// worker-contract.mjs — the W-B worker-turn CONTRACT as code (T46 §1a).
//
// The contract layer between the FSM conductor and ANY work harness (the
// mock shim, the raw-completion stand-in, the CC adapter). Three pure
// surfaces — the dispatch envelope (law-1 start-gate input), the write-back
// door (the artifact governance), and the outcome classifier (the F-F split
// generalized to five classes). NO I/O anywhere in this module: every
// function is (input) -> (value); the adapters own the network, the clock
// injection, and the git plumbing.
//
//   envelopeFromDispatch(cp, nowMs)  — derive + validate the turn envelope
//                                      from a repository_dispatch
//                                      client_payload. F-B2 legacy-compat:
//                                      today's minimal live ASSIGN shape
//                                      gets DEFAULTS, only corrupt /
//                                      contradictory shapes fail closed.
//   writeBackDoor({branch, paths, sizes, allowRoot})
//                                    — the pathspec allowlist + size caps
//                                      for worker write-back (PURE
//                                      validation this wave; the remote
//                                      read-back verification lands with
//                                      the adapter wave and consumes this
//                                      return shape).
//   classifyOutcome(raw, ctx)        — normalize ANY harness completion
//                                      payload to the five classes
//                                      {done, work_failed, infra_failed,
//                                      deadline, poison}. F-M4 hardened:
//                                      reasoning-first models, budget-
//                                      misconfigured truncation, and
//                                      error-as-answer marker text.
//   mintEventId / MINT_TABLE         — re-exported from event-ingest.mjs
//                                      (F-B3: the table lives THERE, next
//                                      to the live mint sites; this module
//                                      re-exports so harness code has ONE
//                                      import site for the whole contract).
//
// The five classes (the shared vocabulary — the FSM receiver in lib/fsm.mjs
// applies exactly these):
//   done          the work completed; artifact/answer extracted
//   work_failed   the model ATTEMPTED the work and it is not usable —
//                 burns a work attempt (alias of the legacy 'failed')
//   infra_failed  the LANE failed before/between work (401/402/429/5xx/
//                 transport) — net-zero retry, lane rotates
//   deadline      the turn hit its lease-scoped wall — attempt-burn +
//                 lease release (the self-reported reaper)
//   poison        prompt-injection / anomaly / contract violation —
//                 terminal quarantine, DISTINCT from infra exhaustion

import { mintEventId, MINT_TABLE } from './event-ingest.mjs';

export { mintEventId, MINT_TABLE };

// ---------------------------------------------------------------------------
// envelopeFromDispatch — law-1 start-gate input (F-B2 compat rule folded)
// ---------------------------------------------------------------------------
//
// cp = the repository_dispatch client_payload. TWO supported shapes:
//
//   FULL (the W-B conductor mints it): {task, attempt, mode, prompt, title?,
//   deadline_ms | (expires, ttl_ms?), session?, run_id?, chain, budget?,
//   task_ref?} — every workload field explicit, pre-computed deadline.
//
//   LEGACY-MINIMAL (today's live ASSIGN, conductor/turn.mjs:223-227):
//   {task, lease, behavior, attempt, work_ms, expires, chain} — gets
//   DEFAULTS: prompt <- title <- `task <id>`, budget <- {max_turns:40,
//   wall_ms: derived, lane_attempts:3}, mode <- 'mock'. Legacy minimalism
//   is NOT corrupt (the F-B2 review hole: fail-closed validation would
//   quarantine TODAY's epochs into DEGRADED halt).
//
// FAIL-CLOSED ({ok:false, class:'infra_failed', reason, detail?}) only for
// corrupt/contradictory shapes: missing task id, non-integer/negative
// attempt, unknown mode, non-string prompt/title, bad task_ref, no deadline
// source, deadline in the past (the law-1 late-start class — the lease
// already expired at job start), out-of-bounds explicit budget fields.
//
// The lease/report plumbing (cp.lease et al.) stays on the RAW cp — the
// envelope is the workload contract; W2/W3 read CP.lease directly for the
// report identity.

// F-G(a) proven arithmetic: 2 minutes of margin between every deadline and
// the thing that kills the job (the runner SIGTERM lands ~30-60s before the
// documented timeout; the margin absorbs it plus clock skew).
export const ENVELOPE_MARGIN_MS = 120_000;
export const ENVELOPE_MODES = ['mock', 'real', 'cc'];
export const ENVELOPE_DEFAULT_MAX_TURNS = 40;
export const ENVELOPE_DEFAULT_LANE_ATTEMPTS = 3;
export const ENVELOPE_MIN_WALL_MS = 60_000;
export const ENVELOPE_LANE_ATTEMPTS_BOUNDS = [1, 8];

export function envelopeFromDispatch(cp, nowMs = Date.now()) {
  const fail = (reason, detail) => ({ ok: false, class: 'infra_failed', reason, ...(detail !== undefined ? { detail } : {}) });
  if (cp === null || typeof cp !== 'object' || Array.isArray(cp)) {
    return fail('bad-payload', `client_payload is ${cp === null ? 'null' : typeof cp} (expected an object)`);
  }

  // X21 live finding (the 10-property dispatch limit): the envelope rides
  // ONE `ox` JSON-string property beside the legacy fields. Unwrap it FIRST
  // — a corrupt ox string is fail-closed (never a silently degraded turn);
  // an absent ox falls through to the top-level/legacy field path.
  if (cp.ox !== undefined && cp.ox !== null) {
    if (typeof cp.ox !== 'string') {
      return fail('bad-envelope', `cp.ox must be a JSON string (got ${typeof cp.ox})`);
    }
    let ox;
    try { ox = JSON.parse(cp.ox); } catch (e) {
      return fail('bad-envelope', `cp.ox is not valid JSON: ${String(e?.message ?? e).slice(0, 80)}`);
    }
    if (ox === null || typeof ox !== 'object' || Array.isArray(ox)) {
      return fail('bad-envelope', `cp.ox must decode to an object (got ${ox === null ? 'null' : typeof ox})`);
    }
    // merge: ox fields WIN over top-level (the minted envelope is the
    // authority), legacy top-level fields remain as fallbacks
    cp = { ...cp, ...ox };
  }

  // task id — the one field with NO default (a dispatch without a task is
  // not minimal, it is corrupt)
  const taskId = cp.task;
  if (typeof taskId !== 'string' || taskId === '') {
    return fail('missing-task-id', `cp.task=${JSON.stringify(taskId)} (must be a non-empty string)`);
  }
  // task_ref: v1 knows exactly ONE kind — the task record lives in
  // state.json (richer spec paths arrive with the W-C intake)
  if (cp.task_ref !== undefined && cp.task_ref !== null) {
    const tr = cp.task_ref;
    if (typeof tr !== 'object' || tr === null || Array.isArray(tr) || tr.kind !== 'state-task' || tr.id !== taskId) {
      return fail('bad-task-ref', `cp.task_ref must be {kind:'state-task', id:${JSON.stringify(taskId)}} in v1 (got ${JSON.stringify(tr).slice(0, 120)})`);
    }
  }

  // attempt — present in every live ASSIGN; absent -> 1 (the minimal default)
  let attempt = 1;
  if (cp.attempt !== undefined && cp.attempt !== null) {
    if (!Number.isInteger(cp.attempt) || cp.attempt < 1) {
      return fail('bad-attempt', `cp.attempt=${JSON.stringify(cp.attempt)} (must be an integer >= 1)`);
    }
    attempt = cp.attempt;
  }

  // mode — absent -> 'mock' (the legacy default); present-but-unknown is
  // corrupt (a typo'd mode would silently run the wrong harness)
  const mode = cp.mode === undefined || cp.mode === null || cp.mode === '' ? 'mock' : cp.mode;
  if (!ENVELOPE_MODES.includes(mode)) {
    return fail('unknown-mode', `cp.mode=${JSON.stringify(cp.mode)} (must be one of ${ENVELOPE_MODES.join('|')})`);
  }

  // prompt — F-B2 legacy compat: prompt > title > the literal `task <id>`.
  // An EMPTY string falls through (minimal, not corrupt); a non-string
  // prompt/title is a corrupt shape (fail-closed).
  for (const k of ['prompt', 'title']) {
    const v = cp[k];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      return fail('bad-prompt', `cp.${k} must be a string (got ${typeof v})`);
    }
  }
  const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const prompt = nonEmpty(cp.prompt) ?? nonEmpty(cp.title) ?? `task ${taskId}`;

  // deadline — absolute epoch ms. An EXPLICIT cp.deadline_ms wins (the W-B
  // conductor pre-computes min(lease expiry - margin, TTL - margin)); the
  // legacy path derives it here from the lease expiry (and the job TTL when
  // supplied), applying the same margin.
  let deadlineMs;
  if (cp.deadline_ms !== undefined && cp.deadline_ms !== null) {
    if (typeof cp.deadline_ms !== 'number' || !Number.isFinite(cp.deadline_ms)) {
      return fail('bad-deadline', `cp.deadline_ms=${JSON.stringify(cp.deadline_ms)} (must be epoch-ms)`);
    }
    deadlineMs = cp.deadline_ms;
  } else {
    const leaseMs = cp.expires !== undefined && cp.expires !== null ? Date.parse(cp.expires) : NaN;
    const hasTtl = typeof cp.ttl_ms === 'number' && Number.isFinite(cp.ttl_ms) && cp.ttl_ms > 0;
    const cands = [];
    if (Number.isFinite(leaseMs)) cands.push(leaseMs);
    if (hasTtl) cands.push(nowMs + cp.ttl_ms);
    if (cands.length === 0) {
      return fail('no-deadline-source', 'none of deadline_ms / expires / ttl_ms present — the envelope cannot derive a deadline (not the live ASSIGN shape, not the full shape)');
    }
    deadlineMs = Math.min(...cands) - ENVELOPE_MARGIN_MS;
  }
  if (!(deadlineMs > nowMs)) {
    return fail('deadline-in-past', `deadline ${Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : String(deadlineMs)} <= now ${new Date(nowMs).toISOString()} (the law-1 late-start class: the lease already expired at job start — report infra_failed, exit 0)`);
  }

  // budget — explicit sub-fields validated against the published bounds;
  // missing sub-fields get the defaults. wall_ms derives from the deadline
  // (the remaining window) with the 60s config floor: the FLOOR is a
  // harness-config minimum, the ABSOLUTE deadline still gates (the adapter
  // kills at deadline_ms regardless of wall_ms).
  const b = cp.budget === undefined || cp.budget === null ? {} : cp.budget;
  if (typeof b !== 'object' || Array.isArray(b)) {
    return fail('bad-budget', `cp.budget must be an object (got ${Array.isArray(b) ? 'array' : typeof b})`);
  }
  const maxTurns = b.max_turns === undefined || b.max_turns === null ? ENVELOPE_DEFAULT_MAX_TURNS : b.max_turns;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    return fail('bad-budget', `budget.max_turns=${JSON.stringify(b.max_turns)} (must be an integer >= 1)`);
  }
  const wallMs = b.wall_ms === undefined || b.wall_ms === null
    ? Math.max(ENVELOPE_MIN_WALL_MS, Math.round(deadlineMs - nowMs))
    : b.wall_ms;
  if (!Number.isInteger(wallMs) || wallMs < ENVELOPE_MIN_WALL_MS) {
    return fail('bad-budget', `budget.wall_ms=${JSON.stringify(b.wall_ms)} (must be an integer >= ${ENVELOPE_MIN_WALL_MS})`);
  }
  const laneAttempts = b.lane_attempts === undefined || b.lane_attempts === null ? ENVELOPE_DEFAULT_LANE_ATTEMPTS : b.lane_attempts;
  if (!Number.isInteger(laneAttempts) || laneAttempts < ENVELOPE_LANE_ATTEMPTS_BOUNDS[0] || laneAttempts > ENVELOPE_LANE_ATTEMPTS_BOUNDS[1]) {
    return fail('bad-budget', `budget.lane_attempts=${JSON.stringify(b.lane_attempts)} (must be an integer in [${ENVELOPE_LANE_ATTEMPTS_BOUNDS.join(',')}]`);
  }

  // session — the turn identity. Precomputed (cp.session) or derived
  // `${chainId}/${taskId}/${runId}-a${attempt}`; runId comes from cp.run_id
  // (the dispatching run — W2's conductor passes GITHUB_RUN_ID so every
  // assignment gets a unique session; default 'local' mirrors
  // reportEventId's local smoke lane).
  let session;
  if (cp.session !== undefined && cp.session !== null && cp.session !== '') {
    if (typeof cp.session !== 'string') {
      return fail('bad-session', `cp.session must be a string (got ${typeof cp.session})`);
    }
    session = cp.session;
  } else {
    session = `${nonEmpty(cp.chain) ?? 'chain'}/${taskId}/${nonEmpty(cp.run_id) ?? 'local'}-a${attempt}`;
  }

  return {
    ok: true,
    envelope: {
      task_ref: { kind: 'state-task', id: taskId },
      prompt,
      deadline_ms: deadlineMs,
      session,
      budget: { max_turns: maxTurns, wall_ms: wallMs, lane_attempts: laneAttempts },
      mode,
      attempt,
    },
  };
}

// ---------------------------------------------------------------------------
// writeBackDoor — the artifact pathspec governance (D4: the door ships
// BEFORE the task-branch flow that needs it)
// ---------------------------------------------------------------------------
//
// PURE VALIDATION this wave: no git calls, no remote reads. The adapter wave
// consumes the return shape for its remote read-back verification (the
// tip-API discipline — after committing, verify via the API that each
// `allowed` path EXISTS on `branch`'s tip with the declared size; the
// masked-rc lesson).
//
// ALLOW: `tasks/<id>/**` (the branch IS the task branch — its id owns the
// namespace) + pathspecs listed in `allowRoot` (the payload-declared
// artifact paths; despite the name the entries may be any pathspec — the
// primary use is declaring root-level files, which are denied by default).
// DENY ALWAYS (checked BEFORE the allowlist — declaring a denied path does
// not unlock it): any path with a segment starting `.git` (covers .git,
// .gitignore, .gitmodules, AND .github/**), path escapes (absolute paths,
// `..` segments, empty segments, backslashes).
// CAPS: WRITE_BACK_CAP_FILE_BYTES per file, WRITE_BACK_CAP_TASK_BYTES per
// task total (10MB each), measured on the caller-declared `sizes` map; a
// missing size reads as 0 (the read-back wave measures actuals).

export const WRITE_BACK_CAP_FILE_BYTES = 10 * 1024 * 1024;
export const WRITE_BACK_CAP_TASK_BYTES = 10 * 1024 * 1024;
const TASK_BRANCH_RE = /^tasks\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function writeBackDoor({ branch, paths, sizes = {}, allowRoot = [] } = {}) {
  const caps = { fileBytes: WRITE_BACK_CAP_FILE_BYTES, taskTotalBytes: WRITE_BACK_CAP_TASK_BYTES };
  const shape = (violations, taskId = null, allowed = [], totalBytes = 0) => ({
    ok: violations.length === 0, violations, branch: typeof branch === 'string' ? branch : null, taskId, allowed, totalBytes, caps,
  });
  if (typeof branch !== 'string' || branch === '') {
    return shape([`bad-branch(${JSON.stringify(branch)}) — the door commits to tasks/<id> task branches ONLY (main/fsm-state/fsm-sessions are refused)`]);
  }
  if (!TASK_BRANCH_RE.test(branch)) {
    return shape([`bad-branch(${branch}) — must match tasks/<id> (the task-branch convention; the state/sessions branches are never writable through the door)`]);
  }
  const taskId = branch.slice('tasks/'.length);

  let pathList;
  if (paths === undefined || paths === null) pathList = [];
  else if (Array.isArray(paths)) pathList = paths;
  else return shape([`bad-paths(${JSON.stringify(paths).slice(0, 80)}) — paths must be an array of pathspecs`], taskId);

  const sizeMap = sizes === undefined || sizes === null ? {} : sizes;
  if (typeof sizeMap !== 'object' || Array.isArray(sizeMap)) {
    return shape([`bad-sizes(${JSON.stringify(sizes).slice(0, 80)}) — sizes must be an object {path: bytes}`], taskId);
  }
  const allow = allowRoot === undefined || allowRoot === null ? [] : allowRoot;
  if (!Array.isArray(allow)) {
    return shape([`bad-allowRoot(${JSON.stringify(allowRoot).slice(0, 80)}) — allowRoot must be an array of declared pathspecs`], taskId);
  }
  const violations = [];
  const declared = new Set();
  for (const a of allow) {
    if (typeof a !== 'string' || a === '') violations.push(`bad-allow(${JSON.stringify(a)})`);
    else declared.add(a);
  }

  const allowed = [];
  let totalBytes = 0;
  for (const p of pathList) {
    if (typeof p !== 'string' || p === '') { violations.push(`bad-path(${JSON.stringify(p)})`); continue; }
    const norm = p.replace(/^\.\//, '');
    if (norm.startsWith('/') || norm.includes('\\') || norm.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
      violations.push(`path-escape(${p})`);
      continue;
    }
    if (norm.split('/').some(seg => seg.startsWith('.git'))) {
      violations.push(`deny-dotgit(${norm})`);
      continue;
    }
    const inTaskNamespace = norm.startsWith(`tasks/${taskId}/`);
    if (!inTaskNamespace && !declared.has(norm)) {
      violations.push(norm.includes('/') ? `undeclared(${norm})` : `root-not-declared(${norm})`);
      continue;
    }
    const sz = sizeMap[norm] ?? sizeMap[p];
    if (sz === undefined) {
      // no declared size: allowed, counted as 0 (the read-back wave
      // measures the actual blob)
      allowed.push(norm);
      continue;
    }
    if (typeof sz !== 'number' || !Number.isFinite(sz) || sz < 0) {
      violations.push(`bad-size(${norm})`);
      continue;
    }
    totalBytes += sz;
    if (sz > WRITE_BACK_CAP_FILE_BYTES) violations.push(`size-cap-file(${norm}:${sz})`);
    allowed.push(norm);
  }
  if (totalBytes > WRITE_BACK_CAP_TASK_BYTES) violations.push(`size-cap-total(${totalBytes})`);
  return { ok: violations.length === 0, violations, branch, taskId, allowed, totalBytes, caps };
}

// ---------------------------------------------------------------------------
// classifyOutcome — ONE pure function, five classes, every harness shape
// ---------------------------------------------------------------------------
//
// Precedence (each step short-circuits):
//   0. non-object payload                       -> work_failed 'empty-completion'
//   1. explicit status: five classes            -> passthrough (+detail/artifact)
//      done + marker-laden content              -> infra_failed 'error-as-answer'
//                                                 (the E11 trust boundary is
//                                                 re-checked even when the
//                                                 harness vouches 'done')
//      legacy 'failed'                          -> work_failed (the F-B1 alias)
//      any other status                         -> poison 'unknown-status(...)'
//                                                 (a status outside the contract
//                                                 is an anomaly — loud and
//                                                 terminal beats silent
//                                                 remapping)
//   2. {error:{status}}: 401/402/429/5xx/       -> infra_failed 'lane-<status>'
//      'transport'                                (the lane rotates)
//      other numeric statuses                    -> work_failed 'error-<status>'
//                                                 (deterministic app class)
//      error without a status                    -> work_failed (sliced text)
//   3. non-string content/reasoning             -> poison 'bad-*-shape'
//   4. content matching ctx.errorMarkers        -> infra_failed 'error-as-answer'
//   5. non-empty content                        -> done (artifact = content)
//      else non-empty reasoning                 -> done 'reasoning-as-answer'
//                                                 (F-M4: reasoning-first models)
//   6. finish:'length' + nothing extracted      -> infra_failed 'budget-misconfigured'
//                                                 (the caller's error — the
//                                                 probe shape: content:null,
//                                                 reasoning:null at small
//                                                 max_tokens)
//   7. both empty                               -> work_failed 'empty-completion'
//                                                 (the lane ANSWERED; retrying
//                                                 is meaningful)
//
// ctx.errorMarkers: array of substrings (case-insensitive) and/or RegExp —
// replaces the defaults when present (an explicit [] disables the check:
// the caller's deliberate choice). Default markers (the E11 probe classes):
// 'invalid api key', 'unauthorized', 'insufficient credits', 'rate limit'.

export const OUTCOME_CLASSES = ['done', 'work_failed', 'infra_failed', 'deadline', 'poison'];
export const DEFAULT_ERROR_MARKERS = ['invalid api key', 'unauthorized', 'insufficient credits', 'rate limit'];
const INFRA_HTTP_STATUSES = new Set([401, 402, 429]);
const DETAIL_SLICE = 200;

function sliceDetail(s) { return String(s).slice(0, DETAIL_SLICE); }

function classifyError(err) {
  if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
    const st = err.status;
    if (st !== undefined && st !== null) {
      const n = typeof st === 'string' && /^\d+$/.test(st) ? parseInt(st, 10) : st;
      if (n === 'transport' || INFRA_HTTP_STATUSES.has(n) || (typeof n === 'number' && n >= 500)) {
        return { status: 'infra_failed', detail: `lane-${n}` };
      }
      return { status: 'work_failed', detail: `error-${sliceDetail(n)}` };
    }
    return { status: 'work_failed', detail: sliceDetail(err.message ?? JSON.stringify(err)) };
  }
  return { status: 'work_failed', detail: sliceDetail(err) };
}

export function classifyOutcome(raw, ctx = {}) {
  // 0. degenerate payload — the conservative WORK class (infra would
  // net-zero-retry-loop a systematically-null harness forever; work burns
  // the bounded ladder then parks, visible)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'work_failed', detail: 'empty-completion' };
  }

  const markers = Array.isArray(ctx.errorMarkers) ? ctx.errorMarkers : DEFAULT_ERROR_MARKERS;
  const matchMarker = (text, marker) => {
    if (typeof marker === 'string') return text.toLowerCase().includes(marker.toLowerCase());
    if (marker instanceof RegExp) {
      // a /g regex is STATEFUL across .test() calls — strip the flag so the
      // classifier stays pure (same input, same answer, every call)
      const re = marker.flags.includes('g') ? new RegExp(marker.source, marker.flags.replace('g', '')) : marker;
      return re.test(text);
    }
    return false;
  };
  const markerName = (m) => (m instanceof RegExp ? `/${m.source}/${m.flags.replace('g', '')}` : String(m));
  const markerHit = (text) => {
    for (const mk of markers) {
      if (matchMarker(text, mk)) return markerName(mk);
    }
    return null;
  };

  // shape guards for the extraction fields (a harness emitting a non-string
  // content/reasoning is a contract violation — the anomaly class)
  if (raw.content !== undefined && raw.content !== null && typeof raw.content !== 'string') {
    return { status: 'poison', detail: `bad-content-shape(${typeof raw.content})` };
  }
  if (raw.reasoning !== undefined && raw.reasoning !== null && typeof raw.reasoning !== 'string') {
    return { status: 'poison', detail: `bad-reasoning-shape(${typeof raw.reasoning})` };
  }
  const hasContent = typeof raw.content === 'string' && raw.content !== '';
  const hasReasoning = typeof raw.reasoning === 'string' && raw.reasoning !== '';

  // 1. explicit status
  if (typeof raw.status === 'string' && raw.status !== '') {
    const detail = raw.detail ?? raw.error;
    const extra = {
      ...(detail !== undefined && detail !== null && detail !== '' ? { detail: sliceDetail(detail) } : {}),
      ...(raw.status === 'done' && raw.artifact !== undefined && raw.artifact !== null ? { artifact: sliceDetail(raw.artifact) } : {}),
    };
    if (OUTCOME_CLASSES.includes(raw.status)) {
      // E11 re-check: the marker text packaged as a SUCCESS answer is
      // infra EVEN when the harness already stamped status:'done'
      if (raw.status === 'done' && hasContent) {
        const hit = markerHit(raw.content);
        if (hit) return { status: 'infra_failed', detail: `error-as-answer(${hit})` };
      }
      return { status: raw.status, ...extra };
    }
    if (raw.status === 'failed') {
      // the legacy worker vocabulary (mock/real lanes) — F-B1's alias
      return { status: 'work_failed', ...extra };
    }
    return { status: 'poison', detail: `unknown-status(${sliceDetail(raw.status)})` };
  }

  // 2. error shapes
  if (raw.error !== undefined && raw.error !== null) {
    return classifyError(raw.error);
  }

  // 4. error-as-answer (E11): marker TEXT packaged as the success answer —
  // checked BEFORE done
  if (hasContent) {
    const hit = markerHit(raw.content);
    if (hit) return { status: 'infra_failed', detail: `error-as-answer(${hit})` };
  }

  // 5. extraction — content first, reasoning second (F-M4: reasoning-first
  // models return content:null with the answer in reasoning)
  if (hasContent) return { status: 'done', artifact: sliceDetail(raw.content) };
  if (hasReasoning) return { status: 'done', artifact: sliceDetail(raw.reasoning), detail: 'reasoning-as-answer' };

  // 6. F-M4: truncated-at-cap with NOTHING extracted — the caller asked for
  // fewer tokens than the model needs to open its mouth; that is a budget
  // configuration error (infra), not the model's work failure
  if (raw.finish === 'length') return { status: 'infra_failed', detail: 'budget-misconfigured' };

  // 7. the lane answered; the model produced nothing (work class — a retry
  // is meaningful)
  return { status: 'work_failed', detail: 'empty-completion' };
}
