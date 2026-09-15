# T46-WB — Worker-Turn Contract + Harness-Shim + CC Adapter (the W-B build)

**Task ID:** 46 (session 15, W-B). **Status:** design for adversarial review.
**Inputs:** PHASE2-ARCHITECTURE §4/§10/§11 (v2 review-hardened), T45-FIX-DESIGN (deployed base), the D1 adjudications (law ownership; A5 de-scope; C3-fold), the live fuel map (46-A4/46-HA1: keys #7+#6 free-capable; `minimax-m3:free` RETIRED live 404 — fleet re-armed on `dots-studio/dots-3-note-preview:free`; alternates `nvidia/nemotron-3-ultra-550b-a55b:free`, `cohere/north-mini-code:free`, `inclusionai/ling-3.0-flash-fin:free`).
**Deploy base:** fsm-lab main @ 04c26d8 (98/98 tests, sim 8/8, sim2 7/7, smoke 16/16), quiesced (phase=done halted=true v65 seq154).

## 0. Law ownership (D1-adjudicated; this build ships the lab-side halves)

| R2 law | Side | Status |
|---|---|---|
| 1 start-gate | worker (turn.mjs) | **THIS BUILD** |
| 2 phase quality-gate | lab | deployed (70ff179) |
| 3 work-lane breaker | executor | **deployed this session (A2/X19)** |
| 4 run-creation verify | conductor | **THIS BUILD** |
| 5 alert-lane health | executor half deployed (A2/X19); worker REPORT-post half = the existing enqueue CAS + F-F classification | **THIS BUILD (worker half hardened)** |
| 6 blob budgets | lab | **THIS BUILD (audit + pacing + transcript GC hook)** |
| 7 cold-start 404 | lab | **THIS BUILD (audit + pinning test)** |
| 8 monitor quota isolation | executor/W-C | out of scope |

## 1. Deliverable map (new/changed files)

### 1a. `lib/worker-contract.mjs` (NEW — the contract as code)
- `envelopeFromDispatch(cp, now)` → `{ok, envelope}` — derives+validates `{task_ref, prompt, deadline, session, budget}` from the repository_dispatch client_payload. **Fail-closed:** missing/corrupt → `{ok:false, class:'infra_failed', reason:'bad-envelope'}` — never a work attempt. v1 task_ref = `{kind:'state-task', id}` (the task record lives in state.json; richer spec paths arrive with W-C intake). deadline = min(lease expiry − margin, job TTL − margin, harness ceiling); margin default 2min (F-G(a) proven arithmetic).
- `writeBackDoor({branch, paths, sizes})` → `{ok, violations}` — the pathspec allowlist (`tasks/<id>/**` + payload-declared artifact paths ONLY; `.github/**`, root, `.git*` ALWAYS refused), per-file cap (10MB default) + total cap (10MB/task), remote read-back verification (the tip-API discipline — masked-rc lesson). Used by the CC adapter's artifact path (D4: the door ships before the task-branch flow that needs it).
- `mintEventId(kind, seed)` — the R1-B2 mint table: TICK (`tick-<reason>-<seq>`), REPORT (`rep-<RUN_ID>-a<ATTEMPT>`, F-E), CONTROL (`ctl-<command>-<node_id>`), TASK_CREATED (`task-<issue#>-<body-sha8>`); WAKE never journaled. One function = the single mint source (the exactly-once rule's other half).
- `classifyOutcome(raw)` — the five classes (done / work_failed / infra_failed / deadline / poison) as ONE pure function shared by shim, real, and cc paths (the F-F split generalized; poison = the prompt-injection/anomaly report class per §5 trust boundary).

### 1b. `sim/harness-shim.mjs` (NEW — the deterministic contract implementer)
- `shimInvoke(envelope, behavior, seed)` → the full contract return `{status, artifact_refs, summary, telemetry}` — behaviors: `fast, slow, poison, infra-flaky, deadline, hang, dup-report, wb-violation` (write-back door exercise), seeded RNG (determinism = the conformance suite's foundation).
- Implements the SAME surface the CC adapter implements — **the shim IS the multi-harness conformance reference (C3 folded here per D1)**.

### 1c. `worker/turn.mjs` (CHANGED)
- Route ALL modes through the contract: `envelopeFromDispatch` FIRST (law 1 start-gate: lease already expired at job start → report `infra_failed 'late-start'` immediately, exit 0 — kills the guaranteed-orphan class).
- `MODE=mock` → shimInvoke (mock.mjs stays for sim1 legacy); `MODE=real` → the raw-completion stand-in (model slug moves to the fallback chain); `MODE=cc` → the adapter.
- Report enqueue keeps the CAS + attempt-scoped event_id (F-E); the REPORT post failure (enqueue) = infra_failed classification already — hardened: the enqueue failure itself retries once then reports via the run conclusion (the visible-waste doctrine).

### 1d. `worker/cc-adapter.mjs` (NEW — the CC harness turn)
- **CLI invocation:** pinned `@anthropic-ai/claude-code` install (version env-pinned, default recorded at build), `-p` headless, `--max-turns` from budget, permissions: deny WebFetch/WebSearch (mcp-web replaces — SA-5), `--output-format json` for parseable results.
- **The lane picker (A5 de-scope — the user's key-pool + fallback + mock requirements, implemented in-adapter):** key pool = `[OPENROUTER_API_KEY, OPENROUTER_API_KEY_2]` (fsm-lab repo secrets; #7 primary, #6 secondary); model chain = `[CC_MODEL env, dots-studio/dots-3-note-preview:free, nvidia/nemotron-3-ultra-550b-a55b:free, cohere/north-mini-code:free]`; on infra-class lane failure (401/402/429/5xx/transport) → next lane in the key×model product, bounded by budget (default 3 lane attempts/turn); lane telemetry in the outcome. **GHA runners rotate IPs naturally (the TOS-multi-account concern's real answer); sandbox-origin calls are validity probes only — documented.**
- **Mock-LLM mode:** `CC_FAKE_LLM=1` stubs the CLI with a deterministic script (fixture responses incl. the error-as-answer shapes) — functional tests NEVER burn fuel or depend on network (the user's determinism requirement).
- **Deadline pacing:** `OX_AGENT_DEADLINE_UTC` computed from the envelope; rc=124 → status `deadline`; the CLI's own turn cap = the harness ceiling.
- **The error-as-answer classifier inline:** parse the result text for the packaged-error marker classes (401/402 text-as-success — E11) BEFORE done; classified infra/failed per F-F.
- **Transcripts:** pushed to the `fsm-sessions` branch as `sessions/<task>/<run>-a<attempt>.txt` (+ `meta.json` with telemetry); GC contract = at terminal task state + 90d hard cap (R2-A8 — the hook ships now, the GC duty rides the watchdog W-C).
- **Artifacts:** any declared artifact paths commit via `writeBackDoor` to the task branch; violations → `poison` class report (the door is the governance).

### 1e. `lib/fsm.mjs` + `lib/conductor-core.mjs` (CHANGED — laws 4/6/7)
- **Law 4:** post-dispatch run-creation verification — the conductor tick (or the dispatch step) verifies via API that each dispatched worker run EXISTS after a bounded window (60s probe + one 120s re-check — the A2-verified pattern); missing → the assignment flips to `infra_failed 'dispatch-unverified'` (net-zero retry per F-F) — the accepted-but-dropped class dies.
- **Law 6:** audit that journal records stay pointer-only (payload in task records, ids in journal — verify + pin with a test); dispatch pacing floor ≥300s at hot cadence (config-bounded, default enforced); transcript GC hook (above).
- **Law 7:** cold-start audit — branch-absent 404 → genesis-eligible (idempotent, alert must not lie); pin with a test.

### 1f. `briefs/project.md` (NEW — the memory v1 seed)
- The rolling ~2KB project digest: `digest-of: <state pointer>` header + the contract (written at milestone boundaries + epoch transitions by a reviewed digest task — NOT an autonomous summarizer; every worker prompt includes it AS QUOTED DATA).

### 1g. Tests + sims
- `tests/test-worker-contract.mjs` (envelope fail-closed; door allowlist/deny/size/read-back; mint table; classify — incl. the error-as-answer shapes)
- `sim/run-sim3.mjs` — the FSM↔shim conformance driver (drives the full loop offline: dispatch → shimInvoke → report → drain → terminal states; asserts the five-status mapping + law 1/4 behaviors)
- `worker/conformance-cc.mjs` — the adapter in CC_FAKE_LLM mode driven by the same conformance matrix (the multi-harness proof: shim and adapter pass the SAME suite)
- Existing suites stay green (98/98 + sims + smoke).

## 2. X-proofs

- **X20 (pre-merge, disposable surface):** a live wrapper smoke of the claude-CLI-on-GHA + OpenRouter free lane — runs in a THROWAWAY dispatch of the adapter's install+one-turn path (a scratch workflow on fsm-lab's conformance workflow OR the main repo's kit-wrapper-smoke re-run with the re-armed fuel). Measures: install time, one-turn duration, quota readback. **Labeled LOWER-BOUND (free lane — kill-F9).** Gate for lease arithmetic.
- **X21 (post-merge, synthetic epoch):** the first real CC worker completing a lease-scoped turn THROUGH the FSM: genesis → 1 shim task (sanity) → 1 MODE=cc task → REPORT (done) → artifact check → lease release → halt. The dogfood-gate recording (§11-1): verdict recorded — mock-project pass = the gate for pointing the system at the real backlog (W-C decision).
- Proof IDs X19 (done, A2) / X20 / X21 this session; X22+ stay W-C's.

## 3. Build + deploy discipline

- Branch `t46/wb` (worktree off main @ 04c26d8); every commit pushes the branch (GIT IS THE DISK).
- Gates before merge: all offline suites green (unit + sim3 + conformance-cc fake-LLM + legacy sims + smoke) → adversarial review round (2 reviewers minimum) → fold → merge ONLY in a quiescent window (post-X15 + post-drill-epoch halt — the split-deploy hazard law).
- `worker.yml` gains the new env (keys 1+2, model chain, CC pin) — secrets set at deploy time; the roster/executor needs NOTHING (the worker is repository_dispatch-driven, zero monitor coupling).
- The fsm-lab OPENROUTER_API_KEY secret gets re-set (to #7) + OPENROUTER_API_KEY_2 (to #6) — the realWork hardcoded dead slug dies with this build.

## 4. Recorded decisions (mine, numbered W-B-D)

- **D1 self-contained adapter:** no agent-kit submodule in the public system repo (zero PAT-submodule surface on fsm-lab); the SA-5 CONTRACT is followed, the kit CODE is cited not imported. Kit-side parity notes recorded for W-E.
- **D2 v1 fuel env:** two repo secrets (key1/key2) + env-driven model chain with live-probed free defaults; NO balance-API trust (telemetry reported, not enforced).
- **D3 transcripts v1:** fsm-sessions branch, one file per turn, GC-at-terminal+90d hook (duty lands W-C).
- **D4 write-back door v1:** enforced in-lib + exercised by shim/conformance + the adapter artifact path; the human task-branch/PR flow arrives with W-C intake (the door before the flow).
- **D5 budget v1:** max_turns + wall-clock + lane-attempt caps; token/cost telemetry reported not enforced.
- **D6 law-4 verification window:** 60s + one 120s re-check (the fsm-watchdog duty's proven arithmetic — 2m44s worst observed latency tail).

## 5. Anti-scope (this build does NOT)

No intake door (W-C). No ops-console upgrades (W-C). No pinger (W-C). No heartbeat/lease renewal (v2 per §4). No multi-project epochs (W-D). No OC/HA adapters (W-E — the C1/C2 absorption docs carry those designs). No auto-merge (Q4 is the principal's). No balance-enforced budgets (D5).

---

## v2 fold (2026-09-15 — both review rounds: 5 BLOCKING / 13 MAJOR folded; the two reviewers converged on the core holes from independent lenses)

- **F-B1 (the five-class FSM receiver — BOTH reviewers, the top hole):** the contract's status classes have NO FSM handlers today (`lib/fsm.mjs:166-204` rejects work_failed/deadline/poison as bad-outcome — poison would degrade to lease-reaper WORK burn, the exact class W-B exists to kill). **Amendment:** §1e gains the receiver: the report-apply switch accepts `{done, work_failed, infra_failed, deadline, poison}` — work_failed→attempt-burn (alias of today's `failed`; legacy epochs unchanged), deadline→attempt-burn + lease release (the reaper-equivalence, self-reported), poison→the quarantine door with `reason: 'poison'` (terminal, distinct from infra); `rebuild()` parity extended to the new classes (the F8 contract); tests pin all five transitions + rebuild parity.
- **F-B2 (the dispatch-side envelope doesn't exist — deep reviewer):** the live ASSIGN payload (`conductor/turn.mjs:223-227`) carries no prompt/session/budget/mode → fail-closed validation would quarantine TODAY's epochs into DEGRADED halt (X21's own sanity task dies). **Amendment:** `conductor/turn.mjs` + `conductor.yml` ADDED to the changed-files map — the ASSIGN action mints the FULL envelope (prompt assembled from task spec + `briefs/project.md` AS QUOTED DATA + task window; deadline from lease/TTL arithmetic; budget defaults; mode from task record/epoch config); `makeGenesis` gains `mode` (mock default; cc for the X21 synthetic epoch). **Backwards-compat rule:** `envelopeFromDispatch` rejects only CORRUPT/CONTRADICTORY envelopes (deadline in the past, unknown mode, non-integer attempt) — minimal legacy payloads get DEFAULTS (prompt fallback = the task title; budget/mode fallback = epoch defaults). Fail-closed stays fail-closed for the classes that matter (trust-boundary shapes), not for legacy minimalism.
- **F-B3 (the mint source is event-ingest.mjs — kill reviewer):** TICK/CONTROL/REPORT ids mint in `lib/event-ingest.mjs` today; "one function in worker-contract.mjs" would fork the source and regress the probe6 injected-clock fix. **Amendment:** `lib/event-ingest.mjs` ADDED to the map — `mintEventId` + the mint TABLE live THERE; worker-contract.mjs imports it; all existing mint sites route through the one table.
- **F-M1 (law-4 plumbing):** `conductor.yml` needs `permissions: actions: read` (run-listing 403s as-is); the verification window widens to the watchdog's proven arithmetic (360s + one 360s re-check — D6's 180s had 16s headroom over its own cited 164s tail); runless synthetic reports mint `rep-synthetic-<uuid8>-a1`.
- **F-M2 (the pacing-floor kill — kill reviewer's B2):** ≥300s floor × live `lease_minutes=4` = structural orphan-storm → DEGRADED halt (sim2's own lease-margin arithmetic). **Amendment:** the floor activates only when `lease_minutes ≥ 7` (short-lease epochs are burst lanes by design); config-bounded, tested at both sides.
- **F-M3 (law-6 scoping):** the pointer-only pin-test would FAIL today (legacy journal records inline specs). **Amendment:** the invariant scopes to NEW record classes (ASSIGN carries task_ref pointers; legacy records stay untouched); the test asserts new-class shape only.
- **F-M4 (classifier hardening — probe-grounded):** the live probe found dots-studio:free is REASONING-FIRST (content:null, reasoning populated, finish=length at small max_tokens) — the empty-completion path would misclassify. **Amendment:** classifyOutcome handles {content:null, reasoning:string} as valid extraction; finish=length at probe budgets = the caller's error (infra-class 'budget-misconfigured'); mid-turn 429/5xx on the SHARED kasulty lane = infra (lane rotates); empty-BOTH → work_failed 'empty-completion'.
- **F-M5 (X20 physics):** repository_dispatch resolves workflows from the default branch ONLY — the scratch smoke can't live on t46/wb as a dispatch target. **Amendment:** X20 runs via `workflow_dispatch` ON the t46/wb branch (feature-branch dispatch works when the workflow file exists there — the file ships in the branch); disposable, zero main risk, pre-merge.
- **F-M6 (transcript ordering + plumbing):** transcript push BEFORE report enqueue (the report references the transcript path; push failure → infra_failed, retry lane); the sessions-branch writer rides the Store CAS plumbing (new Store method, 3-way-refresh semantics); the CLI spawn is process-group-scoped (kill the group at deadline — no orphan CLI processes past the report).
- **F-M7 (conformance honesty):** the fake-LLM boundary asserts argv+env at the SPAWN level (the fake CLI echoes its invocation; conformance asserts the env lane, model chain, deadline, max-turns); sim3 models law-4 under the DispatchLane's latency/drop tails (the run-creation verification path gets its own shim scenario).
- **F-M8 (CC bridge env contract):** the adapter's env: `ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`, `ANTHROPIC_AUTH_TOKEN=<lane key>`, `ANTHROPIC_MODEL=<lane model>`, `ANTHROPIC_SMALL_FAST_MODEL=<lane model>` (sub-agent lane — same key), `DISABLE_TELEMETRY=1`; all documented in the adapter header + asserted by the fake-CLI conformance.
- **F-M9 (probe6 preserved):** event-ingest ids keep the injected-clock mint semantics (the G-a probe6 fix) — the consolidation changes WHERE the table lives, not the mint rules.
- **F-M10 (file map correction):** changed-files = worker-contract.mjs (NEW), harness-shim.mjs (NEW), cc-adapter.mjs (NEW), conformance-cc.mjs (NEW), run-sim3.mjs (NEW), test-worker-contract.mjs (NEW) + worker/turn.mjs, conductor/turn.mjs, conductor.yml, worker.yml, lib/fsm.mjs, lib/conductor-core.mjs, lib/store.mjs, lib/event-ingest.mjs, briefs/project.md (NEW).
