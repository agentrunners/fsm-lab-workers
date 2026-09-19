// test-console.mjs — T46/W-C2 lane C: the ops console's pins (node:test).
//
// NO LIVE API CALLS — the conformance pattern: the REST client and the git
// store are INJECTED seams (ops/console.mjs's runConsole takes them as
// parameters); the conductor drain drives the REAL lib/conductor-core.mjs
// (pure); the one store-level test runs against a REAL temp git repo (the
// test-store.mjs discipline — no mocks on the transport path).
//
// Coverage map (§3's contract):
//   parseConsoleCommand  the command matrix: every command word, case
//                        sensitivity, prose first lines are NON-commands,
//                        trailing prose on bare commands, reset flags
//                        (bare/from_queue/drop_queue/both/duplicate/
//                        garbage), configure (valid/empty/bad JSON/
//                        non-object/missing arg)
//   consoleQueueRecord   F-12 layer shapes: id console-<n>, node_id, sender,
//                        ts, note null, the patch riding the record
//   runConsole           the gate ORDER (scope → bot → parse → permission;
//                        the common non-command case makes ZERO API calls),
//                        the permission gate fail-closed (stranger/read/
//                        unverified → silent, nothing enqueued, no reply;
//                        write/admin → proceed), the command matrix end-to-
//                        end (enqueue + ONE reply + nudge), the reply shape,
//                        status (READ-ONLY: no store write method, ONE
//                        comment, no nudge), rejected args (one-line reply,
//                        no enqueue), exit codes (2 reply-POST failed, 3
//                        nudge failed, 1 enqueue failed)
//   F-12 round-trip      console record → conductorTick drain → the minted
//                        `ctl-<nodeId>-<cmd>-<ms>` lands in state.dedup;
//                        a re-delivered twin → a REJECTED journal record
//                        carrying the minted event_id; the queue id joins
//                        via the node id; node_id-less records keep c.id
//                        (the baseline pin — existing ids byte-identical)
//   F-12 reset lane      a console reset keeps the queue id through the
//                        drain (its own site upstream of the cev line); the
//                        F-1 twin-guard extends to console resets unchanged
//   store round-trip     the REAL CAS lane (temp git repo): the console
//                        record lands in state/control-queue.jsonl verbatim
//                        and reads back; the enqueue commit message carries
//                        the queue id (the audit trail)
//   F-13 source pin      the workflow YAML: GH_TOKEN wired from github.token
//                        ONLY, NO secrets.* anywhere, issue_comment[created]
//                        ONLY, OWN concurrency group, the permission set;
//                        m-8: OPS_ISSUE mapped from vars.OPS_ISSUE || '1'

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseConsoleCommand, consoleQueueRecord, statusSummary, runConsole,
  queuedReply, CONSOLE_COMMANDS,
} from '../ops/console.mjs';
import { conductorTick } from '../lib/conductor-core.mjs';
import { genesis, apply, invariants } from '../lib/fsm.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';
import { Store } from '../lib/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-09-06T10:00:00.000Z');
const NM = nextMilestoneFactory(fastProject());
const CFG = { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const OPS_USER = 'ops-writer';

const commentEvent = ({ issue = 1, nodeId = 'IC_node_123456', body = 'pause', author = OPS_USER, commentId = 4242 } = {}) => ({
  action: 'created',
  issue: { number: issue, node_id: 'I_kwDO1' },
  comment: { id: commentId, node_id: nodeId, body, user: { login: author } },
  repository: { full_name: 'claudecode-headless/fsm-lab' },
  sender: { login: author },
});

// the REST seam: a recording fake — every call is asserted by shape
function mkApi({ permission = 'write', permissionStatus = 200, commentStatus = 201, dispatchStatus = 204 } = {}) {
  const calls = [];
  const api = async (path, method = 'GET', body = null) => {
    calls.push({ path, method, body });
    if (path.includes('/collaborators/') && path.endsWith('/permission')) {
      return { status: permissionStatus, data: permissionStatus === 200 ? { permission } : null };
    }
    if (path.endsWith('/comments') && method === 'POST') {
      return { status: commentStatus, data: { id: 555 } };
    }
    if (path.endsWith('/dispatches') && method === 'POST') {
      return { status: dispatchStatus, data: null };
    }
    return { status: 404, data: null };
  };
  return { api, calls };
}

// the store seam: a recording fake — `writes` must stay EMPTY on the status lane
function mkStore({ state = null, control = [], intake = [], report = [], enqueueResult = { ok: true } } = {}) {
  const reads = [];
  const writes = [];
  const store = {
    fetch() { reads.push('fetch'); },
    readState() { reads.push('readState'); return { state, sha: 'sha' }; },
    readControlQueue() { reads.push('readControlQueue'); return control; },
    readIntakeQueue() { reads.push('readIntakeQueue'); return intake; },
    readQueue() { reads.push('readQueue'); return report; },
    enqueueControl(rec) { writes.push({ method: 'enqueueControl', rec }); return enqueueResult; },
  };
  return { store, reads, writes };
}

const ENV = { REPO: 'claudecode-headless/fsm-lab', OPS_ISSUE: '1' };
const NOW = () => iso(T0 + 60_000);

const run = (overrides = {}) => runConsole({ event: commentEvent(), env: ENV, now: NOW, ...overrides });

// ---------------------------------------------------------------------------
// parseConsoleCommand — the command matrix
// ---------------------------------------------------------------------------

test('parse: every command word parses; CONSOLE_COMMANDS matches the brief surface', () => {
  assert.deepEqual(CONSOLE_COMMANDS, ['pause', 'resume', 'halt', 'unhalt', 'reset', 'status', 'configure']);
  for (const cmd of ['pause', 'resume', 'halt', 'unhalt', 'reset', 'status']) {
    const p = parseConsoleCommand(cmd);
    assert.deepEqual(p, { command: cmd, patch: null }, cmd);
  }
  assert.deepEqual(parseConsoleCommand('configure {"max_parallel":8}'), { command: 'configure', patch: { max_parallel: 8 } });
});

test('parse: ONLY the first line matters — later lines never command', () => {
  assert.deepEqual(parseConsoleCommand('some prose\npause\nmore prose'), null);
  assert.deepEqual(parseConsoleCommand('pause'), { command: 'pause', patch: null });
  assert.deepEqual(parseConsoleCommand('  pause  \ntrailing'), { command: 'pause', patch: null });
});

test('parse: prose first lines are NON-commands (the anchored-word rule)', () => {
  // the brief's unanchored regex would fire on substrings — "paused for
  // maintenance" would enqueue a PAUSE; the anchored first-token parse is
  // the fail-closed reading
  for (const bad of ['paused for maintenance', 'unpause the chain', 'please pause', 'PAUSE', 'Pause', 'status?', 'resetting', '']) {
    assert.equal(parseConsoleCommand(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseConsoleCommand(null), null);
  // bare `configure` (the word WITHOUT an argument) is a command word with
  // missing args — a one-line REJECT, not a silent ignore (the operator
  // learns the syntax; covered in the rejected-args test below)
  assert.equal(parseConsoleCommand('configure').command, 'configure');
});

test('parse: bare commands tolerate trailing prose; status ignores args', () => {
  assert.deepEqual(parseConsoleCommand('pause until the quota resets'), { command: 'pause', patch: null });
  assert.deepEqual(parseConsoleCommand('unhalt the thing please'), { command: 'unhalt', patch: null });
  assert.deepEqual(parseConsoleCommand('status please'), { command: 'status', patch: null });
});

test('parse: reset flags — bare / from_queue / drop_queue / both / duplicate-collapse / garbage-reject', () => {
  assert.deepEqual(parseConsoleCommand('reset'), { command: 'reset', patch: null });
  assert.deepEqual(parseConsoleCommand('reset from_queue'), { command: 'reset', patch: { from_queue: true } });
  assert.deepEqual(parseConsoleCommand('reset drop_queue'), { command: 'reset', patch: { drop_queue: true } });
  assert.deepEqual(parseConsoleCommand('reset from_queue drop_queue'), { command: 'reset', patch: { from_queue: true, drop_queue: true } });
  assert.deepEqual(parseConsoleCommand('reset drop_queue from_queue'), { command: 'reset', patch: { drop_queue: true, from_queue: true } });
  // duplicates collapse harmlessly (same intent, not an error)
  assert.deepEqual(parseConsoleCommand('reset from_queue from_queue'), { command: 'reset', patch: { from_queue: true } });
  // garbage → a REJECT with a one-line error naming the valid flags
  const g = parseConsoleCommand('reset purge');
  assert.equal(g.command, 'reset');
  assert.match(g.error, /unknown reset flag\(s\) "purge"/);
  assert.match(g.error, /from_queue \| drop_queue/);
});

test('parse: configure — valid object, bad JSON names the parse error, non-object and empty rejected', () => {
  assert.deepEqual(parseConsoleCommand('configure {"lease_minutes":15}'), { command: 'configure', patch: { lease_minutes: 15 } });
  assert.deepEqual(parseConsoleCommand('configure {"tick_min_interval_s":60, "max_attempts":2}'), {
    command: 'configure', patch: { tick_min_interval_s: 60, max_attempts: 2 },
  });
  const bad = parseConsoleCommand('configure {"max_parallel":');
  assert.equal(bad.command, 'configure');
  assert.match(bad.error, /not valid JSON/);
  for (const body of ['configure [1,2]', 'configure "x"', 'configure 8', 'configure {}']) {
    const p = parseConsoleCommand(body);
    assert.equal(p.command, 'configure', body);
    assert.ok(p.error, `non-object/empty patch rejected: ${body}`);
    assert.equal(p.patch, undefined);
  }
  const missing = parseConsoleCommand('configure');
  assert.equal(missing.command, 'configure');
  assert.match(missing.error, /needs a JSON patch argument/);
});

// ---------------------------------------------------------------------------
// consoleQueueRecord — F-12's two layers on the record
// ---------------------------------------------------------------------------

test('record: F-12 two-layer shape — id console-<nodeId> + node_id; sender/actor; note null; patch rides', () => {
  const rec = consoleQueueRecord({ command: 'pause', author: OPS_USER, nodeId: 'IC_node_123456', nowIso: iso(T0) });
  assert.equal(rec.id, 'console-IC_node_123456');
  assert.equal(rec.node_id, 'IC_node_123456');
  assert.equal(rec.cmd, 'pause');
  assert.equal(rec.sender, OPS_USER);
  assert.equal(rec.note, null);
  assert.equal(rec.patch, null);
  assert.equal(rec.ts, iso(T0));
  // the ops/turn.mjs lane compatibility: every field the drain reads exists
  for (const k of ['cmd', 'patch', 'note', 'sender', 'ts', 'id']) assert.ok(k in rec, k);

  const reset = consoleQueueRecord({ command: 'reset', patch: { from_queue: true, drop_queue: true }, author: OPS_USER, nodeId: 'N2', nowIso: iso(T0) });
  assert.deepEqual(reset.patch, { from_queue: true, drop_queue: true });
  assert.equal(reset.id, 'console-N2');

  // node_id absent (a defensive shape — GitHub always sends it) → the
  // legacy identity: queue id only, no node_id → the drain keeps c.id
  const noid = consoleQueueRecord({ command: 'halt', author: OPS_USER, nodeId: null, nowIso: iso(T0) });
  assert.equal(noid.id, 'console-noid');
  assert.equal('node_id' in noid, false);
});

// ---------------------------------------------------------------------------
// runConsole — the gates, in order, with zero-API proofs
// ---------------------------------------------------------------------------

test('gate order: scoping BEFORE any API — a comment on issue #2 with OPS_ISSUE=1 is ignored with ZERO API calls', async () => {
  const { api, calls } = mkApi();
  const { store, writes } = mkStore();
  const r = await runConsole({ event: commentEvent({ issue: 2 }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'silent-scope');
  assert.equal(r.exitCode, 0);
  assert.equal(calls.length, 0, 'no API call may fire before the scope gate');
  assert.equal(writes.length, 0);
  // the number compare is string-typed on both sides (env vars are strings)
  const r2 = await runConsole({ event: commentEvent({ issue: '1' }), env: ENV, api, store, now: NOW });
  assert.notEqual(r2.outcome, 'silent-scope');
});

test('gate order: bots exit BEFORE any API call; a stranger comment never enqueues anything', async () => {
  const { api, calls } = mkApi();
  const { store, writes } = mkStore();
  const r = await runConsole({ event: commentEvent({ author: 'dependabot[bot]', body: 'pause' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'silent-bot');
  assert.equal(r.exitCode, 0);
  assert.equal(calls.length, 0, 'the bot pre-pass burns zero API calls');
  assert.equal(writes.length, 0);
  // null-author shape (a defensive event) also exits silently
  const r2 = await runConsole({ event: commentEvent({ author: null, body: 'pause' }), env: ENV, api, store, now: NOW });
  assert.equal(r2.outcome, 'silent-bot');
  assert.equal(calls.length, 0);
});

test('gate order: a non-command comment is zero work beyond the parse (no API, no store touch)', async () => {
  const { api, calls } = mkApi();
  const { store, reads, writes } = mkStore();
  const r = await runConsole({ event: commentEvent({ body: 'looks good to me' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'silent-noncommand');
  assert.equal(r.exitCode, 0);
  assert.equal(calls.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(writes.length, 0);
});

test('permission gate: fail-closed — stranger (non-200), read-class, and unverified all exit SILENTLY (no reply burned, nothing enqueued)', async () => {
  for (const { label, opts } of [
    { label: '404 stranger', opts: { permissionStatus: 404 } },
    { label: 'read-class', opts: { permission: 'read' } },
    { label: 'none-class', opts: { permission: 'none' } },
    { label: 'non-JSON body', opts: { permissionStatus: 500 } },
  ]) {
    const { api, calls } = mkApi(opts);
    const { store, writes } = mkStore();
    const r = await runConsole({ event: commentEvent({ body: 'pause' }), env: ENV, api, store, now: NOW });
    assert.equal(r.outcome, 'silent-permission', label);
    assert.equal(r.exitCode, 0, label);
    assert.equal(calls.length, 1, `${label}: exactly the ONE permission call fired`);
    assert.match(calls[0].path, /\/collaborators\/ops-writer\/permission$/, label);
    assert.equal(calls[0].method, 'GET', label);
    assert.equal(writes.length, 0, `${label}: nothing enqueued`);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0, `${label}: no reply POST — a stranger's comment burns no comment`);
  }
});

test('permission gate: write and admin both proceed', async () => {
  for (const permission of ['write', 'admin']) {
    const { api, calls } = mkApi({ permission });
    const { store, writes } = mkStore();
    const r = await runConsole({ event: commentEvent({ body: 'pause' }), env: ENV, api, store, now: NOW });
    assert.equal(r.outcome, 'queued', permission);
    assert.equal(writes.length, 1);
    assert.ok(calls.some(c => c.method === 'POST' && c.path.endsWith('/comments')), permission);
  }
});

// ---------------------------------------------------------------------------
// runConsole — the dispatch lanes
// ---------------------------------------------------------------------------

test('command matrix end-to-end: each command → ONE enqueueControl with the right record + ONE reply + ONE nudge', async () => {
  const cases = [
    { body: 'pause', cmd: 'pause', patch: null },
    { body: 'resume', cmd: 'resume', patch: null },
    { body: 'halt', cmd: 'halt', patch: null },
    { body: 'unhalt', cmd: 'unhalt', patch: null },
    { body: 'reset', cmd: 'reset', patch: null },
    { body: 'reset from_queue', cmd: 'reset', patch: { from_queue: true } },
    { body: 'reset drop_queue', cmd: 'reset', patch: { drop_queue: true } },
    { body: 'reset from_queue drop_queue', cmd: 'reset', patch: { from_queue: true, drop_queue: true } },
    { body: 'configure {"max_parallel":8}', cmd: 'configure', patch: { max_parallel: 8 } },
  ];
  for (const c of cases) {
    const { api, calls } = mkApi();
    const { store, writes } = mkStore();
    const r = await runConsole({ event: commentEvent({ body: c.body, nodeId: 'IC_x1' }), env: ENV, api, store, now: NOW });
    assert.equal(r.outcome, 'queued', c.body);
    assert.equal(r.exitCode, 0, c.body);
    // ONE enqueue, exact record shape (F-12: id + node_id + sender + ts)
    assert.equal(writes.length, 1, c.body);
    const rec = writes[0].rec;
    assert.equal(rec.cmd, c.cmd, c.body);
    assert.deepEqual(rec.patch, c.patch, c.body);
    assert.equal(rec.id, 'console-IC_x1', c.body);
    assert.equal(rec.node_id, 'IC_x1', c.body);
    assert.equal(rec.sender, OPS_USER, c.body);
    assert.equal(rec.note, null, c.body);
    assert.equal(rec.ts, NOW(), c.body);
    // ONE comment reply, the brief's exact shape
    const replies = calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(replies.length, 1, c.body);
    assert.equal(replies[0].body.body, `**[fsm-console]** command ${c.cmd} queued (console-IC_x1) — next tick applies.`, c.body);
    // ONE nudge: repository_dispatch fsm-tick, GITHUB_TOKEN lane
    const nudges = calls.filter(x => x.method === 'POST' && x.path.endsWith('/dispatches'));
    assert.equal(nudges.length, 1, c.body);
    assert.deepEqual(nudges[0].body, { event_type: 'fsm-tick', client_payload: { reason: 'console' } }, c.body);
    // the permission call fired exactly once (the gate before dispatch)
    assert.equal(calls.filter(x => x.path.endsWith('/permission')).length, 1, c.body);
  }
});

test("reply failure after a successful enqueue → exit 2 (law 5: the feedback loop's health is visible; the queue line holds)", async () => {
  const { api } = mkApi({ commentStatus: 500 });
  const { store, writes } = mkStore();
  const r = await runConsole({ event: commentEvent({ body: 'pause' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'queued-reply-failed');
  assert.equal(r.exitCode, 2);
  assert.equal(writes.length, 1, 'the command IS queued — only the ack was lost');
});

test('nudge failure after enqueue+reply → exit 3 (degraded, not lost)', async () => {
  const { api } = mkApi({ dispatchStatus: 422 });
  const { store, writes } = mkStore();
  const r = await runConsole({ event: commentEvent({ body: 'pause' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'queued-nudge-failed');
  assert.equal(r.exitCode, 3);
  assert.equal(writes.length, 1);
});

test('enqueue CAS failure → exit 1, no reply, no nudge (the command is LOST — the run goes red)', async () => {
  const { api, calls } = mkApi();
  const { store, writes } = mkStore({ enqueueResult: { ok: false, err: 'control CAS conflict (attempt 8)' } });
  const r = await runConsole({ event: commentEvent({ body: 'pause' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'enqueue-failed');
  assert.equal(r.exitCode, 1);
  assert.equal(writes.length, 1);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'no reply for a lost command');
});

test('rejected args (reset garbage / configure bad JSON) → ONE-line reply, NOTHING enqueued, no nudge', async () => {
  for (const body of ['reset purge', 'configure {"max_parallel":', 'configure', 'configure [1]']) {
    const { api, calls } = mkApi();
    const { store, writes } = mkStore();
    const r = await runConsole({ event: commentEvent({ body }), env: ENV, api, store, now: NOW });
    assert.equal(r.outcome, 'rejected', body);
    assert.equal(r.exitCode, 0, body);
    assert.equal(writes.length, 0, `${body}: nothing enqueued`);
    const replies = calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(replies.length, 1, body);
    assert.match(replies[0].body.body, /^\*\*\[fsm-console\]\*\* rejected: /, `${body}: the one-line reject`);
    assert.equal(replies[0].body.body.split('\n').length, 1, `${body}: ONE line`);
    assert.equal(calls.filter(x => x.path.endsWith('/dispatches')).length, 0, `${body}: no nudge`);
  }
});

// ---------------------------------------------------------------------------
// status — the read-only lane
// ---------------------------------------------------------------------------

const STATUS_STATE = (() => {
  const s = genesis({ config: CFG, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'c-status', now: iso(T0) });
  return apply(s, { kind: 'TICK', actor: 'chain', event_id: 'tick-seed', ts: iso(T0) }, iso(T0), NM).state;
})();

test('status: READ-ONLY — no store WRITE method fires, ONE comment, no nudge, no enqueue', async () => {
  const { api, calls } = mkApi();
  const { store, reads, writes } = mkStore({ state: STATUS_STATE, control: [{ cmd: 'x' }], intake: [{ issue: 9 }, { issue: 10 }], report: [] });
  const r = await runConsole({ event: commentEvent({ body: 'status' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'status');
  assert.equal(r.exitCode, 0);
  assert.equal(writes.length, 0, 'the status lane NEVER writes (enqueueControl is a write method)');
  assert.ok(reads.includes('fetch') && reads.includes('readState'), 'the watchdog read pattern: fetch + readState');
  assert.equal(reads.filter(x => x === 'readControlQueue').length, 1);
  assert.equal(reads.filter(x => x === 'readIntakeQueue').length, 1);
  assert.equal(reads.filter(x => x === 'readQueue').length, 1);
  const replies = calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.equal(replies.length, 1, 'ONE comment');
  assert.equal(calls.filter(x => x.path.endsWith('/dispatches')).length, 0, 'status never nudges');
});

test('status: the screen carries phase, milestone, counts, chain id + last-tick age, queue depths, holds, active ids', async () => {
  const { api, calls } = mkApi();
  const { store } = mkStore({ state: STATUS_STATE, control: [], intake: [{ issue: 9 }, { issue: 10 }], report: [] });
  await runConsole({ event: commentEvent({ body: 'status' }), env: ENV, api, store, now: NOW });
  const body = calls.find(x => x.method === 'POST' && x.path.endsWith('/comments')).body.body;
  assert.match(body, /\*\*\[fsm-console\]\*\* status — chain `c-status`/);
  assert.match(body, /last tick 60s ago/);
  assert.match(body, /- phase: executing · milestone 1\/2 · mode mock/);
  assert.match(body, /0\/\d+ done · 0 quarantined · 0 failed · 0 cancelled/);
  assert.match(body, /active \[/);
  assert.match(body, /- holds: paused=false · halted=false/);
  assert.match(body, /- queues: report 0 · control 0 · intake 2/);
});

test('status: unreadable state → an honest one-screen reply (never a silent red)', async () => {
  const { api, calls } = mkApi();
  const { store, writes } = mkStore({ state: null });
  const r = await runConsole({ event: commentEvent({ body: 'status' }), env: ENV, api, store, now: NOW });
  assert.equal(r.outcome, 'status');
  assert.equal(writes.length, 0);
  const body = calls.find(x => x.method === 'POST' && x.path.endsWith('/comments')).body.body;
  assert.match(body, /state\.json is UNREADABLE/);
});

test('statusSummary: pure — the paused/halted + active-ids projections from arbitrary state', () => {
  let s = structuredClone(STATUS_STATE);
  s = apply(s, { kind: 'CONTROL', command: 'pause', event_id: 'ctl-p1', ts: iso(T0 + 1000) }, iso(T0 + 1000), NM).state;
  const assigned = Object.values(s.tasks).filter(t => t.status === 'assigned').map(t => t.id);
  const out = statusSummary({ state: s, depths: { report: 3, control: 1, intake: 0 }, nowMs: T0 + 120_000 });
  assert.match(out, /paused=true · halted=false/);
  assert.match(out, /queues: report 3 · control 1 · intake 0/);
  assert.match(out, new RegExp(`active \\[${assigned.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  // T46/W-D lane B: the screen carries the LANE section — six lines now
  // (five + the lane telemetry line; legacy records render the no-telemetry line)
  assert.equal(out.split('\n').length, 6, 'one screen, six lines (the W-D lane section)');
  assert.match(out, /- lanes: /);
});

// ---------------------------------------------------------------------------
// F-12 — the two-layer mint round-trip through the REAL drain
// ---------------------------------------------------------------------------

function bootOne() {
  return genesis({ config: CFG, project: { tasks: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }], milestones: 1 }, chainId: 'c-f12', now: iso(T0) });
}
const ONE_NM = () => null;
const noRecover = () => null;
const tickEv = (reason = 'chain') => ({ kind: 'TICK', actor: reason, event_id: `tick-${reason}`, ts: iso(T0) });

test('F-12 round-trip: console record → drain mints ctl-<nodeId>-<cmd>-<clockMs> via MINT_TABLE; the minted id is the dedup identity', () => {
  const s = bootOne();
  const rec = consoleQueueRecord({ command: 'pause', author: OPS_USER, nodeId: 'IC_node_777', nowIso: iso(T0 + 60_000) });
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [rec],
    ev: tickEv('console-nudge'), now: () => iso(T0 + 61_000), nextMilestone: ONE_NM, recover: noRecover,
    makeGenesis: () => ({ state: bootOne(), spec: {} }),
  });
  // the pause applied
  assert.equal(out.state.chain.paused, true);
  // LAYER 2: the minted id — MINT_TABLE's exact shape, clockMs = Date.parse(rec.ts)
  const minted = `ctl-IC_node_777-pause-${T0 + 60_000}`;
  assert.ok(out.state.dedup.includes(minted), `dedup carries the minted id (got: ${JSON.stringify(out.state.dedup)})`);
  assert.equal(minted, `ctl-${rec.node_id}-${rec.cmd}-${Date.parse(rec.ts)}`);
  // the journal CONTROL record carries the actor (the comment author — audit)
  const ctrlRec = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'pause');
  assert.ok(ctrlRec, 'the applied CONTROL record lands');
  assert.equal(ctrlRec.actor, OPS_USER);
  // LAYER 1: the queue id stays ON THE RECORD (pre-drain) — the audit trail
  assert.equal(rec.id, 'console-IC_node_777');
});

test('F-12 round-trip: a re-delivered twin → a REJECTED journal record carrying the MINTED event_id (the durable journal answers the minted identity)', () => {
  let s = bootOne();
  const rec = consoleQueueRecord({ command: 'pause', author: OPS_USER, nodeId: 'IC_node_778', nowIso: iso(T0 + 60_000) });
  const first = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [structuredClone(rec)],
    ev: tickEv('n1'), now: () => iso(T0 + 61_000), nextMilestone: ONE_NM, recover: noRecover,
    makeGenesis: () => ({ state: bootOne(), spec: {} }),
  });
  s = first.state;
  const minted = `ctl-IC_node_778-pause-${T0 + 60_000}`;
  // the same queue line re-delivered (a CAS race / a replayed queue file)
  const second = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [structuredClone(rec)],
    ev: tickEv('n2'), now: () => iso(T0 + 62_000), nextMilestone: ONE_NM, recover: noRecover,
    makeGenesis: () => ({ state: bootOne(), spec: {} }),
  });
  const dup = second.journal.find(j => j.kind === 'REJECTED' && j.reason === 'duplicate' && j.origKind === 'CONTROL');
  assert.ok(dup, `the duplicate is journaled REJECTED (journal: ${JSON.stringify(second.journal.map(j => j.kind + ':' + (j.command || j.reason)))})`);
  assert.equal(dup.event_id, minted, 'the REJECTED record answers the MINTED id — the two layers join by the node id');
  // and the pause did not double-apply (idempotent consume)
  assert.equal(second.state.stats.rejected_events >= 1, true);
});

test('F-12 baseline pin: node_id-less records keep event_id = c.id — the mint NEVER fires for pre-console records', () => {
  const s = bootOne();
  const legacy = { cmd: 'pause', id: 'ctl-1789000000123-abc123', note: null, sender: 'ops', ts: iso(T0 + 60_000) };
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [legacy],
    ev: tickEv('legacy'), now: () => iso(T0 + 61_000), nextMilestone: ONE_NM, recover: noRecover,
    makeGenesis: () => ({ state: bootOne(), spec: {} }),
  });
  assert.equal(out.state.chain.paused, true);
  assert.ok(out.state.dedup.includes('ctl-1789000000123-abc123'), 'the legacy queue id IS the event id (byte-identical — no mint)');
  assert.ok(!out.state.dedup.some(k => k.startsWith('ctl-ctl-')), 'no double-prefix mint');
});

test('F-12 reset lane: a console reset keeps the QUEUE id through the drain (reset never reaches the cev site); F-1 twin-guard unchanged', () => {
  const s = bootOne();
  const rec = consoleQueueRecord({ command: 'reset', patch: { from_queue: false }, author: OPS_USER, nodeId: 'IC_node_9', nowIso: iso(T0 + 60_000) });
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [rec, structuredClone(rec)],
    ev: tickEv('r'), now: () => iso(T0 + 61_000), nextMilestone: ONE_NM, recover: noRecover,
    makeGenesis: () => ({ state: bootOne(), spec: {} }),
  });
  // the reset applied ONCE; the twin (same drain, same note=null, <30s) → REJECTED reset-duplicate
  const resets = out.journal.filter(j => j.kind === 'CONTROL' && j.command === 'reset');
  assert.equal(resets.length, 1, 'one reset applies');
  const twin = out.journal.find(j => j.kind === 'REJECTED' && j.reason === 'reset-duplicate');
  assert.ok(twin, 'the F-1 twin-guard extends to console resets');
  assert.equal(twin.event_id, rec.id, 'the twin REJECTED record answers the QUEUE id (the reset lane keeps layer 1)');
});

test('F-12 drain parity: the console command applies through the SAME conductorTick the live chain runs (invariants clean)', () => {
  const s = bootOne();
  const rec = consoleQueueRecord({ command: 'configure', patch: { max_parallel: 2 }, author: OPS_USER, nodeId: 'IC_cfg', nowIso: iso(T0 + 60_000) });
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [rec],
    ev: tickEv('cfg'), now: () => iso(T0 + 61_000), nextMilestone: ONE_NM, recover: noRecover,
    makeGenesis: () => ({ state: bootOne(), spec: {} }),
  });
  assert.equal(out.state.config.max_parallel, 2, 'the configure patch applied');
  const minted = `ctl-IC_cfg-configure-${T0 + 60_000}`;
  assert.ok(out.state.dedup.includes(minted));
  assert.deepEqual(invariants(out.state), [], 'invariants clean after the console drain');
});

// ---------------------------------------------------------------------------
// F-12 — the REAL store CAS lane (temp git repo; no mocks on the transport)
// ---------------------------------------------------------------------------

function mkLab() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-console-'));
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  const g = (args, cwd) => spawnSync('git', args, { cwd: cwd || clone, encoding: 'utf8' });
  g(['init', '--bare', '-b', 'main', origin], dir);
  const seed = join(dir, 'seed');
  g(['init', '-b', 'main', 'seed'], dir);
  g(['-C', seed, 'commit', '--allow-empty', '-m', 'seed'], dir);
  g(['-C', seed, 'push', origin, 'main'], dir);
  g(['clone', origin, 'clone'], dir);
  return { dir, clone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('store round-trip: the console record lands in ctl.jsonl VERBATIM via enqueueControl; the CAS commit message carries the queue id', () => {
  const lab = mkLab();
  try {
    const st = new Store({ cwd: lab.clone });
    const g0 = genesis({ config: CFG, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'store-c', now: iso(T0) });
    st.init(g0);
    st.fetch();
    const rec = consoleQueueRecord({ command: 'pause', author: OPS_USER, nodeId: 'IC_store_1', nowIso: iso(T0 + 5_000) });
    const r = st.enqueueControl(rec);
    assert.equal(r.ok, true, JSON.stringify(r));
    st.fetch();
    const q = st.readControlQueue();
    assert.equal(q.length, 1);
    assert.deepEqual(q[0], rec, 'the two-layer record survives the CAS lane byte-for-byte');
    // the audit trail: the enqueue commit message names the queue id
    const log = spawnSync('git', ['log', '--format=%s', `refs/remotes/origin/${st.branch}`], { cwd: lab.clone, encoding: 'utf8' });
    assert.ok(log.stdout.split('\n').some(m => m === `control-queue +1 pause ${rec.id}`), `commit message carries the queue id (log: ${log.stdout.trim().split('\n').join(' | ')})`);
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// F-13 + m-8 — the source-shape pins (grep-style, the established law-pin form)
// ---------------------------------------------------------------------------

const YML = readFileSync(join(ROOT, '.github/workflows/ops-console.yml'), 'utf8');
const CONSOLE_SRC = readFileSync(join(ROOT, 'ops/console.mjs'), 'utf8');

test('F-13 source pin: the workflow is GITHUB_TOKEN ONLY — no secrets wiring anywhere; GH_TOKEN wired from github.token', () => {
  assert.ok(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/.test(YML), 'GH_TOKEN comes from github.token (the job token) EXACTLY');
  // the WIRING shape is what leaks a PAT: ${{ secrets.<name> }} — the pin
  // greps that exact shape (the phrase "secrets.*" appears in the security
  // COMMENTS by convention — intake.yml does the same — and is not a wiring)
  assert.equal(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/.test(YML), false, 'NO ${{ secrets.* }} wiring may exist in ops-console.yml');
  // the console source reads only GH_TOKEN as its credential env
  assert.match(CONSOLE_SRC, /TOKEN:\s*process\.env\.GH_TOKEN/);
  const envReads = [...CONSOLE_SRC.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(envReads)].sort(), ['EVENT', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'OPS_ISSUE'],
    'console.mjs touches EXACTLY the four wired envs — no other credential surface');
});

test('F-13 source pin: issue_comment[created] ONLY, OWN concurrency group (no conductor-chain contention)', () => {
  // pin the ACTUAL on: block (comments may mention other triggers — the
  // X1a note explains repository_dispatch; only the block is a trigger)
  const onBlock = YML.match(/^on:\s*\n((?:[^\S\n].*\n)+)/m);
  assert.ok(onBlock, 'the workflow has an on: block');
  assert.match(onBlock[1], /issue_comment:\s*\n\s*types:\s*\[created\]/, 'issue_comment[created] is THE trigger');
  assert.equal(/(repository_dispatch|workflow_dispatch|schedule|issues|pull_request|push|release|watch|fork|discussion)/.test(onBlock[1]), false,
    'no other trigger key may exist in the on: block');
  assert.match(YML, /group:\s*fsm-ops-console\b/);
  assert.match(YML, /cancel-in-progress:\s*false/);
});

test('F-13 source pin (m-8): OPS_ISSUE maps from the LOAD-BEARING repo variable with the documented default', () => {
  assert.match(YML, /OPS_ISSUE:\s*\$\{\{\s*vars\.OPS_ISSUE\s*\|\|\s*'1'\s*\}\}/, 'the var, default 1');
  assert.match(YML, /LOAD-BEARING/, 'documented as load-bearing in the workflow');
});

test('F-13 source pin: the permission set — issues:write for replies + contents:write (the F-2a class: the queue CAS push + nudge dispatch need write)', () => {
  assert.match(YML, /issues:\s*write/);
  assert.match(YML, /contents:\s*write/);
  // the documented deviation note (the brief said contents:read — the YAML
  // carries the amendment rationale in-source, the F-2a precedent)
  assert.match(YML, /F-2a/);
});

test('F-13 source pin: the run command is ops/console.mjs and the reply/nudge lane is the job token (anti-recursion by construction)', () => {
  assert.match(YML, /run:\s*node ops\/console\.mjs/);
  // the reply + nudge ride the job token: the api seam + nudgeTick use
  // env.TOKEN, which main() wires from GH_TOKEN only (asserted above).
  // GITHUB_TOKEN-authored issue_comment events never fire workflows — the
  // platform law the console's own header states:
  assert.match(CONSOLE_SRC, /issue_comment events NEVER fire/);
  assert.match(CONSOLE_SRC, /anti-recursion BY CONSTRUCTION/);
});
