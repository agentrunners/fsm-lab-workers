// cc-adapter.mjs — the CC harness turn (T46/W-B §1d, W4).
//
// THE CONTRACT: ccTurn(envelope, opts) consumes the turn envelope from
// envelopeFromDispatch and returns the SAME contract return the shim returns
// ({status?, content?, reasoning?, artifact_refs, summary, telemetry} + the
// raw-lane extras runTurn's single classifyOutcome call consumes). The shim
// (sim/harness-shim.mjs) is the conformance reference (C3 folded per D1);
// worker/conformance-cc.mjs drives THIS adapter through the same behavior
// matrix and asserts parity.
//
// THE SPAWN (F-M7 — asserted by the fake-CLI conformance at the boundary):
//   npx -y @anthropic-ai/claude-code@<CC_VERSION|2.1.273>   (M-4: pinned)
//        -p <envelope.prompt>
//        --max-turns <budget.max_turns>          (the CLI's own turn cap)
//        --output-format json                    (the parseable result)
//        --disallowedTools WebFetch,WebSearch    (SA-5: mcp-web replaces)
//   cwd = a fresh temp workdir (the CLI's writes there are the write-back
//   claim surface — scanned post-turn, governed by the door).
//   REAL-interface note (checked live 2026-09-16, claude-code 2.1.273):
//   --max-turns exists in the binary but is NOT in `--help`'s top list; the
//   F-M8 env names (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL,
//   DISABLE_TELEMETRY) are all present in the binary. --disallowedTools is
//   the documented deny surface (comma-separated, one argv element).
//
// THE ENV CONTRACT (F-M8, per lane):
//   ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1   (the OpenRouter bridge)
//   ANTHROPIC_AUTH_TOKEN=<lane key>                   (key pool, A5/D2)
//   ANTHROPIC_MODEL=<lane model>                      ANTHROPIC_SMALL_FAST_MODEL=<same>
//   DISABLE_TELEMETRY=1
//   OX_AGENT_DEADLINE_UTC=<envelope.deadline_ms as ISO>  (the kit contract)
//   OX_AGENT_TASK_ID=<task id>                        (the artifact namespace)
//
// THE LANE PICKER (D2): key pool [OPENROUTER_API_KEY, OPENROUTER_API_KEY_2] ×
// model chain [CC_MODEL, deepseek-v4.1-flash, glm-5.3-flash,
// cohere/north-mini-code:free] (T46/W-D §D2: the s19 cc-lane eval verdict —
// deepseek primary, glm fallback for provider diversity; s24 FLIPS the free
// tail nemotron→cohere — the live eval: cohere 6/6 vs nemotron 1/6, the
// nemotron 500-tax ACTIVE at its worst (4×500+504, 30-150s failure
// latencies);
// deepseek-v4-flash-0731:free is NEVER on this lane — it hallucinated
// the eval task, silent content-poison, and is 404-dead upstream anyway
// (s23 probe §1b) — the exclusion is now self-enforcing), flattened
// KEY-MAJOR (every model on key 1 before key 2's first), bounded by
// budget.lane_attempts (default 3). INFRA-class lane failure
// (401/402/429/5xx text-as-answer, transport-shaped stderr,
// budget-misconfigured truncation) → next lane. s21/W1: a KEY-CLASS
// failure (401/402/429) JUMPS to the next key's first lane — a drained
// primary fails over to KEY_2 inside the dispatched budget instead of
// grinding the dead key's remaining models (ccNextLaneIndex). s23/B1:
// when there IS no next key (the LAST key's key-class failure — both paid
// keys dry, the W1 live arc's terminal shape), the advance skips the dead
// key's PAID siblings and lands on the same key's `:free` tail slot (the
// FREE-TAIL rule: a $0 request passes the cost-proportional credit
// pre-flight — a drained key still serves free traffic; the paid siblings
// share the dead key's credit state, so burning a slot on glm is a
// no-backoff retry of a known-dead key). WORK-class (the CLI ran and
// answered: empty completion, deterministic app error, max-turns) → NO
// hop: rotating the lane cannot change the answer. GHA runners rotate IPs
// naturally (the TOS-multi-account concern's real answer); sandbox-origin
// calls are validity probes only.
//
// THE WALL (F-M6): the spawn is PROCESS-GROUP-scoped (detached:true makes the
// CLI its own group leader; kill(-pid) reaps the whole group). The adapter
// enforces wall-clock at min(envelope.deadline_ms, start + budget.wall_ms):
// at the wall the GROUP is SIGKILLed (leader + every same-group child — no
// orphan CLI past the report) and the turn returns {status:'deadline',
// detail:'wall-budget-exceeded'} (the rc=124 equivalent — the self-reported
// reaper). A post-kill 250ms force-resolve guards the pipes-held-by-an-
// escapee case so the wall can never stall the report.
//
// DETERMINISM (CC_FAKE_LLM=1): the REAL lane is NEVER touched by tests.
// Fake mode spawns worker/fake-cc.mjs with the REAL argv (only the command
// head swaps: `npx -y <pkg>` → `node fake-cc.mjs`), so the echoed spawn
// boundary IS the real one. The fake picks a fixture by a marker in the
// prompt ([fixture:429], [fixture:reasoning], …) and answers deterministically
// — zero network, zero npm install. The adapter's outcome surface (status,
// detail, artifact_refs, models, lane structure) is deterministic in fake
// mode; telemetry.wall_ms / duration_ms are physical measurements and vary.
//
// TRANSCRIPTS (F-M6, D3) — BEFORE the report: the full turn (prompt + result
// + telemetry) lands as sessions/<task>/<run>-a<attempt>.txt (+ .meta.json)
// BEFORE ccTurn returns — the report (enqueued by runTurn afterwards)
// references the transcript path, so the ordering is structural. Push failure
// → retry once, then the turn reports infra_failed 'transcript-push-failed'.
// Real mode (s25/b1 — the X29 F3/F2 rebuild): per-file CONTENTS-API pushes
// via the shared worker/sessions-push.mjs engine (race-free by construction;
// the repo/token seam is FSM_SESSIONS_REPO/FSM_SESSIONS_TOKEN — the custom
// names that REACH the process — with the GITHUB_REPOSITORY/GH_TOKEN
// back-compat pair); fake mode: a LOCAL directory
// (env.CC_FAKE_TRANSCRIPTS_DIR, default <tmp>/fsm-sessions-
// fake) — deterministic tests never touch git.
//
// ARTIFACTS (D4): post-turn the workdir is scanned; every regular file
// except the documented CLI-internal scratch (.claude/**, .claude.json) is a
// write-back claim. The door (writeBackDoor) governs FIRST: violations → the
// turn returns the POISON class (the door is the governance — same violation
// text runTurn's door produces for the shim lane; runTurn's door remains the
// backstop). Allowed paths are STAGED locally (opts.stageDir /
// env.CC_STAGE_DIR) — the W-C seam: the live task-branch commit + remote
// read-back (consuming the door's {branch, allowed[], totalBytes, caps}
// return shape) replaces the local staging when the task-branch flow ships.
//
// TELEMETRY rides the report's outcome: lane attempts used, per-lane
// {key_index, model, rc, duration_ms, class}, models tried, real duration.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyOutcome, writeBackDoor } from '../lib/worker-contract.mjs';
import { collectLaneStats } from './lane-telemetry.mjs';
// s25/b1 (the X29 F3/F2 rebuild): the transcript lane's shared contents-API
// engine + the custom-name repo/token seam — the law and the live lesson
// (run 35999041887) are recorded at the top of worker/sessions-push.mjs.
import { pushSessionFiles, sessionsRepoFromEnv, sessionsTokenFromEnv, appendTranscriptNote } from './sessions-push.mjs';

const FAKE_CC_PATH = fileURLToPath(new URL('./fake-cc.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// The lane algebra (pure, exported for the unit suite).
// ---------------------------------------------------------------------------

export const CC_BRIDGE_BASE_URL = 'https://openrouter.ai/api/v1';
// s23/B2: the PAID defaults (the OPENROUTER-KEYS §S23 approved pair — paid
// traffic rides ONLY these two models) and the FREE tail slot, composed by
// ccModelChain. CC_MODEL_CHAIN_DEFAULTS stays the DEFAULT chain's exact
// shape (the deployed [ds, glm, cohere:free], pinned verbatim below).
// s24 — THE TAIL FLIP (the pre-registered rule, research/s23-cc-tail.md §7
// open question 1, met): the live eval (2026-09-24,
// scripts/s24-cohere-tail-results.json) — cohere/north-mini-code:free 6/6
// (all 200s on the 32K pre-flight across 4 key classes incl. drained /
// overdrawn keys; content-bearing turn-shaped completions 4-9.5s; ZERO
// transport-class failures) vs nemotron 1/6 (4×500 + 1×504, failure
// latencies 30-150s — the 500-tax ACTIVE and worse than the s23 probe's
// 2/6). The default flips nemotron → cohere; nemotron stays exactly one
// CC_TAIL_MODEL env line away (the s23 swap mechanism, pinned in tests).
export const CC_PAID_MODEL_DEFAULTS = [
  'deepseek/deepseek-v4.1-flash',
  'z-ai/glm-5.3-flash',
];
export const CC_TAIL_MODEL_DEFAULT = 'cohere/north-mini-code:free';
export const CC_MODEL_CHAIN_DEFAULTS = [...CC_PAID_MODEL_DEFAULTS, CC_TAIL_MODEL_DEFAULT];
// SA-5: the web tools are DENIED at the CLI boundary (mcp-web replaces them)
export const CC_PERMISSION_DENIES = ['WebFetch', 'WebSearch'];
// CLI-internal scratch the adapter never claims as write-back (workdir-local,
// dies with the workdir; anything else the CLI writes IS a claim)
export const CC_SCRATCH_EXCLUDE = ['.claude', '.claude.json'];

export function ccModelChain(env = process.env) {
  const custom = typeof env.CC_MODEL === 'string' && env.CC_MODEL.trim() !== '' ? [env.CC_MODEL.trim()] : [];
  // s21/W7 (a2): dedup the custom head against the defaults — the deployed
  // CC_MODEL (deepseek/deepseek-v4.1-flash == CC_MODEL_CHAIN_DEFAULTS[0])
  // made lane 2 an EXACT (key, model) repeat of lane 1: a no-backoff plain
  // retry that pushes glm/the-tail and KEY_2's block further out of the
  // 3-slot dispatched budget (compounds W1, the unreachable failover).
  // Custom wins (the operator's head position); the duplicate slot drops.
  //
  // s23/B2 — THE TAIL SLOT (the free-model tail design §2.2/§2.7): the
  // chain's LAST position is a `:free` model — the landing spot the B1
  // advance rule aims the LAST key's key-class failure at. The env knobs:
  //   CC_TAIL_MODEL=<slug>  swaps the tail (MUST end ':free' — a LOUD throw
  //                         otherwise: the tail is the FREE lane by hard
  //                         rule, and a paid tail would silently serve
  //                         outside the §S23 approved pair; even an
  //                         APPROVED paid model is a bad tail — ccTurn
  //                         converts the throw to infra_failed
  //                         'bad-tail-model(...)')
  //   CC_TAIL_MODEL=''      the escape hatch: no `:free` slot in the chain →
  //   CC_TAIL_DISABLED=1    the B1 rule degenerates to the pre-s23 `+1`
  //                         advance, byte-identical (the quality-vs-
  //                         completion call stays the OPERATOR's)
  const tailDisabled = env.CC_TAIL_DISABLED === '1'
    || (typeof env.CC_TAIL_MODEL === 'string' && env.CC_TAIL_MODEL.trim() === '');
  let tail = CC_TAIL_MODEL_DEFAULT;
  if (typeof env.CC_TAIL_MODEL === 'string' && env.CC_TAIL_MODEL.trim() !== '') {
    tail = env.CC_TAIL_MODEL.trim();
    if (!tail.endsWith(':free')) {
      throw new Error(`ccModelChain: CC_TAIL_MODEL must end ':free' (got ${JSON.stringify(tail)}) — the tail is the FREE lane by hard rule (OPENROUTER-KEYS §S23: paid traffic rides only deepseek/deepseek-v4.1-flash or z-ai/glm-5.3-flash); set CC_TAIL_MODEL='' (or CC_TAIL_DISABLED=1) to disable the tail instead`);
    }
  }
  const paid = CC_PAID_MODEL_DEFAULTS.filter((m) => !custom.includes(m));
  // the tail dedups against the custom head too (the W7 discipline: a
  // custom CC_MODEL that IS the tail model must not mint an exact
  // (key, model) repeat at the tail position; the free slot then sits at
  // m1 — the tail-as-head degenerate, no FORWARD free sibling → +1)
  if (tailDisabled || custom.includes(tail)) return [...custom, ...paid];
  return [...custom, ...paid, tail];
}

export function ccKeyPool(env = process.env) {
  return [env.OPENROUTER_API_KEY, env.OPENROUTER_API_KEY_2]
    .map((key, i) => ({ key: typeof key === 'string' ? key.trim() : '', keyIndex: i + 1 }))
    .filter((l) => l.key !== '');
}

// key-major flatten: every model on key 1 before key 2's first (D2)
export function ccLanes(env = process.env) {
  const lanes = [];
  for (const { key, keyIndex } of ccKeyPool(env)) {
    for (const model of ccModelChain(env)) lanes.push({ key, keyIndex, model });
  }
  return lanes;
}

// s21/W1 (a2): the KEY-CLASS statuses — failures that implicate the KEY, not
// the model: 401 (auth dead), 402 (credits drained), 429 (quota exhausted).
// The same rotate-class the free lane's M5 uses (worker/turn.mjs). 5xx and
// 400/404 are upstream/model conditions — ordinary rotation material.
export const CC_KEY_CLASS_STATUSES = new Set([401, 402, 429]);

// s21/W1 (a2): the lane ADVANCE policy (pure, exported for the unit suite).
// KEY-MAJOR flatten × the dispatched budget (lane_attempts: 3) × a 3-model
// chain meant every served lane rode key 1 — a drained/revoked primary
// burned all 3 slots 402-ing while a healthy KEY_2 sat UNREACHABLE (the
// designed failover did not exist). Remedy: on a KEY-CLASS failure the
// failing key is dead for every model it still owes — burning the remaining
// same-key lanes is a no-backoff retry of a known-dead key — so JUMP the
// lane index to the NEXT KEY'S FIRST LANE (the key-major product is then
// consumed strictly in order, with dead-key tails skipped: k1m1, k1m2(402),
// [k1m3 skipped], k2m1, k2m2, k2m3 — the common case k1m1(402)→k2m1 is the
// like-for-like retry). Everything else (transport, 5xx, 400/404, bridge
// spawn) advances one lane as before.
//
// s23/B1 — THE FREE-TAIL RULE (the W1 live arc's fix): when the failing
// lane's key is the LAST key in the pool (no next key to jump to — the
// both-paid-keys-dry posture), the ordinary `+1` advance burns the budget's
// final slot on the dead key's next PAID sibling (the W1 arc:
// k1ds(401)→JUMP→k2ds(402)→+1→k2glm(402)→exhausted→infra-retry×2→QUARANTINE
// while the free slot sat ONE index away untried). The paid siblings share
// the dead key's credit state — probe §1a: glm 402s wherever deepseek 402s
// on every drained key, and the CLI's fixed 32000-token ask cannot fit any
// drained key on either approved paid model — while a $0 request passes
// the cost-proportional credit pre-flight (or-079, OVERDRAWN −$0.384:
// paid deepseek 402 / free cohere 200 on the SAME key, SAME max_tokens).
// So: scan FORWARD within the SAME keyIndex block for the first lane whose
// model ends ':free'; none found → `i + 1` (today's fallback — the tail is
// a bridge, not an immunity: a 1-key pool with no free slot, a free-as-head
// chain, and the tail's OWN key-class failure all fall through to the same
// bounded exhaustion as before).
export function ccNextLaneIndex(lanes, i, keyClassFailure) {
  if (!Array.isArray(lanes) || !Number.isInteger(i) || i < 0 || i >= lanes.length) return i + 1;
  if (!keyClassFailure) return i + 1;
  const dead = lanes[i].keyIndex;
  for (let j = i + 1; j < lanes.length; j++) {
    if (lanes[j].keyIndex !== dead) return j;
  }
  // no other key in the pool — the LAST key's key-class failure: the
  // same key's next `:free` slot (skipping the credit-dead paid siblings)
  for (let j = i + 1; j < lanes.length; j++) {
    if (lanes[j].keyIndex === dead && typeof lanes[j].model === 'string' && lanes[j].model.endsWith(':free')) return j;
  }
  return i + 1;   // no free sibling either — ordinary advance (exhaustion follows)
}

// M-4: the CLI pin — the live-proven X20/X21 version is the DEFAULT (the
// design's "version env-pinned, default recorded at build"). 'latest' was
// the reproducibility hole: an upstream release renaming a flag or changing
// the env contract would kill every cc turn as rc≠0 app-class work_failed
// while every offline gate stayed green (the fake accepts any argv).
// CC_VERSION still overrides.
export function ccCliVersion(env = process.env) {
  return typeof env.CC_VERSION === 'string' && env.CC_VERSION.trim() !== '' ? env.CC_VERSION.trim() : '2.1.273';
}

// the CLI argument vector AFTER the executable — the npx form. Fake mode
// prepends the fake script path under the node executable; the fake then
// echoes process.argv.slice(2) = THIS vector (the real spawn boundary).
// T46/X22 (live finding, run 35297656079): --permission-mode acceptEdits —
// headless -p mode DEFERS file-write prompts by default; the turn "completed
// done" while the declared artifact was never written ("The write needs
// your approval"). The workdir sandbox IS the boundary (a fresh temp dir,
// the write-back door governs what rides the task branch) — auto-accepting
// edits inside it is the designed shape.
export function ccArgv(envelope, budget, env = process.env) {
  return [
    '-y', `@anthropic-ai/claude-code@${ccCliVersion(env)}`,
    '-p', envelope.prompt,
    '--permission-mode', 'acceptEdits',
    '--max-turns', String(budget.max_turns),
    '--output-format', 'json',
    '--disallowedTools', CC_PERMISSION_DENIES.join(','),
  ];
}

// the F-M8 per-lane env contract (asserted by the fake-CLI conformance)
export function ccLaneEnv(lane, envelope, extra = {}) {
  // the LOCAL bridge URL (real mode) rides extra.CC_BRIDGE_URL — popped
  // here so it never reaches the child env twice
  const { CC_BRIDGE_URL, ...rest } = extra;
  return {
    // T46/X20 run-3: the CLI's pre-flight GET /v1/models/{id} 404s on
    // OpenRouter (the compat surface lacks the per-model route), killing
    // the turn before the main call. The bridge (worker/cc-bridge.mjs,
    // spawned PER LANE) synthesizes the models route and passes
    // /v1/messages through. F-M8 AMENDED: the base URL is the local
    // bridge; the REAL key lives ONLY in the bridge's env (the CLI gets a
    // dummy token — a spawned CLI can no longer read the credential).
    ANTHROPIC_BASE_URL: CC_BRIDGE_URL || CC_BRIDGE_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: CC_BRIDGE_URL ? 'bridge-local-no-key' : lane.key,
    ANTHROPIC_MODEL: lane.model,
    ANTHROPIC_SMALL_FAST_MODEL: lane.model,
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    OX_AGENT_DEADLINE_UTC: new Date(envelope.deadline_ms).toISOString(),
    OX_AGENT_TASK_ID: envelope.task_ref.id,
    ...rest,
  };
}

// M-1: the credential denylist — these keys NEVER inherit into the CLI's
// child env (live-proven /proc/<pid>/environ leak: both pool keys + the
// contents:write job token rode the plain env copy). The lane overlay then
// deliberately sets the ONLY auth the CLI holds: the lane key in fake/
// direct mode, the bridge dummy in bridge mode (the real key lives in the
// BRIDGE process's env alone — startBridge).
export const CC_ENV_DENYLIST = [
  'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'GH_TOKEN', 'GITHUB_TOKEN',
  'ANTHROPIC_AUTH_TOKEN', 'GL_PAT',
  // T46/W-D lane B (M4/M6 class): the bridge's telemetry path rides the
  // ADAPTER-side spawn env only — it must never leak into the CLI child env
  // (the same seam lane C extends for OPENROUTER_KEY_POOL). Defense-in-depth:
  // the adapter passes it via startBridge's explicit env, but a stray export
  // in a runner's top-level env would otherwise inherit through the copy.
  'BRIDGE_LANE_LOG',
  // T46/W-D M6: the real-lane FREE key pool (worker/turn.mjs's D3 pick) —
  // the CLI child env must never see the 73 pool keys (the live-proven
  // /proc/<pid>/environ leak class; this lane's only pool-relevant edit)
  'OPENROUTER_KEY_POOL',
];

// the merged child env: the caller's env (PATH et al.) MINUS the denylist,
// then the F-M8 lane overlay. Pure + exported for the M-1 unit pin — fake
// mode cannot spawn the bridge by design, so the bridge-mode merged env is
// probed here instead of at the spawn boundary.
export function ccChildEnv(env, lane, envelope, extra = {}) {
  const childEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (CC_ENV_DENYLIST.includes(k)) continue;   // credentials never inherit
    if (typeof v !== 'string') continue;
    childEnv[k] = v;
  }
  Object.assign(childEnv, ccLaneEnv(lane, envelope, extra));
  return childEnv;
}

const TRANSPORT_STDERR_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|fetch failed|network|socket|tunneling|connect/i;

// ---------------------------------------------------------------------------
// The CLI error-exit stdout parse (B-1 — the X21-final F-1 fix).
// On a NON-ZERO exit the CLI prints its result JSON on STDOUT (is_error /
// api_error_status / subtype / result); the CC-LANE-EXIT log has parsed it
// since X20 (log-only — the F-1 bug). These helpers are that parse, lifted
// so the classifier consumes the same data.
// ---------------------------------------------------------------------------

// the result JSON the CLI prints on stdout, or null when stdout is not a
// JSON object (the text-only stderr shape — the real work failures)
export function ccExitJson(stdout) {
  try {
    const p = JSON.parse(String(stdout));
    return p !== null && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch { return null; }
}

// the infra trigger: a NUMERIC api_error_status on the exit JSON. ANY status
// — 429/401/402/5xx/400/404 — is an API-conditioned failure (the CLI's API
// errors are never "the work failed"); a numeric STRING coerces (CLI-drift
// tolerance). Everything else is null → the work class.
export function ccApiErrorStatus(exitJson) {
  if (exitJson === null) return null;
  const v = exitJson.api_error_status;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// ---------------------------------------------------------------------------
// The LOCAL bridge lifecycle (real mode only — X20 run-3 root cause fix).
// Spawns worker/cc-bridge.mjs with the LANE's key+model, waits for the port
// file, and returns {url, stop()}. The key never rides the CLI's env.
// ---------------------------------------------------------------------------
const CC_BRIDGE_PATH = fileURLToPath(new URL('./cc-bridge.mjs', import.meta.url));

// T46/W-D lane B (§D4-M2): startBridge passes the TURN-scoped lane-log path
// (BRIDGE_LANE_LOG) — every lane's bridge appends to the SAME file, so the
// turn-level aggregate sees every upstream call across rotations. Exported
// for the glue pin (the bridge env wiring — without it the bridge writes its
// standalone default while the adapter aggregates a path nothing wrote: a
// dead feature with every pure pin green, the exact gap class this repo
// guards against).
export async function startBridge(lane, log, { timeoutMs = 5_000, laneLogPath = null, upstreamBase = null } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'cc-bridge-'));
  const portFile = join(scratch, 'port');
  const child = spawn(process.execPath, [CC_BRIDGE_PATH, portFile], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      OPENROUTER_API_KEY: lane.key,
      CC_LANE_MODEL: lane.model,
      OPENROUTER_BASE: upstreamBase ?? (process.env.OPENROUTER_BASE || ''),
      ...(laneLogPath ? { BRIDGE_LANE_LOG: laneLogPath } : {}),
      // M-3 (integration wiring): the bridge enforces this exact bearer on
      // the credential-spending route; the CLI carries the SAME dummy as its
      // ANTHROPIC_AUTH_TOKEN (ccLaneEnv line above) — the CLI's requests
      // pass, unrelated local processes cannot silently spend the lane key.
      BRIDGE_AUTH: 'bridge-local-no-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,   // its own group: a CLI group-kill cannot take the bridge
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; log(`CC-BRIDGE ${String(d).trim().slice(0, 300)}`); });
  child.stderr.on('data', (d) => { output += d; log(`CC-BRIDGE-ERR ${String(d).trim().slice(0, 300)}`); });
  const t0 = Date.now();
  let port = null;
  while (Date.now() - t0 < timeoutMs) {
    try { port = parseInt(readFileSync(portFile, 'utf8').trim(), 10); } catch { /* not yet */ }
    if (Number.isInteger(port) && port > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!(Number.isInteger(port) && port > 0)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`bridge did not listen in ${timeoutMs}ms (${output.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 120)})`);
  }
  log(`CC-BRIDGE-UP 127.0.0.1:${port} (model ${lane.model}, key ${lane.keyIndex})`);
  return {
    url: `http://127.0.0.1:${port}`,
    stop() {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}


// ---------------------------------------------------------------------------
// The spawn (process-group-scoped, wall-killed).
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
      log(`CC-WALL-KILL pid=${child.pid} at ${Math.round(wallMs)}ms (group SIGKILL — the self-reported reaper)`);
      // a detached escapee holding the stdout pipe cannot stall the wall:
      // force-resolve shortly after the group kill with what we have
      forceTimer = setTimeout(() => settle(null, 'SIGKILL'), 250);
    }, Math.max(0, wallMs));
    child.on('close', (code, sig) => settle(code, sig));
    child.on('error', (e) => { spawnError = e; settle(-1, null); });
  });
}

// ---------------------------------------------------------------------------
// The workdir scan (the write-back claim surface) — pure-ish helper.
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
        const rel = relative(root, full).split('\\').join('/');
        if (CC_SCRATCH_EXCLUDE.includes(rel) || rel.startsWith('.claude/')) continue;
        refs.push(rel);
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
// Transcripts (F-M6/D3): local in fake mode, git push to fsm-sessions in real.
// ---------------------------------------------------------------------------

function transcriptPaths(envelope, runId) {
  const base = `sessions/${envelope.task_ref.id}/${runId}-a${envelope.attempt}`;
  return { txt: `${base}.txt`, meta: `${base}.meta.json` };
}

function transcriptBody(envelope, runId, fake, result) {
  const lanes = (result.telemetry?.lanes || [])
    .map((l) => `  lane ${l.lane}: key#${l.key_index} ${l.model} rc=${l.rc}${l.signal ? ` signal=${l.signal}` : ''} ${l.duration_ms}ms class=${l.class}`).join('\n');
  return [
    `fsm-lab CC transcript (mode: cc${fake ? ' — CC_FAKE_LLM determinism run' : ''})`,
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

function transcriptMeta(envelope, runId, fake, result, nowIso) {
  return JSON.stringify({
    task: envelope.task_ref.id, run_id: runId, attempt: envelope.attempt,
    session: envelope.session, mode: 'cc', fake, harness: 'claude-code',
    deadline_utc: new Date(envelope.deadline_ms).toISOString(),
    status: result.status, detail: result.detail ?? null,
    models: result.models || [], lane_attempts_used: result.lane_attempts_used,
    duration_ms: result.duration_ms, artifact_refs: result.artifact_refs || [],
    // derived, never read off result.transcript (which does not exist yet at
    // meta-write time — the transcript path is a pure function of the turn id)
    transcript: transcriptPaths(envelope, runId).txt, written_at: nowIso,
  }, null, 2) + '\n';
}

// the real-mode push (s25/b1 — the X29 F3 rebuild): per-file contents-API
// CAS via the shared worker/sessions-push.mjs engine — race-free by
// construction (no shared branch tip to fast-forward, no ref lock, no
// clone). The repo/token seam is the F2 law: FSM_SESSIONS_REPO/
// FSM_SESSIONS_TOKEN (the custom names that REACH the process on real
// runners — step-env overrides of GITHUB_* defaults are silently ignored
// by the runner) with the GITHUB_REPOSITORY/GH_TOKEN back-compat pair for
// tests/sims that set the old vocabulary. The token never reaches a log
// line (the Authorization header only). Retry ladder: the engine's per-PUT
// budget (3 attempts, backoff+jitter, 409/422/5xx/network) + the caller's
// ONE call in writeTranscript (the outer whole-set retry is gone — s25/X30).
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
  // record was invisible in the log)
  // s25/X31: the line reports the ACTUAL outcome — 'PUSHED n/m' on the
  // degraded path (the X31 T-X31-03 lesson: the unconditional 'PUSHED 2'
  // followed by 'DEGRADED 1/2' contradicted itself in the run log)
  if (out && out.mode === 'degraded') {
    log(`CC-TRANSCRIPT-PUSHED ${out.files.length}/${files.size} file(s) to fsm-sessions @ ${repo} (degraded — see the DEGRADED line)`);
  } else {
    log(`CC-TRANSCRIPT-PUSHED ${files.size} file(s) to fsm-sessions @ ${repo}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// T46/W-C2 (§4/F-4): the task-branch write-back — the door-allowed artifact
// set commits to refs/heads/tasks/<id> (the branch forks from MAIN per F-4 —
// never the fsm-state orphan: unrelated-history PRs are unreviewable; an
// EXISTING branch (a re-attempt) continues: clone it, fast-forward on).
// ONE commit `task/<id>: artifacts`, pathspec = exactly the door-allowed
// set (m-4: tasks/<id>/** + declared artifacts only — same door rules,
// different base ref). The push is followed by the REMOTE TIP READ-BACK
// (the masked-rc lesson): fetch what the remote NOW holds and verify every
// committed path EXISTS at the tip with the local byte size — a green rc
// with a missing/partial tree escalates, never trusts.
// The worker job's per-task concurrency group (fsm-worker-<task>,
// cancel-in-progress) serializes same-task writers: a push race is the
// one-in-a-million shape, and its failure lands as infra_failed
// 'artifact-push' → net-zero retry (the lane rotates).
// ---------------------------------------------------------------------------
// the read-back verification — PURE (extracted so the failure branches
// are pinnable without hook gymnastics): tip = {path: bytes} parsed from
// `git ls-tree -r --long FETCH_HEAD`, sizes = the local byte sizes.
// W-C2-R (F8): iterates the ALLOWED set (not the copied subset) — a
// declared-but-unwritten path is a MISSING file at the tip, never a
// silently-dropped claim (the old shape pushed a partial tree green).
export function verifyReadBack({ allowed, committed, sizes, tip }) {
  const check = Array.isArray(allowed) && allowed.length ? allowed : committed;
  for (const rel of check) {
    if (!(rel in tip)) return { ok: false, err: `artifact-push read-back: path ${rel} MISSING at the remote tip` };
    const local = sizes[rel];
    if (local !== undefined && tip[rel] !== local) return { ok: false, err: `artifact-push read-back: path ${rel} size drift at tip (${tip[rel]} vs ${local} local)` };
  }
  return { ok: true };
}

// ls-tree output parser — PURE: `mode type sha\tsize\tpath` per line
// (ls-tree --long shape). Returns {path: bytes}.
export function parseLsTree(stdout) {
  const tip = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^\d+ \w+ [0-9a-f]+\s+(\d+)\t(.+)$/);
    if (m) tip[m[2]] = parseInt(m[1], 10);
  }
  return tip;
}

// W-C2-R (F6) + s25/b1 (F2): the task-branch origin resolver — PURE so the
// URL seam is pinnable without a git subprocess. CC_TASKBRANCH_ORIGIN (the
// tests/ops override — the FSM_SESSIONS_ORIGIN pattern, kept verbatim) wins
// outright; otherwise the github URL built from the SESSIONS seam:
// FSM_SESSIONS_REPO + FSM_SESSIONS_TOKEN (the custom names that REACH the
// process on real runners — the GITHUB_* step-env override law). The X29
// lesson this closes: the old `env.GITHUB_REPOSITORY` read built the URL
// from the RUNNER's repo while the log RENDERED the override — mirror run
// 35999041887 pushed tasks/T-X29-21 to the MIRROR repo, splitting the
// record-of-record. The GITHUB_REPOSITORY/GH_TOKEN back-compat pair stays
// for tests/sims that set the old vocabulary.
export function taskBranchOriginUrl(env = process.env) {
  const originOverride = typeof env.CC_TASKBRANCH_ORIGIN === 'string' && env.CC_TASKBRANCH_ORIGIN.trim() !== '' ? env.CC_TASKBRANCH_ORIGIN.trim() : null;
  if (originOverride) return originOverride;
  const repo = sessionsRepoFromEnv(env);
  const token = sessionsTokenFromEnv(env);
  return repo && token ? `https://x-access-token:${token}@github.com/${repo}.git` : null;
}

export function pushTaskBranch({ env, branch, allowed, workdir, log }) {
  const url = taskBranchOriginUrl(env);
  if (!url) throw new Error('artifact-push: needs FSM_SESSIONS_REPO + FSM_SESSIONS_TOKEN (or the GITHUB_REPOSITORY/GH_TOKEN back-compat pair, or CC_TASKBRANCH_ORIGIN)');
  const taskId = branch.startsWith('tasks/') ? branch.slice('tasks/'.length) : branch;
  const scratch = mkdtempSync(join(tmpdir(), 'cc-taskbr-'));
  const wc = join(scratch, 'wc');
  mkdirSync(wc, { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: wc, encoding: 'utf8' });
  const fail = (step, r) => new Error(`artifact-push: ${step} failed: ${String(r.stderr || r.error || `rc=${r.status}`).trim().slice(0, 160)}`);
  try {
    // existing branch continues; absent branch forks from MAIN (F-4)
    let clone = git(['clone', '--depth', '1', '--branch', branch, '--single-branch', url, '.']);
    if (clone.status !== 0) {
      clone = git(['clone', '--depth', '1', '--branch', 'main', '--single-branch', url, '.']);
      if (clone.status !== 0) throw fail('git clone main', clone);
      const co = git(['checkout', '-b', branch]);
      if (co.status !== 0) throw fail('git checkout -b', co);
      log(`CC-TASKBRANCH-GENESIS ${branch} from main (branch was absent — clone stderr: ${String(clone.stderr).trim().slice(0, 120)})`);
    }
    // copy the door-allowed set from the workdir (m-4: the allowed pathspecs
    // ONLY). W-C2-R (F8): a declared-but-unwritten path ESCALATES — the read-
    // back's job is to catch it, but failing HERE with a precise message is
    // strictly better than pushing a partial tree (the old silent drop).
    const committed = [];
    const sizes = {};
    for (const rel of allowed) {
      const src = join(workdir, rel);
      const dst = join(wc, rel);
      try {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        sizes[rel] = statSync(src).size;
        committed.push(rel);
      } catch {
        throw new Error(`artifact-push: declared-but-unwritten path ${rel} (the turn did not produce a file it declared — infra class, net-zero retry)`);
      }
    }
    if (!committed.length) throw new Error('artifact-push: no door-allowed file exists in the workdir (the turn wrote nothing it declared)');
    const add = git(['add', '--', ...committed]);
    if (add.status !== 0) throw fail('git add', add);
    // W-C2-R (L2-4): a byte-identical re-attempt (the report was lost after a
    // successful push — the crash-between-side-effect-and-report class) stages
    // NOTHING: `git commit` would rc=1 "nothing to commit" and a DONE turn
    // would escalate infra_failed → a FALSE QUARANTINE of fully-landed work.
    // The diff probe decides: identical tree → skip commit+push, the read-back
    // below still verifies the tip against the declared set.
    const staged = git(['diff', '--cached', '--quiet']);
    let identical = false;
    if (staged.status === 0) {
      identical = true;
      log(`CC-TASKBRANCH-IDENTICAL (the branch tip already carries exactly the declared set — crash-recovery re-attempt; no new commit)`);
    } else {
      const commit = git(['-c', 'user.name=fsm-worker', '-c', 'user.email=fsm-worker@users.noreply.github.com',
        'commit', '-m', `task/${taskId}: artifacts`]);
      if (commit.status !== 0) throw fail('git commit', commit);
      const push = git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      if (push.status !== 0) throw fail('git push', push);
    }
    // the REMOTE TIP read-back — never trust the green rc alone
    const fetch = git(['fetch', '--depth', '1', 'origin', branch]);
    if (fetch.status !== 0) throw fail('git fetch (read-back)', fetch);
    const ls = git(['ls-tree', '-r', '--long', 'FETCH_HEAD']);
    if (ls.status !== 0) throw fail('git ls-tree (read-back)', ls);
    const vr = verifyReadBack({ allowed, committed, sizes, tip: parseLsTree(ls.stdout) });
    if (!vr.ok) throw new Error(vr.err);
    log(`CC-TASKBRANCH-PUSHED ${committed.length} file(s) -> ${branch} (remote tip read-back verified${identical ? ' — identical re-attempt' : ''})`);
    return { ok: true, branch, committed, ...(identical ? { identical: true } : {}) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// the DONE-turn escalation composer for a failed artifact push — PURE
// (extracted for direct pins; mirrors the transcript escalation's shape:
// a done's PR depends on the artifacts landing, so the turn escalates to
// infra_failed 'artifact-push' = net-zero retry; failed turns keep their
// work-class result — the escalation would mask the diagnosis).
// T46/W-D lane B: lane_stats rides the escalation too — the retry's console
// view must see WHY the first attempt burned (the 429 class et al).
// s21/O-3 (audit a5): key_index/pool_size ride EXACTLY like lane_stats —
// the escalation is a reportable outcome shape; dropping the serving-key
// carry here would punch a hole in the console's key-spread line exactly on
// the artifact-push retry path.
export function artifactPushEscalation(taskId, attempt, err, result) {
  return {
    status: 'infra_failed',
    detail: String(err?.message ?? err).slice(0, 200),
    artifact_refs: result.artifact_refs,
    summary: `cc: task ${taskId} attempt ${attempt} — the artifact branch push failed (${String(err?.message ?? err).slice(0, 120)})`,
    telemetry: result.telemetry, models: result.models,
    lane_attempts_used: result.lane_attempts_used, duration_ms: result.duration_ms,
    ...(result.lane_stats ? { lane_stats: result.lane_stats } : {}),
    ...(Number.isFinite(result.key_index) ? { key_index: result.key_index } : {}),
    ...(Number.isFinite(result.pool_size) ? { pool_size: result.pool_size } : {}),
  };
}

async function writeTranscript(envelope, runId, fake, result, opts, log) {
  const paths = transcriptPaths(envelope, runId);
  const body = transcriptBody(envelope, runId, fake, result);
  const meta = transcriptMeta(envelope, runId, fake, result, new Date(opts.now()).toISOString());
  // s25/X30 structure: ONE attempt, no outer whole-set retry (the old
  // retry RE-FED the 409 storm; the internal jittered 10-attempt ladder
  // is the absorber, and retryable exhaustion returns degraded — the turn
  // keeps its DONE status). PERSISTENT errors (and fake-mode local write
  // failures — test-setup errors keep the same wrap for classification)
  // throw 'transcript-push-failed' (the done-turn escalation: infra_failed
  // — unchanged).
  try {
    // fake mode: the local determinism lane, unchanged
    if (fake) {
      const dir = opts.transcriptsDir || opts.env.CC_FAKE_TRANSCRIPTS_DIR || join(tmpdir(), 'fsm-sessions-fake');
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
      log(`CC-TRANSCRIPT-DEGRADED ${out.files.length}/${out.files.length + out.failures.length} file(s) landed @ ${out.repo} — unlanded: ${out.failures.map((f) => f.path).join(', ')} (the 409-storm class: the turn KEEPS its done status; the record is degraded, the spend is not re-run)`);
    }
    return out;
  } catch (e) {
    throw new Error(`transcript-push-failed(${String(e?.message ?? e).slice(0, 160)})`);
  }
}

// ---------------------------------------------------------------------------
// ccTurn — the CC harness turn.
// ---------------------------------------------------------------------------

export async function ccTurn(envelope, opts = {}) {
  const {
    env = process.env,
    runId = 'local',
    now = Date.now,
    log = () => {},
    transcriptsDir = null,   // fake-mode transcript root (tests/conformance)
    stageDir = null,         // artifact staging root (the W-C seam)
    echoDir = null,          // fake-mode spawn-boundary echo root (F-M7)
    fetchImpl = null,        // s25/b1: the transcript lane's scripted-fetch seam
                             // (rides the opts spread into writeTranscript →
                             // pushSessionsContents → pushSessionFiles; the
                             // mock-first pins drive the REAL-mode push with
                             // zero network; null/absent = the live global fetch)
  } = opts;

  // envelope shape guards — the same contract the shim enforces
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`ccTurn: envelope must be the ok-envelope object from envelopeFromDispatch (got ${envelope === null ? 'null' : typeof envelope})`);
  }
  const taskId = envelope.task_ref?.id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error(`ccTurn: envelope.task_ref.id must be a non-empty string (got ${JSON.stringify(taskId)}) — the artifact/transcript namespace depends on it`);
  }
  if (typeof envelope.prompt !== 'string') {
    throw new Error(`ccTurn: envelope.prompt must be a string (got ${typeof envelope.prompt})`);
  }
  // the wall contract depends on a finite absolute deadline — a hand-rolled
  // envelope without one would compute NaN wall timers (setTimeout(NaN) fires
  // IMMEDIATELY: the silent instant-kill class). Loud, never silent.
  if (typeof envelope.deadline_ms !== 'number' || !Number.isFinite(envelope.deadline_ms)) {
    throw new Error(`ccTurn: envelope.deadline_ms must be finite epoch-ms (got ${JSON.stringify(envelope.deadline_ms)}) — the wall kill depends on it`);
  }
  const attempt = Number.isInteger(envelope.attempt) && envelope.attempt >= 1 ? envelope.attempt : 1;
  const budget = {
    max_turns: Number.isInteger(envelope.budget?.max_turns) && envelope.budget.max_turns >= 1 ? envelope.budget.max_turns : 40,
    wall_ms: Number.isFinite(envelope.budget?.wall_ms) ? envelope.budget.wall_ms : 60_000,
    lane_attempts: Number.isInteger(envelope.budget?.lane_attempts) && envelope.budget.lane_attempts >= 1 ? envelope.budget.lane_attempts : 3,
  };

  const fake = env.CC_FAKE_LLM === '1';
  // the wall arithmetic depends on now() returning EPOCH-MS — an ISO-string
  // clock (a caller mistake seen live in X20's first dispatch: setTimeout(NaN)
  // fires instantly = the silent instant-kill class) fails LOUD here, the
  // same contract the envelope deadline guard enforces.
  const t0 = now();
  if (typeof t0 !== 'number' || !Number.isFinite(t0)) {
    throw new Error(`ccTurn: opts.now() must return finite epoch-ms (got ${typeof t0}: ${String(t0).slice(0, 40)}) — the wall timers depend on it`);
  }
  // the wall: the lease deadline AND the turn's own wall budget, whichever
  // bites first (the ABSOLUTE deadline still gates — F-G(a) arithmetic)
  const wallDeadlineMs = Math.min(envelope.deadline_ms, t0 + budget.wall_ms);
  // s23/B2: the lane BUILD is guarded — a misconfigured CC_TAIL_MODEL
  // (non-`:free`) throws LOUD in the pure chain builder; the TURN converts
  // the throw to the reportable routable-infra marker (the visible-waste
  // doctrine — the operator's misconfiguration is diagnosable from the
  // journal, never a silent paid serve outside the approved pair) instead
  // of dying unhandled before the report.
  let lanes;
  try {
    lanes = ccLanes(env);
  } catch (e) {
    return {
      status: 'infra_failed',
      detail: `bad-tail-model(${String(e?.message ?? e).slice(0, 200)})`,
      artifact_refs: [],
      summary: `cc: task ${taskId} attempt ${attempt} could not build the lane chain — ${String(e?.message ?? e).slice(0, 140)}`,
      telemetry: { turns: 0, wall_ms: now() - t0, lane_attempts_used: 0, lanes: [] },
      models: [], lane_attempts_used: 0, duration_ms: now() - t0,
    };
  }
  // s21/O-3 (audit a5): the POOL SIZE — distinct keys in the product (the
  // key-major flatten repeats each keyIndex once per model). This is the
  // modulo-base half of the serving-key pair the outcome now carries.
  const poolSize = new Set(lanes.map(l => l.keyIndex)).size;
  // the lane bound: budget.lane_attempts, clamped to the product's size
  const maxLanes = Math.min(lanes.length, Math.max(1, Math.min(8, budget.lane_attempts)));

  const baseTelemetry = (used, laneLog) => ({
    turns: 0, wall_ms: now() - t0, lane_attempts_used: used, lanes: laneLog,
  });
  const models = [];
  const laneLog = [];

  const workdir = mkdtempSync(join(tmpdir(), fake ? 'cc-fake-' : 'cc-turn-'));
  const echoRootProvided = fake && echoDir;
  const echoRoot = fake ? (echoDir || mkdtempSync(join(tmpdir(), 'cc-echo-'))) : null;
  // T46/W-D lane B (§D4-M2): the turn-scoped lane-log scratch — its OWN temp
  // dir, NOT the workdir (scanWorkdir would otherwise claim the telemetry
  // file as a CLI write-back artifact — the door/poison interplay). Every
  // lane's bridge appends to the SAME file; finalize aggregates it into
  // `lane_stats` and DELETES it (consumed); the finally below reaps the dir
  // (the backstop). opts.laneLogPath overrides for the seam pins.
  const laneLogDir = mkdtempSync(join(tmpdir(), fake ? 'cc-lanelog-fake-' : 'cc-lanelog-'));
  const laneLogPath = typeof opts.laneLogPath === 'string' && opts.laneLogPath !== '' ? opts.laneLogPath : join(laneLogDir, 'bridge-lane.jsonl');
  try {
    if (!lanes.length) {
      // routable infra marker — the key pool is empty (never a work attempt)
      return {
        status: 'infra_failed',
        detail: 'no-lane-keys(the OPENROUTER_API_KEY key pool is empty — set the repo secrets)',
        artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} had no lane keys`,
        telemetry: baseTelemetry(0, laneLog), models, lane_attempts_used: 0, duration_ms: now() - t0,
      };
    }

    let lastClass = 'none';
    // s21/W1 (a2): `i` is the ATTEMPT ordinal (what budget.lane_attempts
    // bounds); `laneIdx` is the LANE INDEX into the key-major product. They
    // used to coincide (advance was always +1) — which is exactly why the
    // dispatched budget of 3 could never reach key 2: with a 3-model chain
    // every served lane rode key 1. A KEY-CLASS failure (401/402/429 — see
    // CC_KEY_CLASS_STATUSES) now JUMPS laneIdx to the next key's block
    // (ccNextLaneIndex): the dead key's untried models are skipped as the
    // no-backoff retries they are, and a drained primary fails over to
    // KEY_2 WITHIN the budget. The D2 key-major order is unchanged — only
    // the advance policy is failure-aware.
    let laneIdx = 0;
    for (let i = 0; i < maxLanes && laneIdx < lanes.length; i++) {
      const lane = lanes[laneIdx];
      const argv = ccArgv(envelope, budget, env);
      const extraEnv = {};
      // T46/X20 run-3: real mode runs the LOCAL bridge per lane (the CLI's
      // models pre-flight 404s upstream; the key stays out of the CLI env).
      // Fake mode needs no bridge — the fake CLI never touches the network.
      let bridge = null;
      if (!fake) {
        try {
          bridge = await startBridge(lane, log, { laneLogPath });
          extraEnv.CC_BRIDGE_URL = bridge.url;
        } catch (e) {
          laneLog.push({
            lane: i + 1, key_index: lane.keyIndex, model: lane.model,
            rc: null, signal: null, duration_ms: 0, wall_killed: false,
            class: 'infra', bridge_error: String(e?.message ?? e).slice(0, 120),
            ...(typeof lane.model === 'string' && lane.model.endsWith(':free') ? { lane_class: 'free-tail' } : {}),
          });
          lastClass = `cc-bridge(${String(e?.message ?? e).slice(0, 80)})`;
          laneIdx = ccNextLaneIndex(lanes, laneIdx, false);
          continue;   // the bridge is infra — rotate the lane (not key-class: the env broke, not the key)
        }
      }
      if (fake) {
        mkdirSync(echoRoot, { recursive: true });
        extraEnv.FAKE_CC_ECHO_PATH = join(echoRoot, `lane-${i}.json`);
      }
      try {
      // env (M-1): the caller's env (PATH et al.) MINUS the credential
      // denylist, then the F-M8 overlay — the ONLY auth the CLI child ever
      // holds is the overlay's deliberate token (the lane key in fake/
      // direct mode; the bridge dummy in bridge mode)
      const childEnv = ccChildEnv(env, lane, envelope, extraEnv);

      const laneT0 = now();
      if (laneT0 >= wallDeadlineMs) {
        // a previous lane consumed the wall — do not even spawn
        return await finalize({
          status: 'deadline', detail: 'wall-budget-exceeded',
          artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} ran out of wall budget before lane ${i + 1}`,
        }, i);
      }
      const r = await runLane({
        cmd: fake ? process.execPath : 'npx',
        args: fake ? [FAKE_CC_PATH, ...argv] : argv,
        cwd: workdir,
        childEnv,
        wallMs: wallDeadlineMs - laneT0,
        log,
      });
      const laneInfo = {
        lane: i + 1, key_index: lane.keyIndex, model: lane.model,
        rc: r.rc, signal: r.signal ?? null, duration_ms: now() - laneT0,
        wall_killed: r.wallKilled, class: null,
        // s23/B3: the free-tail marker — a lane whose model ends ':free' is
        // the chain's tail slot (the slug derivation, §6.3's adjudicated
        // v1: no fsm.mjs schema change). Rides telemetry.lanes[] verbatim
        // (the adapter's OWN display space, 1-based key_index unchanged);
        // the journal/console derive the tail from lane_stats' `:free` slug.
        ...(typeof lane.model === 'string' && lane.model.endsWith(':free') ? { lane_class: 'free-tail' } : {}),
      };
      laneLog.push(laneInfo);
      models.push(lane.model);

      // ---- the wall kill → deadline (rc=124-equivalent), TERMINAL --------
      if (r.wallKilled || (r.rc === null && r.signal)) {
        laneInfo.class = 'deadline';
        return await finalize({
          status: 'deadline', detail: 'wall-budget-exceeded',
          artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} hit the wall budget on lane ${i + 1} (${lane.model}) — process group killed, self-reported`,
        }, i + 1);
      }
      // ---- spawn failure → terminal infra (the environment is broken) ---
      if (r.spawnError) {
        laneInfo.class = 'infra';
        lastClass = `cc-spawn(${String(r.spawnError.message ?? r.spawnError).slice(0, 80)})`;
        return await finalize({
          status: 'infra_failed', detail: lastClass,
          artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} could not spawn the CLI (${lastClass})`,
        }, i + 1);
      }
      // ---- non-zero rc: transport shape hops, app shape is WORK ---------
      if (r.rc !== 0) {
        if (TRANSPORT_STDERR_RE.test(r.stderr)) {
          laneInfo.class = 'infra';
          lastClass = 'lane-transport';
          laneIdx = ccNextLaneIndex(lanes, laneIdx, false);
          continue;   // the lane never reached the model — rotate (transport is not key-class)
        }
        // B-1 (the X21-final F-1 fix — 12/16 tasks burned as work_failed on
        // a lane-quota 429): the CLI's error-exit prints its result JSON on
        // STDOUT — parse it BEFORE classifying (the same parse the
        // CC-LANE-EXIT log below runs). A NUMERIC api_error_status is an
        // API-conditioned failure: 429/401/402/5xx/400/404 ALL rotate (the
        // CLI's API errors are never "the work failed"), the status rides
        // the detail for the audit, and lane exhaustion then reports
        // infra_failed lane-exhausted (net-zero, its own budget). Text-only
        // stderr (stdout unparseable) stays WORK — the real work failures.
        const exitJson = ccExitJson(r.stdout);
        const apiStatus = ccApiErrorStatus(exitJson);
        // X20 run-2 lesson: the CLI's stderr/stdout IS the diagnosis — log
        // every non-transport error exit (the transcript failure must never
        // mask the work-class cause)
        const stdoutJson = exitJson
          ? ` is_error=${exitJson.is_error} api_error_status=${exitJson.api_error_status} subtype=${exitJson.subtype ?? '-'} result=${String(exitJson.result ?? '').slice(0, 120)}`
          : ' stdout-unparseable';
        log(`CC-LANE-EXIT rc=${r.rc} model=${lane.model} stderr=${JSON.stringify(r.stderr.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300))}${stdoutJson}`);
        if (apiStatus !== null) {
          laneInfo.class = 'infra';
          lastClass = `lane-${apiStatus}`;
          // s21/W1: 401/402/429 implicate the KEY — jump to the next key's
          // block instead of re-trying the dead key's next model. 5xx/400/404
          // are upstream/model conditions — ordinary one-lane advance.
          laneIdx = ccNextLaneIndex(lanes, laneIdx, CC_KEY_CLASS_STATUSES.has(apiStatus));
          continue;   // the API error surface — rotate the lane
        }
        laneInfo.class = 'work';
        return await finalize({
          status: 'work_failed', detail: `cc-exit-${r.rc}(${r.stderr.split('\n')[0].slice(0, 80)})`,
          artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} exited ${r.rc} on lane ${i + 1} (${lane.model})`,
        }, i + 1);
      }
      // ---- rc 0: parse the result JSON -----------------------------------
      let parsed;
      try { parsed = JSON.parse(r.stdout); } catch { /* fallthrough */ }
      if (parsed === null || typeof parsed !== 'object') {
        laneInfo.class = 'work';
        return await finalize({
          status: 'work_failed', detail: 'cc-stdout-unparseable',
          artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} got an unparseable CLI stdout on lane ${i + 1}`,
        }, i + 1);
      }
      const content = typeof parsed.result === 'string' && parsed.result !== '' ? parsed.result : null;
      // documented fake-only extension: the real CLI never emits reasoning /
      // repeat_report — the fake uses them to exercise the F-M4 + dup shapes
      const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning !== '' ? parsed.reasoning : null;
      const finish = typeof parsed.finish_reason === 'string' ? parsed.finish_reason : undefined;

      // the ONE classifier, per lane, decides the hop
      let cls;
      if (parsed.is_error === true) {
        // the CLI's own error surface: check the packaged-error markers FIRST
        // (a 401/429 text riding a "successful" result is E11 infra), else
        // the app-error work class (max-turns et al)
        const markerCls = content ? classifyOutcome({ content }) : null;
        if (markerCls?.status === 'infra_failed') {
          laneInfo.class = 'infra';
          lastClass = markerCls.detail;
          // s21/W1: the E11 markers ('invalid api key', 'unauthorized',
          // 'insufficient credits', 'rate limit' — the adapter's ctx-less
          // defaults) are ALL key/quota classes — jump the key.
          laneIdx = ccNextLaneIndex(lanes, laneIdx, true);
          continue;
        }
        laneInfo.class = 'work';
        return await finalize({
          status: 'work_failed', detail: `cc-error(${parsed.subtype ?? 'is_error'})`,
          artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} hit the CLI error surface (${parsed.subtype ?? 'is_error'}) on lane ${i + 1}`,
        }, i + 1);
      }
      cls = classifyOutcome({ content, reasoning, finish });
      if (cls.status === 'infra_failed') {
        // error-as-answer (E11) or budget-misconfigured (F-M4) — rotate.
        // s21/W1: only the E11 marker conviction is key-class (the default
        // markers name key/quota failures); a truncated-at-cap completion
        // is the caller's budget error — ordinary advance.
        laneInfo.class = 'infra';
        lastClass = cls.detail;
        laneIdx = ccNextLaneIndex(lanes, laneIdx,
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
        ...(parsed.repeat_report === true ? { repeat_report: true } : {}),
        summary: `cc: task ${taskId} attempt ${attempt} ${cls.status === 'done' ? 'completed' : 'failed'} on lane ${i + 1} (${lane.model})`,
      }, i + 1, { turns: Number.isInteger(parsed.num_turns) ? parsed.num_turns : 1 });
      } finally {
        // the per-lane bridge dies with the lane (rotation = fresh bridge
        // with the next lane's key+model)
        if (bridge) bridge.stop();
      }
    }
    // ---- every lane burned: the routing-level infra marker ---------------
    return await finalize({
      status: 'infra_failed',
      detail: `lane-exhausted(${laneLog.length}/${lanes.length} lanes, last ${String(lastClass).slice(0, 80)})`,
      artifact_refs: [], summary: `cc: task ${taskId} attempt ${attempt} exhausted the lane budget (${laneLog.length}/${lanes.length})`,
    }, laneLog.length);

    // ---- the shared terminal tail: scan → door → transcript → return ----
    async function finalize(partial, used, extra = {}) {
      // T46/W-D lane B (§D4-M2): the bridge-lane JSONL → `lane_stats`. Read
      // HERE (every terminal path funnels through finalize — rotation
      // `continue`s burned their bridges but their lines are already in the
      // turn-level file). collectLaneStats aggregates + DELETES the file; a
      // turn whose lanes never reached the model (fake mode, bridge spawn
      // failures) attaches NOTHING — lane_stats is an optional field the
      // whole drain treats as absent-means-absent.
      const laneStats = collectLaneStats(laneLogPath);
      // s21/O-3 (audit a5, MAJOR) — the CC lane's KEY PICK rides the outcome
      // like the real lane's (worker/turn.mjs D3): `key_index` = the 0-based
      // index into the pool ARRAY of the key that served the turn's LAST
      // attempted lane (the laneLog's last entry — the answering lane on a
      // done, the burned slot on exhaustion), `pool_size` = the pool's size.
      // 0-based matches the journaled field's documented semantics ("an index
      // into the pool ARRAY" — fsm.mjs's laneOutcomeFields comment; the
      // laneLog/telemetry.lanes key_index stays the adapter's OWN 1-based
      // display space, unchanged). Before this the CC lane's key pick NEVER
      // rode the report — the live journal held ZERO key_index records, so
      // even a rendered histogram would have been empty in the deployed mode.
      const lastLane = laneLog.length ? laneLog[laneLog.length - 1] : null;
      const laneKeyFields = lastLane && Number.isFinite(lastLane.key_index) && poolSize > 0
        ? { key_index: lastLane.key_index - 1, pool_size: poolSize }
        : {};
      // the write-back claim surface: the workdir scan — ONLY for lanes that
      // ran to rc 0 and answered (the raw-extraction path sets scan:true);
      // every failure shape carries [] like the shim's failure rows
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
      // done/work_failed exactly like the real lane's {content} shape. The
      // in-adapter class is computed for the door + transcript only.
      const internalCls = result.status
        ? { status: result.status, detail: result.detail }
        : classifyOutcome({ content: result.content ?? null, reasoning: result.reasoning ?? null });
      // THE DOOR (D4): violations → poison, BEFORE anything is trusted or
      // staged (runTurn's door is the backstop for callers that bypass here)
      // T46/W-C2: the door now gets MEASURED sizes (statSync on the workdir
      // claim) — the byte caps bite on real files (the read-back wave's
      // actuals; the door's own docstring: "the read-back wave measures
      // actuals" — this is that wave).
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
      // TRANSCRIPTS BEFORE THE REPORT (F-M6): this return is what runTurn
      // enqueues next — the transcript landing here is structurally first.
      // The transcript records the ADAPTER's view (internalCls) so the file
      // is readable even for the raw-extraction returns that leave the
      // classification to the caller.
      const forTranscript = { ...result, status: internalCls.status, detail: result.detail ?? internalCls.detail };
      try {
        result.transcript = await writeTranscript(envelope, runId, fake, forTranscript, { ...opts, env, now }, log);
        result.transcript.txt = transcriptPaths(envelope, runId).txt;
        // s25/X30: the DEGRADED transcript rides the report summary — the
        // FSM keeps the DONE status (no re-run of a completed paid turn);
        // typeof-guard: undefined + ' += ' would stringify 'undefined'.
        // s25-r1/R4: the shared, PINNED note builder (the inline twin was
        // unpinned — the reviewer's cc-glue mutation survived the suite)
        if (result.transcript && result.transcript.mode === 'degraded') {
          result.summary = appendTranscriptNote(result.summary, result.transcript);
        }
      } catch (e) {
        // X20 run-2 lesson: a FAILED turn keeps its work-class result — the
        // transcript is diagnostic for failures, and the infra escalation
        // MASKED the CLI's stderr diagnosis (the exact bug run 2 hit). Only
        // a DONE turn escalates to infra: its report references the
        // transcript, so a missing one is a contract violation worth a
        // net-zero retry. Failed turns carry the miss in the summary.
        if (internalCls.status === 'done') {
          return {
            status: 'infra_failed',
            detail: String(e?.message ?? e).slice(0, 200),
            artifact_refs: result.artifact_refs,
            summary: `cc: task ${taskId} attempt ${attempt} — the transcript never landed (${String(e?.message ?? e).slice(0, 120)})`,
            telemetry: result.telemetry, models: result.models,
            lane_attempts_used: result.lane_attempts_used, duration_ms: result.duration_ms,
            ...(result.lane_stats ? { lane_stats: result.lane_stats } : {}),
            ...laneKeyFields,
          };
        }
        log(`CC-TRANSCRIPT-MISSED (best-effort for a ${internalCls.status} turn): ${String(e?.message ?? e).slice(0, 160)}`);
        result.summary += ` [transcript missed: ${String(e?.message ?? e).slice(0, 80)}]`;
      }
      // T46/W-C2 (§4): the task-branch write-back — the door-allowed set
      // commits to refs/heads/tasks/<id> (F-4 from MAIN, m-4 pathspec) with
      // the remote-tip read-back. REAL mode only; fake mode keeps the local
      // stage (tests never touch git). A DONE turn whose push/read-back
      // fails escalates to infra_failed 'artifact-push' (net-zero — the lane
      // rotates; a done's PR depends on the artifacts landing); a FAILED
      // turn keeps its work-class result (best-effort log only — the report
      // is the diagnosis, the escalation would mask it, the transcript
      // lesson).
      if (door?.ok && door.allowed.length) {
        if (fake) {
          const root = stageDir || env.CC_STAGE_DIR || join(tmpdir(), 'fsm-stage');
          const staged = stageAllowed(door, workdir, root);
          if (staged.length) log(`CC-STAGED ${staged.length} artifact(s) under ${root} (fake-mode local stage — the determinism lane)`);
        } else {
          const pusher = opts.pushTaskBranchImpl || pushTaskBranch;
          let push = null;
          try {
            push = pusher({ env, branch: `tasks/${taskId}`, allowed: door.allowed, workdir, log });
            if (push && push.ok !== true) throw new Error(`artifact-push: ${String(push.err || push.error || 'rejected').slice(0, 160)}`);
          } catch (e) {
            if (internalCls.status === 'done') {
              return artifactPushEscalation(taskId, attempt, e, result);
            }
            log(`CC-TASKBRANCH-MISSED (best-effort for a ${internalCls.status} turn): ${String(e?.message ?? e).slice(0, 160)}`);
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
    // T46/W-D lane B: the lane-log scratch dir — collectLaneStats already
    // deleted the FILE (consumed); this reaps the DIR (the backstop for the
    // paths that never reached finalize)
    rmSync(laneLogDir, { recursive: true, force: true });
    // an internally-created echo root is unreadable by the caller — reap it;
    // a PROVIDED one stays (conformance reads the boundary records after)
    if (echoRoot && !echoRootProvided) rmSync(echoRoot, { recursive: true, force: true });
  }
}
