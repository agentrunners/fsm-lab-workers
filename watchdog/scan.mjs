// watchdog/scan.mjs — the chain-health backstop.
//
// The watchdog NEVER writes state (single-writer discipline: the conductor
// group owns state). Its powers are READ + DISPATCH + ALERT-ISSUE only:
//   1. read state (via git fetch of the fsm-state branch — read-only)
//   2. if halted/paused -> exit (chain stopped on purpose)
//   3. staleness = now - chain.last_tick > stale_after
//   4. if stale AND no conductor run in flight -> the latch decision
//      (lib/watchdog-core.mjs — T45/F-B): the newest 3 watchdog-reprime runs
//      ALL created after chain.last_tick = N consecutive re-primes with ZERO
//      chain progress -> LATCHED: stop re-priming, open/refresh ONE alert
//      issue. Re-arm = ANY applied tick (auto-release — the operator's manual
//      fsm-tick dispatch, already printed in every alert body; derived state,
//      nothing persisted). NOT latched -> re-prime.
//   5. alert comments are 24h-deduped by the newest TRUSTED marker
//      (lib/watchdog-core.mjs alertDedup — T45/F-D: per_page=20&desc fetch,
//      newest-marker-by-created_at, author gate {MEMBER,COLLABORATOR,OWNER} ∪
//      Bot — strangers cannot suppress a live alert).
//   6. if state.json is corrupt -> alert issue (the conductor self-heals on
//      its next tick via findLastGoodState; if the chain is dead, the
//      re-prime dispatch triggers that recovery path)
//
// Cadence: schedule (intermittent) + manual dispatch. The conductor chain is
// the primary driver; this is the safety net that catches dead links.

import { Store } from '../lib/store.mjs';
import { breakerDecision, alertDedup, LATCH_REPRIMES } from '../lib/watchdog-core.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const PAT = process.env.LAB_PAT;
const TOKEN = process.env.GH_TOKEN || PAT; // X1a: job token first, PAT fallback
const STALE_AFTER_MS = parseInt(process.env.STALE_AFTER_MIN || '4', 10) * 60_000;

async function api(path, method = 'GET', body = null) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-watchdog',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  return { status: r.status, data };
}

async function findAlertIssue() {
  const r = await api(`/repos/${REPO}/issues?state=open&labels=fsm-watchdog-alert&per_page=10`);
  return (r.data || [])[0] || null;
}

async function openAlertIssue(body) {
  const existing = await findAlertIssue();
  if (existing) {
    // T44 rate-limit: comment only if the last marker comment is older than
    // 24h — a corrupt-state chain firing every ~2h scan was commenting the
    // same alert 12x/day (the alert issue itself is already deduped to ONE).
    // T45/F-D hardening: fetch per_page=20 (an operator reply being newest no
    // longer hides the marker) + the dedup decision lives in
    // lib/watchdog-core.mjs alertDedup — newest TRUSTED marker by created_at
    // (order-independent; W2-b law-20: sort/direction are ignored server-side)
    // + the author gate {MEMBER,COLLABORATOR,OWNER} ∪ Bot (strangers cannot
    // suppress a live alert; the watchdog's own posts pass via type Bot).
    const r = await api(`/repos/${REPO}/issues/${existing.number}/comments?per_page=20&sort=created&direction=desc`, 'GET');
    const dedup = alertDedup({ comments: r.data || [], nowMs: Date.now() });
    if (dedup.skip) {
      console.log(`WATCHDOG-ALERT-SKIP (recent trusted marker <24h on issue #${existing.number}: age=${dedup.markerAgeMin}min by=${dedup.markerBy})`);
      return existing.number;
    }
    await api(`/repos/${REPO}/issues/${existing.number}/comments`, 'POST', { body });
    return existing.number;
  }
  const r = await api(`/repos/${REPO}/issues`, 'POST', {
    title: 'WATCHDOG: chain dead — manual intervention required',
    labels: ['fsm-watchdog-alert'],
    body,
  });
  return r.data?.number || null;
}

// T45/F-B: the newest conductor runs (window-free — the latch is cadence-
// proof and must see re-primes hours apart; law-20 makes the selection
// order-independent anyway). per_page=100 bounds the call.
async function conductorRuns() {
  const r = await api(`/repos/${REPO}/actions/workflows/conductor.yml/runs?per_page=100`);
  return r.data?.workflow_runs || [];
}

async function main() {
  const store = new Store({ cwd: process.cwd() });
  store.fetch();
  const { state, corrupt } = store.readState();

  if (!state) {
    console.log(`state.json unreadable (corrupt=${!!corrupt}) — the conductor's recovery path handles it; alerting if chain is also stale`);
    const body = `**[fsm-watchdog]** state.json is UNREADABLE on ${store.branch}. The conductor self-heals via git-history recovery on its next tick.`;
    // still check chain liveness below with a null state — but we cannot know
    // halted/paused. Conservative: alert, no re-prime (avoid thrashing a
    // corrupt-state loop).
    await openAlertIssue(body);
    console.log('WATCHDOG-DONE mode=corrupt-state alert=opened no-reprime');
    return;
  }

  if (state.chain.halted) { console.log('WATCHDOG-DONE mode=halted (project complete or halted)'); return; }
  if (state.chain.paused) { console.log('WATCHDOG-DONE mode=paused (operator hold)'); return; }

  const age = Date.now() - Date.parse(state.chain.last_tick);
  const stale = age > STALE_AFTER_MS;
  console.log(`WATCHDOG-SCAN seq=${state.chain.seq} last_tick=${state.chain.last_tick} age=${Math.round(age / 1000)}s stale=${stale} done=${state.stats.done}/${Object.keys(state.tasks).length}`);

  if (!stale) { console.log('WATCHDOG-DONE mode=healthy'); return; }

  // stale: the latch decision (F-B) — ONE runs call covers both the in-flight
  // guard and the breaker predicate. T44 in-flight note: lookback 6min < the
  // conductor job timeout (10min) but benign: the conductor group is
  // cancel-in-progress:false — an extra re-prime QUEUES behind the live run
  // rather than cancelling it.
  const runs = await conductorRuns();
  const decision = breakerDecision({ state, recentRuns: runs, nowMs: Date.now() });
  if (decision.inflight > 0) {
    console.log(`WATCHDOG-DONE mode=stale-but-inflight (${decision.inflight} run(s) queued/running) — waiting`);
    return;
  }

  // the LATCH (F-B): the newest 3 re-primes ALL sit after last_tick — N
  // consecutive re-primes with zero chain progress. Latched -> do NOT
  // re-prime; open/refresh the ONE alert issue (24h-deduped comment,
  // F-D-hardened). Re-arm is ANY applied tick: if the operator's manual
  // fsm-tick lands, last_tick advances past the re-prime runs and the latch
  // condition is false on the next scan — re-priming resumes automatically.
  if (decision.latched) {
    const body = `**[fsm-watchdog LATCHED]** ${LATCH_REPRIMES} consecutive re-primes with NO chain progress (seq frozen at ${state.chain.seq}, last_tick ${state.chain.last_tick}) — re-priming is DISABLED until a tick lands.\n\n`
      + `Re-arm (the T43 breaker contract): fix the root cause, then dispatch ONE manual tick:\n`
      + `POST /repos/${REPO}/dispatches {"event_type":"fsm-tick","client_payload":{"reason":"manual"}}\n\n`
      + `If that tick lands, the latch releases automatically on the next scan.\n\n`
      + `1. read the last conductor run's log (Actions tab)\n`
      + `2. fix the root cause\n`
      + `3. dispatch the manual tick above (the re-arm)`;
    const n = await openAlertIssue(body);
    console.log(`WATCHDOG-DONE mode=latched alert=${n} reprimes=${decision.reprimesTotal} seq=${state.chain.seq} last_tick=${state.chain.last_tick} (re-prime disabled until a tick lands)`);
    return;
  }

  // re-prime (with one retry — a single transient 5xx must not lose it)
  let r = await api(`/repos/${REPO}/dispatches`, 'POST', {
    event_type: 'fsm-tick',
    client_payload: { reason: 'watchdog-reprime', stale_seq: state.chain.seq },
  });
  if (r.status !== 204) {
    await new Promise(res => setTimeout(res, 2000));
    r = await api(`/repos/${REPO}/dispatches`, 'POST', {
      event_type: 'fsm-tick',
      client_payload: { reason: 'watchdog-reprime', stale_seq: state.chain.seq },
    });
  }
  console.log(`WATCHDOG-REPRIME dispatch=${r.status} (recent re-primes=${decision.reprimesTotal}; latch trips at ${LATCH_REPRIMES} with no chain progress)`);
  console.log('WATCHDOG-DONE mode=reprime');
}

main().catch(e => {
  console.error('WATCHDOG-FAILED:', e.message);
  process.exitCode = 1;
});
