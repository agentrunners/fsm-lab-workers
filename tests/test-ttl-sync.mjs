// T46/R2-FIX M-2/B + m-3/C: the TTL coupling supervisor.
//
// The X21 hot-fix 3 root cause: THREE hand-synced constants (worker.yml
// timeout-minutes, WORKER_TTL_MIN env, W2_WORKER_TTL_MIN in conductor-core)
// whose only coupling was prose comments. The 18-vs-50 drift wall-killed real
// turns at ~16min under 45-min leases with every gate green (lens B mutation
// #1: reverting the hot-fix left 245/245 green). This test reads the workflow
// YAMLs from the repo and asserts the coupling structurally — the next person
// to bump one site without the others fails THIS test, not a live epoch.
//
// Coupling contract:
//   worker.yml:    timeout-minutes === WORKER_TTL_MIN (the sleep-cap base)
//   conductor:     W2_WORKER_TTL_MIN === timeout-minutes - 2 (report margin)
//   conductor.yml: JOB_TTL_MIN === its timeout-minutes

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { W2_WORKER_TTL_MIN } from '../lib/conductor-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readWorkflow(name) {
  return readFileSync(join(root, '.github', 'workflows', name), 'utf8');
}

function extract(raw, re, label) {
  const m = raw.match(re);
  assert.ok(m, `${label}: pattern ${re} not found in the workflow YAML`);
  return m[1];
}

test('TTL sync: worker.yml timeout-minutes === WORKER_TTL_MIN === W2_WORKER_TTL_MIN + 2', () => {
  const yml = readWorkflow('worker.yml');
  const timeoutMin = Number(extract(yml, /timeout-minutes:\s*(\d+)/, 'worker timeout-minutes'));
  const ttlEnv = extract(yml, /WORKER_TTL_MIN:\s*'(\d+)'/, 'WORKER_TTL_MIN env');

  assert.ok(Number.isFinite(timeoutMin) && timeoutMin > 0, `worker timeout-minutes sane: ${timeoutMin}`);

  // the sleep-cap base must equal the job timeout (T45/F-G(a) margin lives in
  // the worker's own arithmetic: sleepCapMs = (WORKER_TTL_MIN - 2) minutes)
  assert.equal(ttlEnv, String(timeoutMin), 'WORKER_TTL_MIN env must equal worker.yml timeout-minutes');

  // the conductor's dispatch-deadline cap must equal timeout - 2 (the report
  // margin — the wall must leave room for the report enqueue before SIGTERM)
  assert.equal(
    W2_WORKER_TTL_MIN, timeoutMin - 2,
    `W2_WORKER_TTL_MIN (${W2_WORKER_TTL_MIN}) must equal worker.yml timeout-minutes (${timeoutMin}) - 2 (report margin)`
  );
});

test('TTL sync: conductor.yml JOB_TTL_MIN === its timeout-minutes', () => {
  const yml = readWorkflow('conductor.yml');
  const timeoutMin = Number(extract(yml, /timeout-minutes:\s*(\d+)/, 'conductor timeout-minutes'));
  const jobTtl = extract(yml, /JOB_TTL_MIN:\s*'(\d+)'/, 'JOB_TTL_MIN env');

  assert.equal(jobTtl, String(timeoutMin), 'JOB_TTL_MIN env must equal conductor.yml timeout-minutes');
});

// ---------------------------------------------------------------------------
// T46/W-C1 m-1 (the L2 fold): the TTL-LEASE CEILING pin — pure arithmetic.
// The design's §3c re-scope: the ceiling EXISTS (conductor-core's
// assembleDispatchPayload: deadline = min(lease, now + worker TTL) − margin);
// W-C1 ships only the pin. Three shapes: the SHORT lease wins, the LONG
// lease caps at the TTL (a task the job cannot host is never leased past
// it), and a lease expiring INSIDE the margin mints a PAST deadline — the
// worker's law-1 start-gate turns that into an immediate infra 'late-start'
// (cleaner than working past the lease into a guaranteed orphan).
// ---------------------------------------------------------------------------

test('m-1: the TTL-lease ceiling — deadline = min(leaseMs, dispatch+TTL) − margin, all three shapes', async () => {
  const { assembleDispatchPayload, W2_ENVELOPE_MARGIN_MS } = await import('../lib/conductor-core.mjs');
  const T0 = Date.parse('2026-09-17T10:00:00.000Z');
  const TASK = { id: 'T-1', title: 't', behavior: 'succeed', work_ms: 1 };
  const iso = (ms) => new Date(ms).toISOString();

  // shape 1: SHORT lease (10min) < TTL (48min) — the lease wins
  const short = JSON.parse(assembleDispatchPayload(
    { task: 'T-1', lease: 'l-x', behavior: 'succeed', attempt: 1, expires: iso(T0 + 10 * 60_000), chain: 'c' },
    TASK, null, { nowMs: T0 }).ox);
  assert.equal(short.deadline_ms, T0 + 10 * 60_000 - W2_ENVELOPE_MARGIN_MS, 'short lease: deadline = lease − margin');

  // shape 2: LONG lease (120min) > TTL (48min default) — the TTL caps
  const long = JSON.parse(assembleDispatchPayload(
    { task: 'T-1', lease: 'l-x', behavior: 'succeed', attempt: 1, expires: iso(T0 + 120 * 60_000), chain: 'c' },
    TASK, null, { nowMs: T0 }).ox);
  assert.equal(long.deadline_ms, T0 + 48 * 60_000 - W2_ENVELOPE_MARGIN_MS, 'long lease: the worker TTL caps (a task the job cannot host is never leased past it)');

  // shape 3: lease expiring INSIDE the margin — a PAST deadline (no floor:
  // the law-1 start-gate handles it as late-start, never a worked orphan)
  const past = JSON.parse(assembleDispatchPayload(
    { task: 'T-1', lease: 'l-x', behavior: 'succeed', attempt: 1, expires: iso(T0 + 60_000), chain: 'c' },
    TASK, null, { nowMs: T0 }).ox);
  assert.equal(past.deadline_ms, T0 + 60_000 - W2_ENVELOPE_MARGIN_MS, 'in-margin lease: the past deadline mints (the start-gate rejects)');
  assert.ok(past.deadline_ms < T0, 'it is genuinely in the past');
});
