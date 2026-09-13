// conductor/turn.mjs — ONE turn of the FSM conductor (the GHA ADAPTER).
//
// The turn ALGORITHM lives in lib/conductor-core.mjs (T44/F15: all four
// test layers — unit, store, sim, this adapter — drive the SAME drain /
// apply / commit-shaping code; the integration logic no longer lives only
// in a turn-file). The wake-event ROUTER lives in lib/event-ingest.mjs
// (T44/F16: strict payload shapes). This file keeps everything I/O-shaped:
// env parsing, the GitHub API (Retry-After-aware dispatch ladder, issue
// comments), action execution, pacing + chain continuation.
//
// Wake shapes (all consumed here, serialized by the workflow's concurrency
// group — single state writer by construction):
//   repository_dispatch fsm-tick    {client_payload: {reason, seq}}
//   repository_dispatch fsm-control {client_payload: {command, patch}}
//   repository_dispatch fsm-report  {client_payload: {event_id, task, ...}} (legacy)
//   workflow_dispatch (manual tick) / schedule (backstop tick)
//
// Turn algorithm (fail-safe ordering — commit BEFORE act):
//   1. read state (corruption -> findLastGoodState recovery)
//   2. apply(applyEvent + clock)  [pure]
//   3. commit via CAS             [state is truth]
//   4. execute actions: dispatch workers (PAT), post alerts (PAT)
//   5. self-dispatch next tick (PAT) — the chain continuation, unless
//      STOP_CHAIN/HOLD_CHAIN. A failed dispatch is retried in-turn; if the
//      self-dispatch itself dies, the WATCHDOG re-primes the chain.
//
// Ordering rationale: if we crash between 3 and 4, the lease deadline
// re-covers the un-dispatched task (timeout -> retry). If we crash between
// 4 and 5, the watchdog re-primes. Every failure state has a handler.

import { Store } from '../lib/store.mjs';
import { genesis } from '../lib/fsm.mjs';
import { mockProject, nextMilestoneFactory } from '../lib/mock-project.mjs';
import { conductorTick, makeBudget } from '../lib/conductor-core.mjs';
import { buildEvent } from '../lib/event-ingest.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const RUN_ID = process.env.GITHUB_RUN_ID || 'local';
const PAT = process.env.LAB_PAT;
// X1a finding applied: same-repo dispatches ride the EPHEMERAL job token
// (repository_dispatch is a documented exception to the anti-recursion rule
// — probe-proven run 34025596219). The PAT stays as the fallback lane.
const TOKEN = process.env.GH_TOKEN || PAT;
const EVENT = JSON.parse(process.env.EVENT || '{}');
const OPS_ISSUE = parseInt(process.env.OPS_ISSUE || '1', 10);

// F-C (T45): the job-deadline budget. RUN_STARTED_AT arrives via the explicit
// conductor.yml env mapping (R3-verified: github.run_started_at exists in the
// context but has NO default runner env var — the mapping is REQUIRED); a
// malformed value falls back to the local lane. Local fallback (no env — the
// smoke path): process start + JOB_TTL_MIN (default 10, in sync with
// timeout-minutes).
const PROC_START_MS = Date.now();
const SELF_TICK_RESERVE_MS = 30_000;  // carved out of every worker ladder FIRST (R3 D1-M2)
const MIN_CALL_MS = 30_000;           // one POST + the 20s AbortSignal cap + slack
const PARSED_TTL_MIN = parseFloat(process.env.JOB_TTL_MIN || '10');
const PARSED_START = Date.parse(process.env.RUN_STARTED_AT || '');
const BUDGET = makeBudget({
  startMs: Number.isFinite(PARSED_START) ? PARSED_START : PROC_START_MS,
  ttlMs: (Number.isFinite(PARSED_TTL_MIN) ? PARSED_TTL_MIN : 10) * 60_000,
  safetyMs: 45_000,
});

const NM = nextMilestoneFactory(mockProject());
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function api(path, method = 'GET', body = null, token = TOKEN) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-conductor',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),  // a hung call must not eat the job
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  const headers = {};
  for (const [k, v] of r.headers.entries()) headers[k.toLowerCase()] = v;
  return { status: r.status, data, headers };
}

// F6: Retry-After-aware, budget-capped, jittered. A 403+Retry-After (the
// secondary-rate-limit shape) must wait the SERVER floor, not burn all tries
// in 6s (the old fixed ladder = chain death on a transient). 403 WITHOUT
// Retry-After is a permission problem — fail fast, no retry.
// F-C (T45): the budget is CALLER-SUPPLIED ({budgetMs}) — the per-call fresh
// 240s is now the DEFAULT only; every worker ladder passes
// max(0, remaining() - SELF_TICK_RESERVE) so the first Retry-After ladder can
// never eat the heartbeat window (R3 D1-M2); the self-tick passes the full
// remaining() (the turn's LAST call). Every internal wait clamps to the
// ladder's budgetLeft; budget <= 0 aborts the ladder.
async function dispatchRetry(eventType, clientPayload, { tries = 5, budgetMs = 240_000 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await api(`/repos/${REPO}/dispatches`, 'POST', {
      event_type: eventType, client_payload: clientPayload,
    });
    if (r.status === 204) return { ok: true };
    last = r;
    const budgetLeft = budgetMs - (Date.now() - t0);
    const ra = parseInt(r.headers?.['retry-after'] || '', 10);
    if ((r.status === 403 || r.status === 429) && Number.isFinite(ra) && ra > 0) {
      if (budgetLeft <= 0) break;
      await sleep(Math.min(ra * 1000 * (1 + Math.random() * 0.2), budgetLeft));
      continue;
    }
    if (r.status === 403) return { ok: false, status: 403, fatal: true };
    if (budgetLeft <= 0) break;
    await sleep(Math.min(Math.round(2000 * (i + 1) * (0.8 + Math.random() * 0.4)), budgetLeft));
  }
  return { ok: false, status: last?.status, body: last?.data };
}

async function postIssueComment(body) {
  const r = await api(`/repos/${REPO}/issues/${OPS_ISSUE}/comments`, 'POST', { body });
  return r.status === 201;
}

// ---------------------------------------------------------------------------

function summaryMd(state, applied, reason, actions) {
  const tasks = Object.values(state.tasks);
  const by = (s) => tasks.filter(t => t.status === s).length;
  return [
    `## conductor turn — ${new Date().toISOString()}`,
    `applied=${applied} reason=${reason} version=v${state.version} chain.seq=${state.chain.seq} phase=${state.project.phase} milestone=M${state.project.milestone}`,
    '',
    `| done | failed | quarantined | cancelled | active | ready | backlog | retries | timeouts | orphaned | dispatched | infra_retries |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
    `| ${by('done')} | ${by('failed')} | ${by('quarantined')} | ${by('cancelled')} | ${by('assigned') + by('in_progress')} | ${by('ready')} | ${by('backlog')} | ${state.stats.retries} | ${state.stats.timeouts} | ${state.stats.orphaned_reports} | ${state.stats.dispatched} | ${state.stats.infra_retries} |`,
    '',
    `actions: ${actions.map(a => a.type + (a.task ? `(${a.task})` : '')).join(', ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const store = new Store({ cwd: process.cwd() });
  const ev = buildEvent(EVENT, { now });
  const t0 = Date.now();

  // 1-3. read + drain reports + apply + CAS commit — ONE atomic commit:
  // the queue drain, the event application, and the clock pass land together.
  // (The depth-1 concurrency-queue discovery: report events must NOT ride
  // workflow runs — they'd be newest-wins-cancelled. Data flows through git.)
  // The mutate closure is the one-liner: the ALGORITHM is lib/conductor-core's
  // conductorTick; the injected closures keep the store I/O here (F15).
  const DEFAULT_CFG = () => ({ max_parallel: 4, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 });
  const makeGenesis = ({ config } = {}) => {
    const cfg = config || DEFAULT_CFG();
    const mp = mockProject();
    const chainId = `c-${Date.now()}`;
    const g = genesis({ config: cfg, project: { tasks: mp.m1, milestones: 3 }, chainId, now: now() });
    return { state: g, spec: { tasks: mp.m1, milestones: 3, chainId } };
  };
  const recover = () => {
    // F-A (T45): the repair contract — walk history for the last parseable
    // snapshot; ALSO reconcile the id space with whatever the corrupt era
    // left on-branch. journalMaxId = the newest on-branch journal id (the
    // repair mints strictly above it); dropFrom = the snapshot's pre-repair
    // journal_seq (arms store.commit()'s rollback sweep: KEEP idNum < dropFrom,
    // DROP idNum >= dropFrom); droppedRecords = the sweep's audit count;
    // snapshotSha = the commit the repair rolled back TO.
    const good = store.findLastGoodState();
    const tail = store.readJournalTail(1);
    const journalMaxId = tail.length ? parseInt(String(tail[0].id || '').slice(1), 10) : NaN;
    if (good) {
      const dropFrom = good.state.journal_seq;
      return {
        state: good.state, reason: 'history-walk', snapshotSha: good.sha,
        journalMaxId, dropFrom,
        droppedRecords: store.countJournalFrom(dropFrom),
      };
    }
    // bootstrap-ON-AN-EXISTING-BRANCH: no parseable snapshot anywhere in
    // history — fresh genesis, ids still reconciled above the leftover journal
    // (no sweep: there is no snapshot-era truth to restore; the old records
    // are pre-epoch residue). A truly absent journal returns null (the plain
    // bootstrap: the state branch is fresh/empty).
    return Number.isFinite(journalMaxId) ? { state: null, reason: 'bootstrap', journalMaxId } : null;
  };
  const out = await Promise.resolve(store.commit({
    mutate: (cur, queue, controlQueue, queueBad, ctlBad) => conductorTick({
      cur, queue, controlQueue, queueBad, ctlBad, ev, now,
      nextMilestone: NM, recover, makeGenesis,
    }),
  }));

  if (!out.committed) {
    // F2/A1: QUIESCED — a held chain with empty queues. NEVER self-dispatch
    // (the old noop path restarted stopped chains; a mixed-deploy version of
    // that is a livelock at runner cadence — structurally impossible now).
    const held = out.state?.chain?.paused || out.state?.chain?.halted;
    console.log(`QUIESCED: ${out.reason}${held ? ` (chain ${out.state.chain.paused ? 'paused' : 'halted'})` : ''} — no commit, no self-dispatch`);
    return;
  }
  const state = out.state;

  // 4. execute actions (workers first — parallelism starts ASAP)
  let dispatchFailures = 0;
  let dispatchSkipped = 0;   // F-C: budget-exhausted skips (lease re-covers — loud, not fatal)
  const actionList = out.actions || [];
  for (const a of actionList) {
    if (a.type === 'DISPATCH_WORKER') {
      // F-C (R3 D1-M2, hardened): the reserve is carved out FIRST — the
      // worker ladder's budget is what remains AFTER the heartbeat window is
      // reserved, so no Retry-After ladder can starve the self-tick.
      const workerBudgetMs = Math.max(0, BUDGET.remaining() - SELF_TICK_RESERVE_MS);
      if (workerBudgetMs < MIN_CALL_MS) {
        // Skip, don't die (F-C): the lease deadline re-covers the un-dispatched
        // task (timeout -> retry) — the documented crash-between-3-and-4 model,
        // now entered deliberately and VISIBLY. Remaining only shrinks -> break.
        console.log(`DISPATCH-SKIPPED task=${a.task} budget-exhausted (worker budget ${Math.round(workerBudgetMs / 1000)}s < ${Math.round(MIN_CALL_MS / 1000)}s; turn remaining ${Math.round(BUDGET.remaining() / 1000)}s) — lease deadline re-covers (timeout -> retry)`);
        dispatchSkipped++;
        break;
      }
      const d = await dispatchRetry('fsm-task', {
        task: a.task, lease: a.lease, behavior: a.behavior,
        attempt: a.attempt, work_ms: a.work_ms, expires: a.expires,
        chain: state.chain.id,
      }, { budgetMs: workerBudgetMs });
      if (!d.ok) dispatchFailures++;
    }
    if (a.type === 'BOOTSTRAP_NOTICE') {
      await postIssueComment(`**[fsm]** BOOTSTRAP: fresh genesis committed (state branch was absent or its history was unreadable — if this is unexpected, the previous state was LOST; check the repo's branch protection and recent pushes).`);
    }
    if (a.type === 'RECOVERY_NOTICE') {
      await postIssueComment(`**[fsm]** RECOVERY: state rebuilt from a git-history snapshot (last parseable state.json). Investigate what corrupted the tip.`);
    }
  }

  // alertable journal records -> ops issue comments (bounded: quarantine is
  // terminal per task; PHASE/MILESTONE fire once each)
  for (const j of out.journal || []) {
    if (j.kind === 'REPORT' && j.to === 'quarantined') {
      await postIssueComment(`**[fsm-alert]** task ${j.task} QUARANTINED (attempts exhausted) — journal ${j.id}`);
    }
    if (j.kind === 'TIMEOUT' && j.to === 'quarantined') {
      await postIssueComment(`**[fsm-alert]** task ${j.task} QUARANTINED via lease timeout — journal ${j.id}`);
    }
    if (j.kind === 'MILESTONE') {
      await postIssueComment(`**[fsm]** milestone M${j.milestone} STARTED (${j.tasks.length} tasks)`);
    }
    if (j.kind === 'PHASE' && j.to === 'done') {
      // R2 quality-gate (T45): a completion dominated by quarantine/cancel is
      // a DEGRADED halt — the alert must not read "PROJECT COMPLETE" when
      // the work died (the probe1 kill: 0% done, invariants clean, all green).
      if (j.degraded) {
        await postIssueComment(`**[fsm-alert]** PROJECT HALTED DEGRADED — done ${state.stats.done}/${Object.keys(state.tasks).length} (quarantined=${state.stats.quarantined} cancelled=${state.stats.cancelled}); quality gate: done < 50%. Investigate the work lane before reset. stats ${JSON.stringify(state.stats)}`);
      } else {
        await postIssueComment(`**[fsm]** PROJECT COMPLETE — stats ${JSON.stringify(state.stats)}`);
      }
    }
  }

  // 5. chain continuation — with cadence pacing (config.tick_min_interval_s):
  // a fast chain (sub-10s turns) burns run records for nothing; the pace
  // sleep keeps the job occupied (free on public repos) and throttles ticks.
  // F-C: pacing under budget — min(interval-elapsed, remaining-RESERVE, 240s);
  // <= 0 skips pacing (a faster tick is harmless; the throttle is a nicety).
  const stop = actionList.some(a => a.type === 'STOP_CHAIN' || a.type === 'HOLD_CHAIN');
  let chain = { ok: true };
  let selfTickSkipped = false;
  if (!stop) {
    const intervalMs = (state.config.tick_min_interval_s || 0) * 1000;
    const elapsed = Date.now() - t0;
    const paceMs = Math.min(intervalMs - elapsed, BUDGET.remaining() - SELF_TICK_RESERVE_MS, 240_000);
    if (paceMs > 0) {
      await new Promise(res => setTimeout(res, paceMs));
    }
    // F-C: the self-tick is the turn's LAST call — it gets the FULL remaining
    // window (the reserve was already carved out of every worker ladder).
    // Under MIN_CALL_MS -> skip loudly: the watchdog/backstop revives (the
    // documented crash-between-4-and-5 model). NOTE (R3 D1-M3): a persistent
    // skip-chain does NOT alert via the watchdog latch — skip-chains still
    // apply ticks, last_tick advances, the runs stay green; the in-repo signal
    // is this log + TURN-COMPLETE + the step summary (the work-lane breaker
    // is an executor-side duty, a cross-repo dependency).
    if (BUDGET.remaining() < MIN_CALL_MS) {
      selfTickSkipped = true;
      console.log(`SELF-TICK-SKIPPED budget-exhausted (turn remaining ${Math.round(BUDGET.remaining() / 1000)}s) — watchdog/backstop revives (the documented crash-between-4-and-5 model; a persistent skip-chain is loud HERE only — see the F-C note in T45-FIX-DESIGN)`);
    } else {
      chain = await dispatchRetry('fsm-tick', { reason: 'chain', seq: state.chain.seq + 1 }, { budgetMs: BUDGET.remaining() });
    }
  }
  // summary + compact log line
  const fs = await import('node:fs');
  const appliedReason = `${out.reason || 'ok'}${dispatchFailures ? ` dispatchFailures=${dispatchFailures}` : ''}${dispatchSkipped ? ` dispatchSkipped=${dispatchSkipped}` : ''}${selfTickSkipped ? ' selfTick=skipped' : ''}`;
  fs.default.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null',
    summaryMd(state, true, appliedReason, actionList) + '\n');
  console.log(`TURN-COMPLETE applied=true reason=${appliedReason} v=${state.version} seq=${state.chain.seq} `
    + `done=${state.stats.done}/${Object.keys(state.tasks).length} phase=${state.project.phase} `
    + `actions=${actionList.length} chain=${stop ? "stopped" : selfTickSkipped ? "SELF-TICK-SKIPPED(watchdog/backstop revives)" : chain.ok ? "ok" : "DISPATCH-FAILED(watchdog will re-prime)"}`);

  if (!chain.ok) {
    console.error(`self-dispatch failed: HTTP ${chain.status}`);
    process.exitCode = 3;
  }
}

main().catch(e => {
  console.error('CONDUCTOR-FAILED:', e.message);
  process.exitCode = 1;
});
