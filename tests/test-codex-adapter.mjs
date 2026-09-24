// test-codex-adapter.mjs — the s24/B2+B4+B5 CODEX-ADAPTER suite.
// Pins worker/codex-adapter.mjs through CODEX_FAKE_LLM=1 (the determinism
// mode — worker/fake-codex.mjs stands in for the real codex CLI with the
// REAL argv, zero network, zero npm install; the REAL lane is only ever
// touched by the B10 smoke's manual dispatch):
//   - the model table (worker/codex/models.json — the single source)
//   - the lane algebra: MODEL-MAJOR [k1/ds, k2/ds, k1/glm, k2/glm], the
//     KEY_2 degradation, the empty pool, the attempts bound
//   - the advance policy: the generic key-class JUMP machinery (R3: the
//     degeneration on the model-major list pinned as +1-identical; the
//     machinery itself pinned on a synthetic key-major list)
//   - the argv: the exact vector, the prompt VERBATIM as the last element
//   - the D14 env contract: the 8-member strip set + the {CODEX_HOME, lane
//     key} overlay, the caller's CODEX_HOME winning over the scratch home
//   - the JSONL event decode: every fixture stream (last agent_message,
//     usage sums incl. cached, torn-tail tolerance, the benign filters)
//   - the error classification: the cx-runner table, ported
//   - R7 precedence: codexLaneOutcome's every row (events win; exit 2
//     ALWAYS terminalizes D13's codex-usage)
//   - the lane_stats arithmetic: off-peak + weekday-peak, cached reads at
//     the cache-read price, the exact aggregate through a real fake turn
//   - the workdir hygiene: R1's law + the stray-AGENTS.md counter-pin
//   - the transcript provenance + the artifact-push escalation shape
//   - THE B5 ROUTING SEAM PIN: a real fake-mode codex turn through runTurn
//     carries lane_stats into the enqueued report (a codex turn WITHOUT
//     lane_stats fails THIS test — the adapter-to-drain carry is pinned,
//     not just the adapter's own return)
//   - s25/b1: THE REAL-MODE TRANSCRIPT LANE — pushSessionsContents (the
//     adapter seam) + a full real-mode codex turn whose transcripts land
//     through the CONTENTS API on an injected fetch (CODEX_BIN shim →
//     fake-codex.mjs with the REAL argv: the real lane's code paths —
//     NOT CODEX_FAKE_LLM — zero network, zero git), and the done-turn
//     escalation when the push dies (transcript-push-failed, the class the
//     FSM's net-zero ladder absorbs)
// The design-spec conformance matrix (the §2 rows) lives in
// worker/conformance-codex.mjs — this file is the adapter's own unit surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexTurn, codexLanes, codexKeyPool, codexModelEntry, codexArgv, codexLaneEnv,
  codexChildEnv, codexNextLaneIndex, codexErrorClass, codexLaneOutcome,
  decodeCodexEvents, codexUsageCost, isCodexPeakWindow, codexUsageLaneLine,
  codexErrorLaneLine, codexArtifactPushEscalation, pushSessionsContents,
  CODEX_ENV_DENYLIST, CODEX_MODELS, CODEX_MODEL_TABLE,
  CODEX_KEY_CLASS_EVENTS, CODEX_ROTATABLE_ERROR_EVENTS,
} from '../worker/codex-adapter.mjs';
import { classifyOutcome } from '../lib/worker-contract.mjs';
import { runTurn } from '../worker/turn.mjs';

const KEY1 = 'codex-test-key-one';
const KEY2 = 'codex-test-key-two';

// the fixed clocks: Wednesday 2026-09-16 — 12:00Z is OUTSIDE the deepseek
// weekday peak windows (01-04, 06-10 UTC); 02:30Z is INSIDE one; Saturday
// 2026-09-19 02:30Z is inside the HOURS but outside the DAYS
const NOW_OFFPEAK = Date.parse('2026-09-16T12:00:00.000Z');
const NOW_PEAK = Date.parse('2026-09-16T02:30:00.000Z');
const NOW_WEEKEND = Date.parse('2026-09-19T02:30:00.000Z');

const fakeEnv = (over = {}) => ({
  CODEX_FAKE_LLM: '1',
  OPENROUTER_API_KEY: KEY1,
  OPENROUTER_API_KEY_2: KEY2,
  ...over,
});

// the per-test scratch roots (transcripts + the boundary echo + staging)
function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), 'codex-adapter-test-'));
  return {
    base,
    transcriptsDir: join(base, 'sessions'),
    echoDir: join(base, 'echo'),
    stageDir: join(base, 'stage'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// a valid envelope (the shape envelopeFromDispatch mints); deadline and
// budget overridden per test
function envelope(over = {}) {
  return {
    task_ref: { kind: 'state-task', id: 'T1' },
    prompt: 'do the thing',
    deadline_ms: NOW_OFFPEAK + 60_000,
    session: 'c/T1/local-a1',
    budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 3 },
    mode: 'codex',
    attempt: 1,
    ...over,
  };
}

async function turn(env, over = {}, opts = {}) {
  const roots = makeRoots();
  try {
    const result = await codexTurn(envelope(over), {
      env, runId: 'test-run', now: () => NOW_OFFPEAK, log: () => {},
      transcriptsDir: roots.transcriptsDir, echoDir: roots.echoDir, stageDir: roots.stageDir,
      ...opts,
    });
    return { result, roots };
  } catch (e) {
    roots.cleanup();
    throw e;
  }
}

const readEcho = (roots, lane) =>
  JSON.parse(readFileSync(join(roots.echoDir, `lane-${lane}.json`), 'utf8'));

// poll until the pid is GONE (a SIGKILLed pid can linger as a zombie for a
// beat before the reaper collects it)
async function waitPidGone(pid, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }   // ESRCH — gone
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// The model table (worker/codex/models.json — the single source, D5b).
// ---------------------------------------------------------------------------

test('codex models: the table carries BOTH approved models with the VERIFIED live prices (the addendum\'s numbers, not the harness\'s stale 0.10/0.50)', () => {
  assert.deepEqual(CODEX_MODELS, ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
    'the key order IS the model-major lane order (deepseek first — the value pick)');
  const ds = CODEX_MODEL_TABLE['deepseek/deepseek-v4.1-flash'];
  const glm = CODEX_MODEL_TABLE['z-ai/glm-5.3-flash'];
  assert.equal(ds.ctx, 1_000_000, 'deepseek ctx (cx-agent.sh:366-368 verified value)');
  assert.equal(glm.ctx, 1_310_720, 'glm ctx (cx-agent.sh:366-372 verified value)');
  assert.equal(ds.price_in, 0.15);
  assert.equal(ds.price_out, 0.60);
  assert.equal(ds.price_cache_read, 0.003);
  assert.equal(glm.price_in, 0.15);
  assert.equal(glm.price_out, 0.50);
  assert.equal(glm.price_cache_read, 0.05);
  assert.equal(ds.peak.multiplier, 2, 'the deepseek weekday-peak doubling');
  assert.deepEqual(ds.peak.hours_utc, [1, 2, 3, 4, 6, 7, 8, 9,10], 'the 01-04 + 06-10 UTC windows');
  assert.deepEqual(ds.peak.days_utc, [1, 2, 3, 4, 5], 'weekdays only');
  assert.equal(glm.peak, undefined, 'glm never peaks');
  // the harness-shape parity (ctx/retries/idle/prices/fallback per model —
  // B3's config render consumes the retry/idle half)
  for (const m of CODEX_MODELS) {
    const e = codexModelEntry(m);
    assert.ok(Number.isInteger(e.ctx) && e.ctx > 0, `${m}: ctx`);
    assert.ok(Number.isInteger(e.retries_req) && e.retries_req >= 0, `${m}: retries_req`);
    assert.ok(Number.isInteger(e.retries_stream) && e.retries_stream >= 0, `${m}: retries_stream`);
    assert.ok(Number.isInteger(e.idle_ms) && e.idle_ms > 0, `${m}: idle_ms`);
    assert.ok(typeof e.fallback === 'string', `${m}: fallback`);
  }
  assert.throws(() => codexModelEntry('vendor/not-in-table'), /unknown model/,
    'an off-table model fails LOUD (the table is the single source)');
});

// ---------------------------------------------------------------------------
// The lane algebra (pure).
// ---------------------------------------------------------------------------

test('codex lanes: the MODEL-MAJOR flatten — [k1/ds, k2/ds, k1/glm, k2/glm] (D5a)', () => {
  const lanes = codexLanes(fakeEnv());
  assert.deepEqual(lanes.map((l) => [l.keyIndex, l.model]), [
    [1, 'deepseek/deepseek-v4.1-flash'],
    [2, 'deepseek/deepseek-v4.1-flash'],
    [1, 'z-ai/glm-5.3-flash'],
    [2, 'z-ai/glm-5.3-flash'],
  ], 'both keys on the value model within two attempts — the D5a arithmetic');
  assert.ok(lanes.every((l) => l.key === (l.keyIndex === 1 ? KEY1 : KEY2)));
});

test('codex lanes: a missing KEY_2 degrades to the single-key list; an empty pool yields NO lanes', () => {
  const one = codexLanes({ OPENROUTER_API_KEY: KEY1 });
  assert.deepEqual(one.map((l) => [l.keyIndex, l.model]), [
    [1, 'deepseek/deepseek-v4.1-flash'],
    [1, 'z-ai/glm-5.3-flash'],
  ], 'the degraded product [k1/ds, k1/glm]');
  assert.deepEqual(codexLanes({}), [], 'no keys = no lanes = the routable no-lane-keys infra marker');
  assert.deepEqual(codexKeyPool({}), []);
  assert.equal(codexKeyPool({ OPENROUTER_API_KEY_2: 'x' }).length, 1, 'key 2 alone is a valid pool');
  const blank = codexLanes({ OPENROUTER_API_KEY: '  ', OPENROUTER_API_KEY_2: KEY2 });
  assert.ok(blank.every((l) => l.keyIndex === 2), 'a whitespace-only key 1 is absent from the pool');
});

test('codex lanes: the attempts bound clamps to the product size (2 keys × 2 models = 4)', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:error_credits] bound', budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 2 } });
  try {
    assert.equal(result.lane_attempts_used, 2);
    assert.equal(readdirSync(join(roots.echoDir)).length, 2, 'exactly two spawns');
    assert.match(result.detail, /lane-exhausted\(2\/4 lanes, last codex-error_credits\)/);
    // the bound can never exceed the product: 8-attempt budget on the
    // 4-lane product burns 4 (the clamp), never spins a 5th lane
    const full = await turn(fakeEnv(), { prompt: '[fixture:error_credits] clamp', budget: { max_turns: 40, wall_ms: 60_000, lane_attempts: 8 } });
    try {
      assert.equal(full.result.lane_attempts_used, 4);
      assert.match(full.result.detail, /lane-exhausted\(4\/4 lanes/);
    } finally { full.roots.cleanup(); }
  } finally { roots.cleanup(); }
});

// ---------------------------------------------------------------------------
// The advance policy (pure) — the generic JUMP machinery + R3's degeneration.
// ---------------------------------------------------------------------------

test('codex advance: on the model-major list the key-class JUMP is IDENTICAL to plain +1 (R3, written down and pinned as the behavior)', () => {
  const lanes = codexLanes(fakeEnv());
  for (let i = 0; i < lanes.length; i++) {
    assert.equal(codexNextLaneIndex(lanes, i, true), i + 1,
      `lane ${i}: the JUMP lands on the adjacent lane (the other key's same model) — degenerate by construction`);
    assert.equal(codexNextLaneIndex(lanes, i, false), i + 1);
  }
  // the bounds: bad shapes fall back to +1, never throw
  assert.equal(codexNextLaneIndex([], 0, true), 1);
  assert.equal(codexNextLaneIndex(lanes, -1, true), 0);
  assert.equal(codexNextLaneIndex(lanes, 99, true), 100);
});

test('codex advance: the JUMP machinery is GENERIC — on a key-major list it skips the dead key\'s block (the shape it was built for)', () => {
  // a synthetic KEY-MAJOR product (the CC flatten): k1m1, k1m2, k1m3, k2m1, k2m2
  const keyMajor = [
    { keyIndex: 1, model: 'deepseek/deepseek-v4.1-flash' },
    { keyIndex: 1, model: 'z-ai/glm-5.3-flash' },
    { keyIndex: 1, model: 'vendor/third' },
    { keyIndex: 2, model: 'deepseek/deepseek-v4.1-flash' },
    { keyIndex: 2, model: 'z-ai/glm-5.3-flash' },
  ];
  assert.equal(codexNextLaneIndex(keyMajor, 0, true), 3,
    'a key-class failure at k1m1 JUMPS to k2m1 — the dead key\'s m2/m3 are skipped as the no-backoff retries they are');
  assert.equal(codexNextLaneIndex(keyMajor, 1, true), 3, 'mid-block: the jump still lands on the next key\'s first lane');
  assert.equal(codexNextLaneIndex(keyMajor, 3, true), 4,
    'the LAST key\'s key-class failure has no forward key — ordinary advance (+1; no free tail exists on codex, D4)');
  assert.equal(codexNextLaneIndex(keyMajor, 1, false), 2, 'non-key-class: plain +1, the block order untouched');
});

test('codex error-class sets: the key-class trio vs the full rotatable set', () => {
  assert.deepEqual([...CODEX_KEY_CLASS_EVENTS].sort(), ['error_auth', 'error_credits', 'error_quota_daily']);
  assert.deepEqual([...CODEX_ROTATABLE_ERROR_EVENTS].sort(), [
    'error_auth', 'error_credits', 'error_in_flight_budget', 'error_model_400',
    'error_network', 'error_quota_daily', 'error_rate_limit',
  ], 'the R7 five + model_400/in_flight_budget riding the same event-wins rule (the CC 400/404-rotates precedent)');
});

// ---------------------------------------------------------------------------
// The argv (pure) — the proven invocation shape, the brief's exact vector.
// ---------------------------------------------------------------------------

test('codex argv: the exact vector — flags, -C workdir, -m lane model, -c model_context_window, -o scratch path, prompt VERBATIM last', () => {
  const lane = { key: KEY1, keyIndex: 1, model: 'z-ai/glm-5.3-flash' };
  const argv = codexArgv(envelope({ prompt: 'multi-line\nprompt with [fixture:ok] marker' }), lane, { workdir: '/tmp/wd-x', outPath: '/tmp/scratch-x/last-message.txt' });
  assert.deepEqual(argv, [
    'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    '--disable', 'apps',
    '-C', '/tmp/wd-x',
    '-m', 'z-ai/glm-5.3-flash',
    '-c', 'model_context_window=1310720',
    '-o', '/tmp/scratch-x/last-message.txt',
    'multi-line\nprompt with [fixture:ok] marker',
  ], 'the per-model ctx pin rides -c (env_key auth never fetches the catalog — deepseek/glm hit fallback metadata otherwise)');
  assert.equal(argv[argv.length - 1], 'multi-line\nprompt with [fixture:ok] marker',
    'the FSM envelope IS the prompt (R2: instructions ride the prompt, never a side file)');
  const dsArgv = codexArgv(envelope({ prompt: 'p' }), { key: 'k', keyIndex: 1, model: 'deepseek/deepseek-v4.1-flash' }, { workdir: 'w', outPath: 'o' });
  assert.equal(dsArgv[dsArgv.indexOf('-c') + 1], 'model_context_window=1000000',
    'the per-MODEL ctx: deepseek pins 1,000,000 (the glm lane above pins 1,310,720)');
  assert.throws(() => codexArgv(envelope(), { key: 'k', keyIndex: 1, model: 'vendor/off-table' }, {}),
    /unknown model/, 'an off-table lane model fails LOUD before any spawn');
});

test('codex argv at the boundary: the -o file lands OUTSIDE the workdir, the -C is the spawn cwd (R1\'s scratch law)', async () => {
  const { roots } = await turn(fakeEnv(), { prompt: 'placement probe' });
  try {
    const echo = readEcho(roots, 0);
    const a = echo.argv;
    assert.equal(a[a.indexOf('-C') + 1], echo.cwd, '-C is the spawn cwd (the write-back claim surface)');
    const o = a[a.indexOf('-o') + 1];
    assert.ok(o.endsWith('last-message.txt'));
    assert.ok(!o.startsWith(echo.cwd + '/'), `the -o file is OUTSIDE the workdir (got ${o})`);
    assert.equal(echo.stdin, 'chardev-ignored', 'stdin IGNORED — a piped stdin would hang codex on "additional input" (gotcha §10.1)');
  } finally { roots.cleanup(); }
});

// ---------------------------------------------------------------------------
// The env contract (pure + boundary) — D14.
// ---------------------------------------------------------------------------

test('codex env: the 8-member strip set + the {CODEX_HOME, lane key} overlay (pure)', () => {
  assert.deepEqual([...CODEX_ENV_DENYLIST].sort(), [
    'ANTHROPIC_AUTH_TOKEN', 'BRIDGE_LANE_LOG', 'GH_TOKEN', 'GITHUB_TOKEN',
    'GL_PAT', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'OPENROUTER_KEY_POOL',
  ], 'R6: the FULL CC set including ANTHROPIC_AUTH_TOKEN (free defense-in-depth)');
  const env = {
    PATH: '/usr/bin:/bin', OPENROUTER_API_KEY: 'caller-key-1', OPENROUTER_API_KEY_2: 'caller-key-2',
    OPENROUTER_KEY_POOL: 'pool-leak', GH_TOKEN: 'gh-leak', GITHUB_TOKEN: 'github-leak',
    GL_PAT: 'gl-leak', ANTHROPIC_AUTH_TOKEN: 'stale-auth-leak', BRIDGE_LANE_LOG: '/tmp/bridge-lane.jsonl',
    HOME: '/home/runner',
  };
  const merged = codexChildEnv(env, { key: 'lane-key', keyIndex: 2, model: 'z-ai/glm-5.3-flash' },
    envelope(), { CODEX_HOME: '/home/runner/.codex-fsm' });
  for (const k of CODEX_ENV_DENYLIST) {
    if (k === 'OPENROUTER_API_KEY') continue;   // the ONE the overlay re-injects
    assert.ok(!(k in merged), `${k} never inherits`);
  }
  assert.equal(merged.OPENROUTER_API_KEY, 'lane-key', 'the ONLY auth the child holds is the LANE key (the D14 inversion)');
  assert.equal(merged.CODEX_HOME, '/home/runner/.codex-fsm');
  assert.equal(merged.OX_AGENT_TASK_ID, 'T1');
  assert.equal(merged.OX_AGENT_DEADLINE_UTC, new Date(NOW_OFFPEAK + 60_000).toISOString());
  assert.equal(merged.PATH, '/usr/bin:/bin', 'the benign caller env inherits');
  assert.equal(merged.HOME, '/home/runner');
});

test('codex env: the caller\'s CODEX_HOME wins over the scratch home; absent caller → the adapter\'s scratch home (outside the workdir)', async () => {
  const provided = mkdtempSync(join(tmpdir(), 'codex-home-caller-'));
  try {
    const caller = await turn(fakeEnv({ CODEX_HOME: provided }), { prompt: 'home probe' });
    try {
      const echo = readEcho(caller.roots, 0);
      assert.equal(echo.env.CODEX_HOME, provided, 'B3\'s worker.yml CODEX_HOME ($HOME/.codex-fsm) is the real-mode source');
    } finally { caller.roots.cleanup(); }
    const scratch = await turn(fakeEnv(), { prompt: 'home probe 2' });
    try {
      const echo = readEcho(scratch.roots, 0);
      assert.ok(typeof echo.env.CODEX_HOME === 'string' && echo.env.CODEX_HOME !== '');
      assert.ok(!echo.env.CODEX_HOME.startsWith(echo.cwd + '/'), 'the fallback scratch home is OUTSIDE the workdir (R1)');
      assert.ok(echo.env.CODEX_HOME.includes('codex-home'), 'the fallback home lives under the turn-scoped scratch dir');
    } finally { scratch.roots.cleanup(); }
  } finally { rmSync(provided, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// B3 — the worker.yml codex INSTALL GATE + the config template it renders.
// The W2-pin discipline from test-cc-adapter.mjs (the install lane and the
// spawn lane must agree; drift = the m-9 npx-download-inside-the-wall class),
// mirrored for the second engine — plus the gate's fail-direction pin (the
// ONE deliberate inversion vs the CC step: codex-ONLY, never the absent-ox
// fail-safe) and the committed template's load-bearing keys.
// ---------------------------------------------------------------------------

test('codex B3: worker.yml\'s install gate — the codex-ONLY mode gate (the OX_RAW mechanism), the npm pin + version assert (no || true), CODEX_HOME + the config render', () => {
  const yml = readFileSync(new URL('../.github/workflows/worker.yml', import.meta.url), 'utf8');
  const step = /- name: Install the Codex CLI \([^)]*\)([\s\S]*?)(?=\n      - name:)/.exec(yml);
  assert.ok(step, 'the codex-install step exists in worker.yml');
  const body = step[1];
  // THE GATE: the EXACT mechanism the CC install step uses (the ox envelope
  // rides ENV and is parsed by the node stdin one-liner — never
  // ${{ }}-interpolated into the shell, injection-safe).
  assert.ok(body.includes('OX_RAW: ${{ github.event.client_payload.ox || \'\' }}'),
    'the gate reads ox.mode through the OX_RAW env + node stdin parse (the CC step\'s exact mechanism)');
  assert.ok(body.includes('if [ "$MODE" = "codex" ]; then'), 'the gate fires on MODE=codex');
  assert.ok(!/\[ "\$MODE" = "codex" \] \|\| \[ -z "\$MODE" \]/.test(body),
    'the CC step\'s absent-ox fail-safe is NOT copied — absent ox = legacy = the mock/cc era, and a codex dispatch ALWAYS carries ox.mode (B1 vocabulary; envelopeFromDispatch defaults absent → mock): mock/real/cc/legacy NEVER install codex');
  assert.ok(body.includes('CODEX-INSTALL-SKIPPED mode=$MODE'), 'non-codex dispatches log the skip');
  // THE PIN + THE ASSERT (the W2 tie, mirrored): install default = the
  // verified literal, never latest; a mismatch fails the step LOUDLY.
  const m = /CODEX_PIN="\$\{CODEX_VERSION:-(.+?)\}"/.exec(body);
  assert.ok(m, 'the install step defines CODEX_PIN with a ${CODEX_VERSION:-<literal>} default');
  assert.equal(m[1], '0.156.0', 'the pins.env verified pin (the harness config\'s wire_api="responses" is mandatory on 0.156)');
  assert.ok(body.includes('npm install -g "@openai/codex@${CODEX_PIN}"'), 'the install consumes the pin');
  assert.ok(!/\$\{CODEX_VERSION:-latest\}/.test(body), 'the stale latest default is dead');
  assert.match(body, /case "\$INSTALLED" in\s*\n\s*\*"\$CODEX_PIN"\*\) ;;\s*\n\s*\*\)[^\n]*exit 1;;/,
    'the version assert: a mismatch FAILS the step (no || true — the m-2/C law; the lease re-covers)');
  // CODEX_HOME + the config render (D7a)
  assert.ok(body.includes('CODEX_HOME_DIR="$HOME/.codex-fsm"'),
    'CODEX_HOME is $HOME/.codex-fsm — never /tmp (gotcha §10.2), never in the workdir (R1)');
  assert.ok(body.includes('mkdir -p "$CODEX_HOME_DIR"'), 'the home is pre-created (gotcha #2: CODEX_HOME must exist)');
  assert.ok(body.includes('cp worker/codex/config.toml "${CODEX_HOME_DIR}/config.toml"'),
    'the engine\'s committed template renders INTO the home');
  assert.ok(body.includes('echo "CODEX_HOME=${CODEX_HOME_DIR}" >> "$GITHUB_ENV"'),
    'the home is exported via GITHUB_ENV — the Work-the-task node process reads process.env.CODEX_HOME (the adapter\'s env.CODEX_HOME resolution)');
  assert.ok(!body.includes('AGENTS.md'), 'NO AGENTS.md seeding anywhere in the install (the R2 fold — the envelope IS the prompt)');
  assert.match(body, /install \$\(\(T1-T0\)\)s/, 'the install seconds are echoed (the ~9-16s npm expectation — minutes = the m-9 class)');
  // the Work-the-task env block documents the GITHUB_ENV carriage (the env
  // block does NOT re-map CODEX_HOME — GitHub's env mapping cannot expand
  // $HOME; the export above is the single source)
  assert.ok(yml.includes('codex-install step above exports it via GITHUB_ENV'),
    'the Work-the-task env block documents where the adapter\'s CODEX_HOME comes from');
});

test('codex B3: worker/codex/config.toml — the committed template the install step renders (the load-bearing keys cannot silently rot)', () => {
  const toml = readFileSync(new URL('../worker/codex/config.toml', import.meta.url), 'utf8');
  // the provider block — wire_api is the 0.156.0 kill switch
  assert.match(toml, /^model_provider = "openrouter"$/m);
  assert.match(toml, /^base_url = "https:\/\/openrouter\.ai\/api\/v1"$/m);
  assert.match(toml, /^wire_api = "responses"$/m,
    'MANDATORY on 0.156.0 — "chat" was removed ~0.84 and errors (codex-cli.md §8.1): a chat here is a 100%-dead lane');
  assert.match(toml, /^env_key = "OPENROUTER_API_KEY"$/m,
    'the D14 inversion\'s other half — the lane key the overlay re-injects is the env_key auth');
  assert.match(toml, /^request_max_retries = 4$/m);
  assert.match(toml, /^stream_max_retries = 5$/m);
  assert.match(toml, /^stream_idle_timeout_ms = 300000$/m, 'D15\'s config-side bound (the wall + this idle are the v1 turn bounds)');
  // the model keys — exactly ONE model (the argv-less fallback; argv carries
  // the lane per D5b), the glm ctx (the argv -c overrides per lane)
  const models = [...toml.matchAll(/^model = "(.+)"$/mg)];
  assert.equal(models.length, 1, 'exactly ONE model key — config.toml pins a single model (D5b)');
  assert.ok(CODEX_MODELS.includes(models[0][1]), `the pinned fallback (${models[0][1]}) is a models.json lane model`);
  assert.match(toml, /^model_context_window = 1310720$/m, 'glm\'s ctx — the argv -c model_context_window overrides per lane');
  // the hygiene + noise blocks
  assert.match(toml, /^ignore_default_excludes = false$/m,
    'the model-spawned-shell hygiene that pairs with the adapter\'s D14 denylist');
  assert.match(toml, /^exclude = \["\*PAT\*", "\*PASS\*", "\*CRED\*", "\*GH_\*"\]$/m);
  assert.match(toml, /^\[history\]$/m);
  assert.match(toml, /^persistence = "none"$/m);
  assert.match(toml, /^\[otel\]$/m);
  assert.equal((toml.match(/^exporter = "none"$/mg) || []).length + (toml.match(/^(trace_exporter|metrics_exporter) = "none"$/mg) || []).length, 3,
    'every otel exporter off');
  // the bracket-balance sanity (the [m/[h display-eating artifact class made
  // this explicit): every section header line is a well-formed [table]
  for (const h of toml.split('\n').filter((l) => l.startsWith('['))) {
    assert.match(h, /^\[[a-z_.]+\]$/, `well-formed section header: ${h}`);
  }
});

test('codex env at the boundary: the denylist is DEAD at the spawn (M-1); the lane key is the only re-injection', async () => {
  const env = fakeEnv({
    GH_TOKEN: 'gh-leak', GITHUB_TOKEN: 'github-leak', GL_PAT: 'gl-leak',
    ANTHROPIC_AUTH_TOKEN: 'stale-auth-leak', OPENROUTER_KEY_POOL: 'pool-leak',
    BRIDGE_LANE_LOG: '/tmp/bridge-lane.jsonl',
  });
  const { roots } = await turn(env, { prompt: 'strip probe' });
  try {
    const echo = readEcho(roots, 0);
    const keys = new Set(echo.env_keys);
    const leaked = CODEX_ENV_DENYLIST.filter((k) => k !== 'OPENROUTER_API_KEY' && keys.has(k));
    // MUTATION SPOT (invert-me): drop any member from CODEX_ENV_DENYLIST and
    // this pin fails — the /proc/<pid>/environ leak class returns (the
    // 73-key pool + the job token back in the codex child env).
    assert.deepEqual(leaked, [], 'the 7 non-overlay members are absent from the merged child env');
    assert.equal(echo.env.OPENROUTER_API_KEY, KEY1, 'the lane key (the deliberate re-injection)');
    assert.ok(!keys.has('OPENROUTER_API_KEY_2'), 'the OTHER lane key never rides a codex child');
  } finally { roots.cleanup(); }
});

// ---------------------------------------------------------------------------
// The JSONL event decode (pure) — every stream shape.
// ---------------------------------------------------------------------------

const jl = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n');

test('codex decode: the happy stream — thread id, LAST agent_message wins, usage captured', () => {
  const ev = decodeCodexEvents(jl(
    { type: 'thread.started', thread_id: '01a0cc1b-8f36-7c82-a9c9-c9f4d9541dd4' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'first answer' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'the FINAL answer' } },
    { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 315, output_tokens: 122, reasoning_output_tokens: 30 } },
  ) + '\n');
  assert.equal(ev.threadId, '01a0cc1b-8f36-7c82-a9c9-c9f4d9541dd4');
  assert.equal(ev.turns, 1);
  assert.equal(ev.message, 'the FINAL answer', 'the LAST agent_message is the content');
  assert.equal(ev.reasoning, null);
  assert.equal(ev.errorMessage, null, 'the benign Model-metadata warning is filtered (the cx-runner\'s skip)');
  assert.equal(ev.sawUsage, true);
  assert.deepEqual(ev.usage, { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 315, output_tokens: 122, reasoning_output_tokens: 30 });
});

test('codex decode: usage SUMS across turn.completed; reasoning items extract; torn tails tolerate', () => {
  const ev = decodeCodexEvents(jl(
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'turn one done' } },
    { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 315, output_tokens: 122, reasoning_output_tokens: 30 } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'thinking about turn two' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'turn two done' } },
    { type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 60, reasoning_output_tokens: 10 } },
  ) + '\n{"type":"turn.compl');   // a torn tail (hard kill mid-write)
  assert.equal(ev.turns, 2);
  assert.equal(ev.message, 'turn two done');
  assert.equal(ev.reasoning, 'thinking about turn two');
  assert.deepEqual(ev.usage, { input_tokens: 25263, cached_input_tokens: 24848, cache_write_input_tokens: 315, output_tokens: 182, reasoning_output_tokens: 40 });
});

test('codex decode: the error surfaces — Reconnecting filtered, real errors kept, turn.failed\'s message wins', () => {
  const reconnect = decodeCodexEvents(jl(
    { type: 'error', message: 'Reconnecting… waiting for network' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'recovered after retry' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ));
  assert.equal(reconnect.errorMessage, null, 'transient Reconnecting notices are stream retries, never a failure class');
  const dead = decodeCodexEvents(jl(
    { type: 'thread.started', thread_id: 't-2' },
    { type: 'error', message: '429 rate limit exceeded: free-models-per-day-high-balance' },
    { type: 'turn.failed', error: { message: '429 rate limit exceeded: free-models-per-day-high-balance' } },
  ));
  assert.equal(dead.sawTurnFailed, true);
  assert.equal(dead.errorMessage, '429 rate limit exceeded: free-models-per-day-high-balance');
  const empty = decodeCodexEvents('');
  assert.equal(empty.message, null);
  assert.equal(empty.sawUsage, false);
  assert.equal(empty.turns, 0);
  const garbage = decodeCodexEvents('not json\n{"type":"bogus"}\n');
  assert.equal(garbage.threadId, null, 'unknown event types are skipped, never thrown');
});

// ---------------------------------------------------------------------------
// The error classification (pure) — the cx-runner table, ported.
// ---------------------------------------------------------------------------

test('codex error class: the cx-runner table (every class + the benign fallback)', () => {
  const cases = [
    ['Payment required: 402 insufficient credits', 'error_credits'],
    ['402 with in_flight budget', 'error_in_flight_budget'],
    ['401 Unauthorized: invalid api key', 'error_auth'],
    ['no auth provider configured', 'error_auth'],
    ['429 rate limit exceeded: free-models-per-day-high-balance', 'error_quota_daily'],
    ['429 Too Many Requests: rate limit on this key', 'error_rate_limit'],
    ['rate_limit daily quota exhausted', 'error_quota_daily'],
    ['invalid_prompt: Invalid Responses API request', 'error_model_400'],
    ['tool name must be at most 64 characters, got 66', 'error_model_400'],
    ['503 service unavailable upstream', 'error_network'],
    ['stream timed out waiting for the model', 'error_network'],
    ['connection reset by peer', 'error_network'],
    ['the model declined the task: policy refusal', null],
    ['', null],
    [null, null],
  ];
  for (const [msg, cls] of cases) {
    assert.equal(codexErrorClass(msg), cls, `codexErrorClass(${JSON.stringify(msg)})`);
  }
});

// ---------------------------------------------------------------------------
// R7 precedence (pure) — codexLaneOutcome's every row.
// ---------------------------------------------------------------------------

test('codex R7 precedence: events win over the exit code; exit 2 ALWAYS terminalizes codex-usage (D13)', () => {
  // MUTATION SPOT (invert-me): move codexLaneOutcome's `rc === 2` check
  // BELOW the errorClass branch and the (2, 'error_auth') row fails — D13
  // would rotate on a usage error, burning lane_attempts on a persistent
  // argv bug. The exit-2 carve-out must stay FIRST.
  assert.deepEqual(codexLaneOutcome(2, 'error_auth'), { action: 'terminal', status: 'infra_failed', detailPrefix: 'codex-usage', rotate: false });
  assert.deepEqual(codexLaneOutcome(2, null), { action: 'terminal', status: 'infra_failed', detailPrefix: 'codex-usage', rotate: false });
  // a classifiable error event WINS over exit 1 (R7's headline: a dead key
  // surfaces as exit 1 + an error event — '1 = work-failed' would quarantine
  // good tasks on a dead key)
  assert.deepEqual(codexLaneOutcome(1, 'error_credits'), { action: 'rotate', keyClass: true, detail: 'codex-error_credits' });
  assert.deepEqual(codexLaneOutcome(1, 'error_rate_limit'), { action: 'rotate', keyClass: false, detail: 'codex-error_rate_limit' });
  assert.deepEqual(codexLaneOutcome(1, 'error_model_400'), { action: 'rotate', keyClass: false, detail: 'codex-error_model_400' });
  // ... and over exit 0 (a torn stream carrying a classifiable error is a
  // lane failure, never a silent success)
  assert.deepEqual(codexLaneOutcome(0, 'error_network'), { action: 'rotate', keyClass: false, detail: 'codex-error_network' });
  // nothing classifiable ⇒ the EXIT CODE decides: 1 = the work-failed shape
  assert.deepEqual(codexLaneOutcome(1, null), { action: 'terminal', status: 'work_failed', detailPrefix: 'codex-exit-1' });
  // rc 0 + nothing classifiable ⇒ the extraction lane
  assert.deepEqual(codexLaneOutcome(0, null), { action: 'extract' });
});

// ---------------------------------------------------------------------------
// The lane_stats arithmetic (pure) — off-peak, weekday-peak, cached reads.
// ---------------------------------------------------------------------------

test('codex cost: the off-peak arithmetic — cached reads at the CACHE-READ price, never prompt price', () => {
  const ds = codexModelEntry('deepseek/deepseek-v4.1-flash');
  const usage = { input_tokens: 25263, cached_input_tokens: 24848, cache_write_input_tokens: 315, output_tokens: 182 };
  // MUTATION SPOT (invert-me): charge ALL input at price_in (drop the cached
  // split in codexUsageCost) and this pin fails — 25263×0.15 + 182×0.60 =
  // 0.003918 ≠ 0.000246: the cached-read lane is the whole value of the
  // deepseek posture (70%+ cached on the benchmark's real turns).
  assert.equal(codexUsageCost(usage, ds, NOW_OFFPEAK), 0.000246,
    '(415×0.15 + 24848×0.003 + 182×0.60)/1e6 = 0.000245994 → 6dp');
  assert.equal(isCodexPeakWindow(NOW_OFFPEAK, ds), false, 'Wednesday 12:00Z is off-peak');
});

test('codex cost: the WEEKDAY-PEAK doubling — in/out ×2, cache-read NOT doubled; weekends never peak', () => {
  const ds = codexModelEntry('deepseek/deepseek-v4.1-flash');
  assert.equal(isCodexPeakWindow(NOW_PEAK, ds), true, 'Wednesday 02:30Z is inside the 01-04 window');
  assert.equal(isCodexPeakWindow(NOW_WEEKEND, ds), false, 'Saturday 02:30Z is inside the HOURS but outside the DAYS');
  const usage = { input_tokens: 25263, cached_input_tokens: 24848, output_tokens: 182 };
  assert.equal(codexUsageCost(usage, ds, NOW_PEAK), 0.000417,
    '(415×0.30 + 24848×0.003 + 182×1.20)/1e6 = 0.000417444 → 6dp (cache-read stays 0.003)');
  assert.equal(codexUsageCost(usage, ds, NOW_WEEKEND), 0.000246, 'the weekend keeps the off-peak rates');
  const glm = codexModelEntry('z-ai/glm-5.3-flash');
  assert.equal(isCodexPeakWindow(NOW_PEAK, glm), false, 'glm never peaks');
  assert.equal(codexUsageCost({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200 }, glm, NOW_PEAK), 0.00017,
    '(200×0.15 + 800×0.05 + 200×0.50)/1e6');
});

test('codex cost: guards — cached clamped to input, absent fields are 0, rounding to 6dp', () => {
  const ds = codexModelEntry('deepseek/deepseek-v4.1-flash');
  assert.equal(codexUsageCost({ input_tokens: 100, cached_input_tokens: 500, output_tokens: 0 }, ds, NOW_OFFPEAK), 0,
    'cached > input clamps to input: (0×0.15 + 100×0.003 + 0)/1e6 = 0.0000003 → 6dp rounds to 0');
  assert.equal(codexUsageCost({}, ds, NOW_OFFPEAK), 0);
  assert.equal(codexUsageCost({ input_tokens: 'x', output_tokens: 'y' }, ds, NOW_OFFPEAK), 0, 'non-numeric counters are 0, never NaN');
  assert.equal(codexUsageCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, ds, NOW_OFFPEAK), 0.75, 'the 1M-token sanity row');
});

test('codex stat lines: the usage line (status 200, recomputed cost) + the error line class→status mapping', () => {
  const usage = { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 };
  const line = codexUsageLaneLine({ ts: NOW_OFFPEAK, ms: 42, model: 'deepseek/deepseek-v4.1-flash', usage, atMs: NOW_OFFPEAK });
  assert.deepEqual(line, {
    ts: NOW_OFFPEAK, model: 'deepseek/deepseek-v4.1-flash', status: 200, ms: 42,
    tokens_in: 1200, tokens_out: 80, cost: 0.000228, rate_class: null, err_code: null,
  }, '(1200×0.15 + 80×0.60)/1e6 — the laneLogLine 9-key shape, the SHARED aggregate\'s input');
  assert.deepEqual(codexErrorLaneLine({ ts: NOW_OFFPEAK, ms: 7, model: 'z-ai/glm-5.3-flash', errorClass: 'error_credits' }),
    { ts: NOW_OFFPEAK, model: 'z-ai/glm-5.3-flash', status: 402, ms: 7, tokens_in: 0, tokens_out: 0, cost: 0, rate_class: null, err_code: 'error_credits' });
  assert.equal(codexErrorLaneLine({ ts: 0, ms: 0, model: 'z-ai/glm-5.3-flash', errorClass: 'error_auth' }).status, 401);
  assert.equal(codexErrorLaneLine({ ts: 0, ms: 0, model: 'z-ai/glm-5.3-flash', errorClass: 'error_quota_daily' }).status, 429);
  assert.equal(codexErrorLaneLine({ ts: 0, ms: 0, model: 'z-ai/glm-5.3-flash', errorClass: 'error_rate_limit' }).status, 429);
  assert.equal(codexErrorLaneLine({ ts: 0, ms: 0, model: 'z-ai/glm-5.3-flash', errorClass: 'error_model_400' }).status, 400);
  assert.equal(codexErrorLaneLine({ ts: 0, ms: 0, model: 'z-ai/glm-5.3-flash', errorClass: 'error_network' }).status, null,
    'network stays transport-shaped (status null): honestly in NO bucket — the aggregate\'s documented semantics');
});

// ---------------------------------------------------------------------------
// Through-turn: every fixture's outcome + the lane_stats exact aggregate.
// ---------------------------------------------------------------------------

test('codex turn: [fixture:ok] — done on lane 1, the raw-extraction shape, lane_stats attached', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:ok] go' });
  try {
    assert.equal(classifyOutcome(result).status, 'done');
    assert.equal(result.lane_attempts_used, 1);
    assert.equal(result.models.length, 1);
    assert.ok(result.content.includes('fake-codex ok'));
    assert.deepEqual(result.lane_stats, {
      calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 1280, cost: 0.000228,
      p50_ms: 0, p95_ms: 0, rate_classes: {},
      models: { 'deepseek/deepseek-v4.1-flash': { calls: 1, ok: 1, err429: 0, err5xx: 0, tokens: 1280, cost: 0.000228, p50_ms: 0, p95_ms: 0 } },
    }, 'the EXACT lane-telemetry aggregate: usage × the price table (off-peak), p50/p95 fixed-clock deterministic');
    assert.equal(result.key_index, 0);
    assert.equal(result.pool_size, 2);
  } finally { roots.cleanup(); }
});

test('codex turn: [fixture:usage-rich] — usage sums across turns; turns ride telemetry', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:usage-rich] go' });
  try {
    assert.equal(classifyOutcome(result).status, 'done');
    assert.equal(result.telemetry.turns, 2);
    assert.equal(result.lane_stats.tokens, 25445, '25263 in + 182 out');
    assert.equal(result.lane_stats.cost, 0.000246, 'the cached split arithmetic (24848 of 25263 input reads at 0.003)');
    assert.ok(result.content.includes('usage-rich'));
  } finally { roots.cleanup(); }
});

test('codex turn: [fixture:exit-2] — D13\'s TERMINAL codex-usage marker, ONE lane, no rotation, no lane_stats', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:exit-2] go' });
  try {
    assert.equal(result.status, 'infra_failed');
    assert.match(result.detail, /codex-usage\(error: unexpected argument '--bogus-flag' found\)/);
    assert.equal(result.lane_attempts_used, 1, 'terminal at the TURN level — the lane is not the problem, the invocation is');
    assert.equal(result.telemetry.lanes.length, 1);
    assert.equal(result.lane_stats, undefined, 'clap fails before any model call — no accounting line');
  } finally { roots.cleanup(); }
});

test('codex turn: [fixture:error_credits-if:<key1>] — the key-class rotation RECOVERS on key 2 inside the budget', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: `[fixture:error_credits-if:${KEY1}] go` });
  try {
    assert.equal(classifyOutcome(result).status, 'done');
    assert.equal(result.lane_attempts_used, 2);
    assert.deepEqual(result.telemetry.lanes.map((l) => [l.key_index, l.model, l.class]), [
      [1, 'deepseek/deepseek-v4.1-flash', 'infra'],
      [2, 'deepseek/deepseek-v4.1-flash', 'done'],
    ], 'the model-major adjacency: the recovery lands on the OTHER key\'s SAME model');
    assert.equal(result.key_index, 1, 'the answering lane\'s key (0-based)');
    assert.equal(result.lane_stats.calls, 2, 'the error line + the usage line both ride the aggregate');
    assert.equal(result.lane_stats.ok, 1);
    // the 402 error line counts in `calls` but lands in NO status bucket —
    // the aggregate's documented honesty (402 is neither 429 nor 5xx); its
    // presence is pinned by calls=2 vs ok=1 on the SAME model row
    assert.equal(result.lane_stats.models['deepseek/deepseek-v4.1-flash'].calls, 2);
    assert.equal(result.lane_stats.models['deepseek/deepseek-v4.1-flash'].ok, 1);
  } finally { roots.cleanup(); }
});

test('codex turn: [fixture:turn-failed] — work_failed terminal (R7\'s exit-code half); [fixture:hang] — the wall deadline', async () => {
  const failed = await turn(fakeEnv(), { prompt: '[fixture:turn-failed] go' });
  try {
    assert.equal(failed.result.status, 'work_failed');
    assert.match(failed.result.detail, /codex-exit-1\(the model declined the task/);
    assert.equal(failed.result.lane_attempts_used, 1);
  } finally { failed.roots.cleanup(); }
  const hung = await turn(fakeEnv(), {
    prompt: '[fixture:hang] go',
    deadline_ms: NOW_OFFPEAK + 400,
    budget: { max_turns: 40, wall_ms: 480_000, lane_attempts: 3 },
  });
  try {
    assert.equal(hung.result.status, 'deadline');
    assert.equal(hung.result.detail, 'wall-budget-exceeded');
    assert.equal(hung.result.telemetry.lanes[0].wall_killed, true);
    const echo = readEcho(hung.roots, 0);
    assert.ok(await waitPidGone(echo.pid), 'the leader is reaped');
    assert.ok(await waitPidGone(echo.grandchildPid), 'the same-group grandchild is reaped (the GROUP kill)');
  } finally { hung.roots.cleanup(); }
});

// ---------------------------------------------------------------------------
// The workdir hygiene (R1) — the law + the counter-pin + the allowRoot seam.
// ---------------------------------------------------------------------------

test('codex hygiene: R1\'s LAW — a workdir containing ONLY the task\'s declared artifacts reports EXACTLY those artifacts done', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:ok-artifacts] go' });
  try {
    assert.equal(classifyOutcome(result).status, 'done');
    assert.deepEqual(result.artifact_refs, ['tasks/T1/artifacts/out-codex.md'],
      'the claim surface is EXACTLY the task\'s artifact (the -o file, CODEX_HOME and the lane-stats scratch all live OUTSIDE)');
    assert.ok(existsSync(join(roots.stageDir, 'tasks/T1/artifacts/out-codex.md')), 'the door-allowed set staged (the W-C seam, fake-mode local stage)');
  } finally { roots.cleanup(); }
});

test('codex hygiene: R1\'s COUNTER-PIN — a stray AGENTS.md in the workdir fires the writeBackDoor violation (the existing machinery)', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:agents-md-stray] go' });
  try {
    // MUTATION SPOT (invert-me): add an AGENTS.md exclusion to the codex
    // workdir scan (the R1 "defense-in-depth" alternative the design
    // REJECTED) and this pin fails — a stray guidance file would slip past
    // the door as a silent write-back claim. The pinned choice is the EMPTY
    // exclude-set + the door.
    assert.equal(result.status, 'poison');
    assert.match(result.detail, /write-back-door\(root-not-declared\(AGENTS\.md\)/);
    assert.deepEqual(result.artifact_refs, ['AGENTS.md', 'tasks/T1/artifacts/real.md']);
  } finally { roots.cleanup(); }
});

test('codex hygiene: the allowRoot seam — a DECLARED artifact stays done (the §4c pass-through)', async () => {
  // the routing arm passes envelope.artifacts → opts.allowRoot (B1's seam);
  // an in-namespace artifact needs no declaration, and an explicit
  // allowRoot entry is harmless (the door's declared set just grows)
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:ok-artifacts] go' }, {
    allowRoot: ['tasks/T1/artifacts/out-codex.md'],
  });
  try {
    assert.equal(classifyOutcome(result).status, 'done');
    assert.deepEqual(result.artifact_refs, ['tasks/T1/artifacts/out-codex.md']);
  } finally { roots.cleanup(); }
});

// ---------------------------------------------------------------------------
// Transcripts + the escalation shape.
// ---------------------------------------------------------------------------

test('codex transcript: fake mode writes locally with harness \'codex\' + mode \'codex\' provenance (F15)', async () => {
  const { result, roots } = await turn(fakeEnv(), { prompt: '[fixture:ok] transcript' });
  try {
    const meta = JSON.parse(readFileSync(join(roots.transcriptsDir, 'sessions/T1/test-run-a1.meta.json'), 'utf8'));
    const txt = readFileSync(join(roots.transcriptsDir, 'sessions/T1/test-run-a1.txt'), 'utf8');
    assert.equal(meta.harness, 'codex', 'engine-derived, never the CC hardcode (cc-adapter.mjs:542 class)');
    assert.equal(meta.mode, 'codex');
    assert.equal(meta.fake, true);
    assert.equal(meta.task, 'T1');
    assert.equal(meta.run_id, 'test-run');
    assert.equal(meta.transcript, 'sessions/T1/test-run-a1.txt');
    assert.ok(txt.includes('fsm-lab CODEX transcript (mode: codex'));
    assert.ok(txt.includes('--- PROMPT ---'));
    assert.ok(result.transcript.mode === 'local');
    assert.equal(result.transcript.txt, 'sessions/T1/test-run-a1.txt');
  } finally { roots.cleanup(); }
});

// ---------------------------------------------------------------------------
// s25/b1 — THE REAL-MODE TRANSCRIPT LANE (the contents API, the X29 F3/F2
// rebuild). The scripted-fetch mock answers the contents contract (GET
// 404/200 {sha} → PUT 201/200); the CODEX_BIN shim swaps the codex binary
// for fake-codex.mjs WITH THE REAL ARGV so the turn runs the REAL lane's
// code paths (no CODEX_FAKE_LLM) — the adapter's transcript push, retry
// wrapper and escalation are the code under test, not the CLI.
// ---------------------------------------------------------------------------

const FAKE_CODEX_BIN = fileURLToPath(new URL('../worker/fake-codex.mjs', import.meta.url));

// the shim: real mode resolves cmd from env.CODEX_BIN — a shell wrapper
// around fake-codex.mjs keeps the argv EXACTLY as the real codex CLI sees it
function makeCodexBinShim(base) {
  const shim = join(base, 'codex-bin-shim.sh');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX_BIN}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function mockContentsApi(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const r = respond(call, calls.length);
    return { status: r.status, text: async () => (r.data === undefined ? '' : JSON.stringify(r.data)) };
  };
  return { fetchImpl, calls };
}

// THE F2 PIN (the X29 mirror shape verbatim): the process env carries BOTH
// the runner's GITHUB_REPOSITORY (agentrunners/fsm-lab-workers — what the
// broken step-env override left in the process) AND the custom
// FSM_SESSIONS_REPO (claudecode-headless/fsm-lab — what TARGET_REPO meant)
// → the transcript lane MUST follow the custom name.
const REAL_MODE_ENV = {
  OPENROUTER_API_KEY: KEY1,
  OPENROUTER_API_KEY_2: KEY2,
  FSM_SESSIONS_REPO: 'claudecode-headless/fsm-lab',
  FSM_SESSIONS_TOKEN: 'sess-token-1',
  GITHUB_REPOSITORY: 'agentrunners/fsm-lab-workers',
  GH_TOKEN: 'runner-job-token',
};

test('s25/b1 pushSessionsContents (the adapter seam): the custom-name seam wins, the pinned log line carries the landed repo, the engine PUTs the pair', async () => {
  const logs = [];
  const { fetchImpl, calls } = mockContentsApi((c) => (c.method === 'GET' ? { status: 404, data: null } : { status: 201, data: {} }));
  const r = await pushSessionsContents({
    env: { ...REAL_MODE_ENV },
    files: new Map([['sessions/T-77/run77-a1.txt', 'body'], ['sessions/T-77/run77-a1.meta.json', '{}']]),
    log: (l) => logs.push(l),
    fetchImpl,
  });
  assert.equal(r.mode, 'pushed');
  assert.equal(r.repo, 'claudecode-headless/fsm-lab');
  assert.deepEqual(r.files, ['sessions/T-77/run77-a1.txt', 'sessions/T-77/run77-a1.meta.json']);
  assert.ok(logs.some((l) => l === 'CODEX-TRANSCRIPT-PUSHED 2 file(s) to fsm-sessions @ claudecode-headless/fsm-lab'), 'the pinned line SHAPE + the landed repo APPENDED (the X29 lesson)');
  for (const c of calls) {
    assert.ok(c.url.includes('/repos/claudecode-headless/fsm-lab/contents/sessions/T-77/'), 'every call targets the CUSTOM repo');
    assert.ok(!c.url.includes('agentrunners'), 'NEVER the runner repo the old env.GITHUB_REPOSITORY read would have picked (F2)');
    assert.equal(c.headers.Authorization, 'Bearer sess-token-1', 'the custom token lane, not GH_TOKEN');
  }
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
  // the legacy pair still backs compat when the custom names are absent
  const legacy = mockContentsApi((c) => (c.method === 'GET' ? { status: 404, data: null } : { status: 201, data: {} }));
  const r2 = await pushSessionsContents({
    env: { GITHUB_REPOSITORY: 'claudecode-headless/fsm-lab', GH_TOKEN: 'legacy-tok' },
    files: new Map([['sessions/T-78/r.txt', 'b']]),
    log: () => {},
    fetchImpl: legacy.fetchImpl,
  });
  assert.equal(r2.repo, 'claudecode-headless/fsm-lab');
  assert.ok(legacy.calls[0].url.includes('/repos/claudecode-headless/fsm-lab/contents/'));
  assert.equal(legacy.calls[0].headers.Authorization, 'Bearer legacy-tok');
  // and the missing-both case fails LOUD with the seam contract
  await assert.rejects(
    () => pushSessionsContents({ env: {}, files: new Map([['x', 'y']]), log: () => {}, fetchImpl: () => {} }),
    /sessions push needs FSM_SESSIONS_REPO \+ FSM_SESSIONS_TOKEN/,
  );
});

test('s25/b1 REAL-MODE turn (CODEX_BIN shim): the transcript pair lands through the CONTENTS API — the composed body + meta at the per-run paths, on the TARGET repo', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-real-lane-'));
  const logs = [];
  try {
    const shim = makeCodexBinShim(base);
    const { fetchImpl, calls } = mockContentsApi((c) => (c.method === 'GET' ? { status: 404, data: null } : { status: 201, data: {} }));
    const result = await codexTurn(envelope({ prompt: '[fixture:ok] real-mode transcript lane' }), {
      env: { ...REAL_MODE_ENV, CODEX_BIN: shim, CODEX_HOME: join(base, 'codex-home') },
      runId: 'test-run',
      now: () => NOW_OFFPEAK,
      log: (l) => logs.push(l),
      fetchImpl,
    });
    assert.equal(classifyOutcome(result).status, 'done', 'the shim answered the fixture stream through the REAL lane (the raw-extraction shape — runTurn classifies)');
    assert.equal(result.transcript.mode, 'pushed', 'the transcript landed via the contents API, not a git push');
    assert.equal(result.transcript.repo, 'claudecode-headless/fsm-lab');
    assert.equal(result.transcript.branch, 'fsm-sessions');
    assert.equal(result.transcript.txt, 'sessions/T1/test-run-a1.txt');
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(puts.map((c) => c.url.split('/contents/')[1]), ['sessions/T1/test-run-a1.txt', 'sessions/T1/test-run-a1.meta.json'], 'the per-run pair, txt then meta');
    const txtBody = Buffer.from(puts[0].body.content, 'base64').toString('utf8');
    assert.ok(txtBody.includes('fsm-lab CODEX transcript (mode: codex)'), 'the composed body rode the PUT');
    assert.ok(txtBody.includes('[fixture:ok] real-mode transcript lane'), 'the prompt verbatim in the transcript');
    const metaBody = JSON.parse(Buffer.from(puts[1].body.content, 'base64').toString('utf8'));
    assert.equal(metaBody.harness, 'codex');
    assert.equal(metaBody.fake, false, 'real mode — the F15 provenance pin');
    assert.equal(puts[0].body.branch, 'fsm-sessions');
    assert.equal(puts[0].headers.Authorization, 'Bearer sess-token-1');
    assert.ok(puts[0].url.includes('/repos/claudecode-headless/fsm-lab/contents/'));
    assert.ok(!puts[0].url.includes('agentrunners'), 'F2: the TARGET repo, never the runner repo');
    assert.ok(logs.some((l) => l === 'CODEX-TRANSCRIPT-PUSHED 2 file(s) to fsm-sessions @ claudecode-headless/fsm-lab'));
    assert.ok(!logs.some((l) => l.includes('CODEX-TRANSCRIPT-RETRY')), 'the happy path needed no whole-set retry');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('s25 REAL-MODE turn, the push DIES PERSISTENTLY (401): a DONE turn escalates infra_failed transcript-push-failed carrying the aggregate (the lane-broken class — unchanged by the X30 correction)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-real-lane-'));
  const logs = [];
  try {
    const shim = makeCodexBinShim(base);
    // 401 on every call: FATAL per file (no 3×5s of retry theater before the
    // same death) — the fast deterministic route to the escalation
    const { fetchImpl } = mockContentsApi(() => ({ status: 401, data: { message: 'Bad credentials' } }));
    const result = await codexTurn(envelope({ prompt: '[fixture:ok] push death' }), {
      env: { ...REAL_MODE_ENV, CODEX_BIN: shim, CODEX_HOME: join(base, 'codex-home') },
      runId: 'test-run',
      now: () => NOW_OFFPEAK,
      log: (l) => logs.push(l),
      fetchImpl,
    });
    assert.equal(result.status, 'infra_failed', 'a DONE turn whose transcript never landed escalates (its report references the transcript)');
    assert.match(result.detail, /transcript-push-failed\(sessions contents push: 2\/2 file\(s\) failed/);
    assert.match(result.detail, /sessions\/T1\/test-run-a1\.txt: GET HTTP 401/, 'the compact error (s25/X30: the status survives every downstream slice)');
    assert.match(result.summary, /the transcript never landed/);
    assert.deepEqual(result.artifact_refs, [], 'fixture:ok wrote nothing — no artifact surface on this lane');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('s25/X30 THE DEGRADED PATH: a 409 storm exhausts the ladder — the DONE turn KEEPS its status + the note rides the summary (no re-run of a completed paid turn)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-real-lane-'));
  const logs = [];
  try {
    const shim = makeCodexBinShim(base);
    // the X30 storm shape verbatim: every PUT conflicts (the ref moved
    // server-side — "is at X but expected Y") → retryable → the 10-attempt
    // de-sync ladder burns → DEGRADED, never thrown
    const { fetchImpl, calls } = mockContentsApi((c) => (c.method === 'GET' ? { status: 404, data: null } : { status: 409, data: { message: 'is at 3865e67 but expected 6c2c182' } }));
    const sleeps = [];
    const result = await codexTurn(envelope({ prompt: '[fixture:ok] storm' }), {
      env: { ...REAL_MODE_ENV, CODEX_BIN: shim, CODEX_HOME: join(base, 'codex-home') },
      runId: 'test-run',
      now: () => NOW_OFFPEAK,
      log: (l) => logs.push(l),
      fetchImpl,
      sleepImpl: (ms) => { sleeps.push(ms); },
      rand: () => 0.5,
    });
    // the happy-path return is the raw-extraction shape (content/reasoning,
    // NO stamped status — the classification is runTurn's). The X30 law
    // asserts: the WORK is intact, the escalation did NOT fire, and the
    // degraded marker rides the transcript result + the summary.
    assert.equal(result.transcript.mode, 'degraded', 'the transcript result carries the degraded marker');
    assert.ok(String(result.content ?? '').includes('fake-codex ok'), 'the turn\'s work is intact — the storm never touched the content');
    assert.equal(result.status, undefined, 'no escalation fired (a raw-shape return, not an infra_failed compose)');
    assert.match(result.summary, /\[transcript degraded: 2 file\(s\) unlanded @ /, 'the note rides the report summary (the journal-visible marker)');
    assert.ok(logs.some((l) => l.startsWith('CODEX-TRANSCRIPT-DEGRADED')), 'the LOUD run-log line');
    assert.ok(!logs.some((l) => l.startsWith('CODEX-TRANSCRIPT-RETRY')), 'the outer whole-set retry is GONE (it re-fed the storm — the X30 correction)');
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 2 * 10, 'both files burned the full 10-attempt ladder');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('codex escalation: the artifact-push escalation keeps lane_stats + the key pair (the retry\'s console view must see WHY attempt 1 burned)', () => {
  const result = {
    artifact_refs: ['tasks/T1/a.md'], telemetry: { turns: 1 }, models: ['m'],
    lane_attempts_used: 2, duration_ms: 99,
    lane_stats: { calls: 2, ok: 1, err429: 1, err5xx: 0, tokens: 10, cost: 0.001, p50_ms: 5, p95_ms: 7, rate_classes: {}, models: {} },
    key_index: 1, pool_size: 2,
  };
  const esc = codexArtifactPushEscalation('T1', 3, new Error('artifact-push: git push failed: rc=1'), result);
  assert.equal(esc.status, 'infra_failed');
  assert.match(esc.detail, /artifact-push: git push failed/);
  assert.match(esc.summary, /^codex: task T1 attempt 3 — the artifact branch push failed/);
  assert.deepEqual(esc.lane_stats, result.lane_stats, 'lane_stats rides the escalation (the net-zero retry\'s diagnosis)');
  assert.equal(esc.key_index, 1);
  assert.equal(esc.pool_size, 2);
  assert.equal(esc.artifact_refs, result.artifact_refs);
  // absent-means-absent: no lane_stats / no key fields → the escalation
  // carries neither (never undefined holes)
  const bare = codexArtifactPushEscalation('T9', 1, new Error('x'), { artifact_refs: [], telemetry: {}, models: [], lane_attempts_used: 0, duration_ms: 0 });
  assert.ok(!('lane_stats' in bare));
  assert.ok(!('key_index' in bare));
  assert.ok(!('pool_size' in bare));
});

// ---------------------------------------------------------------------------
// THE B5 ROUTING SEAM PIN — a real fake-mode codex turn through runTurn
// carries lane_stats into the ENQUEUED REPORT (the adapter→drain carry).
// ---------------------------------------------------------------------------

test('routing seam (B5): a codex turn through runTurn carries lane_stats + telemetry into the enqueued report — a codex turn WITHOUT lane_stats fails THIS test', async () => {
  const transcriptsRoot = mkdtempSync(join(tmpdir(), 'codex-routing-seam-'));
  const enqueued = [];
  const logs = [];
  try {
    const r = await runTurn({
      cp: {
        task: 'CX1', lease: 'l-cx123', attempt: 1, mode: 'codex', behavior: null,
        prompt: '[fixture:ok] routing seam probe', work_ms: 6000,
        expires: new Date(NOW_OFFPEAK + 900_000).toISOString(), chain: 'c-123',
      },
      runId: '99883', runAttempt: '1',
      env: {
        CODEX_FAKE_LLM: '1',
        OPENROUTER_API_KEY: KEY1,
        OPENROUTER_API_KEY_2: KEY2,
        CODEX_FAKE_TRANSCRIPTS_DIR: join(transcriptsRoot, 'sessions'),
        CODEX_STAGE_DIR: join(transcriptsRoot, 'stage'),
      },
      fetchImpl: async () => { throw new Error('unexpected fetch'); },
      enqueue: async (report) => { enqueued.push(structuredClone(report)); return { ok: true }; },
      sleepImpl: async () => {},
      now: () => NOW_OFFPEAK,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.equal(r.exitCode, 0, 'the report enqueued green');
    assert.equal(r.reported, true);
    assert.equal(enqueued.length, 1);
    const rep = enqueued[0];
    assert.equal(rep.task, 'CX1');
    assert.equal(rep.outcome.status, 'done', 'classifyOutcome normalizes the raw codex return through the routing arm');
    // THE SEAM PIN: the lane_stats aggregate rides the report outcome through
    // composeReportOutcome's M4 allowlist — the adapter's richest data must
    // never die between codexTurn and the drain (the W-C2 silent-drop class)
    assert.ok(rep.outcome.lane_stats && typeof rep.outcome.lane_stats === 'object',
      'lane_stats on the enqueued outcome (the B5 gate: red if the adapter or the composer drops it)');
    assert.equal(rep.outcome.lane_stats.calls, 1);
    assert.equal(rep.outcome.lane_stats.ok, 1);
    assert.equal(rep.outcome.lane_stats.cost, 0.000228);
    assert.deepEqual(rep.outcome.models, ['deepseek/deepseek-v4.1-flash']);
    assert.equal(rep.outcome.telemetry.lane_attempts_used, 1);
    assert.equal(rep.outcome.key_index, 0);
    assert.equal(rep.outcome.pool_size, 2);
    assert.ok(logs.some((l) => l.includes('WORKER-DONE') && l.includes('outcome=done')));
  } finally {
    rmSync(transcriptsRoot, { recursive: true, force: true });
  }
});

test('routing seam (B5): the lazy arm\'s AdapterNotShipped marker stays intact (a missing export is codex-adapter-missing, terminal)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'codex-seam-neg-'));
  const enqueued = [];
  try {
    writeFileSync(join(scratch, 'codex-adapter.mjs'), 'export const other = 1;\n');
    const r = await runTurn({
      cp: {
        task: 'CX2', lease: 'l-cx124', attempt: 1, mode: 'codex', behavior: null,
        prompt: 'seam negative', work_ms: 1000,
        expires: new Date(NOW_OFFPEAK + 900_000).toISOString(),
      },
      runId: '99884', runAttempt: '1',
      env: {},
      fetchImpl: async () => { throw new Error('unexpected fetch'); },
      enqueue: async (report) => { enqueued.push(structuredClone(report)); return { ok: true }; },
      sleepImpl: async () => {},
      now: () => NOW_OFFPEAK,
      log: () => {},
      codexAdapterPath: join(scratch, 'codex-adapter.mjs'),
    });
    assert.equal(r.exitCode, 0);
    assert.equal(enqueued[0].outcome.status, 'infra_failed');
    assert.equal(enqueued[0].outcome.error, 'codex-adapter-missing');
    assert.equal(enqueued[0].outcome.telemetry.lane_attempts_used, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
