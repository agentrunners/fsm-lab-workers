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
//         quota-detailed quarantine. s25/A2-M1: the codex quota vocabulary
//         (the bare codex-<class> lane details + the lane-exhausted terminus
//         forms) arms BOTH the :758 window and the OR-backstop — and the
//         codex dead-key/upstream classes deliberately do NOT (the lens-1
//         F2 narrowing stands on the second engine).
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
  conductorTick, isQuotaDetail, specToTask, specLeaseMinutes, DISPATCH_COST_MS, dispatchBudgetFromWall,
  dispatchVerificationEvents, VERIFY_WINDOW_MS, tailServedFromOutcome, TAIL_ALERT_TURNS, TAIL_ALERT_WINDOW_MS,
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
  // W-D review fold (lens-1 F2) — the FALSE-PAUSE negative pin: the matcher
  // is narrowed to the QUOTA shape. The old bare `lane-exhausted(` prefix
  // matched every exhaustion flavor, so a 401-quarantined dead-key task
  // armed the F-6 window + the OR-backstop ⇒ BUDGET-PAUSE-TRIGGER on a
  // non-quota cause (the W-C1 design letter's "stop-burn is flavor-agnostic"
  // reading is SUPERSEDED: the pause parks the epoch for a quota WAIT, but
  // a dead key's remedy is a pool-secret SWAP — and the turn-side rotation
  // now recovers live keys within the turn, so parking buys nothing).
  assert.ok(!isQuotaDetail('lane-exhausted(3/3 lanes, last lane-401)'), 'dead-key exhaustion does NOT arm the budget pause');
  assert.ok(!isQuotaDetail('lane-exhausted(3/3 lanes, last lane-402)'), 'credits-death exhaustion does not either');
  assert.ok(!isQuotaDetail('lane-exhausted(3/3 lanes, last lane-503)'), 'upstream 5xx exhaustion does not');
  assert.ok(!isQuotaDetail('lane-exhausted(3/3 lanes, last lane-transport)'), 'transport walls do not');
  assert.ok(!isQuotaDetail('lane-exhausted(3/3 lanes, last dead-model-404)'), 'config (dead-model) exhaustion does not');
});

// s25/A2-M1 (the codex quota arm, unit boundary): the second engine's quota
// vocabulary at the matcher itself. The codex lane detail is `codex-<class>`
// (codexLaneOutcome's rotate detail, worker/codex-adapter.mjs:378) and the
// lane-exhaustion terminus embeds the last class verbatim
// (`lane-exhausted(n/m lanes, last codex-<class>)`, :867) — so the two
// RATE/QUOTA classes must match in BOTH forms. The dead-key classes
// (error_credits/error_auth) deliberately do NOT: the W-D lens-1 F2
// narrowing was CORRECT for them (a 401/402-quarantined key's remedy is a
// pool-secret SWAP, not a quota wait — the key-class JUMP + the turn-side
// rotation recover within the turn); upstream (network), config
// (model-400) and transient (in-flight-budget) stay out for the same
// reason as their CC twins above.
test('F-6 codex (s25/A2-M1): the codex quota classes match in BOTH forms; the dead-key/upstream classes do NOT', () => {
  // the two quota classes — the bare lane-detail form (codex-adapter.mjs:378)
  assert.ok(isQuotaDetail('codex-error_rate_limit'), 'the bare rate-limit lane detail arms');
  assert.ok(isQuotaDetail('codex-error_quota_daily'), 'the bare daily-quota lane detail arms');
  // ...and the lane-exhaustion terminus form (:867 embeds the last class verbatim)
  assert.ok(isQuotaDetail('lane-exhausted(3/3 lanes, last codex-error_rate_limit)'), 'the rate-limit terminus arms (substring embedding, the lane-429 precedent)');
  assert.ok(isQuotaDetail('lane-exhausted(2/4 lanes, last codex-error_quota_daily)'), 'the daily-quota terminus arms');
  // the deliberate exclusions — dead-key (the lens-1 F2 narrowing stands on codex)
  assert.ok(!isQuotaDetail('codex-error_credits'), 'credits-death (402) is a pool-secret swap, not a quota wait');
  assert.ok(!isQuotaDetail('codex-error_auth'), 'dead-key auth (401) does NOT arm the budget window');
  assert.ok(!isQuotaDetail('lane-exhausted(3/3 lanes, last codex-error_auth)'), 'a codex dead-key exhaustion terminus does not either');
  assert.ok(!isQuotaDetail('lane-exhausted(2/4 lanes, last codex-error_credits)'), 'nor a credits-death terminus (the test-codex-adapter :188 shape)');
  // ...and the rest of the codex rotatable vocabulary (upstream/config/transient)
  assert.ok(!isQuotaDetail('codex-error_network'), 'upstream/transport stays infra-retry territory');
  assert.ok(!isQuotaDetail('codex-error_model_400'), 'config (provider 400) does not arm');
  assert.ok(!isQuotaDetail('codex-error_in_flight_budget'), 'the in-flight-budget transient does not arm');
});

// T46/W-D review fold (lens-1 F2) — the FALSE-PAUSE integration negative:
// the full dead-key ladder (3 infra reports, detail = the 401 exhaustion
// shape) parks the task infra-exhausted WITHOUT firing the OR-backstop or
// the window. Pre-fold this exact sequence minted BUDGET-PAUSE-TRIGGER on a
// non-quota cause.
test('F-6 false-pause (the fold, lens-1 F2): a 401-quarantined dead-key task does NOT fire the OR-backstop', () => {
  const s = assignedState({ max_parallel: 1 });
  const id = Object.values(s.tasks).find(t => t.status === 'assigned').id;
  const n = makeNow(T0 + 60_000);
  let st = structuredClone(s);
  for (let i = 1; i <= 3; i++) {
    const out = conductorTick({
      cur: st,
      queue: [quotaReport(st, id, `dk${i}`, 'lane-exhausted(3/3 lanes, last lane-401)')],
      controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv(`dk${i}`), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    });
    assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), `round ${i}: NO alert on the dead-key class`);
    st = out.state;
  }
  assert.equal(st.tasks[id].status, 'quarantined', 'the infra ladder itself is flavor-agnostic — the task still parks');
  assert.equal(st.tasks[id].infra_attempts, 3);
  assert.ok(!Array.isArray(st.budget_window) || st.budget_window.length === 0, 'the budget window stayed EMPTY (no false quota entry)');
});

// s25/A2-M1 (the codex integration pins): the REAL trigger path driven with
// codex-shaped infra reports — exactly how a codex epoch's quota wall would
// arrive (the worker enqueues outcome.error = the codexTurn detail; the
// quotaReport helper carries it in the same field). Both arms key through
// isQuotaDetail in the live code: the window/count trigger at
// conductor-core.mjs:758 (`oc.status === 'infra_failed' && isQuotaDetail(oc.error
// ?? oc.detail)`) and the infra-exhausted OR-backstop at :769-770
// (`exRec && isQuotaDetail(exRec.error)`). Until the s25 fix these codex
// details never matched: the burn ran 3 full infra-retry re-turns per task
// into infra-exhausted quarantine with NO pause and NO alert-first.
test('F-6 codex (s25/A2-M1): 3 DISTINCT tasks with codex quota reports -> BUDGET_PAUSE_ALERT (the :758 window arm)', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  assert.equal(ids.length, 3, 'fixture: 3 assigned tasks');
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: ids.map((id, i) => quotaReport(s, id, i, 'codex-error_rate_limit')),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('cx3'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  const alert = out.actions.find(a => a.type === 'BUDGET_PAUSE_ALERT');
  assert.ok(alert, 'the codex quota wall arms the count-trigger (was: silent pre-s25)');
  assert.deepEqual(new Set(alert.tasks), new Set(ids), 'the distinct task list');
  assert.equal(alert.detail, 'codex-error_rate_limit', 'the codex detail rides the alert verbatim');
  assert.equal(alert.backstop, false, 'count-trigger, not backstop');
  assert.equal(out.state.budget_window.length, 3, 'the window persisted all three codex entries');
  assert.deepEqual(invariants(out.state), []);
});

test('F-6 codex backstop (s25/A2-M1): the infra-exhausted quarantine with a codex lane-exhausted terminus fires the OR-backstop', () => {
  // the terminus form `lane-exhausted(n/m lanes, last codex-error_quota_daily)`
  // (codex-adapter.mjs:867) through the FULL ladder: 3 same-task reports →
  // infra-exhausted quarantine → the :769-770 backstop fires IMMEDIATELY.
  const s = assignedState({ max_parallel: 1 });
  const id = Object.values(s.tasks).find(t => t.status === 'assigned').id;
  const n = makeNow(T0 + 60_000);
  let st = structuredClone(s);
  let alert = null;
  for (let i = 1; i <= 3; i++) {
    const out = conductorTick({
      cur: st,
      queue: [quotaReport(st, id, `cx${i}`, 'lane-exhausted(4/4 lanes, last codex-error_quota_daily)')],
      controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv(`cxb${i}`), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    });
    alert = out.actions.find(a => a.type === 'BUDGET_PAUSE_ALERT') || null;
    st = out.state;
    if (alert) break;
  }
  assert.ok(alert, 'the codex backstop fired (was: quarantine with no alert pre-s25)');
  assert.equal(alert.backstop, true, 'labeled backstop');
  assert.equal(st.tasks[id].status, 'quarantined', 'the ladder burned (infra-exhausted)');
  assert.equal(st.tasks[id].infra_attempts, 3);
  assert.equal(st.stats.budget_pauses, undefined, 'the pause stat lands with the SECOND commit (not the trigger)');
});

// s25/A2-M1 (the codex false-pause negative — the lens-1 F2 fold stands on
// the second engine): a codex DEAD-KEY exhaustion terminus (last
// codex-error_auth) parks the task infra-exhausted WITHOUT arming the
// window or the OR-backstop — the operator remedy is a pool-secret swap,
// not a quota wait.
test('F-6 codex false-pause (s25/A2-M1): a codex dead-key terminus does NOT arm the window or the OR-backstop', () => {
  const s = assignedState({ max_parallel: 1 });
  const id = Object.values(s.tasks).find(t => t.status === 'assigned').id;
  const n = makeNow(T0 + 60_000);
  let st = structuredClone(s);
  for (let i = 1; i <= 3; i++) {
    const out = conductorTick({
      cur: st,
      queue: [quotaReport(st, id, `cxa${i}`, 'lane-exhausted(4/4 lanes, last codex-error_auth)')],
      controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv(`cxa${i}`), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    });
    assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), `round ${i}: NO alert on the codex dead-key class`);
    st = out.state;
  }
  assert.equal(st.tasks[id].status, 'quarantined', 'the infra ladder itself is flavor-agnostic — the task still parks');
  assert.equal(st.tasks[id].infra_attempts, 3);
  assert.ok(!Array.isArray(st.budget_window) || st.budget_window.length === 0, 'the budget window stayed EMPTY (no false codex quota entry)');
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

// ---------------------------------------------------------------------------
// s21/C-3 — the straggler re-pause race (live-observed 3x: X23's re-pause,
// the s20 close's 4th) — the cohort gate. Resume stamps
// budget_window_cleared_at; a quota report whose lease predates the stamp
// is a straggler of the OLD storm: journaled (operator audit) but excluded
// from the count-trigger AND the backstop. A genuinely-new storm (leases
// issued post-clear) still triggers.
// ---------------------------------------------------------------------------

test('s21/C-3: post-resume stragglers (pre-clear leases) do NOT re-trigger — the false re-pause is dead', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  // round 1: the original storm -> alert (window 3, distinct 3)
  const n1 = makeNow(T0 + 60_000);
  const r1 = conductorTick({
    cur: structuredClone(s), queue: ids.map((id, i) => quotaReport(s, id, i)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('st1'), now: n1.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(r1.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'round 1: the alert fired (the real storm)');
  // the storm's re-assignments carry leases issued at r1's clock (T0+60s+)
  // pause (T0+120s), then resume (T0+180s) — the clear stamp
  let st = apply(r1.state, { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted' }, event_id: 'ctl-c3-p', ts: iso(T0 + 120_000) }, iso(T0 + 120_000), NM).state;
  st = apply(st, { kind: 'CONTROL', command: 'resume', event_id: 'ctl-c3-r', ts: iso(T0 + 180_000) }, iso(T0 + 180_000), NM).state;
  assert.equal(st.chain.paused, false, 'resumed');
  assert.equal(st.budget_window.length, 0, 'the window cleared');
  assert.ok(st.budget_window_cleared_at, 'the clear stamp landed');
  // round 2: THE RACE — the paused cohort's in-flight grinds report post-resume.
  // Their leases were issued at r1's clock (< the T0+180s stamp) -> stragglers.
  const n2 = makeNow(T0 + 240_000);
  const r2 = conductorTick({
    cur: structuredClone(st), queue: ids.map((id, i) => quotaReport(st, id, `str${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('st2'), now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(!r2.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'THE RACE IS DEAD: 3 straggler reports, no re-pause');
  assert.equal(r2.state.budget_window.length, 3, 'the stragglers are journaled (operator audit)');
  assert.ok(r2.state.budget_window.every(e => e.straggler === true), 'every entry marked straggler: true');
  // honest inverse: a genuinely NEW storm — r2's drain re-assigned with
  // leases at r2's clock (> the stamp) -> 3 distinct non-stragglers -> ALERT
  const n3 = makeNow(T0 + 300_000);
  const r3 = conductorTick({
    cur: structuredClone(r2.state), queue: ids.map((id, i) => quotaReport(r2.state, id, `new${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('st3'), now: n3.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(r3.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'honest inverse: a NEW storm still triggers');
  assert.deepEqual(invariants(r3.state), []);
});

test('s21/C-3: the straggler gate is inert without a resume (fresh chain counts everything)', () => {
  // no resume ever -> no stamp -> no straggler marking: the original F-6
  // semantics unchanged (the 3-distinct alert fires on the first storm).
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: ids.map((id, i) => quotaReport(s, id, `f${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('st4'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'no stamp -> no gating (F-6 unchanged)');
  assert.ok(out.state.budget_window.every(e => !e.straggler), 'no straggler marks without a clear stamp');
});

test('s21/C-3: a straggler\'s terminal infra-exhausted quarantine does NOT arm the backstop (stale pre-clear lane state)', () => {
  // one task leased PRE-clear burns its full ladder POST-resume: the
  // infra-exhausted quarantine lands (correct — the ladder is real) but the
  // quota backstop must NOT fire (the report reflects the pre-resume lane).
  const s = assignedState({ max_parallel: 1 });
  const id = Object.values(s.tasks).find(t => t.status === 'assigned').id;
  const n0 = makeNow(T0 + 60_000);
  // two infra quota failures pre-pause (attempts 1->2, lease re-issued each time)
  let st = structuredClone(s);
  for (let i = 1; i <= 2; i++) {
    const r = conductorTick({
      cur: st, queue: [quotaReport(st, id, `bb${i}`)], controlQueue: [], queueBad: [], ctlBad: [],
      ev: tickEv(`bb${i}`), now: n0.now, nextMilestone: NM, recover: noRecover, makeGenesis,
    });
    st = r.state;
  }
  // pause + resume (stamp at T0+180s; the task's current lease is from the
  // round-2 re-assign at T0+60s+ -> pre-clear)
  st = apply(st, { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted' }, event_id: 'ctl-c3b-p', ts: iso(T0 + 120_000) }, iso(T0 + 120_000), NM).state;
  st = apply(st, { kind: 'CONTROL', command: 'resume', event_id: 'ctl-c3b-r', ts: iso(T0 + 180_000) }, iso(T0 + 180_000), NM).state;
  // the straggler's THIRD failure -> attempts=3 -> infra-exhausted quarantine
  const n2 = makeNow(T0 + 240_000);
  const r = conductorTick({
    cur: structuredClone(st), queue: [quotaReport(st, id, 'bb3')], controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('bb3'), now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(r.state.tasks[id].status, 'quarantined', 'the ladder-burn quarantine lands (attempts are real)');
  assert.ok(r.state.tasks[id].history.some(h => h.why === 'infra-exhausted' || h.status === 'quarantined'), 'the quarantine is journaled');
  assert.ok(!r.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'the backstay/backstop did NOT arm from the straggler (stale pre-clear lane state)');
  assert.ok((r.state.budget_window || []).every(e => e.straggler), 'the terminal entry is straggler-marked');
});

// ---------------------------------------------------------------------------
// s21/A4-F1 — the lease_minutes carry (the door-validated knob actually
// lands in the genesis config — was silently dropped; the d2 agent's code,
// the orchestrator's pins). s22/B-1 adds the FLOOR: the carried value is
// bounded to [LEASE_FLOOR_MINUTES(3), 120] (the envelope deadline =
// min(lease,48) − 120s must be > 0 at assign — a carried 1-2 is the
// work-destroying trap lens-1 verified live in the e2e recovery drill).
// ---------------------------------------------------------------------------

test('s21/A4-F1 + s22/B-1: specLeaseMinutes — the door-bounds parse ([1,120] in, FLOOR 3 out; the YAML string case)', () => {
  assert.equal(specLeaseMinutes({ lease_minutes: '45' }), 45, 'the string form (the door keeps YAML scalars as strings)');
  assert.equal(specLeaseMinutes({ lease_minutes: 60 }), 60, 'the int form');
  assert.equal(specLeaseMinutes({ lease_minutes: 3 }), 3, 'the floor itself passes through');
  // THE s22/B-1 CLAMP: 1-2 are in the parse window but OUT of the safe
  // window — the carry floors them (a pre-floor queue line still lands a
  // sane lease; the door now REJECTS these at intake)
  assert.equal(specLeaseMinutes({ lease_minutes: 2 }), 3, 'the trap value 2 clamps UP to the floor 3');
  assert.equal(specLeaseMinutes({ lease_minutes: '1' }), 3, 'the trap value 1 (string form) clamps to 3');
  assert.equal(specLeaseMinutes({ lease_minutes: 0 }), null, 'below the parse window -> null (the chain config stands)');
  assert.equal(specLeaseMinutes({ lease_minutes: 121 }), null, 'above bounds');
  assert.equal(specLeaseMinutes({ lease_minutes: 'garbage' }), null, 'NaN-safe');
  assert.equal(specLeaseMinutes({}), null, 'absent -> null (the chain config stands)');
  assert.equal(specLeaseMinutes(null), null, 'null-spec safe');
});

// s22/B-1 + R2-4a: the CARRY pins — the floor is load-bearing at BOTH carry
// sites (the rollover and the reset from_queue). A spec with lease_minutes=45
// must land state.config.lease_minutes === 45; a pre-floor spec (2) must land
// the FLOOR 3 (the deadline = min(lease,48) − 120s must be > 0 at assign).
// Inverts cleanly: floor the clamp away and the =3 pins fail (mutation check).
test('s22/B-1 + R2-4a: the carry lands lease_minutes in the genesis config — the rollover lane AND the reset from_queue lane', () => {
  const carry = (spec, { lane = 'rollover', patch = {} } = {}) => {
    // a DONE+HALTED epoch (the rollover shape) + one queued spec line
    const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
    let s = genesis({ config: CFG, project: { tasks: ONE.m1, milestones: 1 }, chainId: `c-b1-${Math.random().toString(36).slice(2, 8)}`, now: '2026-09-06T10:00:00.000Z' });
    s = apply(s, { kind: 'TICK', event_id: 'tk-b1', ts: '2026-09-06T10:00:00.000Z', actor: 'chain' }, '2026-09-06T10:00:00.000Z', nextMilestoneFactory(ONE)).state;
    s = apply(s, { kind: 'REPORT', event_id: 'rep-b1', task: 'X', lease: s.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r' }, '2026-09-06T10:00:01.000Z', nextMilestoneFactory(ONE)).state;
    assert.equal(s.project.phase, 'done');
    const qline = { issue: 51, body_sha8: 'b1abcd12', spec: { title: 'carry pin', accept: 'x', ...spec }, enqueued_at: '2026-09-06T10:00:02.000Z', author: 'op' };
    const ctl = lane === 'direct-reset'
      ? [{ cmd: 'reset', id: 'ctl-b1-rq', ts: '2026-09-06T10:00:03.000Z', sender: 'op', note: 'carry pin', patch: { from_queue: true } }]
      : [];
    const out = conductorTick({
      cur: structuredClone(s), queue: [], controlQueue: ctl, queueBad: [], ctlBad: [],
      intakeQueue: [qline], intakeBad: [],
      ev: lane === 'direct-reset' ? { kind: 'CONTROL', command: 'reset', event_id: 'ctl-b1-direct', ts: '2026-09-06T10:00:03.000Z', patch: { from_queue: true } } : { kind: 'TICK', event_id: 'tk-b1b', ts: '2026-09-06T10:00:04.000Z', actor: 'chain' },
      now: () => '2026-09-06T10:00:05.000Z', nextMilestone: nextMilestoneFactory(ONE), recover: () => null,
      makeGenesis: ({ config, spec, issue }) => {
        const g = genesis({
          config, project: { tasks: [{ id: spec?.id || `task-i${issue}`, title: spec?.title || `intake ${issue}`, behavior: spec?.behavior || 'real', work_ms: 4000, deps: [], spec: { accept: spec?.accept, issue } }], milestones: 1 },
          chainId: `c-b1-g-${Math.random().toString(36).slice(2, 8)}`, now: '2026-09-06T10:00:05.000Z', issue: issue ?? null,
        });
        return { state: g, spec: { tasks: [], milestones: 1, chainId: 'c-b1-g', mode: 'mock' } };
      },
    });
    return out;
  };
  // the rollover lane: 45 rides verbatim; 2 lands the floor
  const r45 = carry({ lease_minutes: 45 });
  assert.equal(r45.state.config.lease_minutes, 45, 'ROLLOVER: the spec 45 rides the genesis config verbatim');
  assert.equal(r45.journal.find(j => j.kind === 'CONTROL' && j.command === 'reset')?.genesisSpec?.config?.lease_minutes, 45, 'the journal genesisSpec carries 45 (rebuild replays the same lease)');
  const r2 = carry({ lease_minutes: 2 });
  assert.equal(r2.state.config.lease_minutes, 3, 'ROLLOVER: a pre-floor spec 2 lands the FLOOR 3 (the deadline stays > 0 at assign)');
  // the reset from_queue lane (direct dispatch): same two pins
  const d45 = carry({ lease_minutes: 45 }, { lane: 'direct-reset' });
  assert.equal(d45.state.config.lease_minutes, 45, 'RESET from_queue: the spec 45 rides the genesis config');
  const d2 = carry({ lease_minutes: 2 }, { lane: 'direct-reset' });
  assert.equal(d2.state.config.lease_minutes, 3, 'RESET from_queue: a pre-floor spec 2 lands the FLOOR 3');
  // absent lease -> the chain's current config stands (the A4-F1 null path)
  const rNone = carry({});
  assert.equal(rNone.state.config.lease_minutes, CFG.lease_minutes, 'absent lease_minutes: the chain config stands (15)');
});

// ---------------------------------------------------------------------------
// s22/B-1 commit 3 (the s22/Q1 adjudication): the CAPACITY-KNOB CARRY —
// the exact A4-F1 pattern, second knob pair. The spec's door-validated
// max_parallel/overflow_at land in the genesis config at BOTH carry sites
// (the rollover and the reset from_queue); absent/garbage -> the knob is
// absent -> the chain's standing config governs. Inverts cleanly: remove
// the carry and the =16/=1 pins fail (mutation check).
// ---------------------------------------------------------------------------

test('s22/B-1 commit 3: the capacity carry — max_parallel:16 + overflow_at:1 land in the genesis config at the ROLLOVER and the RESET from_queue', () => {
  const carry = (spec, { lane = 'rollover' } = {}) => {
    // a DONE+HALTED epoch (the rollover shape) + one queued spec line
    const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
    let s = genesis({ config: CFG, project: { tasks: ONE.m1, milestones: 1 }, chainId: `c-cap-${Math.random().toString(36).slice(2, 8)}`, now: '2026-09-06T10:00:00.000Z' });
    s = apply(s, { kind: 'TICK', event_id: 'tk-cap', ts: '2026-09-06T10:00:00.000Z', actor: 'chain' }, '2026-09-06T10:00:00.000Z', nextMilestoneFactory(ONE)).state;
    s = apply(s, { kind: 'REPORT', event_id: 'rep-cap', task: 'X', lease: s.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r' }, '2026-09-06T10:00:01.000Z', nextMilestoneFactory(ONE)).state;
    assert.equal(s.project.phase, 'done');
    const qline = { issue: 61, body_sha8: 'capabcd12', spec: { title: 'capacity carry pin', accept: 'x', ...spec }, enqueued_at: '2026-09-06T10:00:02.000Z', author: 'op' };
    const ctl = lane === 'direct-reset'
      ? [{ cmd: 'reset', id: 'ctl-cap-rq', ts: '2026-09-06T10:00:03.000Z', sender: 'op', note: 'capacity carry pin', patch: { from_queue: true } }]
      : [];
    const out = conductorTick({
      cur: structuredClone(s), queue: [], controlQueue: ctl, queueBad: [], ctlBad: [],
      intakeQueue: [qline], intakeBad: [],
      ev: lane === 'direct-reset' ? { kind: 'CONTROL', command: 'reset', event_id: 'ctl-cap-direct', ts: '2026-09-06T10:00:03.000Z', patch: { from_queue: true } } : { kind: 'TICK', event_id: 'tk-cap2', ts: '2026-09-06T10:00:04.000Z', actor: 'chain' },
      now: () => '2026-09-06T10:00:05.000Z', nextMilestone: nextMilestoneFactory(ONE), recover: () => null,
      makeGenesis: ({ config, spec, issue }) => {
        const g = genesis({
          config, project: { tasks: [{ id: spec?.id || `task-i${issue}`, title: spec?.title || `intake ${issue}`, behavior: spec?.behavior || 'real', work_ms: 4000, deps: [], spec: { accept: spec?.accept, issue } }], milestones: 1 },
          chainId: `c-cap-g-${Math.random().toString(36).slice(2, 8)}`, now: '2026-09-06T10:00:05.000Z', issue: issue ?? null,
        });
        return { state: g, spec: { tasks: [], milestones: 1, chainId: 'c-cap-g', mode: 'mock' } };
      },
    });
    return out;
  };
  // the rollover lane: BOTH knobs ride the genesis config
  const r = carry({ max_parallel: '16', overflow_at: '1' });
  assert.equal(r.state.config.max_parallel, 16, 'ROLLOVER: the spec max_parallel 16 rides the genesis config');
  assert.equal(r.state.config.overflow_at, 1, 'ROLLOVER: the spec overflow_at 1 rides the genesis config (a NEW config member — the pre-flight consumes it via the state.config precedence)');
  const rj = r.journal.find(j => j.kind === 'CONTROL' && j.command === 'reset');
  assert.equal(rj?.genesisSpec?.config?.max_parallel, 16, 'the journal genesisSpec carries 16 (rebuild replays the same posture)');
  assert.equal(rj?.genesisSpec?.config?.overflow_at, 1, 'the journal genesisSpec carries the overflow posture too');
  // the reset from_queue lane: the SAME two pins
  const d = carry({ max_parallel: '16', overflow_at: '1' }, { lane: 'direct-reset' });
  assert.equal(d.state.config.max_parallel, 16, 'RESET from_queue: the spec max_parallel 16 rides the genesis config');
  assert.equal(d.state.config.overflow_at, 1, 'RESET from_queue: the spec overflow_at 1 rides the genesis config');
  // absent knobs -> the chain's standing config governs (the null path)
  const none = carry({});
  assert.equal(none.state.config.max_parallel, CFG.max_parallel, 'absent max_parallel: the chain config stands (4)');
  assert.equal(none.state.config.overflow_at, undefined, 'absent overflow_at: the env lane stands (no config member minted)');
  // garbage (a pre-door queue line) -> null -> the standing posture, never a wide epoch
  const garbage = carry({ max_parallel: 'garbage', overflow_at: '99' });
  assert.equal(garbage.state.config.max_parallel, CFG.max_parallel, 'garbage max_parallel: the chain config stands');
  assert.equal(garbage.state.config.overflow_at, undefined, 'out-of-bounds overflow_at (99): no config member — the env lane stands');
  // ONE knob alone carries (the independent pair)
  const onlyMp = carry({ max_parallel: '2' });
  assert.equal(onlyMp.state.config.max_parallel, 2, 'max_parallel alone carries');
  assert.equal(onlyMp.state.config.overflow_at, undefined, 'overflow_at stays absent');
});

// ---------------------------------------------------------------------------
// s23/X27 — the genesis budget_window init + REJECTED-never-arms (EVIDENCE
// §X27 quirk 7: the fresh post-reset epoch re-paused 3s later — genesis did
// NOT initialize the window, and the dead epoch's straggler reports (REJECTED
// unknown-task, lane-429 details) armed the fresh chain's window). Two
// changes, five pins:
//   1. genesis initializes budget_window: [] + budget_window_cleared_at ===
//      the genesis now (an epoch boundary is a window-CLEAR boundary — the
//      same semantics as the resume control).
//   2. a report whose apply() produced a REJECTED journal record NEVER arms
//      the window or the backstop (the dead epoch's straggler traffic).
//   4. the C-3 straggler gate extends to the genesis boundary: a report
//      whose task EXISTS but whose lease predates the genesis stamp is
//      straggler-marked — excluded from the count-trigger.
//   5. rebuild parity: the reset replay + the pause/resume pair yield the
//      SAME window fields live produced (F8 additive safety).
// ---------------------------------------------------------------------------

test('s23/X27 pin 1: genesis initializes the window fields — budget_window:[] + budget_window_cleared_at === the genesis now', () => {
  const g = boot();
  assert.deepEqual(g.budget_window, [], 'the window is initialized EMPTY (absent-key "inherit whatever lands" is dead)');
  assert.ok(Number.isFinite(Date.parse(g.budget_window_cleared_at)), 'the clear stamp is a parseable timestamp');
  assert.equal(g.budget_window_cleared_at, iso(T0), 'the stamp === the genesis now (the epoch boundary IS a window-clear boundary)');
  assert.deepEqual(invariants(g), []);
  // the injected makeGenesis lane (the reset/rollover shape) carries it too
  const mg = makeGenesis({ config: { ...CFG } });
  assert.deepEqual(mg.state.budget_window, []);
  assert.ok(Number.isFinite(Date.parse(mg.state.budget_window_cleared_at)), 'the rollover genesis stamps too');
});

test('s23/X27 pin 4: the C-3 straggler gate extends to the GENESIS boundary — pre-genesis leases are stragglers, never count-trigger', () => {
  // The X27 v1-wipe shape at unit level: the fresh genesis stamps
  // budget_window_cleared_at = T0; the PREDECESSOR epoch's in-flight workers
  // carry leases issued BEFORE the stamp (the same task ids existing in both
  // epochs is the reset/rollover reality — mockProject M1 is stable). Their
  // quota reports are stragglers of the DEAD epoch: journaled for operator
  // audit, excluded from the fresh epoch's count-trigger.
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  assert.equal(ids.length, 3, 'fixture: 3 assigned tasks');
  const st = structuredClone(s);
  assert.equal(st.budget_window_cleared_at, iso(T0), 'fixture: the genesis stamp is in force (pin 1)');
  for (const id of ids) st.tasks[id].lease.issued_at = iso(T0 - 60_000);   // the predecessor cohort
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: st, queue: ids.map((id, i) => quotaReport(st, id, `gx${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('gx'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.state.budget_window.length, 3, 'the stragglers are journaled (operator audit)');
  assert.ok(out.state.budget_window.every(e => e.straggler === true), 'every entry carries straggler: true (the genesis stamp gates)');
  assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), '3 DISTINCT pre-genesis reports NEVER count-trigger (the genesis-boundary false re-pause is dead)');
  assert.deepEqual(invariants(out.state), []);
});

test('s23/X27 pin 5: rebuild parity — the reset replay + the pause/resume pair yield the SAME window fields live minted (F8 additive)', () => {
  // (a) the reset replay: a journaled CONTROL reset (genesisSpec.now) re-runs
  // genesis — the replayed fresh epoch carries the same EMPTY window + the
  // same stamp the live rollover minted (rebuild-DERIVED, never invented).
  const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
  let pre = genesis({ config: CFG, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'c-x27-rb', now: iso(T0) });
  pre = apply(pre, tickEv('rb1'), iso(T0), nextMilestoneFactory(ONE)).state;
  pre = apply(pre, { kind: 'REPORT', event_id: 'rep-rb1', task: 'X', lease: pre.tasks.X.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'r' }, iso(T0 + 1000), nextMilestoneFactory(ONE)).state;
  assert.equal(pre.project.phase, 'done');
  const GNOW = iso(T0 + 60_000);   // the rollover instant = the fresh epoch's genesis now
  const FRESH_TASKS = [{ id: 'task-i71', title: 'parity pin', behavior: 'real', work_ms: 4000, deps: [], spec: { accept: 'x', issue: 71 } }];
  const qline = { issue: 71, body_sha8: 'x27abcd12', spec: { title: 'parity pin', accept: 'x' }, enqueued_at: iso(T0), author: 'op' };
  const out = conductorTick({
    cur: structuredClone(pre), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [qline], intakeBad: [],
    ev: tickEv('rb2'), now: () => GNOW, nextMilestone: nextMilestoneFactory(ONE), recover: noRecover,
    makeGenesis: ({ config, issue }) => {
      const g = genesis({ config, project: { tasks: FRESH_TASKS, milestones: 1 }, chainId: 'c-x27-fresh', now: GNOW, issue: issue ?? null });
      return { state: g, spec: { tasks: FRESH_TASKS, milestones: 1, chainId: 'c-x27-fresh', mode: 'mock' } };
    },
  });
  assert.deepEqual(out.state.budget_window, [], 'live rollover: the fresh epoch starts with an EMPTY window');
  assert.equal(out.state.budget_window_cleared_at, GNOW, 'live rollover: the genesis stamp === the rollover instant');
  const rb = rebuild(pre, out.journal);
  assert.equal(rb.chain.id, 'c-x27-fresh', 'rebuild: the reset replayed into the fresh epoch');
  assert.deepEqual(rb.budget_window, [], 'rebuild: the reset replay carries the empty window');
  assert.equal(rb.budget_window_cleared_at, GNOW, 'rebuild: the stamp derives from the journaled genesisSpec.now (replay === live)');
  // (b) the pause/resume pair: live vs rebuild converge on BOTH fields.
  const s2 = assignedState({ max_parallel: 4 });
  const n2 = makeNow(T0 + 120_000);
  const p = conductorTick({
    cur: structuredClone(s2), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted' }, event_id: 'ctl-x27-p', ts: iso(T0 + 120_000) }, now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  const r = conductorTick({
    cur: structuredClone(p.state), queue: [], controlQueue: [], queueBad: [], ctlBad: [],
    ev: { kind: 'CONTROL', command: 'resume', event_id: 'ctl-x27-r', ts: iso(T0 + 180_000) }, now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.deepEqual(r.state.budget_window, [], 'live resume: the window cleared');
  const rb2 = rebuild(boot(), [...p.journal, ...r.journal]);
  assert.deepEqual(rb2.budget_window, [], 'rebuild: the resume replay clears the window');
  assert.equal(rb2.budget_window_cleared_at, r.state.budget_window_cleared_at, 'rebuild: the clear stamp === the live stamp (the journaled resume ts)');
  // (c) legacy neutrality: a pre-s23 genesis state (no window fields) + a
  // journal that never touches the window rebuilds WITHOUT inventing them
  // (absent stays absent — the F8 rebuild-neutral half).
  const legacy = structuredClone(boot());
  delete legacy.budget_window;
  delete legacy.budget_window_cleared_at;
  const t1 = apply(legacy, tickEv('lg'), iso(T0), NM);
  const rb3 = rebuild(legacy, t1.journal);
  assert.equal(rb3.budget_window, undefined, 'no window field invented from a legacy journal');
  assert.equal(rb3.budget_window_cleared_at, undefined, 'no stamp invented either');
});

test('s23/X27 pin 2: REJECTED reports never arm the budget window — 3 quota-shaped unknown-task reports leave it EMPTY (the immediate false re-pause is dead)', () => {
  // The X27 arc at unit level: the wiped epoch's mirror workers' quota-shaped
  // infra reports landed REJECTED (unknown-task) on the fresh epoch but —
  // pre-s23 — STILL armed the window (the push was gated ONLY on the quota
  // shape), and 3 distinct ghost ids count-triggered the false re-pause
  // within seconds of the reset. The X27 live arc, reproduced at unit level,
  // now green.
  const s = assignedState({ max_parallel: 4 });
  const ghosts = ['GHOST-1', 'GHOST-2', 'GHOST-3'];
  const ghostLine = (id, i) => ({
    kind: 'REPORT', event_id: `rep-ghost-${i}`, task: id, lease: `lease-ghost-${i}`,
    outcome: { status: 'infra_failed', error: 'lane-429' }, run_id: `run-ghost-${i}`,
  });
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: ghosts.map(ghostLine),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('gh'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.state.stats.rejected_events, 3, 'every ghost report was REJECTED (unknown-task)');
  const rejRecs = out.journal.filter(j => j.kind === 'REJECTED' && j.origKind === 'REPORT');
  assert.equal(rejRecs.length, 3, 'the REJECTED audit records landed');
  assert.ok(rejRecs.every(j => j.reason === 'unknown-task'), 'the reject reason is unknown-task');
  assert.ok(rejRecs.every(j => j.outcome && j.outcome.status === 'infra_failed' && j.outcome.error === 'lane-429'), 'the audit trail preserves the sliced quota outcome (what the straggler said)');
  assert.deepEqual(out.state.budget_window, [], 'THE WINDOW STAYS EMPTY — the dead epoch\'s straggler traffic never arms it');
  assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'NO alert EVEN at 3 distinct unknown task ids inside the window (the X27 false re-pause is dead)');
  assert.deepEqual(invariants(out.state), []);
  // the F11 re-delivery shape (a network retry of the same POSTs): the
  // duplicate rejects are the SAME straggler class — still no arming.
  const n2 = makeNow(T0 + 90_000);
  const out2 = conductorTick({
    cur: structuredClone(out.state), queue: ghosts.map(ghostLine),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('gh2'), now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out2.state.stats.rejected_events, 6, 'the re-delivered ghosts all rejected as duplicates');
  assert.deepEqual(out2.state.budget_window, [], 'the window is STILL empty after the duplicate re-delivery');
  assert.ok(!out2.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'still no alert');
});

test('s23/X27 pin 3: the negative control — the SAME quota-shaped report for a KNOWN task still arms the window (F-6 unchanged)', () => {
  // The F-6 contract is untouched by the REJECTED gate: a quota-shaped
  // infra_failed report for a task the epoch KNOWS (lease matches, apply
  // succeeds) still pushes its window entry and still count-triggers at 3
  // distinct tasks.
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  assert.equal(ids.length, 3, 'fixture: 3 assigned (known) tasks');
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: ids.map((id, i) => quotaReport(s, id, `kx${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('kx'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.state.budget_window.length, 3, 'KNOWN-task quota reports still push the window entries');
  assert.ok(out.state.budget_window.every(e => !e.straggler), 'post-genesis leases are NOT stragglers (the honest storm counts)');
  const alert = out.actions.find(a => a.type === 'BUDGET_PAUSE_ALERT');
  assert.ok(alert, 'the F-6 count-trigger still fires (the contract unchanged)');
  assert.deepEqual(new Set(alert.tasks), new Set(ids), 'the distinct task list is the KNOWN cohort');
  assert.deepEqual(invariants(out.state), []);
});

// ---------------------------------------------------------------------------
// s23/B9 — the FREE-TAIL RIDING counter + the ALERT-ONLY trigger (the
// design §2.6: N=3 turns / X=15min, whichever first; the slug derivation —
// a REPORT whose lane_stats.models carries a `:free` slug with ok>0 was
// SERVED by the tail; a paid-ok report resets the counter).
// ---------------------------------------------------------------------------

// the LIVE W1→tail arc's report shape: k1ds(402)→JUMP→k2ds(402)→TAIL→
// k2nem:free(200)→done — the bridge JSONL aggregate the adapter attaches
// (calls 3, ok 1: the two paid 402s + the free 200; the free lane ANSWERED).
const TAIL_MODELS = {
  'deepseek/deepseek-v4.1-flash': { calls: 2, ok: 0, err429: 0, err5xx: 2, tokens: 0, cost: 0, p50_ms: null, p95_ms: null },
  'nvidia/nemotron-3.5-lightning:free': { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0, p50_ms: 100, p95_ms: 100 },
};
const PAID_MODELS = {
  'deepseek/deepseek-v4.1-flash': { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 12, cost: 0.003, p50_ms: 90, p95_ms: 90 },
};
const tailReport = (state, id, n, models = TAIL_MODELS) => ({
  kind: 'REPORT', event_id: `rep-tail${n}-${id}`, task: id,
  lease: state.tasks[id].lease.token,
  outcome: {
    status: 'done',
    lane_stats: { calls: 3, ok: 1, err429: 0, err5xx: 2, tokens: 10, cost: 0, p50_ms: 100, p95_ms: 200, models, rate_classes: {} },
  },
  run_id: `run-tail-${n}`,
});

test('s23/B9 pure: tailServedFromOutcome — the slug derivation (free-ok ⟺ tail-served; paid-ok ⟺ a key recovered)', () => {
  // the live W1→tail shape: the free lane ANSWERED (ok>0) → tail-served,
  // NOT paid-served (at most one lane family answers per turn)
  assert.deepEqual(tailServedFromOutcome({ lane_stats: { models: TAIL_MODELS } }), { tail: true, paid: false });
  // a healthy paid turn: deepseek ok → paid-served, no tail
  assert.deepEqual(tailServedFromOutcome({ lane_stats: { models: PAID_MODELS } }), { tail: false, paid: true });
  // the free lane TRIED but never answered (ok:0 — a 500-taxed tail that
  // never got a 2xx): NOT tail-served (the turn was not SERVED by the tail)
  assert.deepEqual(tailServedFromOutcome({ lane_stats: { models: { 'nvidia/nemotron-3.5-lightning:free': { calls: 2, ok: 0, err5xx: 2 } } } }), { tail: false, paid: false });
  // mock/real-lane reports (no lane_stats / no models map) → inert
  assert.deepEqual(tailServedFromOutcome({ status: 'done' }), { tail: false, paid: false });
  assert.deepEqual(tailServedFromOutcome({ lane_stats: { calls: 1 } }), { tail: false, paid: false });
  assert.deepEqual(tailServedFromOutcome(null), { tail: false, paid: false });
  assert.deepEqual(tailServedFromOutcome({ lane_stats: { models: [] } }), { tail: false, paid: false });
  // a paid model whose slug merely CONTAINS 'free' mid-name is NOT :free
  assert.deepEqual(tailServedFromOutcome({ lane_stats: { models: { 'vendor/freedom-paid': { calls: 1, ok: 1 } } } }), { tail: false, paid: true });
});

test('s23/B9 (N trigger): 3 tail-served reports → stats.tail_turns=3 + TAIL_RIDING_ALERT (trigger:turns) — ALERT-ONLY, no pause, no budget alert', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  assert.equal(ids.length, 3, 'fixture: 3 assigned tasks');
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: ids.map((id, i) => tailReport(s, id, i)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('t3'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  // the counter + the stamp
  assert.equal(out.state.stats.tail_turns, 3, 'three tail-served turns counted');
  assert.ok(typeof out.state.stats.tail_since === 'string' && Date.parse(out.state.stats.tail_since) > 0,
    'tail_since armed on the FIRST tail turn of the episode');
  // the action: ALERT-ONLY
  const alert = out.actions.find(a => a.type === 'TAIL_RIDING_ALERT');
  assert.ok(alert, 'the TAIL_RIDING_ALERT action fired at N=3');
  assert.equal(alert.trigger, 'turns');
  assert.equal(alert.tail_turns, 3);
  assert.equal(alert.tail_since, out.state.stats.tail_since);
  assert.equal(alert.window_min, 15, 'X rides the action for the body');
  // ALERT-ONLY: the chain NEVER pauses; the F-6 window never armed (a done
  // report is not quota-shaped infra — the tail is not a pause cause)
  assert.equal(out.state.chain.paused, false, 'ALERT-ONLY — the tail is serving work, parking the epoch would stop a degraded-but-alive fleet');
  assert.ok(!out.actions.some(a => a.type === 'BUDGET_PAUSE_ALERT'), 'no budget-pause crossfire');
  assert.deepEqual(out.state.budget_window, [], 'the F-6 window stays empty');
  assert.deepEqual(invariants(out.state), []);
});

test('s23/B9 (the N boundary): 2 tail turns inside the window → NO alert yet (1-2 turns = a transient drain edge, not a posture)', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 2).map(t => t.id);
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: ids.map((id, i) => tailReport(s, id, i)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('t2'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.state.stats.tail_turns, 2, 'the counter counts them');
  assert.ok(!out.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), 'below N=3 and inside X=15min → quiet');
  assert.deepEqual(invariants(out.state), []);
});

test('s23/B9 (X trigger): 2 tail turns then 16min of continuous riding → TAIL_RIDING_ALERT (trigger:duration) — whichever fires FIRST', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 2).map(t => t.id);
  const n1 = makeNow(T0 + 60_000);
  const first = conductorTick({
    cur: structuredClone(s),
    queue: ids.map((id, i) => tailReport(s, id, i)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('x1'), now: n1.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(!first.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), '2 turns, fresh stamp → quiet');
  // 16 minutes later (an empty-queue tick — the counter is PERSISTED window
  // state, the posture is "still riding"): the DURATION arm fires
  const n2 = makeNow(T0 + 60_000 + 16 * 60_000);
  const second = conductorTick({
    cur: structuredClone(first.state), queue: [],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('x2'), now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  const alert = second.actions.find(a => a.type === 'TAIL_RIDING_ALERT');
  assert.ok(alert, 'the duration arm fired at X=15min of continuous riding');
  assert.equal(alert.trigger, 'duration');
  assert.equal(alert.tail_turns, 2, 'below N — the duration arm alone crossed');
  assert.equal(second.state.chain.paused, false, 'still ALERT-ONLY');
  assert.deepEqual(invariants(second.state), []);
  // the boundary's other side: 14min → quiet (the window is 15)
  const n3 = makeNow(T0 + 60_000 + 14 * 60_000);
  const third = conductorTick({
    cur: structuredClone(first.state), queue: [],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('x3'), now: n3.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.ok(!third.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), '14min of riding → still a bridge, not an alert');
});

test('s23/B9 (the reset): a paid-served report lands → the counter + stamp RESET (a key recovered — the alert re-arms fresh on the next episode)', () => {
  const s = assignedState({ max_parallel: 4 });
  const ids = Object.values(s.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  const n1 = makeNow(T0 + 60_000);
  const first = conductorTick({
    cur: structuredClone(s),
    queue: ids.map((id, i) => tailReport(s, id, i)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('r1'), now: n1.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(first.state.stats.tail_turns, 3);
  assert.ok(first.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), 'the episode armed');
  // a paid-served turn (key 2 topped up / quota reset): the counter zeroes
  // (a STILL-ASSIGNED task — the first tick's three reported tasks are done,
  // their leases released; the clock kept a fourth lease live)
  const paidTask = Object.values(first.state.tasks).find(t => t.status === 'assigned');
  assert.ok(paidTask, 'fixture: a lease-live task survived the first tick');
  const n2 = makeNow(T0 + 60_000 + 5 * 60_000);
  const second = conductorTick({
    cur: structuredClone(first.state),
    queue: [tailReport(first.state, paidTask.id, 'paid', PAID_MODELS)],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('r2'), now: n2.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(second.state.stats.tail_turns, 0, 'RESET — a paid-served report means a key recovered');
  assert.equal(second.state.stats.tail_since, null, 'the stamp cleared too');
  assert.ok(!second.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), 'no alert on the reset tick');
  // and the next single tail turn starts a FRESH episode (armed stamp, no
  // carry-over count — 1 turn is quiet again)
  const freshTask = Object.values(second.state.tasks).find(t => t.status === 'assigned');
  assert.ok(freshTask, 'fixture: a lease-live task for the fresh episode');
  const n3 = makeNow(T0 + 60_000 + 8 * 60_000);
  const third = conductorTick({
    cur: structuredClone(second.state),
    queue: [tailReport(second.state, freshTask.id, 'fresh')],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('r3'), now: n3.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(third.state.stats.tail_turns, 1, 'the fresh episode counts from 1');
  assert.ok(!third.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), '1 turn → quiet (no carry-over from the dead episode)');
  assert.deepEqual(invariants(third.state), []);
});

test('s23/B9 (the X27 discipline): a tail-shaped REJECTED report (unknown task) never touches the counter; a PAUSED chain counts but never alerts', () => {
  // the ghost half: the dead epoch's straggler traffic carrying tail-shaped
  // lane_stats lands REJECTED — the counter stays 0 (the same wasRejected
  // guard the budget window and the backstop share)
  const s = assignedState({ max_parallel: 4 });
  const ghost = {
    kind: 'REPORT', event_id: 'rep-tail-ghost', task: 'GHOST-TAIL', lease: 'lease-ghost',
    outcome: { status: 'done', lane_stats: { calls: 1, ok: 1, models: TAIL_MODELS, rate_classes: {} } },
    run_id: 'run-ghost',
  };
  const n = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [ghost],
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('g1'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.state.stats.rejected_events >= 1, true, 'the ghost report was REJECTED (unknown-task)');
  assert.equal(Number(out.state.stats.tail_turns) || 0, 0, 'the counter never moved');
  assert.equal(out.state.stats.tail_since, undefined, 'never armed');
  // the paused half: the drain still counts (reports are not pause-gated)
  // but the trigger stays quiet (the F-9 quiesced-noop contract)
  const paused = structuredClone(out.state);
  paused.chain.paused = true;
  paused.chain.paused_reason = 'test';
  const ids = Object.values(paused.tasks).filter(t => t.status === 'assigned').slice(0, 3).map(t => t.id);
  const out2 = conductorTick({
    cur: paused,
    queue: ids.map((id, i) => tailReport(paused, id, `p${i}`)),
    controlQueue: [], queueBad: [], ctlBad: [],
    ev: tickEv('g2'), now: n.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out2.state.stats.tail_turns, 3, 'the drain counted the tail turns (reports are not pause-gated)');
  assert.ok(!out2.actions.some(a => a.type === 'TAIL_RIDING_ALERT'), 'a PAUSED chain never re-triggers (quiesced-noop)');
  assert.deepEqual(invariants(out2.state), []);
});
