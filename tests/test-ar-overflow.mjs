// test-ar-overflow.mjs — the T46/ar (20-e) suite: the SECOND-BUCKET
// integration (agentrunners/fsm-lab-workers as a real capacity multiplier).
//
// Surfaces, per the pinned design:
//   1. dispatchLadder (behavioral, fake api) — the F6 ladder extracted to
//      the core: statuses/jitter/budget clamps unchanged, plus the `repo`
//      + `token` routing params (the PAT lane for cross-repo dispatch) and
//      the NEW `saturated` exhaustion marker (the 403/429-with-Retry-After
//      class — the bucket-pressure signal).
//   2. workerOverflowDecision + priorInFlightCount (PURE) — the pinned
//      saturation rule (ladder saturation OR in-flight >= 6 default) and
//      the unset-var byte-identity contract (no repo2 -> NO lane for any
//      input).
//   3. the composed routing fixture — saturation on the main repo -> the
//      SAME envelope re-dispatched to the second repo's dispatches
//      endpoint on the PAT; the compose mirrors turn.mjs's dispatch site
//      (the adapter wiring itself is source-pinned in section 4, the W2 #9
//      idiom for self-executing turn-files).
//   5. report routing (REAL local git, the X25 geometry) — a worker seat
//      whose checkout origin is the TARGET repo enqueues its report onto
//      THAT repo's fsm-state; the run's own repo never sees a branch.
//   4. the YAML pins — worker.yml's TARGET_REPO checkout switch (+ the env
//      pair that follows it) and conductor.yml's WORKER_REPO_2 mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dispatchLadder, workerOverflowDecision, priorInFlightCount,
  WORKER_OVERFLOW_AT_DEFAULT,
  verifyScanRepoList, seenKeysFromRuns, dispatchVerificationEvents, VERIFY_WINDOW_MS,
} from '../lib/conductor-core.mjs';
import { Store } from '../lib/store.mjs';
import { genesis } from '../lib/fsm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWorkflow = (name) => readFileSync(join(root, '.github', 'workflows', name), 'utf8');

// ---------------------------------------------------------------------------
// 1. dispatchLadder — behavioral, fake api
// ---------------------------------------------------------------------------

// a recording fake api: api(path, method, body, token) -> {status, data,
// headers} — the adapter helper's exact contract.
function fakeApi(respond) {
  const calls = [];
  const api = (path, method = 'GET', body = null, token = undefined) => {
    calls.push({ path, method, body, token });
    return Promise.resolve(respond(calls.length - 1, path, token));
  };
  return { api, calls };
}
const noSleep = () => Promise.resolve();
const RA = { 'retry-after': '30' };

test('ar ladder: 204 first try -> ok, one call, envelope verbatim, token rides undefined (the X1a job-token lane)', async () => {
  const payload = { task: 'A1', behavior: 'succeed', attempt: 1 };
  const { api, calls } = fakeApi(() => ({ status: 204, data: null, headers: {} }));
  const r = await dispatchLadder({ eventType: 'fsm-task', clientPayload: payload, api, repo: 'claudecode-headless/fsm-lab', token: undefined, sleep: noSleep });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/repos/claudecode-headless/fsm-lab/dispatches');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { event_type: 'fsm-task', client_payload: payload });
  assert.equal(calls[0].token, undefined, 'same-repo dispatch rides the api default (the ephemeral job token)');
});

test('ar ladder: 403-with-Retry-After exhaustion -> saturated:true (the bucket-pressure signal); the server floor was waited', async () => {
  const sleeps = [];
  const { api, calls } = fakeApi(() => ({ status: 403, data: { message: 'secondary rate limit' }, headers: RA }));
  const r = await dispatchLadder({ eventType: 'fsm-task', clientPayload: { task: 'A1' }, api, repo: 'claudecode-headless/fsm-lab', tries: 3, budgetMs: 240_000, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.saturated, true, 'the retry-after class exhaustion carries the saturation marker');
  assert.ok(!('fatal' in r), 'not the permission class');
  assert.equal(calls.length, 3, 'tries bound respected');
  assert.equal(sleeps.length, 3, 'one wait per failed try (the pre-existing ladder shape — byte-identical)');
  for (const ms of sleeps) assert.ok(ms >= 30_000 && ms <= 30_000 * 1.2, `retry-after floor +20% jitter: ${ms}`);
});

test('ar ladder: bare 403 (no Retry-After) -> fatal, ONE call, no waits (permission problems fail fast)', async () => {
  const sleeps = [];
  const { api, calls } = fakeApi(() => ({ status: 403, data: { message: 'Resource not accessible' }, headers: {} }));
  const r = await dispatchLadder({ eventType: 'fsm-task', clientPayload: {}, api, repo: 'claudecode-headless/fsm-lab', tries: 5, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  assert.deepEqual(r, { ok: false, status: 403, fatal: true });
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test('ar ladder: generic (5xx) exhaustion -> NO saturated marker (not a bucket-pressure shape)', async () => {
  const { api } = fakeApi(() => ({ status: 502, data: { message: 'bad gateway' }, headers: {} }));
  const r = await dispatchLadder({ eventType: 'fsm-task', clientPayload: {}, api, repo: 'claudecode-headless/fsm-lab', tries: 2, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.ok(!('saturated' in r), 'only the 403/429-with-Retry-After class saturates');
});

test('ar ladder: budget <= 0 aborts AFTER the in-flight attempt (the attempt always fires; waits clamp)', async () => {
  const sleeps = [];
  const { api, calls } = fakeApi(() => ({ status: 429, data: {}, headers: { 'retry-after': '60' } }));
  let clock = 1_000;
  const r = await dispatchLadder({ eventType: 'fsm-task', clientPayload: {}, api, repo: 'x/y', tries: 5, budgetMs: 0, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, now: () => clock });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.saturated, true);
  assert.equal(calls.length, 1, 'budget exhausted -> no second attempt');
  assert.equal(sleeps.length, 0, 'no wait past an exhausted budget');
});

test('ar ladder ROUTING: {repo, token} re-target the endpoint — the second repo got the call with the SAME envelope on the PAT', async () => {
  const payload = { task: 'A1', behavior: 'succeed', attempt: 1, lease: 'l-abc', expires: '2026-09-20T12:00:00.000Z' };
  const { api, calls } = fakeApi(() => ({ status: 204, data: null, headers: {} }));
  const r = await dispatchLadder({ eventType: 'fsm-task', clientPayload: payload, api, repo: 'agentrunners/fsm-lab-workers', token: 'PAT-ORG' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/repos/agentrunners/fsm-lab-workers/dispatches', 'the SECOND repo\'s dispatch endpoint');
  assert.deepEqual(calls[0].body.client_payload, payload, 'the envelope is unchanged (byte-equal client_payload)');
  assert.equal(calls[0].token, 'PAT-ORG', 'cross-repo dispatch rides the PAT, not the job token');
});

// ---------------------------------------------------------------------------
// 2. the overflow decision + the occupancy base (PURE)
// ---------------------------------------------------------------------------

test('ar decision: unset WORKER_REPO_2 -> NO overflow for ANY input (the byte-identical contract)', () => {
  for (const d of [{ ok: true }, { ok: false, status: 403, saturated: true }, { ok: false, status: 403, fatal: true }, null]) {
    for (const inFlightNow of [0, 5, 6, 100]) {
      assert.deepEqual(workerOverflowDecision({ d, inFlightNow, repo2: null, pat: 'PAT' }), { overflow: false }, `repo2 unset, d=${JSON.stringify(d)} inFlight=${inFlightNow}`);
    }
  }
  // no PAT -> no lane either (cross-repo needs the PAT; a null PAT must not
  // produce a doomed dispatch)
  assert.deepEqual(workerOverflowDecision({ d: { ok: false, status: 403, saturated: true }, inFlightNow: 99, repo2: 'agentrunners/fsm-lab-workers', pat: null }), { overflow: false });
});

test('ar decision: saturation signal 1 — the ladder\'s 403-with-Retry-After exhaustion re-targets', () => {
  const r = workerOverflowDecision({ d: { ok: false, status: 403, saturated: true }, inFlightNow: 0, repo2: 'agentrunners/fsm-lab-workers', pat: 'PAT' });
  assert.deepEqual(r, { overflow: true, reason: 'ladder-saturated(HTTP 403)', to: 'agentrunners/fsm-lab-workers' });
});

test('ar decision: a bare-403 fatal (permission) does NOT overflow; a 5xx exhaustion does not either', () => {
  assert.equal(workerOverflowDecision({ d: { ok: false, status: 403, fatal: true }, inFlightNow: 0, repo2: 'agentrunners/fsm-lab-workers', pat: 'PAT' }).overflow, false);
  assert.equal(workerOverflowDecision({ d: { ok: false, status: 502 }, inFlightNow: 0, repo2: 'agentrunners/fsm-lab-workers', pat: 'PAT' }).overflow, false);
});

test('ar decision: saturation signal 2 — in-flight >= 6 (the DEFAULT) re-targets; 5 does not; the boundary is >=, counting leases OUTSIDE the current dispatch', () => {
  const base = { repo2: 'agentrunners/fsm-lab-workers', pat: 'PAT', d: { ok: true } };
  assert.equal(workerOverflowDecision({ ...base, inFlightNow: 5 }).overflow, false, '5 in-flight: the main bucket still has room');
  const at6 = workerOverflowDecision({ ...base, inFlightNow: 6 });
  assert.equal(at6.overflow, true);
  assert.deepEqual(at6, { overflow: true, reason: 'in-flight(6>=6)', to: 'agentrunners/fsm-lab-workers' });
  assert.equal(workerOverflowDecision({ ...base, inFlightNow: 7 }).overflow, true);
  // the default IS the exported constant
  assert.equal(WORKER_OVERFLOW_AT_DEFAULT, 6);
  // a custom threshold (the WORKER_OVERFLOW_AT repo variable) moves the boundary
  assert.equal(workerOverflowDecision({ ...base, inFlightNow: 3, overflowAt: 3 }).overflow, true);
  assert.equal(workerOverflowDecision({ ...base, inFlightNow: 2, overflowAt: 3 }).overflow, false);
  // a degenerate threshold falls back to the default (never 0/NaN -> always-overflow)
  assert.equal(workerOverflowDecision({ ...base, inFlightNow: 5, overflowAt: 0 }).overflow, false, 'overflowAt=0 -> the default 6 applies');
  assert.equal(workerOverflowDecision({ ...base, inFlightNow: 5, overflowAt: NaN }).overflow, false, 'NaN -> the default 6 applies');
});

test('ar decision: saturation signal 1 WINS over the occupancy count (both pinned signals re-target; ladder first)', () => {
  const r = workerOverflowDecision({ d: { ok: false, status: 429, saturated: true }, inFlightNow: 12, repo2: 'agentrunners/fsm-lab-workers', pat: 'PAT' });
  assert.equal(r.overflow, true);
  assert.equal(r.reason, 'ladder-saturated(HTTP 429)');
});

test('ar occupancy: priorInFlightCount = committed ACTIVE leases minus THIS tick\'s dispatch actions', () => {
  const st = { tasks: {
    T1: { id: 'T1', status: 'assigned' },     // prior in-flight
    T2: { id: 'T2', status: 'in_progress' },  // prior in-flight
    T3: { id: 'T3', status: 'assigned' },     // NEW this tick (has an action)
    T4: { id: 'T4', status: 'assigned' },     // NEW this tick (has an action)
    T5: { id: 'T5', status: 'ready' },        // not in flight
    T6: { id: 'T6', status: 'done' },
    T7: { id: 'T7', status: 'quarantined' },
  } };
  const actions = [
    { type: 'DISPATCH_WORKER', task: 'T3' },
    { type: 'DISPATCH_WORKER', task: 'T4' },
    { type: 'STOP_CHAIN' },
  ];
  assert.equal(priorInFlightCount(st, actions), 2);
  assert.equal(priorInFlightCount(st, []), 4, 'no actions -> all active leases are prior');
  assert.equal(priorInFlightCount(null, actions), 0);
  assert.equal(priorInFlightCount(st, null), 4);
  // clamp: never negative
  assert.equal(priorInFlightCount({ tasks: { T1: { status: 'assigned' } } }, [{ type: 'DISPATCH_WORKER' }, { type: 'DISPATCH_WORKER' }]), 0);
});

// ---------------------------------------------------------------------------
// 3. the composed routing fixture — what turn.mjs's dispatch site does:
// same-repo ladder -> decision -> (overflow) second-repo ladder. The wiring
// between these three calls is source-pinned below (section 4).
// ---------------------------------------------------------------------------

test('ar COMPOSED: saturation on the main repo -> the SAME envelope re-dispatched to the second repo -> ok (the X25 lane, PAT-routed)', async () => {
  const payload = { task: 'A9', behavior: 'infra-flaky', attempt: 2, lease: 'l-zz', expires: '2026-09-20T12:00:00.000Z' };
  const calls = [];
  const api = (path, method, body, token) => {
    calls.push({ path, method, body, token });
    // the MAIN repo is rate-limited (403 + Retry-After); the SECOND repo accepts
    const r = path.includes('agentrunners/fsm-lab-workers')
      ? { status: 204, data: null, headers: {} }
      : { status: 403, data: { message: 'secondary rate limit' }, headers: RA };
    return Promise.resolve(r);
  };
  // the adapter's exact sequence
  let d = await dispatchLadder({ eventType: 'fsm-task', clientPayload: payload, api, repo: 'claudecode-headless/fsm-lab', tries: 2, sleep: noSleep });
  const ov = workerOverflowDecision({ d, inFlightNow: 1, repo2: 'agentrunners/fsm-lab-workers', pat: 'PAT-ORG' });
  assert.equal(ov.overflow, true, 'saturated ladder -> overflow decision fires');
  if (ov.overflow) d = await dispatchLadder({ eventType: 'fsm-task', clientPayload: payload, api, repo: ov.to, token: 'PAT-ORG', sleep: noSleep });
  assert.equal(d.ok, true, 'the second bucket accepted the dispatch');
  // the calls: 2 on main (the ladder's tries) + 1 on the second repo
  const main = calls.filter(c => c.path === '/repos/claudecode-headless/fsm-lab/dispatches');
  const second = calls.filter(c => c.path === '/repos/agentrunners/fsm-lab-workers/dispatches');
  assert.equal(main.length, 2);
  assert.equal(second.length, 1);
  assert.equal(second[0].token, 'PAT-ORG', 'the cross-repo call rides the PAT');
  assert.deepEqual(second[0].body.client_payload, payload, 'the SAME envelope reached the second bucket');
});

test('ar COMPOSED: unset WORKER_REPO_2 + saturation -> exactly ONE ladder, no second-repo call (byte-identical dispatch path)', async () => {
  const payload = { task: 'A9', behavior: 'succeed', attempt: 1 };
  const calls = [];
  const api = (path, method, body, token) => {
    calls.push({ path, method, body, token });
    return Promise.resolve({ status: 403, data: { message: 'secondary rate limit' }, headers: RA });
  };
  let d = await dispatchLadder({ eventType: 'fsm-task', clientPayload: payload, api, repo: 'claudecode-headless/fsm-lab', tries: 2, sleep: noSleep });
  const ov = workerOverflowDecision({ d, inFlightNow: 99, repo2: null, pat: 'PAT-ORG' });
  assert.equal(ov.overflow, false);
  if (ov.overflow) d = await dispatchLadder({ eventType: 'fsm-task', clientPayload: payload, api, repo: ov.to, token: 'PAT-ORG', sleep: noSleep });
  assert.equal(d.ok, false, 'the failure surfaces exactly as today (dispatchFailures lane)');
  assert.equal(calls.length, 2, 'only the same-repo ladder ran');
  assert.ok(calls.every(c => c.path === '/repos/claudecode-headless/fsm-lab/dispatches'));
  assert.ok(calls.every(c => c.token === undefined), 'the job-token lane throughout');
});

// ---------------------------------------------------------------------------
// 4. the adapter wiring (source-pinned — the W2 #9 idiom: turn.mjs is a
// self-executing I/O script, not importable in a test) + the YAML pins
// ---------------------------------------------------------------------------

test('ar wiring (source-pinned): turn.mjs parses WORKER_REPO_2/WORKER_OVERFLOW_AT, wires the decision + the second-repo re-dispatch', () => {
  const src = readFileSync(new URL('../conductor/turn.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("const WORKER_REPO_2 = process.env.WORKER_REPO_2 || null;"), 'WORKER_REPO_2 env parse (unset -> null -> no lane)');
  assert.ok(src.includes('WORKER_OVERFLOW_AT_DEFAULT,'), 'the overflow threshold default comes from the core');
  assert.ok(src.includes("parseInt(process.env.WORKER_OVERFLOW_AT || '', 10) || WORKER_OVERFLOW_AT_DEFAULT"), 'WORKER_OVERFLOW_AT env parse with the core default');
  // the ladder is DELEGATED to the core (no inline ladder left)
  assert.ok(src.includes('return dispatchLadder({ eventType, clientPayload, api, repo, token, tries, budgetMs, sleep });'), 'dispatchRetry wraps the core ladder');
  assert.ok(!/for \(let i = 0; i < tries; i\+\+\)/.test(src), 'the ladder loop lives in the core now (one source)');
  // the occupancy base
  assert.ok(src.includes('const priorInFlight = priorInFlightCount(state, actionList);'), 'the occupancy base is computed from the committed state + this tick\'s actions');
  // the decision + the re-dispatch, verbatim shapes
  assert.ok(src.includes('inFlightNow: priorInFlight + dispatchIndex - 1'), 'the in-flight count excludes the CURRENT dispatch (prior + already-dispatched)');
  assert.ok(src.includes("repo2: WORKER_REPO_2, pat: PAT, overflowAt: WORKER_OVERFLOW_AT,"), 'the decision consumes the env-parsed lane config');
  assert.ok(src.includes("d = await dispatchRetry('fsm-task', payload, { budgetMs: workerBudgetMs, repo: WORKER_REPO_2, token: PAT });"), 'the SAME payload re-targets the second repo on the PAT');
  assert.ok(src.includes('DISPATCH-OVERFLOW'), 'the overflow is LOUD (a log line per re-target)');
});

test('ar wiring (source-pinned): the worker\'s report enqueue rides the CHECKOUT cwd (the routing property TARGET_REPO redirects)', () => {
  const src = readFileSync(new URL('../worker/turn.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('new Store({ cwd: process.cwd() })'), 'enqueueReport rides the checkout\'s own origin — no repo-name URL, no env routing');
});

test('ar YAML pin: worker.yml TARGET_REPO checkout switch (own-repo default, PAT lane only when redirected)', () => {
  const yml = readWorkflow('worker.yml');
  const checkoutRepo = "repository: ${{ vars.TARGET_REPO || github.repository }}";
  const patLane = "token: ${{ vars.TARGET_REPO && secrets.LAB_PAT || secrets.GITHUB_TOKEN }}";
  const co = yml.indexOf('- uses: actions/checkout@v4');
  const setup = yml.indexOf('- uses: actions/setup-node@v4');
  assert.ok(co !== -1 && setup !== -1, 'the step order is intact');
  const at = yml.indexOf(checkoutRepo);
  const tok = yml.indexOf(patLane);
  assert.ok(at !== -1, 'the checkout carries the TARGET_REPO repository mapping');
  assert.ok(at > co && at < setup, 'the repository mapping rides the CHECKOUT step (before setup-node)');
  assert.ok(tok !== -1 && tok > co && tok < setup, 'the checkout token lane rides the CHECKOUT step');
  assert.ok(at < tok, 'repository before token (the with-block order)');
  // the cc-lane push pair follows the checkout target (fsm-sessions + the
  // task branch ride GITHUB_REPOSITORY + GH_TOKEN — the env seam the adapter
  // actually reads; the job token cannot push cross-repo)
  const work = yml.indexOf('name: Work the task');
  const run = yml.indexOf('run: node worker/turn.mjs');
  const gr = yml.indexOf('GITHUB_REPOSITORY: ${{ vars.TARGET_REPO || github.repository }}');
  const gh = yml.indexOf('GITHUB_REPOSITORY: ${{ github.repository }}');
  assert.equal(gh, -1, 'the OLD same-repo GITHUB_REPOSITORY mapping is gone');
  assert.ok(gr !== -1 && gr > work && gr < run, 'GITHUB_REPOSITORY follows TARGET_REPO inside Work-the-task');
  const ghTok = yml.split('GH_TOKEN:').length - 1;
  assert.equal(ghTok, 1, 'exactly ONE GH_TOKEN mapping (the pair moved up; no duplicate keys)');
  const workBlock = yml.slice(work, run);
  assert.ok(workBlock.includes('GH_TOKEN: ${{ vars.TARGET_REPO && secrets.LAB_PAT || secrets.GITHUB_TOKEN }}'), 'the Work-the-task GH_TOKEN uses the SAME var-gated PAT lane');
  assert.ok(workBlock.includes('GITHUB_REPOSITORY: ${{ vars.TARGET_REPO || github.repository }}'), 'GITHUB_REPOSITORY uses the SAME var-gated repo mapping');
  // the mapping-set-when-unset contract: the pre-existing explicit mappings survive
  assert.ok(yml.includes('GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}'), 'the attempt mapping is intact');
  assert.ok(yml.includes("OPENROUTER_KEY_POOL: ${{ secrets.OPENROUTER_KEY_POOL || '' }}"), 'the B1 pool line is untouched by the ar edit');
});

test('ar YAML pin: conductor.yml maps WORKER_REPO_2 + WORKER_OVERFLOW_AT from repo variables (unset = empty env = no lane)', () => {
  const yml = readWorkflow('conductor.yml');
  assert.ok(yml.includes("WORKER_REPO_2: ${{ vars.WORKER_REPO_2 || '' }}"), 'WORKER_REPO_2 mapping');
  assert.ok(yml.includes("WORKER_OVERFLOW_AT: ${{ vars.WORKER_OVERFLOW_AT || '' }}"), 'WORKER_OVERFLOW_AT mapping');
  const env = yml.indexOf('Conductor turn');
  assert.ok(env !== -1 && yml.indexOf('WORKER_REPO_2:') > env, 'the mapping rides the turn step env');
});

// ---------------------------------------------------------------------------
// 5. report routing — REAL local git, the X25 geometry: the worker seat is a
// CHECKOUT OF THE TARGET REPO; its report CAS-append lands on the TARGET
// repo's fsm-state. The run's own repo (the mirror stand-in) never sees it.
// ---------------------------------------------------------------------------

function mkTwoRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-ar-'));
  const mirror = join(dir, 'mirror-origin.git');   // the RUN repo (agentrunners stand-in)
  const main = join(dir, 'main-origin.git');       // the TARGET repo (fsm-lab stand-in)
  const seat = join(dir, 'seat');                 // the worker's checkout OF THE TARGET
  const g = (args, cwd) => spawnSync('git', args, { cwd: cwd || dir, encoding: 'utf8' });
  const seed = (origin) => {
    const s = join(dir, `seed-${origin.endsWith('main-origin.git') ? 'm' : 'r'}`);
    g(['init', '-b', 'main', s]);
    spawnSync('bash', ['-c', `echo lab > README.md && git add . && git -c user.name=t -c user.email=t@t.invalid commit -m seed && git push -q '${origin}' main`], { cwd: s });
  };
  g(['init', '--bare', '-b', 'main', mirror]);
  g(['init', '--bare', '-b', 'main', main]);
  seed(mirror); seed(main);
  g(['clone', main, seat]);
  return { dir, mirror, main, seat, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ar report routing (real git): a seat checked out from the TARGET repo enqueues onto THE TARGET\'s fsm-state — the run repo never sees a branch', () => {
  const lab = mkTwoRepos();
  try {
    // the MAIN repo (target) holds the live state — genesis its fsm-state
    // FROM THE SEAT (exactly how the overflow worker's Store sees the world)
    const st = new Store({ cwd: lab.seat });
    const g0 = genesis({
      config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3 },
      project: { tasks: [{ id: 'AR-1', title: 'second-bucket probe', spec: { goal: 'prove the routing' }, behavior: 'fast' }], milestones: 1 },
      chainId: 'c-ar-routing', now: '2026-09-20T10:00:00.000Z',
    });
    st.init(g0);
    // the worker turn's report enqueue — the exact wiring of worker/turn.mjs
    const report = {
      event_id: 'rep-35399900001-a1', task: 'AR-1', lease: g0.tasks['AR-1'].lease || 'lease-x',
      outcome: { status: 'done', artifact: 'routed to the MAIN repo', run_id: '35399900001' }, run_id: '35399900001',
    };
    const r = st.enqueueReport(report);
    assert.equal(r.ok, true, 'the CAS-append push succeeds from the seat');
    // the TARGET repo's fsm-state carries the queue line (byte-exact task + event_id)
    const show = spawnSync('git', ['show', 'fsm-state:state/reports-queue.jsonl'], { cwd: lab.main, encoding: 'utf8' });
    assert.equal(show.status, 0, 'the queue file exists on the TARGET repo\'s fsm-state');
    const lines = show.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event_id, 'rep-35399900001-a1');
    assert.equal(lines[0].task, 'AR-1');
    assert.equal(lines[0].outcome.status, 'done');
    // the RUN repo (the mirror stand-in) has NO fsm-state at all — the report
    // never lands on the second bucket's own state (the X25 waste class)
    const mirrorBranches = spawnSync('git', ['branch', '--list', 'fsm-state'], { cwd: lab.mirror, encoding: 'utf8' });
    assert.equal(mirrorBranches.stdout.trim(), '', 'the run repo never sees the report');
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// 6. T46/s21 C-1 (audit a1, BLOCKING) — the law-4 UNION scan. A repo2-only
// dispatch (the saturated-ladder fallback above) has its ONLY run in
// WORKER_REPO_2's worker.yml; the main-only scan flipped it
// 'dispatch-unverified' at 720s -> infra churn -> quarantine of LIVE bucket-2
// work. The adapter composes verifyScanRepoList -> per-repo
// verifyScanRunsPath fetches -> ONE merged time-correlated seenKeysFromRuns;
// these pins bite the planner, the composed flip decision, and the wiring.
// ---------------------------------------------------------------------------

const MAIN_REPO = 'claudecode-headless/fsm-lab';
const REPO_2 = 'agentrunners/fsm-lab-workers';
const C1_T0 = Date.parse('2026-09-20T10:00:00.000Z');

function leasedFlippableState() {
  const issuedMs = C1_T0 - VERIFY_WINDOW_MS - 60_000;   // aged past the window: the flip is DUE
  const s = genesis({
    config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3 },
    project: { tasks: [{ id: 'AR-C1', title: 'union-scan probe', behavior: 'succeed', work_ms: 1 }], milestones: 1 },
    chainId: 'c-ar-c1', now: new Date(issuedMs).toISOString(),
  });
  const t = s.tasks['AR-C1'];
  t.status = 'assigned';
  t.attempts = 1;
  t.lease = { token: 'l-c1', expires: new Date(C1_T0 + 900_000).toISOString(), issued_at: new Date(issuedMs).toISOString() };
  return { state: s, issuedMs };
}

// the adapter's scan composition, exactly: the UNION plan -> per-repo runs
// lists -> ONE merged time-correlated key set (repo2Runs are only consulted
// when the plan actually includes repo2 — a PAT-less lane never fetches them)
function unionSeenKeys(state, { repo2 = null, pat = null, mainRuns = [], repo2Runs = [] } = {}) {
  const repos = verifyScanRepoList(MAIN_REPO, repo2, pat);
  const runs = [];
  for (const sr of repos) runs.push(...(sr === MAIN_REPO ? mainRuns : repo2Runs));
  return seenKeysFromRuns(runs, state.tasks);
}

test('C-1 planner: verifyScanRepoList — [main] alone without the lane; [main, repo2] with lane+PAT; no PAT -> main-only (the job token cannot read cross-repo)', () => {
  assert.deepEqual(verifyScanRepoList(MAIN_REPO, null, 'PAT-ORG'), [MAIN_REPO], 'unset lane -> the main-only scan (byte-identical)');
  assert.deepEqual(verifyScanRepoList(MAIN_REPO, REPO_2, 'PAT-ORG'), [MAIN_REPO, REPO_2], 'lane + PAT -> the UNION');
  assert.deepEqual(verifyScanRepoList(MAIN_REPO, REPO_2, null), [MAIN_REPO], 'lane without a PAT -> main-only (X1a: the job token is same-repo scoped)');
  assert.deepEqual(verifyScanRepoList(MAIN_REPO, REPO_2, undefined), [MAIN_REPO], 'undefined PAT likewise');
  assert.deepEqual(verifyScanRepoList(MAIN_REPO, null, null), [MAIN_REPO]);
});

test('C-1 COMPOSED: a repo2-ONLY run verifies the task — NO dispatch-unverified flip (the BLOCKING kill)', () => {
  const { state, issuedMs } = leasedFlippableState();
  const mirrorRun = { name: 'task-AR-C1 · succeed · a1', created_at: new Date(issuedMs + 60_000).toISOString() };
  // the ONLY run for this lease lives in the second bucket (the saturated-ladder fallback's shape)
  const keys = unionSeenKeys(state, { repo2: REPO_2, pat: 'PAT-ORG', mainRuns: [], repo2Runs: [mirrorRun] });
  assert.ok(keys.has('AR-C1#a1'), 'the union saw the mirror run');
  assert.equal(dispatchVerificationEvents({ state, seenKeys: keys, nowMs: C1_T0 }).length, 0, 'NO flip — the repo2-only dispatch is verified');
  // the PRE-fix shape on the SAME fixture (main-only scan): the C-1 bug, reproduced
  const mainOnly = unionSeenKeys(state, { repo2: REPO_2, pat: 'PAT-ORG', mainRuns: [], repo2Runs: [] });
  const preFix = dispatchVerificationEvents({ state, seenKeys: mainOnly, nowMs: C1_T0 });
  assert.equal(preFix.length, 1, 'the main-only scan flips the LIVE bucket-2 task (the reproduced bug)');
  assert.equal(preFix[0].outcome.error, 'dispatch-unverified');
});

test('C-1 COMPOSED: a run in EITHER bucket suppresses the flip; NO run anywhere still flips (the protection stays); the PAT-less lane degrades to main-only', () => {
  const { state, issuedMs } = leasedFlippableState();
  const run = { name: 'task-AR-C1 · succeed · a1', created_at: new Date(issuedMs + 60_000).toISOString() };
  // a main-bucket run (the normal shape) is seen through the union too — the union only ADDS sight
  assert.equal(dispatchVerificationEvents({ state, seenKeys: unionSeenKeys(state, { repo2: REPO_2, pat: 'PAT-ORG', mainRuns: [run] }), nowMs: C1_T0 }).length, 0, 'main-bucket run: no flip');
  // no run in EITHER bucket — the accepted-but-dropped class still flips
  assert.equal(dispatchVerificationEvents({ state, seenKeys: unionSeenKeys(state, { repo2: REPO_2, pat: 'PAT-ORG' }), nowMs: C1_T0 }).length, 1, 'the union is a superset — it never blinds the existing protection');
  // no PAT: the plan is main-only, so the repo2-only run cannot verify (documented degradation — the union needs the same PAT the cross-repo dispatch already needs)
  assert.equal(dispatchVerificationEvents({ state, seenKeys: unionSeenKeys(state, { repo2: REPO_2, pat: null, repo2Runs: [run] }), nowMs: C1_T0 }).length, 1, 'PAT-less lane: the scan cannot see the mirror');
});

test('C-1 wiring (source-pinned): the adapter\'s scan is the UNION — verifyScanRepoList drives a per-repo fetch loop, and any failure fails the WHOLE scan open', () => {
  const src = readFileSync(new URL('../conductor/turn.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('const scanRepos = verifyScanRepoList(REPO, WORKER_REPO_2, PAT);'), 'the scan plan consults the overflow lane + the PAT');
  assert.ok(src.includes('for (const sr of scanRepos) {'), 'a per-repo fetch loop');
  assert.ok(src.includes('sr === REPO ? TOKEN : PAT'), 'the second bucket\'s fetch rides the PAT (the cross-repo read)');
  assert.ok(src.includes('seenKeysFromRuns(runs,'), 'ONE merged, time-correlated key set from every scanned repo');
  assert.ok(src.includes('let scanOk = true;') && src.includes('if (scanOk) {'), 'any per-repo fetch failure voids the whole scan (fail-open — partial keys would flip every repo2-dispatched task)');
  assert.ok(src.includes('VERIFY-SCAN-SKIPPED repo='), 'per-repo fetch failures are LOUD');
  assert.ok(src.includes('VERIFY-SCAN repos='), 'the merged scan logs its repo count');
});
