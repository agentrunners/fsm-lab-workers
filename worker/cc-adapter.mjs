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
// model chain [CC_MODEL, dots-studio:free, nemotron:free, cohere:free],
// flattened KEY-MAJOR (every model on key 1 before key 2's first), bounded by
// budget.lane_attempts (default 3). INFRA-class lane failure (401/402/429/5xx
// text-as-answer, transport-shaped stderr, budget-misconfigured truncation)
// → next lane. WORK-class (the CLI ran and answered: empty completion,
// deterministic app error, max-turns) → NO hop: rotating the lane cannot
// change the answer. GHA runners rotate IPs naturally (the TOS-multi-account
// concern's real answer); sandbox-origin calls are validity probes only.
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
// Real mode: git push to the fsm-sessions branch (GH_TOKEN); fake mode: a
// LOCAL directory (env.CC_FAKE_TRANSCRIPTS_DIR, default <tmp>/fsm-sessions-
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

const FAKE_CC_PATH = fileURLToPath(new URL('./fake-cc.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// The lane algebra (pure, exported for the unit suite).
// ---------------------------------------------------------------------------

export const CC_BRIDGE_BASE_URL = 'https://openrouter.ai/api/v1';
export const CC_MODEL_CHAIN_DEFAULTS = [
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'cohere/north-mini-code:free',
];
// SA-5: the web tools are DENIED at the CLI boundary (mcp-web replaces them)
export const CC_PERMISSION_DENIES = ['WebFetch', 'WebSearch'];
// CLI-internal scratch the adapter never claims as write-back (workdir-local,
// dies with the workdir; anything else the CLI writes IS a claim)
export const CC_SCRATCH_EXCLUDE = ['.claude', '.claude.json'];

export function ccModelChain(env = process.env) {
  const custom = typeof env.CC_MODEL === 'string' && env.CC_MODEL.trim() !== '' ? [env.CC_MODEL.trim()] : [];
  return [...custom, ...CC_MODEL_CHAIN_DEFAULTS];
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
export function ccArgv(envelope, budget, env = process.env) {
  return [
    '-y', `@anthropic-ai/claude-code@${ccCliVersion(env)}`,
    '-p', envelope.prompt,
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

async function startBridge(lane, log, { timeoutMs = 5_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'cc-bridge-'));
  const portFile = join(scratch, 'port');
  const child = spawn(process.execPath, [CC_BRIDGE_PATH, portFile], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      OPENROUTER_API_KEY: lane.key,
      CC_LANE_MODEL: lane.model,
      OPENROUTER_BASE: process.env.OPENROUTER_BASE || '',
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

// the real-mode push: a shallow clone/push of the fsm-sessions branch (the
// token never reaches a log line). Retry-once semantics live at the caller.
function pushSessionsBranch({ env, files, log }) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('sessions push needs GH_TOKEN + GITHUB_REPOSITORY');
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  const scratch = mkdtempSync(join(tmpdir(), 'cc-sessions-'));
  const wc = join(scratch, 'wc');
  // X20 run-2 lesson: BOTH paths need the workdir — `git clone ... .` AND
  // `git init .` fail with "cannot change to '<wc>'" when it doesn't exist
  // (the init fallback only ran because the clone failed on the SAME
  // missing-dir cause, masking the real branch-absence signal)
  mkdirSync(wc, { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: wc, encoding: 'utf8' });
  const fail = (step, r) => new Error(`${step} failed: ${String(r.stderr || r.error || `rc=${r.status}`).trim().slice(0, 160)}`);
  try {
    const clone = git(['clone', '--depth', '1', '--branch', 'fsm-sessions', '--single-branch', url, '.']);
    if (clone.status !== 0) {
      // branch absent → orphan-branch genesis (sessions is not a code branch)
      const init = git(['init', '-b', 'fsm-sessions', '.']);
      if (init.status !== 0) throw fail('git init', init);
      const remote = git(['remote', 'add', 'origin', url]);
      if (remote.status !== 0) throw fail('git remote', remote);
      log(`CC-SESSIONS-GENESIS fsm-sessions branch absent — orphan genesis (clone stderr: ${String(clone.stderr).trim().slice(0, 120)})`);
    }
    for (const [rel, content] of files) {
      mkdirSync(dirname(join(wc, rel)), { recursive: true });
      writeFileSync(join(wc, rel), content);
    }
    const add = git(['add', ...[...files.keys()]]);
    if (add.status !== 0) throw fail('git add', add);
    const commit = git(['-c', 'user.name=fsm-worker', '-c', 'user.email=fsm-worker@users.noreply.github.com',
      'commit', '-m', 'transcript: sessions update']);
    if (commit.status !== 0) throw fail('git commit', commit);
    const push = git(['push', 'origin', 'fsm-sessions']);
    if (push.status !== 0) throw fail('git push', push);
    log(`CC-TRANSCRIPT-PUSHED ${files.size} file(s) to fsm-sessions`);
    return { mode: 'pushed', branch: 'fsm-sessions', files: [...files.keys()] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function writeTranscript(envelope, runId, fake, result, opts, log) {
  const paths = transcriptPaths(envelope, runId);
  const body = transcriptBody(envelope, runId, fake, result);
  const meta = transcriptMeta(envelope, runId, fake, result, new Date(opts.now()).toISOString());
  const attempt = async () => {
    if (fake) {
      const dir = opts.transcriptsDir || opts.env.CC_FAKE_TRANSCRIPTS_DIR || join(tmpdir(), 'fsm-sessions-fake');
      mkdirSync(join(dir, dirname(paths.txt)), { recursive: true });
      writeFileSync(join(dir, paths.txt), body);
      writeFileSync(join(dir, paths.meta), meta);
      return { mode: 'local', dir, txt: paths.txt, meta: paths.meta };
    }
    return pushSessionsBranch({
      env: opts.env,
      files: new Map([[paths.txt, body], [paths.meta, meta]]),
      log,
    });
  };
  try {
    return await attempt();
  } catch (e1) {
    log(`CC-TRANSCRIPT-RETRY first attempt failed: ${String(e1?.message ?? e1).slice(0, 160)}`);
    try {
      return await attempt();
    } catch (e2) {
      throw new Error(`transcript-push-failed(${String(e2?.message ?? e2).slice(0, 120)})`);
    }
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
  const lanes = ccLanes(env);
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
    for (let i = 0; i < maxLanes; i++) {
      const lane = lanes[i];
      const argv = ccArgv(envelope, budget, env);
      const extraEnv = {};
      // T46/X20 run-3: real mode runs the LOCAL bridge per lane (the CLI's
      // models pre-flight 404s upstream; the key stays out of the CLI env).
      // Fake mode needs no bridge — the fake CLI never touches the network.
      let bridge = null;
      if (!fake) {
        try {
          bridge = await startBridge(lane, log);
          extraEnv.CC_BRIDGE_URL = bridge.url;
        } catch (e) {
          laneLog.push({
            lane: i + 1, key_index: lane.keyIndex, model: lane.model,
            rc: null, signal: null, duration_ms: 0, wall_killed: false,
            class: 'infra', bridge_error: String(e?.message ?? e).slice(0, 120),
          });
          lastClass = `cc-bridge(${String(e?.message ?? e).slice(0, 80)})`;
          continue;   // the bridge is infra — rotate the lane
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
          continue;   // the lane never reached the model — rotate
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
        // error-as-answer (E11) or budget-misconfigured (F-M4) — rotate
        laneInfo.class = 'infra';
        lastClass = cls.detail;
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
      // the write-back claim surface: the workdir scan — ONLY for lanes that
      // ran to rc 0 and answered (the raw-extraction path sets scan:true);
      // every failure shape carries [] like the shim's failure rows
      const refs = partial.scan === true ? scanWorkdir(workdir) : (partial.artifact_refs ?? []);
      let result = {
        ...partial,
        artifact_refs: refs,
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
      let door = null;
      if (Array.isArray(result.artifact_refs) && result.artifact_refs.length) {
        door = writeBackDoor({
          branch: `tasks/${taskId}`,
          paths: result.artifact_refs,
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
          };
        }
        log(`CC-TRANSCRIPT-MISSED (best-effort for a ${internalCls.status} turn): ${String(e?.message ?? e).slice(0, 160)}`);
        result.summary += ` [transcript missed: ${String(e?.message ?? e).slice(0, 80)}]`;
      }
      // the staging seam (W-C): allowed refs stage locally today; the live
      // task-branch commit + remote read-back replaces this when intake ships
      if (door?.ok && door.allowed.length) {
        const root = stageDir || env.CC_STAGE_DIR || join(tmpdir(), 'fsm-stage');
        const staged = stageAllowed(door, workdir, root);
        if (staged.length) log(`CC-STAGED ${staged.length} artifact(s) under ${root} (the W-C task-branch seam)`);
      }
      return result;
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    // an internally-created echo root is unreadable by the caller — reap it;
    // a PROVIDED one stays (conformance reads the boundary records after)
    if (echoRoot && !echoRootProvided) rmSync(echoRoot, { recursive: true, force: true });
  }
}
