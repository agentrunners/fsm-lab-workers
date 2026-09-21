// stress/batteries/dead-key-storm.mjs — BATTERY 3: the W1/W3 storm (a6 §6.1).
//
// The a2 audit's two redundancy-reachability findings, driven as STORMS with
// the REAL lane algebra (worker/cc-adapter.mjs's ccLanes + ccNextLaneIndex,
// worker/turn.mjs's fnv1a hash-stable pick) and the REAL FSM infra ladder:
//
//   W1 (KEY_2-unreachable — FIXED by the s21/W1 key-jump): a 50% dead-key
//     pool still completes ALL tasks — a key-class failure JUMPS to the next
//     key's first lane instead of grinding the dead key's remaining models.
//     The characterization CONTRAST lane drives the PRE-W1 advance policy
//     (i+1) and asserts the OLD wrong number (distinct keys SERVED = 0, all
//     tasks infra-exhausted) — the pin that proves the battery detects the
//     class.
//       // FLIP-ME (W1, FIXED): if the key-jump regresses, the primary lane
//       // below fails FIRST — the contrast lane is the standing proof.
//
//   W3 (no cross-turn key memory — CURRENT): the hash-stable pick re-lands
//     the SAME dead key every turn; the re-land count is bounded ONLY by the
//     FSM's INFRA_RETRY_MAX=3 (infra-exhausted quarantine). Counted, bounded
//     — the number flips when the W3 fix (cross-turn memory) lands:
//       // FLIP-ME (W3, CURRENT): re-lands per task === turns-taken (every
//       // turn re-picks blind); with cross-turn memory the bound tightens to
//       // 1 (the first blind landing) + the memory's own first miss.
//
// Asserts (the design's):
//   * per-turn lane_attempts bounded at 3 (the dispatched hop budget);
//   * infra-exhausted quarantine with the DISTINCT audit detail (reason
//     'infra-exhausted', never 'poison');
//   * a 50% dead pool completes all tasks via key-jump + rotation;
//   * the cross-turn re-land count is bounded (≤ INFRA_RETRY_MAX).
//
// quick: the 2-key CC lane + the 4-key free pool (both 50% dead); full adds
// the all-dead storms and the FSM-level ladder walk.

import { genesis, INFRA_RETRY_MAX } from '../../lib/fsm.mjs';
import { conductorTick } from '../../lib/conductor-core.mjs';
import { buildEvent } from '../../lib/event-ingest.mjs';
import { ccLanes, ccNextLaneIndex } from '../../worker/cc-adapter.mjs';
import { fnv1a } from '../../worker/turn.mjs';
import { makeClock, Recorder } from '../lib/common.mjs';

// ---------------------------------------------------------------------------
// (A) the CC-lane storm — W1's exact shape: 2 keys × 3 models, key-major
// flatten = 6 lanes; key 1 is DEAD (every model 401s), key 2 healthy.
// ---------------------------------------------------------------------------
function ccLaneStorm(rec, { deadKeys, advancePolicy }) {
  const env = {
    OPENROUTER_API_KEY: 'sk-or-v1-deadkey1',
    OPENROUTER_API_KEY_2: 'sk-or-v1-livekey2',
    CC_MODEL: '',   // unset: the default chain rides (no W7 duplicate lane)
  };
  const lanes = ccLanes(env);
  const laneCount = lanes.length;
  const isDead = (lane) => deadKeys.has(lane.keyIndex);

  // one task's turn: the hop ladder bounded by lane_attempts (3, the
  // dispatched budget — W2's lane_attempts default)
  const LANE_ATTEMPTS = 3;
  const walkTask = (taskId) => {
    let i = 0;
    const touched = [];
    for (let hop = 0; hop < LANE_ATTEMPTS; hop++) {
      const lane = lanes[i];
      touched.push(lane.keyIndex);
      if (!isDead(lane)) {
        return { served: lane.keyIndex, hops: hop + 1, touched, done: true };
      }
      const keyClass = true;   // 401 = CC_KEY_CLASS_STATUSES
      i = advancePolicy(lanes, i, keyClass);
    }
    return { served: null, hops: LANE_ATTEMPTS, touched, done: false };
  };

  const tasks = Array.from({ length: 12 }, (_, i) => `CC-${String(i + 1).padStart(2, '0')}`);
  const results = tasks.map(walkTask);
  const servedKeys = new Set(results.filter(r => r.done).map(r => r.served));
  const touchedKeys = new Set(results.flatMap(r => r.touched));
  const doneCount = results.filter(r => r.done).length;
  return { tasks, results, servedKeys, touchedKeys, doneCount, laneCount };
}

// ---------------------------------------------------------------------------
// (B) the free-lane storm — W3's exact shape: a 4-key pool, the hash-stable
// pick, M5 rotation WITHIN the turn (hop budget 2), NO cross-turn memory.
// Driven through the REAL FSM: each turn's walk files its report; infra
// reports re-assign next turn (the hash re-lands the same dead key).
// ---------------------------------------------------------------------------
class FreeLaneStormDriver {
  constructor({ label, poolSize, deadKeys, tasks, clock, config }) {
    this.label = label;
    this.t = clock.ms;
    this.clock = clock;
    this.now = () => { this.t += 1; return new Date(this.t).toISOString(); };
    this.pool = Array.from({ length: poolSize }, (_, i) => `sk-or-v1-free${i + 1}`);
    this.deadKeys = deadKeys;   // Set<keyIndex>
    this.tasksSpec = tasks;
    this.genesisConfig = config;
    this.state = null;
    this.queue = [];
    this.journalAll = [];
    this.tickSeq = 0;
    this.repSeq = 0;
    this.relands = new Map();   // task -> count of turns whose FIRST hop landed on a dead key
    this.firstPickDead = new Set();
    this.makeGenesis = () => {
      const t = this.tasksSpec.map((id) => ({ id, title: `storm ${id}`, behavior: 'real', work_ms: 100, deps: [] }));
      return { state: genesis({ config: this.genesisConfig, project: { tasks: t, milestones: 1 }, chainId: `${label}-c1`, now: this.now(), mode: 'mock' }) };
    };
  }

  boot() { this.state = this.makeGenesis().state; return this.state; }

  // the free-lane walk (worker/turn.mjs's real shape): hash-stable pick +
  // rotation on the ROTATE class, hop budget 2
  walk(taskId) {
    const taskHash = fnv1a(String(taskId));
    let rotationRetries = 0;
    const maxTries = 2;
    const touched = [];
    for (let hop = 0; hop < maxTries; hop++) {
      const keyIndex = (taskHash + rotationRetries) % this.pool.length;
      touched.push(keyIndex);
      if (this.deadKeys.has(keyIndex)) {
        rotationRetries += 1;   // M5: the 401 class rotates the pool slot
        continue;
      }
      return { ok: true, keyIndex, touched, hops: hop + 1 };
    }
    return { ok: false, keyIndex: null, touched, hops: maxTries };
  }

  workAssignedTasks() {
    const assigned = Object.values(this.state.tasks).filter(t => t.status === 'assigned' && t.lease);
    for (const t of assigned) {
      const w = this.walk(t.id);
      if (this.deadKeys.has(w.touched[0])) {
        this.relands.set(t.id, (this.relands.get(t.id) ?? 0) + 1);
        this.firstPickDead.add(t.id);
      }
      const outcome = w.ok
        ? { status: 'done', artifact: `done-${t.id}` }
        : { status: 'infra_failed', error: `openrouter-401 key-dead (${w.touched.map(k => `k${k + 1}`).join('->')})` };
      this.queue.push({
        event_id: `rep-dks${this.label}${++this.repSeq}-${t.id}`, task: t.id, lease: t.lease.token, outcome, run_id: `dks-${this.repSeq}`,
      });
    }
  }

  tick(reason = 'chain') {
    this.tickSeq++;
    const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason, seq: this.tickSeq } }, { now: this.now });
    const out = conductorTick({
      cur: this.state, queue: this.queue, controlQueue: [], queueBad: [], ctlBad: [],
      intakeQueue: [], intakeBad: [], ev, now: this.now, nextMilestone: () => null,
      recover: () => null, makeGenesis: this.makeGenesis,
    });
    this.queue = [];
    if (out.noop) return { noop: true, reason: out.reason };
    this.state = out.state;
    this.journalAll.push(...out.journal);
    return { out };
  }

  round(reason) {
    const r1 = this.tick(reason);
    if (!r1.noop) this.workAssignedTasks();
    const r2 = this.tick(`${reason}-drain`);
    return r2;
  }
}

// ---------------------------------------------------------------------------
export async function run({ quick, seed } = {}) {
  const rec = new Recorder('dead-key-storm');
  void seed;   // deterministic lanes (fnv1a is stable; no rng)

  // --- (A1) the W1 FIX holds under storm: 50% dead CC pool, key-jump live ---
  {
    const storm = ccLaneStorm(rec, {
      deadKeys: new Set([1]),   // key 1 dead, key 2 healthy — 50% of the pool
      advancePolicy: ccNextLaneIndex,
    });
    rec.check('cc-storm/W1-FIX: a 50% dead-key pool completes ALL tasks via key-jump',
      storm.doneCount === storm.tasks.length,
      `done=${storm.doneCount}/${storm.tasks.length} lanes=${storm.laneCount}`);
    rec.check('cc-storm/W1-FIX: KEY_2 SERVES (the designed 2-key failover exists — pre-W1 it was unreachable)',
      storm.servedKeys.size === 1 && storm.servedKeys.has(2),
      `servedKeys={[${[...storm.servedKeys].join(',')}]}`);
    rec.check('cc-storm/W1-FIX: per-task lane attempts bounded (≤2 hops: 1 dead + 1 served)',
      storm.results.every(r => r.hops <= 2),
      `maxHops=${Math.max(...storm.results.map(r => r.hops))}`);
    rec.metric('cc_storm_served_keys', [...storm.servedKeys]);
    rec.metric('cc_storm_touched_keys', [...storm.touchedKeys]);
    rec.metric('cc_storm_lanes', storm.laneCount);
  }

  // --- (A2) the characterization CONTRAST — the PRE-W1 advance policy ---
  // The old policy (plain i+1 over the key-major flatten) ground the dead
  // key's remaining models: 3 attempts on key 1's lanes, budget exhausted,
  // infra report — every turn (no cross-turn memory) — infra-exhausted
  // quarantine, KEY_2 NEVER SERVES.
  //   // FLIP-ME (W1, FIXED in s21/b3): this lane is the standing contrast —
  //   // the primary lane above is the regression pin; if ccNextLaneIndex's
  //   // key-jump regresses, A1 fails and A2's wrong number becomes A1's.
  {
    const storm = ccLaneStorm(rec, {
      deadKeys: new Set([1]),
      advancePolicy: (lanes, i) => Math.min(i + 1, lanes.length - 1),   // PRE-W1: plain advance
    });
    rec.check('cc-storm/W1-CONTRAST: the pre-W1 policy leaves KEY_2 UNSERVED (the pin detects the class)',
      storm.servedKeys.size === 0 && storm.doneCount === 0,
      `servedKeys={} done=${storm.doneCount}/${storm.tasks.length} — the a2 W1 wrong number reproduced`);
  }

  // --- (B1) the 50% dead FREE pool — all tasks complete via rotation ---
  {
    const clock = makeClock();
    const d = new FreeLaneStormDriver({
      label: 'fl50', poolSize: 4, deadKeys: new Set([1, 3]),   // keys 2 & 4 dead (0-indexed 1,3)
      tasks: Array.from({ length: 12 }, (_, i) => `FL-${String(i + 1).padStart(2, '0')}`),
      clock,
      config: { max_parallel: 12, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
    });
    d.boot();
    let guard = 0;
    while (d.state.project.phase !== 'done' && guard++ < 12) d.round(`r${guard}`);
    const done = d.state.stats.done;
    const relandArr = [...d.relands.values()];
    const maxRelands = relandArr.length ? Math.max(...relandArr) : 0;
    const totalRelands = relandArr.reduce((a, b) => a + b, 0);
    rec.check('free-storm/50%: ALL tasks complete via rotation (the 50% dead pool still serves)',
      d.state.project.phase === 'done' && done === 12, `done=${done}/12 rounds=${guard}`);
    // FLIP-ME (W3, CURRENT): re-lands per task = turns-taken (the hash
    // re-lands the SAME dead key every turn — no cross-turn memory). With
    // cross-turn key memory the per-task bound tightens toward 1.
    rec.check('free-storm/50%: the cross-turn re-land count is BOUNDED (≤ 2 per task)',
      maxRelands <= 2, `maxRelands/task=${maxRelands} totalRelands=${totalRelands} tasksWithDeadFirstPick=${d.firstPickDead.size}/12`);
    rec.metric('free50_done', done);
    rec.metric('free50_max_relands_per_task', maxRelands);
    rec.metric('free50_total_relands', totalRelands);
    rec.metric('free50_dead_first_pick_tasks', d.firstPickDead.size);
  }

  if (!quick) {
    // --- (B2) the ALL-DEAD free pool — the W3 re-land bound is the FSM's ---
    // Every key 401 from t0: each turn re-lands the SAME hash-stable dead
    // key, rotation lands on another dead key, infra report — 3 turns →
    // infra-exhausted quarantine with the DISTINCT audit detail. The re-land
    // count per task is EXACTLY INFRA_RETRY_MAX (the current bound).
    //   // FLIP-ME (W3, CURRENT): with cross-turn key memory a task would
    //   // START from the remembered-live candidate and the re-land count
    //   // would DROP below INFRA_RETRY_MAX while the pool is all-dead only
    //   // if the memory widens reach — as-is the bound is the FSM ladder.
    {
      const clock = makeClock();
      const d = new FreeLaneStormDriver({
        label: 'fl100', poolSize: 4, deadKeys: new Set([0, 1, 2, 3]),
        tasks: Array.from({ length: 6 }, (_, i) => `AD-${String(i + 1).padStart(2, '0')}`),
        clock,
        config: { max_parallel: 6, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
      });
      d.boot();
      let guard = 0;
      while (d.state.project.phase !== 'done' && guard++ < 12) d.round(`r${guard}`);
      const quarantined = d.state.stats.quarantined;
      const relandArr = [...d.relands.values()];
      const maxRelands = relandArr.length ? Math.max(...relandArr) : 0;
      const exRecords = d.journalAll.filter(j => j.kind === 'REPORT' && j.reason === 'infra-exhausted');
      rec.check('free-storm/100%: all tasks park infra-exhausted (the DISTINCT quarantine — never poison)',
        quarantined === 6 && d.state.stats.done === 0 && exRecords.length === 6,
        `quarantined=${quarantined} done=${d.state.stats.done} exRecords=${exRecords.length}`);
      rec.check('free-storm/100%: the quarantine detail is the DISTINCT infra-exhausted reason',
        exRecords.every(j => /infra-exhausted/.test(String(j.reason || ''))),
        `reasons=${[...new Set(exRecords.map(j => j.reason))].join('|')}`);
      rec.check('free-storm/100%: per-turn lane_attempts bounded at 3',
        maxRelands === INFRA_RETRY_MAX,
        `maxRelands/task=${maxRelands} (=== INFRA_RETRY_MAX ${INFRA_RETRY_MAX} — the W3 bound)`);
      rec.metric('free100_quarantined', quarantined);
      rec.metric('free100_max_relands_per_task', maxRelands);
      rec.metric('free100_total_relands', relandArr.reduce((a, b) => a + b, 0));
    }

    // --- (B3) the ALL-DEAD CC pool through the FSM ladder (the A-lane of ---
    // the design's original spec): 3 turns × 3 hops of 401 → infra-exhausted.
    {
      const clock = makeClock();
      const LANE_ATTEMPTS = 3;
      const env = { OPENROUTER_API_KEY: 'k1', OPENROUTER_API_KEY_2: 'k2', CC_MODEL: '' };
      const lanes = ccLanes(env);
      const state = genesis({
        config: { max_parallel: 6, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
        project: { tasks: Array.from({ length: 6 }, (_, i) => ({ id: `AC-${i + 1}`, title: 'cc', behavior: 'real', work_ms: 100, deps: [] })), milestones: 1 },
        chainId: 'cc-all-dead', now: clock.now(),
      });
      let s = state;
      const journalAll = [];
      const now = () => { clock.advance(1); return clock.now(); };
      for (let turn = 1; turn <= 4; turn++) {
        const queue = Object.values(s.tasks).filter(t => t.status === 'assigned' && t.lease).map((t, i) => {
          // the all-dead walk: 3 hops, all 401, key-jump can't help (no live key)
          let idx = 0;
          const touched = [];
          for (let hop = 0; hop < LANE_ATTEMPTS; hop++) {
            touched.push(lanes[idx].keyIndex);
            idx = ccNextLaneIndex(lanes, idx, true);
            if (idx >= lanes.length) idx = lanes.length - 1;
          }
          return {
            event_id: `rep-ac${turn}-${t.id}-${i}`, task: t.id, lease: t.lease.token,
            outcome: { status: 'infra_failed', error: `openrouter-401 all-lanes-dead (k${[...new Set(touched)].join(',k')} hops=${LANE_ATTEMPTS})` },
            run_id: `ac-${turn}-${i}`,
          };
        });
        const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason: `ac-turn${turn}`, seq: turn } }, { now });
        const out = conductorTick({
          cur: s, queue, controlQueue: [], queueBad: [], ctlBad: [], intakeQueue: [], intakeBad: [],
          ev, now, nextMilestone: () => null, recover: () => null, makeGenesis: () => { throw new Error('no genesis expected'); },
        });
        s = out.state;
        journalAll.push(...(out.journal || []));
      }
      const quarantined = Object.values(s.tasks).filter(t => t.status === 'quarantined').length;
      const exRecords = journalAll.filter(j => j.kind === 'REPORT' && j.reason === 'infra-exhausted');
      rec.check('cc-storm/100%: all tasks park infra-exhausted after the 3-bound ladder',
        quarantined === 6 && exRecords.length === 6,
        `quarantined=${quarantined} exRecords=${exRecords.length} turns=4`);
      rec.check('cc-storm/100%: per-task infra_attempts === INFRA_RETRY_MAX (bounded)',
        Object.values(s.tasks).every(t => (t.infra_attempts ?? 0) === INFRA_RETRY_MAX),
        `infraAttempts=${[...new Set(Object.values(s.tasks).map(t => t.infra_attempts))].join(',')}`);
      rec.metric('cc100_quarantined', quarantined);
    }
  }

  return rec;
}
