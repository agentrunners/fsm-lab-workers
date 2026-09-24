// codex-adapter.mjs — the CODEX harness turn (s24/B2 — the multi-engine
// design §2, executable; the second engineTurn beside ccTurn).
//
// THE CONTRACT: codexTurn(envelope, opts) consumes the turn envelope from
// envelopeFromDispatch and returns the SAME contract return the shim/cc
// adapters return ({status?, content?, reasoning?, artifact_refs, summary,
// telemetry} + the raw-lane extras runTurn's single classifyOutcome call
// consumes). worker/turn.mjs's codex routing arm resolves THIS module lazily
// (s24/B1) and calls the exported codexTurn — the opts shape it passes
// ({env, runId, now, log, allowRoot}) is the engineTurn contract verbatim.
//
// THE SPAWN (asserted by the fake-CLI conformance at the boundary):
//   codex exec --json --skip-git-repo-check
//        --dangerously-bypass-approvals-and-sandbox   (the worker env is the
//        sandbox — D14's denylist already stripped every credential the
//        process could leak; the review-kit's hostile-input posture does not
//        arise on fsm-lab's own lane)
//        --disable apps                                (F6 REQUIRED: plugin/app
//        tool names >64 chars → error_model_400 on strict OpenRouter models)
//        -C <workdir>                                  (the write-back claim
//        surface — fresh temp dir, scanned post-turn, governed by the door)
//        -m <lane.model>                               (D5b: argv carries the
//        lane's model — config.toml pins exactly ONE)
//        -c model_context_window=<per-model>           (env_key auth never
//        fetches the catalog: deepseek/glm hit fallback metadata unless the
//        ctx is pinned per model — values from worker/codex/models.json)
//        -o <scratch-dir>/last-message.txt              (OUTSIDE the workdir —
//        the cx-runner precedent; gotcha #12: the exit code, never the file,
//        is the success signal — the stream is the content source)
//        "<prompt>"                                    (the FSM envelope IS the
//        prompt — R2: instructions ride the prompt, NO AGENTS.md anywhere in
//        the v1 codex surface)
//   stdin IGNORED (runLane's stdio:['ignore','pipe','pipe'] — gotcha §10.1:
//   an open-piped stdin blocks codex forever on "additional input").
//
// THE ENV CONTRACT (D14, per lane): the 8-member strip set (the CC denylist
// plus OPENROUTER_KEY_POOL) + the overlay {CODEX_HOME, OPENROUTER_API_KEY:
// <lane key>} — the ONLY credential the codex child ever holds is the lane
// key (the deliberate inversion). CODEX_HOME: the caller's (B3's worker.yml
// install step pins $HOME/.codex-fsm) wins; otherwise a turn-scoped scratch
// home under the lane-log scratch dir — NEVER inside the workdir (R1's law)
// and never /tmp in real mode (the caller's home is the real-mode source).
// OX_AGENT_TASK_ID / OX_AGENT_DEADLINE_UTC ride as the engine-neutral kit
// lines (the same F-M8 pair ccLaneEnv sets — the artifact namespace needs
// the task id at the boundary).
//
// THE LANE PICKER (D5a/D5b): key pool [OPENROUTER_API_KEY,
// OPENROUTER_API_KEY_2] × the models table (worker/codex/models.json — the
// single source: ctx + retries + idle + prices + peak), flattened
// MODEL-MAJOR [k1/ds, k2/ds, k1/glm, k2/glm] — both keys on the value model
// within two attempts; a missing KEY_2 degrades to the single-key list
// [k1/ds, k1/glm]. Bounded by budget.lane_attempts (default 3).
//
// THE ROTATION (R3, written down): plain +1 on non-key-class failures; the
// key-class JUMP machinery stays GENERIC (codexNextLaneIndex scans forward
// for a different keyIndex) — on the model-major 4-lane list the scan lands
// on the adjacent lane EVERYWHERE, so the JUMP is behaviorally identical to
// plain +1 (degenerate, accepted: no conformance pin asserts JUMP ≠ +1 on
// this list; the generic machinery is pinned on a synthetic key-major list
// in the unit suite). Model-side failures (error_model_400) advance to the
// SAME model on the other key before the other model — one attempt later
// than key-major would give model diversity; accepted at lane_attempts:3 +
// the wall + budget-pause.
//
// THE DECODE (§2.3 + R7 — PARSE EVENTS FIRST): stdout is JSONL events; the
// last agent_message item = content, turn.completed.usage (incl.
// cached_input_tokens, summed across turns) = accounting, thread.started.
// thread_id = the session label. PRECEDENCE: a classifiable error event
// (error_credits/error_auth/error_quota_daily/error_rate_limit/
// error_network — the R7 set, plus error_model_400/error_in_flight_budget
// riding the same event-wins rule per CC's 400/404-rotates precedent) WINS
// over the exit code; the exit code classifies only when the stream carries
// nothing classifiable; exit 1 then terminalizes work_failed (the
// unclassifiable turn.failed shape). exit 2 ALWAYS = D13's TERMINAL
// infra_failed(codex-usage(<first stderr line>)) — no lane rotation (clap
// fails before any model call; the invocation is broken, not the lane).
//
// THE WALL (F-M6 mechanics, implemented locally — cc-adapter's runLane is
// not exported and this branch does not refactor it): process-group spawn +
// kill(-pid) at min(envelope.deadline_ms, start + budget.wall_ms) → status
// 'deadline' detail 'wall-budget-exceeded'; the 250ms force-resolve guard.
// D15: max_turns is NOT enforced adapter-side (no codex exec flag exists;
// runLane is fire-and-collect) — the wall + codex's own
// stream_idle_timeout_ms (config-side, B3) are the bounds.
//
// DETERMINISM (CODEX_FAKE_LLM=1): the REAL lane is NEVER touched by tests.
// Fake mode spawns worker/fake-codex.mjs with the REAL argv (only the
// command head swaps: codex → node fake-codex.mjs), so the echoed spawn
// boundary IS the real one. The fake picks a fixture by a marker in the
// prompt ([fixture:ok], [fixture:error_credits], …) and answers
// deterministically — zero network, zero npm install.
//
// TRANSCRIPTS (F15): sessions/<task>/<run>-a<attempt>.txt (+ .meta.json)
// BEFORE codexTurn returns, with harness:'codex' + mode:'codex' provenance
// (engine-derived, never the CC hardcode). Fake mode: a LOCAL dir
// (opts.transcriptsDir / env.CODEX_FAKE_TRANSCRIPTS_DIR); real mode (s25/b1
// — the X29 F3/F2 rebuild): per-file CONTENTS-API pushes via the shared
// worker/sessions-push.mjs engine — race-free by construction (no shared
// branch tip to fast-forward), on the FSM_SESSIONS_REPO/FSM_SESSIONS_TOKEN
// custom-name seam (the GITHUB_* step-env override law — see
// sessions-push.mjs) with the GITHUB_REPOSITORY/GH_TOKEN back-compat pair.
//
// ARTIFACTS (R1's law): NOTHING codex-owned lands in the workdir — the -o
// file, the fallback CODEX_HOME, and the lane-stats scratch all live in the
// turn-scoped scratch dir OUTSIDE it, so scanWorkdir claims EVERYTHING it
// finds (the empty exclude set is the design: a workdir containing only the
// task's declared artifacts reports exactly those artifacts done). A stray
// AGENTS.md (or any other undeclared file) in the workdir ⇒ the
// writeBackDoor violation fires — the existing machinery, asserted in
// conformance, not changed here.
//
// LANE_STATS (D6): synthesized from usage × the models.json price table
// (deepseek peak-aware) into laneLogLine-shaped JSONL in the scratch dir,
// then aggregated by the SHARED collectLaneStats — the EXACT
// lane-telemetry.mjs aggregate shape by construction. Cost is recomputed,
// never an engine meter. A turn whose lanes never reported usage or a
// classifiable error attaches NOTHING (absent-means-absent).
//
// TELEMETRY rides the report's outcome: lane attempts used, per-lane
// {key_index, model, rc, duration_ms, class}, models tried, real duration,
// plus key_index/pool_size (the s21/O-3 pair) exactly like ccTurn.

import { spawn } from 'node:child_process';   // s25/b1: spawnSync left with the git-lane push (the contents API needs no subprocess)
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyOutcome, writeBackDoor } from '../lib/worker-contract.mjs';
import { collectLaneStats, laneLogLine } from './lane-telemetry.mjs';
// the W-C2 task-branch write-back is engine-neutral (workdir + the door's
// allowed set in, branch + read-back out) — IMPORTED from the CC adapter
// rather than refactored (the import IS the cheap engine-neutral extraction
// the design's B2 row names; s25/b1 wires ITS origin seam to the shared
// FSM_SESSIONS_REPO/FSM_SESSIONS_TOKEN resolution in cc-adapter.mjs).
import { pushTaskBranch } from './cc-adapter.mjs';
// s25/b1 (the X29 F3/F2 rebuild): the transcript lane's shared contents-API
// engine + the custom-name repo/token seam — race-free by construction, the
// repo the files land on explicit (the law + the live lesson are recorded at
// the top of worker/sessions-push.mjs).
import { pushSessionFiles, sessionsRepoFromEnv, sessionsTokenFromEnv, appendTranscriptNote } from './sessions-push.mjs';
// the single-source model table (D5b): ctx + retries + idle + prices + peak.
// Key order IS the model-major lane order (deepseek first — the value pick).
import CODEX_MODELS_JSON from './codex/models.json' with { type: 'json' };

const FAKE_CODEX_PATH = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// The model table + the lane algebra (pure, exported for the unit suite).
// ---------------------------------------------------------------------------

export const CODEX_MODEL_TABLE = CODEX_MODELS_JSON;
export const CODEX_MODELS = Object.keys(CODEX_MODEL_TABLE);

export function codexModelEntry(model) {
  const entry = CODEX_MODEL_TABLE[model];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`codexModelEntry: unknown model ${JSON.stringify(model)} — the worker/codex/models.json table is the single source (add the entry there; ctx + prices are required, retries/idle feed B3's config render)`);
  }
  return entry;
}

export function codexKeyPool(env = process.env) {
  return [env.OPENROUTER_API_KEY, env.OPENROUTER_API_KEY_2]
    .map((key, i) => ({ key: typeof key === 'string' ? key.trim() : '', keyIndex: i + 1 }))
    .filter((l) => l.key !== '');
}

// MODEL-MAJOR flatten (D5a): for each model (table order), for each key —
// [k1/ds, k2/ds, k1/glm, k2/glm]. A missing KEY_2 degrades to the
// single-key list [k1/ds, k1/glm] (the pool builder drops the empty slot).
export function codexLanes(env = process.env) {
  const lanes = [];
  for (const model of CODEX_MODELS) {
    codexModelEntry(model);   // loud on a table shape break, before any spawn
    for (const { key, keyIndex } of codexKeyPool(env)) {
      lanes.push({ key, keyIndex, model });
    }
  }
  return lanes;
}

// the KEY-CLASS error events (D5a/§2.4): failures that implicate the KEY —
// 402 credits drained, 401 auth dead, 429 daily quota exhausted. These fire
// the (generic) key-class JUMP; every other rotatable class advances +1.
export const CODEX_KEY_CLASS_EVENTS = new Set(['error_credits', 'error_auth', 'error_quota_daily']);

// EVERY event class that wins over the exit code (R7). The five R7 names +
// error_model_400 / error_in_flight_budget (the deliberate CC-parity
// extension: a provider 400 or an in-flight-budget transient is an upstream
// condition, never "the work failed" — CC's 400/404-rotates precedent; the
// cx ladder's same-key backoff for the transient classes does not exist
// here — plain advance, the F14-documented semantic loss).
export const CODEX_ROTATABLE_ERROR_EVENTS = new Set([
  'error_credits', 'error_auth', 'error_quota_daily',
  'error_rate_limit', 'error_network', 'error_model_400', 'error_in_flight_budget',
]);

// the lane ADVANCE policy (pure, exported for the unit suite). The JUMP
// machinery is GENERIC (scan forward for the next key's block — the
// key-major shape it was built for); R3, written down: on the model-major
// 4-lane list the adjacent lane ALWAYS has the other keyIndex, so the scan
// returns i+1 everywhere — behaviorally identical to the plain advance. The
// machinery stays for the day the lane list changes order; no conformance
// row pins JUMP ≠ +1 on this list (it would pin nothing).
export function codexNextLaneIndex(lanes, i, keyClassFailure) {
  if (!Array.isArray(lanes) || !Number.isInteger(i) || i < 0 || i >= lanes.length) return i + 1;
  if (!keyClassFailure) return i + 1;
  const dead = lanes[i].keyIndex;
  for (let j = i + 1; j < lanes.length; j++) {
    if (lanes[j].keyIndex !== dead) return j;
  }
  return i + 1;   // no other key in the pool — ordinary advance (exhaustion follows; no free tail exists on codex — D4)
}

// the CLI argument vector AFTER the executable. Fake mode prepends the fake
// script path under the node executable; the fake then echoes
// process.argv.slice(2) = THIS vector (the real spawn boundary). The prompt
// is the LAST element, verbatim — the FSM envelope IS the prompt (R2: no
// AGENTS.md, no side files; instructions ride the prompt).
export function codexArgv(envelope, lane, { workdir, outPath } = {}) {
  const entry = codexModelEntry(lane.model);
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--disable', 'apps',
    '-C', workdir,
    '-m', lane.model,
    '-c', `model_context_window=${entry.ctx}`,
    '-o', outPath,
    envelope.prompt,
  ];
}

// M-1/D14: the credential denylist — these keys NEVER inherit into the
// codex child env (the live-proven /proc/<pid>/environ leak class: both pool
// keys, the 73-key free pool, the contents:write job token, the GL mirror
// token, the stale caller auth, the bridge telemetry path). The lane overlay
// then deliberately sets the ONLY auth the child holds: the lane key.
// R6: the full 8-member CC set INCLUDING ANTHROPIC_AUTH_TOKEN (free
// defense-in-depth — the worker env never sets ANTHROPIC_* today).
export const CODEX_ENV_DENYLIST = [
  'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'GH_TOKEN', 'GITHUB_TOKEN',
  'ANTHROPIC_AUTH_TOKEN', 'GL_PAT', 'BRIDGE_LANE_LOG', 'OPENROUTER_KEY_POOL',
];

// the per-lane env overlay (D14): CODEX_HOME + the lane key (the inversion)
// + the engine-neutral kit lines (the F-M8 pair the CC lane also sets).
export function codexLaneEnv(lane, envelope, extra = {}) {
  return {
    CODEX_HOME: extra.CODEX_HOME,
    OPENROUTER_API_KEY: lane.key,
    OX_AGENT_TASK_ID: envelope.task_ref.id,
    OX_AGENT_DEADLINE_UTC: new Date(envelope.deadline_ms).toISOString(),
    ...extra,
  };
}

// the merged child env: the caller's env (PATH et al.) MINUS the denylist,
// then the lane overlay. Pure + exported for the M-1 unit pin.
export function codexChildEnv(env, lane, envelope, extra = {}) {
  const childEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (CODEX_ENV_DENYLIST.includes(k)) continue;   // credentials never inherit
    if (typeof v !== 'string') continue;
    childEnv[k] = v;
  }
  Object.assign(childEnv, codexLaneEnv(lane, envelope, extra));
  return childEnv;
}

// ---------------------------------------------------------------------------
// The JSONL event decode (pure — the cx-runner's parse_events, ported).
// ---------------------------------------------------------------------------

const CODEX_BENIGN_ERROR_RE = /^Reconnecting/;
const CODEX_MODEL_METADATA_RE = /^Model metadata .* not found/;

// decodeCodexEvents(stdout) — torn-tail tolerant (a hard-killed stream can
// end mid-line). Returns:
//   threadId       thread.started.thread_id (the session label — audit only,
//                  D9: no engine in fsm-lab resumes today)
//   turns          the turn.started count (telemetry.turns)
//   message        the LAST agent_message item's text (content)
//   reasoning      the last reasoning item's text (the F-M4 shape)
//   usage          turn.completed.usage SUMMED across turns (all five
//                  counters; cached_input_tokens included)
//   sawUsage       true when any turn.completed event carried a usage object
//   errorMessage   the CLASSIFYABLE error surface: turn.failed's error
//                  message, else the last non-benign `error` event message
//                  ("Reconnecting…" stream-retry notices and the env_key
//                  "Model metadata not found" fallback warning are skipped —
//                  the cx-runner's filters)
//   sawTurnFailed  the turn.failed marker
export function decodeCodexEvents(stdout) {
  const out = {
    threadId: null, turns: 0, message: null, reasoning: null,
    usage: {
      input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 0, reasoning_output_tokens: 0,
    },
    sawUsage: false, errorMessage: null, sawTurnFailed: false,
  };
  let lastAgentMsg = null;
  let lastReasoning = null;
  let lastErrorMsg = null;
  for (const line of String(stdout ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }   // torn tail (hard kill) or noise
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) continue;
    const t = ev.type;
    if (t === 'thread.started') {
      out.threadId = typeof ev.thread_id === 'string' ? ev.thread_id : null;
    } else if (t === 'turn.started') {
      out.turns += 1;
    } else if (t === 'turn.completed') {
      const u = ev.usage && typeof ev.usage === 'object' ? ev.usage : {};
      let any = false;
      for (const k of Object.keys(out.usage)) {
        const v = u[k];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) { out.usage[k] += v; any = true; }
        else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) { out.usage[k] += Number(v); any = true; }
      }
      if (any) out.sawUsage = true;
    } else if (t === 'turn.failed') {
      out.sawTurnFailed = true;
      const err = ev.error && typeof ev.error === 'object' ? ev.error : {};
      lastErrorMsg = typeof err.message === 'string' && err.message !== '' ? err.message : String(err);
    } else if (t === 'error') {
      const msg = typeof ev.message === 'string' ? ev.message : '';
      if (CODEX_BENIGN_ERROR_RE.test(msg)) continue;                       // stream retries
      if (CODEX_MODEL_METADATA_RE.test(msg)) continue;                     // env_key fallback warning
      lastErrorMsg = msg;
    } else if (t === 'item.completed' || t === 'item.updated') {
      const item = ev.item && typeof ev.item === 'object' ? ev.item : {};
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text !== '') {
        lastAgentMsg = item.text;
      } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text !== '') {
        lastReasoning = item.text;
      }
    }
  }
  out.message = lastAgentMsg;
  out.reasoning = lastReasoning;
  out.errorMessage = lastErrorMsg !== null && lastErrorMsg !== '' ? lastErrorMsg : null;
  return out;
}

// codexErrorClass(msg) — the cx-runner's classify_error, ported (D4
// ordering). Returns the class string or null ("failed"/nothing rotatable).
export function codexErrorClass(msg) {
  if (typeof msg !== 'string' || msg === '') return null;
  const low = msg.toLowerCase();
  if (msg.includes('402') || low.includes('payment required') || low.includes('insufficient')) {
    if (low.includes('in_flight')) return 'error_in_flight_budget';   // transient — plain advance here (no backoff loop exists)
    return 'error_credits';                                           // key-class: the JUMP
  }
  if (msg.includes('401') || low.includes('unauthorized') || low.includes('no auth')) return 'error_auth';
  if (msg.includes('429') || low.includes('rate limit') || low.includes('rate_limit')) {
    if (low.includes('per_day') || low.includes('daily') || low.includes('free-models-per-day')) return 'error_quota_daily';
    return 'error_rate_limit';
  }
  if (low.includes('invalid_prompt') || low.includes('invalid responses api request')) return 'error_model_400';
  if (low.includes('name must be at most')) return 'error_model_400';
  if (['500', '502', '503', '504'].some((c) => msg.includes(c))
    || low.includes('server error') || low.includes('bad gateway') || low.includes('service unavailable')) return 'error_network';
  if (low.includes('timed out') || low.includes('timeout') || low.includes('connection')
    || low.includes('network') || low.includes('dns') || low.includes('broken pipe')) return 'error_network';
  return null;   // the cx ladder's 'failed' — nothing classifiable: the EXIT CODE decides (R7)
}

// codexLaneOutcome(rc, errorClass) — the R7 PRECEDENCE, pure (the unit
// suite pins every row): exit 2 ALWAYS terminalizes D13's codex-usage (even
// when a stream somehow carried a classifiable event — clap fails before
// any model call, so the two never co-occur in practice); otherwise a
// rotatable event class WINS over the exit code (key-class → the JUMP);
// otherwise the exit code classifies (1 = work-failed shape, 0 = extract).
export function codexLaneOutcome(rc, errorClass) {
  if (rc === 2) {
    return { action: 'terminal', status: 'infra_failed', detailPrefix: 'codex-usage', rotate: false };
  }
  if (errorClass !== null && CODEX_ROTATABLE_ERROR_EVENTS.has(errorClass)) {
    return { action: 'rotate', keyClass: CODEX_KEY_CLASS_EVENTS.has(errorClass), detail: `codex-${errorClass}` };
  }
  if (rc !== 0 && rc !== null && rc !== undefined) {
    return { action: 'terminal', status: 'work_failed', detailPrefix: `codex-exit-${rc}` };
  }
  return { action: 'extract' };
}

// ---------------------------------------------------------------------------
// lane_stats synthesis (D6) — usage × the models.json price table.
// ---------------------------------------------------------------------------

// isCodexPeakWindow(atMs, entry) — the deepseek weekday-peak check (hours
// 01-04 and 06-10 UTC, Mon-Fri). glm carries no `peak` key (never peaks).
export function isCodexPeakWindow(atMs, entry) {
  if (!entry || !entry.peak || !(entry.peak.multiplier > 1)) return false;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return false;
  const d = new Date(atMs);
  const hours = Array.isArray(entry.peak.hours_utc) ? entry.peak.hours_utc : [];
  const days = Array.isArray(entry.peak.days_utc) ? entry.peak.days_utc : [];
  return hours.includes(d.getUTCHours()) && days.includes(d.getUTCDay());
}

// codexUsageCost(usage, entry, atMs) — the recomputed cost in USD (NEVER an
// engine meter): (input − cached) at price_in + cached at price_cache_read +
// output at price_out, all /1M. The peak multiplier doubles price_in and
// price_out ONLY (the cache-read rate is not doubled — the verified-price
// note in models.json). reasoning_output_tokens ride inside output_tokens
// (the cx-runner's same choice). Rounded to 6 decimals (the cx-runner's
// per-attempt rounding discipline).
export function codexUsageCost(usage, entry, atMs = null) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const input = num(usage?.input_tokens);
  const cached = Math.min(num(usage?.cached_input_tokens), input);
  const output = num(usage?.output_tokens);
  const mult = isCodexPeakWindow(atMs, entry) ? (entry.peak.multiplier ?? 1) : 1;
  const priceIn = (entry.price_in ?? 0) * mult;
  const priceOut = (entry.price_out ?? 0) * mult;
  const priceCache = entry.price_cache_read ?? 0;
  const cost = ((input - cached) * priceIn + cached * priceCache + output * priceOut) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

// the per-lane synthesized bridge-log lines (the laneLogLine 9-key shape,
// consumed by the SHARED aggregate — the exact lane-telemetry.mjs:38-42
// output by construction):
//   a lane that reported usage        → an ok call line (status 200, the
//     recomputed cost, the full input as tokens_in — cached included)
//   a lane that failed with a
//     classifiable error event        → an error call line (the class →
//     status mapping: credits 402, auth 401, quota/rate 429, model 400,
//     network stays null — transport-shaped, honestly in NO bucket)
//   anything else (exit 2 clap, unclassifiable exit 1, spawn failures,
//     wall kills) → NO line: the lane never reported model-side accounting
export function codexUsageLaneLine({ ts, ms, model, usage, atMs }) {
  const entry = codexModelEntry(model);
  return laneLogLine({
    ts, model, status: 200, ms,
    tokens_in: usage.input_tokens, tokens_out: usage.output_tokens,
    cost: codexUsageCost(usage, entry, atMs ?? ts),
    rate_class: null, err_code: null,
  });
}

export function codexErrorLaneLine({ ts, ms, model, errorClass }) {
  const status = errorClass === 'error_credits' ? 402
    : errorClass === 'error_auth' ? 401
      : (errorClass === 'error_quota_daily' || errorClass === 'error_rate_limit') ? 429
        : errorClass === 'error_model_400' ? 400 : null;
  return laneLogLine({ ts, model, status, ms, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: null, err_code: errorClass });
}

// ---------------------------------------------------------------------------
// The spawn (process-group-scoped, wall-killed — the F-M6 mechanics,
// implemented locally: cc-adapter's runLane is module-private and this
// branch does not refactor it).
// ---------------------------------------------------------------------------

function runLane({ cmd, args, cwd, childEnv, wallMs, log }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const errs = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errs.push(d));
    let wallKilled = false;
    let settled = false;
    let spawnError = null;
    let forceTimer = null;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } };
    const settle = (rc, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (forceTimer) clearTimeout(forceTimer);
      // F-M6: reap the group even on normal exit — an escapee grandchild
      // holding inherited pipes must never outlive the turn
      killGroup();
      resolve({ rc, signal, stdout: out.join(''), stderr: errs.join(''), wallKilled, pid: child.pid, spawnError });
    };
    const wallTimer = setTimeout(() => {
      wallKilled = true;
      killGroup();
      log(`CODEX-WALL-KILL pid=${child.pid} at ${Math.round(wallMs)}ms (group SIGKILL — the self-reported reaper)`);
      // a detached escapee holding the stdout pipe cannot stall the wall:
      // force-resolve shortly after the group kill with what we have
      forceTimer = setTimeout(() => settle(null, 'SIGKILL'), 250);
    }, Math.max(0, wallMs));
    child.on('close', (code, sig) => settle(code, sig));
    child.on('error', (e) => { spawnError = e; settle(-1, null); });
  });
}

// ---------------------------------------------------------------------------
// The workdir scan (the write-back claim surface). R1's law: the codex
// exclude set is EMPTY — nothing codex-owned lands in the workdir (the -o
// file, the fallback CODEX_HOME and the lane-stats scratch all live in the
// turn-scoped scratch dir OUTSIDE it), so EVERY file found is a claim and
// the door governs the rest. A stray AGENTS.md ⇒ root-not-declared fires.
// ---------------------------------------------------------------------------

function scanWorkdir(root) {
  const refs = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        refs.push(relative(root, full).split('\\').join('/'));
      }
    }
  };
  walk(root);
  refs.sort();
  return refs;
}

function stageAllowed(door, workdir, stageDir) {
  if (!door.ok || !door.allowed.length) return [];
  const staged = [];
  for (const rel of door.allowed) {
    const src = join(workdir, rel);
    const dst = join(stageDir, rel);   // rel is already tasks/<id>/…-shaped
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      staged.push(rel);
    } catch { /* staging is best-effort — the door verdict is the governance */ }
  }
  return staged;
}

// ---------------------------------------------------------------------------
// Transcripts (F15 — engine-derived provenance: harness 'codex', mode
// 'codex'; local implementation, cc-adapter untouched on this branch).
// ---------------------------------------------------------------------------

function codexTranscriptPaths(envelope, runId) {
  const base = `sessions/${envelope.task_ref.id}/${runId}-a${envelope.attempt}`;
  return { txt: `${base}.txt`, meta: `${base}.meta.json` };
}

function codexTranscriptBody(envelope, runId, fake, result) {
  const lanes = (result.telemetry?.lanes || [])
    .map((l) => `  lane ${l.lane}: key#${l.key_index} ${l.model} rc=${l.rc}${l.signal ? ` signal=${l.signal}` : ''} ${l.duration_ms}ms class=${l.class}`).join('\n');
  return [
    `fsm-lab CODEX transcript (mode: codex${fake ? ' — CODEX_FAKE_LLM determinism run' : ''})`,
    `task: ${envelope.task_ref.id}   run: ${runId}   attempt: ${envelope.attempt}`,
    `session: ${envelope.session}`,
    `deadline_utc: ${new Date(envelope.deadline_ms).toISOString()}   budget: ${JSON.stringify(envelope.budget)}`,
    `lanes (${result.lane_attempts_used} used):`,
    lanes || '  (none)',
    '--- PROMPT ---',
    envelope.prompt,
    '--- RESULT ---',
    `${result.status}${result.detail ? ` (${result.detail})` : ''}`,
    String(result.content ?? result.reasoning ?? '(no content)'),
    '--- ARTIFACT_REFS ---',
    (result.artifact_refs || []).join('\n') || '(none)',
    '--- TELEMETRY ---',
    JSON.stringify(result.telemetry, null, 2),
    '',
  ].join('\n');
}

function codexTranscriptMeta(envelope, runId, fake, result, nowIso) {
  return JSON.stringify({
    task: envelope.task_ref.id, run_id: runId, attempt: envelope.attempt,
    session: envelope.session, mode: 'codex', fake, harness: 'codex',
    deadline_utc: new Date(envelope.deadline_ms).toISOString(),
    status: result.status, detail: result.detail ?? null,
    models: result.models || [], lane_attempts_used: result.lane_attempts_used,
    duration_ms: result.duration_ms, artifact_refs: result.artifact_refs || [],
    transcript: codexTranscriptPaths(envelope, runId).txt, written_at: nowIso,
  }, null, 2) + '\n';
}

// the real-mode push (s25/b1 — the X29 F3 rebuild): per-file contents-API
// CAS via the shared worker/sessions-push.mjs engine — race-free by
// construction (no shared branch tip to fast-forward, no ref lock, no
// clone: the 13-parallel X29 convoy that re-turned 10 runs / $0.005701 /
// 100,911 tokens is structurally gone). The repo/token seam is the F2 law:
// FSM_SESSIONS_REPO/FSM_SESSIONS_TOKEN (the custom names that REACH the
// process on real runners — step-env overrides of GITHUB_* defaults are
// silently ignored by the runner) with the GITHUB_REPOSITORY/GH_TOKEN
// back-compat pair for tests/sims that set the old vocabulary. The token
// never reaches a log line (the Authorization header only). Retry ladder:
// the engine's per-PUT budget (3 attempts, backoff+jitter, 409/422/5xx/
// network). s25/X30: the engine's 10-attempt jittered ladder is the absorber —
// this wrapper makes exactly ONE call (the old outer whole-set retry is gone).
// exported as the ADAPTER SEAM for the mock-first pins (the s25/b1 suite
// drives the real-mode lane through fetchImpl — zero network, zero git).
// s25/X30: the engine's OWN retry ladder is the absorber (10 jittered
// attempts); this wrapper makes exactly ONE call — the old outer whole-set
// retry is REMOVED (it re-fed the 409 storm).
export async function pushSessionsContents({ env, files, log, fetchImpl, sleepImpl, rand }) {
  const repo = sessionsRepoFromEnv(env);
  const token = sessionsTokenFromEnv(env);
  if (!repo || !token) throw new Error('sessions push needs FSM_SESSIONS_REPO + FSM_SESSIONS_TOKEN (or the GITHUB_REPOSITORY/GH_TOKEN back-compat pair)');
  const out = await pushSessionFiles({
    repo,
    token,
    branch: 'fsm-sessions',
    files: [...files].map(([path, content]) => ({ path, content, message: `transcript: ${path}` })),
    log,
    env,
    fetchImpl,
    // s25/X30: the mock-first seams ride through (the storm pins drive the
    // 10-attempt ladder at zero wall-clock; the defaults are the live lane)
    ...(sleepImpl ? { sleepImpl } : {}),
    ...(rand ? { rand } : {}),
  });
  // the pinned line SHAPE stays byte-compatible for the run-log consumers;
  // the repo the files LANDED on is APPENDED — the X29 lesson (the split
  // record was invisible in the log: the line said fsm-sessions while the
  // files sat on the mirror repo)
  // s25/X31: the line reports the ACTUAL outcome — 'PUSHED n/m' on the
  // degraded path (the X31 T-X31-03 lesson: the unconditional 'PUSHED 2'
  // followed by 'DEGRADED 1/2' contradicted itself in the run log)
  if (out && out.mode === 'degraded') {
    log(`CODEX-TRANSCRIPT-PUSHED ${out.files.length}/${files.size} file(s) to fsm-sessions @ ${repo} (degraded — see the DEGRADED line)`);
  } else {
    log(`CODEX-TRANSCRIPT-PUSHED ${files.size} file(s) to fsm-sessions @ ${repo}`);
  }
  return out;
}

async function writeCodexTranscript(envelope, runId, fake, result, opts, log) {
  const paths = codexTranscriptPaths(envelope, runId);
  const body = codexTranscriptBody(envelope, runId, fake, result);
  const meta = codexTranscriptMeta(envelope, runId, fake, result, new Date(opts.now()).toISOString());
  // s25/X30 structure: ONE attempt, no outer whole-set retry (the old
  // retry RE-FED the 409 storm: a second 10-attempt ladder immediately
  // re-collides with the same moving ref; the internal jittered ladder IS
  // the absorber, and retryable exhaustion returns degraded — the turn
  // keeps its DONE status, the note rides the report summary). PERSISTENT
  // errors (and fake-mode local write failures — test-setup errors keep
  // the same wrap for classification) throw 'transcript-push-failed' (the
  // done-turn escalation below is unchanged: infra_failed).
  try {
    // fake mode: the local determinism lane, unchanged
    if (fake) {
      const dir = opts.transcriptsDir || opts.env.CODEX_FAKE_TRANSCRIPTS_DIR || join(tmpdir(), 'fsm-sessions-codex-fake');
      mkdirSync(join(dir, dirname(paths.txt)), { recursive: true });
      writeFileSync(join(dir, paths.txt), body);
      writeFileSync(join(dir, paths.meta), meta);
      return { mode: 'local', dir, txt: paths.txt, meta: paths.meta };
    }
    const out = await pushSessionsContents({
      env: opts.env,
      files: new Map([[paths.txt, body], [paths.meta, meta]]),
      log,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      rand: opts.rand,
    });
    if (out && out.mode === 'degraded') {
      // LOUD + structured: which files landed, which did not — the run log
      // keeps the full diagnosis; the report summary carries the headline
      log(`CODEX-TRANSCRIPT-DEGRADED ${out.files.length}/${out.files.length + out.failures.length} file(s) landed @ ${out.repo} — unlanded: ${out.failures.map((f) => f.path).join(', ')} (the 409-storm class: the turn KEEPS its done status; the record is degraded, the spend is not re-run)`);
    }
    return out;
  } catch (e) {
    throw new Error(`transcript-push-failed(${String(e?.message ?? e).slice(0, 160)})`);
  }
}

// the DONE-turn escalation composer for a failed artifact push — mirrors
// the CC shape (cc-adapter's artifactPushEscalation) with the codex summary
// prefix; the imported CC original hardcodes 'cc:' in its summary line.
export function codexArtifactPushEscalation(taskId, attempt, err, result) {
  return {
    status: 'infra_failed',
    detail: String(err?.message ?? err).slice(0, 200),
    artifact_refs: result.artifact_refs,
    summary: `codex: task ${taskId} attempt ${attempt} — the artifact branch push failed (${String(err?.message ?? err).slice(0, 120)})`,
    telemetry: result.telemetry, models: result.models,
    lane_attempts_used: result.lane_attempts_used, duration_ms: result.duration_ms,
    ...(result.lane_stats ? { lane_stats: result.lane_stats } : {}),
    ...(Number.isFinite(result.key_index) ? { key_index: result.key_index } : {}),
    ...(Number.isFinite(result.pool_size) ? { pool_size: result.pool_size } : {}),
  };
}

// ---------------------------------------------------------------------------
// codexTurn — the CODEX harness turn.
// ---------------------------------------------------------------------------

export async function codexTurn(envelope, opts = {}) {
  const {
    env = process.env,
    runId = 'local',
    now = Date.now,
    log = () => {},
    transcriptsDir = null,   // fake-mode transcript root (tests/conformance)
    stageDir = null,         // artifact staging root (the W-C seam)
    echoDir = null,          // fake-mode spawn-boundary echo root
    pushTaskBranchImpl = null,
    fetchImpl = null,       // s25/b1: the transcript lane's scripted-fetch seam
                             // (rides the opts spread into writeCodexTranscript →
                             // pushSessionsContents → pushSessionFiles; the mock-
                             // first pins drive the REAL-mode push with zero
                             // network; null/absent = the live global fetch)
  } = opts;

  // envelope shape guards — the same contract the shim/cc adapters enforce
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`codexTurn: envelope must be the ok-envelope object from envelopeFromDispatch (got ${envelope === null ? 'null' : typeof envelope})`);
  }
  const taskId = envelope.task_ref?.id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error(`codexTurn: envelope.task_ref.id must be a non-empty string (got ${JSON.stringify(taskId)}) — the artifact/transcript namespace depends on it`);
  }
  if (typeof envelope.prompt !== 'string') {
    throw new Error(`codexTurn: envelope.prompt must be a string (got ${typeof envelope.prompt})`);
  }
  if (typeof envelope.deadline_ms !== 'number' || !Number.isFinite(envelope.deadline_ms)) {
    throw new Error(`codexTurn: envelope.deadline_ms must be finite epoch-ms (got ${JSON.stringify(envelope.deadline_ms)}) — the wall kill depends on it`);
  }
  const attempt = Number.isInteger(envelope.attempt) && envelope.attempt >= 1 ? envelope.attempt : 1;
  // D15: max_turns is NOT consumed (no codex exec flag; the wall + the
  // config-side stream_idle_timeout_ms are the bounds) — wall + lane bound only.
  const budget = {
    wall_ms: Number.isFinite(envelope.budget?.wall_ms) ? envelope.budget.wall_ms : 60_000,
    lane_attempts: Number.isInteger(envelope.budget?.lane_attempts) && envelope.budget.lane_attempts >= 1 ? envelope.budget.lane_attempts : 3,
  };

  const fake = env.CODEX_FAKE_LLM === '1';
  // the wall arithmetic depends on now() returning EPOCH-MS — an ISO-string
  // clock fails LOUD here (the silent instant-kill class), same as ccTurn.
  const t0 = now();
  if (typeof t0 !== 'number' || !Number.isFinite(t0)) {
    throw new Error(`codexTurn: opts.now() must return finite epoch-ms (got ${typeof t0}: ${String(t0).slice(0, 40)}) — the wall timers depend on it`);
  }
  const wallDeadlineMs = Math.min(envelope.deadline_ms, t0 + budget.wall_ms);

  const lanes = codexLanes(env);
  const poolSize = new Set(lanes.map((l) => l.keyIndex)).size;
  const maxLanes = Math.min(lanes.length, Math.max(1, Math.min(8, budget.lane_attempts)));

  const baseTelemetry = (used) => ({
    turns: 0, wall_ms: now() - t0, lane_attempts_used: used, lanes: [],
  });
  const models = [];
  const laneLog = [];
  // the per-lane accounting records feeding the lane_stats synthesis (D6)
  const laneStatRecords = [];

  // THE SCRATCH LAW (R1): everything codex-owned lives in the turn-scoped
  // scratch dir OUTSIDE the workdir — the -o last-message file, the
  // synthesized lane-stats JSONL, and (only when the caller provides no
  // CODEX_HOME — B3's worker.yml owns the real one) the fallback codex home.
  // The workdir gets NOTHING but the task's own artifacts.
  const workdir = mkdtempSync(join(tmpdir(), fake ? 'codex-fake-' : 'codex-turn-'));
  const scratchDir = mkdtempSync(join(tmpdir(), fake ? 'codex-scratch-fake-' : 'codex-scratch-'));
  const outPath = join(scratchDir, 'last-message.txt');
  const laneStatsPath = join(scratchDir, 'lane-stats.jsonl');
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== ''
    ? env.CODEX_HOME
    : join(scratchDir, 'codex-home');
  mkdirSync(codexHome, { recursive: true });   // gotcha #2: CODEX_HOME must pre-exist
  const echoRootProvided = fake && echoDir;
  const echoRoot = fake ? (echoDir || mkdtempSync(join(tmpdir(), 'codex-echo-'))) : null;
  try {
    if (!lanes.length) {
      // routable infra marker — the key pool is empty (never a work attempt)
      return {
        status: 'infra_failed',
        detail: 'no-lane-keys(the OPENROUTER_API_KEY key pool is empty — set the repo secrets)',
        artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} had no lane keys`,
        telemetry: baseTelemetry(0), models, lane_attempts_used: 0, duration_ms: now() - t0,
      };
    }

    let lastClass = 'none';
    let laneIdx = 0;
    for (let i = 0; i < maxLanes && laneIdx < lanes.length; i++) {
      const lane = lanes[laneIdx];
      const argv = codexArgv(envelope, lane, { workdir, outPath });
      const extraEnv = {};
      if (fake) {
        mkdirSync(echoRoot, { recursive: true });
        extraEnv.CODEX_FAKE_ECHO_PATH = join(echoRoot, `lane-${i}.json`);
      }
      const laneT0 = now();
      if (laneT0 >= wallDeadlineMs) {
        // a previous lane consumed the wall — do not even spawn
        return await finalize({
          status: 'deadline', detail: 'wall-budget-exceeded',
          artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} ran out of wall budget before lane ${i + 1}`,
        }, i);
      }
      const r = await runLane({
        cmd: fake ? process.execPath : (typeof env.CODEX_BIN === 'string' && env.CODEX_BIN.trim() !== '' ? env.CODEX_BIN.trim() : 'codex'),
        args: fake ? [FAKE_CODEX_PATH, ...argv] : argv,
        cwd: workdir,
        childEnv: codexChildEnv(env, lane, envelope, { CODEX_HOME: codexHome, ...extraEnv }),
        wallMs: wallDeadlineMs - laneT0,
        log,
      });
      const laneInfo = {
        lane: i + 1, key_index: lane.keyIndex, model: lane.model,
        rc: r.rc, signal: r.signal ?? null, duration_ms: now() - laneT0,
        wall_killed: r.wallKilled, class: null,
      };
      laneLog.push(laneInfo);
      models.push(lane.model);

      // ---- the wall kill → deadline (rc=124-equivalent), TERMINAL --------
      if (r.wallKilled || (r.rc === null && r.signal)) {
        laneInfo.class = 'deadline';
        return await finalize({
          status: 'deadline', detail: 'wall-budget-exceeded',
          artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} hit the wall budget on lane ${i + 1} (${lane.model}) — process group killed, self-reported`,
        }, i + 1);
      }
      // ---- spawn failure → terminal infra (the environment is broken) ---
      if (r.spawnError) {
        laneInfo.class = 'infra';
        lastClass = `codex-spawn(${String(r.spawnError.message ?? r.spawnError).slice(0, 80)})`;
        return await finalize({
          status: 'infra_failed', detail: lastClass,
          artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} could not spawn the codex CLI (${lastClass}) — the B3 install gate owns this lane`,
        }, i + 1);
      }
      // ---- D13 FIRST: exit 2 = CLI usage/parse error — TERMINAL ----------
      // (R7's carve-out: exit 2 ALWAYS terminalizes codex-usage — clap fails
      // before any model call, so rotating would burn the budget on a
      // persistent argv bug; the exit-2 lane records NO model accounting)
      if (r.rc === 2) {
        laneInfo.class = 'infra';
        lastClass = `codex-usage(${(r.stderr.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 80)})`;
        log(`CODEX-LANE-EXIT rc=2 (CLI usage error — TERMINAL, no rotation) stderr=${JSON.stringify(r.stderr.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 200))}`);
        return await finalize({
          status: 'infra_failed', detail: lastClass,
          artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} exited 2 (CLI usage error) on lane ${i + 1} — the invocation is broken, not the lane; NO rotation`,
        }, i + 1);
      }
      // ---- R7: PARSE EVENTS FIRST — the stream classifies before the rc ---
      const ev = decodeCodexEvents(r.stdout);
      const errorClass = codexErrorClass(ev.errorMessage);
      const decision = codexLaneOutcome(r.rc, errorClass);
      if (decision.action === 'rotate') {
        laneInfo.class = 'infra';
        lastClass = decision.detail;
        // the accounting: usage lines record what the stream PROVED was
        // spent (a failed lane can still have completed earlier turns);
        // the classifiable error is the model-side failure line
        if (ev.sawUsage) laneStatRecords.push(codexUsageLaneLine({ ts: laneT0, ms: now() - laneT0, model: lane.model, usage: ev.usage, atMs: laneT0 }));
        laneStatRecords.push(codexErrorLaneLine({ ts: laneT0, ms: now() - laneT0, model: lane.model, errorClass }));
        log(`CODEX-LANE-ROTATE class=${decision.detail} key_class=${decision.keyClass} model=${lane.model} message=${JSON.stringify(String(ev.errorMessage ?? '').slice(0, 120))}`);
        laneIdx = codexNextLaneIndex(lanes, laneIdx, decision.keyClass);
        continue;
      }
      if (decision.action === 'terminal') {
        laneInfo.class = 'work';
        if (ev.sawUsage) laneStatRecords.push(codexUsageLaneLine({ ts: laneT0, ms: now() - laneT0, model: lane.model, usage: ev.usage, atMs: laneT0 }));
        const detailSrc = ev.errorMessage ?? (r.stderr.split('\n').find((l) => l.trim() !== '') ?? '');
        log(`CODEX-LANE-EXIT rc=${r.rc} model=${lane.model} stderr=${JSON.stringify(r.stderr.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300))}`);
        return await finalize({
          status: 'work_failed', detail: `${decision.detailPrefix}(${String(detailSrc).slice(0, 80)})`,
          artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} exited ${r.rc} on lane ${i + 1} (${lane.model})`,
        }, i + 1);
      }
      // ---- rc 0, nothing classifiable: the extraction --------------------
      const content = typeof ev.message === 'string' && ev.message !== '' ? ev.message : null;
      const reasoning = typeof ev.reasoning === 'string' && ev.reasoning !== '' ? ev.reasoning : null;
      if (ev.sawUsage) laneStatRecords.push(codexUsageLaneLine({ ts: laneT0, ms: now() - laneT0, model: lane.model, usage: ev.usage, atMs: laneT0 }));

      // the ONE classifier, per lane, decides the hop
      const cls = classifyOutcome({ content, reasoning });
      if (cls.status === 'infra_failed') {
        // error-as-answer (E11) or budget-misconfigured — rotate; only the
        // E11 marker conviction is key-class (the same rule ccTurn applies)
        laneInfo.class = 'infra';
        lastClass = cls.detail;
        laneIdx = codexNextLaneIndex(lanes, laneIdx,
          typeof cls.detail === 'string' && cls.detail.startsWith('error-as-answer'));
        continue;
      }
      // done | work_failed — the lane ANSWERED: terminal, no hop. Return the
      // RAW extraction shape; runTurn's single classifyOutcome call
      // re-derives the same class from the same fields.
      laneInfo.class = cls.status;
      return await finalize({
        scan: true,
        content, reasoning,
        summary: `codex: task ${taskId} attempt ${attempt} ${cls.status === 'done' ? 'completed' : 'failed'} on lane ${i + 1} (${lane.model})`,
      }, i + 1, { turns: ev.turns });
    }
    // ---- every lane burned: the routing-level infra marker ---------------
    return await finalize({
      status: 'infra_failed',
      detail: `lane-exhausted(${laneLog.length}/${lanes.length} lanes, last ${String(lastClass).slice(0, 80)})`,
      artifact_refs: [], summary: `codex: task ${taskId} attempt ${attempt} exhausted the lane budget (${laneLog.length}/${lanes.length})`,
    }, laneLog.length);

    // ---- the shared terminal tail: stats → scan → door → transcript -----
    async function finalize(partial, used, extra = {}) {
      // LANE_STATS (D6): the synthesized records → JSONL → the SHARED
      // collector (read + aggregate + delete) — the exact lane-telemetry
      // aggregate shape by construction. No records → no file → null → the
      // field stays absent (absent-means-absent down the whole drain).
      let laneStats = null;
      if (laneStatRecords.length) {
        writeFileSync(laneStatsPath, `${laneStatRecords.map((l) => JSON.stringify(l)).join('\n')}\n`);
        laneStats = collectLaneStats(laneStatsPath);
      }
      // the s21/O-3 key pick pair (0-based journal semantics, 1-based
      // telemetry display — the same convention ccTurn pins)
      const lastLane = laneLog.length ? laneLog[laneLog.length - 1] : null;
      const laneKeyFields = lastLane && Number.isFinite(lastLane.key_index) && poolSize > 0
        ? { key_index: lastLane.key_index - 1, pool_size: poolSize }
        : {};
      // the write-back claim surface: the workdir scan — ONLY for lanes that
      // ran to rc 0 and answered; every failure shape carries []
      const refs = partial.scan === true ? scanWorkdir(workdir) : (partial.artifact_refs ?? []);
      let result = {
        ...partial,
        artifact_refs: refs,
        ...(laneStats ? { lane_stats: laneStats } : {}),
        ...laneKeyFields,
        telemetry: {
          turns: extra.turns ?? 0,
          wall_ms: now() - t0,
          lane_attempts_used: used,
          lanes: laneLog,
        },
        models: [...models],
        lane_attempts_used: used,
        duration_ms: now() - t0,
      };
      delete result.scan;
      // the raw-extraction shape (content/reasoning, NO stamped status) is
      // returned VERBATIM — runTurn's single classifyOutcome call extracts
      // done/work_failed exactly like the cc lane's {content} shape. The
      // in-adapter class is computed for the door + transcript only.
      const internalCls = result.status
        ? { status: result.status, detail: result.detail }
        : classifyOutcome({ content: result.content ?? null, reasoning: result.reasoning ?? null });
      // THE DOOR (D4): violations → poison, BEFORE anything is trusted or
      // staged (runTurn's door is the backstop). R1's counter-pin: a stray
      // AGENTS.md (any undeclared workdir file) fires writeBackDoor here.
      let door = null;
      if (Array.isArray(result.artifact_refs) && result.artifact_refs.length) {
        const measured = {};
        for (const rel of result.artifact_refs) {
          try { measured[rel] = statSync(join(workdir, rel)).size; } catch { /* unwritten claim: 0 — the read-back catches it */ }
        }
        door = writeBackDoor({
          branch: `tasks/${taskId}`,
          paths: result.artifact_refs,
          sizes: measured,
          allowRoot: Array.isArray(opts.allowRoot) ? opts.allowRoot : [],
        });
        if (!door.ok) {
          result = {
            ...result,
            status: 'poison',
            detail: `write-back-door(${door.violations.join('; ').slice(0, 160)})`,
          };
        }
      }
      // TRANSCRIPTS BEFORE THE REPORT (F-M6) — harness:'codex' provenance
      const forTranscript = { ...result, status: internalCls.status, detail: result.detail ?? internalCls.detail };
      try {
        result.transcript = await writeCodexTranscript(envelope, runId, fake, forTranscript, { ...opts, env, now }, log);
        result.transcript.txt = codexTranscriptPaths(envelope, runId).txt;
        // s25/X30: the DEGRADED transcript (409-storm exhaustion) rides the
        // report summary — the FSM keeps the DONE status (no re-run of a
        // completed paid turn); the note is the journal-visible marker the
        // ops console reads (artifact field carries the summary on dones).
        // typeof-guard: the happy-path result carries no summary until the
        // compose step — undefined + ' += ' would stringify 'undefined'.
        // s25-r1/R4: the shared, PINNED note builder (the inline twin was
        // unpinned — the reviewer's cc-glue mutation survived the suite)
        if (result.transcript && result.transcript.mode === 'degraded') {
          result.summary = appendTranscriptNote(result.summary, result.transcript);
        }
      } catch (e) {
        // the transcript lesson: a FAILED turn keeps its work-class result
        // (the escalation would mask the diagnosis); only a DONE turn
        // escalates — its report references the transcript.
        if (internalCls.status === 'done') {
          return {
            status: 'infra_failed',
            detail: String(e?.message ?? e).slice(0, 200),
            artifact_refs: result.artifact_refs,
            summary: `codex: task ${taskId} attempt ${attempt} — the transcript never landed (${String(e?.message ?? e).slice(0, 120)})`,
            telemetry: result.telemetry, models: result.models,
            lane_attempts_used: result.lane_attempts_used, duration_ms: result.duration_ms,
            ...(result.lane_stats ? { lane_stats: result.lane_stats } : {}),
            ...laneKeyFields,
          };
        }
        log(`CODEX-TRANSCRIPT-MISSED (best-effort for a ${internalCls.status} turn): ${String(e?.message ?? e).slice(0, 160)}`);
        result.summary += ` [transcript missed: ${String(e?.message ?? e).slice(0, 80)}]`;
      }
      // the W-C2 task-branch write-back (the engine-neutral seam IMPORTED
      // from cc-adapter): the door-allowed set commits to refs/heads/tasks/
      // <id> with the remote-tip read-back. REAL mode only; fake mode keeps
      // the local stage. A DONE turn whose push fails escalates to
      // infra_failed 'artifact-push' (net-zero retry); a FAILED turn keeps
      // its work-class result.
      if (door?.ok && door.allowed.length) {
        if (fake) {
          const root = stageDir || env.CODEX_STAGE_DIR || join(tmpdir(), 'fsm-stage-codex');
          const staged = stageAllowed(door, workdir, root);
          if (staged.length) log(`CODEX-STAGED ${staged.length} artifact(s) under ${root} (fake-mode local stage — the determinism lane)`);
        } else {
          const pusher = pushTaskBranchImpl || pushTaskBranch;
          let push = null;
          try {
            push = pusher({ env, branch: `tasks/${taskId}`, allowed: door.allowed, workdir, log });
            if (push && push.ok !== true) throw new Error(`artifact-push: ${String(push.err || push.error || 'rejected').slice(0, 160)}`);
          } catch (e) {
            if (internalCls.status === 'done') {
              return codexArtifactPushEscalation(taskId, attempt, e, result);
            }
            log(`CODEX-TASKBRANCH-MISSED (best-effort for a ${internalCls.status} turn): ${String(e?.message ?? e).slice(0, 160)}`);
            result.summary += ` [artifact push missed: ${String(e?.message ?? e).slice(0, 80)}]`;
          }
          if (push && push.ok) {
            result.task_branch = { branch: push.branch, committed: push.committed.length };
          }
        }
      }
      return result;
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    // the scratch dir: the -o file, the lane-stats JSONL (consumed), and the
    // FALLBACK codex home (only when the caller provided none — B3's
    // $HOME/.codex-fsm is env-sourced and never reaped here)
    rmSync(scratchDir, { recursive: true, force: true });
    // an internally-created echo root is unreadable by the caller — reap it;
    // a PROVIDED one stays (conformance reads the boundary records after)
    if (echoRoot && !echoRootProvided) rmSync(echoRoot, { recursive: true, force: true });
  }
}
