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
// 5. the M4 allowlist SEAM — lane_stats/key_index/hop_telemetry survive the composer
test('composeReportOutcome: lane telemetry passes the allowlist (the prCandidates lesson)', () => {
  const raw = { status: 'done', artifact: 'tasks/x/report.md', duration_ms: 5, lane_stats: { calls: 3, ok: 3, err429: 0, err5xx: 0, tokens: 900, cost: 0.001, p50_ms: 800, p95_ms: 1200, rate_classes: {}, models: { 'z-ai/glm-5.3-flash': { calls: 3 } } }, key_index: 4, hop_telemetry: [{ model: 'm', ms: 5, status: 200 }] };
  const out = composeReportOutcome({ status: 'done', artifact: 'tasks/x/report.md' }, raw, 5);
  assert.equal(out.lane_stats.calls, 3);
  assert.equal(out.key_index, 4);
  assert.deepEqual(out.hop_telemetry, [{ model: 'm', ms: 5, status: 200 }]);
  // absent fields stay absent (legacy shape)
  const out2 = composeReportOutcome({ status: 'done', artifact: 'a' }, { status: 'done', artifact: 'a', duration_ms: 5 }, 5);
  assert.equal('lane_stats' in out2, false);
  assert.equal('key_index' in out2, false);
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
  const rr = apply(s, EV({ status: 'done', artifact: 'f', duration_ms: 5, lane_stats: { calls: 2, ok: 2 }, key_index: 1 }), '2026-09-19T00:00:01Z', NO_MILESTONE);
  const rec = rr.journal.find(j => j.kind === 'REPORT');
  assert.ok(rec, 'journal REPORT record exists');
  assert.deepEqual(rec.lane_stats, { calls: 2, ok: 2 });
  assert.equal(rec.key_index, 1);
  assert.deepEqual(rr.state.tasks['T-1'].last_result.lane_stats, { calls: 2, ok: 2 });
});

test('apply: legacy queue line without lane fields applies unchanged (compat)', () => {
  const s = world();
  const rr = apply(s, EV({ status: 'done', artifact: 'f', duration_ms: 5 }), '2026-09-19T00:00:01Z', NO_MILESTONE);
  const rec = rr.journal.find(j => j.kind === 'REPORT');
  assert.equal('lane_stats' in rec, false);
  assert.equal('key_index' in rec, false);
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
