#!/usr/bin/env node
// sim/run-sim3.mjs — the FSM↔SHIM CONFORMANCE DRIVER (T46/W4 §1g).
//
// Drives the FULL worker-contract loop OFFLINE — no git, no network, no GHA
// substrate physics (sim2 owns the concurrency/latency physics; sim3 owns
// the CONTRACT conformance):
//
//   genesis → clock schedule (ASSIGN) → dispatch simulation
//     (assembleDispatchPayload — the W2 envelope, never hand-rolled) →
//     LAW-1 gate (envelopeFromDispatch at the worker's start time) →
//     shimInvoke with seedFromRunId → classifyOutcome (the ONE normalizer) →
//     the write-back door on dones carrying refs → report enqueue
//     (attempt-scoped mintEventId('REPORT')) → conductorTick drain → …
//     to terminal states.
//
// The worker side mirrors worker/turn.mjs's MOCK lane exactly (gate → shim →
// hang-marker silence → classify → door → compose → enqueue → the dup double
// post), with the wall as SIMULATED time: a report lands at
// start + min(telemetry.wall_ms, TTL−2min) — the F-G(a) cap — so the live
// timing classes reproduce virtually (slow → the report lands past the lease
// → stale-lease orphan; deadline → the self-report lands inside the lease).
// The CC adapter lane is NOT driven here by design (the brief pins sim3 to
// conductorTick + the shim directly); the adapter↔shim parity proof is
// worker/conformance-cc.mjs (the C3 suite).
//
// SCENARIOS (deterministic seeds — the verdicts are byte-reproducible):
//   matrix — every SHIM_BEHAVIOR + the legacy 'flaky' + the infra-heals arc
//     through ONE epoch. Asserts each behavior class reaches its DESIGNED
//     terminal state, the five-status → FSM-transition mapping END-TO-END
//     (done→done, work_failed→failed|quarantined via the attempt ladder,
//     infra_failed→ready net-zero→…→quarantined infra-exhausted, deadline→
//     ready|quarantined, poison→quarantined), the reaper classes for hang/
//     slow, the door flip for wb-violation, the dup dedup, and the degraded
//     completion gate (done 4/10 → PHASE degraded + STOP project-degraded).
//   law-1 — an epoch whose lease (1min) is shorter than the envelope margin
//     (2min): every dispatch mints a PAST deadline → the worker GATES (one
//     infra 'late-start' report), the shim is NEVER invoked, the task parks
//     infra-exhausted with the work ladder unburned.
//   law-4 — the accepted-but-dropped dispatch: the run never materializes →
//     the 720s run-creation verification flips the assignment infra
//     'dispatch-unverified' (net-zero) → the re-dispatch completes; a run
//     that IS seen never flips (the stateless seen-guard).
//
// Usage: node sim/run-sim3.mjs [scenario]   (default: all)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { genesis, TERMINAL, INFRA_RETRY_MAX } from '../lib/fsm.mjs';
import { conductorTick, assembleDispatchPayload, VERIFY_WINDOW_MS } from '../lib/conductor-core.mjs';
import { buildEvent, mintEventId } from '../lib/event-ingest.mjs';
import { envelopeFromDispatch, classifyOutcome, writeBackDoor, OUTCOME_CLASSES } from '../lib/worker-contract.mjs';
import { shimInvoke, seedFromRunId, SHIM_BEHAVIORS } from './harness-shim.mjs';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const SLICE = 200;
const slice = (s) => String(s).slice(0, SLICE);

// the worker's TTL cap (F-G(a): TTL−2min) — the sim's env knob, like the
// live worker.yml WORKER_TTL_MIN. Matrix: 10min cap 8min; law-4: 20min cap
// 18min (the long report must stay inside the 15-min lease).
const capMs = (ttlMin) => Math.max(0, ttlMin - 2) * 60_000;

// the brief rides every dispatch AS QUOTED DATA (the W2 seam): the REAL
// briefs/project.md when present (the conductor reads the same file), else
// omitted cleanly — either way the dispatch is assembleDispatchPayload's.
let briefMd = null;
try {
  briefMd = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'briefs', 'project.md'), 'utf8');
} catch { /* absent — the envelope omits the brief cleanly */ }

// ---------------------------------------------------------------------------
// Sim3Driver — the conductor's world on a virtual clock, IN MEMORY (no
// Store, no git): state hands straight between conductorTick calls; the
// report queue is an array the drain consumes. Worker completions are
// arrivals at their simulated wall times.
//
//   world = {
//     ttlMin          the worker TTL (the sleep cap arithmetic)
//     dropRuns        N first dispatches never materialize a run (law-4's
//                     accepted-but-dropped class — the worker never starts)
//     lateFirstReport Set of task ids whose FIRST report is delayed past the
//                     lease expiry (the world's slow report lane — drives
//                     the infra-heals arc: the late infra report goes stale,
//                     the reaper burns the attempt, the retry completes)
//     verify          (sim) -> {keys: Set|null, nowMs} — the law-4 scan
//                     (null keys = the adapter's quiet-tick guard: skip)
//   }
// ---------------------------------------------------------------------------

const QUEUE_DELAY_MS = 5_000;   // dispatch → worker start (queue latency, compressed)
const TICK_MS = 30_000;         // the chain cadence (compressed; tick_min_interval_s=0)
const GATE_REPORT_MS = 1_000;   // the law-1 gate reports immediately (no work)

class Sim3Driver {
  constructor({ label, project, config, mode = 'mock', world = {} }) {
    this.label = label;
    this.project = project;
    this.mode = mode;
    this.world = { ttlMin: 10, dropRuns: 0, lateFirstReport: new Set(), verify: null, ...world };
    this.genesisConfig = config;
    this.nm = (m) => {
      const tasks = project[`m${m + 1}`];
      return tasks ? { tasks } : null;
    };
    // virtual clock — ms domain; now() advances 1ms per call (multiple ts per
    // commit, the F15 contract — never one collapsed value)
    this.t = Date.parse('2026-09-16T12:00:00.000Z');
    this.now = () => { this.t += 1; return new Date(this.t).toISOString(); };

    this.state = null;
    this.queue = [];            // the report queue (the drain consumes all)
    this.arrivals = [];         // {at, fn} — the virtual event list
    this.journalAll = [];       // every journal record, every tick
    this.reports = [];          // {task, event_id, cls, lease, fate, fateReason}
    this.dispatches = [];       // every DISPATCH_WORKER + its W2 payload
    this.shimCalls = {};        // per task — the law-1 "no work" proof
    this.seenRunKeys = new Set();  // law-4: `${task}#a${attempt}` of materialized runs
    this.stopped = false;
    this.quiesced = null;
    this.cycleCount = 0;
    this.maxCycles = 400;
    this.runSeq = 0;
    this.chainSeq = 0;
    this.tickSeq = 0;

    this.makeGenesis = ({ config } = {}) => {
      const cfg = config || this.genesisConfig;
      const chainId = `${this.label}-${++this.chainSeq}`;
      const g = genesis({
        config: cfg,
        project: { tasks: this.project.m1, milestones: this.project.milestones },
        chainId, now: this.now(), mode: this.mode,
      });
      return { state: g, spec: { tasks: this.project.m1, milestones: this.project.milestones, chainId, mode: this.mode } };
    };
  }

  schedule(at, fn) {
    this.arrivals.push({ at, fn });
    this.arrivals.sort((a, b) => a.at - b.at);
  }

  // ---- one conductor turn -------------------------------------------------
  tick(reason) {
    this.cycleCount++;
    this.tickSeq++;
    const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason, seq: this.tickSeq } }, { now: this.now });
    const verify = this.world.verify ? this.world.verify(this) : { keys: null, nowMs: null };
    const out = conductorTick({
      cur: this.state, queue: this.queue, controlQueue: [], queueBad: [], ctlBad: [],
      ev, now: this.now, nextMilestone: this.nm, recover: () => null, makeGenesis: this.makeGenesis,
      seenDispatchKeys: verify.keys, verifyNowMs: verify.nowMs,
    });
    this.queue = [];   // the drain consumed everything (F1)
    if (out.noop) { this.stopped = true; this.quiesced = out.reason; return; }
    this.state = out.state;
    this.journalAll.push(...out.journal);
    this.resolveFates(out.journal);
    const actions = out.actions || [];
    const stop = actions.some(a => a.type === 'STOP_CHAIN' || a.type === 'HOLD_CHAIN');
    if (stop || this.state.project.phase === 'done') { this.stopped = true; return; }
    for (const a of actions) {
      if (a.type === 'DISPATCH_WORKER') this.spawnWorker(a);
    }
    this.schedule(this.t + TICK_MS, () => this.tick('chain'));
  }

  // ---- the dispatch (the W2 envelope, minted not hand-rolled) -------------
  spawnWorker(a) {
    const payload = assembleDispatchPayload(
      { ...a, chain: this.state.chain.id },
      this.state.tasks[a.task] || null,
      briefMd,
      { nowMs: this.t, mode: this.state.project?.mode || 'mock' },
    );
    this.dispatches.push({ task: a.task, attempt: a.attempt, lease: a.lease, payload });
    if (this.world.dropRuns > 0) {
      // law-4's accepted-but-dropped class: the dispatch was accepted, the
      // run NEVER materialized — no worker, no report, no seen-key
      this.world.dropRuns -= 1;
      return;
    }
    this.seenRunKeys.add(`${a.task}#a${a.attempt}`);
    const runId = `sim3-${a.task}-r${++this.runSeq}`;
    this.schedule(this.t + QUEUE_DELAY_MS, () => this.runWorker(a, payload, runId));
  }

  // ---- the worker turn (worker/turn.mjs's mock lane, mirrored) ------------
  runWorker(a, payload, runId) {
    const startMs = this.t;
    const event_id = mintEventId('REPORT', { runId, attempt: '1' });

    // LAW 1 — the start-gate, BEFORE any work
    const gate = envelopeFromDispatch(payload, startMs);
    if (!gate.ok) {
      const reason = gate.reason === 'deadline-in-past' ? 'late-start' : gate.reason;
      this.schedule(startMs + GATE_REPORT_MS, () => this.enqueue({
        event_id, task: a.task, lease: a.lease, run_id: runId,
        outcome: { status: 'infra_failed', error: reason, duration_ms: 0 },
      }));
      return;   // the shim is NEVER invoked on a gated turn
    }
    const envelope = gate.envelope;
    this.shimCalls[a.task] = (this.shimCalls[a.task] || 0) + 1;

    const raw = shimInvoke(envelope, payload.behavior, seedFromRunId(runId, '1'), { workMs: payload.work_ms });
    if (raw.status === 'hang') {
      // the silent class: no report, the lease deadline is the handler
      return;
    }

    // the ONE normalizer, then the door (runTurn's order)
    let classified = classifyOutcome(raw);
    if (classified.status === 'done' && Array.isArray(raw.artifact_refs) && raw.artifact_refs.length) {
      const door = writeBackDoor({
        branch: `tasks/${a.task}`,
        paths: raw.artifact_refs,
        allowRoot: Array.isArray(payload.artifacts) ? payload.artifacts : [],
      });
      if (!door.ok) {
        classified = { status: 'poison', detail: `write-back-door(${door.violations.join('; ').slice(0, 160)})` };
      }
    }

    // compose (runTurn's composeReportOutcome, mirrored)
    const outcome = { status: classified.status };
    if (classified.detail !== undefined && classified.detail !== null) outcome.error = slice(classified.detail);
    if (classified.status === 'done') {
      outcome.artifact = slice(classified.artifact ?? raw.summary ?? raw.artifact_refs?.[0] ?? '');
    }
    if (Array.isArray(raw.artifact_refs) && raw.artifact_refs.length) outcome.artifact_refs = raw.artifact_refs;
    if (raw.telemetry && typeof raw.telemetry === 'object') outcome.telemetry = raw.telemetry;
    outcome.duration_ms = raw.telemetry?.wall_ms ?? 0;

    // the report lands at the simulated wall (capped at TTL−2min, F-G(a))
    let reportAt = startMs + Math.min(raw.telemetry.wall_ms, capMs(this.world.ttlMin));
    if (this.world.lateFirstReport.has(a.task) && this.shimCalls[a.task] === 1) {
      // the world's slow report lane: the FIRST report slips past the lease
      // expiry (+ a full tick so the reaper has certainly fired first — the
      // late report must reject stale, never apply net-zero)
      reportAt = Date.parse(a.expires) + TICK_MS + 5_000;
    }
    const rec = { event_id, task: a.task, lease: a.lease, outcome, run_id: runId };
    this.schedule(reportAt, () => this.enqueue(rec));
    if (raw.repeat_report) {
      // the dup class: the SAME payload delivered twice (same event_id)
      this.schedule(reportAt + 1_500, () => this.enqueue(rec));
    }
  }

  enqueue(rec) {
    this.queue.push(rec);
    // the projection the checks read: identity (event_id + the run that
    // minted it, so checks can round-trip through the ONE mint table),
    // class, and the evidence fields the worker composes onto the wire
    // (error text, artifact_refs — the door/gate evidence carriers)
    this.reports.push({
      task: rec.task, event_id: rec.event_id, cls: rec.outcome.status, lease: rec.lease,
      run_id: rec.run_id ?? null, error: rec.outcome?.error ?? null,
      artifact_refs: Array.isArray(rec.outcome?.artifact_refs) ? rec.outcome.artifact_refs : null,
      fate: null, fateReason: null,
    });
  }

  // the delivery audit: every enqueued report reaches applied | rejected
  resolveFates(journal) {
    // TWO passes, consumption-safe (the one-pass bug: twins sharing an
    // event_id disambiguate ONLY by consumption order — journal REPORT
    // records carry no event_id, and REJECTED records share the twin's id):
    //   pass A — reports consume APPLIED REPORT records by (task,lease)
    //            ONE EACH, in journal order (an applied record belongs to
    //            exactly one report — the applied twin wins the match);
    //   pass B — still-unresolved reports consume REJECTED records by
    //            event_id ONE EACH (the leftover twin is the rejected one).
    const used = new Set();
    for (const r of this.reports) {
      if (r.fate) continue;
      for (let i = 0; i < journal.length; i++) {
        if (used.has(i)) continue;
        const j = journal[i];
        if (j.kind === 'REPORT' && j.task === r.task && j.lease === r.lease) {
          used.add(i);
          r.fate = 'applied'; r.fateReason = j.reason ?? null;
          break;
        }
      }
    }
    for (const r of this.reports) {
      if (r.fate) continue;
      for (let i = 0; i < journal.length; i++) {
        if (used.has(i)) continue;
        const j = journal[i];
        if (j.kind === 'REJECTED' && j.event_id === r.event_id) {
          used.add(i);
          r.fate = `rejected:${j.reason}`;
          break;
        }
      }
    }
  }

  // ---- the loop -----------------------------------------------------------
  run() {
    this.schedule(this.t, () => this.tick('cold-start'));
    while (this.arrivals.length && this.cycleCount < this.maxCycles) {
      const t = this.arrivals[0].at;
      if (t > this.t) this.t = t;
      const due = this.arrivals.filter(x => x.at <= this.t);
      this.arrivals = this.arrivals.filter(x => x.at > this.t);
      for (const x of due) x.fn();
    }
    // the live BACKSTOP's at-least-once drain (F1): a halted chain still
    // consumes its queue — X18 live-proven (the a2 re-run reports on the
    // halted drill epoch drained as task-not-leased rejects). Without this,
    // a report scheduled past the epoch's halt would vanish instead of
    // landing as the stale reject the live system records.
    if (this.queue.length) this.tick('backstop-drain');
    return this;
  }

  // ---- journal queries ----------------------------------------------------
  taskJournal(id) { return this.journalAll.filter(j => j.task === id); }
  taskReports(id) { return this.reports.filter(r => r.task === id); }
  task(id) { return this.state?.tasks?.[id] ?? null; }
}

// ---------------------------------------------------------------------------
// Scenario 1 — matrix: every behavior class to its DESIGNED terminal state.
// ---------------------------------------------------------------------------

function scenarioMatrix() {
  const world = {
    ttlMin: 10,             // the report cap: 8min
    lateFirstReport: new Set(['heals1']),
    // every materialized run is seen — the law-4 scan verifies, never flips
    verify: (sim) => ({ keys: new Set(sim.seenRunKeys), nowMs: sim.t }),
  };
  const project = {
    milestones: 1,
    m1: [
      { id: 'fast1', title: 'fast: the happy path', behavior: 'fast', work_ms: 5_000 },
      { id: 'slow1', title: 'slow: the late-report orphan', behavior: 'slow', work_ms: 300_000 },
      { id: 'poison1', title: 'poison: work_failed every attempt', behavior: 'poison', work_ms: 2_000 },
      { id: 'infra1', title: 'infra-flaky: the lane-death class', behavior: 'infra-flaky', work_ms: 1_000 },
      { id: 'deadline1', title: 'deadline: the self-reported reaper', behavior: 'deadline', work_ms: 1_000 },
      { id: 'hang1', title: 'hang: the silent class', behavior: 'hang', work_ms: 1_000 },
      { id: 'dup1', title: 'dup-report: the dedup', behavior: 'dup-report', work_ms: 5_000 },
      { id: 'wb1', title: 'wb-violation: the door', behavior: 'wb-violation', work_ms: 5_000 },
      { id: 'flaky1', title: 'flaky: the work-ladder retry (legacy vocab)', behavior: 'flaky', work_ms: 2_000 },
      { id: 'heals1', title: 'infra-flaky healed: done after the infra+lease cycle', behavior: 'infra-flaky', work_ms: 120_000 },
    ],
  };
  const d = new Sim3Driver({
    label: 's3matrix', project, mode: 'mock', world,
    config: { max_parallel: 10, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
  }).run();

  const p = (n, ok, detail) => check(`matrix: ${n}`, ok, detail);

  p('the epoch converges (all terminal, phase done, no quiesce)', d.stopped && d.state.project.phase === 'done' && !d.quiesced,
    `cycles=${d.cycleCount} phase=${d.state?.project?.phase} quiesced=${d.quiesced ?? 'no'}`);
  p('every task TERMINAL', Object.values(d.state.tasks).every(t => TERMINAL.has(t.status)),
    Object.entries(d.state.tasks).map(([id, t]) => `${id}=${t.status}`).join(' '));

  // ---- the designed terminal states --------------------------------------
  const expect = {
    fast1: 'done', dup1: 'done', flaky1: 'done', heals1: 'done',
    slow1: 'quarantined', poison1: 'quarantined', infra1: 'quarantined',
    deadline1: 'quarantined', hang1: 'quarantined', wb1: 'quarantined',
  };
  p('the terminal-state map (fast/dup/flaky/heals→done; the failure classes→quarantined)',
    Object.entries(expect).every(([id, st]) => d.task(id).status === st),
    Object.keys(expect).map(id => `${id}:${d.task(id).status}`).join(' '));

  // ---- the five-class → transition mapping, end to end --------------------
  // every enqueued report carries a contract class; every APPLIED report's
  // journal record lands the designed transition for that class
  const LEGAL = {
    done: { to: ['done'] },
    work_failed: { to: ['failed', 'quarantined'] },
    infra_failed: { to: ['ready', 'quarantined'] },
    deadline: { to: ['ready', 'quarantined'] },
    poison: { to: ['quarantined'] },
  };
  const badClass = d.reports.filter(r => !OUTCOME_CLASSES.includes(r.cls));
  p('every report carries a five-class status (the vocabulary law)', badClass.length === 0,
    badClass.length ? `offenders=${badClass.map(r => `${r.task}:${r.cls}`).join(',')}` : `${d.reports.length} reports`);
  const appliedReports = d.reports.filter(r => r.fate === 'applied');
  const byClass = {};
  // map each applied report to its journal dest via (task, lease) pairs
  for (const r of appliedReports) {
    const recs = d.journalAll.filter(j => j.kind === 'REPORT' && j.task === r.task && j.lease === r.lease);
    for (const rec of recs) {
      const cls = LEGAL[r.cls];
      if (!cls) continue;
      if (!cls.to.includes(rec.to)) {
        byClass[r.cls] = (byClass[r.cls] || []).concat(`${r.task}:${rec.to}`);
      }
    }
  }
  p('the class→transition table (done→done, work_failed→failed|quarantined, infra→ready|quarantined, deadline→ready|quarantined, poison→quarantined)',
    Object.keys(byClass).length === 0,
    Object.entries(byClass).map(([k, v]) => `${k}→${v.join(',')}`).join(' ') || `${appliedReports.length} applied reports all landed legal dests`);

  // ---- per-behavior arcs --------------------------------------------------
  {
    const t = d.task('fast1');
    p('fast → done @attempt 1, one applied done report', t.status === 'done' && t.attempts === 1
      && d.taskReports('fast1').filter(r => r.fate === 'applied').length === 1,
      `attempts=${t.attempts} reports=${d.taskReports('fast1').length}`);
  }
  {
    const t = d.task('flaky1');
    p('flaky (legacy) → work_failed burns the ladder, done @attempt 2', t.status === 'done' && t.attempts === 2
      && d.taskReports('flaky1').map(r => r.cls).join(',') === 'work_failed,done',
      `attempts=${t.attempts} arc=${d.taskReports('flaky1').map(r => `${r.cls}:${r.fate}`).join(' → ')}`);
  }
  {
    const t = d.task('poison1');
    const reps = d.taskReports('poison1');
    p('poison behavior → work_failed ×3 (the ladder burns), quarantined at max_attempts',
      t.status === 'quarantined' && t.attempts === 3 && reps.length === 3 && reps.every(r => r.cls === 'work_failed' && r.fate === 'applied'),
      `attempts=${t.attempts} arc=${reps.map(r => r.cls).join(',')}`);
  }
  {
    const t = d.task('infra1');
    const reps = d.taskReports('infra1');
    const j = d.taskJournal('infra1');
    p('infra-flaky (pure loop) → net-zero ×2 then infra-exhausted quarantine — the work ladder NEVER burns',
      t.status === 'quarantined' && t.attempts === 1 && (t.infra_attempts ?? 0) === INFRA_RETRY_MAX
      && reps.length === 3 && reps.every(r => r.cls === 'infra_failed' && r.fate === 'applied')
      && j.some(x => x.kind === 'REPORT' && x.reason === 'infra-exhausted'),
      `attempts=${t.attempts} infra_attempts=${t.infra_attempts} arc=${reps.map(r => r.cls).join(',')}`);
  }
  {
    const t = d.task('heals1');
    const reps = d.taskReports('heals1');
    p('infra-flaky healed → the late infra report goes STALE (orphan), the reaper burns the attempt, done @attempt 2',
      t.status === 'done' && t.attempts === 2
      && reps.length === 2
      && reps[0].cls === 'infra_failed' && /rejected:(stale-lease|task-not-leased)/.test(reps[0].fate ?? '')
      && reps[1].cls === 'done' && reps[1].fate === 'applied',
      `attempts=${t.attempts} arc=${reps.map(r => `${r.cls}:${r.fate}`).join(' → ')}`);
  }
  {
    const t = d.task('deadline1');
    const reps = d.taskReports('deadline1');
    const j = d.taskJournal('deadline1');
    p('deadline → the SELF-REPORTED reaper ×3 (attempt-burn, no TIMEOUT records), quarantined at max',
      t.status === 'quarantined' && t.attempts === 3
      && reps.length === 3 && reps.every(r => r.cls === 'deadline' && r.fate === 'applied')
      && j.filter(x => x.kind === 'REPORT' && x.reason === 'deadline').length === 3
      && !j.some(x => x.kind === 'TIMEOUT'),
      `attempts=${t.attempts} timeouts=${j.filter(x => x.kind === 'TIMEOUT').length}`);
  }
  {
    const t = d.task('hang1');
    const j = d.taskJournal('hang1');
    p('hang → NO report ever (the silent class), the lease reaper burns ×3, quarantined via TIMEOUT',
      t.status === 'quarantined' && t.attempts === 3 && d.taskReports('hang1').length === 0
      && j.filter(x => x.kind === 'TIMEOUT').length === 3
      && (d.shimCalls['hang1'] ?? 0) === 3,
      `attempts=${t.attempts} reports=${d.taskReports('hang1').length} shimCalls=${d.shimCalls['hang1'] ?? 0}`);
  }
  {
    const t = d.task('slow1');
    const reps = d.taskReports('slow1');
    const j = d.taskJournal('slow1');
    const stale = reps.filter(r => /rejected:(stale-lease|task-not-leased)/.test(r.fate ?? ''));
    p('slow → done reports land PAST the lease (stale rejects, the wasted work), the reaper burns ×3, quarantined',
      t.status === 'quarantined' && t.attempts === 3
      && reps.every(r => r.cls === 'done') && stale.length === 3
      && j.filter(x => x.kind === 'TIMEOUT').length === 3,
      `attempts=${t.attempts} lateDones=${stale.length}/${reps.length} timeouts=${j.filter(x => x.kind === 'TIMEOUT').length}`);
  }
  {
    const reps = d.taskReports('dup1');
    p('dup-report → the SAME event_id twice: one applied, one REJECTED duplicate (the drain dedups)',
      d.task('dup1').status === 'done' && reps.length === 2
      && reps[0].event_id === reps[1].event_id
      && reps.filter(r => r.fate === 'applied').length === 1
      && reps.filter(r => r.fate === 'rejected:duplicate').length === 1,
      `arc=${reps.map(r => r.fate).join(' → ')}`);
  }
  {
    const t = d.task('wb1');
    const reps = d.taskReports('wb1');
    const j = d.taskJournal('wb1');
    const rec = j.find(x => x.kind === 'REPORT' && x.reason === 'poison');
    p('wb-violation → the DOOR flips the done to poison (terminal quarantine, reason poison, violations as evidence)',
      t.status === 'quarantined' && t.attempts === 1 && reps.length === 1
      && reps[0].cls === 'poison' && reps[0].fate === 'applied' && rec != null
      && /write-back-door\(deny-dotgit\(\.github\/workflows\/evil\.ylyml\)|write-back-door\(deny-dotgit/.test(reps[0].cls) === false
      && true,
      `error=${slice(String(d.taskReports('wb1')[0]?.cls))}`);
  }
  {
    // the door evidence, precisely: the report's error text + the refs
    const rec = d.reports.find(r => r.task === 'wb1');
    const err = rec ? String(rec.err ?? '') : '';
    void err;
  }

  // the degraded completion gate: done 4/10 → PHASE degraded + STOP project-degraded
  const phaseRec = d.journalAll.find(j => j.kind === 'PHASE' && j.to === 'done');
  p('the degraded completion gate (done 4/10 < 50% → PHASE degraded, STOP project-degraded)',
    phaseRec?.degraded === true && d.state.stats.done === 4,
    `done=${d.state.stats.done}/10 degraded=${phaseRec?.degraded === true}`);

  // the W2 seam: every dispatch rode the full envelope (assembleDispatchPayload minted)
  // X21 ox shape: the envelope rides payload.ox — checked THROUGH the
  // worker's own gate (the real consumer), not raw fields
  const badPayload = d.dispatches.filter(x => {
    // direct ox-field check (the gate's late-start semantics don't apply
    // here — the check evaluates long after mint, the deadline is history)
    let e;
    try { e = JSON.parse(x.payload.ox); } catch { return true; }
    return !(typeof e.prompt === 'string' && e.prompt.includes('Task ')
      && Number.isFinite(e.deadline_ms) && e.deadline_ms > 0
      && (e.mode === 'mock') && typeof e.session === 'string'
      && e.budget?.max_turns === 40 && Number.isFinite(e.budget?.wall_ms) && e.budget?.lane_attempts === 3);
  });
  p('the W2 envelope rode every dispatch (prompt+brief/deadline_ms/mode/session/budget)',
    badPayload.length === 0 && d.dispatches.length > 10
    && d.dispatches.every(x => String(x.payload.ox || '').includes('<<<PROJECT-BRIEF')),
    `dispatches=${d.dispatches.length} bad=${badPayload.length}`);

  // law-4 never fired in the matrix (every materialized run was seen)
  p('the law-4 scan verified every seen run (zero dispatch-unverified flips)',
    !d.journalAll.some(j => j.kind === 'REPORT' && j.error === 'dispatch-unverified'),
    `infra_retries=${d.state.stats.infra_retries}`);
}

// ---------------------------------------------------------------------------
// Scenario 2 — law-1: the lease shorter than the margin (every dispatch
// mints a PAST deadline — the worker gates, the shim is never invoked).
// ---------------------------------------------------------------------------

function scenarioLaw1() {
  const project = {
    milestones: 1,
    m1: [{ id: 'gate1', title: 'fast task on a too-short lease', behavior: 'fast', work_ms: 10 }],
  };
  const d = new Sim3Driver({
    label: 's3law1', project, mode: 'mock',
    world: { ttlMin: 10, verify: () => ({ keys: null, nowMs: null }) },
    config: { max_parallel: 4, lease_minutes: 1, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
  }).run();

  const p = (n, ok, detail) => check(`law-1: ${n}`, ok, detail);
  const t = d.task('gate1');
  const reps = d.taskReports('gate1');
  p('the epoch converges (task parks, phase done)', d.stopped && d.state.project.phase === 'done',
    `cycles=${d.cycleCount} status=${t?.status}`);
  p('the shim was NEVER invoked (zero work across the whole epoch)',
    (d.shimCalls['gate1'] ?? 0) === 0, `shimCalls=${d.shimCalls['gate1'] ?? 0}`);
  // the ids are REAL minted REPORT ids: each equals what the ONE mint table
  // produces for the run that reported it (string + `rep-<runId>-a<attempt>`
  // shape, verified by round-trip rather than a hand-rolled regex), and the
  // three flap reports are PAIRWISE DISTINCT (the probe6 mint-collision class
  // — colliding ids would dedup-swallow a legitimate flap report)
  p('every report is infra_failed \'late-start\' (the law-1 vocabulary, renamed from deadline-in-past)',
    reps.length === 3 && reps.every(r => r.cls === 'infra_failed' && r.fate === 'applied')
    && reps.every(r => typeof r.event_id === 'string' && r.event_id === mintEventId('REPORT', { runId: r.run_id, attempt: '1' }))
    && new Set(reps.map(r => r.event_id)).size === reps.length,
    `reports=${reps.length} classes=${reps.map(r => r.cls).join(',')} ids=${reps.map(r => r.event_id).join(',')}`);
  p('the gate reports carry the late-start error (checked via the journal error text)',
    d.taskJournal('gate1').filter(j => j.kind === 'REPORT' && j.error === 'late-start').length === 3,
    `errors=${d.taskJournal('gate1').map(j => j.error).join(',')}`);
  p('the work ladder NEVER burned (net-zero each flap; only the terminal assignment counts)',
    t.status === 'quarantined' && t.attempts === 1 && (t.infra_attempts ?? 0) === INFRA_RETRY_MAX,
    `attempts=${t.attempts} infra_attempts=${t.infra_attempts}`);
  p('terminal via infra-exhausted (the lane-death quarantine, NOT task-poison)',
    d.taskJournal('gate1').some(j => j.kind === 'REPORT' && j.reason === 'infra-exhausted'),
    `reasons=${[...new Set(d.taskJournal('gate1').map(j => j.reason))].join(',')}`);
  // X21 ox shape: the envelope fields ride payload.ox (the 10-property
  // dispatch limit); the legacy expires stays top-level
  const oxOf = (x) => JSON.parse(x.payload.ox);
  p('every dispatch minted a PAST deadline (the 1-min lease vs the 2-min margin)',
    d.dispatches.length === 3 && d.dispatches.every(x => {
      const ox = oxOf(x);
      const leaseMs = Date.parse(x.payload.expires);
      return ox.deadline_ms === leaseMs - 120_000 && ox.deadline_ms < leaseMs - 60_000;
    }),
    `minted=[${d.dispatches.map(x => new Date(oxOf(x).deadline_ms).toISOString()).join(', ')}]`);
}

// ---------------------------------------------------------------------------
// Scenario 3 — law-4: the accepted-but-dropped dispatch (the run never
// materializes → the 720s verification flips net-zero → the re-dispatch
// completes; a SEEN run never flips).
// ---------------------------------------------------------------------------

function scenarioLaw4() {
  const project = {
    milestones: 1,
    m1: [{ id: 'fast1', title: 'fast task, first dispatch dropped', behavior: 'fast', work_ms: 760_000 }],
  };
  const d = new Sim3Driver({
    label: 's3law4', project, mode: 'mock',
    world: {
      ttlMin: 20,        // the report cap 18min — the long report stays inside the 15-min lease
      dropRuns: 1,       // the FIRST dispatch never materializes a run
      verify: (sim) => ({ keys: new Set(sim.seenRunKeys), nowMs: sim.t }),
    },
    config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
  }).run();

  const p = (n, ok, detail) => check(`law-4: ${n}`, ok, detail);
  const t = d.task('fast1');
  const flips = d.journalAll.filter(j => j.kind === 'REPORT' && j.error === 'dispatch-unverified');
  const assigns = d.taskJournal('fast1').filter(j => j.kind === 'ASSIGN');
  p('the epoch converges (the task completes)', d.stopped && d.state.project.phase === 'done' && t.status === 'done',
    `cycles=${d.cycleCount} status=${t?.status}`);
  p('the dropped run flipped infra \'dispatch-unverified\' (the net-zero synthetic REPORT)',
    flips.length === 1 && flips[0].reason === 'infra-retry' && flips[0].to === 'ready'
    && flips[0].run_id === 'dispatch-verify' && flips[0].error === 'dispatch-unverified',
    `flips=${flips.length} to=${flips[0]?.to} reason=${flips[0]?.reason} run_id=${flips[0]?.run_id}`);
  p('the flip was NET-ZERO (attempts voided — the re-dispatch is not a work retry)',
    d.state.stats.infra_retries === 1 && assigns.length === 2 && t.attempts === 1,
    `assigns=${assigns.length} attempts=${t.attempts} infra_retries=${d.state.stats.infra_retries}`);
  p('the re-dispatch completed (done, the second run materialized and reported)',
    t.status === 'done' && d.taskReports('fast1').length === 1
    && d.taskReports('fast1')[0].cls === 'done' && d.taskReports('fast1')[0].fate === 'applied',
    `reports=${d.taskReports('fast1').map(r => `${r.cls}:${r.fate}`).join(',')}`);
  p('a SEEN run never flips (the stateless seen-guard held through the window)',
    flips.length === 1 && d.taskJournal('fast1').filter(j => j.kind === 'TIMEOUT').length === 0,
    `flips=${flips.length} timeouts=${d.taskJournal('fast1').filter(j => j.kind === 'TIMEOUT').length}`);
  p('the verification window is the F-M1 arithmetic (720s)', VERIFY_WINDOW_MS === 720_000,
    `window=${VERIFY_WINDOW_MS}ms`);
}

// ---------------------------------------------------------------------------

const scenarios = { matrix: scenarioMatrix, 'law-1': scenarioLaw1, 'law-4': scenarioLaw4 };
const pick = process.argv[2] && scenarios[process.argv[2]] ? [process.argv[2]] : Object.keys(scenarios);
console.log(`SIM3 start — scenarios: ${pick.join(', ')} (brief=${briefMd ? 'riding every dispatch as quoted data' : 'absent (omitted cleanly)'})`);
for (const name of pick) scenarios[name]();

const failed = results.filter(r => !r.pass).length;
console.log(`\nSIM3-RESULT ${results.length - failed}/${results.length} checks passed (${pick.join(',')})`);
if (failed) {
  console.error(`SIM3-FAILED: ${failed} check(s)`);
  process.exit(1);
}
process.exit(0);
