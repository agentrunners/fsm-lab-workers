#!/usr/bin/env node
// e2e/staged/teardown.mjs — the STAGED DRILL's TEARDOWN (s22 design §4, B-0).
//
// The happy-path teardown is the X-series teardown: the drill epoch ended the
// way every epoch ends (PHASE done → halt → quiesce → the tip freezes — that
// IS halted-clean, tomorrow's gate shape; NO reset is needed). This driver:
//   1. asserts the halt held (the frozen tip read twice — the local drill's
//      HALT-QUIESCE phase pattern, e2e/drill.mjs:440-449);
//   2. closes the drill issue (arms tomorrow's reopen cycle, §1.6);
//   3. GREEN: posts the ONE marker comment with the JOB token (GITHUB_TOKEN
//      comments fire no workflows — the anti-recursion law, ops-console.yml
//      :8-14 — the marker cannot wake the machine plane) and auto-closes
//      every open `fsm-staged-red` issue (the self-cleaning alert budget,
//      §5.3: page once per incident, the next GREEN closes it);
//   4. RED: opens ONE duty-alert issue labeled `fsm-staged-red` — NEVER
//      `fsm-watchdog-alert` (the machine's lanes search that label and take
//      the first hit, watchdog/scan.mjs:76-79 — a drill issue with that
//      label would absorb the next REAL alert's comments, mixing lanes).
//      Page ONCE: an already-open RED issue is NOT re-paged (the nightly
//      report artifacts + the issue thread carry the detail, §3.4);
//   5. the STUCK-RECOVERY arm (§4.2 — the only teardown that writes
//      anything): when the drill did NOT reach a terminal state (the monitor
//      timed out, or verify found non-terminal tasks), dispatch ONE control:
//        POST /repos/<repo>/dispatches { event_type: "fsm-control",
//          client_payload: { command: "reset", note: "staged-drill teardown <date>" } }
//      The reset's fresh mock genesis self-completes (~3 h) and halts; the
//      intake queue PARKS through it (a real spec parked behind the stuck
//      drill is NOT dropped). An assertion-RED on a halted-clean chain does
//      NOT fire the arm (§3.4: a valid resting state, just not the one we
//      wanted — the next night retries). DEFERRED never fires it (the drill
//      never touches an epoch it does not own).
//
// The decision core teardownDecision({...}) is PURE (unit-pinned); main() is
// the thin I/O half reading the workflow's mapped outputs (needs.verify /
// needs.run / needs.gate) from env.

import { Store } from '../../lib/store.mjs';
import { pathToFileURL } from 'node:url';
import { api, emitOutput, RED_LABEL, repoName, retryAsync } from './lib.mjs';

const TERMINAL = new Set(['done', 'quarantined', 'cancelled']);

// ---------------------------------------------------------------------------
// the PURE half
// ---------------------------------------------------------------------------

// teardownDecision({gateResult, seeded, runResult, verdict, ...}) ->
//   { action, effectiveVerdict, redClass }
//
// action ∈ 'gate-read-red' | 'seed-skip' | 'seed-no-output' | 'deferred' |
// 'green' | 'red'. Ordering is the safety order: the gate's read-RED pages
// first (nothing else is knowable); the F3 seed-skip exits green BEFORE any
// RED page (no epoch, the queue was never touched); DEFERRED exits green
// with ZERO teardown (§1.4); a missing verdict is RED (never silently green
// — law 5: a crashed verify is not a green drill).
// s23: the RED-family actions — every one of these must run the §4.2
// stuck-recovery arm when the chain is non-terminal (the first stage-0
// green caught the gap: a seed-no-output classification — from the
// workflow's needs-chain bug reading RUN_SEEDED empty — skipped the reset
// on a LIVE epoch because the arm only fired on action === 'red'). The
// epoch does not care WHICH red class paged it; it cares that it is stuck.
export const RED_FAMILY_ACTIONS = new Set(['red', 'gate-read-red', 'seed-no-output']);

export function teardownDecision({ gateResult, seeded, verdict } = {}) {
  if (gateResult === 'failure') {
    return { action: 'gate-read-red', effectiveVerdict: 'RED', redClass: 'gate-read' };
  }
  if (seeded === 'false') {
    return { action: 'seed-skip', effectiveVerdict: 'SKIP', redClass: null };
  }
  if (seeded !== 'true') {
    return { action: 'seed-no-output', effectiveVerdict: 'RED', redClass: 'seed-no-output' };
  }
  if (verdict === 'DEFERRED') {
    return { action: 'deferred', effectiveVerdict: 'DEFERRED', redClass: null };
  }
  if (verdict === 'GREEN') {
    return { action: 'green', effectiveVerdict: 'GREEN', redClass: null };
  }
  if (verdict === 'RED') {
    return { action: 'red', effectiveVerdict: 'RED', redClass: 'assertion' };
  }
  // verdict missing/unknown: the verify job produced no verdict (crashed
  // before emitting, or was skipped after the seed landed) — page it.
  return { action: 'red', effectiveVerdict: 'RED', redClass: 'verify-no-verdict' };
}

// recoveryShape(state) — the RED page's "recovery state of the system" line
// (§3.4): halted-clean? mid-epoch? foreign? held?
export function recoveryShape(state) {
  if (!state || typeof state !== 'object' || !state.chain) return 'state unreadable';
  const tasks = state.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : [];
  const nonTerminal = tasks.filter((t) => !TERMINAL.has(t?.status));
  if (state.chain.paused === true) return 'held-paused (an operator/budget hold)';
  if (state.chain.halted === true && state.project?.phase === 'done' && nonTerminal.length === 0) {
    return 'halted-clean (a valid resting state — the next night retries; no reset fired)';
  }
  if (state.chain.halted === true && nonTerminal.length > 0) return 'halted but NON-TERMINAL tasks remain (an operator-halted mid-flight epoch — the §4.2 reset fires)';
  if (state.chain.halted === true) return `halted with phase=${JSON.stringify(state.project?.phase)}`;
  return `MID-EPOCH (phase=${JSON.stringify(state.project?.phase)}, ${nonTerminal.length}/${tasks.length} task(s) non-terminal — the §4.2 reset fires)`;
}

// nonTerminalState(state) — the stuck-recovery arm's predicate (§4.2: "the
// run job's monitor times out OR the verify job finds a non-terminal
// state"): our read of the LIVE state at teardown time (fresher than the
// verify job's — a halt landing in the race window is honored).
export function nonTerminalState(state) {
  if (!state || typeof state !== 'object' || !state.chain) return true;   // unreadable -> recover
  const tasks = state.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : [];
  return !(state.chain.halted === true && state.project?.phase === 'done' && tasks.every((t) => TERMINAL.has(t?.status)));
}

// markerComment({...}) — §3.3's exact streak surface (one line, the
// operator's at-a-glance GREEN marker).
export function markerComment({ date, wallMin, tasks, assertsPassed, assertsTotal, watchdogGreen } = {}) {
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '');
  return `STAGED-DRILL GREEN · ${d} · wall ${Number(wallMin) || '?'} min · tasks ${Number(tasks) || 0} · asserts ${Number(assertsPassed) || 0}/${Number(assertsTotal) || 0} · watchdog ${watchdogGreen === false ? 'RED' : 'green'}`;
}

// redPageTitle(date) — §3.4: sits visually in the alert stream the operator
// already watches, on the DISTINCT label (never fsm-watchdog-alert).
export function redPageTitle(date) {
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '');
  return `[fsm-staged] NIGHTLY DRILL RED — ${d}`;
}

const RED_CLASS_INTROS = {
  assertion: 'A real invariant break — investigate (the failed A-asserts below; the local drill reproduces offline for bisection: `node e2e/drill.mjs --scenario x22`).',
  read: 'The verify job could not READ state/runs after 3 attempts — likely API flake. Re-run the verify job first; only page deeper if it stays red.',
  'no-epoch': 'The seed\'s reopen landed but no epoch started — the PAT-comment trigger law or the intake door lane is the suspect (the seed job log carries the enqueue wait).',
  'verify-no-verdict': 'The verify job produced NO verdict (crashed or skipped after the seed landed) — the drill did not prove green, so it pages (law 5: never silently green).',
  'seed-no-output': 'The seed job produced no output (crashed before deciding) — the drill did not start cleanly.',
  'gate-read': 'The GATE could not read the state after 3 attempts — unreadable state is the operator\'s problem (check the fsm-state branch; the conductor\'s history-walk recovery may already be healing it).',
  'halt-not-held': 'The halt did not HOLD after the verify pass (the tip moved on a halted chain) — something wrote to a quiesced chain.',
};

// redPageBody({...}) — §3.4's page: the failed asserts (A-table refs), the
// recovery state of the system, and the fix-forward note.
export function redPageBody({ date, redClass, failedIds = [], recovery, resetDispatched = null, extra = '' } = {}) {
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '');
  const intro = RED_CLASS_INTROS[redClass] || RED_CLASS_INTROS.assertion;
  const failedList = failedIds.length
    ? failedIds.map((id) => `- **${id}** — see the run's step summary + the staged-drill-report artifact for expected/actual`).join('\n')
    : '- (no per-assert detail — the class above carries the failure)';
  const parts = [
    `**[fsm-staged]** The nightly staged drill went RED on ${d}.`,
    '',
    intro,
    '',
    '**Failed asserts:**',
    failedList,
    '',
    `**Recovery state of the system:** ${recovery}`,
  ];
  if (resetDispatched === true) {
    parts.push('', '**Recovery:** the §4.2 stuck-recovery RESET was dispatched — a fresh mock epoch self-completes (~3 h) and halts; the intake queue PARKS through it (parked real specs are not dropped).');
  } else if (resetDispatched === false) {
    parts.push('', '**Recovery:** the §4.2 stuck-recovery reset dispatch FAILED (see the teardown log) — re-send it manually: `POST /repos/claudecode-headless/fsm-lab/dispatches {"event_type":"fsm-control","client_payload":{"command":"reset","note":"staged-drill teardown manual"}}`');
  }
  if (extra) parts.push('', extra);
  parts.push('', '**Fix-forward:** read the verify job\'s step summary (the full A-table with expected/actual) and the drill report artifact; the design doc is `research/s22-staged-mode.md` (§7 carries the failure-mode table). If this is a real regression the drill caught it working as designed — bisect with the local drill.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// the I/O half
// ---------------------------------------------------------------------------

const today = () => new Date();

async function main() {
  const repo = repoName();
  const drillIssueNum = String(process.env.DRILL_ISSUE ?? '').trim();
  const date = today();
  const isoDay = date.toISOString().slice(0, 10);

  const dec = teardownDecision({
    gateResult: String(process.env.GATE_RESULT ?? ''),
    seeded: String(process.env.RUN_SEEDED ?? ''),
    verdict: String(process.env.VERIFY_VERDICT ?? ''),
  });
  const failedIds = String(process.env.VERIFY_FAILED ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const redClassFromEnv = String(process.env.VERIFY_RED_CLASS ?? '').trim();

  // ---- the GATE read-RED page (nothing else is knowable) ------------------
  if (dec.action === 'gate-read-red') {
    const reason = String(process.env.GATE_SKIP_REASON ?? '');
    console.log(`STAGED-DRILL-TEARDOWN gate-read-red (skipReason="${reason}") — opening the page`);
    const n = await openRedPage({ date, redClass: 'gate-read', failedIds: [], recovery: 'unknown (the gate could not read fsm-state)' });
    console.log(`STAGED-DRILL-RED-OPENED #${n ?? 'FAILED'} (class gate-read)`);
    process.exitCode = n ? 1 : 1;
    return;
  }

  // ---- the F3 seed-skip: green, nothing written, nothing to clean --------
  if (dec.action === 'seed-skip') {
    console.log('STAGED-DRILL-TEARDOWN seed-skip (F3: a seed write failed after 2 attempts — no epoch, the queue was never touched; retry next night) — zero teardown');
    return;
  }

  // ---- DEFERRED: zero teardown, zero page (§1.4) --------------------------
  if (dec.action === 'deferred') {
    console.log('STAGED-DRILL-DEFERRED (a real epoch won the queue head — green exit, zero teardown, zero page; the drill retries next night)');
    emitOutput('deferred', 'true');
    return;
  }

  // ---- the fresh state read (3 attempts) — the recovery + halt-held base -
  const store = new Store({ cwd: process.cwd() });
  const readState = () => {
    try {
      store.fetch();
      const { state } = store.readState();
      if (!state) return { ok: false, err: 'state.json absent on fsm-state' };
      return { ok: true, state };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const rd = await retryAsync(readState, { attempts: 3, backoffMs: 3000, onRetry: (i, r) => console.log(`TEARDOWN-READ-RETRY ${i} (${r.err})`) });
  if (!rd.ok) {
    const n = await openRedPage({ date, redClass: 'read', failedIds, recovery: 'state unreadable at teardown after 3 attempts' });
    console.error(`STAGED-DRILL-TEARDOWN-READ-FAILED (${rd.err}) — RED page #${n ?? 'FAILED'} (class read)`);
    process.exitCode = 1;
    return;
  }
  const state = rd.state;
  const recovery = recoveryShape(state);

  let action = dec.action;
  let redClass = dec.redClass === 'assertion' && redClassFromEnv ? redClassFromEnv : dec.redClass;

  // ---- the halt-held assert (the happy path's one invariant, §4.1) --------
  if (action === 'green') {
    const gapS = Number(process.env.TEARDOWN_QUIESCE_GAP_S) > 0 ? Number(process.env.TEARDOWN_QUIESCE_GAP_S) : 10;
    const tip1 = store.headSha();
    const halted1 = store.readState().state?.chain?.halted === true;
    await new Promise(res => setTimeout(res, gapS * 1000));
    store.fetch();
    const tip2 = store.headSha();
    const halted2 = store.readState().state?.chain?.halted === true;
    const held = tip1 !== null && tip1 === tip2 && halted1 && halted2;
    console.log(`STAGED-DRILL-HALT-HELD ${held ? 'yes' : 'NO'} (tip ${String(tip1).slice(0, 8)} -> ${String(tip2).slice(0, 8)} over ${gapS}s, halted ${halted1}/${halted2})`);
    if (!held) {
      action = 'red';
      redClass = 'halt-not-held';
      failedIds.push('HALT-HELD');
    }
  }

  // ---- the stuck-recovery arm (§4.2) — only a NON-TERMINAL drill ---------
  // s23: RED_FAMILY_ACTIONS (the whole red family, not just 'red') — a
  // seed-no-output/gate-read-red classification with a LIVE non-terminal
  // epoch is EXACTLY the stuck shape the reset exists for.
  let resetDispatched = null;
  if (RED_FAMILY_ACTIONS.has(action) && nonTerminalState(state)) {
    resetDispatched = await dispatchStuckRecovery({ date });
  } else if (RED_FAMILY_ACTIONS.has(action)) {
    console.log(`STAGED-DRILL-NO-RESET (the chain is terminal: ${recovery} — §3.4: an assertion-RED on a halted-clean chain leaves the system alone; the next night retries)`);
  }

  // ---- close the drill issue (arms tomorrow's reopen) --------------------
  if (/^\d+$/.test(drillIssueNum)) {
    const close = await retryAsync(() => api(`/repos/${repo}/issues/${drillIssueNum}`, { method: 'PATCH', body: { state: 'closed' }, token: tokenFor('issue') }), { attempts: 2, backoffMs: 2000 });
    // a failed close self-heals: the seed's close-first guarantees tomorrow
    // night's reopen is a genuine transition even on a left-open issue.
    console.log(`STAGED-DRILL-ISSUE-CLOSED #${drillIssueNum} HTTP=${close.status}${close.status === 200 ? '' : ' (FAILED — self-healing: the seed\'s close-first covers it)'}`);
  }

  // ---- GREEN: the marker + the self-cleaning alert budget ----------------
  if (action === 'green') {
    const marker = markerComment({
      date,
      wallMin: Number(process.env.VERIFY_WALL_MIN) || Number(process.env.RUN_WALL_MIN) || 0,
      tasks: Number(process.env.VERIFY_TASKS) || 0,
      assertsPassed: Number(process.env.VERIFY_ASSERTS_PASSED) || 0,
      assertsTotal: Number(process.env.VERIFY_ASSERTS_TOTAL) || 0,
      watchdogGreen: String(process.env.VERIFY_WATCHDOG) !== 'false',
    });
    const okMarker = await postComment(drillIssueNum, marker);
    console.log(`STAGED-DRILL-GREEN-MARKER ${okMarker ? 'posted' : 'FAILED (law 5 — visible)'}: ${marker}`);
    const closed = await autoCloseStaleReds({ date });
    console.log(`STAGED-DRILL-RED-AUTOCLOSE ${closed} stale fsm-staged-red issue(s) closed (the self-cleaning alert budget)`);
    if (!okMarker) process.exitCode = 1;   // the streak surface broke — visible, not green
    return;
  }

  // ---- RED: the page-once lane --------------------------------------------
  const n = await openRedPage({ date, redClass, failedIds, recovery, resetDispatched });
  if (n === null) {
    console.error('STAGED-DRILL-RED-OPEN-FAILED (law 5: the page itself failed — the red run + the logs are the remaining signal)');
    process.exitCode = 1;
    return;
  }
  console.log(`STAGED-DRILL-RED #${n} class=${redClass} failed=[${failedIds.join(',')}] recovery="${recovery}"${resetDispatched === true ? ' reset=dispatched' : resetDispatched === false ? ' reset=FAILED' : ''}`);
  process.exitCode = 1;
}

// the token lanes: the marker comment, the issue close, the RED page and the
// auto-close all ride the JOB token (GITHUB_TOKEN-authored events fire no
// workflows — the anti-recursion law; these surfaces must never wake the
// machine plane). The reset dispatch rides the job token too (X1a: same-repo
// repository_dispatch is the law's exception — the conductor's own
// self-dispatch lane); the PAT stays the fallback for local runs.
function tokenFor() {
  return process.env.GH_TOKEN || process.env.LAB_PAT || '';
}

async function postComment(issueNum, body) {
  if (!/^\d+$/.test(String(issueNum))) return false;
  const r = await retryAsync(() => api(`/repos/${repoName()}/issues/${issueNum}/comments`, { method: 'POST', body: { body }, token: tokenFor() }), { attempts: 2, backoffMs: 2000 });
  return r.status === 201;
}

// openRedPage() — page ONCE per incident: an existing OPEN fsm-staged-red
// issue is NOT re-paged (§3.4 — no nightly re-paging while an incident is
// open; the report artifacts carry the detail). Returns the issue number or
// null on failure.
async function openRedPage({ date, redClass, failedIds, recovery, resetDispatched = null }) {
  const repo = repoName();
  const existing = await retryAsync(() => api(`/repos/${repo}/issues?state=open&labels=${RED_LABEL}&per_page=20`, { token: tokenFor() }), { attempts: 2, backoffMs: 2000 });
  if (existing.status === 200 && Array.isArray(existing.data) && existing.data.length > 0) {
    console.log(`STAGED-DRILL-RED-ALREADY-OPEN #${existing.data[0].number} (page-once: no new page, no nightly comment — the report artifact carries tonight's detail)`);
    return existing.data[0].number;
  }
  const body = redPageBody({ date, redClass, failedIds, recovery, resetDispatched });
  const r = await retryAsync(() => api(`/repos/${repo}/issues`, {
    method: 'POST',
    body: { title: redPageTitle(date), labels: [RED_LABEL], body },
    token: tokenFor(),
  }), { attempts: 2, backoffMs: 2000 });
  return r.status === 201 ? (r.data?.number ?? null) : null;
}

// autoCloseStaleReds() — the next GREEN closes every open fsm-staged-red
// (§5.3). One closing comment each (the audit line), then the close.
async function autoCloseStaleReds({ date }) {
  const repo = repoName();
  const list = await retryAsync(() => api(`/repos/${repo}/issues?state=open&labels=${RED_LABEL}&per_page=20`, { token: tokenFor() }), { attempts: 2, backoffMs: 2000 });
  if (list.status !== 200 || !Array.isArray(list.data)) return 0;
  let closed = 0;
  for (const it of list.data) {
    await postComment(it.number, `closed by the GREEN staged drill ${date instanceof Date ? date.toISOString().slice(0, 10) : date} (the self-cleaning alert budget, §5.3)`);
    const c = await retryAsync(() => api(`/repos/${repo}/issues/${it.number}`, { method: 'PATCH', body: { state: 'closed' }, token: tokenFor() }), { attempts: 2, backoffMs: 2000 });
    if (c.status === 200) closed += 1;
    else console.log(`STAGED-DRILL-RED-AUTOCLOSE-FAILED #${it.number} HTTP=${c.status} (visible — retry next green)`);
  }
  return closed;
}

// dispatchStuckRecovery() — §4.2's ONE control. The fsm-control fan-out wakes
// conductor.yml AND ops.yml; the direct reset applies and the ops lane's
// queued twin is REJECTED reset-duplicate with NO comment (the F-1/F-8 twin
// guard) — exactly one reset lands. A plain reset PARKS the intake queue
// (never drop_queue — real specs parked behind the stuck drill survive).
async function dispatchStuckRecovery({ date }) {
  const repo = repoName();
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  const post = () => api(`/repos/${repo}/dispatches`, {
    method: 'POST',
    body: { event_type: 'fsm-control', client_payload: { command: 'reset', note: `staged-drill teardown ${d}` } },
    token: tokenFor(),
  });
  const r = await retryAsync(post, { attempts: 2, backoffMs: 2000 });
  const ok = r.status === 204;
  console.log(`STAGED-DRILL-RESET-DISPATCH ${ok ? 'ok (204)' : `FAILED HTTP=${r.status}`} — command=reset note="staged-drill teardown ${d}" (the fresh mock genesis self-completes ~3h and halts; the intake queue PARKS)`);
  return ok;
}

// Direct-run guard (the watchdog/scan.mjs:497 pattern).
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch(e => {
    console.error('TEARDOWN-FAILED:', e.message);
    process.exitCode = 1;
  });
}
