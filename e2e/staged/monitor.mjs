#!/usr/bin/env node
// e2e/staged/monitor.mjs — the STAGED DRILL's MONITOR (s22 design §8 B-0;
// §2.3's wall budget).
//
// The poll loop: fetch `fsm-state` every 60 s (git reads — the watchdog's
// own read pattern, watchdog/scan.mjs:402-404), log progress checkpoints
// (genesis seen / assigns seen / reports draining / the foreign-epoch
// observation), exit 0 on `chain.halted && phase === 'done'`, exit 1 on the
// 55-min timeout. The run job's timeout-minutes:70 is the ALARM line above
// it (§7 F2); the monitor's own 55 min leaves the margin.
//
// The monitor NEVER writes and NEVER dispatches — it only watches. The
// foreign-epoch case (a real issue won the queue head in the seconds between
// gate-pass and the drill's enqueue, §1.4's residual race) is LOGGED here
// but the decision belongs to verify (the DRILL-DEFERRED path): the monitor
// keeps polling to halt-or-timeout either way — the epoch it watches is
// whatever the state says, and a foreign epoch that halts within the window
// exits 0 cleanly (verify then sees the foreign boundary and defers, green,
// zero teardown, zero page).
//
// Outputs (GITHUB_OUTPUT): halted ('true'|'false'), wallMin.

import { Store } from '../../lib/store.mjs';
import { pathToFileURL } from 'node:url';
import { emitOutput, envInt } from './lib.mjs';

const POLL_S = envInt('MONITOR_POLL_S', 60);
// s23 (attempt 3's live catch — the resting-shape race): the seed's
// door+rollover latency (~15s live) can trail the monitor's first poll; a
// halted+done read in the opening seconds is the PREDECESSOR'S resting
// shape, not tonight's completion (attempt 3: poll at seed+1s saw the
// halted drill-epoch-#1, the boundary landed at seed+4s, the monitor
// declared DONE on an epoch that was seconds old). The birth-wait: ignore
// the halt-exit until the wait elapses; a legitimate epoch cannot reach
// halt inside it (the fastest mock task needs ~30s+ of worker+drain).
const BIRTH_WAIT_MS = Math.max(POLL_S * 2, 120) * 1000;

// s23: the pure birth-wait predicate (exported for the unit pins). A
// halted+done read is only an admissible EXIT once the birth-wait has
// elapsed — inside the wait the read is presumed the predecessor's
// resting shape (the seed's door+rollover latency can trail the first
// poll).
export function haltExitAllowed(elapsedMs, birthWaitMs = BIRTH_WAIT_MS) {
  return Number.isFinite(elapsedMs) && elapsedMs >= birthWaitMs;
}
const TIMEOUT_MIN = envInt('MONITOR_TIMEOUT_MIN', 55);

async function main() {
  const drillIssue = String(process.env.DRILL_ISSUE ?? '').trim();
  const store = new Store({ cwd: process.cwd() });
  const t0 = Date.now();
  const deadlineMs = t0 + TIMEOUT_MIN * 60_000;

  // the checkpoint state — each fires its LOUD line exactly once
  const seen = { genesis: false, foreign: false, assigns: false, draining: false, halt: false };

  const readState = () => {
    try {
      store.fetch();
      const { state } = store.readState();
      return state || null;
    } catch {
      return null;   // transient git/fetch failure — the next poll retries
    }
  };

  console.log(`STAGED-DRILL-MONITOR start issue=#${drillIssue || '?'} poll=${POLL_S}s timeout=${TIMEOUT_MIN}min`);

  for (;;) {
    const s = readState();
    if (s && s.chain) {
      const tasks = s.tasks && typeof s.tasks === 'object' ? Object.values(s.tasks) : [];
      const active = tasks.filter((t) => t?.status === 'assigned' || t?.status === 'in_progress');
      const done = Number(s.stats?.done) || 0;
      const quarantined = Number(s.stats?.quarantined) || 0;
      const ours = String(s.project?.issue ?? '') === drillIssue && drillIssue !== '';

      if (ours && !seen.genesis && tasks.length > 0) {
        seen.genesis = true;
        console.log(`CHECKPOINT GENESIS-SEEN issue=#${drillIssue} chain=${s.chain.id} tasks=${tasks.length} (${tasks.map((t) => t.id).join(', ')})`);
      }
      if (!ours && !s.chain.halted && !seen.foreign) {
        seen.foreign = true;
        console.log(`CHECKPOINT FOREIGN-EPOCH state.project.issue=${JSON.stringify(s.project?.issue)} != drill #${drillIssue} — a real epoch won the queue head (§1.4's residual race); the drill DEFERS (verify decides; zero teardown, zero page)`);
      }
      if (active.length > 0 && !seen.assigns) {
        seen.assigns = true;
        console.log(`CHECKPOINT ASSIGNS-SEEN ${active.length} task(s) assigned/in_progress (${active.map((t) => `${t.id}:a${t.attempts ?? '?'}`).join(', ')})`);
      }
      if ((done + quarantined) > 0 && !seen.draining) {
        seen.draining = true;
        console.log(`CHECKPOINT REPORTS-DRAINING done=${done} quarantined=${quarantined} (the report lane is flowing)`);
      }

      // the exit-0 condition (the design verbatim): halted + phase done —
      // a degraded halt also lands here (phase is still 'done'); the
      // quality-gate verdict is verify's A3, not the monitor's.
      if (s.chain.halted === true && s.project?.phase === 'done') {
        if (!haltExitAllowed(Date.now() - t0)) {
          if (!seen.birthWait) {
            seen.birthWait = true;
            console.log(`MONITOR-BIRTH-WAIT ${Math.round(BIRTH_WAIT_MS / 1000)}s — halted+done observed ${Math.round((Date.now() - t0) / 1000)}s in; the door+rollover latency band is ~15s, this may be the PREDECESSOR'S resting shape (the halt-exit is held until the wait elapses)`);
          }
        } else {
        if (!seen.halt) {
          seen.halt = true;
          console.log(`CHECKPOINT HALT-AND-DONE seq=${s.chain.seq} done=${done} quarantined=${quarantined} cancelled=${Number(s.stats?.cancelled) || 0} degraded-shape=${done * 2 < tasks.length ? 'yes (expected on hang-only stage-0 nights)' : 'no'}`);
        }
        const wallMin = Math.max(1, Math.round((Date.now() - t0) / 60_000));
        console.log(`STAGED-DRILL-MONITOR-DONE halted=true wall=${wallMin}min (epoch complete — verify takes the assertion pass)`);
        emitOutput('halted', 'true');
        emitOutput('wallMin', String(wallMin));
        return;
      }
      }

      console.log(`MONITOR seq=${s.chain.seq} phase=${s.project?.phase ?? '?'} halted=${s.chain.halted} tasks=${tasks.length} active=${active.length} done=${done} quarantined=${quarantined} epoch=${ours ? 'ours' : (s.project?.issue ?? '?')}`);
    } else {
      console.log(`MONITOR state-unreadable-yet (retry next poll; ${Math.round((Date.now() - t0) / 1000)}s in)`);
    }

    if (Date.now() + POLL_S * 1000 > deadlineMs) break;
    await new Promise(res => setTimeout(res, POLL_S * 1000));
  }

  // the 55-min timeout: exit 1 — the run job goes red, verify runs anyway
  // (if:always() — it IS the stuck-detector) and teardown's stuck-recovery
  // arm (§4.2) takes the reset decision from the state it reads there.
  const wallMin = Math.max(1, Math.round((Date.now() - t0) / 60_000));
  console.error(`STAGED-DRILL-MONITOR-TIMEOUT after ${wallMin}min (no halted+done — the drill is stuck; verify+teardown take the §4.2 recovery path)`);
  emitOutput('halted', 'false');
  emitOutput('wallMin', String(wallMin));
  process.exitCode = 1;
}

// Direct-run guard (the watchdog/scan.mjs:497 pattern).
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch(e => {
    console.error('MONITOR-FAILED:', e.message);
    process.exitCode = 1;
  });
}
