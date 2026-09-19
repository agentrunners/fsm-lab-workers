// test-key-pool.mjs — the T46/W-D LANE C suite (D3 + the v2 fold B1/M5/M6):
// the OR key pool for the REAL lane.
//
// Pins, per the lane-C brief + the W-D review fold (lens-1 F2):
//   - the pick: pool[(fnv1a(task_ref.id) + rotation_retries) % pool.length]
//     — FNV-1a against the PUBLISHED 32-bit test vectors (the hash is
//     stable, not just self-consistent), determinism per task id, spread
//     across slots
//   - M5 rotation (widened by the fold): a 429 (quota) OR 401/402
//     (dead-key) hop advances the pool slot by ONE — the fallback hop
//     recovers on a healthy key; non-rotate infra (503/transport) stays
//     key-stable
//   - the empty pool → the legacy single-key behavior, BIT-FOR-BIT (the
//     result key set is pinned — no key_index/pool_size ride)
//   - the precedence seam: pool present + OPENROUTER_API_KEY present → the
//     header the fetch stub sees is the POOL key (the primary stays the
//     cc/paid lane's)
//   - M6: the CLI child env construction (ccChildEnv, the existing M-1
//     seam) never contains OPENROUTER_KEY_POOL
//   - B1: worker.yml's "Work the task" env block carries the ONE pool env
//     line; no other workflow references the pool (their secrets-free
//     contract is untouched)
//
// ZERO network: every realWork call drives an injected fetch stub; the cc
// seam is the PURE ccChildEnv merge; the YAML pin is a local file read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn, realWork, keyPool, fnv1a } from '../worker/turn.mjs';
import { ccChildEnv, CC_ENV_DENYLIST } from '../worker/cc-adapter.mjs';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okBody = (text) => ({ choices: [{ message: { content: text } }] });

// the envelope realWork consumes (the shape envelopeFromDispatch mints)
const env2 = (id, over = {}) => ({
  task_ref: { kind: 'state-task', id },
  prompt: 'p', deadline_ms: NOW + 600_000, session: 's',
  budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 },
  mode: 'real', attempt: 1,
  ...over,
});

// a realWork driver that captures the Authorization headers at the SEAM
async function drive(envelope, { env, responses }) {
  const headers = [];
  const models = [];
  const queue = [...responses];
  const raw = await realWork(envelope, {
    env,
    fetchImpl: async (url, init) => {
      headers.push(init.headers.Authorization);
      models.push(JSON.parse(init.body).model);
      const r = queue.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return { raw, headers, models };
}

const POOL = ['pool-key-0', 'pool-key-1', 'pool-key-2'];
const poolEnv = (over = {}) => ({ OPENROUTER_API_KEY: 'primary-paid-key', OPENROUTER_KEY_POOL: POOL.join(','), ...over });

// fnv1a('pool-pin-T1') = 2472543907 -> slot 1; T2 -> slot 0; T3 -> slot 2
// (computed against the published-vector-verified implementation; pinned as
// LITERALS below so a hash change cannot silently re-deal the fixtures)
const SLOT_T1 = 1;

// ---------------------------------------------------------------------------
// The hash + the parse (the pure halves).
// ---------------------------------------------------------------------------

test('pool: FNV-1a — the PUBLISHED 32-bit test vectors (the pick hash is stable, not self-consistent)', () => {
  assert.equal(fnv1a(''), 0x811c9dc5, 'offset basis (empty string)');
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
  assert.equal(fnv1a('pool-pin-T1'), 2472543907, 'the fixture literal the pins below re-use');
  assert.ok(fnv1a('x') <= 0xffffffff, 'unsigned 32-bit (the modulo stays non-negative)');
});

test('pool: keyPool parse — comma-split, trim, drop empties', () => {
  assert.deepEqual(keyPool({}), [], 'absent env -> empty pool');
  assert.deepEqual(keyPool({ OPENROUTER_KEY_POOL: '' }), [], 'empty string -> empty pool');
  assert.deepEqual(keyPool({ OPENROUTER_KEY_POOL: ' , , ' }), [], 'whitespace-only -> empty pool');
  assert.deepEqual(keyPool({ OPENROUTER_KEY_POOL: 'k1' }), ['k1'], 'single key, no comma');
  assert.deepEqual(keyPool({ OPENROUTER_KEY_POOL: ' k1 , k2 ,, k3 ' }), ['k1', 'k2', 'k3'], 'trim + empties dropped, ORDER preserved (registry order)');
  assert.deepEqual(keyPool({ OPENROUTER_KEY_POOL: 42 }), [], 'non-string env -> empty (fail-open to the legacy lane)');
});

// ---------------------------------------------------------------------------
// The pick — determinism, spread, precedence, the result shape.
// ---------------------------------------------------------------------------

test('pool: pick determinism — same task id -> same key (hash pinned with a fixed pool fixture)', async () => {
  const a = await drive(env2('pool-pin-T1'), { env: poolEnv(), responses: [jsonRes(200, okBody('first'))] });
  const b = await drive(env2('pool-pin-T1'), { env: poolEnv(), responses: [jsonRes(200, okBody('second'))] });
  assert.equal(a.headers[0], `Bearer ${POOL[SLOT_T1]}`, 'the pinned slot (fnv1a=2472543907 % 3 = 1)');
  assert.equal(b.headers[0], `Bearer ${POOL[SLOT_T1]}`, 'a separate invocation re-picks the SAME key (idempotent re-dispatch)');
});

test('pool: pick spread — distinct task ids land across the pool slots', async () => {
  const slots = new Set();
  for (const id of ['pool-pin-T1', 'pool-pin-T2', 'pool-pin-T3', 'pool-pin-T4', 'pool-pin-T5']) {
    const { headers } = await drive(env2(id), { env: poolEnv(), responses: [jsonRes(200, okBody('x'))] });
    slots.add(headers[0]);
  }
  assert.equal(slots.size, 3, 'five task ids cover all three slots (the load spreads)');
});

test('pool: precedence — pool + OPENROUTER_API_KEY both present -> the REAL lane header is the POOL key', async () => {
  const { headers, raw } = await drive(env2('pool-pin-T1'), { env: poolEnv(), responses: [jsonRes(200, okBody('from the pool'))] });
  assert.equal(headers[0], `Bearer ${POOL[SLOT_T1]}`, 'the pool key serves the real (free) lane');
  assert.notEqual(headers[0], 'Bearer primary-paid-key', 'the primary secret does NOT serve this lane while the pool is set');
  assert.equal(raw.key_index, SLOT_T1, 'the 0-based pool slot rides the raw result');
  assert.equal(raw.pool_size, 3);
});

test('pool: result shape — key_index/pool_size ride ONLY when the pool is set (the seam for lane B\'s M4 fold)', async () => {
  const done = await drive(env2('pool-pin-T2'), { env: poolEnv(), responses: [jsonRes(200, okBody('k'))] });
  // W-D integration: hop_telemetry is lane A's unconditional realWork field —
  // the union key-set is lane C's pool pins + lane A's telemetry pin.
  assert.deepEqual(Object.keys(done.raw).sort(), ['content', 'duration_ms', 'hop_telemetry', 'key_index', 'lane_attempts_used', 'models', 'pool_size', 'telemetry'], 'the done shape gains exactly key_index + pool_size (over the hop_telemetry baseline)');
  const burned = await drive(env2('pool-pin-T2'), { env: poolEnv(), responses: [jsonRes(429, {}), jsonRes(429, {})] });
  assert.equal(burned.raw.status, 'infra_failed');
  assert.equal(burned.raw.key_index, (fnv1a('pool-pin-T2') + 1) % 3, 'lane-exhaustion reports the LAST (burned) slot');
  assert.equal(burned.raw.pool_size, 3);
});

// ---------------------------------------------------------------------------
// M5 — the quota-class rotation.
// ---------------------------------------------------------------------------

test('pool: M5 quota rotation — a 429 hop advances the pool slot by ONE (the burned key\'s retry lands on the next key)', async () => {
  const { headers, models, raw } = await drive(env2('pool-pin-T1'), {
    env: poolEnv(),
    responses: [jsonRes(429, { error: { message: 'free-models-per-day quota exceeded' } }), jsonRes(200, okBody('rotated onto the next key'))],
  });
  assert.deepEqual(models.length, 2, 'the model hop still fires (the existing ladder)');
  assert.deepEqual(headers, [`Bearer ${POOL[1]}`, `Bearer ${POOL[2]}`], 'slot 1 -> slot 2: the 429 advanced the index by exactly one');
  assert.equal(raw.content, 'rotated onto the next key');
  assert.equal(raw.key_index, 2, 'the serving slot is reported');
});

test('pool: M5 scope — NON-rotate infra (503 / transport) keeps the key stable; the rotate class is 429/401/402', async () => {
  const s503 = await drive(env2('pool-pin-T1'), {
    env: poolEnv(),
    responses: [jsonRes(503, {}), jsonRes(200, okBody('after a 5xx'))],
  });
  assert.deepEqual(s503.headers, [`Bearer ${POOL[1]}`, `Bearer ${POOL[1]}`], 'a 5xx hops the MODEL but not the key');
  const transport = await drive(env2('pool-pin-T1'), {
    env: poolEnv(),
    responses: [Object.assign(new Error('fetch failed'), { name: 'TimeoutError' }), jsonRes(200, okBody('after a transport'))],
  });
  assert.deepEqual(transport.headers, [`Bearer ${POOL[1]}`, `Bearer ${POOL[1]}`], 'a transport throw keeps the key');
});

test('pool: M5 wrap — the rotation wraps at the pool boundary', async () => {
  // slot for pool-pin-T3 is 2; +1 wraps to 0
  const { headers } = await drive(env2('pool-pin-T3'), {
    env: poolEnv(),
    responses: [jsonRes(429, {}), jsonRes(200, okBody('wrapped'))],
  });
  assert.deepEqual(headers, [`Bearer ${POOL[2]}`, `Bearer ${POOL[0]}`], '(2+1) % 3 = 0 — bounded rotation wraps');
});

// T46/W-D review fold (lens-1 F2) — the DEAD-KEY rotation: a 401/402 means
// the KEY is dead (revoked/invalid/credits-dead). The model is fine; burning
// the turn's fallback hop on the SAME dead key quarantine-kills every task
// hashed onto it (the finding's deterministic failure mode). Rotating lets
// hop 2 recover on a healthy key.
test('pool: dead-key rotation (the fold, lens-1 F2) — a 401/402 hop advances the pool slot by ONE (the fallback hop recovers on the next key)', async () => {
  const dead401 = await drive(env2('pool-pin-T1'), {
    env: poolEnv(),
    responses: [jsonRes(401, {}), jsonRes(200, okBody('recovered on the next key'))],
  });
  assert.deepEqual(dead401.headers, [`Bearer ${POOL[1]}`, `Bearer ${POOL[2]}`], 'a 401 advances the slot by exactly one (the dead-key class rotates)');
  assert.equal(dead401.raw.content, 'recovered on the next key');
  assert.equal(dead401.raw.key_index, 2, 'the serving (recovering) slot is reported');
  const dead402 = await drive(env2('pool-pin-T1'), {
    env: poolEnv(),
    responses: [jsonRes(402, {}), jsonRes(200, okBody('after the credits-death rotation'))],
  });
  assert.deepEqual(dead402.headers, [`Bearer ${POOL[1]}`, `Bearer ${POOL[2]}`], 'a 402 (credits-dead) rotates identically');
  // BOTH hops dead → lane-exhaustion names the 401 class and reports the
  // LAST (rotated-onto) slot — the operator's swap-the-secret signal
  const burned = await drive(env2('pool-pin-T1'), {
    env: poolEnv(),
    responses: [jsonRes(401, {}), jsonRes(401, {})],
  });
  assert.equal(burned.raw.status, 'infra_failed');
  assert.match(burned.raw.detail, /lane-exhausted\(2\/3 lanes, last lane-401\)/);
  assert.equal(burned.raw.key_index, (fnv1a('pool-pin-T1') + 1) % 3, 'the rotated-onto slot is the reported one');
});

// ---------------------------------------------------------------------------
// The empty pool — the legacy lane, bit-for-bit.
// ---------------------------------------------------------------------------

test('pool: empty pool -> today\'s behavior BIT-FOR-BIT (the regression pin)', async () => {
  for (const absent of [undefined, '', ' , , ']) {
    const { headers, raw } = await drive(env2('pool-pin-T1'), {
      env: { OPENROUTER_API_KEY: 'legacy-primary', ...(absent === undefined ? {} : { OPENROUTER_KEY_POOL: absent }) },
      responses: [jsonRes(200, okBody('legacy lane'))],
    });
    assert.equal(headers[0], 'Bearer legacy-primary', `pool=${JSON.stringify(absent)} -> the primary secret serves the lane`);
    // W-D integration: the integrated baseline carries lane A's hop_telemetry
    // (unconditional); the pin's intent — NO pool keys without a pool — is
    // unchanged.
    assert.deepEqual(Object.keys(raw).sort(), ['content', 'duration_ms', 'hop_telemetry', 'lane_attempts_used', 'models', 'telemetry'], 'NO key_index/pool_size keys — the legacy result shape + lane A\'s hop_telemetry');
  }
});

test('pool: empty pool + rotation input — a 429 hop stays on the primary (no pool, no rotation)', async () => {
  const { headers } = await drive(env2('pool-pin-T1'), {
    env: { OPENROUTER_API_KEY: 'legacy-primary' },
    responses: [jsonRes(429, {}), jsonRes(200, okBody('still the primary'))],
  });
  assert.deepEqual(headers, ['Bearer legacy-primary', 'Bearer legacy-primary']);
});

// ---------------------------------------------------------------------------
// The routing integration — the pick survives the FULL turn path.
// ---------------------------------------------------------------------------

test('pool: full turn (runTurn, mode=real) — the pool key rides the wire through the routing path', async () => {
  const fetches = [];
  const r = await runTurn({
    cp: { task: 'pool-pin-T1', lease: 'l-1', behavior: null, attempt: 1, work_ms: 1, expires: iso(NOW + 900_000), chain: 'c-1', mode: 'real' },
    runId: '99883', runAttempt: '1',
    env: poolEnv(),
    fetchImpl: async (u, init) => { fetches.push(init.headers.Authorization); return jsonRes(200, okBody('the routed answer')); },
    enqueue: async () => ({ ok: true }),
    sleepImpl: async () => {},
    now: () => NOW,
    log: () => {},
    stepSummaryPath: null,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.outcome.status, 'done');
  assert.deepEqual(fetches, [`Bearer ${POOL[SLOT_T1]}`], 'the legacy-minimal ASSIGN path picks the pool key (task id = the hash scope)');
});

// ---------------------------------------------------------------------------
// M6 — the CLI child env never sees the pool.
// ---------------------------------------------------------------------------

test('pool: M6 denylist — OPENROUTER_KEY_POOL joins CC_ENV_DENYLIST and never rides the CLI child env', () => {
  assert.ok(CC_ENV_DENYLIST.includes('OPENROUTER_KEY_POOL'), 'the denylist carries the pool entry');
  const POOL_SECRET = 'sk-or-v1-pool-secret-value';
  const callerEnv = {
    PATH: '/usr/bin:/bin', HOME: '/home/worker',
    OPENROUTER_API_KEY: 'k1', OPENROUTER_API_KEY_2: 'k2',
    OPENROUTER_KEY_POOL: `${POOL_SECRET},${POOL_SECRET}-b`,
    GH_TOKEN: 'gh', GITHUB_TOKEN: 'gh2',
  };
  const lane = { key: 'k1', keyIndex: 1, model: 'm/a' };
  const envelope = { task_ref: { kind: 'state-task', id: 'T9' }, deadline_ms: NOW + 600_000 };
  for (const [label, extra] of [['direct', {}], ['bridge', { CC_BRIDGE_URL: 'http://127.0.0.1:45678' }]]) {
    const merged = ccChildEnv(callerEnv, lane, envelope, extra);
    assert.ok(!('OPENROUTER_KEY_POOL' in merged), `${label} mode: the pool var is dead in the merged child env`);
    assert.ok(!JSON.stringify(merged).includes(POOL_SECRET), `${label} mode: NO pool key VALUE leaks through any env slot`);
    assert.equal(merged.PATH, '/usr/bin:/bin', `${label} mode: the working env still rides`);
  }
});

// ---------------------------------------------------------------------------
// B1 — the workflow env line.
// ---------------------------------------------------------------------------

test('pool: B1 workflow pin — worker.yml\'s "Work the task" env carries the ONE pool line; no other workflow does', () => {
  const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.includes('worker.yml'), 'worker.yml is present');
  for (const f of files) {
    const text = readFileSync(join(workflowsDir, f), 'utf8');
    if (f === 'worker.yml') {
      const line = "OPENROUTER_KEY_POOL: ${{ secrets.OPENROUTER_KEY_POOL || '' }}";
      assert.ok(text.includes(line), 'the exact B1 env line (secrets-bound, empty-string fallback)');
      const step = text.indexOf('name: Work the task');
      const at = text.indexOf(line);
      const run = text.indexOf('run: node worker/turn.mjs');
      assert.ok(step !== -1 && at > step && at < run, 'the line rides INSIDE the Work-the-task step env block (before the run)');
    } else {
      assert.ok(!text.includes('OPENROUTER_KEY_POOL'), `${f}: the secrets-free contract is untouched (no pool reference)`);
    }
  }
});
