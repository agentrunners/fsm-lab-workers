#!/usr/bin/env node
// fake-codex.mjs — the CODEX_FAKE_LLM determinism stub (s24/B4).
//
// CODEX_FAKE_LLM=1 spawns THIS script instead of the real codex CLI: the
// adapter builds ONE argument vector (['exec', '--json', …, '<prompt>']) and
// only swaps the command (codex → node fake-codex.mjs), so the argv shape
// asserted by conformance is the REAL one. stdout follows the --json JSONL
// event contract (thread.started → turn.started → item.completed
// agent_message → turn.completed usage); stderr carries the clap-style usage
// error on the exit-2 fixture. ZERO network, ZERO npm install — functional
// tests NEVER burn fuel; the only real-lane execution is the B10 smoke's
// manual dispatch.
//
// FIXTURE SELECTION — a marker in the PROMPT (the LAST argv element) selects
// the deterministic response:
//
//   (no marker) / [fixture:ok]
//                             exit 0 — the full happy stream:
//                             thread.started → turn.started →
//                             item.completed(agent_message) →
//                             turn.completed(usage) with a fixed usage block
//   [fixture:ok-artifacts]    the happy stream + writes
//                             tasks/<id>/artifacts/out-codex.md (a LEGAL
//                             write-back ref — R1's law row: the workdir ends
//                             up containing ONLY the task's declared
//                             artifacts)
//   [fixture:agents-md-stray] the happy stream + writes AGENTS.md at the
//                             workdir ROOT + tasks/<id>/artifacts/real.md —
//                             R1's COUNTER-PIN: the stray file must fire the
//                             write-back door (root-not-declared(AGENTS.md))
//   [fixture:exit-2]          exit 2, clap-style stderr ("error: unexpected
//                             argument …"), NO events — D13's terminal
//                             codex-usage row
//   [fixture:error_credits]   exit 1 — error event (402 payment required /
//                             insufficient credits) + turn.failed — the
//                             key-class JUMP row
//   [fixture:error_auth]      exit 1 — 401 unauthorized — key-class
//   [fixture:error_quota_daily]
//                             exit 1 — 429 … free-models-per-day — key-class
//   [fixture:error_rate_limit]
//                             exit 1 — 429 rate limit (non-daily) — plain
//                             advance (the R3-degenerate ladder row)
//   [fixture:error_network]   exit 1 — 503 service unavailable / connection
//                             reset — plain advance
//   [fixture:error_<class>-if:<substr>]
//                             the SAME error shape, but ONLY when
//                             OPENROUTER_API_KEY (the LANE key, D14's
//                             overlay) contains <substr> — the
//                             rotation-RECOVERY fixture (key-1 lanes fail,
//                             a key-2 lane completes)
//   [fixture:turn-failed]     exit 1 — turn.failed with an UNCLASSIFIABLE
//                             message ("the model declined the task…") —
//                             the work-class terminal row (R7: nothing
//                             classifiable in the stream → the exit code
//                             decides)
//   [fixture:hang]            NO events, sleeps long — the wall-kill fixture
//                             (spawns a same-group grandchild that sleeps
//                             longer: the group-kill proof)
//   [fixture:usage-rich]      exit 0 — a TWO-TURN stream with rich usage
//                             (cached_input_tokens, cache_write_input_tokens,
//                             reasoning_output_tokens; usage SUMS across
//                             turn.completed) — the lane_stats arithmetic row
//
// SPAWN-BOUNDARY ECHO: if the adapter passed CODEX_FAKE_ECHO_PATH (fake mode
// only), the full invocation record — argv, the D14 env subset (CODEX_HOME /
// OPENROUTER_API_KEY / OX_AGENT_TASK_ID / OX_AGENT_DEADLINE_UTC), the SORTED
// child-env KEY SET (M-1: the secret-absence proof), cwd, the STDIN fd class
// (fstatSync(0): 'chardev-ignored' proves stdio:'ignore' — a piped stdin
// would be 'fifo' and codex would hang on "additional input", gotcha §10.1),
// the pids, and the armed fixture names — is written THERE synchronously at
// start, BEFORE any fixture action, so even a deadline-killed spawn leaves
// its boundary record for the conformance assertions. Real mode never sets
// the var and this file never runs.
//
// This file is TEST MACHINERY, not product surface: the real codex CLI is
// the only other writer of these event shapes.

import { writeFileSync, mkdirSync, fstatSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
// the prompt is the LAST argv element (the adapter's vector always ends with
// it — the FSM envelope IS the prompt, R2)
const prompt = argv.length ? argv[argv.length - 1] : '';

const ENVS = ['CODEX_HOME', 'OPENROUTER_API_KEY', 'OX_AGENT_TASK_ID', 'OX_AGENT_DEADLINE_UTC'];

const marker = (name) => prompt.includes(`[fixture:${name}]`);
// [fixture:error_<class>-if:<substr>] — armed only when the LANE key
// (OPENROUTER_API_KEY, D14's overlay) contains <substr>
const classIf = /\[fixture:error_(credits|auth|quota_daily|rate_limit|network)-if:([^\]]+)\]/.exec(prompt);
const plainClass = /(?:^|\s)\[fixture:error_(credits|auth|quota_daily|rate_limit|network)\](?:\s|$)/.exec(prompt);

const ERROR_TEXTS = {
  error_credits: 'Payment required: 402 insufficient credits on this key (fixture:error_credits)',
  error_auth: '401 Unauthorized: invalid api key (fixture:error_auth)',
  error_quota_daily: '429 rate limit exceeded: free-models-per-day-high-balance (fixture:error_quota_daily)',
  error_rate_limit: '429 Too Many Requests: rate limit exceeded on this key, retry after backoff (fixture:error_rate_limit)',
  error_network: 'stream error: connection reset while waiting for the model (503 service unavailable upstream)',
};

// the armed error class: the -if form wins over the plain form; the -if
// form fires ONLY on the matching lane key
let errorClass = null;
if (classIf) {
  if (String(process.env.OPENROUTER_API_KEY || '').includes(classIf[2])) errorClass = `error_${classIf[1]}`;
} else if (plainClass) {
  errorClass = `error_${plainClass[1]}`;
}

// ---- the artifact-writing fixtures (the write-back surface) ---------------
// The adapter hands codex a temp workdir and scans it after the turn; these
// fixtures write the shapes the door must govern. The task namespace comes
// from the adapter's OX_AGENT_TASK_ID env (the artifact convention).
const taskId = process.env.OX_AGENT_TASK_ID || 'unknown-task';
if (marker('ok-artifacts')) {
  mkdirSync(`tasks/${taskId}/artifacts`, { recursive: true });
  writeFileSync(`tasks/${taskId}/artifacts/out-codex.md`,
    `# fake-codex artifact\ntask ${taskId}: a deterministic legal write-back ref (fixture:ok-artifacts)\n`);
}
if (marker('agents-md-stray')) {
  // R1's counter-pin: a stray guidance file at the workdir root (the shape a
  // misconfigured harness or a hostile model would leave) — the door MUST
  // flag it; the adapter's empty exclude-set claims everything it finds
  writeFileSync('AGENTS.md', `# stray project doc\nsomeone seeded codex guidance into the workdir (fixture:agents-md-stray)\n`);
  mkdirSync(`tasks/${taskId}/artifacts`, { recursive: true });
  writeFileSync(`tasks/${taskId}/artifacts/real.md`, `# real artifact\ntask ${taskId}: the legal ref beside the stray (fixture:agents-md-stray)\n`);
}

// ---- the hang fixture's grandchild (the group-kill proof) ----------------
// A same-process-group grandchild that outlives the fake: the adapter's
// GROUP kill must take it down with the leader. stdio 'ignore' so it never
// holds our stdout pipe open past our own exit.
let grandchild = null;
if (marker('hang')) {
  grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const killGrandchild = () => { if (grandchild.pid) { try { grandchild.kill('SIGKILL'); } catch { /* already gone */ } } };
  process.on('exit', killGrandchild);
}

// ---- the spawn-boundary echo (BEFORE any fixture action) ------------------
if (process.env.CODEX_FAKE_ECHO_PATH) {
  let stdinClass = 'unknown';
  try {
    const st = fstatSync(0);
    stdinClass = st.isFIFO() ? 'fifo'
      : st.isCharacterDevice() ? (process.stdin.isTTY ? 'tty' : 'chardev-ignored')
        : 'other';
  } catch { /* fd unreadable — recorded as unknown */ }
  writeFileSync(process.env.CODEX_FAKE_ECHO_PATH, JSON.stringify({
    argv,
    env: Object.fromEntries(ENVS.map(k => [k, process.env[k] ?? null])),
    env_keys: Object.keys(process.env).sort(),   // M-1: the merged child-env key set
    cwd: process.cwd(),
    stdin: stdinClass,
    pid: process.pid,
    grandchildPid: grandchild?.pid ?? null,
    fixtures: [
      ...(errorClass !== null ? [errorClass + (classIf ? `-if:${classIf[2]}` : '')] : []),
      ...['ok', 'ok-artifacts', 'agents-md-stray', 'exit-2', 'turn-failed', 'hang', 'usage-rich'].filter(m => marker(m)),
    ],
  }, null, 2));
}

// ---- the fixture dispatcher ------------------------------------------------
const model = process.env.OPENROUTER_API_KEY ? `key#${String(process.env.OPENROUTER_API_KEY).length}` : '<no-key>';
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const happyStream = (text, usage) => {
  emit({ type: 'thread.started', thread_id: `fake-codex-${process.pid}` });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage });
};

const OK_USAGE = { input_tokens: 1200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 0 };
const okText = `fake-codex ok: completed the task on ${model} (deterministic stub — no network)`;

if (marker('exit-2')) {
  // D13: the clap usage-error class — stderr + exit 2, NEVER any event
  process.stderr.write("error: unexpected argument '--bogus-flag' found\n\nUsage: codex exec [OPTIONS] [PROMPT]\nFor more information, try '--help'.\n");
  process.exit(2);
}
if (errorClass !== null) {
  // the classifiable error family: an `error` event + turn.failed + exit 1
  // (the R7 event-wins shape — the cx-runner's verified error surfaces)
  const text = ERROR_TEXTS[errorClass];
  emit({ type: 'thread.started', thread_id: `fake-codex-${process.pid}` });
  emit({ type: 'error', message: text });
  emit({ type: 'turn.failed', error: { message: text } });
  process.exit(1);
}
if (marker('turn-failed')) {
  // R7's other half: an UNCLASSIFIABLE failure — nothing rotatable in the
  // stream, so the EXIT CODE classifies (work_failed, terminal)
  emit({ type: 'thread.started', thread_id: `fake-codex-${process.pid}` });
  emit({ type: 'turn.started' });
  emit({ type: 'turn.failed', error: { message: 'the model declined the task: policy refusal on the requested output shape (fixture:turn-failed)' } });
  process.exit(1);
}
if (marker('hang')) {
  // no events, no exit — the wall kill is the only way out (the group kill
  // must also take the grandchild above)
  setTimeout(() => { process.exit(0); }, 30000);
} else if (marker('usage-rich')) {
  // the two-turn rich-usage stream: usage SUMS across turn.completed (the
  // decode's accounting contract), cached/cache_write/reasoning variants
  emit({ type: 'thread.started', thread_id: `fake-codex-${process.pid}` });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'fake-codex ok: first turn done (usage-rich fixture)' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 315, output_tokens: 122, reasoning_output_tokens: 30 } });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_3', type: 'reasoning', text: 'fixture reasoning: verifying the second turn (usage-rich)' } });
  emit({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'fake-codex ok: completed the two-turn usage-rich task' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 10 } });
  process.exit(0);
} else {
  happyStream(okText, OK_USAGE);
  process.exit(0);
}
