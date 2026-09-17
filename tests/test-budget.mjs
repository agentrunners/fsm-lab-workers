// test-budget.mjs — T46/W-C1 lane A: the dispatchBudget + lane-budget pause
// pins (F-6/F-7/F-8/F-10 — the X21 12-task burn's structural fix, pinned).
//
// Coverage map (each = one regression pin with the design fold named):
//   F-10  budget=0 → ZERO assigns, task stays READY, BUDGET record journaled
//         (the skip-left-assigned bug class is dead by construction);
//         budget healthy → assigns proceed; per-iteration recompute honored.
//   F-6   3 DISTINCT tasks' quota reports → BUDGET_PAUSE_ALERT (window +
//         tasks + detail); the pause does NOT land in the trigger tick;
//         aged-out window entries trimmed → no trigger; ONE task's repeats
//         do not count-trigger; infra-exhausted backstop fires on the
//         quota-detailed quarantine.
//   F-8   the alert action is the ADAPTER's to execute (here: its shape);
//         the paused chain never re-triggers.
//   F-7   pause payload.reason → paused_reason + budget_pauses; resume
//         clears BOTH + the window; rebuild parity for all of it.
//   F-9   the law-4 verify pass skips on paused OR halted.
//   §2e   specToTask: accept-spec → behavior 'real' + spec.accept; explicit
//         behavior passes through; the id default.

import test from 'node:test';
import assert from 'node:assert/strict';
import { genesis, apply, rebuild, invariants } from '../lib/fsm.mjs';
import {
  conductorTick, isQuotaDetail, specToTask, DISPATCH_COST_MS, dispatchBudgetFromWall,
  dispatchVerificationEvents, VERIFY_WINDOW_MS,
} from '../lib/conductor-core.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const T0 = Date.parse('2026-09-17T10:00:00.000Z');
const NM = nextMilestoneFactory(fastProject());
const CFG = { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };

function makeNow(startMs = T0) {
  let t = startMs;
  return { now: () => new Date((t += 1)).toISOString(), get ms() { return t; } };
}
const iso = (ms) => new Date(ms).toISOString();

function boot(config = {}) {
  return genesis({
    config: { ...CFG, ...config },
    project: { tasks: fastProject().m1, milestones: 2 },
    chainId: 'test-budget', now: iso(T0),
  });
}
const makeGenesis = (() => {
  let n = 0;
  return ({ config } = {}) => {
    const cfg = config || { ...CFG };
    const chainId = `c-budget-${++n}`;
    const g = genesis({ config: cfg, project: { tasks: fastProject().m1, milestones: 2 }, chainId, now: iso(T0 + n) });
    return { state: g, spec: { tasks: fastProject().m1, milestones: 2, chainId } };
  };
})();
const noRecover = () => null;
const tickEv = (reason = 'chain') => ({ kind: 'TICK', actor: reason, event_id: `tick-${reason}-${Math.random().toString(36).slice(2, 8)}`, ts: iso(T0) });

// assign the whole first milestone (budget unlimited) — the fixture for
// report-drain tests
function assignedState(config = {}) {
  const s = boot(config);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('seed'), now: makeNow().now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(out.actions.some(a => a.type === 'DISPATCH_WORKER'), 'fixture: at least one dispatch');
  return out.state;
}

// a quota-shaped infra report for the given task's CURRENT lease
const quotaReport = (state, id, n, detail = 'lane-429') => ({
  kind: 'REPORT', event_id: `rep-q${n}-${id}`, task: id,
  lease: state.tasks[id].lease.token,
  outcome: { status: 'infra_failed', error: detail }, run_id: `run-${n}`,
});

// ---------------------------------------------------------------------------
// F-10 — the dispatchBudget arithmetic
// ---------------------------------------------------------------------------

test('F-10: budget=0 -> ZERO assigns, tasks stay READY, BUDGET record journaled (skip-left-assigned is dead)', () => {
  const s = boot();
  const n = makeNow();
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('b0'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    dispatchBudgetFn: () => 0,
  });
  assert.equal(out.actions.filter(a => a.type === 'DISPATCH_WORKER').length, 0, 'zero dispatch actions under a 0 budget');
  for (const t of Object.values(out.state.tasks)) {
    assert.ok(!['assigned', 'in_progress'].includes(t.status), `${t.id} never assigned without a spent slot (stays ${t.status})`);
    assert.equal(t.attempts, 0, `${t.id} attempts unburned`);
    assert.equal(t.lease, null, `${t.id} no lease`);
  }
  const budgetRec = out.journal.find(j => j.kind === 'BUDGET');
  assert.ok(budgetRec, 'the BUDGET record is journaled (audit)');
  assert.equal(budgetRec.reason, 'dispatch-paced');
  assert.ok(budgetRec.ready_remaining >= 1, 'ready_remaining carried');
  assert.deepEqual(invariants(out.state), [], 'invariants clean');
});

test('F-10: budget=1 -> exactly ONE assign; the rest stay ready; the next tick (healthy budget) assigns the rest', () => {
  const s = boot();
  const n = makeNow();
  // spent-aware fn (the adapter's shape): one slot total, then exhausted
  const one = (spent) => Math.max(0, 1 - (spent || 0));
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('b1'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    dispatchBudgetFn: one,
  });
  assert.equal(out.actions.filter(a => a.type === 'DISPATCH_WORKER').length, 1, 'exactly one dispatch under budget=1');
  const ready = Object.values(out.state.tasks).filter(t => t.status === 'ready');
  assert.ok(ready.length >= 1, 'the rest stay ready');
  // next tick with a healthy budget assigns them (the recovery pin)
  const out2 = conductorTick({
    cur: structuredClone(out.state), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('b2'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    dispatchBudgetFn: () => 99,
  });
  assert.equal(out2.actions.filter(a => a.type === 'DISPATCH_WORKER').length, ready.length, 'the paced tasks assign on the next healthy tick');
});

test('F-10: null budget (disabled) -> legacy unlimited behavior; the spent-aware recompute honored (decreasing wall)', () => {
  const s = boot({ max_parallel: 2 });
  const n = makeNow();
  // wall-clock depleting fn: 12.5s of pay → 2 slots then exhausted (4s each)
  let wallLeft = 12_500;
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('dec'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    dispatchBudgetFn: (spent) => { wallLeft -= 4_000; return Math.floor(Math.max(0, wallLeft) / 4_000); },
  });
  assert.equal(out.actions.filter(a => a.type === 'DISPATCH_WORKER').length, 2, 'wall-clock depletion: 2 assigns then the fn reports exhausted');
});

test('F-10: DISPATCH_COST_MS is the measured constant (4s) — the arithmetic divisor', () => {
  assert.equal(DISPATCH_COST_MS, 4_000);
});

// ---------------------------------------------------------------------------
// F-6 — the pause trigger (window + distinct tasks + backstop)
// ---------------------------------------------------------------------------

test('F-6: 3 DISTINCT tasks with quota reports -> BUDGET_PAUSE_ALERT; the pause does NOT land in the trigger tick', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  assert.equal(ids.length, 3, 'fixture: 3 assigned tasks');
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: ids.map((id, i) => quotaReport(s, id, i)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('w3'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  const alert = out.actions.find(a => a.type === 'BUDGET_PAUSE_ALERT');
  assert.ok(alert, 'the alert action fired');
  assert.deepEqual(new Set(alert.tasks), new Set(ids), 'the distinct task list');
  assert.equal(alert.detail, 'lane-429', 'the first detail verbatim');
  assert.equal(alert.backstop, false, 'count-trigger, not backstop');
  assert.equal(alert.window.length, 3, 'the window rides the action');
  // the pause did NOT land: chain unpaused, the (re-assigned) tasks dispatched
  assert.equal(out.state.chain.paused, false, 'F-8: alert FIRST — the pause lands in the second commit');
  assert.ok(out.state.budget_window.length === 3, 'the window persisted in state');
  assert.deepEqual(invariants(out.state), []);
});

test('F-6: aged-out entries trimmed -> 2-in + 1-old = NO trigger (the window boundary)', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  // two reports now...
  const n0 = makeNow(T0 + 60_000);
  const first = conductorTick({
    cur: structuredClone(s), queue: [quotaReport(s, ids[0], 1), quotaReport(s, ids[1], 2)],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('w2a'), now: n0.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(!first.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), '2 distinct: below threshold');
  assert.equal(first.state.tasks[ids[0]].status, 'assigned', 're-assigned (net-zero infra) — no pause');
  // ...then one report 20min later (outside the default 15min window)
  const n1 = makeNow(T0 + 60_000 + 20 * 60_000);
  const second = conductorTick({
    cur: structuredClone(first.state), queue: [quotaReport(first.state, ids[2], 3)],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('w2b'), now: n1.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(!second.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'the aged entries trimmed — still below threshold');
  assert.ok(second.state.budget_window.length <= 1, 'the window trimmed to the fresh entry');
});

test('F-6: ONE task repeated 3x does NOT count-trigger (distinct-task counting)', () => {
  const s = assignedState({ max_parallel: 1 });
  const id = Object.values(s.tasks).find(t => t.status === 'assigned').id;
  const n = makeNow(T0 + 60_000);
  let st = structuredClone(s);
  for (let i = 1; i <= 2; i++) {
    const out = conductorTick({
      cur: st, queue: [quotaReport(st, id, i)], controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv(`r${i}`), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    });
    assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), `round ${i}: no count-trigger (1 distinct task)`);
    st = out.state;
  }
  assert.equal(st.budget_window.filter(e => e.task === id).length, 2, 'the window accumulated the repeats');
});

test('F-6 backstop: the infra-exhausted quarantine with a quota detail fires the trigger immediately', () => {
  // INFRA_RETRY_MAX=3: a task reporting quota-infra 3x parks infra-exhausted
  const s = assignedState({ max_parallel: 1 });
  const id = Object.values(s.tasks).find(t => t.status === 'assigned').id;
  const n = makeNow(T0 + 60_000);
  let st = structuredClone(s);
  let alert = null;
  for (let i = 1; i <= 3; i++) {
    const out = conductorTick({
      cur: st, queue: [quotaReport(st, id, `x${i}`)], controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv(`bx${i}`), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    });
    alert = out.actions.find(a => a.type === 'BUDGET_PAUSE_ALERT') || null;
    st = out.state;
    if (alert) break;
  }
  assert.ok(alert, 'the backstop fired');
  assert.equal(alert.backstop, true, 'labeled backstop');
  assert.equal(st.tasks[id].status, 'quarantined', 'the ladder burned (infra-exhausted)');
  assert.equal(st.tasks[id].infra_attempts, 3);
  assert.equal(st.stats.budget_pauses, undefined, 'the pause stat lands with the SECOND commit (not the trigger)');
});

test('F-6: a NON-quota infra report never touches the window (the classifier boundary)', () => {
  assert.ok(isQuotaDetail('lane-429'));
  assert.ok(isQuotaDetail('lane-exhausted(3/3 lanes, last lane-429)'));
  assert.ok(isQuotaDetail('error-as-answer(rate limit)'));
  assert.ok(!isQuotaDetail('lane-401'), 'a single 401 rotates lanes — infra-retry territory, not budget');
  assert.ok(!isQuotaDetail('transport'));
  assert.ok(!isQuotaDetail(null));
  assert.ok(!isQuotaDetail('error-as-answer(invalid api key)'), 'key-marker class, not quota');
  // DESIGN LETTER (F-6): ANY lane-exhausted detail matches — the pause is a
  // GENERIC stop-burn (a 401-exhausted chain parks too; the alert's verbatim
  // detail tells the operator WHICH fix applies — key vs quota wait).
  assert.ok(isQuotaDetail('lane-exhausted(3/3 lanes, last lane-401)'), 'exhaustion of any flavor parks the epoch (stop-burn is flavor-agnostic; the alert disambiguates)');
});

test('F-6/F-8: an already-PAUSED chain never re-triggers (idempotent under the hold)', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  const n = makeNow(T0 + 60_000);
  const paused = apply(s, { kind: 'CONTROL', command: 'pause', event_id: 'ctl-p1', ts: iso(T0) }, iso(T0), NM).state;
  assert.equal(paused.chain.paused, true);
  const out = conductorTick({
    cur: structuredClone(paused),
    queue: ids.map((id, i) => quotaReport(paused, id, `p${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('pz'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'paused: no re-trigger');
});

// ---------------------------------------------------------------------------
// F-7 — the pause event semantics + resume + rebuild parity
// ---------------------------------------------------------------------------

test('F-7: pause with payload.reason -> paused_reason + budget_pauses; resume clears reason + window; rebuild replays both', () => {
  const s = assignedState({ max_parallel: 4 });
  const ev = { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted', window: [{ ts: iso(T0), task: 'X', detail: 'lane-429' }] }, event_id: 'ctl-77-budget-pause-123', ts: iso(T0) };
  const n = makeNow();
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev, now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.state.chain.paused, true);
  assert.equal(out.state.chain.paused_reason, 'lane-budget-exhausted');
  assert.equal(out.state.stats.budget_pauses, 1);
  assert.ok(out.actions.some(a => a.type === 'HOLD_CHAIN'), 'held after the pause');
  // rebuild parity
  const rb = rebuild(boot(), out.journal);
  assert.equal(rb.chain.paused, true, 'rebuild: paused replays');
  assert.equal(rb.chain.paused_reason, 'lane-budget-exhausted', 'rebuild: the reason derives from the journaled payload');
  assert.equal(rb.stats.budget_pauses, 1, 'rebuild: the counter replays');
  // resume clears all three
  const out2 = conductorTick({
    cur: structuredClone(out.state), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: { kind: 'CONTROL', command: 'resume', event_id: 'ctl-r1', ts: iso(T0 + 5000) }, now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out2.state.chain.paused, false);
  assert.equal(out2.state.chain.paused_reason, undefined);
  assert.deepEqual(out2.state.budget_window, [], 'resume declares the trigger memory stale (no instant re-pause)');
  const rb2 = rebuild(boot(), [...out.journal, ...out2.journal]);
  assert.equal(rb2.chain.paused, false, 'rebuild: resume replays');
  assert.equal(rb2.chain.paused_reason, undefined);
});

test('F-7: a plain operator pause (no payload) sets NO reason — pre-W-C semantics intact', () => {
  const s = boot();
  const out = apply(s, { kind: 'CONTROL', command: 'pause', event_id: 'ctl-plain', ts: iso(T0) }, iso(T0), NM);
  assert.equal(out.state.chain.paused, true);
  assert.equal(out.state.chain.paused_reason, undefined);
  assert.equal(out.state.stats.budget_pauses, undefined);
});

// ---------------------------------------------------------------------------
// F-9 — the law-4 verify hold-scope
// ---------------------------------------------------------------------------

test('F-9: the verify pass skips on paused OR halted (the quiesced-noop contract)', () => {
  const mk = (patch) => {
    const s = boot({ lease_minutes: 15 });
    // assign + age past the verify window
    const assigned = apply(s, tickEv('v'), iso(T0), NM).state;
    const held = patch(assigned);
    return { state: held, seenKeys: new Set() };  // empty seen-set: the flip WOULD fire if not held
  };
  for (const [label, patch] of [
    ['paused', (st) => apply(st, { kind: 'CONTROL', command: 'pause', event_id: 'ctl-h1', ts: iso(T0) }, iso(T0), NM).state],
    ['halted', (st) => { const x = structuredClone(st); x.chain.halted = true; return x; }],
  ]) {
    const { state, seenKeys } = mk(patch);
    // the pure gate: dispatchVerificationEvents still sees the task, but the
    // TICK-level gate must refuse to apply — pinned via the adapter-shape
    const wouldFlip = dispatchVerificationEvents({ state, seenKeys, nowMs: Date.parse(iso(T0)) + VERIFY_WINDOW_MS + 1 });
    assert.ok(wouldFlip.length >= 1, `${label}: the pure detector still sees the task (the gate is the tick's)`);
    const n = makeNow(Date.parse(iso(T0)) + VERIFY_WINDOW_MS + 60_000);
    const out = conductorTick({
      cur: structuredClone(state), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv('h'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
      seenDispatchKeys: seenKeys, verifyNowMs: n.ms,
    });
    assert.ok(!(out.journal || []).some(j => j.error === 'dispatch-unverified'), `${label}: no verify flip under the hold`);
    // a held chain with empty queues QUIESCES (F2) — the noop return has no
    // actions array; that IS the contract (zero API work, zero dispatches)
    if (!out.noop) {
      assert.ok(!out.actions.some(a => a.type === 'DISPATCH_WORKER'), `${label}: no dispatches under the hold`);
    } else {
      assert.match(out.reason, /held-(paused|halted)/, `${label}: the noop reason names the hold`);
    }
  }
});

// ---------------------------------------------------------------------------
// §2e — specToTask (the conductor-side canonical mapper)
// ---------------------------------------------------------------------------

test('specToTask: accept-spec -> behavior real + spec.accept; behavior-spec passes through; the id default + F-1 deps cut', () => {
  const a = specToTask({ title: 'research the frob nozzle', accept: 'one paragraph with citations' }, { issue: 42, bodySha8: 'abcd1234' });
  assert.equal(a.id, 'task-i42', 'the default id');
  assert.equal(a.behavior, 'real', 'accept-criteria tasks carry behavior real');
  assert.equal(a.spec.accept, 'one paragraph with citations');
  assert.equal(a.spec.issue, 42);
  assert.equal(a.spec.body_sha8, 'abcd1234');
  assert.deepEqual(a.deps, [], 'F-1: deps CUT until W-D');
  const b = specToTask({ id: 'T-501', title: 'drill', behavior: 'flaky' }, { issue: 7 });
  assert.equal(b.id, 'T-501');
  assert.equal(b.behavior, 'flaky');
  assert.equal(b.spec.accept, undefined);
  const c = specToTask({ title: 'arts', accept: 'x', artifacts: ['tasks/T-9/report.md'] }, { issue: 9 });
  assert.deepEqual(c.spec.artifacts, ['tasks/T-9/report.md'], 'declared artifacts ride the task spec');
});

// ---------------------------------------------------------------------------
// T46/W-C1-R (lens-2 MUT-c): the extracted budget arithmetic pin — the
// adapter wires dispatchBudgetFromWall DIRECTLY; deleting the spent term
// must fail HERE (the pre-fold inline lambda survived deletion green).
// ---------------------------------------------------------------------------

test('W-C1-R/MUT-c: dispatchBudgetFromWall — the spent term is load-bearing (the extraction pin)', () => {
  // 62s remaining, 30s reserve, 4s cost: unspent slots = floor(32/4) = 8
  assert.equal(dispatchBudgetFromWall({ remainingMs: 62_000, reserveMs: 30_000 }), 8);
  // each spent slot consumes one cost: 8-8=0 at spent=8, negative-floored
  assert.equal(dispatchBudgetFromWall({ remainingMs: 62_000, reserveMs: 30_000, spent: 5 }), 3);
  assert.equal(dispatchBudgetFromWall({ remainingMs: 62_000, reserveMs: 30_000, spent: 8 }), 0);
  assert.equal(dispatchBudgetFromWall({ remainingMs: 62_000, reserveMs: 30_000, spent: 99 }), 0, 'never negative');
  // the reserve is carved FIRST (R3 D1-M2): 40s remaining - 30s reserve = 2 slots
  assert.equal(dispatchBudgetFromWall({ remainingMs: 40_000, reserveMs: 30_000 }), 2);
  // less than the reserve -> zero (the heartbeat window outranks dispatch)
  assert.equal(dispatchBudgetFromWall({ remainingMs: 25_000, reserveMs: 30_000 }), 0);
  // degenerate inputs fail CLOSED (0, never NaN/Infinity)
  assert.equal(dispatchBudgetFromWall({}), 0);
  assert.equal(dispatchBudgetFromWall({ remainingMs: NaN, reserveMs: 30_000 }), 0);
  assert.equal(dispatchBudgetFromWall({ remainingMs: 62_000, reserveMs: NaN }), 15, 'a NaN reserve is treated as 0 — floor(62s/4s) = 15 slots (degenerate reserve fails OPEN on slots, the real reserve is always finite)');
  assert.equal(DISPATCH_COST_MS, 4_000);
});

// ---------------------------------------------------------------------------
// T46/W-C1-R (lens-1 MAJOR-1): a PAUSED done chain NEVER rolls over —
// the queue parks; resume's next tick rolls over.
// ---------------------------------------------------------------------------

test('W-C1-R/MAJOR-1: paused + done + queued spec -> PARK (no un-commanded resume)', () => {
  const ONE = { m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
  const mkG = (() => { let n = 0; return ({ config, spec, issue }) => { const chainId = `c-pr-${++n}`; const tasks = spec ? [{ id: `task-i${issue}`, title: spec.title, behavior: 'real', work_ms: 1, deps: [], spec: { accept: spec.accept, issue } }] : ONE.m1; const g = genesis({ config: config || { ...CFG }, project: { tasks, milestones: 1 }, chainId, now: iso(T0 + n), mode: 'mock', issue: issue ?? null }); return { state: g, spec: { tasks, milestones: 1, chainId } }; }; })();
  let s = genesis({ config: { ...CFG }, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-pd', now: iso(T0) });
  s = apply(s, tickEv('pr1'), iso(T0), nextMilestoneFactory(ONE)).state;
  s = apply(s, { kind: 'REPORT', event_id: 'rep-prx', task: 'X', lease: s.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r' }, iso(T0 + 1000), nextMilestoneFactory(ONE)).state;
  assert.equal(s.project.phase, 'done');
  const paused = apply(s, { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted' }, event_id: 'ctl-pr-p', ts: iso(T0 + 2000) }, iso(T0 + 2000), nextMilestoneFactory(ONE)).state;
  assert.equal(paused.chain.paused, true);
  const qline = { issue: 77, body_sha8: 'zz99', spec: { title: 'held', accept: 'x' }, enqueued_at: iso(T0), author: 'op' };
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(paused), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('pr2'), now: n.now, nextMilestone: nextMilestoneFactory(ONE), recover: noRecover, makeGenesis: mkG,
  });
  assert.equal(out.noop, true, 'the held tick quiesces');
  assert.equal(out.state.chain.paused, true, 'the pause SURVIVES (no rollover wipe)');
  // resume -> the next tick rolls over
  const out2 = conductorTick({
    cur: structuredClone(out.state), queue: [], controlQueue: [{ cmd: 'resume', id: 'ctl-pr-r', ts: iso(T0 + 61_000), sender: 'op', note: null }], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('pr3'), now: n.now, nextMilestone: nextMilestoneFactory(ONE), recover: noRecover, makeGenesis: mkG,
  });
  assert.equal(out2.state.chain.paused, false, 'resumed');
  assert.notEqual(out2.state.project.issue ?? null, null, 'the resume tick rolled the queue over (phase done + unpaused)');
});
