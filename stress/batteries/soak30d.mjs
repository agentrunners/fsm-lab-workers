// stress/batteries/soak30d.mjs — BATTERY 5: the 30-virtual-day SOAK (a6 §6.1
// item 5; brief s22-stress2). One epoch with SLOW tasks, the chain HELD for
// days mid-epoch, drain to halt — then the repo sits parked (the live
// between-epochs shape) while the three watch planes run the WHOLE span:
//   * the PINGER plane — markers at the MEASURED 2-4h cadence (a seeded gap
//     sequence sampled from [120min, 247min], the live journal-15/16 band:
//     e2556–e2561 on 09-20 measured 2h00m–4h07m gaps at the nominal */15
//     cron — the a3 live datum, NOT the nominal 15min), through the real
//     conductorTick wake path on the live chain (applied TICK/actor-pinger
//     records — the duty's dual-arm source) and the real W-C3 held-chain
//     mint (audit-only `tick-pinger-<ms>` markers) while parked;
//   * the WATCHDOG SCAN plane — every 10min-virtual (the nominal cron
//     3,13,…,53 cadence): the REAL breakerDecision latch predicate against
//     the chain's last_tick + the modeled re-prime run ledger (a re-prime
//     dispatch lands ~2min later — the live conductor-run latency — and the
//     tick re-arms the latch; healthy-but-slow NEVER latches because every
//     re-prime lands below the next last_tick);
//   * the DUTY plane (watch-the-watcher) — every 30min-virtual (the executor
//     scheduler's cycle cadence): the REAL watchTheWatcherVerdict +
//     watchdogDeadmanVerdict against the note streams.
//
// THE HEADLINE METRIC (A-1 + R2-1, the before/after the audits demanded):
// the false-alarm count at the CURRENT calibrated windows — imported from
// lib/pinger-watch.mjs, NEVER hardcoded (pinger PINGER_STALE_AFTER_MIN,
// deadman WATCHDOG_STALE_AFTER_MIN) — against the measured cadence is ZERO;
// the counterfactual at the OLD windows (45min pinger / 180min deadman,
// both nominal-cadence arithmetic) fires N>0 false alarms over the span.
// The deadman's marker stream models the same measured sparsity band as the
// pinger's (the R2-1 claim: GHA schedule sparsity is a property of the
// repo's cron CLASS — the only live-measured band for that class is the
// pinger's; nominal ~1/hour markers are what 180min was calibrated to).
//
// Asserts (the a6 §6.1 item-5 contract + the brief):
//   * state.json bytes bounded (<25KB hard ceiling; the MEASURED number
//     pinned with headroom — the prune-at-20-ticks compaction + the
//     dedup-window cap hold over a 30-day span);
//   * ZERO false watchdog latches — the stall predicate (breakerDecision)
//     never fires on healthy-but-slow: the scan plane runs the whole span,
//     re-primes fire and land, and the only LATCH is the deliberate
//     sabotage window's TRUE latch (asserted to fire — the assert-is-honest
//     discipline) which the manual-tick re-arm then releases;
//   * GC cadence honored — the journal rotation schedule (rotateAt=500,
//     keepGens=4): retained generations pruned to keepGens, rotations
//     proportional to the journaled volume, retained bytes bounded, and the
//     state-side task pruning fires (PRUNE records in the journal);
//   * the deadman throttle mechanics — the REAL journalDeadmanMarker in a
//     bounded nominal-cadence micro-lane: first scan journals, subsequent
//     scans inside WATCHDOG_MARKER_MIN (55min) throttle, expiry journals
//     again;
//   * the DEAD-PINGER true-alarm control — the pinger stream stops for 6h
//     in the parked tail (a true X-class silence): the duty verdict goes
//     stale at the CURRENT window (caught same-day) and ZERO stale
//     verdicts fire outside it.
//
// Honesty notes (the compressed-cadence model, stated):
//   * the conductor's 10-min self-tick cron is COMPRESSED into the epoch's
//     real event commits (drain/assign/pinger/control ticks — one commit
//     per real event, not per cron slot); the liveness planes (pinger,
//     markers, duty verdicts) run at their FULL virtual cadences. The
//     re-prime tick landings are MODEL-side arithmetic (last_tick advances
//     at the landing instant; the store catches up at the next real event
//     commit) — the journal-flood discipline: the LOADING is the model,
//     the drains/verdicts are real. Re-prime TICK records are counted,
//     not journal-loaded (no assert needs them; the volume lane is carried
//     by the markers + epoch records).
//   * the deadman marker VOLUME rides batched journal commits (every 6h
//     virtual) — the marker records are byte-shaped exactly as the real
//     journalDeadmanMarker mints them (audit-only, applied:false,
//     watchdog-scan-<ms>); the real mint+throttle is proven live in the
//     micro-lane. The final flush lands the newest marker on the branch —
//     the discovery assert reads it back through the REAL tail reader.
//   * quick = 7 virtual days / 12 tasks / 36h hold; full = 30 days / 16
//     tasks / 5-day hold (the brief's mid-epoch pause→hold→resume at both
//     scales). All virtual clock; the only real wall cost is the git
//     plumbing (~150 commits quick / ~560 full).
//
// Metrics: the false-alarm counts (current vs old windows — the headline),
// state.json bytes, journal retained bytes/gens/rotations, records total,
// markers/pinger-wakes/re-primes/duty-scans per phase, the latch tallies.

import { Store } from '../../lib/store.mjs';
import { genesis } from '../../lib/fsm.mjs';
import { conductorTick } from '../../lib/conductor-core.mjs';
import { buildEvent, PINGER_REASON } from '../../lib/event-ingest.mjs';
import {
  PINGER_STALE_AFTER_MIN, WATCHDOG_STALE_AFTER_MIN,
  watchTheWatcherVerdict, watchdogDeadmanVerdict,
  newestPingerJournalNote, newestWatchdogJournalNote,
} from '../../lib/pinger-watch.mjs';
import { journalDeadmanMarker, WATCHDOG_MARKER_MIN_DEFAULT } from '../../watchdog/scan.mjs';
import { breakerDecision, LATCH_REPRIMES } from '../../lib/watchdog-core.mjs';
import { mulberry32, makeClock, setupRepo, Recorder, T0, MIN, HOUR, DAY, iso } from '../lib/common.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// the MEASURED band (live fsm-state journal-15/16, 09-20: gaps 2h00m–4h07m)
export const MEASURED_GAP_MIN = [120, 247];
// the OLD windows (the counterfactual pair — A-1's and R2-1's before-shape)
export const OLD_PINGER_WINDOW_MIN = 45;
export const OLD_DEADMAN_WINDOW_MIN = 180;

const SCAN_MIN = 10;        // the nominal watchdog scan cadence (cron 3,13,…,53)
const DUTY_MIN = 30;        // the executor duty's cycle cadence
const FLUSH_MIN = 360;      // the marker-volume batch cadence (virtual)
const REPRIME_LAND_MS = 2 * MIN;   // the conductor-run latency: dispatch -> applied tick
const LEASE_MIN = 120;      // the lease covers work + drain (healthy-but-slow, no churn)
const WORK_MIN = [30, 100]; // slow tasks (the 9-min-grind era's long tail, scaled)
const MAX_PARALLEL = 4;

// the scan-plane model knobs (documented, not exported — they parameterize
// THIS battery's model of the watchdog's live wiring):
const SCAN_STALE_MIN = 4;        // the deployed STALE_AFTER_MIN (watchdog.yml:38) — the chain-staleness gate that arms the re-prime/latch path
const STALL_DELAY_MIN = 10;      // the sabotage stall starts 10min after the cold start (the epoch's first live gap)
const STALL_LEN_MIN = 80;       // [T0+10, T0+90]: 3 stalled re-primes -> the TRUE latch at ~T0+40 -> the operator's manual re-arm
const SILENCE_BEFORE_END = 12 * HOUR;  // the dead-pinger stop lands 12h before T_end
const SILENCE_LEN = 6 * HOUR;          // the true X-class silence window (the current window catches it same-day)
const RUN_LEDGER_KEEP = 60;      // the modeled runs window handed to breakerDecision (the newest 3 is all it reads)
const ROTATE_AT = 500;          // the journal rotation schedule (the a6 contract)
const KEEP_GENS = 4;
const STATE_BYTES_PIN = 18_000; // the measured state.json ceiling + headroom (the s23 4-seed band 16.5-17.2KB + ~5% headroom; pinned below the 25KB contract bound)

// ---------------------------------------------------------------------------
// helpers — the soak driver's plumbing (the journal-flood discipline: the
// queue/CAS/rotation paths are the REAL Store; the liveness planes are the
// model, the drains/verdicts are real)
// ---------------------------------------------------------------------------

// N report lines in ONE plumbing push (the worker's queue enqueue, verbatim
// from journal-flood — the drain that follows is the real conductorTick).
function queuePush(store, records) {
  store.fetch();
  const head = store.headSha();
  const { items, bad } = store.readQueueEx();
  const dir = mkdtempSync(join(tmpdir(), 'soak-q-'));
  try {
    const merged = [...bad.map(String), ...items.map(l => JSON.stringify(l)), ...records.map(r => JSON.stringify(r))];
    writeFileSync(join(dir, 'queue.jsonl'), merged.join('\n') + '\n');
    const commit = store.buildCommit(
      [[join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']], [], head,
      `report-queue +${records.length} (soak worker)`);
    const push = store.git(['push', store.remote, `${commit}:${store.pushRef}`], { acceptCodes: [1, 128] });
    if (push.status !== 0) throw new Error(`soak queuePush: CAS push failed (rc=${push.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// one REAL conductor turn (verbatim from journal-flood — the drain consumes
// the queue, the wake applies or is held, rotation runs inside store.commit).
function tick(store, clock, ev) {
  const now = () => { clock.advance(1); return clock.now(); };
  return store.commit({
    mutate: (cur, queue, cq, qb, cb, iq, ib) => conductorTick({
      cur, queue, controlQueue: cq, queueBad: qb, ctlBad: cb, intakeQueue: iq, intakeBad: ib,
      ev, now, nextMilestone: () => null, recover: () => null,
      makeGenesis: () => { throw new Error('soak: no genesis expected'); },
    }),
  });
}

// retained journal bytes + gen census on the branch (verbatim from
// journal-flood — the bounded-growth curve).
function journalCensus(store) {
  const files = store.listStateFiles()
    .map(f => f.match(/^state\/journal-(\d+)\.jsonl$/))
    .filter(Boolean)
    .map(m => ({ gen: parseInt(m[1], 10), path: `state/journal-${m[1]}.jsonl` }))
    .sort((a, b) => a.gen - b.gen);
  let bytes = 0;
  const perGen = [];
  for (const f of files) {
    const r = store.git(['cat-file', '-s', `${store.remoteRef}:${f.path}`], { acceptCodes: [128] });
    const b = r.status === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0;
    bytes += b;
    perGen.push({ gen: f.gen, bytes: b });
  }
  return { gens: files.map(f => f.gen), bytes, perGen };
}

// the deadman marker VOLUME lane: markers byte-shaped EXACTLY as the real
// journalDeadmanMarker mints them (audit-only, applied:false,
// watchdog-scan-<ms>), riding ONE batched commit per FLUSH_MIN of virtual
// time — the header's honesty note. The ts is the marker's SCHEDULED scan
// instant (the heartbeat time the duty reads), not the flush instant. The
// real mint+throttle is proven live in the micro-lane below.
function deadmanBatch(store, markerMs) {
  return store.commit({
    mutate: (cur) => {
      if (!cur || typeof cur !== 'object' || cur.chain == null) {
        return { noop: true, reason: 'soak-no-state' };
      }
      const seqBase = Number.isInteger(cur.journal_seq) ? cur.journal_seq : 0;
      let seq = seqBase;
      const stamped = markerMs.map((ms) => ({
        id: `e${seq++}`, ts: new Date(ms).toISOString(), applied: false,
        kind: 'TICK', actor: 'watchdog', event_id: `watchdog-scan-${ms}`,
        note: 'watchdog-scan (audit-only deadman marker — the scan completed; no state change, no seq bump)',
      }));
      const state = structuredClone(cur);
      state.journal_seq = seq;
      return { state, journal: stamped };
    },
  });
}

// ---------------------------------------------------------------------------
// LANE 1 — the soak span: one epoch (slow tasks) + the mid-epoch HOLD + the
// drain-to-halt + the parked tail, with the three watch planes running the
// WHOLE span at their full virtual cadences.
//
// Real vs model (the header's honesty notes, restated at the seams):
//   REAL  — every conductor turn (cold start / pinger wakes / report drains /
//           pause / resume / the manual re-arm), the report-queue pushes, the
//           journal rotation, the deadman marker batches (Store.commit), the
//           discovery reads (readJournalTail + the real newest* predicates),
//           and every verdict/latch predicate call.
//   MODEL — the re-prime run ledger + landings (last_tick advances at the
//           landing instant; the store catches up at the next real event
//           commit — re-prime TICK records are counted, never journaled),
//           the deadman marker INSTANTS (the measured sparsity band; the
//           volume rides the 6h batched flushes), and the duty-plane note
//           streams (the ledger of every marker the span minted — the REAL
//           reader equivalence is asserted at every checkpoint + the final
//           flush).
// ---------------------------------------------------------------------------
function theSoak(rec, seed, { days, tasks: nTasks, holdMs, quick }) {
  const lab = setupRepo('soak30d-');
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone, rotateAt: ROTATE_AT, keepGens: KEEP_GENS });
    const rng = mulberry32(seed);
    const gapMs = () => {
      const m = MEASURED_GAP_MIN[0] + Math.floor(rng() * (MEASURED_GAP_MIN[1] - MEASURED_GAP_MIN[0] + 1));
      return m * MIN;   // the MEASURED band, inclusive both ends
    };

    // ---- the fixtures ----------------------------------------------------
    const tasks = Array.from({ length: nTasks }, (_, i) => ({
      id: `S-${String(i + 1).padStart(2, '0')}`, title: `soak ${i + 1}`,
      behavior: 'succeed',
      work_ms: WORK_MIN[0] * MIN + Math.floor(rng() * (WORK_MIN[1] - WORK_MIN[0] + 1) * MIN),
      deps: [],
    }));
    const workMs = Object.fromEntries(tasks.map(t => [t.id, t.work_ms]));
    const half = Math.ceil(nTasks / 2);
    // prune_tasks_after_ticks at the schema FLOOR (5): the compressed cadence
    // (one commit per real event) yields only ~2 dozen observed ticks over
    // the whole span, so the default 20-tick window would fire only at the
    // span's very edge (a flaky pin). The floor pins the COMPACTION MECHANISM
    // — PRUNE records present, stubs replacing full records, the bytes bound
    // holding with the terminal set actually compacted — robustly at BOTH
    // scales; the 20-tick default arithmetic is unit-pinned in tests/.
    const g = genesis({
      config: {
        max_parallel: MAX_PARALLEL, lease_minutes: LEASE_MIN, max_attempts: 3,
        tick_min_interval_s: 0, dedup_window: 300, prune_tasks_after_ticks: 5,
      },
      project: { tasks, milestones: 1 }, chainId: `soak-${seed}`, now: clock.now(),
    });
    store.init(g);

    // ---- the span's schedule (all virtual, all seeded) --------------------
    const endMs = T0 + days * DAY;
    const stallStartMs = T0 + STALL_DELAY_MIN * MIN;                 // the sabotage stall
    const stallEndMs = stallStartMs + STALL_LEN_MIN * MIN;           // the manual-tick re-arm
    const pingerStopMs = endMs - SILENCE_BEFORE_END;                 // the dead-pinger control
    const pingerResumeMs = pingerStopMs + SILENCE_LEN;
    const stalled = (t) => t >= stallStartMs && t < stallEndMs;      // the conductor is stalled (ticks do not apply)
    const pingerDead = (t) => t >= pingerStopMs && t < pingerResumeMs; // wake-skipping: a scheduled wake AT the resume instant lands (the restart ping)
    // duty attribution: the pinger arm's true-silence window is CLOSED at the
    // resume end — the restart marker commits at the resume instant + the
    // commit's ms-ε, so the duty slot AT the boundary legitimately races it
    // (the verdict is still the silence's; the NEXT slot reads the marker fresh)
    const inTrueIncident = (t) => stalled(t) || (t >= pingerStopMs && t <= pingerResumeMs);  // the TRUE-incident windows (excluded from every FALSE count)

    // the pinger plane: wake instants at the MEASURED gap band, seeded. The
    // forced resume instant (the pinger restarts and fires immediately) is
    // spliced into the schedule; wakes inside the sabotage stall (the
    // conductor is dead — a dispatched wake journals nothing) and inside the
    // dead-pinger silence are SKIPPED.
    const pingerWakeMs = [];
    for (let t = T0; (t += gapMs()) < endMs;) pingerWakeMs.push(t);
    pingerWakeMs.push(pingerResumeMs);
    pingerWakeMs.sort((a, b) => a - b);

    // the deadman plane: the watchdog-scan marker instants model the SAME
    // measured sparsity band (the R2-1 claim — GHA schedule sparsity is a
    // property of the cron class; nominal ~1/hour markers are what the old
    // 180min window was calibrated to). First marker at the epoch start.
    const deadmanMs = [T0];
    for (let t = T0; (t += gapMs()) < endMs;) deadmanMs.push(t);

    // ---- the driver state --------------------------------------------------
    const allRecords = [];          // every journal record ever committed, in order
    const collect = (out) => { if (out?.committed) allRecords.push(...(out.journal || [])); };
    const leaseBy = {};
    const inflight = [];            // {task, attempt, completeMs}
    const pingerLedger = [];        // ms of every pinger note that LANDED on the journal
    const appliedPingerTicks = [];
    const auditPingerMarkers = [];
    const deadmanLedger = deadmanMs.slice();
    const pendingDeadman = [];
    const runLedger = [];           // the modeled watchdog-reprime runs (newest last)
    const pendingLandings = [];     // re-prime landings not yet processed
    let phase = 'head';             // head -> hold -> drain -> parked
    let manualArmed = false;        // the sabotage's manual-tick re-arm fires once, at stallEnd
    const phaseAt = { head: T0, hold: null, drain: null, parked: null };
    let pausedNow = false, haltedNow = false, doneCount = 0;
    let modelLastTickMs = T0, modelSeq = 0;
    let nextFlushMs = T0 + FLUSH_MIN * MIN;
    let nextScanMs = T0 + SCAN_MIN * MIN;
    let resumeAtMs = null;
    let pIdx = 0, dIdx = 0;
    let flushedThroughMs = null, flushCount = 0, checkpointMismatches = 0, checkpointCount = 0;
    let latchEngagements = 0, latchFiredAtMs = null, latchReleasedAtMs = null, latchedPrev = false;
    let latchedScans = 0, latchedScansOutsideStall = 0;
    let reprimesDispatched = 0, reprimeLandingsApplied = 0, heldExits = 0, scanTotal = 0;
    let pingerSkipped = 0, completionsQueued = 0, drainTicks = 0;
    const phaseWakes = { head: 0, hold: 0, drain: 0, parked: 0 };
    let pauseRec = null, resumeRec = null;

    const rebuildInflight = (st) => {
      inflight.length = 0;
      for (const t of Object.values(st.tasks || {})) {
        if ((t.status === 'assigned' || t.status === 'in_progress') && t.lease) {
          inflight.push({
            task: t.id, attempt: t.attempts,
            completeMs: Date.parse(t.lease.issued_at) + (workMs[t.id] ?? 0),
          });
        }
      }
    };

    const postTick = (out, tMs) => {
      if (!out?.committed || !out.state) return;
      const st = out.state;
      doneCount = st.stats?.done ?? doneCount;
      pausedNow = !!st.chain?.paused;
      modelLastTickMs = Math.max(modelLastTickMs, Date.parse(st.chain?.last_tick || '') || tMs);
      modelSeq = st.chain?.seq ?? modelSeq;
      if (st.chain?.halted && !haltedNow) {
        haltedNow = true;
        phase = 'parked'; phaseAt.parked = tMs;
      }
      if (pausedNow && phase === 'head') {
        phase = 'hold'; phaseAt.hold = tMs;
        resumeAtMs = tMs + holdMs;
        pauseRec = (out.journal || []).find(j => j.kind === 'CONTROL' && j.command === 'pause') || pauseRec;
      }
      for (const j of out.journal || []) {
        if (j.kind === 'ASSIGN') leaseBy[j.task] = j.lease;
        if (j.kind === 'CONTROL' && j.command === 'resume') resumeRec = j;
      }
      rebuildInflight(st);
    };

    const drainTick = (tMs, reason) => {
      clock.advanceTo(tMs);
      const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason } }, { now: () => clock.now() });
      const out = tick(store, clock, ev);
      collect(out);
      drainTicks += 1;
      postTick(out, tMs);
      // the mid-epoch HOLD: the operator pauses as soon as half the tasks are done
      if (phase === 'head' && doneCount >= half) {
        clock.advanceTo(tMs);
        const pev = buildEvent({ action: 'fsm-control', client_payload: { command: 'pause' } }, { now: () => clock.now() });
        const pout = tick(store, clock, pev);
        collect(pout);
        postTick(pout, tMs);
      }
      return out;
    };

    const controlTick = (tMs, command) => {
      clock.advanceTo(tMs);
      const ev = buildEvent({ action: 'fsm-control', client_payload: { command } }, { now: () => clock.now() });
      const out = tick(store, clock, ev);
      collect(out);
      postTick(out, tMs);
      return out;
    };

    // the pinger wake: on the LIVE chain it applies (a TICK/actor-pinger
    // record — the duty's ACTOR arm); on a HELD chain conductorTick mints the
    // W-C3 audit-only marker (the EVENT_ID arm). Both are pinger notes.
    const doPingerWake = (tMs) => {
      clock.advanceTo(tMs);
      const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason: PINGER_REASON } }, { now: () => clock.now() });
      const out = tick(store, clock, ev);
      collect(out);
      const note = (out.journal || []).find(j => j.kind === 'TICK' && j.actor === PINGER_REASON);
      if (note) {
        pingerLedger.push(Date.parse(note.ts));
        if (note.applied) appliedPingerTicks.push(note); else auditPingerMarkers.push(note);
      }
      postTick(out, tMs);
      phaseWakes[phase] = (phaseWakes[phase] || 0) + 1;
    };

    // the discovery checkpoint: the REAL tail reader must agree with the
    // ledger (the pinger note commits at its instant; the deadman markers are
    // on-branch up to the last flush).
    const checkpointDiscovery = (tMs) => {
      checkpointCount += 1;
      const tail = store.readJournalTail(64);
      const np = newestPingerJournalNote(tail);
      const nw = newestWatchdogJournalNote(tail);
      const expectP = pingerLedger.length ? pingerLedger[pingerLedger.length - 1] : null;
      let expectW = null;
      for (const ms of deadmanLedger) { if (ms <= flushedThroughMs) expectW = ms; }
      const okP = np != null && expectP != null && Date.parse(np.ts) === expectP;
      const okW = nw != null && expectW != null && Date.parse(nw.ts) === expectW;
      if (!okP || !okW) {
        checkpointMismatches += 1;
        rec.note(`discovery mismatch at ${iso(tMs)}: pinger=${np?.ts} (expect ${expectP != null ? iso(expectP) : 'none'}), watchdog=${nw?.ts} (expect ${expectW != null ? iso(expectW) : 'none'})`);
      }
    };

    // ---- the COLD START: the epoch's first event is a pinger wake (the
    // chain's first liveness note + the first ASSIGN batch) -----------------
    doPingerWake(T0);

    // ---- the span's event loop --------------------------------------------
    while (clock.ms < endMs) {
      let nextCompleteMs = Infinity, nextCompletion = null;
      for (const c of inflight) {
        if (c.completeMs < nextCompleteMs) { nextCompleteMs = c.completeMs; nextCompletion = c; }
      }
      const cands = [];
      if (resumeAtMs != null) cands.push([resumeAtMs, -2, 'resume']);
      if (!manualArmed && stallEndMs > clock.ms && stallEndMs <= endMs) cands.push([stallEndMs, -1, 'manual']);
      if (nextCompletion && nextCompleteMs < endMs) cands.push([nextCompleteMs, -0.5, 'complete']);
      if (pIdx < pingerWakeMs.length && pingerWakeMs[pIdx] < endMs) cands.push([pingerWakeMs[pIdx], 0, 'pinger']);
      if (dIdx < deadmanMs.length && deadmanMs[dIdx] < endMs) cands.push([deadmanMs[dIdx], 1, 'deadman']);
      cands.push([nextFlushMs, 2, 'flush']);
      cands.push([nextScanMs, 3, 'scan']);
      if (!cands.length) break;
      cands.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      const [tMs, , kind] = cands[0];
      if (tMs >= endMs) break;
      clock.advanceTo(tMs);

      if (kind === 'resume') {
        controlTick(tMs, 'resume');
        resumeAtMs = null;
        if (phase === 'hold') { phase = 'drain'; phaseAt.drain = tMs; }
      } else if (kind === 'manual') {
        manualArmed = true;
        drainTick(tMs, 'manual');
      } else if (kind === 'complete') {
        inflight.splice(inflight.indexOf(nextCompletion), 1);
        completionsQueued += 1;
        queuePush(store, [{
          event_id: `rep-${nextCompletion.task}-a${nextCompletion.attempt}`,
          task: nextCompletion.task, lease: leaseBy[nextCompletion.task],
          outcome: { status: 'done', artifact: `artifact:${nextCompletion.task}` },
          run_id: `run-${nextCompletion.task}-${nextCompletion.attempt}`,
        }]);
        // a stalled or held conductor drains nothing at the completion
        // instant — the queued report waits for the next real tick (the
        // manual re-arm, or the next pinger wake's at-least-once drain)
        if (!stalled(tMs) && !pausedNow && !haltedNow) {
          drainTick(tMs, `drain-${nextCompletion.task}`);
        }
      } else if (kind === 'pinger') {
        const wt = pingerWakeMs[pIdx++];
        if (stalled(wt) || pingerDead(wt)) { pingerSkipped += 1; } else { doPingerWake(wt); }
      } else if (kind === 'deadman') {
        pendingDeadman.push(deadmanMs[dIdx++]);
      } else if (kind === 'flush') {
        nextFlushMs = tMs + FLUSH_MIN * MIN;
        if (pendingDeadman.length) {
          collect(deadmanBatch(store, pendingDeadman.splice(0)));
          flushedThroughMs = tMs;
          flushCount += 1;
          if (flushCount % 4 === 0) checkpointDiscovery(tMs);
        }
      } else if (kind === 'scan') {
        nextScanMs = tMs + SCAN_MIN * MIN;
        scanTotal += 1;
        // the re-prime landings due at/before this scan (MODEL-side
        // arithmetic: the landing applies a tick when the conductor is healthy)
        for (let i = pendingLandings.length - 1; i >= 0; i--) {
          const l = pendingLandings[i];
          if (l <= tMs) {
            pendingLandings.splice(i, 1);
            if (!stalled(l) && !pausedNow && !haltedNow) {
              modelLastTickMs = Math.max(modelLastTickMs, l);
              modelSeq += 1;
              reprimeLandingsApplied += 1;
            }
          }
        }
        // the real watchdog exits BEFORE staleness on a held chain (the
        // marker heartbeat fires before that exit — modeled by the marker
        // stream; here the latch plane just stands down)
        if (pausedNow || haltedNow) { heldExits += 1; continue; }
        // the REAL latch predicate — run at EVERY scan (the strongest
        // zero-false-latch pin: the predicate itself never fires outside the
        // sabotage, not merely "never alerts")
        const decision = breakerDecision({
          state: { chain: { last_tick: iso(modelLastTickMs), seq: modelSeq } },
          recentRuns: runLedger, nowMs: tMs,
        });
        if (decision.latched && !latchedPrev) { latchEngagements += 1; latchFiredAtMs = tMs; }
        if (!decision.latched && latchedPrev) { latchReleasedAtMs = tMs; }
        latchedPrev = decision.latched;
        if (decision.latched) {
          latchedScans += 1;
          if (!stalled(tMs)) latchedScansOutsideStall += 1;
        } else if (tMs - modelLastTickMs > SCAN_STALE_MIN * MIN) {
          // stale + not latched + nothing in flight -> re-prime (the eternal
          // healthy loop at the deployed 4min threshold — probe3's shape)
          runLedger.push({ name: 'watchdog-reprime · conductor', status: 'completed', created_at: iso(tMs) });
          pendingLandings.push(tMs + REPRIME_LAND_MS);
          reprimesDispatched += 1;
          if (runLedger.length > RUN_LEDGER_KEEP) runLedger.splice(0, runLedger.length - RUN_LEDGER_KEEP);
        }
      }
    }

    // ---- the FINAL FLUSH: the newest markers land on the branch -----------
    if (pendingDeadman.length) {
      collect(deadmanBatch(store, pendingDeadman.splice(0)));
      flushedThroughMs = endMs;
      flushCount += 1;
    }

    // ---- the duty plane (pure, full cadence): the REAL verdict predicates
    // against the span's note ledgers — current windows (imported) vs the OLD
    // counterfactual windows, per cadence ------------------------------------
    const countVerdicts = (cadMin) => {
      const out = {
        slots: 0, curPingerFalse: 0, curPingerTrue: 0, curDeadmanStale: 0,
        oldPingerFalse: 0, oldDeadmanFalse: 0, comments24h: 0,
        staleSlots: [], firstStaleMs: null,
      };
      let pi = 0, di = 0, lastCommentMs = -Infinity;
      for (let t = T0 + cadMin * MIN; t < endMs; t += cadMin * MIN) {
        while (pi < pingerLedger.length && pingerLedger[pi] <= t) pi += 1;
        while (di < deadmanLedger.length && deadmanLedger[di] <= t) di += 1;
        const pNote = pi > 0 ? { ts: iso(pingerLedger[pi - 1]), source: 'journal' } : null;
        const dNote = di > 0 ? { ts: iso(deadmanLedger[di - 1]), source: 'journal' } : null;
        const vCP = watchTheWatcherVerdict({ journalNote: pNote, nowMs: t, staleAfterMin: PINGER_STALE_AFTER_MIN });
        const vCD = watchdogDeadmanVerdict({ journalNote: dNote, nowMs: t, staleAfterMin: WATCHDOG_STALE_AFTER_MIN });
        const vOP = watchTheWatcherVerdict({ journalNote: pNote, nowMs: t, staleAfterMin: OLD_PINGER_WINDOW_MIN });
        const vOD = watchdogDeadmanVerdict({ journalNote: dNote, nowMs: t, staleAfterMin: OLD_DEADMAN_WINDOW_MIN });
        out.slots += 1;
        if (vCP.verdict === 'stale') {
          out.staleSlots.push(t);
          if (out.firstStaleMs == null) out.firstStaleMs = t;
          if (inTrueIncident(t)) out.curPingerTrue += 1; else out.curPingerFalse += 1;
          if (t - lastCommentMs > 24 * HOUR) { out.comments24h += 1; lastCommentMs = t; }
        }
        if (vCD.verdict === 'stale') out.curDeadmanStale += 1;
        if (vOP.verdict === 'stale' && !inTrueIncident(t)) out.oldPingerFalse += 1;
        if (vOD.verdict === 'stale') out.oldDeadmanFalse += 1;
      }
      return out;
    };

    const cadences = quick ? [DUTY_MIN] : [DUTY_MIN, 60, 120];
    const sweeps = cadences.map((c) => ({ cadMin: c, v: countVerdicts(c) }));
    const main = sweeps[0].v;
    const N = main.oldPingerFalse + main.oldDeadmanFalse;

    // ---- the assertions ----------------------------------------------------
    const finalState = store.readState().state;
    const census = journalCensus(store);
    const rotations = census.gens.length ? Math.max(...census.gens) - 1 : 0;
    const totalRecords = allRecords.length;
    const prunes = allRecords.filter(j => j.kind === 'PRUNE').length;
    const stateBytes = parseInt(
      store.git(['cat-file', '-s', `${store.remoteRef}:state/state.json`]).stdout.trim(), 10) || 0;
    const holdActualMs = (pauseRec && resumeRec) ? Date.parse(resumeRec.ts) - Date.parse(pauseRec.ts) : null;

    rec.check('soak: the epoch completed — every task done, phase=done, chain HALTED (drain-to-halt after the resume)',
      haltedNow && finalState?.project?.phase === 'done' && finalState?.stats?.done === nTasks,
      `done=${finalState?.stats?.done}/${nTasks} phase=${finalState?.project?.phase} halted=${haltedNow}`);

    rec.check(`soak: the hold HELD exactly ${(holdMs / DAY).toFixed(1)}d mid-epoch (pause->resume on the journal's CONTROL records)`,
      holdActualMs != null && Math.abs(holdActualMs - holdMs) < MIN,
      `pause=${pauseRec?.ts} resume=${resumeRec?.ts} held=${holdActualMs != null ? Math.round(holdActualMs / MIN) : '?'}min`);

    rec.check('soak: the pinger plane minted BOTH journal arms — applied TICK/actor-pinger records on the live chain AND audit-only tick-pinger-<ms> markers while held',
      appliedPingerTicks.length >= 1 && auditPingerMarkers.length >= 1
      && appliedPingerTicks.every(m => m.applied === true && m.actor === PINGER_REASON && /^tick-pinger-\d+$/.test(m.event_id || ''))
      && auditPingerMarkers.every(m => m.applied === false && /^tick-pinger-\d+$/.test(m.event_id || '')),
      `applied=${appliedPingerTicks.length} audit-only=${auditPingerMarkers.length} (wakes/head:${phaseWakes.head} hold:${phaseWakes.hold} drain:${phaseWakes.drain} parked:${phaseWakes.parked})`);

    // the state-bytes bound: the 25KB hard ceiling + the measured pin
    rec.check('soak: state.json bytes bounded under the 25KB hard ceiling (the compaction + the dedup-window cap over the span)',
      stateBytes > 0 && stateBytes < 25_000,
      `state.json=${stateBytes}B over ${days}d / ${totalRecords} journal records`);
    rec.check(`soak: state.json bytes pinned (measured + headroom <= ${STATE_BYTES_PIN}B)`,
      stateBytes <= STATE_BYTES_PIN,
      `measured=${stateBytes}B pin=${STATE_BYTES_PIN}B`);

    // the latch contract
    rec.check(`soak: ZERO false watchdog latches — the ONLY latch in ${scanTotal} scans is the sabotage's TRUE one (healthy-but-slow: every re-prime lands below the next last_tick)`,
      latchEngagements === 1 && latchedScansOutsideStall === 0 && reprimesDispatched > 0,
      `latchEngagements=${latchEngagements} latchedScans=${latchedScans} (all inside the stall) reprimes=${reprimesDispatched} landingsApplied=${reprimeLandingsApplied} heldExits=${heldExits}`);
    rec.check('soak: the TRUE latch FIRES inside the sabotage window (assert-is-honest — the stall, 3 re-primes, the engage)',
      latchFiredAtMs != null && stalled(latchFiredAtMs),
      `latched at ${iso(latchFiredAtMs)} (stall [${iso(stallStartMs)} .. ${iso(stallEndMs)}), ${LATCH_REPRIMES} re-primes after the frozen last_tick)`);
    rec.check('soak: the manual-tick re-arm RELEASES the latch (both directions proven)',
      latchReleasedAtMs != null && latchReleasedAtMs >= stallEndMs && (latchReleasedAtMs - stallEndMs) <= 2 * SCAN_MIN * MIN && latchEngagements === 1,
      `released at ${iso(latchReleasedAtMs)} (the first scan after the re-arm at ${iso(stallEndMs)})`);

    // the GC cadence contract
    rec.check('soak: GC cadence — retained generations pruned to keepGens=4 (the bounded retained window)',
      census.gens.length <= 4 && census.gens.length >= 1,
      `retainedGens=[${census.gens.join(',')}] keepGens=4`);
    const rotationsExpected = Math.max(0, Math.ceil((totalRecords - ROTATE_AT) / ROTATE_AT));
    rec.check('soak: GC cadence — rotations PROPORTIONAL to the journaled volume (rotateAt=500)',
      Math.abs(rotations - rotationsExpected) <= 1 && (quick || rotations >= 1),
      `rotations=${rotations} expected~${rotationsExpected} (records=${totalRecords})${quick ? ' (quick: sub-500 volume -> zero rotations is the proportional answer)' : ''}`);
    rec.check('soak: GC cadence — PRUNE records present (the state-side task compaction fired over the span)',
      prunes >= 1, `PRUNE records=${prunes}`);
    const maxRetainedBytes = KEEP_GENS * ROTATE_AT * 400;   // ~400B/record generous ceiling
    rec.check('soak: GC cadence — retained journal bytes BOUNDED (keepGens x rotateAt ceiling)',
      census.bytes <= maxRetainedBytes,
      `retainedBytes=${census.bytes}B bound=${maxRetainedBytes}B gens=[${census.gens.join(',')}]`);

    // THE HEADLINE (A-1 + R2-1 before/after)
    rec.check(`soak: THE HEADLINE — ZERO false alarms at the CURRENT windows (imported: pinger ${PINGER_STALE_AFTER_MIN}min / deadman ${WATCHDOG_STALE_AFTER_MIN}min) against the measured cadence`,
      main.curPingerFalse === 0 && main.curDeadmanStale === 0,
      `falsePinger=${main.curPingerFalse} falseDeadman=${main.curDeadmanStale} over ${main.slots} duty scans at ${DUTY_MIN}min`);
    rec.check(`soak: THE HEADLINE — the OLD windows (pinger ${OLD_PINGER_WINDOW_MIN}min / deadman ${OLD_DEADMAN_WINDOW_MIN}min) would have fired N=${N}>0 false alarms over the span`,
      N > 0,
      `N=${N} (oldPinger=${main.oldPingerFalse} + oldDeadman=${main.oldDeadmanFalse}); 24h-deduped comment-equivalents=${main.comments24h}`);
    rec.note(`HEADLINE (A-1/R2-1 before-after): current windows (pinger ${PINGER_STALE_AFTER_MIN}min, deadman ${WATCHDOG_STALE_AFTER_MIN}min — imported from lib/pinger-watch.mjs) => ${main.curPingerFalse + main.curDeadmanStale} false alarms over ${days} virtual days at the measured [${MEASURED_GAP_MIN[0]},${MEASURED_GAP_MIN[1]}]min cadence; the OLD windows (${OLD_PINGER_WINDOW_MIN}/${OLD_DEADMAN_WINDOW_MIN}min) => N=${N} false alarms (pinger ${main.oldPingerFalse}, deadman ${main.oldDeadmanFalse}) — the number the audits demanded`);

    // the dead-pinger control
    const firstStaleDelayMs = main.firstStaleMs != null ? main.firstStaleMs - pingerStopMs : null;
    rec.check('soak: the dead-pinger control — the TRUE alarm FIRES at the current window, caught same-day',
      main.curPingerTrue >= 1 && firstStaleDelayMs != null && firstStaleDelayMs > 0 && firstStaleDelayMs <= 24 * HOUR,
      `firstStale=${main.firstStaleMs != null ? iso(main.firstStaleMs) : 'never'} (delay ${firstStaleDelayMs != null ? Math.round(firstStaleDelayMs / MIN) : '?'}min after the stop; window=${PINGER_STALE_AFTER_MIN}min; true verdicts=${main.curPingerTrue})`);
    const inSilence = (t) => t >= pingerStopMs && t <= pingerResumeMs;   // CLOSED at the resume end — the restart marker commits at resume+ms-ε and races the boundary slot
    rec.check('soak: the dead-pinger control — ZERO stale pinger verdicts outside the 6h silence window',
      main.staleSlots.every((t) => inSilence(t)),
      `staleSlots=${main.staleSlots.length} all inside [${iso(pingerStopMs)} .. ${iso(pingerResumeMs)})`);

    // the discovery contract (the REAL tail reader)
    const tail = store.readJournalTail(64);
    const npFinal = newestPingerJournalNote(tail);
    const nwFinal = newestWatchdogJournalNote(tail);
    const expectPFinal = pingerLedger.length ? pingerLedger[pingerLedger.length - 1] : null;
    let expectWFinal = null;
    for (const ms of deadmanLedger) { if (ms <= endMs) expectWFinal = ms; }
    rec.check('soak: the final-flush discovery — the REAL tail reader finds the newest pinger AND watchdog markers on the branch',
      npFinal != null && expectPFinal != null && Date.parse(npFinal.ts) === expectPFinal
      && nwFinal != null && expectWFinal != null && Date.parse(nwFinal.ts) === expectWFinal,
      `newestPinger=${npFinal?.ts} newestWatchdog=${nwFinal?.ts}`);
    rec.check('soak: the mid-span discovery checkpoints — the REAL reader agreed with the ledger at every checkpoint',
      checkpointMismatches === 0 && checkpointCount >= (quick ? 3 : 10),
      `checkpoints=${checkpointCount} mismatches=${checkpointMismatches}`);

    // the duty-cadence sensitivity (full mode — the registry's advertised sweep)
    if (!quick) {
      rec.check('soak: duty-cadence sweep — the OLD windows fire at EVERY cadence (30/60/120min) while the current windows stay zero',
        sweeps.every(({ v }) => (v.oldPingerFalse + v.oldDeadmanFalse) > 0 && v.curPingerFalse === 0 && v.curDeadmanStale === 0),
        sweeps.map(({ cadMin, v }) => `${cadMin}min: N=${v.oldPingerFalse + v.oldDeadmanFalse} cur=0`).join(' | '));
      for (const { cadMin, v } of sweeps.slice(1)) {
        rec.metric(`old_window_false_alarms_cad${cadMin}min`, v.oldPingerFalse + v.oldDeadmanFalse);
        rec.metric(`old_window_pinger_false_cad${cadMin}min`, v.oldPingerFalse);
        rec.metric(`old_window_deadman_false_cad${cadMin}min`, v.oldDeadmanFalse);
      }
    }

    // ---- the metrics ---------------------------------------------------------
    rec.metric('virtual_days', days);
    rec.metric('span_end', iso(endMs));
    rec.metric('journal_records_total', totalRecords);
    rec.metric('journal_rotations', rotations);
    rec.metric('journal_retained_gens', census.gens.length);
    rec.metric('journal_retained_bytes', census.bytes);
    rec.metric('journal_retained_per_gen_bytes', census.perGen);
    rec.metric('state_json_bytes', stateBytes);
    rec.metric('prune_records', prunes);
    rec.metric('pinger_wakes_landed', pingerLedger.length);
    rec.metric('pinger_wakes_skipped_stall_or_silence', pingerSkipped);
    rec.metric('pinger_applied_ticks_live_chain', appliedPingerTicks.length);
    rec.metric('pinger_audit_markers_held_chain', auditPingerMarkers.length);
    rec.metric('deadman_markers_total', deadmanLedger.length);
    rec.metric('deadman_flushes', flushCount);
    rec.metric('watchdog_scans_total', scanTotal);
    rec.metric('watchdog_held_exits', heldExits);
    rec.metric('reprimes_dispatched', reprimesDispatched);
    rec.metric('reprime_landings_applied', reprimeLandingsApplied);
    rec.metric('latch_engagements', latchEngagements);
    rec.metric('latched_scans', latchedScans);
    rec.metric('duty_slots', main.slots);
    rec.metric('false_alarms_current_windows', main.curPingerFalse + main.curDeadmanStale);
    rec.metric('false_alarms_old_windows_N', N);
    rec.metric('old_window_pinger_false_45min', main.oldPingerFalse);
    rec.metric('old_window_deadman_false_180min', main.oldDeadmanFalse);
    rec.metric('old_window_comments_24h_dedup', main.comments24h);
    rec.metric('dead_pinger_true_verdicts', main.curPingerTrue);
    rec.metric('dead_pinger_detection_delay_min', firstStaleDelayMs != null ? Math.round(firstStaleDelayMs / MIN) : null);
    rec.metric('completions', completionsQueued);
    rec.metric('drain_ticks', drainTicks);
    rec.metric('phase_wakes', phaseWakes);
    rec.metric('phase_boundaries', Object.fromEntries(Object.entries(phaseAt).map(([k, v]) => [k, v != null ? iso(v) : null])));
    rec.metric('windows_imported', { pinger_stale_after_min: PINGER_STALE_AFTER_MIN, watchdog_stale_after_min: WATCHDOG_STALE_AFTER_MIN });

    return { finalState, census };
  } finally {
    lab.cleanup();
  }
}

// ---------------------------------------------------------------------------
// LANE 2 — the deadman throttle micro-lane: the REAL journalDeadmanMarker at
// a bounded nominal cadence (first scan journals, in-window scans throttle,
// expiry journals again) + the charter pin (the marker commit touches
// NOTHING but journal_seq).
// ---------------------------------------------------------------------------
function deadmanThrottleLane(rec, seed) {
  const lab = setupRepo('soak-throttle-');
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone });
    const g = genesis({
      config: { max_parallel: 1, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
      project: { tasks: [{ id: 'D-1', title: 'throttle', behavior: 'succeed', work_ms: 10, deps: [] }], milestones: 1 },
      chainId: `throttle-${seed}`, now: clock.now(),
    });
    store.init(g);

    const scanMin = [0, 20, 40, 56, 76];   // the bounded nominal cadence + the 55min expiry crossing
    const outcomes = [];
    let stateBefore = null;
    for (const m of scanMin) {
      clock.advanceTo(T0 + m * MIN);
      if (m === 56) stateBefore = store.readState().state;   // the charter snapshot: pre-journal
      const out = journalDeadmanMarker(store, { env: {}, log: () => {}, nowMs: () => clock.ms });
      outcomes.push(out.outcome);
    }
    const stateAfter = store.readState().state;

    rec.check(`throttle: the REAL journalDeadmanMarker — first scan journals, in-window scans throttle (WATCHDOG_MARKER_MIN=${WATCHDOG_MARKER_MIN_DEFAULT}min), expiry journals again`,
      outcomes.join(',') === 'journaled,throttled,throttled,journaled,throttled',
      `outcomes=[${outcomes.join(',')}] over scans at ${scanMin.join(',')}min`);

    const strip = (s) => { const c = structuredClone(s); delete c.journal_seq; return c; };
    rec.check('throttle: the charter pin — the marker commit touches NOTHING but journal_seq (the A-3 amendment: chain/tasks/stats/config identical)',
      stateBefore != null && stateAfter != null && JSON.stringify(strip(stateBefore)) === JSON.stringify(strip(stateAfter)),
      `journal_seq ${stateBefore?.journal_seq} -> ${stateAfter?.journal_seq}`);

    const newest = newestWatchdogJournalNote(store.readJournalTail(64, 'TICK'));
    rec.check('throttle: the marker discovery — newestWatchdogJournalNote(readJournalTail(64, TICK)) reads the newest marker',
      newest != null && Math.abs(Date.parse(newest.ts) - (T0 + 56 * MIN)) < 1000,
      `newest=${newest?.ts} (expected the 56min re-journal)`);
    rec.metric('throttle_outcomes', outcomes.join(','));
    rec.metric('throttle_marker_min_default', WATCHDOG_MARKER_MIN_DEFAULT);
  } finally {
    lab.cleanup();
  }
}

// ---------------------------------------------------------------------------
// the battery
// ---------------------------------------------------------------------------
export async function run({ quick, seed } = {}) {
  const rec = new Recorder('soak30d');
  const days = quick ? 7 : 30;
  const tasks = quick ? 12 : 16;
  const holdMs = quick ? 36 * HOUR : 5 * DAY;
  theSoak(rec, seed, { days, tasks, holdMs, quick });
  deadmanThrottleLane(rec, seed + 1);
  return rec;
}
