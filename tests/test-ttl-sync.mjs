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
