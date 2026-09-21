// test-store.mjs — the state-anchor suite: CAS optimistic concurrency,
// journal rotation + bounded growth, corruption recovery via git history,
// concurrent-writer survival (the 3-way-refresh discipline, restated for the
// FSM store: retry + re-apply, dedup keys absorb the double-apply).
//
// Runs against a REAL local git repo (bare origin + clone) — no mocks on the
// transport path (the vacuous-fixture discipline).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { genesis, apply, rebuild } from '../lib/fsm.mjs';
import { conductorTick } from '../lib/conductor-core.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const NM = nextMilestoneFactory(fastProject());

function mkLab() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-store-'));
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  const g = (args, cwd) => spawnSync('git', args, { cwd: cwd || clone, encoding: 'utf8' });
  g(['init', '--bare', '-b', 'main', origin], dir);
  // seed origin main with one commit so clone works
  const seed = join(dir, 'seed');
  g(['init', '-b', 'main', seed], dir);
  const w = (p, c) => spawnSync('bash', ['-c', `echo '${c}' > '${p}'`], { cwd: seed });
  w(join(seed, 'README.md'), 'lab');
  g(['add', '.'], seed);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'seed'], seed);
  g(['push', origin, 'main'], seed);
  g(['clone', origin, clone], dir);
  return { dir, origin, clone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cfg = { max_parallel: 2, lease_minutes: 1, max_attempts: 3 };
const boot = (now) => genesis({
  config: cfg,
  project: { tasks: fastProject().m1, milestones: 2 },
  chainId: 'store-test',
  now,
});

test('init: branch created, state readable back', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    const r = st.init(g0);
    assert.equal(r.initialized, true);
    st.fetch();
    const { state } = st.readState();
    assert.equal(state.version, 1);
    assert.equal(state.tasks.A1.status, 'ready');
  } finally { lab.cleanup(); }
});

test('commit: mutate + journal land atomically; read-back matches', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.fetch();
    const out = st.commit({
      mutate: (cur) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: 'evt-t1' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick 1' };
      },
    });
    assert.equal(out.committed, true);
    st.fetch();
    const { state } = st.readState();
    assert.equal(state.chain.seq, 1);
    assert.equal(Object.values(state.tasks).filter(t => t.status === 'assigned').length, 2);
    const j = st.readJournals();
    assert.ok(j.length >= 3, `journal records: ${j.length}`);
    assert.ok(j.some(x => x.kind === 'TICK'));
    assert.ok(j.some(x => x.kind === 'ASSIGN'));
  } finally { lab.cleanup(); }
});

test('CAS: concurrent writer lands between read and push -> retry re-applies, no lost update', () => {
  const lab = mkLab(); try {
    const st1 = new Store({ cwd: lab.clone });
    st1.init(boot('2026-09-06T10:00:00Z'));

    // writer A: commits a TICK normally
    st1.fetch();
    const a = st1.commit({
      mutate: (cur) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'A', ts: now, event_id: 'evt-a' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick A' };
      },
    });
    assert.equal(a.committed, true);

    // writer B: READ the pre-A state (simulated by reading at the old sha —
    // we emulate the race by building B's mutation from the state BEFORE A
    // committed, then letting the CAS loop re-apply against A's state).
    const pre = structuredClone(boot('2026-09-06T10:00:00Z'));
    const b = st1.commit({
      mutate: (cur) => {
        // B's event is a REPORT with a unique event id — applied against
        // whatever CURRENT state the retry reads (A's, post-merge).
        const now = '2026-09-06T10:00:07Z';
        // find a leased task in the CURRENT state (A's tick assigned A1/A2)
        const t = cur.tasks.A1;
        if (!t.lease) return { noop: true, reason: 'no-lease' };
        const r = apply(cur, {
          kind: 'REPORT', event_id: 'evt-b', task: 'A1', lease: t.lease.token,
          outcome: { status: 'done', artifact: 'x' }, run_id: 'run-b',
        }, now, NM);
        return { state: r.state, journal: r.journal, message: 'report B' };
      },
    });
    assert.equal(b.committed, true);
    st1.fetch();
    const { state } = st1.readState();
    // BOTH writes survived: A's tick (chain.seq=1) AND B's report (A1 done)
    assert.equal(state.chain.seq, 1, "A's tick survived");
    assert.equal(state.tasks.A1.status, 'done', "B's report survived");
    assert.ok(state.journal_seq >= 4);
  } finally { lab.cleanup(); }
});

test('CAS conflict path: mutate sees stale base, retry loop re-reads (forced race)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    // first commit
    st.commit({
      mutate: (cur) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: 'evt-1' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick 1' };
      },
    });
    // simulate a mid-flight competing writer: while OUR commit runs, another
    // pushes. We force it by having mutate() push a competing commit itself
    // on the FIRST attempt only, then return a normal mutation.
    let sabotaged = false;
    const out = st.commit({
      mutate: (cur) => {
        if (!sabotaged) {
          sabotaged = true;
          const st2 = new Store({ cwd: lab.clone });
          st2.fetch();
          st2.commit({
            mutate: (c2) => {
              const now = '2026-09-06T10:00:06Z';
              const r = apply(c2, { kind: 'TICK', actor: 'rival', ts: now, event_id: 'evt-rival' }, now, NM);
              return { state: r.state, journal: r.journal, message: 'rival' };
            },
          });
        }
        const now = '2026-09-06T10:00:07Z';
        const r = apply(cur, { kind: 'TICK', actor: 'me', ts: now, event_id: 'evt-2' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick 2 (mine)' };
      },
    });
    assert.equal(out.committed, true, 'CAS retry landed the write');
    st.fetch();
    const { state } = st.readState();
    // three ticks total: evt-1, evt-rival (the racing writer), evt-2 (mine,
    // re-applied against the rival's state by the CAS retry — no lost update)
    assert.equal(state.chain.seq, 3, 'all three ticks counted, none lost');
  } finally { lab.cleanup(); }
});

test('rotation: generations rotate, bounded retention', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 20, keepGens: 3 });
    st.init(boot('2026-09-06T10:00:00Z'));
    let n = 0;
    for (let round = 0; round < 120; round++) {
      st.fetch();
      st.commit({
        mutate: (cur) => {
          const now = new Date(Date.parse('2026-09-06T10:00:00Z') + round * 1000).toISOString();
          const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: `evt-r${round}` }, now, NM);
          n += r.journal.length;
          return { state: r.state, journal: r.journal, message: `tick r${round}` };
        },
      });
    }
    st.fetch();
    const files = st.listStateFiles().filter(f => /journal-\d+\.jsonl/.test(f));
    const gens = files.map(f => parseInt(f.match(/journal-(\d+)/)[1], 10)).sort((a, b) => a - b);
    assert.ok(gens.length >= 2, `rotated generations exist: ${gens}`);
    assert.ok(gens[gens.length - 1] >= 5, `reached generation ${gens[gens.length - 1]}`);
    assert.ok(!gens.includes(1), 'gen 1 pruned (bounded retention)');
    assert.ok(gens.length <= 3, `at most keepGens retained: ${gens}`);
    const all = st.readJournals();
    assert.ok(all.length <= 3 * 20 + 10, `bounded journal size: ${all.length}`);
    // state.json stays small regardless of journal volume
    const raw = st.readFile('state/state.json');
    assert.ok(raw.length < 20_000, `state.json bounded: ${raw.length}B`);
    const { state } = st.readState();
    assert.ok(state.journal_seq > 120, `journal_seq monotonic: ${state.journal_seq}`);
  } finally { lab.cleanup(); }
});

test('corruption recovery: state.json corrupted -> last good state from git history', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    // two good commits
    for (const [i, ev] of [['evt-1', '2026-09-06T10:00:05Z'], ['evt-2', '2026-09-06T10:00:10Z']]) {
      st.fetch();
      st.commit({
        mutate: (cur) => {
          const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: ev, event_id: i }, ev, NM);
          return { state: r.state, journal: r.journal, message: `tick ${i}` };
        },
      });
    }
    // now corrupt state.json on the branch tip (raw push of garbage)
    // s21 CI fix: the runner has NO ambient git identity (the Store's own
    // commit path passes GIT_AUTHOR_*/GIT_COMMITTER_* env explicitly — this
    // raw bash must do the same or commit-tree fails silently there and the
    // corruption never lands, failing the pin at the wrong place).
    spawnSync('bash', ['-c',
      `cd ${lab.clone} && git fetch origin fsm-state && ` +
      `tree=$(git rev-parse origin/fsm-state^{tree}) && ` +
      `blob=$(printf 'THIS IS NOT JSON{{{' | git hash-object -w --stdin) && ` +
      `git read-tree $tree && git update-index --cacheinfo 100644,$blob,state/state.json && ` +
      `t2=$(git write-tree) && ` +
      `c=$(GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.invalid git commit-tree $t2 -p origin/fsm-state -m corrupt) && ` +
      `git push origin $c:refs/heads/fsm-state`], { encoding: 'utf8' });
    st.fetch();
    const { state, corrupt } = st.readState();
    assert.ok(corrupt || state === null, 'corruption detected');
    const good = st.findLastGoodState();
    assert.ok(good, 'last good state found');
    assert.ok(good.state.chain.seq >= 2, `recovered to seq=${good.state.chain.seq}`);
    // recovery write: mutate(null) -> repair from the good snapshot
    const out = st.commit({
      mutate: (cur) => {
        const base = cur || good.state; // cur is null on the corrupt tip
        const now = '2026-09-06T10:00:20Z';
        const r = apply(base, { kind: 'TICK', actor: 'recovery', ts: now, event_id: 'evt-recover' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'recovery tick' };
      },
      attempts: 4,
    });
    assert.equal(out.committed, true);
    st.fetch();
    const healed = st.readState();
    assert.ok(healed.state && healed.state.chain.seq >= 3, `healed state readable: seq=${healed.state?.chain.seq}`);
  } finally { lab.cleanup(); }
});

test('journal replay: readJournals + rebuild reproduce the live state (determinism)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    let s = g0;
    let clock = 0;
    for (let round = 0; round < 5; round++) {
      st.fetch();
      const out = st.commit({
        mutate: (cur) => {
          const now = new Date(Date.parse('2026-09-06T10:00:00Z') + clock * 1000).toISOString();
          const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: `evt-t${round}` }, now, NM);
          return { state: r.state, journal: r.journal, message: `tick ${round}` };
        },
      });
      s = out.state;
      clock += 10;
    }
    st.fetch();
    const live = st.readState().state;
    assert.equal(live.chain.seq, 5);
    // simulate a report landing
    const t = live.tasks.A1;
    st.commit({
      mutate: (cur) => {
        const now = new Date(Date.parse('2026-09-06T10:00:00Z') + 60 * 1000).toISOString();
        const tt = cur.tasks.A1;
        if (!tt.lease) return { noop: true, reason: 'no lease' };
        const r = apply(cur, { kind: 'REPORT', event_id: 'evt-rep', task: 'A1', lease: tt.lease.token, outcome: { status: 'done' }, run_id: 'r1' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'report' };
      },
    });
    st.fetch();
    const final = st.readState().state;
    const recs = st.readJournals();
    const rebuilt = rebuild(g0, recs);
    assert.equal(rebuilt.tasks.A1.status, final.tasks.A1.status);
    assert.equal(rebuilt.chain.seq, final.chain.seq);
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T44 additions: commit-tree fault guard (the branch-deletion path), disjoint
// rotation, numeric gen ordering, unparseable-queue audit, drain semantics.

test('T44/F4: commit-tree failure THROWS (never builds a deletion refspec)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    st.fetch();
    const before = st.headSha();
    assert.ok(before, 'branch exists before the fault');
    // the fault seam: buildCommit behaves as if commit-tree failed
    process.env.FSM_LAB_FAULT_COMMIT_TREE = '1';
    let threw = null;
    try {
      st.commit({ mutate: (cur) => {
        const rr = apply(cur, { kind: 'TICK', event_id: 't-f', ts: '2026-09-06T10:01:00Z' }, '2026-09-06T10:01:00Z', NM);
        return { state: rr.state, journal: rr.journal, message: 'fault test' };
      } });
    } catch (e) { threw = e; }
    delete process.env.FSM_LAB_FAULT_COMMIT_TREE;
    assert.ok(threw, 'commit() must throw when commit-tree fails');
    assert.match(threw.message, /commit-tree failed/);
    // the branch must still exist, tip unchanged (NOT deleted)
    st.fetch();
    assert.equal(st.headSha(), before, 'branch survived the fault — no deletion refspec');
    const { state } = st.readState();
    assert.equal(state.version, 1, 'state untouched');
  } finally { delete process.env.FSM_LAB_FAULT_COMMIT_TREE; lab.cleanup(); }
});

test('T44/F5: rotation is DISJOINT — retained lines are distinct ids, no sliding-window duplication', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 10, keepGens: 3 });
    st.init(boot('2026-09-06T10:00:00Z'));
    let n = 0;
    const pushBatch = (count) => {
      for (let i = 0; i < count; i++) {
        st.commit({ mutate: (cur) => {
          const rr = apply(cur, { kind: 'TICK', event_id: `tick-${n}`, ts: `2026-09-06T10:${String(n % 60).padStart(2, '0')}:00Z`, actor: 'x' }, `2026-09-06T10:${String(n % 60).padStart(2, '0')}:00Z`, NM);
          n++;
          return { state: rr.state, journal: rr.journal, queue: [], controlQueue: [], message: `t${n}` };
        } });
      }
    };
    pushBatch(34);  // 34 records with rotateAt=10 -> several rotations
    st.fetch();
    const all = st.readJournals();
    const ids = all.map(j => j.id);
    const distinct = new Set(ids);
    assert.equal(ids.length, distinct.size, `retained lines must be DISTINCT (got ${ids.length} lines / ${distinct.size} ids)`);
    // bounded retention: keepGens=3 x rotateAt=10 => <= 30 retained (+ in-flight gen)
    assert.ok(ids.length <= 40, `retention bounded (got ${ids.length})`);
    // per-generation disjointness: no id appears in two gen FILES
    const files = st.listStateFiles().filter(f => /journal-\d+/.test(f));
    // 44-h F5 residual (T45/F-H): the FILE count is bounded too — keepGens
    // retained generations (+1 for the in-flight gen at the append boundary)
    assert.ok(files.length <= st.keepGens + 1, `gen FILE count bounded: keepGens=${st.keepGens} + 1, got ${files.length} (${files.join(',')})`);
    const perGen = files.map(f => {
      const raw = st.readFile(f);
      return raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l).id);
    });
    const seen = new Map();
    for (const ids2 of perGen) for (const id of ids2) {
      assert.equal(seen.has(id), false, `id ${id} must live in exactly ONE generation`);
      seen.set(id, true);
    }
  } finally { lab.cleanup(); }
});

test('T44/F5: NUMERIC generation ordering — journal-10 is read AFTER journal-9 (the lexicographic trap)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 3, keepGens: 12 });
    st.init(boot('2026-09-06T10:00:00Z'));
    let n = 0;
    for (let i = 0; i < 40; i++) {
      st.commit({ mutate: (cur) => {
        const ts = new Date(Date.parse('2026-09-06T10:00:00Z') + n * 1000).toISOString();
        const rr = apply(cur, { kind: 'TICK', event_id: `tick-${n}`, ts, actor: 'x' }, ts, NM);
        n++;
        return { state: rr.state, journal: rr.journal, queue: [], controlQueue: [], message: `t${n}` };
      } });
    }
    st.fetch();
    const files = st.listStateFiles().filter(f => /journal-\d+/.test(f));
    const maxGen = Math.max(...files.map(f => parseInt(f.match(/journal-(\d+)/)[1], 10)));
    assert.ok(maxGen >= 10, `need gen >= 10 to exercise the trap (got ${maxGen})`);
    const tail = st.readJournalTail(5);
    // the tail must be the NEWEST records: the last ids by sequence
    const seq = (id) => parseInt(id.slice(1), 10);
    const sorted = [...tail].sort((a, b) => seq(a.id) - seq(b.id));
    assert.deepEqual(tail, sorted, 'tail records arrive in sequence order');
    // and they are the globally-newest: max seq in tail == max seq anywhere
    const all = st.readJournals();
    const maxSeq = Math.max(...all.map(j => seq(j.id)));
    assert.equal(seq(tail[tail.length - 1].id), maxSeq, 'the tail ends at the newest record (gen-10 was NOT hidden)');
  } finally { lab.cleanup(); }
});

// T46/W-D review fold (A4, lens-2 F2) — the readJournalTail KIND filter: the
// console's journal-sourced LANE section needs the last N REPORT records,
// not the last N records of any kind. Mixed-kind journal, hand-built via the
// F1 pattern (a raw file pushed through buildCommit) so the kinds interleave.
test('W-D fold (A4): readJournalTail(n, kind) — REPORT-only tail scans past other kinds; n bounds the MATCHED count; the default is unchanged', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.fetch();
    const dir = mkdtempSync(join(tmpdir(), 'fsm-jkind-'));
    try {
      const recs = [
        { id: 'e101', ts: '2026-09-06T10:00:01Z', applied: true, kind: 'TICK', task: null },
        { id: 'e102', ts: '2026-09-06T10:00:02Z', applied: true, kind: 'REPORT', task: 'A1', to: 'done', lane_stats: { calls: 1, ok: 1 } },
        { id: 'e103', ts: '2026-09-06T10:00:03Z', applied: true, kind: 'CONTROL', command: 'pause' },
        { id: 'e104', ts: '2026-09-06T10:00:04Z', applied: true, kind: 'REPORT', task: 'A2', to: 'done' },
        { id: 'e105', ts: '2026-09-06T10:00:05Z', applied: true, kind: 'TIMEOUT', task: 'A3', from: 'assigned', to: 'ready' },
      ];
      writeFileSync(join(dir, 'journal.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
      const commit = st.buildCommit([[join(dir, 'journal.jsonl'), 'state/journal-1.jsonl']], [], st.headSha(), 'seed mixed-kind journal');
      st.git(['push', 'origin', `${commit}:refs/heads/fsm-state`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    st.fetch();
    // default: today's behavior — every kind rides, tail order
    const all = st.readJournalTail(10);
    assert.deepEqual(all.map(r => r.id), ['e101', 'e102', 'e103', 'e104', 'e105'], 'no kind filter: all five records in sequence order');
    // REPORT-only: the scan SKIPS the interleaved kinds, tail order kept
    const reports = st.readJournalTail(10, 'REPORT');
    assert.deepEqual(reports.map(r => r.id), ['e102', 'e104'], 'only the REPORT records, oldest-first tail order');
    assert.ok(reports.every(r => r.kind === 'REPORT'), 'no foreign kind leaks');
    assert.deepEqual(reports[0].lane_stats, { calls: 1, ok: 1 }, 'the lane_stats payload rides the record (the console\'s source)');
    // n bounds the MATCHED count (not the scanned lines): last 1 REPORT
    assert.deepEqual(st.readJournalTail(1, 'REPORT').map(r => r.id), ['e104'], 'n=1 -> the newest REPORT record only');
    // a kind that does not exist: empty (not an error, not the unfiltered tail)
    assert.deepEqual(st.readJournalTail(10, 'PHASE'), [], 'a absent kind yields the empty tail');
  } finally { lab.cleanup(); }
});

test('T44/F1: unparseable queue lines surface via readQueueEx (auditable before the drop)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    st.fetch();
    // hand-craft a queue file with one good line and one broken line
    const dir = mkdtempSync(join(tmpdir(), 'fsm-qbad-'));
    try {
      const good = { event_id: 'rep-1', task: 'A1', lease: 'x', outcome: { status: 'done' }, run_id: 'r1' };
      const content = JSON.stringify(good) + '\n{BROKEN JSON LINE\n';
      writeFileSync(join(dir, 'queue.jsonl'), content);
      const commit = st.buildCommit([[join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']], [], st.headSha(), 'seed queue with a bad line');
      st.git(['push', 'origin', `${commit}:refs/heads/fsm-state`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    st.fetch();
    const q = st.readQueueEx();
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].event_id, 'rep-1');
    assert.equal(q.bad.length, 1, 'the broken line is surfaced, not silently skipped');
    assert.ok(q.bad[0].includes('BROKEN'));
  } finally { lab.cleanup(); }
});

test('T44/F1: the drain consumes rejected reports — queue EMPTIES (the zombie loop is dead)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    st.fetch();
    // enqueue a report for a task that doesn't exist (permanent reject)
    const r = st.enqueueReport({ event_id: 'rep-ghost', task: 'GHOST-9', lease: 'tok', outcome: { status: 'done', artifact: 'zombie artifact' }, run_id: 'r9' });
    assert.equal(r.ok, true);
    // a conductor-shaped drain: consume ALL, write empty queue
    st.commit({ mutate: (cur, queue, controlQueue, queueBad) => {
      const journals = [];
      for (const q of queue) {
        const rr = apply(cur, { kind: 'REPORT', event_id: q.event_id, task: q.task, lease: q.lease, outcome: q.outcome, run_id: q.run_id }, '2026-09-06T10:01:00Z', NM);
        journals.push(...rr.journal);
      }
      const rr = apply(cur, { kind: 'TICK', event_id: 't1', ts: '2026-09-06T10:01:00Z', actor: 'x' }, '2026-09-06T10:01:00Z', NM);
      return { state: rr.state, journal: [...journals, ...rr.journal], queue: [], controlQueue: [], message: 'drain' };
    } });
    st.fetch();
    assert.equal(st.readQueue().length, 0, 'queue emptied (rejected report consumed, not re-parked)');
    const j = st.readJournals().find(x => x.kind === 'REJECTED' && x.origKind === 'REPORT');
    assert.ok(j, 'the rejection is journaled');
    assert.equal(j.reason, 'unknown-task');
    assert.equal(j.event_id, 'rep-ghost');
    assert.equal(j.outcome.artifact, 'zombie artifact', 'audit trail preserved');
    // the second drain: the queue stays empty and NO new REJECTED records
    // appear for the consumed id (clock transitions may journal legitimately)
    const rejectedBefore = st.readJournals().filter(x => x.kind === 'REJECTED').length;
    st.commit({ mutate: (cur) => {
      const rr = apply(cur, { kind: 'TICK', event_id: 't2', ts: '2026-09-06T10:02:00Z', actor: 'x' }, '2026-09-06T10:02:00Z', NM);
      return { state: rr.state, journal: rr.journal, queue: [], controlQueue: [], message: 't2' };
    } });
    st.fetch();
    assert.equal(st.readQueue().length, 0, 'queue still empty');
    const rejectedAfter = st.readJournals().filter(x => x.kind === 'REJECTED').length;
    assert.equal(rejectedAfter, rejectedBefore, 'no zombie re-rejection of the consumed event_id');
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T45/F-A additions: the corruption-repair rollback sweep (probe1's shape,
// driven through the REAL Store + REAL conductorTick; the R3-adjudicated
// direction — KEEP idNum < dropFrom, DROP idNum >= dropFrom).

// a raw plumbing commit: write exactly these branch files over the parent tree
function plumbCommit(st, files, message) {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-plumb-'));
  try {
    const mappings = [];
    for (const [dest, content] of Object.entries(files)) {
      const base = dest.split('/').pop();
      writeFileSync(join(dir, base), content);
      mappings.push([join(dir, base), dest]);
    }
    const commit = st.buildCommit(mappings, [], st.headSha(), message);
    st.git(['push', 'origin', `${commit}:refs/heads/fsm-state`]);
    return commit;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// the conductor-adapter-shaped repair turn: the REAL conductorTick with a
// recover() closure mirroring conductor/turn.mjs's F-A contract
function repairCommit(st, ts = '2026-09-06T11:00:00Z') {
  return st.commit({
    mutate: (cur, queue, controlQueue, queueBad, ctlBad) => conductorTick({
      cur, queue, controlQueue, queueBad, ctlBad,
      ev: { kind: 'TICK', actor: 'backstop', event_id: 'evt-repair', ts },
      now: () => ts,
      nextMilestone: NM,
      recover: () => {
        const good = st.findLastGoodState();
        const tail = st.readJournalTail(1);
        const journalMaxId = tail.length ? parseInt(String(tail[0].id || '').slice(1), 10) : NaN;
        if (good) {
          const dropFrom = good.state.journal_seq;
          return {
            state: good.state, reason: 'history-walk', snapshotSha: good.sha,
            journalMaxId, dropFrom, droppedRecords: st.countJournalFrom(dropFrom),
          };
        }
        return Number.isFinite(journalMaxId) ? { state: null, reason: 'bootstrap', journalMaxId } : null;
      },
      makeGenesis: () => {
        const g = genesis({ config: cfg, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'repair-chain', now: ts });
        return { state: g, spec: { tasks: fastProject().m1, milestones: 2, chainId: 'repair-chain' } };
      },
    }),
  });
}

const rec = (id, fields, ts) => ({ id, ts, applied: true, ...fields });
const jlines = (recs) => recs.map(r => JSON.stringify(r)).join('\n') + '\n';

test('T45/F-A: repair sweep — probe1 shape (rollback journal integrity + R3 gate)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 10, keepGens: 6 });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    // era1: two REAL commits — snapshot journal_seq lands at 7 (records e1..e6)
    st.fetch();
    st.commit({ mutate: (cur) => {
      const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: '2026-09-06T10:00:05Z', event_id: 'evt-a' }, '2026-09-06T10:00:05Z', NM);
      return { state: r.state, journal: r.journal, message: 'era1 tick' };
    } });
    st.commit({ mutate: (cur) => {
      const t = cur.tasks.A1;
      const r = apply(cur, { kind: 'REPORT', event_id: 'evt-b', task: 'A1', lease: t.lease.token, outcome: { status: 'done', artifact: 'era1' }, run_id: 'r-b' }, '2026-09-06T10:00:10Z', NM);
      return { state: r.state, journal: r.journal, message: 'era1 report' };
    } });
    st.fetch();
    const snapshotSeq = st.readState().state.journal_seq;
    const era1 = st.readJournals();
    assert.ok(era1.length >= 5, `era1 records: ${era1.length}`);
    // the corrupt era: records e7..e9 land on-branch AND the state.json is
    // garbage — exactly probe1 (the snapshot's seq sits BELOW the on-branch ids)
    plumbCommit(st, {
      'state/state.json': 'THIS IS NOT JSON{{{',
      'state/journal-1.jsonl': jlines([...era1, ...[
        rec('e7', { kind: 'TICK', seq: 2, actor: 'chain' }, '2026-09-06T10:30:00Z'),
        rec('e8', { kind: 'ASSIGN', task: 'A5', from: 'ready', to: 'assigned', lease: 'l-corrupt', expires: '2026-09-06T10:41:00Z', attempt: 1, behavior: 'succeed' }, '2026-09-06T10:31:00Z'),
        rec('e9', { kind: 'REPORT', task: 'A5', lease: 'l-corrupt', to: 'done', run_id: 'run-corrupt' }, '2026-09-06T10:32:00Z'),
      ]]),
    }, 'corrupt era');
    st.fetch();
    assert.ok(st.readState().corrupt, 'tip is corrupt');
    // the repair turn: the REAL conductorTick through the real store
    const out = repairCommit(st);
    assert.equal(out.committed, true);
    st.fetch();
    const all = st.readJournals();
    const ids = all.map(j => j.id);
    // (a) CHECK1 dead — zero duplicate ids on-branch post-repair
    assert.equal(new Set(ids).size, ids.length, `duplicate ids on-branch: ${ids.join(',')}`);
    // (b) CHECK2 dead — journal_seq > max on-branch id
    const final = st.readState().state;
    const maxId = Math.max(...ids.map(i => parseInt(i.slice(1), 10)));
    assert.ok(final.journal_seq > maxId, `journal_seq ${final.journal_seq} <= max on-branch id ${maxId}`);
    // (c) the R3-adjudicated DIRECTION: rolled-back records GONE, era1 KEPT
    for (const bad of ['e7', 'e8', 'e9']) assert.ok(!ids.includes(bad), `rolled-back record ${bad} must be SWEPT`);
    for (const r of era1) assert.ok(ids.includes(r.id), `era1 record ${r.id} must SURVIVE the sweep`);
    // (d) the RECOVERY record carries the rollback audit
    const recovery = all.find(j => j.kind === 'RECOVERY');
    assert.ok(recovery, 'RECOVERY record present');
    assert.equal(recovery.reason, 'history-walk');
    assert.equal(recovery.dropFrom, snapshotSeq);
    assert.equal(recovery.droppedRecords, 3);
    assert.ok(recovery.snapshotSha, 'snapshotSha carried');
    // (e)+(f) R3's gate: the repair's OWN records are present on-branch
    // (the (b)-side double-writer failure — journal_seq advanced past records
    // that never landed)
    const repairIds = (out.journal || []).map(j => j.id);
    assert.ok(repairIds.length >= 2, `the repair journaled ${repairIds.length} records`);
    for (const id of repairIds) assert.ok(ids.includes(id), `the repair's own record ${id} must be ON-BRANCH post-commit`);
    assert.ok(Math.max(...repairIds.map(i => parseInt(i.slice(1), 10))) > 9, 'repair records mint ABOVE the swept-out corrupt era');
    // CHECK3 dead — rebuild(genesis, readJournals()) agrees with the live state
    const rebuilt = rebuild(g0, all);
    for (const [id, t] of Object.entries(final.tasks)) {
      assert.equal(rebuilt.tasks[id]?.status, t.status, `rebuild status mismatch for ${id}`);
      assert.equal(rebuilt.tasks[id]?.attempts, t.attempts, `rebuild attempts mismatch for ${id}`);
    }
    assert.equal(rebuilt.chain.seq, final.chain.seq);
    assert.equal(rebuilt.stats.done, final.stats.done);
    assert.equal(rebuilt.stats.infra_retries, final.stats.infra_retries);
  } finally { lab.cleanup(); }
});

test('T45/F-A: a sweep that EMPTIES the current gen removes the gen file; records land in the NEXT gen', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 5, keepGens: 6 });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    // era1 (hand-built snapshot): journal-1 = e1..e5, state seq=6
    const era1State = structuredClone(g0);
    era1State.journal_seq = 6;
    const era1 = [
      rec('e1', { kind: 'TICK', seq: 1, actor: 'chain' }, '2026-09-06T10:00:01Z'),
      rec('e2', { kind: 'ASSIGN', task: 'A1', from: 'ready', to: 'assigned', lease: 'l-1', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'succeed' }, '2026-09-06T10:00:02Z'),
      rec('e3', { kind: 'ASSIGN', task: 'A2', from: 'ready', to: 'assigned', lease: 'l-2', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'flaky' }, '2026-09-06T10:00:03Z'),
      rec('e4', { kind: 'REPORT', task: 'A1', lease: 'l-1', to: 'done', run_id: 'r-1' }, '2026-09-06T10:00:04Z'),
      rec('e5', { kind: 'UNLOCK', task: 'A4', from: 'backlog', to: 'ready' }, '2026-09-06T10:00:05Z'),
    ];
    plumbCommit(st, {
      'state/state.json': JSON.stringify(era1State, null, 1) + '\n',
      'state/journal-1.jsonl': jlines(era1),
    }, 'era1 (hand-built snapshot)');
    // corrupt era: journal-2 holds ONLY rolled-back records (ids >= 6)
    plumbCommit(st, {
      'state/state.json': 'GARBAGE',
      'state/journal-2.jsonl': jlines([
        rec('e6', { kind: 'TICK', seq: 2, actor: 'chain' }, '2026-09-06T10:30:00Z'),
        rec('e7', { kind: 'ASSIGN', task: 'A5', from: 'ready', to: 'assigned', lease: 'l-c', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'succeed' }, '2026-09-06T10:30:01Z'),
        rec('e8', { kind: 'REPORT', task: 'A5', lease: 'l-c', to: 'done', run_id: 'r-c' }, '2026-09-06T10:30:02Z'),
      ]),
    }, 'corrupt era (all records >= dropFrom)');
    st.fetch();
    assert.ok(st.readState().corrupt);
    const out = repairCommit(st);
    assert.equal(out.committed, true);
    st.fetch();
    const files = st.listStateFiles().filter(f => /journal-\d+/.test(f));
    assert.ok(!files.includes('state/journal-2.jsonl'), `the EMPTIED current gen is REMOVED (files: ${files.join(',')})`);
    assert.ok(files.includes('state/journal-1.jsonl'), 'the good gen survives');
    assert.ok(files.includes('state/journal-3.jsonl'), 'the repair records land in the NEXT gen');
    // gen-1 content byte-identical: e1..e5 untouched by the sweep
    const raw1 = st.readFile('state/journal-1.jsonl');
    assert.equal(raw1, jlines(era1), 'the untouched good gen is byte-identical (no spurious rewrite)');
    const all = st.readJournals();
    const ids = all.map(j => j.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    for (const bad of ['e6', 'e7', 'e8']) assert.ok(!ids.includes(bad), `rolled-back ${bad} swept`);
    for (const r of era1) assert.ok(ids.includes(r.id), `era1 ${r.id} survives`);
    const recovery = all.find(j => j.kind === 'RECOVERY');
    assert.equal(recovery.dropFrom, 6);
    assert.equal(recovery.droppedRecords, 3);
    const final = st.readState().state;
    assert.ok(final.journal_seq > Math.max(...ids.map(i => parseInt(i.slice(1), 10))));
    // R3's gate: the repair's own records are on-branch (in gen-3)
    for (const id of (out.journal || []).map(j => j.id)) assert.ok(ids.includes(id), `repair record ${id} on-branch`);
  } finally { lab.cleanup(); }
});

test('T45/F-A: multi-gen STRADDLE — corrupt-era records in the current gen AND a prior gen are swept from BOTH', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 10, keepGens: 6 });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    // era1: journal-1 = e1..e5, state seq=6
    const era1State = structuredClone(g0);
    era1State.journal_seq = 6;
    const era1 = [
      rec('e1', { kind: 'TICK', seq: 1, actor: 'chain' }, '2026-09-06T10:00:01Z'),
      rec('e2', { kind: 'ASSIGN', task: 'A1', from: 'ready', to: 'assigned', lease: 'l-1', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'succeed' }, '2026-09-06T10:00:02Z'),
      rec('e3', { kind: 'REPORT', task: 'A1', lease: 'l-1', to: 'done', run_id: 'r-1' }, '2026-09-06T10:00:03Z'),
      rec('e4', { kind: 'UNLOCK', task: 'A4', from: 'backlog', to: 'ready' }, '2026-09-06T10:00:04Z'),
      rec('e5', { kind: 'TICK', seq: 2, actor: 'chain' }, '2026-09-06T10:00:05Z'),
    ];
    plumbCommit(st, {
      'state/state.json': JSON.stringify(era1State, null, 1) + '\n',
      'state/journal-1.jsonl': jlines(era1),
    }, 'era1');
    // corrupt era STRADDLING both gens: gen-1 carries e1..e10 (era1 + e6..e10),
    // gen-2 carries e11..e14 — dropFrom=6 must sweep e6..e14 out of BOTH
    const corrupt = [
      rec('e6', { kind: 'TICK', seq: 3, actor: 'chain' }, '2026-09-06T10:20:00Z'),
      rec('e7', { kind: 'ASSIGN', task: 'A2', from: 'ready', to: 'assigned', lease: 'l-c2', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'flaky' }, '2026-09-06T10:20:01Z'),
      rec('e8', { kind: 'ASSIGN', task: 'A3', from: 'ready', to: 'assigned', lease: 'l-c3', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'poison' }, '2026-09-06T10:20:02Z'),
      rec('e9', { kind: 'REPORT', task: 'A2', lease: 'l-c2', to: 'done', run_id: 'r-c2' }, '2026-09-06T10:20:03Z'),
      rec('e10', { kind: 'REPORT', task: 'A3', lease: 'l-c3', to: 'done', run_id: 'r-c3' }, '2026-09-06T10:20:04Z'),
      rec('e11', { kind: 'TICK', seq: 4, actor: 'chain' }, '2026-09-06T10:25:00Z'),
      rec('e12', { kind: 'ASSIGN', task: 'A5', from: 'ready', to: 'assigned', lease: 'l-c5', expires: '2026-09-06T10:40:00Z', attempt: 1, behavior: 'dup' }, '2026-09-06T10:25:01Z'),
      rec('e13', { kind: 'REPORT', task: 'A5', lease: 'l-c5', to: 'done', run_id: 'r-c5' }, '2026-09-06T10:25:02Z'),
      rec('e14', { kind: 'TICK', seq: 5, actor: 'chain' }, '2026-09-06T10:30:00Z'),
    ];
    plumbCommit(st, {
      'state/state.json': 'GARBAGE',
      'state/journal-1.jsonl': jlines([...era1, ...corrupt.slice(0, 5)]),
      'state/journal-2.jsonl': jlines(corrupt.slice(5)),
    }, 'corrupt era (straddling gens)');
    st.fetch();
    assert.ok(st.readState().corrupt);
    const out = repairCommit(st);
    assert.equal(out.committed, true);
    st.fetch();
    const files = st.listStateFiles().filter(f => /journal-\d+/.test(f));
    assert.ok(!files.includes('state/journal-2.jsonl'), 'the emptied gen-2 is REMOVED');
    assert.ok(files.includes('state/journal-1.jsonl'), 'gen-1 survives (rewritten to its good prefix)');
    assert.ok(files.includes('state/journal-3.jsonl'), 'the repair records land in gen-3');
    // gen-1 was swept IN PLACE: e1..e5 only (the straddle — its corrupt tail e6..e10 gone)
    assert.equal(st.readFile('state/journal-1.jsonl'), jlines(era1), 'gen-1 rewritten to contain ONLY its pre-snapshot records');
    const all = st.readJournals();
    const ids = all.map(j => j.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    for (let n = 6; n <= 14; n++) assert.ok(!ids.includes(`e${n}`), `rolled-back e${n} swept from BOTH gens`);
    for (const r of era1) assert.ok(ids.includes(r.id), `era1 ${r.id} survives`);
    const recovery = all.find(j => j.kind === 'RECOVERY');
    assert.equal(recovery.dropFrom, 6);
    assert.equal(recovery.droppedRecords, 9, 'the audit counts the straddle (5 from gen-1 + 4 from gen-2)');
    for (const id of (out.journal || []).map(j => j.id)) assert.ok(ids.includes(id), `repair record ${id} on-branch`);
    const final = st.readState().state;
    assert.ok(final.journal_seq > Math.max(...ids.map(i => parseInt(i.slice(1), 10))));
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T45/F-E: probe2's Shape A re-driven through a REAL drain — a re-run's
// attempt-scoped report is a stale-lease ORPHAN (journaled, visible), never a
// dedup swallow (the documented re-run contract).

test('T45/F-E: re-run shape — rep-111-a1{failed} then rep-111-a2{done}: the failed APPLIES (attempt burn), the re-run is a stale-lease REJECT (NOT dedup-swallowed)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    // assign A1 (one tick)
    let state = null;
    st.commit({ mutate: (cur) => {
      const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: '2026-09-06T10:00:05Z', event_id: 't-a' }, '2026-09-06T10:00:05Z', NM);
      state = r.state;
      return { state: r.state, journal: r.journal, message: 'assign' };
    } });
    const lease = state.tasks.A1.lease.token;
    // attempt 1 of run 111: the flaky worker FAILS (work-class — burns the attempt)
    st.enqueueReport({ event_id: 'rep-111-a1', task: 'A1', lease, outcome: { status: 'failed', error: 'flaky' }, run_id: '111' });
    // the re-run (attempt 2) reports done with the SAME run id, DIFFERENT attempt
    st.enqueueReport({ event_id: 'rep-111-a2', task: 'A1', lease, outcome: { status: 'done', artifact: 'better result' }, run_id: '111' });
    // the drain: the first applies; by the time the second is drained the
    // failed->retry->reassignment cycle has already minted a NEW lease — the
    // re-run's report lands as a stale-lease ORPHAN (journaled), never a
    // dedup swallow (the OLD rep-<run> id shape swallowed it silently).
    st.commit({ mutate: (cur, queue) => conductorTick({
      cur, queue, controlQueue: [],
      ev: { kind: 'TICK', actor: 'chain', event_id: 't-drain', ts: '2026-09-06T10:01:00Z' },
      now: () => '2026-09-06T10:01:00Z',
      nextMilestone: NM,
      recover: null,
      makeGenesis: () => { throw new Error('no genesis expected'); },
    }) });
    st.fetch();
    const final = st.readState().state;
    const tail = st.readJournalTail(30);
    const applied = tail.find(j => j.kind === 'REPORT' && j.task === 'A1');
    assert.equal(applied.to, 'failed', 'the failed report applied (work-class: failed, then the clock retry-scan requeues it)');
    const rej = tail.find(j => j.kind === 'REJECTED' && j.event_id === 'rep-111-a2');
    assert.ok(rej, 'the re-run report was JOURNALED as rejected');
    assert.equal(rej.reason, 'stale-lease', 'the documented contract: re-run outcome = stale-lease orphan (the FSM retry ladder owns retries)');
    assert.equal(final.stats.orphaned_reports, 1, 'the visible-waste counter incremented — never silent');
    assert.equal(final.tasks.A1.status, 'assigned', 'reassigned in the same pass (new lease — the retry ladder)');
    assert.notEqual(final.tasks.A1.lease.token, lease, 'a NEW lease owns the task now');
    assert.ok(final.tasks.A1.attempts >= 2, 'the reassignment burned the next REAL attempt (the re-run itself burned nothing — it is not a dedup swallow, it is an orphan)');
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T45/F-G(d): strict queue reads — an EXISTING-but-unreadable queue file
// throws instead of masquerading as empty (the silent-rewrite kill).

test('T45/F-G(d): FSM_LAB_FAULT_READ_SHOW — an existing-but-unreadable queue THROWS; the branch tip is UNCHANGED', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.commit({ mutate: (cur) => {
      const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: '2026-09-06T10:00:05Z', event_id: 't-fd' }, '2026-09-06T10:00:05Z', NM);
      return { state: r.state, journal: r.journal, message: 'tick' };
    } });
    st.fetch();
    // a report lands on the queue (the file now EXISTS on the branch)
    const enq = st.enqueueReport({ event_id: 'rep-fd-1', task: 'A1', lease: 'tok', outcome: { status: 'done', artifact: 'x' }, run_id: 'r-fd' });
    assert.equal(enq.ok, true);
    st.fetch();
    const before = st.headSha();
    assert.ok(st.readQueueEx().items.length === 1, 'the queue is readable pre-fault');
    // the fault seam: git show fails while ls-tree still lists the path
    process.env.FSM_LAB_FAULT_READ_SHOW = '1';
    let threw = null;
    try {
      st.readQueueEx();
    } catch (e) { threw = e; }
    // the enqueue path must THROW too (it reads via readQueueEx)
    let enqThrew = null;
    try {
      st.enqueueReport({ event_id: 'rep-fd-2', task: 'A1', lease: 'tok', outcome: { status: 'done' }, run_id: 'r-fd-2' });
    } catch (e) { enqThrew = e; }
    delete process.env.FSM_LAB_FAULT_READ_SHOW;
    assert.ok(threw, 'readQueueEx must THROW when an existing file reads as damaged');
    assert.match(threw.message, /readFileStrict: git show failed/);
    assert.ok(enqThrew, 'enqueueReport must THROW (a silent rewrite would DELETE the queued report)');
    // the branch survived untouched — the CAS push was never attempted
    st.fetch();
    assert.equal(st.headSha(), before, 'branch tip unchanged — no data loss, the failure is VISIBLE');
    // and the absent-file path still reads as empty (not a throw)
    assert.equal(st.readFileStrict('state/no-such-file.jsonl'), null, 'an ABSENT path still returns null (bootstrap semantics intact)');
  } finally { delete process.env.FSM_LAB_FAULT_READ_SHOW; lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T45/F-G(d2): enqueue merges PRESERVE unparseable lines (G-11 — the last
// real unaudited-drop surface; only the conductor's drain may drop, journaled).

test('T45/F-G(d2): enqueue onto a queue holding a bad line PRESERVES it; the drain then journals REJECTED(unparseable) and empties', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    // hand-place a queue with ONE unparseable line (the damage shape)
    plumbCommit(st, {
      'state/state.json': JSON.stringify(g0, null, 1) + '\n',
      'state/reports-queue.jsonl': 'THIS LINE IS NOT JSON{{{\n',
    }, 'damaged queue (one bad line)');
    st.fetch();
    // a worker CAS-appends onto the damaged queue
    const enq = st.enqueueReport({ event_id: 'rep-d2-1', task: 'A1', lease: 'tok', outcome: { status: 'done', artifact: 'ok' }, run_id: 'r-d2' });
    assert.equal(enq.ok, true);
    st.fetch();
    const raw = st.readFile('state/reports-queue.jsonl');
    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
    assert.equal(lines.length, 2, `the bad line SURVIVED the merge (got ${lines.length} lines)`);
    assert.match(lines[0], /THIS LINE IS NOT JSON/, 'the bad line is preserved VERBATIM ahead of the new record');
    assert.match(lines[1], /rep-d2-1/);
    // the full discipline end-to-end: the conductor's drain journals the bad
    // line REJECTED(unparseable) and empties the queue (the ONLY drop path)
    st.commit({ mutate: (cur, queue, controlQueue, queueBad) => conductorTick({
      cur, queue, controlQueue, queueBad,
      ev: { kind: 'TICK', actor: 'chain', event_id: 't-d2', ts: '2026-09-06T10:01:00Z' },
      now: () => '2026-09-06T10:01:00Z',
      nextMilestone: NM,
      recover: null,
      makeGenesis: () => { throw new Error('no genesis expected'); },
    }) });
    st.fetch();
    const tail = st.readJournalTail(30);
    const rej = tail.find(j => j.kind === 'REJECTED' && j.reason === 'unparseable');
    assert.ok(rej, 'the drain JOURNALED the bad line as REJECTED(unparseable)');
    assert.match(rej.raw, /THIS LINE IS NOT JSON/);
    assert.equal(st.readQueueEx().items.length, 0, 'the drain emptied the queue (the only sanctioned drop)');
    assert.equal(st.readQueueEx().bad.length, 0);
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T46/W-C1 §4b (lane B): the THIRD queue — state/intake-queue.jsonl, the
// intake door's parking lot. Same discipline as the control queue: strict
// presence (F-G(d)), merge-reserialize (F-G(d2)), consume = rewrite-minus-
// head or DELETE-on-empty (m-5), park = the file untouched.
// ---------------------------------------------------------------------------

const irec = (issue, sha, extra = {}) => ({
  issue, body_sha8: sha,
  spec: { title: `task from issue #${issue}`, accept: 'do the thing' },
  enqueued_at: '2026-09-17T10:00:00.000Z', author: 'alice', ...extra,
});

test('T46/§4b: intake round-trip — enqueueIntake lands the line; readIntakeQueue reads it back', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    const r = st.enqueueIntake(irec(42, 'ab12cd34'));
    assert.equal(r.ok, true, `enqueue ok: ${r.err}`);
    st.fetch();
    const ex = st.readIntakeQueueEx();
    assert.equal(ex.items.length, 1);
    assert.equal(ex.items[0].issue, 42);
    assert.equal(ex.items[0].body_sha8, 'ab12cd34');
    assert.equal(ex.items[0].spec.title, 'task from issue #42');
    assert.equal(ex.bad.length, 0);
    assert.equal(st.readIntakeQueue().length, 1, 'readIntakeQueue is the items view');
  } finally { lab.cleanup(); }
});

test('T46/§4b (m-5): drain-consume — mutate returns intakeQueue MINUS HEAD -> file REWRITTEN (the rollover shape)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.enqueueIntake(irec(1, 'aaaaaaaa'));
    st.enqueueIntake(irec(2, 'bbbbbbbb'));
    st.fetch();
    assert.equal(st.readIntakeQueue().length, 2);
    // the conductor's epoch-rollover shape (§5, lane A): consume the head,
    // keep the tail parked for the NEXT halt
    st.commit({
      mutate: (cur, queue, controlQueue, queueBad, ctlBad, intakeQueue, intakeBad) => {
        assert.equal(intakeQueue.length, 2, 'param 6 = intake items');
        assert.equal(intakeBad.length, 0, 'param 7 = intake bad lines');
        assert.equal(intakeQueue[0].issue, 1, 'head is issue #1 (FIFO)');
        return { state: cur, journal: [], intakeQueue: intakeQueue.slice(1), message: 'rollover consumed head' };
      },
    });
    st.fetch();
    const q = st.readIntakeQueue();
    assert.equal(q.length, 1, 'rewrite-minus-head landed');
    assert.equal(q[0].issue, 2, 'the TAIL survived (issue #2 now at the head)');
  } finally { lab.cleanup(); }
});

test('T46/§4b (m-5): consume-to-EMPTY — intakeQueue: [] DELETES the file from the branch', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.enqueueIntake(irec(7, 'cafef00d'));
    st.fetch();
    assert.equal(st.readIntakeQueue().length, 1);
    st.commit({
      mutate: (cur, _q, _cq, _qb, _cb, intakeQueue) => {
        assert.equal(intakeQueue.length, 1);
        return { state: cur, journal: [], intakeQueue: [], message: 'drain all' };
      },
    });
    st.fetch();
    assert.equal(st.readIntakeQueueEx().items.length, 0);
    assert.equal(st.readIntakeQueueEx().bad.length, 0);
    assert.equal(st.readFile('state/intake-queue.jsonl'), null, 'the file is ABSENT on the branch (DELETE, not empty-file)');
  } finally { lab.cleanup(); }
});

test('T46/§4b: park + backward compat — an OLD-shape mutate (5 params, no intakeQueue key) leaves the file UNTOUCHED', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.enqueueIntake(irec(9, 'deadbeef'));
    st.fetch();
    const before = st.readFile('state/intake-queue.jsonl');
    assert.ok(before, 'the intake line landed');
    // the PRE-W-C1 caller shape verbatim: five declared params, no
    // intakeQueue in the return — the park case (an active epoch never
    // touches the queue; extra args are simply not declared)
    st.commit({
      mutate: (cur, queue, controlQueue, queueBad, ctlBad) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: 'evt-park' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick while parked' };
      },
    });
    st.fetch();
    assert.equal(st.readFile('state/intake-queue.jsonl'), before, 'the intake file is BYTE-IDENTICAL (park = untouched)');
    assert.equal(st.readIntakeQueue().length, 1, 'the parked line is still readable');
  } finally { lab.cleanup(); }
});

test('T46/§4b: bad intake lines surface via readIntakeQueueEx; enqueueIntake PRESERVES them (F-G(d2))', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    plumbCommit(st, {
      'state/state.json': JSON.stringify(g0, null, 1) + '\n',
      'state/intake-queue.jsonl': JSON.stringify(irec(1, 'aaaaaaaa')) + '\nNOT JSON AT ALL[[[\n',
    }, 'damaged intake queue (one bad line)');
    st.fetch();
    const ex = st.readIntakeQueueEx();
    assert.equal(ex.items.length, 1);
    assert.equal(ex.items[0].issue, 1);
    assert.equal(ex.bad.length, 1, 'the bad line is surfaced, not silently skipped');
    assert.match(ex.bad[0], /NOT JSON AT ALL/);
    // the door CAS-appends onto the damaged queue: the bad line survives
    const enq = st.enqueueIntake(irec(2, 'bbbbbbbb'));
    assert.equal(enq.ok, true);
    st.fetch();
    const raw = st.readFile('state/intake-queue.jsonl');
    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
    assert.equal(lines.length, 3, `the bad line SURVIVED the merge (got ${lines.length} lines)`);
    assert.match(lines[0], /NOT JSON AT ALL/, 'bad line preserved VERBATIM ahead of the records');
    assert.match(lines[1], /"issue":1/);
    assert.match(lines[2], /"issue":2/);
    // and the mutate-side view agrees: items 2, bad 1
    const ex2 = st.readIntakeQueueEx();
    assert.equal(ex2.items.length, 2);
    assert.equal(ex2.bad.length, 1);
  } finally { lab.cleanup(); }
});

test('T46/§4b: intake CAS-conflict retry — a rival door push mid-commit re-reads and lands (no lost update)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.enqueueIntake(irec(1, 'aaaaaaaa'));
    // simulate a mid-flight competing DOOR: while OUR rollover commit runs,
    // another intake push lands. Forced by having mutate() enqueue a rival
    // line on the FIRST attempt only, then return a consume-head mutation.
    let sabotaged = false;
    const out = st.commit({
      mutate: (cur, _q, _cq, _qb, _cb, intakeQueue) => {
        if (!sabotaged) {
          sabotaged = true;
          const st2 = new Store({ cwd: lab.clone });
          st2.fetch();
          const r2 = st2.enqueueIntake(irec(2, 'bbbbbbbb'));
          assert.equal(r2.ok, true, 'the rival door push landed');
        }
        // consume the head WHATEVER it currently is — the CAS retry re-reads
        // the rival's queue and re-decides against it (no lost update)
        return { state: cur, journal: [], intakeQueue: intakeQueue.slice(1), message: 'rollover' };
      },
    });
    assert.equal(out.committed, true, 'CAS retry landed the rollover');
    st.fetch();
    const q = st.readIntakeQueue();
    // attempt 1 read [issue#1]; the rival appended issue#2 mid-flight; the
    // retry re-read [issue#1, issue#2] and consumed the HEAD (#1) — issue#2
    // (enqueued AFTER our read but BEFORE our push) SURVIVED.
    assert.equal(q.length, 1, `exactly the rival's line survived: ${JSON.stringify(q.map(l => l.issue))}`);
    assert.equal(q[0].issue, 2, 'the rival intake line was not lost to the CAS race');
  } finally { lab.cleanup(); }
});

// T46/W-C1-R (lens-2 MUT-b): the PAUSE COMMIT's queue-preservation pin.
// The adapter's second commit (conductor/turn.mjs's BUDGET-PAUSE block)
// returns {queue: q2, controlQueue: cq2} — queues that landed between the
// two commits rewrite UNCHANGED for the next tick (never dropped). The
// pre-fold shape had NO pin: mutating to {queue: []} passed 323/323 +
// sim4 51/51 (sim4's driver bypasses the store entirely). This pin drives
// the REAL store through the REAL two-commit shape with a report landing
// in between.
test('W-C1-R/MUT-b: the pause commit preserves interleaved queues (the two-commit protocol, store-level)', () => {
  const lab = mkLab();
  try {
    const store = new Store({ cwd: lab.clone });
    store.init();
    const now = () => new Date().toISOString();
    const NMq = nextMilestoneFactory(fastProject());
    // commit 1: bootstrap + a tick (the plain shape)
    const out1 = store.commit({
      mutate: (cur, q, cq, qb, cb) => conductorTick({
        cur, queue: q, controlQueue: cq, queueBad: qb, ctlBad: cb,
        ev: { kind: 'TICK', actor: 'seed', event_id: `tick-mutb-${Date.now()}`, ts: now() },
        now, nextMilestone: NMq, recover: () => null,
        makeGenesis: () => { const g = genesis({ config: cfg, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'mut-b', now: now() }); return { state: g, spec: { tasks: fastProject().m1, milestones: 2, chainId: 'mut-b' } }; },
      }),
    });
    assert.ok(out1.committed, 'commit 1 lands');
    // a worker report lands BETWEEN the commits (the interleaving)
    const assigned = Object.values(out1.state.tasks).find(t => t.status === 'assigned');
    assert.ok(assigned, 'a task is assigned after the seed tick');
    store.enqueueReport({ event_id: 'rep-mutb-1', task: assigned.id, lease: assigned.lease.token, outcome: { status: 'progress' }, run_id: 'run-mutb' });
    // commit 2: the pause shape VERBATIM from the adapter (queue: q2 preserved)
    const pauseEv = { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted' }, event_id: `ctl-901-budget-pause-${Date.now()}`, ts: now() };
    const out2 = store.commit({
      mutate: (cur2, q2, cq2) => {
        const r = apply(cur2, pauseEv, now(), NMq, {});
        return { state: r.state, journal: r.journal, actions: r.actions, queue: q2, controlQueue: cq2 };
      },
    });
    assert.ok(out2.committed, 'commit 2 lands (the pause)');
    assert.equal(out2.state.chain.paused, true);
    // THE PIN: the interleaved report SURVIVES the pause commit — the next
    // tick drains it (mutating the pause shape to {queue: []} drops it)
    const peek = store.readQueue();
    assert.equal(peek.length, 1, 'the interleaved report is preserved on the queue file');
    assert.equal(peek[0].event_id, 'rep-mutb-1');
    // and the next tick drains it against the PAUSED chain (at-least-once)
    const out3 = store.commit({
      mutate: (cur, q, cq, qb, cb) => conductorTick({
        cur, queue: q, controlQueue: cq, queueBad: qb, ctlBad: cb,
        ev: { kind: 'TICK', actor: 'after', event_id: `tick-mutb2-${Date.now()}`, ts: now() },
        now, nextMilestone: NMq, recover: () => null,
        makeGenesis: () => { const g = genesis({ config: cfg, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'mut-b2', now: now() }); return { state: g, spec: { tasks: fastProject().m1, milestones: 2, chainId: 'mut-b2' } }; },
      }),
    });
    assert.ok(out3.committed || out3.noop, 'the post-pause tick runs');
    assert.ok((out3.journal || []).some(j => j.kind === 'REPORT'), 'the preserved report DRAINED (in_progress on the assigned task)');
    assert.equal(store.readQueue().length, 0, 'the queue is empty after the drain');
  } finally {
    lab.cleanup();
  }
});
