// test-cc-adapter.mjs — the W4 CC-ADAPTER suite (T46 §1d / §1g).
// Pins worker/cc-adapter.mjs through CC_FAKE_LLM=1 (the determinism mode —
// worker/fake-cc.mjs stands in for the real CLI with the REAL argv, zero
// network, zero npm install; the REAL lane is only ever touched by X20's
// manual dispatch):
//   - the lane algebra: key pool × model chain, key-major flatten, bounds
//   - the F-M8 env contract at the SPAWN boundary (the fake's echo record)
//   - deadline enforcement: the process-group kill at the wall, no orphans
//   - classification integration: every fixture shape through classifyOutcome
//   - the lane rotation: infra-class failure → the next lane's spawn env
//   - the lane_attempts bound
//   - transcripts BEFORE the report (the fake-lane local write + the
//     push-failure → infra_failed 'transcript-push-failed' lane)
//   - the door governance on artifacts (poison flip, verbatim violations,
//     staging of the allowed only, the CLI-scratch exclusion)
// The multi-harness PARITY matrix (shim vs adapter, the C3 proof) lives in
// worker/conformance-cc.mjs — this file is the adapter's own unit surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ccTurn, ccLanes, ccKeyPool, ccModelChain, ccArgv, ccLaneEnv, ccCliVersion,
  ccExitJson, ccApiErrorStatus, ccChildEnv, ccNextLaneIndex, CC_ENV_DENYLIST,
  CC_BRIDGE_BASE_URL, CC_MODEL_CHAIN_DEFAULTS, CC_PERMISSION_DENIES,
  CC_KEY_CLASS_STATUSES,
} from '../worker/cc-adapter.mjs';
import { classifyOutcome } from '../lib/worker-contract.mjs';

const KEY1 = 'cc-test-key-one';
const KEY2 = 'cc-test-key-two';

const fakeEnv = (over = {}) => ({
  CC_FAKE_LLM: '1',
  OPENROUTER_API_KEY: KEY1,
  OPENROUTER_API_KEY_2: KEY2,
  ...over,
});

// the per-test scratch roots (transcripts + the F-M7 echo records + staging)
function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), 'cc-adapter-test-'));
  return {
    base,
    transcriptsDir: join(base, 'sessions'),
    echoDir: join(base, 'echo'),
    stageDir: join(base, 'stage'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// a valid envelope (the shape envelopeFromDispatch mints); deadline and
// budget overridden per test
function envelope(over = {}) {
  return {
    task_ref: { kind: 'state-task', id: 'T1' },
    prompt: 'do the thing',
    deadline_ms: Date.now() + 60_000,
    session: 'c/T1/local-a1',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
    mode: 'cc',
    attempt: 1,
    ...over,
  };
}

async function turn(env, over = {}, opts = {}) {
  const roots = makeRoots();
  try {
    const result = await ccTurn(envelope(over), {
      env, runId: 'test-run', now: Date.now, log: () => {},
      transcriptsDir: roots.transcriptsDir, echoDir: roots.echoDir, stageDir: roots.stageDir,
      ...opts,
    });
    return { result, roots };
  } catch (e) {
    roots.cleanup();
    throw e;
  }
}

const readEcho = (roots, lane) =>
  JSON.parse(readFileSync(join(roots.echoDir, `lane-${lane}.json`), 'utf8'));

// poll until the pid is GONE (a SIGKILLed pid can linger as a zombie for a
// beat before the reaper collects it)
async function waitPidGone(pid, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }   // ESRCH — gone
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// The lane algebra (pure).
// ---------------------------------------------------------------------------

test('cc lanes: the key pool × model chain product, KEY-MAJOR flatten (D2)', () => {
  const env = fakeEnv({ CC_MODEL: 'vendor/custom-model' });
  const lanes = ccLanes(env);
  assert.deepEqual(lanes.map(l => [l.keyIndex, l.model]), [
    [1, 'vendor/custom-model'],
    [1, 'deepseek/deepseek-v4.1-flash'],
    [1, 'z-ai/glm-5.3-flash'],
    [1, 'nvidia/nemotron-3.5-lightning:free'],
    [2, 'vendor/custom-model'],
    [2, 'deepseek/deepseek-v4.1-flash'],
    [2, 'z-ai/glm-5.3-flash'],
    [2, 'nvidia/nemotron-3.5-lightning:free'],
  ], 'every model on key 1 before key 2\'s first');
  assert.ok(lanes.every(l => l.key === (l.keyIndex === 1 ? KEY1 : KEY2)));
});

test('cc lanes: a single key collapses the pool; an empty pool yields NO lanes', () => {
  const one = ccLanes({ OPENROUTER_API_KEY: KEY1 });
  assert.equal(one.length, CC_MODEL_CHAIN_DEFAULTS.length);
  assert.ok(one.every(l => l.keyIndex === 1));
  assert.deepEqual(ccLanes({}), [], 'no keys = no lanes = the routable no-lane-keys infra marker');
  assert.deepEqual(ccKeyPool({}), []);
  assert.equal(ccKeyPool({ OPENROUTER_API_KEY_2: 'x' }).length, 1, 'key 2 alone is a valid pool');
});

test('cc model chain: CC_MODEL env heads the chain (trimmed); the defaults are the s19 eval verdict (D2)', () => {
  assert.deepEqual(CC_MODEL_CHAIN_DEFAULTS, ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'nvidia/nemotron-3.5-lightning:free'],
    'D2: deepseek-v4.1-flash primary (20.6s turn, 4/4 calls, flawless content), glm-5.3-flash fallback (provider diversity), nemotron free tail');
  assert.deepEqual(ccModelChain({}), CC_MODEL_CHAIN_DEFAULTS);
  assert.equal(ccModelChain({ CC_MODEL: ' x/y ' })[0], 'x/y');
  assert.deepEqual(ccModelChain({ CC_MODEL: '' }), CC_MODEL_CHAIN_DEFAULTS, 'empty = absent');
  // s21/W7 pins: the custom head DEDUPS against the defaults (custom wins)
  // — the deployed CC_MODEL == defaults[0] used to mint lane 2 as an exact
  // (key, model) repeat of lane 1, a no-backoff plain retry burning a
  // dispatched slot (compounds W1's unreachable key-2 failover).
  assert.deepEqual(ccModelChain({ CC_MODEL: 'deepseek/deepseek-v4.1-flash' }), CC_MODEL_CHAIN_DEFAULTS,
    'W7: the DEPLOYED shape — a duplicate head collapses to the defaults, no repeat lane');
  assert.deepEqual(ccModelChain({ CC_MODEL: 'z-ai/glm-5.3-flash' }),
    ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash', 'nvidia/nemotron-3.5-lightning:free'],
    'W7: custom wins the head; the duplicated default slot drops (3 lanes/key, not 4)');
  assert.equal(ccLanes({ OPENROUTER_API_KEY: KEY1, OPENROUTER_API_KEY_2: KEY2, CC_MODEL: 'deepseek/deepseek-v4.1-flash' }).length, 6,
    'W7 end-to-end: the deployed config is 2 keys × 3 distinct models = 6 lanes, not 8');
  assert.ok(!JSON.stringify(ccModelChain({})).includes('minimax'), 'the retired slug stays dead');
  assert.ok(!JSON.stringify(CC_MODEL_CHAIN_DEFAULTS).includes('deepseek-v4-flash-0731'),
    'D2 NEVER: the hallucinating free slug on the cc lane (silent content-poison, measured live)');
});

test('cc argv: the REAL spawn vector (npx form) — -p, --max-turns, json output, the SA-5 denies', () => {
  // no CC_VERSION: the PINNED default rides the argv (M-4 — live-proven
  // X20/X21, never 'latest')
  const argv = ccArgv(envelope({ budget: { max_turns: 12, wall_ms: 60_000, lane_attempts: 3 } }), { max_turns: 12 }, {});
  assert.deepEqual(argv, [
    '-y', '@anthropic-ai/claude-code@2.1.273',
    '-p', 'do the thing',
    // T46/X22 (live finding run 35297656079): headless write prompts deferred
    // the declared artifact — acceptEdits is the designed shape (the workdir
    // sandbox + the write-back door are the boundary)
    '--permission-mode', 'acceptEdits',
    '--max-turns', '12',
    '--output-format', 'json',
    '--disallowedTools', 'WebFetch,WebSearch',
  ]);
  assert.deepEqual(CC_PERMISSION_DENIES, ['WebFetch', 'WebSearch']);
  assert.equal(ccCliVersion({}), '2.1.273', 'the pinned default (M-4 — live-proven X20/X21, never latest)');
  assert.equal(ccCliVersion({ CC_VERSION: '' }), '2.1.273', 'empty = the pinned default');
  assert.equal(ccCliVersion({ CC_VERSION: ' 2.1.273 ' }), '2.1.273', 'trimmed env pin');
  assert.equal(ccArgv(envelope({ budget: { max_turns: 12, wall_ms: 60_000, lane_attempts: 3 } }), { max_turns: 12 }, { CC_VERSION: '9.9.999' })[1],
    '@anthropic-ai/claude-code@9.9.999', 'CC_VERSION overrides the pin');
});

test('cc W2: worker.yml\'s INSTALL default == the adapter pin — the install lane and the spawn lane agree (never latest)', () => {
  // s21/W2 (a2): the install step defaulted to @latest while the spawn argv
  // pinned 2.1.273 — an unset vars.CC_VERSION installed a version the spawn
  // lane would not use, so npx paid a fresh package download INSIDE the wall
  // budget (the ~7-min m-9 tax the install step exists to avoid). The yml
  // default and ccCliVersion() must move together — THIS pin is the tie.
  const yml = readFileSync(fileURLToPath(new URL('../.github/workflows/worker.yml', import.meta.url)), 'utf8');
  const m = /CC_PIN="\$\{CC_VERSION:-(.+?)\}"/.exec(yml);
  assert.ok(m, 'the install step defines CC_PIN with a ${CC_VERSION:-<literal>} default');
  assert.equal(m[1], ccCliVersion({}),
    `the install default (${m[1]}) must equal the adapter's ccCliVersion pin (${ccCliVersion({})}) — drift = the npx-download-inside-the-wall class`);
  assert.ok(yml.includes('npm install -g "@anthropic-ai/claude-code@${CC_PIN}"'), 'the install consumes the pin');
  assert.ok(!/\$\{CC_VERSION:-latest\}/.test(yml), 'the stale latest default is dead');
});

test('cc lane env: the FULL F-M8 contract shape (pure)', () => {
  const env = ccLaneEnv({ key: KEY1, keyIndex: 1, model: 'm/a' }, envelope({ deadline_ms: Date.parse('2026-09-16T12:34:56.000Z') }));
  // X20 run-3: F-M8 AMENDED — + CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  // (the background session-title call 404s on the bridge and kills the
  // turn); the direct (no-bridge) lane keeps the key as the token
  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: CC_BRIDGE_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: KEY1,
    ANTHROPIC_MODEL: 'm/a',
    ANTHROPIC_SMALL_FAST_MODEL: 'm/a',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    OX_AGENT_DEADLINE_UTC: '2026-09-16T12:34:56.000Z',
    OX_AGENT_TASK_ID: 'T1',
  });
  assert.equal(CC_BRIDGE_BASE_URL, 'https://openrouter.ai/api/v1');
  // the BRIDGE lane (real mode): the local URL + a DUMMY token — the real
  // key lives only in the bridge process's env (credential hygiene)
  const bridged = ccLaneEnv({ key: KEY1, keyIndex: 1, model: 'm/a' }, envelope({ deadline_ms: Date.parse('2026-09-16T12:34:56.000Z') }), { CC_BRIDGE_URL: 'http://127.0.0.1:45678' });
  assert.equal(bridged.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45678');
  assert.equal(bridged.ANTHROPIC_AUTH_TOKEN, 'bridge-local-no-key');
  assert.ok(!JSON.stringify(bridged).includes(KEY1), 'the real key never rides the CLI env in bridged mode');
});

test('ccTurn: envelope guards — the shim-parity throws (bad envelope / task_ref / prompt / deadline)', async () => {
  await assert.rejects(() => ccTurn(null), /envelope must be the ok-envelope/);
  await assert.rejects(() => ccTurn({ ...envelope(), task_ref: {} }), /task_ref\.id must be a non-empty string/);
  await assert.rejects(() => ccTurn({ ...envelope(), prompt: 42 }), /envelope\.prompt must be a string/);
  await assert.rejects(() => ccTurn({ ...envelope(), deadline_ms: undefined }), /deadline_ms must be finite epoch-ms/);
});

// ---------------------------------------------------------------------------
// The spawn boundary (F-M7) — the fake CLI's echoed invocation IS the real one.
// ---------------------------------------------------------------------------

test('cc spawn boundary: the fake echoes the REAL argv + the complete F-M8 env (one spawn)', async () => {
  const dl = Date.now() + 60_000;
  const { result, roots } = await turn(fakeEnv({ CC_MODEL: 'vendor/x', CC_VERSION: '2.1.273' }), {
    deadline_ms: dl, budget: { max_turns: 9, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(classifyOutcome(result).status, 'done');
  const echo = readEcho(roots, 0);
  assert.deepEqual(echo.argv, [
    '-y', '@anthropic-ai/claude-code@2.1.273',
    '-p', 'do the thing',
    // T46/X22: acceptEdits — headless write prompts deferred the declared
    // artifact (run 35297656079); the workdir sandbox is the boundary
    '--permission-mode', 'acceptEdits',
    '--max-turns', '9',
    '--output-format', 'json',
    '--disallowedTools', 'WebFetch,WebSearch',
  ], 'the npx argv verbatim (the fake received process.argv.slice(2) = the real vector)');
  assert.equal(echo.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.equal(echo.env.ANTHROPIC_AUTH_TOKEN, KEY1, 'lane 1 = key 1');
  assert.equal(echo.env.ANTHROPIC_MODEL, 'vendor/x');
  assert.equal(echo.env.ANTHROPIC_SMALL_FAST_MODEL, 'vendor/x', 'the sub-agent lane shares the model');
  assert.equal(echo.env.DISABLE_TELEMETRY, '1');
  assert.equal(echo.env.OX_AGENT_DEADLINE_UTC, new Date(dl).toISOString(), 'the wall, from envelope.deadline_ms');
  assert.equal(echo.env.OX_AGENT_TASK_ID, 'T1');
  assert.equal(echo.cwd.includes('cc-fake-'), true, 'a fresh temp workdir');
  assert.ok(Number.isInteger(echo.pid));
  roots.cleanup();
});

test('ccTurn: no lane keys → infra_failed no-lane-keys, ZERO spawns (a routable marker, never a work attempt)', async () => {
  const { result, roots } = await turn({ CC_FAKE_LLM: '1' });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /no-lane-keys/);
  assert.deepEqual(result.lane_attempts_used, 0);
  assert.ok(!existsSync(roots.echoDir) || readdirSync(roots.echoDir).length === 0, 'nothing was spawned — no echo records');
  roots.cleanup();
});

test('M-1: the merged child env carries NO credentials — the /proc/<pid>/environ leak is dead', async () => {
  // every marker secret a live runner would hold: both pool keys (via
  // fakeEnv), both GH tokens, a GL_PAT, and a stale caller-side
  // ANTHROPIC_AUTH_TOKEN — ALL must die at the spawn boundary
  const { result, roots } = await turn(fakeEnv({
    GH_TOKEN: 'gh-test-token', GITHUB_TOKEN: 'github-test-token',
    GL_PAT: 'glpat-test', ANTHROPIC_AUTH_TOKEN: 'stale-caller-auth-that-must-die',
  }));
  assert.equal(classifyOutcome(result).status, 'done');
  const echo = readEcho(roots, 0);
  const keys = new Set(echo.env_keys);
  // the raw credentials NEVER ride the CLI's env (the overlay sets
  // ANTHROPIC_AUTH_TOKEN deliberately — that one is value-pinned below)
  for (const k of CC_ENV_DENYLIST) {
    if (k === 'ANTHROPIC_AUTH_TOKEN') continue;
    assert.equal(keys.has(k), false, `${k} never rides the CLI child env`);
  }
  // the ONLY auth the child holds is the overlay's deliberate token — the
  // lane key in fake/direct mode (the bridge dummy in bridge mode, below);
  // the caller's stale value is gone
  assert.equal(echo.env.ANTHROPIC_AUTH_TOKEN, KEY1, 'the overlay token, never the caller\'s');
  roots.cleanup();
});

test('M-1 (bridge boundary, pure): the merged bridge-mode env — bridge base + dummy token, denylist dead', () => {
  // fake mode cannot spawn the bridge by design (zero network), so the
  // bridge-mode MERGED env — exactly what the spawn would receive — is
  // probed pure: the CLI needs only the base URL, the DUMMY token and the
  // model env to reach the bridge; the bridge itself holds the real key
  const merged = ccChildEnv({
    PATH: '/usr/bin:/bin', HOME: '/home/worker', CC_FAKE_LLM: '1',
    OPENROUTER_API_KEY: KEY1, OPENROUTER_API_KEY_2: KEY2,
    GH_TOKEN: 'gh', GITHUB_TOKEN: 'gh2', GL_PAT: 'gl',
    ANTHROPIC_AUTH_TOKEN: 'stale-caller-auth',
  }, { key: KEY1, keyIndex: 1, model: 'm/a' },
  envelope({ deadline_ms: Date.parse('2026-09-16T12:34:56.000Z') }),
  { CC_BRIDGE_URL: 'http://127.0.0.1:45678' });
  assert.equal(merged.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45678', 'the CLI aims at the local bridge');
  assert.equal(merged.ANTHROPIC_AUTH_TOKEN, 'bridge-local-no-key', 'ONLY the dummy — the real key lives in the bridge process env');
  for (const k of ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'GH_TOKEN', 'GITHUB_TOKEN', 'GL_PAT']) {
    assert.ok(!(k in merged), `${k} is dead in the merged env`);
  }
  assert.equal(merged.PATH, '/usr/bin:/bin', 'the working env (PATH et al.) still rides');
  assert.equal(merged.HOME, '/home/worker');
  assert.equal(merged.ANTHROPIC_MODEL, 'm/a');
  assert.equal(merged.ANTHROPIC_SMALL_FAST_MODEL, 'm/a');
  assert.ok(!('CC_BRIDGE_URL' in merged), 'the bridge URL is consumed into the base URL, not passed through');
  // the direct (bridgeless) merged env keeps the lane key as the token
  const direct = ccChildEnv({ OPENROUTER_API_KEY: KEY1, ANTHROPIC_AUTH_TOKEN: 'stale' },
    { key: KEY1, keyIndex: 1, model: 'm/a' }, envelope({ deadline_ms: 0 }));
  assert.equal(direct.ANTHROPIC_AUTH_TOKEN, KEY1, 'direct mode: the overlay lane key (the stale caller value died)');
  assert.ok(!('OPENROUTER_API_KEY' in direct));
});

// ---------------------------------------------------------------------------
// Classification integration — every fixture shape through the ONE classifier.
// ---------------------------------------------------------------------------

test('cc classify: the normal done — content extracted, single lane, no hop', async () => {
  const { result, roots } = await turn(fakeEnv());
  assert.equal(classifyOutcome(result).status, 'done');
  assert.match(result.content, /fake-cc ok: completed the task on deepseek\/deepseek-v4\.1-flash/);
  assert.equal(result.reasoning, null);
  assert.equal(result.lane_attempts_used, 1);
  assert.deepEqual(result.models, ['deepseek/deepseek-v4.1-flash']);
  assert.deepEqual(result.artifact_refs, [], 'nothing written = nothing claimed');
  assert.equal(result.telemetry.lanes[0].class, 'done');
  assert.equal(result.telemetry.lanes[0].rc, 0);
  roots.cleanup();
});

test('cc classify: reasoning-first (F-M4) — content null, reasoning populated → done reasoning-as-answer', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:reasoning] go' });
  const cls = classifyOutcome(result);
  assert.equal(cls.status, 'done');
  assert.equal(cls.detail, 'reasoning-as-answer');
  assert.equal(result.content, null);
  assert.match(result.reasoning, /the answer is 42/);
  roots.cleanup();
});

test('cc classify: error-as-answer (E11) — 401 text packaged as a successful answer → infra, BEFORE done', async () => {
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:auth-text] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 1 },
  });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /error-as-answer\(invalid api key\)/, 'the FIRST default marker in the text wins (E11, BEFORE done)');
  assert.match(result.detail, /lane-exhausted\(1\/6 lanes/);
  roots.cleanup();
});

test('cc classify: 429 text-as-answer → infra HOP; work-class shapes do NOT hop', async () => {
  // infra: the 429 marker text rides a "successful" result
  const infra = await turn(fakeEnv(), {
    prompt: '[fixture:429] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  });
  assert.equal(infra.result.status, 'infra_failed');
  assert.equal(infra.result.lane_attempts_used, 2, 'the lane rotated');
  infra.roots.cleanup();
  // work: the empty completion (the lane ANSWERED) — the raw extraction
  // shape returns unstamped; the ONE classifier at the caller normalizes
  const empty = await turn(fakeEnv(), { prompt: '[fixture:fail] go' });
  const emptyCls = classifyOutcome(empty.result);
  assert.equal(emptyCls.status, 'work_failed');
  assert.equal(empty.result.lane_attempts_used, 1, 'no hop — rotating the lane cannot change the answer');
  assert.match(emptyCls.detail, /empty-completion/);
  empty.roots.cleanup();
  // work: the CLI's own error surface (max-turns — the harness ceiling)
  const mt = await turn(fakeEnv(), { prompt: '[fixture:max-turns] go' });
  assert.equal(mt.result.status, 'work_failed');
  assert.match(mt.result.detail, /cc-error\(error_max_turns\)/);
  assert.equal(mt.result.lane_attempts_used, 1);
  mt.roots.cleanup();
});

test('cc classify (W4 NEGATIVE): a DONE answer DISCUSSING rate limits/unauthorized stays done — no hop, no quarantine', async () => {
  // the a2 W4 false-positive class, adapter end-to-end: a legitimately DONE
  // turn whose result prose MERELY MENTIONS the E11 markers (runbooks for
  // the 429 lane, quota docs — this repo's own task mix). Pre-W4 the bare
  // substring scan flipped it infra → rotation → lane-exhausted → net-zero
  // ×3 → infra-exhausted QUARANTINE of good, landed work.
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:done-marker-prose] go' });
  const cls = classifyOutcome(result);
  assert.equal(cls.status, 'done', 'the marker-mentioning prose answer stays done');
  assert.match(cls.artifact, /Done: documented the ops runbook/);
  assert.equal(result.lane_attempts_used, 1, 'NO hop — the answer is the work, not an error');
  assert.equal(result.telemetry.lanes.length, 1);
  assert.equal(result.telemetry.lanes[0].class, 'done');
  assert.equal(readdirSync(roots.echoDir).length, 1, 'exactly one spawn — nothing rotated');
  roots.cleanup();
});

test('cc classify: non-zero rc — transport-shaped stderr hops, app-shaped stderr is WORK', async () => {
  const transport = await turn(fakeEnv(), {
    prompt: '[fixture:exit-transport] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  });
  assert.equal(transport.result.status, 'infra_failed');
  assert.equal(transport.result.lane_attempts_used, 2, 'ECONNREFUSED-shaped stderr → the lane rotates');
  assert.match(transport.result.detail, /lane-exhausted\(2\/6 lanes, last lane-transport\)/);
  transport.roots.cleanup();
  const app = await turn(fakeEnv(), { prompt: '[fixture:exit-app] go' });
  assert.equal(app.result.status, 'work_failed');
  assert.match(app.result.detail, /cc-exit-2/);
  assert.equal(app.result.lane_attempts_used, 1, 'a deterministic app error does NOT rotate');
  app.roots.cleanup();
});

test('cc classify (B-1): the REAL CLI error-exit shape — rc≠0 + stdout JSON with numeric api_error_status → infra lane-<status>, ROTATION', async () => {
  const logs = [];
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:exit-api-429] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  }, { log: (...a) => logs.push(a.join(' ')) });
  // the X21-final F-1 fix: the API error surface (rc 1 + the result JSON on
  // stdout) is INFRA with the status in the detail — never the terminal
  // work_failed that burned 12/16 tasks on a lane-quota 429
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /lane-exhausted\(2\/6 lanes, last lane-429\)/, 'the status rides the detail for the audit');
  assert.equal(result.lane_attempts_used, 2, 'the lane rotated instead of terminating');
  assert.deepEqual(result.telemetry.lanes.map(l => l.class), ['infra', 'infra']);
  assert.equal(result.telemetry.lanes[0].rc, 1);
  // the CC-LANE-EXIT evidence log fired with the parsed api_error_status
  assert.ok(logs.some(l => l.includes('CC-LANE-EXIT') && l.includes('api_error_status=429')),
    'the diagnosis log rode the rotation');
  roots.cleanup();
});

test('cc classify (B-1): EVERY numeric api_error_status rotates — 400/401/402/404/5xx (the whole F-1 family, not just 429)', async () => {
  for (const status of [400, 401, 402, 404, 500, 502, 503]) {
    const { result, roots } = await turn(fakeEnv(), {
      prompt: `[fixture:exit-api-${status}] go`,
      budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
    });
    assert.equal(result.status, 'infra_failed', `api_error_status ${status} is infra`);
    assert.ok(result.detail.includes(`lane-exhausted(2/6 lanes, last lane-${status})`), `status ${status} rides the detail (detail=${result.detail})`);
    assert.equal(result.lane_attempts_used, 2, `status ${status} rotated`);
    roots.cleanup();
  }
});

test('cc rotation (B-1): key-1 exit-api-429 lane → JUMPS to key 2 and RECOVERS — the F-1 fix + the W1 key-jump end-to-end', async () => {
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:exit-api-429-if:cc-test-key-one] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 5 },
  });
  assert.equal(classifyOutcome(result).status, 'done', 'the rotation recovered the turn in-process');
  // s21/W1: the 429 is KEY-CLASS — the dead key's remaining models are
  // skipped (they would 429 too); the SECOND attempt is already key 2's
  // like-for-like deepseek lane (was 4 attempts pre-W1: k1m1→k1m2→k1m3→k2m1)
  assert.equal(result.lane_attempts_used, 2, 'attempt 1 = key-1 deepseek (exit-api-429), attempt 2 = key-2 deepseek — done');
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.class]), [
    [1, 'infra'], [2, 'done'],
  ]);
  roots.cleanup();
});

test('cc W1 HEADLINE: key-1 402s on every lane at the DISPATCHED budget (lane_attempts:3) + the deployed CC_MODEL — key 2 serves, the turn completes (the failover that did not exist)', async () => {
  // the deployed shape verbatim: CC_MODEL = defaults[0] (the W7 dedup makes
  // it 3 distinct models), 2 keys in the pool, lane_attempts 3 — the budget
  // assembleDispatchPayload mints. Pre-W1: all 3 served lanes were key-1
  // lanes (key-major flatten) → 402×3 → lane-exhausted → net-zero ×3 →
  // infra-exhausted quarantine while a HEALTHY key 2 sat idle (a2 W1).
  const { result, roots } = await turn(fakeEnv({ CC_MODEL: 'deepseek/deepseek-v4.1-flash' }), {
    prompt: '[fixture:exit-api-402-if:cc-test-key-one] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(classifyOutcome(result).status, 'done', 'the drained primary fails over INSIDE the dispatched budget');
  assert.equal(result.lane_attempts_used, 2, 'one 402 lane on key 1, then key 2 answers');
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.model, l.class]), [
    [1, 'deepseek/deepseek-v4.1-flash', 'infra'],
    [2, 'deepseek/deepseek-v4.1-flash', 'done'],
  ], 'key 2 SERVED — the like-for-like retry on the next key');
  const e2 = readEcho(roots, 1);
  assert.equal(e2.env.ANTHROPIC_AUTH_TOKEN, KEY2, 'the second spawn rode the second key');
  roots.cleanup();
});

test('cc W1: single-key pool — the key-jump degenerates to ordinary advance (byte-identical rotation)', async () => {
  // no second key: ccNextLaneIndex has no next key to jump to — the advance
  // is +1 exactly as before (the 1-key deployment is unchanged by W1)
  const { result, roots } = await turn({ CC_FAKE_LLM: '1', OPENROUTER_API_KEY: KEY1 }, {
    prompt: '[fixture:exit-api-429] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /lane-exhausted\(2\/3 lanes, last lane-429\)/);
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.model]), [
    [1, 'deepseek/deepseek-v4.1-flash'],
    [1, 'z-ai/glm-5.3-flash'],
  ], 'same-key model-chain rotation — the pre-W1 shape');
  roots.cleanup();
});

test('cc lane advance (W1 pure): ccNextLaneIndex — key-class jumps the key block, everything else advances one', () => {
  const lanes = ccLanes(fakeEnv());   // 6 lanes: k1m1..k1m3, k2m1..k2m3
  assert.equal(lanes.length, 6);
  // key-class at k1m1 → the next key's FIRST lane (k2m1 — like-for-like here)
  assert.equal(ccNextLaneIndex(lanes, 0, true), 3);
  // key-class mid-block (k1m2) → still the next key's FIRST lane (k2m1):
  // the product is consumed strictly in order, dead-key tails skipped
  assert.equal(ccNextLaneIndex(lanes, 1, true), 3);
  // key-class on the LAST key (k2m2) → no next key: ordinary advance
  assert.equal(ccNextLaneIndex(lanes, 4, true), 5);
  // key-class on the very last lane → advance past the end (exhaustion)
  assert.equal(ccNextLaneIndex(lanes, 5, true), 6);
  // non-key-class (transport/5xx/400/404/bridge) — always +1
  assert.equal(ccNextLaneIndex(lanes, 0, false), 1);
  assert.equal(ccNextLaneIndex(lanes, 3, false), 4);
  // degenerate inputs stay boring
  assert.equal(ccNextLaneIndex([], 0, true), 1);
  assert.equal(ccNextLaneIndex(lanes, -1, true), 0);
  assert.equal(ccNextLaneIndex(lanes, 99, true), 100);
  assert.equal(ccNextLaneIndex(null, 0, true), 1);
  // the key-class set is exactly the free lane's M5 rotate-class
  assert.deepEqual([...CC_KEY_CLASS_STATUSES].sort(), [401, 402, 429]);
});

test('cc exit-json helpers (B-1 pure): the stdout parse + the numeric-status trigger', () => {
  const x21 = JSON.stringify({
    type: 'result', subtype: 'api_error', is_error: true, api_error_status: 429,
    result: 'API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day-high-balance',
  });
  assert.equal(ccApiErrorStatus(ccExitJson(x21)), 429, 'the X21-final verbatim stdout shape');
  assert.equal(ccExitJson('not json at all'), null);
  assert.equal(ccExitJson('null'), null);
  assert.equal(ccExitJson('"a string"'), null);
  assert.equal(ccExitJson('[1,2]'), null, 'an array is not a result object');
  assert.deepEqual(ccExitJson('{}'), {}, 'an empty object parses (no status → work)');
  assert.equal(ccApiErrorStatus(null), null);
  assert.equal(ccApiErrorStatus({}), null);
  assert.equal(ccApiErrorStatus({ is_error: true, result: 'x' }), null, 'no numeric status → the work class (text-only shape)');
  assert.equal(ccApiErrorStatus({ api_error_status: '429' }), 429, 'a numeric STRING coerces (CLI-drift tolerance)');
  assert.equal(ccApiErrorStatus({ api_error_status: 'not-a-number' }), null);
  assert.equal(ccApiErrorStatus({ api_error_status: null }), null);
  assert.equal(ccApiErrorStatus({ api_error_status: true }), null, 'booleans are not statuses');
});

test('cc dup-report: the fixture rides repeat_report — the caller enqueues the SAME payload twice', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:dup-report] go' });
  assert.equal(classifyOutcome(result).status, 'done');
  assert.equal(result.repeat_report, true);
  roots.cleanup();
});

// ---------------------------------------------------------------------------
// The lane rotation (fixture:429 on key 1) + the lane_attempts bound.
// ---------------------------------------------------------------------------

test('cc rotation: key-1 lane 429 → JUMPS to a KEY-2 lane → done; every spawn boundary visible', async () => {
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:429-if:cc-test-key-one] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 5 },
  });
  assert.equal(classifyOutcome(result).status, 'done', 'the rotation recovered the turn in-process');
  // s21/W1: the E11 429-text conviction is key-class — attempt 2 is already
  // the key-2 like-for-like deepseek lane (was 4 attempts pre-W1)
  assert.equal(result.lane_attempts_used, 2, '1 key-1 lane burned (429 marker), the 2nd (key 2, same model) completed');
  assert.deepEqual(result.models, [
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4.1-flash',
  ], 'the like-for-like retry: same model, next key');
  // the SECOND spawn's boundary already shows the rotated KEY (same model)
  const e1 = readEcho(roots, 1);
  assert.equal(e1.env.ANTHROPIC_AUTH_TOKEN, KEY2, 'the key pool jumped (E11 markers are key-class)');
  assert.equal(e1.env.ANTHROPIC_MODEL, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.class]), [
    [1, 'infra'], [2, 'done'],
  ]);
  roots.cleanup();
});

test('cc bound: budget.lane_attempts caps the product — exhaustion reports the exact burn', async () => {
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:429] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /lane-exhausted\(2\/6 lanes/);
  assert.equal(result.telemetry.lanes.length, 2);
  assert.equal(readdirSync(roots.echoDir).length, 2, 'exactly two spawns');
  roots.cleanup();
});

// ---------------------------------------------------------------------------
// Deadline enforcement (F-M6): the process-group kill at the wall.
// ---------------------------------------------------------------------------

test('cc deadline: the wall kills the GROUP at the deadline — leader AND grandchild dead, status deadline', async () => {
  const t0 = Date.now();
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:sleep-ms=30000] park',
    deadline_ms: Date.now() + 400,               // the wall bites first
    budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 },
  });
  const took = Date.now() - t0;
  assert.equal(result.status, 'deadline', 'the rc=124-equivalent: the group kill self-reports');
  assert.equal(result.detail, 'wall-budget-exceeded');
  assert.ok(took < 5000, `the kill is prompt (took ${took}ms — no orphan CLI past the report)`);
  const lane = result.telemetry.lanes[0];
  assert.equal(lane.wall_killed, true);
  assert.equal(lane.signal, 'SIGKILL');
  const echo = readEcho(roots, 0);
  assert.ok(echo.grandchildPid, 'the sleep fixture parked a same-group grandchild');
  assert.equal(await waitPidGone(echo.pid), true, 'the leader is dead');
  assert.equal(await waitPidGone(echo.grandchildPid), true, 'the GRANDCHILD died with the group (kill(-pid), not kill(pid))');
  roots.cleanup();
});

test('cc deadline: budget.wall_ms binds when it bites before the lease deadline', async () => {
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:sleep-ms=30000] park',
    deadline_ms: Date.now() + 60_000,            // far away
    budget: { max_turns: 40, wall_ms: 400, lane_attempts: 3 },
  });
  assert.equal(result.status, 'deadline');
  assert.equal(result.detail, 'wall-budget-exceeded');
  roots.cleanup();
});

// ---------------------------------------------------------------------------
// Transcripts (F-M6, D3) — BEFORE the report.
// ---------------------------------------------------------------------------

test('cc transcripts: the full turn lands in the LOCAL dir (fake mode) BEFORE ccTurn resolves — the report references it', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: 'transcribe me', attempt: 2 });
  assert.equal(result.transcript.mode, 'local');
  assert.equal(result.transcript.txt, 'sessions/T1/test-run-a2.txt');
  assert.equal(result.transcript.meta, 'sessions/T1/test-run-a2.meta.json');
  // the structural ordering proof: by the time ccTurn has returned (and only
  // THEN does runTurn enqueue the report), both files are COMPLETE on disk
  const txt = readFileSync(join(roots.transcriptsDir, 'sessions/T1/test-run-a2.txt'), 'utf8');
  const meta = JSON.parse(readFileSync(join(roots.transcriptsDir, 'sessions/T1/test-run-a2.meta.json'), 'utf8'));
  assert.ok(txt.includes('--- PROMPT ---') && txt.includes('transcribe me'));
  assert.ok(txt.includes('--- RESULT ---') && txt.includes('done'));
  assert.ok(txt.includes('lane 1: key#1 deepseek/deepseek-v4.1-flash'));
  assert.equal(meta.task, 'T1');
  assert.equal(meta.run_id, 'test-run');
  assert.equal(meta.attempt, 2);
  assert.equal(meta.mode, 'cc');
  assert.equal(meta.fake, true);
  assert.equal(meta.status, 'done');
  assert.equal(meta.transcript, 'sessions/T1/test-run-a2.txt');
  roots.cleanup();
});

test('cc transcripts: push failure → retry once → infra_failed transcript-push-failed (the lane dies, not the lie)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-adapter-test-'));
  try {
    const blockFile = join(base, 'not-a-dir');   // a FILE where the root must be
    writeFileSync(blockFile, 'x');
    const logs = [];
    const result = await ccTurn(envelope(), {
      env: fakeEnv(), runId: 'test-run', now: Date.now,
      log: (...a) => logs.push(a.join(' ')),
      transcriptsDir: blockFile, echoDir: join(base, 'echo'), stageDir: join(base, 'stage'),
    });
    assert.equal(result.status, 'infra_failed');
    assert.match(result.detail, /transcript-push-failed/);
    assert.ok(logs.some(l => l.includes('CC-TRANSCRIPT-RETRY')), 'exactly one retry before the failure lane');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The door governance on artifacts (D4) + the claim surface.
// ---------------------------------------------------------------------------

test('cc artifacts: a LEGAL write-back claim — the door passes, the ref stages (the W-C seam), done stands', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:artifacts] go' });
  assert.equal(classifyOutcome(result).status, 'done');
  assert.deepEqual(result.artifact_refs, ['tasks/T1/artifacts/out-fake.md']);
  const staged = join(roots.stageDir, 'tasks/T1/artifacts/out-fake.md');
  assert.ok(existsSync(staged), 'the allowed ref is staged locally (the W-C task-branch seam)');
  assert.match(readFileSync(staged, 'utf8'), /deterministic legal write-back ref/);
  roots.cleanup();
});

test('cc artifacts: the CLI-internal scratch is NEVER a claim (.claude/**, .claude.json)', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:scratch] go' });
  assert.equal(classifyOutcome(result).status, 'done');
  assert.deepEqual(result.artifact_refs, ['tasks/T1/artifacts/real.md'],
    'the scratch set is excluded; only the real artifact is claimed');
  roots.cleanup();
});

test('cc door: the wb-violation fixture → POISON with the shim-parity violations VERBATIM; nothing stages', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:wb-violation] go' });
  assert.equal(result.status, 'poison', 'the door is the governance — the done flipped');
  assert.match(result.detail, /write-back-door\(deny-dotgit\(\.github\/workflows\/evil\.yml\)/);
  assert.match(result.detail, /root-not-declared\(evil\.txt\)/);
  assert.ok(result.artifact_refs.includes('tasks/T1/out/report.md'), 'the LEGAL ref rides as evidence');
  assert.ok(result.artifact_refs.includes('.github/workflows/evil.yml'), 'the ILLEGAL ref rides as evidence');
  assert.equal(existsSync(join(roots.stageDir, 'tasks/T1/out/report.md')), false, 'a poisoned turn stages NOTHING');
  roots.cleanup();
});

test('cc door: a DECLARED root file unlocks itself; declaring never unlocks the denied', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:wb-violation] go' }, { allowRoot: ['evil.txt'] });
  assert.equal(result.status, 'poison', 'the dotgit violation alone still poisons');
  assert.doesNotMatch(result.detail, /root-not-declared/);
  assert.match(result.detail, /deny-dotgit/);
  roots.cleanup();
});

// ---------------------------------------------------------------------------
// Determinism of the outcome surface (fake mode).
// ---------------------------------------------------------------------------

test('cc determinism: same fixture → byte-identical outcome surface (timings excluded)', async () => {
  const pick = (r) => JSON.stringify({
    status: r.status, detail: r.detail, content: r.content, reasoning: r.reasoning,
    artifact_refs: r.artifact_refs, models: r.models, lane_attempts_used: r.lane_attempts_used,
    repeat_report: r.repeat_report ?? false,
    lanes: r.telemetry.lanes.map(l => [l.lane, l.key_index, l.model, l.class]),
  });
  const a = await turn(fakeEnv(), { prompt: '[fixture:429-if:cc-test-key-one] go', budget: { max_turns: 5, wall_ms: 60_000, lane_attempts: 5 } });
  const b = await turn(fakeEnv(), { prompt: '[fixture:429-if:cc-test-key-one] go', budget: { max_turns: 5, wall_ms: 60_000, lane_attempts: 5 } });
  assert.equal(pick(a.result), pick(b.result), 'the outcome surface is a pure function of (envelope, fixture)');
  a.roots.cleanup(); b.roots.cleanup();
});

test('X20-run-1 lesson: an ISO-string now() clock fails LOUD (the NaN-wall instant-kill class)', async () => {
  await assert.rejects(
    () => ccTurn(envelope(), { env: fakeEnv(), runId: 'iso-clock', now: () => new Date().toISOString() }),
    /opts\.now\(\) must return finite epoch-ms/,
  );
});

test('X20 run-4 lesson: the bridge spawns, listens on 127.0.0.1, synthesizes the models route, and stops cleanly', async () => {
  // startBridge IS exported (the W-D fold's A3 glue pin drives it in
  // tests/test-cc-bridge.mjs — the bridge env wiring at the spawn seam);
  // THIS pin stays on the raw bridge contract: spawn cc-bridge.mjs (no
  // network needed until a request arrives) and check the port-file contract
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scratch = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const portFile = join(scratch, 'port');
  const child = spawn(process.execPath, ['worker/cc-bridge.mjs', portFile], {
    // W-D review fold (A2): BRIDGE_LANE_LOG on EVERY test spawn of the
    // bridge — the cwd fallback would write ./bridge-lane.jsonl into the
    // repo (this test drives no upstream call so writes nothing today, but
    // the spawn must be residue-proof by construction, not by accident)
    env: { PATH: process.env.PATH || '/usr/bin:/bin', OPENROUTER_API_KEY: 'sk-or-v1-test-key', CC_LANE_MODEL: 'test/model:free', BRIDGE_LANE_LOG: join(scratch, 'bridge-lane.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let port = null;
  for (let i = 0; i < 40 && !(Number.isInteger(port) && port > 0); i++) {
    await new Promise((r) => setTimeout(r, 50));
    try { port = parseInt(readFileSync(portFile, 'utf8').trim(), 10); } catch { /* not yet */ }
  }
  assert.ok(Number.isInteger(port) && port > 0, `the bridge writes its port file (${out.slice(0, 120)})`);
  // the models DETAIL route: synthesized, 200, no network — the BARE model
  // object (m-7: the real Anthropic detail shape; the LIST shape lives on
  // GET /v1/models — reconciled with lane B's bridge at integration)
  const r = await fetch(`http://127.0.0.1:${port}/v1/models/test%2Fmodel%3Afree`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, 'test/model:free');
  assert.equal(body.type, 'model');
  // unknown route: LOUD 501 (never a silent 404 mirror)
  const r2 = await fetch(`http://127.0.0.1:${port}/v1/something-else`, { method: 'POST' });
  assert.equal(r2.status, 501);
  child.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});
