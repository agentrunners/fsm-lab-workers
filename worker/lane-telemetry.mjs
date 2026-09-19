// lane-telemetry.mjs — T46/W-D lane B (§D4 as amended by the v2 fold:
// M2's bridge JSONL stat, M3's drain carry, M4's allowlist — the G2/G3/G4
// signals captured at the source).
//
// THE CONTRACT (M2, v2 fold — the review's amendment REPLACED the v1
// in-memory stat + shutdown handshake): the bridge appends ONE JSON line per
// upstream call to the file at env BRIDGE_LANE_LOG (path provided by the
// adapter; default <cwd>/bridge-lane.jsonl when the bridge is spawned
// standalone). Append-only fs write per request — the file SURVIVES the
// adapter's group-scoped SIGKILL of the bridge (no graceful shutdown exists
// by design; cc-bridge.mjs:266-272 — the FILE is the contract). The adapter
// reads + aggregates + DELETES the file after the turn (turn-scoped scratch
// in its OWN temp dir, NOT the CLI workdir — scanWorkdir would otherwise
// claim the telemetry file as a CLI write-back artifact).
//
// THE LINE (the brief's exact field set, this order):
//   {ts, model, status, ms, tokens_in, tokens_out, cost, rate_class, err_code}
//     ts          epoch-ms at request start
//     model       the pinned lane model (the bridge's LANE_MODEL)
//     status      the upstream HTTP status (null on a transport failure)
//     ms          the FULL exchange duration (request -> last forwarded byte)
//     tokens_in   usage.input_tokens | usage.prompt_tokens (SSE frames
//                 included — max across frames; null when the body carried
//                 no parseable usage: the m7 documented accept-null state)
//     tokens_out  usage.output_tokens | usage.completion_tokens (cumulative
//                 message_delta frames -> max wins)
//     cost        usage.cost when present (null when absent — SSE emission
//                 of cost on the Anthropic-compat surface is UNVERIFIED, the
//                 eval's own extractor read 0; null is honest, 0-by-accident
//                 is not)
//     rate_class  the quota-bucket identity: 429 body "limit_source" >
//                 first *ratelimit*limit* response header ("rl:<value>") >
//                 'rate_limit' fallback on a bare 429 > null
//     err_code    non-2xx: the body's error.type | error.code (Anthropic
//                 shape first, OpenRouter-native second); transport failure:
//                 the error NAME (set by the bridge, not by the parse)
//
// The AGGREGATE the adapter attaches as `lane_stats` (the brief's required
// set + the additive `models` sub-map the console's per-model rows need):
//   {calls, ok, err429, err5xx, tokens, cost, p50_ms, p95_ms,
//    rate_classes:{}, models:{<slug>:{calls,ok,err429,err5xx,tokens,cost,
//    p50_ms,p95_ms}}}
//
// Pure functions ONLY — the bridge (a spawned script with import-time side
// effects) and the adapter both import THIS module, so the tests pin the
// math without spawning anything. collectLaneStats is the one fs-touching
// entry (read + aggregate + delete — the workdir-hygiene contract).

import { readFileSync, rmSync } from 'node:fs';

const LIMIT_SOURCE_RE = /"limit_source"\s*:\s*"([^"]+)"/;

// ---------------------------------------------------------------------------
// the line
// ---------------------------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// laneLogLine({...}) — the exact 9-key JSONL record; unknown/absent values
// land as null (never dropped keys, never coerced garbage).
export function laneLogLine({ ts, model, status, ms, tokens_in, tokens_out, cost, rate_class, err_code }) {
  return {
    ts: num(ts),
    model: typeof model === 'string' && model !== '' ? model : null,
    status: num(status),
    ms: num(ms),
    tokens_in: num(tokens_in),
    tokens_out: num(tokens_out),
    cost: num(cost),
    rate_class: typeof rate_class === 'string' && rate_class !== '' ? rate_class : null,
    err_code: err_code === undefined || err_code === null ? null : err_code,
  };
}

// ---------------------------------------------------------------------------
// parseLaneTelemetry — the response-body/header extraction (PURE)
// ---------------------------------------------------------------------------

// collect one usage object's counters into acc (max semantics — SSE deltas
// are cumulative, whole-body usage is final; max converges either way).
function collectUsage(u, acc) {
  if (!u || typeof u !== 'object') return;
  const tin = u.input_tokens ?? u.prompt_tokens;
  const tout = u.output_tokens ?? u.completion_tokens;
  if (Number.isFinite(tin)) acc.tokens_in = Math.max(acc.tokens_in ?? 0, tin);
  if (Number.isFinite(tout)) acc.tokens_out = Math.max(acc.tokens_out ?? 0, tout);
  if (Number.isFinite(u.cost)) acc.cost = Math.max(acc.cost ?? 0, u.cost);
}

// walk the known usage spots on one parsed JSON frame: top-level usage
// (whole-body + OpenRouter-native), message.usage (Anthropic message_start),
// delta.usage (Anthropic message_delta — cumulative output tokens).
function usageSpots(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return [obj.usage, obj.message?.usage, obj.delta?.usage];
}

// parseLaneTelemetry({status, headers, bodyText}) ->
//   {tokens_in, tokens_out, cost, rate_class, err_code} (each possibly null)
//
// Handles BOTH surface shapes the bridge forwards: whole-body JSON (the
// non-streaming completion + every error body) and Anthropic SSE (the
// `data: {...}` frames — the tee-scan accumulates the full text). A body
// that parses as neither still yields the regex-extractable signals
// (limit_source) and the header-derived rate class — telemetry never turns
// an unparseable body into an error.
export function parseLaneTelemetry({ status, headers = {}, bodyText = '' }) {
  const acc = { tokens_in: null, tokens_out: null, cost: null };
  let errCode = null;

  const handleObj = (obj) => {
    for (const u of usageSpots(obj)) collectUsage(u, acc);
    const e = obj.error;
    if (e && typeof e === 'object') {
      if (e.type !== undefined && e.type !== null) errCode = errCode ?? e.type;
      else if (e.code !== undefined && e.code !== null) errCode = errCode ?? e.code;
    } else if (obj.type !== undefined && typeof obj.type === 'string' && /_error$/.test(obj.type)) {
      // the Anthropic SSE error frame shape: {type: '<t>_error', ...} with no
      // nested error object
      errCode = errCode ?? obj.type;
    }
  };

  const text = String(bodyText ?? '');
  let whole = null;
  try {
    whole = JSON.parse(text);
    if (whole === null || typeof whole !== 'object' || Array.isArray(whole)) whole = null;
  } catch { /* SSE or garbage — the frame walk below handles SSE */ }
  if (whole) {
    handleObj(whole);
  } else {
    for (const line of text.split('\n')) {
      const m = /^data:\s*(\{.*\})\s*$/.exec(line);
      if (!m) continue;
      try {
        const f = JSON.parse(m[1]);
        if (f && typeof f === 'object' && !Array.isArray(f)) handleObj(f);
      } catch { /* torn frame — skip */ }
    }
  }

  // rate_class: limit_source (any nesting — the regex reads the raw text so
  // it works on parseable AND unparseable bodies) > the first rate-limit
  // LIMIT header (identifies the key's tier bucket) > the bare-429 fallback.
  let rateClass = null;
  const ls = LIMIT_SOURCE_RE.exec(text);
  if (ls) rateClass = ls[1];
  if (rateClass === null) {
    const h = Object.entries(headers)
      .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && v !== '' && /ratelimit/.test(k) && /limit/.test(k))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (h.length) rateClass = `rl:${h[0][1]}`;
  }
  if (rateClass === null && status === 429) rateClass = 'rate_limit';

  return {
    tokens_in: acc.tokens_in, tokens_out: acc.tokens_out, cost: acc.cost,
    rate_class: rateClass, err_code: errCode,
  };
}

// ---------------------------------------------------------------------------
// the aggregate (PURE)
// ---------------------------------------------------------------------------

// percentile(sortedValues, q) — nearest-rank: idx = min(n-1, floor(q*n)).
// Documented + pinned so the console/adapter share ONE definition.
export function percentile(sortedValues, q) {
  const n = sortedValues.length;
  if (n === 0) return null;
  return sortedValues[Math.min(n - 1, Math.floor(q * n))];
}

// aggregateLaneStats(lines) -> the lane_stats object | null (no lines).
// Transport-failure lines (status null) count in `calls` and carry their ms
// into the percentiles, but land in NONE of ok/err429/err5xx — honest, not
// silently reclassified.
export function aggregateLaneStats(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const agg = {
    calls: 0, ok: 0, err429: 0, err5xx: 0, tokens: 0, cost: 0,
    p50_ms: null, p95_ms: null, rate_classes: {}, models: {},
  };
  const msAll = [];
  for (const l of lines) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue;
    agg.calls += 1;
    const st = typeof l.status === 'number' && Number.isFinite(l.status) ? l.status : null;
    if (st !== null && st >= 200 && st < 300) agg.ok += 1;
    else if (st === 429) agg.err429 += 1;
    else if (st !== null && st >= 500 && st < 600) agg.err5xx += 1;
    const tin = Number.isFinite(l.tokens_in) ? l.tokens_in : 0;
    const tout = Number.isFinite(l.tokens_out) ? l.tokens_out : 0;
    const cost = Number.isFinite(l.cost) ? l.cost : 0;
    agg.tokens += tin + tout;
    agg.cost += cost;
    if (l.rate_class !== null && l.rate_class !== undefined && l.rate_class !== '') {
      agg.rate_classes[l.rate_class] = (agg.rate_classes[l.rate_class] || 0) + 1;
    }
    if (Number.isFinite(l.ms)) msAll.push(l.ms);
    const slug = typeof l.model === 'string' && l.model !== '' ? l.model : '(unknown)';
    const mm = agg.models[slug] || (agg.models[slug] = {
      calls: 0, ok: 0, err429: 0, err5xx: 0, tokens: 0, cost: 0, p50_ms: null, p95_ms: null, _ms: [],
    });
    mm.calls += 1;
    if (st !== null && st >= 200 && st < 300) mm.ok += 1;
    else if (st === 429) mm.err429 += 1;
    else if (st !== null && st >= 500 && st < 600) mm.err5xx += 1;
    mm.tokens += tin + tout;
    mm.cost += cost;
    if (Number.isFinite(l.ms)) mm._ms.push(l.ms);
  }
  if (msAll.length) {
    const s = [...msAll].sort((a, b) => a - b);
    agg.p50_ms = percentile(s, 0.5);
    agg.p95_ms = percentile(s, 0.95);
  }
  for (const mm of Object.values(agg.models)) {
    if (mm._ms.length) {
      const s = [...mm._ms].sort((a, b) => a - b);
      mm.p50_ms = percentile(s, 0.5);
      mm.p95_ms = percentile(s, 0.95);
    }
    delete mm._ms;
  }
  return agg;
}

// ---------------------------------------------------------------------------
// collectLaneStats — the adapter's runtime entry (the one fs touch)
// ---------------------------------------------------------------------------

// collectLaneStats(path) -> the aggregate | null. Reads the JSONL (tolerant:
// unparseable lines are skipped — they cannot aggregate), aggregates, then
// DELETES the file (turn-scoped scratch hygiene; a later lane never re-reads
// a consumed turn's lines). A missing/unreadable file is null (fake mode,
// bridge spawn failure, or a turn whose CLI never reached the model).
export function collectLaneStats(path) {
  if (typeof path !== 'string' || path === '') return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const lines = [];
  for (const t of raw.split('\n')) {
    const s = t.trim();
    if (!s) continue;
    try { lines.push(JSON.parse(s)); } catch { /* unparseable — skipped */ }
  }
  const agg = aggregateLaneStats(lines);
  try { rmSync(path, { force: true }); } catch { /* best-effort hygiene */ }
  return agg;
}
