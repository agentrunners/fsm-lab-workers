#!/usr/bin/env node
// e2e/staged/seed.mjs — the STAGED DRILL's SEED (s22 design §1.6/§2.2, B-0).
//
// The epoch's genesis is the REAL intake door: `issues: [opened, reopened]`
// (intake.yml:23-24). Two platform facts force this driver's shape:
//   - a GITHUB_TOKEN-authored issue event fires NO workflows (the
//     anti-recursion law) — the seed reopens the drill issue with
//     secrets.LAB_PAT (a real-user token) so the door actually wakes;
//   - the door gates the ISSUE's author (`it.user.login`,
//     intake/turn.mjs:84) — the drill issue is created ONCE by a write-class
//     operator; every nightly reopen passes on the author's standing
//     permission, whoever performs the reopen.
//
// The pinned-issue cycle (§1.6): PATCH the body with tonight's dated spec
// block (PAT — `issues: edited` fires nothing), then REOPEN (PAT —
// `issues: reopened` wakes the door). The dated body means a fresh
// body_sha8 each night, so the door's dedup (issue + body_sha8) never
// suppresses the nightly enqueue while an accidental double-reopen in one
// night IS suppressed — idempotence by existing mechanism.
//
// STAGE 0 (this build — the door is single-task until B-1 lands): the spec
// alternates by WEEKDAY (§2.2's stage-0 rotation): Mon/Thu/Fri/Sat/Sun
// `fast`, Tue `infra-flaky`, Wed `hang` (lease 15 — the full 3-attempt
// ladder ≈ 48 min). The `full` 4-task mix (A fast + B mirror-overflow +
// C infra + H hang) renders too but stays DORMANT behind DRILL_MIX until
// B-1's multi-task door exists (selecting it now would die at the door's
// unknown-key rejection).
//
// Exit codes (visible, never silently green):
//   0 — decided: seeded (PATCH+REOPEN landed, enqueue observed) OR the F3
//       green-skip (a write failed after 2 attempts: no epoch, the queue was
//       never touched — retry next night)
//   1 — the enqueue-wait TIMED OUT: the reopen landed but the door never
//       enqueued (the PAT-comment trigger law / the door itself failed — a
//       REAL drill failure; verify takes the no-epoch RED path and teardown
//       closes the reopened issue)

import { Store } from '../../lib/store.mjs';
import { bodySha8 } from '../../lib/intake.mjs';
import { pathToFileURL } from 'node:url';
import { api, emitOutput, repoName, retryAsync } from './lib.mjs';

// ---------------------------------------------------------------------------
// the PURE half — the body template (date-substituted)
// ---------------------------------------------------------------------------

// The stage-0 weekday rotation (§2.2): Mon fast, Tue infra-flaky, Wed hang,
// Thu/Fri fast, and the design's elided weekend completed with fast (the
// cheap one-pass shape — the conservative completion of the "…").
export const WEEKDAY_BEHAVIORS = ['fast', 'fast', 'infra-flaky', 'hang', 'fast', 'fast', 'fast'];   // Sun..Sat (getUTCDay order)

export function weekdayBehavior(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) throw new Error(`weekdayBehavior: unparseable date ${String(date)}`);
  return WEEKDAY_BEHAVIORS[d.getUTCDay()];
}

// The task LETTER per behavior — the SAME letters the full mix uses
// (A=fast happy, C=infra retry, H=hang lease-expiry), so the id pattern
// ^T-STG-.*-<MMDD>$ and the A-table's per-behavior expectations stay
// coherent across both stages.
const LETTER_BY_BEHAVIOR = { fast: 'A', 'infra-flaky': 'C', hang: 'H' };

export function mmddOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) throw new Error(`mmddOf: unparseable date ${String(date)}`);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const DRILL_LEASE_MINUTES = 15;   // §2.1: the epoch-wide lease (the spec knob rides A4-F1 unchanged)
export const DRILL_MODE = 'mock';        // §1.5: pinned in the spec — the drill never reads vars.EPOCH_MODE

// renderDrillBody({date, mix}) -> { body, mmdd, leaseMinutes, mode, tasks:[{id,behavior,title}] }
//
// The fenced `fsm-task` block the door parses (lib/intake.mjs parseSpecBlock
// — 3-or-4-backtick fences, `key: value` lines, unknown keys rejected at
// validateSpec). Tonight's date rides BOTH the task ids (the <MMDD> suffix —
// unique per night, the law-4 id-reuse hazard cannot arise) and the header
// line (a fresh body_sha8 each night even for the same weekday behavior).
export function renderDrillBody({ date = new Date(), mix = 'stage0' } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const mmdd = mmddOf(d);
  const isoDay = d.toISOString().slice(0, 10);
  let tasks;
  if (mix === 'full') {
    // §2.2's 4-task mix (B-1's shape — dormant until the multi-task door)
    tasks = [
      { id: `T-STG-A-${mmdd}`, behavior: 'fast', title: 'staged nightly A (happy path)' },
      { id: `T-STG-B-${mmdd}`, behavior: 'fast', title: 'staged nightly B (mirror overflow)' },
      { id: `T-STG-C-${mmdd}`, behavior: 'infra-flaky', title: 'staged nightly C (infra retry)' },
      { id: `T-STG-H-${mmdd}`, behavior: 'hang', title: 'staged nightly H (lease expiry)' },
    ];
  } else {
    // stage 0: ONE task, the weekday rotation
    const behavior = weekdayBehavior(d);
    const letter = LETTER_BY_BEHAVIOR[behavior] || 'A';
    tasks = [{ id: `T-STG-${letter}-${mmdd}`, behavior, title: `staged nightly ${letter} (${behavior} night)` }];
  }
  const specLines = [
    `mode: ${DRILL_MODE}`,
    `lease_minutes: ${DRILL_LEASE_MINUTES}`,
    ...tasks.map((t) => `id: ${t.id}`),
    ...tasks.map((t) => `title: ${t.title}`),
    ...tasks.map((t) => `behavior: ${t.behavior}`),
  ];
  const body = [
    `**Staged drill — ${isoDay}** (${mix === 'full' ? 'full 4-task mix' : 'stage 0 · single-task'} · ${tasks.map((t) => t.behavior).join(' + ')})`,
    '',
    'The nightly spec (auto-patched by the seed job each night; the intake door parses the fenced block):',
    '',
    '```fsm-task',
    ...specLines,
    '```',
  ].join('\n') + '\n';
  return { body, mmdd, leaseMinutes: DRILL_LEASE_MINUTES, mode: DRILL_MODE, tasks };
}

// ---------------------------------------------------------------------------
// the I/O half
// ---------------------------------------------------------------------------

async function main() {
  const drillIssue = String(process.env.DRILL_ISSUE ?? '').trim();
  const pat = process.env.LAB_PAT;
  const mix = String(process.env.DRILL_MIX || 'stage0').trim();
  const repo = repoName();
  const enqueueWaitMs = (Number(process.env.SEED_ENQUEUE_WAIT_S) > 0 ? Number(process.env.SEED_ENQUEUE_WAIT_S) : 300) * 1000;
  const pollMs = 10_000;

  // the config pre-pass (the gate already SKIPs on this — but the seed is
  // also runnable by hand; fail the same green way, never a half-write)
  if (!/^\d+$/.test(drillIssue) || !pat) {
    console.log(`STAGED-DRILL-SEED-SKIP config (DRILL_ISSUE="${drillIssue}" LAB_PAT=${pat ? 'set' : 'MISSING'}) — the operator one-time setup has not happened; nothing written`);
    emitOutput('seeded', 'false');
    emitOutput('enqueued', 'false');
    emitOutput('mmdd', '');
    return;
  }

  const rendered = renderDrillBody({ date: new Date(), mix });
  console.log(`STAGED-DRILL-SEED issue #${drillIssue} mix=${mix} mmdd=${rendered.mmdd} tasks=${rendered.tasks.map((t) => `${t.id}:${t.behavior}`).join(',')} lease=${rendered.leaseMinutes}min mode=${rendered.mode}`);

  // 0) guarantee a genuine closed→open transition: a LEFT-OPEN issue (last
  // night's teardown failed, or a same-night manual re-run) would make the
  // state PATCH a no-op and NO `issues: reopened` event would fire — the
  // door would never wake and the night would burn in the enqueue wait.
  // `issues: closed` fires nothing (intake.yml triggers only opened/reopened).
  const getIssue = () => api(`/repos/${repo}/issues/${drillIssue}`, { token: pat });
  const cur = await retryAsync(getIssue, { attempts: 2, backoffMs: 2000 });
  if (cur.status !== 200) {
    console.log(`STAGED-DRILL-SEED-SKIP read (GET issue HTTP ${cur.status} after 2 attempts — nothing written, retry next night; F3)`);
    emitOutput('seeded', 'false');
    emitOutput('enqueued', 'false');
    emitOutput('mmdd', '');
    return;
  }
  if (String(cur.data?.state) !== 'closed') {
    const close = await retryAsync(() => api(`/repos/${repo}/issues/${drillIssue}`, { method: 'PATCH', body: { state: 'closed' }, token: pat }), { attempts: 2, backoffMs: 2000 });
    if (close.status !== 200) {
      console.log(`STAGED-DRILL-SEED-SKIP close-first (HTTP ${close.status} after 2 attempts — cannot guarantee the reopened transition; nothing enqueued, retry next night; F3)`);
      emitOutput('seeded', 'false');
      emitOutput('enqueued', 'false');
      emitOutput('mmdd', '');
      return;
    }
    console.log('STAGED-DRILL-SEED-CLOSE-FIRST (the issue was open — closed it so the reopen is a genuine transition)');
  }

  // 1) PATCH the body (PAT; `issues: edited` fires nothing) — 2 attempts (§7 F3).
  const patchBody = () => api(`/repos/${repo}/issues/${drillIssue}`, { method: 'PATCH', body: { body: rendered.body }, token: pat });
  const pb = await retryAsync(patchBody, { attempts: 2, backoffMs: 2000 });
  if (pb.status !== 200) {
    console.log(`STAGED-DRILL-SEED-SKIP body-patch (HTTP ${pb.status} after 2 attempts — no epoch, the queue was never touched, retry next night; F3)`);
    emitOutput('seeded', 'false');
    emitOutput('enqueued', 'false');
    emitOutput('mmdd', '');
    return;
  }
  console.log(`STAGED-DRILL-SEED-BODY-PATCHED sha8=${bodySha8(rendered.body)}`);

  // 2) REOPEN (PAT — `issues: reopened` wakes the door) — 2 attempts.
  const reopen = () => api(`/repos/${repo}/issues/${drillIssue}`, { method: 'PATCH', body: { state: 'open' }, token: pat });
  const ro = await retryAsync(reopen, { attempts: 2, backoffMs: 2000 });
  if (ro.status !== 200) {
    console.log(`STAGED-DRILL-SEED-SKIP reopen (HTTP ${ro.status} after 2 attempts — no epoch, the queue was never touched, retry next night; F3)`);
    emitOutput('seeded', 'false');
    emitOutput('enqueued', 'false');
    emitOutput('mmdd', '');
    return;
  }
  console.log('STAGED-DRILL-SEED-REOPENED (the door is waking — enqueue expected within seconds-to-a-minute)');

  // the reopen LANDED: from here the issue is open and teardown's close is
  // required on every exit path — seeded=true from now on.
  emitOutput('seeded', 'true');
  emitOutput('mmdd', rendered.mmdd);

  // 3) wait-for-enqueue poll (git reads — the same Store the door writes
  // through): the door's queue line {issue, body_sha8} for TONIGHT's body.
  const store = new Store({ cwd: process.cwd() });
  const sha8 = bodySha8(rendered.body);
  const t0 = Date.now();
  for (;;) {
    try {
      store.fetch();
      const line = store.readIntakeQueue().find((l) => String(l.issue) === String(drillIssue) && l.body_sha8 === sha8);
      if (line) {
        console.log(`STAGED-DRILL-ENQUEUED after ${Math.round((Date.now() - t0) / 1000)}s (queue line: issue #${line.issue} sha8=${line.body_sha8} id=${line.spec?.id ?? '?'} — the rollover is seconds away)`);
        emitOutput('enqueued', 'true');
        return;
      }
    } catch (e) {
      console.log(`SEED-POLL-READ-RETRY (${String(e?.message ?? e).slice(0, 120)})`);
    }
    if (Date.now() - t0 > enqueueWaitMs) break;
    await new Promise(res => setTimeout(res, pollMs));
  }

  // the reopen landed but the door never enqueued: a REAL drill failure (the
  // PAT-comment trigger law / the door lane). The run job goes red; verify's
  // no-epoch path pages through teardown, which also closes the reopened issue.
  console.error(`STAGED-DRILL-SEED-ENQUEUE-TIMEOUT after ${Math.round(enqueueWaitMs / 1000)}s — the reopen landed but the door never enqueued (the trigger law or the door lane failed; verify takes the no-epoch path)`);
  emitOutput('enqueued', 'false');
  process.exitCode = 1;
}

// Direct-run guard (the watchdog/scan.mjs:497 pattern).
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch(e => {
    console.error('SEED-FAILED:', e.message);
    process.exitCode = 1;
  });
}
