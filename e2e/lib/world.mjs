// e2e/lib/world.mjs — the drill's WORLD: local bare origins + clone factory +
// the spawned-adapter env assembly (s21 audit §5.2, mkclone generalized).
//
// Geometry (the AR mkTwoRepos shape, local):
//   <scratch>/origin-main.git    the MAIN repo's bare origin. Holds:
//                                main (the code tree, pushed from the
//                                worktree HEAD), fsm-state (the Store), the
//                                tasks/<id> branches (the write-back door),
//                                fsm-sessions (transcripts). EVERY adapter
//                                runs in a fresh clone of this.
//   <scratch>/origin-repo2.git   the SECOND bucket (WORKER_REPO_2): receives
//                                dispatches; its runs live in the scheduler
//                                ledger; a seed main branch only.
//   <scratch>/probe-clone        the drill's own long-lived clone (assertions
//                                read fsm-state through the REAL Store).
//   <scratch>/runs/<id>.log      every spawned run's captured stdout+stderr.
//   <scratch>/ghapi-ledger.jsonl the stand-in's request ledger.
//
// The spawned env mirrors the workflow yml env surfaces (conductor.yml /
// worker.yml / intake.yml / ops.yml / watchdog.yml) — GITHUB_API_URL is the
// T9 seam, everything else rides the same names the runners set. Two
// network-boundary tricks keep the drill OFFLINE while running the REAL
// adapter code paths:
//   1. a dead HTTP(S) proxy (NODE_USE_ENV_PROXY + 127.0.0.1:9) with
//      NO_PROXY=127.0.0.1 — any unplanned real-network call dies in ~ms and
//      is visible; the stand-in stays reachable.
//   2. git insteadOf via GIT_CONFIG_* env — the cc adapter's transcript push
//      builds https://x-access-token:<token>@github.com/<repo>.git from
//      GITHUB_REPOSITORY; the rewrite maps it to the local bare origin. The
//      task-branch push uses the CC_TASKBRANCH_ORIGIN seam directly.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`world: ${cmd} ${args.join(' ')} rc=${r.status}: ${String(r.stderr || r.error || '').slice(0, 300)}`);
  }
  return r.stdout;
};

// the drill's npx stand-in: the cc adapter spawns
//   npx -y @anthropic-ai/claude-code@<pin> -p <prompt> --permission-mode ...
// The shim swaps ONLY the command head (node worker/fake-cc.mjs) so the argv
// boundary the adapter builds is the REAL one — zero npm, zero network.
// Anything unplanned refuses LOUDLY (a drill must never pay a package
// download inside the wall budget).
const NPX_SHIM = `#!/bin/sh
# e2e/bin/npx — the drill's CLI stand-in (CC_FAKE determinism at the REAL
# spawn boundary). Unplanned package installs REFUSE (exit 127) — never
# npm-install inside a drill.
if [ "$#" -ge 2 ] && [ "$1" = "-y" ]; then
  case "$2" in
    @anthropic-ai/claude-code@*) shift 2; exec node "$DRILL_FAKE_CC" "$@" ;;
  esac
fi
echo "drill-npx-shim: REFUSING unplanned npx invocation: $*" >&2
exit 127
`;

export function createWorld({ scratchDir, mainRepo = 'local/fsm-lab', repo2 = 'local/fsm-lab-workers', worktreeRoot, apiBase, log = () => {}, keep = false }) {
  const w = { scratchDir, mainRepo, repo2, runsDir: join(scratchDir, 'runs') };
  const mainBare = join(scratchDir, 'origin-main.git');
  const repo2Bare = join(scratchDir, 'origin-repo2.git');
  const binDir = join(scratchDir, 'bin');
  const probeClone = join(scratchDir, 'probe-clone');
  let cloneSeq = 0;
  let runSeq = 0;

  const gitMain = (args, opts = {}) => sh('git', args, opts);

  // ---- BOOT: the bare origins + the bin shim + the probe clone -------------
  function boot() {
    mkdirSync(w.runsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // main: bare + the worktree's code tree on main
    gitMain(['init', '--bare', '-q', '-b', 'main', mainBare]);
    gitMain(['-C', worktreeRoot, 'push', '-q', mainBare, 'HEAD:refs/heads/main']);
    // repo2: bare + a seed main (it only ever RECEIVES dispatches/runs)
    gitMain(['init', '--bare', '-q', '-b', 'main', repo2Bare]);
    const seedDir = join(scratchDir, 'repo2-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'README.md'), 'second worker bucket (drill stand-in)\n');
    gitMain(['-C', seedDir, 'init', '-q', '-b', 'main']);
    gitMain(['-C', seedDir, 'add', '.']);
    gitMain(['-C', seedDir, '-c', 'user.name=drill', '-c', 'user.email=drill@invalid', 'commit', '-qm', 'seed']);
    gitMain(['-C', seedDir, 'push', '-q', repo2Bare, 'main']);
    rmSync(seedDir, { recursive: true, force: true });
    // the npx shim
    const npxShim = join(binDir, 'npx');
    writeFileSync(npxShim, NPX_SHIM, { mode: 0o755 });
    chmodSync(npxShim, 0o755);
    // the probe clone (the drill's own read surface)
    gitMain(['clone', '-q', mainBare, probeClone]);
    return w;
  }

  // ---- clone factory (a fresh runner checkout per run) ----------------------
  // EVERY adapter clones the MAIN bare: workers dispatched into the second
  // bucket check out TARGET_REPO = the main repo (worker.yml's ar 20-e
  // redirect — the report CAS-append rides the checkout's origin), so the
  // bucket-2 geometry is dispatch-ledger-side only.
  function cloneForRun(role) {
    cloneSeq += 1;
    const dir = join(scratchDir, `clone-${role}-${cloneSeq}`);
    gitMain(['clone', '-q', mainBare, dir]);
    return dir;
  }

  // ---- env assembly ----------------------------------------------------------
  // deadProxy: anything unplanned dies fast; NO_PROXY keeps the stand-in live.
  const baseEnv = () => ({
    GITHUB_API_URL: apiBase,
    GITHUB_REPOSITORY: mainRepo,
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
  });

  const sessionsRewrite = () => ({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${mainBare}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://x-access-token:drill-job-token@github.com/${mainRepo}.git`,
  });

  // conductor.yml's env surface (+ the scenario's overflow vars)
  function conductorEnv({ run, event, startedAtIso, vars = {} }) {
    return {
      ...baseEnv(),
      GH_TOKEN: 'drill-job-token',
      LAB_PAT: 'drill-pat',
      GITHUB_RUN_ID: String(run.id),
      RUN_STARTED_AT: startedAtIso,
      JOB_TTL_MIN: '10',
      EPOCH_MODE: 'mock',
      EVENT: JSON.stringify(event),
      OPS_ISSUE: '1',
      GITHUB_STEP_SUMMARY: '/dev/null',
      ...(vars.WORKER_REPO_2 ? { WORKER_REPO_2: vars.WORKER_REPO_2 } : {}),
      ...(vars.WORKER_OVERFLOW_AT != null ? { WORKER_OVERFLOW_AT: String(vars.WORKER_OVERFLOW_AT) } : {}),
    };
  }

  // worker.yml's env surface (+ the cc lane's local push targets)
  function workerEnv({ run, clientPayload }) {
    return {
      ...baseEnv(),
      ...sessionsRewrite(),
      GH_TOKEN: 'drill-job-token',
      GITHUB_REPOSITORY: mainRepo,        // TARGET_REPO redirect: bucket-2 workers report to the MAIN repo
      GITHUB_RUN_ID: String(run.id),
      GITHUB_RUN_ATTEMPT: '1',
      WORKER_TTL_MIN: '50',
      EVENT: JSON.stringify({ action: 'fsm-task', client_payload: clientPayload, sender: { login: 'fsm-pat-bot' } }),
      // the cc lane (real spawn path, deterministic CLI via the npx shim)
      OPENROUTER_API_KEY: 'sk-drill-key-1',
      OPENROUTER_API_KEY_2: 'sk-drill-key-2',
      CC_TASKBRANCH_ORIGIN: mainBare,
      DRILL_FAKE_CC: join(probeCloneFix(), 'worker/fake-cc.mjs'),
    };
  }

  // the fake CLI must live at a STABLE path across clones (the env is built
  // once per run, pointing at the run's own clone is fine — but the probe
  // clone is always present, so pin it there).
  const probeCloneFix = () => probeClone;

  function intakeEnv({ run, issueEvent }) {
    return {
      ...baseEnv(),
      GH_TOKEN: 'drill-job-token',
      EVENT: JSON.stringify(issueEvent),
    };
  }

  function opsEnv({ run, controlPayload, sender = 'drill-operator' }) {
    return {
      ...baseEnv(),
      GH_TOKEN: 'drill-job-token',
      EVENT: JSON.stringify({ action: 'fsm-control', client_payload: controlPayload, sender: { login: sender } }),
    };
  }

  function watchdogEnv({ run }) {
    return {
      ...baseEnv(),
      GH_TOKEN: 'drill-job-token',
      LAB_PAT: 'drill-pat',
      STALE_AFTER_MIN: '4',
      FSM_SESSIONS_ORIGIN: mainBare,
    };
  }

  function teardown() {
    if (keep) { log(`world: --keep — scratch retained at ${scratchDir}`); return; }
    for (const p of [scratchDir]) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return {
    boot, cloneForRun, teardown,
    mainBare, repo2Bare, probeClone, binDir, scratchDir,
    conductorEnv, workerEnv, intakeEnv, opsEnv, watchdogEnv,
    mainRepo, repo2,
    nextRunId: () => { runSeq += 1; return 9_000_000 + runSeq; },
    runLogPath: (id) => join(w.runsDir, `${id}.log`),
  };
}
