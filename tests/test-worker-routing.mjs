// test-worker-routing.mjs — the W-B ROUTING suite (T46 §1c / §1g).
// Pins worker/turn.mjs's runTurn — the whole worker turn with every
// dependency injectable (fetch / enqueue / sleep / clock / logs), so the
// routing contract is testable offline with zero git and zero network:
//   - LAW 1, the start-gate: envelopeFromDispatch FIRST — an expired
//     deadline at job start reports infra_failed 'late-start', does NO work,
//     exits 0 (the lease is never burned on a guaranteed orphan)
//   - MODE routing: mock → shimInvoke / real → the env-driven model chain
//     with ONE fallback hop on infra-class failure / cc → the REAL adapter
//     (worker/cc-adapter.mjs in CC_FAKE_LLM mode — T46/W4)
//   - classifyOutcome as the ONE normalizer before report enqueue (the
//     five-class round trip through the full turn)
//   - the write-back door: a done carrying illegal artifact_refs flips to
//     the poison class (the door is the governance)
//   - the enqueue-failure hardening: retry once, then the run-conclusion
//     step summary (the visible-waste doctrine), exit 2
//   - the report identity: attempt-scoped ids through the ONE mint table

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, realWork, realModelChain, sleepCapMs } from '../worker/turn.mjs';
import { seedFromRunId } from '../sim/harness-shim.mjs';
import { mintEventId } from '../lib/worker-contract.mjs';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// the harness: fakes for everything runTouch touches
function makeHarness({ cp, env = {}, fetchImpl, enqueueResult = { ok: true }, runId = '99881', runAttempt = '1' } = {}) {
  const sleeps = [];
  const enqueued = [];
  const logs = [];
  const fetches = [];
  const fetch = fetchImpl ?? (async () => { throw new Error('unexpected fetch'); });
  const wrappedFetch = async (...a) => { fetches.push(a); return fetch(...a); };
  const turn = (over = {}) => runTurn({
    cp, runId, runAttempt, env, fetchImpl: wrappedFetch,
    enqueue: async (report) => { enqueued.push(structuredClone(report)); return enqueueResult; },
    sleepImpl: async (ms) => { sleeps.push(ms); },
    now: () => NOW,
    log: (...a) => logs.push(a.join(' ')),
    stepSummaryPath: over.stepSummaryPath ?? null,
    ...over,
  });
  return { turn, sleeps, enqueued, logs, fetches };
}

const legacyCp = (over = {}) => ({
  // the EXACT legacy-minimal live ASSIGN shape (conductor/turn.mjs mints it)
  task: 'A3', lease: 'l-abc123def456', behavior: 'succeed',
  attempt: 1, work_ms: 6000, expires: iso(NOW + 900_000), chain: 'c-123',
  ...over,
});

// ---------------------------------------------------------------------------
// LAW 1 — the start-gate.
// ---------------------------------------------------------------------------

test('routing: LAW-1 late-start — expired deadline at job start → infra_failed \'late-start\', NO work, exit 0', async () => {
  const h = makeHarness({ cp: legacyCp({ expires: iso(NOW - 60_000) }) });   // lease already lapsed
  const r = await h.turn();
  assert.equal(r.exitCode, 0, 'NEVER a failed run for a handled gate rejection');
  assert.equal(r.reported, true);
  assert.equal(h.sleeps.length, 0, 'zero work performed — the lease is not burned');
  assert.equal(h.enqueued.length, 1);
  const rep = h.enqueued[0];
  assert.equal(rep.event_id, mintEventId('REPORT', { runId: '99881', attempt: '1' }), 'attempt-scoped id through the ONE mint table');
  assert.equal(rep.task, 'A3');
  assert.equal(rep.lease, 'l-abc123def456');
  assert.equal(rep.outcome.status, 'infra_failed');
  assert.equal(rep.outcome.error, 'late-start');
  assert.ok(h.logs.some(l => l.includes('WORKER-GATE-REJECT') && l.includes('late-start')));
});

test('routing: LAW-1 inside the margin — deadline past but lease live → still the gate (net-zero retry lands on a VALID lease)', async () => {
  // deadline = lease − 120s margin: a job starting in the last 2 minutes of
  // the lease is a guaranteed orphan work-wise — the gate fires
  const h = makeHarness({ cp: legacyCp({ expires: iso(NOW + 60_000) }) });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.enqueued[0].outcome.status, 'infra_failed');
  assert.equal(h.enqueued[0].outcome.error, 'late-start');
});

test('routing: gate fail-closed for corrupt payloads — the reason rides the report, exit 0', async () => {
  const h = makeHarness({ cp: legacyCp({ attempt: 0 }) });   // bad-attempt
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.enqueued[0].outcome.status, 'infra_failed');
  assert.equal(h.enqueued[0].outcome.error, 'bad-attempt');
});

test('routing: no task id — nothing reportable, loud log, exit 0', async () => {
  const h = makeHarness({ cp: { behavior: 'fast', expires: iso(NOW + 600_000) } });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.enqueued.length, 0);
  assert.ok(h.logs.some(l => l.includes('WORKER-ENVELOPE-REJECT')));
});

// ---------------------------------------------------------------------------
// MODE=mock — the shim lane (live semantics preserved through the contract).
// ---------------------------------------------------------------------------

test('routing: mock fast — ok envelope → work happens, done report with the contract extras', async () => {
  const h = makeHarness({ cp: legacyCp({ behavior: 'fast', work_ms: 10 }) });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(r.reported, true);
  assert.deepEqual(h.sleeps, [10], 'the shim wall (work_ms), uncapped below the TTL margin');
  const rep = h.enqueued[0];
  assert.equal(rep.outcome.status, 'done');
  assert.equal(typeof rep.outcome.artifact, 'string');
  assert.ok(Array.isArray(rep.outcome.artifact_refs) && rep.outcome.artifact_refs.every(p => p.startsWith('tasks/A3/')));
  // turns: the seeded shim's DETERMINISTIC output for this run identity
  // (seedFromRunId('99881','1') → intIn(rng,1,4) = 2) — a concrete pin, not
  // a self-reference: a mint/seed drift that changes the turn count fails here
  assert.deepEqual(rep.outcome.telemetry, { turns: 2, wall_ms: 10, lane_attempts_used: 1 });
  assert.equal(rep.event_id, 'rep-99881-a1');
  assert.ok(h.logs.some(l => l.startsWith('WORKER-DONE') && l.includes('outcome=done')));
});

test('routing: mock slow — the wall is capped at TTL−2min (F-G(a)) so the report lands LATE (the orphan class)', async () => {
  const h = makeHarness({ cp: legacyCp({ behavior: 'slow' }), env: { WORKER_TTL_MIN: '10' } });
  await h.turn();
  assert.deepEqual(h.sleeps, [8 * 60_000], '30-min slow work capped to the 10−2 min margin');
  assert.equal(h.enqueued[0].outcome.status, 'done', 'the report still enqueues (late → stale-lease orphan on the conductor)');
});

test('routing: mock hang — the marker → NO report, sleep capped, exit 0 (the lease deadline is the handler)', async () => {
  const h = makeHarness({ cp: legacyCp({ behavior: 'hang' }), env: { WORKER_TTL_MIN: '6' } });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(r.reported, false);
  assert.equal(h.enqueued.length, 0);
  assert.deepEqual(h.sleeps, [4 * 60_000], '24h hang capped to TTL−2');
  assert.ok(h.logs.some(l => l.includes('WORKER-SILENT')));
  // the legacy name maps to the same silent class
  const h2 = makeHarness({ cp: legacyCp({ behavior: 'no-report', work_ms: 50 }) });
  const r2 = await h2.turn();
  assert.equal(r2.reported, false);
  assert.equal(h2.enqueued.length, 0);
});

test('routing: mock dup-report — the SAME payload enqueued twice (same attempt-scoped event_id)', async () => {
  const h = makeHarness({ cp: legacyCp({ behavior: 'dup', work_ms: 5 }) });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.enqueued.length, 2, 'two enqueues');
  assert.deepEqual(h.enqueued[0], h.enqueued[1], 'byte-identical payloads — the drain must dedup');
  assert.equal(h.enqueued[0].event_id, 'rep-99881-a1');
  assert.ok(h.sleeps.includes(1500), 'the deliberate gap between the duplicate posts');
  assert.ok(h.logs.some(l => l.includes('WORKER-REPORT-DUP')));
});

test('routing: mock legacy vocabulary — succeed/flaky/poison/fail/infra flow through the shim unmodified', async () => {
  const cases = [
    ['succeed', 'done'], ['flaky', 'work_failed'], ['poison', 'work_failed'],
    ['fail', 'work_failed'], ['infra', 'infra_failed'],
  ];
  for (const [behavior, status] of cases) {
    const h = makeHarness({ cp: legacyCp({ behavior, work_ms: 5 }) });
    const r = await h.turn();
    assert.equal(r.exitCode, 0, `${behavior}: handled turn exits 0`);
    assert.equal(h.enqueued[0].outcome.status, status, `${behavior} → ${status} (the CONTRACT vocabulary)`);
  }
});

test('routing: determinism through the whole turn — same run+attempt → byte-identical outcome', async () => {
  const mk = () => { const h = makeHarness({ cp: legacyCp({ behavior: 'fast' }) }); return h.turn().then(() => h); };
  const h1 = await mk(); const h2 = await mk();
  assert.equal(JSON.stringify(h1.enqueued[0].outcome), JSON.stringify(h2.enqueued[0].outcome));
  assert.equal(seedFromRunId('99881', '1'), seedFromRunId('99881', '1'), 'the seed is run+attempt scoped');
});

// ---------------------------------------------------------------------------
// MODE=cc — the REAL adapter through the routing (T46/W4: the stub is dead;
// these drive worker/cc-adapter.mjs in CC_FAKE_LLM mode — zero network, zero
// npm install; the adapter suite covers the spawn boundary in depth).
// ---------------------------------------------------------------------------

const ccEnv = () => ({
  CC_FAKE_LLM: '1',
  OPENROUTER_API_KEY: 'routing-key-1',
  OPENROUTER_API_KEY_2: 'routing-key-2',
});

test('routing: MODE=cc (fake lane) — the adapter completes through the full turn: done + transcript + telemetry', async () => {
  const h = makeHarness({ cp: legacyCp({ mode: 'cc', behavior: 'fast' }), env: ccEnv() });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(r.reported, true);
  const rep = h.enqueued[0];
  assert.equal(rep.outcome.status, 'done', 'the fake CLI answers → content → done');
  assert.match(rep.outcome.artifact, /fake-cc ok: completed the task on deepseek\/deepseek-v4\.1-flash/);
  assert.equal(rep.outcome.telemetry.lane_attempts_used, 1);
  assert.equal(rep.outcome.telemetry.lanes?.[0]?.key_index, 1);
  assert.deepEqual(rep.outcome.models, ['deepseek/deepseek-v4.1-flash']);
  assert.equal(h.sleeps.length, 0, 'the cc lane enforces its OWN wall — no worker-side sleep');
  assert.ok(!h.fetches.length, 'zero network through the whole turn');
});

test('routing: MODE=cc (fake lane) — the deadline kill self-reports deadline (the process-group reaper)', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'cc', behavior: 'fast', deadline_ms: NOW + 400, budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 }, prompt: '[fixture:sleep-ms=40000] park' }),
    env: ccEnv(),
  });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.enqueued[0].outcome.status, 'deadline');
  assert.equal(h.enqueued[0].outcome.error, 'wall-budget-exceeded');
});

test('routing: W2 payload with mode=cc — the epoch-mode lane reaches the adapter (done, fake mode)', async () => {
  const h = makeHarness({ cp: { ...w2Payload({}, { mode: 'cc' }) }, env: ccEnv() });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(r.reported, true);
  assert.equal(h.enqueued[0].outcome.status, 'done');
  assert.match(h.enqueued[0].outcome.artifact, /fake-cc ok/);
  // the W2-minted prompt (title + quoted brief) is what the CLI received
  assert.ok(h.enqueued[0].outcome.telemetry.lanes?.length >= 1);
});

// T46/W-D review fold (A3, lens-1 F4) — the lane_stats GLUE pin: the attach
// chain runTurn(laneLogPath) -> ccTurn opts -> collectLaneStats at finalize
// -> composeReportOutcome's allowlist -> the ENQUEUED outcome was unpinned
// (the "seam pin injects a pre-written bridge-lane JSONL" the code comment
// promised did not exist — a dropped option or a finalize refactor anywhere
// in the middle passed every pure pin and silently killed the D4 fold).
// FIXTURE-DRIVEN by design: a pre-written bridge-lane JSONL at the seam path,
// no spawned bridge (the bridge env wiring is the companion pin in
// tests/test-cc-bridge.mjs).
test('routing: MODE=cc laneLogPath glue — a pre-written bridge-lane JSONL becomes outcome.lane_stats (the aggregation attach)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wd-fold-glue-'));
  try {
    const laneLog = join(scratch, 'bridge-lane.jsonl');
    writeFileSync(laneLog, [
      JSON.stringify({ ts: '2026-09-16T12:00:00Z', model: 'test/lane-model:free', status: 200, ms: 100, tokens_in: 7, tokens_out: 3, cost: 0.0002, rate_class: '', err_code: null }),
      JSON.stringify({ ts: '2026-09-16T12:00:01Z', model: 'test/lane-model:free', status: 429, ms: 50, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: 'openrouter_free_tier_daily', err_code: 429 }),
    ].join('\n') + '\n');
    const h = makeHarness({ cp: legacyCp({ mode: 'cc', behavior: 'fast' }), env: ccEnv() });
    const r = await h.turn({ laneLogPath: laneLog });
    assert.equal(r.exitCode, 0);
    assert.equal(r.reported, true);
    assert.equal(h.enqueued[0].outcome.status, 'done', 'the fake CLI answers (the lane stats ride a DONE report — the allowlist path)');
    const ls = h.enqueued[0].outcome.lane_stats;
    assert.ok(ls && typeof ls === 'object' && !Array.isArray(ls), 'the aggregated lane_stats rides the enqueued outcome');
    assert.equal(ls.calls, 2, 'both fixture lines counted');
    assert.equal(ls.ok, 1);
    assert.equal(ls.err429, 1);
    assert.equal(ls.p50_ms, 100, 'p50 over the sorted per-call ms [50,100] -> index 1 = 100');
    assert.equal(ls.tokens, 10, 'usage summed (7+3)');
    assert.equal(ls.rate_classes.openrouter_free_tier_daily, 1, 'the 429 limit-source class histogrammed');
    assert.equal(existsSync(laneLog), false, 'the fixture was CONSUMED (collectLaneStats: read -> aggregate -> delete)');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MODE=real — the env-driven model chain with ONE fallback hop.
// ---------------------------------------------------------------------------

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okBody = (text) => ({ choices: [{ message: { content: text } }] });
const models = (fetches) => fetches.map(([, init]) => JSON.parse(init.body).model);

test('routing: real chain — D1: nemotron-3.5 leads, dots-studio/nemotron-3-ultra demoted OUT; the free defaults lead', () => {
  assert.deepEqual(realModelChain({}), ['nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-v4-flash-0731:free', 'cohere/north-mini-code:free']);
  assert.deepEqual(realModelChain({ OPENROUTER_MODEL: '' }), realModelChain({}), 'empty env model = absent');
  assert.deepEqual(realModelChain({ OPENROUTER_MODEL: ' x/y ' })[0], 'x/y', 'env model heads the chain (trimmed)');
  assert.ok(!JSON.stringify(realModelChain({})).includes('minimax'), 'the retired slug stays dead');
  assert.ok(!JSON.stringify(realModelChain({})).includes('dots-studio'), 'D1: dots-studio demoted OUT — 0% content at the production shape');
  assert.ok(!JSON.stringify(realModelChain({})).includes('nemotron-3-ultra'), 'D1: nemotron-3-ultra demoted to never — p95 32s + 30s burst walls');
});

test('routing: real fallback — primary 429 → ONE hop → the fallback model completes', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real', behavior: null }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async (url, init) => JSON.parse(init.body).model.includes('nemotron')
      ? jsonRes(429, { error: { message: 'rate limited' } })
      : jsonRes(200, okBody('the fallback answer')),
  });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.enqueued[0].outcome.status, 'done');
  assert.equal(h.enqueued[0].outcome.artifact, 'the fallback answer');
  assert.deepEqual(models(h.fetches), ['nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-v4-flash-0731:free'], 'exactly one hop');
  assert.deepEqual(h.enqueued[0].outcome.models, ['nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-v4-flash-0731:free']);
  assert.equal(h.enqueued[0].outcome.telemetry.lane_attempts_used, 2);
});

test('routing: real fallback — OPENROUTER_MODEL heads the chain and is hopped past on infra failure', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real' }),
    env: { OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'custom/model-x' },
    fetchImpl: async (url, init) => JSON.parse(init.body).model === 'custom/model-x'
      ? jsonRes(503, {})
      : jsonRes(200, okBody('after the custom lane')),
  });
  await h.turn();
  assert.deepEqual(models(h.fetches), ['custom/model-x', 'nvidia/nemotron-3.5-lightning:free']);
  assert.equal(h.enqueued[0].outcome.status, 'done');
});

test('routing: real all-lanes-dead — infra_failed \'lane-exhausted\' after the hop', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real' }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async () => jsonRes(429, {}),
  });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.enqueued[0].outcome.status, 'infra_failed');
  assert.match(h.enqueued[0].outcome.error, /lane-exhausted\(2\/3 lanes, last lane-429\)/);
  assert.equal(models(h.fetches).length, 2);
});

test('routing: real lane_attempts=1 — NO hop (the lane budget bounds the chain)', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real', budget: { lane_attempts: 1 } }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async () => jsonRes(429, {}),
  });
  await h.turn();
  assert.equal(models(h.fetches).length, 1, 'lane_attempts 1 = the primary only');
  assert.match(h.enqueued[0].outcome.error, /lane-exhausted\(1\/3 lanes, last lane-429\)/);
});

test('routing: real transport throw on the primary → infra hop → done', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real' }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async (url, init) => {
      if (JSON.parse(init.body).model.includes('nemotron')) throw Object.assign(new Error('fetch failed'), { name: 'TimeoutError' });
      return jsonRes(200, okBody('post-transport'));
    },
  });
  await h.turn();
  assert.equal(h.enqueued[0].outcome.status, 'done');
  assert.equal(models(h.fetches).length, 2);
});

test('routing: real empty completion — work_failed, NO hop (the lane answered)', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real' }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async () => jsonRes(200, { choices: [{ message: { content: null } }] }),
  });
  await h.turn();
  assert.equal(models(h.fetches).length, 1);
  assert.equal(h.enqueued[0].outcome.status, 'work_failed');
  assert.equal(h.enqueued[0].outcome.error, 'empty-completion');
});

test('routing: real deterministic 4xx — work_failed (the F-F split; no hop)', async () => {
  const h = makeHarness({
    cp: legacyCp({ mode: 'real' }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async () => jsonRes(400, {}),
  });
  await h.turn();
  assert.equal(models(h.fetches).length, 1);
  assert.equal(h.enqueued[0].outcome.status, 'work_failed');
  assert.equal(h.enqueued[0].outcome.error, 'error-400');
});

test('routing: realWork is directly drivable (the lane chain, no full turn)', async () => {
  const env = { task_ref: { kind: 'state-task', id: 'T1' }, prompt: 'p', deadline_ms: NOW + 600_000, session: 's', budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 }, mode: 'real', attempt: 1 };
  const fetches = [];
  const raw = await realWork(env, {
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async (u, init) => { fetches.push(JSON.parse(init.body).model); return jsonRes(200, okBody('direct')); },
  });
  assert.equal(raw.content, 'direct');
  assert.deepEqual(fetches, ['nvidia/nemotron-3.5-lightning:free']);
});

test('routing: real max_tokens — D1: the completion budget is 512 (the seam: the request body the fetch receives)', async () => {
  // 64 starved every reasoning-style model (content:null → work_failed
  // 'empty-completion' churn that LOOKED like model failure but was a budget
  // artifact); 512 is the measured 100%-content shape on the new chain.
  const h = makeHarness({
    cp: legacyCp({ mode: 'real', behavior: null }),
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async () => jsonRes(200, okBody('done at the 512 budget')),
  });
  await h.turn();
  assert.equal(h.fetches.length, 1);
  const body = JSON.parse(h.fetches[0][1].body);
  assert.equal(body.max_tokens, 512, 'the request body carries the 512 completion budget');
  assert.equal(body.model, 'nvidia/nemotron-3.5-lightning:free');
});

test('routing: real hop_telemetry — per-hop {model, ms, status} on the two-hop fixture (429 → 200; D4-G5 real-lane half)', async () => {
  const env = { task_ref: { kind: 'state-task', id: 'T1' }, prompt: 'p', deadline_ms: NOW + 600_000, session: 's', budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 }, mode: 'real', attempt: 1 };
  const raw = await realWork(env, {
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async (u, init) => JSON.parse(init.body).model.includes('nemotron')
      ? jsonRes(429, { error: { message: 'rate limited' } })
      : jsonRes(200, okBody('telemetry after the hop')),
  });
  assert.equal(raw.content, 'telemetry after the hop');
  assert.deepEqual(raw.models, ['nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-v4-flash-0731:free']);
  assert.ok(Array.isArray(raw.hop_telemetry), 'the optional per-hop field rides the raw lane return');
  assert.equal(raw.hop_telemetry.length, 2, 'one entry per attempted hop');
  const [hop1, hop2] = raw.hop_telemetry;
  assert.deepEqual(Object.keys(hop1).sort(), ['model', 'ms', 'status'], 'the minimal G5 shape');
  assert.equal(hop1.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(hop1.status, 429, 'the first hop carries the lane answer that triggered the hop');
  assert.ok(Number.isFinite(hop1.ms) && hop1.ms >= 0, 'the hop wall is a finite ms');
  assert.equal(hop2.model, 'deepseek/deepseek-v4-flash-0731:free');
  assert.equal(hop2.status, 200);
  assert.ok(Number.isFinite(hop2.ms) && hop2.ms >= 0);
});

test('routing: real hop_telemetry — the transport hop records status \'transport\'', async () => {
  const env = { task_ref: { kind: 'state-task', id: 'T1' }, prompt: 'p', deadline_ms: NOW + 600_000, session: 's', budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 }, mode: 'real', attempt: 1 };
  const raw = await realWork(env, {
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async (u, init) => {
      if (JSON.parse(init.body).model.includes('nemotron')) throw Object.assign(new Error('fetch failed'), { name: 'TimeoutError' });
      return jsonRes(200, okBody('after transport'));
    },
  });
  assert.equal(raw.content, 'after transport');
  assert.equal(raw.hop_telemetry.length, 2);
  assert.equal(raw.hop_telemetry[0].status, 'transport', 'a thrown fetch records the transport class, not a number');
  assert.equal(raw.hop_telemetry[1].status, 200);
});

// ---------------------------------------------------------------------------
// The five-class round trip + the write-back door, through the FULL turn.
// ---------------------------------------------------------------------------

test('routing: FIVE-CLASS round trip — the shim behaviors through runTurn → classified report outcomes', async () => {
  const cases = [
    ['fast', 'done'], ['slow', 'done'], ['poison', 'work_failed'],
    ['infra-flaky', 'infra_failed'], ['deadline', 'deadline'],
  ];
  for (const [behavior, status] of cases) {
    const h = makeHarness({ cp: legacyCp({ behavior, work_ms: 1 }) });
    await h.turn();
    assert.equal(h.enqueued[0].outcome.status, status, `${behavior} → ${status}`);
  }
});

test('routing: wb-violation — the door flips the done to POISON (the governance), evidence preserved', async () => {
  const h = makeHarness({ cp: legacyCp({ behavior: 'wb-violation', work_ms: 1 }) });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  const rep = h.enqueued[0];
  assert.equal(rep.outcome.status, 'poison', 'the door is the governance — terminal quarantine');
  assert.match(rep.outcome.error, /write-back-door\(.*deny-dotgit\(\.github\/workflows\/evil\.yml\)/);
  assert.match(rep.outcome.error, /root-not-declared\(evil\.txt\)/);
  assert.ok(rep.outcome.artifact_refs.includes('.github/workflows/evil.yml'), 'the evidence rides the report');
  assert.ok(rep.outcome.telemetry, 'telemetry preserved for the audit');
});

test('routing: wb-violation with the root file DECLARED — only the dotgit violation remains (declaring does not unlock the denied)', async () => {
  const h = makeHarness({ cp: legacyCp({ behavior: 'wb-violation', work_ms: 1, artifacts: ['evil.txt'] }) });
  await h.turn();
  const rep = h.enqueued[0];
  assert.equal(rep.outcome.status, 'poison');
  assert.match(rep.outcome.error, /deny-dotgit/);
  assert.doesNotMatch(rep.outcome.error, /root-not-declared/);
});

// ---------------------------------------------------------------------------
// The enqueue-failure hardening (the visible-waste doctrine).
// ---------------------------------------------------------------------------

test('routing: enqueue failure — retry ONCE, then the run-conclusion step summary, exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-w3-'));
  try {
    const summaryPath = join(dir, 'summary.md');
    const h = makeHarness({ cp: legacyCp({ behavior: 'fast', work_ms: 1 }), enqueueResult: { ok: false, err: 'boom' } });
    const r = await h.turn({ stepSummaryPath: summaryPath });
    assert.equal(r.exitCode, 2, 'the failed enqueue is a FAILED run (L0 visibility)');
    assert.equal(h.enqueued.length, 2, 'the worker-level retry: exactly one more attempt');
    assert.ok(h.sleeps.includes(1000), 'a beat between the retries');
    const summary = readFileSync(summaryPath, 'utf8');
    assert.ok(summary.includes('rep-99881-a1'), 'the payload identity is in the conclusion');
    assert.ok(summary.includes('`A3`'), 'the task is in the conclusion');
    assert.ok(/re-run THIS worker/.test(summary), 'the re-run contract pointer');
    assert.ok(h.logs.some(l => l.includes('WORKER-ENQUEUE-FAILED') && l.includes('stepSummary=written')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routing: enqueue transient failure — the retry lands, exit 0, no conclusion written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-w3-'));
  try {
    let n = 0;
    const h = makeHarness({ cp: legacyCp({ behavior: 'fast', work_ms: 1 }) });
    const r = await runTurn({
      cp: h.cp ?? legacyCp({ behavior: 'fast', work_ms: 1 }), runId: '99881', runAttempt: '1', env: {},
      fetchImpl: async () => { throw new Error('no fetch expected'); },
      enqueue: async (report) => { n++; return n === 1 ? { ok: false, err: 'transient' } : { ok: true }; },
      sleepImpl: async () => {}, now: () => NOW, log: () => {},
      stepSummaryPath: join(dir, 'summary.md'),
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.reported, true);
    assert.equal(n, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routing: late-start with a failing enqueue — the conclusion lane still fires (exit 2: the report is the whole point)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-w3-'));
  try {
    const h = makeHarness({ cp: legacyCp({ expires: iso(NOW - 60_000) }), enqueueResult: { ok: false, err: 'down' } });
    const r = await h.turn({ stepSummaryPath: join(dir, 's.md') });
    assert.equal(r.exitCode, 2);
    assert.ok(h.sleeps.every(s => s === 1000), `no work sleep — only the enqueue-retry beats: ${h.sleeps}`);
    assert.ok(!h.logs.some(l => l.includes('WORKER-DONE')), 'zero work performed');
    assert.ok(readFileSync(join(dir, 's.md'), 'utf8').includes('late-start') || h.logs.some(l => l.includes('WORKER-GATE-REJECT')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The knob surface.
// ---------------------------------------------------------------------------

test('routing: sleepCapMs — the F-G(a) TTL−2min arithmetic', () => {
  assert.equal(sleepCapMs({}), 18 * 60_000);
  assert.equal(sleepCapMs({ WORKER_TTL_MIN: '8' }), 6 * 60_000);
  assert.equal(sleepCapMs({ WORKER_TTL_MIN: '1' }), 0, 'a sub-margin TTL caps at 0 (no sleep at all)');
  assert.equal(sleepCapMs({ WORKER_TTL_MIN: 'garbage' }), 18 * 60_000, 'the 20-min default on garbage');
});

// ---------------------------------------------------------------------------
// The W2 cross-wave seam — assembleDispatchPayload's FULL payload through the
// worker. The conductor (T46/W2) now mints prompt/deadline_ms/mode/session/
// budget on every ASSIGN dispatch as a legacy-superset client_payload; THIS
// worker consumes exactly that shape. The routing tests above pin the
// legacy-minimal lane; these pin the live W-B dispatch lane end-to-end.
// ---------------------------------------------------------------------------

import { assembleDispatchPayload } from '../lib/conductor-core.mjs';

// the live DISPATCH_WORKER action shape (lib/conductor-core.mjs's clock pass)
// + the task record it points at — exactly what conductor/turn.mjs feeds
// assembleDispatchPayload on a real ASSIGN.
const w2Payload = (over = {}, opts = {}) => assembleDispatchPayload(
  {
    type: 'DISPATCH_WORKER', task: 'A3', lease: 'l-w2envelope01', behavior: 'succeed',
    attempt: 1, work_ms: 6000, expires: iso(NOW + 15 * 60_000), chain: 'c-w2',
    task_ref: { kind: 'state-task', id: 'A3' },
    ...over.action,
  },
  { id: 'A3', title: 'Reconcile the frobnicator ledger', spec: { unit: 'ledger' }, ...over.task },
  '# project brief\nShip the contract.',
  { nowMs: NOW, mode: 'mock', ...over.opts, ...opts },
);

test('routing: W2 payload → the full envelope flows — prompt/deadline/budget/session/mode consumed, done reported', async () => {
  const h = makeHarness({ cp: { ...w2Payload(), behavior: 'fast', work_ms: 10 } });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(r.reported, true);
  const rep = h.enqueued[0];
  assert.equal(rep.task, 'A3');
  assert.equal(rep.lease, 'l-w2envelope01', 'the lease token rides the report (the validity claim)');
  assert.equal(rep.outcome.status, 'done');
  assert.equal(rep.outcome.artifact_refs.every(p => p.startsWith('tasks/A3/')), true, 'the shim namespaces by the payload task');
  assert.deepEqual(h.sleeps, [10], 'work_ms from the W2 payload drives the mock lane wall');
});

test('routing: W2 payload, delayed start — the minted deadline passes while the job sits in queue → LAW-1 late-start', async () => {
  // W2 mints deadline_ms AT DISPATCH (min(lease, dispatch+TTL) − margin, NO
  // floor); a dispatch delayed past that deadline is the guaranteed-orphan
  // class — the gate must fire without burning the lease
  const h = makeHarness({ cp: w2Payload() });   // deadline = NOW + 13min
  const r = await h.turn({ now: () => NOW + 14 * 60_000 });   // started 14min late
  assert.equal(r.exitCode, 0);
  assert.equal(r.reported, true);
  assert.equal(h.sleeps.length, 0, 'no work');
  assert.equal(h.enqueued[0].outcome.status, 'infra_failed');
  assert.equal(h.enqueued[0].outcome.error, 'late-start');
});

test('routing: W2 near-expired lease — deadline minted in the past BY DESIGN (no floor) → the gate, not a doomed work turn', async () => {
  // the W2 complement of test-w2-conductor's no-floor pin: a lease inside
  // the margin mints a PAST deadline; the worker side answers late-start
  const h = makeHarness({ cp: w2Payload({ action: { expires: iso(NOW + 60_000) } }) });
  const r = await h.turn();
  assert.equal(r.exitCode, 0);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.enqueued[0].outcome.status, 'infra_failed');
  assert.equal(h.enqueued[0].outcome.error, 'late-start');
});

test('routing: W2 payload with mode=cc — the envelope budget bounds the lane chain (lane_attempts rides the dispatch into the adapter)', async () => {
  // the fixture marker rides the OX envelope (the X21 10-property shape:
  // the envelope wins over top-level fields at the gate)
  const base = w2Payload({}, { mode: 'cc' });
  const ox = JSON.parse(base.ox);
  ox.prompt = '[fixture:429] always-rate-limited';
  const h = makeHarness({
    cp: { ...base, ox: JSON.stringify(ox) },
    env: ccEnv(),
  });
  await h.turn();
  const rep = h.enqueued[0];
  assert.equal(rep.outcome.status, 'infra_failed', 'every lane answered 429-text-as-answer → infra hop, hop, exhausted');
  assert.equal(rep.outcome.telemetry.lane_attempts_used, 3, 'W2 mints lane_attempts:3 — exactly three fake spawns');
  assert.match(rep.outcome.error, /lane-exhausted\(3\/6 lanes/);
  assert.equal(rep.outcome.telemetry.lanes?.[2]?.model, 'nvidia/nemotron-3.5-lightning:free', 'key-major flatten: three models on key 1');
});

test('routing: W2 payload with mode=real — the envelope budget bounds the lane chain (lane_attempts rides the dispatch)', async () => {
  const h = makeHarness({
    cp: { ...w2Payload({ action: { behavior: 'work' } }, { mode: 'real' }) },
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async () => jsonRes(429, {}),
  });
  await h.turn();
  // W2 mints lane_attempts:3 → the chain tries primary + ONE fallback hop
  assert.equal(models(h.fetches).length, 2);
  assert.equal(h.enqueued[0].outcome.status, 'infra_failed');
  assert.match(h.enqueued[0].outcome.error, /lane-exhausted\(2\/3 lanes, last lane-429\)/);
});
