#!/usr/bin/env node
// conformance-codex.mjs — the s24/B4 CONFORMANCE PROOF for the codex engine
// (the multi-engine design §2, executable — this suite IS the design's gate;
// the shim-parity half of conformance-cc.mjs has no codex counterpart: the
// REFERENCE here is the design's own spec rows).
//
// Drives worker/codex-adapter.mjs's codexTurn in CODEX_FAKE_LLM=1 mode
// (worker/fake-codex.mjs stands in for the real codex CLI with the REAL
// argv — zero network, zero npm install) and asserts:
//
//   * the MATRIX: every fixture shape → the five-class outcome the design
//     §2.3/R7/D13 specifies (ok → done; the error classes → infra rotation
//     with lane exhaustion at the bound; the -if recovery → done on the
//     other key; turn-failed → work_failed terminal; exit-2 → the TERMINAL
//     codex-usage marker, NO rotation; hang → deadline)
//   * the SPAWN BOUNDARY: the exact argv vector (exec/--json/
//     --skip-git-repo-check/--dangerously-bypass-approvals-and-sandbox/
//     --disable apps/-C workdir/-m lane.model/-c model_context_window=<
//     per-model>/-o OUTSIDE the workdir/prompt verbatim LAST), stdin
//     IGNORED (the fstat class — an open pipe would hang codex on
//     "additional input"), the D14 env overlay (CODEX_HOME outside the
//     workdir + the LANE key), the 8-member denylist DEAD
//   * the LANE ROTATION: the model-major ladder [k1/ds, k2/ds, k1/glm] at
//     the dispatched bound — R3 WRITTEN DOWN: the key-class ladder and the
//     plain-advance ladder are IDENTICAL on this list (the JUMP degenerates
//     to +1 — asserted as the actual behavior, never pinned as a
//     difference); the single-key degradation row
//   * the LANE_STATS SHAPE (D6): usage × the models.json price table into
//     the EXACT lane-telemetry aggregate — deep-equal, deterministic under
//     the fixed clock (off-peak Wednesday noon UTC)
//   * the WORKDIR HYGIENE (R1): the LAW (a workdir containing ONLY the
//     task's declared artifacts reports exactly those artifacts done) + the
//     COUNTER-PIN (a stray AGENTS.md ⇒ the writeBackDoor violation fires —
//     the existing machinery, asserted, not changed)
//   * the TRANSCRIPT PROVENANCE (F15): harness 'codex', mode 'codex'
//   * the DEADLINE KILL: the process-group SIGKILL at the wall (leader +
//     grandchild), status 'deadline'
//   * the BOUND: exactly budget.lane_attempts spawns
//
// Exit non-zero on ANY mismatch. This is the gate
// `node worker/conformance-codex.mjs`.

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { codexTurn, codexUsageCost, codexModelEntry, CODEX_ENV_DENYLIST } from './codex-adapter.mjs';
import { classifyOutcome } from '../lib/worker-contract.mjs';

const KEY1 = 'conf-codex-key-one';
const KEY2 = 'conf-codex-key-two';
// the fixed clock: Wednesday 2026-09-16T12:00:00Z — OUTSIDE the deepseek
// weekday peak windows (01-04, 06-10 UTC) → the cost arithmetic pins are
// deterministic off-peak numbers
const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const fakeEnv = {
  CODEX_FAKE_LLM: '1', OPENROUTER_API_KEY: KEY1, OPENROUTER_API_KEY_2: KEY2,
  // M-1 marker secrets: every one of these must DIE at the spawn boundary
  // (the 8-member D14 strip set) — they exist here to be provably absent
  GH_TOKEN: 'conf-gh-token', GITHUB_TOKEN: 'conf-github-token',
  GL_PAT: 'conf-gl-pat', ANTHROPIC_AUTH_TOKEN: 'conf-stale-caller-auth',
  OPENROUTER_KEY_POOL: 'conf-73-key-pool', BRIDGE_LANE_LOG: '/tmp/conf-bridge-lane.jsonl',
};

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const eq = (a, b) => a === b;

// ---------------------------------------------------------------------------
// The shared envelope: EXACTLY what envelopeFromDispatch mints for a live
// MODE=codex assignment (the same shape both engines consume).
// ---------------------------------------------------------------------------

const ENVELOPE_BASE = {
  task_ref: { kind: 'state-task', id: 'CF1' },
  prompt: 'conformance: do the thing',
  deadline_ms: NOW + 60_000,
  session: 'c/CF1/conf-a1',
  budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
  mode: 'codex',
  attempt: 1,
};

const mkEnvelope = (over = {}) => ({ ...structuredClone(ENVELOPE_BASE), ...over });

async function adapterTurn(envelope, opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'conf-codex-'));
  try {
    return {
      result: await codexTurn(envelope, {
        env: fakeEnv, runId: 'conf-run', now: () => NOW, log: () => {},
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

const outside = (cwd, p) => {
  if (typeof p !== 'string' || p === '') return false;
  const rel = relative(cwd, p);
  return rel === '' || isAbsolute(rel) || rel.startsWith('..');
};

// ---------------------------------------------------------------------------
// THE MATRIX — every fixture shape through the design's specified outcome.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:ok] conformance: do the thing' }));
  check('matrix:ok — the full happy stream (thread.started → agent_message → turn.completed usage)',
    eq(classifyOutcome(result).status, 'done') && eq(result.lane_attempts_used, 1)
      && typeof result.content === 'string' && result.content.includes('fake-codex ok'),
    `status=${classifyOutcome(result).status} used=${result.lane_attempts_used}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:exit-2] conformance: do the thing' }));
  check('matrix:exit-2 — D13 TERMINAL infra_failed(codex-usage), NO lane rotation',
    eq(result.status, 'infra_failed') && /codex-usage\(error: unexpected argument/.test(result.detail ?? '')
      && eq(result.lane_attempts_used, 1) && eq(result.telemetry.lanes.length, 1)
      && !result.lane_stats,
    `status=${result.status} detail=${result.detail} used=${result.lane_attempts_used}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_credits] conformance: do the thing' }));
  const ladder = result.telemetry.lanes.map((l) => [l.key_index, l.model, l.class]);
  check('matrix:error_credits — key-class rotation, exhausted at the dispatched bound (3/4 lanes)',
    eq(result.status, 'infra_failed') && /lane-exhausted\(3\/4 lanes, last codex-error_credits\)/.test(result.detail ?? '')
      && eq(result.lane_attempts_used, 3)
      && eq(JSON.stringify(ladder), JSON.stringify([
        [1, 'deepseek/deepseek-v4.1-flash', 'infra'],
        [2, 'deepseek/deepseek-v4.1-flash', 'infra'],
        [1, 'z-ai/glm-5.3-flash', 'infra'],
      ])),
    `status=${result.status} detail=${result.detail} ladder=${JSON.stringify(ladder)}`);
  check('matrix:error_credits — the lane_stats error lines ride the rotation (3 calls, 0 ok, per-model map)',
    result.lane_stats && eq(result.lane_stats.calls, 3) && eq(result.lane_stats.ok, 0)
      && eq(result.lane_stats.models['deepseek/deepseek-v4.1-flash'].calls, 2)
      && eq(result.lane_stats.models['z-ai/glm-5.3-flash'].calls, 1),
    `lane_stats=${JSON.stringify(result.lane_stats)}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_rate_limit] conformance: do the thing' }));
  const ladder = result.telemetry.lanes.map((l) => [l.key_index, l.model, l.class]);
  check('matrix:error_rate_limit — plain advance, and R3 WRITTEN DOWN: the ladder is IDENTICAL to the key-class ladder',
    eq(result.status, 'infra_failed') && /lane-exhausted\(3\/4 lanes, last codex-error_rate_limit\)/.test(result.detail ?? '')
      && eq(JSON.stringify(ladder), JSON.stringify([
        [1, 'deepseek/deepseek-v4.1-flash', 'infra'],
        [2, 'deepseek/deepseek-v4.1-flash', 'infra'],
        [1, 'z-ai/glm-5.3-flash', 'infra'],
      ]))
      && eq(result.lane_stats.err429, 3),
    `status=${result.status} detail=${result.detail} err429=${result.lane_stats?.err429}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_credits-if:conf-codex-key-one] conformance: do the thing' }));
  check('matrix:error_credits-if:<lane-key> — the rotation RECOVERS on the other key (2 attempts, done)',
    eq(classifyOutcome(result).status, 'done') && eq(result.lane_attempts_used, 2)
      && eq(JSON.stringify(result.telemetry.lanes.map((l) => [l.key_index, l.class])), JSON.stringify([[1, 'infra'], [2, 'done']])),
    `status=${classifyOutcome(result).status} used=${result.lane_attempts_used}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const auth = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_auth] conformance: do the thing' }));
  const quota = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_quota_daily] conformance: do the thing' }));
  const network = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_network] conformance: do the thing' }));
  check('matrix:error_auth / error_quota_daily / error_network — every rotatable class burns the bound with its own detail',
    eq(auth.result.status, 'infra_failed') && /last codex-error_auth/.test(auth.result.detail ?? '')
      && eq(quota.result.status, 'infra_failed') && /last codex-error_quota_daily/.test(quota.result.detail ?? '')
      && eq(network.result.status, 'infra_failed') && /last codex-error_network/.test(network.result.detail ?? '')
      && eq(auth.result.lane_attempts_used, 3) && eq(quota.result.lane_attempts_used, 3) && eq(network.result.lane_attempts_used, 3),
    `auth=${auth.result.detail} quota=${quota.result.detail} network=${network.result.detail}`);
  rmSync(auth.roots, { recursive: true, force: true });
  rmSync(quota.roots, { recursive: true, force: true });
  rmSync(network.roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:turn-failed] conformance: do the thing' }));
  check('matrix:turn-failed — R7\'s other half: nothing classifiable ⇒ the EXIT CODE decides (work_failed, terminal)',
    eq(result.status, 'work_failed') && /codex-exit-1\(the model declined the task/.test(result.detail ?? '')
      && eq(result.lane_attempts_used, 1) && !result.lane_stats,
    `status=${result.status} detail=${result.detail} used=${result.lane_attempts_used}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:hang] conformance: do the thing',
    deadline_ms: NOW + 400, budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 },
  }));
  check('matrix:hang — the wall budget kills the turn (status deadline)',
    eq(result.status, 'deadline') && eq(result.detail, 'wall-budget-exceeded')
      && eq(result.telemetry.lanes[0].wall_killed, true),
    `status=${result.status} detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  // the single-key degradation row: no OPENROUTER_API_KEY_2 → the product is
  // [k1/ds, k1/glm]; the bound 3 clamps to the product's 2 lanes
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:error_credits] conformance: do the thing' }), {
    env: { ...fakeEnv, OPENROUTER_API_KEY_2: '' },
  });
  check('matrix:single-key degradation — [k1/ds, k1/glm], exhausted 2/2',
    eq(result.status, 'infra_failed') && /lane-exhausted\(2\/2 lanes, last codex-error_credits\)/.test(result.detail ?? '')
      && eq(JSON.stringify(result.telemetry.lanes.map((l) => [l.key_index, l.model])), JSON.stringify([
        [1, 'deepseek/deepseek-v4.1-flash'], [1, 'z-ai/glm-5.3-flash'],
      ])),
    `detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: 'no keys conformance' }), {
    env: { CODEX_FAKE_LLM: '1' },
  });
  check('matrix:empty pool — the routable no-lane-keys infra marker (zero spawns)',
    eq(result.status, 'infra_failed') && /no-lane-keys/.test(result.detail ?? '')
      && eq(result.lane_attempts_used, 0),
    `status=${result.status} detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE SPAWN BOUNDARY — the echoed argv + the D14 env contract + stdin.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: 'boundary probe codex' }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const a = echo.argv;
  const cIdx = a.indexOf('-C');
  const mIdx = a.indexOf('-m');
  const cOverride = a.indexOf('-c');
  const oIdx = a.indexOf('-o');
  const argvOk = eq(a[0], 'exec') && eq(a[1], '--json') && eq(a[2], '--skip-git-repo-check')
    && eq(a[3], '--dangerously-bypass-approvals-and-sandbox')
    && eq(a[4], '--disable') && eq(a[5], 'apps')
    && cIdx === 6 && eq(a[mIdx], '-m') && eq(a[mIdx + 1], 'deepseek/deepseek-v4.1-flash')
    && eq(a[cOverride], '-c') && eq(a[cOverride + 1], 'model_context_window=1000000')
    && eq(a[a.length - 1], 'boundary probe codex');
  // the -C value IS the spawn cwd; the -o file lives OUTSIDE it (R1's law —
  // nothing codex-owned lands in the workdir)
  const placementOk = eq(a[cIdx + 1], echo.cwd)
    && eq(a[oIdx + 1].endsWith('last-message.txt'), true)
    && outside(echo.cwd, a[oIdx + 1]);
  // stdin IGNORED: the fd-0 fstat class — a piped stdin would be 'fifo' and
  // codex would block forever on "additional input" (gotcha §10.1)
  const stdinOk = eq(echo.stdin, 'chardev-ignored');
  check('boundary: the exact argv vector — -m/-c ctx/--disable apps/-o OUTSIDE the workdir/prompt LAST, stdin IGNORED',
    argvOk && placementOk && stdinOk && eq(classifyOutcome(result).status, 'done'),
    `argv=${argvOk ? 'ok' : JSON.stringify(a)} placement=${placementOk ? 'ok' : a[oIdx + 1]} stdin=${echo.stdin}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const dl = NOW + 60_000;
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: 'env probe codex', deadline_ms: dl }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const envOk = eq(echo.env.OPENROUTER_API_KEY, KEY1)
    && typeof echo.env.CODEX_HOME === 'string' && echo.env.CODEX_HOME !== ''
    && outside(echo.cwd, echo.env.CODEX_HOME)
    && eq(echo.env.OX_AGENT_TASK_ID, 'CF1')
    && eq(echo.env.OX_AGENT_DEADLINE_UTC, new Date(dl).toISOString());
  const keys = new Set(echo.env_keys);
  // the strip set is 8 members, but OPENROUTER_API_KEY is the ONE the D14
  // overlay deliberately RE-INJECTS (with the LANE key — the inversion) —
  // its presence is asserted by VALUE below; the other 7 must be ABSENT,
  // and the OTHER lane's key must never ride a codex child
  const leaked = CODEX_ENV_DENYLIST.filter((k) => k !== 'OPENROUTER_API_KEY' && keys.has(k));
  check('boundary: the D14 overlay (CODEX_HOME outside the workdir + the LANE key + the kit lines), the denylist DEAD (7 absent, the lane key the ONLY re-injection)',
    envOk && leaked.length === 0 && keys.has('OPENROUTER_API_KEY')
      && echo.env.OPENROUTER_API_KEY === KEY1 && !keys.has('OPENROUTER_API_KEY_2')
      && eq(classifyOutcome(result).status, 'done'),
    `env=${envOk ? 'ok' : JSON.stringify(echo.env)} leaked=[${leaked.join(',')}] key=${echo.env.OPENROUTER_API_KEY === KEY1 ? 'lane-key (the deliberate inversion)' : echo.env.OPENROUTER_API_KEY}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  // the rotation boundary: after a key-class failure on lane 1, lane 2's
  // spawn carries KEY_2 on the SAME model (the model-major adjacency — R3)
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:error_credits-if:conf-codex-key-one] rotate',
  }), { keepRoots: true });
  const e2 = readEcho(roots, 1);
  check('rotation: lane 2 boundary carries KEY_2 on the SAME model (model-major adjacency)',
    eq(e2.env.OPENROUTER_API_KEY, KEY2) && eq(e2.argv[e2.argv.indexOf('-m') + 1], 'deepseek/deepseek-v4.1-flash')
      && eq(classifyOutcome(result).status, 'done'),
    `key=${e2.env.OPENROUTER_API_KEY === KEY2 ? 'key2' : 'OTHER'} model=${e2.argv[e2.argv.indexOf('-m') + 1]}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE BOUND — exactly budget.lane_attempts spawns.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:error_credits] bound',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 },
  }), { keepRoots: true });
  const spawns = readdirSync(join(roots, 'echo')).length;
  check('bound: lane_attempts caps the spawns exactly',
    eq(spawns, 2) && eq(result.lane_attempts_used, 2) && eq(result.status, 'infra_failed')
      && /lane-exhausted\(2\/4 lanes/.test(result.detail ?? ''),
    `spawns=${spawns} used=${result.lane_attempts_used} detail=${result.detail}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE DEADLINE KILL — the process-group reaper, no orphans past the report.
// ---------------------------------------------------------------------------

{
  const t0 = Date.now();
  const { result, roots } = await adapterTurn(mkEnvelope({
    prompt: '[fixture:hang] wall probe',
    deadline_ms: NOW + 400, budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 },
  }), { keepRoots: true });
  const echo = readEcho(roots, 0);
  const dead = async (pid) => {
    const limit = Date.now() + 3000;
    for (;;) {
      try { process.kill(pid, 0); } catch { return true; }
      if (Date.now() > limit) return false;
      await new Promise((r) => setTimeout(r, 25));
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
// THE LANE_STATS SHAPE (D6) — the EXACT lane-telemetry aggregate, deep-equal,
// deterministic under the fixed off-peak clock.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:usage-rich] stats probe' }));
  const ds = codexModelEntry('deepseek/deepseek-v4.1-flash');
  // usage-rich sums: input 25263 (cached 24848) + output 182 → the recomputed
  // cost via the SAME exported pure function (the arithmetic itself is pinned
  // exactly — with fixed off-peak clocks — in tests/test-codex-adapter.mjs)
  const usage = { input_tokens: 25263, cached_input_tokens: 24848, cache_write_input_tokens: 315, output_tokens: 182, reasoning_output_tokens: 40 };
  const expectedCost = codexUsageCost(usage, ds, NOW);
  const expected = {
    calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 25445, cost: expectedCost,
    p50_ms: 0, p95_ms: 0, rate_classes: {},
    models: { 'deepseek/deepseek-v4.1-flash': { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 25445, cost: expectedCost, p50_ms: 0, p95_ms: 0 } },
  };
  check('stats: the EXACT lane-telemetry aggregate shape (usage-rich, cached tokens accounted, fixed-clock ms)',
    eq(JSON.stringify(result.lane_stats), JSON.stringify(expected)) && eq(result.telemetry.turns, 2),
    `lane_stats=${JSON.stringify(result.lane_stats)}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  // the s21/O-3 pair rides the outcome exactly like the CC lane
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:ok] key pick probe' }));
  check('stats: the key pick pair rides the outcome (0-based key_index + pool_size)',
    eq(result.key_index, 0) && eq(result.pool_size, 2) && eq(classifyOutcome(result).status, 'done'),
    `key_index=${result.key_index} pool_size=${result.pool_size}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE WORKDIR HYGIENE (R1) — the LAW + the COUNTER-PIN.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:ok-artifacts] hygiene law probe' }));
  check('hygiene LAW (R1): a workdir containing ONLY the task\'s declared artifacts reports EXACTLY those artifacts done',
    eq(classifyOutcome(result).status, 'done')
      && eq(JSON.stringify(result.artifact_refs), JSON.stringify(['tasks/CF1/artifacts/out-codex.md'])),
    `status=${classifyOutcome(result).status} refs=${JSON.stringify(result.artifact_refs)}`);
  rmSync(roots, { recursive: true, force: true });
}
{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:agents-md-stray] counter-pin probe' }));
  check('hygiene COUNTER-PIN (R1): a stray AGENTS.md in the workdir ⇒ the writeBackDoor violation fires (the existing machinery)',
    eq(result.status, 'poison') && /write-back-door\(root-not-declared\(AGENTS\.md\)/.test(result.detail ?? '')
      && eq(JSON.stringify(result.artifact_refs), JSON.stringify(['AGENTS.md', 'tasks/CF1/artifacts/real.md'])),
    `status=${result.status} detail=${result.detail} refs=${JSON.stringify(result.artifact_refs)}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE TRANSCRIPT PROVENANCE (F15) — harness 'codex', mode 'codex'.
// ---------------------------------------------------------------------------

{
  const { result, roots } = await adapterTurn(mkEnvelope({ prompt: '[fixture:ok] transcript probe' }));
  const meta = JSON.parse(readFileSync(join(roots, 'sessions', 'sessions/CF1/conf-run-a1.meta.json'), 'utf8'));
  const txt = readFileSync(join(roots, 'sessions', 'sessions/CF1/conf-run-a1.txt'), 'utf8');
  check('transcript: harness \'codex\' + mode \'codex\' provenance (the engine-derived stamps, never the CC hardcode)',
    eq(meta.harness, 'codex') && eq(meta.mode, 'codex') && eq(meta.fake, true)
      && eq(meta.task, 'CF1') && eq(meta.run_id, 'conf-run') && meta.transcript.endsWith('.txt')
      && txt.startsWith('fsm-lab CODEX transcript (mode: codex')
      && result.transcript.mode === 'local',
    `harness=${meta.harness} mode=${meta.mode}`);
  rmSync(roots, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass).length;
console.log(`\nCONFORMANCE-CODEX-RESULT ${results.length - failed}/${results.length} checks passed (adapter=CODEX_FAKE_LLM, reference=the multi-engine design §2/R7/D13/R1/R3)`);
if (failed) {
  console.error(`CONFORMANCE-CODEX-FAILED: ${failed} mismatch(es)`);
  process.exit(1);
}
process.exit(0);
