// worker/turn.mjs — ONE task execution (the agent seat).
//
// T46/W-B §1c — ALL modes route through the CONTRACT (lib/worker-contract.mjs):
//
//   1. LAW 1 — THE START-GATE, before ANY work: envelopeFromDispatch(CP,
//      Date.now()). {ok:false} (deadline already past = the 'late-start'
//      class, or any corrupt/contradictory payload) → enqueue ONE
//      infra_failed report carrying the reason and EXIT 0 — the lease is
//      NEVER burned on a guaranteed orphan (work that cannot finish before
//      its deadline is not started; the report lands while the lease is
//      still valid inside the margin window → net-zero retry; if the lease
//      truly lapsed it lands as a journaled orphan and the reaper converges
//      the task either way).
//   2. MODE routing (envelope.mode; absent → 'mock'):
//        mock → shimInvoke (sim/harness-shim.mjs — the deterministic
//               contract implementer; the seeded behaviors replace the old
//               mock.mjs brain in the WORKFLOW path. lib/mock.mjs STAYS for
//               sim/run-sim.mjs + run-sim2.mjs, whose drivers call the mock
//               directly — the sims do not execute this file).
//        real → the raw-completion stand-in (realWork) on the env-driven
//               model chain with ONE fallback hop on infra-class failure,
//               bounded by budget.lane_attempts (the RETIRED hardcoded
//               minimax/minimax-m3:free slug — live 404 — died here).
//        cc   → worker/cc-adapter.mjs (T46/W4): the claude-code harness
//               turn — key-pool × model-chain lanes, the F-M8 bridge env,
//               the process-group wall kill, transcripts to fsm-sessions
//               BEFORE the report, the door governance on artifacts.
//               CC_FAKE_LLM=1 swaps the CLI for worker/fake-cc.mjs (same
//               argv, deterministic fixtures) — tests never burn fuel.
//   3. classifyOutcome — the ONE normalizer before report enqueue: every
//      harness completion (shim return, real-lane raw, routing-level infra
//      marker) flows through it exactly once; the five-class outcome plus
//      the contract extras (telemetry, artifact_refs) form the payload.
//      The FSM receiver (T46/W1 F-B1) applies all five classes.
//   4. THE WRITE-BACK DOOR (the artifact governance): a done carrying
//      artifact_refs is validated by writeBackDoor BEFORE the report is
//      trusted — violations flip the outcome to the poison class (terminal
//      quarantine; the door is the governance, per §1d).
//
// The worker NEVER writes state — it reports through a CAS-appended line on
// the state branch's report queue (data flows through git; dispatches are
// the wake mechanism only). The tick drains the queue atomically. Report
// semantics: at-least-once enqueue, exactly-once apply (event_id dedup on
// the conductor side).
//
// T45/F-E re-run contract (README failure-matrix row carries the same text):
// re-run ONLY workers whose report never enqueued (enqueue failure, infra
// blip). Once a report is enqueued, the FSM's retry ladder IS the retry
// mechanism — a re-run cannot improve an outcome: its report lands as a
// stale-lease ORPHAN (journaled, orphaned_reports+1), visible waste, never
// silent. Ids are attempt-scoped (rep-<run>-a<attempt>, minted through the
// ONE mint table) so a re-run is never dedup-swallowed (the probe2 Shape-A
// kill).
//
// Enqueue-failure hardening (the visible-waste doctrine): the enqueue itself
// retries once (on top of the CAS loop's internal retries); on final failure
// the report payload is written to the GITHUB_STEP_SUMMARY file (the run's
// visible conclusion — the worker has ZERO API/PAT surface, so the step
// summary IS the run-conclusion lane) and the run exits 2.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from '../lib/store.mjs';
import { reportEventId } from '../lib/event-ingest.mjs';
import { envelopeFromDispatch, classifyOutcome, writeBackDoor } from '../lib/worker-contract.mjs';
import { shimInvoke, seedFromRunId } from '../sim/harness-shim.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// T45/F-G(a): the mock sleep cap = WORKER_TTL − 2min margin (keep in sync
// with worker.yml timeout-minutes). The old cap (== timeout-minutes) meant
// the job was SIGTERM-killed ~30-60s BEFORE the capped sleep resolved —
// 'slow' degenerated to no-report and the designed orphaned-report lane was
// unreachable from the mock lane (probe5A).
export function sleepCapMs(env = process.env) {
  const ttl = parseFloat(env.WORKER_TTL_MIN || '20');
  return Math.max(0, (Number.isFinite(ttl) ? ttl : 20) - 2) * 60_000;
}

// ---------------------------------------------------------------------------
// MODE=real — the raw-completion stand-in (X7: the non-deterministic-agent
// seam; one OpenRouter completion stands in for a CC turn), on the
// env-driven model chain.
//
// The chain: [OPENROUTER_MODEL env (optional), dots-studio (the re-armed
// free lane), nemotron, cohere] — the RETIRED minimax/minimax-m3:free slug
// (live 404, 46-A4) is gone. On an INFRA-class lane failure (transport /
// 401 / 402 / 429 / 5xx — lane/key state, operator action) the turn hops ONCE
// to the next model, bounded by budget.lane_attempts (lane_attempts 1 = no
// hop). WORK-class failures (empty completion, deterministic 4xx) do NOT
// hop — the lane answered; rotating it cannot change the answer.
//
// Returns the RAW lane result (pre-normalization — runTurn's single
// classifyOutcome call is the one normalizer):
//   {content}                                  200 + content        → done
//   {content: null}                            200 + empty          → work_failed 'empty-completion'
//   {error: {status: <n|'transport'>}}         non-infra error      → work_failed 'error-<n>'
//   {status:'infra_failed', detail:'lane-exhausted(...)'}  all lanes dead
// ---------------------------------------------------------------------------

export const REAL_MODEL_CHAIN_DEFAULTS = [
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'cohere/north-mini-code:free',
];

export function realModelChain(env = process.env) {
  const custom = typeof env.OPENROUTER_MODEL === 'string' && env.OPENROUTER_MODEL.trim() !== '' ? [env.OPENROUTER_MODEL.trim()] : [];
  return [...custom, ...REAL_MODEL_CHAIN_DEFAULTS];
}

const isInfraStatus = (st) => st === 401 || st === 402 || st === 429 || (typeof st === 'number' && st >= 500);

export async function realWork(envelope, { env = process.env, fetchImpl = fetch } = {}) {
  const chain = realModelChain(env);
  // ONE fallback hop, bounded by the lane budget and the chain's length
  const maxTries = Math.min(chain.length, Math.max(1, Math.min(2, envelope.budget.lane_attempts)));
  const key = env.OPENROUTER_API_KEY;
  const t0 = Date.now();
  const models = [];
  const finish = (raw) => ({
    ...raw,
    models: [...models],
    lane_attempts_used: models.length,
    telemetry: { turns: 1, wall_ms: Date.now() - t0, lane_attempts_used: models.length },
    duration_ms: Date.now() - t0,
  });

  for (let i = 0; i < maxTries; i++) {
    const model = chain[i];
    models.push(model);
    let r;
    try {
      r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a task worker. Reply with a one-line result summary.' },
            { role: 'user', content: `Task ${envelope.task_ref.id}: ${envelope.prompt}` },
          ],
          max_tokens: 64,
        }),
        signal: AbortSignal.timeout(150_000),  // bounded: the lease is the semantic backstop, not the hang
      });
    } catch (e) {
      // transport throw (AbortSignal timeout / DNS / socket) — infra class
      if (i === maxTries - 1) {
        return finish({ status: 'infra_failed', detail: `lane-exhausted(${models.length}/${chain.length} lanes, last lane-transport)` });
      }
      continue;
    }
    const d = await r.json().catch(() => ({}));
    const content = d?.choices?.[0]?.message?.content || null;
    if (r.status === 200) {
      // done / empty-completion — both terminal for the turn (the lane
      // answered; no hop)
      return finish(content ? { content: String(content) } : { content: null });
    }
    if (isInfraStatus(r.status)) {
      if (i === maxTries - 1) {
        return finish({ status: 'infra_failed', detail: `lane-exhausted(${models.length}/${chain.length} lanes, last lane-${r.status})` });
      }
      continue;   // the fallback hop
    }
    // m-6 (R2-FIX): a dead/typo'd model slug (400/404 with "model" in the
    // error body) is a CONFIG condition, not work failure — the operator's
    // chain head must not burn the task's attempts. Hop to the next model
    // (config-infra); exhaustion is infra-class with the dead-model detail.
    if ((r.status === 400 || r.status === 404) && /model/i.test(String(d?.error?.message || ''))) {
      if (i === maxTries - 1) {
        return finish({ status: 'infra_failed', detail: `lane-exhausted(${models.length}/${chain.length} lanes, last dead-model-${r.status})` });
      }
      continue;
    }
    // deterministic app class (other 4xx) — terminal, no hop
    return finish({ error: { status: r.status } });
  }
  // unreachable: every loop path returns
  return finish({ status: 'infra_failed', detail: `lane-exhausted(${models.length}/${chain.length} lanes)` });
}

// ---------------------------------------------------------------------------
// MODE=cc — the CC harness turn (worker/cc-adapter.mjs, T46/W4 §1d).
//
// ccTurn(envelope, opts) returns the SAME contract return the shim implements
// (the conformance reference — C3 folded into the shim per D1; the adapter
// passes the same behavior matrix, asserted by worker/conformance-cc.mjs).
// The lane picker, the F-M8 env contract, the process-group wall kill, the
// transcript-before-report push and the door governance live THERE; this
// routing site passes the injected dependencies through (env/runId/now/log —
// the adapter stays offline-testable through the same seams runTurn exposes).
// The AdapterNotShipped class is now DEAD CODE by design (the adapter ships
// with this wave); the catch stays as the guard for a checkout that somehow
// drops the module — the mode stays routable and reports infra, never throws.
//
// F-M8 env contract (implemented in the adapter, asserted by the fake-CLI
// conformance at the spawn boundary):
//   ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
//   ANTHROPIC_AUTH_TOKEN=<the lane key>     (key pool × model chain, A5/D2)
//   ANTHROPIC_MODEL=<the lane model>        ANTHROPIC_SMALL_FAST_MODEL=<same>
//   DISABLE_TELEMETRY=1                     OX_AGENT_DEADLINE_UTC=<envelope.deadline_ms>
// ---------------------------------------------------------------------------

export class AdapterNotShipped extends Error {
  constructor(msg) { super(msg); this.name = 'AdapterNotShipped'; this.code = 'ADAPTER_NOT_SHIPPED'; }
}

async function ccWork(envelope, opts = {}) {
  try {
    const mod = await import('./cc-adapter.mjs');
    return await mod.ccTurn(envelope, opts);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(String(e?.message ?? ''))) {
      throw new AdapterNotShipped('worker/cc-adapter.mjs missing from the checkout — MODE=cc reports infra_failed cc-adapter-missing (the adapter ships with T46/W4)');
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The report payload composer — classifyOutcome's five-class result plus the
// contract extras. The FSM receiver reads outcome.status / .artifact /
// .error (journal text) / .duration_ms; telemetry + artifact_refs + models
// ride along for the audit (extra keys are ignored by the receiver).
// ---------------------------------------------------------------------------

const SLICE = 200;
const slice = (s) => String(s).slice(0, SLICE);

function composeReportOutcome(classified, raw, durationMs) {
  const outcome = { status: classified.status };
  if (classified.detail !== undefined && classified.detail !== null) outcome.error = slice(classified.detail);
  if (classified.status === 'done') {
    // the one-line result: the classifier's extracted artifact (real lane)
    // or the harness summary (the shim contract return)
    outcome.artifact = slice(classified.artifact ?? raw?.summary ?? raw?.artifact_refs?.[0] ?? '');
  }
  // the refs ride on dones (the written artifacts) AND door-poisoned turns
  // (the evidence the door flagged) — the audit trail keeps both
  if (Array.isArray(raw?.artifact_refs) && raw.artifact_refs.length) outcome.artifact_refs = raw.artifact_refs;
  if (raw?.telemetry && typeof raw.telemetry === 'object') outcome.telemetry = raw.telemetry;
  if (Array.isArray(raw?.models) && raw.models.length) outcome.models = raw.models;
  if (Number.isFinite(durationMs)) outcome.duration_ms = durationMs;
  return outcome;
}

// The visible-waste lane for a failed enqueue: the run's step summary (the
// worker's zero-API run-conclusion surface). Returns true if written.
function appendStepSummary(path, text) {
  if (!path) return false;
  try { appendFileSync(path, text); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// runTurn — the whole worker turn, every dependency injectable (the routing
// tests drive it with fake fetch/enqueue/sleep/clock; main() wires the real
// ones). Returns {reported, exitCode, ...diagnostics} — main() only maps
// exitCode onto process.exitCode.
// ---------------------------------------------------------------------------

export async function runTurn({
  cp, runId = 'local', runAttempt = '1',
  env = process.env, fetchImpl = fetch, enqueue, sleepImpl = sleep, now = Date.now,
  log = console.log, stepSummaryPath = null,
}) {
  const t0 = now();
  const eventId = reportEventId({ runId, attempt: runAttempt });
  const sleepCap = sleepCapMs(env);
  log(`WORKER-START task=${cp?.task} behavior=${cp?.behavior} attempt=${cp?.attempt} mode=${cp?.mode || 'mock'} run=${runId}`);

  // enqueue with the hardening: retry once, then the step-summary conclusion
  const enqueueHardened = async (payload) => {
    const r1 = await enqueue(payload);
    if (r1.ok) return r1;
    await sleepImpl(1000);
    const r2 = await enqueue(payload);
    if (r2.ok) return r2;
    const written = appendStepSummary(stepSummaryPath,
      `\n## fsm-worker: report enqueue FAILED (visible waste — the report never landed)\n\n` +
      `- task: \`${payload.task}\`\n- event_id: \`${payload.event_id}\`\n- outcome: \`${payload.outcome.status}\`\n- run_id: \`${payload.run_id}\`\n\n` +
      `The report could not be enqueued after retry — re-run THIS worker (the report never enqueued; the FSM retry ladder only covers enqueued reports).\n`);
    log(`WORKER-ENQUEUE-FAILED task=${payload.task} event_id=${payload.event_id} stepSummary=${written ? 'written' : 'unavailable'} (re-run this worker — the lease deadline re-covers otherwise)`);
    return r2;
  };

  // ---- LAW 1: the start-gate — BEFORE any work ---------------------------
  const gate = envelopeFromDispatch(cp, now());
  if (!gate.ok) {
    // the reason vocabulary: the deadline-in-past class reports the
    // law-1 name 'late-start'; every other fail-closed reason rides as-is
    const reason = gate.reason === 'deadline-in-past' ? 'late-start' : gate.reason;
    if (typeof cp?.task !== 'string' || cp.task === '') {
      // a dispatch without a task id cannot even be reported — loud log, exit 0
      log(`WORKER-ENVELOPE-REJECT reason=${gate.reason} detail=${slice(gate.detail ?? '')} (no task id — nothing reportable; exiting 0)`);
      return { reported: false, exitCode: 0, gate: gate.reason };
    }
    const outcome = composeReportOutcome(classifyOutcome({ status: 'infra_failed', detail: reason }), null, now() - t0);
    const payload = { event_id: eventId, task: cp.task, lease: cp.lease, outcome, run_id: runId };
    const r = await enqueueHardened(payload);
    log(`WORKER-GATE-REJECT task=${cp.task} reason=${reason} enqueue=${r.ok ? 'ok' : 'FAILED:' + r.err} (lease NOT burned — exit 0)`);
    return { reported: r.ok, exitCode: r.ok ? 0 : 2, gate: reason, outcome };
  }

  const envelope = gate.envelope;

  // ---- the harness turn (mode-routed) -------------------------------------
  let raw;
  if (envelope.mode === 'real') {
    raw = await realWork(envelope, { env, fetchImpl });
  } else if (envelope.mode === 'cc') {
    try {
      raw = await ccWork(envelope, { env, runId, now, log });
    } catch (e) {
      if (e instanceof AdapterNotShipped) {
        // the routing-level infra marker (NOT a completion payload — the
        // classifier has no slot for "harness not shipped"; minted here,
        // normalized by the same single classifyOutcome call below)
        raw = { status: 'infra_failed', detail: 'cc-adapter-missing', artifact_refs: [], summary: e.message, telemetry: { turns: 0, wall_ms: 0, lane_attempts_used: 0 } };
      } else {
        throw e;
      }
    }
  } else {
    // MODE=mock (default): the shim lane. lib/mock.mjs stays for the sims
    // (their drivers call it directly); the WORKFLOW path runs the shim.
    const seed = seedFromRunId(runId, runAttempt);
    raw = shimInvoke(envelope, cp.behavior || 'fast', seed, { workMs: cp.work_ms });
    if (raw.status === 'hang') {
      // the hang contract (see sim/harness-shim.mjs): sleep past the cap,
      // report NOTHING, exit 0 — the lease deadline is the handler
      await sleepImpl(Math.min(raw.telemetry.wall_ms, sleepCap));
      log(`WORKER-SILENT task=${cp.task} behavior=${cp.behavior} (no report by design — lease ${cp.expires} is the handler)`);
      return { reported: false, exitCode: 0, hang: true };
    }
    // the simulated wall, capped at TTL−2min (F-G(a)): slow lands late
    // (stale-lease orphan), deadline lands at the wall — the live classes
    await sleepImpl(Math.min(raw.telemetry.wall_ms, sleepCap));
  }

  // ---- the ONE normalizer + the door + the enqueue ------------------------
  let classified = classifyOutcome(raw);

  // the write-back door: a done carrying artifact_refs is governed BEFORE
  // the report is trusted — violations flip the outcome to poison (the door
  // is the governance; the branch is the tasks/<id> convention)
  if (classified.status === 'done' && Array.isArray(raw?.artifact_refs) && raw.artifact_refs.length) {
    const door = writeBackDoor({
      branch: `tasks/${cp.task}`,
      paths: raw.artifact_refs,
      allowRoot: Array.isArray(cp.artifacts) ? cp.artifacts : [],
    });
    if (!door.ok) {
      classified = {
        status: 'poison',
        detail: `write-back-door(${door.violations.join('; ').slice(0, 160)})`,
      };
    }
  }

  const durationMs = Number.isFinite(raw?.duration_ms) ? raw.duration_ms : now() - t0;
  const outcome = composeReportOutcome(classified, raw, durationMs);
  const payload = { event_id: eventId, task: cp.task, lease: cp.lease, outcome, run_id: runId };

  if (raw?.repeat_report) {
    // the duplicate-report class: same event_id enqueued twice — the
    // conductor's drain must dedup the second (ONE id per attempt — the
    // dup-behavior's two posts share it on purpose). The first enqueue is
    // hardened; the second is best-effort (its failure is meaningless —
    // the first already landed, at-least-once is satisfied).
    const r1 = await enqueueHardened(payload);
    await sleepImpl(1500);
    const r2 = await enqueue(payload);
    log(`WORKER-REPORT-DUP first=${r1.ok} second=${r2.ok} (second must be deduped by the drain)`);
    return { reported: r1.ok, exitCode: r1.ok ? 0 : 2, dup: true, outcome };
  }

  const r = await enqueueHardened(payload);
  log(`WORKER-DONE task=${cp.task} outcome=${outcome.status} enqueue=${r.ok ? 'ok' : 'FAILED:' + r.err} (${durationMs}ms)`);
  if (!r.ok) return { reported: false, exitCode: 2, outcome };
  return { reported: true, exitCode: 0, outcome };
}

// ---------------------------------------------------------------------------
// main — the real wiring (the workflow entry; everything above is testable
// with the dependencies injected).
// ---------------------------------------------------------------------------

async function main() {
  const cp = JSON.parse(process.env.EVENT || '{}').client_payload || {};
  const r = await runTurn({
    cp,
    runId: process.env.GITHUB_RUN_ID || 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    env: process.env,
    fetchImpl: fetch,
    enqueue: (report) => new Store({ cwd: process.cwd() }).enqueueReport(report),
    sleepImpl: sleep,
    now: Date.now,
    log: console.log,
    stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || null,
  });
  if (r.exitCode) process.exitCode = r.exitCode;
}

// run as the workflow entry (`node worker/turn.mjs`) — NOT on import (the
// routing tests import runTurn/realWork directly)
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch(e => {
    console.error('WORKER-FAILED:', e.message);
    // exit non-zero: the run shows failed (L0 visibility); the lease deadline
    // is the semantic handler either way.
    process.exitCode = 1;
  });
}
