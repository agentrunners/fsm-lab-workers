#!/usr/bin/env node
// e2e/drill.mjs — THE E2E DRILL HARNESS (s21 audit §5 — the principal's named
// ask: the automated X-series).
//
//   node e2e/drill.mjs --scenario x22|budget-pause|recovery|overflow [--seed N]
//                       [--keep] [--time-scale 0.01] [--timeout-min 10]
//   -> exit 0/1 + a DRILL-REPORT json on stdout + e2e/last-drill-report.json
//
// LOCAL MODE (the CI-runnable layer): the REAL five turn-files
// (conductor/turn.mjs, worker/turn.mjs, watchdog/scan.mjs, intake/turn.mjs,
// ops/turn.mjs) as REAL child processes against:
//   - a local ghapi HTTP stand-in (the T9 GITHUB_API_URL seam),
//   - a mini-GHA scheduler (concurrency groups + repo-wide ParallelCap(5) +
//     164s dispatch latency compressed by --time-scale + timeout SIGKILL),
//   - local bare git origins for fsm-state / tasks/<id> / fsm-sessions.
// Worker behavior rides the seeded harness-shim contract (EPOCH_MODE=mock);
// the cc lane runs the REAL adapter spawn path (bridge + argv + env contract
// + process-group wall) against the deterministic fake CLI behind an npx
// shim — zero network, zero npm.
//
// Scenarios (the phase gates assert REAL state: git tips, queue lines,
// journal contents, the ghapi request ledger):
//   x22           the one-pass dogfood loop: issue -> door (incl. the
//                 fail-closed stranger rejection) -> epoch live -> cc worker
//                 turn (transcripts + task branch BEFORE the report) ->
//                 report -> drain -> task-branch+PR -> completion digest on
//                 the intake issue -> halt -> quiesce -> watchdog green.
//   budget-pause  X23's arc: quota storm -> alert-first pause (two commits,
//                 ordering asserted from the two ledgers) -> pause held ->
//                 resume (the REAL ops lane) -> straggler reports drained ->
//                 NO re-pause (the C-3 regression pin, provable e2e).
//   overflow      2 concurrent in-flight -> the pre-flight overflow decision
//                 -> exactly ONE dispatch per task (the C-2 pin) -> the
//                 mirror run in bucket 2 -> the union verify scan sees it
//                 (the C-1 pin).
//   recovery      corrupt tip -> watchdog alert -> the A-2 law-20 residual
//                 characterized at its >100-in-window boundary (bounded
//                 one-extra-alert; the <=100 zone protected — s22/M-2) ->
//                 history-walk heal -> healthy scan.
//
// The DRILL-REPORT: per-phase PASS/FAIL + per-hop latencies (dispatch->run
// start, run wall) + scheduler capacity metrics (criterion 4's cadence
// costs, regression-pinned per run) + the honest NOT-MODELED list.

import { argv, exit } from 'node:process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ---- CLI ---------------------------------------------------------------------
const args = parseArgs(argv.slice(2));
function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--scenario') out.scenario = list[++i];
    else if (list[i] === '--seed') out.seed = parseInt(list[++i], 10);
    else if (list[i] === '--keep') out.keep = true;
    else if (list[i] === '--time-scale') out.timeScale = parseFloat(list[++i]);
    else if (list[i] === '--timeout-min') out.timeoutMin = parseFloat(list[++i]);
    else if (list[i] === '--help' || list[i] === '-h') out.help = true;
  }
  return out;
}
if (args.help || !args.scenario) {
  console.log('usage: node e2e/drill.mjs --scenario <x22|budget-pause|recovery|overflow> [--seed N] [--keep] [--time-scale 0.01] [--timeout-min 10]');
  exit(args.help ? 0 : 2);
}
const SCENARIOS = ['x22', 'budget-pause', 'recovery', 'overflow'];
if (!SCENARIOS.includes(args.scenario)) {
  console.error(`drill: unknown scenario "${args.scenario}" (known: ${SCENARIOS.join(', ')})`);
  exit(2);
}

const scenario = args.scenario;
const seed = Number.isFinite(args.seed) ? args.seed : 7;
const keep = !!args.keep;
const timeScale = Number.isFinite(args.timeScale) ? args.timeScale : 0.01;
const timeoutMin = Number.isFinite(args.timeoutMin) ? args.timeoutMin : 10;

// ---- harness imports (after arg validation, for fast --help) -----------------
const { createGhapi } = await import('./lib/ghapi.mjs');
const { createWorld } = await import('./lib/world.mjs');
const { createScheduler } = await import('./lib/scheduler.mjs');
const { genesis } = await import('../lib/fsm.mjs');
const { Store } = await import('../lib/store.mjs');
// s22/M-2: the watchdog's REAL comments-fetch path — the LAW20-PAGINATION
// phase fetches through the EXACT path the live scan builds (per_page=100 +
// since=<window floor>), imported from the module under test, never a
// re-derived twin.
const { alertCommentsPath } = await import('../lib/watchdog-core.mjs');

const log = (msg) => console.log(`[drill] ${msg}`);

// ---- the wait/phase toolkit ---------------------------------------------------
// until() supports ASYNC predicates: the drill's polling reads go through
// async git (spawn) — a sync spawnSync inside the poll loop would BLOCK the
// drill's event loop, and the ghapi stand-in server runs IN this process
// (adapter requests would starve behind every poll tick).
function until(fn, { timeoutMs = 30_000, everyMs = 150, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let busy = false;
    const iv = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const v = await fn();
        if (v) { clearInterval(iv); resolve(v); return; }
      } catch { /* transient */ }
      busy = false;
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`until: TIMEOUT after ${timeoutMs}ms waiting for ${label}`));
      }
    }, everyMs);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// async git (non-blocking — keeps the stand-in's event loop live)
const agit = (args) => new Promise((resolve) => {
  const p = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', () => resolve({ code: -1, out, err }));
  p.on('close', (code) => resolve({ code, out, err }));
});

// ---- the drill world ----------------------------------------------------------
const outDir = join(ROOT, 'e2e', 'out');
mkdirSync(outDir, { recursive: true });
const scratchDir = keep ? join(outDir, `drill-${Date.now()}-${scenario}`) : mkdtempSync(join(tmpdir(), 'fsm-drill-'));
mkdirSync(scratchDir, { recursive: true });

const ghapi = createGhapi({ scratchDir, log: () => {} });
const apiBase = await ghapi.listen();

const world = createWorld({
  scratchDir, mainRepo: 'local/fsm-lab', repo2: 'local/fsm-lab-workers',
  worktreeRoot: ROOT, apiBase, log, keep,
});
world.boot();

// the ops anchor issue #1 (the live repo's OPS_ISSUE — conductor comments land there)
ghapi.openIssue('local/fsm-lab', {
  title: '[fsm] ops console anchor (drill seed)',
  body: 'The ops issue — conductor alert/completion comments land here (OPS_ISSUE=1).',
  labels: [], token: 'drill-user-pat',
});

const sched = createScheduler({ world, ghapi, log, timeScale, seed });

// the drill's own read surface — ASYNC git reads through the probe clone
// (the polling path must never block the stand-in's event loop; the sync
// Store stays for setup + one-shot phase-body reads)
const fetchProbe = () => agit(['-C', world.probeClone, 'fetch', '-q', world.mainBare, '+refs/heads/fsm-state:refs/remotes/origin/fsm-state']);
const showProbe = async (path) => {
  const r = await agit(['-C', world.probeClone, 'show', `refs/remotes/origin/fsm-state:${path}`]);
  return r.code === 0 ? r.out : null;
};
const readState = async () => {
  await fetchProbe();
  const raw = await showProbe('state/state.json');
  if (raw === null) return { state: null };
  try { return { state: JSON.parse(raw) }; } catch { return { state: null, corrupt: true }; }
};
const parseJsonl = (raw) => {
  if (raw === null || raw === undefined) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* bad line — not the drill's concern */ }
  }
  return out;
};
// s22/M-3 (the harness's REAL fix, lens-1): the queue readers FETCH FIRST —
// like readState/journalTail. They used to read the probe clone's
// REMOTE-TRACKING ref directly, which only moves on a fetch: every queue
// assert read whatever the LAST readState() poll left behind (the INTAKE
// phase read the BOOT-time snapshot — the queue read as empty before the
// door ever ran; the WORK phase could read the pre-report state).
const queueLines = async () => { await fetchProbe(); return parseJsonl(await showProbe('state/reports-queue.jsonl')); };
const intakeLines = async () => { await fetchProbe(); return parseJsonl(await showProbe('state/intake-queue.jsonl')); };
const journalTail = async (n = 60) => {
  await fetchProbe();
  const ls = await agit(['-C', world.probeClone, 'ls-tree', '--name-only', 'refs/remotes/origin/fsm-state', 'state/']);
  const gens = ls.out.split('\n').map((x) => x.trim()).filter(Boolean)
    .map((f) => /^state\/journal-(\d+)\.jsonl$/.exec(f)).filter(Boolean)
    .map((m) => parseInt(m[1], 10)).sort((a, b) => a - b);
  const all = [];
  for (const g of gens) {
    const raw = await showProbe(`state/journal-${g}.jsonl`);
    for (const rec of parseJsonl(raw)) all.push(rec);
  }
  return all.slice(-n);
};
const tip = async () => {
  const r = await agit(['--git-dir', world.mainBare, 'rev-parse', 'refs/heads/fsm-state']);
  return r.code === 0 ? r.out.trim() : null;
};
const branchTip = (name) => {
  const r = spawnSync('git', ['--git-dir', world.mainBare, 'rev-parse', `refs/heads/${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const branchFiles = (name) => {
  const r = spawnSync('git', ['--git-dir', world.mainBare, 'ls-tree', '-r', '--name-only', `refs/heads/${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [];
};
const commitTime = (sha) => {
  if (!sha) return 0;
  const r = spawnSync('git', ['--git-dir', world.mainBare, 'show', '-s', '--format=%ct', sha], { encoding: 'utf8' });
  return r.status === 0 ? parseInt(r.stdout.trim(), 10) * 1000 : 0;
};

// seed a state via the REAL genesis + Store.init (the smoke's plumbing)
function seedState(g) {
  const st = new Store({ cwd: world.probeClone });
  return st.init(g);
}

// dispatch an event as the operator would (through the stand-in's HTTP surface)
async function postDispatch(eventType, clientPayload, { token = 'drill-user-pat', repo = 'local/fsm-lab' } = {}) {
  const r = await fetch(`${apiBase}/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  return r.status;
}

// ---- the phase runner ----------------------------------------------------------
const phases = [];
async function phase(name, fn) {
  const t0 = Date.now();
  const asserts = [];
  let fails = 0;
  const t = {
    ok(cond, label, detail = '') {
      const pass = !!cond;
      if (!pass) fails++;
      asserts.push({ label, pass, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail && !pass ? `  — ${String(detail).slice(0, 240)}` : ''}`);
      return pass;
    },
  };
  let err = null;
  try {
    await fn(t);
  } catch (e) {
    err = e;
    fails++;
    asserts.push({ label: `${name} (phase error)`, pass: false, detail: String(e.message).slice(0, 300) });
    console.log(`  PHASE-ERROR ${name}: ${e.message}`);
  }
  const ms = Date.now() - t0;
  phases.push({ name, ok: err === null && fails === 0, ms, asserts: asserts.length, fails, ...(err ? { error: String(err.message).slice(0, 300) } : {}) });
  console.log(`== PHASE ${name}: ${err === null && fails === 0 ? 'PASS' : 'FAIL'} (${ms}ms, ${asserts.length - fails}/${asserts.length} asserts)`);
  return err === null && fails === 0;
}

async function watchdogScan() {
  const run = sched.runWatchdogScan();
  await until(() => run.status === 'completed', { timeoutMs: 30_000, label: `watchdog run ${run.id}` });
  return sched.runLogText(run.id);
}

// =====================================================================================
// SCENARIO x22 — the one-pass dogfood loop
// =====================================================================================
async function runX22() {
  const TASK = 'DRILL-X22';
  const artifactPath = `tasks/${TASK}/artifacts/out-fake.md`;
  const accept = `Produce the artifact at ${artifactPath} (deterministic drill turn). [fixture:artifacts]`;

  // pre-seed a HALTED epoch (the smoke's c1 plumbing): the chain is quiesced
  // between epochs — exactly the state the live X22 issue arrived into. The
  // intake rollover then births the cc epoch on the door's nudge.
  seedState(haltedSeed());

  await phase('BOOT', async (t) => {
    t.ok(await tip() !== null, 'fsm-state branch seeded on the main origin');
    t.ok(branchTip('main') !== null, 'main (the code tree) pushed to the origin');
    t.ok((await readState()).state?.chain?.halted === true, 'the seed epoch is HALTED (quiesced between epochs)');
  });

  await phase('INTAKE', async (t) => {
    // the operator opens the issue (a real-user-shaped author, write class)
    const body = [
      'Please run the drill task described below.',
      '',
      '```fsm-task',
      `id: ${TASK}`,
      'title: drill the one-pass dogfood loop',
      `accept: ${accept}`,
      `artifacts: [${artifactPath}]`,
      'lease_minutes: 4',
      'mode: cc',
      '```',
    ].join('\n');
    const issue = ghapi.openIssue('local/fsm-lab', { title: `[drill] ${TASK}`, body, labels: [] });
    t.ok(issue.number === 2, `the intake issue #${issue.number} opened by a write-class user`);

    // the NEGATIVE door first: a stranger with the same spec gets ONE reject
    // comment (fail-closed — criterion 8's door contract, e2e)
    const strangerTok = ghapi.addStrangerToken('stranger-1');
    const strangerIssue = ghapi.openIssue('local/fsm-lab', {
      title: '[drill] stranger task', body, labels: [], token: strangerTok,
    });
    const srun = sched.deliverIssueEvent({
      action: 'opened',
      issue: { number: strangerIssue.number, title: strangerIssue.title, body, user: { login: 'stranger-1' } },
    });
    await until(() => srun.status === 'completed', { timeoutMs: 30_000, label: 'stranger intake run' });
    const sComments = ghapi.comments('local/fsm-lab', strangerIssue.number);
    t.ok(sComments.length === 1 && /only accepts work from collaborators/.test(sComments[0]?.body || ''),
      'the door REJECTS the stranger (fail-closed, one comment)', JSON.stringify(sComments.map((c) => c.body.slice(0, 60))));

    // the real door run for the operator's issue
    const run = sched.deliverIssueEvent({
      action: 'opened',
      issue: { number: issue.number, title: issue.title, body, user: { login: 'drill-operator' } },
    });
    await until(() => run.status === 'completed', { timeoutMs: 30_000, label: 'intake run' });
    const runLog = sched.runLogText(run.id);
    t.ok(/INTAKE-ENQUEUED/.test(runLog), 'the intake run fired + enqueued (INTAKE-ENQUEUED log)');
    // s22 (the assert-tuning residual): this read races the conductor's
    // rollover drain — the door's nudge starts a conductor run ~1.6s later
    // (compressed dispatch latency) and its rollover CONSUMES the head. The
    // machinery works either way; the TRANSIENT (1 line parked) and the
    // DRAINED (0 lines) states are BOTH healthy here — the EPOCH phase pins
    // the durable drained state. What must NEVER hold: 2+ lines (the
    // stranger's spec queued) or a parked line that is not the operator's.
    const lines = await intakeLines();
    t.ok(lines.length <= 1, 'the intake queue holds AT MOST the operator line (1 = parked transient, 0 = rollover already drained; the stranger never queues)', `lines=${JSON.stringify(lines.map((l) => l.issue))}`);
    if (lines.length === 1) {
      t.ok(String(lines[0]?.issue) === String(issue.number) && lines[0]?.spec?.id === TASK, 'the parked queue line is the operator spec (issue + spec.id)');
      t.ok(typeof lines[0]?.body_sha8 === 'string' && lines[0]?.body_sha8.length === 8, 'the queue line carries the byte-exact body_sha8');
    }
    const nudges = ghapi.ledger().filter((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && (e.req || '').includes('"fsm-tick"') && (e.req || '').includes('"reason":"intake"'));
    t.ok(nudges.length === 1, 'the door NUDGED the conductor (one fsm-tick dispatch, reason intake)');
  });

  await phase('EPOCH', async (t) => {
    // the nudge's conductor run performs the ROLLOVER: halted + queue -> genesis
    // (s22/M-3: the predicate AWAITS readState() — the old sync read held the
    // PROMISE, permanently falsy, a guaranteed 60s timeout masking working
    // machinery)
    await until(async () => {
      const s = await readState();
      return s.state && s.state.project?.issue === 2 && s.state.tasks?.[TASK]?.status === 'assigned';
    }, { timeoutMs: 60_000, label: 'rollover + assign' });
    const s = (await readState()).state;
    t.ok(s.project.mode === 'cc', "the epoch is LIVE in cc mode (the spec's mode)");
    // (s22 assert-tune: the project field is `milestone` (the CURRENT one) —
    // the never-validated draft read `milestones` (undefined) and always failed)
    t.ok(s.project.milestones_total === 1 && s.project.milestone === 1, 'spec epochs carry milestones_total=1 (the task IS the project)');
    const jr = await journalTail(20);
    const roll = jr.find((j) => j.kind === 'CONTROL' && j.command === 'reset' && String(j.note || '').startsWith('intake-rollover'));
    t.ok(!!roll, 'journal: the rollover record (CONTROL reset, note intake-rollover)');
    t.ok(roll?.genesisSpec?.tasks?.[0]?.id === TASK && roll?.genesisSpec?.mode === 'cc', 'the genesisSpec slim shape rides the journal (task id + mode)');
    t.ok((await intakeLines()).length === 0, 'the intake queue CONSUMED (rewritten minus the head)');
    const comments2 = ghapi.comments('local/fsm-lab', 2);
    t.ok(comments2.some((c) => /Epoch started for this task/.test(c.body)), 'the epoch-started comment landed on the intake issue (m-3)');
    const dispatches = ghapi.ledger().filter((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && (e.req || '').includes('"fsm-task"'));
    t.ok(dispatches.length === 1, 'EXACTLY ONE worker dispatch (one task, one bucket)', `n=${dispatches.length}`);
    // (s22 assert-tune: the ox envelope is a JSON STRING nested INSIDE
    // client_payload — the old regex-grab fed the ESCAPED source text straight
    // to JSON.parse (always threw -> null on every assert). Parse the ledgered
    // body, then the ox string — the SLICE bump keeps both whole.)
    let ox = null;
    try {
      const dbody = JSON.parse(dispatches[0]?.req || 'null');
      ox = dbody?.client_payload?.ox ? JSON.parse(dbody.client_payload.ox) : null;
    } catch { ox = null; }
    t.ok(ox && ox.task_ref?.id === TASK, 'the dispatch envelope (ox) names the task', JSON.stringify(ox?.task_ref));
    t.ok(ox && ox.mode === 'cc' && typeof ox.deadline_ms === 'number' && ox.deadline_ms > Date.now() - 1000, 'the envelope deadline is sane (absolute, future at mint)');
    t.ok(Array.isArray(ox?.artifacts) && ox.artifacts[0] === artifactPath, 'the DECLARED artifacts ride the envelope');
    t.ok(s.tasks[TASK]?.lease?.token && s.tasks[TASK]?.lease?.issued_at, 'the lease is assigned (token + issued_at)');
  });

  await phase('WORK', async (t) => {
    // the worker run materialized (law-4's name shape)
    const wrun = await until(() => sched.runs.find((r) => r.workflow === 'worker' && r.name === `task-${TASK} · real · a1` && r.status !== 'group-pending'), { timeoutMs: 30_000, label: 'worker run start' });
    await until(() => wrun.status === 'completed', { timeoutMs: 60_000, label: 'worker run end' });
    const wlog = sched.runLogText(wrun.id);
    t.ok(/WORKER-START/.test(wlog) && !/WORKER-GATE-REJECT/.test(wlog), 'law-1 start-gate PASSED (the envelope deadline was sane)');
    t.ok(/WORKER-DONE/.test(wlog) && /outcome=done/.test(wlog), 'the cc turn completed done');
    t.ok(/CC-BRIDGE-UP/.test(wlog), 'the local bridge spawned (the real-mode env contract)');
    t.ok(/CC-TASKBRANCH-PUSHED/.test(wlog), 'the task branch pushed (the REAL adapter git lane + read-back)');
    t.ok(/CC-TRANSCRIPT-PUSHED|CC-SESSIONS-GENESIS/.test(wlog), 'the transcript pushed to fsm-sessions (BEFORE the report)');
    const sessionsFiles = branchFiles('fsm-sessions');
    t.ok(sessionsFiles.some((f) => f.startsWith(`sessions/${TASK}/`) && f.endsWith('.txt')), 'fsm-sessions carries the transcript', JSON.stringify(sessionsFiles));
    const taskFiles = branchFiles(`tasks/${TASK}`);
    t.ok(taskFiles.includes(artifactPath), 'the task branch carries the declared artifact', JSON.stringify(taskFiles));
    const reports = await queueLines();
    t.ok(reports.some((r) => r.task === TASK && r.event_id === `rep-${wrun.id}-a1`), 'the report line is on the queue (attempt-scoped event_id)');
    const rep = reports.find((r) => r.task === TASK);
    t.ok(rep?.outcome?.status === 'done' && /fake-cc ok/.test(String(rep?.outcome?.artifact || '')), 'the report outcome is done with the artifact digest');
  });

  await phase('DRAIN-VERIFY', async (t) => {
    // the conductor's self-tick (paced at the intake epoch's 25s cadence —
    // the REAL tick-cadence cost, measured in this phase's wall time) drains
    // the report and halts.
    await until(async () => {
      const s = await readState();
      return s.state && s.state.chain?.halted === true && s.state.tasks?.[TASK]?.status === 'done';
    }, { timeoutMs: 120_000, label: 'drain -> done -> halt' });
    // (s22 assert-tune: the PR flow's STAMP is a SECOND commit, seconds after
    // the halt commit — the adapter's post-tick prFlow lane opens the PR then
    // stamps task.pr; the read below raced that commit and saw pr=undefined
    // while the journal (read a beat later) already carried the pointer record)
    await until(async () => !!(await readState()).state?.tasks?.[TASK]?.pr, { timeoutMs: 30_000, label: 'the PR stamp commit' });
    const s = (await readState()).state;
    t.ok(s.tasks[TASK]?.pr, `the task is PR-stamped (task.pr=${s.tasks[TASK].pr})`);
    t.ok(s.project.phase === 'done' && s.chain.halted === true, 'phase done + chain HALTED');
    const jr = await journalTail(30);
    t.ok(jr.some((j) => j.kind === 'PHASE' && j.to === 'done' && j.degraded !== true), 'the PHASE-done journal record (not degraded)');
    t.ok(jr.some((j) => j.kind === 'REPORT' && j.task === TASK && j.to === 'done'), 'the REPORT journal record');
    t.ok(jr.some((j) => j.kind === 'REPORT' && j.task === TASK && j.pr), 'the PR pointer-only journal record (law 6)');
    const pulls = ghapi.pulls('local/fsm-lab');
    t.ok(pulls.length === 1 && pulls[0].head?.ref === `tasks/${TASK}`, 'EXACTLY ONE PR opened from the task branch');
    t.ok(/Task write-back/.test(pulls[0]?.body || '') && /Accept criteria/.test(pulls[0]?.body || ''), 'the PR body is the m-3 body (write-back + accept criteria)');
    const comments2 = ghapi.comments('local/fsm-lab', 2);
    const completion = comments2.find((c) => /Epoch COMPLETE for this task/.test(c.body));
    t.ok(!!completion, 'the completion digest landed on the intake issue (the X22 one-pass criterion)');
    t.ok(/PR #\d+/.test(completion?.body || ''), 'the digest carries the PR link');
    t.ok(/fake-cc ok/.test(completion?.body || ''), 'the digest carries the result digest');
  });

  await phase('HALT-QUIESCE', async (t) => {
    const frozen = await tip();
    await sleep(1500);
    t.ok((await tip()) === frozen, 'the halted chain\'s tip is FROZEN');
    // the schedule-backstop wake -> QUIESCED (no commit, no self-dispatch)
    const before = ghapi.ledger().length;
    await postDispatch('fsm-tick', { reason: 'schedule-backstop' });
    // m-8: the drill's OWN wake POST is the one dispatch entry between the
    // snapshot and the conductor's actions — pin its ledger index and exclude
    // it (the assert counts CONDUCTOR dispatches, not the drill's control
    // traffic; the conductor run has not started yet — dispatch latency)
    const selfWake = ghapi.ledger().find((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && e.i > before);
    const selfWakeIdx = selfWake ? selfWake.i : before;
    await until(() => {
      const r = sched.runs.filter((x) => x.workflow === 'conductor');
      return r.length && r[r.length - 1].status === 'completed';
    }, { timeoutMs: 30_000, label: 'the backstop wake' });
    await sleep(400);
    const qlog = sched.runLogText(sched.runs.filter((x) => x.workflow === 'conductor').slice(-1)[0].id);
    t.ok(/QUIESCED/.test(qlog), 'the backstop wake QUIESCED (no commit, no self-dispatch)');
    t.ok((await tip()) === frozen, 'the tip is still frozen after the wake');
    const postWakeDispatches = ghapi.ledger().filter((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && e.i > selfWakeIdx);
    t.ok(postWakeDispatches.length === 0, 'ZERO dispatches after the quiesced wake (STOP_CHAIN filtered from the actions; the drill\'s own wake POST excluded)');
    // the watchdog: halted + the GC pass ran (F-15a placement)
    const wlog = await watchdogScan();
    t.ok(/WATCHDOG-DONE mode=halted/.test(wlog), 'the watchdog scan is green on the halted chain');
    t.ok(/GC-TRANSCRIPTS/.test(wlog), 'the transcript-GC pass ran (F-15a: GC precedes the halted exit)');
    const alertIssues = ghapi.issues('local/fsm-lab').filter((it) => (it.labels || []).some((l) => l.name === 'fsm-watchdog-alert'));
    t.ok(alertIssues.length === 0, 'no alert issue was EVER opened on the happy path');
  });
}

function haltedSeed() {
  const g = genesis({
    config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
    project: { tasks: [{ id: 'SEED-1', title: 'seed (halted between epochs)', behavior: 'fast', work_ms: 10, deps: [] }], milestones: 1 },
    chainId: 'c-drill-seed', now: new Date().toISOString(), mode: 'mock',
  });
  g.chain.halted = true;
  g.project.phase = 'done';
  for (const t of Object.values(g.tasks)) t.status = 'done';
  g.stats.done = Object.keys(g.tasks).length;
  return g;
}

// =====================================================================================
// SCENARIO budget-pause — X23's arc + the straggler characterization (C-3)
// =====================================================================================
async function runBudgetPause() {
  const TASKS = ['Q-A', 'Q-B', 'Q-C'];

  // pre-seed a LIVE epoch: 3 tasks, behavior 'infra' (the shim's quota class:
  // infra_failed 'lane-429' — the lane never recovers inside this arc, exactly
  // the quota-storm shape). tick_min_interval_s=0 keeps the drill's ticks
  // unpaced (the >=25s rollover floor is an intake-epoch rule; a seeded epoch
  // keeps its own config).
  // (s23 fix — the seed's lease: 2 was THE s22/B-1 trap value: the envelope
  // deadline = min(2,48)min − 120s is ≤0 at mint, EVERY worker start-gate
  // rejects 'late-start' (WORKER-GATE-REJECT in every run log), the reports
  // carry error 'late-start' — NOT quota-shaped — so the F-6 window never
  // populates, the pause never fires, and the chain burns its infra ladder
  // to a degraded halt. The overflow scenario's seed was already floored to
  // 3 for the same reason; this seed now matches it: floor 3.)
  const g = genesis({
    config: { max_parallel: 4, lease_minutes: 3, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
    project: { tasks: TASKS.map((id) => ({ id, title: `quota storm ${id}`, behavior: 'infra', work_ms: 200, deps: [] })), milestones: 1 },
    chainId: 'c-drill-x23', now: new Date().toISOString(), mode: 'mock',
  });
  seedState(g);

  await phase('BOOT', async (t) => {
    t.ok(await tip() !== null, 'the live epoch is seeded on fsm-state');
    t.ok((await readState()).state?.chain?.paused === false, 'the chain starts unpaused');
  });

  await phase('STORM', async (t) => {
    await postDispatch('fsm-tick', { reason: 'manual' });
    await until(async () => (await queueLines()).filter((r) => TASKS.includes(r.task)).length >= 3, { timeoutMs: 60_000, label: '3 quota reports enqueued' });
    const reps = (await queueLines()).filter((r) => TASKS.includes(r.task));
    t.ok(reps.length >= 3 && reps.every((r) => r.outcome?.status === 'infra_failed' && /lane-429/.test(String(r.outcome?.error || ''))),
      'the infra quota reports (lane-429) are on the queue', `n=${reps.length}`);
    for (const id of TASKS) {
      t.ok(sched.runs.some((r) => r.workflow === 'worker' && r.name === `task-${id} · infra · a1`), `worker run for ${id} (law-4 name shape)`);
    }
  });

  let pauseTip = null;
  let alertLedgerIdx = -1;
  await phase('ALERT-FIRST-PAUSE', async (t) => {
    // the chain's self-tick drains them -> BUDGET_PAUSE_ALERT -> the alert
    // issue FIRST -> the pause commit SECOND (the two-commit protocol).
    await until(async () => (await readState()).state?.chain?.paused === true, { timeoutMs: 90_000, label: 'pause applied' });
    const s = (await readState()).state;
    pauseTip = await tip();
    t.ok(s.chain.paused === true, 'the chain is PAUSED (HOLD)');
    const alertIssues = ghapi.issues('local/fsm-lab').filter((it) => (it.labels || []).some((l) => l.name === 'fsm-watchdog-alert'));
    t.ok(alertIssues.length === 1, 'exactly ONE fsm-watchdog-alert issue opened');
    t.ok(/Lane budget exhausted/.test(alertIssues[0]?.body || ''), 'the alert body is the budget-pause alert');
    // ALERT-FIRST ordering — from the two REAL ledgers: the issue POST's
    // ledger timestamp vs the pause commit's committer time
    const alertPost = ghapi.ledger().find((e) => e.method === 'POST' && /\/issues$/.test(e.path) && (e.req || '').includes('fsm-watchdog-alert'));
    alertLedgerIdx = alertPost ? alertPost.i : -1;
    const pauseCommitMs = commitTime(pauseTip);
    t.ok(!!alertPost && alertPost.t <= pauseCommitMs,
      `ALERT-FIRST: the issue POST (t=${alertPost?.t}) precedes the pause commit (t=${pauseCommitMs})`);
    const jr = await journalTail(30);
    t.ok(jr.some((j) => j.kind === 'CONTROL' && j.command === 'pause' && j.payload?.reason === 'lane-budget-exhausted'),
      'the pause CONTROL journal record (reason lane-budget-exhausted)');
    t.ok(Array.isArray((await readState()).state?.budget_window) && (await readState()).state.budget_window.length >= 3, 'the budget_window is persisted (>=3 entries)');
    t.ok((s.stats?.budget_pauses ?? 0) >= 1, 'stats.budget_pauses counted');
  });

  await phase('PAUSE-HELD', async (t) => {
    // the pause tick's residual (the DOCUMENTED honest residual): its
    // already-dispatched workers burn once under the pause (their leases are
    // the pre-pause cohort — the stragglers of the next phase); ZERO further
    // assigns/dispatches land after the alert+pause.
    await until(async () => (await queueLines()).length >= 3, { timeoutMs: 60_000, label: 'the residual (straggler-cohort) reports land' });
    await sleep(800);
    const jr = await journalTail(80);
    const pauseIdx = jr.findIndex((j) => j.kind === 'CONTROL' && j.command === 'pause');
    const postPauseAssigns = jr.slice(pauseIdx + 1).filter((j) => j.kind === 'ASSIGN');
    t.ok(pauseIdx >= 0 && postPauseAssigns.length === 0, 'ZERO ASSIGN records after the pause', `n=${postPauseAssigns.length}`);
    // every fsm-task dispatch POST precedes the alert POST (the pause tick's
    // own residual window); nothing after
    const postAlertTaskDispatches = ghapi.ledger().filter((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && (e.req || '').includes('"fsm-task"') && e.i > alertLedgerIdx);
    t.ok(postAlertTaskDispatches.length === 0, 'ZERO worker dispatches after the alert+pause (the hold is real)', `n=${postAlertTaskDispatches.length}`);
    t.ok((await readState()).state?.chain?.paused === true, 'the chain is STILL paused (no self-tick revival)');
  });

  await phase('RESUME-NO-REPAUSE', async (t) => {
    // the residual reports are the pre-pause cohort's: their leases predate
    // the resume stamp -> STRAGGLERS. Resume through the REAL ops lane
    // (repository_dispatch fsm-control wakes BOTH conductor.yml and ops.yml —
    // the fan-out the scheduler models).
    const rc = await postDispatch('fsm-control', { command: 'resume', note: 'quota reset (drill)' });
    t.ok(rc === 204, 'the resume control dispatched (fsm-control, 204)');
    await until(async () => (await readState()).state?.chain?.paused === false, { timeoutMs: 60_000, label: 'resume applied' });
    const s = (await readState()).state;
    t.ok(s.chain.paused === false, 'the chain RESUMED');
    t.ok(!!s.budget_window_cleared_at, 'resume stamped budget_window_cleared_at (the C-3 gate)');
    // the straggler reports drained: journaled infra-retries, window entries straggler-marked
    await until(async () => (await queueLines()).length === 0, { timeoutMs: 60_000, label: 'the straggler reports drained' });
    const jr = await journalTail(60);
    const stragglerReports = jr.filter((j) => j.kind === 'REPORT' && j.reason === 'infra-retry');
    t.ok(stragglerReports.length >= 3, `the straggler quota reports drained as infra-retries (net-zero, ${stragglerReports.length} records)`);
    const win = (await readState()).state?.budget_window || [];
    const marked = win.filter((e) => e.straggler === true);
    const distinctNonStraggler = new Set(win.filter((e) => !e.straggler).map((e) => e.task)).size;
    t.ok(marked.length >= 3, 'the window entries are STRAGGLER-marked (lease predates the clear stamp)',
      JSON.stringify(win.map((e) => ({ t: e.task, s: !!e.straggler }))));
    t.ok(distinctNonStraggler === 0, 'the count-trigger\'s distinct set is EMPTY (structurally cannot re-trigger)');
    // THE C-3 PIN: the drained stragglers did NOT re-pause the chain
    await sleep(1500);
    t.ok((await readState()).state?.chain?.paused === false, 'NO RE-PAUSE: the straggler cohort does not re-trigger (the C-3 regression pin, live-observed 3x pre-fix)');
    // (s23 assert-tune, the M-2 discipline: the old filter matched ANY
    // '[fsm-alert]' body — which counts the POST-RESUME TAIL's quarantine +
    // degraded-halt comments (the documented out-of-gates residual: round-3
    // infra exhaustion after the C-3 gate, NOT-MODELED below) as "second
    // alerts". The honest pin: the BUDGET alert's distinctive body — a
    // re-pause would open/comment a SECOND 'Lane budget exhausted' alert;
    // the round-3 quarantine comments are not budget alerts.)
    const budgetAlertPosts = ghapi.ledger().filter((e) => e.method === 'POST' && (/\/issues$/.test(e.path) || /\/comments$/.test(e.path)) && /Lane budget exhausted/.test(String(e.req || '')));
    t.ok(budgetAlertPosts.length <= 1, 'no second BUDGET alert fired around the resume (the C-3 gate holds)', `n=${budgetAlertPosts.length}`);
  });

  // teardown note: the post-resume grind (round-3 infra exhaustion ->
  // degraded halt) is REAL but timing-dependent across ticks; the drill's
  // gates end at the C-3 characterization. That tail is pinned deterministically
  // by sim4/test-budget (see the NOT-MODELED list in the report).
}

// =====================================================================================
// SCENARIO overflow — the C-1/C-2 regression pins
// =====================================================================================
async function runOverflow() {
  // WORKER_OVERFLOW_AT=1: the SECOND concurrent dispatch goes PRE-FLIGHT to
  // the second bucket; the first stays on the main lane. OV-A reports fast
  // (done); OV-B runs 'hang' (silent by design — its lease stays outstanding
  // so the law-4 UNION scan has a live subject).
  sched.setVars({ WORKER_REPO_2: world.repo2, WORKER_OVERFLOW_AT: 1 });
  // (s22/B-1 consequence — the seed's lease: 1 was THE trap value: the
  // envelope deadline = min(1min,48) − 120s is −60s at mint, every worker
  // start-gate rejects 'late-start', the epoch loops re-dispatch — the exact
  // live verification lens-1 cited. The drill seeds a SANE chain: floor 3.)
  const g = genesis({
    config: { max_parallel: 2, lease_minutes: 3, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
    project: { tasks: [
      { id: 'OV-A', title: 'main-lane task', behavior: 'fast', work_ms: 100, deps: [] },
      { id: 'OV-B', title: 'bucket-2 task', behavior: 'hang', work_ms: 100, deps: [] },
    ], milestones: 1 },
    chainId: 'c-drill-ov', now: new Date().toISOString(), mode: 'mock',
  });
  seedState(g);

  await phase('BOOT', async (t) => {
    t.ok(await tip() !== null, 'the live epoch is seeded');
    t.ok(branchTip('main') !== null && spawnSync('git', ['--git-dir', world.repo2Bare, 'rev-parse', 'refs/heads/main']).status === 0, 'both buckets exist (main + repo2 origins)');
  });

  await phase('PREFLIGHT-OVERFLOW', async (t) => {
    await postDispatch('fsm-tick', { reason: 'manual' });
    await until(() => {
      const n = ghapi.ledger().filter((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && (e.req || '').includes('"fsm-task"')).length;
      return n >= 2;
    }, { timeoutMs: 60_000, label: '2 worker dispatches' });
    const dispatchLedger = ghapi.ledger().filter((e) => e.method === 'POST' && /\/dispatches$/.test(e.path) && (e.req || '').includes('"fsm-task"'));
    t.ok(dispatchLedger.length === 2, 'exactly TWO worker dispatches (one per task)', `n=${dispatchLedger.length}`);
    // C-2: EXACTLY ONE dispatch per task — the same-payload double fire is dead
    // (s22 assert-tune: the repo regex must match the TWO-SEGMENT slug —
    // [^/]+ truncated 'local/fsm-lab' to 'local' and both lane asserts failed;
    // the same class the orchestrator fixed in the stand-in's routes)
    const perTask = {};
    for (const d of dispatchLedger) {
      const task = /"task":"([^"]+)"/.exec(d.req || '')?.[1];
      const repo = /\/repos\/([^/]+\/+[^/]+)\/dispatches/.exec(d.path)?.[1];
      perTask[task] = [...(perTask[task] || []), repo];
    }
    t.ok(Object.keys(perTask).length === 2 && Object.values(perTask).every((v) => v.length === 1),
      'C-2 PIN: exactly ONE dispatch per task (the double-dispatch is dead)', JSON.stringify(perTask));
    t.ok(perTask['OV-A']?.[0] === 'local/fsm-lab', 'OV-A dispatched on the MAIN lane');
    t.ok(perTask['OV-B']?.[0] === world.repo2, `OV-B dispatched PRE-FLIGHT to the SECOND bucket (${world.repo2})`);
    // (s22 assert-tune: the decision line lives in the MANUAL tick's log — a
    // one-shot read of the LAST conductor run races both the log's pipe
    // delivery and the self-tick chain replacing "last"; poll ALL conductor
    // logs for the line, and assert the saturated-ladder fallback appears in
    // NONE of them)
    const preflightLogged = await until(() => sched.runs.filter((r) => r.workflow === 'conductor')
      .some((r) => /DISPATCH-OVERFLOW-PREFLIGHT task=OV-B/.test(sched.runLogText(r.id))), { timeoutMs: 30_000, label: 'the pre-flight decision log' });
    t.ok(preflightLogged, 'the pre-flight overflow decision logged (DISPATCH-OVERFLOW-PREFLIGHT task=OV-B)');
    const ladderFallback = sched.runs.filter((r) => r.workflow === 'conductor')
      .some((r) => /DISPATCH-OVERFLOW task=OV-B /.test(sched.runLogText(r.id)));
    t.ok(!ladderFallback, 'NOT the saturated-ladder fallback (the pre-flight arm decided)');
  });

  await phase('MIRROR-RUN', async (t) => {
    // both workers ran; OV-A reports done; OV-B (hang) stays silent
    await until(async () => (await readState()).state?.tasks?.['OV-A']?.status === 'done', { timeoutMs: 60_000, label: 'OV-A done' });
    const bRun = sched.runs.find((r) => r.workflow === 'worker' && r.name.startsWith('task-OV-B'));
    t.ok(!!bRun && bRun.repo === world.repo2, "OV-B's run lives in the SECOND bucket's ledger (the mirror run)");
    const aRun = sched.runs.find((r) => r.workflow === 'worker' && r.name.startsWith('task-OV-A'));
    t.ok(!!aRun && aRun.repo === 'local/fsm-lab', "OV-A's run lives on the main lane");
    // the bucket-2 worker reported to the MAIN fsm-state (the TARGET_REPO geometry)
    t.ok((await readState()).state?.tasks?.['OV-A']?.status === 'done', 'the report routed to the MAIN fsm-state (mkTwoRepos geometry)');
    // (s23 assert-tune — the seed-23 flake: a ONE-SHOT read of the hang
    // worker's log races its dispatch latency + the stdout pipe delivery —
    // OV-A's done-resolve can beat OV-B's START line by a few hundred ms
    // (seeded ±20% latency jitter), and the empty log failed the assert on
    // working machinery. Poll the run's OWN log for the start line — the
    // s22 PREFLIGHT phase's pattern — then assert.)
    await until(() => /WORKER-START task=OV-B behavior=hang/.test(sched.runLogText(bRun.id)), { timeoutMs: 30_000, label: "OV-B's hang-worker start line (WORKER-START task=OV-B behavior=hang)" });
    const wlogB = sched.runLogText(bRun.id);
    t.ok(/WORKER-START/.test(wlogB) && /behavior=hang/.test(wlogB), 'OV-B ran the hang behavior (silent — the lease deadline is the handler)');
  });

  await phase('UNION-VERIFY', async (t) => {
    // law-4's verify scan: OV-B's lease is aged PAST the 360s pre-window AND
    // past its deadline via a drill fixture commit (a 6-minute REAL wall wait
    // would price the drill out of CI; the scan path, the union fetch, and
    // the key match are otherwise fully real — the documented simplification).
    // (s23 fix — the FAITHFUL aged lease: issued_at AND expires move
    // together, expires = issued_at + lease_minutes. The old fixture
    // backdated ONLY issued_at — an impossible lease state whose FRESH
    // expires kept the deadline ~3min in the future, so the asserted
    // TIMEOUT reap could never land inside the drill's window.)
    const st = new Store({ cwd: world.probeClone });
    await st.commit({
      message: 'drill fixture: backdate OV-B lease issued_at+expires (the law-4 pre-window + the deadline)',
      mutate: (cur) => {
        const s = cur;
        const agedMs = Date.now() - 400_000;
        s.tasks['OV-B'].lease.issued_at = new Date(agedMs).toISOString();
        s.tasks['OV-B'].lease.expires = new Date(agedMs + (Number(s.config.lease_minutes) || 3) * 60_000).toISOString();
        s.version += 1;
        return { state: s, journal: [] };
      },
    });
    await postDispatch('fsm-tick', { reason: 'manual' });
    // (s23 fix — the s21-class permanently-falsy gate: "the LAST conductor
    // run is completed" NEVER holds on a LIVE chain. The conductor POSTs its
    // next self-tick dispatch BEFORE exiting, so the newest conductor run is
    // queued/pending/in_progress from the moment the current run mints its
    // continuation — the repro waited 60s while 30+ conductor runs completed
    // (their END lines are in the drill log) and the predicate always read
    // the PENDING successor. The honest gate — the PREFLIGHT phase's own
    // pattern: the verify tick is the conductor run whose LOG carries the
    // VERIFY-SCAN line; poll ALL conductor logs for it.)
    const verifyRun = await until(() => sched.runs.filter((r) => r.workflow === 'conductor')
      .find((r) => /VERIFY-SCAN repos=/.test(sched.runLogText(r.id))), { timeoutMs: 60_000, label: 'the verify tick (a conductor log carrying VERIFY-SCAN)' });
    const log = sched.runLogText(verifyRun.id);
    t.ok(/VERIFY-SCAN repos=2/.test(log), 'C-1 PIN: the verify scan fetched BOTH buckets (the UNION)', (log.match(/VERIFY-SCAN.*/g) || []).join(' | '));
    // (s23 assert-tune: the union's honest page is runs=2 keys=2 — OV-A#a1
    // from the MAIN bucket + OV-B#a1 from the MIRROR. The old keys=1
    // encoded a main-only scan's view; the union exists precisely so BOTH
    // buckets' run keys are seen.)
    t.ok(/runs=2 keys=2/.test(log) && !/VERIFY-FLIP task=OV-B/.test(log), 'the mirror run was SEEN (both buckets\' keys on the page; OV-B not flipped dispatch-unverified)', (log.match(/VERIFY-SCAN.*/g) || []).join(' | '));
    // the VERIFY-SCAN line prints PRE-COMMIT; the reap's TIMEOUT record
    // lands with the SAME run's commit — wait for it explicitly (an
    // immediate journal read raced the commit).
    await until(async () => (await journalTail(40)).some((j) => j.kind === 'TIMEOUT' && j.task === 'OV-B'), { timeoutMs: 30_000, label: 'the reaped lease (TIMEOUT journal record)' });
    const jr = await journalTail(40);
    t.ok(!jr.some((j) => j.reason === 'dispatch-unverified' && j.task === 'OV-B'), 'no dispatch-unverified flip for the bucket-2 task');
    t.ok(jr.some((j) => j.kind === 'TIMEOUT' && j.task === 'OV-B'), 'the backdated lease was reaped by the clock (the documented backstop — the scan correctly did NOT flip)');
  });
}

// =====================================================================================
// SCENARIO recovery — corruption + law-20 pagination + history-walk heal
// =====================================================================================
async function runRecovery() {
  // seed a LIVE epoch with one ready task (the heal tick continues the chain)
  const g = genesis({
    config: { max_parallel: 2, lease_minutes: 2, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 },
    project: { tasks: [
      { id: 'RC-1', title: 'survives the corruption', behavior: 'fast', work_ms: 100, deps: [] },
    ], milestones: 1 },
    chainId: 'c-drill-x15', now: new Date().toISOString(), mode: 'mock',
  });
  seedState(g);
  const goodTip = await tip();

  await phase('BOOT', async (t) => {
    t.ok(goodTip !== null && (await readState()).state?.tasks?.['RC-1']?.status === 'ready', 'the live epoch is seeded (RC-1 ready)');
  });

  await phase('CORRUPT-ALERT', async (t) => {
    // corrupt the tip's state.json via the smoke's c3 plumbing (F4-class damage)
    const st = new Store({ cwd: world.probeClone });
    st.fetch();
    const head = st.headSha();
    const dir = mkdtempSync(join(tmpdir(), 'fsm-corrupt-'));
    try {
      writeFileSync(join(dir, 'state.json'), 'THIS IS NOT JSON');
      const c = st.buildCommit([[join(dir, 'state.json'), 'state/state.json']], [], head, 'drill: corrupt the tip');
      st.git(['push', 'origin', `${c}:refs/heads/fsm-state`]);
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    const { state, corrupt } = await readState();
    t.ok(state === null && corrupt === true, 'the tip is CORRUPT (state.json unparseable)');
    // watchdog scan #1: alert opened, no re-prime (the conservative contract)
    const wlog = await watchdogScan();
    t.ok(/WATCHDOG-DONE mode=corrupt-state alert=opened no-reprime/.test(wlog), 'scan #1: alert OPENED, no re-prime');
    const alerts = ghapi.issues('local/fsm-lab').filter((it) => (it.labels || []).some((l) => l.name === 'fsm-watchdog-alert'));
    t.ok(alerts.length === 1 && /UNREADABLE/.test(alerts[0]?.body || ''), 'ONE fsm-watchdog-alert issue with the corruption body');
  });

  let alertIssueN = null;
  await phase('LAW20-PAGINATION', async (t) => {
    // s22/M-2: the phase now points at the A-2 RESIDUAL, not the fixed bug.
    // The watchdog's marker fetch is per_page=100 + since=<now-24h>
    // (alertCommentsPath — the s21/A-2 fix): the OLD phase flooded 21
    // comments and asserted the duplicate alert the OLD per_page=20 fetch
    // produced — asserting the PRE-fix bug against POST-fix machinery (the
    // scan now SKIPS and the phase failed). The honest residual (documented
    // at lib/watchdog-core.mjs alertCommentsPath): a >100-comments-updated-
    // in-24h burst can still page the marker out of the single newest-100
    // page — the fail direction is ONE extra alert comment, bounded and
    // loud. The phase pins BOTH sides of that boundary on the watchdog's
    // EXACT fetch path (alertCommentsPath imported from the real module —
    // never a re-derived twin): <=100 in-window -> no dup; >100 -> exactly
    // ONE extra alert; the next scan re-latches (bounded, no loop).
    alertIssueN = ghapi.issues('local/fsm-lab').find((it) => (it.labels || []).some((l) => l.name === 'fsm-watchdog-alert'))?.number;
    // scan #2: no marker exists yet -> this scan POSTS the marker comment (the
    // watchdog's own trusted marker)
    const before = ghapi.comments('local/fsm-lab', alertIssueN).length;
    const wlog2 = await watchdogScan();
    t.ok(/WATCHDOG-DONE mode=corrupt-state/.test(wlog2), 'scan #2 still sees the corrupt state');
    const after2 = ghapi.comments('local/fsm-lab', alertIssueN).length;
    t.ok(after2 === before + 1, 'scan #2 posted the marker comment (the first trusted marker)');
    // the watchdog's OWN fetch path: per_page=100 + since=<now-24h>
    const wdPage = async () => {
      const r = await fetch(`${apiBase}${alertCommentsPath('local/fsm-lab', alertIssueN, Date.now())}`, {
        headers: { Authorization: 'token drill-job-token', Accept: 'application/vnd.github+json' },
      });
      return r.status === 200 ? await r.json() : [];
    };
    // ---- the PROTECTED side of the boundary: 100 in-window (marker + 99) ----
    // flood to JUST under the page size: the marker stays inside the newest-100
    for (let i = 1; i <= 99; i++) {
      ghapi.addComment('local/fsm-lab', alertIssueN, { body: `+1 seeing this too (#${i})`, token: ghapi.addStrangerToken(`stranger-${i}`) });
    }
    const pageAt100 = await wdPage();
    t.ok(pageAt100.length === 100 && pageAt100.some((c) => (c.body || '').includes('[fsm-watchdog]')),
      'A-2 PROTECTED: at exactly 100 in-window comments the trusted marker is STILL on the fetched page (since= filters nothing fresh; per_page=100 holds it)');
    const wlog25 = await watchdogScan();
    t.ok(/WATCHDOG-ALERT-SKIP/.test(wlog25), 'scan #2.5 SKIPS: no duplicate alert at <=100 in-window comments (the fixed law-20 break)');
    t.ok(ghapi.comments('local/fsm-lab', alertIssueN).length === 100, 'the skip posted NOTHING (the comment count holds at 100)');
    // ---- the RESIDUAL side: >100 in-window pages the OLDEST (the marker) out ----
    for (let i = 100; i <= 101; i++) {
      ghapi.addComment('local/fsm-lab', alertIssueN, { body: `+1 seeing this too (#${i})`, token: ghapi.addStrangerToken(`stranger-${i}`) });
    }
    const pageAt102 = await wdPage();
    t.ok(pageAt102.length === 100 && pageAt102.every((c) => !((c.body || '').includes('[fsm-watchdog]'))),
      'A-2 RESIDUAL REPRODUCED: at 102 in-window comments the newest-100 page EXCLUDES the marker (single-page fetch, no Link walk)');
    // scan #3: the dedup CANNOT see the trusted marker -> the documented
    // ONE-extra-alert (fail-noisy, bounded; pinned-as-accepted at
    // lib/watchdog-core.mjs alertCommentsPath's comment — this drill is its
    // e2e regression pin)
    const wlog3 = await watchdogScan();
    t.ok(!/WATCHDOG-ALERT-SKIP/.test(wlog3), 'scan #3 did NOT skip (the marker is past the newest-100 page — the >100 residual)');
    const after3 = ghapi.comments('local/fsm-lab', alertIssueN).length;
    t.ok(after3 === 103, 'the ONE extra alert comment landed (102 + 1 — the bounded residual, not a loop)', `comments=${after3}`);
    // ---- BOUNDEDNESS: the fresh scan-3 marker is the NEWEST comment -> the
    // next scan re-latches; the residual costs ONE alert, not one per scan
    const wlog4 = await watchdogScan();
    t.ok(/WATCHDOG-ALERT-SKIP/.test(wlog4), 'scan #4 SKIPS again (the new marker is fresh + on-page — the residual is BOUNDED)');
    t.ok(ghapi.comments('local/fsm-lab', alertIssueN).length === 103, 'the count HOLDS at 103 (no second extra alert)');
  });

  await phase('HEAL', async (t) => {
    // the manual re-prime tick: the conductor's history-walk recovery
    await postDispatch('fsm-tick', { reason: 'manual' });
    await until(async () => {
      const { state, corrupt } = await readState();
      return state !== null && corrupt !== true;
    }, { timeoutMs: 60_000, label: 'history-walk heal' });
    const { state } = await readState();
    t.ok(state !== null, 'state.json HEALED (parseable)');
    const nowTip = await tip();
    t.ok(nowTip !== null && commitTime(nowTip) > commitTime(goodTip), 'the tip ADVANCED past the corrupt commit (repair forces the commit)');
    const jr = await journalTail(40);
    const rec = jr.find((j) => j.kind === 'RECOVERY');
    t.ok(rec?.reason === 'history-walk' && !!rec?.snapshotSha, 'the RECOVERY(history-walk) journal record carries the snapshot sha');
    // the chain CONTINUES from the healed state: RC-1 gets dispatched
    await until(async () => ['assigned', 'in_progress', 'done'].includes((await readState()).state?.tasks?.['RC-1']?.status), { timeoutMs: 60_000, label: 'RC-1 dispatched post-heal' });
    t.ok(true, 'the healed chain continues (RC-1 assigned)');
  });

  await phase('HEALTHY-SCAN', async (t) => {
    await until(async () => (await readState()).state?.chain?.halted === true, { timeoutMs: 90_000, label: 'epoch completes' });
    const wlog = await watchdogScan();
    t.ok(/WATCHDOG-DONE mode=halted/.test(wlog) && !/UNREADABLE/.test(wlog), 'the final scan is clean (halted, state healthy)');
    t.ok(/GC-TRANSCRIPTS/.test(wlog), 'the GC pass ran');
  });
}

// =====================================================================================
// RUN + THE REPORT
// =====================================================================================
const drivers = { x22: runX22, 'budget-pause': runBudgetPause, overflow: runOverflow, recovery: runRecovery };

const t0 = Date.now();
let verdict = 'FAIL';
try {
  await Promise.race([
    drivers[scenario](),
    sleep(timeoutMin * 60_000).then(() => { throw new Error(`drill timeout (${timeoutMin}min)`); }),
  ]);
  verdict = phases.length && phases.every((p) => p.ok) ? 'PASS' : 'FAIL';
} catch (e) {
  console.error(`[drill] FATAL: ${e.message}`);
  phases.push({ name: 'FATAL', ok: false, ms: Date.now() - t0, asserts: 1, fails: 1, error: String(e.message).slice(0, 300) });
}

await sched.stop();
await ghapi.close();
world.teardown();

const wallMs = Date.now() - t0;

const NOT_MODELED = [
  'PAT-comment trigger law (live GHA wakes workflows only on real-user-PAT-authored comments; the scheduler delivers every accepted dispatch)',
  'secondary rate limits (the 403/429+Retry-After ladder shapes stay unit/sim-pinned; the stand-in always 204s dispatches)',
  'runner cold-start, minute quotas, and cross-repo contention beyond the modeled repo-wide ParallelCap(5)',
  'real authn/authz (the stand-in trusts its minted tokens; the door\'s permission classes are scenario data, not GitHub\'s)',
  'the paid LLM lane (the cc lane runs the real adapter + bridge + spawn boundary against the deterministic fake CLI; no OpenRouter bytes move)',
  'law-4\'s 360s pre-window (and the lease deadline) is backdated by a drill fixture commit in the overflow scenario — issued_at AND expires move together, the faithful aged-lease shape (a 6-minute real wait is priced out of CI; the scan path, the union fetch and the key match are fully real)',
  'the budget-pause post-resume tail (round-3 infra exhaustion -> degraded halt or backstop re-pause) is timing-dependent across ticks; the drill\'s gates end at the C-3 characterization — that tail is pinned deterministically by sim4/test-budget',
  'pagination beyond the A-2 fetch contract: the stand-in implements since= (server semantics) but serves ONE newest-per_page page, no Link headers — a >100-comments-updated-in-24h burst pages the trusted marker out and costs ONE extra alert comment (bounded, fail-noisy; the recovery drill pins both sides of the boundary)',
  'issue/PR webhooks, check-runs, artifacts API, merge/close flows (the pull stand-in opens and stamps; nobody merges)',
];


const report = {
  drill: scenario, seed, timeScale, keep, started: new Date(t0).toISOString(), wallMs,
  phases,

  metrics: {
    ...sched.metrics,
    perRunLatencies: sched.runs.filter((r) => r.startedAt).map((r) => ({
      run: r.id, workflow: r.workflow, repo: r.repo, name: r.name,
      queuedMs: r.queuedMs, runMs: r.runMs, conclusion: r.conclusion, exitCode: r.exitCode,
    })),
  },
  notModeled: NOT_MODELED,
  verdict,
};

const reportPath = join(ROOT, 'e2e', 'last-drill-report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\nDRILL-REPORT ${JSON.stringify(report)}`);
console.log(`\nDRILL ${scenario}: ${verdict} (${Math.round(wallMs / 1000)}s wall, ${phases.length} phases, report: e2e/last-drill-report.json${keep ? ` + ${scratchDir} retained` : ''})`);
exit(verdict === 'PASS' ? 0 : 1);

// the honest list — carried IN the report (the brief's requirement)
