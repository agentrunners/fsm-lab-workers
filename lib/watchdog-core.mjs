// watchdog-core.mjs — the watchdog's DECISION core, extracted from
// watchdog/scan.mjs (T45/F-B + F-D). The breaker/dedup arithmetic previously
// lived only in the adapter with ZERO automated coverage — exactly where the
// P1-c finding lives. Pure functions only: adapters-stay-thin is the house
// style (the conductor-core extraction pattern). NO I/O here — the scan
// adapter owns fetch/store/logging; these functions decide.

// F-B: the latch threshold — the newest N watchdog-reprime runs must ALL sit
// after state.chain.last_tick for the latch to trip. Replaces the old
// 30-minute sliding window (MAX_REPRIMES=3 in REPRIME_WINDOW_MIN): production
// cadences are ~2h (native) to 2-6h (executor) — the window could NEVER fill,
// so a permanently-dead conductor was re-primed FOREVER with zero operator
// alerts (probe3: 48 scans / 48 re-primes / 0 alerts = the eternal silent
// re-prime loop). The latch is cadence-proof: at 5-min manual cadence it trips
// on the 4th scan (same as the old breaker); at 2h it trips on the 4th scan
// ≈ 6h. One rule, all regimes.
export const LATCH_REPRIMES = 3;

// F-D: the alert-marker dedup window (24h — the T44 rate-limit discipline:
// a corrupt-state chain firing every ~2h scan must not comment the same alert
// 12x/day; the alert ISSUE itself is already deduped to one).
export const DEDUP_WINDOW_MS = 24 * 3600_000;

// F-D: trusted author associations for the alert-marker dedup. A marker
// comment refreshes the window ONLY if authored by MEMBER/COLLABORATOR/OWNER
// or a Bot — anonymous (NONE) and drive-by (CONTRIBUTOR, FIRST_TIME_*) markers
// are IGNORED (the stranger-suppression kill, w2f F-3: on a public repo ANY
// anonymous commenter could stay newest and strip diagnostics from a live
// alert). The watchdog's own posts pass via type==='Bot'
// (github-actions[bot]); the LAB_PAT fallback lane passes via COLLABORATOR.
// The gate bounds COMMENT NOISE only — never control.
const TRUSTED_ASSOC = new Set(['MEMBER', 'COLLABORATOR', 'OWNER']);

const tsMs = (x) => Date.parse(x?.created_at || x || '');

// ---------------------------------------------------------------------------
// F-B — the per-incident circuit-breaker LATCH.
//
// breakerDecision({ state, recentRuns, nowMs, inflightWindowMs })
//   state      — the state.json object as read by the scan (only
//                state.chain.last_tick / state.chain.seq are read).
//   recentRuns — the conductor workflow runs visible to this scan (ANY order;
//                the arithmetic is order-independent — W2-b law-20: sort/
//                direction params are IGNORED server-side on list endpoints).
//                Each run needs {name, status, created_at}.
//   nowMs      — the scan's clock (injected for testability).
//
// LATCH condition: the newest LATCH_REPRIMES runs named 'watchdog-reprime'
// ALL exist AND were all created_at > state.chain.last_tick — i.e. the last
// N re-primes ALL failed to produce an applied tick. last_tick is the
// progress witness (it advances in the same TICK branch as seq, with no
// run-name schema change). MEMORY-FREE: derived state only (run ledger +
// state.json) — nothing to persist, nothing to reset; ANY applied tick IS the
// re-arm (the latch condition is simply false on the next scan). A
// revived-but-slow chain never latches: its re-primes sit below last_tick.
//
// The in-flight guard (T44 semantics, unchanged): a queued/in_progress
// conductor run created within the lookback -> WAIT (no re-prime — it queues
// behind the live run rather than cancelling it; the group is
// cancel-in-progress:false). The 6-min lookback (< the 10-min conductor job
// TTL) also bounds a runner-starved 'queued' run from blocking re-primes
// forever.
//
// Fail-open direction: an unparseable/missing last_tick or unparseable
// run.created_at can never complete the "all after last_tick" predicate ->
// not latched -> re-prime continues (today's behavior — the self-heal lane).
// ---------------------------------------------------------------------------
export function breakerDecision({ state, recentRuns = [], nowMs = Date.now(), inflightWindowMs = 6 * 60_000 } = {}) {
  const inflight = recentRuns.filter(r =>
    ['queued', 'in_progress'].includes(r.status) && (nowMs - tsMs(r)) <= inflightWindowMs);

  const reprimes = recentRuns
    .filter(r => (r.name || '').includes('watchdog-reprime'))
    .sort((a, b) => tsMs(b) - tsMs(a)); // newest first — order-independent selection
  const newest = reprimes.slice(0, LATCH_REPRIMES);
  const lastTickMs = tsMs(state?.chain?.last_tick);
  const latched =
    newest.length === LATCH_REPRIMES &&
    Number.isFinite(lastTickMs) &&
    newest.every(r => Number.isFinite(tsMs(r)) && tsMs(r) > lastTickMs);

  return {
    latched,
    latchCount: newest.length,        // how many re-primes the predicate considered
    reprimesTotal: reprimes.length,   // re-primes in the fetched window (log color)
    inflight: inflight.length,
    lastTick: state?.chain?.last_tick || null,
    seq: state?.chain?.seq,
  };
}

// ---------------------------------------------------------------------------
// F-D — the alert-marker 24h dedup, hardened.
//
// alertDedup({ comments, nowMs, windowMs }) -> { skip, markerAgeMin, ... }
//   comments — the issue comments the adapter fetched (per_page=20, ANY
//              order — law-20 again: the newest TRUSTED marker is selected by
//              created_at arithmetic, never by array position; an out-of-set
//              newest marker simply fails to dedup -> an extra alert comment,
//              the fail-NOISY direction, never the suppress direction).
//
// skip=true  -> the 24h window is fresh (a trusted marker < 24h old): the
//               scan posts NOTHING (the alert issue already carries the body).
// skip=false -> post the marker comment.
// ---------------------------------------------------------------------------
export function alertDedup({ comments = [], nowMs = Date.now(), windowMs = DEDUP_WINDOW_MS } = {}) {
  const markers = comments.filter(c => (c.body || '').includes('[fsm-watchdog]'));
  const trusted = markers.filter(c =>
    TRUSTED_ASSOC.has(c.author_association) || c.user?.type === 'Bot');
  if (trusted.length === 0) {
    return {
      skip: false, markerAgeMin: null, markerBy: null,
      reason: markers.length ? 'no-trusted-marker' : 'no-marker',
    };
  }
  let newest = trusted[0];
  for (const c of trusted) {
    // NaN comparisons are false — an unparseable created_at can never win
    if (tsMs(c) > tsMs(newest)) newest = c;
  }
  const ageMs = nowMs - tsMs(newest);
  if (Number.isFinite(ageMs) && ageMs < windowMs) {
    return {
      skip: true,
      markerAgeMin: Math.round(Math.max(ageMs, 0) / 60_000),
      markerBy: newest.user?.login || null,
      reason: 'trusted-marker-fresh',
    };
  }
  return {
    skip: false,
    markerAgeMin: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null,
    markerBy: newest.user?.login || null,
    reason: Number.isFinite(ageMs) ? 'marker-stale' : 'marker-unparseable',
  };
}
