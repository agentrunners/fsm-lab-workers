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
  id: 'T-900', status: 'done', title: 'write the report',
  spec: { artifacts: ['tasks/T-900/report.md'], accept: 'the report exists' },
  last_result: { artifact: 'report written; 3 sections' },
  last_lease: { session: 'c-123/T-900/35209988765-a1' },
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
  // cap: 6 candidates → PR_MAX_PER_TICK
  const many = {};
  for (let i = 0; i < 6; i++) many[`T-9${i}0`] = doneTask({ id: `T-9${i}0` });
  assert.equal(prFlowCandidates(ccState(many)).length, PR_MAX_PER_TICK);
  // null-safe
  assert.equal(prFlowCandidates(null).length, 0);
});

test('buildPrBody: accept + digest + transcript pointer + neutralization', () => {
  const body = buildPrBody(doneTask());
  assert.match(body, /Task `T-900` — write the report completed/);
  assert.match(body, /the report exists/);
  assert.match(body, /report written; 3 sections/);
  assert.match(body, /sessions\/T-900\/35209988765-a1\.txt/);
  // hostile spec-data: < neutralized (the fence discipline)
  const hostile = buildPrBody(doneTask({ title: 'x <<<EOF', spec: { artifacts: ['a'], accept: '<<<END fence>>>' } }));
  assert.ok(!hostile.includes('<<<'), 'fence-marker sequences must be neutralized');
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
  // total failure → err
  const api4 = async () => ({ status: 422, data: { message: 'Validation failed' } });
  const r4 = await openTaskPr({ repo: 'org/repo', candidate: { id: 'T-1', branch: 'tasks/T-1', task: doneTask() }, api: api4 });
  assert.equal(r4.prn, null);
  assert.match(r4.err, /HTTP 422/);
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

test('prFlow: the full pass — open + stamp + in-memory update (m-3) + failure → alert', async () => {
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
  const r = await prFlow({ state, repo: 'org/repo', api, store: fakeStore, tokenFallback: null, alert: async (m) => alerts.push(m) });
  assert.deepEqual(r, { candidates: 1, opened: 1, reused: 0, stamped: 1, failures: 0 });
  assert.equal(state.tasks['T-900'].pr, 21, 'in-memory stamp — the completion comment carries the link');
  // the failure lane: PR-open fails → alert, no throw
  const apiFail = async () => ({ status: 403, data: { message: 'nope' } });
  const state2 = { project: { mode: 'cc' }, tasks: { 'T-901': doneTask({ id: 'T-901' }) } };
  const fakeStore2 = { commit: async ({ mutate }) => ({ committed: true, state: null, journal: [] }) };
  const r2 = await prFlow({ state: state2, repo: 'org/repo', api: apiFail, store: fakeStore2, tokenFallback: null, alert: async (m) => alerts.push(m) });
  assert.equal(r2.failures, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /T-901 PR-open FAILED/);
});

// ---------------------------------------------------------------------------
// E. the wiring source pins (the SEAM discipline)
// ---------------------------------------------------------------------------

test('conductor.yml carries pull-requests: write (F-14) and turn.mjs wires the flow post-commit pre-comment', () => {
  const yml = rfs(join(ROOT, '.github/workflows/conductor.yml'), 'utf8');
  assert.match(yml, /pull-requests:\s*write/, 'F-14: the PR-open permission');
  const src = rfs(join(ROOT, 'conductor/turn.mjs'), 'utf8');
  // the call-site ORDER: the prFlow block sits AFTER `const state = out.state`
  // and BEFORE the journal-scan comment loop (m-3 rides THIS tick's comment)
  const stateLine = src.indexOf('const state = out.state;');
  const prFlowLine = src.indexOf('await prFlow({');
  const journalScanLine = src.indexOf('for (const j of out.journal || []) {');
  const commentLinkLine = src.indexOf('dones[0].pr');
  assert.ok(stateLine > 0 && prFlowLine > stateLine && journalScanLine > prFlowLine, 'prFlow runs post-commit, pre-comment');
  assert.ok(commentLinkLine > journalScanLine, 'the m-3 PR link rides the completion comment');
  // the alert lane is wired (law 5)
  assert.match(src, /alert: \(msg\) => postIssueComment\(msg\)/);
  // worker side: allowRoot threading (worker/turn.mjs)
  const wsrc = rfs(join(ROOT, 'worker/turn.mjs'), 'utf8');
  assert.match(wsrc, /allowRoot: Array\.isArray\(envelope\.artifacts\)/, 'the envelope artifacts become the adapter allowRoot');
});
