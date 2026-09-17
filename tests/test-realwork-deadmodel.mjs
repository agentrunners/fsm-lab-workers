// T46/R2-FIX m-6/C: the realWork dead-model-slug fallthrough.
//
// Lens C finding: a dead/typo'd OPENROUTER_MODEL chain head returned
// 400/404 "not a valid model" → terminal work-class error-{status} → attempt
// burn → quarantine on a pure operator config mistake. The fix: 400/404 with
// "model" in the error body hops to the next model (config-infra class);
// exhaustion is infra_failed with the dead-model detail — net-zero, distinct
// in the audit trail, and the free-lane defaults remain reachable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { realWork } from '../worker/turn.mjs';

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, model: JSON.parse(opts.body).model });
    return { status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const envelope = { task_ref: { kind: 'state-task', id: 'T-404' }, prompt: 'x', budget: { lane_attempts: 2 } };

test('m-6: dead model slug 404 hops to the next model, lands done', async () => {
  let n = 0;
  const fetchImpl = async (url, opts) => {
    n += 1;
    if (n === 1) return { status: 404, json: async () => ({ error: { message: 'No allowed models for your configured model: typo/dead-slug' } }) };
    return { status: 200, json: async () => ({ choices: [{ message: { content: 'ok-after-hop' } }] }) };
  };
  const out = await realWork(envelope, { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl });
  assert.equal(out.status, undefined, 'not an infra/work failure');
  assert.equal(out.content, 'ok-after-hop');
  assert.equal(fetchImpl.calls ? fetchImpl.calls.length : n, 2, 'two lane attempts');
});

test('m-6: dead model slug 400 with model-error hops too', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { status: 400, json: async () => ({ error: { message: 'Invalid model specified' } }) };
    return { status: 200, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  const out = await realWork(envelope, { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl });
  assert.equal(out.content, 'recovered');
});

test('m-6: all-dead chain exhausts infra-class with dead-model detail', async () => {
  const fetchImpl = async () => ({ status: 404, json: async () => ({ error: { message: 'No allowed models for your model' } }) });
  const out = await realWork(envelope, { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl });
  assert.equal(out.status, 'infra_failed');
  assert.match(out.detail, /dead-model-404/);
  assert.match(out.detail, /lane-exhausted/);
});

test('m-6: a NON-model 4xx stays terminal work-class (no false hop)', async () => {
  const fetchImpl = fakeFetch(422, { error: { message: 'context length exceeded' } });
  const out = await realWork(envelope, { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl });
  assert.equal(out.status, undefined, 'not infra');
  assert.deepEqual(out.error, { status: 422 }, 'terminal app-class preserved');
  assert.equal(fetchImpl.calls.length, 1, 'no hop on non-model 4xx');
});

test('m-6: 404 WITHOUT model in the message stays terminal work-class', async () => {
  const fetchImpl = fakeFetch(404, { error: { message: 'resource not found' } });
  const out = await realWork(envelope, { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl });
  assert.deepEqual(out.error, { status: 404 });
  assert.equal(fetchImpl.calls.length, 1, 'no hop');
});
