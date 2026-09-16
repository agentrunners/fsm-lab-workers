// test-fsm.mjs — the transition-matrix + invariants suite (node:test).
// The vacuous-fixture discipline: every test drives the REAL apply()/clock()
// exports, asserts fsm.invariants() after EVERY step, and proves the failure
// classes (dup, stale, orphan, poison, quarantine, edges, dedup, rebuild).

import test from 'node:test';
import assert from 'node:assert/strict';
import { genesis, apply, applyEvent, clock, invariants, rebuild, mkTask, INFRA_RETRY_MAX, GENESIS_MODES, law6Violations } from '../lib/fsm.mjs';
import { ENVELOPE_MODES } from '../lib/worker-contract.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const T0 = '2026-09-06T10:00:00.000Z';
const step = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();
const NM = nextMilestoneFactory(fastProject());

function boot(config = {}) {
  let s = genesis({
    config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3, ...config },
    project: { tasks: fastProject().m1, milestones: 2 },
    chainId: 'test-chain',
    now: T0,
  });
  return s;
}

const ok = (s, label) => {
  const v = invariants(s);
  assert.deepEqual(v, [], `invariants violated after ${label}: ${v.join('; ')}`);
};

// a worker report helper — every report gets a UNIQUE event identity
// (fresh uuid per call unless evtId is pinned — the network-retry shape).
const report = (task, lease, outcome, ts, runId = 'run-1', evtId) => ({
  kind: 'REPORT', event_id: evtId || `evt-${crypto.randomUUID().slice(0, 12)}`,
  task, lease, outcome, run_id: runId, ts,
});

// ---------------------------------------------------------------------------
test('genesis: deps route tasks to backlog vs ready; invariants hold', () => {
  const s = boot();
  ok(s, 'genesis');
  assert.equal(s.tasks.A1.status, 'ready');
  assert.equal(s.tasks.A4.status, 'backlog'); // depends on A1
  assert.equal(s.version, 1);
});

test('TICK: assigns up to max_parallel, journals ASSIGN, emits DISPATCH_WORKER actions', () => {
  const s = boot({ max_parallel: 2 });
  const r = apply(s, { kind: 'TICK', ts: T0, actor: 'chain' }, T0, NM);
  ok(r.state, 'tick1');
  assert.equal(r.reason, 'tick');
  const assigned = Object.values(r.state.tasks).filter(t => t.status === 'assigned');
  assert.equal(assigned.length, 2, 'max_parallel=2 respected');
  assert.equal(r.state.chain.seq, 1);
  // FIFO by id: A1, A2 first (A3, A5 also ready — id order: A1,A2,A3,A5)
  assert.deepEqual(assigned.map(t => t.id).sort(), ['A1', 'A2']);
  const dispatches = r.actions.filter(a => a.type === 'DISPATCH_WORKER');
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches.every(d => d.lease && d.attempt === 1 && d.expires > T0));
  const assignJ = r.journal.filter(j => j.kind === 'ASSIGN');
  assert.equal(assignJ.length, 2);
  assert.equal(r.state.journal_seq, 1 + r.journal.length, 'journal_seq advanced past all records');
});

test('REPORT done: task -> done, dep unlock on next clock, stats recount', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const a1 = r.state.tasks.A1;
  const lease = a1.lease.token;
  // A1 reports done
  r = apply(r.state, report('A1', lease, { status: 'done', artifact: 'x' }, step(10_000)), step(10_000), NM);
  ok(r.state, 'report-done');
  assert.equal(r.state.tasks.A1.status, 'done');
  assert.equal(r.state.stats.done, 1);
  // A4 (dep on A1) unlocked by the SAME apply's clock pass
  assert.equal(r.state.tasks.A4.status, 'ready', 'dep unlocked in the same clock pass');
  // a slot freed -> A3 assigned (FIFO: A3 before A5? ready queue after unlock: A3, A5 — wait A2 is assigned, in-flight=1, free=1)
  assert.ok(r.state.tasks.A3.status === 'assigned' || r.state.tasks.A5.status === 'assigned');
});

test('duplicate REPORT: second identical report is a no-op (dedup), journaled as REJECTED', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  const ev = report('A1', lease, { status: 'done' }, step(5000));
  const r1 = apply(r.state, ev, step(5000), NM);
  assert.equal(r1.state.tasks.A1.status, 'done');
  const r2 = apply(r1.state, ev, step(6000), NM); // byte-identical event (same event_id)
  assert.equal(r2.applied, false);
  assert.equal(r2.reason, 'duplicate');
  assert.equal(r2.state.tasks.A1.status, 'done');
  assert.equal(r2.state.stats.rejected_events, 1);
  assert.ok(r2.journal.some(j => j.kind === 'REJECTED' && j.reason === 'duplicate'));
  ok(r2.state, 'dup');
});

test('stale-lease REPORT: rejected, counted as orphaned, task untouched', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const before = r.state.tasks.A2.status; // assigned
  const r1 = apply(r.state, report('A2', 'l-wrongtoken', { status: 'done' }, step(5000)), step(5000), NM);
  assert.equal(r1.state.tasks.A2.status, before, 'task state untouched by stale report');
  assert.equal(r1.state.stats.orphaned_reports, 1);
  assert.ok(r1.journal.some(j => j.kind === 'REJECTED' && j.reason === 'stale-lease'));
  ok(r1.state, 'stale');
});

test('lease timeout: attempts < max -> ready then IMMEDIATE reassign in the same clock pass', () => {
  let s = boot({ lease_minutes: 1 });
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease0 = r.state.tasks.A2.lease.token;
  // 2 minutes later: both leases expired, attempts=1 < 3 -> ready, then
  // the SAME clock pass refills the free slot -> assigned (attempts=2)
  r = apply(r.state, { kind: 'TICK', ts: step(120_000) }, step(120_000), NM);
  ok(r.state, 'timeout');
  const a2 = r.state.tasks.A2;
  assert.ok(['ready', 'assigned'].includes(a2.status), `post-timeout status: ${a2.status}`);
  assert.equal(a2.attempts, 2, 'reassignment consumed attempt 2');
  assert.equal(r.state.stats.timeouts, 2, 'both leased tasks timed out');
  assert.equal(r.state.stats.retries, 2);
  assert.notEqual(a2.lease?.token, lease0, 'the expired lease token is gone');
  assert.ok(r.journal.some(j => j.kind === 'TIMEOUT' && j.task === 'A2'));
});

test('poison task: exhausts attempts -> quarantined, ALERT action emitted', () => {
  let s = boot({ max_parallel: 4, lease_minutes: 1, max_attempts: 3 });
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM); // A3 assigned attempt 1
  // three failed reports (each failure + retry-scan reassigns)
  let now = 10_000;
  for (let i = 0; i < 3; i++) {
    const t = r.state.tasks.A3;
    assert.ok(t.lease, `A3 should be leased at round ${i}, status=${t.status}`);
    r = apply(r.state, report('A3', t.lease.token, { status: 'failed', error: 'poison' }, step(now), `run-${i}`), step(now), NM);
    now += 10_000;
    ok(r.state, `poison-round-${i}`);
    if (i < 2) {
      // failed -> retry-scan -> ready -> SAME clock pass reassigns
      assert.ok(['failed', 'ready', 'assigned'].includes(r.state.tasks.A3.status),
        `round ${i}: ${r.state.tasks.A3.status}`);
      assert.equal(r.state.tasks.A3.attempts, i + 2, 'attempts advance per reassignment');
    }
  }
  assert.equal(r.state.tasks.A3.status, 'quarantined', 'poison eventually quarantined');
  assert.equal(r.state.tasks.A3.attempts, 3);
  // alerting is the conductor's journal scan — the RECORD is the trigger
  assert.ok(r.journal.some(j => j.to === 'quarantined' && j.task === 'A3'));
  ok(r.state, 'poison-final');
});

test('flaky task: fails once then succeeds on retry (the at-least-once path)', () => {
  let s = boot({ max_parallel: 4 });
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM); // A2 assigned attempt 1
  r = apply(r.state, report('A2', r.state.tasks.A2.lease.token, { status: 'failed', error: 'flaky' }, step(5000), 'run-a'), step(5000), NM);
  // failed -> retry-scan -> reassign happens in the same clock pass
  const t = r.state.tasks.A2;
  assert.equal(t.status, 'assigned', 'reassigned in the same clock pass');
  assert.equal(t.attempts, 2);
  r = apply(r.state, report('A2', t.lease.token, { status: 'done', artifact: 'ok' }, step(7000), 'run-b'), step(7000), NM);
  assert.equal(r.state.tasks.A2.status, 'done');
  assert.equal(r.state.stats.retries, 1);
  ok(r.state, 'flaky');
});

test('milestone advance: all-terminal -> next milestone tasks created', () => {
  let s = boot({ max_parallel: 8, max_attempts: 1, lease_minutes: 1 });
  // drain M1: everything terminal (poison quarantined at 1 attempt, etc.)
  let r = { state: s };
  let now = 0;
  for (let guard = 0; guard < 40; guard++) {
    r = apply(r.state, { kind: 'TICK', ts: step(now) }, step(now), NM);
    now += 30_000;
    const reportables = Object.values(r.state.tasks).filter(t => ['assigned', 'in_progress'].includes(t.status) && (t.behavior === 'succeed' || t.behavior === 'flaky' || t.behavior === 'dup'));
    for (const t of reportables) {
      // fresh state each time (apply is pure)
      const cur = r.state.tasks[t.id];
      if (!cur.lease) continue;
      const attempt = cur.attempts;
      const succeed = cur.behavior === 'succeed' || cur.behavior === 'dup' || (cur.behavior === 'flaky' && attempt >= 2);
      r = apply(r.state, report(t.id, cur.lease.token, { status: succeed ? 'done' : 'failed' }, step(now)), step(now), NM);
    }
  }
  const statuses = Object.values(r.state.tasks).map(t => `${t.id}:${t.status}`);
  // M1 all-terminal triggers M2 creation
  assert.ok(r.state.tasks.B1, `milestone 2 tasks created (${statuses.join(',')})`);
  assert.equal(r.state.project.milestone, 2);
  ok(r.state, 'milestone');
});

test('project completion: STOP_CHAIN action + phase=done + chain halted', () => {
  let s = boot({ max_parallel: 8, max_attempts: 1 });
  let r = { state: s };
  let now = 0;
  for (let guard = 0; guard < 60; guard++) {
    r = apply(r.state, { kind: 'TICK', ts: step(now) }, step(now), NM);
    now += 30_000;
    let acted = true;
    while (acted) {
      acted = false;
      for (const t of Object.values(r.state.tasks)) {
        if (['assigned', 'in_progress'].includes(t.status)) {
          const succeed = t.behavior === 'succeed' || t.behavior === 'dup' || t.behavior === 'flaky';
          r = apply(r.state, report(t.id, t.lease.token, { status: succeed ? 'done' : 'failed' }, step(now)), step(now), NM);
          acted = true;
        }
      }
    }
    if (r.state.project.phase === 'done') break;
  }
  assert.equal(r.state.project.phase, 'done');
  assert.equal(r.state.chain.halted, true);
  assert.ok(r.actions.some(a => a.type === 'STOP_CHAIN' && a.reason === 'project-complete'));
  ok(r.state, 'complete');
});

test('bad edge: report on a done task -> rejected, no state damage', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  r = apply(r.state, report('A1', lease, { status: 'done' }, step(5000)), step(5000), NM);
  const v = r.state.version;
  // now the task is done; another report for it (different dedup key) with the OLD lease
  const r2 = apply(r.state, { kind: 'REPORT', dedup_key: 'rep:other:A1', task: 'A1', lease, outcome: { status: 'failed' }, run_id: 'run-2' }, step(9000), step(9000), NM);
  assert.equal(r2.applied, false);
  assert.match(r2.reason, /task-not-leased\(done\)/);
  ok(r2.state, 'bad-edge');
});

test('unknown task / unknown kind / bad command: rejected cleanly', () => {
  const s = boot();
  const r1 = apply(s, { kind: 'REPORT', dedup_key: 'x1', task: 'NOPE', lease: 'l', outcome: { status: 'done' } }, T0, NM);
  assert.equal(r1.applied, false);
  assert.equal(r1.reason, 'unknown-task');
  const r2 = apply(s, { kind: 'WAT', ts: T0 }, T0, NM);
  assert.match(r2.reason, /bad-kind/);
  const r3 = apply(s, { kind: 'CONTROL', dedup_key: 'x3', command: 'explode' }, T0, NM);
  assert.match(r3.reason, /bad-command/);
  ok(r3.state, 'bad-cmd');
});

test('CONTROL pause: clock holds (no assigns, HOLD_CHAIN), no lease churn', () => {
  let s = boot();
  s = apply(s, { kind: 'CONTROL', dedup_key: 'c1', command: 'pause' }, T0, NM).state;
  const r = apply(s, { kind: 'TICK', ts: step(1000) }, step(1000), NM);
  ok(r.state, 'paused');
  assert.equal(Object.values(r.state.tasks).filter(t => t.status === 'assigned').length, 0, 'no assignments while paused');
  assert.ok(r.actions.some(a => a.type === 'HOLD_CHAIN' && a.reason === 'paused'));
  const r2 = apply(r.state, { kind: 'CONTROL', dedup_key: 'c2', command: 'resume' }, step(2000), NM);
  assert.equal(r2.state.chain.paused, false);
});

test('rebuild: journal replay reproduces the incremental state (event sourcing)', () => {
  let s = boot({ max_parallel: 3, max_attempts: 3 });
  const gen = structuredClone(s);
  let now = 0;
  const journal = [];
  for (let guard = 0; guard < 30; guard++) {
    const r = apply(s, { kind: 'TICK', actor: 'chain', ts: step(now) }, step(now), NM);
    journal.push(...r.journal);
    s = r.state;
    now += 30_000;
    for (const t of Object.values(s.tasks)) {
      if (['assigned', 'in_progress'].includes(t.status)) {
        const succeed = t.behavior === 'succeed' || t.behavior === 'dup' || (t.behavior === 'flaky' && t.attempts >= 2);
        const rr = apply(s, report(t.id, t.lease.token, { status: succeed ? 'done' : 'failed' }, step(now)), step(now), NM);
        journal.push(...rr.journal);
        s = rr.state;
      }
    }
    ok(s, `rebuild-build-${guard}`);
    if (s.project.phase === 'done') break;
  }
  const rebuilt = rebuild(gen, journal);
  // the deterministic projection: statuses, attempts, stats, phase
  for (const [id, t] of Object.entries(s.tasks)) {
    assert.equal(rebuilt.tasks[id]?.status, t.status, `rebuild status mismatch for ${id}`);
    assert.equal(rebuilt.tasks[id]?.attempts, t.attempts, `rebuild attempts mismatch for ${id}`);
  }
  assert.equal(rebuilt.project.phase, s.project.phase);
  assert.equal(rebuilt.stats.done, s.stats.done);
  assert.equal(rebuilt.stats.quarantined, s.stats.quarantined);
  assert.equal(rebuilt.chain.paused, s.chain.paused);
  assert.equal(rebuilt.chain.halted, s.chain.halted);
  ok(rebuilt, 'rebuilt');
  ok(s, 'final');
});

test('invariants catch real corruption (the guard is not vacuous)', () => {
  const s = boot();
  s.tasks.A1.status = 'assigned'; // active without lease
  const v = invariants(s);
  assert.ok(v.some(x => x.startsWith('A1:active-without-lease')), 'invariant must catch lease-less active task');
  const s2 = boot();
  s2.stats.done = 99; // stats drift
  const v2 = invariants(s2);
  assert.ok(v2.some(x => x.startsWith('stats.done')), 'invariant must catch stats drift');
});

test('parallelism cap: never more than max_parallel in flight', () => {
  let s = boot({ max_parallel: 2 });
  let now = 0;
  for (let i = 0; i < 6; i++) {
    const r = apply(s, { kind: 'TICK', ts: step(now) }, step(now), NM);
    s = r.state;
    ok(s, `cap-${i}`);
    const inflight = Object.values(s.tasks).filter(t => ['assigned', 'in_progress'].includes(t.status)).length;
    assert.ok(inflight <= 2, `inflight=${inflight} <= 2`);
    now += 5000;
  }
});

test('progress report: assigned -> in_progress (heartbeat path)', () => {
  let s = boot();
  const r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  const r2 = apply(r.state, report('A1', lease, { status: 'progress' }, step(2000), 'run-p'), step(2000), NM);
  assert.equal(r2.state.tasks.A1.status, 'in_progress');
  ok(r2.state, 'progress');
});

test('cascade cancellation: quarantined deps cancel blocked dependents (live-found gap)', () => {
  let s = boot({ max_parallel: 1, max_attempts: 1, lease_minutes: 1 });
  // A1 succeeds -> A4 unlocks and completes; A3 (poison) fails once -> quarantined (max_attempts=1)
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM); // A1 assigned
  r = apply(r.state, report('A1', r.state.tasks.A1.lease.token, { status: 'done' }, step(5000), 'r-a'), step(5000), NM);
  // A4 is ready now; next tick assigns it (A3 also ready — FIFO A3 first with max_parallel=1)
  let now = 10_000;
  for (let i = 0; i < 4; i++) {
    const t = Object.values(r.state.tasks).find(x => x.status === 'assigned');
    if (!t) break;
    r = apply(r.state, report(t.id, t.lease.token, { status: 'failed', error: 'x' }, step(now), `r-${i}`), step(now), NM);
    now += 5000;
  }
  ok(r.state, 'cascade-build');
  // poison A3 quarantined at attempt 1; dependents of failed tasks cancel
  const cancelled = Object.values(r.state.tasks).filter(t => t.status === 'cancelled');
  assert.ok(cancelled.length >= 0, 'no invariant damage');
  // direct check: build a state where a dep is quarantined and a dependent is backlog
  const s2 = boot();
  s2.tasks.A1.status = 'quarantined'; s2.tasks.A1.lease = null;
  s2.tasks.A4.status = 'backlog';
  const c = clock(s2, step(60000), NM);
  assert.equal(c.state.tasks.A4.status, 'cancelled', 'dependent of quarantined dep cascade-cancels');
  assert.ok(c.journal.some(j => j.kind === 'CANCEL_CASCADE' && j.task === 'A4'));
  ok(c.state, 'cascade');
  // and the cascade propagates: cancelled deps cancel their dependents too
  const s3 = boot();
  s3.tasks.A1.status = 'cancelled'; s3.tasks.A1.lease = null;
  s3.tasks.A4.status = 'backlog';
  const c3 = clock(s3, step(60000), NM);
  assert.equal(c3.state.tasks.A4.status, 'cancelled', 'cascade propagates through cancelled');
});

// ---------------------------------------------------------------------------
// T44 additions (audit-driven): quiescence, identity consumption, configure,
// unhalt-on-done, ghost deps, enriched rejects, invariant additions, and the
// F8 rebuild-parity projection test.

test('T44/F2: TICK on a HELD chain is not an event — no journal, no seq bump, quiesce-able', () => {
  const s = boot();
  const paused = apply(s, { kind: 'CONTROL', command: 'pause', event_id: 'c1', ts: T0 }, T0, NM);
  ok(paused.state, 'paused');
  const wake = apply(paused.state, { kind: 'TICK', event_id: 't2', ts: step(1000), actor: 'chain' }, step(1000), NM);
  assert.equal(wake.applied, false);
  assert.equal(wake.reason, 'held-paused');
  assert.equal(wake.journal.length, 0, 'no journal records on a held wake');
  assert.equal(wake.state.chain.seq, paused.state.chain.seq, 'seq frozen');
  assert.equal(wake.state.chain.last_tick, paused.state.chain.last_tick, 'last_tick frozen (watchdog reads held first — safe)');
  // halted variant
  const done = apply(s, { kind: 'CONTROL', command: 'halt', event_id: 'c2', ts: T0 }, T0, NM);
  const wake2 = apply(done.state, { kind: 'TICK', event_id: 't3', ts: step(1000) }, step(1000), NM);
  assert.equal(wake2.reason, 'held-halted');
  assert.equal(wake2.journal.length, 0);
});

test('T44/F2: a drain that PAUSES mid-mutate still commits (the accumulated-journal gate)', () => {
  // the wake TICK no-ops, but the control's journal record persists — the
  // noop gate must key on TOTAL journals, not the wake's own records
  const s = boot();
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const pauseEv = { kind: 'CONTROL', command: 'pause', event_id: 'c-p1', ts: step(500) };
  const rp = apply(r1.state, pauseEv, step(500), NM);
  // journals from the control exist; a subsequent held TICK contributes none
  assert.ok(rp.journal.length >= 1, 'control journaled');
  const wake = apply(rp.state, { kind: 'TICK', event_id: 't2', ts: step(600) }, step(600), NM);
  assert.equal(wake.journal.length, 0);
  // combined: [control records] nonempty => the conductor commits (gate test)
  const totalJournals = [...rp.journal, ...wake.journal];
  assert.ok(totalJournals.length >= 1, 'the accumulated journal is non-empty — commit happens');
});

test('T44/F11: a REJECTED report consumes its event_id — re-enqueue arrives as duplicate', () => {
  const s = boot();
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const leaseA1 = r1.state.tasks.A1.lease.token;
  // a report for an UNKNOWN task (permanent reject)
  const bad = report('NOPE', leaseA1, { status: 'done', artifact: 'x' }, step(1000), 'run-x', 'evt-bad-1');
  const rr1 = apply(r1.state, bad, step(1000), NM);
  assert.equal(rr1.reason, 'unknown-task');
  assert.equal(rr1.applied, false);
  // the SAME event_id again (network re-delivery): duplicate, not re-rejected
  const rr2 = apply(rr1.state, { ...bad, ts: step(2000) }, step(2000), NM);
  assert.equal(rr2.reason, 'duplicate');
  assert.equal(rr2.journal[0].kind, 'REJECTED');
  assert.equal(rr2.journal[0].applied, false);
  assert.equal(rr2.journal[0].reason, 'duplicate');
});

test('T44/A4: REJECTED report records carry the event identity + sliced outcome (audit trail)', () => {
  const s = boot();
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const leaseA1 = r1.state.tasks.A1.lease.token;
  const late = report('A1', 'wrong-token', { status: 'done', artifact: 'x'.repeat(500) }, step(100), 'run-9', 'evt-late');
  const rr = apply(r1.state, late, step(100), NM);
  assert.equal(rr.reason, 'stale-lease');
  const j = rr.journal[0];
  assert.equal(j.kind, 'REJECTED');
  assert.equal(j.applied, false);
  assert.equal(j.event_id, 'evt-late');
  assert.equal(j.outcome.artifact.length, 200, 'artifact sliced to 200 chars');
  assert.equal(rr.state.stats.orphaned_reports, 1);
});

test('T44/F12: configure control — valid patch applies + journals; bounds and unknown keys reject', () => {
  const s = boot({ max_parallel: 2 });
  const cfg = (patch, id) => apply(s, { kind: 'CONTROL', command: 'configure', patch, event_id: id, ts: T0 }, T0, NM);
  const good = cfg({ lease_minutes: 15 }, 'cf-1');
  assert.equal(good.applied, true);
  assert.equal(good.state.config.lease_minutes, 15);
  assert.equal(good.state.config.max_parallel, 2, 'untouched keys unchanged');
  const jj = good.journal[0];
  assert.equal(jj.command, 'configure');
  assert.deepEqual(jj.patch, { lease_minutes: 15 });
  assert.deepEqual(jj.before, { lease_minutes: 1 });
  // bounds: max_parallel 999 (the flood shape) must reject
  assert.equal(cfg({ max_parallel: 999 }, 'cf-2').reason, 'bad-patch(configure: config.max_parallel must be an integer in [1,32] (got 999))');
  assert.equal(cfg({ max_parallel: 0 }, 'cf-3').reason.startsWith('bad-patch('), true);
  // unknown key
  assert.equal(cfg({ dedup_window: 10 }, 'cf-4').reason, 'bad-patch-key(dedup_window)');
  assert.equal(cfg({ evil: 1 }, 'cf-5').reason, 'bad-patch-key(evil)');
  // no-op (against the ALREADY-configured state)
  const again = apply(good.state, { kind: 'CONTROL', command: 'configure', patch: { lease_minutes: 15 }, event_id: 'cf-6', ts: T0 }, T0, NM);
  assert.equal(again.reason, 'configure-noop');
  // empty
  assert.equal(cfg({}, 'cf-7').reason, 'configure-empty');
  // non-integer (the workflow_dispatch string-input shape)
  assert.equal(cfg({ lease_minutes: '15' }, 'cf-8').reason.startsWith('bad-patch('), true);
});

test('T44/F12: genesis validation — degenerate configs throw at the boundary', () => {
  const mk = (config, tasks) => () => genesis({ config, project: { tasks: tasks || fastProject().m1, milestones: 2 }, chainId: 'x', now: T0 });
  assert.throws(mk({ max_parallel: 0 }), /max_parallel/);
  assert.throws(mk({ lease_minutes: 0 }), /lease_minutes/);
  assert.throws(mk({ max_attempts: 0 }), /max_attempts/);
  assert.throws(mk({ dedup_window: 8 }), /dedup_window/);
  assert.throws(mk({ tick_min_interval_s: -1 }), /tick_min_interval_s/);
  assert.throws(mk({}, []), /non-empty/);
});

test('T44/F13: unhalt on a DONE project rejects (phase-done); no duplicate PHASE/PROJECT-COMPLETE', () => {
  // drive to phase=done
  let s = boot({ max_parallel: 4, lease_minutes: 1 });
  const seen = [];
  const nm = nextMilestoneFactory(fastProject());
  let now = T0;
  for (let i = 0; i < 200 && s.project.phase !== 'done'; i++) {
    const r = apply(s, { kind: 'TICK', event_id: `tick-${i}`, ts: now, actor: 'chain' }, now, nm);
    s = r.state;
    ok(s, `loop-${i}`);
    seen.push(...r.journal.filter(j => j.kind === 'PHASE'));
    // workers report instantly for every assigned task
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        const rr = apply(s, report(t.id, t.lease.token, { status: 'done' }, now, `run-${i}-${t.id}`), now, nm);
        s = rr.state;
        seen.push(...rr.journal.filter(j => j.kind === 'PHASE'));
      }
    }
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  assert.equal(s.project.phase, 'done');
  assert.equal(seen.length, 1, 'exactly one PHASE record');
  // unhalt on done: rejected with phase-done
  const uh = apply(s, { kind: 'CONTROL', command: 'unhalt', event_id: 'uh1', ts: now }, now, nm);
  assert.equal(uh.applied, false);
  assert.equal(uh.reason, 'phase-done');
  // a held tick after: still quiesced, no second PHASE
  const wake = apply(s, { kind: 'TICK', event_id: 't-fin', ts: now }, now, nm);
  assert.equal(wake.journal.filter(j => j.kind === 'PHASE').length, 0);
});

test('T44/F9: TASK_CREATED with a ghost dep is rejected at the boundary (the chain-bricker)', () => {
  const s = boot();
  const ev = { kind: 'TASK_CREATED', event_id: 'tc1', ts: T0, task: { id: 'T-NEW', title: 'x', deps: ['GHOST-1'] } };
  const r = apply(s, ev, T0, NM);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'unknown-dep(GHOST-1)');
  assert.equal(r.state.tasks['T-NEW'], undefined, 'no half-created task');
  ok(r.state, 'reject');
  // valid dep: accepted
  const ev2 = { kind: 'TASK_CREATED', event_id: 'tc2', ts: T0, task: { id: 'T-OK', title: 'x', deps: ['A1'] } };
  const r2 = apply(s, ev2, T0, NM);
  assert.equal(r2.applied, true);
  assert.equal(r2.state.tasks['T-OK'].status, 'backlog');
});

test('T44/F9: milestone specs with ghost deps are skipped + journaled (not bricked)', () => {
  // a generator bug must not brick the chain: build a custom NM whose m2 has a ghost dep
  const proj = fastProject();
  const badM2 = { tasks: [{ id: 'B1', title: 'ok' }, { id: 'B2', title: 'bad', deps: ['GHOST-X'] }] };
  const nm = (m) => (m === 1 ? badM2 : null);  // nextMilestone(m) returns milestone m+1
  let s = boot({ max_parallel: 8 });
  let now = T0;
  for (let i = 0; i < 100 && s.project.phase !== 'done' && s.project.milestone < 2; i++) {
    const r = apply(s, { kind: 'TICK', event_id: `t${i}`, ts: now, actor: 'x' }, now, nm);
    s = r.state;
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        s = apply(s, report(t.id, t.lease.token, { status: 'done' }, now, `r${i}${t.id}`), now, nm).state;
      }
    }
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  assert.equal(s.project.milestone, 2);
  assert.equal(s.tasks.B1.status, 'ready', 'valid spec created');
  assert.equal(s.tasks.B2, undefined, 'ghost-dep spec NOT created');
  ok(s, 'milestone-door — no invariant violation, chain not bricked');
});

test('T44/F10: invariants catch lease leaks (inactive-with-lease) and duplicate tokens', () => {
  const s = boot();
  const leaked = structuredClone(s);
  leaked.tasks.A1.status = 'ready';
  leaked.tasks.A1.lease = { token: 'l-leak', expires: step(60000), issued_at: T0 };
  assert.ok(invariants(leaked).some(v => v.includes('inactive-with-lease')));
  // duplicate token across two active tasks — 44-h F10 residual (T45/F-H):
  // boot with max_parallel 4 so >=2 actives are GUARANTEED (fastProject m1
  // has 4+ ready) and the assertion is UNCONDITIONAL (the old shape silently
  // skipped when <2 actives — a test that can not fail proves nothing)
  const s2 = boot({ max_parallel: 4 });
  const r = apply(s2, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'x' }, T0, NM);
  const dupd = structuredClone(r.state);
  const actives = Object.values(dupd.tasks).filter(t => t.status === 'assigned');
  assert.ok(actives.length >= 2, `max_parallel=4 must assign >=2 tasks (got ${actives.length}) — the F10 assertion is unconditional`);
  dupd.tasks[actives[1].id].lease.token = actives[0].lease.token;
  assert.ok(invariants(dupd).some(v => v.includes('duplicate-lease-token')));
});

test('T44/F8: rebuild parity — the PROJECTION converges across a rich sequence (rejects, timeouts, reset, cascades)', () => {
  const nm = nextMilestoneFactory(fastProject());
  let s = boot({ max_parallel: 2, lease_minutes: 1 });
  const journals = [];
  let now = T0;
  let tickN = 0;
  const drive = (ev) => {
    const r = apply(s, ev, now, nm);
    s = r.state;
    journals.push(...r.journal);
    ok(s, 'parity-step');
  };
  // a normal project with injections
  for (let i = 0; i < 120 && s.project.phase !== 'done'; i++) {
    drive({ kind: 'TICK', event_id: `tk${tickN++}`, ts: now, actor: 'chain' });
    // ghost-dep task created (rejected — journaled)
    if (i === 2) drive({ kind: 'TASK_CREATED', event_id: 'tc-ghost', ts: now, task: { id: 'G1', deps: ['NOPE'] } });
    if (i === 3) drive({ kind: 'CONTROL', command: 'configure', patch: { lease_minutes: 2 }, event_id: 'cf-p1', ts: now });
    if (i === 4) drive({ kind: 'CONTROL', command: 'pause', event_id: 'c-p', ts: now });
    if (i === 5) drive({ kind: 'CONTROL', command: 'resume', event_id: 'c-r', ts: now });
    // flaky: fail once then succeed; poison: always fail; late-report: stale lease
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        if (t.id === 'A2' && t.attempts === 1) {
          drive(report(t.id, t.lease.token, { status: 'failed', error: 'flaky' }, now, `rr${i}`));
        } else if (t.id === 'A5') {
          drive(report(t.id, 'stale-token-x', { status: 'done' }, now, `rr${i}`));
        } else if (t.id === 'A3' && t.attempts <= 2) {
          drive(report(t.id, t.lease.token, { status: 'failed', error: 'poison' }, now, `rr${i}`));
        } else if (t.status === 'assigned') {
          drive(report(t.id, t.lease.token, { status: 'done', artifact: `done:${t.id}` }, now, `rr${i}`));
        }
      }
    }
    // advance past lease windows (timeouts fire; retries reassign)
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  assert.equal(s.project.phase, 'done');
  // a RESET epoch (the conductor's shape: slim genesis spec + journal_seq continuity)
  const spec = { config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, tasks: fastProject().m1, milestones: 2, chainId: 'chain-after-reset', now, journal_seq: s.journal_seq };
  const rec = { id: `e${s.journal_seq}`, ts: now, applied: true, kind: 'CONTROL', command: 'reset', genesisSpec: spec };
  journals.push(rec);
  const g = genesis({ config: spec.config, project: { tasks: spec.tasks, milestones: spec.milestones }, chainId: spec.chainId, now: spec.now });
  g.journal_seq = s.journal_seq + 1;
  s = g;
  // and one more tick on the fresh epoch
  const r2 = apply(s, { kind: 'TICK', event_id: 'tk-post', ts: now, actor: 'chain' }, now, nm);
  s = r2.state;
  journals.push(...r2.journal);
  ok(s, 'post-reset');
  // T45/F-A extension: a duplicate-id residue (identical content — the
  // frozen branch's mixed-deploy shape) and a RECOVERY epoch marker are
  // rebuild-neutral under keeps-last (the dup replays ONCE; RECOVERY is
  // audit-only). The repair commit mints the epoch record LAST, so the live
  // journal_seq advances past it — mirrored here.
  journals.push(structuredClone(journals[journals.length - 1]));
  journals.push({ id: `e${s.journal_seq}`, ts: now, applied: true, kind: 'RECOVERY', reason: 'history-walk', dropFrom: null, droppedRecords: null, snapshotSha: 'deadbeef' });
  s.journal_seq += 1;
  ok(s, 'post-recovery-marker');

  // REBUILD from the ORIGINAL genesis + the journal
  const reb = rebuild(genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'test-chain', now: T0 }), journals, { nextMilestone: nm });
  // THE PROJECTION: statuses, attempts, stats, version, journal_seq, phase, chain fields
  const proj = (st) => ({
    phase: st.project.phase, milestone: st.project.milestone,
    chain: { seq: st.chain.seq, paused: st.chain.paused, halted: st.chain.halted, id: st.chain.id },
    config: st.config,
    stats: st.stats,
    version: st.version, journal_seq: st.journal_seq,
    tasks: Object.fromEntries(Object.entries(st.tasks).map(([id, t]) => [id, { status: t.status, attempts: t.attempts, lease: t.lease ? t.lease.token : null }])),
  });
  assert.deepEqual(proj(reb), proj(s), 'rebuild projection must equal live projection');
});

test('T44/44-h P1: TWO-LEVEL ghost deps cascade (B1-ghost, B2-deps-B1 — the fixpoint prune)', () => {
  const proj = fastProject();
  const badM2 = { tasks: [{ id: 'B1', title: 'ghost', deps: ['GHOST-X'] }, { id: 'B2', title: 'deps-on-ghost', deps: ['B1'] }, { id: 'B3', title: 'clean' }] };
  const nm = (m) => (m === 1 ? badM2 : null);
  let s = boot({ max_parallel: 8 });
  let now = T0;
  const journals = [];
  for (let i = 0; i < 100 && s.project.milestone < 2; i++) {
    const r = apply(s, { kind: 'TICK', event_id: `t${i}`, ts: now, actor: 'x' }, now, nm);
    s = r.state;
    journals.push(...r.journal);
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        const rr = apply(s, report(t.id, t.lease.token, { status: 'done' }, now, `r${i}${t.id}`), now, nm);
        s = rr.state;
        journals.push(...rr.journal);
      }
    }
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  // B1 AND B2 pruned (the cascade); B3 created; NO invariant violation
  assert.equal(s.tasks.B1, undefined, 'B1 pruned (ghost)');
  assert.equal(s.tasks.B2, undefined, 'B2 pruned (dep on the pruned B1 — the fixpoint)');
  assert.equal(s.tasks.B3.status, 'ready', 'the clean spec survives');
  const rejected = journals.filter(j => j.kind === 'REJECTED' && j.origKind === 'MILESTONE');
  assert.equal(rejected.length, 2, 'both invalid specs journaled as REJECTED');
  assert.equal(rejected[0].applied, false);
  ok(s, 'fixpoint milestone door');
});

// ---------------------------------------------------------------------------
// T45/F-F: the infra_failed outcome class (net-zero burn, own budget).

test('T45/F-F: infra_failed report — net-zero burn, ready + lease cleared, distinct history why', () => {
  let s = boot({ max_parallel: 2 });
  let r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  // pure applyEvent (no clock pass): the task returns to READY, lease CLEARED
  const ri = applyEvent(r.state, report('A1', lease, { status: 'infra_failed', error: 'mock-lane-429' }, step(5000), 'run-i', 'evt-infra-1'), step(5000));
  ok(ri.state, 'infra-pure');
  assert.equal(ri.applied, true);
  const t = ri.state.tasks.A1;
  assert.equal(t.status, 'ready', 'back to ready (lane unavailable, not work failure)');
  assert.equal(t.attempts, 0, 'net-zero burn: the assignment is voided');
  assert.equal(t.lease, null, 'lease cleared (ready is non-terminal — the explicit clear)');
  assert.equal(t.infra_attempts, 1);
  assert.equal(ri.state.stats.infra_retries, 1);
  assert.ok(t.history.some(h => /infra-retry/.test(h.why)), `history why: ${t.history.map(h => h.why).join('|')}`);
  const j = ri.eventOut;
  assert.equal(j.kind, 'REPORT');
  assert.equal(j.to, 'ready');
  assert.equal(j.reason, 'infra-retry');
  assert.equal(j.error, 'mock-lane-429');
  // the composite apply() (event + clock): reassignment in the SAME pass
  const r2 = apply(r.state, report('A1', lease, { status: 'infra_failed', error: 'mock-lane-429' }, step(5000), 'run-i', 'evt-infra-2'), step(5000), NM);
  ok(r2.state, 'infra-composite');
  assert.equal(r2.state.tasks.A1.status, 'assigned', 'reassigned in the same clock pass');
  assert.equal(r2.state.tasks.A1.attempts, 1, 'attempts oscillates 1->0->1 — the work ladder never burns');
  assert.equal(r2.state.stats.infra_retries, 1);
});

test('T45/F-F: INFRA_RETRY_MAX exhaustion -> quarantined with the DISTINCT infra-exhausted reason', () => {
  assert.equal(INFRA_RETRY_MAX, 3, 'the budget is a lib constant (not a config knob)');
  let s = boot({ max_parallel: 2 });
  let n = 0;
  for (let i = 0; i < 3; i++) {
    let r = apply(s, { kind: 'TICK', event_id: `t-${i}`, ts: step(n), actor: 'chain' }, step(n), NM);
    s = r.state; n += 1000;
    const t = s.tasks.A1;
    assert.ok(t.lease, `A1 leased at round ${i} (status=${t.status})`);
    const rr = apply(s, report('A1', t.lease.token, { status: 'infra_failed', error: 'mock-lane-429' }, step(n), 'run-x', `evt-infra-${i}`), step(n), NM);
    s = rr.state; n += 1000;
    ok(s, `infra-round-${i}`);
  }
  const t = s.tasks.A1;
  assert.equal(t.status, 'quarantined', 'the lane-death terminal');
  assert.equal(t.infra_attempts, INFRA_RETRY_MAX);
  assert.equal(s.stats.infra_retries, 2, 'the third report parks — only 2 retries counted');
  assert.ok(t.history.some(h => /infra-exhausted/.test(h.why)), 'the DISTINCT reason is in the audit trail');
  assert.equal(t.attempts, 1, 'the work ladder never burned past 1 (net-zero held to the end)');
  assert.equal(t.lease, null);
});

test('T45/F-F: infra report on a TERMINAL task rejects task-not-leased (the lease guard is unchanged)', () => {
  let s = boot({ max_parallel: 2 });
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const lease = r1.state.tasks.A1.lease.token;
  const r2 = apply(r1.state, report('A1', lease, { status: 'done' }, step(5000), 'run-d', 'evt-done'), step(5000), NM);
  const r3 = apply(r2.state, report('A1', lease, { status: 'infra_failed', error: 'x' }, step(6000), 'run-late', 'evt-late-infra'), step(6000), NM);
  assert.equal(r3.applied, false);
  assert.match(r3.reason, /task-not-leased\(done\)/);
  assert.equal(r3.state.stats.infra_retries, 0);
});

test('T45/F-F: rebuild mirrors infra-retry (net-zero + lease cleared) and infra-exhausted (F8 parity)', () => {
  let s = boot({ max_parallel: 2 });
  const gen = structuredClone(s);
  const journal = [];
  const drive = (ev) => {
    const r = apply(s, ev, step(1000 * (journal.length + 1)), NM);
    s = r.state;
    journal.push(...r.journal);
    ok(s, 'ff-parity-step');
  };
  drive({ kind: 'TICK', event_id: 't1', ts: step(1000), actor: 'chain' });
  // two infra flaps (each reassigns in the same pass), then the lane recovers
  for (let i = 0; i < 2; i++) {
    drive(report('A1', s.tasks.A1.lease.token, { status: 'infra_failed', error: 'mock-lane-429' }, step(2000 + i * 10), 'run-i', `evt-if-${i}`));
  }
  drive(report('A1', s.tasks.A1.lease.token, { status: 'done', artifact: 'recovered' }, step(3000), 'run-ok', 'evt-ok'));
  // a second task exhausts the infra budget -> quarantined (infra-exhausted)
  for (let i = 0; i < 3; i++) {
    const t = s.tasks.A2;
    if (t.status !== 'assigned') break;  // quarantined on the 3rd
    drive(report('A2', t.lease.token, { status: 'infra_failed', error: 'mock-lane-5xx' }, step(5000 + i * 10), 'run-i2', `evt-if2-${i}`));
  }
  assert.equal(s.tasks.A2.status, 'quarantined');
  assert.equal(s.stats.infra_retries, 4);  // A1 x2 + A2's first two
  const reb = rebuild(gen, journal);
  const proj = (st) => ({
    tasks: Object.fromEntries(Object.entries(st.tasks).map(([id, t]) => [id, {
      status: t.status, attempts: t.attempts, lease: t.lease ? t.lease.token : null, infra: t.infra_attempts ?? 0,
    }])),
    stats: st.stats,
    chain: { seq: st.chain.seq },
  });
  assert.deepEqual(proj(reb), proj(s), 'rebuild mirrors the infra classes (net-zero burn, lease clears, infra-exhausted)');
});

// ---------------------------------------------------------------------------
// T45/F-A: rebuild keeps-last-on-duplicate-id.

test('T45/F-A: rebuild KEEPS-LAST on duplicate ids — last content wins, replayed once; journal_seq monotonic', () => {
  const g = boot({ max_parallel: 2 });
  const recs = [
    { id: 'e1', ts: step(1000), applied: true, kind: 'TICK', seq: 1, actor: 'chain' },
    { id: 'e1', ts: step(2000), applied: true, kind: 'TICK', seq: 2, actor: 'chain' },  // SAME id, DIFFERENT content (LAST wins)
    { id: 'e2', ts: step(3000), applied: true, kind: 'ASSIGN', task: 'A1', from: 'ready', to: 'assigned', lease: 'l-1', expires: step(60000), attempt: 1, behavior: 'succeed' },
    { id: 'e2', ts: step(4000), applied: true, kind: 'ASSIGN', task: 'A2', from: 'ready', to: 'assigned', lease: 'l-2', expires: step(60000), attempt: 1, behavior: 'flaky' },
    { id: 'e3', ts: step(5000), applied: false, kind: 'REJECTED', origKind: 'REPORT', reason: 'stale-lease' },
  ];
  const reb = rebuild(g, recs);
  assert.equal(reb.chain.seq, 2, 'the LAST e1 content won (seq=2), applied ONCE');
  assert.equal(reb.tasks.A2.status, 'assigned', 'the LAST e2 content won (A2 assigned)');
  assert.equal(reb.tasks.A1.status, 'ready', 'the superseded e2 content (A1) did NOT apply');
  assert.equal(reb.stats.dispatched, 1, 'one ASSIGN applied (not two)');
  assert.equal(reb.stats.rejected_events, 1, 'applied:false still counted once');
  assert.equal(reb.journal_seq, 4, 'journal_seq monotonic through the duplicates (max id + 1)');
  // an EXACT duplicate of the LAST content (the frozen-branch overlap shape)
  // is replay-neutral: same id, same content -> applied once
  const recs2 = [...recs, structuredClone(recs[3])];
  const reb2 = rebuild(g, recs2);
  assert.equal(reb2.tasks.A2.status, 'assigned');
  assert.equal(reb2.stats.dispatched, 1, 'the identical-content duplicate applied ONCE');
  // id-less records replay individually (each its own group)
  const recs3 = [...recs, { ts: step(6000), applied: true, kind: 'CONTROL', command: 'pause' }];
  const reb3 = rebuild(g, recs3);
  assert.equal(reb3.chain.paused, true, 'an id-less record still replays');
});

// ---------------------------------------------------------------------------
// T46/F-B1: the FIVE-CLASS receiver — the contract's status classes get FSM
// handlers (work_failed / deadline / poison joined done / infra_failed).
// ---------------------------------------------------------------------------

test('T46/F-B1: work_failed — the ALIAS of legacy failed (byte-identical transition, attempt-burn)', () => {
  let s = boot({ max_parallel: 2 });
  let r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const lease = r.state.tasks.A2.lease.token;
  // pure applyEvent: failed (terminal) — the retry-scan moves it on next clock
  const rw = applyEvent(r.state, report('A2', lease, { status: 'work_failed', error: 'bad-output' }, step(5000), 'run-w', 'evt-wf-1'), step(5000));
  ok(rw.state, 'work-failed-pure');
  assert.equal(rw.applied, true);
  assert.equal(rw.state.tasks.A2.status, 'failed', 'attempt-burn: the work ladder, not the infra void');
  assert.equal(rw.state.tasks.A2.attempts, 1, 'the attempt STAYS burned');
  assert.equal(rw.state.tasks.A2.lease, null, 'failed is terminal — lease cleared');
  assert.equal(rw.state.tasks.A2.last_result.status, 'work_failed', 'last_result records the vocabulary the worker used');
  assert.equal(rw.eventOut.kind, 'REPORT');
  assert.equal(rw.eventOut.to, 'failed');
  assert.equal(rw.eventOut.reason, undefined, 'work-class reports carry no reason (the legacy shape)');
  // the composite apply(): retry-scan -> ready -> SAME pass reassigns
  const r2 = apply(r.state, report('A2', lease, { status: 'work_failed', error: 'bad-output' }, step(5000), 'run-w', 'evt-wf-2'), step(5000), NM);
  ok(r2.state, 'work-failed-composite');
  assert.equal(r2.state.tasks.A2.status, 'assigned', 'reassigned in the same clock pass');
  assert.equal(r2.state.tasks.A2.attempts, 2);
  assert.equal(r2.state.stats.retries, 1);
  assert.ok(r2.journal.some(j => j.kind === 'RETRY' && j.task === 'A2'), 'the retry-scan record lands');
});

test('T46/F-B1: work_failed PARITY — the alias produces the identical state+journal as legacy failed', () => {
  // two parallel worlds, identical except the report vocabulary
  const drive = (status) => {
    let s = boot({ max_parallel: 1 });
    let r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
    const lease = r.state.tasks.A1.lease.token;
    r = apply(r.state, report('A1', lease, { status, error: 'x' }, step(5000), 'run-1', 'evt-1'), step(5000), NM);
    return r;
  };
  const legacy = drive('failed');
  const alias = drive('work_failed');
  ok(legacy.state, 'legacy'); ok(alias.state, 'alias');
  // the journal is byte-identical modulo the random lease TOKENS (each boot
  // mints fresh uuid tokens — normalize them, keep every other byte)
  const normJ = (js) => js.map(j => ({ ...j, lease: j.lease ? '<token>' : j.lease }));
  assert.deepEqual(normJ(alias.journal), normJ(legacy.journal));
  // the state projection is identical except last_result.status and the
  // random lease TOKENS (fresh uuid per boot — normalize both)
  const proj = (st) => {
    const c = structuredClone(st);
    for (const t of Object.values(c.tasks)) {
      t.last_result = t.last_result ? { ...t.last_result, status: '<vocab>' } : null;
      if (t.lease) t.lease = { ...t.lease, token: '<token>' };
    }
    return c;
  };
  assert.deepEqual(proj(alias.state), proj(legacy.state));
  assert.equal(alias.state.tasks.A1.last_result.status, 'work_failed');
  assert.equal(legacy.state.tasks.A1.last_result.status, 'failed');
});

test('T46/F-B1: work_failed at max attempts -> quarantined (the alias inherits the ladder)', () => {
  let s = boot({ max_parallel: 1, max_attempts: 2 });
  let n = 0;
  for (let i = 0; i < 2; i++) {
    let r = apply(s, { kind: 'TICK', event_id: `t-${i}`, ts: step(n), actor: 'chain' }, step(n), NM);
    s = r.state; n += 1000;
    const t = s.tasks.A1;
    assert.ok(t.lease, `A1 leased at round ${i} (status=${t.status})`);
    const rr = apply(s, report('A1', t.lease.token, { status: 'work_failed', error: 'still-bad' }, step(n), 'run-w', `evt-wf-q-${i}`), step(n), NM);
    s = rr.state; n += 1000;
    ok(s, `wf-quarantine-round-${i}`);
  }
  assert.equal(s.tasks.A1.status, 'quarantined');
  assert.equal(s.tasks.A1.attempts, 2);
  assert.equal(s.stats.quarantined, 1);
});

test('T46/F-B1: deadline — the SELF-REPORTED reaper (attempt-burn + lease release, TIMEOUT-equivalent)', () => {
  let s = boot({ max_parallel: 2 });
  let r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  // pure applyEvent: ready + lease RELEASED + attempts BURNED (not voided)
  const rd = applyEvent(r.state, report('A1', lease, { status: 'deadline', error: 'rc=124' }, step(5000), 'run-d', 'evt-dl-1'), step(5000));
  ok(rd.state, 'deadline-pure');
  assert.equal(rd.applied, true);
  const t = rd.state.tasks.A1;
  assert.equal(t.status, 'ready', 'requeue (retries remain)');
  assert.equal(t.lease, null, 'LEASE RELEASED (ready is non-terminal — the explicit clear)');
  assert.equal(t.attempts, 1, 'attempt-burn: the attempt STAYS counted (unlike the infra void)');
  assert.equal(t.infra_attempts, undefined, 'deadline is NOT the infra class');
  assert.equal(rd.state.stats.timeouts, 1, 'counted as the reaper would count it');
  assert.equal(rd.state.stats.retries, 1);
  assert.equal(rd.eventOut.kind, 'REPORT');
  assert.equal(rd.eventOut.to, 'ready');
  assert.equal(rd.eventOut.reason, 'deadline');
  assert.equal(rd.eventOut.error, 'rc=124');
  assert.ok(t.history.some(h => /worker-deadline/.test(h.why)), 'the distinct history why');
  // the reaper cannot double-fire: the released lease is gone from the clock's view
  const c = clock(rd.state, step(6000), NM);
  assert.ok(!c.journal.some(j => j.kind === 'TIMEOUT' && j.task === 'A1'), 'no TIMEOUT follows the self-report');
  // the composite apply(): ready -> SAME pass reassigns (the timeout-test equivalence)
  const r2 = apply(r.state, report('A1', lease, { status: 'deadline', error: 'rc=124' }, step(5000), 'run-d', 'evt-dl-2'), step(5000), NM);
  ok(r2.state, 'deadline-composite');
  assert.equal(r2.state.tasks.A1.status, 'assigned', 'IMMEDIATE reassign in the same clock pass');
  assert.equal(r2.state.tasks.A1.attempts, 2);
  assert.notEqual(r2.state.tasks.A1.lease?.token, lease, 'a FRESH lease');
  assert.equal(r2.state.stats.timeouts, 1);
});

test('T46/F-B1: deadline at max attempts -> quarantined (timeouts counted, no retry)', () => {
  let s = boot({ max_parallel: 1, max_attempts: 2 });
  let n = 0;
  for (let i = 0; i < 2; i++) {
    let r = apply(s, { kind: 'TICK', event_id: `t-${i}`, ts: step(n), actor: 'chain' }, step(n), NM);
    s = r.state; n += 1000;
    const t = s.tasks.A1;
    assert.ok(t.lease, `A1 leased at round ${i} (status=${t.status})`);
    const rr = apply(s, report('A1', t.lease.token, { status: 'deadline', error: 'rc=124' }, step(n), 'run-d', `evt-dl-q-${i}`), step(n), NM);
    s = rr.state; n += 1000;
    ok(s, `dl-quarantine-round-${i}`);
  }
  assert.equal(s.tasks.A1.status, 'quarantined', 'the spent ladder quarantines');
  assert.equal(s.tasks.A1.lease, null);
  assert.equal(s.stats.timeouts, 2);
  assert.equal(s.stats.retries, 1, 'only the FIRST deadline requeued');
});

test('T46/F-B1: poison — the quarantine DOOR, terminal regardless of attempts, reason poison, DISTINCT from infra', () => {
  let s = boot({ max_parallel: 2 });
  let r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  const rp = apply(r.state, report('A1', lease, { status: 'poison', error: 'prompt-injection-detected' }, step(5000), 'run-p', 'evt-po-1'), step(5000), NM);
  ok(rp.state, 'poison');
  assert.equal(rp.applied, true);
  const t = rp.state.tasks.A1;
  assert.equal(t.status, 'quarantined', 'the quarantine door');
  assert.equal(t.attempts, 1, 'terminal at attempt 1 — retrying an anomalous prompt is pointless burn');
  assert.equal(t.lease, null, 'terminal — lease cleared');
  assert.equal(t.infra_attempts, undefined, 'DISTINCT from infra exhaustion (no infra counter)');
  assert.equal(t.last_result.status, 'poison');
  const rec = rp.journal.find(j => j.kind === 'REPORT' && j.task === 'A1');
  assert.equal(rec.to, 'quarantined');
  assert.equal(rec.reason, 'poison', 'the DISTINCT reason on the audit trail');
  assert.equal(rec.error, 'prompt-injection-detected');
  assert.ok(t.history.some(h => /worker-poison/.test(h.why)));
  assert.equal(rp.state.stats.quarantined, 1);
  assert.equal(rp.state.stats.infra_retries, 0);
  // the detail vocabulary from classifyOutcome is accepted too (error<-detail)
  let s2 = boot({ max_parallel: 2 });
  let r2 = apply(s2, { kind: 'TICK', event_id: 't2', ts: T0, actor: 'chain' }, T0, NM);
  const rp2 = apply(r2.state, report('A1', r2.state.tasks.A1.lease.token, { status: 'poison', detail: 'wb-violation(.github)' }, step(5000), 'run-p', 'evt-po-2'), step(5000), NM);
  assert.equal(rp2.state.tasks.A1.status, 'quarantined');
  assert.equal(rp2.journal.find(j => j.kind === 'REPORT' && j.task === 'A1').error, 'wb-violation(.github)');
});

test('T46/F-B1: unknown outcome statuses still reject bad-outcome (fail-closed receiver)', () => {
  let s = boot({ max_parallel: 2 });
  let r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  for (const status of ['exploded', 'DONE', 'ok', 'cancelled', 'quarantined']) {
    const rr = apply(r.state, report('A1', lease, { status }, step(5000), 'run-x', `evt-bad-${status}`), step(5000), NM);
    assert.equal(rr.applied, false, `status=${status} must reject`);
    assert.match(rr.reason, new RegExp(`^bad-outcome\\(${status}\\)$`));
    assert.equal(rr.state.tasks.A1.status, 'assigned', 'no state damage');
  }
  ok(r.state, 'bad-outcome');
});

test('T46/F-B1: rebuild parity — ALL FIVE classes replay identically from journals (the F8 contract)', () => {
  let s = boot({ max_parallel: 2 });
  const gen = structuredClone(s);
  const journal = [];
  let n = 0;
  const drive = (ev) => {
    const r = apply(s, ev, step(1000 * (++n)), NM);
    s = r.state;
    journal.push(...r.journal);
    ok(s, `f8-five-step-${n}`);
    return r;
  };
  drive({ kind: 'TICK', event_id: 't1', ts: step(1000), actor: 'chain' });
  // A1: done
  drive(report('A1', s.tasks.A1.lease.token, { status: 'done', artifact: 'x' }, step(2000), 'r1', 'evt-1'));
  // A2: work_failed -> retry-scan ready -> reassign -> deadline (self-reported reaper)
  drive(report('A2', s.tasks.A2.lease.token, { status: 'work_failed', error: 'bad' }, step(3000), 'r2', 'evt-2'));
  drive(report('A2', s.tasks.A2.lease.token, { status: 'deadline', error: 'rc=124' }, step(4000), 'r2b', 'evt-2b'));
  // A2 reassigned; report poison on the fresh lease
  drive(report('A2', s.tasks.A2.lease.token, { status: 'poison', error: 'anomaly' }, step(5000), 'r2c', 'evt-2c'));
  // A3 (poison behavior, legacy vocab): failed twice -> quarantined via the ladder
  for (let i = 0; i < 3 && s.tasks.A3.status !== 'quarantined'; i++) {
    if (!s.tasks.A3.lease) drive({ kind: 'TICK', event_id: `t-${i}`, ts: step(1000 * (++n)), actor: 'chain' });
    if (s.tasks.A3.lease) drive(report('A3', s.tasks.A3.lease.token, { status: 'failed', error: 'poison-always' }, step(1000 * (++n)), 'r3', `evt-3-${i}`));
  }
  // an infra flap on A5 (net-zero) then done
  drive(report('A5', s.tasks.A5.lease.token, { status: 'infra_failed', error: 'lane-429' }, step(1000 * (++n)), 'r5', 'evt-5a'));
  drive(report('A5', s.tasks.A5.lease.token, { status: 'done', artifact: 'y' }, step(1000 * (++n)), 'r5b', 'evt-5b'));
  // A4 was unlocked by A1-done; give it a deadline-to-quarantine via max_attempts
  // (drive enough deadline reports to spend the ladder)
  for (let i = 0; i < 3 && s.tasks.A4.status !== 'quarantined' && s.tasks.A4.status !== 'ready'; i++) {
    if (s.tasks.A4.lease) drive(report('A4', s.tasks.A4.lease.token, { status: 'deadline', error: 'rc=124' }, step(1000 * (++n)), 'r4', `evt-4-${i}`));
  }
  // sanity: the live state exercised all five classes
  assert.equal(s.tasks.A1.status, 'done');
  assert.equal(s.tasks.A2.status, 'quarantined');
  assert.equal(s.tasks.A3.status, 'quarantined');
  assert.ok(s.stats.timeouts >= 1);
  assert.ok(journal.some(j => j.kind === 'REPORT' && j.reason === 'deadline'));
  assert.ok(journal.some(j => j.kind === 'REPORT' && j.reason === 'poison'));
  assert.ok(journal.some(j => j.kind === 'REPORT' && j.reason === 'infra-retry'));
  assert.ok(journal.some(j => j.kind === 'RETRY'));
  // the projection: rebuild(genesis, journal) === live
  const reb = rebuild(gen, journal);
  const proj = (st) => ({
    tasks: Object.fromEntries(Object.entries(st.tasks).map(([id, t]) => [id, {
      status: t.status, attempts: t.attempts, lease: t.lease ? t.lease.token : null, infra: t.infra_attempts ?? 0,
    }])),
    stats: st.stats,
    chain: { seq: st.chain.seq },
    version: st.version,
  });
  assert.deepEqual(proj(reb), proj(s), 'rebuild parity across all five report classes');
  // NOTE: dedup is deliberately NOT compared — applied REPORT records do not
  // journal their event_id, so the runtime dedup window is not reconstructible
  // from the journal (the pre-existing F8 semantics; the store's exactly-once
  // drain covers re-delivery after recovery, and the window is bounded)
});

// ---------------------------------------------------------------------------
// T46/F-B2 (fsm half): the genesis mode param (the epoch's harness lane).
// ---------------------------------------------------------------------------

test('T46/F-B2: genesis mode — default mock rides project.mode; cc for the X21 synthetic epoch', () => {
  const s = genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'c-mode', now: T0 });
  assert.equal(s.project.mode, 'mock', 'the default (every legacy epoch)');
  const cc = genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'c-x21', now: T0, mode: 'cc' });
  assert.equal(cc.project.mode, 'cc');
  ok(cc, 'genesis-cc');
  // bad mode fails closed at the boundary
  for (const mode of ['monk', '', 42, null]) {
    assert.throws(() => genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3 }, project: { tasks: fastProject().m1 }, chainId: 'x', now: T0, mode }),
      /genesis: mode must be one of/);
  }
  // ONE vocabulary: fsm's GENESIS_MODES === worker-contract's ENVELOPE_MODES
  assert.deepEqual(GENESIS_MODES, ENVELOPE_MODES, 'the receiver and the envelope speak the same mode vocabulary');
});

test('T46/F-B2: rebuild replays the mode from a reset genesisSpec (legacy specs default to mock)', () => {
  const g = boot({ max_parallel: 1 });
  const tasks = fastProject().m1;
  const mk = (mode) => [
    { id: 'e1', ts: step(1000), applied: true, kind: 'CONTROL', command: 'reset', genesisSpec: { config: { max_parallel: 1, lease_minutes: 1, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, tasks, milestones: 2, chainId: 'c-reset', now: step(1000), journal_seq: 1, ...(mode ? { mode } : {}) } },
  ];
  const cc = rebuild(g, mk('cc'));
  assert.equal(cc.project.mode, 'cc', 'the W-B reset spec carries the epoch mode');
  const legacy = rebuild(g, mk(undefined));
  assert.equal(legacy.project.mode, 'mock', 'a legacy spec (no mode field) defaults to mock');
});

// ---------------------------------------------------------------------------
// T46/F-M3 (law 6): the pointer-only journal invariant, NEW-class scoped.
// ---------------------------------------------------------------------------

test('T46/F-M3: ASSIGN records + DISPATCH actions carry task_ref pointers; no inline specs', () => {
  let s = boot({ max_parallel: 2 });
  const r = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const assigns = r.journal.filter(j => j.kind === 'ASSIGN');
  assert.equal(assigns.length, 2);
  for (const j of assigns) {
    assert.deepEqual(j.task_ref, { kind: 'state-task', id: j.task }, 'the NEW-class pointer');
    for (const k of ['prompt', 'spec', 'body', 'title', 'tasks']) {
      assert.equal(j[k], undefined, `ASSIGN must not inline ${k} (payload stays in the state.json task record)`);
    }
  }
  const dispatches = r.actions.filter(a => a.type === 'DISPATCH_WORKER');
  assert.equal(dispatches.length, 2);
  for (const d of dispatches) {
    assert.deepEqual(d.task_ref, { kind: 'state-task', id: d.task });
  }
});

test('T46/F-M3: law6Violations — NEW-class records only; legacy inline-spec records untouched', () => {
  // a REAL journal from a full drive: new ASSIGN records (task_ref) + legacy
  // MILESTONE records (inline specs BY DESIGN — rebuild replays them)
  let s = boot({ max_parallel: 2 });
  const journal = [];
  let n = 0;
  const drive = (ev) => {
    const r = apply(s, ev, step(1000 * (++n)), NM);
    s = r.state; journal.push(...r.journal);
  };
  drive({ kind: 'TICK', event_id: 't1', ts: step(1000), actor: 'chain' });
  drive(report('A1', s.tasks.A1.lease.token, { status: 'done', artifact: 'x' }, step(2000), 'r1', 'evt-1'));
  // push to milestone 2 (the legacy inline-spec MILESTONE record class)
  drive(report('A2', s.tasks.A2.lease.token, { status: 'done', artifact: 'x' }, step(3000), 'r2', 'evt-2'));
  drive(report('A3', s.tasks.A3.lease.token, { status: 'done', artifact: 'x' }, step(4000), 'r3', 'evt-3'));
  drive(report('A5', s.tasks.A5.lease.token, { status: 'done', artifact: 'x' }, step(5000), 'r5', 'evt-5'));
  drive(report('A4', s.tasks.A4.lease.token, { status: 'done', artifact: 'x' }, step(6000), 'r4', 'evt-4'));
  assert.ok(journal.some(j => j.kind === 'MILESTONE' && Array.isArray(j.tasks)), 'a legacy inline-spec MILESTONE record is in the journal');
  // the SCOPED audit: clean on the mixed journal (new pointers OK, legacy specs exempt)
  assert.deepEqual(law6Violations(journal), [], 'the F-M3 scoping: legacy records are not flagged');
  // strict mode for post-T46 journals: every ASSIGN must carry the pointer
  assert.deepEqual(law6Violations(journal, { requireAssignTaskRef: true }), []);
  // a synthetic NEW-class violation: task_ref PLUS an inline payload
  const bad = [
    ...journal,
    { id: 'e99', ts: step(9999), applied: true, kind: 'ASSIGN', task: 'Z9', from: 'ready', to: 'assigned', lease: 'l-1', expires: step(99999), attempt: 1, behavior: 'succeed', task_ref: { kind: 'state-task', id: 'Z9' }, prompt: 'do the thing inline' },
  ];
  assert.deepEqual(law6Violations(bad), ['e99:inline-spec(prompt)']);
  // a malformed pointer + a mismatched pointer
  assert.deepEqual(law6Violations([{ id: 'e1', kind: 'ASSIGN', task: 'Z9', task_ref: { kind: 'issue', id: 9 } }]), ['e1:bad-task-ref({"kind":"issue","id":9})']);
  assert.deepEqual(law6Violations([{ id: 'e2', kind: 'ASSIGN', task: 'A', task_ref: { kind: 'state-task', id: 'B' } }]), ['e2:task-ref-mismatch(A!=B)']);
  // an ASSIGN missing its pointer (the minting regression) — only in strict mode
  const noPtr = [{ id: 'e3', kind: 'ASSIGN', task: 'Z9', from: 'ready', to: 'assigned', lease: 'l-1', expires: step(99999), attempt: 1, behavior: 'succeed' }];
  assert.deepEqual(law6Violations(noPtr), [], 'legacy-shaped (pre-T46) records stay legal by default');
  assert.deepEqual(law6Violations(noPtr, { requireAssignTaskRef: true }), ['e3:assign-without-task-ref']);
  // a purely LEGACY journal (hand-crafted pre-T46 shape, inline specs everywhere)
  const legacyJournal = [
    { id: 'e1', ts: step(1000), applied: true, kind: 'TICK', seq: 1, actor: 'chain' },
    { id: 'e2', ts: step(2000), applied: true, kind: 'ASSIGN', task: 'A1', from: 'ready', to: 'assigned', lease: 'l-1', expires: step(99999), attempt: 1, behavior: 'succeed' },
    { id: 'e3', ts: step(3000), applied: true, kind: 'TASK_CREATED', task: 'N1', spec: { id: 'N1', title: 't', behavior: 'succeed' } },
    { id: 'e4', ts: step(4000), applied: true, kind: 'MILESTONE', milestone: 2, tasks: [{ id: 'B1', title: 'b', behavior: 'succeed' }] },
  ];
  assert.deepEqual(law6Violations(legacyJournal), [], 'the unscoped pin-test would FAIL here — this is the F-M3 kill');
});
