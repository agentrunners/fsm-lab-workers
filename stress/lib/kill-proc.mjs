// stress/lib/kill-proc.mjs — the chaos battery's PROCESS-level kill surface
// (s23-chaos, a6 §6.1 item 6). NEW FILE (the s23 discipline: shared-lib
// additions land as new files; nothing existing is touched).
//
// The chaos battery SIGKILLs REAL adapter children (conductor/turn.mjs and
// worker/turn.mjs spawned by e2e/lib/scheduler.mjs as detached process
// groups). The scheduler keeps its child table private, so the kill surface
// here discovers victims through /proc — the same inspection a live operator
// (or the GHA runner's own job cleanup) performs:
//
//   procScan()        every userspace process as {pid, pgid, ppid, cmd,
//                     envRunId, envTaskId} — cmd from cmdline, the process
//                     group from stat(5), GITHUB_RUN_ID (the scheduler mints
//                     it into EVERY spawned adapter env) and OX_AGENT_TASK_ID
//                     (the cc adapter's curated CLI env carries it — the CLI
//                     runs DETACHED in its own group, so a worker group-kill
//                     does NOT reach it) from environ.
//   killGroup(pgid)   SIGKILL a whole process group (the detached spawn means
//                     the group leader + its spawnSync git children die
//                     together — exactly the runner's own timeout kill).
//   killRunTree()     the full tree for one scheduler run: the adapter's own
//                     group (GITHUB_RUN_ID match), the detached CLI group
//                     (OX_AGENT_TASK_ID match), and any per-lane bridges
//                     (their cmdline embeds the run's clone dir).
//   sweepProcs()      the teardown broom — kill every group matching a
//                     predicate (the battery sweeps anything whose cmdline
//                     lives under its scratch dir, so a killed run's escaped
//                     grandchildren never outlive the battery).
//
// Linux-only by construction (/proc) — the stress layer is already a
// real-substrate layer (local bare repos, real git, real spawns); the battery
// header documents the platform assumption. Reading another process's
// /proc/<pid>/environ requires same-uid (the sandbox/CI shape); unreadable
// processes are skipped, never fatal.

import { readdirSync, readFileSync } from 'node:fs';

const PROC = '/proc';

export function procScan() {
  const out = [];
  let entries;
  try { entries = readdirSync(PROC); } catch { return out; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    if (pid === process.pid) continue;
    let cmd = '';
    try {
      cmd = readFileSync(`${PROC}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch { continue; }            // gone, or a kernel thread (empty cmdline)
    if (!cmd) continue;              // kernel threads have no argv
    let pgid = null;
    let ppid = null;
    try {
      const stat = readFileSync(`${PROC}/${pid}/stat`, 'utf8');
      // comm may contain spaces/parens — everything after the LAST ')'
      const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      ppid = parseInt(f[1], 10);
      pgid = parseInt(f[2], 10);
    } catch { /* gone mid-scan */ }
    let envRunId = null;
    let envTaskId = null;
    try {
      const env = readFileSync(`${PROC}/${pid}/environ`, 'utf8');
      for (const kv of env.split('\0')) {
        if (envRunId === null && kv.startsWith('GITHUB_RUN_ID=')) envRunId = kv.slice(14);
        else if (envTaskId === null && kv.startsWith('OX_AGENT_TASK_ID=')) envTaskId = kv.slice(17);
      }
    } catch { /* gone, or not ours to read */ }
    out.push({ pid, pgid, ppid, cmd, envRunId, envTaskId });
  }
  return out;
}

export function killGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 'SIGKILL'); return true; } catch { return false; }
}

// Kill every process group belonging to one scheduler run. Three match arms,
// because the cc adapter deliberately detaches its CLI (a CLI group-kill must
// not take the bridge — and symmetrically a worker group-kill must not reach
// the CLI; the battery reaps both, like the runner's job cleanup would):
//   runId   — the adapter processes themselves (scheduler-minted GITHUB_RUN_ID)
//   taskId  — the run's CLI groups (OX_AGENT_TASK_ID rides the curated env)
//   cloneDir— per-lane cc-bridge.mjs spawns (cmdline embeds the clone's path)
export function killRunTree({ runId = null, taskId = null, cloneDir = null } = {}) {
  const killed = [];
  const seenGroups = new Set();
  for (const p of procScan()) {
    const match =
      (runId != null && p.envRunId != null && String(p.envRunId) === String(runId)) ||
      (taskId != null && p.envTaskId != null && String(p.envTaskId) === String(taskId)) ||
      (cloneDir != null && p.cmd.includes(cloneDir));
    if (!match || p.pgid == null || seenGroups.has(p.pgid)) continue;
    seenGroups.add(p.pgid);
    if (killGroup(p.pgid)) killed.push({ pid: p.pid, pgid: p.pgid, cmd: p.cmd.slice(0, 140) });
  }
  return killed;
}

// The teardown broom: SIGKILL every group whose /proc entry matches. Returns
// the killed pid list (the battery asserts the SECOND pass finds zero — no
// orphaned fake-CLI / bridge / git process outlives the battery).
export function sweepProcs(matchFn) {
  const killed = [];
  const seenGroups = new Set();
  for (const p of procScan()) {
    if (!matchFn(p) || p.pgid == null || seenGroups.has(p.pgid)) continue;
    seenGroups.add(p.pgid);
    if (killGroup(p.pgid)) killed.push(p.pid);
  }
  return killed;
}

export function countProcs(matchFn) {
  return procScan().filter(matchFn).length;
}
