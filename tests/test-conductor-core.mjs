// test-conductor-core.mjs — the conductor-turn algorithm suite (node:test).
// Drives the REAL lib/conductor-core.mjs conductorTick (the F15 extraction
// of conductor/turn.mjs's mutate closure) with injected closures — no git,
// no API — and regression-tests every trap door the 44-f review demanded be
// preserved verbatim:
//   - the noop gate on the ACCUMULATED journal (probe 2c: a wake-journal-only
//     gate stalls project completion forever)
//   - the unified reset path (direct reset = prepended control; queued
//     reports drain AFTER the reset, journaled, never silently dropped)
//   - control-first drain ordering; consume-everything semantics
//   - repair-forces-commit (A2) + BOOTSTRAP/RECOVERY notices
//   - invariants() fail-closed pre-commit
//   - the slim genesisSpec on reset records
//   - unparseable-line REJECTED records with the stats counter

import test from 'node:test';
import assert from 'node:assert/strict';
import { genesis, apply, invariants, TERMINAL, rebuild } from '../lib/fsm.mjs';
import { conductorTick, specToTask, specEpoch } from '../lib/conductor-core.mjs';
import { fastProject, nextMilestoneFactory, mockProject } from '../lib/mock-project.mjs';

const T0 = Date.parse('2026-09-06T10:00:00.000Z');
const NM = nextMilestoneFactory(fastProject());
const CFG = { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };

// multi-ts clock: each now() call advances 1ms — the conductor stamps
// SEVERAL ts values per commit (the F15 contract: never collapse to one)
function makeNow(startMs = T0) {
  let t = startMs;
  return { now: () => new Date((t += 1)).toISOString(), get ms() { return t; } };
}
const iso = (ms) => new Date(ms).toISOString();

function boot(config = {}) {
  return genesis({
    config: { ...CFG, ...config },
    project: { tasks: fastProject().m1, milestones: 2 },
    chainId: 'test-cc', now: iso(T0),
  });
}
// the injected makeGenesis: returns {state, spec} like the adapter's
function makeGenesisFor(mp = fastProject()) {
  let n = 0;
  return ({ config } = {}) => {
    const cfg = config || { ...CFG };
    const chainId = `c-test-${++n}`;
    const g = genesis({
      config: cfg, project: { tasks: mp.m1, milestones: mp.milestones ?? 2 },
      chainId, now: iso(T0 + n),
    });
    return { state: g, spec: { tasks: mp.m1, milestones: mp.milestones ?? 2, chainId } };
  };
}
const makeGenesis = makeGenesisFor();
const noRecover = () => null;
const tickEv = (reason = 'chain') => ({ kind: 'TICK', actor: reason, event_id: `tick-${reason}`, ts: iso(T0) });
const ctlEv = (command, extra = {}) => ({ kind: 'CONTROL', command, event_id: `ctl-direct-${command}`, ts: iso(T0), ...extra });

// one task, one milestone — the minimal project for drain-completion tests
const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
function bootOne() {
  return genesis({ config: CFG, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'test-one', now: iso(T0) });
}
function assignOne() {
  // tick the one-task project once: X becomes assigned with a lease
  const s = bootOne();
  const r = apply(s, tickEv('seed'), iso(T0), nextMilestoneFactory(ONE));
  assert.equal(r.state.tasks.X.status, 'assigned');
  return r.state;
}
const reportFor = (state, id, outcome = { status: 'done', artifact: 'a' }) => ({
  kind: 'REPORT', event_id: id, task: 'X', lease: state.tasks.X.lease.token, outcome, run_id: 'run-1',
});

const ok = (s, label) => {
  const v = invariants(s);
  assert.deepEqual(v, [], `invariants after ${label}: ${v.join('; ')}`);
};

// ---------------------------------------------------------------------------

test('held-tick quiesce: paused/halted + empty queues => noop (no journal, no commit material)', () => {
  const clock = makeNow();
  let s = boot();
  s = apply(s, ctlEv('pause'), iso(T0), NM).state;
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'held-paused');
  assert.equal(out.journal, undefined, 'a held wake journals NOTHING');
  // halted variant
  let h = boot();
  h = apply(h, ctlEv('halt'), iso(T0), NM).state;
  const out2 = conductorTick({
    cur: structuredClone(h), queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out2.noop, true);
  assert.equal(out2.reason, 'held-halted');
});

test('NOOP GATE on the ACCUMULATED journal (probe 2c): a drain that completes+halts the chain mid-mutate STILL commits', () => {
  // X is in flight; the queued report finishes the project (PHASE done +
  // STOP_CHAIN). The wake TICK lands AFTER the drain — on the now-halted
  // chain it journals nothing. Gating on the WAKE journal alone would noop
  // and the PHASE/STOP records would never commit (the completion stall).
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [reportFor(s, 'rep-final')], controlQueue: [],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.noop, undefined, 'the accumulated journal must force the commit');
  assert.ok(out.journal.some(j => j.kind === 'REPORT' && j.task === 'X' && j.to === 'done'));
  assert.ok(out.journal.some(j => j.kind === 'PHASE' && j.to === 'done'), 'the completion record lands');
  assert.equal(out.state.project.phase, 'done');
  assert.equal(out.state.chain.halted, true);
  assert.deepEqual(out.queue, [], 'consume-everything: the drained report is gone');
  ok(out.state, 'drain-completes');
});

test('unified reset (direct dispatch): queued reports drain AFTER the reset — journaled rejects, nothing silently dropped', () => {
  // the pre-T44 direct-reset path returned BEFORE the report drain and
  // deleted the queue files unjournaled (44-b P3 hole / F1a amendment)
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const zombies = [0, 1, 2].map(i => ({
    event_id: `rep-zombie-${i}`, task: `GHOST-${i}`, lease: 'tok', outcome: { status: 'done' }, run_id: `r${i}`,
  }));
  const out = conductorTick({
    cur: structuredClone(s), queue: zombies, controlQueue: [],
    ev: ctlEv('reset'), now: clock.now, nextMilestone: NM, recover: noRecover,
    makeGenesis: makeGenesisFor(fastProject()),
  });
  assert.ok(out.message.startsWith('reset'), `message leads with the reset: ${out.message}`);
  const resetRec = out.journal[0];
  assert.equal(resetRec.kind, 'CONTROL');
  assert.equal(resetRec.command, 'reset');
  // the SLIM genesis spec (rebuild() replays it) — T46/W2: + mode (the epoch
  // mode rides the spec for rebuild parity; legacy specs default 'mock')
  const spec = resetRec.genesisSpec;
  assert.deepEqual(Object.keys(spec).sort(), ['chainId', 'config', 'journal_seq', 'milestones', 'mode', 'now', 'tasks']);
  assert.deepEqual(spec.tasks, fastProject().m1);
  assert.equal(spec.milestones, 2);
  assert.equal(spec.journal_seq, s.journal_seq);
  assert.equal(spec.chainId, out.state.chain.id, 'the spec chainId is the new chain');
  // the queued zombies drained AFTER the reset: journaled unknown-task rejects
  const rej = out.journal.filter(j => j.kind === 'REJECTED' && j.reason === 'unknown-task');
  assert.equal(rej.length, 3, 'every queued report is journaled (none silently dropped)');
  assert.deepEqual(rej.map(j => j.event_id), zombies.map(z => z.event_id));
  // journal_seq continuity across the epoch boundary: the reset record starts
  // at the OLD seq and the ids run monotonically to the new state's seq
  const ids = out.journal.map(j => parseInt(j.id.slice(1), 10));
  assert.equal(ids[0], s.journal_seq, 'the reset record id continues the old journal');
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids are strictly increasing across the epoch');
  assert.equal(ids[ids.length - 1] + 1, out.state.journal_seq);
  assert.notEqual(out.state.chain.id, s.chain.id, 'fresh chain after reset');
  // consume-everything semantics
  assert.deepEqual(out.queue, []);
  assert.deepEqual(out.controlQueue, []);
  ok(out.state, 'reset-drain');
});

test('unified reset via the QUEUE (ops path): prepended control, reset record, journal_seq continuity', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [{ cmd: 'reset', id: 'ctl-q-1', ts: iso(T0 + 1000), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: NM, recover: noRecover,
    makeGenesis: makeGenesisFor(fastProject()),
  });
  assert.ok(out.journal.some(j => j.kind === 'CONTROL' && j.command === 'reset'));
  // a QUEUED reset does NOT skip the wake: the tick applies on the fresh chain
  assert.ok(out.journal.some(j => j.kind === 'TICK'));
  assert.equal(out.state.chain.seq, 1, 'the wake tick applied on the new chain');
  assert.notEqual(out.state.chain.id, s.chain.id);
  ok(out.state, 'queued-reset');
});

test('reset ADOPTS the current config (F12 — no hardcoded reset config)', () => {
  const s = boot({ lease_minutes: 9, tick_min_interval_s: 40 });
  const clock = makeNow(T0);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [],
    ev: ctlEv('reset'), now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.journal[0].genesisSpec.config.lease_minutes, 9, 'adopted');
  assert.equal(out.journal[0].genesisSpec.config.tick_min_interval_s, 40, 'adopted (>= the 25s floor)');
  assert.equal(out.state.config.lease_minutes, 9);
  ok(out.state, 'reset-config-adopt');
});

test('repair-forces-commit (A2): a recovered PAUSED state with nothing to do still commits the RECOVERY record', () => {
  // under quiescence a history-walked state must PERSIST or corruption
  // never heals — without repair this turn is a noop (held-paused, no
  // journals) and the healed state.json never lands (red-team probe)
  let good = boot();
  good = apply(good, ctlEv('pause'), iso(T0), NM).state;
  const clock = makeNow(T0 + 5_000);
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: clock.now, nextMilestone: NM,
    recover: () => ({ state: structuredClone(good), reason: 'history-walk' }),
    makeGenesis,
  });
  assert.equal(out.noop, undefined, 'repair forces the commit');
  assert.ok(out.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'history-walk'));
  assert.ok(out.actions.some(a => a.type === 'RECOVERY_NOTICE'));
  assert.equal(out.state.chain.paused, true, 'the recovered state is preserved');
  ok(out.state, 'repair-commit');
});

test('bootstrap: no state, no history => fresh genesis + BOOTSTRAP_NOTICE + RECOVERY(bootstrap)', () => {
  const clock = makeNow(T0);
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('chain'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.noop, undefined);
  assert.ok(out.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'bootstrap'));
  assert.ok(out.actions.some(a => a.type === 'BOOTSTRAP_NOTICE'));
  assert.equal(out.state.chain.seq, 1, 'the wake tick applied on the fresh chain');
  assert.ok(out.journal.some(j => j.kind === 'ASSIGN'), 'the bootstrap turn assigns');
  ok(out.state, 'bootstrap');
});

test('control-first ordering + reports are NOT pause-gated: a queued pause lands BEFORE the report drain, and the report still applies', () => {
  // at-least-once drain: a HELD chain still consumes its report queue; only
  // the wake TICK is a non-event on a held chain
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: [reportFor(s, 'rep-under-pause')],
    controlQueue: [{ cmd: 'pause', id: 'ctl-p-1', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.journal[0].kind, 'CONTROL', 'control queue drains FIRST');
  assert.equal(out.journal[0].command, 'pause');
  assert.equal(out.state.tasks.X.status, 'done', 'the report applied despite the pause');
  assert.equal(out.state.chain.paused, true);
  assert.equal(out.noop, undefined, 'journals exist — this is a real commit');
  ok(out.state, 'pause-report-drain');
});

test('queued resume unpauses BEFORE the wake applies: the tick is a real event again (F2 unpaused-tick case)', () => {
  let s = assignOne();
  s = apply(s, ctlEv('pause'), iso(T0), nextMilestoneFactory(ONE)).state;
  assert.equal(s.chain.paused, true);
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [{ cmd: 'resume', id: 'ctl-r-1', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.journal[0].kind, 'CONTROL');
  assert.equal(out.journal[0].command, 'resume');
  assert.ok(out.journal.some(j => j.kind === 'TICK'), 'the wake tick applied (state was unpaused when apply ran)');
  assert.equal(out.state.chain.paused, false);
  assert.equal(out.state.chain.seq, 2);
  ok(out.state, 'resume-then-tick');
});

test('configure patch passthrough: a queued configure applies + journals patch/before; a bad patch is a consumed reject', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [],
    controlQueue: [{ cmd: 'configure', patch: { max_attempts: 5 }, id: 'ctl-c-1', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.state.config.max_attempts, 5);
  const rec = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'configure');
  assert.deepEqual(rec.patch, { max_attempts: 5 }, 'the patch round-trips');
  assert.deepEqual(rec.before, { max_attempts: 3 }, 'before captured (was 3 in CFG)');
  ok(out.state, 'configure');

  // invalid patch: rejected AND consumed (never re-parked)
  const out2 = conductorTick({
    cur: structuredClone(assignOne()), queue: [],
    controlQueue: [{ cmd: 'configure', patch: { max_parallel: 999 }, id: 'ctl-c-2', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.ok(out2.journal.some(j => j.kind === 'REJECTED' && j.reason.startsWith('bad-patch')));
  assert.deepEqual(out2.controlQueue, [], 'the rejected control is consumed, not re-parked');
  assert.equal(out2.state.config.max_parallel, CFG.max_parallel, 'config untouched by the bad patch');
});

test('unparseable queue/control lines: journaled REJECTED(unparseable) + counted, then dropped by the rewrite', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: [], queueBad: ['{"event_id": "torn line', '###not json at all'],
    controlQueue: [], ctlBad: ['%%%garbage%%%'],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  const rej = out.journal.filter(j => j.kind === 'REJECTED' && j.reason === 'unparseable');
  assert.equal(rej.length, 3, 'queue AND control unparseables journaled');
  assert.deepEqual(rej.map(j => j.origKind).sort(), ['CONTROL', 'REPORT', 'REPORT']);
  assert.ok(rej.every(j => j.applied === false && typeof j.raw === 'string'));
  assert.equal(out.state.stats.rejected_events, 3, 'the stats counter increments (44-h P2c)');
  ok(out.state, 'unparseables');
});

test('invariants fail-closed: a corrupted base state makes the turn THROW pre-commit (never lands)', () => {
  const s = assignOne();
  const bad = structuredClone(s);
  bad.tasks.X.lease = null;            // active-without-lease — a real violation
  bad.tasks.X.status = 'in_progress';
  const clock = makeNow(T0 + 60_000);
  assert.throws(
    () => conductorTick({
      cur: bad, queue: [], controlQueue: [], ev: tickEv('chain'),
      now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
      recover: noRecover, makeGenesis: makeGenesisFor(ONE),
    }),
    /INVARIANT VIOLATION: .*active-without-lease/,
  );
});

test('duplicate wake control is consumed as a duplicate (identity consumed once — F11 discipline)', () => {
  // pause applied earlier in the same chain; the SAME event_id re-delivered
  // through the control queue lands as REJECTED(duplicate), consumed
  let s = boot();
  s = apply(s, ctlEv('pause'), iso(T0), NM).state;
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [],
    controlQueue: [{ cmd: 'pause', id: 'ctl-direct-pause', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  // 'ctl-direct-pause' was consumed by the earlier apply() (same event identity)
  const rej = out.journal.find(j => j.kind === 'REJECTED' && j.event_id === 'ctl-direct-pause');
  assert.equal(rej?.reason, 'duplicate');
  assert.deepEqual(out.controlQueue, [], 'the duplicate control is consumed, not re-parked');
  ok(out.state, 'dup-control');
});

test('drain halt with a duplicate report still commits (accumulated-journal gate, reject variant)', () => {
  // second copy of the report that already finished X: the drain journals a
  // REJECTED(duplicate) — accumulated journal non-empty => commit, even
  // though the wake tick is held (chain halted by the FIRST drain... here X
  // is already done so the wake applies normally; the gate check is the
  // reject-record path). Structural guard: journals.length > 0.
  const s = assignOne();
  const first = conductorTick({
    cur: structuredClone(s), queue: [reportFor(s, 'rep-1')], controlQueue: [],
    ev: tickEv('chain'), now: makeNow(T0 + 60_000).now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(first.state.project.phase, 'done');
  const clock = makeNow(T0 + 120_000);
  const out = conductorTick({
    cur: structuredClone(first.state), queue: [reportFor(s, 'rep-1')], controlQueue: [],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  // held-halted wake + a duplicate reject in the drain => still a commit
  assert.equal(out.noop, undefined);
  assert.ok(out.journal.some(j => j.kind === 'REJECTED' && j.reason === 'duplicate'));
  assert.deepEqual(out.queue, []);
  ok(out.state, 'dup-report-drain');
});

test('now is stamped per-value (multiple ts per commit — the extraction contract)', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [reportFor(s, 'rep-ts')],
    controlQueue: [{ cmd: 'configure', patch: { max_attempts: 5 }, id: 'ctl-ts', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  const ts = out.journal.map(j => j.ts);
  assert.ok(new Set(ts).size >= 2, `journal carries multiple distinct ts values (${new Set(ts).size})`);
  // strictly increasing: each mkJ/apply stamped a fresh now()
  assert.deepEqual(ts, [...ts].sort(), 'ts values are monotonic');
});

// ---------------------------------------------------------------------------
// T45 additions (F-A reconciliation / F-F infra drain).

test('T45/F-A: recovery reconciles journal_seq above the on-branch max id; RECOVERY record carries the sweep audit', () => {
  const clock = makeNow(T0);
  const snap = boot();
  snap.journal_seq = 7;  // a snapshot whose seq sits BELOW the on-branch ids (the rollback shape)
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [],
    ev: tickEv('backstop'), now: clock.now, nextMilestone: NM,
    recover: () => ({ state: snap, reason: 'history-walk', journalMaxId: 9, dropFrom: 7, droppedRecords: 3, snapshotSha: 'deadbeef' }),
    makeGenesis,
  });
  const rec = out.journal.find(j => j.kind === 'RECOVERY');
  assert.ok(rec, 'RECOVERY record present');
  const ids = out.journal.map(j => parseInt(j.id.slice(1), 10));
  assert.equal(ids[0], 10, 'the FIRST record mints ABOVE the on-branch max id (reconciliation before any mkJ)');
  assert.ok(parseInt(rec.id.slice(1), 10) > 9, 'the RECOVERY record mints above the on-branch max id');
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids strictly increasing from the reconciled base');
  assert.equal(rec.reason, 'history-walk');
  assert.equal(rec.dropFrom, 7);
  assert.equal(rec.droppedRecords, 3);
  assert.equal(rec.snapshotSha, 'deadbeef');
  assert.equal(out.journalDropFrom, 7, 'the rollback sweep is armed for store.commit');
  assert.ok(out.state.journal_seq > 9, `journal_seq ${out.state.journal_seq} above the pre-repair on-branch max`);
  assert.ok(out.actions.some(a => a.type === 'RECOVERY_NOTICE'));
  ok(out.state, 'fa-reconcile');
});

test('T45/F-A: bootstrap-on-existing-branch reconciles ids too (no sweep — nothing to restore)', () => {
  const clock = makeNow(T0);
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [],
    ev: tickEv('chain'), now: clock.now, nextMilestone: NM,
    recover: () => ({ state: null, reason: 'bootstrap', journalMaxId: 9 }),
    makeGenesis,
  });
  assert.ok(out.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'bootstrap'));
  assert.ok(out.actions.some(a => a.type === 'BOOTSTRAP_NOTICE'));
  const ids = out.journal.map(j => parseInt(j.id.slice(1), 10));
  assert.equal(Math.min(...ids), 10, 'the first record mints above the leftover journal ids');
  assert.equal(out.journalDropFrom, undefined, 'no sweep on bootstrap');
  ok(out.state, 'fa-bootstrap');
});

test('T45/F-A: repair WITHOUT journalMaxId (legacy recover shape) keeps the old semantics', () => {
  const clock = makeNow(T0);
  const good = boot();
  good.chain.paused = true;  // a quiesced snapshot: held wake, repair-forces-commit
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [],
    ev: tickEv('backstop'), now: clock.now, nextMilestone: NM,
    recover: () => ({ state: good, reason: 'history-walk' }),
    makeGenesis,
  });
  assert.equal(out.journalDropFrom, undefined);
  const rec = out.journal.find(j => j.kind === 'RECOVERY');
  assert.equal(rec.dropFrom, null);
  assert.equal(rec.droppedRecords, null);
  assert.equal(rec.snapshotSha, null);
  ok(out.state, 'fa-legacy');
});

test('T45/F-F: an infra_failed report drains through the tick — net-zero burn, reassignment, infra_retries counted', () => {
  const s = assignOne();  // X assigned attempt 1
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: [{
      event_id: 'rep-infra-1', task: 'X', lease: s.tasks.X.lease.token,
      outcome: { status: 'infra_failed', error: 'transport-drop' }, run_id: 'r-infra',
    }],
    controlQueue: [], ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  const x = out.state.tasks.X;
  assert.equal(x.status, 'assigned', 'reassigned in the same clock pass (at-least-once lane)');
  assert.equal(x.attempts, 1, 'net-zero burn: attempts back to the pre-assignment value');
  assert.equal(x.infra_attempts, 1);
  assert.equal(out.state.stats.infra_retries, 1);
  const rep = out.journal.find(j => j.kind === 'REPORT' && j.task === 'X');
  assert.equal(rep.to, 'ready');
  assert.equal(rep.reason, 'infra-retry');
  assert.equal(rep.error, 'transport-drop');
  assert.ok(out.journal.some(j => j.kind === 'ASSIGN' && j.task === 'X' && j.attempt === 1), 'the reassignment is journaled');
  ok(out.state, 'ff-infra-drain');
});

// ---------------------------------------------------------------------------
// T45/F-C: makeBudget — the per-turn dispatch-budget arithmetic (pure).

import { makeBudget } from '../lib/conductor-core.mjs';

test('T45/F-C: makeBudget — remaining/clamp/fits math + monotonic remaining', () => {
  let nowMs = T0;                       // virtual clock
  const b = makeBudget({ startMs: T0, ttlMs: 10 * 60_000, safetyMs: 45_000, nowMs: () => nowMs });
  assert.equal(b.deadlineMs, T0 + 600_000 - 45_000, 'deadline = start + ttl - safety');
  // t=0: remaining = 555s
  assert.equal(b.remaining(), 555_000);
  assert.equal(b.fits(30_000), true);
  assert.equal(b.fits(600_000), false, 'nothing bigger than the remaining window fits');
  // clamp floors at 0 and caps at remaining
  assert.equal(b.clamp(240_000), 240_000);
  assert.equal(b.clamp(999_999), 555_000, 'clamped to what fits');
  // monotonic: remaining only shrinks as the clock advances
  nowMs += 100_000;
  assert.equal(b.remaining(), 455_000);
  assert.ok(b.remaining() < 555_000);
  // the worker-ladder discipline (adapter-side, exercised here as arithmetic):
  // reserve carved FIRST -> max(0, remaining - 30s)
  assert.equal(Math.max(0, b.remaining() - 30_000), 425_000);
});

test('T45/F-C: makeBudget — the skip thresholds (MIN_CALL_MS discipline) + negative floor', () => {
  let nowMs = T0;
  const b = makeBudget({ startMs: T0, ttlMs: 90_000, safetyMs: 45_000, nowMs: () => nowMs });
  assert.equal(b.remaining(), 45_000);
  nowMs += 30_000;  // 15s remaining: no worker dispatch fits (15s - 30s reserve -> 0 < 30s MIN_CALL_MS)
  assert.equal(b.remaining(), 15_000);
  assert.equal(Math.max(0, b.remaining() - 30_000), 0, 'worker budget floors at 0 — below MIN_CALL_MS -> DISPATCH-SKIPPED');
  assert.equal(b.fits(30_000), false, 'the self-tick skip threshold (remaining < MIN_CALL_MS)');
  // past the deadline: remaining goes NEGATIVE — every consumer floors first
  nowMs += 60_000;
  assert.ok(b.remaining() < 0);
  assert.equal(b.clamp(10_000), 0, 'clamp never returns a negative wait');
});

test('T45/F-C: makeBudget — the local fallback lane (no RUN_STARTED_AT env: process start + TTL)', () => {
  // the adapter's fallback: startMs = process start, ttl = JOB_TTL_MIN default 10
  const start = Date.now();
  const b = makeBudget({ startMs: start, ttlMs: 10 * 60_000, safetyMs: 45_000 });
  const r = b.remaining();
  assert.ok(r > 550_000 && r <= 555_000, `fallback deadline ≈ now + 9m15s (got ${Math.round(r / 1000)}s)`);
});

// ---------------------------------------------------------------------------
// T45/F-G(c): CONTROL journal records carry actor + note (audit trail).

test('T45/F-G(c): queued pause with note+sender -> the CONTROL journal record carries BOTH; direct control carries the sender; note absence -> null', () => {
  const clock = makeNow(T0);
  const base = boot();
  const out = conductorTick({
    cur: structuredClone(base),
    queue: [], controlQueue: [
      { cmd: 'pause', id: 'ctl-q1', ts: iso(T0), note: 'night hold', sender: 'zikomolapoutl' },
      { cmd: 'halt', id: 'ctl-q2', ts: iso(T0) },  // no note, no sender (legacy queue shape)
    ],
    ev: tickEv('chain'), now: clock.now, nextMilestone: NM,
    recover: noRecover, makeGenesis,
  });
  const pause = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'pause');
  assert.ok(pause, 'pause CONTROL record present');
  assert.equal(pause.actor, 'zikomolapoutl', 'the sender is journaled as actor');
  assert.equal(pause.note, 'night hold', 'the note is journaled');
  const halt = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'halt');
  assert.equal(halt.actor, null, 'absent sender -> null (legacy queue records are shape-stable)');
  assert.equal(halt.note, null, 'absent note -> null');
  ok(out.state, 'fgc-queued');
});

test('T45/F-G(c): a DIRECT control wake carries the sender through the router; the reset record journals actor+note', () => {
  const clock = makeNow(T0);
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [],
    ev: { kind: 'CONTROL', command: 'reset', actor: 'xfnwpho1', note: 'fresh epoch', event_id: 'ctl-direct-1', ts: iso(T0) },
    now: clock.now, nextMilestone: NM,
    recover: noRecover, makeGenesis,
  });
  const reset = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'reset');
  assert.ok(reset, 'reset CONTROL record present');
  assert.equal(reset.actor, 'xfnwpho1', 'the direct reset carries the dispatching sender');
  assert.equal(reset.note, 'fresh epoch');
  ok(out.state, 'fgc-direct-reset');
});

// ---------------------------------------------------------------------------
// T46 law-7: the cold-start pin — branch-absent is genesis-ELIGIBLE,
// idempotently, and the notice tells the truth about it. (The live 404 path
// is the conductor adapter's: Store read -> cur null -> recover() -> null ->
// makeGenesis — this unit test pins the eligibility logic itself.)
// ---------------------------------------------------------------------------

test('T46/law-7: cold start — an ABSENT state branch (cur=null, no snapshot anywhere) is genesis-eligible, idempotently', () => {
  // eligibility: cur null + recover() null (the branch-absent 404 shape)
  // => fresh genesis, NOT an error — a brand-new deployment cold-starts clean
  const clock = makeNow(T0);
  const out1 = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('watchdog-reprime'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out1.noop, undefined, 'the cold-start turn COMMITS (genesis material)');
  assert.equal(out1.state.chain.primed_by, 'watchdog-reprime');
  assert.ok(out1.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'bootstrap'));
  // the alert must not lie: the BOOTSTRAP_NOTICE fires exactly when the
  // branch/snapshot was absent — and does NOT fire when a snapshot was found
  assert.ok(out1.actions.some(a => a.type === 'BOOTSTRAP_NOTICE'), 'absent -> the honest bootstrap notice');
  ok(out1.state, 'cold-start-1');
  // the fresh epoch carries the documented mode default (F-B2 genesis half)
  assert.equal(out1.state.project.mode, 'mock');
  // IDEMPOTENT: a second cold start on a STILL-absent branch (the first
  // commit was lost / the watchdog re-primed into the void) produces another
  // clean genesis — no crash, no duplicate-id corruption, no lying alert
  const clock2 = makeNow(T0 + 60_000);
  const out2 = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('watchdog-reprime'),
    now: clock2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out2.noop, undefined);
  assert.ok(out2.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'bootstrap'));
  assert.ok(out2.actions.some(a => a.type === 'BOOTSTRAP_NOTICE'));
  ok(out2.state, 'cold-start-2');
  // contrast: a FOUND snapshot is NOT a cold start — the notice is the
  // recovery one, never the bootstrap one (the alert stays truthful)
  let good = boot();
  good = apply(good, ctlEv('pause'), iso(T0), NM).state;
  const out3 = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: makeNow(T0 + 5_000).now, nextMilestone: NM,
    recover: () => ({ state: structuredClone(good), reason: 'history-walk' }),
    makeGenesis,
  });
  assert.ok(!out3.actions.some(a => a.type === 'BOOTSTRAP_NOTICE'),
    'a found snapshot is a RECOVERY, never a bootstrap — the notice does not lie');
  assert.ok(out3.actions.some(a => a.type === 'RECOVERY_NOTICE'));
});

// ---------------------------------------------------------------------------
// T46/W-C1: the intake drain + epoch ROLLOVER (F-5) + reset flags + pruning
// ---------------------------------------------------------------------------

// the spec-aware makeGenesis (the adapter's extended contract: {config,
// spec, issue} — spec births the intake epoch; plain keeps mockProject)
const mkIntakeG = (() => {
  let n = 0;
  return ({ config, spec, issue } = {}) => {
    const cfg = config || { ...CFG };
    const chainId = `c-wc1-${++n}`;
    let tasks, miles = 1, mode = 'mock', iss = null;
    if (spec) {
      tasks = [{ id: spec.id || `task-i${issue}`, title: spec.title || `intake ${issue}`, behavior: spec.behavior || 'real', work_ms: 4000, deps: [], spec: { accept: spec.accept, artifacts: spec.artifacts, issue } }];
      miles = Math.max(spec.milestone ?? 1, 1);
      iss = issue ?? null;
    } else {
      tasks = fastProject().m1; miles = 2;
    }
    const g = genesis({ config: cfg, project: { tasks, milestones: miles }, chainId, now: iso(T0 + n), mode, issue: iss });
    return { state: g, spec: { tasks, milestones: miles, chainId, mode } };
  };
})();

test('W-C1/F-5: the halting tick with a queued spec mints the next genesis IN THE SAME TICK (rollover; STOP_CHAIN filtered; queue consumed)', () => {
  const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
  // a done epoch (halted) + one queued spec
  let s = genesis({ config: { ...CFG }, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-done', now: iso(T0) });
  s = apply(s, tickEv('r1'), iso(T0), nextMilestoneFactory(ONE)).state;          // assign X
  s = apply(s, { kind: 'REPORT', event_id: 'rep-done-1', task: 'X', lease: s.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r' }, iso(T0 + 1000), nextMilestoneFactory(ONE)).state;
  assert.equal(s.project.phase, 'done');
  assert.equal(s.chain.halted, true);
  const qline = { issue: 42, body_sha8: 'abcd1234', spec: { title: 'research the frob', accept: 'one paragraph' }, enqueued_at: iso(T0), author: 'operator' };
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('roll'), now: n.now, nextMilestone: nextMilestoneFactory(ONE), recover: noRecover, makeGenesis: mkIntakeG,
  });
  // the rollover: a fresh epoch from the spec, in THIS tick
  assert.equal(out.state.project.phase, 'executing', 'the fresh epoch is live');
  assert.notEqual(out.state.chain.id, 'c-done', 'a NEW chain');
  assert.equal(out.state.project.issue, 42, 'm-3: the intake thread rides the project');
  assert.equal(out.state.tasks['task-i42'].behavior, 'real', 'the accept-spec task (behavior real)');
  assert.ok(out.state.tasks['task-i42'].spec.accept, 'the accept criteria ride the task');
  assert.ok(out.actions.some(a => a.type === 'DISPATCH_WORKER' && a.task === 'task-i42'), 'M1 assigned + dispatched in the same tick');
  assert.ok(!out.actions.some(a => a.type === 'STOP_CHAIN'), 'F-5: the halting STOP_CHAIN is filtered — the chain continues');
  assert.deepEqual(out.intakeQueue, [], 'consume = rewrite-minus-head (empty rest = file deleted)');
  const rollRec = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'reset' && String(j.note || '').startsWith('intake-rollover'));
  assert.ok(rollRec, 'the rollover journals as a CONTROL reset (rebuild replays it with zero new code)');
  assert.equal(rollRec.actor, 'intake-door:operator');
  assert.equal(rollRec.genesisSpec.issue, 42, 'the genesisSpec carries the issue');
  // rebuild parity: replaying the rollover journal reconstructs the fresh epoch
  const base = genesis({ config: { ...CFG }, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-par', now: iso(T0) });
  const rb = rebuild(base, out.journal);
  assert.equal(rb.project.issue, 42, 'rebuild: the intake thread replays');
  assert.ok(rb.tasks['task-i42'], 'rebuild: the spec task replays');
});

test('W-C1/F-5: an ACTIVE epoch parks the queue (no journals, no consume — quiesce while live)', () => {
  const s = boot();
  const qline = { issue: 7, body_sha8: 'ef567890', spec: { title: 'next thing', accept: 'x' }, enqueued_at: iso(T0), author: 'op' };
  const n = makeNow(T0 + 1000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('park'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis: mkIntakeG,
  });
  assert.equal(out.state.project.phase, 'executing', 'the active epoch is untouched');
  assert.equal(out.intakeQueue, undefined, 'm-5: park = no writeback (the file stays as-is in git)');
  assert.ok(!out.journal.some(j => j.kind === 'CONTROL' && String(j.note || '').includes('intake')), 'a park-only tick journals nothing intake-shaped');
});

test('W-C1/F-5: reset {from_queue} takes the head; {drop_queue} discards; plain reset parks the queue — BOTH lanes', () => {
  const qline = (i) => ({ issue: i, body_sha8: `s${i}`, spec: { title: `t${i}`, accept: 'x' }, enqueued_at: iso(T0), author: 'op' });
  const run = (patch, queue, lane = 'queued') => {
    const n = makeNow(T0 + 1000);
    const suffix = Math.random().toString(36).slice(2, 8);
    // ONE lane per run (direct + queued twins trip the F-1 twin-guard by
    // design — the e913/e914 shape; each lane is exercised alone here)
    return conductorTick({
      cur: structuredClone(boot()), queue: [], controlQueue: lane === 'queued' ? [{ cmd: 'reset', id: `ctl-rq-${suffix}`, ts: iso(T0), sender: 'op', note: 'flag test', patch }] : [], queueBad: [], ctlBad: [],
      intakeQueue: queue, intakeBad: [],
      ev: lane === 'direct' ? { kind: 'CONTROL', command: 'reset', event_id: `ctl-direct-rq-${suffix}`, ts: iso(T0), patch } : tickEv('rq'),
      now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis: mkIntakeG,
    });
  };
  // plain reset: queue parks
  const a = run(undefined, [qline(1), qline(2)]);
  assert.equal(a.intakeQueue, undefined, 'plain reset: the queue parks (the drill contract is sacred)');
  assert.ok(!a.state.project.issue, 'a plain reset births no intake thread');
  // from_queue: head consumed, genesis from the spec
  const b = run({ from_queue: true }, [qline(1), qline(2)]);
  assert.equal(b.state.project.issue, 1, 'from_queue: the head spec birthed the epoch');
  assert.deepEqual(b.intakeQueue, [qline(2)], 'from_queue: consume-minus-head');
  // drop_queue alone: discards everything, mock genesis
  const c = run({ drop_queue: true }, [qline(1), qline(2)]);
  assert.deepEqual(c.intakeQueue, [], 'drop_queue: the queue is discarded');
  assert.ok(!c.state.project.issue, 'no intake thread');
  // both: take the head, drop the rest
  const d = run({ from_queue: true, drop_queue: true }, [qline(1), qline(2)]);
  assert.equal(d.state.project.issue, 1);
  assert.deepEqual(d.intakeQueue, [], 'from_queue+drop_queue: the rest discarded');
  // the DIRECT lane carries the patch too (the F-5 prepend fix)
  const e = run({ from_queue: true }, [qline(3), qline(4)], 'direct');
  assert.equal(e.state.project.issue, 3, 'direct dispatch with from_queue: the flag survives the prepend');
  assert.deepEqual(e.intakeQueue, [qline(4)], 'direct from_queue: consume-minus-head');
});

test('W-C1/5b: terminal task records PRUNE mid-epoch after N ticks (compact shape, idempotent, dep-satisfaction survives, rebuild re-prunes)', () => {
  // C never reports (a long-lease in-flight task keeps the epoch EXECUTING
  // while A/B age terminal — the mid-epoch shape where growth actually
  // happens; a halted epoch's state is static, replaced by the next genesis)
  const THREE = { milestones: 1, m1: [
    { id: 'A', title: 'a', behavior: 'succeed', work_ms: 1 },
    { id: 'B', title: 'b', behavior: 'succeed', work_ms: 1, deps: ['A'] },
    { id: 'C', title: 'c', behavior: 'hang', work_ms: 1 },
  ] };
  const NM3 = nextMilestoneFactory(THREE);
  const PCFG = { ...CFG, prune_tasks_after_ticks: 5 };
  let s = genesis({ config: PCFG, project: { tasks: THREE.m1, milestones: 1 }, chainId: 'c-prune', now: iso(T0) });
  const n = makeNow(T0);
  const journalsAll = [];   // the FULL history from genesis (rebuild replays everything)
  let r0 = apply(s, tickEv('p1'), n.now(), NM3); s = r0.state; journalsAll.push(...r0.journal);          // A + C assigned
  r0 = apply(s, { kind: 'REPORT', event_id: 'rep-pa', task: 'A', lease: s.tasks.A.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r' }, n.now(), NM3); s = r0.state; journalsAll.push(...r0.journal);  // A done; B unlocks + assigns
  r0 = apply(s, { kind: 'REPORT', event_id: 'rep-pb', task: 'B', lease: s.tasks.B.lease.token, outcome: { status: 'done', artifact: 'b' }, run_id: 'r' }, n.now(), NM3); s = r0.state; journalsAll.push(...r0.journal);  // B done; C in flight keeps executing
  assert.equal(s.project.phase, 'executing');
  assert.ok(!s.tasks.A.pruned, 'freshly terminal: full record');
  let prunedAt = null;
  let s2 = structuredClone(s);
  for (let i = 0; i < 8 && prunedAt == null; i++) {
    const r = apply(s2, tickEv(`age${i}`), n.now(), NM3);
    s2 = r.state; journalsAll.push(...r.journal);
    if (s2.tasks.A.pruned) prunedAt = i;
  }
  assert.ok(prunedAt != null, 'A pruned after the tick age (5 + drift)');
  const prj = journalsAll.find(j => j.kind === 'PRUNE' && j.task === 'A');
  assert.ok(prj, 'the PRUNE journal record');
  assert.equal(prj.from_status, 'done');
  const A = s2.tasks.A;
  assert.deepEqual(Object.keys(A).sort(), ['attempts', 'done_at', 'id', 'pruned', 'status'].sort(), 'the compact shape {id,status,attempts,done_at,pruned}');
  assert.equal(A.status, 'done', 'status kept (recount + allTerminal + dep checks survive)');
  assert.equal(A.attempts, 1);
  assert.ok(s2.tasks.B.pruned, 'B pruned too (same age)');
  assert.ok(!s2.tasks.C.pruned && s2.tasks.C.history, 'C (in flight) keeps its full record');
  assert.deepEqual(invariants(s2), [], 'invariants clean against pruned records');
  // idempotent: further ticks do not re-journal PRUNE for A
  const before = journalsAll.filter(j => j.kind === 'PRUNE' && j.task === 'A').length;
  const r2 = apply(s2, tickEv('age9'), n.now(), NM3);
  assert.equal([...journalsAll, ...r2.journal].filter(j => j.kind === 'PRUNE' && j.task === 'A').length, before, 'idempotent — no re-prune');
  // rebuild: reconstructs the FULL record; the prune is a state-level
  // projection — the next live clock RE-STAMPS terminal_seq and the record
  // re-prunes after the full N-tick age again (idempotent, bounded drift;
  // pruning is an optimization, never a correctness property)
  const base = genesis({ config: PCFG, project: { tasks: THREE.m1, milestones: 1 }, chainId: 'c-par2', now: iso(T0) });
  const rb = rebuild(base, journalsAll);
  assert.ok(!rb.tasks.A.pruned && rb.tasks.A.history, 'rebuild: the full record returns');
  let rb2 = apply(rb, tickEv('post-rb'), n.now(), NM3).state;
  assert.ok(rb2.tasks.A.terminal_seq != null && !rb2.tasks.A.pruned, 'the post-rebuild clock re-stamps (not yet pruned — the age restarts)');
  for (let i = 0; i < 7 && !rb2.tasks.A.pruned; i++) {
    rb2 = apply(rb2, tickEv(`rb-age${i}`), n.now(), NM3).state;
  }
  assert.ok(rb2.tasks.A.pruned, 'the record re-prunes after the re-established age (idempotent)');
});

// ---------------------------------------------------------------------------
// T46/W-C1-R (lens-1 BLOCKING-1): the ADAPTER-SHAPE rollover pin — the
// generator is the LIVE wiring (nextMilestoneFactory(mockProject()) — the
// mock drill's M2/M3), NOT the null every prior pin used. The intake epoch
// must complete at M1 (milestones_total bound) and roll over — no sprout.
// ---------------------------------------------------------------------------

test('W-C1-R/BLOCKING-1: an intake epoch with the ADAPTER generator (mock drill wired) completes at M1 — NO mock sprout, rollover fires', () => {
  // the LIVE adapter wiring, verbatim: conductor/turn.mjs:68
  const ADAPTER_NM = nextMilestoneFactory(mockProjectForAdapter());
  function mockProjectForAdapter() { return fastProject(); }
  const mkG = (() => { let n = 0; return ({ config, spec, issue } = {}) => {
    const chainId = `c-b1-${++n}`;
    const tasks = spec ? [{ id: `task-i${issue}`, title: spec.title, behavior: 'real', work_ms: 1, deps: [], spec: { accept: spec.accept, issue } }] : fastProject().m1;
    const g = genesis({ config: config || { ...CFG }, project: { tasks, milestones: 1 }, chainId, now: iso(T0 + n), mode: 'mock', issue: issue ?? null });
    return { state: g, spec: { tasks, milestones: 1, chainId } };
  }; })();
  const qline = { issue: 55, body_sha8: 'b1abcd12', spec: { title: 'the real thing', accept: 'criteria' }, enqueued_at: iso(T0), author: 'op' };
  const n = makeNow(T0 + 1000);
  // a DONE plain epoch + the queue -> the rollover births the intake epoch
  // (the bootstrap path always mints a plain genesis; intake epochs arrive
  // ONLY via the rollover / reset from_queue — by design)
  const ONE = { m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
  let pre = genesis({ config: { ...CFG }, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-b1pre', now: iso(T0) });
  pre = apply(pre, tickEv('b1s'), iso(T0), nextMilestoneFactory(ONE)).state;
  pre = apply(pre, { kind: 'REPORT', event_id: 'rep-b1x', task: 'X', lease: pre.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r0' }, iso(T0 + 500), nextMilestoneFactory(ONE)).state;
  assert.equal(pre.project.phase, 'done');
  const out = conductorTick({
    cur: structuredClone(pre), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('b1'), now: n.now, nextMilestone: ADAPTER_NM, recover: noRecover, makeGenesis: mkG,
  });
  // the epoch births and assigns its ONE task
  assert.ok(out.state.project.issue === 55, 'the intake thread');
  assert.equal(Object.keys(out.state.tasks).length, 1, 'ONE task — no sprout at genesis');
  assert.equal(out.state.project.milestones_total, 1, 'milestones_total=1 (the adapter half of the fold)');
  // the task completes INSIDE the next tick's drain (the REAL halting shape)
  const t0 = out.state.tasks['task-i55'];
  const doneReport = { kind: 'REPORT', event_id: 'rep-b1', task: 'task-i55', lease: out.state.tasks['task-i55'].lease.token, outcome: { status: 'done', artifact: 'the result' }, run_id: 'r1' };
  const out2 = conductorTick({
    cur: structuredClone(out.state), queue: [doneReport], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [], intakeBad: [],
    ev: tickEv('b1d'), now: n.now, nextMilestone: ADAPTER_NM, recover: noRecover, makeGenesis: mkG,
  });
  // THE BLOCKING-1 ASSERTIONS: phase done at M1 (no M2 sprout), the PHASE
  // record landed, the task set is still the ONE intake task
  assert.equal(out2.state.project.phase, 'done', 'completed — the generator was never consulted');
  assert.equal(out2.state.project.milestone, 1, 'still at M1');
  assert.equal(Object.keys(out2.state.tasks).length, 1, 'NO mock M2/M3 tasks sprouted (the live sprout bug)');
  assert.ok(out2.journal.some(j => j.kind === 'PHASE' && j.to === 'done'), 'the PHASE record');
  assert.ok(out2.actions.some(a => a.type === 'STOP_CHAIN'), 'STOP_CHAIN minted (nothing queued to roll over to)');
  // and WITH a queued second spec: the rollover replaces the stop
  const out3 = conductorTick({
    cur: structuredClone(out.state), queue: [doneReport], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [{ issue: 56, body_sha8: 'b2', spec: { title: 'next', accept: 'x' }, enqueued_at: iso(T0), author: 'op' }], intakeBad: [],
    ev: tickEv('b1r'), now: n.now, nextMilestone: ADAPTER_NM, recover: noRecover, makeGenesis: mkG,
  });
  assert.ok(!out3.actions.some(a => a.type === 'STOP_CHAIN'), 'M4 (lens-1 ask#7a): the REAL-shape STOP_CHAIN filter — the halting drain minted a STOP and the rollover removed it');
  assert.equal(out3.state.project.issue, 56, 'the second spec rolled over in the same tick');
  assert.deepEqual(out3.intakeQueue, []);
});

// T46/W-C1-R (lens-1 ask#7c): the prune idempotence pin EXTENDED — aged past
// N+1 post-prune ticks (the pre-fold pin aged ONE tick; the mutation's damage
// needs N+1 — a second PRUNE + done_at wiped to undefined every N+1 ticks).
test('W-C1-R/mut-c: prune idempotence EXTENDED — 8 post-prune ticks, exactly ONE PRUNE, done_at stable, compact shape stable', () => {
  const THREE = { m1: [
    { id: 'A', title: 'a', behavior: 'succeed', work_ms: 1 },
    { id: 'B', title: 'b', behavior: 'succeed', work_ms: 1, deps: ['A'] },
    { id: 'C', title: 'c', behavior: 'hang', work_ms: 1 },
  ] };
  const NM3 = nextMilestoneFactory(THREE);
  const PCFG = { ...CFG, prune_tasks_after_ticks: 5 };
  let s = genesis({ config: PCFG, project: { tasks: THREE.m1, milestones: 1 }, chainId: 'c-prx', now: iso(T0) });
  const n = makeNow(T0);
  const J = [];
  let r0 = apply(s, tickEv('x1'), n.now(), NM3); s = r0.state; J.push(...r0.journal);
  r0 = apply(s, { kind: 'REPORT', event_id: 'rxa', task: 'A', lease: s.tasks.A.lease.token, outcome: { status: 'done' }, run_id: 'r' }, n.now(), NM3); s = r0.state; J.push(...r0.journal);
  r0 = apply(s, { kind: 'REPORT', event_id: 'rxb', task: 'B', lease: s.tasks.B.lease.token, outcome: { status: 'done' }, run_id: 'r' }, n.now(), NM3); s = r0.state; J.push(...r0.journal);
  let pruned = false, firstDoneAt = null;
  for (let i = 0; i < 20 && !pruned; i++) {
    const r = apply(s, tickEv(`xa${i}`), n.now(), NM3); s = r.state; J.push(...r.journal);
    if (s.tasks.A.pruned) { pruned = true; firstDoneAt = s.tasks.A.done_at; }
  }
  assert.ok(pruned, 'A pruned');
  // THE EXTENSION: 8 MORE ticks past the prune — idempotence must hold
  for (let i = 0; i < 8; i++) {
    const r = apply(s, tickEv(`xb${i}`), n.now(), NM3); s = r.state; J.push(...r.journal);
  }
  const pruneCount = J.filter(j => j.kind === 'PRUNE' && j.task === 'A').length;
  assert.equal(pruneCount, 1, `exactly ONE PRUNE record for A (got ${pruneCount} — the mutation's damage was a second PRUNE + done_at wipe)`);
  assert.equal(s.tasks.A.done_at, firstDoneAt, 'done_at stable across the extended age');
  assert.deepEqual(Object.keys(s.tasks.A).sort(), ['attempts', 'done_at', 'id', 'pruned', 'status'].sort(), 'the compact shape stable');
});

// ---------------------------------------------------------------------------
// s22/B-1 (staged-mode §2.2/§8 B-1): the MULTI-TASK GENESIS MAPPING —
// specEpoch is the pure seam makeGenesis (conductor/turn.mjs) consumes: a
// spec carrying `tasks` maps EVERY entry through the canonical specToTask;
// a plain spec maps its single task (byte-identical to the pre-B-1 inline
// shape). milestones_total stays 1 for BOTH lanes ("the task SET is the
// project") — B-1's `milestones_total = tasks.length` formula would fire
// the clock's generator at milestone 1 < N and re-sprout the mock M2/M3
// (the lens-1 live-sprout bug); the no-sprout pin below is the teeth.
// ---------------------------------------------------------------------------

test('B-1 genesis: the multi-task mapping — 4 entries -> 4 specToTask tasks (canonical mapper per entry; deps CUT; issue/bodySha8 per task)', () => {
  const spec = {
    mode: 'mock', lease_minutes: '15',
    tasks: [
      { id: 'T-STG-A-1031', behavior: 'fast', title: 'staged nightly A (happy path)' },
      { id: 'T-STG-B-1031', behavior: 'fast', title: 'staged nightly B (mirror overflow)' },
      { id: 'T-STG-C-1031', behavior: 'infra-flaky', title: 'staged nightly C (infra retry)' },
      { id: 'T-STG-H-1031', behavior: 'hang', title: 'staged nightly H (lease expiry)' },
    ],
  };
  const ep = specEpoch(spec, { issue: 31, bodySha8: 'ab12cd34' });
  assert.equal(ep.tasks.length, 4);
  assert.equal(ep.milestones, 1, 'milestones_total = 1 — the task SET is the project (the B-1 formula would re-arm the mock generator; see the no-sprout pin)');
  for (const t of ep.tasks) {
    assert.equal(t.deps.length, 0, `deps stay CUT (${t.id})`);
    assert.equal(t.spec.issue, 31, `the intake thread rides every task (${t.id})`);
    assert.equal(t.spec.body_sha8, 'ab12cd34');
  }
  assert.equal(ep.tasks[0].id, 'T-STG-A-1031');
  assert.equal(ep.tasks[0].behavior, 'fast');
  assert.equal(ep.tasks[0].work_ms, 4000, 'the specToTask default');
  assert.equal(ep.tasks[3].behavior, 'hang');
  // a mixed entry with accept + artifacts maps through the same canonical shape
  const mixed = specEpoch({ tasks: [{ id: 'T-1', title: 'real lane', accept: 'criteria', artifacts: ['tasks/T-1/r.md'] }] }, { issue: 9, bodySha8: 'x' });
  assert.equal(mixed.tasks[0].behavior, 'real', 'an accept entry mints behavior real');
  assert.deepEqual(mixed.tasks[0].spec.artifacts, ['tasks/T-1/r.md']);
  assert.equal(mixed.tasks[0].spec.accept, 'criteria');
});

test('B-1 genesis: the single-task path is BYTE-IDENTICAL to the pre-B-1 inline shape (the backward-compat pin)', () => {
  const spec = { id: 'T-501', title: 'research the frob', accept: 'one paragraph', milestone: '2' };
  const ep = specEpoch(spec, { issue: 42, bodySha8: 'abcd1234' });
  // the EXACT object the pre-B-1 makeGenesis built inline:
  //   const task = specToTask(spec, { issue, bodySha8 });
  //   { tasks: [task], milestones: 1 }
  assert.deepEqual(ep, { tasks: [specToTask(spec, { issue: 42, bodySha8: 'abcd1234' })], milestones: 1 });
  assert.equal(ep.tasks[0].id, 'T-501');
  assert.equal(ep.tasks[0].behavior, 'real');
  // the spec-level milestone key stays INERT metadata (dropped by the mapper, as pre-B-1)
  assert.ok(!('milestone' in ep.tasks[0]));
  // a specless epoch is the mock path (makeGenesis's other arm) — specEpoch is never called
  assert.equal(specEpoch(null, { issue: 1 }).tasks[0].id, 'task-i1', 'null-safe single lane');
});

test('B-1 genesis: THE NO-SPROUT PIN — a 4-task spec epoch with the ADAPTER generator wired completes at M1, exactly 4 tasks (the lens-1 F2 bound generalized)', () => {
  // the LIVE adapter wiring: the mock drill's generator (M2+M3), the exact
  // wiring that live-sprouted pre-fold single-task epochs
  const ADAPTER_NM = nextMilestoneFactory(mockProject());
  const spec = {
    mode: 'mock',
    tasks: [
      { id: 'STG-A', behavior: 'succeed', title: 'a' },
      { id: 'STG-B', behavior: 'succeed', title: 'b' },
      { id: 'STG-C', behavior: 'succeed', title: 'c' },
      { id: 'STG-H', behavior: 'succeed', title: 'h' },
    ],
  };
  const ep = specEpoch(spec, { issue: 31, bodySha8: 'ns01' });
  let s = genesis({ config: { ...CFG, max_parallel: 4 }, project: ep, chainId: 'c-b1ns', now: iso(T0), mode: 'mock', issue: 31 });
  assert.equal(s.project.milestones_total, 1);
  // the genesis tick assigns all 4 (max_parallel 4)
  s = apply(s, tickEv('ns1'), iso(T0 + 1000), ADAPTER_NM).state;
  assert.equal(Object.values(s.tasks).filter(t => t.status === 'assigned').length, 4, 'all 4 assigned in the genesis tick');
  // every task reports done
  let n = 0;
  for (const id of ['STG-A', 'STG-B', 'STG-C', 'STG-H']) {
    s = apply(s, { kind: 'REPORT', event_id: `rep-ns-${++n}`, task: id, lease: s.tasks[id].lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: `r${n}` }, iso(T0 + 2000 + n), ADAPTER_NM).state;
  }
  assert.equal(s.project.phase, 'done', 'completed — the generator was NEVER consulted');
  assert.equal(s.project.milestone, 1, 'still at M1');
  assert.deepEqual(Object.keys(s.tasks).sort(), ['STG-A', 'STG-B', 'STG-C', 'STG-H'], 'exactly the 4 spec tasks — NO mock M2/M3 sprout');
});

test('B-1 rollover: a queued 4-entry spec births the 4-task epoch in the halting tick (the genesisSpec slim shape; A12-local)', () => {
  // the REAL mapping through the REAL rollover: makeGenesis wired to
  // specEpoch (the adapter's shape, minus the I/O)
  const mkG = (() => { let n = 0; return ({ config, spec, issue, bodySha8 } = {}) => {
    const cfg = config || { ...CFG };
    const chainId = `c-b1roll-${++n}`;
    if (spec) {
      const ep = specEpoch(spec, { issue, bodySha8: bodySha8 || `i${issue}` });
      const g = genesis({ config: cfg, project: ep, chainId, now: iso(T0 + n), mode: spec.mode || 'mock', issue: issue ?? null });
      return { state: g, spec: { tasks: ep.tasks, milestones: ep.milestones, chainId, mode: g.project.mode } };
    }
    const mp = fastProject();
    const g = genesis({ config: cfg, project: { tasks: mp.m1, milestones: 2 }, chainId, now: iso(T0 + n), mode: 'mock' });
    return { state: g, spec: { tasks: mp.m1, milestones: 2, chainId, mode: 'mock' } };
  }; })();
  // a DONE one-task epoch + the queued 4-task spec (the staged nightly shape)
  const ONE = { m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
  let pre = genesis({ config: { ...CFG }, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-b1pre2', now: iso(T0) });
  pre = apply(pre, tickEv('b1r0'), iso(T0), nextMilestoneFactory(ONE)).state;
  pre = apply(pre, { kind: 'REPORT', event_id: 'rep-b1r0', task: 'X', lease: pre.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r0' }, iso(T0 + 500), nextMilestoneFactory(ONE)).state;
  assert.equal(pre.project.phase, 'done');
  const qline = {
    issue: 31, body_sha8: 'b1abcd99', author: 'op', enqueued_at: iso(T0), id: 'int-b1',
    spec: {
      mode: 'mock', lease_minutes: '15',
      tasks: [
        { id: 'T-STG-A-1031', behavior: 'fast', title: 'staged nightly A (happy path)' },
        { id: 'T-STG-B-1031', behavior: 'fast', title: 'staged nightly B (mirror overflow)' },
        { id: 'T-STG-C-1031', behavior: 'infra-flaky', title: 'staged nightly C (infra retry)' },
        { id: 'T-STG-H-1031', behavior: 'hang', title: 'staged nightly H (lease expiry)' },
      ],
    },
  };
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(pre), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('b1roll'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis: mkG,
  });
  assert.equal(out.state.project.phase, 'executing', 'the fresh epoch is live');
  assert.equal(out.state.project.issue, 31, 'the intake thread rides the project');
  assert.equal(out.state.project.milestones_total, 1, 'milestones_total=1 (the task SET is the project)');
  assert.deepEqual(Object.keys(out.state.tasks).sort(), ['T-STG-A-1031', 'T-STG-B-1031', 'T-STG-C-1031', 'T-STG-H-1031'], 'the 4 mapped tasks');
  assert.equal(out.state.tasks['T-STG-C-1031'].behavior, 'infra-flaky');
  assert.equal(out.state.config.lease_minutes, 15, 'the spec-level lease rides the A4-F1 carry');
  const rollRec = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'reset' && String(j.note || '').startsWith('intake-rollover'));
  assert.ok(rollRec, 'the rollover journals as a CONTROL reset');
  assert.equal(rollRec.genesisSpec.tasks.length, 4, 'A12-local: genesisSpec.tasks.length === 4');
  assert.equal(rollRec.genesisSpec.milestones, 1, 'the slim genesisSpec carries the mapping (rebuild replays it verbatim)');
  assert.equal(rollRec.genesisSpec.mode, 'mock');
  // rebuild parity: the journal replays the 4-task epoch
  const base = genesis({ config: { ...CFG }, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-b1par', now: iso(T0) });
  const rb = rebuild(base, out.journal);
  assert.equal(Object.keys(rb.tasks).length, 4, 'rebuild: all 4 tasks replay');
  assert.equal(rb.tasks['T-STG-H-1031'].behavior, 'hang');
});
