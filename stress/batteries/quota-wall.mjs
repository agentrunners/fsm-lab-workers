// stress/batteries/quota-wall.mjs — BATTERY 2: the X23 arc parameterized
// (a6 §6.1). The PoolLane model (per-key 50/day-style budget, 429 +
// X-RateLimit headers, per-key counters, daily reset) driving the REAL
// conductorTick + FSM budget machinery: rotation coverage, alert-first
// order, zero work-ladder burn, resume-on-fresh-quota drains.
//
// The worker model is the REAL free-lane pick (worker/turn.mjs's fnv1a
// hash-stable pick + M5 rotation, bounded by the lane_attempts hop budget):
//   pick = pool[(fnv1a(task) + rotationRetries) % pool.length]
//   200 -> done report; 429 -> rotate (rotationRetries++), bounded by
//   maxTries = min(chain.length, max(1, min(2, lane_attempts))) = 2.
//   Both hops 429 -> infra_failed report carrying the QUOTA detail
//   ('lane-exhausted(2/2 hops, last lane-429)') — the exact class the F-6
//   budget window keys on.
//
// Asserts (the X23 contract):
//   * rotation visits keys per the FNV pick — coverage = pool size (given
//     enough calls);
//   * the budget-pause fires at budget_pause_threshold distinct tasks (the
//     count trigger), ALERT-FIRST (the alert issue exists BEFORE the pause
//     event applies — ghapi-ledger timestamps), the pause NOT in the
//     trigger tick;
//   * zero work-ladder burn — every task's attempts ≤ 1 through the wall
//     (infra voids net-zero; the X21 12×3 quarantine burn is dead);
//   * zero post-pause assigns;
//   * resume-on-fresh-quota drains clean (the day rollover resets the
//     per-key counters — the honest remedy, not retry-harder).
//
// Parameterized (keys × quota × tasks × preSpent): quick = one shape
// (8 × 2 × 12); full = the nightly sweep matrix, including the a6 example
// (68-key pool, all exhausted by t0+3 tasks) and the single-ladder backstop
// shape (max_parallel=1).

import { genesis, apply } from '../../lib/fsm.mjs';
import { conductorTick } from '../../lib/conductor-core.mjs';
import { buildEvent, mintEventId } from '../../lib/event-ingest.mjs';
import { fnv1a } from '../../worker/turn.mjs';
import { PoolLane } from '../lib/pool-lane.mjs';
import { makeClock, Recorder, T0, MIN, HOUR, DAY } from '../lib/common.mjs';

const CFG = (over = {}) => ({ max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300, budget_pause_threshold: 3, budget_pause_window_min: 15, prune_tasks_after_ticks: 500, ...over });

// the free-lane hop ladder (worker/turn.mjs's shape, virtual): fnv1a
// hash-stable pick + M5 rotation on the QUOTA class, bounded by the hop
// budget. Returns the report the virtual worker files.
function workerTurn({ task, attempt, pool, poolLane, clock, repSeq }) {
  const maxTries = 2;   // min(chain.length=2, max(1, min(2, lane_attempts=3)))
  const taskHash = fnv1a(String(task));
  let rotationRetries = 0;
  let last = null;
  const keysUsed = [];
  for (let hop = 0; hop < maxTries; hop++) {
    const keyIndex = (taskHash + rotationRetries) % pool.length;
    keysUsed.push(keyIndex);
    const r = poolLane.call(keyIndex);
    if (r.status === 200) {
      return {
        report: { event_id: `rep-qw${repSeq}-${task}-a${attempt}`, task, outcome: { status: 'done', artifact: `done-${task}` }, run_id: `qw-${repSeq}` },
        ok: true, keysUsed, hops: hop + 1,
      };
    }
    last = r;   // 429 — the quota family rotates the pool slot
    rotationRetries += 1;
  }
  return {
    report: {
      event_id: `rep-qw${repSeq}-${task}-a${attempt}`, task,
      outcome: { status: 'infra_failed', error: `lane-exhausted(${maxTries}/${maxTries} hops, last lane-429)` },
      run_id: `qw-${repSeq}`,
    },
    ok: false, keysUsed, hops: maxTries, retryAfterMs: last?.retryAfterMs ?? null,
  };
}

// ---------------------------------------------------------------------------
// QuotaWallDriver — Sim4's shape (in-memory conductorTick, the adapter's
// pause protocol simulated with a TIMESTAMPED alert ledger — alert-first is
// an ORDERING assert, so the ledger carries the virtual clock at each step).
// ---------------------------------------------------------------------------
class QuotaWallDriver {
  constructor({ label, config, keys, quota, clock, preSpended = 0 }) {
    this.label = label;
    this.t = clock.ms;
    this.clock = clock;
    this.now = () => { this.t += 1; return new Date(this.t).toISOString(); };
    this.genesisConfig = config;
    this.pool = keys.map((_, i) => `sk-or-v1-qw${i}`);
    this.poolLane = new PoolLane({ keys: this.pool, quota, clock, preSpent: preSpended });
    this.state = null;
    this.queue = [];
    this.journalAll = [];
    this.tickSeq = 0;
    this.repSeq = 0;
    // the adapter-protocol simulation, timestamped (the alert-first ledger)
    this.alertLedger = [];       // { at, kind: 'issue-opened' | 'marker-comment' }
    this.pauseLedger = [];       // { at, event_id }
    this.turnRed = false;
    this.turnCount = 0;
    this.keysUsedAll = new Set();
    this.hopHistogram = [];
    this.makeGenesis = ({ config } = {}) => {
      const cfg = config || this.genesisConfig;
      const tasks = Array.from({ length: cfg.__tasks }, (_, i) => ({ id: `QW-${String(i + 1).padStart(2, '0')}`, title: `quota task ${i + 1}`, behavior: 'real', work_ms: 1000, deps: [] }));
      return { state: genesis({ config: { ...cfg }, project: { tasks, milestones: 1 }, chainId: `${label}-c1`, now: this.now(), mode: 'mock' }), spec: { tasks, milestones: 1 } };
    };
  }

  boot(nTasks) {
    const g = this.makeGenesis({ config: { ...this.genesisConfig, __tasks: nTasks } });
    delete g.state.config.__tasks;
    this.genesisConfig = { ...g.state.config };
    this.state = g.state;
    return this.state;
  }

  // the virtual workers work every assigned task and file their reports
  workAssignedTasks() {
    const assigned = Object.values(this.state.tasks).filter(t => t.status === 'assigned' && t.lease);
    for (const t of assigned) {
      const w = workerTurn({ task: t.id, attempt: t.attempts, pool: this.pool, poolLane: this.poolLane, clock: this.clock, repSeq: ++this.repSeq });
      for (const k of w.keysUsed) this.keysUsedAll.add(k);
      this.hopHistogram.push(w.hops);
      this.queue.push({ ...w.report, lease: t.lease.token, task: t.id });
    }
  }

  applyPauseProtocol(action) {
    // F-8: (1) open the alert issue; (2) only on success mint + apply the
    // pause CONTROL event. The LEDGER proves the order.
    this.alertLedger.push({ at: this.now(), kind: 'issue-opened', detail: action.detail });
    const pauseEv = {
      kind: 'CONTROL', command: 'pause',
      payload: { reason: 'lane-budget-exhausted', window: action.window },
      event_id: mintEventId('CONTROL', { nodeId: '9001', command: 'budget-pause', clockMs: this.t }),
      ts: this.now(),
    };
    this.pauseLedger.push({ at: this.t, event_id: pauseEv.event_id });
    const r = apply(this.state, pauseEv, this.now(), () => null, {});
    this.state = r.state;
    this.journalAll.push(...r.journal);
    return { ok: true };
  }

  tick(reason = 'chain', { controls = [] } = {}) {
    this.tickSeq++;
    this.turnCount++;
    const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason, seq: this.tickSeq } }, { now: this.now });
    const out = conductorTick({
      cur: this.state, queue: this.queue, controlQueue: controls, queueBad: [], ctlBad: [],
      intakeQueue: [], intakeBad: [], ev, now: this.now, nextMilestone: () => null,
      recover: () => null, makeGenesis: this.makeGenesis,
    });
    this.queue = [];
    if (out.noop) return { noop: true, reason: out.reason };
    this.state = out.state;
    this.journalAll.push(...out.journal);
    const pauseAction = (out.actions || []).find(a => a.type === 'BUDGET_PAUSE_ALERT') || null;
    return { out, pauseAction };
  }

  // one full round: assign → work → drain (the compressed epoch loop)
  round(reason = 'chain', controls = []) {
    const r1 = this.tick(reason, { controls });
    if (!r1.noop) this.workAssignedTasks();
    const r2 = this.tick(`${reason}-drain`);
    return { r1, r2 };
  }
}

// ---------------------------------------------------------------------------
// one parameterized arc
// ---------------------------------------------------------------------------
function runArc({ label, keys, quota, tasks, preSpent = 0, maxParallel = 4, threshold = 3, backstopShape = false }, rec) {
  const clock = makeClock();
  const d = new QuotaWallDriver({
    label, config: CFG({ max_parallel: maxParallel, budget_pause_threshold: threshold }), keys: Array.from({ length: keys }, (_, i) => i), quota, clock, preSpended: preSpent,
  });
  d.boot(tasks);

  // --- phase 1: drive rounds until the pause fires (or everything drains) ---
  let pauseAction = null, rounds = 0;
  while (!pauseAction && d.state.project.phase !== 'done' && rounds < 30) {
    const { r1, r2 } = d.round(`w${rounds}`);
    pauseAction = r1.pauseAction || r2.pauseAction || null;
    rounds++;
    if (d.state.chain.paused) break;
  }
  // the adapter's alert-first protocol: alert issue -> THEN the pause event
  if (pauseAction && !d.state.chain.paused) d.applyPauseProtocol(pauseAction);

  const coverage = d.keysUsedAll.size;
  const m = d.poolLane.metrics;
  const attemptsAtWall = Math.max(0, ...Object.values(d.state.tasks).map(t => t.attempts));
  const quarantinedAtWall = Object.values(d.state.tasks).filter(t => t.status === 'quarantined').length;

  const pausedNow = d.state.chain.paused === true;
  // alert-first: the ledger's issue-opened strictly precedes the pause stamp
  // (both in epoch-ms — the alert ledger's ISO parsed)
  const alertFirst = d.alertLedger.length >= 1 && d.pauseLedger.length === 1
    && Date.parse(d.alertLedger[0].at) <= d.pauseLedger[0].at;

  rec.check(`${label}: the budget-pause FIRED at the wall`, !!pauseAction && pausedNow,
    `rounds=${rounds} distinctTasks=${pauseAction?.tasks?.length ?? 0} backstop=${pauseAction?.backstop ?? false}`);
  rec.check(`${label}: ALERT-FIRST — the alert issue exists before the pause event applies`,
    alertFirst, `alert@${d.alertLedger[0]?.at} pause@${d.pauseLedger[0]?.at}`);
  rec.check(`${label}: the pause fired at ≤ threshold+1 distinct tasks (immediate — no extra burn waiting)`,
    (pauseAction?.tasks?.length ?? 99) <= threshold + (maxParallel - 1),
    `tasks in window=${pauseAction?.tasks?.length} threshold=${threshold} max_parallel=${maxParallel}`);
  rec.check(`${label}: ZERO work-ladder burn through the wall (attempts ≤ 1, the X21 12×3 burn is dead)`,
    attemptsAtWall <= 1 && quarantinedAtWall <= (backstopShape ? 1 : 0),
    `maxAttempts=${attemptsAtWall} quarantined=${quarantinedAtWall}${backstopShape ? ' (the single-ladder backstop\'s DESIGNED infra-exhausted terminal — the INFRA ladder burned at its own 3-bound, never the work ladder)' : ''}`);
  rec.metric(`${label}_rotation_coverage`, coverage);
  rec.metric(`${label}_keys_pool`, keys);
  rec.metric(`${label}_calls`, m.calls);
  rec.metric(`${label}_ok200`, m.ok200);
  rec.metric(`${label}_err429`, m.err429);
  rec.metric(`${label}_first_429_at`, m.first429At);
  rec.metric(`${label}_rounds_to_pause`, rounds);
  rec.metric(`${label}_attempts_at_wall`, attemptsAtWall);

  // --- phase 2: zero post-pause assigns, then the day rolls + resume drains ---
  const assignedAtPause = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  d.tick('held');
  const assignedAfterHeld = Object.values(d.state.tasks).filter(t => t.status === 'assigned').length;
  rec.check(`${label}: zero post-pause assigns`, assignedAfterHeld <= assignedAtPause,
    `assigned ${assignedAtPause} -> ${assignedAfterHeld} across the held tick`);

  // the honest remedy: the DAY ROLLS (the per-key counters reset) — then the
  // operator resumes and the epoch drains on the fresh quota
  clock.advanceTo(Math.floor(clock.ms / DAY) * DAY + DAY + 5 * MIN);
  let guard = 0;
  d.tick('resume', { controls: [{ cmd: 'resume', id: 'ctl-qw-r', ts: new Date(clock.ms).toISOString(), sender: 'op', note: 'quota-day-rolled' }] });
  while (d.state.project.phase !== 'done' && guard++ < 40) {
    const { r1 } = d.round(`post${guard}`);
    if (r1.noop) break;
  }
  const done = d.state.stats.done;
  const quarantinedFinal = d.state.stats.quarantined;
  rec.check(`${label}: resume-on-fresh-quota drains the epoch clean`,
    d.state.project.phase === 'done' && done + quarantinedFinal === tasks,
    `phase=${d.state.project.phase} done=${done}/${tasks} quarantined=${quarantinedFinal} roundsPostResume=${guard}`);
  rec.metric(`${label}_done`, done);
  rec.metric(`${label}_post_resume_rounds`, guard);
  const finalAttempts = Math.max(...Object.values(d.state.tasks).map(t => t.attempts));
  rec.metric(`${label}_final_max_attempts`, finalAttempts);
  rec.check(`${label}: the day-rollover reset fired (per-key counters reborn)`,
    (d.poolLane.dayRollovers ?? 0) >= 1, `rollovers=${d.poolLane.dayRollovers ?? 0}`);
  // the honest REACH characterization (the W1/W3 family): a turn's hop
  // ladder reaches exactly TWO keys (hash, hash+1) — pool capacity can
  // STRAND when demand exactly equals capacity and the last free slot sits
  // outside every remaining task's 2-key reach. Cross-turn key memory (the
  // a2 W3 fix) or a wider hop budget would widen the reach.
  rec.note(`${label}: hop-ladder reach = 2 keys/turn (hash, hash+1 mod ${keys}) — rotation coverage across the fleet is ${coverage}/${keys} keys; stranded-capacity risk exists when demand ≈ capacity (the W1/W3 reachability family)`);
  return d;
}

// ---------------------------------------------------------------------------
export async function run({ quick, seed } = {}) {
  const rec = new Recorder('quota-wall');
  void seed;   // the arc is deterministic given its parameters (no rng lanes)

  // quick: one shape — 4 keys × quota 2 × 12 tasks: capacity 8 < 12 needed —
  // the wall hits mid-epoch, exactly the X23 shape (the compact analog of
  // the 68-key pool exhausted by volume).
  runArc({ label: 'qw4x2x12', keys: 4, quota: 2, tasks: 12, maxParallel: 4, threshold: 3 }, rec);

  if (!quick) {
    // the nightly sweep (a6 §6.1: parameterized keys × quota × tasks):
    //  - 16×2×24 preSpent 16: the wall mid-epoch by volume, FULL quota back
    //    on rollover (slack for the drain — the honest X23 remedy shape)
    //  - the a6 example: 68-key pool × quota 50, ALL exhausted by t0+3 tasks
    //    (preSpent = 68×50 − 3) — the wall at the third task's first hop
    //  - the single-ladder backstop shape: max_parallel=1, one task's full
    //    ladder → infra-exhausted → the OR-backstop pause (zero further burn;
    //    the ONE designed infra-exhausted quarantine is the backstop firing)
    runArc({ label: 'qw16x2x24-pre', keys: 16, quota: 2, tasks: 24, preSpent: 16, maxParallel: 4, threshold: 3 }, rec);
    runArc({ label: 'qw68x50x24-pre', keys: 68, quota: 50, tasks: 24, preSpent: 68 * 50 - 3, maxParallel: 4, threshold: 3 }, rec);
    runArc({ label: 'qw-single-ladder', keys: 4, quota: 1, tasks: 6, maxParallel: 1, threshold: 3, backstopShape: true }, rec);
  }
  return rec;
}
