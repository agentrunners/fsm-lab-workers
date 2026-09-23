#!/usr/bin/env node
// fake-cc.mjs — the CC_FAKE_LLM determinism stub (T46/W4 §1d-f).
//
// CC_FAKE_LLM=1 spawns THIS script instead of the real
// @anthropic-ai/claude-code CLI: the adapter builds ONE argument vector and
// only swaps the command (npx -y @anthropic-ai/claude-code@<ver> → node
// fake-cc.mjs), so the argv shape asserted by conformance is the REAL one.
// stdout follows the --output-format json result-object contract. ZERO
// network, ZERO npm install — functional tests NEVER burn fuel; the only
// real-lane execution is X20's manual dispatch.
//
// FIXTURE SELECTION — a marker in the PROMPT (the argv element after -p)
// selects the deterministic response:
//
//   (no marker)               normal done: result = "fake-cc ok: …"
//   [fixture:429]             rc 0, error TEXT packaged as a successful answer
//                             ("…429 rate limit exceeded…") — the E11 class
//                             the classifier must catch BEFORE done → infra hop
//   [fixture:429-if:<substr>] the 429 shape ONLY when ANTHROPIC_AUTH_TOKEN
//                             contains <substr> — the lane-rotation fixture
//                             (key-1 lanes fail, a key-2 lane completes)
//   [fixture:auth-text]       rc 0, 401 text packaged as a successful answer
//                             ("…401 Unauthorized… invalid api key…") — E11
//   [fixture:done-marker-prose]
//                             rc 0, a REAL done answer whose prose MERELY
//                             MENTIONS the E11 markers mid-sentence (the
//                             runbook/quota-docs shape) — the s21/W4
//                             NEGATIVE: must stay done (no rotation, no
//                             quarantine)
//   [fixture:reasoning]       rc 0, result:null + reasoning populated — the
//                             F-M4 reasoning-first shape
//   [fixture:fail]            rc 0, result:null + reasoning:null — the empty
//                             completion (work class, no hop)
//   [fixture:exit-transport]  rc 1, transport-shaped stderr (connect
//                             ECONNREFUSED…) — the non-zero-exit infra class
//   [fixture:exit-app]        rc 2, plain app stderr — non-zero-exit WORK class
//   [fixture:exit-api-<status>]
//                             rc 1, stdout = the REAL CLI error-exit result
//                             JSON: is_error:true + NUMERIC
//                             api_error_status:<status> + the API Error
//                             text (X21-final VERBATIM for 429: "API Error:
//                             Request rejected (429) · Rate limit exceeded:
//                             free-models-per-day-high-balance") — the B-1
//                             shape: infra lane-<status>, rotation
//   [fixture:exit-api-<status>-if:<substr>]
//                             the same error-exit shape ONLY when
//                             ANTHROPIC_AUTH_TOKEN contains <substr> — the
//                             rotation-RECOVERY fixture (key-1 lanes exit
//                             with the API error, a key-2 lane completes)
//   [fixture:exit-api-<status>-unless-free]
//                             the same error-exit shape ONLY when
//                             ANTHROPIC_MODEL does NOT end ':free' — the
//                             s23 FREE-TAIL drill (the design probe §1a's
//                             citation pair verbatim: PAID lanes exit the
//                             key-class error on a drained key, the `:free`
//                             tail lane answers — the W1 both-keys-dry arc
//                             k1ds(402)→JUMP→k2ds(402)→TAIL→k2nem done)
//   [fixture:sleep-ms=<n>]    sleeps <n> REAL ms (spawning a same-group
//                             grandchild that sleeps longer — the group-kill
//                             proof), then normal done
//   [fixture:dup-report]      normal done + repeat_report:true (the adapter
//                             propagates it; the worker double-enqueues)
//   [fixture:max-turns]       rc 0, is_error:true + subtype error_max_turns —
//                             the CLI's own turn cap (the harness ceiling)
//   [fixture:artifacts]       writes tasks/<id>/artifacts/out-fake.md (a
//                             LEGAL write-back ref) then normal done
//   [fixture:scratch]         writes the CLI-internal scratch set
//                             (.claude/settings.json + .claude.json — NEVER
//                             write-back claims) PLUS a legal artifact, then
//                             normal done — pins the adapter's scratch
//                             exclusion against the claim surface
//   [fixture:wb-violation]    writes the shim-parity artifact set —
//                             tasks/<id>/out/report.md (legal) +
//                             .github/workflows/evil.yml (dotgit, denied
//                             ALWAYS) + evil.txt (root, undeclared) — the
//                             write-back door must flag the last two verbatim
//
// SPAWN-BOUNDARY ECHO (F-M7): if the adapter passed FAKE_CC_ECHO_PATH (fake
// mode only), the full invocation record — argv, the F-M8 env subset
// (ANTHROPIC_BASE_URL / AUTH_TOKEN / MODEL / SMALL_FAST_MODEL /
// DISABLE_TELEMETRY / OX_AGENT_DEADLINE_UTC + the adapter's
// OX_AGENT_TASK_ID), the SORTED child-env KEY SET (M-1: the secret-absence
// proof — Object.keys(process.env) of the merged child env), cwd, and the
// pids — is written THERE synchronously at start, BEFORE any fixture
// action, so even a deadline-killed spawn leaves its boundary record for
// the conformance assertions. Real mode never sets the var and this file
// never runs.
//
// This file is TEST MACHINERY, not product surface: the real CLI never emits
// `reasoning`/`repeat_report`/`num_turns`-as-fixture or FAKE_CC_ECHO_PATH —
// they are the documented fake-only extensions the adapter tolerates
// (superset parsing; the mapping is documented in cc-adapter.mjs).

import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const pIdx = argv.indexOf('-p');
const prompt = pIdx >= 0 && pIdx + 1 < argv.length ? argv[pIdx + 1] : '';

const ENVS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'DISABLE_TELEMETRY', 'OX_AGENT_DEADLINE_UTC', 'OX_AGENT_TASK_ID'];

const marker = (name) => prompt.includes(`[fixture:${name}]`);
const sleepMatch = /\[fixture:sleep-ms=(\d+)\]/.exec(prompt);
const ifMatch = /\[fixture:429-if:([^\]]+)\]/.exec(prompt);
// the REAL CLI error-exit family (B-1): -if wins over the plain form;
// s23: -unless-free keys on the LANE MODEL's freeness (the tail drill)
const apiExitIf = /\[fixture:exit-api-(\d{3})-if:([^\]]+)\]/.exec(prompt);
const apiExitUnlessFree = !apiExitIf ? /\[fixture:exit-api-(\d{3})-unless-free\]/.exec(prompt) : null;
const apiExitPlain = !apiExitIf && !apiExitUnlessFree ? /\[fixture:exit-api-(\d{3})\]/.exec(prompt) : null;
const apiExitStatus = apiExitIf ? parseInt(apiExitIf[1], 10)
  : (apiExitUnlessFree ? parseInt(apiExitUnlessFree[1], 10)
    : (apiExitPlain ? parseInt(apiExitPlain[1], 10) : null));
const apiExitArmed = apiExitStatus !== null
  && (!apiExitIf || String(process.env.ANTHROPIC_AUTH_TOKEN || '').includes(apiExitIf[2]))
  && (!apiExitUnlessFree || !String(process.env.ANTHROPIC_MODEL || '').endsWith(':free'));

// ---- the artifact-writing fixtures (the write-back surface) ---------------
// The adapter hands the CLI a temp workdir and scans it after the turn; these
// fixtures write the same shapes the shim's behavior table claims. The task
// namespace comes from the adapter's OX_AGENT_TASK_ID env (the artifact
// convention: legal refs live under tasks/<id>/**).
const taskId = process.env.OX_AGENT_TASK_ID || 'unknown-task';
if (marker('artifacts')) {
  mkdirSync(`tasks/${taskId}/artifacts`, { recursive: true });
  writeFileSync(`tasks/${taskId}/artifacts/out-fake.md`,
    `# fake-cc artifact\ntask ${taskId}: a deterministic legal write-back ref (fixture:artifacts)\n`);
}
if (marker('scratch')) {
  // the CLI's own workdir-local scratch (excluded from the claim surface)
  // + one REAL artifact: the adapter's scan must claim only the latter
  mkdirSync('.claude', { recursive: true });
  writeFileSync('.claude/settings.json', '{"permissions":{}}\n');
  writeFileSync('.claude.json', `{"userID":"fake-${process.pid}"}\n`);
  mkdirSync(`tasks/${taskId}/artifacts`, { recursive: true });
  writeFileSync(`tasks/${taskId}/artifacts/real.md`, `# real artifact\ntask ${taskId}: the one claimable ref (fixture:scratch)\n`);
}
if (marker('wb-violation')) {
  mkdirSync(`tasks/${taskId}/out`, { recursive: true });
  mkdirSync('.github/workflows', { recursive: true });
  writeFileSync(`tasks/${taskId}/out/report.md`, `# fake-cc report\ntask ${taskId}: the LEGAL ref (task namespace)\n`);
  writeFileSync('.github/workflows/evil.yml', 'name: evil\non: [push]\njobs: {x: {runs-on: ubuntu-latest, steps: [{run: echo pwned}]}}\n');
  writeFileSync('evil.txt', 'the undeclared ROOT ref (fixture:wb-violation)\n');
}

// ---- the sleep fixture's grandchild (the group-kill proof) ----------------
// A same-process-group grandchild that outlives the fake: the adapter's GROUP
// kill must take it down with the leader (a leader-only kill would leave it
// alive — the conformance asserts BOTH pids are dead). stdio 'ignore' so it
// never holds our stdout pipe open past our own exit.
let grandchild = null;
if (sleepMatch) {
  const ms = parseInt(sleepMatch[1], 10) || 1000;
  grandchild = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Math.max(ms * 4, 4000)})`], { stdio: 'ignore' });
  const killGrandchild = () => { if (grandchild.pid) { try { grandchild.kill('SIGKILL'); } catch { /* already gone */ } } };
  process.on('exit', killGrandchild);
  void ms;
}

// ---- the spawn-boundary echo (BEFORE any fixture action) ------------------
if (process.env.FAKE_CC_ECHO_PATH) {
  writeFileSync(process.env.FAKE_CC_ECHO_PATH, JSON.stringify({
    argv,
    env: Object.fromEntries(ENVS.map(k => [k, process.env[k] ?? null])),
    env_keys: Object.keys(process.env).sort(),   // M-1: the merged child-env key set
    cwd: process.cwd(),
    pid: process.pid,
    grandchildPid: grandchild?.pid ?? null,
    fixtures: [
      ...(sleepMatch ? [`sleep-ms=${sleepMatch[1]}`] : []),
      ...(ifMatch ? [`429-if:${ifMatch[1]}`] : []),
      ...(apiExitStatus !== null ? [`exit-api-${apiExitStatus}${apiExitIf ? `-if:${apiExitIf[2]}` : ''}${apiExitUnlessFree ? '-unless-free' : ''}`] : []),
      ...['429', 'auth-text', 'done-marker-prose', 'reasoning', 'fail', 'exit-transport', 'exit-app', 'dup-report', 'max-turns', 'artifacts', 'scratch', 'wb-violation'].filter(m => marker(m)),
    ],
  }, null, 2));
}

// ---- the fixture dispatcher ------------------------------------------------
const model = process.env.ANTHROPIC_MODEL || '<no-model>';
const okResult = `fake-cc ok: completed the task on ${model} (deterministic stub — no network)`;
const emit = (payload) => process.stdout.write(JSON.stringify({
  num_turns: 1, session_id: `fake-${process.pid}`, usage: null,
  ...payload,
}));

if (marker('exit-transport')) {
  process.stderr.write('Error: request failed: fetch failed: connect ECONNREFUSED 203.0.113.9:443 (transport fixture)\n');
  process.exit(1);
}
if (marker('exit-app')) {
  process.stderr.write('fixture app error: deterministic non-transport failure (exit 2)\n');
  process.exit(2);
}
if (apiExitArmed) {
  // the REAL CLI error-exit (X21-final): the result JSON rides STDOUT and
  // the process exits rc 1 — is_error + NUMERIC api_error_status + the
  // verbatim API Error text for 429 (B-1's classification input)
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'api_error', is_error: true,
    api_error_status: apiExitStatus,
    result: apiExitStatus === 429
      ? 'API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day-high-balance'
      : `API Error: Request rejected (${apiExitStatus})`,
  }));
  process.exit(1);
}
if (marker('max-turns')) {
  emit({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Max turns reached!', num_turns: 40 });
  process.exit(0);
}
if (sleepMatch) {
  const ms = parseInt(sleepMatch[1], 10) || 1000;
  setTimeout(() => {
    emit({ type: 'result', subtype: 'success', is_error: false, result: okResult, reasoning: null, repeat_report: marker('dup-report') });
    process.exit(0);
  }, ms);
} else if (marker('429') || (ifMatch && String(process.env.ANTHROPIC_AUTH_TOKEN || '').includes(ifMatch[1]))) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'Error: 429 rate limit exceeded on the shared lane (fixture:429) — retry after backoff', reasoning: null, repeat_report: false });
  process.exit(0);
} else if (marker('auth-text')) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'API Error: 401 Unauthorized — invalid api key or insufficient credits (fixture:auth-text)', reasoning: null, repeat_report: false });
  process.exit(0);
} else if (marker('done-marker-prose')) {
  // s21/W4 NEGATIVE: a legitimately DONE answer that DISCUSSES the markers
  // mid-prose (this repo's own task mix — runbooks for the 429 lane, quota
  // docs). Pre-W4 the bare substring scan convicted it as E11 infra →
  // rotation → lane-exhausted → infra-exhausted quarantine of landed work.
  emit({ type: 'result', subtype: 'success', is_error: false,
    result: 'Done: documented the ops runbook — when a rate limit hits the shared lane the pool rotates keys and the backoff ladder absorbs it; the 401 unauthorized section now covers the dead-key class too. Artifact staged.',
    reasoning: null, repeat_report: false });
  process.exit(0);
} else if (marker('reasoning')) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: null, reasoning: 'fixture reasoning chain: the answer is 42 — content stayed null (the F-M4 reasoning-first shape)', repeat_report: false });
  process.exit(0);
} else if (marker('fail')) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: null, reasoning: null, repeat_report: false });
  process.exit(0);
} else {
  emit({ type: 'result', subtype: 'success', is_error: false, result: okResult, reasoning: null, repeat_report: marker('dup-report') });
  process.exit(0);
}
