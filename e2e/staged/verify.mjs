#!/usr/bin/env node
// e2e/staged/verify.mjs — the STAGED DRILL's VERIFICATION PASS (s22 design
// §3, build item B-0). `needs: [run]`, `if: always()` — it must run on a
// stuck drill too, because it is also the stuck-detector.
//
// Reads (§3.1 — all through the REAL surfaces, zero re-derivation):
//   - `fsm-state` via the REAL Store (the watchdog's read-only pattern:
//     checkout + store.fetch() + readState() + readJournals()) — git reads,
//     zero API cost, byte-identical to what every machine-plane reader sees;
//   - the journal's epoch segment — records AFTER the newest applied
//     `CONTROL reset` boundary (epochSegment(), the epochSpend walk rule);
//   - both buckets' run ledgers — GET .../actions/workflows/worker.yml/runs
//     for main and the mirror (the PAT lane for the cross-repo one — the
//     same call the conductor's union scan makes);
//   - the watchdog's own runs + the fsm-watchdog-alert issue search (the
//     findAlertIssue query shape, watchdog/scan.mjs:76-79);
//   - the drill issue's comments (A10's evidence).
//
// PURE half: runVerdict({state, journalSegment, runsMain, runsMirror,
// drillIssue, window}) — the whole A1–A12 table. DEVIATION (documented): two
// OPTIONAL keys were added beyond the design's six — `watchdogRuns` and
// `alertIssues` (A11's evidence: "≥1 watchdog run completed in-window with
// success conclusion; zero fsm-watchdog-alert issues created in-window"
// cannot ride any of the six named inputs without lying about their types),
// and `drillIssue` is an object `{number, comments}` rather than a bare
// number (A10's evidence — the issue's comment thread). The pure function is
// behavior-aware: the expected arcs derive from the boundary's genesisSpec
// (per-task behavior + the adopted max_attempts), so the SAME table serves
// the stage-0 single-task rotation and B-1's full 4-task mix — including the
// stage-0 hang-night case where a DEGRADED halt is the CORRECT outcome
// (done 0/1: the R2 quality gate working, not broken).
//
// On read failure (3 attempts): verdict RED class 'read' — DISTINCT from
// assertion-RED (§3.4: likely API flake; the page says so and suggests
// re-running the verify job). Both page once; neither is silently green.
//
// Emits: the DRILL-REPORT-shaped JSON (e2e/staged/last-staged-report.json +
// a STAGED-DRILL-REPORT stdout line + the step summary) + the workflow
// outputs the teardown consumes. Exit 0 on GREEN/DEFERRED, 1 on RED.

import { Store } from '../../lib/store.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { api, emitOutput, emitSummary, epochSegment, repoName, retryAsync, toMs } from './lib.mjs';

// ---------------------------------------------------------------------------
// the PURE half — the A1–A12 assertion table
// ---------------------------------------------------------------------------

// worker.yml's run-name contract (worker.yml:47): `task-<id> · <behavior> ·
// a<attempt>` — the id charset forbids spaces, so the ' · ' split is exact.
const RUN_NAME_RE = /^task-(\S+) · \S+ · a(\d+)$/;
const DRILL_ID_RE = /^T-STG-[A-Z]-\d{4}$/;   // the seed's id shape: letter + <MMDD>
const TERMINAL = new Set(['done', 'quarantined', 'cancelled']);
const EXPECTED_STATUS = { fast: 'done', 'infra-flaky': 'done', hang: 'quarantined' };

export const ASSERT_NAMES = {
  A1: 'the epoch is OURS (the lock check)',
  A2: 'all tasks terminal',
  A3: 'halt reached, quality-gate verdict as expected',
  A4: 'zero double-applied',
  A5: 'the attempts ladder',
  A6: 'the overflow shape (X26)',
  A7: 'the union scan protected the mirror work (C-1)',
  A8: 'exactly one dispatch per task (C-2)',
  A9: 'stats sane',
  A10: 'the human plane closed',
  A11: 'watchdog stayed green',
  A12: 'the rollover record',
};

function normWindow(w) {
  const end = toMs(w?.end ?? w?.endMs);
  const endMs = Number.isFinite(end) ? end : Date.now();
  const start = toMs(w?.start ?? w?.startMs);
  const startMs = Number.isFinite(start) ? start : endMs - 60 * 60_000;
  return { startMs, endMs: Math.max(endMs, startMs) };
}
function inWindowTs(ts, win) {
  const t = toMs(ts);
  return Number.isFinite(t) && t >= win.startMs && t <= win.endMs;
}
function mmddOfMs(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function parseDrillRun(run) {
  const m = RUN_NAME_RE.exec(String(run?.name ?? ''));
  if (!m) return null;
  return { taskId: m[1], attempt: Number(m[2]) || 0, created: run?.created_at ?? null, status: run?.status ?? null, conclusion: run?.conclusion ?? null };
}
function parseComment(c) {
  return typeof c === 'string' ? c : String(c?.body ?? '');
}

// the run pool the A6/A8 asserts key on: in-window runs on EITHER bucket
// whose name parses to a DRILL task id (main first, mirror second — the
// `includes` identity keeps each run's bucket attribution exact).
function drillRunPool(runsMain, runsMirror, drillTaskIds, win) {
  const pool = [];
  for (const run of (Array.isArray(runsMain) ? runsMain : [])) {
    const p = parseDrillRun(run);
    if (p && drillTaskIds.has(p.taskId) && inWindowTs(p.created, win)) pool.push({ ...p, bucket: 'main' });
  }
  for (const run of (Array.isArray(runsMirror) ? runsMirror : [])) {
    const p = parseDrillRun(run);
    if (p && drillTaskIds.has(p.taskId) && inWindowTs(p.created, win)) pool.push({ ...p, bucket: 'mirror' });
  }
  return pool;
}

// runVerdict(input) -> { verdict, deferred, redClass, stuck, asserts, passed,
// failed, tasks, watchdogGreen, report }
//
// verdict: 'GREEN' (all twelve true) | 'RED' (any false — redClass carries
// 'assertion' | 'no-epoch') | 'DEFERRED' (§1.4: a foreign epoch owns the
// state — green exit, zero teardown, zero page; the drill retries next
// night). `stuck` is the teardown §4.2 input: OUR epoch, non-terminal.
export function runVerdict(input = {}) {
  const state = input.state && typeof input.state === 'object' ? input.state : null;
  const seg = input.journalSegment && typeof input.journalSegment === 'object' ? input.journalSegment : {};
  const boundary = seg.boundary ?? null;
  const records = Array.isArray(seg.records) ? seg.records : [];
  const di = input.drillIssue && typeof input.drillIssue === 'object' && !Array.isArray(input.drillIssue)
    ? input.drillIssue : { number: input.drillIssue };
  const drillIssueNum = String(di.number ?? '').trim();
  const comments = (Array.isArray(di.comments) ? di.comments : []).map(parseComment);
  const win = normWindow(input.window);
  const mmdd = mmddOfMs(win.startMs);

  const asserts = [];
  const add = (id, ok, expected, actual, detail) =>
    asserts.push({ id, name: ASSERT_NAMES[id], ok, expected, actual, detail: detail ?? '' });

  // ---- A1: the epoch is OURS (the lock check, §1.4) ----------------------
  const stateIssue = String(state?.project?.issue ?? '');
  const ours = !!state && drillIssueNum !== '' && stateIssue === drillIssueNum;
  const stateTasks = state?.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : [];

  if (!ours) {
    // foreign state: DEFERRED when a foreign epoch actually RAN (live now, or
    // its boundary record is in-window — §1.4's residual race: the real issue
    // won the queue head in the seconds between gate-pass and the enqueue);
    // otherwise the no-epoch wedge (the reopen landed, nothing consumed it).
    const liveForeign = !!state && state.chain?.halted !== true;
    const foreignBoundaryInWindow = !!boundary
      && String(boundary.genesisSpec?.issue ?? '') !== drillIssueNum
      && inWindowTs(boundary.ts, win);
    if (liveForeign || foreignBoundaryInWindow) {
      const detail = liveForeign
        ? `state.project.issue=${JSON.stringify(stateIssue)} (live) — a real epoch won the queue head; it is healthy and runs to completion`
        : `boundary issue #${boundary.genesisSpec?.issue} in-window — a real epoch ran tonight; the drill retries next night`;
      for (let i = 1; i <= 12; i++) add(`A${i}`, null, 'deferred', 'deferred', `${detail} (DRILL-DEFERRED: green exit, zero teardown, zero page)`);
      return verdictOf({ asserts, verdict: 'DEFERRED', redClass: null, stuck: false, tasks: 0, watchdogGreen: null, state, boundary, records, win, mmdd, drillIssueNum, comments });
    }
    add('A1', false, `project.issue === #${drillIssueNum || '(unset)'} + ^T-STG-[A-Z]-${mmdd}$ ids`, `issue=${JSON.stringify(stateIssue)} tasks=${stateTasks.length}`,
      'NO-EPOCH: the state is the pre-drill resting shape — the reopen landed but no epoch started tonight (the seed log carries the enqueue wait; the PAT-comment trigger law or the door lane is the suspect)');
    for (let i = 2; i <= 12; i++) add(`A${i}`, null, '—', '—', 'no-epoch: no drill epoch to assert against');
    return verdictOf({ asserts, verdict: 'RED', redClass: 'no-epoch', stuck: false, tasks: 0, watchdogGreen: null, state, boundary, records, win, mmdd, drillIssueNum, comments });
  }

  // ---- the drill epoch's expected arcs (behavior-aware, from the rollover)
  const gTasks = Array.isArray(boundary?.genesisSpec?.tasks) ? boundary.genesisSpec.tasks : [];
  const behaviorOf = new Map(gTasks.map((t) => [String(t?.id ?? ''), String(t?.behavior ?? '')]));
  const maxAttempts = Number(boundary?.genesisSpec?.config?.max_attempts) || 3;
  const drillTaskIds = new Set(gTasks.map((t) => String(t?.id ?? '')));
  const hasInfra = [...behaviorOf.values()].includes('infra-flaky');
  const hasHang = [...behaviorOf.values()].includes('hang');
  const expectedDone = gTasks.filter((t) => EXPECTED_STATUS[String(t?.behavior)] === 'done').length;
  // the R2 quality gate's own arithmetic (fsm.mjs:689): degraded = done*2 < n.
  // Behavior-aware: a stage-0 hang-only night (done 0/1) EXPECTS the degraded
  // verdict — the gate is working, not broken. The full mix (3/4) does not.
  const expectedDegraded = expectedDone * 2 < gTasks.length;

  const idPatternOk = stateTasks.length > 0 && stateTasks.every((t) => DRILL_ID_RE.test(String(t?.id ?? '')) && String(t.id).endsWith(`-${mmdd}`));
  add('A1', ours && idPatternOk,
    `project.issue === #${drillIssueNum} and every task id matches ^T-STG-[A-Z]-${mmdd}$`,
    `issue=#${stateIssue} ids=${stateTasks.map((t) => t.id).join(',') || '(none)'}`,
    idPatternOk ? 'the epoch is OURS (the lock check passed)' : `task ids do not match tonight's <MMDD>=${mmdd} (a stale T-STG epoch or a malformed seed body)`);

  // ---- A2: all tasks terminal, the per-behavior expected statuses --------
  {
    const nonTerminal = stateTasks.filter((t) => !TERMINAL.has(t?.status));
    const wrongArc = stateTasks.filter((t) => {
      const exp = EXPECTED_STATUS[behaviorOf.get(String(t.id))];
      return exp !== undefined && t?.status !== exp;
    });
    add('A2', nonTerminal.length === 0 && wrongArc.length === 0,
      `${gTasks.filter((t) => t?.behavior === 'fast').length}×done(fast) + ${gTasks.filter((t) => t?.behavior === 'infra-flaky').length}×done(infra) + ${hasHang ? 1 : 0}×quarantined(hang); zero non-terminal`,
      stateTasks.map((t) => `${t.id}:${t.status}`).join(' ') || '(no tasks)',
      nonTerminal.length ? `${nonTerminal.length} NON-TERMINAL task(s): ${nonTerminal.map((t) => `${t.id}:${t.status}`).join(', ')} (stuck — teardown takes the §4.2 recovery)`
        : wrongArc.length ? wrongArc.map((t) => `${t.id} expected ${EXPECTED_STATUS[behaviorOf.get(String(t.id))]} got ${t.status}`).join('; ')
        : 'all terminal with the expected per-behavior statuses');
  }

  // ---- A3: halt reached, the quality-gate verdict as expected ------------
  {
    const phaseRec = records.find((r) => r?.kind === 'PHASE' && r?.to === 'done') || null;
    const haltedDone = state?.chain?.halted === true && state?.project?.phase === 'done';
    const degradedMatches = phaseRec ? (phaseRec.degraded === true) === expectedDegraded : !expectedDegraded;
    add('A3', haltedDone && degradedMatches,
      `halted && phase done && PHASE degraded === ${expectedDegraded}${expectedDegraded ? ' (stage-0 hang night: the honest verdict)' : ''}`,
      `halted=${state?.chain?.halted} phase=${JSON.stringify(state?.project?.phase)} degraded=${phaseRec ? String(phaseRec.degraded === true) : '(no PHASE record)'} expectedDone=${expectedDone}/${gTasks.length}`,
      !haltedDone ? 'the chain did NOT reach halt+done (stuck — teardown takes the §4.2 recovery)'
        : !phaseRec ? 'no PHASE-done journal record in the epoch segment'
        : degradedMatches ? `halt reached with the expected quality-gate verdict (degraded=${expectedDegraded})`
        : `degraded mismatch: got ${phaseRec.degraded === true}, expected ${expectedDegraded} (done ${expectedDone}/${gTasks.length})`);
  }

  // ---- A4: zero double-applied (the dedup ring contract) -----------------
  {
    const applied = records.filter((r) => r?.kind === 'REPORT' && r.applied !== false);
    const byKey = new Map();
    for (const r of applied) {
      const k = `${r.task}|${r.event_id}`;
      byKey.set(k, (byKey.get(k) || 0) + 1);
    }
    const doubles = [...byKey.entries()].filter(([, n]) => n > 1);
    const dupRejects = records.filter((r) => r?.kind === 'REJECTED' && r.reason === 'duplicate').length;
    add('A4', doubles.length === 0,
      '0 double-applies (a re-delivered id only ever lands as REJECTED duplicate)',
      `applied=${applied.length} double-applied=${doubles.length} duplicate-rejects=${dupRejects}`,
      doubles.length ? `DOUBLE-APPLIED (task|event_id) keys: ${doubles.slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', ')}`
        : `${applied.length} applied REPORT records, ${dupRejects} duplicate-rejects (the dedup ring journaled them, never re-applied)`);
  }

  // ---- A5: the attempts ladder --------------------------------------------
  {
    const problems = [];
    for (const t of stateTasks) {
      const b = behaviorOf.get(String(t.id));
      const exp = b === 'hang' ? maxAttempts : b === 'infra-flaky' ? 2 : 1;
      if (Number(t?.attempts) !== exp) problems.push(`${t.id}: attempts=${t?.attempts} expected ${exp} (${b || 'unknown'})`);
    }
    if (hasInfra) {
      const infraIds = gTasks.filter((t) => t?.behavior === 'infra-flaky').map((t) => String(t.id));
      if (!records.some((r) => r?.kind === 'REPORT' && infraIds.includes(String(r.task)) && r.to === 'ready' && r.reason === 'infra-retry')) {
        problems.push('no infra-retry REPORT record for the infra-flaky task (the infra report must drain as a retry, not a quarantine)');
      }
    }
    if (hasHang) {
      const hangIds = gTasks.filter((t) => t?.behavior === 'hang').map((t) => String(t.id));
      const timeouts = records.filter((r) => r?.kind === 'TIMEOUT' && hangIds.includes(String(r.task)));
      const toReady = timeouts.filter((r) => r.to === 'ready').length;
      const toQuarantined = timeouts.filter((r) => r.to === 'quarantined').length;
      if (toReady !== maxAttempts - 1 || toQuarantined !== 1) {
        problems.push(`hang TIMEOUT ladder: ${toReady}×to-ready + ${toQuarantined}×to-quarantined (expected ${maxAttempts - 1}×ready + 1×quarantined)`);
      }
    }
    add('A5', problems.length === 0,
      `fast=1, infra-flaky=2 (one infra-retry REPORT), hang=${maxAttempts} (${maxAttempts - 1} TIMEOUT to-ready + 1 to-quarantined)`,
      stateTasks.map((t) => `${t.id}:a${t?.attempts}`).join(' ') || '(no tasks)',
      problems.join('; ') || `the ladder matches the behaviors (max_attempts=${maxAttempts} adopted at the rollover)`);
  }

  // ---- A6: the overflow shape (the X26 evidence) --------------------------
  {
    const pool = drillRunPool(input.runsMain, input.runsMirror, drillTaskIds, win);
    const mirrorRuns = pool.filter((r) => r.bucket === 'mirror').length;
    const mainRuns = pool.filter((r) => r.bucket === 'main').length;
    const multi = gTasks.length >= 2;
    const ok = multi ? mirrorRuns >= 2 && mainRuns >= 1 : mirrorRuns === 0 && mainRuns >= 1;
    add('A6', ok,
      multi ? '≥2 mirror-bucket runs + ≥1 main-bucket run (the pre-flight overflow engaged)' : '0 mirror runs + ≥1 main run (stage-0 single-task: in-flight 0 never overflows)',
      `main=${mainRuns} mirror=${mirrorRuns} (in-window drill runs)`,
      ok ? (multi ? 'the X26 geometry: dispatch #1 main, #2+ overflowed to the mirror bucket' : 'the stage-0 shape: the single dispatch took the main lane')
        : 'the overflow shape does not match the mix (mirror runs missing or unexpected)');
  }

  // ---- A7: the union scan protected the mirror work (C-1) -----------------
  {
    const flips = records.filter((r) => r?.kind === 'REPORT' && String(r?.error) === 'dispatch-unverified' && drillTaskIds.has(String(r.task)));
    add('A7', flips.length === 0,
      '0 dispatch-unverified records for any drill task',
      `${flips.length} flip(s)`,
      flips.length ? `the union scan MISSED run(s): ${flips.map((r) => `${r.task} (${r.event_id})`).join(', ')}`
        : hasHang ? "zero flips — meaningful because the hang task's 15-min lease outlives the 720s flip window (the union scan SAW the mirror run; a main-only scan would have flipped)"
        : 'zero flips (no hang task tonight — the assert still guards every drill task against a false flip)');
  }

  // ---- A8: exactly ONE dispatch per task (C-2) ----------------------------
  {
    const pool = drillRunPool(input.runsMain, input.runsMirror, drillTaskIds, win);
    const byKey = new Map();
    for (const r of pool) {
      const k = `${r.taskId}#a${r.attempt}`;
      byKey.set(k, (byKey.get(k) || 0) + 1);
    }
    const dups = [...byKey.entries()].filter(([, n]) => n > 1);
    add('A8', dups.length === 0,
      'one run per (task, attempt) across BOTH ledgers',
      `${byKey.size} distinct (task,attempt) keys; duplicates: ${dups.length}`,
      dups.length ? `DOUBLE DISPATCH: ${dups.slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', ')} (the pre-flight arm's contract is broken)`
        : `${byKey.size} runs, no duplicates`);
  }

  // ---- A9: stats sane ------------------------------------------------------
  {
    const st = state?.stats || {};
    const problems = [];
    if (hasInfra && !(Number(st.infra_retries) >= 1)) problems.push(`infra_retries=${st.infra_retries} (expected ≥1 — the infra-flaky task's retry)`);
    if (hasHang && !(Number(st.timeouts) >= 2)) problems.push(`timeouts=${st.timeouts} (expected ≥2 — the hang task's lease ladder)`);
    if (Number(st.budget_pauses ?? 0) !== 0) problems.push(`budget_pauses=${st.budget_pauses} (a nightly pause arc is FORBIDDEN — §5.3's alert budget)`);
    if (Number(st.orphaned_reports ?? 0) !== 0) problems.push(`orphaned_reports=${st.orphaned_reports}`);
    add('A9', problems.length === 0,
      `infra_retries ${hasInfra ? '≥1' : 'n/a'}, timeouts ${hasHang ? '≥2' : 'n/a'}, budget_pauses 0, orphaned_reports 0`,
      `infra_retries=${st.infra_retries} timeouts=${st.timeouts} budget_pauses=${st.budget_pauses ?? 0} orphaned_reports=${st.orphaned_reports}`,
      problems.join('; ') || 'the stats match the expected arcs');
  }

  // ---- A10: the human plane closed ----------------------------------------
  {
    const started = comments.some((c) => /\*\*\[fsm\]\*\* Epoch started for this task/.test(c));
    const digestRe = expectedDegraded ? /\*\*\[fsm\]\*\* Epoch HALTED DEGRADED for this task/ : /\*\*\[fsm\]\*\* Epoch COMPLETE for this task/;
    const digest = comments.some((c) => digestRe.test(c));
    add('A10', started && digest,
      `the epoch-started note + the ${expectedDegraded ? 'HALTED DEGRADED' : 'COMPLETE'} digest on the drill issue`,
      `started=${started} digest=${digest} (of ${comments.length} comment(s))`,
      started && digest ? 'the operator thread closed the loop'
        : `missing: ${[!started && 'epoch-started note', !digest && `completion digest (${expectedDegraded ? 'HALTED DEGRADED' : 'COMPLETE'})`].filter(Boolean).join(' + ')}`);
  }

  // ---- A11: watchdog stayed green -----------------------------------------
  {
    const wdRuns = Array.isArray(input.watchdogRuns) ? input.watchdogRuns : null;
    const alerts = Array.isArray(input.alertIssues) ? input.alertIssues : null;
    const hasData = wdRuns !== null && alerts !== null;
    const inWinWd = hasData ? wdRuns.filter((r) => inWindowTs(r?.created_at, win)) : [];
    const okWd = inWinWd.some((r) => r?.status === 'completed' && r?.conclusion === 'success');
    const okAlerts = hasData && !alerts.some((it) => inWindowTs(it?.created_at, win));
    add('A11', hasData ? okWd && okAlerts : false,
      '≥1 watchdog run completed in-window with success; zero fsm-watchdog-alert issues created in-window',
      hasData ? `watchdog-runs-in-window=${inWinWd.length} (success: ${inWinWd.filter((r) => r?.status === 'completed' && r?.conclusion === 'success').length}); in-window alert issues=${alerts.filter((it) => inWindowTs(it?.created_at, win)).length}`
        : 'INPUT MISSING (watchdogRuns/alertIssues)',
      !hasData ? 'the caller did not supply the watchdog evidence (fail-noisy: never silently green)'
        : okWd && okAlerts ? 'a live self-ticking chain is fresh by construction — the scan stayed green'
        : `${!okWd ? 'no successful in-window watchdog run; ' : ''}${!okAlerts ? 'an fsm-watchdog-alert issue was CREATED in-window' : ''}`.trim());
  }

  // ---- A12: the rollover record -------------------------------------------
  {
    const gs = boundary?.genesisSpec;
    const noteOk = typeof boundary?.note === 'string' && new RegExp(`^intake-rollover issue #${drillIssueNum}$`).test(boundary.note);
    const shapeOk = boundary?.kind === 'CONTROL' && boundary?.command === 'reset'
      && String(gs?.mode) === 'mock'
      && String(gs?.issue ?? '') === drillIssueNum
      && Array.isArray(gs?.tasks) && gs.tasks.length === stateTasks.length
      && gs.tasks.every((t) => DRILL_ID_RE.test(String(t?.id ?? '')));
    add('A12', !!(boundary && noteOk && shapeOk),
      `journal CONTROL reset, note "intake-rollover issue #${drillIssueNum}", genesisSpec.mode='mock', tasks=${stateTasks.length}, ids ^T-STG-[A-Z]-\\d{4}$`,
      boundary ? `note=${JSON.stringify(boundary.note)} mode=${JSON.stringify(gs?.mode)} issue=${JSON.stringify(gs?.issue)} tasks=${gs?.tasks?.length ?? 'n/a'}` : 'NO boundary record in the journal segment',
      !boundary ? 'the epoch segment has no CONTROL-reset boundary (the rollover never journaled)'
        : `boundary ${boundary.id}: ${[!noteOk && 'note mismatch', boundary.kind !== 'CONTROL' && 'kind', String(gs?.mode) !== 'mock' && 'mode', String(gs?.issue ?? '') !== drillIssueNum && 'issue', Array.isArray(gs?.tasks) && gs.tasks.length !== stateTasks.length && 'task-count'].filter(Boolean).join('; ') || 'present and shaped as minted (conductor-core.mjs:719-733)'}`);
  }

  const stuck = !(state?.chain?.halted === true && stateTasks.every((t) => TERMINAL.has(t?.status)));
  return verdictOf({ asserts, verdict: null, redClass: null, stuck, tasks: gTasks.length, watchdogGreen: null, state, boundary, records, win, mmdd, drillIssueNum, comments });
}

// the common tail:GREEN/RED derivation + the DRILL-REPORT shape (the local
// drill's per-phase PASS/FAIL form, e2e/drill.mjs:868-881 — both modes report
// alike). Read timings ride metrics.reads (the reader injects them).
function verdictOf({ asserts, verdict, redClass, stuck, tasks, watchdogGreen, state, boundary, records, win, mmdd, drillIssueNum, comments, readTimings = null }) {
  const passed = asserts.filter((a) => a.ok === true).length;
  const failed = asserts.filter((a) => a.ok === false).length;
  if (verdict === null) {
    verdict = failed === 0 ? 'GREEN' : 'RED';
    redClass = failed === 0 ? null : 'assertion';
    watchdogGreen = (asserts.find((a) => a.id === 'A11')?.ok === true);
  }
  const wallMs = win.endMs - win.startMs;
  const phases = asserts.map((a) => ({
    name: `${a.id} · ${a.name}`,
    ok: a.ok !== false,
    ms: 0,   // the asserts evaluate in one read pass; the read timings ride metrics.reads
    asserts: 1,
    fails: a.ok === false ? 1 : 0,
    error: a.ok === false ? `${a.detail} (expected ${a.expected}; actual ${a.actual})` : a.detail,
  }));
  const report = {
    drill: `staged-${mmdd}`,
    issue: drillIssueNum !== '' ? Number(drillIssueNum) : null,
    started: new Date(win.startMs).toISOString(),
    wallMs,
    phases,
    asserts,
    metrics: {
      wallMs,
      tasks,
      journalRecords: records.length,
      boundary: boundary ? { id: boundary.id, note: boundary.note, mode: boundary.genesisSpec?.mode ?? null, tasks: boundary.genesisSpec?.tasks?.length ?? null } : null,
      state: state ? { seq: state.chain?.seq, halted: state.chain?.halted, phase: state.project?.phase, stats: state.stats } : null,
      comments: comments.length,
      ...(readTimings ? { reads: readTimings } : {}),
    },
    notModeled: [
      'the paid-LLM / cc lane (mock economics is the point — the X-series keeps that cadence, design §9 Q3)',
      'the PR/task-branch write-back lane (mock epochs skip it by design, task-pr.mjs:25,43)',
      'the >100-runs-in-window pagination tail (per_page=100, one page — the drill window bounds it; a full page logs loudly)',
    ],
    verdict,
  };
  return { verdict, deferred: verdict === 'DEFERRED', redClass, stuck, asserts, passed, failed, tasks, watchdogGreen, report };
}

// read-RED (the §3.4 class distinct from assertion-RED): the reader could
// not gather the evidence after 3 attempts. Twelve no-data asserts + a loud
// class marker — never silently green.
export function readRedVerdict({ err, win = {}, drillIssueNum = '' }) {
  const w = normWindow(win);
  const asserts = [];
  for (let i = 1; i <= 12; i++) {
    asserts.push({ id: `A${i}`, name: ASSERT_NAMES[`A${i}`], ok: false, expected: 'readable evidence', actual: 'READ FAILED', detail: `read-RED: ${String(err).slice(0, 200)}` });
  }
  const out = verdictOf({ asserts, verdict: 'RED', redClass: 'read', stuck: false, tasks: 0, watchdogGreen: false, state: null, boundary: null, records: [], win: w, mmdd: mmddOfMs(w.startMs), drillIssueNum, comments: [] });
  out.report.metrics.readError = String(err).slice(0, 300);
  return out;
}

// ---------------------------------------------------------------------------
// the I/O half — the thin reader
// ---------------------------------------------------------------------------

const READ_ATTEMPTS = 3;

async function main() {
  const drillIssueNum = String(process.env.DRILL_ISSUE ?? '').trim();
  const mirrorRepo = String(process.env.WORKER_REPO_2 || '').trim();
  const repo = repoName();
  const runStartedAt = process.env.RUN_STARTED_AT || new Date(Date.now() - 60 * 60_000).toISOString();
  const endMs = Date.now();
  const window = { start: runStartedAt, end: endMs };
  const readTimings = {};

  // ---- the git reads (state + journals), 3 attempts -----------------------
  const store = new Store({ cwd: process.cwd() });
  const gitRead = () => {
    try {
      store.fetch();
      const { state } = store.readState();
      if (!state) return { ok: false, err: 'state.json absent on fsm-state' };
      const journals = store.readJournals();
      return { ok: true, state, journals };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
    }
  };
  const tGit = Date.now();
  const g = await retryAsync(gitRead, { attempts: READ_ATTEMPTS, backoffMs: 3000, onRetry: (i, r) => console.log(`VERIFY-READ-RETRY git ${i} (${r.err})`) });
  readTimings.gitMs = Date.now() - tGit;
  if (!g.ok) {
    const v = readRedVerdict({ err: `git/state read failed after ${READ_ATTEMPTS} attempts: ${g.err}`, window, drillIssueNum });
    return finish(v, { window, readTimings });
  }
  const segment = epochSegment(g.journals);

  // ---- the API reads, 3 attempts each -------------------------------------
  const tApi = Date.now();
  const fetchRuns = async (targetRepo, wf, token) => {
    const r = await retryAsync(() => api(`/repos/${targetRepo}/actions/workflows/${wf}/runs?per_page=100`, { token }), { attempts: READ_ATTEMPTS, backoffMs: 3000 });
    if (r.status !== 200) throw new Error(`runs fetch ${targetRepo}/${wf} HTTP ${r.status} after ${READ_ATTEMPTS} attempts`);
    const runs = r.data?.workflow_runs || [];
    if (runs.length >= 100) console.log(`VERIFY-RUNS-PAGE-FULL repo=${targetRepo} wf=${wf} — runs past this page are invisible (the drill window bounds it; no pagination loop)`);
    return runs;
  };
  try {
    const [runsMain, runsMirror, watchdogRuns, alertIssues, comments] = await Promise.all([
      fetchRuns(repo, 'worker.yml', process.env.GH_TOKEN || process.env.LAB_PAT),
      mirrorRepo ? fetchRuns(mirrorRepo, 'worker.yml', process.env.LAB_PAT) : Promise.resolve([]),
      fetchRuns(repo, 'watchdog.yml', process.env.GH_TOKEN || process.env.LAB_PAT),
      (async () => {
        const r = await retryAsync(() => api(`/repos/${repo}/issues?state=open&labels=fsm-watchdog-alert&per_page=10`, { token: process.env.GH_TOKEN || process.env.LAB_PAT }), { attempts: READ_ATTEMPTS, backoffMs: 3000 });
        if (r.status !== 200) throw new Error(`alert-issue search HTTP ${r.status} after ${READ_ATTEMPTS} attempts`);
        return r.data || [];
      })(),
      (async () => {
        if (!/^\d+$/.test(drillIssueNum)) return [];
        const r = await retryAsync(() => api(`/repos/${repo}/issues/${drillIssueNum}/comments?per_page=100`, { token: process.env.GH_TOKEN || process.env.LAB_PAT }), { attempts: READ_ATTEMPTS, backoffMs: 3000 });
        if (r.status !== 200) throw new Error(`drill-issue comments HTTP ${r.status} after ${READ_ATTEMPTS} attempts`);
        return r.data || [];
      })(),
    ]);
    readTimings.apiMs = Date.now() - tApi;

    // the seed's mmdd cross-check (informational — the pure half derives the
    // MMDD from the window start; a mismatch means the drill crossed UTC
    // midnight, which the 01:37 window cannot)
    const seedMmdd = String(process.env.DRILL_MMDD || '').trim();
    const winMmdd = mmddOfMs(Date.parse(runStartedAt));
    if (seedMmdd && seedMmdd !== winMmdd) console.log(`VERIFY-MMDD-NOTE seed=${seedMmdd} window=${winMmdd} (a midnight crossing — the id pattern keys on the window start)`);

    const v = runVerdict({
      state: g.state,
      journalSegment: segment,
      runsMain,
      runsMirror,
      drillIssue: { number: drillIssueNum, comments },
      window,
      watchdogRuns,
      alertIssues,
    });
    v.report.metrics.reads = readTimings;
    return finish(v, { window, readTimings });
  } catch (e) {
    const v = readRedVerdict({ err: String(e?.message ?? e), window, drillIssueNum });
    v.report.metrics.reads = readTimings;
    return finish(v, { window, readTimings });
  }
}

// finish(): the outputs + the DRILL-REPORT artifact + the exit code.
async function finish(v, { window, readTimings }) {
  const wallMin = Math.max(1, Math.round(((window.end ? toMs(window.end) : Date.now()) - toMs(window.start)) / 60_000));
  const failedIds = v.asserts.filter((a) => a.ok === false).map((a) => a.id).join(',');
  emitOutput('verdict', v.verdict);
  emitOutput('deferred', v.deferred ? 'true' : 'false');
  emitOutput('stuck', v.stuck ? 'true' : 'false');
  emitOutput('redClass', v.redClass || '');
  emitOutput('failed', failedIds);
  emitOutput('wallMin', String(wallMin));
  emitOutput('tasks', String(v.tasks));
  emitOutput('assertsPassed', String(v.passed));
  emitOutput('assertsTotal', String(v.asserts.length));
  emitOutput('watchdogGreen', v.watchdogGreen === true ? 'true' : v.watchdogGreen === null ? '' : 'false');

  const reportPath = join(dirname(fileURLToPath(import.meta.url)), 'last-staged-report.json');
  try {
    writeFileSync(reportPath, JSON.stringify(v.report, null, 2) + '\n');
  } catch (e) {
    console.log(`VERIFY-REPORT-WRITE-FAILED (${e.message}) — the stdout line + step summary still carry it`);
  }
  console.log(`\nSTAGED-DRILL-REPORT ${JSON.stringify(v.report)}`);
  const rows = v.asserts.map((a) => `| ${a.id} | ${a.name} | ${a.ok === true ? '✅' : a.ok === false ? '❌' : '—'} | ${String(a.detail).replace(/\|/g, '\\|').slice(0, 160)} |`).join('\n');
  emitSummary(`## fsm-staged-drill verify — ${v.verdict}${v.redClass ? ` (${v.redClass})` : ''}\n\n| # | invariant | verdict | detail |\n|---|---|---|---|\n${rows}\n\nverdict **${v.verdict}** · asserts ${v.passed}/${v.asserts.length} · wall ${wallMin} min · report artifact: staged-drill-report\n`);

  console.log(`STAGED-DRILL-VERIFY ${v.verdict}${v.redClass ? ` class=${v.redClass}` : ''} asserts=${v.passed}/${v.asserts.length} failed=[${failedIds}] stuck=${v.stuck} wall=${wallMin}min`);
  process.exitCode = v.verdict === 'RED' ? 1 : 0;
}

// Direct-run guard (the watchdog/scan.mjs:497 pattern).
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch(e => {
    console.error('VERIFY-FAILED:', e.message);
    process.exitCode = 1;
  });
}
