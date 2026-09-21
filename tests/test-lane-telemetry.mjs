// tests/test-lane-telemetry.mjs — T46/W-D lane B pins (§D4 as amended v2).
// Covers: the pure shapes (laneLogLine/parseLaneTelemetry/aggregate), the
// collectLaneStats fs contract, the composeReportOutcome allowlist SEAM (M4),
// the drain carry + legacy compatibility (M3), and the console LANE section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneLogLine, parseLaneTelemetry, aggregateLaneStats, collectLaneStats } from '../worker/lane-telemetry.mjs';
import { composeReportOutcome } from '../worker/turn.mjs';
import { laneSection, statusSummary } from '../ops/console.mjs';
import { apply } from '../lib/fsm.mjs';

// ---------------------------------------------------------------------------
// 1. the pure line shape
test('laneLogLine: the JSONL record shape (M2)', () => {
  const l = laneLogLine({ ts: '2026-09-19T00:00:00Z', model: 'z-ai/glm-5.3-flash', status: 200, ms: 1234, tokens_in: 10, tokens_out: 5, cost: 0.0001, rate_class: '', err_code: null });
  assert.equal(l.model, 'z-ai/glm-5.3-flash');
  assert.equal(l.status, 200);
  assert.equal(l.ms, 1234);
  const round = JSON.parse(JSON.stringify(l));
  assert.deepEqual(Object.keys(round).sort(), ['cost', 'err_code', 'model', 'ms', 'rate_class', 'status', 'tokens_in', 'tokens_out', 'ts'].sort());
});

// ---------------------------------------------------------------------------
// 2. the 429 class extraction (G2/G3)
test('parseLaneTelemetry: 429 + limit_source becomes rate_class', () => {
  const t = parseLaneTelemetry({ status: 429, headers: { 'x-ratelimit-limit': '1000' }, bodyText: JSON.stringify({ error: { code: 429, metadata: { limit_source: 'openrouter_free_tier_daily' } } }) });
  assert.equal(t.rate_class, 'openrouter_free_tier_daily');
});

test('parseLaneTelemetry: 200 usage extracts tokens/cost', () => {
  const t = parseLaneTelemetry({ status: 200, headers: {}, bodyText: JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3, cost: 0.0002 } }) });
  assert.equal(t.tokens_in, 7);
  assert.equal(t.tokens_out, 3);
  assert.equal(t.cost, 0.0002);
});

// ---------------------------------------------------------------------------
// 3. the aggregate (p50/p95 math + per-model map + rate histogram)
test('aggregateLaneStats: counts, percentiles, models map, rate_classes', () => {
  const lines = [
    { model: 'a', status: 200, ms: 100, tokens_in: 1, tokens_out: 1, cost: 0, rate_class: '' },
    { model: 'a', status: 200, ms: 300, tokens_in: 1, tokens_out: 1, cost: 0, rate_class: '' },
    { model: 'b', status: 429, ms: 50, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: 'openrouter_free_tier_daily' },
    { model: 'b', status: 500, ms: 70, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: '' },
  ];
  const agg = aggregateLaneStats(lines);
  assert.equal(agg.calls, 4);
  assert.equal(agg.ok, 2);
  assert.equal(agg.err429, 1);
  assert.equal(agg.err5xx, 1);
  assert.equal(agg.rate_classes.openrouter_free_tier_daily, 1);
  assert.equal(agg.models.a.calls, 2);
  assert.equal(agg.models.b.err429, 1);
  // sorted ms = [50,70,100,300]; p50 = idx 2 = 100; p95 = idx 3 = 300
  assert.equal(agg.p50_ms, 100);
  assert.equal(agg.p95_ms, 300);
  // models.a has ms [100,300]: floor(0.5*2)=1 → 300 (the same nearest-rank formula)
  assert.equal(agg.models.a.p50_ms, 300);
});

// ---------------------------------------------------------------------------
// 4. the collectLaneStats fs contract (read → aggregate → DELETE; missing → null)
test('collectLaneStats: reads, aggregates, deletes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-lane-test-'));
  const p = join(dir, 'bridge-lane.jsonl');
  writeFileSync(p, JSON.stringify({ model: 'm', status: 200, ms: 10, tokens_in: 1, tokens_out: 1, cost: 0, rate_class: '' }) + '\n' + JSON.stringify({ model: 'm', status: 429, ms: 5, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: 'x' }) + '\n');
  const agg = collectLaneStats(p);
  assert.equal(agg.calls, 2);
  assert.equal(agg.err429, 1);
  assert.throws(() => { /* file gone */ const fs = require('node:fs'); fs.accessSync(p); }, undefined, 'consumed');
  // tolerant: unparseable line skipped
  writeFileSync(p, 'not-json\n' + JSON.stringify({ model: 'm', status: 200, ms: 1, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: '' }) + '\n');
  const agg2 = collectLaneStats(p);
  assert.equal(agg2.calls, 1);
  assert.equal(collectLaneStats(join(dir, 'absent.jsonl')), null);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. the M4 allowlist SEAM — lane_stats/key_index/pool_size/hop_telemetry survive the composer
test('composeReportOutcome: lane telemetry passes the allowlist (the prCandidates lesson)', () => {
  const raw = { status: 'done', artifact: 'tasks/x/report.md', duration_ms: 5, lane_stats: { calls: 3, ok: 3, err429: 0, err5xx: 0, tokens: 900, cost: 0.001, p50_ms: 800, p95_ms: 1200, rate_classes: {}, models: { 'z-ai/glm-5.3-flash': { calls: 3 } } }, key_index: 4, pool_size: 82, hop_telemetry: [{ model: 'm', ms: 5, status: 200 }] };
  const out = composeReportOutcome({ status: 'done', artifact: 'tasks/x/report.md' }, raw, 5);
  assert.equal(out.lane_stats.calls, 3);
  assert.equal(out.key_index, 4);
  // W-D review fold (A4, lens-2 F1): the PAIR rides together — key_index
  // (the slot) + pool_size (the modulo base). Without the base the journal's
  // historical slots are ambiguous across pool redeploys.
  assert.equal(out.pool_size, 82, 'pool_size rides exactly like key_index');
  assert.deepEqual(out.hop_telemetry, [{ model: 'm', ms: 5, status: 200 }]);
  // absent fields stay absent (legacy shape)
  const out2 = composeReportOutcome({ status: 'done', artifact: 'a' }, { status: 'done', artifact: 'a', duration_ms: 5 }, 5);
  assert.equal('lane_stats' in out2, false);
  assert.equal('key_index' in out2, false);
  assert.equal('pool_size' in out2, false);
});

// ---------------------------------------------------------------------------
// 6. the M3 drain carry — lane fields land in the journal record + last_result
//    (legacy queue lines without them stay byte-identical: compat is HARD)
function world() {
  return {
    schema: 1, version: 1, journal_seq: 0,
    chain: { id: 'c1', phase: 'executing', seq: 1, halted: false, paused: false, last_tick: '2026-09-19T00:00:00Z' },
    project: { phase: 'executing', mode: 'mock', milestone: 1, milestones_total: 1 },
    config: { max_parallel: 4, lease_minutes: 45, max_attempts: 3, tick_min_interval_s: 25, dedup_window: 300 },
    tasks: { 'T-1': { id: 'T-1', title: 't', status: 'assigned', attempts: 1, infra_attempts: 0, lease: { token: 'l1', expires: '2026-09-19T01:00:00Z', issued_at: '2026-09-19T00:00:00Z' }, milestones: [1], history: [] } },
    stats: { done: 0, failed: 0, quarantined: 0, cancelled: 0, retries: 0, dispatched: 1, infra_retries: 0, rejected_events: 0, timeouts: 0, orphaned_reports: 0 },
    dedup: [],
  };
}
const EV = (outcome, lease = 'l1') => ({ kind: 'REPORT', event_id: 'e1', task: 'T-1', lease, run_id: 'r1', outcome });
const NO_MILESTONE = () => null;

test('apply: lane_stats rides the REPORT into the task record + journal (M3)', () => {
  const s = world();
  const rr = apply(s, EV({ status: 'done', artifact: 'f', duration_ms: 5, lane_stats: { calls: 2, ok: 2 }, key_index: 1, pool_size: 82 }), '2026-09-19T00:00:01Z', NO_MILESTONE);
  const rec = rr.journal.find(j => j.kind === 'REPORT');
  assert.ok(rec, 'journal REPORT record exists');
  assert.deepEqual(rec.lane_stats, { calls: 2, ok: 2 });
  assert.equal(rec.key_index, 1);
  // W-D review fold (A4, lens-2 F1): the slot's modulo base rides the SAME
  // drain — the journaled pair (key_index + pool_size) is self-describing.
  assert.equal(rec.pool_size, 82, 'pool_size lands in the journal record');
  assert.deepEqual(rr.state.tasks['T-1'].last_result.lane_stats, { calls: 2, ok: 2 });
  assert.equal(rr.state.tasks['T-1'].last_result.pool_size, 82, 'and in last_result');
});

test('apply: legacy queue line without lane fields applies unchanged (compat)', () => {
  const s = world();
  const rr = apply(s, EV({ status: 'done', artifact: 'f', duration_ms: 5 }), '2026-09-19T00:00:01Z', NO_MILESTONE);
  const rec = rr.journal.find(j => j.kind === 'REPORT');
  assert.equal('lane_stats' in rec, false);
  assert.equal('key_index' in rec, false);
  assert.equal('pool_size' in rec, false);
  assert.equal(rr.state.tasks['T-1'].last_result.artifact, 'f');
  assert.equal('lane_stats' in rr.state.tasks['T-1'].last_result, false);
});

// ---------------------------------------------------------------------------
// 7. the console LANE section
test('laneSection: aggregates across tasks; absent → the no-telemetry line', () => {
  const none = laneSection([{ id: 'T-1', last_result: { status: 'done' } }]);
  assert.match(none[0], /no telemetry yet/);
  const some = laneSection([
    { id: 'T-1', last_result: { status: 'done', lane_stats: { calls: 3, ok: 2, err429: 1, err5xx: 0, tokens: 120, cost: 0.01, p50_ms: 100, p95_ms: 200, models: { 'z-ai/glm-5.3-flash': { calls: 3 } }, rate_classes: { openrouter_free_tier_daily: 1 } } } },
    { id: 'T-2', last_result: { status: 'done', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 30, cost: 0.02, p50_ms: 400, p95_ms: 400, models: { 'z-ai/glm-5.3-flash': { calls: 1 } }, rate_classes: {} } } },
  ]);
  assert.match(some[0], /4 calls/);
  assert.match(some[0], /1×429/);
  assert.match(some[0], /p50 400ms/);
  assert.match(some[0], /2 tasks/);
  assert.match(some[1], /glm-5.3-flash:4/);
  assert.match(some[1], /openrouter_free_tier_daily:1/);
});

test('statusSummary: carries the lane lines (or the absent line) without breaking the screen', () => {
  const base = { chain: { id: 'c1', last_tick: '2026-09-19T00:00:00Z' }, project: { phase: 'executing', milestone: 1, milestones_total: 1, mode: 'mock' }, stats: {}, tasks: { 'T-1': { id: 'T-1', status: 'assigned' } } };
  const s1 = statusSummary({ state: base, depths: {}, nowMs: Date.parse('2026-09-19T00:00:30Z') });
  assert.match(s1, /no telemetry yet/);
  base.tasks['T-1'].last_result = { lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 1, cost: 0, p50_ms: 5, p95_ms: 5, models: { m: { calls: 1 } }, rate_classes: {} } };
  const s2 = statusSummary({ state: base, depths: {}, nowMs: Date.parse('2026-09-19T00:00:30Z') });
  assert.match(s2, /- lanes: 1 calls/);
  assert.match(s2, /- phase: executing/); // the rest of the screen survives
});

// ---------------------------------------------------------------------------
// 8. the W-D review fold (A4) — the JOURNAL-sourced LANE section (the primary
//    source; lens-2 F2 + lens-1 F3): REPORT records from readJournalTail
//    aggregate ahead of the state view; old-format records degrade gracefully.
test('laneSection (the fold, A4): the journal tail is the PRIMARY lane source — REPORT records aggregate; old-format records degrade gracefully', () => {
  const stateView = [
    { id: 'T-1', last_result: { status: 'done', lane_stats: { calls: 3, ok: 3, err429: 0, err5xx: 0, tokens: 100, cost: 0, p50_ms: 900, p95_ms: 900, models: {}, rate_classes: {} } } },
  ];
  const journalReports = [
    { kind: 'REPORT', task: 'T-1', lane_stats: { calls: 2, ok: 1, err429: 1, err5xx: 0, tokens: 40, cost: 0.01, p50_ms: 100, p95_ms: 200, models: { 'z-ai/glm-5.3-flash': { calls: 2 } }, rate_classes: { openrouter_free_tier_daily: 1 } } },
    { kind: 'TICK', ts: '2026-09-19T00:00:00Z' },   // not a REPORT — skipped
    { kind: 'REPORT', task: 'T-2' },                 // old-format, no lane_stats — skipped, no crash
    { kind: 'REPORT', task: 'T-3', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0.02, p50_ms: 400, p95_ms: 400, models: { 'z-ai/glm-5.3-flash': { calls: 1 } }, rate_classes: {} } },
  ];
  const lines = laneSection(stateView, journalReports);
  assert.match(lines[0], /3 calls/);   // the JOURNAL aggregate (2+1), not the state view's 3
  assert.match(lines[0], /1×429/);
  assert.match(lines[0], /p50 400ms/); // sorted per-record p50s [100,400] -> index 1
  assert.match(lines[0], /2 turns \(journal tail\)/, 'the source is labeled (the durable record)');
  assert.match(lines[1], /glm-5.3-flash:3/);
  // graceful: an ALL-old-format journal (pre-fold records) -> the state fallback
  const legacy = laneSection(stateView, [{ kind: 'REPORT', task: 'T-9' }, { kind: 'CONTROL', command: 'pause' }]);
  assert.match(legacy[0], /3 calls/);
  assert.match(legacy[0], /1 tasks \(state window\)/, 'the fallback source is labeled too');
  // graceful: nothing anywhere -> the single no-telemetry line (no crash)
  const none = laneSection([{ id: 'T-1', last_result: { status: 'done' } }], [{ kind: 'REPORT', task: 'T-8' }]);
  assert.match(none[0], /no telemetry yet/);
  assert.equal(none.length, 1);
  // an EMPTY journal array (fresh epoch, no REPORT records yet) -> the fallback
  assert.match(laneSection(stateView, [])[0], /3 calls/);
});

test('statusSummary (the fold, A4): journalReports drives the lane section; the rest of the screen survives', () => {
  const base = { chain: { id: 'c1', last_tick: '2026-09-19T00:00:00Z' }, project: { phase: 'executing', milestone: 1, milestones_total: 1, mode: 'cc' }, stats: {}, tasks: {} };
  const s = statusSummary({
    state: base,
    depths: {},
    nowMs: Date.parse('2026-09-19T00:00:30Z'),
    journalReports: [
      { kind: 'REPORT', task: 'T-1', lane_stats: { calls: 2, ok: 2, err429: 0, err5xx: 0, tokens: 60, cost: 0.03, p50_ms: 700, p95_ms: 900, models: { 'deepseek/deepseek-v4.1-flash': { calls: 2 } }, rate_classes: {} } },
    ],
  });
  assert.match(s, /- lanes: 2 calls/);
  assert.match(s, /1 turns \(journal tail\)/);
  assert.match(s, /- phase: executing/);
  assert.match(s, /deepseek-v4\.1-flash:2/);
});

// ---------------------------------------------------------------------------
// 9. s21/O-2 (audit a5, MAJOR) — the HONEST latency line. The accumulator
//    collected only per-record p50_ms and the render percentile'd that array
//    under an unqualified `p95` label: with 2 records the p50 and "p95"
//    rendered IDENTICAL (percentile-of-medians), systematically understating
//    the tail (live: `p50 7384ms · p95 15593ms` where 15593 was max-of-p50s
//    and the records' true p95s ran 12606-21406ms). Now BOTH arrays collect:
//    `p50` = the median of the per-turn medians, `p95(max)` = the MAXIMUM of
//    the per-turn p95s — the label says exactly what was computed.
test('laneSection (s21/O-2): p50-of-p50s and max-of-p95s render distinctly — the label says what it is', () => {
  const journalReports = [
    { kind: 'REPORT', task: 'T-1', lane_stats: { calls: 2, ok: 2, err429: 0, err5xx: 0, tokens: 40, cost: 0.01, p50_ms: 100, p95_ms: 900, models: {}, rate_classes: {} } },
    { kind: 'REPORT', task: 'T-2', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0.02, p50_ms: 300, p95_ms: 1200, models: {}, rate_classes: {} } },
  ];
  const lines = laneSection([], journalReports);
  // p50 = median of the per-record p50s [100,300] -> 300; p95(max) =
  // max of the per-record p95s [900,1200] -> 1200. The OLD render here said
  // `p50 300ms · p95 300ms` — the two lines were IDENTICAL.
  assert.match(lines[0], /p50 300ms/);
  assert.match(lines[0], /p95\(max\) 1200ms/);
  const m = /p50 (\d+)ms · p95\(max\) (\d+)ms/.exec(lines[0]);
  assert.ok(m, 'both latency tokens render');
  assert.notEqual(m[1], m[2], 'p50 and p95(max) come from DIFFERENT arrays — the median-of-medians trap is dead');
  // a single record: p50 = its p50, p95(max) = its OWN p95 (the audit's live
  // 2-record case rendered p50 === p95; even 1 record now shows both truths)
  const single = laneSection([], [journalReports[0]]);
  assert.match(single[0], /p50 100ms · p95\(max\) 900ms/);
  // records without p95_ms (or null) → the honest '?', never a re-labeled p50
  const noP95 = laneSection([], [{ kind: 'REPORT', task: 'T-3', lane_stats: { calls: 1, ok: 1, tokens: 1, cost: 0, p50_ms: 500, p95_ms: null, models: {}, rate_classes: {} } }]);
  assert.match(noP95[0], /p95\(max\) \?ms/);
  assert.match(noP95[0], /p50 500ms/);
});

// ---------------------------------------------------------------------------
// 10. s21/O-3 (audit a5, MAJOR) — the KEY line + the HOP rows. key_index/
//     pool_size/hop_telemetry ride the REPORT records (the drain's
//     laneOutcomeFields) but rendered NOWHERE before; the CC lane (the
//     deployed mode) never even produced key_index — so the blind spot behind
//     the live key failure modes (one key serving everything / a dead key)
//     was undetectable from the operator's one screen.
test('laneSection (s21/O-3): CC-lane-shaped REPORT records render the KEY spread (distinct indexes + pool size)', () => {
  // the deployed CC shape after the carry: lane_stats + key_index/pool_size
  // (0-based), NO hop_telemetry (real-lane-only producer)
  const ccRecords = [
    { kind: 'REPORT', task: 'A1', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0.001, p50_ms: 700, p95_ms: 900, models: {}, rate_classes: {} }, key_index: 0, pool_size: 2 },
    { kind: 'REPORT', task: 'A2', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0.001, p50_ms: 800, p95_ms: 950, models: {}, rate_classes: {} }, key_index: 0, pool_size: 2 },
    { kind: 'REPORT', task: 'A3', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0.001, p50_ms: 600, p95_ms: 880, models: {}, rate_classes: {} }, key_index: 0, pool_size: 2 },
  ];
  const one = laneSection([], ccRecords);
  assert.equal(one[0], '- lanes: 3 calls (3 ok · 0×429 · 0×5xx) · p50 700ms · p95(max) 950ms · tokens 30 · cost $0.0030 · 3 turns (journal tail)');
  // THE live blind-spot line: one key serving EVERY turn reads 1/2 — the
  // W1/W3 failure-class signal an operator could not see before
  assert.equal(one[1], '- lane keys: 1/2 distinct served (k0:3)');
  // a spread across both keys (the W1 key-jump recovery shape)
  const spread = laneSection([], [...ccRecords, { kind: 'REPORT', task: 'A4', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 5, cost: 0.001, p50_ms: 500, p95_ms: 700, models: {}, rate_classes: {} }, key_index: 1, pool_size: 2 }]);
  assert.equal(spread[1], '- lane keys: 2/2 distinct served (k0:3 k1:1)');
  // records WITHOUT pool_size → the distinct count alone (the base is honest)
  const noPool = laneSection([], [{ kind: 'REPORT', task: 'B1', lane_stats: { calls: 1, ok: 1, tokens: 1, cost: 0, p50_ms: 5, p95_ms: 5, models: {}, rate_classes: {} }, key_index: 2 }]);
  assert.equal(noPool[1], '- lane keys: 1 distinct served (k2:1)');
  // old-format records (no key_index anywhere) → NO keys line, no crash
  const legacy = laneSection([], [{ kind: 'REPORT', task: 'C1', lane_stats: { calls: 1, ok: 1, tokens: 1, cost: 0, p50_ms: 5, p95_ms: 5, models: {}, rate_classes: {} } }]);
  assert.equal(legacy.length, 1, 'no key telemetry carried → the lanes line only (graceful)');
});

test('laneSection (s21/O-3): real-lane-shaped REPORT records render the HOP rows (model/ms/status, last N)', () => {
  const realRecords = [
    { kind: 'REPORT', task: 'D1', lane_stats: { calls: 2, ok: 1, err429: 1, err5xx: 0, tokens: 20, cost: 0, p50_ms: 100, p95_ms: 200, models: {}, rate_classes: {} }, key_index: 1, pool_size: 3, hop_telemetry: [
      { model: 'nvidia/nemotron-3.5-lightning:free', ms: 100, status: 429 },
      { model: 'z-ai/glm-5.3-flash', ms: 250, status: 200 },
    ] },
    { kind: 'REPORT', task: 'D2', lane_stats: { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 10, cost: 0, p50_ms: 60, p95_ms: 60, models: {}, rate_classes: {} }, key_index: 2, pool_size: 3, hop_telemetry: [
      { model: 'z-ai/glm-5.3-flash', ms: 60, status: 200 },
    ] },
  ];
  const lines = laneSection([], realRecords);
  assert.equal(lines[0], '- lanes: 3 calls (2 ok · 1×429 · 0×5xx) · p50 100ms · p95(max) 200ms · tokens 30 · cost $0.0000 · 2 turns (journal tail)');
  assert.equal(lines[1], '- lane keys: 2/3 distinct served (k1:1 k2:1)');
  // the hops render in journal order, newest last: the 429 hop is VISIBLE
  assert.equal(lines[2], '- lane hops (last 3): nemotron-3.5-lightning:free 100ms 429 · glm-5.3-flash 250ms 200 · glm-5.3-flash 60ms 200');
  // the window bound: only the LAST LANE_HOP_WINDOW hops render
  const many = [];
  for (let i = 0; i < 9; i++) {
    many.push({ kind: 'REPORT', task: `E${i}`, lane_stats: { calls: 1, ok: 1, tokens: 1, cost: 0, p50_ms: 1, p95_ms: 1, models: {}, rate_classes: {} }, hop_telemetry: [{ model: `m${i}`, ms: i * 10, status: 200 }] });
  }
  const bounded = laneSection([], many);
  assert.match(bounded[1], /^- lane hops \(last 6\): m3 30ms 200 · m4 40ms 200 · m5 50ms 200 · m6 60ms 200 · m7 70ms 200 · m8 80ms 200$/);
  // the 'transport' status (never reached the model) renders verbatim
  const transport = laneSection([], [{ kind: 'REPORT', task: 'F1', lane_stats: { calls: 1, ok: 0, err429: 0, err5xx: 0, tokens: 0, cost: 0, p50_ms: null, p95_ms: null, models: {}, rate_classes: {} }, hop_telemetry: [{ model: 'x/y', ms: 12, status: 'transport' }] }]);
  assert.match(transport[1], /- lane hops \(last 1\): y 12ms transport/);
  // the state-window fallback carries the SAME fields (last_result's spread)
  const fallback = laneSection([{ id: 'G1', last_result: { status: 'done', lane_stats: { calls: 1, ok: 1, tokens: 2, cost: 0, p50_ms: 9, p95_ms: 9, models: {}, rate_classes: {} }, key_index: 0, pool_size: 2, hop_telemetry: [{ model: 'a/b', ms: 9, status: 200 }] } }]);
  assert.equal(fallback[1], '- lane keys: 1/2 distinct served (k0:1)');
  assert.match(fallback[2], /^- lane hops \(last 1\): b 9ms 200$/);
});
