// watchdog/scan.mjs — the chain-health backstop.
//
// The watchdog NEVER writes state (single-writer discipline: the conductor
// group owns state). Its powers are READ + DISPATCH + ALERT-ISSUE only:
//   1. read state (via git fetch of the fsm-state branch — read-only)
//   2. T46/W-C2 (§5a, F-15): transcript GC — BEFORE the halted/paused exits
//      (a completed epoch is the GC's PRIMARY target, so the pass runs even
//      when the chain is halted). Deletes aged transcripts of TERMINAL
//      tasks from the fsm-sessions branch in ONE commit per scan — that
//      deletion commit IS the audit (F-15b: no journal record, no fsm-state
//      write; fsm-state interaction stays READ-ONLY, charter kept). The
//      pass is fully contained: any failure logs GC-ERROR and the scan's
//      primary duty (staleness/latch/alert) proceeds undisturbed.
//   3. if halted/paused -> exit (chain stopped on purpose)
//   4. staleness = now - chain.last_tick > stale_after
//   5. if stale AND no conductor run in flight -> the latch decision
//      (lib/watchdog-core.mjs — T45/F-B): the newest 3 watchdog-reprime runs
//      ALL created after chain.last_tick = N consecutive re-primes with ZERO
//      chain progress -> LATCHED: stop re-priming, open/refresh ONE alert
//      issue. Re-arm = ANY applied tick (auto-release — the operator's manual
//      fsm-tick dispatch, already printed in every alert body; derived state,
//      nothing persisted). NOT latched -> re-prime.
//   6. alert comments are 24h-deduped by the newest TRUSTED marker
//      (lib/watchdog-core.mjs alertDedup — T45/F-D: per_page=20&desc fetch,
//      newest-marker-by-created_at, author gate {MEMBER,COLLABORATOR,OWNER} ∪
//      Bot — strangers cannot suppress a live alert).
//   7. if state.json is corrupt -> alert issue (the conductor self-heals on
//      its next tick via findLastGoodState; if the chain is dead, the
//      re-prime dispatch triggers that recovery path)
//
// Cadence: schedule (intermittent) + manual dispatch. The conductor chain is
// the primary driver; this is the safety net that catches dead links.

import { Store } from '../lib/store.mjs';
import {
  breakerDecision, alertDedup, LATCH_REPRIMES,
  gcDaysFromEnv, gcPlan, gcParseTouchLog, gcCommitMessage,
  GC_TREE_LIMIT, GC_DAY_MS,
} from '../lib/watchdog-core.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

// ---------------------------------------------------------------------------
// T46/W-C2 (§5a, F-15): the transcript-GC pass — the git lane.
//
// Age source (DECIDED — the brief leaves it open): a read-only shallow clone
// `git clone --shallow-since=<now-(gcDays+2)d> --branch fsm-sessions
// --single-branch` (mirrors worker/cc-adapter.mjs pushSessionsBranch's clone
// shape). Listing: `git ls-tree -r --name-only HEAD`. Age map: `git log
// --name-only --format='@@@%H %cI'` → newest-touching-commit per path (the
// REST trees API has no mtime; the commits-list endpoint has no per-commit
// file set). Paths outside the fetched window fall to the horizon rule
// (lib/watchdog-core.mjs gcParseTouchLog/gcPlan — fail-retention). The +2d
// slack in --shallow-since absorbs ≤2d of runner clock skew.
//
// Deletion lane (F-15b/d): per CAS attempt (≤3) — FRESH clone → re-list →
// re-decide on the FRESH read (the enqueueControl 3-way-refresh discipline;
// the W-C1-R m4 fold: the decision is re-derived inside every attempt, so a
// racing RE-PUSH of an old victim path resets its age and drops it from the
// victim set) → `git rm` → ONE commit → `git push HEAD:refs/heads/fsm-sessions`
// (FF-only: a non-FF rejection = a live transcript push raced → next attempt
// re-clones at the moved tip). The token appears ONLY in the git URL and is
// scrubbed from every error string (never in a log line or commit content).
// Scratch dir per attempt (mkdtemp) — the scan's checkout and the Store's
// remote-tracking refs are never touched.
// ---------------------------------------------------------------------------

const GC_CAS_ATTEMPTS = 3;
const GC_IDENTITY = ['-c', 'user.name=fsm-watchdog', '-c', 'user.email=fsm-watchdog@users.noreply.github.com'];

// FSM_SESSIONS_ORIGIN (test seam / ops override) wins; otherwise the github
// URL from GITHUB_REPOSITORY + the scan's own token lane (GH_TOKEN || LAB_PAT).
function sessionsRemote(env) {
  if (env.FSM_SESSIONS_ORIGIN) return { url: env.FSM_SESSIONS_ORIGIN, token: null };
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN || env.LAB_PAT;
  if (!repo || !token) return null;
  return { url: `https://x-access-token:${token}@github.com/${repo}.git`, token };
}

function gcAttempt({ url, token, sinceIso, state, nowMs, gcDays, log, hooks, attempt }) {
  // the token NEVER reaches a log line: the generic credential shape is
  // scrubbed first, then the literal token (belt + suspenders)
  const scrub = (s) => {
    let t = String(s).replace(/(x-access-token:)[^@\s'"]+(@)/g, '$1***$2');
    if (token) t = t.split(token).join('***');
    return t;
  };
  const scratch = mkdtempSync(join(tmpdir(), 'fsm-gc-'));
  try {
    const wc = join(scratch, 'wc');
    // X20 run-2 lesson: the workdir must exist before clone (clone `.` and
    // init both fail on a missing dir)
    mkdirSync(wc, { recursive: true });
    const git = (args) => spawnSync('git', args, { cwd: wc, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const clone = git(['clone', '-q', '--shallow-since', sinceIso, '--branch', 'fsm-sessions', '--single-branch', url, '.']);
    if (clone.status !== 0) {
      const err = scrub(clone.stderr || clone.error || `rc=${clone.status}`).trim();
      if (/Remote branch .* not found|not found in upstream/.test(err)) {
        log('GC-TRANSCRIPTS deleted=0 retained=0 (fsm-sessions branch absent)');
        return { ok: true, outcome: 'absent' };
      }
      if (/no commits selected for shallow requests/.test(err)) {
        // the WHOLE branch predates the window: every file is definitionally
        // older than gc_days (tip date < since = now-(gcDays+2)d). A tip-only
        // clone maps every file to the tip date — an UNDERSTATEMENT of every
        // true age — so the verdicts stay exact-in-the-safe-direction.
        rmSync(wc, { recursive: true, force: true });
        mkdirSync(wc, { recursive: true });
        const d1 = git(['clone', '-q', '--depth', '1', '--branch', 'fsm-sessions', '--single-branch', url, '.']);
        if (d1.status !== 0) {
          throw new Error(`sessions clone (depth-1 fallback) failed: ${scrub(d1.stderr || d1.error).trim().slice(0, 160)}`);
        }
        log('GC-WINDOW-EMPTY (branch predates the shallow window — tip-only clone; everything is definitionally aged)');
      } else {
        throw new Error(`sessions clone failed: ${err.slice(0, 160)}`);
      }
    }
    const tip = String(git(['rev-parse', 'HEAD']).stdout || '').trim();
    // test seam: the mid-flight tip move is injected between clone and push
    if (hooks && typeof hooks.afterClone === 'function') hooks.afterClone({ wc, tip, attempt });
    const ls = git(['ls-tree', '-r', '--name-only', 'HEAD']);
    if (ls.status !== 0) throw new Error(`ls-tree failed: ${scrub(ls.stderr).slice(0, 160)}`);
    const files = String(ls.stdout || '').split('\n').map(x => x.trim()).filter(Boolean);
    const lg = git(['log', '--name-only', '--format=@@@%H %cI', 'HEAD']);
    if (lg.status !== 0) throw new Error(`sessions log failed: ${scrub(lg.stderr).slice(0, 160)}`);
    const { touches, horizonMs } = gcParseTouchLog(lg.stdout);
    let plan = gcPlan({ files, touches, horizonMs, state, nowMs, gcDays });
    // EMPIRICAL FIX (the inter-epoch-gap root cause, probe-verified on a
    // file:// bare): a shallow clone's `git log --name-only` FABRICATES the
    // boundary commit's file set — the graft shows the boundary's FULL TREE
    // as added at the boundary's date. A path older than the window maps to
    // the (potentially fresh) boundary date: retained, ambiguous=0 — the
    // old ambiguous>0 trigger could NEVER fire, and prior-epoch residue (the
    // GC's bulk value) would be retained FOREVER whenever a fresh epoch
    // keeps re-bounding the window. A shallow log can never PROVE a file is
    // old enough: deepen whenever the clone is shallow and transcripts
    // exist; on deepen failure the shallow plan stands (fail-retention — the
    // safe direction; a fabricated fresh touch only ever retains).
    const shallowRepo = String(git(['rev-parse', '--is-shallow-repository']).stdout || '').trim() === 'true';
    if (shallowRepo && plan.transcriptCount > 0) {
      const up = git(['fetch', '-q', '--unshallow', 'origin']);
      if (up.status !== 0) {
        log(`GC-DEEPEN-SKIPPED (unshallow fetch failed; the shallow plan stands — fail-retention): ${scrub(up.stderr || up.error).trim().slice(0, 120)}`);
      } else {
        const lg2 = git(['log', '--name-only', '--format=@@@%H %cI', 'HEAD']);
        if (lg2.status === 0) {
          const deep = gcParseTouchLog(lg2.stdout);
          const plan2 = gcPlan({ files, touches: deep.touches, horizonMs: deep.horizonMs, state, nowMs, gcDays });
          log(`GC-DEEPENED (full history fetched — the shallow boundary fabricates touches; exact ages now)`);
          plan = plan2;
        }
      }
    }
    if (plan.deferred) {
      log(`GC-DEFERRED tree=${plan.treeCount} (limit ${GC_TREE_LIMIT}; no commit this scan)`);
      return { ok: true, outcome: 'deferred', treeCount: plan.treeCount };
    }
    if (plan.victims.length === 0) {
      log(`GC-TRANSCRIPTS deleted=0 retained=${plan.retained}`);
      return { ok: true, outcome: 'clean', retained: plan.retained };
    }
    const msg = gcCommitMessage({ victims: plan.victims, retained: plan.retained, ageDays: gcDays });
    const rm = git(['rm', '-q', '--', ...plan.victims]);
    if (rm.status !== 0) throw new Error(`git rm failed: ${scrub(rm.stderr).slice(0, 160)}`);
    const cm = git([...GC_IDENTITY, 'commit', '-q', '-m', msg.subject, '-m', msg.body]);
    if (cm.status !== 0) throw new Error(`gc commit failed: ${scrub(cm.stderr).slice(0, 160)}`);
    const sha = String(git(['rev-parse', '--short', 'HEAD']).stdout || '').trim();
    // no -q here: the rejection line must reach stderr for the CAS detection
    const push = git(['push', 'origin', 'HEAD:refs/heads/fsm-sessions']);
    if (push.status === 0) {
      log(`GC-COMMIT sha=${sha} (audit: the fsm-sessions deletion commit, branch history retains it)`);
      log(`GC-TRANSCRIPTS deleted=${plan.victims.length} retained=${plan.retained}`);
      return { ok: true, outcome: 'pushed', deleted: plan.victims.length, retained: plan.retained, sha };
    }
    const why = /\[rejected\]/.test(String(push.stderr || ''))
      ? 'non-fast-forward (live transcript push raced)'
      : `push-failed (${scrub(push.stderr || push.error || `rc=${push.status}`).trim().slice(0, 120)})`;
    log(`GC-CAS-RETRY attempt=${attempt}/${GC_CAS_ATTEMPTS} reason=${why}`);
    return { outcome: 'retry', reason: why };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// runTranscriptGc — the pass main() calls (F-15a placement). Contained:
// never throws into the scan; every failure is a log line + a soft return.
export async function runTranscriptGc({ state, env = process.env, log = () => {}, now = Date.now, hooks = {} } = {}) {
  const scrub = (s) => String(s).replace(/(x-access-token:)[^@\s'"]+(@)/g, '$1***$2');
  try {
    const remote = sessionsRemote(env);
    if (!remote) {
      log('GC-SKIP reason=no-remote (need GH_TOKEN/LAB_PAT + GITHUB_REPOSITORY, or FSM_SESSIONS_ORIGIN)');
      return { ok: true, outcome: 'skipped' };
    }
    const { days, adjusted, raw } = gcDaysFromEnv(env.TRANSCRIPT_GC_DAYS);
    if (adjusted === 'clamped') log(`GC-DAYS-CLAMP raw=${raw} -> ${days} (hard cap 90)`);
    else if (adjusted === 'defaulted' && raw != null) log(`GC-DAYS-DEFAULT raw=${raw} -> ${days} (must be an integer >= 1)`);
    const nowMs = now();
    // +2d slack: the shallow window must reach BEYOND the threshold so the
    // horizon rule collects prior-epoch residue while absorbing clock skew.
    const sinceIso = new Date(nowMs - (days + 2) * GC_DAY_MS).toISOString();
    let lastReason = 'unknown';
    for (let attempt = 1; attempt <= GC_CAS_ATTEMPTS; attempt++) {
      const r = gcAttempt({ url: remote.url, token: remote.token, sinceIso, state, nowMs, gcDays: days, log, hooks, attempt });
      if (r.outcome !== 'retry') return r;
      lastReason = r.reason;
    }
    log(`GC-ERROR cas-exhausted attempts=${GC_CAS_ATTEMPTS} last=${lastReason} (next scan retries)`);
    return { ok: false, outcome: 'exhausted', reason: lastReason };
  } catch (e) {
    log(`GC-ERROR ${scrub(String(e?.message ?? e)).slice(0, 200)}`);
    return { ok: false, outcome: 'error' };
  }
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

  // T46/W-C2 (§5a, F-15a — BINDING PLACEMENT): the transcript-GC pass runs
  // AFTER readState() and BEFORE the halted/paused early-exits — a completed
  // epoch is the GC's PRIMARY target, so the pass runs even on a halted
  // chain. Skipped when state was unreadable (above): absent-from-state
  // counts as terminal, and during a corrupt-state window that would read
  // as "every task is residue" — the worst moment to delete the audit trail.
  // Read-only over fsm-state (the charter); the ONLY write is the ONE
  // fsm-sessions deletion commit (F-15b: that commit is the audit).
  await runTranscriptGc({ state, env: process.env, log: console.log, now: Date.now });

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

// Direct-run guard: `node watchdog/scan.mjs` runs the scan; importing the
// module (tests/test-gc.mjs) must NOT run main() — the adapter's GC lane is
// unit-testable via the exported runTranscriptGc.
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch(e => {
    console.error('WATCHDOG-FAILED:', e.message);
    process.exitCode = 1;
  });
}
