#!/usr/bin/env node
// e2e/staged/gate.mjs — the STAGED DRILL's GATE (s22 design §1.2/§1.3, B-0).
//
// Read-only: checkout + Store.fetch() + readState() + the three queue readers
// (the watchdog's own read pattern, watchdog/scan.mjs:402-404, and
// lib/store.mjs:67,113,353,403-404,428-429) + the in-progress runs query via
// the api seam. It NEVER writes state, never dispatches.
//
// The G1–G6 predicate matrix (§1.3) as a PURE function
// gateDecision({state, depths, event, cadenceVar, now, inProgress}):
//   G1 chain.halted === true        (a LIVE or PAUSED chain refuses — one
//                                     state, one epoch)
//   G2 chain.paused === false       (a budget-pause hold is protected)
//   G3 phase==='done' AND every task terminal (done/quarantined/cancelled)
//                                     — or zero tasks (the halted-clean
//                                     resting shape)
//   G4 report + control + intake queues ALL empty (a queued real spec means
//                                     the real system is WAITING; a queued
//                                     drill line means last night never
//                                     drained, §7 F7)
//   G5 event is workflow_dispatch OR the cadence var admits today
//                                     (manual: schedule SKIPs; weekly:
//                                     Mondays UTC; nightly: every fire)
//   G6 no in-progress fsm-worker/fsm-conductor runs on either bucket —
//                                     HARD on main, WARN-only on the mirror
//                                     (an orphaned mirror run still grinding)
//
// A SKIP is GREEN (exit 0, one log line `STAGED-DRILL-SKIP <reason>`): a busy
// real epoch is healthy behavior, not a drill failure — the next scheduled
// fire retries. Only a gate that CANNOT READ the state (git/API failure after
// 3 attempts) goes RED (exit 1 — unreadable state is the operator's problem,
// and teardown pages, §3.4).
//
// DEVIATION (documented): the design's five-key signature
// {state, depths, event, cadenceVar, now} cannot carry G6's evidence (the
// in-progress run counts on both buckets). A sixth OPTIONAL key
// `inProgress: {main, mirror}` was added rather than overloading `depths`
// (the queue depths are G4's evidence; run counts are a different reader).
// Caller's duty: the thin main() always supplies it from the REAL runs query.

import { Store } from '../../lib/store.mjs';
import { pathToFileURL } from 'node:url';
import { api, emitOutput, repoName, retryAsync } from './lib.mjs';

// ---------------------------------------------------------------------------
// the PURE half
// ---------------------------------------------------------------------------

export const TERMINAL_STATUSES = new Set(['done', 'quarantined', 'cancelled']);
export const CADENCE_VALUES = ['manual', 'weekly', 'nightly'];
const DAY_MONDAY = 1;   // getUTCDay() index

// cadenceAdmitsToday({cadenceVar, eventName, now}) — the §1.2 ladder:
// workflow_dispatch ALWAYS proceeds; a schedule fire proceeds only when the
// var has been promoted (manual = never, weekly = Mondays UTC, nightly =
// always). Unknown values degrade to `manual` (fail-closed — a typo'd var
// must never silently promote the cadence).
export function cadenceAdmitsToday({ cadenceVar, eventName, now } = {}) {
  const event = typeof eventName === 'string' ? eventName : String(eventName?.name ?? '');
  if (event === 'workflow_dispatch') return true;
  const cadence = CADENCE_VALUES.includes(cadenceVar) ? cadenceVar : 'manual';
  if (cadence === 'nightly') return true;
  if (cadence === 'weekly') {
    const d = now instanceof Date ? now : new Date(now);
    return Number.isFinite(d.getTime()) && d.getUTCDay() === DAY_MONDAY;
  }
  return false;   // manual (or unknown — fail-closed): schedule SKIPs
}

// gateConfigCheck({drillIssue, labPat}) — the m-8 load-bearing-variable
// pre-pass (PURE): the pinned drill issue number and the PAT must both be
// mapped before any state is read. Missing -> a GREEN skip (the operator
// one-time setup, §8 B-0 item 4, has not happened) — never a red run.
export function gateConfigCheck({ drillIssue, labPat } = {}) {
  const issue = String(drillIssue ?? '').trim();
  if (issue === '' || !/^\d+$/.test(issue)) {
    return { ok: false, reason: 'config-missing-drill-issue', detail: `DRILL_ISSUE="${issue}" — create the pinned drill issue and set the repo variable (the workflow header's one-time setup)` };
  }
  if (!labPat) {
    return { ok: false, reason: 'config-missing-lab-pat', detail: 'LAB_PAT is not mapped — the seed/verify cross-repo lanes need it' };
  }
  return { ok: true, reason: null, detail: `drill issue #${issue}` };
}

// gateDecision({state, depths, event, cadenceVar, now, inProgress}) ->
//   { decision: 'PROCEED'|'SKIP', reason, skipCode, warnings, checks }
//
// checks[] carries every G-row with {id, ok, detail} (the full matrix is
// ALWAYS evaluated — the log shows the whole picture, the SKIP names the
// first failure in G1..G6 order). depths = {reports, control, intake} queue
// depths; inProgress = {main, mirror} in-progress/queued run counts.
export function gateDecision({ state, depths, event, cadenceVar, now, inProgress } = {}) {
  const depth = (n) => Math.max(0, Number(n) || 0);   // absent -> 0 (caller's duty to supply real reads)
  const d = {
    reports: depth(depths?.reports),
    control: depth(depths?.control),
    intake: depth(depths?.intake),
  };
  const runs = {
    main: depth(inProgress?.main),
    mirror: depth(inProgress?.mirror),
  };
  const eventName = typeof event === 'string' ? event : String(event?.name ?? '');
  const warnings = [];
  const checks = [];
  const fail = (id, detail) => { checks.push({ id, ok: false, detail }); return { id, detail }; };
  const pass = (id, detail) => { checks.push({ id, ok: true, detail }); };

  // G1 — the chain must be HALTED (one state, one epoch: a reset/rollover on
  // a live chain would destroy the real epoch's state).
  if (!state || typeof state !== 'object' || !state.chain || state.chain.halted !== true) {
    const f = fail('G1', state?.chain ? `chain.halted=${state.chain.halted} (a LIVE or PAUSED chain — one state, one epoch)` : 'state/chain unreadable shape');
    return { decision: 'SKIP', reason: `${f.id}-live-epoch`, skipCode: f.id, warnings, checks };
  }
  pass('G1', 'chain.halted=true');

  // G2 — not budget-paused (the X23-class quota protection must survive).
  if (state.chain.paused === true) {
    const f = fail('G2', 'chain.paused=true (a budget-pause hold — the drill must not wipe it)');
    return { decision: 'SKIP', reason: `${f.id}-paused-hold`, skipCode: f.id, warnings, checks };
  }
  pass('G2', 'chain.paused=false');

  // G3 — the halted-clean resting shape: phase done AND every task terminal
  // (or zero tasks — the pruned-between-epochs shape).
  const tasks = state.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : [];
  const nonTerminal = tasks.filter((t) => !TERMINAL_STATUSES.has(t?.status));
  const phaseDone = state.project?.phase === 'done';
  if (!phaseDone || nonTerminal.length > 0) {
    const f = fail('G3', !phaseDone
      ? `project.phase=${JSON.stringify(state.project?.phase)} (a mid-flight epoch)`
      : `${nonTerminal.length} non-terminal task(s): ${nonTerminal.slice(0, 5).map((t) => `${t?.id}:${t?.status}`).join(', ')}`);
    return { decision: 'SKIP', reason: `${f.id}-mid-flight-epoch`, skipCode: f.id, warnings, checks };
  }
  pass('G3', `phase=done, ${tasks.length} task(s) all terminal`);

  // G4 — all three queues EMPTY (a queued real spec must not be jumped; a
  // queued drill line means last night never drained, §7 F7).
  if (d.reports > 0 || d.control > 0 || d.intake > 0) {
    const f = fail('G4', `queue depths report:${d.reports} control:${d.control} intake:${d.intake} (a queued spec — real or drill — means the system is WAITING)`);
    return { decision: 'SKIP', reason: `${f.id}-queued-spec`, skipCode: f.id, warnings, checks };
  }
  pass('G4', 'report+control+intake queues all empty');

  // G5 — the cadence ladder (§1.2).
  const cadenceOk = cadenceAdmitsToday({ cadenceVar, eventName, now });
  if (!cadenceOk) {
    const f = fail('G5', `event=${eventName || '(none)'} cadence=${cadenceVar ?? '(unset)'} — schedule fires skip until the var is promoted (manual|weekly|nightly)`);
    return { decision: 'SKIP', reason: `${f.id}-cadence-gated`, skipCode: f.id, warnings, checks };
  }
  pass('G5', `event=${eventName || '(none)'} admitted by cadence=${cadenceVar ?? '(unset → manual)'}`);

  // G6 — no in-progress fsm-worker/fsm-conductor runs on either bucket.
  // HARD on main (a live machine-plane run means the epoch is not actually
  // resting); WARN-only on the mirror (the shared agentrunners bucket's runs
  // are not ours to gate on — the warn still surfaces before the drill adds
  // load to the org's 20-slot bucket).
  if (runs.main > 0) {
    const f = fail('G6', `${runs.main} in-progress/queued machine-plane run(s) on the MAIN bucket (straggler runs from a real epoch)`);
    return { decision: 'SKIP', reason: `${f.id}-main-runs-in-progress`, skipCode: f.id, warnings, checks };
  }
  pass('G6', 'zero in-progress machine-plane runs on the main bucket');
  if (runs.mirror > 0) {
    warnings.push(`G6-mirror-in-progress: ${runs.mirror} run(s) on the mirror bucket (WARN-only — the shared agentrunners bucket; proceeding)`);
  }

  return { decision: 'PROCEED', reason: null, skipCode: null, warnings, checks };
}

// ---------------------------------------------------------------------------
// the I/O half (thin main — the only thing that touches the outside world)
// ---------------------------------------------------------------------------

// The in-progress runs query (§1.3 G6): worker.yml + conductor.yml runs on
// MAIN (GH_TOKEN — actions:read, the conductor.yml:51 law-4 pattern) and
// worker.yml runs on the MIRROR bucket (LAB_PAT — the cross-repo lane, the
// same call the conductor's union scan makes). In-progress = status
// queued|in_progress within a 60-min lookback (a worker run older than its
// 50-min TTL is dead by timeout; the lookback keeps the page small).
async function inProgressRuns({ mirrorRepo }) {
  const lookbackIso = new Date(Date.now() - 60 * 60_000).toISOString();
  const count = (runs) => (Array.isArray(runs) ? runs : []).filter((r) => {
    const created = Date.parse(r?.created_at || '');
    return (r?.status === 'queued' || r?.status === 'in_progress')
      && Number.isFinite(created) && created >= Date.parse(lookbackIso);
  }).length;
  const fetchRuns = async (repo, wf, token) => {
    const r = await api(`/repos/${repo}/actions/workflows/${wf}/runs?per_page=100`, { token });
    return r.status === 200 ? (r.data?.workflow_runs || []) : [];
  };
  const repo = repoName();
  const [wMain, cMain, wMirror] = await Promise.all([
    fetchRuns(repo, 'worker.yml', process.env.GH_TOKEN || process.env.LAB_PAT),
    fetchRuns(repo, 'conductor.yml', process.env.GH_TOKEN || process.env.LAB_PAT),
    mirrorRepo ? fetchRuns(mirrorRepo, 'worker.yml', process.env.LAB_PAT) : Promise.resolve([]),
  ]);
  return { main: count(wMain) + count(cMain), mirror: count(wMirror) };
}

async function main() {
  const drillIssue = String(process.env.DRILL_ISSUE ?? '').trim();
  const cadenceVar = String(process.env.STAGED_DRILL_ENABLED ?? 'manual').trim();
  const eventName = process.env.EVENT_NAME || 'workflow_dispatch';
  const mirrorRepo = String(process.env.WORKER_REPO_2 || '').trim();

  // the config pre-pass (m-8): a missing drill issue / PAT is a GREEN skip.
  const cfg = gateConfigCheck({ drillIssue, labPat: process.env.LAB_PAT });
  if (!cfg.ok) {
    console.log(`STAGED-DRILL-SKIP ${cfg.reason} (${cfg.detail})`);
    emitOutput('proceed', 'false');
    emitOutput('skipReason', cfg.reason);
    return;
  }

  // the state read — 3 attempts (§1.3: only a gate that CANNOT read the
  // state goes RED). corrupt JSON counts as unreadable; an ABSENT state.json
  // is readable-but-empty -> G1's SKIP (the branch-fresh shape; the log makes
  // it visible, and the conductor's recovery owns that lane).
  const store = new Store({ cwd: process.cwd() });
  const read = () => {
    try {
      store.fetch();
      const { state, corrupt } = store.readState();
      if (state) return { ok: true, state };
      return { ok: false, corrupt: !!corrupt, err: corrupt ? 'state.json present but UNPARSEABLE' : 'state.json absent on fsm-state' };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const rd = await retryAsync(read, { attempts: 3, backoffMs: 3000, onRetry: (i, r) => console.log(`GATE-READ-RETRY ${i} (${r.err})`) });
  if (!rd.ok) {
    // RED: unreadable-after-3 — teardown (wired if:always() on gate failure)
    // opens the page; this job's red run is the second signal.
    console.error(`GATE-READ-FAILED after 3 attempts: ${rd.err || 'unknown'} — unreadable state is the operator's problem (teardown pages)`);
    process.exitCode = 1;
    return;
  }

  // the three queue depths (G4) — items AND unparseable residue both count:
  // a queue with bad lines is NOT empty.
  const depths = {
    reports: store.readQueueEx().items.length + store.readQueueEx().bad.length,
    control: store.readControlQueueEx().items.length + store.readControlQueueEx().bad.length,
    intake: store.readIntakeQueueEx().items.length + store.readIntakeQueueEx().bad.length,
  };

  const inProgress = await inProgressRuns({ mirrorRepo });

  const decision = gateDecision({
    state: rd.state,
    depths,
    event: { name: eventName },
    cadenceVar,
    now: new Date(),
    inProgress,
  });

  for (const c of decision.checks) console.log(`GATE ${c.ok ? 'ok' : 'FAIL'} ${c.id}: ${c.detail}`);
  for (const w of decision.warnings) console.log(`GATE-WARN ${w}`);

  if (decision.decision === 'SKIP') {
    console.log(`STAGED-DRILL-SKIP ${decision.reason} (green — the next scheduled fire retries; a busy real epoch is healthy behavior)`);
    emitOutput('proceed', 'false');
    emitOutput('skipReason', decision.reason);
    return;
  }

  console.log(`STAGED-DRILL-GATE-PROCEED issue #${drillIssue} cadence=${cadenceVar} event=${eventName} mirror=${mirrorRepo || 'none'}${decision.warnings.length ? ` warnings=${decision.warnings.length}` : ''}`);
  emitOutput('proceed', 'true');
  emitOutput('skipReason', '');
}

// Direct-run guard (the watchdog/scan.mjs:497 pattern): `node
// e2e/staged/gate.mjs` runs the gate; importing the module (tests) must NOT.
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch(e => {
    console.error('GATE-FAILED:', e.message);
    process.exitCode = 1;
  });
}
