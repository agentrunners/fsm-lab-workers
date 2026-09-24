// test-x29-smoke.mjs — the s24/B10 unit pin: the x29-codex-smoke DRIVER's
// pure half (scripts/x29-codex-smoke.mjs) + one boundary pin of the impure
// half in the determinism lane. The REAL lane is only ever touched by the
// workflow's manual dispatch (the x20-cc-smoke discipline — tests always
// run fake; the smoke run IS the measurement):
//   - the envelope: the minimal codex turn {task T-X29-SMOKE, the echo
//     prompt, mode 'codex', wall 8min + lane_attempts 3, deadline +10min}
//     — deterministic under a fixed clock
//   - the prompt seam: X29_PROMPT rides the envelope, the MARKER never
//     rides the prompt (the assert is its own surface)
//   - the content gate: includes-semantics on content ONLY (reasoning-only
//     answers are done for the FSM, NOT for this smoke)
//   - the derived status: a stamped adapter status wins; the raw extraction
//     shape classifies exactly like runTurn's single classifyOutcome call
//   - the cost line: lane_stats (the adapter's own usage × models.json
//     synthesis) renders cost/tokens/calls + the per-model bracket;
//     absent lane_stats renders the honest null line
//   - the lane lines: the per-lane telemetry view + the (none) guard
//   - THE BOUNDARY PIN: main() in fake mode — the full wiring (envelope →
//     codexTurn → decode → gate → cost line) with the deterministic stub,
//     whose content LACKS the marker: the honest miss (rc 4) is what gets
//     pinned, plus the child-process exit-code contract (the main-guard).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  X29_TASK_REF, X29_PROMPT, X29_MARKER,
  buildX29Envelope, x29ContentOk, x29DerivedStatus, x29CostLine, x29LaneLines, main,
} from '../scripts/x29-codex-smoke.mjs';

const DRIVER_PATH = fileURLToPath(new URL('../scripts/x29-codex-smoke.mjs', import.meta.url));

// a fixed clock (deterministic envelope arithmetic)
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

test('x29: the envelope — the minimal codex turn, deterministic under a fixed clock', () => {
  const e = buildX29Envelope({ nowMs: NOW });
  assert.deepEqual(e.task_ref, { kind: 'state-task', id: X29_TASK_REF });
  assert.equal(X29_TASK_REF, 'T-X29-SMOKE');
  assert.equal(e.prompt, 'Reply with exactly: X29-SMOKE-OK');
  assert.equal(X29_PROMPT, e.prompt);
  assert.equal(e.mode, 'codex');
  assert.equal(e.attempt, 1);
  assert.equal(typeof e.session, 'string');
  assert.ok(e.session.length > 0);
  assert.equal(e.deadline_ms, NOW + 10 * 60_000);   // +10min, inside the 15min workflow TTL
  assert.deepEqual(e.budget, { max_turns: 4, wall_ms: 8 * 60_000, lane_attempts: 3 });
});

test('x29: the envelope — the prompt seam overrides, the deadline scales, the marker never rides the prompt', () => {
  const e = buildX29Envelope({ nowMs: NOW, prompt: 'Say hi', wallMs: 60_000, deadlinePadMs: 120_000, attempt: 2 });
  assert.equal(e.prompt, 'Say hi');
  assert.equal(e.deadline_ms, NOW + 120_000);
  assert.equal(e.budget.wall_ms, 60_000);
  assert.equal(e.attempt, 2);
  // the assert surface is its own constant — no prompt, however custom,
  // ever changes what the gate looks for
  assert.equal(X29_MARKER, 'X29-SMOKE-OK');
  assert.ok(!X29_MARKER.includes('fixture'));   // never arms a fake fixture by accident
});

test('x29: the content gate — includes-semantics on content ONLY', () => {
  assert.equal(x29ContentOk({ content: 'X29-SMOKE-OK' }), true);
  assert.equal(x29ContentOk({ content: 'Sure! X29-SMOKE-OK — hope that helps.' }), true);   // tolerant of wrapping prose
  assert.equal(x29ContentOk({ content: 'X29-SMOKE' }), false);   // partial marker is NOT the marker
  assert.equal(x29ContentOk({ content: 'the task failed' }), false);
  assert.equal(x29ContentOk({ content: null, reasoning: 'X29-SMOKE-OK' }), false);   // reasoning-only is NOT the smoke's surface
  assert.equal(x29ContentOk({}), false);
  assert.equal(x29ContentOk(null), false);
});

test('x29: the derived status — a stamped adapter status wins; the raw shape classifies like runTurn', () => {
  // the raw extraction shape (a done lane): NO status field — runTurn's
  // single classifyOutcome call derives done from the content
  assert.equal(x29DerivedStatus({ content: 'X29-SMOKE-OK', reasoning: null }), 'done');
  // the adapter's failure returns carry a STAMPED status — it wins verbatim
  assert.equal(x29DerivedStatus({ status: 'infra_failed', detail: 'codex-usage(x)' }), 'infra_failed');
  assert.equal(x29DerivedStatus({ status: 'deadline', detail: 'wall-budget-exceeded' }), 'deadline');
  assert.equal(x29DerivedStatus({ status: 'work_failed', content: null }), 'work_failed');
  // degenerate raw shape: the conservative work class (empty-completion)
  assert.equal(x29DerivedStatus({ content: null, reasoning: null }), 'work_failed');
});

test('x29: the cost line — lane_stats renders; absent renders the honest null', () => {
  const ls = {
    calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 1280, cost: 0.000228,
    p50_ms: 3200, p95_ms: 3200, rate_classes: {},
    models: { 'deepseek/deepseek-v4.1-flash': { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 1280, cost: 0.000228, p50_ms: 3200, p95_ms: 3200 } },
  };
  const line = x29CostLine({ lane_stats: ls });
  assert.ok(line.startsWith('X29-COST '));
  assert.ok(line.includes('cost=$0.000228'));
  assert.ok(line.includes('tokens=1280'));
  assert.ok(line.includes('calls=1'));
  assert.ok(line.includes('ok=1'));
  assert.ok(line.includes('[deepseek/deepseek-v4.1-flash: 1 call(s) 1280 tok $0.000228]'));
  assert.ok(line.includes('usage × worker/codex/models.json prices'));
  // absent lane_stats — the turn never reported usage (never a fake 0)
  const nullLine = x29CostLine({ content: 'X29-SMOKE-OK' });
  assert.ok(nullLine.includes('cost=null'));
  assert.ok(nullLine.includes('absent-means-absent'));
  assert.equal(x29CostLine(null), nullLine);
});

test('x29: the lane lines — the per-lane telemetry view + the (none) guard', () => {
  const lines = x29LaneLines({ telemetry: { lanes: [
    { lane: 1, key_index: 1, model: 'deepseek/deepseek-v4.1-flash', rc: 0, signal: null, duration_ms: 3240, wall_killed: false, class: 'done' },
  ] } });
  assert.equal(lines[0], 'X29-LANES (1):');
  assert.equal(lines[1], '  lane 1: key#1 deepseek/deepseek-v4.1-flash rc=0 3240ms class=done');
  assert.deepEqual(x29LaneLines({ telemetry: { lanes: [] } }), ['X29-LANES (none — no lane ever spawned)']);
  assert.deepEqual(x29LaneLines({}), ['X29-LANES (none — no lane ever spawned)']);
});

// ---------------------------------------------------------------------------
// THE BOUNDARY PIN — main() in the determinism lane (CODEX_FAKE_LLM=1): the
// full driver wiring against worker/fake-codex.mjs. The stub's content
// ("fake-codex ok: …") deliberately LACKS the marker: the honest miss (rc 4,
// every diagnostic line printed) is what gets pinned — the pass path of the
// gate is the workflow's one real turn, never a test's.
// ---------------------------------------------------------------------------

function fakeMainEnv(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x29-smoke-pin-'));
  return {
    env: {
      CODEX_FAKE_LLM: '1',
      OPENROUTER_API_KEY: 'x29-pin-key',
      CODEX_FAKE_TRANSCRIPTS_DIR: join(dir, 'sessions'),
      ...over,
    },
    dir,
  };
}

test('x29: main() in fake mode — the full wiring, the honest miss (rc 4) + every diagnostic line', async () => {
  const { env, dir } = fakeMainEnv({ X29_INSTALL_S: '12', X29_PROMPT: 'Reply with exactly: X29-SMOKE-OK' });
  const lines = [];
  try {
    const code = await main({ env, log: (s) => lines.push(String(s)) });
    assert.equal(code, 4);   // the stub's content lacks the marker — the gate misses honestly
    const joined = lines.join('\n');
    assert.ok(joined.includes('X29-INSTALL-SECONDS 12s'));
    assert.ok(joined.includes("X29-CODEX-HOME <absent"));   // the diagnostic reads the env honestly
    assert.ok(joined.includes('X29-ENVELOPE '));
    assert.ok(joined.includes('"mode":"codex"'));
    assert.ok(joined.includes('X29-RESULT '));
    assert.ok(joined.includes('X29-STATUS done'));           // the stub answers a done shape...
    assert.ok(joined.includes('X29-CONTENT-ASSERT FAIL'));   // ...whose content is NOT the marker
    // the fake's OK_USAGE (1200 in / 80 out, deepseek lane 1) through the
    // adapter's own synthesis — the cost VALUE is peak-window dependent
    // (weekday 01-04/06-10 UTC doubles it), the SHAPE is not
    assert.ok(joined.includes('X29-COST cost=$0.000'));
    assert.ok(joined.includes('tokens=1280'));
    assert.ok(joined.includes('calls=1'));
    assert.ok(joined.includes('ok=1'));
    assert.ok(joined.includes('[deepseek/deepseek-v4.1-flash: 1 call(s) 1280 tok $'));
    assert.ok(joined.includes('X29-LANES (1):'));
    assert.ok(joined.includes('class=done'));
    assert.ok(joined.includes('X29-TURN '));
    assert.ok(joined.includes('X29-GATE the marker missed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('x29: main() as a child process — the main-guard + the exit-code contract (rc 4 propagates)', async () => {
  const { env, dir } = fakeMainEnv();
  try {
    const rc = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DRIVER_PATH], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(new Error('x29 child pin timed out')); }, 30_000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    assert.equal(rc.code, 4);   // the honest miss exits the process nonzero — the workflow step fails LOUD
    assert.ok(rc.out.includes('X29-CONTENT-ASSERT FAIL'));
    assert.ok(rc.out.includes('X29-COST cost=$0.000'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
