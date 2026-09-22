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
import { breakerDecision } from '../../lib/watchdog-core.mjs';
import { mulberry32, makeClock, setupRepo, Recorder, T0, MIN, HOUR, DAY } from '../lib/common.mjs';
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

// SKELETON (s22-stress2, commit 1 of 3): fixtures + the run() wiring land
// here; the driver + assertions follow in the next commits. A half-built
// battery on the branch is recoverable; an uncommitted buffer is not.

// ---------------------------------------------------------------------------
// the battery
// ---------------------------------------------------------------------------
export async function run({ quick, seed } = {}) {
  const rec = new Recorder('soak30d');
  const days = quick ? 7 : 30;
  const tasks = quick ? 12 : 16;
  const holdMs = quick ? 36 * HOUR : 5 * DAY;
  rec.note(`skeleton: ${days} virtual days / ${tasks} tasks / ${(holdMs / DAY).toFixed(1)}d hold — the driver lands next commit (seed ${seed})`);
  return rec;
}
