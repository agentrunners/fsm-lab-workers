// pinger-watch.mjs — the WATCH-THE-WATCHER duty's brains (T46/W-C3, X24).
//
// The DUTY itself lives on the EXECUTOR (claudecode-headless/
// cc-gha-public-executor scheduler.yml, wired into the duty roster): the
// executor is the de-correlated monitor plane — the watcher's compute must
// not share a failure domain with the watched (the pinger xfnwfpho1/pinger
// watches the chain; this duty watches the PINGER; the executor hosts the
// duty). The executor step is a DUMB DRIVER (bash + jq, the fsm-watchdog
// duty's pattern — foreign repo code NEVER runs on a PAT-holding runner);
// THIS module is the CANONICAL specification of what the driver mirrors:
//   1. what counts as a PINGER NOTE (the scan predicates below),
//   2. the 300-minute (5h) silence window (watchTheWatcherVerdict — s21/A-1
//      recalibrated: the live marker cadence measures 2h00m–4h07m gaps
//      (journal-15 e2556–e2561, 09-20), so the old 45min window fired
//      "pinger SILENT" on essentially every scan — a 24h-deduped noise
//      comment/day forever that trains operators to ignore the ONE X-class
//      detection signal; 5h sits safely above the measured max gap while
//      still catching a dead pinger same-day; PINGER_STALE_AFTER_MIN env
//      overrides it in the duty host's wiring — pingerStaleAfterMin(env)),
//   3. the ops-issue comment format (pingerWatchComment — the duty comment
//      lands on the fsm-lab ops anchor issue, visible NOT fatal: it reports
//      the PINGER's health, not the chain's — the chain may be alive and
//      self-ticking).
// Pure + offline: no API, no clock reads (nowMs is INJECTED), no I/O — the
// fixture-based pins in tests/test-pinger-watch.mjs bite the real code.
//
// The two note sources (both are "pinger notes" — the duty scans fsm-lab's
// journal AND runs):
//   JOURNAL — the X24 liveness markers: TICK records with actor 'pinger'
//     (the ACTIVE-chain tick record and the HELD-chain audit-only marker —
//     lib/conductor-core.mjs mints the latter precisely so this scan has a
//     durable, GC-surviving datum; the journal is the record, state is
//     compacted). Identified by kind TICK + actor pinger, or by the minted
//     event_id `tick-pinger-<ms>` (MINT_TABLE's shape — either arm matches).
//   RUNS — the conductor.yml runs named "pinger · conductor" (the run-name
//     template renders client_payload.reason; live: run 35206789111). The
//     secondary signal: covers the pre-marker deploy window and is the only
//     source when the journal tail has rotated past the markers.

import { PINGER_REASON } from './event-ingest.mjs';

// The minted marker's id shape (`tick-pinger-<ms>` — MINT_TABLE TICK).
export const PINGER_NOTE_EVENT_ID_RE = /^tick-pinger-\d+$/;

// conductor.yml's run-name renders the dispatch reason: "pinger · conductor".
export const PINGER_RUN_NAME_PREFIX = 'pinger ·';

// The silence window (§8, s21/A-1 recalibrated): no pinger note in 300min
// (5h) → duty comment. The 45min spec constant was calibrated to the NOMINAL
// */15 cron; the MEASURED live cadence (fsm-state journal-15, markers
// e2556–e2561 on 09-20: 09:50→13:57→17:21→19:38→21:50→23:51) gaps run
// 2h00m–4h07m — the design's own honesty note said "nominal 15min ≈
// effective 1-2h" (T46-WC-DESIGN.md §8; EVIDENCE.md X24) and the live datum
// is worse. 300min: above the measured max (4h07) with ~1h headroom, under
// the "catches a dead pinger same-day" bar. Env-overridable at the duty
// host (PINGER_STALE_AFTER_MIN — see pingerStaleAfterMin below).
export const PINGER_STALE_AFTER_MIN = 300;

// isPingerJournalNote(rec) — PURE. Tolerant two-arm predicate: the actor arm
// is the primary (both the active-chain TICK record and the held-chain
// audit-only marker carry actor 'pinger'); the event_id arm matches the
// minted marker shape even if a future record shape drifts the actor field.
// Legacy records (no event_id, other actors) never match either arm.
export function isPingerJournalNote(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.kind === 'TICK' && rec.actor === PINGER_REASON) return true;
  return typeof rec.event_id === 'string' && PINGER_NOTE_EVENT_ID_RE.test(rec.event_id);
}

// newestPingerJournalNote(records) — PURE. records: journal records in ANY
// order (the store's tail read is oldest→newest per gen, but ordering is the
// caller's affair — the newest MATCH wins regardless). Returns
// {ts, source:'journal'} | null. Unparseable/malformed entries are skipped
// (the bash driver's jq makes the same tolerance call — a bad line never
// blinds the scan).
export function newestPingerJournalNote(records) {
  let newest = null;
  for (const rec of Array.isArray(records) ? records : []) {
    if (!isPingerJournalNote(rec)) continue;
    const ms = Date.parse(rec.ts || '');
    if (!Number.isFinite(ms)) continue;
    if (!newest || ms > newest.ms) newest = { ms, ts: rec.ts, source: 'journal' };
  }
  return newest;
}

// newestPingerRunNote(runs) — PURE. runs: [{name, createdAt}] (the shape
// `gh run list --json name,createdAt` yields). Returns {ts, source:'runs'}
// | null — the newest run whose name starts "pinger ·" (the middle dot is
// the run-name template's separator; startswith, not contains — a task or
// branch named pinger-something must never count).
export function newestPingerRunNote(runs) {
  let newest = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    const name = typeof r?.name === 'string' ? r.name : '';
    if (!name.startsWith(PINGER_RUN_NAME_PREFIX)) continue;
    const ms = Date.parse(r.createdAt || '');
    if (!Number.isFinite(ms)) continue;
    if (!newest || ms > newest.ms) newest = { ms, ts: r.createdAt, source: 'runs' };
  }
  return newest;
}

// watchTheWatcherVerdict({journalNote, runNote, nowMs, staleAfterMin}) —
// PURE, the silence window (default 300min — s21/A-1). journalNote/runNote:
// the scan results above ({ts, source} | null — EITHER may be absent; the
// duty takes the NEWEST of what exists). nowMs is INJECTED (fixture-based
// pins; the driver passes $(date +%s)*1000). Verdict ladder:
//   fresh — the newest note is younger than the window (age < staleAfterMin)
//   stale — the newest note is at/older than the window (age >= staleAfterMin
//           — the fsm-watchdog duty's boundary convention: age < stale_after
//           is fresh), OR no note exists at all ("no pinger-note in the
//           window" is trivially true then; the pinger is expected to be
//           configured, silence is reportable).
export function watchTheWatcherVerdict({
  journalNote = null, runNote = null, nowMs, staleAfterMin = PINGER_STALE_AFTER_MIN,
} = {}) {
  const notes = [];
  for (const n of [journalNote, runNote]) {
    const ms = Date.parse(n?.ts || '');
    if (n && Number.isFinite(ms)) notes.push({ ms, ts: n.ts, source: n.source === 'runs' ? 'runs' : 'journal' });
  }
  if (!Number.isFinite(nowMs)) throw new Error('watchTheWatcherVerdict: nowMs must be a finite epoch-ms number (injected clock)');
  if (!Number.isFinite(staleAfterMin) || staleAfterMin <= 0) throw new Error('watchTheWatcherVerdict: staleAfterMin must be a positive number of minutes');
  if (!notes.length) return { verdict: 'stale', note: null, ageMin: null, reason: 'no-pinger-notes' };
  notes.sort((a, b) => b.ms - a.ms);
  const newest = notes[0];
  const ageMin = Math.max(0, Math.round((nowMs - newest.ms) / 60_000));
  const stale = ageMin >= staleAfterMin;
  return {
    verdict: stale ? 'stale' : 'fresh',
    note: { ts: newest.ts, source: newest.source },
    ageMin,
    reason: stale ? 'note-at-or-older-than-window' : 'note-within-window',
  };
}

// pingerStaleAfterMin(env) — PURE, the env-overridable window for the duty
// host's wiring (the executor driver / watchdog pass their environment
// through; the canonical default lives in PINGER_STALE_AFTER_MIN). Unset,
// unparseable, or non-positive values fall back to the calibrated constant —
// a bad env can never mint a zero/negative window (the verdict guard would
// throw on every scan) nor a NaN one (every note would read fresh).
export function pingerStaleAfterMin(env = {}) {
  const n = parseInt(env?.PINGER_STALE_AFTER_MIN, 10);
  return Number.isFinite(n) && n > 0 ? n : PINGER_STALE_AFTER_MIN;
}

// pingerWatchComment({repo, staleAfterMin, note, ageMin}) — PURE, the
// CANONICAL ops-issue comment body (the format pin). Flat two-paragraph
// shape, one interpolated line — the executor's bash driver mirrors this
// template byte-for-byte (scheduler.yml cites this module as canonical).
// Starts with the '**[pinger-watch]**' marker: the duty's 24h comment dedup
// scans the ops issue for that prefix (the exec-duty marker discipline —
// one comment per day while the pinger stays silent, never a 30-min spam
// lane; the scheduler's cycle cadence).
export function pingerWatchComment({
  repo, staleAfterMin = PINGER_STALE_AFTER_MIN, note = null, ageMin = null,
} = {}) {
  if (typeof repo !== 'string' || repo === '') throw new Error('pingerWatchComment: repo must be a non-empty slug');
  const newestLine = note
    ? `${note.ts} (age ${ageMin ?? '?'}min, source: ${note.source === 'runs' ? 'runs' : 'journal'})`
    : 'none found (no tick-pinger journal markers, no "pinger · conductor" runs in the scan window)';
  return [
    `**[pinger-watch]** pinger SILENT — no pinger note on ${repo} in ${staleAfterMin}min (newest: ${newestLine}).`,
    '',
    'Scanned: the fsm-state journal tail (`tick-pinger-<ms>` markers) + conductor.yml runs ("pinger · conductor"). This duty reports the PINGER\'s health, not the chain\'s — the chain may be alive-and-self-ticking (visible, not fatal). Check the pinger workflow (xfnwfpho1/pinger, cron */15) and its PAT; the next landed pinger tick re-arms this watch silently (24h-deduped marker).',
  ].join('\n');
}
