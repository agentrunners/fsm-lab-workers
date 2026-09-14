// worker/turn.mjs — ONE task execution (the agent seat).
//
// Mock mode (the stress-test lane): the behavior profile IS the agent —
// deterministic, free, fast. Real mode (the seam proof): one OpenRouter
// completion stands in for the CC turn (X7).
//
// The worker NEVER writes state — it reports through a CAS-appended line on
// the state branch's report queue (data flows through git; dispatches are
// the wake mechanism only — the concurrency-group depth-1 discovery made
// run-per-report lossy: pending runs in a group are newest-wins-cancelled).
// The tick drains the queue atomically. Report semantics: at-least-once
// enqueue, exactly-once apply (event_id dedup on the conductor side).
//
// T45/F-E re-run contract (README failure-matrix row carries the same text):
// re-run ONLY workers whose report never enqueued (enqueue failure, infra
// blip). Once a report is enqueued, the FSM's retry ladder IS the retry
// mechanism — a re-run cannot improve an outcome: its report lands as a
// stale-lease ORPHAN (journaled, orphaned_reports+1), visible waste, never
// silent. Ids are attempt-scoped (rep-<run>-a<attempt>) so a re-run is never
// dedup-swallowed (the probe2 Shape-A kill).

import { mockWork } from '../lib/mock.mjs';
import { Store } from '../lib/store.mjs';
import { reportEventId } from '../lib/event-ingest.mjs';

const RUN_ID = process.env.GITHUB_RUN_ID || 'local';
const RUN_ATTEMPT = process.env.GITHUB_RUN_ATTEMPT || '1';  // T45/F-E: stable across re-runs? NO — only this increments
const EVENT_ID = reportEventId({ runId: RUN_ID, attempt: RUN_ATTEMPT });
// T44: LAB_PAT dropped — the worker NEVER dispatches (reports ride git via
// CAS-append; the report enqueue uses the checkout's git credentials, and
// the state branch accepts the ephemeral job token). Zero PAT surface here.
const CP = JSON.parse(process.env.EVENT || '{}').client_payload || {};
const MODE = CP.mode || 'mock';
// T45/F-G(a): the mock sleep cap = WORKER_TTL − 2min margin. The old cap
// (== timeout-minutes) meant the job was SIGTERM-killed ~30-60s BEFORE the
// capped sleep resolved — 'slow' degenerated to no-report and the designed
// orphaned-report lane was unreachable from the mock lane (probe5A). With
// the margin, slow's 30-min work sleeps (TTL-2)min, exits 0, reports LATE
// -> stale-lease orphan — the stat becomes reachable live.
const WORKER_TTL_MIN = parseFloat(process.env.WORKER_TTL_MIN || '20');  // keep in sync with worker.yml timeout-minutes
const SLEEP_CAP_MS = Math.max(0, (Number.isFinite(WORKER_TTL_MIN) ? WORKER_TTL_MIN : 20) - 2) * 60_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function enqueue(report) {
  const store = new Store({ cwd: process.cwd() });
  return store.enqueueReport(report);
}

async function realWork() {
  // X7: the non-deterministic-agent seam. One free-model OpenRouter
  // completion stands in for a CC turn. Proves: a real LLM call inside the
  // deterministic FSM wrapper, reported through the same lease contract.
  //
  // F-F (T45) outcome classification — infra vs work:
  //   transport throw (AbortSignal timeout / DNS / socket)  -> infra_failed 'transport-<name>'
  //   HTTP 401 / 402 / 429 / 5xx                             -> infra_failed 'openrouter-<status>'
  //     (lane/key state — operator action, not task poison; 402 = drained-
  //     with-top-up, 401 = expired key: both infra per the key-pool laws)
  //   200 + content                                          -> done
  //   200 + empty completion                                 -> failed 'empty-completion' (WORK class —
  //     the lane answered; the model produced nothing; retrying is meaningful)
  //   other 4xx                                              -> failed 'openrouter-<status>' (deterministic class)
  const key = process.env.OPENROUTER_API_KEY;
  const t0 = Date.now();
  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m3:free',
        messages: [
          { role: 'system', content: 'You are a task worker. Reply with a one-line result summary.' },
          { role: 'user', content: `Task ${CP.task}: ${CP.prompt || 'compute a one-line status report for this unit of work.'}` },
        ],
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(150_000),  // bounded: the lease is the semantic backstop, not the hang
    });
  } catch (e) {
    return { status: 'infra_failed', error: `transport-${e?.name || 'error'}`, duration_ms: Date.now() - t0 };
  }
  const d = await r.json().catch(() => ({}));
  const content = d?.choices?.[0]?.message?.content || null;
  if (r.status === 200) {
    if (content) {
      return { status: 'done', artifact: String(content).slice(0, 200), duration_ms: Date.now() - t0 };
    }
    return { status: 'failed', error: 'empty-completion', duration_ms: Date.now() - t0 };
  }
  if (r.status === 401 || r.status === 402 || r.status === 429 || r.status >= 500) {
    return { status: 'infra_failed', error: `openrouter-${r.status}`, duration_ms: Date.now() - t0 };
  }
  return { status: 'failed', error: `openrouter-${r.status}`, duration_ms: Date.now() - t0 };
}

async function main() {
  console.log(`WORKER-START task=${CP.task} behavior=${CP.behavior} attempt=${CP.attempt} mode=${MODE} run=${RUN_ID}`);
  const t0 = Date.now();

  let outcome;
  if (MODE === 'real') {
    outcome = await realWork();
  } else {
    const w = mockWork(CP.behavior, { task: CP.task, attempt: CP.attempt, workMs: CP.work_ms ?? 5000 });
    // bound the sleep: the TTL-minus-margin cap (F-G(a)); for 'hang' the
    // KILL is still the point (lease timeout handles it).
    const sleepMs = Math.min(w.sleepMs, SLEEP_CAP_MS);
    await sleep(sleepMs);
    outcome = w.outcome ? { ...w.outcome, duration_ms: Date.now() - t0 } : null;
    if (!outcome) {
      // hang / no-report: deliberately never report. Log the intent, exit 0
      // (the run itself succeeding while the WORK goes unreported is exactly
      // the failure class the lease deadline exists for).
      console.log(`WORKER-SILENT task=${CP.task} behavior=${CP.behavior} (no report by design — lease ${CP.expires} is the handler)`);
      return;
    }
    if (w.repeatReport) {
      // the duplicate-report class: same event_id enqueued twice — the
      // conductor's drain must dedup the second (ONE id per attempt — the
      // dup-behavior's two posts share it on purpose)
      const payload = {
        event_id: EVENT_ID, task: CP.task, lease: CP.lease,
        outcome, run_id: RUN_ID,
      };
      const r1 = await enqueue(payload);
      await sleep(1500);
      const r2 = await enqueue(payload);
      console.log(`WORKER-REPORT-DUP first=${r1.ok} second=${r2.ok} (second must be deduped by the drain)`);
      return;
    }
  }

  const payload = {
    event_id: EVENT_ID, task: CP.task, lease: CP.lease,
    outcome, run_id: RUN_ID,
  };
  const r = await enqueue(payload);
  console.log(`WORKER-DONE task=${CP.task} outcome=${outcome.status} enqueue=${r.ok ? 'ok' : 'FAILED:' + r.err} (${Date.now() - t0}ms)`);
  if (!r.ok) process.exitCode = 2;
}

main().catch(e => {
  console.error('WORKER-FAILED:', e.message);
  // exit non-zero: the run shows failed (L0 visibility); the lease deadline
  // is the semantic handler either way.
  process.exitCode = 1;
});
