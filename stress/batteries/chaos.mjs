// stress/batteries/chaos.mjs — BATTERY 6: the KILL-MID-FLIGHT chaos battery
// (a6 §6.1 item 6 — the yardstick's chaos GAP; brief s23-chaos).
//
// A seeded KillScheduler SIGKILLs REAL adapter children at the dangerous
// boundaries while one epoch runs to its halt:
//
//   B1 worker-pre-report          a worker child dies mid-work (before its
//                                 report push — the silent wedge: no report,
//                                 the lease deadline is the handler)
//   B2 conductor-post-commit      a conductor child dies right after its state
//                                 commit (the CRASH CLASS: assigned-but-
//                                 never-dispatched leases when the kill beats
//                                 the action loop; a mid-drain crash when it
//                                 does not — both shapes land, both recover)
//   B3 worker-report-push         a worker child dies just after its report
//                                 line landed on the queue (for the dup-report
//                                 tasks: between the first and second enqueue
//                                 — the DUP CLASS; for plain tasks: after the
//                                 report, before exit)
//   B4 worker-post-taskbranch     a cc worker dies after its tasks/<id> branch
//                                 push, before the report (branch landed, work
//                                 unreported — the lease reaper re-drives, the
//                                 re-attempt's identical-tree skip is the
//                                 designed crash-recovery: L2-4)
//   B5 conductor-mid-pr           a conductor child dies right after the PR
//                                 create POST, before the stamp commit (the
//                                 reuse lane reopens/re-stamps next tick)
//
// Asserts the invariants that matter (NOT the interleavings):
//   * every task reaches EXACTLY ONE terminal state (final status terminal +
//     exactly one applied terminal-arrival journal record, one distinct `to`;
//     the PR-stamp pointer records — kind REPORT, note 'pr-opened' — are NOT
//     task-arrivals and are excluded);
//   * ZERO lost reports and ZERO double-applied reports — the report ledger
//     diff: every worker-confirmed emission is accounted (applied, or
//     rejected-duplicate = a re-delivery absorbed, or rejected-orphan = a
//     superseded attempt accounted); no event id applied twice; every applied
//     report attributes to a dispatched worker run (the LOSS class — an
//     orphan report from a run the runner never created; killed-before-report
//     runs are the healthy complement);
//   * the WEDGED shapes recover: every assigned-but-never-dispatched attempt
//     (the killed-post-commit-pre-dispatch class) is later lease-reaped (a
//     TIMEOUT record after the wedge) — no lease lives forever;
//   * the final halt is reachable (chain.halted, phase done, queue drained)
//     inside the wall budget;
//   * every done declared-artifacts task is PR-stamped IN THE JOURNAL — the
//     B5 reuse-lane recovery (the live state's pr pointer is NOT the evidence:
//     the W-C1 §5b compaction prunes it 20 ticks past terminal).
//
// Process-level so not byte-deterministic, but SEED-REPRODUCIBLE: the kill
// schedule (the (boundary, skip, delay) list below) is a pure function of the
// seed; the wall-clock interleaving decides which exact event each kill lands
// on, and every kill's ACHIEVED class is classified post-hoc from the durable
// evidence (journal + ledger + run logs) and reported as metrics. The asserts
// are invariant-only.
//
// ---------------------------------------------------------------------------
// THE SUBSTRATE (reused verbatim from the e2e drill — the proven local mode):
//   e2e/lib/world.mjs      local bare origins (main + the AR bucket) + the
//                          spawned-adapter env assembly (dead-proxy isolation,
//                          the npx shim → worker/fake-cc.mjs, the insteadOf
//                          transcript rewrite)
//   e2e/lib/ghapi.mjs      the 8-endpoint GitHub stand-in + its request ledger
//   e2e/lib/scheduler.mjs  the mini-GHA: real child spawns of conductor/turn.mjs
//                          + worker/turn.mjs, dispatch latency, ParallelCap(5),
//                          per-task cancel-in-progress groups
// The epoch runs EPOCH MODE cc (genesis project.mode='cc'): the cc lane is the
// ONLY lane with the full boundary surface (transcripts push → taskbranch push
// → report enqueue); its CLI is the deterministic fake (npx shim), so the
// whole thing stays OFFLINE. The conductor/worker/store/fsm layers are the
// REAL production files — zero lib/ or worker/ code was touched for this
// battery (the kill boundaries are OBSERVED, not instrumented).
//
// ---------------------------------------------------------------------------
// THE MODELING (where a boundary cannot be instrumented without touching
// production code, the kill lands BETWEEN the child's observable I/O steps —
// the observer watches the durable surfaces every production actor writes):
//   * a conductor commit is observed as the fsm-state ref moving in the main
//     bare (the push IS the commit's landing); the tip's commit message
//     attributes it ('report-queue +1' = a worker report push, anything else
//     = a conductor commit). A B2 kill fired at ref-move time lands between
//     the commit and the action loop's dispatch POSTs with high probability —
//     the achieved class (pre-dispatch vs mid-dispatch) is classified from
//     the ledger afterwards and reported; both shapes are legitimate crash
//     classes with the same invariants.
//   * the taskbranch boundary is the tasks/<id> ref appearing/moving in the
//     main bare; the report boundary is the report-queue push (same ref, the
//     message discriminates); the PR boundary is the POST /pulls 201 in the
//     ghapi ledger. Poll cadence 15ms — two commits inside one poll collapse
//     to one observed event (counted honestly in the event tally).
//   * the driver's periodic tick (a POST fsm-tick whenever the chain is idle
//     >6.5s) models the schedule backstop + the watchdog re-prime: a killed
//     conductor loses its self-tick, and something must revive the chain —
//     in production that is the cron backstop/pinger/watchdog, here it is the
//     driver's stall kick (the recovery path's arrival is compressed from
//     minutes to seconds; the recovery itself — lease reap, requeue, retry,
//     PR reuse — is the real machinery).
//   * the lease floor is REAL clock: LEASE_FLOOR_MINUTES=3 (the s22/B-1
//     floor) means every wedged lease costs up to 180s of wall time — this is
//     the ONE process-level battery and it documents its own wall time
//     (~4-7min quick, ~12-20min full). Kills are deliberately biased LATE
//     into long attempts (sleep fixtures) so the remaining-lease cost stays
//     bounded, and early conductor kills skip the first commits so the
//     productive phase is not wedged at t0.
//
// quick = 12 tasks / 12 seeded kills; full = 18 tasks / 50 seeded kills (the
// registry contract). Linux-only (/proc — stress/lib/kill-proc.mjs).
//
// ---------------------------------------------------------------------------
// s23-chaos3 RECOVERY NOTES (the deltas that made it green — round 3):
//   * THE EVENT-ID MIRAGE (the lost-reports false conviction): the applied
//     REPORT journal records carry run_id but NO event_id (the documented
//     shape: {kind, task, lease, to, run_id, ...lane} — only REJECTED records
//     carry event_id), so an appliedEventIds set read from the journal was
//     ALWAYS EMPTY: every emission looked "lost" except the REJECTED ones.
//     The honest emission ledger is the QUEUE-LANDING COMMITS — every report
//     enqueue is a CAS commit whose subject is `report-queue +1 <task>
//     <event_id>`, and the branch HISTORY retains all of them (rotation
//     prunes files from the tree, never commits). Accounting joins by run_id
//     (applied) or event_id (rejected) — the id parses back to the run id.
//   * ROTATION-PROOF JOURNAL READBACK: the retained branch carries only the
//     last keepGens=4 generations (~2000 records); a long epoch (the full
//     mode's 18 tasks / 50 kills) rotates the earliest records OUT of the
//     branch readback. Every pruned generation's FINAL content is still
//     recoverable in history (its last Add/Modify commit) — the analysis
//     now merges branch-retained gens with history-recovered gens, so every
//     journal-based invariant (terminal arrivals, wedges, PR stamps, report
//     accounting) reads the COMPLETE journal.
//   * COVERAGE-FIRST SCHEDULE: the first entry of every boundary is the
//     COVERAGE entry — skip=0, and for worker-report-push a delay calibrated
//     INSIDE the dup gap (300-1200ms of the 1500ms inter-enqueue sleep, clear
//     margins both sides) — so the boundary class crosses in the quick
//     epoch's thin event supply (the one exception: conductor-post-commit's
//     first entry keeps its skip 2-3 productive-phase guard — its supply is
//     hundreds of events). Quick's worker-report-push entries ALL take
//     skip=0 and the quick cohort carries TWO dup tasks (the gap supply).
//   * SEED PURITY vs THE RE-ARM (the design tension, resolved): purity hashes
//     the INITIAL derivation — a byte-snapshot of the entries taken BEFORE
//     the scheduler runs (the re-arm is RUNTIME retry bookkeeping on the
//     entry objects, not a schedule change). The runtime half of the check
//     is the accounting: every scheduled entry is fired exactly once or
//     flushed as a documented epoch-ended dud (kills + duds = the schedule).
//
// ---------------------------------------------------------------------------
// s23-chaos2 RECOVERY NOTES (the deltas that made it green):
//   * DUD RE-ARMING: a kill whose victim exits before the delayed SIGKILL (or
//     whose immediate victim is already gone) is RE-QUEUED at the boundary's
//     head and retries on the next matching event — the SCHEDULE is the
//     contract (seed-pure), duds are schedule-waste that moves to the next
//     candidate. Terminal duds = event-supply exhaustion (more entries than
//     the boundary's events: e.g. report-push entries beyond the dup tasks'
//     pushes); the kill floor is calibrated to the honest supply and the
//     coverage requirement is EVERY BOUNDARY FIRED.
//   * B3 arms on dup-task pushes when the cohort has dup tasks (the 1500ms
//     inter-enqueue gap is the kill class; a plain task's worker exits
//     ~200-500ms after its push — a delayed kill there is a guaranteed dud).
//   * THE PRUNED POINTER: prune_tasks_after_ticks=20 compacts terminal task
//     records to {id,status,attempts,done_at,pruned} — the pr field drops BY
//     DESIGN (live-proven: stamps e24/e80/e81 in the journal, pruned records
//     in the final state). The settle gate and the PR asserts read the
//     JOURNAL stamp records; !t.pr alone spun the settle loop forever
//     ('settle budget exhausted' with every PR long since stamped).
//   * THE REAL-CLOCK LEASE: lease_minutes=3 is the s22/B-1 production floor —
//     NOT compressible (a virtual clock cannot reach the real child
//     processes' Date.now, and a sub-floor lease is the work-destroying trap
//     the floor exists to prevent). Every wedge therefore costs up to 180s
//     of REAL wall (the lease's remaining lifetime); the wall is the honest
//     price of process-level chaos: ~5-7min quick, ~12-18min full (the
//     wall budgets are 10/25min).

import { Store } from '../../lib/store.mjs';
import { genesis, TERMINAL } from '../../lib/fsm.mjs';
import { mulberry32, Recorder } from '../lib/common.mjs';
import { createGhapi } from '../../e2e/lib/ghapi.mjs';
import { createWorld } from '../../e2e/lib/world.mjs';
import { createScheduler } from '../../e2e/lib/scheduler.mjs';
import { killRunTree, sweepProcs, countProcs } from '../lib/kill-proc.mjs';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));            // the repo root (the drill's ROOT)

// ---------------------------------------------------------------------------
// the epoch fixtures
// ---------------------------------------------------------------------------
const LEASE_MIN = 3;                            // LEASE_FLOOR_MINUTES — real clock
const MAX_ATTEMPTS = 3;
const MAX_PARALLEL = 6;
const LONG_TASK_MS = 15_000;                    // B1 arms only on long tasks

// T(id, fixture, behavior, workMs, spec?) — the TITLE carries the fake-CLI
// fixture markers (the cc lane's prompt IS the conductor-assembled
// `Task <id>: <title>`), work_ms mirrors the sleep for readable run names.
const T = (id, fixture, behavior, workMs, spec) => ({
  id, behavior, work_ms: workMs, deps: [],
  title: `chaos ${behavior} turn${fixture ? ` [fixture:${fixture}]` : ''}`,
  ...(spec ? { spec } : {}),
});
const art = (id) => ['tasks/' + id + '/artifacts/out-fake.md'];

function cohort(quick) {
  const tasks = quick ? [
    T('CQ-S1', 'sleep-ms=26000', 'cc-slow', 26_000),
    T('CQ-S2', 'sleep-ms=20000', 'cc-slow', 20_000),
    T('CQ-S3', 'sleep-ms=32000', 'cc-slow', 32_000),
    T('CQ-A1', 'artifacts', 'cc-art', 4_000, { artifacts: art('CQ-A1') }),
    T('CQ-A2', 'artifacts [fixture:sleep-ms=16000]', 'cc-art-slow', 16_000, { artifacts: art('CQ-A2') }),
    T('CQ-F1', null, 'cc-fast', 3_000),
    T('CQ-F2', null, 'cc-fast', 3_000),
    T('CQ-F3', null, 'cc-fast', 4_000),
    T('CQ-F5', null, 'cc-fast', 4_000),
    T('CQ-D1', 'dup-report', 'cc-dup', 4_000),
    T('CQ-D2', 'dup-report', 'cc-dup', 4_000),
    T('CQ-I1', 'exit-transport', 'cc-infra', 4_000),
  ] : [
    T('CF-S1', 'sleep-ms=26000', 'cc-slow', 26_000),
    T('CF-S2', 'sleep-ms=22000', 'cc-slow', 22_000),
    T('CF-S3', 'sleep-ms=34000', 'cc-slow', 34_000),
    T('CF-A1', 'artifacts', 'cc-art', 4_000, { artifacts: art('CF-A1') }),
    T('CF-A2', 'artifacts', 'cc-art', 4_000, { artifacts: art('CF-A2') }),
    T('CF-A3', 'artifacts [fixture:sleep-ms=18000]', 'cc-art-slow', 18_000, { artifacts: art('CF-A3') }),
    T('CF-F1', null, 'cc-fast', 3_000),
    T('CF-F2', null, 'cc-fast', 3_000),
    T('CF-F3', null, 'cc-fast', 4_000),
    T('CF-F4', null, 'cc-fast', 3_000),
    T('CF-F5', null, 'cc-fast', 4_000),
    T('CF-F6', null, 'cc-fast', 3_000),
    T('CF-F7', null, 'cc-fast', 4_000),
    T('CF-F8', null, 'cc-fast', 3_000),
    T('CF-D1', 'dup-report', 'cc-dup', 4_000),
    T('CF-D2', 'dup-report', 'cc-dup', 4_000),
    T('CF-I1', 'exit-transport', 'cc-infra', 4_000),
    T('CF-W1', 'fail', 'cc-fail', 3_000),
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return { tasks, byId };
}

// ---------------------------------------------------------------------------
// the kill schedule — a PURE function of the seed
// ---------------------------------------------------------------------------
// Entry semantics: per boundary, entries fire in order; an entry with skip=k
// lets k matching events pass and kills at the (k+1)-th. delayMs postpones
// the SIGKILL after the event (B1: mid-work on a long attempt; B3: inside the
// dup-report 1500ms gap or just after a plain report push). COVERAGE-FIRST
// (s23-chaos3): the FIRST entry of every boundary is the coverage entry —
// skip=0 so the class crosses on the first matching event (B3's coverage
// delay is calibrated mid-gap: 300-1200ms of the 1500ms inter-enqueue sleep,
// margins both sides). The exception is the first B2 entry: skip stays 2-3
// (the productive-phase guard — the epoch must not be wedged at t0; B2's
// supply is hundreds of events, coverage was never in question). Quick's B3
// entries all take skip=0 — the quick cohort's two dup tasks are the supply.
export const BOUNDARIES = ['worker-pre-report', 'conductor-post-commit', 'worker-report-push', 'worker-post-taskbranch', 'conductor-mid-pr'];

export function killPlanFor(seed, quick) {
  const rng = mulberry32((seed >>> 0) ^ 0x6b6c);       // chaos's own stream
  const counts = quick
    ? { 'worker-pre-report': 3, 'conductor-post-commit': 3, 'worker-report-push': 2, 'worker-post-taskbranch': 2, 'conductor-mid-pr': 2 }
    : { 'worker-pre-report': 10, 'conductor-post-commit': 18, 'worker-report-push': 14, 'worker-post-taskbranch': 4, 'conductor-mid-pr': 4 };
  const plan = { seed, quick, entries: [] };
  for (const boundary of BOUNDARIES) {
    for (let i = 0; i < counts[boundary]; i++) {
      let skip = Math.floor(rng() * (boundary === 'conductor-post-commit' ? 3 : 2));
      if (boundary === 'conductor-post-commit' && i === 0) skip = 2 + Math.floor(rng() * 2);  // let the first assigns fly
      if (boundary === 'worker-post-taskbranch' || boundary === 'conductor-mid-pr') skip = 0;  // rare events — never skip
      if (i === 0 && boundary !== 'conductor-post-commit') skip = 0;                          // the COVERAGE entry
      if (boundary === 'worker-report-push' && quick) skip = 0;                               // quick: every dup gap is supply
      let delayMs = 0;
      if (boundary === 'worker-pre-report') delayMs = 1500 + Math.floor(rng() * 7000);         // mid-work on a >=15s attempt
      if (boundary === 'worker-report-push') {
        delayMs = i === 0
          ? 300 + Math.floor(rng() * 900)                                                      // the coverage kill: mid-gap, margins both sides
          : 30 + Math.floor(rng() * 1350);                                                     // the dup gap is 1500ms
      }
      plan.entries.push({ boundary, skip, delayMs });
    }
  }
  plan.fingerprint = planHash(plan.entries);
  return plan;
}

function planHash(entries) {
  const s = JSON.stringify(entries);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// the KillScheduler — observers + the firing engine
// ---------------------------------------------------------------------------
class KillScheduler {
  constructor({ plan, sched, ghapi, mainBare, byId }) {
    this.plan = plan;
    this.sched = sched;
    this.ghapi = ghapi;
    this.mainBare = mainBare;
    this.byId = byId;
    this.queues = new Map(BOUNDARIES.map((b) => [b, plan.entries.filter((e) => e.boundary === b)]));
    this.sinceFire = new Map(BOUNDARIES.map((b) => [b, 0]));
    this.eventCounts = new Map(BOUNDARIES.map((b) => [b, 0]));
    this.pending = [];          // delayed kills awaiting their dueMs
    this.kills = [];            // the fired records
    this.duds = [];             // waste records: {rearmed:true} transient, 'epoch-ended' terminal
    // B3's target preference: the dup-report tasks (the cohort's 1500ms
    // inter-enqueue gap hosts the mid-gap kill class). null when the cohort
    // has none (every push is then a legal arm target).
    const dupIds = [...(byId?.values() || [])].filter((t) => String(t.title || '').includes('dup-report')).map((t) => t.id);
    this.dupTaskIds = dupIds.length ? new Set(dupIds) : null;
    this.tip = null;
    this.tasksRefs = new Map();
    this.ledgerSeen = 0;
    this.runStatus = new Map();
    this.timer = null;
    this.stopped = false;
    this.seq = 0;
  }

  start() {
    this.tip = this.readRef('fsm-state');
    this.tasksRefs = this.readTasksRefs();
    this.ledgerSeen = this.ghapi.ledger().length;
    this.timer = setInterval(() => this.poll(), 15);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // flush the unfired remainder as honest duds
    for (const [, q] of this.queues) {
      while (q.length) this.duds.push({ entry: q.shift(), reason: 'epoch-ended' });
    }
    for (const p of this.pending) if (!p.done) this.duds.push({ entry: p.entry, reason: 'epoch-ended' });
    this.pending = [];
  }

  readRef(name) {
    try { return readFileSync(join(this.mainBare, 'refs', 'heads', name), 'utf8').trim(); } catch { return null; }
  }

  readTasksRefs() {
    const out = new Map();
    try {
      const dir = join(this.mainBare, 'refs', 'heads', 'tasks');
      for (const n of readdirSync(dir)) {
        try { out.set(n, readFileSync(join(dir, n), 'utf8').trim()); } catch { /* racing push */ }
      }
    } catch { /* no tasks refs yet */ }
    return out;
  }

  tipMessage(sha) {
    const r = spawnSync('git', ['--git-dir', this.mainBare, 'show', '-s', '--format=%s', sha], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() : '';
  }

  poll() {
    if (this.stopped) return;
    try { this.pollRuns(); this.pollRefs(); this.pollLedger(); this.fireDue(); } catch { /* the observer never kills the battery */ }
  }

  pollRuns() {
    for (const r of this.sched.runs) {
      const prev = this.runStatus.get(r.id);
      if (prev === r.status) continue;
      this.runStatus.set(r.id, r.status);
      if (r.workflow === 'worker' && r.status === 'in_progress') {
        // B1 arms only on LONG tasks: the kill must land mid-work (a fast task
        // would exit before the delay — that kill class is B3's, not B1's)
        const t = this.byId.get(r.taskRef);
        if (t && t.work_ms >= LONG_TASK_MS) this.onEvent('worker-pre-report', { runId: r.id, task: r.taskRef });
      }
    }
  }

  pollRefs() {
    const tip = this.readRef('fsm-state');
    if (tip && tip !== this.tip) {
      const first = this.tip === null;
      this.tip = tip;
      if (!first) {
        const msg = this.tipMessage(tip);
        const m = /^report-queue \+1 (\S+) (rep-\d+-a\d+)$/.exec(msg);
        if (m) this.onEvent('worker-report-push', { runId: m[2].slice(4).replace(/-a\d+$/, ''), task: m[1] });
        else this.onEvent('conductor-post-commit', {});
      }
    }
    const refs = this.readTasksRefs();
    for (const [name, sha] of refs) {
      if (this.tasksRefs.get(name) === sha) continue;
      const isNew = !this.tasksRefs.has(name);
      this.tasksRefs.set(name, sha);
      if (!isNew && sha === this.tasksRefs.get(name)) { /* unreachable */ }
      this.onEvent('worker-post-taskbranch', { task: name, sha });
    }
  }

  pollLedger() {
    const led = this.ghapi.ledger();
    if (led.length <= this.ledgerSeen) return;
    for (const e of led.slice(this.ledgerSeen)) {
      if (e.method === 'POST' && /\/pulls$/.test(String(e.path)) && e.status === 201) {
        this.onEvent('conductor-mid-pr', { pull: e });
      }
    }
    this.ledgerSeen = led.length;
  }

  onEvent(boundary, info) {
    this.eventCounts.set(boundary, (this.eventCounts.get(boundary) || 0) + 1);
    // B3 target preference: when the cohort HAS dup-report tasks, the
    // report-push boundary's KILL CLASS is the dup task's 1500ms inter-enqueue
    // gap (a plain task's worker exits ~200-500ms after its push — a delayed
    // kill there is a guaranteed dud). The event still counts (honest tally);
    // the entry only CONSUMES/arms on a push that can actually host the kill.
    if (boundary === 'worker-report-push' && this.dupTaskIds && info.task && !this.dupTaskIds.has(info.task)) return;
    const q = this.queues.get(boundary);
    if (!q || !q.length) return;
    const since = this.sinceFire.get(boundary) + 1;
    this.sinceFire.set(boundary, since);
    const head = q[0];
    if (since <= head.skip) return;
    q.shift();
    this.sinceFire.set(boundary, 0);
    this.arm(head, boundary, info);
  }

  // a dud is schedule-waste, not a dead entry: RE-ARM at the queue head so
  // the NEXT matching event retries the kill (the design's "50 seeded kills
  // across one epoch" — the SCHEDULE is the contract; a victim that exited
  // before its delayed kill just moves the kill to the next candidate).
  // rearm counts ride the entry for the honest waste tally; the entries still
  // unfired at stop() flush as 'epoch-ended' duds.
  rearm(entry, boundary, reason) {
    entry.rearms = (entry.rearms || 0) + 1;
    this.queues.get(boundary).unshift(entry);
    this.sinceFire.set(boundary, 0);
    this.duds.push({ entry, reason: `${reason} (re-armed x${entry.rearms})`, rearmed: true, boundary });
  }

  arm(entry, boundary, info) {
    if (boundary === 'worker-pre-report' || boundary === 'worker-report-push') {
      this.pending.push({ entry, boundary, runId: info.runId, task: info.task, dueMs: Date.now() + entry.delayMs, ts: Date.now() });
      return;
    }
    // immediate boundaries: resolve the victim run now
    if (boundary === 'conductor-post-commit' || boundary === 'conductor-mid-pr') {
      const run = this.sched.runs.find((r) => r.workflow === 'conductor' && r.status === 'in_progress');
      if (!run) { this.rearm(entry, boundary, 'no-conductor-in-flight'); return; }
      this.execute({ entry, boundary, runId: run.id, task: null, ts: Date.now() });
      return;
    }
    if (boundary === 'worker-post-taskbranch') {
      const run = this.sched.runs.find((r) => r.workflow === 'worker' && r.status === 'in_progress' && r.taskRef === info.task);
      if (!run) { this.rearm(entry, boundary, 'no-worker-in-flight'); return; }
      this.execute({ entry, boundary, runId: run.id, task: info.task, ts: Date.now() });
    }
  }

  fireDue() {
    for (const p of this.pending) {
      if (p.done || Date.now() < p.dueMs) continue;
      p.done = true;
      const run = this.sched.runById(p.runId);
      if (!run || run.status !== 'in_progress') {
        this.rearm(p.entry, p.boundary, 'victim-exited');
        continue;
      }
      this.execute(p);
    }
    this.pending = this.pending.filter((p) => !p.done);
  }

  execute(p) {
    const procs = killRunTree({ runId: p.runId, taskId: p.task ?? null, cloneDir: null });
    this.seq += 1;
    const rec = {
      seq: this.seq, boundary: p.boundary, victimRunId: p.runId, victimTask: p.task ?? null,
      scheduleIdx: this.plan.entries.indexOf(p.entry),   // the initial-schedule accounting key (s23-chaos3)
      ts: p.ts, delayMs: p.entry.delayMs, killedGroups: procs.length,
      killed: procs.map((x) => ({ pid: x.pid, cmd: x.cmd.slice(0, 90) })),
    };
    this.kills.push(rec);
    console.log(`  ⚡ [chaos] KILL #${rec.seq} ${p.boundary} run=${p.runId} task=${p.task ?? '-'} (${procs.length} group${procs.length === 1 ? '' : 's'}${p.entry.delayMs ? `, delayed ${p.entry.delayMs}ms` : ''})`);
  }
}

// ---------------------------------------------------------------------------
// the battery
// ---------------------------------------------------------------------------
const agit = (args) => new Promise((resolve) => {
  const pr = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  pr.stdout.on('data', (d) => { out += d; });
  pr.stderr.on('data', (d) => { err += d; });
  pr.on('error', () => resolve({ code: -1, out, err }));
  pr.on('close', (code) => resolve({ code, out, err }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ quick, seed } = {}) {
  const rec = new Recorder('chaos');
  const wallBudgetMs = quick ? 10 * 60_000 : 25 * 60_000;
  const maxKicks = quick ? 500 : 1500;
  const { tasks, byId } = cohort(quick);
  const plan = killPlanFor(seed, quick);
  // s23-chaos3: the SEED-PURITY snapshot — the byte-image of the INITIAL
  // derivation, taken BEFORE the KillScheduler runs. The re-arm is RUNTIME
  // retry bookkeeping on the entry objects (entry.rearms), NOT a schedule
  // change: purity compares the re-derivation to THIS snapshot, and the
  // runtime half of the contract is the separate accounting check below.
  const initialEntriesJson = JSON.stringify(plan.entries);
  rec.note(`epoch: ${tasks.length} tasks (mixed: fast/slow/dup/artifacts/infra/fail), max_parallel=${MAX_PARALLEL}, lease=${LEASE_MIN}min (the floor — real clock), max_attempts=${MAX_ATTEMPTS}, mode=cc (the full boundary surface)`);
  rec.note(`kill schedule (seed ${seed}, fingerprint ${plan.fingerprint}, coverage-first): ${plan.entries.length} entries — ${BOUNDARIES.map((b) => `${b}=${plan.entries.filter((e) => e.boundary === b).length}`).join(', ')}`);

  const scratchDir = mkdtempSync(join(tmpdir(), 'fsm-chaos-'));
  const driverLog = join(scratchDir, 'chaos-driver.log');
  const flog = (m) => { try { appendFileSync(driverLog, m + '\n'); } catch { /* best effort */ } };
  const underScratch = (p) => String(p.cmd || '').includes(scratchDir);

  let ghapi = null;
  let world = null;
  let sched = null;
  let killer = null;
  let sweptPids = [];
  try {
    // ---- BOOT: the drill's local mode, verbatim ---------------------------
    ghapi = createGhapi({ scratchDir, log: flog });
    const apiBase = await ghapi.listen();
    world = createWorld({
      scratchDir, mainRepo: 'local/fsm-lab', repo2: 'local/fsm-lab-workers',
      worktreeRoot: ROOT, apiBase, log: flog, keep: process.env.CHAOS_KEEP === '1',
    });
    world.boot();
    ghapi.openIssue('local/fsm-lab', {
      title: '[fsm] ops console anchor (chaos seed)',
      body: 'The ops issue — conductor alert/completion comments land here (OPS_ISSUE=1).',
      labels: [],
    });
    sched = createScheduler({ world, ghapi, log: flog, timeScale: 0.01, seed });

    // the read surface (the drill's async probe pattern — never blocks)
    const fetchProbe = () => agit(['-C', world.probeClone, 'fetch', '-q', world.mainBare, '+refs/heads/fsm-state:refs/remotes/origin/fsm-state']);
    const showProbe = async (path) => {
      const r = await agit(['-C', world.probeClone, 'show', `refs/remotes/origin/fsm-state:${path}`]);
      return r.code === 0 ? r.out : null;
    };
    const readState = async () => {
      await fetchProbe();
      const raw = await showProbe('state/state.json');
      if (raw === null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    };
    const queueLines = async () => {
      await fetchProbe();
      const raw = await showProbe('state/reports-queue.jsonl');
      if (raw === null) return [];
      return raw.split('\n').map((s) => s.trim()).filter(Boolean);
    };

    // ---- GENESIS: seed the live cc epoch through the REAL Store -----------
    const g = genesis({
      config: { max_parallel: MAX_PARALLEL, lease_minutes: LEASE_MIN, max_attempts: MAX_ATTEMPTS, tick_min_interval_s: 0, dedup_window: 300 },
      project: { tasks, milestones: 1 },
      chainId: `chaos-${seed}`,
      now: new Date().toISOString(),
      mode: 'cc',
    });
    new Store({ cwd: world.probeClone }).init(g);

    // ---- the KillScheduler -------------------------------------------------
    killer = new KillScheduler({ plan, sched, ghapi, mainBare: world.mainBare, byId });
    killer.start();

    const postDispatch = async (eventType, clientPayload) => {
      const r = await fetch(`${apiBase}/repos/local/fsm-lab/dispatches`, {
        method: 'POST',
        headers: { Authorization: 'token drill-user-pat', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
      });
      return r.status;
    };
    const kick = () => postDispatch('fsm-tick', { reason: 'chaos' });
    await kick();                                   // the genesis tick

    // ---- the driver loop (the schedule backstop + watchdog re-prime model)
    const t0 = Date.now();
    let kicks = 1;
    let lastConductorEnd = Date.now();
    let lastDoneCount = 0;
    let halted = false;
    let settleKicks = 0;
    let budgetNote = null;
    driver: while (true) {
      await sleep(1000);
      const cRuns = sched.runs.filter((r) => r.workflow === 'conductor');
      const doneCount = cRuns.filter((r) => r.status === 'completed').length;
      if (doneCount !== lastDoneCount) { lastDoneCount = doneCount; lastConductorEnd = Date.now(); }
      const inflight = sched.runs.some((r) => ['queued', 'group-pending', 'repo-queued', 'in_progress'].includes(r.status) && (r.workflow === 'conductor' || halted === false));
      const st = await readState();
      if (st && st.chain && st.chain.halted) halted = true;

      if (!halted) {
        if (!inflight && Date.now() - lastConductorEnd > 6500 && kicks < maxKicks) {
          await kick();
          kicks += 1;
          lastConductorEnd = Date.now();
        }
        if (Date.now() - t0 > wallBudgetMs) { budgetNote = `wall budget ${Math.round(wallBudgetMs / 60000)}min exhausted before halt`; break; }
        if (kicks >= maxKicks) { budgetNote = `kick budget ${maxKicks} exhausted before halt`; break; }
        continue;
      }

      // ---- SETTLE: halted — drain the queue, stamp the PRs -----------------
      // pendPr reads the LIVE pointer: a task done + declared-artifacts +
      // unpruned + pr-less still needs its stamp (the prFlow runs on every
      // tick — quiesced ticks included — so a kick or two lands it). A PRUNED
      // record ({id,status,attempts,done_at,pruned} — the W-C1 §5b compaction,
      // prune_tasks_after_ticks=20) has dropped its pr field BY DESIGN: the
      // durable PR evidence is the journal's stamp record + the API ledger,
      // and the un-pruned !t.pr read that spun this loop forever on pruned
      // records ('settle budget exhausted' with every PR long since stamped —
      // the s23-chaos2 root cause, live-proven on the kept world: stamps
      // e24/e80/e81 in the journal, pruned compact records in the final state).
      const lines = await queueLines();
      const pendPr = st && Object.entries(st.tasks || {}).some(([id, t]) => t && t.status === 'done' && !t.pruned && !t.pr && (byId.get(id)?.spec?.artifacts?.length));
      if (lines.length === 0 && !pendPr && settleKicks >= 2) break;
      if (settleKicks >= 16) { budgetNote = 'settle budget exhausted (queue/PRs not settled)'; break; }
      settleKicks += 1;
      await kick();
      await sleep(2500);
      if (Date.now() - t0 > wallBudgetMs) { budgetNote = `wall budget exhausted during settle`; break; }
    }
    // post-settle drain: the last settle kick's conductor run may still be
    // mid-flight (its stamp commit lands as it exits) — wait for the conductor
    // queue to go idle (bounded: 20s) before the final reads.
    for (let i = 0; i < 20; i++) {
      const cInflight = sched.runs.some((r) => r.workflow === 'conductor' && ['queued', 'group-pending', 'repo-queued', 'in_progress'].includes(r.status));
      if (!cInflight) break;
      await sleep(1000);
    }
    await sleep(1200);   // let the last tick's run land its commits
    killer.stop();

    const wallMs = Date.now() - t0;
    const totalRuns = sched.runs.length;
    const conductorRuns = sched.runs.filter((r) => r.workflow === 'conductor').length;
    const workerRuns = sched.runs.filter((r) => r.workflow === 'worker').length;
    rec.metric('wallMs', wallMs);
    rec.metric('ticksKicked', kicks);
    rec.metric('settleKicks', settleKicks);
    rec.metric('conductorRuns', conductorRuns);
    rec.metric('workerRuns', workerRuns);
    if (budgetNote) rec.note(`DRIVER: ${budgetNote}`);

    // ---- the post-hoc ledger analysis --------------------------------------
    // the full journal — ROTATION-PROOF (s23-chaos3): the retained branch
    // carries only the last keepGens=4 generations (~2000 records); a long
    // epoch rotates the earliest applied/rejected records OUT of the branch
    // readback (the drain's accounting evidence would silently vanish). The
    // git HISTORY retains every commit: each pruned generation's FINAL
    // content is recoverable at its last Add/Modify commit — the merge below
    // reads branch-retained gens ∪ history-recovered gens, so every
    // journal-based invariant (terminal arrivals, wedges, PR stamps, report
    // accounting) reads the COMPLETE journal.
    await fetchProbe();
    const ls = await agit(['-C', world.probeClone, 'ls-tree', '--name-only', 'refs/remotes/origin/fsm-state', 'state/']);
    const branchGens = ls.out.split('\n').map((x) => x.trim()).filter(Boolean)
      .map((f) => /^state\/journal-(\d+)\.jsonl$/.exec(f)).filter(Boolean)
      .map((m) => parseInt(m[1], 10)).sort((a, b) => a - b);
    // history walk: the newest-first log's FIRST A/M sighting of each gen is
    // its final content commit (gens are append-then-freeze — F5 disjoint
    // generations; the F-A rollback sweep rewrites via M, newest still wins).
    const lastAM = new Map();          // gen -> sha (its final Add/Modify commit)
    {
      const logRaw = await agit(['--git-dir', world.mainBare, 'log', '--format=%H', '--name-status', 'fsm-state', '--', 'state/']);
      let sha = null;
      for (const line of logRaw.out.split('\n')) {
        const t = line.trim();
        if (/^[0-9a-f]{40}$/.test(t)) { sha = t; continue; }
        const m = /^([AM])\tstate\/journal-(\d+)\.jsonl$/.exec(t);
        if (m && sha) {
          const g = parseInt(m[2], 10);
          if (!lastAM.has(g)) lastAM.set(g, sha);
        }
      }
    }
    const allGens = [...new Set([...branchGens, ...lastAM.keys()])].sort((a, b) => a - b);
    const journal = [];
    for (const gn of allGens) {
      // a gen currently on the branch: its live content IS its final content;
      // a pruned gen: its last-A/M-in-history content. (Never both — the
      // branch version supersedes when present.)
      const raw = branchGens.includes(gn)
        ? await showProbe(`state/journal-${gn}.jsonl`)
        : (await agit(['--git-dir', world.mainBare, 'show', `${lastAM.get(gn)}:state/journal-${gn}.jsonl`])).out || null;
      for (const line of (raw || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { journal.push(JSON.parse(t)); } catch { /* bad line — the drain's own class */ }
      }
    }
    rec.metric('journalGens', { retained: branchGens.length, recoveredFromHistory: allGens.length - branchGens.length, records: journal.length });

    // the dispatch ledger: every fsm-task POST the conductor ever made, keyed
    // by the payload's OWN identity — (task, attempt). The dispatch payload
    // carries NO run_id (the conductor's run id rides only inside the ox
    // envelope's session string; the WORKER run's id is minted by the runner
    // AFTER the dispatch — the s23-chaos recovery fix: the prior shape keyed
    // on cp.run_id, a field that never exists, so the map was ALWAYS empty —
    // every applied report looked unattributed and every ASSIGN looked like a
    // wedge). The honest dispatch record is the (task, attempt) POST itself.
    const dispatchedPairs = new Set();     // `${task}#a${attempt}`
    const dispatchCountByPair = new Map();  // pair -> POST count (the dispatch tally)
    for (const e of ghapi.ledger()) {
      if (e.method !== 'POST' || !/\/dispatches$/.test(String(e.path))) continue;
      if (!String(e.req || '').includes('"fsm-task"')) continue;
      try {
        const cp = JSON.parse(e.req).client_payload || {};
        if (cp.task && cp.attempt != null) {
          const pair = `${cp.task}#a${cp.attempt}`;
          dispatchedPairs.add(pair);
          dispatchCountByPair.set(pair, (dispatchCountByPair.get(pair) || 0) + 1);
        }
      } catch { /* sliced body — the tallies only */ }
    }
    // the worker-run ledger: the scheduler creates a worker run ONLY from an
    // fsm-task dispatch POST, so run-id ∈ this map ⟺ the run was dispatched.
    // workerRunById: runId -> {task, attempt, name} (the run's own dispatch key
    // = `${task}#a${attempt}`, joinable with dispatchedPairs).
    const workerRunById = new Map();       // runId -> {task, attempt, name}
    for (const r of sched.runs) {
      if (r.workflow !== 'worker') continue;
      const m = / a(\d+)$/.exec(r.name || '');
      if (!m) continue;
      workerRunById.set(String(r.id), { task: r.taskRef, attempt: parseInt(m[1], 10), name: r.name });
    }

    // the applied/rejected report ledger (journal side)
    const appliedInprogress = new Map();    // runId -> count of to=in_progress REPORT records (double-apply detector)
    const appliedRunIds = new Set();
    const redeliverIds = new Set();         // REJECTED duplicate (origKind REPORT)
    const orphanRejectIds = new Set();      // REJECTED stale/unknown/… (accounted, superseded)
    const appliedTerminal = new Map();      // task -> [{kind, to}]
    // the PR-stamp pointer records (task-pr.mjs stampPr) are kind REPORT with
    // to=<status> — they are NOT task-arrival transitions (the task was
    // already terminal when the stamp landed; the record is a pointer-only
    // audit note). The exactly-one-terminal check must exclude them or every
    // stamped artifacts task reads as double-terminal (the s23-chaos
    // recovery's second false positive).
    const isPrStamp = (j) => j.pr != null && typeof j.note === 'string' && j.note.startsWith('pr-opened');
    for (const j of journal) {
      if (j.kind === 'REPORT' && j.applied !== false && !isPrStamp(j)) {
        // NOTE (s23-chaos3, the event-id mirage): applied REPORT records
        // carry run_id but NO event_id (the documented shape — only REJECTED
        // records carry event_id), so there is NO applied-event-id set to
        // read here; the accounting joins by RUN ID (the minted event id
        // embeds it: rep-<runId>-a<attempt>).
        if (j.run_id != null) {
          const rid = String(j.run_id);
          appliedRunIds.add(rid);
          if (j.to === 'in_progress') appliedInprogress.set(rid, (appliedInprogress.get(rid) || 0) + 1);
        }
        if (TERMINAL.has(j.to)) pushTerm(appliedTerminal, j.task, j);
      }
      if (j.kind === 'TIMEOUT' && TERMINAL.has(j.to)) pushTerm(appliedTerminal, j.task, j);
      if (j.kind === 'CANCEL_CASCADE') pushTerm(appliedTerminal, j.task, j);
      if (j.kind === 'REJECTED' && j.origKind === 'REPORT' && j.event_id) {
        if (j.reason === 'duplicate') redeliverIds.add(j.event_id);
        else orphanRejectIds.add(j.event_id);
      }
    }

    // the emission ledger — the QUEUE-LANDING COMMITS (s23-chaos3): every
    // report enqueue is a CAS push whose commit subject is `report-queue +1
    // <task> <event_id>`, and the branch HISTORY retains ALL of them
    // (rotation prunes files from the tree, never commits). This is the
    // honest full emission set — the prior run-log regex lane keyed the
    // claims by the run NAME's attempt suffix, which is NOT the minted id's
    // attempt component (the drill's world pins GITHUB_RUN_ATTEMPT='1' for
    // every run — production-faithful: a fresh run id per FSM attempt), and
    // SIGKILL can lose a killed run's buffered stdout, so the logs UNDERCOUNT
    // (the claims survive as a cross-check metric, not as the ledger).
    const EMIT_ID_RE = /^rep-(\d+)-a(\d+)$/;   // MINT_TABLE's REPORT shape
    const emittedIds = new Map();    // eventId -> task (every report that ever LANDED)
    {
      const subj = await agit(['--git-dir', world.mainBare, 'log', '--format=%s', 'fsm-state']);
      for (const line of subj.out.split('\n')) {
        const m = /^report-queue \+1 (\S+) (\S+)$/.exec(line.trim());
        if (m && !emittedIds.has(m[2])) emittedIds.set(m[2], m[1]);
      }
    }
    // the run-log claim lane (diagnostic cross-check only): the runs whose
    // log survived long enough to confirm an enqueue (killed runs can lose
    // buffered stdout — claims ≤ landings by construction)
    let logClaimed = 0;
    {
      const EMIT_RE = /WORKER-DONE task=\S+ outcome=\S+ enqueue=ok|WORKER-GATE-REJECT task=\S+[^\n]*enqueue=ok|WORKER-REPORT-DUP first=true/;
      for (const r of sched.runs) {
        if (r.workflow !== 'worker') continue;
        if (EMIT_RE.test(sched.runLogText(r.id))) logClaimed += 1;
      }
    }
    // the accounting join: a landed report is accounted iff its event id was
    // REJECTED (duplicate re-delivery or orphan/superseded) OR its run id has
    // an APPLIED REPORT record (the minted id embeds the run id — the drill's
    // minted attempt is always '1', and the run ids are unique per attempt,
    // so the join is exact either way).
    const rejectedRunIds = new Set();
    for (const id of [...redeliverIds, ...orphanRejectIds]) {
      const m = EMIT_ID_RE.exec(id);
      if (m) rejectedRunIds.add(m[1]);
    }
    const accountOf = (eventId) => {
      if (redeliverIds.has(eventId) || orphanRejectIds.has(eventId)) return 'rejected';
      const m = EMIT_ID_RE.exec(eventId);
      if (m && appliedRunIds.has(m[1])) return 'applied';
      return null;
    };

    // the wedge analysis: every ASSIGN whose (task, attempt) was NEVER dispatched
    const assigns = [];
    {
      let idx = 0;
      for (const j of journal) {
        if (j.kind === 'ASSIGN' && j.applied !== false) assigns.push({ ...j, idx: idx });
        idx++;
      }
    }
    const wedges = assigns.filter((a) => !dispatchedPairs.has(`${a.task}#a${a.attempt}`));
    const wedgesRecovered = wedges.filter((w) => {
      const later = journal.slice(w.idx + 1).some((j) => j.kind === 'TIMEOUT' && j.task === w.task);
      return later;
    });

    // the final state + queue
    const finalState = await readState();
    const finalQueue = await queueLines();
    const taskIds = tasks.map((t) => t.id);
    const finalStatus = new Map(taskIds.map((id) => [id, finalState?.tasks?.[id]?.status ?? '(absent)']));

    // ---- DIAGNOSTICS (bounded, always collected — the settle/PR story) ------
    // the settle-window conductor tally: which conductor runs STARTED in the
    // last 150s, and what their logs say about the PR flow (the reuse lane's
    // visible trace). Notes land in the report; CHAOS_DEBUG=1 additionally
    // prints the driver-log tail.
    {
      const settleWindowFrom = Date.now() - 150_000;
      const lateConductors = sched.runs.filter((r) => r.workflow === 'conductor' && (r.startedAt ?? 0) >= settleWindowFrom);
      const prLines = [];
      for (const r of lateConductors.slice(-14)) {
        const text = sched.runLogText(r.id);
        const hits = text.split('\n').filter((l) => /PR-FLOW|PR-OPEN|PR-STAMP|QUIESCED|PR-OPEN-FAILED|PR-FLOW-FAILED|PR-FLOW-DEFERRED/.test(l)).slice(-6);
        if (hits.length) prLines.push(`run ${r.id} (${r.status}/${r.conclusion ?? '??'}): ${hits.join(' || ').slice(0, 400)}`);
      }
      rec.note(`settle window: ${lateConductors.length} conductor runs in the last 150s (${lateConductors.filter((r) => r.conclusion === 'success').length} success, ${lateConductors.filter((r) => r.conclusion === 'failure').length} failure, ${lateConductors.filter((r) => r.status !== 'completed').length} never-finished)${prLines.length ? `; PR-flow lines: ${prLines.slice(0, 6).join(' ;; ').slice(0, 1500)}` : '; NO PR-flow lines in any late conductor log'}`);
      if (process.env.CHAOS_DEBUG === '1') {
        try {
          const dl = readFileSync(driverLog, 'utf8').split('\n');
          console.log('---- DRIVER LOG TAIL (last 60) ----');
          for (const l of dl.slice(-60)) console.log(l);
          console.log('---- LATE CONDUCTOR PR/FLOW LINES ----');
          for (const p of prLines) console.log(p);
        } catch { /* best effort */ }
      }
    }

    // ---- the achieved-class tally per kill ---------------------------------
    const killsByBoundary = {};
    for (const b of BOUNDARIES) killsByBoundary[b] = { fired: 0, events: killer.eventCounts.get(b) || 0, achieved: {} };
    // every fsm-task POST's timestamp, with the conductor run that was
    // in flight when it landed (conductor runs SERIALIZE — the group admits
    // one running at a time — so the in-flight run at e.t is unambiguous;
    // the old shape keyed POSTs on cp.run_id, a field the dispatch payload
    // never carries).
    const taskPostTs = [];
    for (const e of ghapi.ledger()) {
      if (e.method !== 'POST' || !/\/dispatches$/.test(String(e.path)) || !String(e.req || '').includes('"fsm-task"')) continue;
      taskPostTs.push(e.t);
    }
    taskPostTs.sort((a, b) => a - b);
    const conductorRunList = sched.runs.filter((r) => r.workflow === 'conductor');
    for (const k of killer.kills) {
      const slot = killsByBoundary[k.boundary];
      slot.fired += 1;
      let cls = 'killed';
      // the victim's report accounting — by RUN ID (s23-chaos3): applied
      // records join on run_id, rejected ids parse back to the run id, so
      // the attempt-component mismatch (run-name suffix vs the minted id's
      // env attempt) never misclassifies the achieved class.
      const accounted = appliedRunIds.has(String(k.victimRunId)) || rejectedRunIds.has(String(k.victimRunId));
      if (k.boundary === 'conductor-post-commit') {
        // the victim's in-flight window: [startedAt, finishedAt ?? +inf) — POSTs
        // the victim landed AFTER the kill's commit observation (k.ts) = the
        // action loop survived past the commit (mid-dispatch); zero = the
        // crash class (assigned-but-never-dispatched leases, the wedge).
        const victim = conductorRunList.find((r) => r.id === k.victimRunId);
        const from = k.ts;
        const to = victim && victim.finishedAt ? victim.finishedAt + 1 : Number.POSITIVE_INFINITY;
        const posts = taskPostTs.filter((t) => t >= from && t <= to).length;
        cls = posts === 0 ? 'pre-dispatch (the crash class)' : `mid-dispatch (${posts} POSTs)`;
      } else if (k.boundary === 'conductor-mid-pr') {
        cls = 'pr-opened-pre-stamp (reuse lane re-stamps)';
      } else if (k.boundary === 'worker-report-push') {
        const isDup = (byId.get(k.victimTask)?.title || '').includes('dup-report');
        cls = isDup ? (accounted ? 'dup-first-landed (second lost — not a loss)' : 'report-lost-mid-CAS (lease re-covers)') : 'post-report';
      } else if (k.boundary === 'worker-pre-report') {
        cls = accounted ? 'post-report (delay outlived the turn)' : 'pre-report (the silent wedge — lease re-covers)';
      } else if (k.boundary === 'worker-post-taskbranch') {
        cls = accounted ? 'post-taskbranch-post-report' : 'post-taskbranch-pre-report (branch landed, report lost — lease re-covers)';
      }
      slot.achieved[cls] = (slot.achieved[cls] || 0) + 1;
    }
    for (const b of BOUNDARIES) {
      const bd = (killer.duds || []).filter((d) => d.entry.boundary === b);
      killsByBoundary[b].duds = bd.filter((d) => !d.rearmed).length;          // terminal (never fired)
      killsByBoundary[b].rearmed = bd.filter((d) => d.rearmed).length;        // transient waste (fired later or flushed)
    }
    const terminalDuds = killer.duds.filter((d) => !d.rearmed);
    const rearmedWaste = killer.duds.filter((d) => d.rearmed);
    rec.metric('killScheduleFingerprint', plan.fingerprint);
    rec.metric('killsScheduled', plan.entries.length);
    rec.metric('killsFired', killer.kills.length);
    rec.metric('killsDud', terminalDuds.length);
    rec.metric('killsRearmed', rearmedWaste.length);
    rec.metric('killsByBoundary', killsByBoundary);
    rec.metric('boundaryEvents', Object.fromEntries(killer.eventCounts));
    rec.metric('tasks', { total: taskIds.length, byStatus: Object.fromEntries([...finalStatus].map(([id, s]) => [id, s])) });
    rec.metric('reportsLedger', {
      landed: emittedIds.size,        // the commit-proven emission ledger (full history)
      logClaimed,                    // the run-log claims that survived the kills (≤ landed)
      applied: appliedRunIds.size,
      redeliveries: redeliverIds.size,
      orphanRejects: orphanRejectIds.size,
      finalQueueLines: finalQueue.length,
    });
    rec.metric('wedges', { assignedNeverDispatched: wedges.length, recoveredViaLeaseReap: wedgesRecovered.length });
    // the PR evidence: OPENED from the API ledger (the POSTs), STAMPED from
    // the JOURNAL stamp records (the durable pointer) ∪ the live pr fields —
    // the W-C1 §5b compaction prunes the pr field out of the state 20 ticks
    // past terminal, so the live-field read alone under-counts to zero on
    // any epoch that ran >20 post-terminal ticks (the s23-chaos2 finding).
    const stampByTask = new Map();    // task -> prn (journal stamp records)
    for (const j of journal) {
      if (isPrStamp(j) && j.task) stampByTask.set(j.task, j.pr);
    }
    const artifactsIds = taskIds.filter((id) => (byId.get(id)?.spec?.artifacts?.length || 0) > 0);
    rec.metric('prs', {
      opened: ghapi.ledger().filter((e) => e.method === 'POST' && /\/pulls$/.test(String(e.path)) && e.status === 201).length,
      stamped: artifactsIds.filter((id) => stampByTask.has(id) || finalState?.tasks?.[id]?.pr != null).length,
      stampedViaJournal: artifactsIds.filter((id) => stampByTask.has(id)).length,
      livePointer: artifactsIds.filter((id) => finalState?.tasks?.[id]?.pr != null).length,
      pruned: artifactsIds.filter((id) => finalState?.tasks?.[id]?.pruned).length,
    });
    rec.metric('totalRuns', totalRuns);

    // ---- THE INVARIANT ASSERTS (the gates) ----------------------------------
    // 1. every task reaches EXACTLY ONE terminal state
    const nonTerminal = taskIds.filter((id) => !TERMINAL.has(finalStatus.get(id)));
    rec.check('every task reaches a terminal status', nonTerminal.length === 0,
      `${taskIds.length} tasks; non-terminal: ${nonTerminal.map((id) => `${id}=${finalStatus.get(id)}`).join(', ') || 'none'}`);
    const multiTerminal = [];
    for (const [task, recs] of appliedTerminal) {
      if (recs.length !== 1 || new Set(recs.map((r) => r.to)).size !== 1) multiTerminal.push(`${task}(${recs.map((r) => `${r.kind}->${r.to}`).join('|')})`);
    }
    if (multiTerminal.length) {
      const dump = multiTerminal.map((m) => {
        const t = /^([^ (]+)/.exec(m)[1];
        const recs = journal.filter((j) => j.task === t && (j.kind === 'REPORT' || j.kind === 'TIMEOUT' || j.kind === 'CANCEL_CASCADE') && j.applied !== false);
        return `${t}: ${recs.map((j) => `${j.kind}->${j.to}${j.run_id != null ? ` run=${j.run_id}` : ''}${j.pr != null ? ` pr=${j.pr}` : ''}${j.note ? ` note=${String(j.note).slice(0, 30)}` : ''}`).join(' ; ')}`;
      }).join(' || ').slice(0, 1200);
      rec.note(`multi-terminal diagnostic: ${dump}`);
    }
    const missingTerminal = taskIds.filter((id) => !appliedTerminal.has(id));
    rec.check('every task has EXACTLY ONE applied terminal-arrival record', multiTerminal.length === 0 && missingTerminal.length === 0,
      `multi: ${multiTerminal.join(', ') || 'none'}; missing: ${missingTerminal.join(', ') || 'none'}`);

    // 2+3. the report ledger diff — zero lost, zero double-applied.
    // s23-chaos3: the emission ledger is the QUEUE-LANDING COMMITS (every
    // `report-queue +1 <task> <event_id>` subject on the branch history —
    // SIGKILL-proof, rotation-proof); the accounting joins by run id (applied)
    // or event id (rejected). A landed report that is neither applied nor
    // rejected is the LOSS class — the conductor's consumed-applied-or-
    // rejected drain law (F1) says it cannot exist.
    const lost = [...emittedIds.keys()].filter((id) => accountOf(id) === null);
    rec.check('ZERO lost reports (every queue-landed report is applied or rejected)', lost.length === 0,
      lost.length ? `lost: ${lost.join(', ')}` : `${emittedIds.size} landed (commit-proven; ${logClaimed} log-claimed) → ${appliedRunIds.size} applied runs + ${redeliverIds.size} re-deliveries + ${orphanRejectIds.size} orphan-rejects`);
    const doubleApplied = [...appliedInprogress].filter(([, n]) => n > 1).map(([rid]) => rid);
    rec.check('ZERO double-applied reports (one in_progress arrival per event id)', doubleApplied.length === 0,
      doubleApplied.length ? `run ids applied twice: ${doubleApplied.join(', ')}` : `${appliedRunIds.size} distinct applied ids, dedup absorbed ${redeliverIds.size} re-deliveries`);
    // the applied report's run attribution, rebuilt per journal record (the
    // LOSS class: an APPLIED report whose run was never dispatched — an
    // orphan report from a run the runner never created. Killed-before-report
    // runs are the HEALTHY complement: no report, no attribution needed).
    const appliedRunTask = new Map();      // runId -> task (from applied REPORT records)
    for (const j of journal) {
      if (j.kind === 'REPORT' && j.applied !== false && !isPrStamp(j) && j.run_id != null) {
        appliedRunTask.set(String(j.run_id), j.task);
      }
    }
    const phantom = [...appliedRunTask.keys()].filter((rid) => {
      const wr = workerRunById.get(rid);
      if (!wr) return true;                                    // no worker run ever existed — the orphan class
      if (wr.task !== appliedRunTask.get(rid)) return true;      // run/task mismatch — misattributed
      return !dispatchedPairs.has(`${wr.task}#a${wr.attempt}`);  // run exists but its dispatch POST is absent
    });
    rec.check('every applied report attributes to a dispatched worker run', phantom.length === 0,
      phantom.length ? `unattributed run ids: ${phantom.join(', ')}` : `${appliedRunTask.size}/${appliedRunTask.size} attributed (${dispatchedPairs.size} dispatch POST keys, ${workerRunById.size} worker runs)`);

    // 4. the wedged shapes resolve via the lease-reap recovery path
    rec.check('every assigned-but-never-dispatched attempt is lease-reaped (wedge recovery)', wedges.length === wedgesRecovered.length,
      `${wedgesRecovered.length}/${wedges.length} wedged attempts recovered via TIMEOUT${wedges.length !== wedgesRecovered.length ? ` — unrecovered: ${wedges.filter((w) => !wedgesRecovered.includes(w)).map((w) => `${w.task}#a${w.attempt}`).join(', ')}` : ''}`);

    // 5. the final halt is reachable + the queue drained
    rec.check('final halt reachable (chain halted, phase done, within budget)', !!(finalState?.chain?.halted && finalState?.project?.phase === 'done') && !budgetNote,
      budgetNote ? `budget note: ${budgetNote}; halted=${!!finalState?.chain?.halted}` : `halted at ${Math.round(wallMs / 1000)}s, ${conductorRuns} conductor runs, ${kicks} ticks`);
    rec.check('final report queue drained at halt', finalQueue.length === 0, `${finalQueue.length} lines remain`);

    // 5b. the B5 recovery invariant: every done declared-artifacts task is
    // PR-stamped IN THE JOURNAL (the durable pointer). A B5 kill lands between
    // the PR-open POST and the stamp commit — the reuse lane must re-nominate
    // (prFlowCandidates re-scans every tick, quiesced ticks included) and
    // re-stamp via the reuse probe. The live state's pr field is NOT the
    // evidence (the §5b compaction prunes it 20 ticks past terminal); the
    // journal stamp record is. (A NON-done artifacts task — e.g. a
    // chaos-quarantined one — expects NO PR: the work never completed.)
    const doneArtifacts = artifactsIds.filter((id) => finalStatus.get(id) === 'done');
    const unstamped = doneArtifacts.filter((id) => !stampByTask.has(id) && finalState?.tasks?.[id]?.pr == null);
    rec.check('every done artifacts task is PR-stamped (journal stamp record — the B5 reuse-lane recovery)', unstamped.length === 0,
      unstamped.length ? `unstamped: ${unstamped.join(', ')}` : `${doneArtifacts.length}/${doneArtifacts.length} stamped (${doneArtifacts.filter((id) => finalState?.tasks?.[id]?.pruned).length} pruned pointers — journal evidence)`);

    // 6. the kill floor + every boundary class exercised. The SCHEDULE is the
    // design contract (seed-pure, all entries seeded); FIRED is the coverage
    // contract. A dud entry is schedule-waste, not a coverage hole — with
    // re-arming, a terminal dud means the boundary's event SUPPLY ran out
    // (e.g. more report-push entries than dup-task pushes exist), so the
    // floor is calibrated to the honest quick/full supply, and the REAL
    // coverage requirement is: every boundary class FIRED at least once.
    const firedFloor = quick ? 10 : 32;
    const unexercised = BOUNDARIES.filter((b) => (killsByBoundary[b]?.fired || 0) === 0);
    rec.check(`kill floor (>=${firedFloor} fired) and all five boundaries exercised`, killer.kills.length >= firedFloor && unexercised.length === 0,
      `${killer.kills.length}/${plan.entries.length} fired (${terminalDuds.length} terminal duds = event-supply exhaustion, ${rearmedWaste.length} re-armed waste events); unexercised: ${unexercised.join(', ') || 'none'}`);

    // 7. seed purity + the executed-log accounting — SPLIT (s23-chaos3, the
    // design tension resolved): the re-arm is RUNTIME retry bookkeeping on
    // the entry objects (entry.rearms), not a schedule change, so the LIVE
    // plan.entries are EXPECTED to differ from a fresh derivation after any
    // re-arm — the pre-recovery-3 shape compared the live entries and
    // convicted the pure derivation of its own runtime retry state.
    // (a) THE PURE PROPERTY: a fresh derivation is byte-identical to the
    //     INITIAL snapshot taken before the scheduler ran.
    // (b) THE ACCOUNTING PROPERTY: the executed log is a complete ledger of
    //     the initial schedule — every entry fired EXACTLY ONCE or was
    //     flushed as a documented epoch-ended dud; kills + unfired = the
    //     schedule, and no kill references an entry that is not in it.
    const recheck = killPlanFor(seed, quick);
    rec.check('kill schedule is seed-pure (the INITIAL derivation re-derives byte-identical)',
      recheck.fingerprint === plan.fingerprint && JSON.stringify(recheck.entries) === initialEntriesJson,
      `fingerprint ${plan.fingerprint} (seed ${seed}${quick ? ', quick' : ', full'}); the live entries carry the runtime re-arm bookkeeping — the accounting check below is the runtime half`);
    const firedIdxList = killer.kills.map((k) => k.scheduleIdx);
    const firedIdx = new Set(firedIdxList);
    const phantomKillIdx = firedIdxList.filter((i) => !Number.isInteger(i) || i < 0 || i >= plan.entries.length);
    const unfiredEntries = plan.entries.filter((e, i) => !firedIdx.has(i));
    const unfiredFlushed = unfiredEntries.filter((e) => terminalDuds.some((d) => d.entry === e));
    rec.check('every scheduled kill is accounted (fired exactly once or a documented dud)',
      phantomKillIdx.length === 0 && firedIdx.size === firedIdxList.length && unfiredEntries.length === unfiredFlushed.length && killer.kills.length + terminalDuds.length === plan.entries.length,
      `${killer.kills.length} fired + ${terminalDuds.length} unfired-at-stop = ${plan.entries.length} scheduled${unfiredEntries.length !== unfiredFlushed.length ? ` — UNACCOUNTED entries: ${plan.entries.filter((e, i) => !firedIdx.has(i) && !terminalDuds.some((d) => d.entry === e)).length}` : ''}`);

    // 8. no orphaned processes outlive the battery
    sweptPids = sweepProcs(underScratch);
    await sleep(400);
    const leftovers = countProcs(underScratch);
    rec.check('no orphaned adapter/CLI/bridge processes survive the battery', leftovers === 0,
      `${sweptPids.length} swept at teardown, ${leftovers} remained after the grace period`);
    if (redeliverIds.size === 0) rec.note('zero re-deliveries observed this run (the dup tasks were killed inside their gap — the at-least-once side carried)');
  } finally {
    // ---- teardown: everything down, everything swept ------------------------
    try { if (killer) killer.stop(); } catch { /* already */ }
    try { if (sched) await sched.stop(); } catch { /* already */ }
    try { sweepProcs(underScratch); } catch { /* best effort */ }
    try { if (ghapi) await ghapi.close(); } catch { /* best effort */ }
    try { if (world) world.teardown(); } catch { /* best effort */ }
    void sweptPids;
  }
  return rec;
}

function pushTerm(map, task, j) {
  if (!task) return;
  const arr = map.get(task) || [];
  arr.push({ kind: j.kind, to: j.to });
  map.set(task, arr);
}
