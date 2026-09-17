// intake.mjs — the intake door's PURE half (T46/W-C1 §4a, lane B).
//
// The door turns a public issue into a validated task spec queued on
// state/intake-queue.jsonl. This file is the decision core: zero I/O, zero
// network, fully testable. The I/O half (intake/turn.mjs — the workflow
// adapter: permission API, issue comments, the queue push, the nudge) mirrors
// ops/turn.mjs's shape and owns nothing but transport.
//
// WHY A DOOR AT ALL (T46-WC-DESIGN §0/§2): W-B made the machine plane real
// but the only way IN was an operator with curl. The door is the human-plane
// entry — with the trust boundary drawn HERE, at parse+validate time, so a
// hostile issue body can never reach the conductor, the dispatch prompt, or
// the run-name regex as anything but already-vetted data:
//   - the id charset kills the R2-MINOR-4 run-name hazard AT THE DOOR (an id
//     that would mis-split law-4's `task-<id> · <behavior> · a<n>` matching
//     can never exist — it is rejected before it is queued);
//   - F-1 (L1-B1): deps are CUT — per-issue epochs make cross-epoch deps
//     structurally incoherent (every enqueue-legal dep is a drain-time ghost)
//     and the unspecified failure path dead-loops the chain. The door rejects
//     `deps:` unconditionally; multi-task epochs arrive with W-D.
//   - m-4 (L2): artifacts bind to `^tasks/<minted-id>/` — foreign-task paths
//     are rejected at the door AND the write-back door enforces the same
//     shape (W-C2), so the two doors speak one path language.
//   - the permission class gate FAILS CLOSED: permission null (the API-error
//     marker) rejects — a flaky permission API must never become a free
//     compute lane (§2a).
//
// Every rule is fail-closed and the door NEVER drips: one rejection comment
// lists EVERY violated rule (the anti-drip contract, §2b).

import { createHash } from 'node:crypto';
import { SHIM_BEHAVIORS, LEGACY_BEHAVIORS } from '../sim/harness-shim.mjs';

// The behavior vocabulary: IMPORTED from the harness shim, not forked (the
// brief's directive — the door and the harness can never disagree). The
// brief's bracket list mixes the shim's two vocabularies (the contract set
// `succeed|flaky|fail|hang|slow|poison|wb-violation` straddles both), so the
// accepted set is the UNION of the shim's own exported lists — every string
// shimInvoke implements MEANINGFULLY (its default arm turns anything else
// into a visible work_failed burn; the door stops that at the boundary).
// 'real' is deliberately NOT door-acceptable: a real-lane task is expressed
// as `accept:` (specToTask mints behavior 'real' for it).
export const INTAKE_BEHAVIORS = [...SHIM_BEHAVIORS, ...LEGACY_BEHAVIORS];

// §5's contract extension: the spec MAY carry `mode` (the X22 operator
// switch — `mode: cc` mints a CC epoch). Validated against GENESIS_MODES'
// values HERE so a typo fails at the door, not at genesis.
export const INTAKE_MODES = ['mock', 'real', 'cc'];

export const SPEC_MAX_BYTES = 4096;        // §2b: total spec ≤ 4KB (the raw block)
export const TITLE_MAX_CHARS = 140;        // §2b
export const ACCEPT_MAX_CHARS = 2048;      // §4a
export const ID_RE = /^[-A-Za-z0-9_.]{1,24}$/;  // the run-name-hazard killer
export const LEASE_MIN = 1, LEASE_MAX = 120;
export const MILESTONE_MIN = 1, MILESTONE_MAX = 9;
export const PERMISSION_CLASSES = ['admin', 'maintain', 'write', 'owner'];

// ---------------------------------------------------------------------------
// parseSpecBlock(body) -> { spec, raw, problems } | null
//
// The FIRST fenced block tagged `fsm-task` in the issue body. Fences of 3 OR
// 4 backticks are tolerated (hosts and humans paste 4-backtick fences around
// 3-backtick examples; CommonMark's own tolerance). The content is YAML-ish
// `key: value` lines parsed BY HAND (no yaml dep — the brief's rule):
//   - keys: any word; UNKNOWN keys are validateSpec's to reject (typo
//     protection lives there, with the key NAMED in the error);
//   - values: comment-stripped (` #…` — whitespace-preceded hash, the YAML
//     rule) UNLESS quoted; wrapping "…" or '…' quotes are unwrapped, which
//     is how a literal ` #` rides in (`accept: "see issue #5"` works);
//   - `deps`/`artifacts` accept `[a, b]` list literals or bare single values;
//   - a line that is neither blank nor `key: value`, or a DUPLICATE key, is
//     collected into `problems` — fail-closed: validateSpec turns every
//     problem into a rejection error (a garbage line is never silently
//     ignored; the anti-drip contract cuts both ways).
//
// Returns null when no tagged block exists (the door's "how to write a task"
// lane). `raw` is the block's CONTENT between the fences (the 4KB bound's
// measured bytes — what actually rides the queue line and the prompt).
// The brief's documented return is `{ spec }`; `raw`/`problems` are additive
// members (callers reading `.spec` are unaffected).
// ---------------------------------------------------------------------------
const OPEN_FENCE_RE = /(^|\n)(`{3,4})[ \t]*fsm-task[ \t]*\r?\n/;

export function parseSpecBlock(body) {
  const text = String(body ?? '');
  const open = OPEN_FENCE_RE.exec(text);
  if (!open) return null;
  const ticks = open[2];
  const rest = text.slice(open.index + open[0].length);
  // closing fence: a line that is only backticks, >= the opening count
  const closeRe = new RegExp(`(^|\\n)[ \\t]*\`{${ticks.length},}[ \\t]*(\\r?\\n|$)`);
  const close = closeRe.exec(rest);
  const raw = close ? rest.slice(0, close.index + (close[1] ? close[1].length : 0)) : rest;

  const spec = {};
  const problems = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:(?:[ \t](.*))?$/.exec(line);
    if (!m) {
      problems.push(`line ${i + 1}: not a \`key: value\` pair ("${line.trim().slice(0, 80)}")`);
      continue;
    }
    const key = m[1];
    if (seen.has(key)) {
      problems.push(`line ${i + 1}: duplicate key \`${key}\``);
      continue;
    }
    seen.add(key);
    let v = parseValue(m[2] ?? '');
    // the documented normalization (the doc comment + validateSpec's own
    // error text promise it): deps/artifacts accept list literals OR bare
    // single values — the key-aware wrap happens HERE so validateSpec sees
    // ONE shape. (Found by the lane-B completion's test matrix: parseValue
    // alone is key-agnostic and left bare values as scalars.)
    if ((key === 'deps' || key === 'artifacts') && typeof v === 'string' && v.trim() !== '') {
      v = [v];
    }
    spec[key] = v;
  }
  return { spec, raw, problems };
}

// value parse: comment-strip (unless quoted) -> trim -> unwrap quotes ->
// list-literal for bracketed values. deps/artifacts are normalized to
// arrays HERE so validateSpec sees one shape (the §4a rule).
function parseValue(v) {
  let s = String(v);
  // YAML-ish comment: '#' preceded by whitespace, only when unquoted
  if (!(s.startsWith('"') || s.startsWith("'"))) {
    const hash = s.match(/\s#/);
    if (hash) s = s.slice(0, hash.index);
  }
  s = s.trim();
  // list literal [a, b] (possibly empty); falls through to scalar otherwise
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(x => unquote(x.trim())).filter(x => x !== '');
  }
  return unquote(s);
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// validateSpec(spec, { issue, raw, problems }) -> { ok: true, id } |
// { ok: false, errors: string[] }
//
// EVERY rule, fail-closed, ONE pass collecting ALL violations (the door
// never drips — one comment lists every broken rule). `raw` (the block
// content from parseSpecBlock) is the 4KB bound's input; when absent (direct
// calls), the serialized spec stands in — the bound still holds. `problems`
// (line-level parse failures) become errors verbatim.
// ---------------------------------------------------------------------------
export function validateSpec(spec, { issue, raw, problems = [] } = {}) {
  const errors = [...problems];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: [...errors, 'spec must be a parsed fsm-task block (object)'] };
  }
  if (issue === undefined || issue === null || String(issue) === '') {
    // the default id is built FROM the issue number — without it the door
    // would mint `task-iundefined` (charset-legal!). Fail closed.
    errors.push('issue number is required (the default id is derived from it)');
  }

  // 4KB bound (the raw block; serialized fallback for direct calls)
  const measured = raw != null ? String(raw) : JSON.stringify(spec);
  if (Buffer.byteLength(measured, 'utf8') > SPEC_MAX_BYTES) {
    errors.push(`spec exceeds ${SPEC_MAX_BYTES} bytes (${Buffer.byteLength(measured, 'utf8')} — the raw block)`);
  }

  // id: OPTIONAL, default task-i<issue#>; charset (the run-name hazard dies HERE)
  const hasId = Object.prototype.hasOwnProperty.call(spec, 'id');
  let id = hasId ? spec.id : (String(issue) !== '' ? `task-i${issue}` : undefined);
  if (hasId) {
    if (typeof id !== 'string') {
      errors.push(`id must be a string (got ${JSON.stringify(id)?.slice(0, 40)})`);
      id = undefined;
    } else if (!ID_RE.test(id)) {
      errors.push(`id "${id.slice(0, 40)}" fails the charset ^[-A-Za-z0-9_.]{1,24}$ (the run-name hazard is killed here — see law-4's task-<id> · <behavior> · a<n> matching)`);
      id = undefined;
    }
  } else if (id !== undefined && !ID_RE.test(id)) {
    // the DEFAULT failed the charset (a hostile issue number) — same rejection
    errors.push(`default id "${id}" fails the charset ^[-A-Za-z0-9_.]{1,24}$`);
    id = undefined;
  }

  // title: REQUIRED, ≤ 140 chars, no fence-forming sequences
  const title = spec.title;
  if (typeof title !== 'string' || title.trim() === '') {
    errors.push('title is required (non-empty, ≤ 140 chars)');
  } else {
    if (title.length > TITLE_MAX_CHARS) errors.push(`title is ${title.length} chars (max ${TITLE_MAX_CHARS})`);
    if (/`{3}/.test(title)) errors.push('title must not contain fence-forming sequences (```)');
  }

  // EXACTLY ONE of accept | behavior
  const hasAccept = Object.prototype.hasOwnProperty.call(spec, 'accept');
  const hasBehavior = Object.prototype.hasOwnProperty.call(spec, 'behavior');
  if (hasAccept && hasBehavior) {
    errors.push('exactly ONE of accept or behavior — both are present');
  } else if (!hasAccept && !hasBehavior) {
    errors.push('exactly ONE of accept or behavior is required (accept for real work, behavior for mock epochs)');
  }
  if (hasAccept) {
    const accept = spec.accept;
    if (typeof accept !== 'string' || accept.trim() === '') {
      errors.push('accept must be a non-empty string (≤ 2048 chars)');
    } else if (accept.length > ACCEPT_MAX_CHARS) {
      errors.push(`accept is ${accept.length} chars (max ${ACCEPT_MAX_CHARS})`);
    }
  }
  if (hasBehavior && !INTAKE_BEHAVIORS.includes(spec.behavior)) {
    errors.push(`behavior "${String(spec.behavior).slice(0, 40)}" is not one of [${INTAKE_BEHAVIORS.join(', ')}]`);
  }

  // F-1 (L1-B1): deps are CUT — cross-epoch deps are structurally incoherent
  // until W-D; the failure path dead-loops the chain. ANY presence rejects.
  if (Object.prototype.hasOwnProperty.call(spec, 'deps')) {
    errors.push('deps arrive with multi-task epochs (W-D) — remove the deps line');
  }

  // artifacts: OPTIONAL array; every path bound to the MINTED id (m-4)
  if (Object.prototype.hasOwnProperty.call(spec, 'artifacts')) {
    const arts = spec.artifacts;
    if (!Array.isArray(arts)) {
      errors.push(`artifacts must be a list ("[tasks/<id>/report.md]" or a bare path)`);
    } else {
      const boundId = typeof id === 'string' ? id : '<id-invalid>';
      const artRe = new RegExp(`^tasks/${escapeRe(boundId)}/[-A-Za-z0-9_./]*$`);
      for (const a of arts) {
        if (typeof a !== 'string') {
          errors.push(`artifact ${JSON.stringify(a)?.slice(0, 40)} is not a string`);
          continue;
        }
        if (!artRe.test(a)) {
          errors.push(`artifact "${a.slice(0, 80)}" must live under tasks/${boundId}/ (bound to the minted id — m-4)`);
        } else if (a.split('/').includes('..')) {
          // the brief's charset admits '..' but m-4's intent (one path
          // language with the write-back door) forbids traversal — the
          // conservative fold, documented in t46-wc1-state.md
          errors.push(`artifact "${a.slice(0, 80)}" must not contain '..' path segments`);
        }
      }
    }
  }

  // lease_minutes: OPTIONAL integer [1, 120]
  if (Object.prototype.hasOwnProperty.call(spec, 'lease_minutes')) {
    const lm = spec.lease_minutes;
    if (!/^-?\d+$/.test(String(lm).trim())) {
      errors.push(`lease_minutes must be an integer in [${LEASE_MIN}, ${LEASE_MAX}] (got ${JSON.stringify(lm)?.slice(0, 20)})`);
    } else {
      const n = parseInt(String(lm).trim(), 10);
      if (n < LEASE_MIN || n > LEASE_MAX) errors.push(`lease_minutes ${n} is outside [${LEASE_MIN}, ${LEASE_MAX}]`);
    }
  }

  // milestone: OPTIONAL integer [1, 9]
  if (Object.prototype.hasOwnProperty.call(spec, 'milestone')) {
    const ms = spec.milestone;
    if (!/^-?\d+$/.test(String(ms).trim())) {
      errors.push(`milestone must be an integer in [${MILESTONE_MIN}, ${MILESTONE_MAX}] (got ${JSON.stringify(ms)?.slice(0, 20)})`);
    } else {
      const n = parseInt(String(ms).trim(), 10);
      if (n < MILESTONE_MIN || n > MILESTONE_MAX) errors.push(`milestone ${n} is outside [${MILESTONE_MIN}, ${MILESTONE_MAX}]`);
    }
  }

  // mode: OPTIONAL, one of GENESIS_MODES' values (§5 — the X22 switch)
  if (Object.prototype.hasOwnProperty.call(spec, 'mode')) {
    if (!INTAKE_MODES.includes(spec.mode)) {
      errors.push(`mode "${String(spec.mode).slice(0, 20)}" is not one of [${INTAKE_MODES.join(', ')}]`);
    }
  }

  // unknown keys: REJECT, listing them (typo protection)
  const KNOWN = ['id', 'title', 'accept', 'behavior', 'deps', 'artifacts', 'lease_minutes', 'milestone', 'mode'];
  const unknown = Object.keys(spec).filter(k => !KNOWN.includes(k));
  if (unknown.length) {
    errors.push(`unknown key(s): ${unknown.join(', ')} (known: ${KNOWN.join(', ')})`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, id };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// specToTask — RE-EXPORTED from conductor-core (the ONE canonical mapper;
// the conductor's makeGenesis and the door must never disagree on shape —
// the lane-B draft duplicated it and the integration folded them back).
// Shape: {id, title, behavior ('real' for accept-specs), work_ms, deps: [],
// spec: {accept?, artifacts?, issue, body_sha8?}}.
// ---------------------------------------------------------------------------
export { specToTask } from './conductor-core.mjs';

// ---------------------------------------------------------------------------
// doorDecide({ author, isBot, permission, body, issue, queue })
//   -> { decision: 'enqueue'|'reject'|'silent', comment?, spec?, id? }
//
// The door's decision table, in the brief's EXACT order:
//   1. bot (github-actions[bot] / any [bot] login) -> SILENT, no comment —
//      loop safety: the door must never wake itself (and GITHUB_TOKEN-
//      authored comments fire no issue_comment anyway, F-13).
//   2. no fsm-task block -> reject, the how-to comment (schema template).
//   3. permission NOT in [admin, maintain, write, owner] -> reject, the
//      stranger comment (ONE comment, the issue stays open for triage).
//      permission null (the API-error marker) -> reject FAIL-CLOSED with
//      its own comment (a flaky permission API is never a free lane).
//   4. validateSpec errors -> reject, ONE comment listing EVERY rule.
//   5. already queued (same issue + same body sha8) -> SILENT + the
//      idempotence comment (kills the double-queue; cross-epoch re-runs
//      still work once the queue drains — F-11).
//   6. else enqueue.
// ---------------------------------------------------------------------------
export function doorDecide({ author, isBot, permission, body, issue, queue = [] } = {}) {
  // 1. bot-silent — belt AND suspenders: trust the flag OR the login shape
  // (a login ending '[bot]' is a bot on GitHub, whoever computed the flag).
  if (isBot === true || String(author || '').endsWith('[bot]')) {
    return { decision: 'silent' };
  }

  // 2. no block -> the how-to comment
  const parsed = parseSpecBlock(body);
  if (!parsed) {
    return { decision: 'reject', comment: howToComment() };
  }

  // 3. the permission class gate (fail-closed on null)
  if (!PERMISSION_CLASSES.includes(permission)) {
    if (permission === null || permission === undefined) {
      return { decision: 'reject', comment:
        '**[fsm-intake]** The door could not verify your permission (GitHub API error) — failing closed: a flaky permission check must never become a free compute lane.\n\n'
        + 'Nothing was queued. Close and re-open this issue to retry, or ask an operator to nudge it.' };
    }
    return { decision: 'reject', comment:
      `**[fsm-intake]** Thanks @${author || 'there'} — the FSM intake door only accepts work from collaborators with write access to this repo (observed permission: \`${permission}\`).\n\n`
      + 'This issue stays open for triage by an operator; nothing was queued. If you believe you should have access, contact a maintainer.' };
  }

  // 4. full validation — ONE comment, EVERY rule
  const v = validateSpec(parsed.spec, { issue, raw: parsed.raw, problems: parsed.problems });
  if (!v.ok) {
    return { decision: 'reject', comment:
      `**[fsm-intake]** The \`fsm-task\` spec was rejected — ${v.errors.length} rule(s) violated:\n\n`
      + v.errors.map(e => `- ${e}`).join('\n')
      + '\n\nFix the spec and re-open this issue (close + open) to retry.' };
  }

  // 5. already-queued dedup (issue + body sha8): the door is idempotent
  const sha = bodySha8(body);
  if (queue.some(l => String(l.issue) === String(issue) && l.body_sha8 === sha)) {
    return { decision: 'silent', comment:
      `**[fsm-intake]** already queued (issue #${issue}, same body) — the door is idempotent.` };
  }

  // 6. enqueue
  return { decision: 'enqueue', spec: parsed.spec, id: v.id };
}

// The how-to comment — the schema template VERBATIM (§4a). No inline
// comments in the template itself: pasted specs must survive the parser
// without quoting surprises.
export function howToComment() {
  return [
    '**[fsm-intake]** This issue has no `fsm-task` spec block, so the FSM intake door ignored it (it stays a normal issue — nothing was queued).',
    '',
    'To queue machine work, include a fenced block tagged `fsm-task`:',
    '',
    '```fsm-task',
    'id: T-501',
    'title: research the frob nozzle',
    'accept: one paragraph on frob options with citations',
    'artifacts: [tasks/T-501/report.md]',
    'lease_minutes: 45',
    'milestone: 1',
    '```',
    '',
    'Rules (one comment lists every violation — fix them all, then close and re-open the issue to retry):',
    '- `id` optional — default `task-i<issue#>`; charset `[-A-Za-z0-9_.]{1,24}`',
    '- `title` required — ≤ 140 chars, no fence-forming sequences',
    '- exactly ONE of `accept` (non-empty, ≤ 2048 chars) or `behavior` (mock epochs; one of the harness behaviors)',
    '- `deps` is not accepted yet — arrives with multi-task epochs (W-D)',
    '- `artifacts` optional — every path under `tasks/<task-id>/`',
    '- `lease_minutes` optional — integer [1, 120]; `milestone` optional — integer [1, 9]',
    '- `mode` optional — one of mock | real | cc',
    '- unknown keys are rejected (typo protection); the whole block must be ≤ 4KB',
    '- values containing ` #` must be quoted (`accept: "see #5"`) — otherwise ` #` starts a comment',
  ].join('\n');
}

// bodySha8(body) — the re-delivery discriminator (§2c): the TASK_CREATED
// mint is `task-<issue#>-<bodySha8>`; the queue line carries the same sha8
// so the drain and the door dedupe on one identity.
export function bodySha8(body) {
  return createHash('sha256').update(String(body ?? '')).digest('hex').slice(0, 8);
}
