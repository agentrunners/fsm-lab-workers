// s22/B-0 (7/7): the OFFLINE PINS for the staged drill drivers.
//
// The six drivers are built with the pure-half/IO-half discipline (the
// ops/console.mjs shape): every decision core is a PURE function and the I/O
// lives behind seams. These tests import ONLY the pure halves — no API, no
// git, no timers beyond what the fixtures carry:
//
//   - e2e/staged/gate.mjs     gateDecision / cadenceAdmitsToday / gateConfigCheck
//   - e2e/staged/verify.mjs   runVerdict / readRedVerdict (the A1–A12 table)
//   - e2e/staged/teardown.mjs teardownDecision / markerComment / redPageTitle /
//                             redPageBody / recoveryShape / nonTerminalState
//   - e2e/staged/lib.mjs      epochSegment (the §3.1 scoping walk) / RED_LABEL
//   - e2e/staged/seed.mjs     renderDrillBody / weekdayBehavior (checked
//                             against the REAL door: lib/intake.mjs
//                             parseSpecBlock + validateSpec)
//
// The three fixture nights (all 2026-09-2x, a Monday 0921 / Tuesday 0922 /
// Wednesday 0923 triple):
//   - 0921 the full 4-task mix GREEN (A fast + B overflow + C infra + H hang)
//   - 0923 the stage-0 hang night (a DEGRADED halt is the EXPECTED verdict —
//     done 0/1, the R2 quality gate working, not broken)
//   - the RED/DEFERRED/no-epoch/read-RED classes on mutated copies.
//
// Fixtures model the REAL state/journal shapes (lib/store.mjs readState /
// readJournals): state.chain.{id,seq,halted,paused}, state.project.{issue,
// phase}, state.tasks.<id>.{id,status,attempts}, journal CONTROL/REPORT/
// TIMEOUT/REJECTED/PHASE records with the worker.yml run-name contract
// `task-<id> · <behavior> · a<attempt>`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { gateDecision, cadenceAdmitsToday, gateConfigCheck } from '../e2e/staged/gate.mjs';
import { runVerdict, readRedVerdict, ASSERT_NAMES } from '../e2e/staged/verify.mjs';
import {
  teardownDecision, markerComment, redPageTitle, redPageBody,
  recoveryShape, nonTerminalState,
} from '../e2e/staged/teardown.mjs';
import { epochSegment, RED_LABEL } from '../e2e/staged/lib.mjs';
import { renderDrillBody, weekdayBehavior, WEEKDAY_BEHAVIORS, DRILL_LEASE_MINUTES, DRILL_MODE } from '../e2e/staged/seed.mjs';
import { parseSpecBlock, validateSpec, bodySha8 } from '../lib/intake.mjs';

const T0 = Date.parse('2026-09-21T01:37:00.000Z');   // a Monday (the cron fire)
const iso = (ms) => new Date(ms).toISOString();
const at = (min) => iso(T0 + min * 60_000);
const deep = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

function haltedCleanState({ issue = '55', tasks = { 'T-1': { id: 'T-1', status: 'done', attempts: 1 } } } = {}) {
  return { chain: { id: 'c-1', seq: 3, halted: true, paused: false }, project: { issue, phase: 'done' }, tasks };
}

const QUIET = { reports: 0, control: 0, intake: 0 };
const NO_RUNS = { main: 0, mirror: 0 };
const DISPATCH = { name: 'workflow_dispatch' };

// ---- the 0921 full-mix GREEN night -----------------------------------------

function fullMixState() {
  return {
    chain: { id: 'c-9', seq: 42, halted: true, paused: false },
    project: { issue: '77', phase: 'done' },
    tasks: {
      'T-STG-A-0921': { id: 'T-STG-A-0921', status: 'done', attempts: 1 },
      'T-STG-B-0921': { id: 'T-STG-B-0921', status: 'done', attempts: 1 },
      'T-STG-C-0921': { id: 'T-STG-C-0921', status: 'done', attempts: 2 },
      'T-STG-H-0921': { id: 'T-STG-H-0921', status: 'quarantined', attempts: 3 },
    },
    stats: { done: 3, quarantined: 1, cancelled: 0, infra_retries: 1, timeouts: 3, budget_pauses: 0, orphaned_reports: 0 },
  };
}

function fullMixBoundary() {
  return {
    id: 'j-101', kind: 'CONTROL', command: 'reset', applied: true,
    note: 'intake-rollover issue #77', ts: '2026-09-21T01:38:00.000Z',
    genesisSpec: {
      mode: 'mock', issue: '77', config: { max_attempts: 3 },
      tasks: [
        { id: 'T-STG-A-0921', behavior: 'fast' },
        { id: 'T-STG-B-0921', behavior: 'fast' },
        { id: 'T-STG-C-0921', behavior: 'infra-flaky' },
        { id: 'T-STG-H-0921', behavior: 'hang' },
      ],
    },
  };
}

function fullMixRecords() {
  return [
    { id: 'j-102', kind: 'REPORT', task: 'T-STG-A-0921', event_id: 'ev-a1', to: 'done' },
    { id: 'j-103', kind: 'REPORT', task: 'T-STG-B-0921', event_id: 'ev-b1', to: 'done' },
    { id: 'j-104', kind: 'REPORT', task: 'T-STG-C-0921', event_id: 'ev-c1', to: 'ready', reason: 'infra-retry' },
    { id: 'j-105', kind: 'REPORT', task: 'T-STG-C-0921', event_id: 'ev-c2', to: 'done' },
    { id: 'j-106', kind: 'TIMEOUT', task: 'T-STG-H-0921', to: 'ready' },
    { id: 'j-107', kind: 'TIMEOUT', task: 'T-STG-H-0921', to: 'ready' },
    { id: 'j-108', kind: 'TIMEOUT', task: 'T-STG-H-0921', to: 'quarantined' },
    { id: 'j-109', kind: 'REJECTED', reason: 'duplicate', task: 'T-STG-A-0921', event_id: 'ev-a1' },
    { id: 'j-110', kind: 'PHASE', to: 'done', degraded: false },
  ];
}

// the worker.yml run-name contract rows (A6/A8's evidence) — main hosts A and
// H's ladder; the mirror hosted B and C (the X26 overflow geometry)
function fullMixRuns() {
  return {
    runsMain: [
      { name: 'task-T-STG-A-0921 · fast · a1', created_at: at(5) },
      { name: 'task-T-STG-H-0921 · hang · a1', created_at: at(10) },
      { name: 'task-T-STG-H-0921 · hang · a2', created_at: at(30) },
      { name: 'task-T-STG-H-0921 · hang · a3', created_at: at(50) },
    ],
    runsMirror: [
      { name: 'task-T-STG-B-0921 · fast · a1', created_at: at(6) },
      { name: 'task-T-STG-C-0921 · infra-flaky · a1', created_at: at(7) },
      { name: 'task-T-STG-C-0921 · infra-flaky · a2', created_at: at(22) },
    ],
  };
}

function fullMixComments() {
  return [
    '**[fsm]** Epoch started for this task — rollover genesis (mock, 4 tasks, lease 15min)',
    '**[fsm]** Epoch COMPLETE for this task — 3 done, 1 quarantined, 0 cancelled',
  ];
}

const WIN_0921 = { start: '2026-09-21T01:37:00.000Z', end: '2026-09-21T04:00:00.000Z' };

function fullMixInput() {
  return {
    state: fullMixState(),
    journalSegment: { boundary: fullMixBoundary(), records: fullMixRecords() },
    ...fullMixRuns(),
    drillIssue: { number: '77', comments: fullMixComments() },
    window: WIN_0921,
    watchdogRuns: [
      { created_at: at(60), status: 'completed', conclusion: 'success' },
      { created_at: at(120), status: 'completed', conclusion: 'success' },
    ],
    alertIssues: [],
  };
}

// the PRIOR generation — a week-old drill epoch still on the journal branch
// (the 16-generations shape §3.1 scopes out). The double-applied pair j-91/92
// is last week's re-delivery accident: if the epoch-segment walk ever leaked
// prior records into tonight's asserts, A4 would go red on it.
function priorGeneration() {
  return [
    {
      id: 'j-90', kind: 'CONTROL', command: 'reset', applied: true,
      note: 'intake-rollover issue #77', ts: '2026-09-14T01:38:00.000Z',
      genesisSpec: { mode: 'mock', issue: '77', config: { max_attempts: 3 }, tasks: [{ id: 'T-STG-A-0914', behavior: 'fast' }] },
    },
    { id: 'j-91', kind: 'REPORT', task: 'T-STG-A-0914', event_id: 'ev-old', to: 'done' },
    { id: 'j-92', kind: 'REPORT', task: 'T-STG-A-0914', event_id: 'ev-old', to: 'done' },   // a DOUBLE-APPLY in the prior epoch
    { id: 'j-93', kind: 'PHASE', to: 'done', degraded: false },
  ];
}

// ---------------------------------------------------------------------------
// §1 the gate matrix (gateDecision — G1..G6)
// ---------------------------------------------------------------------------

test('gate: halted-clean + empty queues + dispatch -> PROCEED, all six rows green', () => {
  const d = gateDecision({ state: haltedCleanState(), depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d.decision, 'PROCEED');
  assert.equal(d.reason, null);
  assert.equal(d.skipCode, null);
  assert.equal(d.warnings.length, 0);
  assert.equal(d.checks.length, 6, 'the full matrix is always evaluated');
  assert.deepEqual(d.checks.map((c) => c.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  assert.ok(d.checks.every((c) => c.ok === true), `every row ok: ${JSON.stringify(d.checks)}`);
});

test('gate: the zero-tasks resting shape (pruned between epochs) also PROCEEDs at G3', () => {
  const d = gateDecision({ state: haltedCleanState({ tasks: {} }), depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d.decision, 'PROCEED');
  const g3 = d.checks.find((c) => c.id === 'G3');
  assert.ok(g3.ok);
  assert.match(g3.detail, /0 task\(s\) all terminal/);
});

test('gate G1: a LIVE chain refuses (one state, one epoch)', () => {
  const s = haltedCleanState();
  s.chain.halted = false;
  const d = gateDecision({ state: s, depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d.decision, 'SKIP');
  assert.equal(d.skipCode, 'G1');
  assert.equal(d.reason, 'G1-live-epoch');
  assert.equal(d.checks.length, 1, 'evaluation stops at the first failure');
  assert.equal(d.checks[0].ok, false);
  assert.match(d.checks[0].detail, /chain\.halted=false/);
});

test('gate G2: a budget-pause hold refuses (the X23-class protection survives)', () => {
  const s = haltedCleanState();
  s.chain.paused = true;
  const d = gateDecision({ state: s, depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d.decision, 'SKIP');
  assert.equal(d.skipCode, 'G2');
  assert.equal(d.reason, 'G2-paused-hold');
  assert.match(d.checks[1].detail, /budget-pause hold/);
});

test('gate G3: non-terminal tasks refuse AND a mid-flight phase refuses', () => {
  const nonTerm = haltedCleanState({ tasks: { 'T-1': { id: 'T-1', status: 'assigned', attempts: 1 } } });
  const d1 = gateDecision({ state: nonTerm, depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d1.skipCode, 'G3');
  assert.equal(d1.reason, 'G3-mid-flight-epoch');
  assert.match(d1.checks[2].detail, /1 non-terminal task\(s\): T-1:assigned/);

  const midFlight = haltedCleanState();
  midFlight.project.phase = 'running';
  const d2 = gateDecision({ state: midFlight, depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d2.skipCode, 'G3');
  assert.match(d2.checks[2].detail, /project\.phase="running"/);
});

test('gate G4: any non-empty queue refuses (a queued spec means the system is WAITING)', () => {
  for (const key of ['reports', 'control', 'intake']) {
    const depths = { ...QUIET, [key]: 1 };
    const d = gateDecision({ state: haltedCleanState(), depths, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
    assert.equal(d.skipCode, 'G4', `${key} depth 1 must refuse`);
    assert.equal(d.reason, 'G4-queued-spec');
  }
  // unparseable residue counts as non-empty too — but that is the thin main's
  // reader duty (items + bad); the pure half just sees the number.
  const d = gateDecision({ state: haltedCleanState(), depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d.decision, 'PROCEED');
});

test('gate G5: a schedule fire with the cadence not promoted refuses (stage-0 posture)', () => {
  const d = gateDecision({ state: haltedCleanState(), depths: QUIET, event: { name: 'schedule' }, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
  assert.equal(d.decision, 'SKIP');
  assert.equal(d.skipCode, 'G5');
  assert.equal(d.reason, 'G5-cadence-gated');
  assert.match(d.checks[4].detail, /schedule fires skip until the var is promoted/);
});

test('gate G6: main-bucket in-progress runs refuse HARD; mirror runs WARN only', () => {
  const hard = gateDecision({ state: haltedCleanState(), depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: { main: 2, mirror: 0 } });
  assert.equal(hard.decision, 'SKIP');
  assert.equal(hard.skipCode, 'G6');
  assert.equal(hard.reason, 'G6-main-runs-in-progress');
  assert.match(hard.checks[5].detail, /2 in-progress\/queued machine-plane run\(s\)/);

  const warn = gateDecision({ state: haltedCleanState(), depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: { main: 0, mirror: 3 } });
  assert.equal(warn.decision, 'PROCEED', 'the shared agentrunners bucket is not ours to gate on');
  assert.equal(warn.warnings.length, 1);
  assert.match(warn.warnings[0], /G6-mirror-in-progress: 3 run\(s\)/);
});

test('gate: an UNREADABLE state shape refuses at G1 (the read-RED class\'s pure half) + the G1..G6 ordering', () => {
  for (const bad of [null, undefined, {}, { chain: null }]) {
    const d = gateDecision({ state: bad, depths: QUIET, event: DISPATCH, cadenceVar: 'manual', now: new Date(T0), inProgress: NO_RUNS });
    assert.equal(d.decision, 'SKIP', `unreadable ${JSON.stringify(bad)} must never PROCEED`);
    assert.equal(d.skipCode, 'G1');
    assert.match(d.checks[0].detail, /unreadable shape/);
  }
  // ordering: a live chain AND queued depths AND main runs -> G1 is named, the
  // matrix stops there (the first failure in G1..G6 order, §1.3)
  const s = haltedCleanState();
  s.chain.halted = false;
  const d = gateDecision({ state: s, depths: { reports: 3, control: 0, intake: 2 }, event: { name: 'schedule' }, cadenceVar: 'manual', now: new Date(T0), inProgress: { main: 1, mirror: 0 } });
  assert.equal(d.skipCode, 'G1');
  assert.equal(d.checks.length, 1);
});

test('gate: cadenceAdmitsToday ladder (dispatch always; nightly always; weekly Mondays-UTC only; manual/unknown fail closed)', () => {
  const monday = new Date('2026-09-21T12:00:00.000Z');   // a Monday (verified)
  const tuesday = new Date('2026-09-22T12:00:00.000Z');
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'manual', eventName: 'workflow_dispatch', now: tuesday }), true, 'a manual run always proceeds');
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'manual', eventName: 'schedule', now: tuesday }), false, 'stage 0: schedule SKIPs');
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'nightly', eventName: 'schedule', now: tuesday }), true);
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'weekly', eventName: 'schedule', now: monday }), true, 'weekly = Mondays UTC');
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'weekly', eventName: 'schedule', now: tuesday }), false, 'not a Monday');
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'typo-of-nightly', eventName: 'schedule', now: tuesday }), false, 'a typo\'d var must never silently promote the cadence (fail-closed)');
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'weekly', eventName: 'schedule', now: new Date('invalid') }), false, 'an unparseable now fails closed');
  // the string-event form (the caller may pass either)
  assert.equal(cadenceAdmitsToday({ cadenceVar: 'nightly', eventName: 'schedule', now: monday }), true);
});

test('gate: gateConfigCheck (the m-8 pre-pass) — a missing drill issue or PAT is a GREEN skip, never a red run', () => {
  const noIssue = gateConfigCheck({ drillIssue: '', labPat: 'tok' });
  assert.equal(noIssue.ok, false);
  assert.equal(noIssue.reason, 'config-missing-drill-issue');

  const badIssue = gateConfigCheck({ drillIssue: 'not-a-number', labPat: 'tok' });
  assert.equal(badIssue.ok, false);
  assert.equal(badIssue.reason, 'config-missing-drill-issue');

  const noPat = gateConfigCheck({ drillIssue: '77', labPat: undefined });
  assert.equal(noPat.ok, false);
  assert.equal(noPat.reason, 'config-missing-lab-pat');

  const ok = gateConfigCheck({ drillIssue: '77', labPat: 'tok' });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
  assert.match(ok.detail, /drill issue #77/);
});

// ---------------------------------------------------------------------------
// §3 the verdict table (runVerdict — A1..A12 on fixture pairs)
// ---------------------------------------------------------------------------

test('verdict: the GREEN full-mix fixture — 12/12, the report shape, zero stuck', () => {
  const v = runVerdict(fullMixInput());
  assert.equal(v.verdict, 'GREEN');
  assert.equal(v.deferred, false);
  assert.equal(v.redClass, null);
  assert.equal(v.stuck, false);
  assert.equal(v.failed, 0);
  assert.equal(v.passed, 12);
  assert.equal(v.tasks, 4);
  assert.equal(v.watchdogGreen, true);
  assert.equal(v.asserts.length, 12);
  assert.deepEqual(v.asserts.map((a) => a.id), Object.keys(ASSERT_NAMES));

  // the DRILL-REPORT shape both modes report alike
  assert.equal(v.report.verdict, 'GREEN');
  assert.equal(v.report.drill, 'staged-0921');
  assert.equal(v.report.issue, 77);
  assert.equal(v.report.phases.length, 12);
  assert.equal(v.report.metrics.tasks, 4);
  assert.equal(v.report.metrics.journalRecords, 9);
  assert.equal(v.report.metrics.comments, 2);
  assert.equal(v.report.metrics.state.halted, true);
  assert.equal(v.report.metrics.boundary.mode, 'mock');
  assert.ok(Array.isArray(v.report.notModeled) && v.report.notModeled.length > 0, 'the honest notModeled list rides the report');
});

test('verdict: the epoch-segment scoping — the PRIOR generation never leaks into tonight\'s asserts', () => {
  // the real journal carries the prior week's epoch too; the reader derives
  // the segment with epochSegment (the epochSpend walk rule)
  const journal = [...priorGeneration(), fullMixBoundary(), ...fullMixRecords()];
  const seg = epochSegment(journal);
  assert.equal(seg.boundary.id, 'j-101', 'the NEWEST applied CONTROL reset bounds the epoch');
  assert.equal(seg.records.length, 9, 'only tonight\'s records ride the segment');
  assert.ok(!seg.records.some((r) => String(r.task).endsWith('-0914')), 'the week-old task records are scoped out');

  // and with the prior generation scoped out, the night is still GREEN even
  // though the prior epoch contains a genuine double-applied pair (j-91/92)
  // and a stale single-task boundary (j-90) that would break A4/A12
  const input = fullMixInput();
  input.journalSegment = seg;
  const v = runVerdict(input);
  assert.equal(v.verdict, 'GREEN', `the prior generation must not leak: ${v.asserts.filter((a) => a.ok === false).map((a) => `${a.id}: ${a.detail}`).join(' | ')}`);
  assert.equal(v.failed, 0);
});

test('verdict: the stage-0 HANG night — a DEGRADED halt is the EXPECTED verdict (the R2 gate working)', () => {
  const t3 = Date.parse('2026-09-23T01:37:00.000Z');   // a Wednesday: the rotation's hang night
  const boundary = {
    id: 'j-201', kind: 'CONTROL', command: 'reset', applied: true,
    note: 'intake-rollover issue #77', ts: iso(t3 + 60_000),
    genesisSpec: { mode: 'mock', issue: '77', config: { max_attempts: 3 }, tasks: [{ id: 'T-STG-H-0923', behavior: 'hang' }] },
  };
  const state = {
    chain: { id: 'c-10', seq: 7, halted: true, paused: false },
    project: { issue: '77', phase: 'done' },
    tasks: { 'T-STG-H-0923': { id: 'T-STG-H-0923', status: 'quarantined', attempts: 3 } },
    stats: { done: 0, quarantined: 1, cancelled: 0, infra_retries: 0, timeouts: 3, budget_pauses: 0, orphaned_reports: 0 },
  };
  const records = [
    { id: 'j-202', kind: 'TIMEOUT', task: 'T-STG-H-0923', to: 'ready' },
    { id: 'j-203', kind: 'TIMEOUT', task: 'T-STG-H-0923', to: 'ready' },
    { id: 'j-204', kind: 'TIMEOUT', task: 'T-STG-H-0923', to: 'quarantined' },
    { id: 'j-205', kind: 'PHASE', to: 'done', degraded: true },   // done 0/1 — the honest degraded verdict
  ];
  const v = runVerdict({
    state,
    journalSegment: { boundary, records },
    runsMain: [
      { name: 'task-T-STG-H-0923 · hang · a1', created_at: iso(t3 + 10 * 60_000) },
      { name: 'task-T-STG-H-0923 · hang · a2', created_at: iso(t3 + 30 * 60_000) },
      { name: 'task-T-STG-H-0923 · hang · a3', created_at: iso(t3 + 50 * 60_000) },
    ],
    runsMirror: [],   // stage-0 single-task: in-flight 0 never overflows
    drillIssue: {
      number: '77',
      comments: [
        '**[fsm]** Epoch started for this task — rollover genesis (mock, 1 task)',
        '**[fsm]** Epoch HALTED DEGRADED for this task — 0/1 done (the R2 quality gate)',
      ],
    },
    window: { start: '2026-09-23T01:37:00.000Z', end: '2026-09-23T04:00:00.000Z' },
    watchdogRuns: [{ created_at: iso(t3 + 40 * 60_000), status: 'completed', conclusion: 'success' }],
    alertIssues: [],
  });
  assert.equal(v.verdict, 'GREEN', `the hang night is GREEN: ${v.asserts.filter((a) => a.ok === false).map((a) => `${a.id}: ${a.detail}`).join(' | ')}`);
  assert.equal(v.failed, 0);
  const a3 = v.asserts.find((a) => a.id === 'A3');
  assert.ok(a3.ok, 'A3 passes with degraded=true expected (behavior-aware)');
  assert.match(a3.expected, /degraded === true/);
  const a6 = v.asserts.find((a) => a.id === 'A6');
  assert.ok(a6.ok);
  assert.match(a6.expected, /0 mirror runs \+ ≥1 main run \(stage-0 single-task/, 'the stage-0 overflow shape: zero mirror runs');
  const a5 = v.asserts.find((a) => a.id === 'A5');
  assert.match(a5.detail, /max_attempts=3/);
});

test('verdict RED (assertion): a NON-TERMINAL task fails A2 and flags stuck (the §4.2 arm\'s input)', () => {
  const input = deep(fullMixInput());
  input.state.tasks['T-STG-H-0921'].status = 'in_progress';   // the monitor timed out mid-drain
  const v = runVerdict(input);
  assert.equal(v.verdict, 'RED');
  assert.equal(v.redClass, 'assertion');
  assert.equal(v.failed, 1);
  assert.equal(v.passed, 11);
  assert.equal(v.stuck, true, 'stuck=true is teardown\'s nonTerminalState predicate input');
  const a2 = v.asserts.find((a) => a.id === 'A2');
  assert.equal(a2.ok, false);
  assert.match(a2.detail, /NON-TERMINAL task\(s\): T-STG-H-0921:in_progress/);
  assert.equal(v.report.verdict, 'RED');
});

test('verdict RED (assertion): a DOUBLE-APPLIED report fails A4 on a halted-clean chain (NOT stuck — no reset fires)', () => {
  const input = deep(fullMixInput());
  input.journalSegment.records.push({ id: 'j-111', kind: 'REPORT', task: 'T-STG-A-0921', event_id: 'ev-a1', to: 'done' });   // the same (task,event_id) applied twice
  const v = runVerdict(input);
  assert.equal(v.verdict, 'RED');
  assert.equal(v.redClass, 'assertion');
  assert.equal(v.stuck, false, 'an assertion-RED on a halted-clean chain leaves the system alone (§3.4)');
  const a4 = v.asserts.find((a) => a.id === 'A4');
  assert.equal(a4.ok, false);
  assert.match(a4.detail, /DOUBLE-APPLIED .*ev-a1×2/);
  assert.match(a4.actual, /duplicate-rejects=1/);
});

test('verdict RED (no-epoch): the pre-drill resting shape — the reopen landed but nothing consumed it', () => {
  const v = runVerdict({
    state: haltedCleanState({ issue: '55' }),   // a foreign halted-clean epoch from before the drill
    journalSegment: {
      boundary: {   // a week-old foreign boundary — not ours, not in-window
        id: 'j-90', kind: 'CONTROL', command: 'reset', applied: true,
        note: 'intake-rollover issue #55', ts: '2026-09-14T01:38:00.000Z',
        genesisSpec: { mode: 'mock', issue: '55', config: { max_attempts: 3 }, tasks: [{ id: 'T-REAL-1', behavior: 'fast' }] },
      },
      records: [],
    },
    runsMain: [], runsMirror: [],
    drillIssue: { number: '77', comments: [] },
    window: WIN_0921,
  });
  assert.equal(v.verdict, 'RED');
  assert.equal(v.redClass, 'no-epoch');
  assert.equal(v.failed, 1);
  assert.equal(v.passed, 0);
  const a1 = v.asserts.find((a) => a.id === 'A1');
  assert.equal(a1.ok, false);
  assert.match(a1.detail, /NO-EPOCH/);
  // A2..A12 ride along as null (no drill epoch to assert against)
  assert.ok(v.asserts.slice(1).every((a) => a.ok === null));
});

test('verdict DEFERRED (§1.4): a foreign LIVE epoch and a foreign in-window boundary both defer — green, zero teardown, zero page', () => {
  // shape 1: the real issue won the queue head and is LIVE right now
  const live = runVerdict({
    state: { chain: { id: 'c-2', seq: 5, halted: false, paused: false }, project: { issue: '55', phase: 'running' }, tasks: { 'T-REAL-9': { id: 'T-REAL-9', status: 'in_progress', attempts: 1 } } },
    journalSegment: { boundary: null, records: [] },
    runsMain: [], runsMirror: [],
    drillIssue: { number: '77', comments: [] },
    window: WIN_0921,
  });
  assert.equal(live.verdict, 'DEFERRED');
  assert.equal(live.deferred, true);
  assert.equal(live.redClass, null);
  assert.equal(live.failed, 0);
  assert.equal(live.passed, 0);
  assert.equal(live.asserts.length, 12);
  assert.ok(live.asserts.every((a) => a.ok === null && /DRILL-DEFERRED/.test(a.detail)));
  assert.equal(live.report.verdict, 'DEFERRED');

  // shape 2: the foreign epoch already ran and halted tonight (in-window boundary)
  const done = runVerdict({
    state: haltedCleanState({ issue: '55' }),
    journalSegment: {
      boundary: {
        id: 'j-95', kind: 'CONTROL', command: 'reset', applied: true,
        note: 'intake-rollover issue #55', ts: '2026-09-21T01:39:00.000Z',   // IN tonight's window
        genesisSpec: { mode: 'mock', issue: '55', config: { max_attempts: 3 }, tasks: [{ id: 'T-REAL-1', behavior: 'fast' }] },
      },
      records: [{ kind: 'PHASE', to: 'done', degraded: false }],
    },
    runsMain: [], runsMirror: [],
    drillIssue: { number: '77', comments: [] },
    window: WIN_0921,
  });
  assert.equal(done.verdict, 'DEFERRED', 'a real epoch ran tonight; the drill retries next night');
  assert.equal(done.deferred, true);
});

test('verdict read-RED (§3.4): readRedVerdict — twelve no-data asserts, never silently green', () => {
  const v = readRedVerdict({ err: 'git fetch failed: exit 128 (retries exhausted)', win: WIN_0921, drillIssueNum: '77' });
  assert.equal(v.verdict, 'RED');
  assert.equal(v.redClass, 'read');
  assert.equal(v.deferred, false);
  assert.equal(v.failed, 12);
  assert.equal(v.passed, 0);
  assert.ok(v.asserts.every((a) => a.ok === false && /read-RED/.test(a.detail)));
  assert.match(v.report.metrics.readError, /git fetch failed/);
  assert.equal(v.report.issue, 77);
});

// ---------------------------------------------------------------------------
// §3.1 epochSegment (the scoping walk — lib.mjs)
// ---------------------------------------------------------------------------

test('epochSegment: the newest APPLIED reset bounds; rejected twins and absent resets never bound', () => {
  const applied = (id, note = 'intake-rollover issue #77') => ({ id, kind: 'CONTROL', command: 'reset', applied: true, note });
  const rejected = (id) => ({ id, kind: 'CONTROL', command: 'reset', applied: false, reason: 'duplicate' });

  const newest = epochSegment([applied('r1'), { id: 'x1' }, applied('r2'), { id: 'x2' }]);
  assert.equal(newest.boundary.id, 'r2', 'the walk is from the END backward');
  assert.deepEqual(newest.records.map((r) => r.id), ['x2'], 'only the records AFTER the boundary');

  const twin = epochSegment([applied('r1'), { id: 'x1' }, rejected('rTwin'), { id: 'x2' }]);
  assert.equal(twin.boundary.id, 'r1', 'a REJECTED/reset-duplicate twin never bounds the epoch (the M-1/R2-3 class)');
  assert.deepEqual(twin.records.map((r) => r.id), ['x1', 'rTwin', 'x2']);

  const none = epochSegment([{ id: 'x1' }, { id: 'x2' }]);
  assert.equal(none.boundary, null, 'no applied reset -> the bootstrap shape');
  assert.deepEqual(none.records, []);

  const weird = epochSegment(null);
  assert.equal(weird.boundary, null, 'non-array input degrades to the no-epoch shape');
  assert.deepEqual(weird.records, []);
});

// ---------------------------------------------------------------------------
// §4 the emit shapes (teardown.mjs)
// ---------------------------------------------------------------------------

test('teardownDecision: the safety order — gate-read-red pages FIRST, seed-skip exits green BEFORE any page, DEFERRED is zero-teardown', () => {
  // the ordering: a gate read failure wins even when the seed landed and verify said RED
  assert.deepEqual(
    teardownDecision({ gateResult: 'failure', seeded: 'true', verdict: 'RED' }),
    { action: 'gate-read-red', effectiveVerdict: 'RED', redClass: 'gate-read' }
  );
  // the F3 seed-skip: a failed seed write is GREEN (no epoch, the queue was never touched)
  assert.deepEqual(
    teardownDecision({ gateResult: 'success', seeded: 'false', verdict: 'RED' }),
    { action: 'seed-skip', effectiveVerdict: 'SKIP', redClass: null }
  );
  // a crashed seed (no output at all) is RED — law 5
  assert.deepEqual(
    teardownDecision({ gateResult: 'success', seeded: undefined, verdict: 'GREEN' }),
    { action: 'seed-no-output', effectiveVerdict: 'RED', redClass: 'seed-no-output' }
  );
  // DEFERRED: green exit, zero teardown, zero page (§1.4)
  assert.deepEqual(
    teardownDecision({ gateResult: 'success', seeded: 'true', verdict: 'DEFERRED' }),
    { action: 'deferred', effectiveVerdict: 'DEFERRED', redClass: null }
  );
  // GREEN / RED / verify-no-verdict
  assert.deepEqual(
    teardownDecision({ gateResult: 'success', seeded: 'true', verdict: 'GREEN' }),
    { action: 'green', effectiveVerdict: 'GREEN', redClass: null }
  );
  assert.deepEqual(
    teardownDecision({ gateResult: 'success', seeded: 'true', verdict: 'RED' }),
    { action: 'red', effectiveVerdict: 'RED', redClass: 'assertion' }
  );
  // a crashed verify (no verdict) is RED — never silently green (law 5)
  assert.deepEqual(
    teardownDecision({ gateResult: 'success', seeded: 'true', verdict: '' }),
    { action: 'red', effectiveVerdict: 'RED', redClass: 'verify-no-verdict' }
  );
});

test('markerComment: §3.3\'s exact streak line (watchdog RED renders RED)', () => {
  const line = markerComment({ date: new Date('2026-09-21T04:00:00Z'), wallMin: 137, tasks: 4, assertsPassed: 12, assertsTotal: 12, watchdogGreen: true });
  assert.equal(line, 'STAGED-DRILL GREEN · 2026-09-21 · wall 137 min · tasks 4 · asserts 12/12 · watchdog green');

  const red = markerComment({ date: new Date('2026-09-21T04:00:00Z'), wallMin: 137, tasks: 4, assertsPassed: 11, assertsTotal: 12, watchdogGreen: false });
  assert.equal(red, 'STAGED-DRILL GREEN · 2026-09-21 · wall 137 min · tasks 4 · asserts 11/12 · watchdog RED');

  const unknown = markerComment({ date: '2026-09-21', wallMin: NaN, tasks: 4, assertsPassed: 12, assertsTotal: 12 });
  assert.match(unknown, /wall \? min/, 'a missing wall renders ? not NaN');
});

test('redPageTitle + RED_LABEL: the page sits in the alert stream on the DISTINCT label — never fsm-watchdog-alert (the lane-mixing hazard)', () => {
  assert.equal(redPageTitle(new Date('2026-09-21T04:00:00Z')), '[fsm-staged] NIGHTLY DRILL RED — 2026-09-21');
  assert.equal(redPageTitle('2026-09-22'), '[fsm-staged] NIGHTLY DRILL RED — 2026-09-22');

  // the machine's alert lanes search state=open&labels=fsm-watchdog-alert and
  // take the first hit (watchdog/scan.mjs:76-79) — an open drill-RED issue
  // with that label would ABSORB the next REAL alert's comments
  assert.equal(RED_LABEL, 'fsm-staged-red');
  assert.notEqual(RED_LABEL, 'fsm-watchdog-alert');
});

test('redPageBody: per-class intros (assertion vs read), the failed-assert list, the recovery line, the reset branches', () => {
  const base = { date: new Date('2026-09-21T04:00:00Z'), failedIds: ['A2', 'A3'], recovery: 'halted-clean (a valid resting state — the next night retries; no reset fired)' };

  const assertion = redPageBody({ ...base, redClass: 'assertion' });
  assert.match(assertion, /\*\*\[fsm-staged\]\*\* The nightly staged drill went RED on 2026-09-21\./);
  assert.match(assertion, /A real invariant break — investigate/);
  assert.match(assertion, /- \*\*A2\*\* — see the run's step summary/);
  assert.match(assertion, /\*\*Recovery state of the system:\*\* halted-clean/);
  assert.match(assertion, /research\/s22-staged-mode\.md/, 'the fix-forward note points at the design doc');
  assert.ok(!assertion.includes('RESET was dispatched'), 'no reset branch when resetDispatched is absent');

  const read = redPageBody({ ...base, redClass: 'read', failedIds: [] });
  assert.match(read, /likely API flake\. Re-run the verify job first/);
  assert.match(read, /- \(no per-assert detail — the class above carries the failure\)/);

  const noEpoch = redPageBody({ ...base, redClass: 'no-epoch' });
  assert.match(noEpoch, /no epoch started — the PAT-comment trigger law or the intake door lane is the suspect/);

  const resetOk = redPageBody({ ...base, redClass: 'assertion', resetDispatched: true });
  assert.match(resetOk, /§4\.2 stuck-recovery RESET was dispatched/);
  assert.match(resetOk, /the intake queue PARKS through it/);

  const resetFail = redPageBody({ ...base, redClass: 'assertion', resetDispatched: false });
  assert.match(resetFail, /reset dispatch FAILED/);
  assert.match(resetFail, /"event_type":"fsm-control"/, 'the manual re-send instruction carries the exact dispatch shape');
});

test('recoveryShape: halted-clean / paused / mid-epoch / halted-non-terminal / unreadable', () => {
  assert.equal(recoveryShape(null), 'state unreadable');
  assert.equal(recoveryShape({}), 'state unreadable');

  const paused = haltedCleanState();
  paused.chain.paused = true;
  assert.match(recoveryShape(paused), /held-paused \(an operator\/budget hold\)/);

  assert.match(recoveryShape(haltedCleanState()), /halted-clean \(a valid resting state — the next night retries; no reset fired\)/);

  const nonTerm = haltedCleanState({ tasks: { 'T-1': { id: 'T-1', status: 'assigned', attempts: 1 } } });
  assert.match(recoveryShape(nonTerm), /halted but NON-TERMINAL tasks remain .* the §4\.2 reset fires/);

  const mid = haltedCleanState({ tasks: { 'T-1': { id: 'T-1', status: 'in_progress', attempts: 1 } } });
  mid.chain.halted = false;
  mid.project.phase = 'running';
  assert.match(recoveryShape(mid), /MID-EPOCH \(phase="running", 1\/1 task\(s\) non-terminal/);
});

test('nonTerminalState: the §4.2 predicate — unreadable recovers, halted-clean does not', () => {
  assert.equal(nonTerminalState(null), true, 'unreadable -> recover (fail-safe)');
  assert.equal(nonTerminalState({}), true);
  assert.equal(nonTerminalState(haltedCleanState()), false, 'halted-clean is terminal — NO reset fires');
  const mid = haltedCleanState({ tasks: { 'T-1': { id: 'T-1', status: 'in_progress', attempts: 1 } } });
  mid.chain.halted = false;
  assert.equal(nonTerminalState(mid), true);
  const paused = haltedCleanState();
  paused.chain.paused = true;
  assert.equal(nonTerminalState(paused), false, 'a paused-but-terminal hold does NOT fire the reset (wiping the X23 hold would be the cure worse than the disease)');
});

// ---------------------------------------------------------------------------
// §2.2 the seed's pure half — the body template against the REAL door
// ---------------------------------------------------------------------------

test('seed: the stage-0 weekday rotation (Mon fast / Tue infra / Wed hang) + the dated task ids', () => {
  assert.deepEqual(WEEKDAY_BEHAVIORS, ['fast', 'fast', 'infra-flaky', 'hang', 'fast', 'fast', 'fast']);   // Sun..Sat
  assert.equal(weekdayBehavior(new Date('2026-09-21T01:37:00Z')), 'fast');        // Monday
  assert.equal(weekdayBehavior(new Date('2026-09-22T01:37:00Z')), 'infra-flaky'); // Tuesday
  assert.equal(weekdayBehavior(new Date('2026-09-23T01:37:00Z')), 'hang');        // Wednesday

  const mon = renderDrillBody({ date: new Date('2026-09-21T01:37:00Z') });
  assert.equal(mon.mmdd, '0921');
  assert.equal(mon.tasks.length, 1);
  assert.equal(mon.tasks[0].id, 'T-STG-A-0921');
  assert.equal(mon.tasks[0].behavior, 'fast');
  assert.equal(mon.leaseMinutes, DRILL_LEASE_MINUTES);
  assert.equal(mon.leaseMinutes, 15, '§2.1: the epoch-wide lease');
  assert.equal(mon.mode, DRILL_MODE);
  assert.equal(mon.mode, 'mock', '§1.5: pinned in the spec — the drill never reads vars.EPOCH_MODE');

  const tue = renderDrillBody({ date: new Date('2026-09-22T01:37:00Z') });
  assert.equal(tue.tasks[0].id, 'T-STG-C-0922');
  assert.equal(tue.tasks[0].behavior, 'infra-flaky');
  const wed = renderDrillBody({ date: new Date('2026-09-23T01:37:00Z') });
  assert.equal(wed.tasks[0].id, 'T-STG-H-0923');
  assert.equal(wed.tasks[0].behavior, 'hang');

  // the dated ids kill the law-4 id-reuse hazard at the source, and the dated
  // header means a fresh body_sha8 each night (the door's dedup never
  // suppresses the nightly enqueue)
  assert.notEqual(mon.tasks[0].id, tue.tasks[0].id);
  assert.notEqual(bodySha8(mon.body), bodySha8(tue.body));
});

test('seed: the stage-0 body is ACCEPTED by the REAL door (parseSpecBlock + validateSpec)', () => {
  const rendered = renderDrillBody({ date: new Date('2026-09-21T01:37:00Z') });   // Monday: the fast night
  const parsed = parseSpecBlock(rendered.body);
  assert.ok(parsed, 'the fenced fsm-task block parses');
  assert.equal(parsed.problems.length, 0, `no duplicate-key problems: ${JSON.stringify(parsed.problems)}`);
  assert.equal(parsed.spec.id, 'T-STG-A-0921');
  assert.equal(parsed.spec.behavior, 'fast');
  assert.equal(parsed.spec.mode, 'mock');
  assert.equal(String(parsed.spec.lease_minutes), '15');

  const verdict = validateSpec(parsed.spec, { issue: 77, raw: parsed.raw, problems: parsed.problems });
  assert.deepEqual(verdict, { ok: true, id: 'T-STG-A-0921' }, `the door accepts the nightly body: ${JSON.stringify(verdict)}`);

  // the hang night too (the letter changes, the shape does not)
  const hang = renderDrillBody({ date: new Date('2026-09-23T01:37:00Z') });
  const hp = parseSpecBlock(hang.body);
  const hv = validateSpec(hp.spec, { issue: 77, raw: hp.raw, problems: hp.problems });
  assert.equal(hv.ok, true, `Wednesday's hang spec passes the door: ${JSON.stringify(hv)}`);
});

test('seed: the DORMANT full mix renders but today\'s single-task door rejects it (B-1\'s territory)', () => {
  const full = renderDrillBody({ date: new Date('2026-09-21T01:37:00Z'), mix: 'full' });
  assert.equal(full.tasks.length, 4);
  assert.deepEqual(full.tasks.map((t) => t.id), ['T-STG-A-0921', 'T-STG-B-0921', 'T-STG-C-0921', 'T-STG-H-0921']);
  assert.deepEqual(full.tasks.map((t) => t.behavior), ['fast', 'fast', 'infra-flaky', 'hang']);

  // selecting the full mix today would die at the door's unknown/duplicate-key
  // rejection — exactly as designed until B-1 lands the multi-task door
  const parsed = parseSpecBlock(full.body);
  assert.ok(parsed.problems.length >= 4, 'the repeated keys collect duplicate-key problems');
  const verdict = validateSpec(parsed.spec, { issue: 77, raw: parsed.raw, problems: parsed.problems });
  assert.equal(verdict.ok, false, 'the dormant mix does NOT pass today\'s door');
  assert.ok(verdict.errors.some((e) => /duplicate key `id`/.test(e)));
});

// ---------------------------------------------------------------------------
// s23 (the stage-0 first-green catch — the runner-only bug class): verify.mjs
// used fileURLToPath at its report-writer path (line 527) without importing
// it — the unit pins test the PURE functions, and the invokedAsMain guard
// means the CLI-entry path never runs under `node --test`. The runner's
// verify job died with "fileURLToPath is not defined". THE FAMILY GUARD:
// every node:url built-in used in the staged driver family must be imported
// in THAT file (a generic guard for the whole e2e/staged/ dir — the same
// class would recur in any driver).
// ---------------------------------------------------------------------------
test('s23/url-imports (source shape): every fileURLToPath/pathToFileURL usage in e2e/staged/*.mjs carries its node:url import', async () => {
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const REPO_ROOT = join(import.meta.dirname, '..');
  const dir = join(REPO_ROOT, 'e2e', 'staged');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs'));
  assert.ok(files.length >= 6, `the staged driver family is present (${files.length} files)`);
  for (const f of files) {
    const src = fs.readFileSync(join(dir, f), 'utf8');
    const usesFileURL = /\bfileURLToPath\s*\(/.test(src);
    const usesPathToFile = /\bpathToFileURL\s*\(/.test(src);
    if (!usesFileURL && !usesPathToFile) continue;
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'node:url'/);
    assert.ok(m, `${f} uses node:url builtins but has no node:url import`);
    const imported = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (usesFileURL) assert.ok(imported.includes('fileURLToPath'), `${f} uses fileURLToPath without importing it (the stage-0 runner catch)`);
    if (usesPathToFile) assert.ok(imported.includes('pathToFileURL'), `${f} uses pathToFileURL without importing it`);
  }
});
