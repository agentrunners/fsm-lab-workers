// stress/batteries/burst12.mjs — BATTERY 1: the X21 shape automated (a6 §6.1).
//
// 12 tasks spawned at t0, max_parallel=4, ParallelCap(5) LIVE (T7's model —
// the repo-wide GHA run cap, previously modeled nowhere), seeded worker
// durations (two 9-min grinds — the X21 shape), dispatch pacing within the
// dispatchBudget (F-10), and the REAL 12-writer CAS storm.
//
// Asserts:
//   * the conductor's own self-tick never starves > 2 consecutive windows
//     under worker saturation (ParallelCap's starvation counter) — the
//     sabotage lane proves the counter DETECTS starvation (a test that
//     proves the test, the sim2 actions-drop discipline);
//   * ZERO CAS losses across 12 concurrent report enqueues (12 REAL child
//     processes racing enqueueReport on one clone — the ledger diff shows
//     every report applied exactly once);
//   * dispatch pacing within the dispatch budget (F-10: ≤ B ASSIGN records
//     per committed turn);
//   * drain-time bounded — the baseline PIN: ticks-to-drain ≤ N (the number
//     is printed; future regressions move it).
//
// Metrics: dispatch-queue depth curve (max/avg), ticks-to-drain,
// virtual-time-to-drain, slot-wait histograms (conductor vs worker vs
// watchdog), starvation windows, CAS-storm wall time.
//
// quick: the full 12-task shape (virtual — fast); full: adds a 3-seed sweep
// of the drain baseline (the number becomes a mean ± spread, not one draw).

import { Store } from '../../lib/store.mjs';
import { genesis } from '../../lib/fsm.mjs';
import { conductorTick } from '../../lib/conductor-core.mjs';
import { buildEvent } from '../../lib/event-ingest.mjs';
import { ConcurrencyGroup, DispatchLane, mulberry32 } from '../../sim/gha-shim.mjs';
import { ParallelCap } from '../lib/parallel-cap.mjs';
import { makeClock, setupRepo, Recorder, T0, MIN } from '../lib/common.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const RUN_MS = 30_000;              // one conductor turn ≈ 30s runner time
const WATCHDOG_MS = 90_000;         // one watchdog scan (fetch + GC lane)
const BACKSTOP_MS = 600_000;        // the compressed schedule backstop
const DISPATCH_BUDGET = 3;          // F-10 pacing: ≤3 worker dispatches per turn

function burstProject(seed, { grinds = 2, grindMs = 9 * MIN } = {}) {
  const rng = mulberry32(seed);
  const tasks = [];
  for (let i = 1; i <= 12; i++) {
    tasks.push({
      id: `T-${String(i).padStart(2, '0')}`,
      title: `burst task ${i}`,
      behavior: 'succeed',
      work_ms: 1_000 + Math.floor(rng() * 5_000),
      deps: [],
    });
  }
  // the two 9-min grinds (the X21 shape: long-tail turns under the cap)
  for (const t of tasks.slice(0, grinds)) { t.work_ms = grindMs; t.behavior = 'succeed'; }
  return { tasks, milestones: 1 };
}

// ---------------------------------------------------------------------------
// CappedDriver — run-sim2's SimDriver re-based on the repo-wide ParallelCap:
// the conductor group still serializes WAKES (depth-1 newest-wins) but a run
// STARTS only when a cap slot frees; workers and watchdog scans queue in the
// SAME FIFO (GHA admits queued jobs in submit order — no lane privilege).
// ---------------------------------------------------------------------------
export class CappedDriver {
  constructor({ clock, store, project, cap, lane, seed, opts = {} }) {
    this.label = opts.label || 'burst12';
    this.clock = clock;
    this.store = store;
    this.project = project;
    this.cap = cap;
    this.lane = lane;
    this.opts = opts;
    this.group = new ConcurrencyGroup({ clock, name: `${this.label}-conductor` });
    this.rng = mulberry32(seed);
    this.arrivals = [];          // { at, fn }
    this.state = null;
    this.turnCount = 0;          // committed turns
    this.stopped = false;
    this.dispatchLog = [];
    this.reportEnqueues = [];
    this.pendingConductorWake = null;   // depth-1 newest-wins (the group)
    this.conductorRunning = false;
    this.assignsPerTurn = [];
    this.repSeq = 0;
    this.chainSeq = 0;
    this.watchdogEvery = opts.watchdogEvery ?? 10 * MIN;
    this.dispatchBudgetFn = opts.dispatchBudgetFn ?? null;
    this.makeGenesis = ({ config } = {}) => {
      const cfg = config || { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };
      const chainId = `${this.label}-${++this.chainSeq}`;
      const g = genesis({ config: cfg, project: { tasks: this.project.tasks, milestones: this.project.milestones }, chainId, now: this.clock.now() });
      return { state: g, spec: { tasks: this.project.tasks, milestones: this.project.milestones, chainId } };
    };
    this.now = () => { this.clock.advance(1); return this.clock.now(); };
  }

  schedule(at, fn) {
    this.arrivals.push({ at, fn });
    this.arrivals.sort((a, b) => a.at - b.at);
  }

  submitConductor(ev) {
    // the group's depth-1 newest-wins: a wake while one is pending REPLACES it
    if (this.conductorRunning) { this.pendingConductorWake = ev; return; }
    this.conductorRunning = true;
    this.cap.submit({ name: 'conductor', durationMs: RUN_MS, wake: ev, id: `cond-${this.turnCount + 1}` });
  }

  dispatchTick(reason) {
    const seq = (this.state?.chain?.seq ?? 0) + 1;
    const d = this.lane.send('fsm-tick', { reason, seq });
    if (!d.ok) return d;
    this.schedule(d.willRunAt, () => {
      this.submitConductor(buildEvent({ action: 'fsm-tick', client_payload: { reason, seq } }, { now: this.now }));
    });
    return d;
  }

  scheduleBackstop(at) {
    this.schedule(at, () => {
      this.submitConductor(buildEvent({ schedule: 'stress-backstop' }, { now: this.now }));
      if (!this.stopped) this.scheduleBackstop(this.clock.ms + BACKSTOP_MS);
    });
  }

  scheduleWatchdog() {
    this.schedule(this.clock.ms + this.watchdogEvery, () => {
      if (!this.stopped) {
        this.cap.submit({ name: 'watchdog', durationMs: WATCHDOG_MS, id: `wd-${this.clock.ms}` });
        this.scheduleWatchdog();
      }
    });
  }

  // a cap event: run started => execute; completed => the tail semantics
  onCapEvent(e) {
    if (e.type === 'started' && e.run.name === 'conductor') {
      this.executeTurn(e.run);
    } else if (e.type === 'completed') {
      if (e.run.name === 'conductor') {
        this.conductorRunning = false;
        // chain continuation fires at run END (the adapter's self-dispatch tail)
        const stopped = e.run.stopped;
        if (this.pendingConductorWake) {
          const w = this.pendingConductorWake;
          this.pendingConductorWake = null;
          this.submitConductor(w);
        } else if (!stopped && !this.stopped) {
          this.dispatchTick('chain');
        }
      } else if (e.run.name === 'worker') {
        this.workerReports(e.run);
      }
    }
  }

  executeTurn(run) {
    const ev = run.wake;
    const out = this.store.commit({
      mutate: (cur, queue, controlQueue, queueBad, ctlBad, intakeQueue, intakeBad) => conductorTick({
        cur, queue, controlQueue, queueBad, ctlBad, intakeQueue, intakeBad, ev, now: this.now,
        nextMilestone: () => null, recover: () => null, makeGenesis: this.makeGenesis,
        ...(this.dispatchBudgetFn ? { dispatchBudgetFn: this.dispatchBudgetFn } : {}),
      }),
    });
    if (!out.committed) {
      this.state = out.state || this.state;
      run.stopped = true;
      return;
    }
    this.turnCount++;
    this.state = out.state;
    const assigns = (out.journal || []).filter(j => j.kind === 'ASSIGN').length;
    this.assignsPerTurn.push(assigns);
    const actions = out.actions || [];
    run.stopped = actions.some(a => a.type === 'STOP_CHAIN' || a.type === 'HOLD_CHAIN');
    for (const a of actions) {
      if (a.type === 'DISPATCH_WORKER') {
        const d = this.lane.send('fsm-task', { task: a.task, lease: a.lease, attempt: a.attempt, behavior: a.behavior, work_ms: a.work_ms, expires: a.expires });
        if (d.ok) {
          this.dispatchLog.push({ task: a.task, lease: a.lease, willRunAt: d.willRunAt });
          // the worker run ARRIVES at the dispatch lane's latency, then queues
          // for a cap slot — the two latencies COMPOSE (GHA reality)
          this.schedule(d.willRunAt, () => {
            this.cap.submit({ name: 'worker', durationMs: Math.min(a.work_ms, 75 * MIN), task: a.task, lease: a.lease, attempt: a.attempt, behavior: a.behavior, work_ms: a.work_ms, id: `wk-${a.task}-${a.attempt}` });
          });
        }
      }
    }
    if (out.state.project.phase === 'done') this.stopped = true;
  }

  workerReports(run) {
    // mock-lane succeed (the burst's behaviors are all 'succeed'; duration =
    // the run's virtual duration)
    const event_id = `rep-${run.task}-${run.attempt}-${++this.repSeq}`;
    const rec = { event_id, task: run.task, lease: run.lease, outcome: { status: 'done', artifact: `artifact:${run.task}`, duration_ms: run.durationMs }, run_id: `burst-${run.task}-${run.attempt}` };
    const r = this.store.enqueueReport(rec);
    this.reportEnqueues.push({ ...rec, ok: r.ok });
    if (!r.ok) throw new Error(`report enqueue failed: ${r.err}`);
  }

  nextEventTime() {
    const a = this.arrivals.length ? this.arrivals[0].at : null;
    const c = this.cap.nextTickAt();
    if (a == null) return c;
    if (c == null) return a;
    return Math.min(a, c);
  }

  run(maxCycles = 400) {
    this.submitConductor(buildEvent({ action: 'fsm-tick', client_payload: { reason: 'cold-start' } }, { now: this.now }));
    this.scheduleBackstop(this.clock.ms + BACKSTOP_MS);
    if (this.opts.watchdog !== false) this.scheduleWatchdog();
    let guard = 0;
    while (this.turnCount < maxCycles && !this.stopped && guard++ < 5000) {
      const t = this.nextEventTime();
      if (t == null) break;
      this.clock.advanceTo(t);
      const due = this.arrivals.filter(x => x.at <= this.clock.ms);
      this.arrivals = this.arrivals.filter(x => x.at > this.clock.ms);
      for (const x of due) x.fn();
      for (const e of this.cap.tick()) this.onCapEvent(e);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — the REAL 12-writer CAS storm: 12 child processes racing
// Store.enqueueReport on ONE clone (the X3 burst shape: shared-clone ref
// locks + non-FF pushes + the jittered backoff ladder). Zero CAS losses =
// every child ok AND every report applied EXACTLY once by the drain tick.
// ---------------------------------------------------------------------------
function spawnEnqueueChild(clone, rec) {
  return new Promise((res) => {
    const recFile = join(clone, `..`, `storm-${rec.task}.json`);
    writeFileSync(recFile, JSON.stringify(rec));
    const child = spawn(process.execPath, [join(HERE, '..', 'children', 'enqueue-child.mjs'), clone, recFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', (code) => {
      rmSync(recFile, { force: true });
      try { res({ ...JSON.parse(out), code, err: err.slice(0, 200) }); }
      catch { res({ ok: false, code, err: (err || out).slice(0, 300) }); }
    });
  });
}

async function casStorm(recorder, seed) {
  const lab = setupRepo('fsm-burst-cas-');
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone });
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `S-${i + 1}`, title: `storm ${i + 1}`, behavior: 'succeed', work_ms: 10, deps: [] }));
    const g = genesis({ config: { max_parallel: 12, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project: { tasks, milestones: 1 }, chainId: 'cas-storm', now: clock.now() });
    store.init(g);
    const now = () => { clock.advance(1); return clock.now(); };
    const out = store.commit({
      mutate: (cur, queue, cq, qb, cb, iq, ib) => conductorTick({
        cur, queue, controlQueue: cq, queueBad: qb, ctlBad: cb, intakeQueue: iq, intakeBad: ib,
        ev: buildEvent({ action: 'fsm-tick', client_payload: { reason: 'assign-all' } }, { now }),
        now, nextMilestone: () => null, recover: () => null, makeGenesis: () => { throw new Error('no genesis expected'); },
      }),
    });
    recorder.check('cas-storm: the assign tick committed (12 leases live)', out.committed && out.journal.filter(j => j.kind === 'ASSIGN').length === 12,
      `assigns=${out.journal.filter(j => j.kind === 'ASSIGN').length}`);

    // 12 children, ONE clone, simultaneously
    const t0 = Date.now();
    const records = out.actions.filter(a => a.type === 'DISPATCH_WORKER').map((a, i) => ({
      event_id: `rep-storm-${a.task}-a${a.attempt}`, task: a.task, lease: a.lease,
      outcome: { status: 'done', artifact: `artifact:${a.task}` }, run_id: `storm-${a.task}`,
    }));
    const results = await Promise.all(records.map(r => spawnEnqueueChild(lab.clone, r)));
    const wallMs = Date.now() - t0;
    const landed = results.filter(r => r.ok).length;
    recorder.metric('cas_storm_wall_ms', wallMs);
    recorder.metric('cas_storm_landed', landed);

    // the drain tick: exactly-once ledger diff
    const out2 = store.commit({
      mutate: (cur, queue, cq, qb, cb, iq, ib) => conductorTick({
        cur, queue, controlQueue: cq, queueBad: qb, ctlBad: cb, intakeQueue: iq, intakeBad: ib,
        ev: buildEvent({ action: 'fsm-tick', client_payload: { reason: 'drain' } }, { now }),
        now, nextMilestone: () => null, recover: () => null, makeGenesis: () => { throw new Error('no genesis expected'); },
      }),
    });
    const applied = (out2.journal || []).filter(j => j.kind === 'REPORT' && j.to === 'done');
    const dups = (out2.journal || []).filter(j => j.kind === 'REJECTED' && j.reason === 'duplicate');
    const done = out2.state?.stats?.done;
    recorder.check('cas-storm: ZERO CAS losses — every one of the 12 concurrent enqueues landed', landed === 12, `landed=${landed}/12`);
    recorder.check('cas-storm: every report applied EXACTLY once (ledger diff)', applied.length === 12 && dups.length === 0 && done === 12,
      `applied=${applied.length} dup=${dups.length} done=${done}`);
    recorder.metric('cas_storm_applied', applied.length);
    recorder.metric('cas_storm_duplicates', dups.length);
    return { landed, applied: applied.length };
  } finally {
    lab.cleanup();
  }
}

// ---------------------------------------------------------------------------
// the battery
// ---------------------------------------------------------------------------
export async function run({ quick, seed } = {}) {
  const rec = new Recorder('burst12');
  const seeds = quick ? [seed] : [seed, seed + 1, seed + 2];
  const drains = [];

  for (const s of seeds) {
    const lab = setupRepo('fsm-burst12-');
    try {
      const clock = makeClock();
      const store = new Store({ cwd: lab.clone });
      const cap = new ParallelCap({ slots: 5, clock, windowMs: BACKSTOP_MS, watch: 'conductor' });
      const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0.2, rng: mulberry32(s) });
      const project = burstProject(s);
      const g = genesis({ config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project, chainId: `burst-${s}`, now: clock.now() });
      store.init(g);
      const d = new CappedDriver({
        clock, store, project, cap, lane, seed: s,
        opts: { label: `burst12-${s}`, dispatchBudgetFn: (spent) => DISPATCH_BUDGET - spent, watchdogEvery: 10 * MIN },
      });
      d.run();
      const ticks = d.turnCount;
      const drainMs = clock.ms - T0;
      drains.push({ seed: s, ticks, drainMs });
      const maxAssigns = Math.max(0, ...d.assignsPerTurn);
      const depthMax = Math.max(0, ...cap.queueDepthSamples);
      const depthAvg = cap.queueDepthSamples.length ? cap.queueDepthSamples.reduce((a, b) => a + b, 0) / cap.queueDepthSamples.length : 0;

      if (s === seeds[0]) {   // the pinned checks run on the primary seed; the sweep adds numbers
        rec.check('burst12: all 12 tasks complete under the live cap (phase done)', d.state?.project?.phase === 'done' && d.state?.stats?.done === 12,
          `phase=${d.state?.project?.phase} done=${d.state?.stats?.done}`);
        rec.check('burst12: the conductor self-tick never starves > 2 consecutive windows under saturation',
          cap.maxConsecutiveStarved <= 2, `maxConsecutiveStarved=${cap.maxConsecutiveStarved}`);
        rec.check('burst12: dispatch pacing within the dispatchBudget (F-10)',
          maxAssigns <= DISPATCH_BUDGET, `maxAssignsPerTurn=${maxAssigns} budget=${DISPATCH_BUDGET}`);
        rec.check('burst12: every ASSIGN has its dispatch (no lost actions)', d.dispatchLog.length === 12,
          `dispatches=${d.dispatchLog.length}`);
        rec.check('burst12: drain-time bounded — the baseline pin (ticks ≤ 24)', ticks <= 24, `ticks-to-drain=${ticks}`);
        rec.metric('ticks_to_drain', ticks);
        rec.metric('virtual_drain_ms', drainMs);
        rec.metric('max_queue_depth', depthMax);
        rec.metric('avg_queue_depth', Math.round(depthAvg * 10) / 10);
        rec.metric('conductor_wait', cap.waitHistogram('conductor'));
        rec.metric('worker_wait', cap.waitHistogram('worker'));
        rec.metric('watchdog_wait', cap.waitHistogram('watchdog'));
        rec.metric('starvation_max_consecutive_windows', cap.maxConsecutiveStarved);
        rec.metric('runs_total', cap.completed.length);
      } else {
        rec.metric(`ticks_to_drain_seed${s}`, ticks);
      }
    } finally { lab.cleanup(); }
  }
  if (drains.length > 1) {
    const mean = drains.reduce((a, b) => a + b.ticks, 0) / drains.length;
    const spread = Math.max(...drains.map(x => x.ticks)) - Math.min(...drains.map(x => x.ticks));
    rec.metric('ticks_to_drain_mean', Math.round(mean * 10) / 10);
    rec.metric('ticks_to_drain_spread', spread);
    rec.note(`drain baseline across seeds [${drains.map(x => `#${x.seed}:${x.ticks}ticks`).join(' ')}] — mean ${Math.round(mean * 10) / 10}, spread ${spread}`);
  }

  // the SATURATED lane — the capacity boundary measured, not guessed: the
  // deployed shape (max_parallel=4) leaves the cap SLACK (queue depth 0
  // above); at max_parallel=5 the workers + watchdog scans genuinely contend
  // for the 5 slots (queue depth > 0, conductor waits real time) — the assert
  // is that the conductor STILL never starves > 2 windows (FIFO + the
  // watchdog's short runs keep the watch-name cycling). At 6 it starves
  // (the sabotage lane below) — the cliff is between 5 and 6, one slot of
  // headroom, exactly the a1 ARCH-2 capacity question.
  {
    const lab = setupRepo('fsm-burst-sat-');
    try {
      const clock = makeClock();
      const store = new Store({ cwd: lab.clone });
      const cap = new ParallelCap({ slots: 5, clock, windowMs: BACKSTOP_MS, watch: 'conductor' });
      const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0.2, rng: mulberry32(seed + 7) });
      const project = burstProject(seed + 7, { grinds: 6 });   // 6 nine-min grinds: 5 fill the slots for real
      const g = genesis({ config: { max_parallel: 5, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project, chainId: 'burst-sat', now: clock.now() });
      store.init(g);
      const d = new CappedDriver({ clock, store, project, cap, lane, seed: seed + 7, opts: { label: 'burst-sat', watchdogEvery: 10 * MIN } });
      d.run();
      const depthMax = Math.max(0, ...cap.queueDepthSamples);
      rec.check('burst12/saturated: max_parallel=5 contends the cap for real (queue depth > 0)',
        depthMax > 0, `maxQueueDepth=${depthMax}`);
      rec.check('burst12/saturated: the conductor still never starves > 2 windows at the 5-slot boundary',
        cap.maxConsecutiveStarved <= 2, `maxConsecutiveStarved=${cap.maxConsecutiveStarved}`);
      rec.check('burst12/saturated: all 12 tasks still complete', d.state?.project?.phase === 'done' && d.state?.stats?.done === 12,
        `done=${d.state?.stats?.done}`);
      rec.metric('saturated_max_queue_depth', depthMax);
      rec.metric('saturated_conductor_wait', cap.waitHistogram('conductor'));
      rec.metric('saturated_worker_wait', cap.waitHistogram('worker'));
      rec.metric('saturated_starvation_max_consecutive_windows', cap.maxConsecutiveStarved);
    } finally { lab.cleanup(); }
  }

  // the SABOTAGE lane — the starvation counter must DETECT real starvation:
  // max_parallel=6 against slots=5 (mis-provisioned: the FSM's parallelism
  // exceeds the repo cap minus the conductor's own slot) with 30-min grinds
  // and no short watchdog runs to cycle slots — the conductor's self-tick
  // sits FIFO behind queued grinds for > 2 windows. A green counter here
  // would mean the starvation assert above is vacuous.
  {
    const lab = setupRepo('fsm-burst-sab-');
    try {
      const clock = makeClock();
      const store = new Store({ cwd: lab.clone });
      const cap = new ParallelCap({ slots: 5, clock, windowMs: BACKSTOP_MS, watch: 'conductor' });
      const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0, rng: mulberry32(seed) });
      const project = burstProject(seed + 99, { grinds: 12, grindMs: 45 * MIN });   // ALL tasks: 45+min grinds
      // stagger the grind durations (45..60min) — synchronized completions
      // would free every slot at once and mask the starvation signal
      project.tasks.forEach((t, i) => { t.work_ms = 45 * MIN + (i % 6) * 3 * MIN; });
      const g = genesis({ config: { max_parallel: 6, lease_minutes: 60, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project, chainId: 'burst-sab', now: clock.now() });
      store.init(g);
      const d = new CappedDriver({ clock, store, project, cap, lane, seed: seed + 99, opts: { label: 'burst-sab', watchdog: false } });
      d.run(8);   // bound the sabotage lane — we only need the starvation signal
      rec.check('burst12/sabotage: the starvation counter DETECTS a starved conductor (> 2 windows)',
        cap.maxConsecutiveStarved > 2, `maxConsecutiveStarved=${cap.maxConsecutiveStarved} (the assert is honest, not vacuous)`);
      rec.metric('sabotage_starvation_max_consecutive_windows', cap.maxConsecutiveStarved);
    } finally { lab.cleanup(); }
  }

  await casStorm(rec, seed);
  return rec;
}
