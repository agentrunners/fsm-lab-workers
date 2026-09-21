// test-pinger-watch.mjs — the T46/W-C3 (X24) suite: the pinger-reason →
// journal-marker pin, the held-chain liveness marker (conductorTick), the
// chain-continuation no-self-dispatch pin, the rebuild audit-only parity,
// and the watch-the-watcher DUTY pins (scan predicates, the silence window
// — s21/A-1 recalibrated 45min → 300min against the MEASURED live cadence —
// the env override, and the ops-issue comment format).
//
// The duty itself is an EXECUTOR-side step (cc-gha-public-executor
// scheduler.yml, roster-driven); lib/pinger-watch.mjs is its canonical spec
// (the bash driver mirrors these predicates — foreign repo code never runs
// on a PAT-holding runner). These pins bite the REAL module + the REAL
// conductor-core path, per the W-C1-R rule (pin the seam, not a source
// string).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvent, mintEventId, PINGER_REASON } from '../lib/event-ingest.mjs';
import { genesis, apply, rebuild } from '../lib/fsm.mjs';
import { conductorTick, chainContinuationDecision } from '../lib/conductor-core.mjs';
import {
  isPingerJournalNote, newestPingerJournalNote, newestPingerRunNote,
  watchTheWatcherVerdict, pingerWatchComment, pingerStaleAfterMin,
  PINGER_NOTE_EVENT_ID_RE, PINGER_RUN_NAME_PREFIX, PINGER_STALE_AFTER_MIN,
} from '../lib/pinger-watch.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const T0 = Date.parse('2026-09-19T06:00:00.000Z');
const NM = nextMilestoneFactory(fastProject());
const CFG = { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };
const iso = (ms) => new Date(ms).toISOString();
function makeNow(startMs = T0) {
  let t = startMs;
  return { now: () => new Date((t += 1)).toISOString(), get ms() { return t; } };
}
function boot(config = {}) {
  return genesis({
    config: { ...CFG, ...config },
    project: { tasks: fastProject().m1, milestones: 2 },
    chainId: 'test-wc3', now: iso(T0),
  });
}
const makeGenesisFor = (mp = fastProject()) => {
  let n = 0;
  return ({ config } = {}) => {
    const chainId = `c-wc3-${++n}`;
    const g = genesis({
      config: config || { ...CFG }, project: { tasks: mp.m1, milestones: mp.milestones ?? 2 },
      chainId, now: iso(T0 + n),
    });
    return { state: g, spec: { tasks: mp.m1, milestones: mp.milestones ?? 2, chainId } };
  };
};
const noRecover = () => null;
// the pinger's LIVE dispatch shape: repository_dispatch fsm-tick carrying
// {reason:'pinger'} (the pinger repo's workflow POSTs exactly this)
const pingerDispatch = (ms = T0) => ({ action: 'fsm-tick', client_payload: { reason: PINGER_REASON } });
const tickEv = (reason = 'chain', evId) => ({ kind: 'TICK', actor: reason, event_id: evId ?? `tick-${reason}`, ts: iso(T0) });

// ---------------------------------------------------------------------------
// 1. The pinger-reason → journal-marker mint (the event-ingest half).
// ---------------------------------------------------------------------------

test('W-C3/X24: the pinger dispatch mints the tick-pinger-<ms> marker id (reason keys everything)', () => {
  // a CONSTANT injected clock: buildEvent calls now() twice (the mint + the
  // ts), so a frozen now pins the exact ms deterministically
  const ev = buildEvent(pingerDispatch(), { now: () => iso(T0) });
  assert.equal(ev.kind, 'TICK');
  assert.equal(ev.actor, PINGER_REASON, 'the reason rides the TICK actor — the field every scan keys on');
  assert.match(ev.event_id, /^tick-pinger-\d+$/, 'the minted id is the journal marker shape');
  assert.equal(ev.event_id, `tick-pinger-${T0}`, 'the ms is the injected clock — the MINT_TABLE TICK shape');
  // the constant is the single source both the marker mint and the duty scan key on
  assert.equal(PINGER_REASON, 'pinger');
  assert.equal(mintEventId('TICK', { reason: PINGER_REASON, clockMs: T0 }), `tick-pinger-${T0}`);
});

test('W-C3/X24: an ACTIVE chain journals the TICK record WITH the minted event_id (additive field)', () => {
  const clock = makeNow(T0 + 60_000);
  let s = boot();
  const ev = buildEvent(pingerDispatch(), { now: clock.now });
  const r = apply(s, ev, clock.now(), NM);
  s = r.state;
  assert.equal(r.applied, true);
  assert.equal(s.chain.primed_by, PINGER_REASON);
  const rec = r.journal.find(j => j.kind === 'TICK');
  assert.ok(rec, 'the applied tick record exists');
  assert.equal(rec.event_id, ev.event_id, 'the record carries the minted marker — tick-pinger-<ms> in the journal');
  assert.equal(rec.applied, true);
  assert.equal(rec.actor, PINGER_REASON);
  // every OTHER tick reason carries its own event_id too (uniform, additive)
  const clock2 = makeNow(T0 + 120_000);
  const r2 = apply(s, tickEv('chain', 'tick-chain-2'), clock2.now(), NM);
  assert.equal(r2.journal.find(j => j.kind === 'TICK').event_id, 'tick-chain-2');
  // absent event_id (legacy/synthetic wakes) -> explicit null, never undefined
  const clock3 = makeNow(T0 + 180_000);
  const r3 = apply(r2.state, { kind: 'TICK', ts: clock3.now() }, clock3.now(), NM);
  assert.equal(r3.journal.find(j => j.kind === 'TICK').event_id, null);
});

// ---------------------------------------------------------------------------
// 2. The HELD-chain liveness marker (conductorTick — the X24 journal half).
// ---------------------------------------------------------------------------

test('W-C3/X24: a pinger wake on a HALTED chain journals the audit-only liveness MARKER (state untouched)', () => {
  const clock = makeNow(T0 + 300_000);
  let h = boot();
  // halt the chain (a done/halted project is the pinger's PRIMARY domain —
  // the idle-between-epochs case where its ticks used to vanish silently)
  h = apply(h, { kind: 'CONTROL', command: 'halt', event_id: 'ctl-halt', ts: iso(T0) }, iso(T0), NM).state;
  const before = structuredClone(h);
  const ev = buildEvent(pingerDispatch(), { now: clock.now });
  const out = conductorTick({
    cur: structuredClone(h), queue: [], controlQueue: [], ev,
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis: makeGenesisFor(),
  });
  // NOT a noop: the marker is commit material (the journal is the durable record)
  assert.equal(out.noop, undefined, 'the marker forces the journal-only commit');
  assert.ok(Array.isArray(out.journal) && out.journal.length === 1, `exactly one record (got ${out.journal?.length})`);
  const m = out.journal[0];
  assert.equal(m.kind, 'TICK');
  assert.equal(m.actor, PINGER_REASON);
  assert.equal(m.applied, false, 'audit-only — the marker is NOT an applied event');
  assert.equal(m.event_id, ev.event_id, 'the record carries the minted tick-pinger-<ms> marker');
  assert.match(m.event_id, /^tick-pinger-\d+$/);
  assert.ok(typeof m.note === 'string' && m.note.startsWith('pinger-liveness'));
  assert.ok(/^e\d+$/.test(m.id), 'the id mints in the journal id space (id-reconciled, additive)');
  // state is UNCHANGED by the marker: no seq bump, no last_tick move, no version bump
  assert.equal(out.state.chain.seq, before.chain.seq);
  assert.equal(out.state.chain.last_tick, before.chain.last_tick);
  assert.equal(out.state.chain.halted, true);
  assert.equal(out.state.chain.primed_by, before.chain.primed_by, 'primed_by untouched — the marker is journal-side provenance only');
  assert.equal(out.state.version, before.version, 'version never bumps on TICK-class records');
  assert.equal(out.state.stats.rejected_events, before.stats.rejected_events, 'the marker is NOT a rejection');
});

test('W-C3/X24: the PAUSED variant journals the same marker (both hold states)', () => {
  const clock = makeNow(T0 + 300_000);
  let p = boot();
  p = apply(p, { kind: 'CONTROL', command: 'pause', event_id: 'ctl-pause', ts: iso(T0) }, iso(T0), NM).state;
  const ev = buildEvent(pingerDispatch(), { now: clock.now });
  const out = conductorTick({
    cur: structuredClone(p), queue: [], controlQueue: [], ev,
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis: makeGenesisFor(),
  });
  assert.equal(out.noop, undefined);
  assert.equal(out.journal.length, 1);
  assert.equal(out.journal[0].applied, false);
  assert.equal(out.journal[0].actor, PINGER_REASON);
  assert.equal(out.journal[0].event_id, ev.event_id);
  assert.equal(out.reason, 'held-paused');
});

test('W-C3/X24 contrast: NON-pinger held wakes still quiesce silently (the F2 contract is unchanged)', () => {
  const clock = makeNow(T0 + 300_000);
  let h = boot();
  h = apply(h, { kind: 'CONTROL', command: 'halt', event_id: 'ctl-halt', ts: iso(T0) }, iso(T0), NM).state;
  for (const reason of ['backstop', 'manual', 'watchdog-reprime', 'chain', 'console']) {
    const out = conductorTick({
      cur: structuredClone(h), queue: [], controlQueue: [], ev: tickEv(reason),
      now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis: makeGenesisFor(),
    });
    assert.equal(out.noop, true, `${reason} held wake stays a silent noop`);
    assert.equal(out.journal, undefined);
  }
});

test('W-C3/X24: a DUPLICATE pinger wake (dedup-consumed) mints no second marker', () => {
  const clock = makeNow(T0 + 300_000);
  let h = boot();
  h = apply(h, { kind: 'CONTROL', command: 'halt', event_id: 'ctl-halt', ts: iso(T0) }, iso(T0), NM).state;
  const ev = buildEvent(pingerDispatch(), { now: clock.now });
  const first = conductorTick({
    cur: structuredClone(h), queue: [], controlQueue: [], ev,
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis: makeGenesisFor(),
  });
  assert.equal(first.journal.length, 1);
  // the SAME dispatch re-delivered: the marker commit carried the dedup key
  // (applyEvent pushes it pre-hold-check, and the journal-only commit PERSISTS
  // state), so the wake is consumed as 'duplicate' — the REJECTED record is
  // the F11 consume-once audit, and NO SECOND MARKER mints (the first arrival
  // already journaled the liveness datum)
  const dup = conductorTick({
    cur: first.state, queue: [], controlQueue: [], ev,
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis: makeGenesisFor(),
  });
  assert.equal(dup.reason, 'duplicate');
  assert.equal(dup.journal.filter(j => j.actor === PINGER_REASON).length, 0, 'no second pinger marker');
  assert.ok(dup.journal.some(j => j.kind === 'REJECTED' && j.reason === 'duplicate'), 'the duplicate wake journals its consume-once REJECTED audit record');
  assert.equal(dup.state.chain.halted, true, 'still held');
  assert.equal(dup.state.chain.seq, first.state.chain.seq, 'no seq motion');
});

test('W-C3/X24: a held chain whose DRAIN journaled records still gets the marker (report drain + pinger wake)', () => {
  // reports are NOT pause-gated (at-least-once drain on held chains) — the
  // pinger marker must ride ALONGSIDE the drain records, not only on the
  // pure-noop path
  const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
  const nmOne = nextMilestoneFactory(ONE);
  let h = genesis({ config: CFG, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'wc3-one', now: iso(T0) });
  h = apply(h, tickEv('seed'), iso(T0), nmOne).state;   // X assigned
  const lease = h.tasks.X.lease.token;
  h = apply(h, { kind: 'CONTROL', command: 'halt', event_id: 'ctl-halt', ts: iso(T0 + 1000) }, iso(T0 + 1000), nmOne).state;
  const clock = makeNow(T0 + 300_000);
  const ev = buildEvent(pingerDispatch(), { now: clock.now });
  const out = conductorTick({
    cur: structuredClone(h),
    queue: [{ kind: 'REPORT', event_id: 'rep-x', task: 'X', lease, outcome: { status: 'progress' }, run_id: 'r1' }],
    controlQueue: [], ev,
    now: clock.now, nextMilestone: nmOne, recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.noop, undefined, 'the drain alone forces the commit');
  const marker = out.journal.find(j => j.kind === 'TICK' && j.actor === PINGER_REASON);
  assert.ok(marker, 'the pinger marker rides with the drain records');
  assert.equal(marker.applied, false);
  assert.equal(marker.event_id, ev.event_id);
  assert.ok(out.journal.some(j => j.kind === 'REPORT' && j.to === 'in_progress'), 'the drain record landed too');
});

// ---------------------------------------------------------------------------
// 3. The chain-continuation decision (the no-self-dispatch pin).
// ---------------------------------------------------------------------------

test('W-C3/X24: chainContinuationDecision — a marker-commit tick on a HELD chain does NOT self-dispatch', () => {
  // THE livelock guard: the marker path commits journal-only with NO
  // STOP/HOLD action (the chain was already held). The action-derived stop
  // alone would restart the self-tick loop at runner cadence — F2's class.
  let h = boot();
  h = apply(h, { kind: 'CONTROL', command: 'halt', event_id: 'ctl-halt', ts: iso(T0) }, iso(T0), NM).state;
  const d = chainContinuationDecision({ actions: [], state: h, pausedNow: false });
  assert.equal(d.stop, true, 'held state stops the continuation with zero actions');
  assert.equal(d.held, true);
  // paused variant
  let p = boot();
  p = apply(p, { kind: 'CONTROL', command: 'pause', event_id: 'ctl-pause', ts: iso(T0) }, iso(T0), NM).state;
  assert.equal(chainContinuationDecision({ actions: [], state: p }).stop, true);
  // truth-preserving for every pre-W-C3 path:
  //   the halting tick's own STOP_CHAIN action still stops (state held too)
  assert.equal(chainContinuationDecision({ actions: [{ type: 'STOP_CHAIN' }], state: { chain: { halted: false, paused: false } } }).stop, true);
  //   a mid-epoch tick with no hold state and no stop actions CONTINUES (today's behavior)
  assert.equal(chainContinuationDecision({ actions: [{ type: 'DISPATCH_WORKER', task: 'T-1' }], state: { chain: { halted: false, paused: false } } }).stop, false);
  //   the budget pause still stops (pausedNow, unchanged)
  assert.equal(chainContinuationDecision({ actions: [], state: { chain: { halted: false, paused: false } }, pausedNow: true }).stop, true);
  //   HOLD_CHAIN unchanged
  assert.equal(chainContinuationDecision({ actions: [{ type: 'HOLD_CHAIN' }], state: { chain: { halted: false, paused: false } } }).stop, true);
});

// ---------------------------------------------------------------------------
// 4. rebuild parity — the marker is audit-only (F8 additive).
// ---------------------------------------------------------------------------

test('W-C3/X24: rebuild — the marker skips replay, does NOT count as rejected_events, moves no chain field', () => {
  const g = boot();
  const clock = makeNow(T0 + 60_000);
  // live-side shape: one applied chain tick, one pinger MARKER on the held
  // chain, one REJECTED record — the journal corpus the duty scans
  const recs = [
    { id: 'e1', ts: iso(T0), applied: true, kind: 'TICK', seq: 1, actor: 'chain', event_id: 'tick-chain-1' },
    { id: 'e2', ts: iso(T0 + 1000), applied: false, kind: 'TICK', actor: PINGER_REASON, event_id: 'tick-pinger-1000', note: 'pinger-liveness (held chain — audit-only marker, no state change, no self-dispatch)' },
    { id: 'e3', ts: iso(T0 + 2000), applied: false, kind: 'REJECTED', origKind: 'REPORT', reason: 'duplicate', event_id: 'rep-dup' },
  ];
  const s = rebuild(structuredClone(g), recs, { nextMilestone: NM });
  // the applied tick replays; the marker does not move last_tick/primed_by/seq
  assert.equal(s.chain.seq, 1, 'the marker carries no seq — the applied tick owns it');
  assert.equal(s.chain.last_tick, iso(T0), 'last_tick is the APPLIED tick\'s ts, not the marker\'s');
  assert.equal(s.chain.primed_by, 'chain', 'primed_by is the applied tick\'s actor');
  // the parity discipline: rejected_events counts REJECTED records ONLY
  assert.equal(s.stats.rejected_events, 1, 'one REJECTED counted; the marker is not a rejection');
  // journal_seq reconciles ABOVE every record id (audit-only included — the id space is shared)
  assert.ok(s.journal_seq >= 4, `journal_seq reconciled past e3 (got ${s.journal_seq})`);
});

test('W-C3/X24: rebuild — the pre-W-C3 applied:false corpus (all REJECTED) counts identically (the narrowing is byte-identical)', () => {
  const g = boot();
  const recs = [
    { id: 'e1', ts: iso(T0), applied: true, kind: 'TICK', seq: 1, actor: 'chain' },
    { id: 'e2', ts: iso(T0 + 1000), applied: false, kind: 'REJECTED', origKind: 'REPORT', reason: 'stale-lease', event_id: 'r1' },
    { id: 'e3', ts: iso(T0 + 2000), applied: false, kind: 'REJECTED', origKind: 'CONTROL', reason: 'bad-command', event_id: 'c1' },
    { id: 'e4', ts: iso(T0 + 3000), applied: false, kind: 'REJECTED', origKind: 'INTAKE', reason: 'unparseable', raw: 'x' },
  ];
  const s = rebuild(structuredClone(g), recs, { nextMilestone: NM });
  assert.equal(s.stats.rejected_events, 3, 'every REJECTED still counts');
  assert.equal(s.stats.orphaned_reports, 1, 'the stale-lease reject still counts its orphan');
});

// ---------------------------------------------------------------------------
// 5. The DUTY pins — scan predicates (fixtures), the silence window, the env
//    override, the comment format. lib/pinger-watch.mjs is the canonical spec
//    the executor's bash driver mirrors.
// ---------------------------------------------------------------------------

const JOURNAL_FIXTURE = [
  { id: 'e2541', ts: '2026-09-19T06:43:34.591Z', applied: true, kind: 'TICK', seq: 107, actor: 'chain', event_id: 'tick-chain-1789778614151' },
  { id: 'e2542', ts: '2026-09-19T06:44:14.111Z', applied: true, kind: 'REPORT', task: 'T-301', to: 'done', run_id: '35427339036' },
  { id: 'e2543', ts: '2026-09-19T05:30:36.100Z', applied: false, kind: 'TICK', actor: 'pinger', event_id: 'tick-pinger-1789775436100', note: 'pinger-liveness (held chain — audit-only marker, no state change, no self-dispatch)' },
  { id: 'e2544', ts: '2026-09-19T06:44:14.172Z', applied: true, kind: 'TICK', seq: 108, actor: 'chain', event_id: 'tick-chain-1789778654172' },
  { id: 'e2545', ts: '2026-09-19T06:45:57.167Z', applied: true, kind: 'PHASE', to: 'done', degraded: true },
  { id: 'e2546', ts: '2026-09-19T04:12:00.000Z', applied: true, kind: 'TICK', seq: 96, actor: 'pinger', event_id: 'tick-pinger-1789771920000' },
  { id: 'e2547', ts: '2026-09-19T06:40:00.000Z', applied: false, kind: 'REJECTED', origKind: 'REPORT', reason: 'duplicate' },
];

test('W-C3/X24 duty: the journal scan predicate — newest pinger note out of the noise, both record shapes', () => {
  // both arms of the predicate: the audit-only marker (actor arm) AND the
  // active-chain applied tick (actor arm + event_id arm)
  assert.equal(isPingerJournalNote(JOURNAL_FIXTURE[2]), true, 'the held-chain audit-only marker matches');
  assert.equal(isPingerJournalNote(JOURNAL_FIXTURE[5]), true, 'the active-chain applied pinger tick matches');
  assert.equal(isPingerJournalNote(JOURNAL_FIXTURE[0]), false, 'a chain tick does not match');
  assert.equal(isPingerJournalNote(JOURNAL_FIXTURE[1]), false, 'a REPORT does not match');
  assert.equal(isPingerJournalNote(JOURNAL_FIXTURE[6]), false, 'a REJECTED does not match');
  // the event_id arm alone matches (future actor-shape drift tolerance)
  assert.equal(isPingerJournalNote({ kind: 'TICK', actor: 'mystery', event_id: 'tick-pinger-42' }), true);
  assert.equal(isPingerJournalNote({ kind: 'TICK', actor: 'mystery', event_id: 'tick-chain-42' }), false);
  // legacy records never match
  assert.equal(isPingerJournalNote({ id: 'e1', ts: iso(T0), applied: true, kind: 'TICK', seq: 1, actor: 'chain' }), false);
  assert.equal(isPingerJournalNote(null), false);
  assert.equal(isPingerJournalNote('not-an-object'), false);
  // the newest of the two pinger notes wins regardless of position
  const n = newestPingerJournalNote(JOURNAL_FIXTURE);
  assert.equal(n.ts, '2026-09-19T05:30:36.100Z');
  assert.equal(n.source, 'journal');
  // a marker with an unparseable ts is skipped, not fatal
  const n2 = newestPingerJournalNote([{ kind: 'TICK', actor: 'pinger', ts: 'garbage' }, { kind: 'TICK', actor: 'pinger', ts: iso(T0), event_id: 'tick-pinger-1' }]);
  assert.equal(n2.ts, iso(T0));
  // empty / no-match corpora -> null (the "no notes" verdict input)
  assert.equal(newestPingerJournalNote([]), null);
  assert.equal(newestPingerJournalNote(JOURNAL_FIXTURE.filter(r => r.kind === 'REPORT')), null);
});

test('W-C3/X24 duty: the runs scan predicate — "pinger · conductor" prefix, newest wins', () => {
  const RUNS_FIXTURE = [
    { name: 'chain · conductor', createdAt: '2026-09-19T06:45:14Z' },
    { name: 'pinger · conductor', createdAt: '2026-09-19T06:30:36Z' },
    { name: 'console · conductor', createdAt: '2026-09-19T06:41:18Z' },
    { name: 'schedule-backstop · conductor', createdAt: '2026-09-19T05:59:13Z' },
    { name: 'pinger · conductor', createdAt: '2026-09-19T01:29:40Z' },
  ];
  const n = newestPingerRunNote(RUNS_FIXTURE);
  assert.equal(n.ts, '2026-09-19T06:30:36Z');
  assert.equal(n.source, 'runs');
  // startswith, not contains: a run named for a task/branch containing
  // 'pinger' elsewhere must never count
  assert.equal(newestPingerRunNote([{ name: 'task-pinger-check · conductor', createdAt: iso(T0) }]), null);
  assert.equal(newestPingerRunNote([{ name: 'pinger·conductor', createdAt: iso(T0) }]), null, 'the template separator (space-dot-space) is part of the prefix');
  assert.equal(newestPingerRunNote([]), null);
  assert.equal(newestPingerRunNote(null), null);
  assert.equal(PINGER_RUN_NAME_PREFIX, 'pinger ·');
});

test('s21/A-1: the silence window — the recalibrated 300min default, both sides of the boundary, both note sources', () => {
  const NOW = Date.parse('2026-09-19T07:00:36.000Z');
  const freshNote = { ts: '2026-09-19T06:30:36.000Z', source: 'journal' };      // 30min old
  const staleNote = { ts: '2026-09-19T01:50:36.000Z', source: 'journal' };      // 5h10m old
  const edgeNote = { ts: '2026-09-19T02:00:36.000Z', source: 'runs' };          // exactly 300min old
  // fresh: 30 < 300
  assert.equal(watchTheWatcherVerdict({ journalNote: freshNote, nowMs: NOW }).verdict, 'fresh');
  // stale: 5h10m >= 300
  const st = watchTheWatcherVerdict({ journalNote: staleNote, nowMs: NOW });
  assert.equal(st.verdict, 'stale');
  assert.equal(st.ageMin, 310);
  assert.equal(st.note.ts, staleNote.ts);
  assert.equal(st.note.source, 'journal');
  // the boundary: EXACTLY 300min is stale ("no note in 300min" — the sibling-duty convention)
  assert.equal(watchTheWatcherVerdict({ journalNote: edgeNote, nowMs: NOW }).verdict, 'stale', 'age == window → stale');
  // one minute inside is fresh
  assert.equal(watchTheWatcherVerdict({ journalNote: { ts: '2026-09-19T02:01:36.000Z', source: 'journal' }, nowMs: NOW }).verdict, 'fresh', 'age 299 < window → fresh');
  // the NEWEST of the two sources wins (the runs note is fresher here)
  const mixed = watchTheWatcherVerdict({ journalNote: staleNote, runNote: { ts: '2026-09-19T06:30:36.000Z', source: 'runs' }, nowMs: NOW });
  assert.equal(mixed.verdict, 'fresh');
  assert.equal(mixed.note.source, 'runs');
  assert.equal(mixed.note.ts, '2026-09-19T06:30:36.000Z');
  // EITHER source alone carries the verdict
  assert.equal(watchTheWatcherVerdict({ runNote: freshNote, nowMs: NOW }).verdict, 'fresh');
  assert.equal(watchTheWatcherVerdict({ journalNote: null, runNote: staleNote, nowMs: NOW }).verdict, 'stale');
  // NO notes at all → stale, reason no-pinger-notes ("no pinger-note in the window" is trivially true)
  const none = watchTheWatcherVerdict({ nowMs: NOW });
  assert.equal(none.verdict, 'stale');
  assert.equal(none.note, null);
  assert.equal(none.reason, 'no-pinger-notes');
  // the default window is the A-1 recalibration (300 — the measured live
  // cadence runs 2h00m–4h07m gaps; 45 fired on essentially every scan)
  assert.equal(PINGER_STALE_AFTER_MIN, 300);
  // window is configurable (the roster's stale_after_min) and guarded
  assert.equal(watchTheWatcherVerdict({ journalNote: staleNote, nowMs: NOW, staleAfterMin: 360 }).verdict, 'fresh', '310 < 360 with the roster override');
  assert.throws(() => watchTheWatcherVerdict({ nowMs: NaN }), /nowMs/);
  assert.throws(() => watchTheWatcherVerdict({ nowMs: NOW, staleAfterMin: 0 }), /staleAfterMin/);
  // a note in the FUTURE clamps age to 0 (clock skew — never a false stale)
  assert.equal(watchTheWatcherVerdict({ journalNote: { ts: '2026-09-19T08:00:00.000Z', source: 'journal' }, nowMs: NOW }).ageMin, 0);
});

test('s21/A-1: the LIVE-CADENCE boundary — the measured 2h00m–4h07m marker gaps never false-alarm at the 300min window', () => {
  // THE recalibration pin: the live journal-15 datum (markers e2556–e2561,
  // 09-20 09:50→13:57→17:21→19:38→21:50→23:51) gaps run 2h00m–4h07m. The
  // old 45min constant fired "pinger SILENT" on essentially EVERY duty scan
  // (~12 deduped noise comments/day forever — operators trained to ignore
  // the X-class signal). At 300min every MEASURED gap is comfortably fresh.
  const NOW = Date.parse('2026-09-20T23:51:00.000Z');   // the last live marker's ts
  for (const gapMin of [120, 137, 164, 182, 247]) {    // measured gaps + the 4h07 max
    const v = watchTheWatcherVerdict({ journalNote: { ts: new Date(NOW - gapMin * 60_000).toISOString(), source: 'journal' }, nowMs: NOW });
    assert.equal(v.verdict, 'fresh', `a ${gapMin}min gap (the measured regime) must read fresh at 300min`);
  }
  // the honest inverse: 5h07m of true silence still reads STALE — a dead
  // pinger is caught same-day (the window's whole point)
  assert.equal(watchTheWatcherVerdict({ journalNote: { ts: new Date(NOW - 307 * 60_000).toISOString(), source: 'journal' }, nowMs: NOW }).verdict, 'stale', '5h07m of silence alarms');
  // and the OLD constant's false-alarm shape, pinned dead: a 55min-old note
  // (fresh work, healthy pinger between markers) was STALE at 45, is FRESH now
  assert.equal(watchTheWatcherVerdict({ journalNote: { ts: new Date(NOW - 55 * 60_000).toISOString(), source: 'journal' }, nowMs: NOW }).verdict, 'fresh', '55min-old note: the 45min-era false alarm is dead');
});

test('s21/A-1: pingerStaleAfterMin(env) — the PINGER_STALE_AFTER_MIN override with the guarded fallback', () => {
  // unset / absent env -> the calibrated default
  assert.equal(pingerStaleAfterMin({}), 300);
  assert.equal(pingerStaleAfterMin(), 300);
  assert.equal(pingerStaleAfterMin({ PINGER_STALE_AFTER_MIN: undefined }), 300);
  // a valid override wins (the duty host's wiring knob — a tighter window for
  // a pinger whose cadence is actually fast, or a wider one mid-incident)
  assert.equal(pingerStaleAfterMin({ PINGER_STALE_AFTER_MIN: '90' }), 90);
  assert.equal(pingerStaleAfterMin({ PINGER_STALE_AFTER_MIN: '1440' }), 1440);
  assert.equal(pingerStaleAfterMin({ PINGER_STALE_AFTER_MIN: 60 }), 60, 'numeric env values parse too (process.env always strings; tolerate both)');
  // garbage / zero / negative NEVER mint a broken window — the fallback holds
  // (parseInt's prefix semantics mean '45min' DOES parse as 45 — accepted,
  // it is a sane window; the bad list is strictly unparseable/degenerate)
  for (const bad of ['garbage', '0', '-5', '', 'min45', 'NaN']) {
    assert.equal(pingerStaleAfterMin({ PINGER_STALE_AFTER_MIN: bad }), 300, `bad env ${JSON.stringify(bad)} falls back to the default`);
  }
  // the override threads into the verdict (the wiring the driver mirrors)
  const NOW = Date.parse('2026-09-19T07:00:36.000Z');
  const note = { ts: '2026-09-19T06:30:36.000Z', source: 'journal' };   // 30min old
  assert.equal(watchTheWatcherVerdict({ journalNote: note, nowMs: NOW, staleAfterMin: pingerStaleAfterMin({ PINGER_STALE_AFTER_MIN: '20' }) }).verdict, 'stale', 'a 20min override alarms on a 30min-old note');
  assert.equal(watchTheWatcherVerdict({ journalNote: note, nowMs: NOW, staleAfterMin: pingerStaleAfterMin({}) }).verdict, 'fresh', 'the default wiring stays fresh');
});

test('W-C3/X24 duty: the COMMENT FORMAT — the canonical ops-issue body (the executor mirrors this template)', () => {
  const c = pingerWatchComment({
    repo: 'claudecode-headless/fsm-lab', staleAfterMin: 300,
    note: { ts: '2026-09-19T01:50:36.000Z', source: 'journal' }, ageMin: 310,
  });
  // the dedup marker prefix (the duty's 24h comment-dedup scans for it)
  assert.ok(c.startsWith('**[pinger-watch]**'), 'the body starts with the dedup marker');
  // line 1: the verdict line with the newest-note interpolation
  const lines = c.split('\n');
  assert.equal(lines[0], '**[pinger-watch]** pinger SILENT — no pinger note on claudecode-headless/fsm-lab in 300min (newest: 2026-09-19T01:50:36.000Z (age 310min, source: journal)).');
  // two paragraphs, flat shape (the bash mirror stays byte-easy)
  assert.equal(lines[1], '');
  assert.equal(lines.length, 3);
  // the second paragraph carries the load-bearing semantics
  assert.ok(lines[2].includes('This duty reports the PINGER\'s health, not the chain\'s'), 'the not-the-chain\'s-health line');
  assert.ok(lines[2].includes('the chain may be alive-and-self-ticking'), 'visible, not fatal');
  assert.ok(lines[2].includes('xfnwfpho1/pinger'), 'the pinger repo pointer');
  assert.ok(lines[2].includes('cron */15'), 'the pinger cadence');
  assert.ok(lines[2].includes('24h-deduped marker'), 'the dedup contract');
  assert.ok(lines[2].includes('tick-pinger-<ms>'), 'the journal signal named');
  assert.ok(lines[2].includes('"pinger · conductor"'), 'the runs signal named');
  // the no-note variant (the DEFAULT window renders as 300 — the A-1 recalibration)
  const c2 = pingerWatchComment({ repo: 'claudecode-headless/fsm-lab' });
  assert.ok(c2.includes('newest: none found'), 'the none-found line');
  assert.ok(c2.includes('no tick-pinger journal markers'), 'both absent signals named');
  // defaults + guards
  assert.equal(pingerWatchComment({ repo: 'x', note: null }).split('\n')[0], '**[pinger-watch]** pinger SILENT — no pinger note on x in 300min (newest: none found (no tick-pinger journal markers, no "pinger · conductor" runs in the scan window)).');
  assert.throws(() => pingerWatchComment({}), /repo/);
});

test('W-C3/X24 duty: end-to-end fixture — journal + runs through the verdict and the comment (the driver\'s exact pipeline)', () => {
  // the live pre-deploy shape: the journal has NO pinger markers (the held
  // chain journals nothing today) but the RUNS lane has the pinger runs —
  // the duty must read the pinger's liveness from runs until the journal
  // half lands, then from both
  const NOW = Date.parse('2026-09-19T11:30:36.000Z');
  const jn = newestPingerJournalNote(JOURNAL_FIXTURE.filter(r => !isPingerJournalNote(r)));
  assert.equal(jn, null, 'pre-deploy: no journal markers');
  const rn = newestPingerRunNote([
    { name: 'chain · conductor', createdAt: '2026-09-19T06:45:14Z' },
    { name: 'pinger · conductor', createdAt: '2026-09-19T06:30:36Z' },
  ]);
  const v = watchTheWatcherVerdict({ journalNote: jn, runNote: rn, nowMs: NOW });
  // 06:30:36 → 11:30:36 is EXACTLY 300min: the boundary convention (age >= window → stale)
  assert.equal(v.ageMin, 300);
  assert.equal(v.verdict, 'stale');
  assert.equal(v.note.source, 'runs');
  const body = pingerWatchComment({ repo: 'claudecode-headless/fsm-lab', staleAfterMin: 300, note: v.note, ageMin: v.ageMin });
  assert.ok(body.startsWith('**[pinger-watch]**'));
  assert.ok(body.includes('source: runs'), 'the runs source is named — the pre-deploy signal');
});
