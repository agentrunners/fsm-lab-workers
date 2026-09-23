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
  CC_KEY_CLASS_STATUSES, artifactPushEscalation,
} from '../worker/cc-adapter.mjs';
import { classifyOutcome } from '../lib/worker-contract.mjs';
import { composeReportOutcome } from '../worker/turn.mjs';

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
  // s21/O-3: the no-pool shape carries NO key fields (absent-means-absent —
  // there is no slot to name when the pool itself is empty)
  assert.equal('key_index' in result, false);
  assert.equal('pool_size' in result, false);
  roots.cleanup();
});

// s21/O-3 (audit a5, MAJOR) — the CC lane's KEY PICK rides the outcome like
// the real lane's: key_index = the 0-based index into the pool ARRAY of the
// key that served the turn's LAST attempted lane, pool_size = the pool's
// size. Before this the CC lane (the DEPLOYED mode) never produced key_index
// — the live journal held ZERO records, so the console's key-spread line
// would have been empty exactly where the W1/W3 key failure modes live.
test('ccTurn (s21/O-3): the outcome carries the serving key pair (key_index 0-based + pool_size) — and it survives composeReportOutcome', async () => {
  // the normal done: lane 1 rode key 1 (ordinal 1) → 0-based index 0, pool 2
  const { result, roots } = await turn(fakeEnv());
  assert.equal(classifyOutcome(result).status, 'done');
  assert.equal(result.key_index, 0, 'the serving key is pool slot 0 (the 0-based journal contract — the real lane\'s D3 semantics)');
  assert.equal(result.pool_size, 2);
  // the composer (the worker's report payload allowlist) passes BOTH — the
  // pair is what the drain journals beside lane_stats
  const outcome = composeReportOutcome(classifyOutcome(result), result, 5);
  assert.equal(outcome.key_index, 0);
  assert.equal(outcome.pool_size, 2);
  roots.cleanup();
  // the W1 key-jump recovery: the LAST lane rode key 2 (ordinal 2) → index 1
  const { result: jumped, roots: roots2 } = await turn(fakeEnv({ CC_MODEL: 'deepseek/deepseek-v4.1-flash' }), {
    prompt: '[fixture:exit-api-402-if:cc-test-key-one] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(classifyOutcome(jumped).status, 'done');
  assert.equal(jumped.key_index, 1, 'the turn\'s LAST lane (the answering one) was key 2 — the burned slot 0 is history, the SERVING key is what the report names');
  assert.equal(jumped.pool_size, 2);
  roots2.cleanup();
  // a single-key pool: index 0, pool 1 (the degenerate-but-honest shape)
  const { result: single, roots: roots3 } = await turn({ CC_FAKE_LLM: '1', OPENROUTER_API_KEY: KEY1 });
  assert.equal(single.key_index, 0);
  assert.equal(single.pool_size, 1);
  roots3.cleanup();
  // the escalation composers keep the pair (the artifact-push net-zero retry
  // keeps its key provenance — a hole here would blank the console's spread
  // line exactly on the retry path)
  const esc = artifactPushEscalation('T9', 2, new Error('push rejected'), { ...single, key_index: single.key_index, pool_size: single.pool_size });
  assert.equal(esc.key_index, 0);
  assert.equal(esc.pool_size, 1);
  const escNoKeys = artifactPushEscalation('T9', 2, new Error('push rejected'), { telemetry: {}, models: [], lane_attempts_used: 1, duration_ms: 1 });
  assert.equal('key_index' in escNoKeys, false);
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
  // s23/B6 (re-asserted, UNCHANGED by the tail): a HEALTHY key-2 means the
  // tail NEVER fires — it aims only the LAST key's key-class failure. No
  // `:free` lane was ever tried; the free slot stays reachable at m3 only
  // through ordinary advance (5xx/provider-diversity), never needed here.
  assert.ok(!result.models.some(m => typeof m === 'string' && m.endsWith(':free')),
    'B6: no :free lane fired — the tail is the both-paid-keys-dry last resort, not a mid-ladder hop');
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

test('cc s23 HEADLINE (B1+B2+B3): BOTH keys 402-shaped at the dispatched budget — the FREE TAIL completes the turn (the W1 quarantine arc becomes a done turn)', async () => {
  // the W1 live arc's terminal shape: the drained primary (402) fails over
  // to key 2, key 2 is ALSO credit-dry (402) — pre-s23 the third slot
  // burned on k2/glm (the paid sibling sharing the dead key's credit state)
  // → lane-exhausted(3/6) → net-zero ×3 → infra-exhausted QUARANTINE while
  // the :free slot sat one index away untried. s23/B1's rule redirects that
  // final slot to the tail: probe §1a's citation pair (paid 402 / free 200
  // on the SAME overdrawn key, SAME 32K ask) — a $0 request passes the
  // cost-proportional credit gate. The fixture keys on the LANE MODEL's
  // freeness (the fake's unless-free form): paid lanes exit the real CLI
  // error-exit shape, the :free lane answers normally.
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:exit-api-402-unless-free] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(classifyOutcome(result).status, 'done', 'the both-keys-dry arc now completes INSIDE the same 3-slot budget');
  assert.equal(result.lane_attempts_used, 3, 'the tail REPLACES the last paid lane — the budget does NOT grow');
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.model, l.class]), [
    [1, 'deepseek/deepseek-v4.1-flash', 'infra'],
    [2, 'deepseek/deepseek-v4.1-flash', 'infra'],
    [2, 'nvidia/nemotron-3.5-lightning:free', 'done'],
  ], 'k1ds(402) →JUMP→ k2ds(402) →TAIL→ k2nem(:free) — the brief\'s exact arithmetic');
  // B3: the free-tail marker rides the laneLog row (the slug derivation)
  assert.equal(result.telemetry.lanes[2].lane_class, 'free-tail');
  assert.equal('lane_class' in result.telemetry.lanes[0], false, 'the paid lanes carry no tail marker');
  // the third spawn's boundary rode the :free slug on the SAME (last) key —
  // the tail inherits the last auth-known-alive key (the W1 key-jump has
  // already rotated past auth-dead keys by the time the tail fires)
  const e2 = readEcho(roots, 2);
  assert.equal(e2.env.ANTHROPIC_MODEL, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(e2.env.ANTHROPIC_AUTH_TOKEN, KEY2, 'the tail rides the LAST key (both paid keys dry, key 2 still auth-alive)');
  roots.cleanup();
});

test('cc s23 (B2 escape hatch): CC_TAIL_MODEL=\'\' — the both-keys-dry arc is the PRE-s23 ladder again (byte-identical degenerate)', async () => {
  const { result, roots } = await turn(fakeEnv({ CC_TAIL_MODEL: '' }), {
    prompt: '[fixture:exit-api-402-unless-free] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(result.status, 'infra_failed', 'no :free slot → the third slot burns on the paid sibling again');
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.model]), [
    [1, 'deepseek/deepseek-v4.1-flash'],
    [2, 'deepseek/deepseek-v4.1-flash'],
    [2, 'z-ai/glm-5.3-flash'],
  ], 'the pre-s23 W1 arc verbatim: k1ds → k2ds → k2glm (the quality-vs-completion call stays the OPERATOR\'s)');
  roots.cleanup();
});

test('cc s23 (B2 swap): CC_TAIL_MODEL=cohere — the tail slot swaps without a code change (the reliability alternative, one env line)', async () => {
  const { result, roots } = await turn(fakeEnv({ CC_TAIL_MODEL: 'cohere/north-mini-code:free' }), {
    prompt: '[fixture:exit-api-402-unless-free] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(classifyOutcome(result).status, 'done');
  assert.deepEqual(result.telemetry.lanes.map(l => l.model), [
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4.1-flash',
    'cohere/north-mini-code:free',
  ]);
  assert.equal(result.telemetry.lanes[2].lane_class, 'free-tail');
  roots.cleanup();
});

test('cc s23 (B2 hard rule): a non-`:free` CC_TAIL_MODEL — LOUD throw converted to the reportable infra marker bad-tail-model (zero spawns)', async () => {
  // the §2.7 hard rule: the tail is `:free`, ALWAYS — a paid tail (even an
  // APPROVED paid model) would silently serve paid traffic on the exact
  // path taken when credit is the problem. The pure chain builder throws;
  // the TURN reports infra_failed with the distinct detail instead of dying
  // unhandled (the visible-waste doctrine — diagnosable from the journal).
  const { result, roots } = await turn(fakeEnv({ CC_TAIL_MODEL: 'z-ai/glm-5.3-flash' }), {
    prompt: 'go', budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /bad-tail-model\(ccModelChain: CC_TAIL_MODEL must end ':free'/);
  assert.equal(result.lane_attempts_used, 0, 'zero spawns — the misconfiguration never burns a lane');
  assert.deepEqual(result.telemetry.lanes, []);
  roots.cleanup();
});

test('cc s23 (the bridge, not an immunity): the tail ALSO fails key-class — the SAME bounded exhaustion (the quarantine verdict stays reachable)', async () => {
  // the plain marker fires on EVERY lane (the 429 = the key's free-daily
  // quota gone, or 401 = the key died between lanes): the tail 429s → the
  // rule finds no FORWARD free sibling → +1 → the budget exhausts at 3 →
  // the net-zero infra-retry ladder → the honest infra-exhausted quarantine.
  // A fleet that exhausts even its free lane is honestly quarantinable.
  const { result, roots } = await turn(fakeEnv(), {
    prompt: '[fixture:exit-api-402] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /lane-exhausted\(3\/6 lanes, last lane-402\)/);
  assert.equal(result.lane_attempts_used, 3);
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.model]), [
    [1, 'deepseek/deepseek-v4.1-flash'],
    [2, 'deepseek/deepseek-v4.1-flash'],
    [2, 'nvidia/nemotron-3.5-lightning:free'],
  ], 'the third slot is still the tail — it just ALSO 402s (the exhaustion shape is unchanged)');
  roots.cleanup();
});

test('cc W1: single-key pool — the key-jump degenerates to the tail skip (the last key IS the only key)', async () => {
  // no second key: ccNextLaneIndex has no next key to jump to — s23/B1's
  // rule then applies (the pool's only key is trivially the LAST key): the
  // key-class failure skips the paid sibling and lands on the SAME key's
  // `:free` slot. Pre-s23 this advanced +1 to glm (the paid sibling shares
  // the dead key's credit state — the same no-backoff-retry rationale); the
  // 1-key 402 arc now reaches the free slot at attempt 2 instead of 3.
  // CC_TAIL_MODEL='' restores the pre-s23 ladder byte-identically (the
  // escape hatch, pinned in the pure block below).
  const { result, roots } = await turn({ CC_FAKE_LLM: '1', OPENROUTER_API_KEY: KEY1 }, {
    prompt: '[fixture:exit-api-429] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  });
  assert.equal(result.status, 'infra_failed');
  assert.match(result.detail, /lane-exhausted\(2\/3 lanes, last lane-429\)/);
  assert.deepEqual(result.telemetry.lanes.map(l => [l.key_index, l.model]), [
    [1, 'deepseek/deepseek-v4.1-flash'],
    [1, 'nvidia/nemotron-3.5-lightning:free'],
  ], 'the 1-key key-class ladder: ds → the :free tail (glm skipped — credit-dead sibling)');
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
  // key-class on the LAST key (k2m2) → no next key: the same key's :free
  // slot is the IMMEDIATE next lane — the s23 tail answer and the pre-s23
  // +1 answer COINCIDE here (5 either way)
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

test('cc tail (s23/B1 pure): the LAST key\'s key-class failure skips the paid siblings — the same key\'s next `:free` slot', () => {
  const lanes = ccLanes(fakeEnv());   // 6 lanes: k1[ds,glm,nem], k2[ds,glm,nem]
  // THE RULE (the W1 live arc's fix, design §2.1): i=3 (k2/ds) key-class →
  // NO next key → the same key's next :free slot (5 = k2/nemotron:free),
  // NOT +1 (4 = k2/glm — the paid sibling that shares the dead key's
  // credit state: probe §1a, glm 402s wherever deepseek 402s on every
  // drained key; the W1 live arc burned its third slot exactly there)
  assert.equal(ccNextLaneIndex(lanes, 3, true), 5);
  // the tail itself fails key-class → no FORWARD free sibling → +1 past
  // the end (exhaustion — the tail is a bridge, not an immunity)
  assert.equal(ccNextLaneIndex(lanes, 5, true), 6);
  // a 3-key pool (hand-built — ccKeyPool reads 2 env slots today): the
  // rule fires ONLY on the LAST key; k2's key-class still JUMPS to k3
  // (the adjudicated v1 posture: the budget of 3 exhausts on the three
  // keys' primaries before any tail — the 3-key question stays deferred)
  const three = [];
  for (const keyIndex of [1, 2, 3]) {
    for (const model of ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'nvidia/nemotron-3.5-lightning:free']) {
      three.push({ key: `k${keyIndex}`, keyIndex, model });
    }
  }
  assert.equal(ccNextLaneIndex(three, 3, true), 6, 'k2 key-class → the k3 JUMP (not the k2 tail)');
  assert.equal(ccNextLaneIndex(three, 6, true), 8, 'k3/ds key-class (the LAST key) → the k3 tail (k3/nemotron:free)');
  // degenerate lanes with no free slot at all: a paid-only array — the
  // rule degenerates to +1 byte-for-byte
  const paidOnly = [
    { key: 'k1', keyIndex: 1, model: 'deepseek/deepseek-v4.1-flash' },
    { key: 'k1', keyIndex: 1, model: 'z-ai/glm-5.3-flash' },
    { key: 'k2', keyIndex: 2, model: 'deepseek/deepseek-v4.1-flash' },
    { key: 'k2', keyIndex: 2, model: 'z-ai/glm-5.3-flash' },
  ];
  assert.equal(ccNextLaneIndex(paidOnly, 2, true), 3, 'no :free lane exists → +1 (today\'s fallback)');
});

test('cc tail (s23/B2 pure): CC_TAIL_MODEL — the override, the `:free` hard rule, the escape hatches, the default-chain constraint', () => {
  // the default-chain constraint pin (§2.7 item 2): the DEFAULT chain's
  // non-tail models ARE the §S23 approved paid pair; the tail is `:free`.
  // (A custom CC_MODEL that is neither approved-nor-`:free` rides the head
  // at the operator's own call — the free-form head predates s23 and stays
  // the operator's position; the tail slot is where the hard rule binds.)
  assert.deepEqual(ccModelChain({}), CC_MODEL_CHAIN_DEFAULTS);
  const nonTail = ccModelChain({}).filter(m => !m.endsWith(':free'));
  assert.deepEqual(nonTail, ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
    'the non-tail defaults ∈ the §S23 approved pair — paid traffic rides ONLY these two');
  assert.ok(CC_MODEL_CHAIN_DEFAULTS[CC_MODEL_CHAIN_DEFAULTS.length - 1].endsWith(':free'),
    'the chain\'s LAST slot is the :free tail');
  // the override: a valid :free slug swaps the tail without a code change
  assert.deepEqual(ccModelChain({ CC_TAIL_MODEL: 'cohere/north-mini-code:free' }),
    ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'cohere/north-mini-code:free']);
  // the hard rule (§2.7 item 1): a paid tail throws LOUD — even an APPROVED
  // paid model (the tail is the FREE lane by design; a paid tail would
  // burn credit on the exact path taken when credit is the problem)
  assert.throws(() => ccModelChain({ CC_TAIL_MODEL: 'z-ai/glm-5.3-flash' }), /CC_TAIL_MODEL must end ':free'/);
  assert.throws(() => ccModelChain({ CC_TAIL_MODEL: 'deepseek/deepseek-v4.1-flash' }), /CC_TAIL_MODEL must end ':free'/);
  assert.throws(() => ccModelChain({ CC_TAIL_MODEL: 'vendor/paid-model' }), /CC_TAIL_MODEL must end ':free'/);
  // the escape hatches: '' and CC_TAIL_DISABLED=1 drop the slot — the B1
  // rule then degenerates to the pre-s23 +1 advance, byte-identical
  assert.deepEqual(ccModelChain({ CC_TAIL_MODEL: '' }),
    ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'], 'the empty string = the tail is OFF');
  assert.deepEqual(ccModelChain({ CC_TAIL_DISABLED: '1' }),
    ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'], 'the dedicated kill switch');
  // the paid-only chain + the rule: the escape hatch is behavioral, not
  // just shape — the degenerate ladder is +1 (k2ds → k2glm, today's arc)
  const paid = ccLanes(fakeEnv({ CC_TAIL_MODEL: '' }));
  assert.deepEqual(paid.map(l => l.model),
    ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']);
  assert.equal(ccNextLaneIndex(paid, 0, true), 2, 'the key-jump still fires (k1ds → k2ds)');
  assert.equal(ccNextLaneIndex(paid, 2, true), 3, 'k2ds key-class, no next key, NO free sibling → +1 (k2glm — the pre-s23 arc, byte-identical)');
  // the tail-as-head degenerate: the :free slot at m1 (a custom CC_MODEL
  // that IS free) — from a later k2 lane there is no FORWARD free sibling
  // (the head sits behind) → +1
  const freeHead = ccLanes(fakeEnv({ CC_MODEL: 'cohere/north-mini-code:free', CC_TAIL_MODEL: '' }));
  assert.deepEqual(freeHead.map(l => l.model).slice(0, 3),
    ['cohere/north-mini-code:free', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']);
  assert.equal(ccNextLaneIndex(freeHead, 3, true), 4, 'k2/cohere key-class → no FORWARD free sibling → +1 (k2/ds)');
  // the W7 dedup survives the split: a custom head dedups against the PAID
  // defaults, and a custom head that IS the tail model dedups the tail slot
  // (no exact (key, model) repeat at m1 AND m3)
  assert.deepEqual(ccModelChain({ CC_MODEL: 'z-ai/glm-5.3-flash' }),
    ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash', 'nvidia/nemotron-3.5-lightning:free']);
  assert.deepEqual(ccModelChain({ CC_MODEL: 'nvidia/nemotron-3.5-lightning:free' }),
    ['nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
    'the free-as-head chain: the tail slot dedups (W7 discipline); the free slot sits at m1');
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
