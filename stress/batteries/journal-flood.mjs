// stress/batteries/journal-flood.mjs — BATTERY 4: the journal under FLOOD
// (a6 §6.1 item 4). 10k events in one epoch (rotateAt=500) — the Store's
// rotation / tail-read / dedup-ring mechanics saturated, not sampled.
//
// Asserts (the a6 §6.1 item-4 contract):
//   * readJournalTail correct across >= 20 rotations (F5 numeric generation
//     ordering under pressure — the id sequence of the returned tail is the
//     globally-newest N, byte-verified against every record the battery
//     journaled; a sub-lane runs rotateAt=60/keepGens=12 so DOUBLE-DIGIT
//     gen numbers coexist on the branch and the lexicographic-misread class
//     is directly in play, not just implied);
//   * the dedup ring absorbs a 100-report redelivery storm — ZERO
//     double-applied while the ids are IN the ring (REJECTED 'duplicate')
//     AND after ring eviction (the task-status guard is the backstop —
//     REJECTED 'task-not-leased(done)'; the eviction sub-lane runs
//     dedup_window=16, the schema floor, so eviction is REAL, not
//     hypothetical: 3 ids evict DURING the first delivery itself);
//   * pinger-marker noise does not drown LANE_JOURNAL_WINDOW=64 — markers
//     at the nominal 15-min cadence (30d full / 7d quick) interleaved 9:1
//     over report traffic: readJournalTail(64, 'REPORT') still returns
//     EXACTLY the newest 64 REPORT records (the a3-A4 kind filter holds),
//     while the raw 64-tail is majority markers (the drowning shape real);
//   * the alert-dedup pagination shape WITH the s21/A-2 `since=` fix in the
//     tree (alertCommentsPath — per_page=100 + since): duplicate-alert count
//     pinned to the bounded one-extra residual (a >100-updated-in-24h
//     burst pages the marker out exactly once, then the fresh marker
//     re-arms); the OLD path's counterfactual count printed as the
//     before/after number (law-20: the no-since fetch returns the OLDEST
//     page — the live shape behind a3/A2's ~12/day).
//
// Metrics: retained journal bytes vs journal_seq (bounded by
// keepGens*rotateAt), state.json bytes, rotations, duplicate-alert counts
// (with-fix / old-path / burst residual / latched-body), redelivery reject
// classification.
//
// STRESS-FULL notes: full = ~10k events / 20+ rotations / 2880 markers
// (30d at the nominal 15-min cadence) / a 60-scan sustained-latch pagination
// timeline (5 virtual days at the 2h scan cadence). quick = ~2.9k events /
// 5+ rotations / 675 markers (7d) / 24 scans (2 virtual days). All virtual
// clock; the only real wall cost is the git plumbing (2 commits per flood
// cycle) + the pagination model's localhost HTTP (offline).
//
// Honesty notes (the compressed-cadence model, stated):
//   * the report queue is LOADED in batch pushes (the X3 burst's N writers
//     compressed into one plumbing commit per batch) — the LOADING is the
//     model; the DRAIN that consumes each batch is the real conductorTick;
//   * the marker VOLUME lane journals marker-shaped records through the real
//     Store.commit rotation path (the mint logic itself is proven live in
//     lane (i) via the REAL held-chain wake, and unit-pinned W-C3);
//   * the pagination lane rides the e2e ghapi stand-in (localhost —
//     offline) with its s22 `since`/`now` seams + the REAL
//     alertCommentsPath/alertDedup decision core. The OLD-path
//     counterfactual is modeled in-battery per law-20's letter (server
//     ignores sort/direction -> the DEFAULT page is the OLDEST per_page
//     comments) — the stand-in's no-since fetch keeps its newest-page
//     drill semantics, so both server readings are characterized.
//
// s22 FINDING (characterized in lane C, not fixed here): the adapter's
// LATCHED alert body '**[fsm-watchdog LATCHED]**' does NOT contain the
// '[fsm-watchdog]' substring alertDedup filters on — the latch alert class
// can NEVER recognize its own markers, so the 24h dedup (and A-2's since=
// with it) cannot bound it: ~12 duplicate comments/day for a sustained
// latch. Pinned as the characterization number (the a6 discipline — the
// number drives the fix, the battery does not silently repair).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const REPO_ROOT = join(dirname(import.meta.url.replace('file://', '')), '..', '..');
import { Store } from '../../lib/store.mjs';
import { genesis } from '../../lib/fsm.mjs';
import { conductorTick } from '../../lib/conductor-core.mjs';
import { buildEvent, PINGER_REASON } from '../../lib/event-ingest.mjs';
import { alertDedup, alertCommentsPath, DEDUP_WINDOW_MS } from '../../lib/watchdog-core.mjs';
import { LANE_JOURNAL_WINDOW } from '../../ops/console.mjs';
import { createGhapi } from '../../e2e/lib/ghapi.mjs';
import { mulberry32, makeClock, setupRepo, Recorder, T0, MIN, HOUR } from '../lib/common.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROTATE_AT = 500;
const KEEP_GENS = 4;
const TASKS = 32;              // genesis bounds max_parallel at 32 — the
                              // VOLUME comes from queue-line count, not the
                              // task count (100 junk lines/cycle over the
                              // 32 done tasks)
const STORM_LINES = 100;      // the redelivery storm: 100 lines in ONE batch

// ---------------------------------------------------------------------------
// helpers — the flood driver's plumbing
// ---------------------------------------------------------------------------

// N report lines in ONE plumbing push (the X3 burst's N writers compressed;
// the drain that follows is the real conductorTick). Mirrors enqueueReport's
// merge discipline: existing parsed lines re-serialized, bad lines VERBATIM.
function queuePush(store, records) {
  store.fetch();
  const head = store.headSha();
  const { items, bad } = store.readQueueEx();
  const dir = mkdtempSync(join(tmpdir(), 'flood-q-'));
  try {
    const merged = [...bad.map(String), ...items.map(l => JSON.stringify(l)), ...records.map(r => JSON.stringify(r))];
    writeFileSync(join(dir, 'queue.jsonl'), merged.join('\n') + '\n');
    const commit = store.buildCommit(
      [[join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']], [], head,
      `report-queue +${records.length} (flood batch)`);
    const push = store.git(['push', store.remote, `${commit}:${store.pushRef}`], { acceptCodes: [1, 128] });
    if (push.status !== 0) throw new Error(`flood queuePush: CAS push failed (rc=${push.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// one REAL conductor turn: the drain consumes the queue, the wake applies
// (or is held — post-halt floods journal the rejects and commit), rotation
// runs inside store.commit.
function tick(store, clock, ev) {
  const now = () => { clock.advance(1); return clock.now(); };
  return store.commit({
    mutate: (cur, queue, cq, qb, cb, iq, ib) => conductorTick({
      cur, queue, controlQueue: cq, queueBad: qb, ctlBad: cb, intakeQueue: iq, intakeBad: ib,
      ev, now, nextMilestone: () => null, recover: () => null,
      makeGenesis: () => { throw new Error('flood: no genesis expected'); },
    }),
  });
}

const tickEv = (clock, reason = 'flood-drain') => {
  clock.advance(1);
  return buildEvent({ action: 'fsm-tick', client_payload: { reason } }, { now: () => clock.now() });
};

// journal a batch of PRE-BUILT records through the real Store.commit
// rotation path (the compressed-cadence volume lane). Ids mirror mkJ —
// journal_seq is the id space; the mutate bumps it exactly like
// journalDeadmanMarker's does.
function journalBatch(store, clock, records) {
  const now = () => { clock.advance(1); return clock.now(); };
  return store.commit({
    mutate: (cur) => {
      const seqBase = Number.isInteger(cur.journal_seq) ? cur.journal_seq : 0;
      let seq = seqBase;
      const stamped = records.map(r => ({ id: `e${seq++}`, ts: now(), applied: r.applied ?? true, ...r }));
      const state = structuredClone(cur);
      state.journal_seq = seq;
      return { state, journal: stamped };
    },
  });
}

// the pinger marker record EXACTLY as the real held-chain mint shapes it
// (kind TICK, actor pinger, event_id tick-pinger-<ms>, applied:false).
function markerRecord(clockMs) {
  return {
    applied: false, kind: 'TICK', actor: PINGER_REASON,
    event_id: `tick-pinger-${clockMs}`,
    note: 'pinger-liveness (held chain — audit-only marker, no state change, no self-dispatch)',
  };
}

// retained journal bytes + gen census on the branch (the bounded-growth curve).
function journalCensus(store) {
  const files = store.listStateFiles()
    .map(f => f.match(/^state\/journal-(\d+)\.jsonl$/))
    .filter(Boolean)
    .map(m => ({ gen: parseInt(m[1], 10), path: `state/journal-${m[1]}.jsonl` }))
    .sort((a, b) => a.gen - b.gen);
  let bytes = 0;
  const perGen = [];
  for (const f of files) {
    const r = store.git(['cat-file', '-s', `${store.remoteRef}:${f.path}`], { acceptCodes: [128] });
    const b = r.status === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0;
    bytes += b;
    perGen.push({ gen: f.gen, bytes: b });
  }
  return { gens: files.map(f => f.gen), bytes, perGen };
}

// ---------------------------------------------------------------------------
// LANE 1 — the flood epoch: rotation pressure + the redelivery storm
// ---------------------------------------------------------------------------
function floodEpoch(rec, seed, { cycles, minRotations }) {
  const lab = setupRepo('fsm-flood-');
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone, rotateAt: ROTATE_AT, keepGens: KEEP_GENS });
    const rng = mulberry32(seed);
    const tasks = Array.from({ length: TASKS }, (_, i) => ({
      id: `F-${String(i + 1).padStart(3, '0')}`, title: `flood ${i + 1}`,
      behavior: 'succeed', work_ms: 1_000 + Math.floor(rng() * 4_000), deps: [],
    }));
    const g = genesis({
      config: { max_parallel: TASKS, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
      project: { tasks, milestones: 1 }, chainId: `flood-${seed}`, now: clock.now(),
    });
    store.init(g);

    const allRecords = [];          // every record ever journaled, in order
    const collect = (out) => { if (out?.committed) allRecords.push(...(out.journal || [])); };

    // tick 1 — cold-start: 100 ASSIGNs in ONE commit (a 100-record batch)
    collect(tick(store, clock, tickEv(clock, 'cold-start')));
    const leaseBy = {};
    for (const a of allRecords.filter(j => j.kind === 'ASSIGN')) leaseBy[a.task] = a.lease;

    // the epoch's real reports: 100 done (one per task) — ONE drain, then
    // the chain HALTS; the flood continues on the held chain (the
    // between-epochs redelivery noise — the live shape after every epoch)
    const firstReports = tasks.map((t, i) => ({
      event_id: `rep-flood-${i + 1}-a1`, task: t.id, lease: leaseBy[t.id],
      outcome: { status: 'done', artifact: `artifact:${t.id}` }, run_id: `flood-${t.id}-1`,
    }));
    queuePush(store, firstReports);
    collect(tick(store, clock, tickEv(clock, 'drain-epoch')));
    const halted = store.readState().state?.chain?.halted === true;

    // the flood cycles: 100 junk report lines per cycle over the DONE tasks
    // (~100 REJECTED records per drain — the rotation pressure). Cycle 0 is
    // the 100-line IDENTICAL-redelivery storm (all in-ring: 'duplicate');
    // cycle 5 redelivers the 32 originals AFTER 4x100 junk ids evicted them
    // from the 300-key ring (the task-status guard is the only backstop).
    let c5 = { notLeased: 0, applied: 0, dup: 0 };
    for (let c = 0; c < cycles; c++) {
      const batch = (c === 0)
        ? Array.from({ length: STORM_LINES }, (_, k) => ({ ...firstReports[k % TASKS] }))     // the identical redelivery storm
        : (c === 5)
          ? firstReports.map(r => ({ ...r }))                                                  // post-eviction redelivery
          : Array.from({ length: STORM_LINES }, (_, k) => ({                                   // fresh junk ids
            event_id: `rep-junk-${c}-${k}-a1`, task: tasks[k % TASKS].id, lease: 'dead-lease',
            outcome: { status: 'done', artifact: 'artifact:junk' }, run_id: `junk-${c}-${k}`,
          }));
      queuePush(store, batch);
      const out = tick(store, clock, tickEv(clock, `flood-cycle-${c}`));
      collect(out);
      if (c === 0 || c === 5) {
        for (const j of out.journal || []) {
          if (j.kind === 'REPORT' && j.to === 'done') c5.applied += 1;
          if (j.kind === 'REJECTED' && j.reason === 'duplicate') c5.dup += 1;
          if (j.kind === 'REJECTED' && String(j.reason || '').startsWith('task-not-leased')) c5.notLeased += 1;
        }
      }
    }

    // ---- the assertions --------------------------------------------------
    const finalState = store.readState().state;
    const census = journalCensus(store);
    const rotations = Math.max(...census.gens) - 1;
    rec.check('flood: the epoch completed and HALTED (the flood then runs on the held chain — the between-epochs shape)',
      halted && finalState?.project?.phase === 'done', `phase=${finalState?.project?.phase} halted=${halted}`);

    rec.check(`flood: >= ${minRotations} rotations under pressure (rotateAt=${ROTATE_AT})`,
      rotations >= minRotations, `rotations=${rotations} gens=[${census.gens.join(',')}]`);

    rec.check('flood: retained generations pruned to keepGens (the bounded retained window)',
      census.gens.length <= KEEP_GENS, `retained=${census.gens.length} keepGens=${KEEP_GENS}`);

    // readJournalTail(64): EXACTLY the globally-newest 64 records, in order
    // (F5 numeric gen ordering under rotation pressure)
    const tailAll = store.readJournalTail(64);
    const expectAll = allRecords.slice(-64).map(r => r.id);
    rec.check('flood: readJournalTail(64) returns the globally-newest 64 records IN ORDER',
      tailAll.length === 64 && tailAll.every((r, i) => r.id === expectAll[i]),
      `tail=[${tailAll[0]?.id}..${tailAll[63]?.id}] expected=[${expectAll[0]}..${expectAll[63]}]`);

    // the kind filter under the dominant-kind noise: the newest 64 REJECTED
    // records (the REPORT-kind variant of this assert lives in the marker
    // lane below, where REPORT records are interleaved with markers)
    const tailRejected = store.readJournalTail(64, 'REJECTED');
    const expectRejected = allRecords.filter(r => r.kind === 'REJECTED').slice(-64).map(r => r.id);
    rec.check('flood: readJournalTail(64, REJECTED) — the kind filter holds when one kind dominates',
      tailRejected.length === 64 && tailRejected.every((r, i) => r.id === expectRejected[i]),
      `rejectedTail=[${tailRejected[0]?.id}..${tailRejected[63]?.id}] of ${allRecords.filter(r => r.kind === 'REJECTED').length} REJECTED records`);

    // the redelivery storm: ZERO double-applied (in-ring AND post-eviction)
    const appliedReports = allRecords.filter(j => j.kind === 'REPORT' && j.to === 'done').length;
    rec.check('flood: the 100-line redelivery storm — ZERO double-applied (exactly one REPORT-to-done per task)',
      appliedReports === TASKS && finalState?.stats?.done === TASKS,
      `applied=${appliedReports} done=${finalState?.stats?.done}`);
    rec.check('flood: in-ring redelivery absorbed as REJECTED(duplicate) — the ring side',
      c5.applied === 0 && c5.dup === STORM_LINES, `cycle0: applied=${c5.applied} duplicateRejects=${c5.dup}/${STORM_LINES}`);
    rec.check('flood: post-eviction redelivery absorbed by the task-status guard — the backstop side',
      c5.notLeased === TASKS && c5.applied === 0,
      `cycle5 (ring evicted by 4x100 junk ids over window 300): applied=${c5.applied} notLeased=${c5.notLeased}/${TASKS}`);

    // the bounded-growth curve: retained bytes bounded regardless of journal_seq
    const maxRetainedBytes = KEEP_GENS * ROTATE_AT * 400;   // ~400B/record generous ceiling
    rec.check('flood: retained journal bytes BOUNDED (the rotation curve flattens while journal_seq grows)',
      census.bytes <= maxRetainedBytes, `retainedBytes=${census.bytes} bound=${maxRetainedBytes} journal_seq=${finalState?.journal_seq}`);
    rec.metric('journal_seq_final', finalState?.journal_seq);
    rec.metric('journal_records_total', allRecords.length);
    rec.metric('rotations', rotations);
    rec.metric('retained_gens', census.gens.length);
    rec.metric('retained_bytes_final', census.bytes);
    rec.metric('retained_per_gen_bytes', census.perGen);
    rec.metric('state_json_bytes', JSON.stringify(finalState).length);
    rec.metric('redelivery_duplicate_rejects', c5.dup);
    rec.metric('redelivery_post_eviction_rejects', c5.notLeased);

    // ---- the F5 numeric-ordering sub-lane: rotateAt=60/keepGens=12 ------
    // ~15 rotations over ~900 records: gens 9, 10, 11+ sit on the branch
    // TOGETHER — the lexicographic journal-10-before-journal-9 misread class
    // is directly under test, not just implied by gen numbers >= 10.
    {
      const lab2 = setupRepo('flood-lex-');
      try {
        const store2 = new Store({ cwd: lab2.clone, rotateAt: 60, keepGens: 12 });
        const clock2 = makeClock();
        const tasks2 = Array.from({ length: 20 }, (_, i) => ({ id: `L-${i + 1}`, title: `lex ${i + 1}`, behavior: 'succeed', work_ms: 10, deps: [] }));
        const g2 = genesis({
          config: { max_parallel: 20, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
          project: { tasks: tasks2, milestones: 1 }, chainId: 'flood-lex', now: clock2.now(),
        });
        store2.init(g2);
        const recs2 = [];
        const collect2 = (out) => { if (out?.committed) recs2.push(...(out.journal || [])); };
        collect2(tick(store2, clock2, tickEv(clock2, 'cold-start')));
        const lease2 = {};
        for (const a of recs2.filter(j => j.kind === 'ASSIGN')) lease2[a.task] = a.lease;
        for (let c = 0; c < 15; c++) {
          const batch = Array.from({ length: 60 }, (_, k) => ({
            event_id: `rep-lex-${c}-${k}`, task: tasks2[k % 20].id, lease: lease2[tasks2[k % 20].id] || 'x',
            outcome: { status: 'done', artifact: 'a' }, run_id: `lex-${c}-${k}`,
          }));
          queuePush(store2, batch);
          collect2(tick(store2, clock2, tickEv(clock2, `lex-${c}`)));
        }
        const census2 = journalCensus(store2);
        const coexist = census2.gens.filter(gn => gn >= 10).length;
        const tail2 = store2.readJournalTail(64);
        const expect2 = recs2.slice(-64).map(r => r.id);
        rec.check('flood/lex: double-digit generations COEXIST on the branch (keepGens=12 — the F5 misread class is directly under test)',
          coexist >= 2 && Math.max(...census2.gens) >= 11, `gens=[${census2.gens.join(',')}]`);
        rec.check('flood/lex: readJournalTail(64) correct with journal-9..journal-12+ coexisting (numeric gen ordering)',
          tail2.length === 64 && tail2.every((r, i) => r.id === expect2[i]),
          `tail=[${tail2[0]?.id}..${tail2[63]?.id}]`);
        rec.metric('lex_gens_coexisting', census2.gens.length);
      } finally { lab2.cleanup(); }
    }
    return { allRecords };
  } finally {
    lab.cleanup();
  }
}

// ---------------------------------------------------------------------------
// LANE 2 — the evicted-ring sub-lane: dedup_window=16 (the schema floor)
// ---------------------------------------------------------------------------
function evictedRing(rec, seed) {
  const lab = setupRepo('flood-ring-');
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone });
    // 19 tasks, 18 report: T-19 stays in_progress so the chain stays LIVE —
    // the churn ticks must APPLY (a live tick pushes its own dedup key) or
    // the ring never advances on a held chain (nothing applies while held).
    const tasks = Array.from({ length: 19 }, (_, i) => ({ id: `R-${String(i + 1).padStart(2, '0')}`, title: `ring ${i + 1}`, behavior: 'succeed', work_ms: 10, deps: [] }));
    const g = genesis({
      config: { max_parallel: 19, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 16 },
      project: { tasks, milestones: 1 }, chainId: `ring-${seed}`, now: clock.now(),
    });
    store.init(g);
    const out1 = tick(store, clock, tickEv(clock, 'cold-start'));
    const leaseBy = {};
    for (const a of (out1.journal || []).filter(j => j.kind === 'ASSIGN')) leaseBy[a.task] = a.lease;
    const reports = tasks.slice(0, 18).map((t, i) => ({
      event_id: `rep-ring-${i}-a1`, task: t.id, lease: leaseBy[t.id],
      outcome: { status: 'done', artifact: `artifact:${t.id}` }, run_id: `ring-${t.id}-1`,
    }));

    // first delivery: 18 applied (the 16-key ring evicts the tick key + the
    // first 2 report ids DURING the storm itself — eviction is real)
    queuePush(store, reports);
    const d1 = tick(store, clock, tickEv(clock, 'drain-1'));
    const applied1 = (d1.journal || []).filter(j => j.kind === 'REPORT' && j.to === 'done').length;

    // immediate redelivery: ~16 in-ring duplicates + ~2 evicted (status guard)
    queuePush(store, reports.map(r => ({ ...r })));
    const d2 = tick(store, clock, tickEv(clock, 'drain-2'));
    const dup2 = (d2.journal || []).filter(j => j.kind === 'REJECTED' && j.reason === 'duplicate').length;
    const nl2 = (d2.journal || []).filter(j => j.kind === 'REJECTED' && String(j.reason || '').startsWith('task-not-leased')).length;
    const applied2 = (d2.journal || []).filter(j => j.kind === 'REPORT' && j.to === 'done').length;

    // churn: 20 applied ticks push 20 fresh keys -> every report id evicts
    for (let k = 0; k < 20; k++) tick(store, clock, tickEv(clock, `churn-${k}`));

    // post-churn redelivery: ALL ids evicted — the STATUS GUARD alone holds
    queuePush(store, reports.map(r => ({ ...r })));
    const d3 = tick(store, clock, tickEv(clock, 'drain-3'));
    const applied3 = (d3.journal || []).filter(j => j.kind === 'REPORT' && j.to === 'done').length;
    const nl3 = (d3.journal || []).filter(j => j.kind === 'REJECTED' && String(j.reason || '').startsWith('task-not-leased')).length;
    const dup3 = (d3.journal || []).filter(j => j.kind === 'REJECTED' && j.reason === 'duplicate').length;

    const finalState = store.readState().state;
    rec.check('ring: dedup_window=16 — the storm evicts ids DURING delivery (eviction is real, not hypothetical)',
      applied1 === 18, `firstPassApplied=${applied1}/18`);
    rec.check('ring: immediate redelivery — ZERO double-applied (ring duplicates + status-guard rejects account for every line)',
      applied2 === 0 && dup2 + nl2 === 18, `applied=${applied2} duplicate=${dup2} notLeased=${nl2}`);
    rec.check('ring: post-churn redelivery (ALL 18 ids evicted) — the task-status guard ALONE holds exactly-once',
      applied3 === 0 && nl3 === 18 && dup3 === 0, `applied=${applied3} notLeased=${nl3}/18 duplicate=${dup3}`);
    rec.check('ring: every reported task done EXACTLY once across the storm',
      finalState?.stats?.done === 18, `done=${finalState?.stats?.done}`);
    rec.metric('ring_first_pass_applied', applied1);
    rec.metric('ring_redelivery_duplicates', dup2);
    rec.metric('ring_redelivery_status_guard_rejects', nl2 + nl3);
  } finally {
    lab.cleanup();
  }
}

// ---------------------------------------------------------------------------
// LANE 3 — pinger-marker noise vs LANE_JOURNAL_WINDOW=64 (the kind filter)
// ---------------------------------------------------------------------------
function markerNoise(rec, seed, { markerCount, reportCount }) {
  const lab = setupRepo('flood-marker-');
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone, rotateAt: ROTATE_AT, keepGens: KEEP_GENS });
    const tasks = [{ id: 'M-1', title: 'marker epoch', behavior: 'succeed', work_ms: 10, deps: [] }];
    const g = genesis({
      config: { max_parallel: 1, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
      project: { tasks, milestones: 1 }, chainId: `marker-${seed}`, now: clock.now(),
    });
    store.init(g);
    const allRecords = [];
    const collect = (out) => { if (out?.committed) allRecords.push(...(out.journal || [])); };
    collect(tick(store, clock, tickEv(clock, 'cold-start')));
    const lease = (allRecords.find(j => j.kind === 'ASSIGN'))?.lease;
    queuePush(store, [{ event_id: 'rep-marker-1-a1', task: 'M-1', lease, outcome: { status: 'done', artifact: 'a:m' }, run_id: 'marker-1' }]);
    collect(tick(store, clock, tickEv(clock, 'drain')));       // the chain halts here

    // (i) the REAL held-chain mint path: 6 pinger wakes -> 6 audit-only
    // markers, each its own journal-only commit (the W-C3 shape proven live)
    const realMarkers = [];
    for (let i = 0; i < 6; i++) {
      clock.advance(15 * MIN);
      const ev = buildEvent({ action: 'fsm-tick', client_payload: { reason: PINGER_REASON } }, { now: () => clock.now() });
      const out = tick(store, clock, ev);
      collect(out);
      const m = (out.journal || []).find(j => j.kind === 'TICK' && j.actor === PINGER_REASON);
      if (m) realMarkers.push(m);
    }
    rec.check('markers: the REAL held-chain pinger mint fires (audit-only TICK/pinger/tick-pinger-<ms> records)',
      realMarkers.length === 6 && realMarkers.every(m => m.applied === false && /^tick-pinger-\d+$/.test(m.event_id || '')),
      `minted=${realMarkers.length}/6`);

    // (ii) the VOLUME model: markers at the nominal 15-min cadence for the
    // full virtual span, interleaved 9:1 over REPORT-kind records, journaled
    // through the real Store.commit rotation path in mixed batches (the
    // compressed cadence — the mint itself is proven above and unit-pinned)
    let mLeft = markerCount, rLeft = reportCount;
    while (mLeft > 0 || rLeft > 0) {
      const batch = [];
      for (let i = 0; i < 45 && mLeft > 0; i++, mLeft--) {
        clock.advance(15 * MIN);
        batch.push(markerRecord(clock.ms));
      }
      for (let i = 0; i < 5 && rLeft > 0; i++, rLeft--) {
        batch.push({ kind: 'REPORT', task: 'M-1', lease: 'lex', to: 'done', run_id: `noise-${rLeft}` });
      }
      collect(journalBatch(store, clock, batch));
    }

    // the assertions: the raw tail DROWNS in markers; the REPORT-filtered
    // tail still sees exactly the newest 64 REPORTs
    const tailAll = store.readJournalTail(LANE_JOURNAL_WINDOW);
    const markersInTail = tailAll.filter(r => r.kind === 'TICK' && r.actor === PINGER_REASON).length;
    const tailReports = store.readJournalTail(LANE_JOURNAL_WINDOW, 'REPORT');
    const expectReports = allRecords.filter(r => r.kind === 'REPORT').slice(-LANE_JOURNAL_WINDOW).map(r => r.id);
    rec.check('markers: the raw 64-tail is dominated by pinger markers (the drowning shape is real)',
      markersInTail >= 50, `markersInTail=${markersInTail}/${LANE_JOURNAL_WINDOW}`);
    rec.check(`markers: readJournalTail(LANE_JOURNAL_WINDOW=64, 'REPORT') survives the noise — the a3-A4 kind filter holds`,
      tailReports.length === LANE_JOURNAL_WINDOW && tailReports.every((r, i) => r.id === expectReports[i]),
      `reportTail=${tailReports.length}/${LANE_JOURNAL_WINDOW} of ${allRecords.filter(r => r.kind === 'REPORT').length} REPORT records`);
    // and the pinger-watch duty's own reader finds the newest marker in the tail
    const newest = (() => {
      const tail = store.readJournalTail(200);
      let best = null;
      for (const r of tail) {
        if (r.kind === 'TICK' && r.actor === PINGER_REASON) {
          const ms = Date.parse(r.ts || '');
          if (Number.isFinite(ms) && (!best || ms > best.ms)) best = { ms, ts: r.ts };
        }
      }
      return best;
    })();
    rec.check('markers: the newest pinger marker is discoverable in the 200-tail (the duty scan reads it)',
      newest != null && Math.abs(clock.ms - newest.ms) <= 30 * MIN,
      `newest=${newest?.ts} vs clock=${clock.now()}`);
    rec.metric('marker_records_total', markerCount + 6);
    rec.metric('marker_noise_report_records', reportCount);
    rec.metric('markers_in_raw_tail', markersInTail);
  } finally {
    lab.cleanup();
  }
}

// ---------------------------------------------------------------------------
// LANE 4 — the alert-dedup pagination shape (the A-2 since= fix IN the tree)
// ---------------------------------------------------------------------------
async function alertPagination(rec, seed, { scans }) {
  const scratch = mkdtempSync(join(tmpdir(), 'flood-ghapi-'));
  try {
    const clock = makeClock();
    const api = createGhapi({ scratchDir: join(scratch, 'b'), now: () => clock.now() });
    const base = await api.listen();
    const REPO = 'local/fsm-lab';
    const botToken = 'drill-job-token';      // github-actions[bot] — type Bot, alertDedup-trusted

    const fetchComments = async (path) => {
      const r = await fetch(`${base}${path}`, { headers: { Authorization: `token ${botToken}` } });
      return r.status === 200 ? await r.json() : [];
    };

    // the corrupt-state alert body — the class that MATCHES alertDedup's
    // '[fsm-watchdog]' filter (the characterization target). The LATCHED
    // body (lane C below) does not match — a divergence the battery surfaces.
    const corruptBody = '**[fsm-watchdog]** state.json is UNREADABLE on fsm-state. The conductor self-heals via git-history recovery on its next tick.';
    // s23/latch update: the production body was FIXED (class-first) — the
    // battery now sources the CURRENT template from watchdog/scan.mjs and
    // asserts the fix (the old divergent shape stays as the BEFORE record).
    const OLD_LATCHED_BODY = '**[fsm-watchdog LATCHED]** 3 consecutive re-primes with NO chain progress (seq frozen) — re-priming is DISABLED until a tick lands.';
    const scanSrc = readFileSync(join(REPO_ROOT, 'watchdog', 'scan.mjs'), 'utf8');
    const latchedBody = (scanSrc.match(/const body = `([^`]*consecutive re-primes[^`]*)`/) || [])[1]
      ?? OLD_LATCHED_BODY;

    // TWO alert issues evolve on ONE interleaved virtual clock at the 2h
    // scan cadence (the live X-series cadence): the FIX issue is fetched via
    // the REAL alertCommentsPath (per_page=100 + since) against the
    // stand-in's since-aware endpoint; the OLD issue is fetched via the
    // law-20 counterfactual (the no-since server ignores sort/direction ->
    // the DEFAULT page is the OLDEST per_page=20 comments — the live shape
    // behind a3/A2's ~12/day). Each lane posts to its OWN issue, so both
    // timelines are self-consistent.
    const issueFix = api.openIssue(REPO, { title: 'WATCHDOG: chain dead (fix path)', body: 'alert body', labels: ['fsm-watchdog-alert'], token: botToken });
    const issueOld = api.openIssue(REPO, { title: 'WATCHDOG: chain dead (old path)', body: 'alert body', labels: ['fsm-watchdog-alert'], token: botToken });

    // the incident's day-0: 21 comments on EACH issue BEFORE any watchdog
    // marker (a public repo's +1 flood — trusted and stranger mixed; the
    // strangers are assoc NONE, never dedup-fresh: the w2f F-3 class)
    for (const iss of [issueFix, issueOld]) {
      for (let k = 0; k < 21; k++) {
        api.addComment(REPO, iss.number, {
          body: k % 2 === 0 ? '+1 seeing this too' : '+1 same here',
          token: k % 2 === 0 ? botToken : api.addStrangerToken(`str-${seed}-${iss.number}-${k}`),
        });
      }
    }

    let fixDups = 0, oldDups = 0, fixPosts = 0, oldPosts = 0;
    const SCAN_MS = 2 * HOUR;
    for (let i = 0; i < scans; i++) {
      clock.advanceTo(T0 + (i + 1) * SCAN_MS);
      const nowMs = clock.ms;

      // (a) the A-2 fix path: REAL path builder + since-aware fetch + the
      // REAL dedup decision core
      const fixComments = await fetchComments(alertCommentsPath(REPO, issueFix.number, nowMs));
      const dedupFix = alertDedup({ comments: fixComments, nowMs });
      if (!dedupFix.skip) {
        // duplicate accounting FIRST (the PRE-post comment set — the just-
        // posted marker must not count as the fresh marker it post-dates):
        // was a fresh (<24h) trusted marker present at scan time? (a >=24h
        // refresh is the intended 1/day cadence, not a duplicate)
        const all = api.comments(REPO, issueFix.number);
        const trusted = all.filter(c => (c.body || '').includes('[fsm-watchdog]')
          && (c.user?.type === 'Bot' || ['MEMBER', 'COLLABORATOR', 'OWNER'].includes(c.author_association)));
        const newest = trusted.reduce((a, c) => Date.parse(c.created_at || '') > Date.parse(a?.created_at || '') ? c : a, trusted[0]);
        const ageMs = nowMs - Date.parse(newest?.created_at || '');
        if (newest && Number.isFinite(ageMs) && ageMs < DEDUP_WINDOW_MS) fixDups += 1;
        api.addComment(REPO, issueFix.number, { body: corruptBody, token: botToken });
        fixPosts += 1;
      }

      // (b) the counterfactual OLD path: the OLDEST-20 page (law-20 letter)
      const oldAll = api.comments(REPO, issueOld.number);
      const oldPage = oldAll.slice(0, 20);
      const dedupOld = alertDedup({ comments: oldPage, nowMs });
      if (!dedupOld.skip) {
        api.addComment(REPO, issueOld.number, { body: corruptBody, token: botToken });
        oldPosts += 1;
        const trusted = oldAll.filter(c => (c.body || '').includes('[fsm-watchdog]')
          && (c.user?.type === 'Bot' || ['MEMBER', 'COLLABORATOR', 'OWNER'].includes(c.author_association)));
        const newest = trusted.reduce((a, c) => Date.parse(c.created_at || '') > Date.parse(a?.created_at || '') ? c : a, trusted[0]);
        const ageMs = nowMs - Date.parse(newest?.created_at || '');
        if (newest && Number.isFinite(ageMs) && ageMs < DEDUP_WINDOW_MS) oldDups += 1;
      }
    }

    rec.check('pagination: with the A-2 since= fix — ZERO duplicate alerts across the sustained latch (marker-matching body class)',
      fixDups === 0, `fixPathDuplicates=${fixDups} over ${scans} scans at the 2h cadence`);
    rec.check('pagination: the OLD path duplicates on essentially EVERY scan once the issue passes 20 comments (the ~12/day class)',
      oldDups >= scans - 2, `oldPathDuplicates=${oldDups}/${scans} scans`);
    rec.metric('duplicate_alerts_with_since_fix', fixDups);
    rec.metric('duplicate_alerts_old_path', oldDups);
    rec.metric('pagination_scan_count', scans);
    rec.metric('pagination_fix_issue_comments', api.comments(REPO, issueFix.number).length);
    rec.metric('pagination_old_issue_comments', api.comments(REPO, issueOld.number).length);

    // ---- the >100-updated-in-24h burst residual (the bounded one-extra) --
    {
      // 120 stranger comments land inside the dedup window, all AFTER the
      // newest marker: the newest-100 since-page drops the marker -> ONE
      // extra alert -> that fresh marker re-arms -> every later scan skips
      clock.advance(HOUR);
      for (let k = 0; k < 120; k++) {
        api.addComment(REPO, issueFix.number, { body: `+1 burst ${k}`, token: api.addStrangerToken(`burst-${seed}-${k}`) });
      }
      let burstDups = 0;
      for (let i = 0; i < 6; i++) {
        clock.advance(2 * HOUR);
        const nowMs = clock.ms;
        const fixComments = await fetchComments(alertCommentsPath(REPO, issueFix.number, nowMs));
        const dedupFix = alertDedup({ comments: fixComments, nowMs });
        if (!dedupFix.skip) {
          api.addComment(REPO, issueFix.number, { body: corruptBody, token: botToken });
          burstDups += 1;
        }
      }
      rec.check('pagination: the >100-in-24h burst residual is BOUNDED — one extra alert, then re-armed (the fail-noisy direction)',
        burstDups <= 1, `burstDuplicates=${burstDups} after a 120-comment in-window burst`);
      rec.metric('duplicate_alerts_burst_residual', burstDups);
    }

    // ---- lane C: the adapter's LATCHED body — DIVERGENCE, characterized ---
    // '[fsm-watchdog LATCHED]' does NOT contain '[fsm-watchdog]' (the
    // closing bracket comes after ' LATCHED'): alertDedup never recognizes
    // the latch class's own markers, so the skip CANNOT fire for it — even
    // WITH the A-2 since= fix, a sustained latch posts ~12/day. Pinned as
    // the characterization number (a6's discipline: the number drives the
    // fix; the battery does not silently repair).
    {
      const issueC = api.openIssue(REPO, { title: 'WATCHDOG: chain dead (latch class)', body: 'latched alert', labels: ['fsm-watchdog-alert'], token: botToken });
      api.addComment(REPO, issueC.number, { body: latchedBody, token: botToken });
      clock.advance(2 * HOUR);
      const nowMs = clock.ms;
      const recognized = api.comments(REPO, issueC.number).filter(c => (c.body || '').includes('[fsm-watchdog]'));
      const dedup = alertDedup({ comments: await fetchComments(alertCommentsPath(REPO, issueC.number, nowMs)), nowMs });
      // s23/latch: the fix landed (main 2bac884) — the PRODUCTION template
      // now carries the class token. Lane C runs the CURRENT body through
      // the REAL filter: recognized + skip=true (the 24h dedup bounds the
      // LATCH class). The OLD shape's divergence stays asserted below as
      // the BEFORE record (the characterization that drove the fix).
      const oldRecognized = api.comments(REPO, issueC.number).filter(c => (c.body || '').includes('[fsm-watchdog]') && c.body === OLD_LATCHED_BODY).length;
      rec.check('pagination: s23/latch FIX — the production LATCHED body (sourced from watchdog/scan.mjs) matches the dedup marker filter (the skip fires for the latch class)',
        recognized.length === 1 && dedup.skip === true && dedup.reason === 'trusted-marker-fresh',
        `recognizedMarkers=${recognized.length} skip=${dedup.skip} reason=${dedup.reason} (production template: ${latchedBody.slice(0, 40)}...)`);
      rec.check('pagination: BEFORE-record — the OLD LATCHED body shape never matched (the s22 divergence characterization, kept as the fixes evidence)',
        OLD_LATCHED_BODY.includes('[fsm-watchdog]') === false,
        'the old shape lacks the [fsm-watchdog] substring — alertDedup could never match it (the ~12/day sustained-latch class)');
      rec.metric('latched_body_marker_recognition', recognized.length);
      rec.note(`s23/latch: the LATCHED-body divergence is FIXED on main (2bac884) — the production template (sourced live from watchdog/scan.mjs) carries the class token and the skip fires; the OLD shape's non-match stays pinned as the BEFORE record. The A-2 since= fix now bounds BOTH alert classes.`);
    }
    await api.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// the battery
// ---------------------------------------------------------------------------
export async function run({ quick, seed } = {}) {
  const rec = new Recorder('journal-flood');
  const cycles = quick ? 27 : 105;             // ~100 records/cycle -> ~2.9k / ~10.5k events (s23: 98 undershot the >=20-rotation boundary at 19 — the per-cycle record count runs ~99, not 100)
  const minRotations = quick ? 5 : 20;
  const markerCount = quick ? 675 : 2880;      // 7d / 30d at the nominal 15-min cadence
  const scans = quick ? 24 : 60;               // 2 / 5 virtual days at the 2h scan cadence

  floodEpoch(rec, seed, { cycles, minRotations });
  evictedRing(rec, seed + 1);
  markerNoise(rec, seed + 2, { markerCount, reportCount: quick ? 70 : 290 });
  await alertPagination(rec, seed + 3, { scans });
  return rec;
}
