// test-watchdog-core.mjs — T45/F-B + F-D: the watchdog's DECISION core
// (lib/watchdog-core.mjs). The breaker/dedup arithmetic had ZERO automated
// coverage before this extraction — P1-c lived exactly there. All pure: no
// I/O, no fetch stubs (adapters-stay-thin is the house style — the adapter's
// corrupt-state early-return / halted / paused gates stay in scan.mjs, before
// any core call).
//
// Clock discipline: all times are ISO strings minted from a fixed NOW so the
// latch arithmetic is exact (the design's memory-free rule is derived state
// only: the run ledger + state.chain.last_tick).

import test from 'node:test';
import assert from 'node:assert/strict';
import { breakerDecision, alertDedup, LATCH_REPRIMES, DEDUP_WINDOW_MS } from '../lib/watchdog-core.mjs';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const run = (name, minAgo, status = 'completed') => ({ name, status, created_at: iso(minAgo) });
const rep = (minAgo, status = 'completed') => run('watchdog-reprime · conductor', minAgo, status);
const stateAt = (lastTickMinAgo, seq = 42) => ({ chain: { last_tick: iso(lastTickMinAgo), seq } });

// ---------------------------------------------------------------------------
// F-B — the latch.

test('T45/F-B: probe3A regimes — the latch fires at ALL production cadences (the old 30-min window could not)', () => {
  // dead chain: every re-prime created AFTER last_tick, zero chain progress.
  // The old breaker required 3 re-primes INSIDE 30min — at 2h/2-6h cadences
  // it NEVER fired (48 scans / 48 re-primes / 0 alerts). The latch is
  // cadence-proof: spacing is irrelevant, only "all after last_tick" is.
  const regimes = [
    { label: 'manual 5-min (probe3A X5b)', gaps: [5, 10, 15], lastTick: 60 },
    { label: 'dense 10-min', gaps: [10, 20, 30], lastTick: 90 },
    { label: 'native ~2h', gaps: [120, 240, 360], lastTick: 420 },
    { label: 'executor 2-6h', gaps: [120, 300, 540], lastTick: 600 },
  ];
  for (const { label, gaps, lastTick } of regimes) {
    const d = breakerDecision({ state: stateAt(lastTick), recentRuns: gaps.map(g => rep(g)), nowMs: NOW });
    assert.equal(d.latched, true, `${label}: latch must FIRE`);
    assert.equal(d.latchCount, LATCH_REPRIMES);
    assert.equal(d.inflight, 0);
  }
});

test('T45/F-B: fewer than 3 re-primes after last_tick -> NO latch (re-prime continues)', () => {
  const d = breakerDecision({ state: stateAt(60), recentRuns: [rep(5), rep(10)], nowMs: NOW });
  assert.equal(d.latched, false);
  assert.equal(d.latchCount, 2);
});

test('T45/F-B: progress case — a tick landed after the 2nd re-prime -> NOT latched (the counter effectively resets)', () => {
  // re-primes at -15, -10, -5 min; a tick landed 7 min ago (AFTER the 2nd
  // re-prime): only the newest re-prime sits after last_tick -> no latch.
  const d = breakerDecision({ state: stateAt(7), recentRuns: [rep(5), rep(10), rep(15)], nowMs: NOW });
  assert.equal(d.latched, false, 'last_tick past 2 of 3 re-primes = progress witnessed');
});

test('T45/F-B: revival case — 3 latched re-primes, then a landed tick -> unlatched on the next scan (auto re-arm)', () => {
  // before the tick: latched (all 3 after last_tick at -60)
  const before = breakerDecision({ state: stateAt(60), recentRuns: [rep(5), rep(10), rep(15)], nowMs: NOW });
  assert.equal(before.latched, true);
  // the operator's manual fsm-tick lands NOW; next scan sees last_tick=now:
  // every re-prime sits BELOW it -> the latch condition is simply false.
  const after = breakerDecision({ state: { chain: { last_tick: new Date(NOW).toISOString(), seq: 43 } }, recentRuns: [rep(5), rep(10), rep(15)], nowMs: NOW + 60_000 });
  assert.equal(after.latched, false, 'any applied tick IS the re-arm — derived state, nothing to reset');
});

test('T45/F-B: HEALTHY-BUT-SLOW never false-latches (R3-verified: each re-prime own run applies a tick)', () => {
  // a slow-but-alive chain: every re-prime DID produce an applied tick AFTER
  // its creation (re-prime -20 -> tick -18; re-prime -15 -> tick -13;
  // re-prime -10 -> tick -8). last_tick (-8) sits AFTER the newest re-prime
  // (-10): zero of the re-primes are after it -> no latch.
  const d = breakerDecision({ state: stateAt(8), recentRuns: [rep(10), rep(15), rep(20)], nowMs: NOW });
  assert.equal(d.latched, false, 'a revived-but-slow chain never latches — its re-primes sit below last_tick');
});

test('T45/F-B: re-primes older than last_tick do not count toward the latch (only the newest 3 are considered, order-independent)', () => {
  // 5 re-primes: two BELOW last_tick (witnessed progress), the newest 3 above.
  // The newest 3 all sit after last_tick -> LATCHED (the old ones are history).
  const d = breakerDecision({
    state: stateAt(30),
    recentRuns: [rep(5), rep(12), rep(20), rep(40), rep(50)],
    nowMs: NOW,
  });
  assert.equal(d.latched, true);
  assert.equal(d.reprimesTotal, 5);
  // the SAME runs in the OPPOSITE array order (law-20: server ordering is
  // arbitrary) -> identical verdict
  const d2 = breakerDecision({
    state: stateAt(30),
    recentRuns: [rep(50), rep(40), rep(20), rep(12), rep(5)],
    nowMs: NOW,
  });
  assert.equal(d2.latched, true, 'order-independent selection');
});

test('T45/F-B: in-flight guard (T44 semantics unchanged) — queued/running run within the lookback -> WAIT', () => {
  const d = breakerDecision({
    state: stateAt(60),
    recentRuns: [rep(1, 'queued'), rep(5), rep(10)],
    nowMs: NOW,
  });
  assert.equal(d.inflight, 1, 'a queued conductor run 1 min old blocks the re-prime');
  // the ADAPTER gates on inflight FIRST (scan.mjs returns before the latch
  // branch) — the decision returns both facts; latched is still computed.
  // in_progress also waits
  const d2 = breakerDecision({
    state: stateAt(60),
    recentRuns: [run('manual · conductor', 2, 'in_progress'), rep(5), rep(10)],
    nowMs: NOW,
  });
  assert.equal(d2.inflight, 1);
  // a run queued LONG ago (runner starvation, 30 min) is beyond the 6-min
  // lookback -> NOT in flight (the T44 bound: it cannot block re-primes forever)
  const d3 = breakerDecision({
    state: stateAt(60),
    recentRuns: [rep(30, 'queued'), rep(5), rep(10)],
    nowMs: NOW,
  });
  assert.equal(d3.inflight, 0, 'a 30-min-old queued run is beyond the 6-min lookback');
  // completed runs never count
  const d4 = breakerDecision({
    state: stateAt(60),
    recentRuns: [rep(1), rep(5), rep(10)],
    nowMs: NOW,
  });
  assert.equal(d4.inflight, 0);
});

test('T45/F-B: fail-open direction — missing/unparseable last_tick or created_at never latches', () => {
  const noTick = breakerDecision({ state: { chain: { seq: 1 } }, recentRuns: [rep(5), rep(10), rep(15)], nowMs: NOW });
  assert.equal(noTick.latched, false, 'no last_tick -> no progress witness -> re-prime continues (today behavior)');
  const badTick = breakerDecision({ state: { chain: { last_tick: 'not-a-date', seq: 42 } }, recentRuns: [rep(5), rep(10), rep(15)], nowMs: NOW });
  assert.equal(badTick.latched, false);
  const badRuns = breakerDecision({ state: stateAt(60), recentRuns: [rep(5), rep(10), { name: 'watchdog-reprime · conductor', status: 'completed', created_at: 'garbage' }], nowMs: NOW });
  assert.equal(badRuns.latched, false, 'an unparseable created_at cannot complete the all-after predicate');
});

// ---------------------------------------------------------------------------
// F-D — the alert-marker dedup.

const cm = (minAgo, { assoc = 'NONE', type = 'User', login = 'anon', body = '**[fsm-watchdog]** LATCHED — marker' } = {}) => ({
  created_at: iso(minAgo),
  author_association: assoc,
  user: { type, login },
  body,
});

test('T45/F-D: ANONYMOUS newest marker -> NO skip (the stranger-suppression kill is dead)', () => {
  // a stranger comments [fsm-watchdog] 5 min ago; the trusted marker is 25h old.
  // OLD behavior: the stranger's marker was newest -> suppressed the alert.
  // NEW: only trusted markers refresh the window — the stale trusted marker
  // does NOT dedup, and the stranger's fresh one counts for nothing.
  const d = alertDedup({ comments: [cm(5), cm(1500, { assoc: 'COLLABORATOR', login: 'zikomolapoutl' })], nowMs: NOW });
  assert.equal(d.skip, false, 'an anonymous (NONE) marker must NOT suppress');
  assert.equal(d.reason, 'marker-stale');
});

test('T45/F-D: the watchdog\'s own Bot marker <24h -> skip', () => {
  const d = alertDedup({ comments: [cm(10, { assoc: 'NONE', type: 'Bot', login: 'github-actions[bot]' })], nowMs: NOW });
  assert.equal(d.skip, true);
  assert.equal(d.markerAgeMin, 10);
  assert.equal(d.markerBy, 'github-actions[bot]');
});

test('T45/F-D: operator reply newest + trusted marker 10min old IN the set -> skip (the per_page=1 regression)', () => {
  // OLD: per_page=1 + find() missed the marker behind the operator's reply ->
  // one extra marker comment per scan (~12/day while a human keeps replying).
  // NEW: per_page=20 + newest-by-created_at among the fetched set.
  const comments = [
    cm(3, { assoc: 'OWNER', login: 'xfnwpho1', body: 'investigating now' }),      // newest, NOT a marker
    cm(10, { assoc: 'COLLABORATOR', login: 'zikomolapoutl' }),                     // the marker, 10 min old
    cm(120, { assoc: 'NONE', type: 'Bot', login: 'github-actions[bot]' }),         // older marker
  ];
  const d = alertDedup({ comments, nowMs: NOW });
  assert.equal(d.skip, true);
  assert.equal(d.markerAgeMin, 10);
});

test('T45/F-D: trusted marker OUTSIDE the fetched set -> NO skip (fail-NOISY, never the suppress direction)', () => {
  // 25 comments on the issue; the fetch (per_page=20) carries only replies —
  // the newest marker fell out of the window. The decision can only see the
  // fetched set: no marker -> post (an extra alert comment — bounded noise).
  const replies = Array.from({ length: 25 }, (_, i) => cm(i + 1, { assoc: 'CONTRIBUTOR', login: `r${i}`, body: 'looks bad' }));
  const d = alertDedup({ comments: replies, nowMs: NOW });
  assert.equal(d.skip, false);
  assert.equal(d.reason, 'no-marker');
});

test('T45/F-D: law-20 order-independence — ascending vs descending server responses give IDENTICAL verdicts', () => {
  const descending = [
    cm(5, { assoc: 'MEMBER', login: 'op' }),
    cm(300, { assoc: 'COLLABORATOR', login: 'op2' }),
    cm(700, { assoc: 'NONE', login: 'stranger', body: '**[fsm-watchdog]** fake' }),
  ];
  const ascending = [...descending].reverse();
  const a = alertDedup({ comments: descending, nowMs: NOW });
  const b = alertDedup({ comments: ascending, nowMs: NOW });
  assert.equal(a.skip, true, 'the newest marker (5min, MEMBER) wins regardless of position');
  assert.equal(b.skip, true);
  assert.equal(a.markerAgeMin, b.markerAgeMin);
  assert.equal(a.markerBy, b.markerBy);
});

test('T45/F-D: newest trusted marker selected by created_at (not array position); marker >24h -> no skip', () => {
  // two trusted markers: 10h ago (COLLABORATOR) and 2h ago (MEMBER) — the
  // NEWER one is the dedup anchor even though it appears FIRST in the array.
  const d = alertDedup({ comments: [cm(120, { assoc: 'MEMBER', login: 'op' }), cm(600, { assoc: 'COLLABORATOR', login: 'op2' })], nowMs: NOW });
  assert.equal(d.skip, true);
  assert.equal(d.markerBy, 'op');
  assert.equal(d.markerAgeMin, 120);
  // both markers > 24h -> the window is stale -> post
  const stale = alertDedup({ comments: [cm(1500, { assoc: 'MEMBER', login: 'op' })], nowMs: NOW });
  assert.equal(stale.skip, false);
  assert.equal(stale.reason, 'marker-stale');
});

test('T45/F-D: the author gate — MEMBER/COLLABORATOR/OWNER pass; CONTRIBUTOR/FIRST_TIME_* are ignored', () => {
  for (const assoc of ['MEMBER', 'COLLABORATOR', 'OWNER']) {
    const d = alertDedup({ comments: [cm(10, { assoc, login: 'trusted' })], nowMs: NOW });
    assert.equal(d.skip, true, `${assoc} is trusted`);
  }
  for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) {
    const d = alertDedup({ comments: [cm(10, { assoc, login: 'drive-by' })], nowMs: NOW });
    assert.equal(d.skip, false, `${assoc} markers are ignored`);
    assert.equal(d.reason, 'no-trusted-marker');
  }
});

test('T45/F-D: the LAB_PAT fallback lane (COLLABORATOR) and Bot lane both stay functional; DEDUP_WINDOW_MS is 24h', () => {
  assert.equal(DEDUP_WINDOW_MS, 24 * 3600_000);
  const pat = alertDedup({ comments: [cm(60, { assoc: 'COLLABORATOR', login: 'zikomolapoutl' })], nowMs: NOW });
  assert.equal(pat.skip, true, 'the PAT lane (a collaborator) still dedups');
  const bot = alertDedup({ comments: [cm(60, { assoc: 'NONE', type: 'Bot', login: 'github-actions[bot]' })], nowMs: NOW });
  assert.equal(bot.skip, true, 'the bot lane still dedups');
});
