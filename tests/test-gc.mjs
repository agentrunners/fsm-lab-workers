// test-gc.mjs — T46/W-C2 (§5a, F-15): the transcript-GC suite.
//
// Three layers, NO live API calls:
//   1. PURE — lib/watchdog-core.mjs gcDaysFromEnv / gcParseTouchLog / gcPlan /
//      gcCommitMessage: fixtures + a fixed clock (the watchdog-core style).
//   2. GIT LANE — watchdog/scan.mjs runTranscriptGc against REAL local bare
//      repos (the test-store discipline: no mocks on the transport path; the
//      vacuous-fixture hazard is exactly what the W-C1 review taught). The
//      remote is injected via FSM_SESSIONS_ORIGIN (file:// — shallow-since is
//      ignored on plain paths); commit dates are minted via
//      GIT_AUTHOR_DATE/GIT_COMMITTER_DATE so ages are deterministic; the
//      clock is injected via now().
//   3. ADAPTER E2E — `node watchdog/scan.mjs` in a local clone whose origin
//      is a bare repo carrying fsm-state + fsm-sessions: pins the F-15a
//      placement (a HALTED chain still runs the GC) and the charter at
//      runtime (fsm-state tip unchanged) + a source-shape pin (no write path
//      to fsm-state is even constructed).
//
// Clock discipline: NOW is fixed at 2026-09-13T12:00:00Z; transcript commit
// dates are minted relative to it. gcDays=7 → the shallow window reaches
// 2026-09-04 (the +2d slack); the boundary commit at 2026-09-05 is inside it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gcDaysFromEnv, gcParseTouchLog, gcPlan, gcCommitMessage,
  GC_DAYS_CAP, GC_DAYS_DEFAULT, GC_TREE_LIMIT, GC_DAY_MS,
} from '../lib/watchdog-core.mjs';
import { runTranscriptGc } from '../watchdog/scan.mjs';
import { Store } from '../lib/store.mjs';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = GC_DAY_MS;
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// ---------------------------------------------------------------------------
// local-bare fixtures (real git, hermetic)
// ---------------------------------------------------------------------------

const g = (args, cwd, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

// seedSessions(originDir, commits) — builds the fsm-sessions branch on a bare
// origin with DATED commits (the worker's one-commit-per-turn push shape).
// commits: [{ files: {path: content}, date: 'ISO' }]
function seedSessions(origin, commits) {
  const work = mkdtempSync(join(tmpdir(), 'gc-seed-'));
  try {
    g(['init', '-q', '-b', 'fsm-sessions', '.'], work);
    g(['config', 'user.name', 'fsm-worker'], work);
    g(['config', 'user.email', 'fsm-worker@users.noreply.github.com'], work);
    for (const c of commits) {
      for (const [p, content] of Object.entries(c.files)) {
        const abs = join(work, p);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, content);
      }
      g(['add', '-A'], work);
      const r = g(['commit', '-qm', 'transcript: sessions update'], work, {
        GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date,
      });
      if (r.status !== 0) throw new Error(`seed commit failed: ${r.stderr}`);
    }
    g(['init', '-q', '--bare', origin], join(work, '..'));
    const p = g(['push', '-q', origin, 'fsm-sessions'], work);
    if (p.status !== 0) throw new Error(`seed push failed: ${p.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// the standard transcript fixture (relative to NOW):
//   now-43d : T1 old (task done)     → VICTIM (terminal + old)
//             T2 old (in_progress)   → retained (non-terminal)
//             T3 old (ABSENT task)   → VICTIM (prior-epoch residue)
//             T4 old (failed)        → retained ('failed' is retryable — excluded)
//             sessions/notes.md      → stray: never deleted, not counted
//   now-8d  : T5 transcript (in_progress) — the in-window boundary commit
//   now-1h  : T1 fresh (task done)   → retained (terminal + FRESH)
const STD_STATE = {
  version: 1,
  chain: { seq: 9, last_tick: iso(NOW - 3600_000), halted: true, paused: false },
  tasks: {
    T1: { id: 'T1', status: 'done' },
    T2: { id: 'T2', status: 'in_progress' },
    T4: { id: 'T4', status: 'failed' },
    T5: { id: 'T5', status: 'in_progress' },
  },
  stats: { done: 1 },
  config: {},
};
const pair = (t, run) => ({ [`sessions/${t}/${run}-a1.txt`]: `old ${t}`, [`sessions/${t}/${run}-a1.meta.json`]: `meta ${t}` });
const STD_COMMITS = [
  {
    date: iso(NOW - 43 * DAY),
    files: {
      ...pair('T1', 'oldrun'), ...pair('T2', 'oldrun'), ...pair('T3', 'oldrun'), ...pair('T4', 'oldrun'),
      'sessions/notes.md': 'stray — not a transcript',
    },
  },
  { date: iso(NOW - 8 * DAY), files: pair('T5', 'run5') },
  { date: iso(NOW - 3600_000), files: { 'sessions/T1/freshrun-a2.txt': 'fresh', 'sessions/T1/freshrun-a2.meta.json': 'fm' } },
];
const STD_VICTIMS = [
  'sessions/T1/oldrun-a1.meta.json', 'sessions/T1/oldrun-a1.txt',
  'sessions/T3/oldrun-a1.meta.json', 'sessions/T3/oldrun-a1.txt',
];

function mkStdLab() {
  const dir = mkdtempSync(join(tmpdir(), 'gc-lab-'));
  const origin = join(dir, 'origin.git');
  seedSessions(origin, STD_COMMITS);
  return { dir, origin, url: `file://${origin}`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tipOf = (origin, branch = 'fsm-sessions') =>
  String(g(['--git-dir', origin, 'rev-parse', branch], dirOf(origin)).stdout || '').trim();
function dirOf(origin) { return join(origin, '..'); }
const lsTree = (origin, branch = 'fsm-sessions') =>
  String(g(['--git-dir', origin, 'ls-tree', '-r', '--name-only', branch], dirOf(origin)).stdout || '')
    .split('\n').map(x => x.trim()).filter(Boolean);
const gcCount = (origin) =>
  lsTree(origin).length && String(g(['--git-dir', origin, 'log', '--format=%s', 'fsm-sessions'], dirOf(origin)).stdout || '')
    .split('\n').filter(s => s.startsWith('gc-transcripts:')).length;

async function runGc({ origin, state = STD_STATE, env = {}, now = () => NOW, hooks }) {
  const logs = [];
  const r = await runTranscriptGc({
    state,
    env: { FSM_SESSIONS_ORIGIN: `file://${origin}`, ...env },
    log: (m) => logs.push(m),
    now,
    hooks,
  });
  return { r, logs };
}

// ---------------------------------------------------------------------------
// 1. PURE — the knob (F-15: default 7, hard cap 90)
// ---------------------------------------------------------------------------

test('F-15 knob: gcDaysFromEnv — default 7 when unset/invalid/<1, hard cap 90', () => {
  assert.deepEqual(gcDaysFromEnv(undefined), { days: 7, adjusted: 'defaulted', raw: null });
  assert.deepEqual(gcDaysFromEnv(''), { days: 7, adjusted: 'defaulted', raw: '' });
  assert.deepEqual(gcDaysFromEnv('0'), { days: 7, adjusted: 'defaulted', raw: '0' });
  assert.deepEqual(gcDaysFromEnv('-5'), { days: 7, adjusted: 'defaulted', raw: '-5' });
  assert.deepEqual(gcDaysFromEnv('abc'), { days: 7, adjusted: 'defaulted', raw: 'abc' });
  assert.deepEqual(gcDaysFromEnv('365'), { days: 90, adjusted: 'clamped', raw: '365' });
  assert.deepEqual(gcDaysFromEnv('91'), { days: 90, adjusted: 'clamped', raw: '91' });
  assert.deepEqual(gcDaysFromEnv('90'), { days: 90, adjusted: null, raw: '90' });
  assert.deepEqual(gcDaysFromEnv('1'), { days: 1, adjusted: null, raw: '1' });
  assert.deepEqual(gcDaysFromEnv('30'), { days: 30, adjusted: null, raw: '30' });
  assert.equal(GC_DAYS_DEFAULT, 7);
  assert.equal(GC_DAYS_CAP, 90);
});

// ---------------------------------------------------------------------------
// 2. PURE — the terminal-age rule (gcPlan)
// ---------------------------------------------------------------------------

test('F-15 rule: terminal+old -> deleted; terminal+fresh -> retained; non-terminal+old -> retained', () => {
  const old = NOW - 20 * DAY, fresh = NOW - 1 * DAY;
  const files = [
    'sessions/TDONE/old-a1.txt', 'sessions/TDONE/fresh-a1.txt',
    'sessions/TREADY/old-a1.txt', 'sessions/TASSIGNED/old-a1.txt', 'sessions/TIP/old-a1.txt',
  ];
  const touches = new Map([
    ['sessions/TDONE/old-a1.txt', old], ['sessions/TDONE/fresh-a1.txt', fresh],
    ['sessions/TREADY/old-a1.txt', old], ['sessions/TASSIGNED/old-a1.txt', old], ['sessions/TIP/old-a1.txt', old],
  ]);
  const state = { tasks: {
    TDONE: { status: 'done' }, TREADY: { status: 'ready' },
    TASSIGNED: { status: 'assigned' }, TIP: { status: 'in_progress' },
  } };
  const p = gcPlan({ files, touches, state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p.victims, ['sessions/TDONE/old-a1.txt']);
  assert.equal(p.retained, 4);
  assert.equal(p.deferred, false);
});

test('F-15 rule: quarantined/cancelled are terminal; "failed" is NOT (retryable — the deliberate exclusion)', () => {
  const old = NOW - 20 * DAY;
  const files = ['sessions/TQ/q-a1.txt', 'sessions/TC/c-a1.txt', 'sessions/TF/f-a1.txt'];
  const touches = new Map(files.map(f => [f, old]));
  const state = { tasks: { TQ: { status: 'quarantined' }, TC: { status: 'cancelled' }, TF: { status: 'failed' } } };
  const p = gcPlan({ files, touches, state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p.victims, ['sessions/TC/c-a1.txt', 'sessions/TQ/q-a1.txt']);
  assert.equal(p.retained, 1);
});

test('F-15 rule: task ABSENT from state.tasks counts as terminal (prior-epoch residue — the bulk value)', () => {
  const old = NOW - 20 * DAY;
  const p = gcPlan({
    files: ['sessions/GHOST-7/run-a1.txt'],
    touches: new Map([['sessions/GHOST-7/run-a1.txt', old]]),
    state: { tasks: { OTHER: { status: 'in_progress' } } },
    nowMs: NOW, gcDays: 7,
  });
  assert.deepEqual(p.victims, ['sessions/GHOST-7/run-a1.txt']);
});

test('F-15 rule: age is STRICTLY greater than gc_days (exactly-at-threshold is retained)', () => {
  const f = 'sessions/T/t-a1.txt';
  const state = { tasks: { T: { status: 'done' } } };
  const p = gcPlan({ files: [f], touches: new Map([[f, NOW - 7 * DAY]]), state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p.victims, []);
  const p2 = gcPlan({ files: [f], touches: new Map([[f, NOW - 7 * DAY - 1]]), state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p2.victims, [f]);
});

test('F-15 rule: the horizon — unmapped paths use the oldest fetched commit (fail-retention)', () => {
  const f = 'sessions/T/t-a1.txt';
  const state = { tasks: { T: { status: 'done' } } };
  // unmapped + horizon older than the threshold -> eligible (residue collection)
  const p = gcPlan({ files: [f], touches: new Map(), horizonMs: NOW - 12 * DAY, state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p.victims, [f], 'horizon past the threshold -> the unmapped path is definitionally older');
  assert.equal(p.ambiguous, 1, 'the verdict rests on the horizon — the deepen trigger');
  // unmapped + horizon FRESHER than the threshold -> retained (understates age -> safe)
  const p2 = gcPlan({ files: [f], touches: new Map(), horizonMs: NOW - 3 * DAY, state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p2.victims, []);
  assert.equal(p2.ambiguous, 1);
  // no horizon at all (no history visible) -> unknown age -> retained
  const p3 = gcPlan({ files: [f], touches: new Map(), horizonMs: null, state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p3.victims, []);
  // a MAPPED touch always beats the horizon (fresh touch on an old window)
  const p4 = gcPlan({ files: [f], touches: new Map([[f, NOW - 1 * DAY]]), horizonMs: NOW - 12 * DAY, state, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p4.victims, []);
  assert.equal(p4.ambiguous, 0, 'a real touch resolves the age — no deepen needed');
});

test('F-15 rule: strays are never deleted and never counted; transcripts count via the path shape', () => {
  const old = NOW - 20 * DAY;
  const files = [
    'README.md', 'sessions/notes.md', 'sessions/T/README', 'sessions/T/notatranscript.txt',
    'sessions/T/deep/nested-a1.txt', // third path segment — not the transcript shape
    'sessions/T/run-a1.txt', 'sessions/T/run-a1.meta.json',
  ];
  const touches = new Map(files.map(f => [f, old]));
  const p = gcPlan({ files, touches, state: { tasks: { T: { status: 'done' } } }, nowMs: NOW, gcDays: 7 });
  assert.deepEqual(p.victims, ['sessions/T/run-a1.meta.json', 'sessions/T/run-a1.txt']);
  assert.equal(p.transcriptCount, 2);
  assert.equal(p.retained, 0);
  assert.equal(p.treeCount, 6, 'sessions/ blobs count for the bail-out (strays included); repo-root files do not');
});

// ---------------------------------------------------------------------------
// 3. PURE — the bail-out (F-15c: >5000 files)
// ---------------------------------------------------------------------------

test('F-15c bail-out: tree >5000 sessions/ files -> deferred (5000 passes, 5001 defers)', () => {
  const files = [];
  for (let i = 0; i < GC_TREE_LIMIT + 1; i++) files.push(`sessions/T${Math.floor(i / 2)}/r${i}-a1.txt`);
  const touches = new Map(files.map(f => [f, NOW - 99 * DAY]));
  const state = { tasks: {} }; // everything absent -> all terminal (worst case)
  const over = gcPlan({ files, touches, state, nowMs: NOW, gcDays: 7 });
  assert.equal(over.deferred, true);
  assert.equal(over.treeCount, 5001);
  const at = gcPlan({ files: files.slice(0, GC_TREE_LIMIT), touches, state, nowMs: NOW, gcDays: 7 });
  assert.equal(at.deferred, false);
});

// ---------------------------------------------------------------------------
// 4. PURE — the touch-log parser + the commit message
// ---------------------------------------------------------------------------

test('gcParseTouchLog: markers/blank lines parse; newest-first first-sight wins; horizon = oldest commit', () => {
  const text = [
    '@@@aaa111 2026-09-13T10:00:00Z', '', 'sessions/A/a-a1.txt',
    '@@@bbb222 2026-09-05T00:00:00Z', '', 'sessions/A/a-a1.txt', 'sessions/B/b-a1.txt',
    '@@@ccc333 2026-08-01T00:00:00Z', '', 'sessions/C/c-a1.txt',
  ].join('\n');
  const { touches, horizonMs } = gcParseTouchLog(text);
  assert.equal(touches.get('sessions/A/a-a1.txt'), Date.parse('2026-09-13T10:00:00Z'), 'newest touch wins');
  assert.equal(touches.get('sessions/B/b-a1.txt'), Date.parse('2026-09-05T00:00:00Z'));
  assert.equal(touches.get('sessions/C/c-a1.txt'), Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(horizonMs, Date.parse('2026-08-01T00:00:00Z'));
  // degenerate shapes: empty, no markers, unparseable dates
  assert.deepEqual(gcParseTouchLog(''), { touches: new Map(), horizonMs: null });
  assert.deepEqual(gcParseTouchLog('random\nlines'), { touches: new Map(), horizonMs: null });
  const bad = gcParseTouchLog('@@@xyz notadate\n\nsessions/X/x-a1.txt');
  assert.equal(bad.horizonMs, null);
  assert.equal(bad.touches.size, 0, 'files under an unparseable commit line are not mapped (retained)');
});

test('F-15b message: subject shape + body bounded to the first 50 paths with the more-marker', () => {
  const few = gcCommitMessage({ victims: ['sessions/T/a-a1.txt', 'sessions/T/b-a1.txt'], retained: 3, ageDays: 7 });
  assert.equal(few.subject, 'gc-transcripts: deleted=2 retained=3 age_days=7');
  assert.equal(few.body, 'sessions/T/a-a1.txt\nsessions/T/b-a1.txt\n');
  const many = Array.from({ length: 53 }, (_, i) => `sessions/T/f${i}-a1.txt`);
  const m = gcCommitMessage({ victims: many, retained: 0, ageDays: 90 });
  assert.equal(m.subject, 'gc-transcripts: deleted=53 retained=0 age_days=90');
  const lines = m.body.split('\n').filter(Boolean);
  assert.equal(lines.length, 51, '50 paths + the more-marker');
  assert.equal(lines[50], '… +3 more');
  assert.ok(lines.slice(0, 50).every((l, i) => l === many[i]));
});

// ---------------------------------------------------------------------------
// 5. GIT LANE — runTranscriptGc against real local bare repos
// ---------------------------------------------------------------------------

test('F-15 git lane: the standard fixture — 4 victims deleted in ONE commit, audit shape exact', async () => {
  const lab = mkStdLab(); try {
    const before = tipOf(lab.origin);
    const { r, logs } = await runGc({ origin: lab.origin });
    assert.equal(r.outcome, 'pushed');
    assert.equal(r.deleted, 4);
    assert.equal(r.retained, 8);
    assert.ok(logs.some(l => l === 'GC-TRANSCRIPTS deleted=4 retained=8'), `log lines: ${logs.join(' | ')}`);
    assert.ok(logs.some(l => l.startsWith('GC-COMMIT sha=')));
    // exactly ONE new commit on fsm-sessions (one-commit-per-scan, F-15b)
    assert.equal(gcCount(lab.origin), 1);
    const after = tipOf(lab.origin);
    assert.notEqual(after, before);
    // the audit shape: subject + author + body
    const subj = String(g(['--git-dir', lab.origin, 'log', '-1', '--format=%s', 'fsm-sessions'], lab.dir).stdout).trim();
    assert.equal(subj, 'gc-transcripts: deleted=4 retained=8 age_days=7');
    const auth = String(g(['--git-dir', lab.origin, 'log', '-1', '--format=%an <%ae>', 'fsm-sessions'], lab.dir).stdout).trim();
    assert.equal(auth, 'fsm-watchdog <fsm-watchdog@users.noreply.github.com>');
    const body = String(g(['--git-dir', lab.origin, 'log', '-1', '--format=%b', 'fsm-sessions'], lab.dir).stdout);
    for (const v of STD_VICTIMS) assert.ok(body.includes(v), `body lists ${v}`);
    // victims gone; everything the rule protects is intact
    const tree = new Set(lsTree(lab.origin));
    for (const v of STD_VICTIMS) assert.ok(!tree.has(v), `${v} deleted`);
    for (const keep of [
      'sessions/T1/freshrun-a2.txt', 'sessions/T1/freshrun-a2.meta.json', // done + FRESH
      'sessions/T2/oldrun-a1.txt', 'sessions/T2/oldrun-a1.meta.json',     // in_progress + old
      'sessions/T4/oldrun-a1.txt', 'sessions/T4/oldrun-a1.meta.json',     // failed (retryable) + old
      'sessions/T5/run5-a1.txt', 'sessions/T5/run5-a1.meta.json',         // live task
      'sessions/notes.md',                                                 // stray — never touched
    ]) assert.ok(tree.has(keep), `${keep} retained`);
  } finally { lab.cleanup(); }
});

test('F-15 git lane: nothing to delete -> deleted=0 logged, NO commit (tip unchanged)', async () => {
  const lab = mkStdLab(); try {
    const before = tipOf(lab.origin);
    const { r, logs } = await runGc({ origin: lab.origin, env: { TRANSCRIPT_GC_DAYS: '90' } });
    // with a 90d window: the boundary is now-92d; the 43d-old fixture files
    // are all touched INSIDE the window -> mapped fresh -> retained
    assert.equal(r.outcome, 'clean');
    assert.equal(r.retained, 12);
    assert.ok(logs.some(l => l === 'GC-TRANSCRIPTS deleted=0 retained=12'), `log lines: ${logs.join(' | ')}`);
    assert.equal(tipOf(lab.origin), before, 'no commit when deleted=0');
    assert.equal(gcCount(lab.origin), 0);
    assert.ok(logs.some(l => l === 'GC-DAYS-CLAMP raw=90 -> 90 (hard cap 90)' && false) === false); // 90 is valid, no clamp line
    assert.ok(!logs.some(l => l.startsWith('GC-DAYS-')), '90 needs no adjustment line');
  } finally { lab.cleanup(); }
});

test('F-15d CAS: a mid-flight tip move (live transcript push races) -> retry succeeds, ONE commit, racer survives', async () => {
  const lab = mkStdLab(); try {
    const before = tipOf(lab.origin);
    let raced = 0;
    const { r, logs } = await runGc({
      origin: lab.origin,
      hooks: {
        afterClone: ({ attempt }) => {
          if (attempt !== 1) return; // race exactly once, mid-flight
          raced++;
          const d = mkdtempSync(join(tmpdir(), 'gc-racer-'));
          try {
            const wc = join(d, 'wc'); mkdirSync(wc, { recursive: true });
            const gg = (a, env = {}) => spawnSync('git', a, { cwd: wc, encoding: 'utf8', env: { ...process.env, ...env } });
            assert.equal(gg(['clone', '-q', '--depth', '1', '--branch', 'fsm-sessions', '--single-branch', lab.url, '.']).status, 0);
            mkdirSync(join(wc, 'sessions/T6'), { recursive: true });
            writeFileSync(join(wc, 'sessions/T6/racerun-a1.txt'), 'racing live transcript');
            writeFileSync(join(wc, 'sessions/T6/racerun-a1.meta.json'), '{}');
            gg(['add', '-A']);
            gg(['-c', 'user.name=fsm-worker', '-c', 'user.email=fsm-worker@users.noreply.github.com', 'commit', '-qm', 'transcript: sessions update'], {
              GIT_AUTHOR_DATE: iso(NOW + 300_000), GIT_COMMITTER_DATE: iso(NOW + 300_000),
            });
            const p = gg(['push', '-q', 'origin', 'fsm-sessions']);
            assert.equal(p.status, 0, `racer push: ${p.stderr}`);
          } finally { rmSync(d, { recursive: true, force: true }); }
        },
      },
    });
    assert.equal(raced, 1, 'the race fired once');
    assert.equal(r.outcome, 'pushed');
    assert.equal(r.deleted, 4);
    assert.equal(r.retained, 10, 'the racing transcript is retained');
    assert.ok(logs.some(l => l.startsWith('GC-CAS-RETRY attempt=1/3 reason=non-fast-forward')), `log lines: ${logs.join(' | ')}`);
    // ONE gc commit landed — the rejected attempt's commit never did (no duplicate deletion)
    assert.equal(gcCount(lab.origin), 1);
    const tree = new Set(lsTree(lab.origin));
    assert.ok(tree.has('sessions/T6/racerun-a1.txt'), 'the racing LIVE transcript survives the retry');
    for (const v of STD_VICTIMS) assert.ok(!tree.has(v), `${v} deleted exactly once`);
    // and the retry's commit sits on top of the racer's commit (fresh-read re-decision)
    const subj = String(g(['--git-dir', lab.origin, 'log', '-1', '--format=%s', 'fsm-sessions'], lab.dir).stdout).trim();
    assert.equal(subj, 'gc-transcripts: deleted=4 retained=10 age_days=7');
  } finally { lab.cleanup(); }
});

test('F-15d CAS: a RE-PUSHED old victim path (worker transcript retry) drops out of the victim set on retry', async () => {
  const lab = mkStdLab(); try {
    let raced = 0;
    const { r } = await runGc({
      origin: lab.origin,
      hooks: {
        afterClone: ({ attempt }) => {
          if (attempt !== 1) return;
          raced++;
          // a worker re-pushes the SAME old victim path (its transcript-push
          // retry) — the fresh touch resets the file's age
          const d = mkdtempSync(join(tmpdir(), 'gc-repush-'));
          try {
            const wc = join(d, 'wc'); mkdirSync(wc, { recursive: true });
            const gg = (a, env = {}) => spawnSync('git', a, { cwd: wc, encoding: 'utf8', env: { ...process.env, ...env } });
            gg(['clone', '-q', '--depth', '1', '--branch', 'fsm-sessions', '--single-branch', lab.url, '.']);
            writeFileSync(join(wc, 'sessions/T3/oldrun-a1.txt'), 're-pushed content');
            gg(['add', '-A']);
            gg(['-c', 'user.name=fsm-worker', '-c', 'user.email=fsm-worker@users.noreply.github.com', 'commit', '-qm', 'transcript: sessions update'], {
              GIT_AUTHOR_DATE: iso(NOW + 300_000), GIT_COMMITTER_DATE: iso(NOW + 300_000),
            });
            gg(['push', '-q', 'origin', 'fsm-sessions']);
          } finally { rmSync(d, { recursive: true, force: true }); }
        },
      },
    });
    assert.equal(raced, 1);
    assert.equal(r.outcome, 'pushed');
    // T3's re-pushed txt is FRESH now -> retained; its stale .meta.json pair + T1's old pair deleted
    assert.equal(r.deleted, 3);
    const tree = new Set(lsTree(lab.origin));
    assert.ok(tree.has('sessions/T3/oldrun-a1.txt'), 'the re-pushed transcript survives (fresh touch wins)');
    assert.ok(!tree.has('sessions/T3/oldrun-a1.meta.json'));
  } finally { lab.cleanup(); }
});

test('F-15d CAS: exhaustion — a racer on EVERY attempt -> 3 attempts, no commit, GC-ERROR', async () => {
  const lab = mkStdLab(); try {
    const before = tipOf(lab.origin);
    let races = 0;
    const { r, logs } = await runGc({
      origin: lab.origin,
      hooks: {
        afterClone: () => {
          races++;
          const d = mkdtempSync(join(tmpdir(), 'gc-racer-'));
          try {
            const wc = join(d, 'wc'); mkdirSync(wc, { recursive: true });
            const gg = (a, env = {}) => spawnSync('git', a, { cwd: wc, encoding: 'utf8', env: { ...process.env, ...env } });
            gg(['clone', '-q', '--depth', '1', '--branch', 'fsm-sessions', '--single-branch', lab.url, '.']);
            mkdirSync(join(wc, `sessions/RR${races}`), { recursive: true });
            writeFileSync(join(wc, `sessions/RR${races}/r-a1.txt`), 'race');
            gg(['add', '-A']);
            gg(['-c', 'user.name=w', '-c', 'user.email=w@t.invalid', 'commit', '-qm', 'transcript: sessions update'], {
              GIT_AUTHOR_DATE: iso(NOW + 300_000), GIT_COMMITTER_DATE: iso(NOW + 300_000),
            });
            gg(['push', '-q', 'origin', 'fsm-sessions']);
          } finally { rmSync(d, { recursive: true, force: true }); }
        },
      },
    });
    assert.equal(races, 3, 'the loop is bounded at 3 attempts');
    assert.equal(r.outcome, 'exhausted');
    assert.ok(logs.some(l => l.startsWith('GC-ERROR cas-exhausted attempts=3')), `log lines: ${logs.join(' | ')}`);
    assert.equal(gcCount(lab.origin), 0);
    // the racers' OWN commits move the tip (they survive — the CAS never
    // overwrites a rival); "no GC commit landed" is the gcCount pin above
    assert.notEqual(tipOf(lab.origin), before, 'the racer commits advanced the tip (their writes survive the exhaustion)');
  } finally { lab.cleanup(); }
});

test('F-15c bail-out (git lane): 5001 files -> GC-DEFERRED tree=5001, no commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-big-')); try {
    const origin = join(dir, 'origin.git');
    const files = {};
    for (let i = 0; i < 5001; i++) files[`sessions/BIG/t${i}-a1.txt`] = '';
    seedSessions(origin, [{ files, date: iso(NOW - 1 * DAY) }]);
    const before = tipOf(origin);
    const { r, logs } = await runGc({ origin, state: { tasks: {} } });
    assert.equal(r.outcome, 'deferred');
    assert.equal(r.treeCount, 5001);
    assert.ok(logs.some(l => l.startsWith('GC-DEFERRED tree=5001')), `log lines: ${logs.join(' | ')}`);
    assert.ok(!logs.some(l => l.startsWith('GC-TRANSCRIPTS deleted=')), 'the bail-out REPLACES the deleted/retained line (F-15c: log GC-DEFERRED, do NOT commit)');
    assert.equal(tipOf(origin), before, 'no commit on bail-out');
    assert.equal(lsTree(origin).length, 5001, 'the tree is untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-15 git lane: fsm-sessions branch ABSENT -> deleted=0 retained=0, not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-absent-')); try {
    const origin = join(dir, 'origin.git');
    g(['init', '-q', '--bare', '-b', 'main', origin], dir);
    const { r, logs } = await runGc({ origin });
    assert.equal(r.outcome, 'absent');
    assert.ok(logs.some(l => l.startsWith('GC-TRANSCRIPTS deleted=0 retained=0')), `log lines: ${logs.join(' | ')}`);
    assert.ok(!logs.some(l => l.startsWith('GC-ERROR')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-15 knob (git lane): env=365 clamps to 90 (age_days=90 in the audit subject); env=0 rejects to 7', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-cap-')); try {
    const origin = join(dir, 'origin.git');
    // fixture for the 90d cap: residue added now-100d; the boundary commit
    // (now-91d — INSIDE the now-92d window) carries it forward. The residue
    // is unmapped-in-window -> the deepen pass resolves its exact age (100d)
    // -> collected at the clamped 90d threshold.
    seedSessions(origin, [
      { files: { 'sessions/R/old-a1.txt': 'residue', 'sessions/R/old-a1.meta.json': 'm' }, date: iso(NOW - 100 * DAY) },
      { files: { 'sessions/LIVE/x-a1.txt': 'live' }, date: iso(NOW - 91 * DAY) },
    ]);
    const state = { tasks: { LIVE: { status: 'in_progress' } } }; // R absent -> residue
    const { r, logs } = await runGc({ origin, state, env: { TRANSCRIPT_GC_DAYS: '365' } });
    assert.equal(r.outcome, 'pushed');
    assert.equal(r.deleted, 2);
    assert.equal(r.retained, 1);
    assert.ok(logs.some(l => l === 'GC-DAYS-CLAMP raw=365 -> 90 (hard cap 90)'), `log lines: ${logs.join(' | ')}`);
    const subj = String(g(['--git-dir', origin, 'log', '-1', '--format=%s', 'fsm-sessions'], dir).stdout).trim();
    assert.equal(subj, 'gc-transcripts: deleted=2 retained=1 age_days=90');
    const tree = new Set(lsTree(origin));
    assert.ok(!tree.has('sessions/R/old-a1.txt') && tree.has('sessions/LIVE/x-a1.txt'));
    // and a run with env=0 on a fresh lab rejects to the default 7
    const lab2 = mkStdLab(); try {
      const { logs: l2 } = await runGc({ origin: lab2.origin, env: { TRANSCRIPT_GC_DAYS: '0' } });
      assert.ok(l2.some(l => l === 'GC-DAYS-DEFAULT raw=0 -> 7 (must be an integer >= 1)'), `log lines: ${l2.join(' | ')}`);
      assert.ok(l2.some(l => l === 'GC-TRANSCRIPTS deleted=4 retained=8'), 'the defaulted window behaves as 7');
    } finally { lab2.cleanup(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-15 age source: the inter-epoch GAP — pre-gap residue beyond the window is collected via the deepen pass', async () => {
  // epoch-1 residue (absent task) pushed now-30d; a >window gap; epoch-2's
  // live-task commit at now-1d. The shallow window (9d) sees ONLY epoch-2 —
  // and the grafted boundary FABRICATES the residue's touch at the fresh
  // boundary date (probe-verified: git log --name-only shows the boundary's
  // full tree). The always-deepen-when-shallow pass fetches full history →
  // exact age 30d → VICTIM. This is the pin that makes the deepen pass
  // load-bearing (the old ambiguous>0 trigger could never fire — that was
  // the bug).
  const dir = mkdtempSync(join(tmpdir(), 'gc-gap-')); try {
    const origin = join(dir, 'origin.git');
    seedSessions(origin, [
      { files: { 'sessions/R1/gap-a1.txt': 'epoch-1 residue', 'sessions/R1/gap-a1.meta.json': 'm' }, date: iso(NOW - 30 * DAY) },
      { files: { 'sessions/LIVE2/g2-a1.txt': 'epoch-2 live', 'sessions/LIVE2/g2-a1.meta.json': 'm' }, date: iso(NOW - 1 * DAY) },
    ]);
    const state = { tasks: { LIVE2: { status: 'in_progress' } } }; // R1 absent -> residue
    const { r, logs } = await runGc({ origin, state });
    assert.equal(r.outcome, 'pushed');
    assert.equal(r.deleted, 2, 'the pre-gap residue pair is collected');
    assert.equal(r.retained, 2, 'the live epoch-2 pair is retained');
    assert.ok(logs.some(l => l.startsWith('GC-DEEPENED')), `the deepen pass fired: ${logs.join(' | ')}`);
    const tree = new Set(lsTree(origin));
    assert.ok(!tree.has('sessions/R1/gap-a1.txt'));
    assert.ok(tree.has('sessions/LIVE2/g2-a1.txt'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-15 age source: the QUIET branch — whole history predates the window -> depth-1 fallback still collects', async () => {
  // every commit is older than the shallow window (a lab halted between
  // epochs): git refuses the shallow request ('no commits selected') — the
  // lane falls back to a tip-only clone, where the tip date itself is past
  // the threshold, so everything terminal/absent is definitionally eligible.
  const dir = mkdtempSync(join(tmpdir(), 'gc-quiet-')); try {
    const origin = join(dir, 'origin.git');
    seedSessions(origin, [
      { files: { 'sessions/QD/q-a1.txt': 'done 30d ago', 'sessions/QD/q-a1.meta.json': 'm' }, date: iso(NOW - 30 * DAY) },
      { files: { 'sessions/QL/l-a1.txt': 'live 29d ago', 'sessions/QL/l-a1.meta.json': 'm' }, date: iso(NOW - 29 * DAY) },
    ]);
    const state = { tasks: { QL: { status: 'in_progress' } } }; // QD absent -> residue
    const { r, logs } = await runGc({ origin, state });
    assert.equal(r.outcome, 'pushed');
    assert.equal(r.deleted, 2);
    assert.equal(r.retained, 2);
    assert.ok(logs.some(l => l.startsWith('GC-WINDOW-EMPTY')), `log lines: ${logs.join(' | ')}`);
    const tree = new Set(lsTree(origin));
    assert.ok(!tree.has('sessions/QD/q-a1.txt'));
    assert.ok(tree.has('sessions/QL/l-a1.txt'), 'non-terminal tasks are never touched even on a fully-aged branch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-15 safety: the token NEVER appears in a log line (scrubbed error path)', async () => {
  // dead proxy -> the clone fails hermetically in ~ms with the URL (and any
  // embedded token) in stderr; the GC-ERROR line must carry *** instead
  const prev = { https: process.env.https_proxy, HTTPS: process.env.HTTPS_PROXY };
  process.env.https_proxy = 'http://127.0.0.1:9';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  const logs = [];   // declared BEFORE the closure (the TDZ fix — the agent's draft referenced it before init)
  try {
    const r = await runTranscriptGc({
      state: STD_STATE,
      env: { FSM_SESSIONS_ORIGIN: 'https://x-access-token:SECRETTOKEN123@github.com/claudecode-headless/fsm-lab.git' },
      log: (m) => logs.push(m),
      now: () => NOW,
    });
    assert.equal(r.outcome, 'error');
    assert.equal(logs.length, 1);
    assert.ok(logs[0].startsWith('GC-ERROR'), `log line: ${logs[0]}`);
    assert.ok(!logs[0].includes('SECRETTOKEN123'), 'the token must not appear in the log line');
    assert.ok(logs[0].includes('***') || !logs[0].includes('x-access-token'), 'scrubbed');
  } finally {
    if (prev.https === undefined) delete process.env.https_proxy; else process.env.https_proxy = prev.https;
    if (prev.HTTPS === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prev.HTTPS;
  }
});

// ---------------------------------------------------------------------------
// 6. ADAPTER E2E — the scan itself (F-15a placement + the charter)
// ---------------------------------------------------------------------------

function mkScanLab({ stateJson, sessionsCommits = STD_COMMITS }) {
  const dir = mkdtempSync(join(tmpdir(), 'gc-scan-'));
  const origin = join(dir, 'origin.git');
  g(['init', '-q', '--bare', '-b', 'main', origin], dir);
  // main seed (one commit so clone works)
  const seed = join(dir, 'seed'); mkdirSync(seed);
  g(['init', '-q', '-b', 'main', '.'], seed);
  writeFileSync(join(seed, 'README.md'), 'lab');
  g(['add', '.'], seed);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'seed'], seed);
  g(['push', '-q', origin, 'main'], seed);
  // fsm-state via the real Store (the charter-relevant branch)
  const stateSeed = join(dir, 'stateseed'); mkdirSync(stateSeed);
  g(['clone', '-q', origin, stateSeed], dir);
  const st = new Store({ cwd: stateSeed });
  st.init(stateJson);
  // fsm-sessions with dated transcript commits
  seedSessions(origin, sessionsCommits);
  // the scan's clone
  const clone = join(dir, 'clone');
  g(['clone', '-q', origin, clone], dir);
  return { dir, origin, clone, url: `file://${origin}`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runScan(clone, extraEnv = {}) {
  const env = { ...process.env };
  delete env.FSM_SESSIONS_ORIGIN; // never inherit an ambient override
  Object.assign(env, {
    GITHUB_REPOSITORY: 'local/test',
    GH_TOKEN: 'bogus',
    LAB_PAT: '',
    STALE_AFTER_MIN: '4',
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    ...extraEnv,
  });
  return spawnSync('node', [join(REPO_ROOT, 'watchdog', 'scan.mjs')], { cwd: clone, encoding: 'utf8', env, timeout: 60_000 });
}

test('F-15a placement (PRIMARY TARGET): a HALTED chain still runs the GC — and fsm-state stays READ-ONLY', async () => {
  const lab = mkScanLab({ stateJson: { ...STD_STATE, chain: { ...STD_STATE.chain, halted: true, paused: false } } });
  try {
    const fsmStateBefore = tipOf(lab.origin, 'fsm-state');
    const sessionsBefore = tipOf(lab.origin, 'fsm-sessions');
    const p = runScan(lab.clone, { FSM_SESSIONS_ORIGIN: lab.url });
    assert.equal(p.status, 0, `scan rc=${p.status}\nstdout: ${p.stdout}\nstderr: ${p.stderr}`);
    // THE placement pin: the GC ran BEFORE the halted early-exit
    assert.ok(p.stdout.includes('GC-TRANSCRIPTS deleted=4 retained=8'), `stdout: ${p.stdout}`);
    assert.ok(p.stdout.includes('WATCHDOG-DONE mode=halted'), `stdout: ${p.stdout}`);
    assert.ok(p.stdout.indexOf('GC-TRANSCRIPTS') < p.stdout.indexOf('mode=halted'), 'GC precedes the halted exit');
    // the deletion landed on fsm-sessions (the audit branch)
    assert.notEqual(tipOf(lab.origin, 'fsm-sessions'), sessionsBefore);
    const tree = new Set(lsTree(lab.origin));
    for (const v of STD_VICTIMS) assert.ok(!tree.has(v), `${v} deleted by the halted-scan GC`);
    // THE charter pin (runtime): fsm-state tip unchanged — no write path fired
    assert.equal(tipOf(lab.origin, 'fsm-state'), fsmStateBefore, 'the watchdog NEVER writes fsm-state');
  } finally { lab.cleanup(); }
});

test('charter (source shape): the scan constructs NO fsm-state write path (read-only member set)', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(join(REPO_ROOT, 'watchdog', 'scan.mjs'), 'utf8'));
  const used = new Set();
  for (const m of src.matchAll(/\bstore\.(\w+)/g)) {
    if (m[1] === 'mjs') continue; // the module path in the import line
    used.add(m[1]);
  }
  const allowed = new Set(['fetch', 'readState', 'branch']); // read-only + the log's branch name
  for (const u of used) assert.ok(allowed.has(u), `scan.mjs touches store.${u} — outside the read-only charter set`);
  // no journal write, no queue enqueue, no commit builder anywhere in the GC lane
  assert.ok(!/\.(enqueueControl|enqueueReport|enqueueIntake|buildCommit|readJournals)\s*\(/.test(src), 'no write-path construction');
  // and the GC pass never writes fsm-state: the only push in the file targets fsm-sessions
  const pushes = [...src.matchAll(/git\(\['push',[^\]]*\]\)/g)].map(m => m[0]);
  assert.ok(pushes.length > 0 && pushes.every(p => p.includes('fsm-sessions')), `push targets: ${pushes.join(' ; ')}`);
});

test('F-15 corrupt-state guard: state.json unreadable -> NO GC that scan (sessions untouched)', async () => {
  // absent-from-state counts as terminal; during a corrupt window that would
  // read as "every task is residue" — the D5 guard skips the pass entirely.
  const lab = mkScanLab({ stateJson: { ...STD_STATE, chain: { ...STD_STATE.chain, halted: false, paused: false } } });
  try {
    // corrupt state.json on the fsm-state tip (a bad-JSON commit)
    const work = join(lab.dir, 'corrupt'); mkdirSync(work);
    g(['clone', '-q', '--branch', 'fsm-state', lab.url, work], lab.dir);
    writeFileSync(join(work, 'state', 'state.json'), '{ this is not json');
    g(['add', '-A'], work);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'corrupt'], work);
    g(['push', '-q', 'origin', 'fsm-state'], work);
    const sessionsBefore = tipOf(lab.origin, 'fsm-sessions');
    const p = runScan(lab.clone, { FSM_SESSIONS_ORIGIN: lab.url });
    assert.ok(!p.stdout.includes('GC-TRANSCRIPTS'), `stdout must carry no GC line: ${p.stdout}`);
    assert.ok(!p.stdout.includes('GC-COMMIT'), `stdout must carry no GC commit: ${p.stdout}`);
    // the corrupt lane alerts (api over the dead proxy -> the contained failure is fine)
    assert.ok(p.stdout.includes('state.json unreadable') || p.stderr.includes('WATCHDOG-FAILED'), `stdout: ${p.stdout}\nstderr: ${p.stderr}`);
    assert.equal(tipOf(lab.origin, 'fsm-sessions'), sessionsBefore, 'sessions untouched during the corrupt window');
  } finally { lab.cleanup(); }
});

test('F-15a placement (paused): a PAUSED chain also runs the GC (before the paused exit)', async () => {
  const lab = mkScanLab({ stateJson: { ...STD_STATE, chain: { ...STD_STATE.chain, halted: false, paused: true } } });
  try {
    const p = runScan(lab.clone, { FSM_SESSIONS_ORIGIN: lab.url });
    assert.equal(p.status, 0, `scan rc=${p.status}\nstdout: ${p.stdout}\nstderr: ${p.stderr}`);
    assert.ok(p.stdout.includes('GC-TRANSCRIPTS deleted=4 retained=8'), `stdout: ${p.stdout}`);
    assert.ok(p.stdout.includes('WATCHDOG-DONE mode=paused'), `stdout: ${p.stdout}`);
    assert.equal(gcCount(lab.origin), 1);
  } finally { lab.cleanup(); }
});

test('F-15 isolation: a GC failure NEVER breaks the scan (contained — primary duty proceeds)', async () => {
  const lab = mkScanLab({ stateJson: { ...STD_STATE, chain: { ...STD_STATE.chain, halted: true } } });
  try {
    // unreachable sessions remote -> the pass errors, the scan still exits clean
    const p = runScan(lab.clone, { FSM_SESSIONS_ORIGIN: 'file:///nonexistent-path/origin.git' });
    assert.equal(p.status, 0, `scan rc=${p.status}\nstdout: ${p.stdout}\nstderr: ${p.stderr}`);
    assert.ok(p.stdout.includes('GC-ERROR'), `stdout: ${p.stdout}`);
    assert.ok(p.stdout.includes('WATCHDOG-DONE mode=halted'), 'the primary duty completed after the GC error');
  } finally { lab.cleanup(); }
});
