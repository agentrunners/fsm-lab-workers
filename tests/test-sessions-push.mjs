// test-sessions-push.mjs — the s25/b1 sessions-push suite (the X29 F3/F2
// transcript-lane rebuild, unit boundary).
// Pins worker/sessions-push.mjs — the shared contents-API engine BOTH
// adapters' real-mode transcript lane now rides — with a scripted fetch
// (zero network, zero npm — the mock-first doctrine; fetchImpl/sleepImpl/
// rand are the injected seams the helper was built around):
//   - the create path: GET 404 → PUT 201 (no sha, base64 content, branch,
//     the per-file message)
//   - the update path: GET 200 {sha} → PUT 200 WITH the captured sha —
//     THE MUTATION SPOT (drop the sha from the update PUT and the pin
//     fails: every update push 422s server-side)
//   - the 409 absorber: PUT 409 (the ref moved between GET and PUT) →
//     fresh GET (a NEW sha) → PUT lands; the ladder's sleep + jitter
//     arithmetic pinned through the injected clock/rand
//   - the aggregate failure: one file exhausts the 3-attempt ladder, one
//     fails fatally (401 — no theater) → ONE throw carrying BOTH files'
//     errors (the done-turn escalation's diagnosis)
//   - THE F2 SEAM: sessionsRepoFromEnv/sessionsTokenFromEnv — the custom
//     FSM_SESSIONS_* names win, the GITHUB_REPOSITORY/GH_TOKEN legacy pair
//     backs compat, absent → null
//   - the 1 MiB fail-loud guard, the T9 GITHUB_API_URL seam, the auth
//     header shape, the network-error retry class, the arg guards

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pushSessionFiles,
  sessionsRepoFromEnv,
  sessionsTokenFromEnv,
  SESSIONS_FILE_MAX_BYTES,
  SESSIONS_PUT_ATTEMPTS,
  SESSIONS_RETRY_BACKOFF_MS,
} from '../worker/sessions-push.mjs';

// the scripted fetch: every call is captured (url/method/headers/parsed
// body) and answered by the test's respond() — the response shape is
// exactly what ghJson consumes (status + text()).
function mockFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const r = respond(call, calls.length, calls);
    return { status: r.status, text: async () => (r.data === undefined ? '' : JSON.stringify(r.data)) };
  };
  return { fetchImpl, calls };
}

// the deterministic sleep/rand pair: rand()=0.5 → jitter factor exactly 1.0
// (the ladder tier, unscaled) — the sleeps array IS the observed backoff.
const noSleep = (sleeps) => (ms) => { sleeps.push(ms); return Promise.resolve(); };
const randMid = () => 0.5;

const FILE = (path, content = 'body\n', message = `transcript: ${path}`) => ({ path, content, message });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const BASE_ARGS = { repo: 'claudecode-headless/fsm-lab', token: 'tok-1', branch: 'fsm-sessions' };

// ---------------------------------------------------------------------------
// The create path (GET 404 → PUT 201).
// ---------------------------------------------------------------------------

test('create path: GET 404 → PUT 201 — no sha, base64 content, the branch, the per-file message', async () => {
  const { fetchImpl, calls } = mockFetch((c) => (c.method === 'GET' ? { status: 404, data: { message: 'Not Found' } } : { status: 201, data: { content: { sha: 'newblob' } } }));
  const r = await pushSessionFiles({ ...BASE_ARGS, files: [FILE('sessions/T-1/run1-a1.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid });
  assert.equal(r.mode, 'pushed');
  assert.equal(r.branch, 'fsm-sessions');
  assert.equal(r.repo, BASE_ARGS.repo);
  assert.deepEqual(r.files, ['sessions/T-1/run1-a1.txt']);
  assert.equal(calls.length, 2, 'exactly one GET + one PUT on the happy create');
  assert.match(calls[0].url, /\/repos\/claudecode-headless\/fsm-lab\/contents\/sessions\/T-1\/run1-a1\.txt\?ref=fsm-sessions$/, 'the GET carries the ref');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://api.github.com/repos/claudecode-headless/fsm-lab/contents/sessions/T-1/run1-a1.txt');
  assert.equal(calls[1].body.message, 'transcript: sessions/T-1/run1-a1.txt', 'the per-file message');
  assert.equal(calls[1].body.content, b64('body\n'), 'content is base64-of-utf8, built HERE never at the caller');
  assert.equal(calls[1].body.branch, 'fsm-sessions');
  assert.equal('sha' in calls[1].body, false, 'the CREATE path carries no sha — a sha on a 404 path would 422');
});

// ---------------------------------------------------------------------------
// The update path (GET 200 {sha} → PUT 200 WITH the sha) — THE MUTATION
// SPOT lives on this pin.
// ---------------------------------------------------------------------------

test('update path: GET 200 {sha} → PUT 200 carries the CAPTURED sha — the update-CAS contract', async () => {
  const { fetchImpl, calls } = mockFetch((c) => (c.method === 'GET' ? { status: 200, data: { sha: 'blobsha-AAA', content: 'x' } } : { status: 200, data: { content: { sha: 'blobsha-BBB' } } }));
  const r = await pushSessionFiles({ ...BASE_ARGS, files: [FILE('sessions/T-2/run2-a2.txt', 'v2 body')], fetchImpl, sleepImpl: noSleep([]), rand: randMid });
  assert.equal(r.mode, 'pushed');
  assert.equal(calls.length, 2);
  // MUTATION SPOT (invert-me): drop the `sha` param from the update-path PUT
  // body in putSessionFile (worker/sessions-push.mjs) and THIS pin fails —
  // every transcript update on an existing path 422s server-side ("sha
  // wasn't supplied"), i.e. every re-attempt/continuation turn's transcript
  // push dies after the ladder. The sha IS the contents-API update CAS.
  assert.equal(calls[1].body.sha, 'blobsha-AAA', 'the PUT carries the sha the GET captured');
  assert.equal(calls[1].body.content, b64('v2 body'));
});

// ---------------------------------------------------------------------------
// The 409 absorber (the ref moved between GET and PUT).
// ---------------------------------------------------------------------------

test('409 retry: PUT 409 → FRESH GET (a new sha) → PUT lands — the stale-sha absorber, with the backoff ladder + jitter', async () => {
  const sleeps = [];
  let putCount = 0;
  const { fetchImpl, calls } = mockFetch((c) => {
    if (c.method === 'GET') return { status: 200, data: { sha: putCount === 0 ? 'sha-stale' : 'sha-fresh' } };
    putCount += 1;
    return putCount === 1 ? { status: 409, data: { message: 'conflict: the ref moved' } } : { status: 200, data: { content: { sha: 'x' } } };
  });
  const r = await pushSessionFiles({ ...BASE_ARGS, files: [FILE('sessions/T-3/run3-a1.txt')], fetchImpl, sleepImpl: noSleep(sleeps), rand: randMid });
  assert.equal(r.mode, 'pushed', 'the 409 was absorbed, not escalated');
  assert.deepEqual(sleeps, [SESSIONS_RETRY_BACKOFF_MS[0]], 'one backoff tier between the two attempts (rand=0.5 → the tier unscaled)');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2, 'the retry took a FRESH GET');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
  assert.equal(calls[3].body.sha, 'sha-fresh', 'the re-armed sha is the SECOND GET\'s — the stale one never rides the retry');
});

test('backoff ladder + jitter: two consecutive failures sleep tiers 250/1000 at factor 1.0; the ±25% bounds hold at rand extremes', async () => {
  const mk = async (rand) => {
    const sleeps = [];
    let putCount = 0;
    const { fetchImpl } = mockFetch((c) => {
      if (c.method === 'GET') return { status: 404, data: null };
      putCount += 1;
      return { status: 503, data: { message: 'upstream unavailable' } };
    });
    await assert.rejects(
      () => pushSessionFiles({ ...BASE_ARGS, files: [FILE('p.txt')], fetchImpl, sleepImpl: noSleep(sleeps), rand }),
      /sessions contents push: 1\/1 file\(s\) failed/,
    );
    return sleeps;
  };
  // three 503s exhaust the ladder: sleeps land between attempts 1→2 and
  // 2→3 — tiers 250 and 1000 at rand()=0.5 (factor exactly 1.0)
  assert.deepEqual(await mk(randMid), [250, 1000], 'the live tiers under SESSIONS_PUT_ATTEMPTS=3');
  const lo = await mk(() => 0);
  const hi = await mk(() => 1);
  assert.deepEqual(lo, [Math.round(250 * 0.75), Math.round(1000 * 0.75)], 'rand=0 → the −25% bound');
  assert.deepEqual(hi, [Math.round(250 * 1.25), Math.round(1000 * 1.25)], 'rand=1 → the +25% bound');
  assert.equal(SESSIONS_PUT_ATTEMPTS, 3, 'the documented ladder budget');
  assert.deepEqual(SESSIONS_RETRY_BACKOFF_MS, [250, 1000, 4000], 'the documented curve (the 4s tier = the ceiling, live only if attempts rise)');
});

// ---------------------------------------------------------------------------
// The aggregate failure — ONE throw, EVERY file's error.
// ---------------------------------------------------------------------------

test('aggregate failure: one file exhausts the ladder, one fails fatally → ONE throw carrying BOTH files\' errors', async () => {
  const perPath = { 'a.txt': 0, 'b.txt': 0 };
  const { fetchImpl, calls } = mockFetch((c) => {
    const path = c.url.split('/contents/')[1]?.split('?')[0];
    if (c.method === 'GET') return { status: 404, data: null };
    perPath[path] += 1;
    // a.txt: retryable 5xx every time (burns all SESSIONS_PUT_ATTEMPTS);
    // b.txt: 401 (auth) — FATAL, one attempt, no 3× theater before the same death
    return path === 'a.txt' ? { status: 503, data: { message: 'upstream unavailable' } } : { status: 401, data: { message: 'Bad credentials' } };
  });
  await assert.rejects(
    () => pushSessionFiles({ ...BASE_ARGS, files: [FILE('a.txt'), FILE('b.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid }),
    (e) => {
      assert.match(e.message, /sessions contents push: 2\/2 file\(s\) failed/);
      assert.match(e.message, /a\.txt: exhausted 3 attempts — PUT\(create\) -> HTTP 503/, 'the ladder-exhausted file names its last class');
      assert.match(e.message, /b\.txt: PUT\(create\) -> HTTP 401/, 'the fatal file fails fast, its status in the aggregate');
      return true;
    },
  );
  assert.equal(perPath['a.txt'], SESSIONS_PUT_ATTEMPTS, 'the retryable file burned the full ladder');
  assert.equal(perPath['b.txt'], 1, 'the 401 is fatal per file — no retry theater');
});

test('network rejection is the retryable class: fetch throws → attempt 2 lands', async () => {
  let n = 0;
  const { fetchImpl } = mockFetch((c) => {
    n += 1;
    if (n === 1) throw new TypeError('fetch failed — DNS hiccup');
    return c.method === 'GET' ? { status: 404, data: null } : { status: 201, data: {} };
  });
  const r = await pushSessionFiles({ ...BASE_ARGS, files: [FILE('net.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid });
  assert.equal(r.mode, 'pushed', 'the network blip was absorbed by the ladder');
});

// ---------------------------------------------------------------------------
// THE F2 SEAM — the env resolution (pure).
// ---------------------------------------------------------------------------

test('THE F2 SEAM: sessionsRepoFromEnv — FSM_SESSIONS_REPO wins over the runner\'s GITHUB_REPOSITORY; absent → the legacy name; neither → null', () => {
  // the X29 shape verbatim: the runner repo says agentrunners/fsm-lab-workers,
  // TARGET_REPO says claudecode-headless/fsm-lab — the custom name MUST win
  // (the old lane read GITHUB_REPOSITORY and split the record-of-record)
  assert.equal(sessionsRepoFromEnv({ FSM_SESSIONS_REPO: 'claudecode-headless/fsm-lab', GITHUB_REPOSITORY: 'agentrunners/fsm-lab-workers' }), 'claudecode-headless/fsm-lab');
  // back-compat: tests/sims/local lanes that set only the old name
  assert.equal(sessionsRepoFromEnv({ GITHUB_REPOSITORY: 'claudecode-headless/fsm-lab' }), 'claudecode-headless/fsm-lab');
  // an EMPTY custom value is absent (the workflow mapping can render ''), never a blank repo
  assert.equal(sessionsRepoFromEnv({ FSM_SESSIONS_REPO: '  ', GITHUB_REPOSITORY: 'o/legacy' }), 'o/legacy');
  assert.equal(sessionsRepoFromEnv({}), null);
});

test('THE F2 SEAM: sessionsTokenFromEnv — FSM_SESSIONS_TOKEN wins; GH_TOKEN then GITHUB_TOKEN back-compat; absent → null', () => {
  assert.equal(sessionsTokenFromEnv({ FSM_SESSIONS_TOKEN: 'pat-x', GH_TOKEN: 'jobtok' }), 'pat-x');
  assert.equal(sessionsTokenFromEnv({ GH_TOKEN: 'jobtok', GITHUB_TOKEN: 'gtok' }), 'jobtok');
  assert.equal(sessionsTokenFromEnv({ GITHUB_TOKEN: 'gtok' }), 'gtok');
  assert.equal(sessionsTokenFromEnv({ FSM_SESSIONS_TOKEN: '', GH_TOKEN: 'jobtok' }), 'jobtok');
  assert.equal(sessionsTokenFromEnv({}), null);
});

// ---------------------------------------------------------------------------
// The guards + the seams (size, API base, headers, args).
// ---------------------------------------------------------------------------

test('the 1 MiB guard THROWS before any request — fail-loud, never truncated', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ status: 201, data: {} }));
  const big = 'x'.repeat(SESSIONS_FILE_MAX_BYTES + 1);
  await assert.rejects(
    () => pushSessionFiles({ ...BASE_ARGS, files: [FILE('big.txt', big)], fetchImpl, sleepImpl: noSleep([]), rand: randMid }),
    /big\.txt is \d+ bytes — over the 1048576-byte contents-API guard/,
  );
  assert.equal(calls.length, 0, 'the guard fires BEFORE any network');
});

test('the T9 seam: GITHUB_API_URL is the API base (trailing slashes stripped); unset → the literal api.github.com', async () => {
  const seen = [];
  const { fetchImpl } = mockFetch((c) => { seen.push(c.url); return c.method === 'GET' ? { status: 404, data: null } : { status: 201, data: {} }; });
  await pushSessionFiles({ ...BASE_ARGS, files: [FILE('p.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid, env: { GITHUB_API_URL: 'http://127.0.0.1:9876///' } });
  assert.match(seen[0], /^http:\/\/127\.0\.0\.1:9876\/repos\//, 'the injected base, slashes normalized');
  await pushSessionFiles({ ...BASE_ARGS, files: [FILE('p.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid, env: {} });
  assert.match(seen[2], /^https:\/\/api\.github\.com\/repos\//, 'unset → the literal (byte-identical live)');
});

test('the auth shape: Authorization Bearer + the contents Accept, on every call', async () => {
  const { fetchImpl, calls } = mockFetch((c) => (c.method === 'GET' ? { status: 404 } : { status: 201 }));
  await pushSessionFiles({ ...BASE_ARGS, files: [FILE('h.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid });
  for (const c of calls) {
    assert.equal(c.headers.Authorization, 'Bearer tok-1');
    assert.equal(c.headers.Accept, 'application/vnd.github+json');
  }
  assert.equal(calls[1].headers['Content-Type'], 'application/json', 'the PUT is JSON');
});

test('arg guards: repo/token/branch/files/fetchImpl all fail LOUD on the wrong shape', async () => {
  const { fetchImpl } = mockFetch(() => ({ status: 404 }));
  const good = { ...BASE_ARGS, files: [FILE('p.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid };
  await assert.rejects(() => pushSessionFiles({ ...good, repo: '  ' }), /repo must be a non-empty string/);
  await assert.rejects(() => pushSessionFiles({ ...good, token: '' }), /token must be a non-empty string/);
  await assert.rejects(() => pushSessionFiles({ ...good, branch: '' }), /branch must be a non-empty string/);
  await assert.rejects(() => pushSessionFiles({ ...good, files: [] }), /files must be a non-empty/);
  await assert.rejects(() => pushSessionFiles({ ...good, files: [{ path: 'x' }] }), /needs utf8 string content/);
  await assert.rejects(() => pushSessionFiles({ ...good, fetchImpl: null }), /fetchImpl must be a function/);
});

test('malformed 200 (no sha) is FATAL per file — a shape break never burns the ladder', async () => {
  const { fetchImpl, calls } = mockFetch((c) => (c.method === 'GET' ? { status: 200, data: { content: 'no sha field' } } : { status: 201 }));
  await assert.rejects(
    () => pushSessionFiles({ ...BASE_ARGS, files: [FILE('shape.txt')], fetchImpl, sleepImpl: noSleep([]), rand: randMid }),
    /shape\.txt: GET -> HTTP 200 without a sha/,
  );
  assert.equal(calls.length, 1, 'no PUT was attempted — the malformed payload died at the GET');
});

test('multi-file order: the pair pushes sequentially, paths in order, one aggregate result', async () => {
  const { fetchImpl, calls } = mockFetch((c) => (c.method === 'GET' ? { status: 404, data: null } : { status: 201, data: {} }));
  const r = await pushSessionFiles({
    ...BASE_ARGS,
    files: [FILE('sessions/T-9/r-a1.txt'), FILE('sessions/T-9/r-a1.meta.json')],
    fetchImpl, sleepImpl: noSleep([]), rand: randMid,
  });
  assert.deepEqual(r.files, ['sessions/T-9/r-a1.txt', 'sessions/T-9/r-a1.meta.json']);
  assert.deepEqual(calls.map((c) => [c.method, c.url.endsWith('r-a1.txt') || c.url.endsWith('r-a1.txt?ref=fsm-sessions') ? 'txt' : 'meta']), [
    ['GET', 'txt'], ['PUT', 'txt'], ['GET', 'meta'], ['PUT', 'meta'],
  ], 'txt then meta, GET+PUT per file, in order');
});
