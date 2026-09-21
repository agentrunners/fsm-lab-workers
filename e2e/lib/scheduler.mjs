// e2e/lib/scheduler.mjs — the mini-GHA (s21 audit §5.2): the local mode's
// runner fleet. Consumes the ghapi stand-in's dispatch inbox and runs the
// REAL five turn-files as child processes.
//
// MODELED (per gha-shim + the live X-series data):
//   - per-workflow CONCURRENCY GROUPS: conductor {group: fsm-conductor,
//     cancel-in-progress: false} = ONE running + ONE pending, newest-wins
//     (an evicted pending is cancelled at submit — the lossiness that killed
//     run-per-report); worker {group: fsm-worker-<task>, cancel-in-progress:
//     true} (a re-assigned attempt supersedes the older run); intake/ops/
//     watchdog: one each.
//   - repo-wide ParallelCap(5) — the T7 class, modeled NOWHERE else in the
//     tree: per-repo run slots; a run due to start while the repo is full
//     QUEUES; a conductor run queued behind >=3 workers counts one
//     starvation event per poll interval (the burst12 metric's little
//     brother).
//   - dispatch -> run-start latency: 164s live-measured (X5), compressed by
//     --time-scale (default 0.01 -> ~1.6s), seeded jitter +-20%.
//   - timeout-minutes enforcement: SIGKILL the process GROUP; the conclusion
//     is CANCELLED (the T45/F-G(e) TTL-kill signature).
//   - the fsm-control fan-out: ONE repository_dispatch wakes BOTH
//     conductor.yml and ops.yml (both register the type) — the twin the F-1
//     reset guard exists for.
//   - issue events wake intake.yml (the scheduler's event delivery).
//   - worker.yml run-name `task-<id> · <behavior> · a<attempt>` — law-4's
//     matching key. conductor run-name `<reason> · conductor` /
//     `control:<cmd> · conductor` — the watchdog latch's re-prime match.
//
// NOT MODELED: PAT-comment trigger law (an actor-permissioned comment wake),
//   runner cold-start, minute quotas, cross-workflow contention beyond the
//   cap, matrix builds, check-runs.

import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '../../sim/gha-shim.mjs';

const WORKFLOW_OF_EVENT = {
  'fsm-tick': ['conductor'],
  'fsm-control': ['conductor', 'ops'],   // both workflows register the type
  'fsm-task': ['worker'],
};

const ENTRY = {
  conductor: 'conductor/turn.mjs',
  worker: 'worker/turn.mjs',
  intake: 'intake/turn.mjs',
  ops: 'ops/turn.mjs',
  watchdog: 'watchdog/scan.mjs',
};

const TIMEOUT_MIN = { conductor: 10, worker: 50, intake: 3, ops: 3, watchdog: 4 };

export function createScheduler({ world, ghapi, log = () => {}, timeScale = 0.01, dispatchLatencyMs = 164_000, parallelCap = 5, seed = 7 } = {}) {
  const rng = mulberry32(seed >>> 0);
  const runs = [];            // every run ever (the run ledger the API serves)
  const children = new Map(); // runId -> { child, killTimer, logStream, out, err }
  let stopped = false;
  const timers = [];
  // group state
  const groups = new Map();   // groupKey -> { running: runId|null, pending: run|null }
  const repoRunning = new Map();   // repo -> Set(runId)
  const repoQueue = new Map();     // repo -> run[] (past the group, waiting on the cap)
  // metrics
  const metrics = {
    maxConcurrentRuns: 0, repoQueueMaxDepth: 0, conductorStarvationEvents: 0,
    runsStarted: 0, runsCancelled: 0, runsQueuedBehindCap: 0, capDeferrals: 0,
  };

  const groupKeyFor = (wf, repo, run) => (
    wf === 'conductor' ? `conductor:${repo}`
      : wf === 'worker' ? `worker:${repo}:${run.taskRef}`
        : `${wf}:${repo}`
  );

  const runName = (wf, entry) => {
    if (wf === 'worker') {
      const cp = entry.clientPayload || {};
      return `task-${cp.task} · ${cp.behavior} · a${cp.attempt}`;
    }
    if (wf === 'conductor') {
      if (entry.eventType === 'fsm-control') return `control:${entry.clientPayload?.command} · conductor`;
      return `${entry.clientPayload?.reason || entry.eventType} · conductor`;
    }
    if (wf === 'ops') return `ops · ${entry.clientPayload?.command}`;
    if (wf === 'intake') return `intake · #${entry.issueNumber}`;
    return `${wf} · scan`;
  };

  function mkRun({ repo, wf, entry }) {
    const id = world.nextRunId();
    const lat = dispatchLatencyMs * timeScale * (1 + (rng() * 2 - 1) * 0.2);
    const run = {
      id, repo, workflow: wf, name: runName(wf, entry),
      status: 'queued',            // queued (awaiting slot/latency) -> in_progress -> completed
      conclusion: null, exitCode: null,
      created_at: null, startedAt: null, finishedAt: null, queuedMs: null, runMs: null,
      willStartAt: Date.now() + Math.max(0, Math.round(lat)),
      taskRef: entry.clientPayload?.task || entry.issueNumber || null,
      entry, logPath: world.runLogPath(id),
      groupQueued: 0,
    };
    runs.push(run);
    return run;
  }

  // ---- the inbox: the stand-in hands every accepted dispatch here -----------
  async function onDispatch(entry) {
    if (stopped) return;
    const wfs = WORKFLOW_OF_EVENT[entry.eventType];
    if (!wfs) { log(`SCHED: ignoring unknown dispatch type ${entry.eventType}`); return; }
    for (const wf of wfs) {
      const run = mkRun({ repo: entry.repo, wf, entry });
      log(`SCHED dispatch ${entry.eventType} repo=${entry.repo} -> ${wf} run=${run.id} name="${run.name}" (starts in ${Math.round(run.willStartAt - Date.now())}ms)`);
      admit(run);
    }
    pump();
  }
  ghapi.setOnDispatch(onDispatch);

  // ---- group admission -------------------------------------------------------
  function admit(run) {
    const key = groupKeyFor(run.workflow, run.repo, run);
    if (!groups.has(key)) groups.set(key, { running: null, pending: null });
    const g = groups.get(key);
    if (run.workflow === 'worker' && g.running != null) {
      // cancel-in-progress: the newer attempt supersedes (the live semantics)
      const victim = runs.find((r) => r.id === g.running);
      if (victim && victim.status === 'in_progress') {
        log(`SCHED worker group ${key}: newer run ${run.id} supersedes running ${victim.id} (cancel-in-progress)`);
        cancelRun(victim, 'superseded');
      }
    }
    if (g.running != null) {
      if (g.pending) {
        // newest-wins: the older pending is EVICTED (decided at submit)
        const evicted = g.pending;
        evicted.status = 'completed';
        evicted.conclusion = 'cancelled';
        evicted.evictedBy = run.id;
        metrics.runsCancelled += 1;
        log(`SCHED group ${key}: pending run ${evicted.id} "${evicted.name}" EVICTED by ${run.id} (newest-wins)`);
      }
      run.status = 'group-pending';
      g.pending = run;
      return;
    }
    g.pending = run;
    run.status = 'group-pending';
  }

  function pump() {
    if (stopped) return;
    const now = Date.now();
    // promote group pendings whose running slot is free and whose latency elapsed
    for (const [key, g] of groups) {
      if (g.running != null) continue;
      const run = g.pending;
      if (!run) continue;
      if (run.status !== 'group-pending') { g.pending = null; continue; }
      if (now < run.willStartAt) continue;
      g.pending = null;
      g.running = run.id;
      tryStart(run);
    }
    // promote the repo cap queue
    for (const [repo, queue] of repoQueue) {
      while (queue.length && (repoRunning.get(repo)?.size || 0) < parallelCap) {
        const run = queue.shift();
        if (run.status !== 'repo-queued') continue;
        startRun(run);
      }
      if (queue.length === 0) repoQueue.delete(repo);
    }
    // metrics
    const conc = [...repoRunning.values()].reduce((a, s) => a + s.size, 0);
    metrics.maxConcurrentRuns = Math.max(metrics.maxConcurrentRuns, conc);
    for (const [repo, queue] of repoQueue) {
      metrics.repoQueueMaxDepth = Math.max(metrics.repoQueueMaxDepth, queue.length);
      const workers = [...(repoRunning.get(repo) || [])].filter((rid) => runs.find((r) => r.id === rid)?.workflow === 'worker').length;
      if (queue.some((r) => r.workflow === 'conductor') && workers >= 3) metrics.conductorStarvationEvents += 1;
    }
  }

  function tryStart(run) {
    const set = repoRunning.get(run.repo) || new Set();
    repoRunning.set(run.repo, set);
    if (set.size >= parallelCap) {
      run.status = 'repo-queued';
      metrics.runsQueuedBehindCap += 1;
      metrics.capDeferrals += 1;
      const q = repoQueue.get(run.repo) || [];
      q.push(run);
      repoQueue.set(run.repo, q);
      log(`SCHED ParallelCap(${parallelCap}) repo=${run.repo}: run ${run.id} "${run.name}" QUEUED (depth ${q.length})`);
      return;
    }
    startRun(run);
  }

  function startRun(run) {
    if (stopped || run.status === 'in_progress' || run.status === 'completed') return;
    const set = repoRunning.get(run.repo) || new Set();
    repoRunning.set(run.repo, set);
    set.add(run.id);
    run.status = 'in_progress';
    run.created_at = new Date().toISOString();
    run.startedAt = Date.now();
    run.queuedMs = run.startedAt - run.entry.receivedAt;
    metrics.runsStarted += 1;
    spawnRun(run);
  }

  // ---- the REAL spawn --------------------------------------------------------
  function spawnRun(run) {
    const { workflow: wf, entry } = run;
    // a fresh runner checkout per run (workers ALWAYS clone the MAIN repo —
    // worker.yml's TARGET_REPO redirect: a bucket-2 dispatch checks out the
    // main repo so the report CAS-append rides the main fsm-state)
    const dir = world.cloneForRun(wf);
    const startedAtIso = new Date().toISOString();
    let env;
    if (wf === 'conductor') {
      env = world.conductorEnv({
        run, startedAtIso,
        event: {
          action: entry.eventType,
          client_payload: entry.clientPayload,
          sender: { login: entry.actor || 'fsm-pat-bot' },
        },
        vars: schedulerVars,
      });
    } else if (wf === 'worker') {
      env = world.workerEnv({ run, clientPayload: entry.clientPayload });
    } else if (wf === 'intake') {
      env = world.intakeEnv({ run, issueEvent: entry.issueEvent });
    } else if (wf === 'ops') {
      env = world.opsEnv({ run, controlPayload: entry.clientPayload, sender: entry.actor });
    } else if (wf === 'watchdog') {
      env = world.watchdogEnv({ run });
    }
    const script = join(dir, ENTRY[wf]);
    log(`SCHED run ${run.id} START ${wf} name="${run.name}" repo=${run.repo} (queued ${run.queuedMs}ms)`);
    const out = [];
    const stream = createWriteStream(run.logPath, { flags: 'a' });
    const child = spawn(process.execPath, [script], {
      cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(run.id, { child, out, stream });
    child.stdout.on('data', (d) => { out.push(d); stream.write(d); });
    child.stderr.on('data', (d) => { out.push(d); stream.write(d); });
    const killTimer = setTimeout(() => {
      log(`SCHED run ${run.id} TIMEOUT (${TIMEOUT_MIN[wf]}min) — group SIGKILL (conclusion CANCELLED, the TTL-kill signature)`);
      cancelRun(run, 'timeout-minutes');
    }, TIMEOUT_MIN[wf] * 60_000);
    timers.push(killTimer);
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      stream.end();
      children.delete(run.id);
      finishRun(run, code, sig);
    });
  }

  function cancelRun(run, why) {
    const c = children.get(run.id);
    if (c) {
      try { process.kill(-c.child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    }
    run.cancelledBy = why;
  }

  function finishRun(run, code, sig) {
    run.status = 'completed';
    run.finishedAt = Date.now();
    run.runMs = run.finishedAt - run.startedAt;
    run.exitCode = code;
    if (run.cancelledBy) {
      run.conclusion = 'cancelled';
    } else {
      run.conclusion = code === 0 ? 'success' : 'failure';
    }
    const set = repoRunning.get(run.repo);
    if (set) set.delete(run.id);
    // free the group slot
    for (const [, g] of groups) {
      if (g.running === run.id) g.running = null;
    }
    log(`SCHED run ${run.id} END ${run.workflow} "${run.name}" ${run.conclusion} exit=${code}${sig ? ` sig=${sig}` : ''} (ran ${run.runMs}ms)`);
    pump();
  }

  // ---- the event surfaces the drill drives directly ---------------------------
  // an issue event (opened) wakes the intake workflow
  function deliverIssueEvent(issueEvent, repo = world.mainRepo) {
    const entry = { repo, eventType: 'issues', issueEvent, issueNumber: issueEvent.issue?.number, actor: issueEvent.issue?.user?.login, clientPayload: {}, receivedAt: Date.now() };
    const run = mkRun({ repo, wf: 'intake', entry });
    log(`SCHED issue event #${entry.issueNumber} (${entry.actor}) -> intake run=${run.id}`);
    admit(run);
    pump();
    return run;
  }

  // a watchdog scan (the schedule/workflow_dispatch surface)
  function runWatchdogScan(repo = world.mainRepo) {
    const entry = { repo, eventType: 'watchdog-scan', clientPayload: {}, actor: 'scheduler', receivedAt: Date.now() };
    const run = mkRun({ repo, wf: 'watchdog', entry });
    log(`SCHED watchdog scan -> run=${run.id}`);
    admit(run);
    pump();
    return run;
  }

  // the scenario's repo variables (WORKER_REPO_2 / WORKER_OVERFLOW_AT)
  let schedulerVars = {};
  function setVars(v) { schedulerVars = { ...schedulerVars, ...v }; }

  // ---- the runs API the stand-in serves --------------------------------------
  ghapi.setRunsProvider((repo, wf) => runs.filter((r) => r.repo === repo && r.workflow === wf));

  async function stop() {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    for (const [, c] of children) {
      try { process.kill(-c.child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { c.stream.end(); } catch { /* gone */ }
    }
    children.clear();
  }

  function runLogText(id) {
    const c = children.get(id);
    if (c) return c.out.join('');
    try { return readFileSync(world.runLogPath(id), 'utf8'); } catch { return ''; }
  }

  const loopTimer = setInterval(pump, 60);
  timers.push(loopTimer);

  return {
    runs, metrics, onDispatch, deliverIssueEvent, runWatchdogScan, setVars, stop, pump,
    runLogText,
    runById: (id) => runs.find((r) => r.id === id),
  };
}
