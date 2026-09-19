#!/usr/bin/env node
// conformance-cc.mjs — the C3 MULTI-HARNESS PROOF (T46 §1g / F-M7).
//
// The shim (sim/harness-shim.mjs) is the CONTRACT REFERENCE (C3 folded there
// per D1); THIS suite drives the CC adapter (worker/cc-adapter.mjs, in
// CC_FAKE_LLM=1 mode — zero network, zero npm install) through the SAME
// behavior matrix and asserts PARITY: the same input class produces the same
// five-class status through the ONE classifier (lib/worker-contract.mjs's
// classifyOutcome — never a private mapping), plus the structural spawns the
// shim cannot prove (the boundary assertions F-M7 demands):
//
//   * the SPAWN boundary: the fake CLI echoes its REAL argv + the complete
//     F-M8 env contract (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL,
//     DISABLE_TELEMETRY, OX_AGENT_DEADLINE_UTC from envelope.deadline_ms) —
//     lane key index, model, deadline, max-turns all visible and correct
//   * the LANE ROTATION: fixture:429 on the key-1 lanes → lane 2's echo shows
//     the rotated model (same key), lane 4's shows the rotated KEY
//   * the LANE_ATTEMPTS BOUND: exactly budget.lane_attempts spawns
//   * the DEADLINE KILL: the process-group SIGKILL at the wall → status
//     'deadline' (rc=124-equivalent), no orphan CLI past the report
//
// MATRIX PARITY MAP (shim behavior → adapter fixture → the shared class):
//   fast          (no marker)                 → done
//   slow          [fixture:sleep-ms=250]      → done  (late-but-done is a
//                                                 wall-clock property, not a
//                                                 status — see the row note)
//   poison        [fixture:fail]              → work_failed (the poison
//                                                 BEHAVIOR is the CONTRACT's
//                                                 work class per W3-D4; the
//                                                 poison STATUS arrives via
//                                                 the door)
//   infra-flaky   [fixture:429-if:<key1>]     → infra_failed at the shim's
//                                                 attempt-1 shape (lane_attempts
//                                                 1); done-after-rotation at
//                                                 the attempt-2+ shape (the
//                                                 full pool) — both asserted
//   deadline      [fixture:sleep-ms]+wall     → deadline
//   hang (deadlineEnforced) — same as deadline → deadline (the dual-return
//                                                 contract: an enforcing
//                                                 harness never hangs)
//   dup-report    [fixture:dup-report]        → done + repeat_report:true
//   wb-violation  [fixture:wb-violation]      → the door flips BOTH to poison
//                                                 with VERBATIM-equal violation
//                                                 strings
// Adapter-side shapes beyond the shim matrix (asserted directly): reasoning-
// first (F-M4), auth-text-as-answer (E11), transport-exit, app-exit,
// max-turns, the scratch exclusion, the REAL CLI error-exit shape (m-1:
// rc≠0 + stdout result JSON with numeric api_error_status — X21-final).
//
// Exit non-zero on ANY mismatch. This is the gate `node worker/conformance-cc.mjs`.

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccTurn, ccChildEnv } from './cc-adapter.mjs';
import { shimInvoke, seedFromRunId, SHIM_BEHAVIORS } from '../sim/harness-shim.mjs';
import { classifyOutcome, writeBackDoor } from '../lib/worker-contract.mjs';

const KEY1 = 'conformance-key-one';
const KEY2 = 'conformance-key-two';
const fakeEnv = {
  CC_FAKE_LLM: '1', OPENROUTER_API_KEY: KEY1, OPENROUTER_API_KEY_2: KEY2,
  // M-1 marker secrets: every one of these must DIE at the spawn boundary
  // (the denylist strip) — they exist here to be provably absent
  GH_TOKEN: 'conformance-gh-token', GITHUB_TOKEN: 'conformance-github-token',
  GL_PAT: 'conformance-gl-pat', ANTHROPIC_AUTH_TOKEN: 'conformance-stale-caller-auth',
};

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const eq = (a, b) => a === b;

// ---------------------------------------------------------------------------
// The shared envelope: EXACTLY what envelopeFromDispatch mints for a live
// MODE=cc assignment (the same shape both harnesses consume).
// ---------------------------------------------------------------------------

const ENVELOPE_BASE = {
  task_ref: { kind: 'state-task', id: 'CF1' },
  prompt: 'conformance: do the thing',
  deadline_ms: Date.now() + 60_000,
  session: 'c/CF1/conf-a1',
  budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  mode: 'cc',
  attempt: 1,
};

const mkEnvelope = (over = {}) => ({ ...structuredClone(ENVELOPE_BASE), ...over });

async function adapterTurn(envelope, opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'conf-cc-'));
  try {
    return {
      result: await ccTurn(envelope, {
        env: fakeEnv, runId: 'conf-run', now: Date.now, log: () => {},
        transcriptsDir: join(base, 'sessions'), echoDir: join(base, 'echo'), stageDir: join(base, 'stage'),
        ...opts,
      }),
      roots: base,
    };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
}

const readEcho = (base, lane) =>
  JSON.parse(readFileSync(join(base, 'echo', `lane-${lane}.json`), 'utf8'));

// the report-level class of a harness return: the ONE classifier, then the
// write-back door on dones carrying refs (the runTurn order — parity means
// parity of the REPORT the FSM receiver would see, not just the raw return)
function reportClass(raw, allowRoot = []) {
  const cls = classifyOutcome(raw);
  if (cls.status === 'done' && Array.isArray(raw?.artifact_refs) && raw.artifact_refs.length) {
    const door = writeBackDoor({ branch: 'tasks/CF1', paths: raw.artifact_refs, allowRoot });
    if (!door.ok) return { status: 'poison', detail: `write-back-door(${door.violations.join('; ')})`, door };
  }
  return cls;
}

// ---------------------------------------------------------------------------
// THE MATRIX — parity rows: shimInvoke vs ccTurn, same input class.
// ---------------------------------------------------------------------------

const seed = seedFromRunId('conf-run', '1');
const coveredBehaviors = new Set();

async function matrixRow({ name, behavior, fixture, expect, envelope: envOver = {}, adapterOpts = {}, shimOpts = {} }) {
  coveredBehaviors.add(behavior);
  const envelope = mkEnvelope({
    ...envOver,
    ...(fixture !== null ? { prompt: `${fixture} conformance: do the thing` } : {}),
  });
  // the shim side (the reference)
  const shimRaw = shimInvoke(envelope, behavior, seed, { workMs: 100, ...shimOpts });
  const shimCls = reportClass(shimRaw);
  // the adapter side (the implementer)
  const { result, roots } = await adapterTurn(envelope, adapterOpts);
  const ccCls = reportClass(result);
  const ok = eq(shimCls.status, ccCls.status) && eq(ccCls.status, expect);
  check(`matrix:${name}`, ok,
    `shim=${shimCls.status} adapter=${ccCls.status} expect=${expect}`);
  rmSync(roots, { recursive: true, force: true });
  return { shimRaw, shimCls, result, ccCls };
}

const matrix = [];
matrix.push(await matrixRow({ name: 'fast', behavior: 'fast', fixture: null, expect: 'done' }));
matrix.push(await matrixRow({
  name: 'slow', behavior: 'slow', fixture: '[fixture:sleep-ms=250]', expect: 'done',
}));
matrix.push(await matrixRow({ name: 'poison (the BEHAVIOR = the work class)', behavior: 'poison', fixture: '[fixture:fail]', expect: 'work_failed' }));
matrix.push(await matrixRow({
  name: 'infra-flaky @attempt-1 (lane budget 1 — the shim\'s fail shape)', behavior: 'infra-flaky',
  fixture: '[fixture:429-if:conformance-key-one]', expect: 'infra_failed',
  envelope: { budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 1 } },
}));
const flakyRecovered = await matrixRow({
  name: 'infra-flaky @attempt-2+ (the full pool — the rotation recovers in-turn)', behavior: 'infra-flaky',
  fixture: '[fixture:429-if:conformance-key-one]', expect: 'done',
  envelope: { attempt: 2, budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 5 } },
});
matrix.push(flakyRecovered);
matrix.push(await matrixRow({
  name: 'deadline', behavior: 'deadline', fixture: '[fixture:sleep-ms=30000]', expect: 'deadline',
  envelope: { deadline_ms: Date.now() + 450, budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 } },
}));
matrix.push(await matrixRow({
  name: 'hang under an enforcing harness (deadlineEnforced — the adapter\'s group kill)', behavior: 'hang',
  fixture: '[fixture:sleep-ms=30000]', expect: 'deadline',
  envelope: { deadline_ms: Date.now() + 450, budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 } },
  // the shim's dual-return switch selects the enforcing caller's contract
  shimOpts: { deadlineEnforced: true },
}));
matrix.push(await matrixRow({ name: 'dup-report', behavior: 'dup-report', fixture: '[fixture:dup-report]', expect: 'done' }));
matrix.push(await matrixRow({
  name: 'wb-violation (the door flips BOTH)', behavior: 'wb-violation', fixture: '[fixture:wb-violation]', expect: 'poison',
}));

// dup-report parity detail: the repeat flag rides both sides
{
  const row = matrix.find(m => m.shimRaw.repeat_report === true);
  check('matrix:dup-report repeat flag parity', row != null && row.result.repeat_report === true,
    `shim repeat=${row?.shimRaw.repeat_report} adapter repeat=${row?.result.repeat_report}`);
}

// wb-violation parity detail: the ILLEGAL violation strings VERBATIM-equal
{
  const row = matrix[matrix.length - 1];
  const shimDoor = writeBackDoor({ branch: 'tasks/CF1', paths: row.shimRaw.artifact_refs });
  const ccDoor = writeBackDoor({ branch: 'tasks/CF1', paths: row.result.artifact_refs });
  const illegal = (v) => v.filter(s => s.startsWith('deny-dotgit') || s.startsWith('root-not-declared'));
  check('matrix:wb-violation door parity (verbatim)',
    eq(JSON.stringify(illegal(shimDoor.violations)), JSON.stringify(illegal(ccDoor.violations)))
    && illegal(shimDoor.violations).length === 2,
    `shim=[${illegal(shimDoor.violations)}] adapter=[${illegal(ccDoor.violations)}]`);
}

// ---------------------------------------------------------------------------
// The adapter-side shapes beyond the shim matrix (F-M4 / E11 / exits).
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:reasoning] go' }));
  const cls = classifyOutcome(result);
  check('shape:reasoning-first (F-M4)', eq(cls.status, 'done') && eq(cls.detail, 'reasoning-as-answer'),
    `status=${cls.status} detail=${cls.detail}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:auth-text] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 1 },
  }));
  check('shape:auth-text-as-answer (E11 — BEFORE done)', eq(result.status, 'infra_failed') && /error-as-answer/.test(result.detail ?? ''),
    `status=${result.status} detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const transport = await adapterTurn(mkEnvelope({
    prompt: '[fixture:exit-transport] go', budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  }));
  const app = await adapterTurn(mkEnvelope({ prompt: '[fixture:exit-app] go' }));
  check('shape:non-zero exits — transport hops, app is work',
    eq(transport.result.status, 'infra_failed') && eq(transport.result.lane_attempts_used, 2)
    && eq(classifyOutcome(app.result).status, 'work_failed') && eq(app.result.lane_attempts_used, 1),
    `transport=${transport.result.status}(${transport.result.lane_attempts_used} lanes) app=${classifyOutcome(app.result).status}(${app.result.lane_attempts_used} lanes)`);
  rmSync(transport.roots, { recursive: true, force: true });
  rmSync(app.roots, { recursive: true, force: true });
}
{
  // m-1: the REAL CLI error-exit shape (X21-final verbatim — the shape the
  // old fixture table lacked, the exact F-1 repro): rc 1 + the result JSON
  // on stdout with is_error:true + NUMERIC api_error_status:429 + the
  // "API Error: Request rejected (429) · Rate limit exceeded" text.
  // B-1: infra lane-<status> + rotation (never the terminal work_failed).
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:exit-api-429] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const classes = result.telemetry.lanes.map(l => l.class);
  check('shape:real CLI error-exit (X21-final) — api_error_status → infra lane-<status> + rotation',
    eq(result.status, 'infra_failed') && result.detail.includes('lane-exhausted(2/6 lanes, last lane-429)')
    && eq(result.lane_attempts_used, 2) && eq(JSON.stringify(classes), JSON.stringify(['infra', 'infra']))
    && eq(echo.fixtures[0], 'exit-api-429'),
    `status=${result.status} detail=${result.detail} lanes=${JSON.stringify(classes)}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  // m-1 (rotation recovery): the key-1 lanes exit with the API error, the
  // key-2 lane completes — the F-1 fix recovers the turn in-process
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:exit-api-429-if:conformance-key-one] go',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 5 },
  }));
  check('shape:real CLI error-exit — the rotation RECOVERS (key-2 lane completes)',
    eq(classifyOutcome(result).status, 'done') && eq(result.lane_attempts_used, 4)
    && eq(JSON.stringify(result.telemetry.lanes.map(l => [l.key_index, l.class])),
      JSON.stringify([[1, 'infra'], [1, 'infra'], [1, 'infra'], [2, 'done']])),
    `status=${classifyOutcome(result).status} used=${result.lane_attempts_used}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:max-turns] go' }));
  check('shape:max-turns (the CLI\'s own ceiling — work class, no hop)',
    eq(result.status, 'work_failed') && /error_max_turns/.test(result.detail ?? '') && eq(result.lane_attempts_used, 1),
    `status=${result.status} detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:scratch] go' }));
  check('shape:the CLI scratch is never a claim',
    eq(JSON.stringify(result.artifact_refs), JSON.stringify(['tasks/CF1/artifacts/real.md'])),
    `refs=${JSON.stringify(result.artifact_refs)}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE SPAWN BOUNDARY (F-M7) — the echoed argv + the complete F-M8 env.
// ---------------------------------------------------------------------------

{
  const dl = Date.now() + 60_000;
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: 'boundary probe',
    deadline_ms: dl,
    budget: { max_turns: 11, wall_ms: 60_000, lane_attempts: 3 },
  }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const argvOk = eq(JSON.stringify(echo.argv), JSON.stringify([
    '-y', '@anthropic-ai/claude-code@2.1.273',   // M-4: the pinned default
    '-p', 'boundary probe',
    // T46/X22 (live finding, run 35297656079): acceptEdits — the adapter's
    // designed shape since the X22 fix; this pin predated it (the drift).
    '--permission-mode', 'acceptEdits',
    '--max-turns', '11',
    '--output-format', 'json',
    '--disallowedTools', 'WebFetch,WebSearch',
  ]));
  const envOk = eq(echo.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api/v1')
    && eq(echo.env.ANTHROPIC_AUTH_TOKEN, KEY1)
    && eq(echo.env.ANTHROPIC_MODEL, 'deepseek/deepseek-v4.1-flash')
    && eq(echo.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek/deepseek-v4.1-flash')
    && eq(echo.env.DISABLE_TELEMETRY, '1')
    && eq(echo.env.OX_AGENT_DEADLINE_UTC, new Date(dl).toISOString())
    && eq(echo.env.OX_AGENT_TASK_ID, 'CF1');
  check('boundary: the real argv + the COMPLETE F-M8 env contract', argvOk && envOk && eq(classifyOutcome(result).status, 'done'),
    `argv=${argvOk ? 'ok' : JSON.stringify(echo.argv)} env=${envOk ? 'ok' : JSON.stringify(echo.env)}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE CREDENTIAL STRIP (M-1) — the merged child env at the spawn boundary.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: 'credential strip probe' }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const keys = new Set(echo.env_keys);
  // the raw credentials never ride the CLI's env; ANTHROPIC_AUTH_TOKEN is
  // the overlay's deliberate token (value-pinned), never the caller's stale
  const leaked = ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'GH_TOKEN', 'GITHUB_TOKEN', 'GL_PAT']
    .filter(k => keys.has(k));
  check('boundary: the credential denylist is DEAD at the spawn boundary (M-1)',
    leaked.length === 0 && eq(echo.env.ANTHROPIC_AUTH_TOKEN, KEY1) && eq(classifyOutcome(result).status, 'done'),
    `leaked=[${leaked.join(',')}] auth=${eq(echo.env.ANTHROPIC_AUTH_TOKEN, KEY1) ? 'lane-key (overlay)' : echo.env.ANTHROPIC_AUTH_TOKEN}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  // the bridge-mode merged env (pure — fake mode cannot spawn the bridge by
  // design): the CLI aims at the bridge holding ONLY the dummy token
  const merged = ccChildEnv({ ...fakeEnv, PATH: '/usr/bin:/bin' },
    { key: KEY1, keyIndex: 1, model: 'deepseek/deepseek-v4.1-flash' },
    mkEnvelope(), { CC_BRIDGE_URL: 'http://127.0.0.1:45678' });
  const dead = ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'GH_TOKEN', 'GITHUB_TOKEN', 'GL_PAT']
    .every(k => !(k in merged));
  check('boundary: bridge-mode merged env — bridge base + dummy token, denylist dead (M-1)',
    dead && eq(merged.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45678')
    && eq(merged.ANTHROPIC_AUTH_TOKEN, 'bridge-local-no-key') && eq(merged.PATH, '/usr/bin:/bin'),
    `dead=${dead} base=${merged.ANTHROPIC_BASE_URL} auth=${merged.ANTHROPIC_AUTH_TOKEN}`);
}
{
  // M-4: the CC_VERSION override semantics at the spawn boundary — the pin
  // is the DEFAULT (asserted in the argv check above), the env wins when set
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: 'version pin probe' }), {
    keepRoots: true, env: { ...fakeEnv, CC_VERSION: '9.9.999-conf' },
  });
  const echo = readEcho(roots, 0);
  check('boundary: the CLI pin — @2.1.273 default, CC_VERSION overrides (M-4)',
    eq(echo.argv[1], '@anthropic-ai/claude-code@9.9.999-conf') && eq(classifyOutcome(result).status, 'done'),
    `argv[1]=${echo.argv[1]}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE LANE ROTATION + THE BOUND — 429 on the key-1 lanes.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:429-if:conformance-key-one] rotate',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 5 },
  }), { keepRoots: true });
  const e2 = readEcho(roots, 1);
  const e4 = readEcho(roots, 3);
  const lane2Rotated = eq(e2.env.ANTHROPIC_AUTH_TOKEN, KEY1) && eq(e2.env.ANTHROPIC_MODEL, 'z-ai/glm-5.3-flash');
  const keyRotated = eq(e4.env.ANTHROPIC_AUTH_TOKEN, KEY2) && eq(e4.env.ANTHROPIC_MODEL, 'deepseek/deepseek-v4.1-flash');
  const recovered = eq(classifyOutcome(result).status, 'done') && eq(result.lane_attempts_used, 4);
  check('rotation: lane 2 shows the rotated MODEL; lane 4 the rotated KEY; the turn recovers',
    lane2Rotated && keyRotated && recovered,
    `lane2=${e2.env.ANTHROPIC_MODEL} lane4=${e4.env.ANTHROPIC_AUTH_TOKEN === KEY2 ? 'key2' : 'key1'} used=${result.lane_attempts_used}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:429] bound',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  }), { keepRoots: true });
  const spawns = readdirSync(join(roots, 'echo')).length;
  check('bound: lane_attempts caps the spawns exactly',
    eq(spawns, 2) && eq(result.lane_attempts_used, 2) && eq(result.status, 'infra_failed')
    && /lane-exhausted\(2\/6 lanes/.test(result.detail ?? ''),
    `spawns=${spawns} used=${result.lane_attempts_used} detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE DEADLINE KILL — the process-group reaper, no orphans past the report.
// ---------------------------------------------------------------------------

{
  const t0 = Date.now();
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:sleep-ms=30000] wall probe',
    deadline_ms: Date.now() + 400,
    budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 },
  }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const dead = async (pid) => {
    const limit = Date.now() + 3000;
    for (;;) {
      try { process.kill(pid, 0); } catch { return true; }
      if (Date.now() > limit) return false;
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const leaderDead = await dead(echo.pid);
  const grandchildDead = echo.grandchildPid ? await dead(echo.grandchildPid) : true;
  check('deadline: the wall kills the GROUP (leader + grandchild), status deadline',
    eq(result.status, 'deadline') && eq(result.detail, 'wall-budget-exceeded')
    && result.telemetry.lanes[0].wall_killed === true && leaderDead && grandchildDead
    && Date.now() - t0 < 5000,
    `status=${result.status} leader=${leaderDead ? 'dead' : 'ALIVE'} grandchild=${grandchildDead ? 'dead' : 'ALIVE'} took=${Date.now() - t0}ms`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The shim vocabulary sanity (the reference side of the matrix is intact).
// ---------------------------------------------------------------------------

{
  const missing = SHIM_BEHAVIORS.filter(b => !coveredBehaviors.has(b));
  check('reference: every SHIM_BEHAVIOR has a matrix row', missing.length === 0,
    `behaviors=${SHIM_BEHAVIORS.join(',')} covered=${coveredBehaviors.size}${missing.length ? ` MISSING=[${missing.join(',')}]` : ''}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r.pass).length;
console.log(`\nCONFORMANCE-RESULT ${results.length - failed}/${results.length} checks passed (shim=${SHIM_BEHAVIORS.length} behaviors, adapter=CC_FAKE_LLM)`);
if (failed) {
  console.error(`CONFORMANCE-FAILED: ${failed} mismatch(es)`);
  process.exit(1);
}
process.exit(0);
