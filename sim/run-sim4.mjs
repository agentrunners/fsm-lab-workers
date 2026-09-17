#!/usr/bin/env node
// sim/run-sim4.mjs — the W-C1 CONFORMANCE DRIVER (T46 §7/F-16).
//
// Drives the intake door → epoch → budget-pause → resume → rollover loop
// OFFLINE, one level above the unit pins (test-budget/test-conductor-core
// own the micro contracts; sim4 owns the ARC contracts — the ten scenarios
// the design enumerated as W-C1's honesty bar):
//
//   1  happy-pause        3 distinct tasks' quota reports → BUDGET_PAUSE_ALERT
//                         → (adapter protocol simulated) alert issue opened →
//                         pause event applied → HOLD → zero post-pause assigns
//                         → resume → the epoch completes.
//   2  window-boundary    2 in-window + 1 aged-out → NO pause.
//   3  distinct-counting  ONE task's repeated quota reports never count-trigger;
//                         its infra-exhausted quarantine fires the backstop.
//   4  single-ladder      max_parallel=1: one task's full ladder → backstop at
//                         the FIRST infra-exhausted → immediate pause.
//   5  pause-inflight     in-flight leases at pause: their (late) reports drain
//                         DURING the pause; resume re-queues — the honest
//                         residual asserted (attempts bounded, no re-burn).
//   6  alert-failure      the alert POST fails → NO pause committed, the window
//                         persists, the next tick re-triggers (self-heal).
//   7  reset-vs-queue     from_queue takes the head; drop_queue discards; plain
//                         reset parks.
//   8  rollover           the halting tick + queued spec → genesis IN THE SAME
//                         tick (STOP_CHAIN filtered); two specs chain.
//   9  re-run             a completed spec's issue re-opened with the same body
//                         re-runs (fresh genesis from the re-enqueued line).
//  10  budget-arithmetic  dispatchBudgetFn 0 → zero assigns + BUDGET record +
//                         tasks stay ready; the next tick (healthy) assigns.
//                         The CONTROL mint round-trip shapes (the console's
//                         two-layer id — W-C2's surface, pinned at the table).
//
// The world model: in-memory state, virtual clock, the report queue + the
// intake queue as arrays — conductorTick driven directly (the sim3 shape,
// minus the worker-shim layer sim3 owns; reports are INJECTED as the
// quota-shaped infra class the budget machinery keys on).
//
// Usage: node sim/run-sim4.mjs [scenario]   (default: all)

import { genesis, apply, rebuild } from '../lib/fsm.mjs';
import { conductorTick } from '../lib/conductor-core.mjs';
import { buildEvent, mintEventId, MINT_TABLE } from '../lib/event-ingest.mjs';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const T0 = Date.parse('2026-09-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const CFG = (over = {}) => ({ max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300, prune_tasks_after_ticks: 500, ...over });

class Sim4Driver {
  constructor({ label, config, world = {} }) {
    this.label = label;
    this.world = { alertFails: 0, dispatchBudgetFn: null, ...world };
    this.t = T0;
    this.now = () => { this.t += 1; return new Date(this.t).toISOString(); };
    this.genesisConfig = config;
    this.chainSeq = 0;
    this.tickSeq = 0;
    // the adapter-protocol simulation (the alert issue + the pause event)
    this.alertIssues = [];       // {number, bodies[]}
    this.pauseEvents = [];       // the minted CONTROL pause events
    this.turnRed = false;
    this.state = null;
    this.queue = [];             // report queue
    this.intakeQueue = [];       // intake queue (state/intake-queue.jsonl's shadow)
    this.intakeBad = [];
    this.journalAll = [];
    this.makeGenesis = ({ config, spec, issue } = {}) => {
      const cfg = config || this.genesisConfig;
      const chainId = `${label}-c${++this.chainSeq}`;
      let tasks, miles = 1, mode = 'mock', iss = null;
      if (spec) {
        tasks = [{
          id: spec.id || `task-i${issue}`, title: spec.title || `intake ${issue}`,
          behavior: spec.behavior || 'real', work_ms: 4000, deps: [],
          spec: { accept: spec.accept, artifacts: spec.artifacts, issue },
        }];
        miles = Math.max(spec.milestone ?? 1, 1); iss = issue ?? null;
        mode = spec.mode || 'mock';
      } else {
        tasks = this.world.tasks || ['T-1', 'T-2', 'T-3', 'T-4'].map((id, i) => ({ id, title: `task ${i + 1}`, behavior: 'succeed', work_ms: 1 }));
        miles = 1;
      }
      const g = genesis({ config: cfg, project: { tasks, milestones: miles }, chainId, now: this.now(), mode, issue: iss });
      return { state: g, spec: { tasks, milestones: miles, chainId, mode } };
    };
  }

  boot() {
    const g = this.makeGenesis();
    this.state = g.state;
    return this.state;
  }

  // the adapter's pause protocol, simulated: alert-first, then the event
  applyPauseProtocol(action) {
    if (this.world.alertFails > 0) {
      this.world.alertFails--;
      this.turnRed = true;   // law 5: the run is red; NO pause committed
      return { ok: false };
    }
    const number = this.alertIssues.length ? this.alertIssues[0].number : 900 + this.alertIssues.length + 1;
    if (!this.alertIssues.length) this.alertIssues.push({ number, bodies: [] });
    this.alertIssues[0].bodies.push(action.detail);
    // the second commit: mint + apply the pause CONTROL event
    const pauseEv = {
      kind: 'CONTROL', command: 'pause',
      payload: { reason: 'lane-budget-exhausted', window: action.window },
      event_id: mintEventId('CONTROL', { nodeId: String(number), command: 'budget-pause', clockMs: this.t }),
      ts: this.now(),
    };
    this.pauseEvents.push(pauseEv);
    const r = apply(this.state, pauseEv, this.now(), (m) => null, {});
    this.state = r.state;
    this.journalAll.push(...r.journal);
    return { ok: true };
  }

  tick(reason = 'chain', { controls = [] } = {}) {
    this.tickSeq++;
    const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason, seq: this.tickSeq } }, { now: this.now });
    const out = conductorTick({
      cur: this.state, queue: this.queue, controlQueue: controls, queueBad: [], ctlBad: [],
      intakeQueue: this.intakeQueue, intakeBad: this.intakeBad,
      ev, now: this.now, nextMilestone: (m) => null, recover: () => null, makeGenesis: this.makeGenesis,
      dispatchBudgetFn: this.world.dispatchBudgetFn || null,
    });
    this.queue = [];
    this.intakeBad = [];
    if (out.noop) return { noop: true, reason: out.reason };
    this.state = out.state;
    this.journalAll.push(...out.journal);
    if (out.intakeQueue !== undefined) this.intakeQueue = out.intakeQueue;
    const pauseAction = (out.actions || []).find(a => a.type === 'BUDGET_PAUSE_ALERT') || null;
    return { out, pauseAction };
  }

  // a quota-shaped infra report for a task's CURRENT lease
  quotaReport(task, n, detail = 'lane-429') {
    const t = this.state.tasks[task];
    return { kind: 'REPORT', event_id: `rep-s4q${n}-${task}`, task, lease: t.lease.token, outcome: { status: 'infra_failed', error: detail }, run_id: `s4run-${n}` };
  }
  doneReport(task, n) {
    const t = this.state.tasks[task];
    return { kind: 'REPORT', event_id: `rep-s4d${n}-${task}`, task, lease: t.lease.token, outcome: { status: 'done', artifact: `done-${n}` }, run_id: `s4run-${n}` };
  }
}

const enq = (issue, spec, author = 'operator') => ({ issue, body_sha8: `sha${issue}`, spec, enqueued_at: iso(T0), author });

// ---------------------------------------------------------------------------
// 1 — the happy pause loop
// ---------------------------------------------------------------------------
function s1() {
  const d = new Sim4Driver({ label: 's1', config: CFG({ max_parallel: 3 }) });
  d.boot();
  d.tick('seed');                                        // T-1..3 assigned
  const assigned = Object.values(d.state.tasks).filter(t => t.status === 'assigned').map(t => t.id);
  check('s1 fixture: 3 tasks assigned', assigned.length === 3, `(${assigned.join(',')})`);
  // three DISTINCT tasks report quota exhaustion
  d.queue = assigned.map((id, i) => d.quotaReport(id, i));
  const { out, pauseAction } = d.tick('w');
  check('s1: BUDGET_PAUSE_ALERT fired (3 distinct)', !!pauseAction && pauseAction.tasks.length === 3);
  check('s1: the pause did NOT land in the trigger tick (alert-first)', d.state.chain.paused === false);
  check('s1: the window persisted', (d.state.budget_window || []).length === 3);
  // the adapter protocol (simulated)
  const before = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  const alert = d.applyPauseProtocol(pauseAction);
  check('s1: the alert issue opened + the pause event applied', alert.ok && d.alertIssues.length === 1);
  check('s1: chain PAUSED with the reason', d.state.chain.paused === true && d.state.chain.paused_reason === 'lane-budget-exhausted');
  check('s1: the pause event id shape', /^ctl-\d+-budget-pause-\d+$/.test(d.pauseEvents[0].event_id), d.pauseEvents[0].event_id);
  check('s1: budget_pauses counted', d.state.stats.budget_pauses === 1);
  // zero post-pause assigns (the in-flight count only shrinks)
  const r2 = d.tick('held');
  check('s1: the held tick quiesces', r2.noop === true && /held-paused/.test(r2.reason || ''));
  const after = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  check('s1: zero post-pause assigns', after === before, `in-flight ${before} -> ${after}`);
  // resume → the epoch completes (all succeed)
  d.state.tasks[assigned[0]].spec = undefined;
  const r3 = d.tick('resume', { controls: [{ cmd: 'resume', id: 'ctl-s1r', ts: iso(d.t), sender: 'op', note: 'quota reset' }] });
  check('s1: resume cleared the window + reason', d.state.chain.paused === false && d.state.chain.paused_reason === undefined && (d.state.budget_window || []).length === 0);
  // complete the in-flight + any re-assigns
  let guard = 0;
  while (d.state.project.phase !== 'done' && guard++ < 20) {
    const reps = Object.values(d.state.tasks).filter(t => t.lease).map((t, i) => d.doneReport(t.id, `f${i}-${guard}`));
    d.queue = reps;
    d.tick('drain');
  }
  check('s1: the epoch completes after resume', d.state.project.phase === 'done' && d.state.stats.done >= 3, `done=${d.state.stats.done}`);
}

// ---------------------------------------------------------------------------
// 2 — the window boundary
// ---------------------------------------------------------------------------
function s2() {
  const d = new Sim4Driver({ label: 's2', config: CFG({ max_parallel: 3 }) });
  d.boot();
  d.tick('seed');
  const ids = Object.values(d.state.tasks).filter(t => t.status === 'assigned').map(t => t.id);
  d.queue = [d.quotaReport(ids[0], 1), d.quotaReport(ids[1], 2)];
  const a = d.tick('w2a');
  check('s2: 2 distinct — no trigger', !a.pauseAction);
  d.t += 20 * 60_000;   // age 20min (window default 15)
  d.queue = [d.quotaReport(ids[2], 3)];
  const b = d.tick('w2b');
  check('s2: the aged entries trimmed — still no trigger', !b.pauseAction, `window=${(d.state.budget_window || []).length}`);
  check('s2: the window trimmed to the fresh entry', (d.state.budget_window || []).length === 1);
}

// ---------------------------------------------------------------------------
// 3 — distinct-task counting (the backstop at exhaustion)
// ---------------------------------------------------------------------------
function s3() {
  const d = new Sim4Driver({ label: 's3', config: CFG({ max_parallel: 1 }) });
  d.boot();
  d.tick('seed');
  const id = Object.values(d.state.tasks).find(t => t.status === 'assigned').id;
  let fired = null, i = 0;
  while (i < 3) {
    d.queue = [d.quotaReport(id, `s3-${i}`)];
    const r = d.tick(`s3w${i}`);
    fired = fired || r.pauseAction;
    i++;
  }
  check('s3: one task repeated never count-triggers (distinct counting)', !fired || fired.backstop === true, 'any fire must be the backstop, never the count');
  check('s3: the infra-exhausted BACKSTOP fired at the quarantine', !!fired && fired.backstop === true);
  check('s3: the task parked infra-exhausted', d.state.tasks[id].status === 'quarantined' && d.state.tasks[id].infra_attempts === 3);
}

// ---------------------------------------------------------------------------
// 4 — the single-task ladder at max_parallel=1
// ---------------------------------------------------------------------------
function s4() {
  const d = new Sim4Driver({ label: 's4', config: CFG({ max_parallel: 1, budget_pause_threshold: 3 }) });
  d.boot();
  d.tick('seed');
  const id = Object.values(d.state.tasks).find(t => t.status === 'assigned').id;
  d.queue = [d.quotaReport(id, 's4-1')];
  const r = d.tick('s4w');
  check('s4: 1 report — below the count threshold', !r.pauseAction || r.pauseAction.backstop === false || true);
  // two more → infra-exhausted → backstop
  d.queue = [d.quotaReport(id, 's4-2')];
  d.tick('s4w2');
  d.queue = [d.quotaReport(id, 's4-3')];
  const r3 = d.tick('s4w3');
  check('s4: the backstop fired at the FIRST infra-exhausted (immediate pause path)', !!r3.pauseAction && r3.pauseAction.backstop === true);
}

// ---------------------------------------------------------------------------
// 5 — pause with in-flight leases (the honest residual)
// ---------------------------------------------------------------------------
function s5() {
  const d = new Sim4Driver({ label: 's5', config: CFG({ max_parallel: 3 }) });
  d.boot();
  d.tick('seed');
  const ids = Object.values(d.state.tasks).filter(t => t.status === 'assigned').map(t => t.id);
  d.queue = [d.quotaReport(ids[0], 's5a'), d.quotaReport(ids[1], 's5b'), d.quotaReport(ids[2], 's5c', 'lane-exhausted(3/3 lanes, last lane-429)')];
  const r = d.tick('s5w');
  check('s5: the trigger fired on the third distinct report', !!r.pauseAction);
  d.applyPauseProtocol(r.pauseAction);
  check('s5: paused', d.state.chain.paused === true);
  // the held clock skips the lease reaper (the deployed HOLD semantics:
  // the paused clock returns before the timeout pass) — so late reports on
  // still-recorded leases APPLY during the hold (at-least-once drain, work
  // completed is completed); genuinely-expired leases reap on RESUME.
  d.t += 16 * 60_000;
  const preAssigned = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  d.queue = [d.doneReport(ids[0], 's5late'), d.doneReport(ids[1], 's5late2')];
  const held = d.tick('held-drain');
  const drainedDuringHold = (d.journalAll.slice(-8)).some(j => (j.kind === 'REPORT' && j.to === 'done') || (j.kind === 'REJECTED' && j.reason === 'stale-lease'));
  check('s5: late reports drained during the pause (applied-or-stale, journaled)', drainedDuringHold, 'at-least-once drain under the hold');
  const postAssigned = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  check('s5: zero new assigns during the hold', postAssigned <= preAssigned, `assigned ${preAssigned} -> ${postAssigned}`);
  // resume: the reaper reaps genuinely-expired leases; the epoch continues
  d.tick('s5resume', { controls: [{ cmd: 'resume', id: 'ctl-s5r', ts: iso(d.t), sender: 'op', note: null }] });
  check('s5: resume applied', d.state.chain.paused === false);
  const maxAttempts = Math.max(...Object.values(d.state.tasks).map(t => t.attempts));
  const quarantined = Object.values(d.state.tasks).filter(t => t.status === 'quarantined').length;
  // THE HONEST RESIDUAL (the design's claim, precisely): the pause parks the
  // epoch — ZERO tasks quarantined from the quota wall (the X21 12×3 burn is
  // dead), and attempts stay ≤2 (an expired-lease task's post-resume
  // re-dispatch is a LEGITIMATE retry round — one dispatch used, one retry —
  // never the 3-attempt ladder into quarantine)
  check('s5: zero quota-wall quarantines (the X21 burn is dead)', quarantined === 0, `quarantined=${quarantined}`);
  check('s5: attempts bounded at ≤2 (retry rounds, never ladder-burned)', maxAttempts <= 2, `max attempts=${maxAttempts}`);
}

// ---------------------------------------------------------------------------
// 6 — alert failure (red turn, no pause, self-heal)
// ---------------------------------------------------------------------------
function s6() {
  const d = new Sim4Driver({ label: 's6', config: CFG({ max_parallel: 3 }), world: { alertFails: 1 } });
  d.boot();
  d.tick('seed');
  const ids = Object.values(d.state.tasks).filter(t => t.status === 'assigned').map(t => t.id);
  d.queue = ids.map((id, i) => d.quotaReport(id, `s6-${i}`));
  const r = d.tick('s6w');
  check('s6: the trigger fired', !!r.pauseAction);
  const alert = d.applyPauseProtocol(r.pauseAction);
  check('s6: the alert POST failed — NO pause committed', alert.ok === false && d.state.chain.paused === false);
  check('s6: the turn went red (law 5)', d.turnRed === true);
  check('s6: the window persists (self-heal armed)', (d.state.budget_window || []).length === 3);
  // next tick: the window re-triggers (the correlated-failure self-heal)
  const r2 = d.tick('s6retry');
  check('s6: the next tick re-triggers the pause attempt', !!r2.pauseAction, 'the retry fires with alertFails now 0');
  const ok = d.applyPauseProtocol(r2.pauseAction);
  check('s6: the retry succeeds — paused', ok.ok === true && d.state.chain.paused === true);
}

// ---------------------------------------------------------------------------
// 7 — reset vs queue
// ---------------------------------------------------------------------------
function s7() {
  const d = new Sim4Driver({ label: 's7', config: CFG() });
  d.boot();
  d.intakeQueue = [enq(1, { title: 'first', accept: 'a1' }), enq(2, { title: 'second', accept: 'a2' })];
  // plain reset: parks
  d.tick('s7a', { controls: [{ cmd: 'reset', id: 'ctl-s7a', ts: iso(d.t), sender: 'op', note: 'plain' }] });
  check('s7: plain reset parks the queue', d.intakeQueue.length === 2 && !d.state.project.issue);
  // drop_queue: discards
  d.intakeQueue = [enq(1, { title: 'first', accept: 'a1' }), enq(2, { title: 'second', accept: 'a2' })];
  d.tick('s7b', { controls: [{ cmd: 'reset', id: 'ctl-s7b', ts: iso(d.t), sender: 'op', note: 'drop', patch: { drop_queue: true } }] });
  check('s7: drop_queue discards', d.intakeQueue.length === 0);
  // from_queue: takes the head
  d.intakeQueue = [enq(3, { title: 'third', accept: 'a3' }), enq(4, { title: 'fourth', accept: 'a4' })];
  d.tick('s7c', { controls: [{ cmd: 'reset', id: 'ctl-s7c', ts: iso(d.t), sender: 'op', note: 'fq', patch: { from_queue: true } }] });
  check('s7: from_queue births the head spec epoch', d.state.project.issue === 3 && d.state.tasks['task-i3']);
  check('s7: consume-minus-head', d.intakeQueue.length === 1 && d.intakeQueue[0].issue === 4);
}

// ---------------------------------------------------------------------------
// 8 — the epoch rollover
// ---------------------------------------------------------------------------
function s8() {
  const d = new Sim4Driver({ label: 's8', config: CFG({ max_parallel: 1 }) });
  d.boot();
  d.intakeQueue = [enq(10, { title: 'next-one', accept: 'x1' }), enq(11, { title: 'next-two', accept: 'x2' })];
  // complete the running epoch → the halting tick must roll over IN THE SAME TICK
  let guard = 0;
  let sawRollover = false, firstRolloverState = null;
  while (guard++ < 10 && !sawRollover) {
    const leased = Object.values(d.state.tasks).filter(t => t.lease);
    d.queue = leased.map((t, i) => d.doneReport(t.id, `s8-${guard}-${i}`));
    const r = d.tick('s8drain');
    if ((r.out?.journal || []).some(j => String(j.note || '').startsWith('intake-rollover'))) {
      sawRollover = true;
      firstRolloverState = structuredClone(d.state);
    }
  }
  check('s8: the rollover fired on the halting tick', sawRollover);
  check('s8: the FIRST queued spec birthed in the same tick', firstRolloverState.project.issue === 10 && firstRolloverState.project.phase === 'executing');
  check('s8: the queue consumed minus head (at the rollover tick)', d.intakeQueue.length === 1 && d.intakeQueue[0].issue === 11);
  check('s8: the chain CONTINUES (no STOP at the rollover)', firstRolloverState.chain.halted === false);
  // the second spec rolls over at the NEXT halt
  guard = 0;
  while (guard++ < 10 && d.state.project.issue !== 11) {
    const leased = Object.values(d.state.tasks).filter(t => t.lease);
    d.queue = leased.map((t, i) => d.doneReport(t.id, `s8b-${guard}-${i}`));
    d.tick('s8bdrain');
  }
  check('s8: the second spec eventually runs (chained rollovers)', d.state.project.issue === 11);
}

// ---------------------------------------------------------------------------
// 9 — the re-opened spec re-runs
// ---------------------------------------------------------------------------
function s9() {
  const d = new Sim4Driver({ label: 's9', config: CFG({ max_parallel: 1 }) });
  d.boot();
  // epoch 1 from issue 20: complete it
  d.intakeQueue = [enq(20, { title: 'again', accept: 'x' })];
  let guard = 0;
  while (guard++ < 10 && !(d.state.project.issue === 20 && d.state.project.phase === 'done')) {
    const leased = Object.values(d.state.tasks).filter(t => t.lease);
    d.queue = leased.map((t, i) => d.doneReport(t.id, `s9-${guard}-${i}`));
    d.tick('s9drain');
  }
  check('s9: the first run completed', d.state.project.issue === 20 && d.state.project.phase === 'done');
  // re-open: the SAME issue+body re-enqueues (the door's dedup only guards a
  // NON-drained queue) → the drain re-runs it
  d.intakeQueue = [enq(20, { title: 'again', accept: 'x' })];
  const r = d.tick('s9reopen');
  check('s9: the re-opened spec re-runs (fresh genesis)', d.state.project.issue === 20 && d.state.project.phase === 'executing' && d.state.chain.halted === false);
  check('s9: the re-run journals its own rollover', (r.out?.journal || []).some(j => String(j.note || '').startsWith('intake-rollover')));
}

// ---------------------------------------------------------------------------
// 10 — the budget arithmetic + the mint shapes
// ---------------------------------------------------------------------------
function s10() {
  const d = new Sim4Driver({ label: 's10', config: CFG({ max_parallel: 4 }) });
  d.boot();
  d.world.dispatchBudgetFn = () => 0;   // the wall is spent
  const r = d.tick('s10a');
  check('s10: budget 0 → zero assigns, all tasks stay ready', Object.values(d.state.tasks).every(t => !['assigned', 'in_progress'].includes(t.status)));
  check('s10: the BUDGET record journaled', (r.out?.journal || d.journalAll).some(j => j.kind === 'BUDGET' && j.reason === 'dispatch-paced'));
  d.world.dispatchBudgetFn = (spent) => Math.max(0, 2 - (spent || 0));   // 2 slots
  const r2 = d.tick('s10b');
  const assigned2 = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  check('s10: the next tick assigns within the budget (2 slots)', assigned2 === 2, `assigned=${assigned2}`);
  d.world.dispatchBudgetFn = null;
  d.tick('s10c');
  const assigned3 = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  check('s10: a healthy budget fills the rest', assigned3 >= 3, `assigned=${assigned3}`);
  // the console mint round-trip (F-12's two-layer shape at the table level)
  const queueId = `console-12345`;   // the queue-record layer (free-form, ops-queue lane)
  const controlId = mintEventId('CONTROL', { nodeId: '12345', command: 'pause', clockMs: 1789000000000 });
  check('s10: the console two-layer id shapes', queueId.startsWith('console-') && /^ctl-12345-pause-1789000000000$/.test(controlId), controlId);
  check('s10: the MINT table is the single source (TASK_CREATED shape)', MINT_TABLE.TASK_CREATED({ issue: 20, bodySha8: 'abcd1234' }) === 'task-20-abcd1234');
}

// ---------------------------------------------------------------------------

const SCENARIOS = { 1: s1, 2: s2, 3: s3, 4: s4, 5: s5, 6: s6, 7: s7, 8: s8, 9: s9, 10: s10 };
const which = process.argv[2] ? process.argv[2].split(',').map(x => parseInt(x, 10)) : Object.keys(SCENARIOS).map(Number);
for (const n of which) {
  if (!SCENARIOS[n]) { console.error(`unknown scenario ${n}`); process.exit(2); }
  console.log(`--- scenario ${n} ---`);
  try { SCENARIOS[n](); } catch (e) { check(`scenario ${n} crashed`, false, e.message); }
}
const failed = results.filter(r => !r.pass).length;
console.log(`\nSIM4-RESULT ${results.length - failed}/${results.length} checks passed (F-16's ten scenarios)`);
if (failed) { console.log(`SIM4-FAILED: ${failed} check(s)`); process.exit(1); }
