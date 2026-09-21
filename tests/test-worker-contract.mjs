// test-worker-contract.mjs — the W-B CONTRACT suite (T46 §1a / §1g).
// Pins the three pure surfaces of lib/worker-contract.mjs against the
// published interface contract (W2's conductor, W3's shim + adapter, W4's
// conformance all build against THESE signatures):
//   envelopeFromDispatch(cp, nowMs)  — the law-1 start-gate input, with the
//     F-B2 legacy-compat rule (minimal live ASSIGN shapes get DEFAULTS,
//     only corrupt/contradictory shapes fail closed)
//   writeBackDoor({branch, paths, sizes, allowRoot}) — the artifact pathspec
//     governance (pure validation; the remote read-back verification lands
//     with the adapter wave and consumes this return shape)
//   classifyOutcome(raw, ctx) — the five-class normalizer, F-M4 hardened
//     (reasoning-first models, budget-misconfigured truncation, error-as-
//     answer marker text)
//   mintEventId / MINT_TABLE — re-exported from event-ingest.mjs (F-B3: the
//     table lives THERE, next to the live mint sites — forking the source
//     would regress probe6)
//
// The FULL live ASSIGN payload (conductor/turn.mjs:223-227) is pinned
// verbatim in the legacy-compat block — when the W-B conductor starts
// minting full envelopes, today's epochs must keep flowing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  envelopeFromDispatch, writeBackDoor, classifyOutcome,
  mintEventId, MINT_TABLE,
  ENVELOPE_MARGIN_MS, ENVELOPE_MODES, WRITE_BACK_CAP_FILE_BYTES, WRITE_BACK_CAP_TASK_BYTES,
  DEFAULT_ERROR_MARKERS, OUTCOME_CLASSES,
} from '../lib/worker-contract.mjs';
import { buildEvent, reportEventId } from '../lib/event-ingest.mjs';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// envelopeFromDispatch — the ok-shapes.
// ---------------------------------------------------------------------------

test('envelope: FULL shape — every field explicit, precomputed deadline passes through unmargined', () => {
  const cp = {
    task: 'T42', attempt: 3, mode: 'cc',
    prompt: 'Refactor the frobnicator',
    deadline_ms: NOW + 600_000,           // the W-B conductor pre-computes min(lease−margin, TTL−margin)
    session: 'c-77/T42/run-9-a3',
    budget: { max_turns: 12, wall_ms: 480_000, lane_attempts: 2 },
  };
  const r = envelopeFromDispatch(cp, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.envelope, {
    task_ref: { kind: 'state-task', id: 'T42' },
    prompt: 'Refactor the frobnicator',
    deadline_ms: NOW + 600_000,
    session: 'c-77/T42/run-9-a3',
    budget: { max_turns: 12, wall_ms: 480_000, lane_attempts: 2 },
    mode: 'cc',
    attempt: 3,
  });
});

test('envelope: FULL shape without session — derived `${chainId}/${taskId}/${runId}-a${attempt}`', () => {
  const r = envelopeFromDispatch({
    task: 'T1', attempt: 2, mode: 'real', prompt: 'p',
    deadline_ms: NOW + 300_000, chain: 'c-abc', run_id: '998877',
  }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.envelope.session, 'c-abc/T1/998877-a2');
});

test('envelope: F-B2 LEGACY-MINIMAL — today\'s live ASSIGN payload gets DEFAULTS, not a rejection', () => {
  // the EXACT client_payload conductor/turn.mjs mints today (line ~223-227)
  const cp = {
    task: 'A3', lease: 'l-abc123def456', behavior: 'succeed',
    attempt: 1, work_ms: 6000, expires: iso(NOW + 900_000), chain: 'c-123',
  };
  const r = envelopeFromDispatch(cp, NOW);
  assert.equal(r.ok, true, `legacy minimalism is NOT corrupt: ${JSON.stringify(r)}`);
  const e = r.envelope;
  // v1 task_ref: the task record lives in state.json
  assert.deepEqual(e.task_ref, { kind: 'state-task', id: 'A3' });
  // prompt <- title <- the literal `task <id>` (no title on the live payload)
  assert.equal(e.prompt, 'task A3');
  // mode <- 'mock'
  assert.equal(e.mode, 'mock');
  // attempt passthrough
  assert.equal(e.attempt, 1);
  // deadline = lease expiry − margin (no TTL supplied)
  assert.equal(e.deadline_ms, NOW + 900_000 - ENVELOPE_MARGIN_MS);
  // budget defaults: max_turns 40, wall from the remaining window, lanes 3
  assert.equal(e.budget.max_turns, 40);
  assert.equal(e.budget.lane_attempts, 3);
  assert.equal(e.budget.wall_ms, 900_000 - ENVELOPE_MARGIN_MS);
  // session derived on the local smoke lane
  assert.equal(e.session, 'c-123/A3/local-a1');
});

test('envelope: legacy prompt fallback order — prompt > title > `task <id>`', () => {
  const base = { task: 'X', attempt: 1, expires: iso(NOW + 600_000) };
  assert.equal(envelopeFromDispatch({ ...base, title: 'the title' }, NOW).envelope.prompt, 'the title');
  assert.equal(envelopeFromDispatch({ ...base, prompt: 'the prompt', title: 'the title' }, NOW).envelope.prompt, 'the prompt');
  assert.equal(envelopeFromDispatch(base, NOW).envelope.prompt, 'task X');
  // an EMPTY string falls through (minimal, not corrupt)
  assert.equal(envelopeFromDispatch({ ...base, prompt: '', title: '' }, NOW).envelope.prompt, 'task X');
});

test('envelope: legacy deadline derivation — min(lease expiry, now+ttl_ms) − margin', () => {
  // TTL tighter than the lease
  const a = envelopeFromDispatch({ task: 'X', expires: iso(NOW + 900_000), ttl_ms: 300_000 }, NOW);
  assert.equal(a.envelope.deadline_ms, NOW + 300_000 - ENVELOPE_MARGIN_MS);
  // lease tighter than the TTL
  const b = envelopeFromDispatch({ task: 'X', expires: iso(NOW + 300_000), ttl_ms: 900_000 }, NOW);
  assert.equal(b.envelope.deadline_ms, NOW + 300_000 - ENVELOPE_MARGIN_MS);
  // TTL only (no lease field)
  const c = envelopeFromDispatch({ task: 'X', ttl_ms: 240_000 }, NOW);
  assert.equal(c.envelope.deadline_ms, NOW + 240_000 - ENVELOPE_MARGIN_MS);
  // margin is the F-G(a) proven 2 minutes
  assert.equal(ENVELOPE_MARGIN_MS, 120_000);
});

test('envelope: wall_ms default — the remaining window with the 60s config floor', () => {
  // a 30s remaining window floors wall_ms at 60s (harness-config minimum);
  // the ABSOLUTE deadline still gates (the adapter kills at deadline_ms)
  const r = envelopeFromDispatch({ task: 'X', expires: iso(NOW + 30_000 + ENVELOPE_MARGIN_MS) }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.envelope.deadline_ms, NOW + 30_000);
  assert.equal(r.envelope.wall_ms_placeholder ?? r.envelope.budget.wall_ms, 60_000);
});

test('envelope: explicit task_ref passes through when consistent; bounds stay enforced', () => {
  const ok = envelopeFromDispatch({ task: 'T9', attempt: 1, deadline_ms: NOW + 60_000, task_ref: { kind: 'state-task', id: 'T9' } }, NOW);
  assert.deepEqual(ok.envelope.task_ref, { kind: 'state-task', id: 'T9' });
  assert.equal(ENVELOPE_MODES.join('|'), 'mock|real|cc');
  // (the genesis-mode vocabulary cross-check lives in test-fsm.mjs — the
  // fsm wave adds GENESIS_MODES; this file pins the CONTRACT surfaces only)
});

// ---------------------------------------------------------------------------
// envelopeFromDispatch — the fail-closed shapes (corrupt/contradictory ONLY).
// ---------------------------------------------------------------------------

test('envelope: FAIL-CLOSED — deadline in the past (the law-1 late-start class)', () => {
  const past = envelopeFromDispatch({ task: 'T1', deadline_ms: NOW - 1 }, NOW);
  assert.equal(past.ok, false);
  assert.equal(past.class, 'infra_failed');
  assert.equal(past.reason, 'deadline-in-past');
  // the legacy lane: an already-expired lease
  const expiredLease = envelopeFromDispatch({ task: 'T1', expires: iso(NOW - 5_000) }, NOW);
  assert.equal(expiredLease.ok, false);
  assert.equal(expiredLease.reason, 'deadline-in-past');
  // deadline EXACTLY now is still late (nothing runnable remains)
  assert.equal(envelopeFromDispatch({ task: 'T1', deadline_ms: NOW }, NOW).ok, false);
});

test('envelope: FAIL-CLOSED — unknown mode (a typo\'d mode would run the wrong harness)', () => {
  for (const mode of ['monk', 'CC', 'real1', 42, {}]) {
    const r = envelopeFromDispatch({ task: 'T1', mode, deadline_ms: NOW + 60_000 }, NOW);
    assert.equal(r.ok, false, `mode=${JSON.stringify(mode)} must fail`);
    assert.equal(r.reason, 'unknown-mode');
    assert.equal(r.class, 'infra_failed');
  }
  // null/undefined/'' are ABSENT (minimal, not corrupt) -> the 'mock' default
  // (an unset field can serialize as '' through the dispatch payload lane)
  for (const mode of [undefined, null, '']) {
    const r = envelopeFromDispatch({ task: 'T1', mode, deadline_ms: NOW + 60_000 }, NOW);
    assert.equal(r.ok, true, `mode=${JSON.stringify(mode)} is absent, not unknown`);
    assert.equal(r.envelope.mode, 'mock');
  }
});

test('envelope: FAIL-CLOSED — non-integer / negative attempt', () => {
  for (const attempt of [0, -1, 1.5, '2', null]) {
    // null is treated as absent (default 1) — only PRESENT garbage fails
    if (attempt === null) continue;
    const r = envelopeFromDispatch({ task: 'T1', attempt, deadline_ms: NOW + 60_000 }, NOW);
    assert.equal(r.ok, false, `attempt=${JSON.stringify(attempt)} must fail`);
    assert.equal(r.reason, 'bad-attempt');
  }
  assert.equal(envelopeFromDispatch({ task: 'T1', attempt: null, deadline_ms: NOW + 60_000 }, NOW).envelope.attempt, 1,
    'absent/null attempt -> the default 1 (minimal, not corrupt)');
});

test('envelope: FAIL-CLOSED — missing / corrupt task id', () => {
  for (const task of [undefined, null, '', 42, {}, []]) {
    const r = envelopeFromDispatch({ task, deadline_ms: NOW + 60_000 }, NOW);
    assert.equal(r.ok, false, `task=${JSON.stringify(task)} must fail`);
    assert.equal(r.reason, 'missing-task-id');
  }
  // the payload itself
  for (const cp of [null, 'x', 42, [], undefined]) {
    const r = envelopeFromDispatch(cp, NOW);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-payload');
  }
});

test('envelope: FAIL-CLOSED — contradictory task_ref, bad budget fields, no deadline source', () => {
  // task_ref pointing at a DIFFERENT task than cp.task
  assert.equal(envelopeFromDispatch({ task: 'T1', task_ref: { kind: 'state-task', id: 'OTHER' }, deadline_ms: NOW + 60_000 }, NOW).reason, 'bad-task-ref');
  assert.equal(envelopeFromDispatch({ task: 'T1', task_ref: { kind: 'issue', id: 'T1' }, deadline_ms: NOW + 60_000 }, NOW).reason, 'bad-task-ref');
  // out-of-bounds explicit budget fields
  const dl = { deadline_ms: NOW + 600_000 };
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { max_turns: 0 } }, NOW).reason, 'bad-budget');
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { max_turns: 1.5 } }, NOW).reason, 'bad-budget');
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { wall_ms: 30_000 } }, NOW).reason, 'bad-budget'); // < 60s floor
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { lane_attempts: 0 } }, NOW).reason, 'bad-budget');
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { lane_attempts: 9 } }, NOW).reason, 'bad-budget');
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: 'big' }, NOW).reason, 'bad-budget');
  // lane bounds: 1..8 inclusive
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { lane_attempts: 1 } }, NOW).ok, true);
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, budget: { lane_attempts: 8 } }, NOW).ok, true);
  // no deadline source AT ALL (not the live ASSIGN shape, not the full shape)
  assert.equal(envelopeFromDispatch({ task: 'T1' }, NOW).reason, 'no-deadline-source');
  // non-string prompt/title
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, prompt: 42 }, NOW).reason, 'bad-prompt');
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, title: {} }, NOW).reason, 'bad-prompt');
  // non-string precomputed session
  assert.equal(envelopeFromDispatch({ task: 'T1', ...dl, session: 7 }, NOW).reason, 'bad-session');
  // non-finite explicit deadline
  assert.equal(envelopeFromDispatch({ task: 'T1', deadline_ms: 'soon' }, NOW).reason, 'bad-deadline');
});

// ---------------------------------------------------------------------------
// writeBackDoor — the allowlist / deny matrix.
// ---------------------------------------------------------------------------

test('door: `tasks/<id>/**` for the branch\'s task id is ALLOWED (nested, multiple)', () => {
  const r = writeBackDoor({
    branch: 'tasks/T7',
    paths: ['tasks/T7/out.txt', 'tasks/T7/deep/nested/report.md', 'tasks/T7/a', 'tasks/T7/b/c/d.json'],
    sizes: { 'tasks/T7/out.txt': 1024 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.allowed, ['tasks/T7/out.txt', 'tasks/T7/deep/nested/report.md', 'tasks/T7/a', 'tasks/T7/b/c/d.json']);
  assert.equal(r.taskId, 'T7');
  assert.equal(r.totalBytes, 1024);
  assert.deepEqual(r.caps, { fileBytes: WRITE_BACK_CAP_FILE_BYTES, taskTotalBytes: WRITE_BACK_CAP_TASK_BYTES });
});

test('door: the namespace is the BRANCH\'S task id — a sibling task\'s dir is undeclared', () => {
  const r = writeBackDoor({ branch: 'tasks/T7', paths: ['tasks/OTHER/out.txt'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ['undeclared(tasks/OTHER/out.txt)']);
});

test('door: DENY ALWAYS — `.github/**` and `.git*` even when DECLARED (deny wins over the allowlist)', () => {
  const r = writeBackDoor({
    branch: 'tasks/T7',
    paths: ['.github/workflows/evil.yml', '.gitignore', '.gitmodules', 'src/.git/config', 'tasks/T7/.git-hooks'],
    allowRoot: ['.github/workflows/evil.yml', '.gitignore', '.gitmodules'],  // declaring does NOT unlock
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [
    'deny-dotgit(.github/workflows/evil.yml)',
    'deny-dotgit(.gitignore)',
    'deny-dotgit(.gitmodules)',
    'deny-dotgit(src/.git/config)',
    'deny-dotgit(tasks/T7/.git-hooks)',
  ]);
});

test('door: root files (no `/`) are denied unless declared in allowRoot (cp.artifacts)', () => {
  const undeclared = writeBackDoor({ branch: 'tasks/T7', paths: ['README.md'] });
  assert.equal(undeclared.ok, false);
  assert.deepEqual(undeclared.violations, ['root-not-declared(README.md)']);
  const declared = writeBackDoor({ branch: 'tasks/T7', paths: ['README.md'], allowRoot: ['README.md'] });
  assert.equal(declared.ok, true, JSON.stringify(declared.violations));
  assert.deepEqual(declared.allowed, ['README.md']);
});

test('door: declared non-root paths outside the namespace are allowed (cp.artifacts entries)', () => {
  const r = writeBackDoor({ branch: 'tasks/T7', paths: ['reports/T7.md'], allowRoot: ['reports/T7.md'] });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  // anything NOT declared and NOT in the namespace is refused
  const r2 = writeBackDoor({ branch: 'tasks/T7', paths: ['reports/other.md'] });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.violations, ['undeclared(reports/other.md)']);
});

test('door: path escapes and malformed pathspecs are violations', () => {
  const r = writeBackDoor({
    branch: 'tasks/T7',
    paths: ['/abs/path.txt', '../escape.txt', 'tasks/T7//double', 'tasks/T7/./dot', 'a\\b.txt', '', 42, null],
  });
  assert.equal(r.ok, false);
  const v = r.violations.join('|');
  assert.match(v, /path-escape\(\/abs\/path\.txt\)/);
  assert.match(v, /path-escape\(\.\.\/escape\.txt\)/);
  assert.match(v, /bad-path\(""\)/);
  assert.match(v, /bad-path\(42\)/);
});

test('door: SIZE CAPS — 10MB/file and 10MB/task total, boundary-exact allowed', () => {
  assert.equal(WRITE_BACK_CAP_FILE_BYTES, 10 * MB);
  assert.equal(WRITE_BACK_CAP_TASK_BYTES, 10 * MB);
  // file cap: one byte over
  const over = writeBackDoor({ branch: 'tasks/T7', paths: ['tasks/T7/big.bin'], sizes: { 'tasks/T7/big.bin': 10 * MB + 1 } });
  assert.equal(over.ok, false);
  assert.match(over.violations[0], /^size-cap-file\(tasks\/T7\/big\.bin:/);
  // file cap: exactly at the cap is allowed
  const atCap = writeBackDoor({ branch: 'tasks/T7', paths: ['tasks/T7/big.bin'], sizes: { 'tasks/T7/big.bin': 10 * MB } });
  assert.equal(atCap.ok, true, JSON.stringify(atCap.violations));
  // TOTAL cap: two 6MB files (each under the file cap, 12MB total)
  const total = writeBackDoor({
    branch: 'tasks/T7',
    paths: ['tasks/T7/a.bin', 'tasks/T7/b.bin'],
    sizes: { 'tasks/T7/a.bin': 6 * MB, 'tasks/T7/b.bin': 6 * MB },
  });
  assert.equal(total.ok, false);
  assert.match(total.violations.join('|'), /size-cap-total\(12582912\)/);
  // a missing size reads as 0 (the read-back wave measures the actual blob)
  const noSize = writeBackDoor({ branch: 'tasks/T7', paths: ['tasks/T7/x.bin'] });
  assert.equal(noSize.ok, true);
  assert.equal(noSize.totalBytes, 0);
  // a corrupt size is a violation, not a silent 0
  const badSize = writeBackDoor({ branch: 'tasks/T7', paths: ['tasks/T7/x.bin'], sizes: { 'tasks/T7/x.bin': 'huge' } });
  assert.equal(badSize.ok, false);
  assert.match(badSize.violations[0], /bad-size/);
});

test('door: the branch MUST be a `tasks/<id>` task branch — main/fsm-state/fsm-sessions refused', () => {
  for (const branch of ['main', 'fsm-state', 'fsm-sessions', 'tasks/', 'tasks/.hidden', 'tasks/T7/x', 'Tasks/T7', 42, null, '']) {
    const r = writeBackDoor({ branch, paths: [] });
    assert.equal(r.ok, false, `branch=${JSON.stringify(branch)} must fail`);
    assert.match(r.violations[0], /^bad-branch/);
  }
});

test('door: the return shape is designed for the adapter wave\'s remote read-back (allowed[], totalBytes, caps, taskId)', () => {
  // PURE validation this wave — no git calls; the shape carries everything
  // the read-back verification needs (verify each `allowed` path EXISTS on
  // `branch`'s tip with the declared size, total under caps)
  const r = writeBackDoor({ branch: 'tasks/T7', paths: ['tasks/T7/a.txt'], sizes: { 'tasks/T7/a.txt': 7 } });
  assert.deepEqual(Object.keys(r).sort(), ['allowed', 'branch', 'caps', 'ok', 'taskId', 'totalBytes', 'violations']);
});

// ---------------------------------------------------------------------------
// classifyOutcome — every normalized shape (F-M4 hardened).
// ---------------------------------------------------------------------------

test('classify: explicit five-class status passthrough (validate, keep detail)', () => {
  assert.deepEqual(classifyOutcome({ status: 'done', artifact: 'x' }), { status: 'done', artifact: 'x' });
  assert.deepEqual(classifyOutcome({ status: 'work_failed', error: 'boom' }), { status: 'work_failed', detail: 'boom' });
  assert.deepEqual(classifyOutcome({ status: 'infra_failed', error: 'lane-429' }), { status: 'infra_failed', detail: 'lane-429' });
  assert.deepEqual(classifyOutcome({ status: 'deadline' }), { status: 'deadline' });
  assert.deepEqual(classifyOutcome({ status: 'poison', detail: 'prompt-injection' }), { status: 'poison', detail: 'prompt-injection' });
  assert.deepEqual(OUTCOME_CLASSES, ['done', 'work_failed', 'infra_failed', 'deadline', 'poison']);
});

test('classify: {content:string} -> done (the artifact is the content)', () => {
  const r = classifyOutcome({ content: 'the answer is 42' });
  assert.deepEqual(r, { status: 'done', artifact: 'the answer is 42' });
  // long content is sliced (journal/outcome growth is bounded)
  assert.equal(classifyOutcome({ content: 'x'.repeat(500) }).artifact.length, 200);
});

test('classify: F-M4 reasoning-first — {content:null, reasoning:string} -> done', () => {
  const r = classifyOutcome({ content: null, reasoning: 'the model answered in the reasoning channel' });
  assert.deepEqual(r, { status: 'done', artifact: 'the model answered in the reasoning channel', detail: 'reasoning-as-answer' });
  // content WINS when both are present
  assert.equal(classifyOutcome({ content: 'c', reasoning: 'r' }).artifact, 'c');
});

test('classify: {error:{status}} — 401/402/429/5xx/transport -> infra_failed (the lane rotates)', () => {
  for (const st of [401, 402, 429, 500, 503]) {
    assert.deepEqual(classifyOutcome({ error: { status: st } }), { status: 'infra_failed', detail: `lane-${st}` });
  }
  assert.deepEqual(classifyOutcome({ error: { status: 'transport' } }), { status: 'infra_failed', detail: 'lane-transport' });
  // string statuses normalize
  assert.deepEqual(classifyOutcome({ error: { status: '429' } }), { status: 'infra_failed', detail: 'lane-429' });
  // other numeric statuses are deterministic WORK-class errors (matches the live realWork lane)
  assert.deepEqual(classifyOutcome({ error: { status: 404 } }), { status: 'work_failed', detail: 'error-404' });
  // error without a status -> work-class with sliced text
  assert.equal(classifyOutcome({ error: { message: 'bad thing' } }).status, 'work_failed');
});

test('classify: F-M4 budget-misconfigured — finish:length with NOTHING extracted -> infra_failed', () => {
  // the probe shape: content:null, reasoning:null at small max_tokens — the
  // caller asked for fewer tokens than the model needs to open its mouth
  assert.deepEqual(classifyOutcome({ content: null, reasoning: null, finish: 'length' }), { status: 'infra_failed', detail: 'budget-misconfigured' });
  assert.deepEqual(classifyOutcome({ content: '', reasoning: '', finish: 'length' }), { status: 'infra_failed', detail: 'budget-misconfigured' });
  // but content extracted WITH finish:length is done (the truncation did not eat the answer)
  assert.equal(classifyOutcome({ content: 'partial but present', finish: 'length' }).status, 'done');
});

test('classify: both-empty -> work_failed \'empty-completion\' (the lane ANSWERED; a retry is meaningful)', () => {
  assert.deepEqual(classifyOutcome({ content: '', reasoning: '' }), { status: 'work_failed', detail: 'empty-completion' });
  assert.deepEqual(classifyOutcome({ content: null, reasoning: null }), { status: 'work_failed', detail: 'empty-completion' });
  assert.deepEqual(classifyOutcome({}), { status: 'work_failed', detail: 'empty-completion' });
});

test('classify: error-as-answer — marker TEXT packaged as the success answer -> infra_failed BEFORE done', () => {
  // the E11 classes against the DEFAULT markers — all ERROR-LINE shaped
  // (s21/W4 gate): an error prefix, a bare status opener, or marker-headed
  assert.deepEqual(classifyOutcome({ content: 'Error: invalid API key provided' }), { status: 'infra_failed', detail: 'error-as-answer(invalid api key)' });
  assert.deepEqual(classifyOutcome({ content: '401 Unauthorized — check your credentials' }), { status: 'infra_failed', detail: 'error-as-answer(unauthorized)' });
  assert.deepEqual(classifyOutcome({ content: 'Insufficient credits: add more' }), { status: 'infra_failed', detail: 'error-as-answer(insufficient credits)' });
  assert.deepEqual(classifyOutcome({ content: 'RATE LIMIT exceeded, slow down' }), { status: 'infra_failed', detail: 'error-as-answer(rate limit)' });
  // the upstream passthrough shape (X21-final verbatim opener)
  assert.equal(classifyOutcome({ content: 'API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day-high-balance' }).status, 'infra_failed');
  assert.equal(classifyOutcome({ content: 'FATAL: the provider rejected the call' }, { errorMarkers: ['provider rejected'] }).status, 'infra_failed');
  assert.deepEqual(DEFAULT_ERROR_MARKERS, ['invalid api key', 'unauthorized', 'insufficient credits', 'rate limit']);
  // the E11 re-check fires EVEN when the harness already stamped status:'done'
  assert.deepEqual(classifyOutcome({ status: 'done', content: 'unauthorized' }), { status: 'infra_failed', detail: 'error-as-answer(unauthorized)' });
  // normal content stays done
  assert.equal(classifyOutcome({ content: 'all good, no markers here' }).status, 'done');
});

test('classify: E11 NEGATIVE pins (s21/W4, a2 T10) — a good done answer DISCUSSING a marker stays done', () => {
  // the pre-W4 false-positive class verbatim: ANY non-empty content
  // CONTAINING a marker substring convicted — a legitimately DONE turn whose
  // result mentioned 'rate limit'/'unauthorized'/'insufficient credits'
  // (this repo's own task mix: runbooks for the 429 lane, quota docs) flipped
  // to infra → net-zero ×3 → infra-exhausted QUARANTINE of good, landed work.
  // The W4 gate requires an error-line context; mid-prose mentions are DONE.
  const prose = [
    'Done: documented the 429 retry ladder — when a rate limit hits the shared lane the pool rotates keys, and the backoff cadence is now in the runbook.',
    'The 401 unauthorized errors were traced to the revoked secondary key; after the secret swap all 12 calls succeeded and the summary table landed in the report.',
    'Fixed the quota docs: the insufficient credits section now covers the paid-lane failover (turn completed, artifact staged).',
  ];
  for (const content of prose) {
    assert.equal(classifyOutcome({ content }).status, 'done', `prose mentioning a marker stays done: ${content.slice(0, 48)}…`);
  }
  // ... and even when the harness already stamped status:'done' (the step-1
  // re-check is gated the same way — runTurn calls ctx-less, defaults on)
  assert.equal(classifyOutcome({ status: 'done', content: prose[0] }).status, 'done');
  assert.equal(classifyOutcome({ status: 'done', content: prose[1] }).status, 'done');
});

test('classify: ctx.errorMarkers — custom markers replace the defaults; [] disables the check', () => {
  const custom = classifyOutcome({ content: 'FATAL: widgets exhausted' }, { errorMarkers: ['widgets exhausted'] });
  assert.deepEqual(custom, { status: 'infra_failed', detail: 'error-as-answer(widgets exhausted)' });
  // with the custom set active, the DEFAULT markers no longer fire
  assert.equal(classifyOutcome({ content: 'unauthorized' }, { errorMarkers: ['widgets exhausted'] }).status, 'done');
  // an explicit [] is the caller\'s deliberate disable
  assert.equal(classifyOutcome({ content: 'unauthorized' }, { errorMarkers: [] }).status, 'done');
  // RegExp markers work; /g regexes stay PURE across calls (no lastIndex drift)
  const re = /quota\s+exceeded/g;
  const a = classifyOutcome({ content: 'quota exceeded for today' }, { errorMarkers: [re] });
  const b = classifyOutcome({ content: 'quota exceeded for today' }, { errorMarkers: [re] });
  assert.deepEqual(a, b);
  assert.equal(a.status, 'infra_failed');
  assert.match(a.detail, /error-as-answer\(\/quota\\s\+exceeded\/\)/);
});

test('classify: the legacy worker vocabulary and anomaly shapes', () => {
  // legacy 'failed' (mock/real lanes today) -> work_failed (the F-B1 alias)
  assert.deepEqual(classifyOutcome({ status: 'failed', error: 'flaky-fail-1' }), { status: 'work_failed', detail: 'flaky-fail-1' });
  // a status OUTSIDE the contract is an anomaly: poison (loud + terminal
  // beats silent remapping)
  const unk = classifyOutcome({ status: 'catastrophic' });
  assert.deepEqual(unk, { status: 'poison', detail: 'unknown-status(catastrophic)' });
  // degenerate payloads -> the conservative WORK class (a systematically-null
  // harness must not net-zero-retry-loop forever)
  for (const raw of [null, 'text', 42, [], true]) {
    assert.deepEqual(classifyOutcome(raw), { status: 'work_failed', detail: 'empty-completion' });
  }
  // non-string content/reasoning is a CONTRACT violation -> poison
  assert.deepEqual(classifyOutcome({ content: 42 }), { status: 'poison', detail: 'bad-content-shape(number)' });
  assert.deepEqual(classifyOutcome({ reasoning: {} }), { status: 'poison', detail: 'bad-reasoning-shape(object)' });
});

// ---------------------------------------------------------------------------
// mintEventId / MINT_TABLE — the ONE id-mint source (F-B3 + F-M9).
// ---------------------------------------------------------------------------

test('mint: the table shapes — TICK / REPORT / CONTROL / TASK_CREATED', () => {
  assert.equal(mintEventId('TICK', { reason: 'chain', clockMs: 12345 }), 'tick-chain-12345');
  // REPORT is attempt-scoped (F-E)
  assert.equal(mintEventId('REPORT', { runId: 111, attempt: 1 }), 'rep-111-a1');
  assert.equal(mintEventId('REPORT', { runId: 111, attempt: 2 }), 'rep-111-a2');
  assert.notEqual(mintEventId('REPORT', { runId: 111, attempt: 1 }), mintEventId('REPORT', { runId: 111, attempt: 2 }),
    'GITHUB_RUN_ID is stable across re-runs — only the attempt scopes the id');
  // tolerant local-lane defaults
  assert.equal(mintEventId('REPORT', {}), 'rep-local-a1');
  // CONTROL: the 'direct' repository_dispatch lane default + nodeId override
  assert.equal(mintEventId('CONTROL', { command: 'pause', clockMs: 999 }), 'ctl-direct-pause-999');
  assert.equal(mintEventId('CONTROL', { command: 'pause', clockMs: 999, nodeId: 'ops' }), 'ctl-ops-pause-999');
  // TASK_CREATED (the W-C intake door's shape — no live site yet)
  assert.equal(mintEventId('TASK_CREATED', { issue: 57, bodySha8: 'ab12cd34' }), 'task-57-ab12cd34');
});

test('mint: WAKE never journaled — minting an id for it is a contract violation (throws)', () => {
  assert.throws(() => mintEventId('WAKE', {}), /WAKE is never journaled/);
  assert.throws(() => mintEventId('MILESTONE', {}), /unknown journal kind/);
  assert.throws(() => mintEventId(null, {}), /unknown journal kind/);
  // the seed must be an object
  assert.throws(() => mintEventId('TICK', null), /seed must be an object/);
  assert.throws(() => mintEventId('TICK', []), /seed must be an object/);
});

test('mint: per-kind seed guards fail closed on missing discriminators (the probe6 class, minting side)', () => {
  assert.throws(() => mintEventId('TICK', { reason: 'x' }), /clockMs/);          // undefined -> `tick-x-undefined` + collisions
  assert.throws(() => mintEventId('TICK', { clockMs: 1 }), /reason/);
  assert.throws(() => mintEventId('TICK', { reason: 'x', clockMs: NaN }), /clockMs/);
  assert.throws(() => mintEventId('CONTROL', { command: 'pause' }), /clockMs/);
  assert.throws(() => mintEventId('CONTROL', { clockMs: 1 }), /command/);
  assert.throws(() => mintEventId('TASK_CREATED', { issue: 1 }), /bodySha8/);
  assert.throws(() => mintEventId('TASK_CREATED', { bodySha8: 'x' }), /issue/);
  // REPORT stays guard-free (the tolerant defaults ARE its rule)
  assert.doesNotThrow(() => mintEventId('REPORT', {}));
});

test('mint: the live sites route through the table — byte-identical ids (F-M9)', () => {
  const nowIso = iso(NOW);
  // buildEvent's TICK id === the table's mint for the same injected clock
  const e = buildEvent({ action: 'fsm-tick', client_payload: { reason: 'watchdog-reprime' } }, { now: () => nowIso });
  assert.equal(e.event_id, mintEventId('TICK', { reason: 'watchdog-reprime', clockMs: NOW }));
  assert.match(e.event_id, /^tick-watchdog-reprime-\d+$/);
  // buildEvent's CONTROL id (the direct lane)
  const c = buildEvent({ action: 'fsm-control', client_payload: { command: 'pause' } }, { now: () => nowIso });
  assert.equal(c.event_id, mintEventId('CONTROL', { command: 'pause', clockMs: NOW }));
  // worker/turn.mjs's report id (reportEventId is a table alias)
  assert.equal(reportEventId({ runId: 42, attempt: 3 }), mintEventId('REPORT', { runId: 42, attempt: 3 }));
  // the re-export IS the same table (one source, one import site)
  assert.equal(MINT_TABLE.REPORT({ runId: 42, attempt: 3 }), 'rep-42-a3');
});

test('mint: two same-real-ms wakes mint DISTINCT ids from the injected clock (the probe6 rule, table-side)', () => {
  let vt = NOW;
  const vnow = () => iso(vt);
  const e1 = buildEvent({ action: 'fsm-tick', client_payload: { reason: 'r' } }, { now: vnow });
  vt += 1000;
  const e2 = buildEvent({ action: 'fsm-tick', client_payload: { reason: 'r' } }, { now: vnow });
  assert.notEqual(e1.event_id, e2.event_id, 'same real-ms wakes must not collide');
  assert.equal(e2.event_id, `tick-r-${NOW + 1000}`);
});

test('X21 live finding: the ox unwrap — a valid ox rides the envelope; corrupt shapes fail closed; absent ox falls through', () => {
  // valid: the ox envelope wins over top-level derivations
  const cp = { task: 'T-9', attempt: 1, lease: 'l', behavior: 'succeed', work_ms: 1, expires: new Date(Date.now() + 600_000).toISOString(), chain: 'c',
    ox: JSON.stringify({ task_ref: { kind: 'state-task', id: 'T-9' }, prompt: 'the real prompt', deadline_ms: Date.now() + 300_000, session: 'c/T-9/r-a1', budget: { max_turns: 5, wall_ms: 240_000, lane_attempts: 2 }, mode: 'cc', attempt: 1 }) };
  const r = envelopeFromDispatch(cp, Date.now());
  assert.ok(r.ok, `valid ox unwraps (got ${JSON.stringify(r).slice(0, 120)})`);
  assert.equal(r.envelope.prompt, 'the real prompt');
  assert.equal(r.envelope.mode, 'cc');
  assert.equal(r.envelope.budget.lane_attempts, 2);
  // corrupt: not JSON
  const bad1 = envelopeFromDispatch({ ...cp, ox: '{nope' }, Date.now());
  assert.ok(!bad1.ok && bad1.reason === 'bad-envelope');
  // corrupt: decodes to a non-object
  const bad2 = envelopeFromDispatch({ ...cp, ox: '"just a string"' }, Date.now());
  assert.ok(!bad2.ok && bad2.reason === 'bad-envelope');
  // corrupt: non-string ox
  const bad3 = envelopeFromDispatch({ ...cp, ox: { nested: true } }, Date.now());
  assert.ok(!bad3.ok && bad3.reason === 'bad-envelope');
  // absent: the legacy path still works
  const legacy = envelopeFromDispatch({ task: 'T-9', attempt: 1, lease: 'l', behavior: 'succeed', work_ms: 1, expires: new Date(Date.now() + 600_000).toISOString(), chain: 'c' }, Date.now());
  assert.ok(legacy.ok);
  assert.equal(legacy.envelope.mode, 'mock');
});
