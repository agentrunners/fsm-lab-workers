#!/usr/bin/env node
// x29-codex-smoke.mjs — the s24/B10 driver: the FIRST live codex turn on an
// fsm-lab worker lane. Fired by .github/workflows/x29-codex-smoke.yml
// (workflow_dispatch, main) AFTER the worker.yml codex-install step's exact
// commands ran (CODEX_HOME=$HOME/.codex-fsm + worker/codex/config.toml
// rendered + the pinned @openai/codex CLI on PATH) — this script then makes
// ONE real codexTurn call through the REAL worker machinery
// (worker/codex-adapter.mjs — the same export the routing arm resolves
// lazily on a codex dispatch), asserts the content marker, and prints the
// cost line recomputed from usage × worker/codex/models.json prices (never
// an engine meter) + the lane log + the install seconds.
//
// THE EXIT CODES (the x20-cc-smoke discipline): 0 = the marker landed and
// the derived status is done; 4 = the content gate missed (the honest miss
// — the step fails LOUD so the logs get read); 5 = an unexpected throw.
//
// THE PURE HALF (pinned by tests/test-x29-smoke.mjs — determinism, zero
// network, zero npm install):
//   buildX29Envelope()   the minimal turn envelope (task T-X29-SMOKE, the
//                        echo prompt, mode 'codex', wall + lane budget)
//   x29ContentOk()       the marker gate: content carries X29-SMOKE-OK
//   x29DerivedStatus()   runTurn's single classifyOutcome call, replicated:
//                        a stamped adapter status wins, else the raw
//                        extraction {content, reasoning} classifies
//   x29CostLine()        lane_stats (usage × models.json, peak-aware — the
//                        adapter's own synthesis) → the X29-COST line
//   x29LaneLines()       telemetry.lanes → the per-lane log lines
// THE IMPURE HALF: main() — codexTurn(envelope, {env, runId, now, log}) +
// the prints. Tests never call it; the workflow always does. In fake mode
// (CODEX_FAKE_LLM=1) it runs the full wiring with the deterministic stub
// (the boundary pin exercises exactly that — the stub's content lacks the
// marker, so the honest miss is what gets pinned).

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { codexTurn } from '../worker/codex-adapter.mjs';
import { classifyOutcome } from '../lib/worker-contract.mjs';

// the pinned constants (the brief's exact strings)
export const X29_TASK_REF = 'T-X29-SMOKE';
export const X29_PROMPT = 'Reply with exactly: X29-SMOKE-OK';
export const X29_MARKER = 'X29-SMOKE-OK';

// buildX29Envelope({ nowMs, prompt, wallMs, deadlinePadMs, attempt }) — the
// minimal turn envelope, the shape envelopeFromDispatch mints for a codex
// dispatch. deadline = now + deadlinePadMs (10min — inside the workflow's
// 15min TTL); wall 8min (D15: max_turns is NOT consumed adapter-side — no
// codex exec flag exists; the wall + the config-side stream_idle_timeout_ms
// are the bounds); lane_attempts 3 (the default bound).
export function buildX29Envelope({
  nowMs, prompt = X29_PROMPT, wallMs = 8 * 60_000, deadlinePadMs = 10 * 60_000, attempt = 1,
} = {}) {
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    task_ref: { kind: 'state-task', id: X29_TASK_REF },
    prompt,
    deadline_ms: now + deadlinePadMs,
    session: 'x29/smoke/codex',
    budget: { max_turns: 4, wall_ms: wallMs, lane_attempts: 3 },
    mode: 'codex',
    attempt,
  };
}

// the marker gate — CONTENT is the assert surface (the adapter's raw
// extraction shape; reasoning-only answers are a done shape for the FSM but
// NOT for this smoke: the marker must ride the content).
export function x29ContentOk(result) {
  return String(result?.content ?? '').includes(X29_MARKER);
}

// runTurn's single classifyOutcome call, replicated for the print: a
// stamped adapter status (infra_failed/deadline/poison — the failure
// returns) wins; the raw extraction shape ({content, reasoning}, no
// status) classifies exactly like the routing arm's call does.
export function x29DerivedStatus(result) {
  if (result && typeof result.status === 'string' && result.status !== '') return result.status;
  return classifyOutcome({ content: result?.content ?? null, reasoning: result?.reasoning ?? null }).status;
}

// the cost line: lane_stats is the adapter's own synthesis (usage × the
// worker/codex/models.json price table, deepseek peak-aware, aggregated by
// the SHARED collectLaneStats into the lane-telemetry aggregate shape) —
// this formatter renders it, it never recomputes. Absent lane_stats =
// absent-means-absent: the turn never reported usage (the honest null).
export function x29CostLine(result) {
  const ls = result?.lane_stats;
  if (!ls || typeof ls !== 'object') {
    return 'X29-COST cost=null tokens=null calls=null (no lane_stats — the turn never reported usage; absent-means-absent)';
  }
  const models = Object.entries(ls.models ?? {})
    .map(([slug, m]) => `${slug}: ${m.calls} call(s) ${m.tokens} tok $${m.cost}`)
    .join(' · ');
  return `X29-COST cost=$${ls.cost} tokens=${ls.tokens} calls=${ls.calls} ok=${ls.ok} `
    + `err429=${ls.err429} err5xx=${ls.err5xx} p50_ms=${ls.p50_ms} p95_ms=${ls.p95_ms}`
    + (models ? ` [${models}] (usage × worker/codex/models.json prices — recomputed, never the engine meter)` : '');
}

// the per-lane log lines (telemetry.lanes — the same fields the transcript
// body renders; the lane view the EVIDENCE entry cites).
export function x29LaneLines(result) {
  const lanes = result?.telemetry?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) return ['X29-LANES (none — no lane ever spawned)'];
  return [`X29-LANES (${lanes.length}):`,
    ...lanes.map((l) => `  lane ${l.lane}: key#${l.key_index} ${l.model} rc=${l.rc}`
      + `${l.signal ? ` signal=${l.signal}` : ''} ${l.duration_ms}ms class=${l.class}`)];
}

// main() — the impure half. Returns the exit code (0 marker+done, 4 miss).
export async function main({ env = process.env, log = (s) => console.log(String(s)) } = {}) {
  const runId = typeof env.GITHUB_RUN_ID === 'string' && env.GITHUB_RUN_ID !== ''
    ? env.GITHUB_RUN_ID
    : `x29-local-${Date.now()}`;
  const envelope = buildX29Envelope({ prompt: env.X29_PROMPT || X29_PROMPT });
  const installS = typeof env.X29_INSTALL_S === 'string' && env.X29_INSTALL_S !== '' ? env.X29_INSTALL_S : 'n/a';

  // the environment readback (the root-cause surfaces: the B3 wiring + the
  // spawn command — config.toml path mismatches and -m slug breaks show here)
  log(`X29-INSTALL-SECONDS ${installS}s (the worker.yml codex-install step's npm pin)`);
  log(`X29-CODEX-HOME ${env.CODEX_HOME ?? '<absent — the fallback scratch home carries NO config.toml (B3\'s install step owns the real one; never on a dispatched lane)'}`);
  log(`X29-CODEX-BIN ${env.CODEX_BIN ?? 'codex (PATH — the installed binary)'}`);
  log(`X29-ENVELOPE ${JSON.stringify({ ...envelope, deadline_utc: new Date(envelope.deadline_ms).toISOString() })}`);

  // the ONE real turn — the same opts shape the routing arm passes
  // ({env, runId, now, log}; now MUST be the epoch-ms clock — the x20
  // run-1 lesson: an ISO-string now() NaN'd the wall and died in 50ms).
  const t0 = Date.now();
  const result = await codexTurn(envelope, { env, runId, now: Date.now, log });
  const turnS = ((Date.now() - t0) / 1000).toFixed(1);

  log(`X29-RESULT ${JSON.stringify(result, null, 1)}`);
  const status = x29DerivedStatus(result);
  const ok = x29ContentOk(result);
  log(`X29-STATUS ${status}${result?.detail ? ` detail=${JSON.stringify(String(result.detail))}` : ''}`);
  log(`X29-CONTENT-ASSERT ${ok ? 'PASS' : 'FAIL'} (content carries ${X29_MARKER})`);
  log(x29CostLine(result));
  for (const line of x29LaneLines(result)) log(line);
  log(`X29-TURN ${turnS}s (one codexTurn through the real worker machinery · run ${runId})`);

  if (!ok) {
    log(`X29-GATE the marker missed — content=${JSON.stringify(String(result?.content ?? '').slice(0, 200))} summary=${JSON.stringify(String(result?.summary ?? '').slice(0, 200))}`);
    return 4;
  }
  if (status !== 'done') {
    log(`X29-GATE the content landed but the derived status is ${status} — the turn is not a done shape`);
    return 4;
  }
  return 0;
}

// the main-guard: tests import the module (pure half only); the workflow and
// the boundary pin spawn it as a child (argv[1] === this file).
const invokedAsMain = (() => {
  try {
    return Array.isArray(process.argv) && typeof process.argv[1] === 'string' && process.argv[1] !== ''
      && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch { return false; }
})();

if (invokedAsMain) {
  main({ env: process.env }).then(
    (code) => { process.exitCode = code; },
    (e) => {
      console.error(`X29-ERROR ${e?.stack ?? e}`);
      process.exitCode = 5;
    },
  );
}
