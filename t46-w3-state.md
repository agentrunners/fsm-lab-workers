# T46-W3 STATE — the WORKER/SHIM wave (harness-shim + turn routing + law-1 start-gate)

**Task ID:** 46-W3. **Status:** COMPLETE — all gates green. **Branch:** `t46/wb-w3` (base `76442c9` = the CURRENT `origin/t46/wb` tip with W1 core + W2 conductor landed; never touched main, no force pushes, never touched the W2-owned conductor files).

| Gate | Result |
|---|---|
| `node --test tests/*.mjs` | **214/214 pass** (163 at base → +51 new; 0 fail) |
| `node sim/run-sim.mjs` | **8/8** |
| `node sim/run-sim2.mjs` | **7/7** |
| `bash scripts/validate.sh` | **VALIDATE-OK** |

Base-branch note: the working branch was created at the W1 tip (`9731c81`) and fast-forwarded to the W2 tip (`76442c9`) before any commit — W2's files (conductor/turn.mjs, lib/conductor-core.mjs, conductor.yml, test-w2-conductor.mjs) do not overlap the W3 surface, so the ff was clean and the W2 code is untouched.

## What landed (commits on t46/wb-w3)

| Commit | Contents |
|---|---|
| `5a9af8f` | **§1b** — NEW `sim/harness-shim.mjs` (293 lines): `shimInvoke` — the deterministic contract implementer with the 8 seeded behaviors + the legacy mock vocabulary as aliases, `seedFromRunId` (FNV-1a 32), `SHIM_BEHAVIORS`/`LEGACY_BEHAVIORS`, `mulberry32` re-exported from `sim/gha-shim.mjs` (ONE rng implementation in the repo). + NEW `tests/test-harness-shim.mjs` (**19 tests**). |
| `4838b2a` | **§1c** — `worker/turn.mjs` REWRITTEN: law-1 start-gate via `envelopeFromDispatch` FIRST, MODE routing mock→shim / real→env-driven model chain with one fallback hop / cc→clean stub, `classifyOutcome` as the ONE normalizer, the write-back door on dones, the hardened enqueue (retry once → step summary → exit 2); `runTurn` fully injectable. `worker.yml`: `OPENROUTER_MODEL` mapping + the MODE-routing header. + NEW `tests/test-worker-routing.mjs` (**32 tests**, incl. the 5 W2 cross-wave seam tests). |

**Test counts:** base 163 → **214**. Per file: harness-shim **19** (new), worker-routing **32** (new), worker-contract 35, fsm 47, conductor-core 25, w2-conductor 17, store 18, watchdog-core 16, event-ingest 5 (all unchanged).

**Out-of-scope discipline:** changed files = exactly `sim/harness-shim.mjs` (new), `tests/test-harness-shim.mjs` (new), `tests/test-worker-routing.mjs` (new), `worker/turn.mjs`, `.github/workflows/worker.yml`. `lib/mock.mjs` is UNTOUCHED (the sims keep calling it — see D6). Nothing in `conductor/*`, `lib/conductor-core.mjs`, `lib/worker-contract.mjs`, `lib/event-ingest.mjs`, `lib/fsm.mjs`, `lib/store.mjs` was modified.

## The interface contract — EXACT signatures as implemented

```js
// sim/harness-shim.mjs  (NEW — pure, zero I/O, deterministic)
export function shimInvoke(envelope, behavior = 'fast', seed = 0, opts = {})
//   envelope  the OK envelope from envelopeFromDispatch ({task_ref:{kind:'state-task',id},
//             prompt, deadline_ms, session, budget:{max_turns,wall_ms,lane_attempts},
//             mode, attempt}). Budget/attempt read LENIENTLY with the contract defaults;
//             a missing/empty task_ref.id THROWS (never a silent wrong-task artifact path).
//   behavior  one of SHIM_BEHAVIORS or the legacy vocabulary (below) — anything else
//             → work_failed 'unknown-behavior(<b>)' (the legacy answer: the ladder burns
//             visibly; it is not an anomaly class).
//   seed      uint32 — the ENTIRE randomness input (mulberry32 from sim/gha-shim.mjs,
//             consumed in FIXED order per behavior path).
//   opts      {workMs?            the intended work duration (the live ASSIGN's work_ms;
//                              default per-behavior: fast/dup 5000, slow max(1.8M, budget
//                              +60s+jitter), fails min(workMs, 2000), infra min(workMs,1000)),
//           deadlineEnforced? the 'hang' dual-return switch (D1 below; default false)}
//   → {status, artifact_refs, summary, telemetry}  — the FULL contract return:
//     status        'done'|'work_failed'|'infra_failed'|'deadline'|'poison' — with ONE
//                   sanctioned exception: the 'hang' marker (D1).
//     artifact_refs paths the harness "wrote": legal tasks/<id>/... (+, for wb-violation,
//                   the ILLEGAL ones the door must flag). [] on failures.
//     summary       human text (the worker maps it to outcome.artifact on dones).
//     telemetry     {turns, wall_ms, lane_attempts_used} — SIMULATED wall time; the
//                   mock-lane worker sleeps min(wall_ms, TTL−2min) to reproduce the live
//                   timing classes.
//     + detail on failure shapes (classifyOutcome passthrough → the journal error text)
//     + repeat_report:true on 'dup-report' (the caller enqueues the SAME payload twice).

export const SHIM_BEHAVIORS = ['fast','slow','poison','infra-flaky','deadline','hang','dup-report','wb-violation'];
export const LEGACY_BEHAVIORS = ['succeed','flaky','fail','no-report','infra','dup'];
//   aliases: succeed→fast  flaky→work_failed@1,done@2+  fail→work_failed  infra→infra-flaky
//            no-report→hang  dup→dup-report  ('slow'/'poison'/'hang' are the same names in both)

export function seedFromRunId(runId, attempt)   // FNV-1a 32 over `<runId>:a<attempt>` → uint32
//   (a re-run mints the SAME seed → byte-reproducible; every new run mints fresh)

export { mulberry32 }   // re-exported from ./gha-shim.mjs — the ONE rng implementation
```

### The behavior table (what W4's conformance matrix asserts)

| behavior | status | detail | artifact_refs | telemetry shape |
|---|---|---|---|---|
| `fast` | done | — | 1× `tasks/<id>/artifacts/out-<hex4>.md` | turns 1..min(4,max_turns), wall = workMs ?? 5000, lanes 1 |
| `slow` | done | — | 1× legal | wall = max(workMs ?? 1.8M, budget.wall_ms+60s+jitter) — PAST the window (the late-report/stale-lease-orphan class) |
| `poison` | work_failed EVERY attempt | `poison-always` | [] | turns 1..2, wall ≤ 2000, lanes 1 |
| `infra-flaky` | infra_failed @ attempt 1, done @ 2+ | `lane-429` | [] on fail | lanes = budget.lane_attempts (all burned) on fail, 1 on done |
| `deadline` | deadline | `wall-budget-exceeded` | [] | turns = budget.max_turns, wall = budget.wall_ms+1+jitter |
| `hang` | **`hang` marker** (default) / `deadline` when `opts.deadlineEnforced` | `hang-by-design` / `wall-budget-exceeded` | [] | wall 86_400_000 (the 24h kill window) |
| `dup-report` | done + `repeat_report:true` | — | 1× legal | turns 1, wall = workMs ?? 5000 |
| `wb-violation` | done | — | `tasks/<id>/out/report.md`, `tasks/<id>/out/data-<hex4>.json`, **`.github/workflows/evil.yml`** (deny-dotgit — ALWAYS denied), **`evil.txt`** (root-not-declared) — the caller's writeBackDoor flips the outcome to poison | turns 2, wall = workMs ?? 5000 |
| *(unknown)* | work_failed | `unknown-behavior(<b>)` | [] | turns 0, wall 100 |

```js
// worker/turn.mjs  (REWRITTEN — the workflow entry stays `node worker/turn.mjs`)
export function sleepCapMs(env = process.env)          // F-G(a): (WORKER_TTL_MIN − 2) minutes, 20-min default
export const REAL_MODEL_CHAIN_DEFAULTS = ['dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free']   // the RETIRED minimax slug is GONE
export function realModelChain(env = process.env)      // [OPENROUTER_MODEL (trimmed, if set), ...defaults]
export async function realWork(envelope, {env, fetchImpl} = {})
//   ONE fallback hop on infra-class failure (transport throw / 401 / 402 / 429 / 5xx),
//   bounded by min(chain.length, max(1, min(2, budget.lane_attempts))). Returns the RAW
//   lane result PRE-normalization: {content} | {content:null} | {error:{status}} |
//   {status:'infra_failed', detail:'lane-exhausted(<used>/<total> lanes, last lane-<n|transport>)'}
//   + models[], lane_attempts_used, telemetry, duration_ms (runTurn's single
//   classifyOutcome call is the one normalizer).
export class AdapterNotShipped extends Error           // code 'ADAPTER_NOT_SHIPPED'
export async function runTurn({cp, runId='local', runAttempt='1', env, fetchImpl, enqueue,
                               sleepImpl, now, log, stepSummaryPath}) → {reported, exitCode, ...}
//   1. LAW-1 START-GATE: envelopeFromDispatch(cp, now()) — {ok:false} → ONE infra_failed
//      report (the deadline-in-past reason renamed 'late-start'; every other reason
//      rides as-is), exit 0, ZERO work (no sleep, no fetch). No task id → loud log,
//      exit 0, nothing reportable.
//   2. mode routing: mock → shimInvoke(envelope, cp.behavior||'fast', seedFromRunId(runId,
//      runAttempt), {workMs: cp.work_ms}); the 'hang' marker → capped sleep, NO report,
//      exit 0; otherwise sleep min(telemetry.wall_ms, sleepCap) then classify.
//      real → realWork; cc → ccWork (import of worker/cc-adapter.mjs; ERR_MODULE_NOT_FOUND
//      → AdapterNotShipped → the routing-level infra marker {status:'infra_failed',
//      detail:'cc-adapter-missing'}).
//   3. classifyOutcome(raw) — the ONE normalizer. THEN the write-back door: a done
//      carrying artifact_refs → writeBackDoor({branch:`tasks/<task>`, paths, allowRoot:
//      cp.artifacts ?? []}) — violations flip the outcome to poison
//      'write-back-door(<violations>)' with the refs + telemetry preserved as evidence.
//   4. report payload {event_id: reportEventId({runId, attempt: runAttempt})  (= the REPORT
//      mint-table site, F-E attempt-scoped), task, lease, outcome, run_id}. dup-report →
//      the SAME payload enqueued twice (second best-effort). Enqueue hardening: one retry
//      (1s beat), then the payload to GITHUB_STEP_SUMMARY (the zero-API run-conclusion
//      lane) + exit 2.
//   main() wires the real dependencies; module-runs-as-entry only (import-safe for tests).
```

## Discrepancies found (design/brief vs implementation — resolutions recorded)

1. **'hang' cannot be simultaneously deterministic and literally hanging.** The brief anticipated this ("return deadline if the caller enforces, else a hang marker"). Implemented as the dual-return contract: default → the `{status:'hang'}` MARKER (one status OUTSIDE the five classes, on purpose): the mock-lane worker sleeps the capped wall, reports NOTHING, exits 0 — the lease deadline is the handler (exact live parity with the legacy mock 'hang'/'no-report'). `opts.deadlineEnforced:true` → the SAME turn returns `deadline 'wall-budget-exceeded'` (the W4 wall-enforcing adapter's process-group-kill shape). **Callers must handle the marker BEFORE classifyOutcome** — the classifier would mis-map the literal 'hang' to poison 'unknown-status' (it is the designed silent class, not an anomaly). Pinned by tests both sides.
2. **The "run conclusion comment" is the STEP SUMMARY, not an issue comment.** The worker has ZERO PAT/API surface by design (T44: LAB_PAT dropped; worker.yml `permissions: contents: write` only — no `issues: write`). The enqueue-failure hardening therefore writes the payload to `GITHUB_STEP_SUMMARY` (visible on the failed run — which exits 2, the L0 visibility signal) instead of posting a comment. Interpretation recorded; if a comment lane is wanted it needs a workflow permission change (W4/W-C decision).
3. **`shimInvoke` grew a 4th parameter `opts`.** The brief's signature is `(envelope, behavior, seed)`; the implementation adds `{workMs, deadlineEnforced}` — `workMs` carries the live ASSIGN's `work_ms` knob (the conductor mints `work_ms: 6000` by default) so the shim's simulated wall tracks the dispatch, and `deadlineEnforced` selects the hang contract (D1). Defaults keep the 3-arg call exactly the brief's shape; the tests pin both forms.
4. **The 'poison' BEHAVIOR ≠ the poison STATUS class.** Per the brief ("poison (work_failed every attempt — but as the CONTRACT's work_failed, not legacy)"), the shim's `poison` behavior returns `work_failed 'poison-always'` on every attempt (ladder burns, then parks). The poison STATUS class arrives via the write-back door (`wb-violation` → the door flips done→poison) or unknown-status shapes. Confusing but specified — recorded so W4's conformance matrix maps the behavior name to the WORK class.
5. **`infra-flaky` is ATTEMPT-keyed, not flap-counter-keyed.** The legacy mock's 'infra' used a caller-decremented `infraLeft` (the worker is stateless, so the LIVE lane never decremented it — live 'infra' flapped forever). The shim's `infra-flaky` (per the brief: "infra_failed on attempt 1, done on 2+") keys on the envelope's attempt. NOTE: infra flapping does NOT grow attempts in the FSM (net-zero), so a live epoch with behavior 'infra' reports infra_failed on every attempt-1 reassignment — same observable live behavior as the legacy mock lane. The real recovery story is W4's lane rotation inside one turn (realWork's fallback hop already demonstrates it).
6. **`lib/mock.mjs` stays, untouched.** sim/run-sim.mjs + run-sim2.mjs drivers call `mockWork` DIRECTLY (they never execute worker/turn.mjs), so the legacy mock stays for them and the WORKFLOW path alone runs the shim — exactly the brief's "if sim1's driver calls worker internals directly, leave mock.mjs in place… document which" (documented in the turn.mjs header). Consequence: the sims' worker-behavior semantics (infraLeft flapping, legacy 'failed' vocabulary in sim reports) are frozen at pre-W3 — sim3 (W4) is the shim-driven FSM exercise.
7. **MODE=real detail vocabulary changed (audit-visible, FSM-equivalent).** Old realWork minted `'transport-<name>'` / `'openrouter-<status>'` / legacy `'failed'` statuses; the new lane returns raw shapes and classifyOutcome normalizes: infra → `lane-<n>` / `lane-exhausted(...)`, work → `error-<n>` / `empty-completion`, statuses `work_failed`. The FSM receiver aliases `work_failed`↔`failed` byte-identically (W1 F-B1), so transitions are unchanged; only the journal text vocabulary is new (which the receiver records via last_result.status).
8. **Missing `cp.behavior` now defaults to 'fast'.** The old mock lane would report `unknown-behavior:undefined` (work_failed); the brief specifies `CP.behavior || 'fast'` and the implementation follows (a typo'd behavior still burns visibly via the shim's unknown-behavior work_failed). Live ASSIGNs always carry behavior, so the difference is hand-crafted-dispatch-only.
9. **The mock-lane sleep happens AFTER `shimInvoke` returns.** The shim's `telemetry.wall_ms` is SIMULATED wall (determinism law — no clock inside the shim); the worker reproduces the live timing classes by sleeping `min(wall_ms, sleepCap)` between the shim return and the report enqueue. `duration_ms` on the report is the REAL turn duration (injected `now()`), not the simulated wall.

## What W4 (CC adapter + conformance + sim3) builds on

- **`worker/cc-adapter.mjs` must export `ccTurn(envelope)`** returning the SAME contract return the shim returns (the conformance reference — C3 folded per D1). The stub already imports it: `MODE=cc` works end-to-end today, reporting `infra_failed 'cc-adapter-missing'` until the module exists. The F-M8 env contract (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL, DISABLE_TELEMETRY, OX_AGENT_DEADLINE_UTC from `envelope.deadline_ms`) is documented at the stub in turn.mjs — implement + assert it at the spawn level.
- **`worker/conformance-cc.mjs` + `sim/run-sim3.mjs`** drive the SAME behavior matrix against shim and adapter: `SHIM_BEHAVIORS` is the exported table; the wb-violation ILLEGAL refs are enumerated and pinned by test (`.github/workflows/evil.yml` → `deny-dotgit(...)`, `evil.txt` → `root-not-declared(...)`) — assert them verbatim through `writeBackDoor`; the legal refs isolated pass the door.
- **Determinism primitives:** `seedFromRunId(runId, attempt)` for reproducible sim3 runs; `mulberry32` from `sim/gha-shim.mjs` (do not fork the rng). The hang contract: the adapter's process-group kill at the wall maps to `deadline` (`opts.deadlineEnforced:true` semantics / rc=124).
- **The door's read-back:** `writeBackDoor` returns `{branch, taskId, allowed[], totalBytes, caps}` — the adapter's remote tip-API verification consumes that shape (W1's design, unchanged).
- **The turn is fully injectable:** `runTurn({cp, runId, runAttempt, env, fetchImpl, enqueue, sleepImpl, now, log, stepSummaryPath})` — sim3 can drive the whole routing (gate → mode → classify → door → report) offline; `realWork(envelope, {env, fetchImpl})` and `realModelChain(env)` are separately drivable for lane-picker tests (the key×model product per §1d lands in the adapter, not realWork).
- **The W2 cross-wave seam is pinned:** `assembleDispatchPayload`'s full payload (prompt/deadline_ms/mode/session/budget riding every live ASSIGN) flows through `runTurn` end-to-end — including the delayed-past-minted-deadline → `late-start` gate and the W2 no-floor near-expired-lease → the gate (test-worker-routing.mjs's W2 section). sim3 should mint dispatches through `assembleDispatchPayload`, not hand-roll payloads.
- **Transcript push (F-M6) goes BEFORE report enqueue** in the cc lane; the report payload already carries `telemetry`/`artifact_refs`/`models` superset fields the receiver ignores — extend, don't fork.
