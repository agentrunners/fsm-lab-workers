// test-harness-shim.mjs — the W-B SHIM suite (T46 §1b / §1g).
// Pins sim/harness-shim.mjs — the deterministic contract implementer (the
// conformance reference the W4 CC adapter must match, C3 folded per D1):
//   - the DETERMINISM LAW: same (envelope, behavior, seed) → byte-identical
//     return (JSON.stringify equality — the conformance suite's foundation)
//   - every seeded behavior's status / artifact_refs / summary / telemetry
//     shape against the contract vocabulary (classifyOutcome's five classes,
//     plus the sanctioned 'hang' marker)
//   - the wb-violation's ILLEGAL refs, enumerated so W4's door-exercise can
//     assert them verbatim (deny-dotgit + root-not-declared through
//     writeBackDoor)
//   - the legacy vocabulary aliases (live mock-lane semantics preserved)
//   - seedFromRunId (the worker's seed derivation — reproducible re-runs)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shimInvoke, seedFromRunId, mulberry32,
  SHIM_BEHAVIORS, LEGACY_BEHAVIORS,
} from '../sim/harness-shim.mjs';
import { classifyOutcome, writeBackDoor, OUTCOME_CLASSES } from '../lib/worker-contract.mjs';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const ENV = {  // an OK envelope (envelopeFromDispatch's output shape)
  task_ref: { kind: 'state-task', id: 'T42' },
  prompt: 'Refactor the frobnicator',
  deadline_ms: NOW + 600_000,
  session: 'c-1/T42/run-9-a1',
  budget: { max_turns: 12, wall_ms: 480_000, lane_attempts: 3 },
  mode: 'mock',
  attempt: 1,
};
const envWith = (over = {}) => ({ ...ENV, ...over });

// ---------------------------------------------------------------------------
// The determinism law.
// ---------------------------------------------------------------------------

test('shim: DETERMINISM — same (envelope, behavior, seed) → byte-identical return, every behavior', () => {
  for (const b of [...SHIM_BEHAVIORS, ...LEGACY_BEHAVIORS]) {
    const a = shimInvoke(ENV, b, 1234);
    const c = shimInvoke(ENV, b, 1234);
    assert.equal(JSON.stringify(a), JSON.stringify(c), `${b}: byte-identical across calls`);
    // a FRESH envelope object with identical fields is the same input (no
    // hidden object identity in the derivation)
    const d = shimInvoke(envWith(), b, 1234);
    assert.equal(JSON.stringify(d), JSON.stringify(a), `${b}: envelope deep-equal, not identity`);
  }
});

test('shim: seed is the ONLY randomness — different seeds observably differ', () => {
  const outs = new Set();
  for (let s = 0; s < 16; s++) outs.add(JSON.stringify(shimInvoke(ENV, 'fast', s)));
  assert.ok(outs.size >= 8, `16 seeds produced ${outs.size} distinct fast returns — the artifact suffix/turns must track the seed`);
});

test('shim: deterministic under repeated rng draws — mulberry32 is pure (same seed, same stream)', () => {
  const r1 = mulberry32(99), r2 = mulberry32(99);
  const s1 = [r1(), r1(), r1()], s2 = [r2(), r2(), r2()];
  assert.deepEqual(s1, s2);
});

test('shim: seedFromRunId — deterministic, run-scoped, uint32', () => {
  assert.equal(seedFromRunId('123', '2'), seedFromRunId('123', '2'));
  assert.notEqual(seedFromRunId('123', '1'), seedFromRunId('123', '2'), 'attempt-scoped');
  assert.notEqual(seedFromRunId('123', '1'), seedFromRunId('124', '1'), 'run-scoped');
  assert.equal(seedFromRunId(null, null), seedFromRunId(null, null));
  for (const [rid, att] of [['1', '1'], ['local', '9'], ['99001122', '3']]) {
    const s = seedFromRunId(rid, att);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xFFFF_FFFF, `uint32 for ${rid}:${att} -> ${s}`);
  }
});

// ---------------------------------------------------------------------------
// The contract-return shape, per behavior.
// ---------------------------------------------------------------------------

const isTelemetry = (t) => Number.isInteger(t.turns) && t.turns >= 0
  && Number.isInteger(t.wall_ms) && t.wall_ms >= 0
  && Number.isInteger(t.lane_attempts_used) && t.lane_attempts_used >= 0;

test('shim: fast — done, quick, legal task-namespace artifacts', () => {
  const r = shimInvoke(ENV, 'fast', 7);
  assert.equal(r.status, 'done');
  assert.ok(Array.isArray(r.artifact_refs) && r.artifact_refs.length === 1);
  assert.ok(r.artifact_refs.every(p => p.startsWith('tasks/T42/')), `legal paths: ${r.artifact_refs}`);
  assert.equal(typeof r.summary, 'string');
  assert.ok(isTelemetry(r.telemetry));
  assert.ok(r.telemetry.turns >= 1 && r.telemetry.turns <= ENV.budget.max_turns);
  assert.equal(r.telemetry.lane_attempts_used, 1);
  assert.ok(r.telemetry.wall_ms < ENV.budget.wall_ms, 'fast finishes inside the window');
});

test('shim: fast — workMs rides the wall (the live work_ms knob)', () => {
  assert.equal(shimInvoke(ENV, 'fast', 7, { workMs: 6000 }).telemetry.wall_ms, 6000);
  assert.equal(shimInvoke(ENV, 'succeed', 7, { workMs: 123 }).telemetry.wall_ms, 123);
  assert.equal(shimInvoke(ENV, 'fast', 7).telemetry.wall_ms, 5000, 'default = the live 5000');
});

test('shim: slow — done but PAST the envelope window (the late-report class)', () => {
  const r = shimInvoke(ENV, 'slow', 7);
  assert.equal(r.status, 'done');
  assert.ok(r.telemetry.wall_ms > ENV.budget.wall_ms, `wall ${r.telemetry.wall_ms} > budget ${ENV.budget.wall_ms}`);
  // the legacy 30-min floor: even a generous window does not shrink slow
  assert.ok(r.telemetry.wall_ms >= 1_800_000);
});

test('shim: poison — work_failed EVERY attempt (the CONTRACT vocabulary, not legacy \'failed\')', () => {
  for (const attempt of [1, 2, 3]) {
    const r = shimInvoke(envWith({ attempt }), 'poison', 7);
    assert.equal(r.status, 'work_failed', `attempt ${attempt}`);
    assert.equal(r.detail, 'poison-always');
    assert.deepEqual(r.artifact_refs, []);
  }
});

test('shim: infra-flaky — infra_failed at attempt 1 (lanes burned), done at 2+', () => {
  const fail = shimInvoke(envWith({ attempt: 1 }), 'infra-flaky', 7);
  assert.equal(fail.status, 'infra_failed');
  assert.equal(fail.detail, 'lane-429');
  assert.equal(fail.telemetry.lane_attempts_used, ENV.budget.lane_attempts, 'the whole lane budget burned');
  const ok = shimInvoke(envWith({ attempt: 2 }), 'infra-flaky', 7);
  assert.equal(ok.status, 'done');
  assert.equal(ok.telemetry.lane_attempts_used, 1, 'the rotated lane answers first try');
});

test('shim: deadline — SELF-REPORTED at the wall budget', () => {
  const r = shimInvoke(ENV, 'deadline', 7);
  assert.equal(r.status, 'deadline');
  assert.equal(r.detail, 'wall-budget-exceeded');
  assert.ok(r.telemetry.wall_ms > ENV.budget.wall_ms, 'the wall was exceeded');
  assert.equal(r.telemetry.turns, ENV.budget.max_turns, 'the turn cap hit');
});

test('shim: hang — the marker by default (NOT one of the five classes, by design)', () => {
  const r = shimInvoke(ENV, 'hang', 7);
  assert.equal(r.status, 'hang');
  assert.ok(!OUTCOME_CLASSES.includes(r.status), 'the marker must be handled BEFORE classification');
  assert.equal(r.telemetry.wall_ms, 86_400_000, 'the 24h kill window (live parity)');
});

test('shim: hang + deadlineEnforced — the SAME turn returns deadline (the wall-enforcing harness)', () => {
  const r = shimInvoke(ENV, 'hang', 7, { deadlineEnforced: true });
  assert.equal(r.status, 'deadline');
  assert.equal(r.detail, 'wall-budget-exceeded');
  assert.ok(r.telemetry.wall_ms > ENV.budget.wall_ms);
});

test('shim: dup-report — done + the repeat_report marker (same event_id twice)', () => {
  const r = shimInvoke(ENV, 'dup-report', 7);
  assert.equal(r.status, 'done');
  assert.equal(r.repeat_report, true, 'the caller enqueues the same payload twice');
  // the marker is deterministic too
  assert.equal(shimInvoke(ENV, 'dup-report', 7).repeat_report, true);
});

test('shim: wb-violation — done + the ILLEGAL refs ENUMERATED (W4\'s door-exercise asserts these)', () => {
  const r = shimInvoke(ENV, 'wb-violation', 7);
  assert.equal(r.status, 'done');
  assert.ok(r.artifact_refs.includes('.github/workflows/evil.yml'), 'the dotgit violation');
  assert.ok(r.artifact_refs.some(p => !p.includes('/')), 'the root-file violation');
  assert.ok(r.artifact_refs.filter(p => p.startsWith('tasks/T42/')).length >= 1, 'plus legal task-namespace paths');
  // the door MUST flag them: the exact violation classes W4 asserts
  const door = writeBackDoor({ branch: 'tasks/T42', paths: r.artifact_refs, allowRoot: [] });
  assert.equal(door.ok, false);
  assert.ok(door.violations.some(v => v.startsWith('deny-dotgit(.github/workflows/evil.yml')), `dotgit denied: ${door.violations}`);
  assert.ok(door.violations.some(v => v.startsWith('root-not-declared(')), `root denied: ${door.violations}`);
  // the LEGAL refs pass when isolated (the door flags exactly the illegal ones)
  const legal = r.artifact_refs.filter(p => p.startsWith('tasks/T42/'));
  assert.equal(writeBackDoor({ branch: 'tasks/T42', paths: legal, allowRoot: [] }).ok, true);
});

// ---------------------------------------------------------------------------
// The five-class round trip — classifyOutcome over the shim's outputs (the
// normalizer the worker applies; the poison class arrives via the door, in
// the routing suite).
// ---------------------------------------------------------------------------

test('shim: FIVE-CLASS round trip — classifyOutcome over every behavior\'s output', () => {
  const expected = {
    fast: 'done', slow: 'done', 'dup-report': 'done', 'wb-violation': 'done',
    poison: 'work_failed', 'infra-flaky': 'infra_failed', deadline: 'deadline',
  };
  for (const [b, cls] of Object.entries(expected)) {
    const raw = shimInvoke(ENV, b, 42);
    const c = classifyOutcome(raw);
    assert.equal(c.status, cls, `${b} → ${cls}`);
    assert.ok(OUTCOME_CLASSES.includes(c.status));
  }
  // failure details ride the passthrough (the report's journal text)
  assert.equal(classifyOutcome(shimInvoke(ENV, 'poison', 42)).detail, 'poison-always');
  assert.equal(classifyOutcome(shimInvoke(ENV, 'infra-flaky', 42)).detail, 'lane-429');
  assert.equal(classifyOutcome(shimInvoke(ENV, 'deadline', 42)).detail, 'wall-budget-exceeded');
});

// ---------------------------------------------------------------------------
// The legacy vocabulary (live mock-lane semantics preserved).
// ---------------------------------------------------------------------------

test('shim: legacy aliases — the live behavior names keep their semantics', () => {
  // succeed → done like fast
  assert.equal(shimInvoke(ENV, 'succeed', 7).status, 'done');
  // flaky → work_failed at 1, done at 2+
  assert.equal(shimInvoke(envWith({ attempt: 1 }), 'flaky', 7).status, 'work_failed');
  assert.equal(shimInvoke(envWith({ attempt: 2 }), 'flaky', 7).status, 'done');
  // fail → work_failed always
  assert.equal(shimInvoke(ENV, 'fail', 7).status, 'work_failed');
  // poison → work_failed every attempt
  assert.equal(shimInvoke(ENV, 'poison', 7).status, 'work_failed');
  // infra → the infra-flaky shape
  assert.equal(shimInvoke(ENV, 'infra', 7).status, 'infra_failed');
  // slow/hang/dup/no-report → their contract behaviors
  assert.ok(shimInvoke(ENV, 'slow', 7).telemetry.wall_ms >= 1_800_000);
  assert.equal(shimInvoke(ENV, 'hang', 7).status, 'hang');
  assert.equal(shimInvoke(ENV, 'no-report', 7).status, 'hang', 'no-report = the silent class');
  assert.equal(shimInvoke(ENV, 'dup', 7).repeat_report, true);
  // the legacy wall caps survive (flaky/fail/poison fail fast)
  assert.ok(shimInvoke(ENV, 'flaky', 7, { workMs: 9000 }).telemetry.wall_ms <= 2000);
  assert.ok(shimInvoke(ENV, 'fail', 7, { workMs: 9000 }).telemetry.wall_ms <= 2000);
});

test('shim: unknown behavior → work_failed \'unknown-behavior(...)\' (the legacy answer: burns the ladder visibly)', () => {
  const r = shimInvoke(ENV, 'typo-name', 7);
  assert.equal(r.status, 'work_failed');
  assert.equal(r.detail, 'unknown-behavior(typo-name)');
  assert.equal(classifyOutcome(r).status, 'work_failed');
});

// ---------------------------------------------------------------------------
// Input contracts (loud, never silent).
// ---------------------------------------------------------------------------

test('shim: envelope shape guards — bad envelopes THROW (never a wrong-task artifact path)', () => {
  assert.throws(() => shimInvoke(null, 'fast', 1), /envelope/);
  assert.throws(() => shimInvoke('nope', 'fast', 1), /envelope/);
  assert.throws(() => shimInvoke({}, 'fast', 1), /task_ref\.id/);
  assert.throws(() => shimInvoke({ task_ref: { kind: 'state-task', id: '' } }, 'fast', 1), /task_ref\.id/);
});

test('shim: budget/attempt lenient reads — the contract defaults when absent', () => {
  const r = shimInvoke({ task_ref: { kind: 'state-task', id: 'X1' } }, 'infra-flaky', 7);
  assert.equal(r.status, 'infra_failed');
  assert.equal(r.telemetry.lane_attempts_used, 3, 'lane_attempts default 3');
  const d = shimInvoke({ task_ref: { kind: 'state-task', id: 'X1' } }, 'deadline', 7);
  assert.equal(d.telemetry.turns, 40, 'max_turns default 40');
  assert.equal(d.telemetry.wall_ms > 60_000, true, 'wall_ms default 60s floor');
});
