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
//   repository_dispatch fsm-report  {client_payload: {event_id, task, ...}} (legacy — no workflow registers this type; the router branch is kept for payload-shape strictness: a write-access direct dispatch of it must still route, not mis-route)
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
import { genesis, apply } from '../lib/fsm.mjs';
import { mockProject, nextMilestoneFactory } from '../lib/mock-project.mjs';
import {
  conductorTick, makeBudget, assembleDispatchPayload, dispatchVerificationEvents,
  DISPATCH_COST_MS, VERIFY_WINDOW_MS, specEpoch, dispatchBudgetFromWall,
  verifyScanRunsPath, seenKeysFromRuns, verifyScanRepoList, VERIFY_SCAN_PER_PAGE, VERIFY_SCAN_SLACK_MS,
  dispatchLadder, workerOverflowDecision, overflowPreFlight, priorInFlightCount, WORKER_OVERFLOW_AT_DEFAULT,
  overflowThreshold, chainContinuationDecision,
} from '../lib/conductor-core.mjs';
import { buildEvent, mintEventId } from '../lib/event-ingest.mjs';
import { prFlow, prFlowCandidates } from '../lib/task-pr.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const API = process.env.GITHUB_API_URL || 'https://api.github.com'; // T9 (s21) seam: GHA sets this env itself — unset -> the literal, byte-identical
const RUN_ID = process.env.GITHUB_RUN_ID || 'local';
const PAT = process.env.LAB_PAT;
// T46/ar (20-e): the SECOND-BUCKET overflow lane. WORKER_REPO_2 (repo
// variable, e.g. agentrunners/fsm-lab-workers; unset/empty = NO lane —
// today's dispatch path bit-for-bit) + WORKER_OVERFLOW_AT (repo variable;
// unset/bad = the core's default 6). The lane engages per-dispatch in the
// action loop below — T46/s21 C-2: PRE-FLIGHT (overflowPreFlight, the
// occupancy arm, before any wire attempt) + the saturated-ladder fallback
// (workerOverflowDecision, after a FAILED main attempt); the PAT is
// REQUIRED — a cross-repo dispatch cannot ride the ephemeral job token (X1a).
const WORKER_REPO_2 = process.env.WORKER_REPO_2 || null;
const WORKER_OVERFLOW_AT = parseInt(process.env.WORKER_OVERFLOW_AT || '', 10) || WORKER_OVERFLOW_AT_DEFAULT;
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
  const r = await fetch(`${API}${path}`, {
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

// F6: Retry-After-aware, budget-capped, jittered — the LOGIC lives in the
// core's dispatchLadder (T46/ar: extracted so the routing is behaviorally
// pinnable; identical statuses/jitter/budget clamps). 403+Retry-After (the
// secondary-rate-limit shape) waits the SERVER floor; 403 WITHOUT
// Retry-After is a permission problem — fail fast, no retry. The default
// target is THIS repo on the ephemeral job token (X1a); {repo, token}
// re-target the overflow lane's second-bucket dispatch on the PAT.
async function dispatchRetry(eventType, clientPayload, { tries = 5, budgetMs = 240_000, repo = REPO, token } = {}) {
  return dispatchLadder({ eventType, clientPayload, api, repo, token, tries, budgetMs, sleep });
}

async function postIssueComment(body) {
  const r = await api(`/repos/${REPO}/issues/${OPS_ISSUE}/comments`, 'POST', { body });
  return r.status === 201;
}

// T46/W-C1 (F-8): the budget-pause alert lane — the established
// fsm-watchdog-alert issue shape (find open → comment; none → open). EVERY
// POST result is checked (law 5): failure propagates as {ok:false} and the
// turn goes RED with the chain still self-ticking (the window re-triggers
// the attempt next tick — the correlated-failure self-heal).
async function budgetAlertIssue(action) {
  const body = [
    '**[fsm-alert] Lane budget exhausted — epoch PARKED.**',
    '',
    `Trigger: ${action.backstop ? 'infra-exhausted backstop (a task\'s full infra ladder burned on quota-shaped failures)' : `distinct-tasks (${action.tasks.length} ≥ threshold) with quota-shaped infra reports inside the pause window`}.`,
    `Tasks: ${action.tasks.join(', ')}`,
    `Observed detail (verbatim): \`${action.detail}\``,
    '',
    'Window (task · detail):',
    ...(action.window || []).slice(0, 10).map(e => `- ${e.task} · ${e.detail}`),
    '',
    'The chain is **paused** — zero further dispatches until resumed. This is the structural fix for the X21 12-task quarantine burn.',
    '',
    '**Resume** (after the quota resets — daily UTC rollover for OpenRouter free tiers):',
    '```',
    `gh api -X POST repos/${REPO}/dispatches -f event_type=fsm-control -F 'client_payload[command]=resume'`,
    '```',
    '(or workflow_dispatch fsm-ops with command=resume)',
  ].join('\n');
  const fr = await api(`/repos/${REPO}/issues?state=open&labels=fsm-watchdog-alert&per_page=10`);
  if (fr.status !== 200 || !Array.isArray(fr.data)) return { ok: false, where: 'search' };
  if (fr.data.length) {
    const cr = await api(`/repos/${REPO}/issues/${fr.data[0].number}/comments`, 'POST', { body });
    return cr.status === 201 ? { ok: true, issue: fr.data[0].number } : { ok: false, where: 'comment' };
  }
  const or = await api(`/repos/${REPO}/issues`, 'POST', {
    title: '[fsm-alert] lane budget exhausted — epoch parked',
    body, labels: ['fsm-watchdog-alert'],
  });
  return or.status === 201 && or.data?.number ? { ok: true, issue: or.data.number } : { ok: false, where: 'open' };
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
  // T46/W2 (F-B2 conductor half): the epoch MODE — cold-start genesis and
  // every reset mint project.mode from this env (operator-switched: the X21
  // synthetic CC epoch = set EPOCH_MODE=cc + reset; the default stays mock).
  // genesis() validates it (GENESIS_MODES); a bad value fails the genesis —
  // loud, never a silent wrong-mode epoch.
  const EPOCH_MODE = process.env.EPOCH_MODE || 'mock';
  // T46/W-C1 (§2e/F-5): makeGenesis gained the SPEC + ISSUE params — the
  // intake rollover and reset {from_queue} build the epoch from a queued
  // spec (validated at the door); the plain paths keep mockProject. The
  // spec's own mode (validated against GENESIS_MODES at the door) wins;
  // absent → the operator's EPOCH_MODE env (the X21 switch, unchanged).
  const makeGenesis = ({ config, spec, issue, bodySha8 } = {}) => {
    const cfg = config || DEFAULT_CFG();
    const chainId = `c-${Date.now()}`;
    if (spec) {
      // specEpoch (conductor-core) is the CANONICAL mapper — the door's
      // pure half parity-pins the same shape at integration. s22/B-1: a
      // spec carrying a `tasks` array (the door's multi-task form) maps
      // EVERY entry through specToTask; a plain spec maps its single task —
      // ONE mapper for both lanes.
      // T46/W-C1-R (lens-1 BLOCKING-1 adapter half): spec epochs carry
      // milestones_total=1 — the task IS the project; the clock's
      // milestones_total bound (fsm.mjs pass 5) then NEVER consults the
      // mock drill's generator for an intake epoch (the live sprout bug:
      // every intake epoch ran the mock M2+M3 — ~10 phantom dispatches —
      // before the rollover could fire). s22/B-1 keeps milestones_total=1
      // for the MULTI-task form too ("the task SET is the project") —
      // B-1's `milestones_total = tasks.length` formula would fire the
      // generator at milestone 1 < N and re-sprout the exact bug the
      // bound killed (see specEpoch's comment + the no-sprout pin). The
      // spec's (and each entry's) `milestone` key stays door-validated
      // metadata for W-D's milestone-aware epochs (inert here).
      const ep = specEpoch(spec, { issue, bodySha8: bodySha8 || `i${issue}` });
      const g = genesis({ config: cfg, project: ep, chainId, now: now(), mode: spec.mode || EPOCH_MODE, issue: issue ?? null });
      return { state: g, spec: { tasks: ep.tasks, milestones: ep.milestones, chainId, mode: g.project.mode } };
    }
    const mp = mockProject();
    const g = genesis({ config: cfg, project: { tasks: mp.m1, milestones: 3 }, chainId, now: now(), mode: EPOCH_MODE });
    return { state: g, spec: { tasks: mp.m1, milestones: 3, chainId, mode: g.project.mode } };
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
  // T46/W2 (law-4): the runs fetch is guarded — one API call ONLY when some
  // task's lease has aged past the pre-window (360s), else zero cost on
  // quiet ticks. The fetch is PRE-COMMIT (the mutate stays I/O-free); a
  // stale peek fails OPEN (no flip, the reaper backstops — same doc as the
  // quiet guard). Matching key: worker.yml's run-name
  // `task-<id> · <behavior> · a<attempt>` → `${taskId}#a${attempt}`.
  // M-A1/M-B1 (46-R2, convergent): the scan is per_page=100 with a
  // created>= floor at (oldest in-window lease issued_at − 900s) and the
  // keys are TIME-CORRELATED against each task's lease.issued_at —
  // name-only, page-1-only matching was blind at every reset (prior-epoch
  // id reuse suppressed the flip) and wrong under churn (a 21st newer run
  // pushed the in-window run off the old 20-run page and flipped a LIVE
  // task). See verifyScanRunsPath/seenKeysFromRuns in conductor-core.
  // T46/s21 C-1 (audit a1, BLOCKING): the scan is a UNION — main's runs
  // PLUS the overflow lane's second bucket (agentrunners stand-in), because
  // a repo2-only dispatch has its ONLY run there and a main-only scan would
  // flip it 'dispatch-unverified' at the 720s window while the mirror
  // worker is still grinding. The second fetch rides the PAT (the job
  // token is same-repo scoped, X1a; the PAT already performs the cross-repo
  // dispatch). ANY per-repo fetch failure fails the WHOLE scan open
  // (seenKeys stays null -> zero flips; the lease reaper backstops) —
  // partial keys would flip every repo2-dispatched task, which is exactly
  // the C-1 bug shape the union exists to kill.
  let seenDispatchKeys = null;
  let verifyNowMs = null;
  {
    store.fetch();
    const peek = store.readState();
    const st = peek && peek.state;
    const preWindowMs = VERIFY_WINDOW_MS / 2;
    let oldestIssuedMs = NaN;   // the created>= floor anchor
    let needsScan = false;
    for (const t of (st && st.tasks ? Object.values(st.tasks) : [])) {
      if ((t.status === 'assigned' || t.status === 'in_progress') && t.lease) {
        const issuedMs = Date.parse(t.lease.issued_at || '');
        if (Number.isFinite(issuedMs) && (Date.now() - issuedMs) > preWindowMs) {
          needsScan = true;
          if (!Number.isFinite(oldestIssuedMs) || issuedMs < oldestIssuedMs) oldestIssuedMs = issuedMs;
        }
      }
    }
    if (needsScan) {
      const scanRepos = verifyScanRepoList(REPO, WORKER_REPO_2, PAT);
      const runs = [];
      let scanOk = true;
      for (const sr of scanRepos) {
        const rr = await api(verifyScanRunsPath(sr, oldestIssuedMs), 'GET', null, sr === REPO ? TOKEN : PAT);
        if (rr.status === 200 && Array.isArray(rr.data?.workflow_runs)) {
          const repoRuns = rr.data.workflow_runs;
          runs.push(...repoRuns);
          if (repoRuns.length >= VERIFY_SCAN_PER_PAGE) {
            // the observable signal of the un-paginated tail. NO pagination
            // loop: the created floor keeps the in-window tail covered and a
            // bounded tick matters more.
            console.log(`VERIFY-SCAN-PAGE-FULL repo=${sr} runs=${repoRuns.length} per_page=${VERIFY_SCAN_PER_PAGE} — runs past this page are invisible to the scan (created floor covers the in-window tail; no pagination loop, the bounded tick wins)`);
          }
        } else {
          scanOk = false;
          console.log(`VERIFY-SCAN-SKIPPED repo=${sr} runs-fetch HTTP ${rr.status} (fail-open — the lease reaper backstops)`);
        }
      }
      if (scanOk) {
        seenDispatchKeys = seenKeysFromRuns(runs, (st && st.tasks) || {});
        verifyNowMs = Date.now();
        console.log(`VERIFY-SCAN repos=${scanRepos.length} runs=${runs.length} keys=${seenDispatchKeys.size} created-floor=${Number.isFinite(oldestIssuedMs) ? new Date(oldestIssuedMs - VERIFY_SCAN_SLACK_MS).toISOString() : 'none'} (tasks past the ${Math.round(preWindowMs / 1000)}s pre-window)`);
      }
    }
  }
  const out = await Promise.resolve(store.commit({
    mutate: (cur, queue, controlQueue, queueBad, ctlBad, intakeQueue, intakeBad) => conductorTick({
      cur, queue, controlQueue, queueBad, ctlBad, intakeQueue, intakeBad, ev, now,
      nextMilestone: NM, recover, makeGenesis,
      seenDispatchKeys, verifyNowMs,
      // T46/W-C1 (F-10): the dispatch budget — slot count from the JOB
      // deadline, self-tick reserve carved FIRST (R3 D1-M2). The fn receives
      // the SPENT slot count (tick-wide + pass): each assign+dispatch pair
      // spends DISPATCH_COST_MS of remaining. Exhausted → tasks stay READY
      // (never assigned — the skip-left-assigned class is dead). The
      // arithmetic lives in conductor-core's dispatchBudgetFromWall (the
      // W-C1-R MUT-c fold: extracted so the pin bites the REAL code, not a
      // string-shape source check).
      dispatchBudgetFn: (spent) => dispatchBudgetFromWall({
        remainingMs: BUDGET.remaining(), reserveMs: SELF_TICK_RESERVE_MS, costMs: DISPATCH_COST_MS, spent,
      }),
    }),
  }));

  if (!out.committed) {
    // F2/A1: QUIESCED — a held chain with empty queues. NEVER self-dispatch
    // (the old noop path restarted stopped chains; a mixed-deploy version of
    // that is a livelock at runner cadence — structurally impossible now).
    // T46/W-C2-R (F4, live-confirmed by the X22 verify tick 35298996619):
    // the PR flow is the ONE piece of post-completion work that still runs
    // on a quiesced tick — a halted epoch has no other ticks coming, and its
    // declared-artifact tasks' PRs would otherwise NEVER open (lens-1 F4:
    // deferred forever, silently). The stamps are legitimate commits; the
    // NEXT tick quiesces truly (pr set → candidates empty).
    if ((out.prCandidates || []).length) {
      try {
        const prr = await prFlow({
          candidates: out.prCandidates, state: out.state, repo: REPO, api, store,
          tokenFallback: PAT || null,
          alert: (msg) => postIssueComment(msg),
          log: console.log,
        });
        console.log(`PR-FLOW (quiesced path) candidates=${prr.candidates} opened=${prr.opened} reused=${prr.reused} stamped=${prr.stamped} failures=${prr.failures} deferred=${prr.deferred}`);
      } catch (e) {
        console.log(`PR-FLOW-FAILED (quiesced path) ${String(e?.message ?? e).slice(0, 200)} (law 5: visible, non-fatal — a manual tick retries)`);
        await postIssueComment(`**[fsm-alert]** the PR flow FAILED on a quiesced tick — ${String(e?.message ?? e).slice(0, 160)}. A halted chain will not retry automatically; dispatch a manual fsm-tick.`);
      }
    }
    const held = out.state?.chain?.paused || out.state?.chain?.halted;
    console.log(`QUIESCED: ${out.reason}${held ? ` (chain ${out.state.chain.paused ? 'paused' : 'halted'})` : ''} — no commit, no self-dispatch${(out.prCandidates || []).length ? ' (the PR flow ran first)' : ''}`);
    return;
  }
  const state = out.state;

  // 4. execute actions (workers first — parallelism starts ASAP)
  let dispatchFailures = 0;
  let dispatchSkipped = 0;   // F-C: budget-exhausted skips (lease re-covers — loud, not fatal)
  const actionList = out.actions || [];
  // T46/W2 (F-B2): the brief rides every dispatch AS QUOTED DATA; the mode
  // comes from the epoch (state.project.mode — W1's genesis field). Read
  // ONCE per turn; absent brief omits cleanly.
  let briefMd = null;
  try {
    const fsMod = await import('node:fs');
    briefMd = fsMod.default.readFileSync('briefs/project.md', 'utf8');
  } catch { /* absent brief — the envelope omits it cleanly */ }
  const epochMode = state.project?.mode || 'mock';
  let dispatchIndex = 0;
  // T46/ar (20-e): the overflow lane's occupancy base — the leases that were
  // outstanding BEFORE this tick's dispatches (the committed state's active
  // count minus this turn's DISPATCH_WORKER assigns); the loop's
  // dispatchIndex adds each already-dispatched one as the loop runs.
  const priorInFlight = priorInFlightCount(state, actionList);
  for (const a of actionList) {
    if (a.type === 'DISPATCH_WORKER') {
      dispatchIndex++;
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
      // T46/W2 (F-B2): the envelope payload — SUPERSET of the legacy shape
      // (old workers ignore the extras; new workers route through
      // envelopeFromDispatch). prompt carries the brief AS QUOTED DATA;
      // deadline_ms is minted HERE (absolute, queue-delay-proof).
      // A-2 (46-R2): run_id rides the action so the envelope's session
      // stops minting the permanent 'pending' run-id (this conductor run's
      // id — the audit trail's dispatch-turn discriminator).
      const payload = assembleDispatchPayload(
        { ...a, chain: state.chain.id, run_id: RUN_ID },
        state.tasks[a.task] || null,
        briefMd,
        { nowMs: Date.now(), mode: epochMode },
      );
      // T46/s21 C-2 (audit a1, MAJOR — the double-dispatch): the target is
      // decided BEFORE any wire attempt. The occupancy arm (in-flight >=
      // overflow threshold) is PRE-FLIGHT: this dispatch goes STRAIGHT to
      // WORKER_REPO_2 and the same-repo attempt is SKIPPED — the old shape
      // ran the main ladder first (204) and then re-sent the SAME payload to
      // the second bucket: two workers grinding one task, 2x paid-key burn,
      // the second report an orphan. The saturated-ladder fallback (a FAILED
      // main attempt in the 403/429-with-Retry-After class) stays post-
      // attempt — that is the true bucket-pressure shape. The ENVELOPE is
      // unchanged either way: the second bucket's workers read client_payload
      // identically — their worker.yml TARGET_REPO checks out the MAIN repo
      // and the report CAS-append follows the CHECKOUT (worker/turn.mjs's
      // Store rides the checkout's origin), so the report lands on the MAIN
      // fsm-state. Unset WORKER_REPO_2 -> both decisions return false for
      // any input (byte-identical today path).
      // s22/B-1 (the s22/Q1 adjudication): the threshold's PRECEDENCE — the
      // STATE view wins (overflowThreshold: config.overflow_at ?? the
      // env-parsed lane value ?? DEFAULT folded in the env parse): a drill
      // epoch carries its own capacity posture (the spec's door-validated
      // overflow_at, carried into the genesis config at the rollover /
      // reset from_queue) while the repo var stays at whatever posture
      // production wants. Absent in the config -> the env lane stands,
      // byte-identical to the pre-B-1 wiring.
      const pre = overflowPreFlight({
        inFlightNow: priorInFlight + dispatchIndex - 1,
        repo2: WORKER_REPO_2, pat: PAT, overflowAt: overflowThreshold(state.config, WORKER_OVERFLOW_AT),
      });
      let d;
      if (pre.overflow) {
        console.log(`DISPATCH-OVERFLOW-PREFLIGHT task=${a.task} ${pre.reason} -> ${WORKER_REPO_2} (the LAB_PAT lane; the same-repo attempt is SKIPPED — exactly one dispatch, one bucket; envelope unchanged — the bucket-2 worker checks out TARGET_REPO and reports to the MAIN fsm-state)`);
        d = await dispatchRetry('fsm-task', payload, { budgetMs: workerBudgetMs, repo: WORKER_REPO_2, token: PAT });
      } else {
        d = await dispatchRetry('fsm-task', payload, { budgetMs: workerBudgetMs });
        const ov = workerOverflowDecision({ d, repo2: WORKER_REPO_2, pat: PAT });
        if (ov.overflow) {
          console.log(`DISPATCH-OVERFLOW task=${a.task} ${ov.reason} -> ${WORKER_REPO_2} (the LAB_PAT lane; the main attempt FAILED saturated — envelope unchanged, the bucket-2 worker reports to the MAIN fsm-state)`);
          d = await dispatchRetry('fsm-task', payload, { budgetMs: workerBudgetMs, repo: WORKER_REPO_2, token: PAT });
        }
      }
      if (!d.ok) {
        // X21 lesson: 4 dispatchFailures with ZERO logged detail (the 422
        // 10-property limit took a whole debugging round to find) — the
        // failure's STATUS + body slice are always visible now
        dispatchFailures++;
        console.log(`DISPATCH-FAILED task=${a.task} HTTP=${d.status ?? 'none'} body=${String(JSON.stringify(d.body) ?? '').slice(0, 200)}`);
      }
    }
    if (a.type === 'BOOTSTRAP_NOTICE') {
      await postIssueComment(`**[fsm]** BOOTSTRAP: fresh genesis committed (state branch was absent or its history was unreadable — if this is unexpected, the previous state was LOST; check the repo's branch protection and recent pushes).`);
    }
    if (a.type === 'RECOVERY_NOTICE') {
      await postIssueComment(`**[fsm]** RECOVERY: state rebuilt from a git-history snapshot (last parseable state.json). Investigate what corrupted the tip.`);
    }
  }

  // T46/W-C2 (§4/F-4/m-3) — the task-branch/PR flow. W-C2-R (L2-2): AFTER
  // the worker-dispatch loop (workers first — the PR ladder must never eat
  // the F-C-reserved dispatch/self-tick budget) and BEFORE the journal-scan
  // comments (the intake completion comment below carries the links, m-3).
  // W-C2-R (F7): the candidates come from conductorTick's PRE-ROLLOVER
  // view (out.prCandidates) — a same-tick intake rollover replaces
  // out.state with the NEXT epoch and the completing epoch's PRs would
  // otherwise vanish. Budget-guarded (L2-2): a thin remainder defers to the
  // next tick + alerts (a halted epoch's deferral must be VISIBLE — F4).
  let prFlowResult = null;
  if ((out.prCandidates || []).length) {
    if (BUDGET.remaining() < 90_000) {
      console.log(`PR-FLOW-DEFERRED candidates=${out.prCandidates.length} budget=${Math.round(BUDGET.remaining() / 1000)}s (next tick retries; a halted chain needs a manual tick)`);
      await postIssueComment(`**[fsm-alert]** PR flow DEFERRED (${out.prCandidates.length} candidate(s), turn budget exhausted) — a halted chain will not retry automatically; dispatch a manual fsm-tick or open the PRs from the \`tasks/<id>\` branches.`);
    } else {
      try {
        prFlowResult = await prFlow({
          candidates: out.prCandidates, state, repo: REPO, api, store,
          tokenFallback: PAT || null,   // the LAB_PAT lane (PAT PR-creation needs no repo setting — live-proven PR#5)
          alert: (msg) => postIssueComment(msg),
          log: console.log,
        });
        console.log(`PR-FLOW candidates=${prFlowResult.candidates} opened=${prFlowResult.opened} reused=${prFlowResult.reused} stamped=${prFlowResult.stamped} failures=${prFlowResult.failures} deferred=${prFlowResult.deferred}`);
      } catch (e) {
        // W-C2-R (L2-6): the whole-flow death is law-5 VISIBLE (the log-only
        // shape left a persistent structural failure invisible outside the
        // Actions log browser) — the epoch still runs; the next tick retries.
        console.log(`PR-FLOW-FAILED ${String(e?.message ?? e).slice(0, 200)} (non-fatal — the next tick retries via the reuse lane)`);
        await postIssueComment(`**[fsm-alert]** the PR flow itself FAILED this tick — ${String(e?.message ?? e).slice(0, 160)}. The next tick retries via the reuse lane; if this repeats, read the conductor run log.`);
      }
    }
  }

  // alertable journal records -> ops issue comments (bounded: quarantine is
  // terminal per task; PHASE/MILESTONE fire once each)
  // T46/W-C1: the scan also serves the intake thread (m-3) — the rollover's
  // "epoch started" note and the PHASE-done completion comment target the
  // INTAKE issue (project.issue) in addition to the ops console.
  for (const j of out.journal || []) {
    if (j.kind === 'REPORT' && j.to === 'quarantined') {
      await postIssueComment(`**[fsm-alert]** task ${j.task} QUARANTINED (attempts exhausted) — journal ${j.id}`);
    }
    if (j.kind === 'TIMEOUT' && j.to === 'quarantined') {
      await postIssueComment(`**[fsm-alert]** task ${j.task} QUARANTINED via lease timeout — journal ${j.id}`);
    }
    // s21/O-4 (audit a5, MAJOR): the CONTROL-REJECTED arm — the false
    // confirmation is dead. The console's ack says "next tick applies"; the
    // drain can REJECT the control (bad-patch-key / bad-patch bounds /
    // configure-noop / reset-duplicate / unparseable), and before this arm
    // the operator learned NOTHING (a log line + the REJECTED journal record
    // only) while believing the knob landed — the feedback loop broke at the
    // drain, the exact class law-5 exists to prevent. ONE comment cites the
    // journal id + the reason; the event_id (the console-minted
    // ctl-<nodeId>-<cmd>-<clockMs>) joins the ack's audit trail. The
    // 'duplicate' class is the F11 re-delivery artifact — never alerted, or
    // a redelivered queue line would re-post the same rejection.
    // s22/M-1 + R2-3 (lens-1 MAJOR): 'reset-duplicate' joins the exclusion —
    // it is the twin of an APPLIED reset (the F-1 same-drain guard doing its
    // job), not a failed control. Alerting it told the operator to "fix the
    // patch and re-send" a reset that ALREADY APPLIED — the re-send lands on
    // a live epoch and destroys it (epoch wipe through the alert's own
    // advice). The twin journals REJECTED + the log line; that is the whole
    // visible trace it needs.
    if (j.kind === 'REJECTED' && j.origKind === 'CONTROL' && j.reason !== 'duplicate' && j.reason !== 'reset-duplicate') {
      // s22/m-4: the O-4 alert POST is CHECKED — a non-201 logs LOUDLY (the
      // same law-5 shape every other alert lane carries). The operator's
      // broken-knob feedback loop breaks TWICE if the rejection alert itself
      // dies silently: the console ack said queued, the drain rejected, and
      // the tell-the-operator comment vanished — the knob looks landed.
      const okRejected = await postIssueComment(`**[fsm-alert]** control REJECTED — ${j.command || 'control'}: ${j.reason} (journal ${j.id}${j.event_id ? ` · event ${j.event_id}` : ''}) — the console ack did NOT land; fix the patch and re-send.`);
      if (!okRejected) console.log(`CONTROL-REJECTED-ALERT-FAILED journal=${j.id} command=${j.command || 'control'} (law 5: visible, non-fatal — the REJECTED record is the durable signal; the next rejected control re-attempts the comment)`);
    }
    if (j.kind === 'BUDGET') {
      // F-10: the observable pacing signal — one log line per exhausted tick
      console.log(`DISPATCH-PACED budget=${j.budget} ready_remaining=${j.ready_remaining} — tasks stay ready, next tick re-assigns (journal ${j.id})`);
    }
    if (j.kind === 'MILESTONE') {
      await postIssueComment(`**[fsm]** milestone M${j.milestone} STARTED (${j.tasks.length} tasks)`);
    }
    if (j.kind === 'CONTROL' && j.command === 'reset' && typeof j.note === 'string' && j.note.startsWith('intake-rollover')) {
      // m-3: the intake thread's "epoch started" note — rides the rollover's
      // journal record (one extra POST per epoch boundary, never per tick)
      const issueN = state.project?.issue;
      if (issueN) {
        const r = await api(`/repos/${REPO}/issues/${issueN}/comments`, 'POST', { body: `**[fsm]** Epoch started for this task (chain ${state.chain.id}) — the conductor will dispatch workers and report completion here. ${j.note}` });
        if (r.status !== 201) console.log(`INTAKE-COMMENT-FAILED issue=${issueN} HTTP=${r.status} (law 5: visible, non-fatal — the epoch still runs)`);
      }
    }
    if (j.kind === 'PHASE' && j.to === 'done') {
      // R2 quality-gate (T45): a completion dominated by quarantine/cancel is
      // a DEGRADED halt — the alert must not read "PROJECT COMPLETE" when
      // the work died (the probe1 kill: 0% done, invariants clean, all green).
      // W-C2-R (F7-adjacent): the stats/tasks come from the JOURNAL RECORD
      // (the COMPLETING epoch's own view — a same-tick rollover replaced
      // the live state with the next epoch's zeroed stats).
      const cStats = j.stats || state.stats;
      const cTaskCount = j.stats?.taskCount ?? Object.keys(state.tasks).length;
      if (j.degraded) {
        await postIssueComment(`**[fsm-alert]** PROJECT HALTED DEGRADED — done ${cStats.done}/${cTaskCount} (quarantined=${cStats.quarantined} cancelled=${cStats.cancelled}); quality gate: done < 50%. Investigate the work lane before reset. stats ${JSON.stringify(cStats)}`);
      } else {
        await postIssueComment(`**[fsm]** PROJECT COMPLETE — stats ${JSON.stringify(cStats)}`);
      }
      // m-3: an intake-born epoch's completion comment targets the intake
      // issue too (X22's criterion: the operator's thread gets the outcome).
      // T46/W-C2: the comment carries the PR links from the PR flow's RETURN
      // (W-C2-R F7/m4/L2-3: the rollover case's stamps cannot land in the
      // live state — the links ride prFlowResult; ALL done candidates link,
      // not just the first).
      const issueN = j.issue ?? state.project?.issue;
      if (issueN) {
        const prLinks = (prFlowResult?.links || []).map(l => `- task \`${l.id}\` → PR #${l.prn}${l.closed ? ' (closed/merged — the write-back landed)' : ' — the artifacts await review/merge'}`).join('\n');
        const linksBlock = prLinks ? `\n\n**Pull requests**:\n${prLinks}` : '';
        const digest = (prFlowResult?.links || []).length && (out.prCandidates || [])[0]?.task?.last_result?.artifact
          ? `\n\nResult digest: ${String(out.prCandidates[0].task.last_result.artifact).slice(0, 600)}` : '';
        const r = await api(`/repos/${REPO}/issues/${issueN}/comments`, 'POST', { body: `**[fsm]** Epoch ${j.degraded ? 'HALTED DEGRADED' : 'COMPLETE'} for this task — done ${cStats.done}/${cTaskCount}${digest}${linksBlock}\n\n(stats ${JSON.stringify(cStats)})` });
        if (r.status !== 201) console.log(`INTAKE-COMMENT-FAILED issue=${issueN} HTTP=${r.status} (law 5: visible, non-fatal)`);
      }
    }
  }

  // T46/W-C1 (F-8): the lane-budget pause — ALERT FIRST, then the pause
  // event in a SECOND commit. Order: (1) open/comment the fsm-watchdog-alert
  // issue; (2) failure → the turn goes RED (law 5) with NO pause committed —
  // the chain self-ticks, the persisted window re-triggers next tick (the
  // correlated-failure self-heal); (3) success → mint + apply the pause
  // CONTROL event (id ctl-<alertIssue#>-budget-pause-<ms>) → HOLD_CHAIN.
  // Honest residual (documented, sim4 scenario 5 pins it): the trigger
  // tick's already-dispatched in-flight leases expire once under the pause
  // and the reaper re-queues them — ≤1 work attempt on ≤threshold tasks;
  // every NOT-yet-dispatched task keeps 0 (the X21 12×3 burn is dead).
  let pausedNow = false;
  const pauseAction = actionList.find(a => a.type === 'BUDGET_PAUSE_ALERT');
  if (pauseAction) {
    const alert = await budgetAlertIssue(pauseAction);
    if (!alert.ok) {
      console.error(`ALERT-POST-FAILED (${alert.where}) — NO pause committed; the chain self-ticks and the window re-triggers next tick (law 5: this run is RED)`);
      process.exitCode = 1;
    } else {
      const pauseEv = {
        kind: 'CONTROL', command: 'pause',
        payload: { reason: 'lane-budget-exhausted', window: pauseAction.window },
        event_id: mintEventId('CONTROL', { nodeId: String(alert.issue), command: 'budget-pause', clockMs: Date.now() }),
        ts: now(),
      };
      let out2;
      try {
        out2 = await Promise.resolve(store.commit({
          mutate: (cur2, q2, cq2) => {
            // queues that landed between the two commits are NOT consumed —
            // they rewrite unchanged for the next tick (never dropped).
            // W-C1-R (lens-2 m1): the store THROWS when CAS retries exhaust
            // (it never returns a noop commit) — the try/catch makes the
            // failure observable AS the budget-pause path (log + red +
            // self-tick + watchdog recovery) instead of the generic
            // CONDUCTOR-FAILED death with no TURN-COMPLETE.
            const r = apply(cur2, pauseEv, now(), NM, {});
            return { state: r.state, journal: r.journal, actions: r.actions, queue: q2, controlQueue: cq2 };
          },
        }));
      } catch (e) {
        console.error(`BUDGET-PAUSE-COMMIT-FAILED (${String(e?.message ?? e).slice(0, 160)}) — the window re-triggers next tick; run is RED`);
        process.exitCode = 1;
        out2 = null;
      }
      if (out2 && out2.committed) {
        pausedNow = true;
        console.log(`BUDGET-PAUSE applied (alert issue #${alert.issue}, event ${pauseEv.event_id}) — chain PAUSED, zero further dispatches; resume via the alert's command`);
      } else if (out2) {
        console.error(`BUDGET-PAUSE-COMMIT-NOT-COMMITTED (${out2.reason}) — the window re-triggers next tick; run is RED`);
        process.exitCode = 1;
      }
    }
  }

  // 5. chain continuation — with cadence pacing (config.tick_min_interval_s):
  // a fast chain (sub-10s turns) burns run records for nothing; the pace
  // sleep keeps the job occupied (free on public repos) and throttles ticks.
  // F-C: pacing under budget — min(interval-elapsed, remaining-RESERVE, 240s);
  // <= 0 skips pacing (a faster tick is harmless; the throttle is a nicety).
  // T46/W-C3 (X24): the decision routes through chainContinuationDecision —
  // the held-state arm is what keeps a pinger MARKER commit on a held chain
  // from self-dispatching (the marker tick carries no STOP/HOLD action: the
  // chain was already held; without the held arm it would restart the
  // self-tick loop at runner cadence — F2's livelock class through the
  // marker door).
  const cont = chainContinuationDecision({ actions: actionList, state, pausedNow });
  const stop = cont.stop;
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
  const appliedReason = `${out.reason || 'ok'}${dispatchFailures ? ` dispatchFailures=${dispatchFailures}` : ''}${dispatchSkipped ? ` dispatchSkipped=${dispatchSkipped}` : ''}${pausedNow ? ' budgetPaused' : ''}${selfTickSkipped ? ' selfTick=skipped' : ''}`;
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
