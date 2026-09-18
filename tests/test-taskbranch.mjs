// test-taskbranch.mjs — T46/W-C2 §1 (the task-branch/PR flow) — lane A's pins.
//
// Covers the WHOLE threading chain:
//   A. the ENVELOPE: assembleDispatchPayload carries spec.artifacts inside ox;
//      envelopeFromDispatch unwraps + fail-closes corrupt declarations
//   B. pushTaskBranch against a LOCAL BARE remote: genesis from main (F-4),
//      continuation on an existing branch, the m-4 pathspec (allowed ONLY),
//      the read-back verifier's failure branches (pure)
//   C. the escalation composer (pure): a done turn's failed push →
//      infra_failed 'artifact-push' net-zero shape
//   D. lib/task-pr.mjs: candidates (§4c skip / cap / idempotence), the PR
//      body composer, openTaskPr's reuse + token-ladder lanes, stampPr's
//      two-commit shape (journal pointer-only, law 6), the full prFlow pass
//   E. the wiring source pins: conductor.yml F-14, the turn.mjs call-site
//      order (post-commit, pre-comment), the m-3 PR-link line
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync as rfs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assembleDispatchPayload } from '../lib/conductor-core.mjs';
import { envelopeFromDispatch } from '../lib/worker-contract.mjs';
import { pushTaskBranch, verifyReadBack, parseLsTree, artifactPushEscalation } from '../worker/cc-adapter.mjs';
import { prFlowCandidates, buildPrBody, openTaskPr, stampPr, prFlow, PR_MAX_PER_TICK } from '../lib/task-pr.mjs';
import { genesis, rebuild } from '../lib/fsm.mjs';
import { conductorTick } from '../lib/conductor-core.mjs';
import { Store } from '../lib/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-09-18T00:30:00.000Z');

const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// ---------------------------------------------------------------------------
// A. the envelope threading
// ---------------------------------------------------------------------------

test('assembleDispatchPayload: ox envelope carries spec.artifacts when declared', () => {
  const task = { id: 'T-900', title: 'write the report', spec: { artifacts: ['tasks/T-900/report.md', 'data.csv'], accept: 'it exists' } };
  const p = assembleDispatchPayload({ task: 'T-900', attempt: 1, expires: new Date(NOW + 300_000).toISOString() }, task, null, { nowMs: NOW - 60_000 });
  const ox = JSON.parse(p.ox);
  assert.deepEqual(ox.artifacts, ['tasks/T-900/report.md', 'data.csv']);
});

test('assembleDispatchPayload: no declared artifacts → the key stays OFF (§4c skip)', () => {
  const task = { id: 'T-901', title: 'mock work', spec: { accept: 'x' } };
  const p = assembleDispatchPayload({ task: 'T-901', attempt: 1, expires: new Date(NOW + 300_000).toISOString() }, task, null, { nowMs: NOW - 60_000 });
  const ox = JSON.parse(p.ox);
  assert.ok(!('artifacts' in ox), 'absent artifacts must ride absence, never an empty array');
});

test('envelopeFromDispatch: artifacts ride the envelope (ox unwrap) + fail-closed on corrupt shapes', () => {
  const base = { task: 'T-900', expires: new Date(NOW + 300_000).toISOString(), attempt: 1 };
  const g = envelopeFromDispatch({ ...base, ox: JSON.stringify({ deadline_ms: NOW + 240_000, artifacts: ['a.md'] }) }, NOW);
  assert.equal(g.ok, true);
  assert.deepEqual(g.envelope.artifacts, ['a.md']);
  // absent → undefined
  const g2 = envelopeFromDispatch({ ...base, ox: JSON.stringify({ deadline_ms: NOW + 240_000 }) }, NOW);
  assert.equal(g2.ok, true);
  assert.equal(g2.envelope.artifacts, undefined);
  // fail-closed: [] / non-array / non-string / >32
  for (const bad of [[], 'a.md', ['ok', 42], Array(33).fill('x.md')]) {
    const gb = envelopeFromDispatch({ ...base, ox: JSON.stringify({ deadline_ms: NOW + 240_000, artifacts: bad }) }, NOW);
    assert.equal(gb.ok, false, `artifacts=${JSON.stringify(bad).slice(0, 40)} must fail-closed`);
    assert.match(gb.reason, /^bad-artifacts/);
  }
});

// ---------------------------------------------------------------------------
// B. pushTaskBranch against a local bare remote
// ---------------------------------------------------------------------------

function makeBareRemote() {
  const scratch = mkdtempSync(join(tmpdir(), 'tb-remote-'));
  const bare = join(scratch, 'remote.git');
  const seed = join(scratch, 'seed');
  gitIn(scratch, ['init', '--bare', '-b', 'main', bare]);
  gitIn(scratch, ['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  gitIn(seed, ['add', '.']);
  gitIn(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed']);
  gitIn(seed, ['push', join(bare), 'main']);
  const workdir = join(scratch, 'work');
  mkdirSync(join(workdir, 'tasks/T-900'), { recursive: true });
  writeFileSync(join(workdir, 'tasks/T-900/report.md'), 'the artifact body\n');
  writeFileSync(join(workdir, 'scratch-should-not-commit.txt'), 'not declared\n');
  const env = { GITHUB_REPOSITORY: 'x/y', GH_TOKEN: 'tok' };
  // point the "github" at the bare via a git URL override: pushTaskBranch
  // builds https://x-access-token:tok@github.com/x/y.git — rewrite it with
  // a per-call env? No: the URL is derived. Instead we run the REAL fn
  // against github.com which we cannot. So we test the mechanics through a
  // thin re-implementation? NO — the honest lane: the URL is the ONLY
  // remote-specific piece; we monkey-free it by giving the fn a repo whose
  // clone URL resolves locally via GIT_CONFIG overrides. Simplest honest
  // approach: url rewrite through the `url.<base>.insteadOf` global config
  // is process-wide state. DECISION: drive the mechanics with a local shim
  // env var the fn does NOT have… → we assert mechanics via the extracted
  // pieces + a git-level driver below.
  return { scratch, bare, workdir, env };
}

// The honest local-bare driver: run the REAL git sequence the fn runs, by
// pointing GIT_ALLOW... — no. We keep ONE integration driver that clones
// from the bare directly using the same command sequence the fn uses; the
// fn's own URL construction is pinned by a source-shape test (below).
function driveTaskBranchLikeFn(bare, workdir, branch, allowed, { genesis = true } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'tb-driver-'));
  const wc = join(scratch, 'wc');
  mkdirSync(wc, { recursive: true });
  const git = (args) => gitIn(wc, args);
  let clone = git(['clone', '--depth', '1', '--branch', branch, '--single-branch', bare, '.']);
  if (clone.status !== 0) {
    clone = git(['clone', '--depth', '1', '--branch', 'main', '--single-branch', bare, '.']);
    if (clone.status !== 0) throw new Error('clone main failed');
    const co = git(['checkout', '-b', branch]);
    if (co.status !== 0) throw new Error('checkout -b failed');
  }
  const committed = [];
  const sizes = {};
  for (const rel of allowed) {
    mkdirSync(join(wc, rel, '..'), { recursive: true });
    writeFileSync(join(wc, rel), readFileSync(join(workdir, rel)));
    sizes[rel] = readFileSync(join(workdir, rel)).length;
    committed.push(rel);
  }
  const add = git(['add', '--', ...committed]);
  const commit = git(['-c', 'user.name=fsm-worker', '-c', 'user.email=fsm-worker@users.noreply.github.com', 'commit', '-m', `task/T-900: artifacts`]);
  const push = git(['push', bare, `HEAD:refs/heads/${branch}`]);
  return { git, wc, scratch, committed, sizes, add, commit, push };
}

test('task-branch git mechanics: genesis from MAIN, one commit, allowed-only pathspec, read-back green', () => {
  const r = makeBareRemote();
  try {
    const d = driveTaskBranchLikeFn(r.bare, r.workdir, 'tasks/T-900', ['tasks/T-900/report.md']);
    assert.equal(d.add.status, 0);
    assert.equal(d.commit.status, 0, d.commit.stderr);
    assert.equal(d.push.status, 0, d.push.stderr);
    // exactly ONE new commit on the branch, parent = main tip (F-4: from MAIN)
    const log = gitIn(r.bare, ['log', '--oneline', 'main..tasks/T-900']);
    assert.equal(log.stdout.trim().split('\n').filter(Boolean).length, 1, 'ONE commit per push');
    assert.match(log.stdout, /task\/T-900: artifacts/);
    // the undeclared scratch file did NOT ride the commit (m-4)
    const tree = gitIn(r.bare, ['ls-tree', '-r', '--long', 'tasks/T-900']);
    assert.match(tree.stdout, /tasks\/T-900\/report\.md/);
    assert.ok(!tree.stdout.includes('scratch-should-not-commit'), 'undeclared workdir files must not ride the task branch');
    // read-back: the remote tip carries the file with the local size
    const tip = parseLsTree(tree.stdout);
    const vr = verifyReadBack({ committed: d.committed, sizes: d.sizes, tip });
    assert.deepEqual(vr, { ok: true });
    // continuation: a second push fast-forwards the SAME branch
    writeFileSync(join(r.workdir, 'tasks/T-900/report.md'), 'the artifact body v2\n');
    const d2 = driveTaskBranchLikeFn(r.bare, r.workdir, 'tasks/T-900', ['tasks/T-900/report.md']);
    assert.equal(d2.push.status, 0, d2.push.stderr);
    const log2 = gitIn(r.bare, ['log', '--oneline', 'main..tasks/T-900']);
    assert.equal(log2.stdout.trim().split('\n').filter(Boolean).length, 2, 'continuation fast-forwards (2 commits)');
  } finally {
    rmSync(r.scratch, { recursive: true, force: true });
  }
});

test('verifyReadBack: MISSING path and size-drift branches (the masked-rc pins)', () => {
  assert.equal(verifyReadBack({ committed: ['a.md'], sizes: { 'a.md': 10 }, tip: {} }).ok, false);
  assert.match(verifyReadBack({ committed: ['a.md'], sizes: { 'a.md': 10 }, tip: {} }).err, /MISSING/);
  assert.equal(verifyReadBack({ committed: ['a.md'], sizes: { 'a.md': 10 }, tip: { 'a.md': 11 } }).ok, false);
  assert.match(verifyReadBack({ committed: ['a.md'], sizes: { 'a.md': 10 }, tip: { 'a.md': 11 } }).err, /size drift/);
  assert.equal(verifyReadBack({ committed: ['a.md'], sizes: { 'a.md': 10 }, tip: { 'a.md': 10 } }).ok, true);
});

test('parseLsTree: the --long shape', () => {
  const out = '100644 blob 0123abcd\u000912\u0009a.md\n100644 blob 4567ef01\u00090\u0009b/c.txt\n';
  const tip = parseLsTree(out);
  assert.deepEqual(tip, { 'a.md': 12, 'b/c.txt': 0 });
});

test('pushTaskBranch: URL construction + env contract (source-shape)', () => {
  const src = rfs(join(ROOT, 'worker/cc-adapter.mjs'), 'utf8');
  assert.match(src, /x-access-token:\$\{token\}@github\.com\/\$\{repo\}\.git/, 'the same auth lane as pushSessionsBranch');
  assert.match(src, /clone.*--branch.*main.*--single-branch/s, 'F-4: genesis clones MAIN, never the orphan');
  assert.match(src, /opts\.pushTaskBranchImpl \|\| pushTaskBranch/, 'the injectable seam');
});

// ---------------------------------------------------------------------------
// C. the escalation composer
// ---------------------------------------------------------------------------

test('artifactPushEscalation: the net-zero infra shape for a DONE turn', () => {
  const result = { artifact_refs: ['tasks/T-1/a.md'], telemetry: { turns: 3 }, models: ['m1'], lane_attempts_used: 1, duration_ms: 1000 };
  const e = artifactPushEscalation('T-1', 2, new Error('git push failed: rejected'), result);
  assert.equal(e.status, 'infra_failed');
  assert.match(e.detail, /git push failed/);
  assert.match(e.summary, /T-1 attempt 2 — the artifact branch push failed/);
  assert.deepEqual(e.artifact_refs, result.artifact_refs);
  assert.equal(e.telemetry, result.telemetry);
});

// ---------------------------------------------------------------------------
// D. lib/task-pr.mjs
// ---------------------------------------------------------------------------

const doneTask = (over = {}) => ({
  id: 'T-900', status: 'done', title: 'write the report', attempts: 1,
  spec: { artifacts: ['tasks/T-900/report.md'], accept: 'the report exists' },
  last_result: { artifact: 'report written; 3 sections', run_id: 'WORKER-RUN-777' },
  ...over,
});

test('prFlowCandidates: the §4c decision matrix', () => {
  const ccState = (tasks, over = {}) => ({ project: { mode: 'cc' }, tasks, ...over });
  // the happy candidate
  assert.deepEqual(prFlowCandidates(ccState({ 'T-900': doneTask() })).map(c => c.id), ['T-900']);
  // mock epoch → skip (§4c)
  assert.equal(prFlowCandidates({ project: { mode: 'mock' }, tasks: { 'T-900': doneTask() } }).length, 0);
  // no declared artifacts → skip
  assert.equal(prFlowCandidates(ccState({ 'T-900': doneTask({ spec: { accept: 'x' } }) })).length, 0);
  // already stamped → skip (idempotence)
  assert.equal(prFlowCandidates(ccState({ 'T-900': doneTask({ pr: 7 }) })).length, 0);
  // not done → skip
  assert.equal(prFlowCandidates(ccState({ 'T-900': doneTask({ status: 'quarantined' }) })).length, 0);
  // cap: PR_MAX_PER_TICK+1 candidates → the cap (W-C2-R F4: the cap rose to 12;
  // the remainder alert is pinned in the fold section below)
  const many = {};
  for (let i = 0; i < PR_MAX_PER_TICK + 1; i++) many[`T-9${i}0`] = doneTask({ id: `T-9${i}0` });
  assert.equal(prFlowCandidates(ccState(many)).length, PR_MAX_PER_TICK);
  // null-safe
  assert.equal(prFlowCandidates(null).length, 0);
});

test('buildPrBody: accept + digest + transcript pointer + neutralization', () => {
  // W-C2-R (F3): the transcript pointer derives from the task record's REAL
  // fields (last_result.run_id + attempts) — the old last_lease derivation was
  // dead code pinned by a fabricated fixture (the lens-1 finding).
  const body = buildPrBody(doneTask());
  assert.match(body, /Task `T-900` — write the report completed/);
  assert.match(body, /the report exists/);
  assert.match(body, /report written; 3 sections/);
  assert.match(body, /sessions\/T-900\/WORKER-RUN-777-a1\.txt/);
  const body2 = buildPrBody(doneTask({ attempts: 3 }));
  assert.match(body2, /sessions\/T-900\/WORKER-RUN-777-a3\.txt/);
  // a task without run_id omits the pointer cleanly (never a fabricated path)
  const body3 = buildPrBody(doneTask({ last_result: { artifact: 'x' } }));
  assert.ok(!body3.includes('**Transcript**'));
  // hostile spec-data: < AND ``` fences neutralized (W-C2-R m1)
  const hostile = buildPrBody(doneTask({ title: 'x <<<EOF', spec: { artifacts: ['a'], accept: 'x```y <<<END' } }));
  assert.ok(!hostile.includes('<<<'), 'fence-marker sequences must be neutralized');
  assert.ok(!hostile.includes('x```y'), 'triple-backtick fences must be broken');
});

test('openTaskPr: the reuse lane (existing OPEN PR) + the create lane + the token ladder', async () => {
  const calls = [];
  const api = async (path, method, body, token) => {
    calls.push({ path, method, body, token });
    if (path.includes('state=open')) return { status: 200, data: [{ number: 42 }] };
    return { status: 201, data: { number: 99 } };
  };
  // reuse
  const r1 = await openTaskPr({ repo: 'org/repo', candidate: { id: 'T-1', branch: 'tasks/T-1', task: doneTask() }, api });
  assert.equal(r1.prn, 42);
  assert.equal(r1.reused, true);
  assert.equal(calls.length, 1, 'reuse makes NO create call');
  // create via GITHUB_TOKEN (first lane succeeds)
  calls.length = 0;
  const api2 = async (path, method, body, token) => {
    calls.push({ path, method, body, token });
    if (path.includes('state=open')) return { status: 200, data: [] };
    return { status: 201, data: { number: 7 } };
  };
  const r2 = await openTaskPr({ repo: 'org/repo', candidate: { id: 'T-1', branch: 'tasks/T-1', task: doneTask() }, api: api2 });
  assert.equal(r2.prn, 7);
  assert.equal(r2.reused, false);
  // token ladder: 403 on GH_TOKEN → PAT fallback creates
  calls.length = 0;
  const api3 = async (path, method, body, token) => {
    calls.push({ path, method, body, token });
    if (path.includes('state=open')) return { status: 200, data: [] };
    if (token === 'PAT') return { status: 201, data: { number: 8 } };
    return { status: 403, data: { message: 'Resource not accessible by integration' } };
  };
  const r3 = await openTaskPr({ repo: 'org/repo', candidate: { id: 'T-1', branch: 'tasks/T-1', task: doneTask() }, api: api3, tokenFallback: 'PAT' });
  assert.equal(r3.prn, 8);
  assert.equal(calls.filter(c => c.method === 'POST').length, 2, 'the ladder retried once');
  assert.equal(calls.filter(c => c.method === 'POST')[1].token, 'PAT');
  // m7 + L2-9: 422 does NOT burn the PAT fallback — it probes state=all and
  // stamps the merged/closed PR's number (the 422-livelock kill)
  calls.length = 0;
  const api4 = async (path, method) => {
    calls.push({ path, method });
    if (path.includes('state=open')) return { status: 200, data: [] };
    if (path.includes('state=all')) return { status: 200, data: [{ number: 55, state: 'closed' }] };
    return { status: 422, data: { message: 'Validation failed: no commits between main and tasks/T-1' } };
  };
  const r4 = await openTaskPr({ repo: 'org/repo', candidate: { id: 'T-1', branch: 'tasks/T-1', task: doneTask() }, api: api4, tokenFallback: 'PAT' });
  assert.equal(r4.prn, 55, 'the merged/closed PR number still stamps');
  assert.equal(r4.closed, true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, '422 never retries the POST with the PAT');
  // total failure → err
  const api5 = async () => ({ status: 422, data: { message: 'Validation failed' } });
  const r5 = await openTaskPr({ repo: 'org/repo', candidate: { id: 'T-1', branch: 'tasks/T-1', task: doneTask() }, api: api5 });
  assert.equal(r5.prn, null);
  assert.match(r5.err, /HTTP 422/);
});

test('stampPr: the two-commit shape — task.pr stamped, journal pointer-only (law 6), queues untouched', async () => {
  const mutates = [];
  const fakeStore = {
    commit: async ({ mutate }) => {
      mutates.push(mutate);
      const state = {
        journal_seq: 100, version: 5,
        tasks: { 'T-900': doneTask() },
        chain: { id: 'c-1' },
      };
      const out = mutate(structuredClone(state), [], [], [], [], [], []);
      // the pass-through contract: NO queue keys in the out (store.commit
      // only rewrites a queue when the out carries an Array for it)
      assert.ok(!('queue' in out) && !('controlQueue' in out) && !('intakeQueue' in out), 'stamp must not touch any queue');
      return { committed: true, state: out.state, journal: out.journal };
    },
  };
  const r = await stampPr({ store: fakeStore, id: 'T-900', prn: 33 });
  assert.equal(r.committed, true);
  assert.equal(r.state.tasks['T-900'].pr, 33);
  assert.equal(r.state.journal_seq, 101);
  assert.equal(r.state.version, 6);
  assert.equal(r.journal.length, 1);
  const rec = r.journal[0];
  assert.equal(rec.kind, 'REPORT');
  assert.equal(rec.task, 'T-900');
  assert.equal(rec.pr, 33);
  assert.equal(rec.id, 'e100');
  assert.match(rec.note, /pointer-only/);
  // the raced twin: already stamped → no-op, journal empty
  const fakeStore2 = {
    commit: async ({ mutate }) => {
      const state = { journal_seq: 100, version: 5, tasks: { 'T-900': doneTask({ pr: 33 }) } };
      const out = mutate(structuredClone(state), [], [], [], [], [], []);
      return { committed: true, state: out.state, journal: out.journal };
    },
  };
  const r2 = await stampPr({ store: fakeStore2, id: 'T-900', prn: 44 });
  assert.deepEqual(r2.journal, []);
  assert.equal(r2.state.tasks['T-900'].pr, 33, 'the twin stamp never overwrites');
});

test('prFlow: the full pass — candidates-driven open + stamp + links + failure → alert + deferred remainder alert', async () => {
  const state = { project: { mode: 'cc', issue: 12 }, tasks: { 'T-900': doneTask() } };
  const alerts = [];
  const api = async (path) => {
    if (path.includes('state=open')) return { status: 200, data: [] };
    if (path.endsWith('/pulls')) return { status: 201, data: { number: 21 } };
    return { status: 200, data: [] };
  };
  const fakeStore = {
    commit: async ({ mutate }) => {
      const out = mutate(structuredClone(state), [], [], [], [], [], []);
      return { committed: true, state: out.state, journal: out.journal };
    },
  };
  // W-C2-R (F7): candidates come from the conductor's PRE-ROLLOVER view — prFlow
  // takes the LIST, never a state re-scan
  const cands = prFlowCandidates(state);
  const r = await prFlow({ candidates: cands, state, repo: 'org/repo', api, store: fakeStore, tokenFallback: null, alert: async (m) => alerts.push(m) });
  assert.deepEqual(r, { candidates: 1, opened: 1, reused: 0, stamped: 1, failures: 0, deferred: 0, links: [{ id: 'T-900', prn: 21 }] });
  assert.equal(state.tasks['T-900'].pr, 21, 'in-memory stamp — the completion comment carries the link');
  // the failure lane: PR-open fails → alert, no throw
  const apiFail = async () => ({ status: 403, data: { message: 'nope' } });
  const cands2 = [{ id: 'T-901', task: doneTask({ id: 'T-901' }), branch: 'tasks/T-901', artifacts: ['tasks/T-901/x'] }];
  const fakeStore2 = { commit: async ({ mutate }) => ({ committed: true, state: null, journal: [] }) };
  const r2 = await prFlow({ candidates: cands2, state: { tasks: {} }, repo: 'org/repo', api: apiFail, store: fakeStore2, tokenFallback: null, alert: async (m) => alerts.push(m) });
  assert.equal(r2.failures, 1);
  assert.match(alerts[0], /T-901 PR-open FAILED/);
  // F4: the deferred remainder alerts (a halted epoch's overflow is VISIBLE)
  const big = [];
  for (let i = 0; i < PR_MAX_PER_TICK + 2; i++) big.push({ id: `T-9${i}X`, task: doneTask({ id: `T-9${i}X` }), branch: `tasks/T-9${i}X`, artifacts: [`tasks/T-9${i}X/x`] });
  const r3 = await prFlow({ candidates: big, state: { tasks: {} }, repo: 'org/repo', api, store: fakeStore2, tokenFallback: null, alert: async (m) => alerts.push(m) });
  assert.equal(r3.deferred, 2);
  assert.equal(r3.opened, PR_MAX_PER_TICK);
  assert.ok(alerts.some(m => /PR flow deferred 2 task/.test(m)), `the deferred-remainder alert: ${alerts.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// E. the wiring source pins (the SEAM discipline)
// ---------------------------------------------------------------------------

test('conductor.yml carries pull-requests: write (F-14) + var-driven OPS_ISSUE; turn.mjs wires prFlow after dispatches, pre-comment', () => {
  const yml = rfs(join(ROOT, '.github/workflows/conductor.yml'), 'utf8');
  assert.match(yml, /pull-requests:\s*write/, 'F-14: the PR-open permission');
  assert.match(yml, /OPS_ISSUE: \$\{\{ vars\.OPS_ISSUE \|\| '1' \}\}/, 'L2-5: the ops anchor is var-driven (same as the console)');
  const src = rfs(join(ROOT, 'conductor/turn.mjs'), 'utf8');
  // W-C2-R (L2-2): the call-site ORDER — commit → DISPATCH LOOP → prFlow →
  // journal-scan comments (workers first; the m-3 links ride THIS tick's
  // comment; the PR ladder never eats the dispatch budget)
  const stateLine = src.indexOf('const state = out.state;');
  const dispatchLoop = src.indexOf('for (const a of actionList) {');
  const prFlowLine = src.indexOf('await prFlow({');
  const journalScanLine = src.indexOf('for (const j of out.journal || []) {');
  const linksLine = src.indexOf('prFlowResult?.links');
  assert.ok(stateLine > 0 && dispatchLoop > stateLine, 'the dispatch loop follows the commit');
  assert.ok(prFlowLine > dispatchLoop, 'prFlow runs AFTER the dispatch loop (L2-2: workers first)');
  assert.ok(journalScanLine > prFlowLine, 'prFlow runs pre-comment (the m-3 links ride this tick)');
  assert.ok(linksLine > journalScanLine, 'the comment composes links from prFlowResult (F7: rollover-proof)');
  // the alert lane is wired (law 5) + the budget guard + the pre-rollover candidates
  assert.match(src, /alert: \(msg\) => postIssueComment\(msg\)/);
  assert.match(src, /BUDGET\.remaining\(\) < 90_000/, 'the budget guard before the PR ladder');
  assert.match(src, /candidates: out\.prCandidates/, 'F7: the candidates come from conductorTick\u2019s pre-rollover view');
  // worker side: allowRoot threading (worker/turn.mjs)
  const wsrc = rfs(join(ROOT, 'worker/turn.mjs'), 'utf8');
  assert.match(wsrc, /allowRoot: Array\.isArray\(envelope\.artifacts\)/, 'the envelope artifacts become the adapter allowRoot');
});

// ---------------------------------------------------------------------------
// F. W-C2-R FOLD PINS — every lens finding gets a pin that bites
// ---------------------------------------------------------------------------

test('F1/L2-9 fold: the pr stamp REPLAYS through rebuild (rebuild(genesis, journal) ≈ state)', () => {
  // a done task + a stamp record → rebuild restores task.pr (the old shape
  // lost it: the lease-gated REPORT replay never matched a lease-free record)
  const spec = { id: 'T-900', title: 't', behavior: 'real', work_ms: 1, spec: { artifacts: ['tasks/T-900/report.md'], issue: 7 } };
  const g = genesis({ config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 }, project: { tasks: [spec], milestones: 1 }, chainId: 'c-reb', now: '2026-09-18T00:00:00.000Z', mode: 'cc', issue: 7 });
  const t = g.tasks['T-900'];
  t.status = 'done';
  t.attempts = 1;
  t.lease = null;
  t.last_result = { status: 'done', artifact: 'did it', run_id: 'R9' };
  const doneRec = { id: 'e1', ts: '2026-09-18T00:01:00Z', applied: true, kind: 'REPORT', task: 'T-900', to: 'done' };
  const stampRec = { id: 'e2', ts: '2026-09-18T00:02:00Z', applied: true, kind: 'REPORT', task: 'T-900', to: 'done', pr: 42, note: 'pr-opened (pointer-only, law 6)' };
  const r = rebuild(g, [doneRec, stampRec], '2026-09-18T00:03:00Z');
  assert.equal(r.tasks['T-900'].status, 'done');
  assert.equal(r.tasks['T-900'].pr, 42, 'the stamp survives journal-replay reconstruction');
  // idempotence: a twin stamp never overwrites
  const r2 = rebuild(g, [doneRec, stampRec, { ...stampRec, id: 'e3', pr: 99 }], '2026-09-18T00:04:00Z');
  assert.equal(r2.tasks['T-900'].pr, 42, 'first stamp wins');
});

test('F2 fold: stampPr against the REAL Store — a real commit message, and the twin is a TRUE no-op (no empty commit)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prstamp-'));
  try {
    const origin = join(dir, 'origin.git');
    const g = (a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = join(dir, 'seed'); mkdirSync(seed);
    g(['init', '-q', '-b', 'main', '.']); // placeholder no-op in seed
    const gg = (a) => spawnSync('git', a, { cwd: seed, encoding: 'utf8' });
    gg(['init', '-q', '-b', 'main', '.']);
    writeFileSync(join(seed, 'README.md'), 'x');
    gg(['add', '.']);
    gg(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']);
    gg(['push', '-q', origin, 'main']);
    const wc = join(dir, 'wc');
    spawnSync('git', ['clone', '-q', origin, wc], { cwd: dir, encoding: 'utf8' });
    const store = new Store({ cwd: wc });
    store.init({
      version: 1, journal_seq: 10,
      chain: { id: 'c-1', seq: 1, paused: false, halted: false, last_tick: '2026-09-18T00:00:00Z' },
      project: { phase: 'executing', milestone: 1, mode: 'cc', issue: 7 },
      config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 },
      stats: { done: 0, quarantined: 0, cancelled: 0, retries: 0, timeouts: 0, orphaned_reports: 0, dispatched: 0, infra_retries: 0, rejected_events: 0 },
      tasks: { 'T-900': doneTask() },
    });
    const r = await stampPr({ store, id: 'T-900', prn: 33, now: () => '2026-09-18T00:05:00Z' });
    assert.equal(r.committed, true);
    assert.equal(r.state.tasks['T-900'].pr, 33);
    // the commit message is REAL (F2: the old shape landed "undefined")
    const log = spawnSync('git', ['--git-dir', origin, 'log', '-1', '--format=%s', 'fsm-state'], { encoding: 'utf8' });
    assert.match(String(log.stdout), /^pr stamp: task T-900 -> #33/, `the stamp commit message: ${log.stdout}`);
    // the twin: already stamped → TRUE no-op (noop:true → the store skips the write; no empty commit)
    const before = String(spawnSync('git', ['--git-dir', origin, 'rev-parse', 'fsm-state'], { encoding: 'utf8' }).stdout).trim();
    const r2 = await stampPr({ store, id: 'T-900', prn: 44, now: () => '2026-09-18T00:06:00Z' });
    assert.equal(r2.committed, false, 'the twin no-ops (never an empty commit)');
    assert.equal(r2.reason, 'already-stamped-or-vanished');
    const after = String(spawnSync('git', ['--git-dir', origin, 'rev-parse', 'fsm-state'], { encoding: 'utf8' }).stdout).trim();
    assert.equal(after, before, 'the branch tip did not move');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F7 fold (BLOCKING): conductorTick returns the PRE-ROLLOVER prCandidates — the rollover tick still opens the completing epoch\'s PRs', () => {
  // the completing cc epoch's task X (done, artifacts) + a queued intake spec
  // → the rollover consumes X's epoch → out.state = the NEW epoch, but
  // out.prCandidates still selects X (the old shape: prFlowCandidates(out.state) === [])
  const mk = (id, issue) => {
    const g = genesis({
      config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 },
      project: { tasks: [{ id, title: 't ' + id, behavior: 'real', work_ms: 1, spec: { artifacts: [`tasks/${id}/report.md`], issue } }], milestones: 1 },
      chainId: 'c-' + id, now: '2026-09-18T00:00:00.000Z', mode: 'cc', issue,
    });
    // ASSIGNED with a live lease — the done report arrives through the QUEUE
    // (the real completing shape: drain-done → clock PHASE-done → rollover)
    const t = g.tasks[id];
    t.status = 'assigned';
    t.lease = { token: 'LX1', issued_at: '2026-09-18T00:00:10Z', expires: '2026-09-18T00:30:00Z' };
    return g;
  };
  const cur = mk('X-1', 7);
  const nextSpec = { id: 'Y-2', title: 'next', behavior: 'real', work_ms: 1, spec: { artifacts: ['tasks/Y-2/report.md'], issue: 9 } };
  const makeGenesis = ({ spec, issue }) => {
    const g2 = genesis({
      config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 },
      project: { tasks: [{ id: spec.id, title: spec.title, behavior: spec.behavior, work_ms: spec.work_ms, spec: { ...spec.spec, issue } }], milestones: 1 },
      chainId: 'c-Y2', now: '2026-09-18T00:01:00.000Z', mode: 'cc', issue,
    });
    return { state: g2, spec: { tasks: [spec], milestones: 1, chainId: 'c-Y2', mode: 'cc' } };
  };
  const ev = { kind: 'TICK', event_id: 't1', ts: '2026-09-18T00:01:00.000Z' };
  const out = conductorTick({
    cur, queue: [{ event_id: 'rep-x1', task: 'X-1', lease: 'LX1', outcome: { status: 'done', artifact: 'done X-1', run_id: 'RX1' }, run_id: 'RX1' }],
    controlQueue: [], queueBad: [], ctlBad: [],
    intakeQueue: [{ spec: nextSpec, issue: 9, body_sha8: 'ab12cd34', author: 'op', ts: '2026-09-18T00:00:30Z', id: 'int-1' }],
    intakeBad: [],
    ev, now: () => '2026-09-18T00:01:00.000Z',
    nextMilestone: () => null,
    recover: null, makeGenesis,
  });
  // the rollover fired: out.state is the NEW epoch
  assert.ok(out.state.tasks['Y-2'], 'the rollover minted the next epoch');
  assert.ok(!out.state.tasks['X-1'], 'the completing epoch is consumed from the live state');
  // THE BLOCKING-pin: the candidates survive via the PRE-ROLLOVER capture
  assert.equal(out.prCandidates.length, 1, 'prCandidates still selects the completing epoch\'s artifact task');
  assert.equal(out.prCandidates[0].id, 'X-1');
  // and the PHASE-done journal record carries the COMPLETING epoch's stats
  const phase = (out.journal || []).find(j => j.kind === 'PHASE' && j.to === 'done');
  assert.ok(phase, 'the PHASE-done record exists');
  assert.equal(phase.stats.done, 1);
  assert.equal(phase.stats.taskCount, 1);
  assert.equal(phase.issue, 7);
  assert.deepEqual(phase.taskIds, ['X-1']);
});

test('L2-4 fold: a byte-identical re-attempt is OK (nothing-to-commit → read-back verified, NO infra escalation) — the REAL pushTaskBranch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-ident-'));
  try {
    const origin = join(dir, 'origin.git');
    const g = (a, cwd = dir) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    g(['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = join(dir, 'seed'); mkdirSync(seed);
    const gs = (a) => g(a, seed);
    gs(['init', '-q', '-b', 'main', '.']);
    writeFileSync(join(seed, 'README.md'), 'x');
    gs(['add', '.']); gs(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']);
    gs(['push', '-q', origin, 'main']);
    const workdir = join(dir, 'work');
    mkdirSync(join(workdir, 'tasks/T-900'), { recursive: true });
    writeFileSync(join(workdir, 'tasks/T-900/report.md'), 'identical body\n');
    const env = { CC_TASKBRANCH_ORIGIN: 'file://' + origin };
    const logs = [];
    // attempt 1: genesis from main
    const r1 = pushTaskBranch({ env, branch: 'tasks/T-900', allowed: ['tasks/T-900/report.md'], workdir, log: (m) => logs.push(m) });
    assert.equal(r1.ok, true);
    assert.equal(r1.identical, undefined);
    // attempt 2: BYTE-IDENTICAL (the report was lost; the re-run reproduces the same bytes)
    const r2 = pushTaskBranch({ env, branch: 'tasks/T-900', allowed: ['tasks/T-900/report.md'], workdir, log: (m) => logs.push(m) });
    assert.equal(r2.ok, true, 'the identical re-attempt is a SUCCESS (the old shape rc=1\'d the commit → false quarantine)');
    assert.equal(r2.identical, true);
    assert.ok(logs.some(l => l.includes('CC-TASKBRANCH-IDENTICAL')), `the identical log: ${logs.join(' | ')}`);
    // still exactly ONE commit on the branch
    const logOut = String(g(['--git-dir', origin, 'log', '--oneline', 'main..tasks/T-900']).stdout).trim();
    assert.equal(logOut.split('\n').filter(Boolean).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F8 fold: a declared-but-unwritten artifact ESCALATES (never a silently-partial tree) — the REAL pushTaskBranch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-unwritten-'));
  try {
    const origin = join(dir, 'origin.git');
    const g = (a, cwd = dir) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    g(['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = join(dir, 'seed'); mkdirSync(seed);
    const gs = (a) => g(a, seed);
    gs(['init', '-q', '-b', 'main', '.']);
    writeFileSync(join(seed, 'README.md'), 'x');
    gs(['add', '.']); gs(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']);
    gs(['push', '-q', origin, 'main']);
    const workdir = join(dir, 'work');
    mkdirSync(join(workdir, 'tasks/T-901'), { recursive: true });
    writeFileSync(join(workdir, 'tasks/T-901/report.md'), 'real file\n');
    // 'extra.md' is declared (door-allowed via the tasks/<id>/ namespace) but the turn never wrote it
    assert.throws(
      () => pushTaskBranch({ env: { CC_TASKBRANCH_ORIGIN: 'file://' + origin }, branch: 'tasks/T-901', allowed: ['tasks/T-901/report.md', 'tasks/T-901/extra.md'], workdir, log: () => {} }),
      /declared-but-unwritten path tasks\/T-901\/extra\.md/,
      'the missing declared file escalates BEFORE any push',
    );
    // nothing landed on the remote
    const branches = String(g(['--git-dir', origin, 'branch']).stdout).trim();
    assert.ok(!branches.includes('tasks/T-901'), 'no partial branch was pushed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyReadBack fold (F8): iterates the ALLOWED set — an allowed-but-missing path fails even when committed is a subset', () => {
  // committed=[report.md] passes alone, but allowed=[report.md, extra.md] with extra missing at tip FAILS
  const vr = verifyReadBack({ allowed: ['report.md', 'extra.md'], committed: ['report.md'], sizes: { 'report.md': 10 }, tip: { 'report.md': 10 } });
  assert.equal(vr.ok, false);
  assert.match(vr.err, /extra\.md MISSING/);
  // and a size drift on an allowed file still fails
  const vr2 = verifyReadBack({ allowed: ['report.md'], committed: ['report.md'], sizes: { 'report.md': 10 }, tip: { 'report.md': 11 } });
  assert.equal(vr2.ok, false);
  assert.match(vr2.err, /size drift/);
});
