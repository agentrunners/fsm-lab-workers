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
//     exactly one applied terminal-arrival journal record, one distinct `to`);
//   * ZERO lost reports and ZERO double-applied reports — the report ledger
//     diff: every worker-confirmed emission is accounted (applied, or
//     rejected-duplicate = a re-delivery absorbed, or rejected-orphan = a
//     superseded attempt accounted); no event id applied twice; every applied
//     report attributes to a real dispatched worker run;
//   * the WEDGED shapes recover: every assigned-but-never-dispatched attempt
//     (the killed-post-commit-pre-dispatch class) is later lease-reaped (a
//     TIMEOUT record after the wedge) — no lease lives forever;
//   * the final halt is reachable (chain.halted, phase done, queue drained)
//     inside the wall budget.
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
    T('CQ-F4', null, 'cc-fast', 3_000),
    T('CQ-F5', null, 'cc-fast', 4_000),
    T('CQ-D1', 'dup-report', 'cc-dup', 4_000),
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
// dup-report 1500ms gap or just after a plain report push). The first B2
// entry skips 2-3 events so the epoch's productive phase is not wedged at t0.
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
      let delayMs = 0;
      if (boundary === 'worker-pre-report') delayMs = 1500 + Math.floor(rng() * 7000);         // mid-work on a >=15s attempt
      if (boundary === 'worker-report-push') delayMs = 30 + Math.floor(rng() * 1350);          // the dup gap is 1500ms
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
    this.duds = [];             // entries that never fired (epoch ended / victim gone)
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

  arm(entry, boundary, info) {
    if (boundary === 'worker-pre-report' || boundary === 'worker-report-push') {
      this.pending.push({ entry, boundary, runId: info.runId, task: info.task, dueMs: Date.now() + entry.delayMs, ts: Date.now() });
      return;
    }
    // immediate boundaries: resolve the victim run now
    if (boundary === 'conductor-post-commit' || boundary === 'conductor-mid-pr') {
      const run = this.sched.runs.find((r) => r.workflow === 'conductor' && r.status === 'in_progress');
      if (!run) { this.duds.push({ entry, reason: 'no-conductor-in-flight' }); return; }
      this.execute({ entry, boundary, runId: run.id, task: null, ts: Date.now() });
      return;
    }
    if (boundary === 'worker-post-taskbranch') {
      const run = this.sched.runs.find((r) => r.workflow === 'worker' && r.status === 'in_progress' && r.taskRef === info.task);
      if (!run) { this.duds.push({ entry, reason: 'no-worker-in-flight' }); return; }
      this.execute({ entry, boundary, runId: run.id, task: info.task, ts: Date.now() });
    }
  }

  fireDue() {
    for (const p of this.pending) {
      if (p.done || Date.now() < p.dueMs) continue;
      p.done = true;
      const run = this.sched.runById(p.runId);
      if (!run || run.status !== 'in_progress') {
        this.duds.push({ entry: p.entry, reason: 'victim-exited', boundary: p.boundary });
        continue;
      }
      this.execute(p);
    }
    this.pending = this.pending.filter((p) => !p.done);
  }

  execute(p) {
    const procs = killRunTree({ runId: p.runId, taskId: p.task ?? null, cloneDir: null });
    let cloneDir = null;
    const r = this.sched.runById(p.runId);
    if (r) cloneDir = `clone-${r.workflow}-`;   // marker only; the full tree kill below sweeps by run id + task
    this.seq += 1;
    const rec = {
      seq: this.seq, boundary: p.boundary, victimRunId: p.runId, victimTask: p.task ?? null,
      ts: p.ts, delayMs: p.entry.delayMs, killedGroups: procs.length,
      killed: procs.map((x) => ({ pid: x.pid, cmd: x.cmd.slice(0, 90) })),
    };
    this.kills.push(rec);
    console.log(`  ⚡ [chaos] KILL #${rec.seq} ${p.boundary} run=${p.runId} task=${p.task ?? '-'} (${procs.length} group${procs.length === 1 ? '' : 's'}${p.entry.delayMs ? `, delayed ${p.entry.delayMs}ms` : ''})`);
    void cloneDir;
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
  rec.note(`epoch: ${tasks.length} tasks (mixed: fast/slow/dup/artifacts/infra/fail), max_parallel=${MAX_PARALLEL}, lease=${LEASE_MIN}min (the floor — real clock), max_attempts=${MAX_ATTEMPTS}, mode=cc (the full boundary surface)`);
  rec.note(`kill schedule (seed ${seed}, fingerprint ${plan.fingerprint}): ${plan.entries.length} entries — ${BOUNDARIES.map((b) => `${b}=${plan.entries.filter((e) => e.boundary === b).length}`).join(', ')}`);

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
      worktreeRoot: ROOT, apiBase, log: flog, keep: false,
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
      const lines = await queueLines();
      const pendPr = st && Object.entries(st.tasks || {}).some(([id, t]) => t && t.status === 'done' && !t.pr && (byId.get(id)?.spec?.artifacts?.length));
      if (lines.length === 0 && !pendPr && settleKicks >= 2) break;
      if (settleKicks >= 16) { budgetNote = 'settle budget exhausted (queue/PRs not settled)'; break; }
      settleKicks += 1;
      await kick();
      await sleep(2500);
      if (Date.now() - t0 > wallBudgetMs) { budgetNote = `wall budget exhausted during settle`; break; }
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
    // the full journal (every retained generation, in order)
    await fetchProbe();
    const ls = await agit(['-C', world.probeClone, 'ls-tree', '--name-only', 'refs/remotes/origin/fsm-state', 'state/']);
    const gens = ls.out.split('\n').map((x) => x.trim()).filter(Boolean)
      .map((f) => /^state\/journal-(\d+)\.jsonl$/.exec(f)).filter(Boolean)
      .map((m) => parseInt(m[1], 10)).sort((a, b) => a - b);
    const journal = [];
    for (const gn of gens) {
      const raw = await showProbe(`state/journal-${gn}.jsonl`);
      for (const line of (raw || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { journal.push(JSON.parse(t)); } catch { /* bad line — the drain's own class */ }
      }
    }

    // the dispatch map: every fsm-task POST the conductor ever made
    const dispatchMap = new Map();   // runId -> {task, attempt, t}
    for (const e of ghapi.ledger()) {
      if (e.method !== 'POST' || !/\/dispatches$/.test(String(e.path))) continue;
      if (!String(e.req || '').includes('"fsm-task"')) continue;
      try {
        const body = JSON.parse(e.req);
        const cp = body.client_payload || {};
        if (cp.task && cp.run_id != null) dispatchMap.set(String(cp.run_id), { task: cp.task, attempt: cp.attempt, t: e.t });
      } catch { /* sliced body — the tallies only */ }
    }

    // the applied/rejected report ledger (journal side)
    const appliedInprogress = new Map();    // runId -> count of to=in_progress REPORT records (double-apply detector)
    const appliedRunIds = new Set();
    const redeliverIds = new Set();         // REJECTED duplicate (origKind REPORT)
    const orphanRejectIds = new Set();      // REJECTED stale/unknown/… (accounted, superseded)
    const appliedTerminal = new Map();      // task -> [{kind, to}]
    for (const j of journal) {
      if (j.kind === 'REPORT' && j.applied !== false) {
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
    const appliedEventIds = new Set([...appliedRunIds].map((rid) => {
      const d = dispatchMap.get(rid);
      return d ? `rep-${rid}-a${d.attempt}` : null;
    }).filter(Boolean));

    // the emitted ledger (worker side): every run whose log confirms a landed enqueue
    const EMIT_RE = /WORKER-DONE task=\S+ outcome=\S+ enqueue=ok|WORKER-GATE-REJECT task=\S+[^\n]*enqueue=ok|WORKER-REPORT-DUP first=true/;
    const emitted = new Map();   // eventId -> {runId, task}
    for (const r of sched.runs) {
      if (r.workflow !== 'worker') continue;
      const m = / a(\d+)$/.exec(r.name || '');
      if (!m) continue;
      const text = sched.runLogText(r.id);
      if (EMIT_RE.test(text)) emitted.set(`rep-${r.id}-a${m[1]}`, { runId: r.id, task: r.taskRef });
    }

    // the wedge analysis: every ASSIGN whose (task, attempt) was NEVER dispatched
    const assigns = [];
    {
      let idx = 0;
      for (const j of journal) {
        if (j.kind === 'ASSIGN' && j.applied !== false) assigns.push({ ...j, idx: idx });
        idx++;
      }
    }
    const dispatchedPairs = new Set([...dispatchMap.values()].map((d) => `${d.task}#a${d.attempt}`));
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

    // ---- the achieved-class tally per kill ---------------------------------
    const killsByBoundary = {};
    for (const b of BOUNDARIES) killsByBoundary[b] = { fired: 0, events: killer.eventCounts.get(b) || 0, achieved: {} };
    const dispatchTsByRun = new Map();
    for (const e of ghapi.ledger()) {
      if (e.method !== 'POST' || !/\/dispatches$/.test(String(e.path)) || !String(e.req || '').includes('"fsm-task"')) continue;
      try {
        const cp = JSON.parse(e.req).client_payload || {};
        if (cp.run_id != null) {
          const rid = String(cp.run_id);
          dispatchTsByRun.set(rid, [...(dispatchTsByRun.get(rid) || []), e.t]);
        }
      } catch { /* sliced */ }
    }
    for (const k of killer.kills) {
      const slot = killsByBoundary[k.boundary];
      slot.fired += 1;
      let cls = 'killed';
      const evId = (() => {
        const d = dispatchMap.get(String(k.victimRunId));
        return d ? `rep-${k.victimRunId}-a${d.attempt}` : null;
      })();
      const accounted = evId && (appliedEventIds.has(evId) || redeliverIds.has(evId) || orphanRejectIds.has(evId));
      if (k.boundary === 'conductor-post-commit') {
        const posts = (dispatchTsByRun.get(String(k.victimRunId)) || []).filter((t) => t >= k.ts).length;
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
    for (const b of BOUNDARIES) killsByBoundary[b].duds = (killer.duds || []).filter((d) => d.entry.boundary === b).length;
    rec.metric('killScheduleFingerprint', plan.fingerprint);
    rec.metric('killsScheduled', plan.entries.length);
    rec.metric('killsFired', killer.kills.length);
    rec.metric('killsDud', killer.duds.length);
    rec.metric('killsByBoundary', killsByBoundary);
    rec.metric('boundaryEvents', Object.fromEntries(killer.eventCounts));
    rec.metric('tasks', { total: taskIds.length, byStatus: Object.fromEntries([...finalStatus].map(([id, s]) => [id, s])) });
    rec.metric('reportsLedger', {
      emitted: emitted.size,
      applied: appliedRunIds.size,
      redeliveries: redeliverIds.size,
      orphanRejects: orphanRejectIds.size,
      finalQueueLines: finalQueue.length,
    });
    rec.metric('wedges', { assignedNeverDispatched: wedges.length, recoveredViaLeaseReap: wedgesRecovered.length });
    rec.metric('prs', {
      opened: ghapi.ledger().filter((e) => e.method === 'POST' && /\/pulls$/.test(String(e.path)) && e.status === 201).length,
      stamped: taskIds.filter((id) => finalState?.tasks?.[id]?.pr != null).length,
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
    const missingTerminal = taskIds.filter((id) => !appliedTerminal.has(id));
    rec.check('every task has EXACTLY ONE applied terminal-arrival record', multiTerminal.length === 0 && missingTerminal.length === 0,
      `multi: ${multiTerminal.join(', ') || 'none'}; missing: ${missingTerminal.join(', ') || 'none'}`);

    // 2+3. the report ledger diff — zero lost, zero double-applied
    const lost = [...emitted.keys()].filter((id) => !(appliedEventIds.has(id) || redeliverIds.has(id) || orphanRejectIds.has(id)));
    rec.check('ZERO lost reports (every worker-confirmed emission is accounted)', lost.length === 0,
      lost.length ? `lost: ${lost.join(', ')}` : `${emitted.size} emitted → ${appliedRunIds.size} applied + ${redeliverIds.size} re-deliveries + ${orphanRejectIds.size} orphan-rejects`);
    const doubleApplied = [...appliedInprogress].filter(([, n]) => n > 1).map(([rid]) => rid);
    rec.check('ZERO double-applied reports (one in_progress arrival per event id)', doubleApplied.length === 0,
      doubleApplied.length ? `run ids applied twice: ${doubleApplied.join(', ')}` : `${appliedRunIds.size} distinct applied ids, dedup absorbed ${redeliverIds.size} re-deliveries`);
    const phantom = [...appliedRunIds].filter((rid) => !dispatchMap.has(rid));
    rec.check('every applied report attributes to a dispatched worker run', phantom.length === 0,
      phantom.length ? `unattributed run ids: ${phantom.join(', ')}` : `${appliedRunIds.size}/${appliedRunIds.size} attributed`);

    // 4. the wedged shapes resolve via the lease-reap recovery path
    rec.check('every assigned-but-never-dispatched attempt is lease-reaped (wedge recovery)', wedges.length === wedgesRecovered.length,
      `${wedgesRecovered.length}/${wedges.length} wedged attempts recovered via TIMEOUT${wedges.length !== wedgesRecovered.length ? ` — unrecovered: ${wedges.filter((w) => !wedgesRecovered.includes(w)).map((w) => w.task).join(', ')}` : ''}`);

    // 5. the final halt is reachable + the queue drained
    rec.check('final halt reachable (chain halted, phase done, within budget)', !!(finalState?.chain?.halted && finalState?.project?.phase === 'done') && !budgetNote,
      budgetNote ? `budget note: ${budgetNote}; halted=${!!finalState?.chain?.halted}` : `halted at ${Math.round(wallMs / 1000)}s, ${conductorRuns} conductor runs, ${kicks} ticks`);
    rec.check('final report queue drained at halt', finalQueue.length === 0, `${finalQueue.length} lines remain`);

    // 6. the kill floor + every boundary class exercised
    const firedFloor = quick ? 10 : 40;
    const unexercised = BOUNDARIES.filter((b) => (killsByBoundary[b]?.fired || 0) === 0);
    rec.check(`kill floor (>=${firedFloor} fired) and all five boundaries exercised`, killer.kills.length >= firedFloor && unexercised.length === 0,
      `${killer.kills.length}/${plan.entries.length} fired (${killer.duds.length} duds); unexercised: ${unexercised.join(', ') || 'none'}`);

    // 7. seed purity — the schedule is a function of the seed (re-derived, compared)
    const recheck = killPlanFor(seed, quick);
    rec.check('kill schedule is seed-pure (re-derivation is byte-identical)', recheck.fingerprint === plan.fingerprint && JSON.stringify(recheck.entries) === JSON.stringify(plan.entries),
      `fingerprint ${plan.fingerprint} (seed ${seed}${quick ? ', quick' : ', full'})`);

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
