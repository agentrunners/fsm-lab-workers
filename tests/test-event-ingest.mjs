// test-event-ingest.mjs — T45/F-E + F-G(b) + F-G(c): the wake-event router
// and the report-id minter (lib/event-ingest.mjs). buildEvent's routing
// contract is also exercised end-to-end by sim2's payload-shape scenario
// (frozen live fixtures); these tests pin the T45 changes: attempt-scoped
// report ids, clock-injected id minting (the probe6 regression), and the
// control actor/note fields.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvent, reportEventId } from '../lib/event-ingest.mjs';
import { genesis, apply } from '../lib/fsm.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const NM = nextMilestoneFactory(fastProject());
const T0 = Date.parse('2026-09-06T10:00:00.000Z');

// ---------------------------------------------------------------------------
// F-E — the report-id minter.

test('T45/F-E: reportEventId — attempt-scoped shape, unique across attempts, tolerant defaults', () => {
  assert.equal(reportEventId({ runId: 111, attempt: 1 }), 'rep-111-a1');
  assert.equal(reportEventId({ runId: 111, attempt: 2 }), 'rep-111-a2');
  assert.notEqual(reportEventId({ runId: 111, attempt: 1 }), reportEventId({ runId: 111, attempt: 2 }),
    'GITHUB_RUN_ID is stable across re-runs — only the attempt scopes the id');
  // defaults: local smoke lane + first-attempt GHA default (run_attempt=1)
  assert.equal(reportEventId({}), 'rep-local-a1');
  assert.equal(reportEventId({ runId: 'x', attempt: '' }), 'rep-x-a1');
  assert.equal(reportEventId({ runId: '', attempt: 3 }), 'rep-local-a3');
  // the pre-T45 shape remains a valid opaque string (no migration needed)
  assert.match(reportEventId({ runId: 111, attempt: 1 }), /^rep-[^\s]+-a\d+$/);
});

// ---------------------------------------------------------------------------
// F-G(b) — ids mint from the INJECTED clock (probe6 regression).

test('T45/F-G(b): same-real-ms wakes mint DISTINCT ids from the injected clock — the second wake APPLIES (probe6)', () => {
  // freeze wall-clock minting entirely: the OLD scheme (Date.now()) minted
  // identical ids for both wakes below.
  const realNow = Date.now;
  Date.now = () => T0;  // frozen — same real ms for the whole test
  try {
    // virtual clock advancing 1s per call (the injected now)
    let vt = T0;
    const vnow = () => new Date(vt).toISOString();
    const e1 = buildEvent({ action: 'fsm-tick', client_payload: { reason: 'watchdog-reprime' } }, { now: vnow });
    vt += 1000;
    const e2 = buildEvent({ action: 'fsm-tick', client_payload: { reason: 'watchdog-reprime' } }, { now: vnow });
    assert.notEqual(e1.event_id, e2.event_id, 'two same-real-ms wakes must NOT mint identical ids (the probe6 silent wake loss)');
    assert.match(e1.event_id, /^tick-watchdog-reprime-\d+$/);
    // the second wake APPLIES against a state that already saw the first
    // (the dedup window would have swallowed it under the old scheme)
    let s = genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'probe6', now: vnow() });
    const r1 = apply(s, e1, vnow(), NM);
    s = r1.state;
    assert.equal(r1.applied, true);
    const r2 = apply(s, e2, vnow(), NM);
    s = r2.state;
    assert.equal(r2.applied, true, 'the second legitimate wake applies — not consumed as duplicate');
    assert.equal(s.chain.seq, 2);
  } finally {
    Date.now = realNow;
  }
});

test('T45/F-G(b): direct control ids also mint from the injected clock', () => {
  let vt = T0;
  const vnow = () => new Date(vt).toISOString();
  const c1 = buildEvent({ action: 'fsm-control', client_payload: { command: 'pause' } }, { now: vnow });
  vt += 1000;
  const c2 = buildEvent({ action: 'fsm-control', client_payload: { command: 'pause' } }, { now: vnow });
  assert.notEqual(c1.event_id, c2.event_id);
  assert.match(c1.event_id, /^ctl-direct-pause-\d+$/);
});

// ---------------------------------------------------------------------------
// F-G(c) — control events carry the sender (actor) + note.

test('T45/F-G(c): direct CONTROL events carry actor (sender) + note through the router', () => {
  const ev = buildEvent({ action: 'fsm-control', client_payload: { command: 'pause', note: 'holding for maintenance' }, sender: { login: 'xfnwpho1' } }, { now: () => new Date(T0).toISOString() });
  assert.equal(ev.actor, 'xfnwpho1');
  assert.equal(ev.note, 'holding for maintenance');
  // no sender / no note -> nulls (audit fields, never undefined shape-shifting)
  const ev2 = buildEvent({ action: 'fsm-control', client_payload: { command: 'resume' } }, { now: () => new Date(T0).toISOString() });
  assert.equal(ev2.actor, null);
  assert.equal(ev2.note, null);
});

test('T45/F-G(c): the CONTROL journal record carries actor + note (and rebuild ignores them — F8-safe)', () => {
  let s = genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'fgc', now: new Date(T0).toISOString() });
  const r = apply(s, { kind: 'CONTROL', command: 'pause', actor: 'zikomolapoutl', note: 'night hold', event_id: 'ctl-1', ts: new Date(T0).toISOString() }, new Date(T0).toISOString(), NM);
  s = r.state;
  assert.equal(r.applied, true);
  assert.equal(s.chain.paused, true);
  const rec = r.journal.find(j => j.kind === 'CONTROL' && j.command === 'pause');
  assert.ok(rec, 'CONTROL journal record present');
  assert.equal(rec.actor, 'zikomolapoutl');
  assert.equal(rec.note, 'night hold');
  // no actor/note on the event -> nulls on the record (not undefined)
  const r2 = apply(s, { kind: 'CONTROL', command: 'resume', event_id: 'ctl-2', ts: new Date(T0 + 1000).toISOString() }, new Date(T0 + 1000).toISOString(), NM);
  const rec2 = r2.journal.find(j => j.kind === 'CONTROL' && j.command === 'resume');
  assert.equal(rec2.actor, null);
  assert.equal(rec2.note, null);
  // long notes are sliced to 200 chars (journal-record growth is bounded)
  const longNote = 'n'.repeat(500);
  const r3 = apply(r2.state, { kind: 'CONTROL', command: 'pause', actor: 'x', note: longNote, event_id: 'ctl-3', ts: new Date(T0 + 2000).toISOString() }, new Date(T0 + 2000).toISOString(), NM);
  const rec3 = r3.journal.find(j => j.kind === 'CONTROL' && j.command === 'pause');
  assert.equal(rec3.note.length, 200);
});
