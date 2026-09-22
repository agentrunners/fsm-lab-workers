// e2e/staged/lib.mjs — the STAGED DRIVERS' shared transport (s22 design §8
// B-0 item 2). Mirrors the pure-half/IO-half discipline (the ops/console.mjs
// shape): every driver keeps its decision core PURE and injects these seams;
// tests import the pure halves and never touch this file's I/O.
//
// The seams follow the repo's established patterns:
//   - api(): the T9 (s21) GITHUB_API_URL seam — GHA sets the env itself;
//     unset -> the literal https://api.github.com, byte-identical (the same
//     line conductor/turn.mjs:45 and intake/turn.mjs:25 carry).
//   - retryAsync(): the nudge-retry pattern (intake/turn.mjs:70-75 — one
//     retry with backoff; §7 F3: seed writes 2 attempts, verify reads 3).
//   - emitOutput()/emitSummary(): the GITHUB_OUTPUT / GITHUB_STEP_SUMMARY
//     file-append protocol (no-op outside a runner — local runs just print).
//   - epochSegment(): the epoch-boundary walk — the SAME rule ops/console.mjs
//     epochSpend uses (from the END backward, newest APPLIED `CONTROL reset`
//     bounds the epoch; REJECTED/reset-duplicate records never bound it),
//     returning the boundary record + the records after it (the spend walker
//     only sums; the verifier needs the segment itself).

import { appendFileSync } from 'node:fs';

export const REPO_DEFAULT = 'claudecode-headless/fsm-lab';
export const MIRROR_REPO_DEFAULT = 'agentrunners/fsm-lab-workers';

// §3.4: the drill's own alert label — deliberately NOT `fsm-watchdog-alert`
// (the machine's alert lanes search `state=open&labels=fsm-watchdog-alert`
// and take the first hit, watchdog/scan.mjs:76-79 — an open drill-RED issue
// with that label would ABSORB the next REAL watchdog alert's comments into
// a drill thread, mixing lanes).
export const RED_LABEL = 'fsm-staged-red';

export function apiBase() {
  return process.env.GITHUB_API_URL || 'https://api.github.com';
}

export function repoName() {
  return process.env.GITHUB_REPOSITORY || REPO_DEFAULT;
}

// The REST seam (the conductor/intake/watchdog api() shape, token-pluggable:
// GH_TOKEN for same-repo calls, LAB_PAT for the cross-repo mirror lane).
export async function api(path, { method = 'GET', body = null, token = process.env.GH_TOKEN || process.env.LAB_PAT || '', userAgent = 'fsm-lab-staged' } = {}) {
  const r = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies */ }
  return { status: r.status, data };
}

// The retry ladder (intake/turn.mjs:70-75's shape generalized): attempts total,
// fixed backoff between them. Returns the LAST attempt's result. `fn` results
// carry { ok: bool, ... } when retryability is decidable; raw fetch results
// (no `ok` key) are returned as-is after the full ladder.
export async function retryAsync(fn, { attempts = 2, backoffMs = 2000, onRetry = null } = {}) {
  let r = await fn();
  for (let i = 1; i < attempts; i++) {
    if (!r || typeof r !== 'object' || r.ok === true) return r;
    if (onRetry) onRetry(i, r);
    await new Promise(res => setTimeout(res, backoffMs));
    r = await fn();
  }
  return r;
}

// GITHUB_OUTPUT protocol — a no-op locally (the env var exists only on a runner).
export function emitOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  const line = `${key}=${String(value ?? '')}\n`;
  if (f) { try { appendFileSync(f, line); } catch { /* local/no-op */ } }
  return line;
}

// GITHUB_STEP_SUMMARY protocol — same no-op discipline.
export function emitSummary(markdown) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { appendFileSync(f, markdown.endsWith('\n') ? markdown : markdown + '\n'); } catch { /* local/no-op */ } }
}

export function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ----------------------------------------------------------------------------
// epochSegment(journalRecords) -> { boundary, records }
//
// The s22 §3.1 scoping rule: records AFTER the newest applied `CONTROL reset`
// boundary — "the same walk epochSpend uses" (ops/console.mjs:87-104). This
// scopes the drill's asserts to TONIGHT's epoch even with 16 generations of
// prior history on the branch. REJECTED / reset-duplicate / applied:false
// records never bound the scan (an unapplied reset is not a boundary).
// No boundary -> { boundary: null, records: [] } (no epoch ever ran — the
// bootstrap shape; the verdict's no-epoch path).
// ----------------------------------------------------------------------------
export function epochSegment(journalRecords) {
  const recs = Array.isArray(journalRecords) ? journalRecords : [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r && typeof r === 'object' && r.kind === 'CONTROL' && r.command === 'reset' && r.applied !== false) {
      return { boundary: r, records: recs.slice(i + 1) };
    }
  }
  return { boundary: null, records: [] };
}

// toMs(x) — accept an ISO string | Date | epoch-ms number (the window inputs
// arrive from env strings and fixtures alike); NaN when unparseable.
export function toMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  if (typeof x === 'string') return Date.parse(x);
  return NaN;
}
