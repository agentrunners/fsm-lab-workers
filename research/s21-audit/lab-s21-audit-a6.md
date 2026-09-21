# S21 deep audit — lens a6: THE TEST PROCESS (the production-grade gap map)

Repo: /home/z/fsm-lab @ c146bcc (clean tree, read-only audit; no commits, no pushes).
Yardstick: /home/z/my-project/agent-briefs/s21-audit-criteria.md (8 criteria). Brief: agent-briefs/s21-a6.md.

---

## §1 Files audited

**The test estate (14,090 lines against 9,069 production lines — 1.55:1):**

| File | Lines | What it pins |
|---|---|---|
| tests/test-fsm.mjs | 1105 | transition matrix, invariants-after-every-step, dedup ring, stale/orphan/poison/quarantine, rebuild, lease-reaper ladder, INFRA_RETRY_MAX net-zero |
| tests/test-store.mjs | 1098 | CAS optimistic concurrency, 3-way-refresh, journal rotation + bounded growth, corruption recovery via history walk, concurrent-writer survival |
| tests/test-conductor-core.mjs | 872 | conductorTick: noop gate on accumulated journal, unified reset, control-first drain, repair-forces-commit, invariants fail-closed, bad-line REJECTED; intake rollover + F-1 twin-reset guard (612-721) |
| tests/test-gc.mjs | 726 | GC pure plan/touchlog/knobs, git-lane runTranscriptGc on real bare repos, adapter e2e scan.mjs placement (F-15a — **2 pins rotted, see T1**), charter source-shape |
| tests/test-taskbranch.mjs | 692 | envelope↔spec.artifacts, pushTaskBranch on local bare remote, read-back verifier branches, escalation composer, task-pr flow (reuse lanes, token ladder, stamp two-commit) |
| tests/test-cc-adapter.mjs | 667 | lane algebra (key pool × model chain, key-major flatten), F-M8 env at SPAWN boundary (CC_FAKE_LLM), deadline group-kill, rotation, lane_attempts bound, transcripts-before-report, door governance |
| tests/test-console.mjs | 680 | parseConsoleCommand matrix, consoleQueueRecord shapes, runConsole gate order + fail-closed permission, drain parity |
| tests/test-worker-routing.mjs | 629 | runTurn full offline (injectable fetch/enqueue/sleep/clock): law-1 gate, mode routing, classify-before-enqueue, door flip, enqueue-failure hardening, hop_telemetry |
| tests/test-budget.mjs | 449 | F-10 dispatchBudget (0/1/null), F-6 window arithmetic (distinct counting, aging, backstop), F-7 pause/resume+rebuild parity, F-9 verify-skip-on-hold, specToTask |
| tests/test-w2-conductor.mjs | 492 | assembleDispatchPayload superset, law-4 flip + verifyScanRunsPath, pacingFloorDecision, twin-reset epoch guard |
| tests/test-worker-contract.mjs | 525 | envelopeFromDispatch legacy-compat, writeBackDoor pathspec governance, classifyOutcome five-class + F-M4/E11 markers, MINT_TABLE re-export |
| tests/test-ar-overflow.mjs | 368 | dispatchLadder routing params + saturated marker (fake api), workerOverflowDecision pure matrix, composed routing fixture, source-string wiring pins, report routing on REAL two-repo git |
| tests/test-pinger-watch.mjs | 436 | tick-pinger marker (active/held/duplicate/contrast), chainContinuationDecision, rebuild narrowing parity, duty predicates + 45-min window + comment format |
| tests/test-intake.mjs | 280 | parseSpecBlock/validateSpec full matrix, doorDecide decision table (fail-closed), bodySha8 |
| tests/test-key-pool.mjs | 305 | FNV-1a published vectors, M5 rotation (429/401/402), empty-pool byte-identity, pool precedence, M6 CLI-env exclusion, B1 YAML env line |
| tests/test-lane-telemetry.mjs | 216 | laneLogLine JSONL shape, parse/aggregate, collectLaneStats fs contract, composeReportOutcome allowlist seam, drain carry, console LANE section, hop_telemetry |
| tests/test-cc-bridge.mjs | 472 | bridge vs mock upstream: raw-socket unparsable target (M-2), model pin (M-3), BRIDGE_AUTH, models endpoints (m-7), beta/client-auth-never-forwarded (m-8), 32MB cap, SSE passthrough |
| tests/test-watchdog-core.mjs | 235 | breakerDecision latch arithmetic, alertDedup, LATCH_REPRIMES, clock-exact fixtures |
| tests/test-harness-shim.mjs | 247 | determinism law (byte-identical), every behavior shape, wb-violation illegal refs enumeration, legacy aliases, seedFromRunId |
| tests/test-realwork-deadmodel.mjs | 71 | 400/404 model-slug fallthrough → config-infra class |
| tests/test-ttl-sync.mjs | 98 | the X21 lesson institutionalized: cross-YAML TTL coupling asserted structurally |
| worker/conformance-cc.mjs | 439 | C3 parity: shim vs adapter through the REAL spawn boundary (argv+env echo, rotation, attempts bound, deadline kill) — 26 checks |
| sim/run-sim.mjs | 373 | 8 scenarios: happy/dup/stale/dropev/crash/cas/grow/infra (GHA mocked away entirely, real Store+fsm on local git) |
| sim/run-sim2.mjs | 660 | 7 scenarios through gha-shim physics: actions-drop (+sabotage lane), queue-cancel (run-per-report loss vs git queue), dep-deadlock (18-task real project), control-cancel, payload-shape (frozen live fixtures), lease-margin (X14 formula), scale-200 |
| sim/run-sim3.mjs | 652 | 31 checks: the FSM↔shim conformance loop (matrix of every behavior to its designed terminal), law-1 short-lease gate, law-4 dropped-dispatch verify flip |
| sim/run-sim4.mjs | 428 | 51 checks: the W-C1 arcs — happy-pause, window-boundary, distinct-counting, single-ladder, pause-inflight, alert-failure self-heal, reset-vs-queue, rollover, re-run, budget-arithmetic |
| sim/gha-shim.mjs | 208 | the substrate physics model: ConcurrencyGroup (depth-1 newest-wins, ~24s cancel propagation) + DispatchLane (164s latency, drop, 403-fail-fast) + mulberry32 |
| sim/harness-shim.mjs | 292 | the deterministic contract implementer (8 behaviors + legacy aliases, seeded, the 'hang' marker dual contract) |
| scripts/validate.sh | 50 | the local gate: YAML parse, node --check, unit tests, sim+sim2; smoke opt-in (FSM_SMOKE=1) |
| scripts/smoke-conductor.sh | 218 | REAL conductor adapter vs local bare origin, 5 cases (zombie drain+quiesce, running wake, corrupt-tip heal, control pause/resume, TTL-budget skips), offline via dead-proxy |
| EVIDENCE.md | — | the X-series drill records (X1–X25) — the manual truth ledger |

**Baseline re-run TODAY (2026-09-21, fresh checkout):** unit **477/479** (2 FAIL — T1 below), sim1 8/8, sim2 7/7, sim3 31/31, sim4 51/51, conformance-cc 26/26. The worklog's "479/479" was true at merge time (09-19); the suite has since rotted (T1) — and nothing caught it (T2).

---

## §2 Findings table

| ID | Sev | file:line | Gap vs the yardstick | Remedy | Eff |
|---|---|---|---|---|---|
| **T1** | **BLOCKING** | tests/test-gc.mjs:656, :706; watchdog/scan.mjs:328 | **The gate is red TODAY on a fresh checkout.** The F-15a adapter-e2e pins spawn the REAL scan.mjs, whose main() hardwires `now: Date.now` (scan.mjs:328 — the injectable `now` of runTranscriptGc is not threaded through), while the transcript fixtures are frozen at NOW=2026-09-13 (test-gc.mjs:37). The "fresh" fixture pair (NOW−1h) aged past the 7-day GC window on 2026-09-20T11:00Z → scan deletes 6 not 4 → `GC-TRANSCRIPTS deleted=4 retained=8` asserts fail. Criterion 6 (a gate that can be trusted) is broken at its root: a permanently-red suite either blocks all merges or trains the team to ignore red. | Clock injection at the adapter boundary: `FSM_TEST_NOW_MS` env read in main() (one line, mirrors the pure-layer discipline), or mint fixture dates relative to `Date.now()`. Re-pin with the deterministic clock. | S |
| **T2** | **MAJOR** | .github/workflows/ (9 files, none CI) | **No CI exists.** No workflow runs validate.sh on push/PR (grep: zero refs). The whole 602-assertion estate is local discipline + the merge ritual. This is precisely what let T1 rot silently for 2+ days, and what let the s17 "2/5 pins were lies" class survive until hand mutation. Criterion 6 "production-grade test process" demands the gate run where merges actually land. | `.github/workflows/ci.yml`: on push/PR to main → `bash scripts/validate.sh` with FSM_SMOKE=1 (ubuntu-latest has git+python3-yaml; ~10–15 min). Later: nightly stage (stress quick + e2e local). | S |
| **T3** | **MAJOR** | scripts/validate.sh:6 vs :37-40 | **The gate doesn't run what its own header claims.** Header: "the offline simulations (run-sim + run-sim2 + run-sim3 + run-sim4)"; body runs ONLY run-sim.mjs (:37) + run-sim2.mjs (:40). sim3 (31 checks), sim4 (51 checks) and worker/conformance-cc.mjs (26 checks) are ritual-only — invoked by hand, per the worklog's four-part "479/479 + VALIDATE-OK + sims + conformance 26/26" incantation. A contributor running validate.sh gets VALIDATE-OK with the contract-conformance and W-C1-arc layers unexercised. | Three lines: `node sim/run-sim3.mjs \|\| fail=1`, `node sim/run-sim4.mjs \|\| fail=1`, `node worker/conformance-cc.mjs \|\| fail=1` (+ fix the header). | S |
| **T4** | **MAJOR** | EVIDENCE.md:399-414; tests/sim (absent) | **The straggler race (the twice-observed false-pause) has ZERO automated coverage.** "straggler" appears in no test or sim (grep: EVIDENCE.md only). The shape — pause → resume clears window → in-flight 9-min grinds' quota reports land post-resume → window re-populates → second BUDGET_PAUSE_ALERT (live-observed 2×: X23 + the s20 close's 4th straggler-pause) — is exactly the class a regression pin exists for, and the eventual fix (a1's C-3 in-flight-cohort condition) has no test to flip. | sim4 scenario 11 (characterization): drive pause→resume with 2 in-flight quota leases reporting post-resume; assert today's double-pause honestly (pin the current behavior + a `// FLIP-ME` marker), flip when C-3 lands. | S |
| **T5** | **MAJOR** | e2e/ (does not exist); scripts/smoke-conductor.sh:9 (opt-in) | **No automated e2e drill harness** — the yardstick's named GAP. The X-series (X15–X25) is manual orchestrator work: dispatch, watch runs, ls-remote, verify, comment. smoke-conductor.sh is the nearest artifact but covers only the conductor plane, is opt-in (FSM_SMOKE=1, off by default), and cannot exercise the issue→door→epoch→PR→completion loop (X22's one-pass criterion) or the worker/intake/ops planes. Nothing rehearses recovery (X15/X16) or the budget arc (X23) end-to-end without an operator. | Build `e2e/drill.mjs` — the design in §5. | L |
| **T6** | **MAJOR** | stress/ (does not exist); sim/run-sim2.mjs:615 (scale-200) | **No stress/soak/chaos battery** — the yardstick's named GAPs. Grep: zero soak/chaos/burst harnesses. sim2's scale-200 is the nearest (200 deps-free `succeed` tasks — throughput, no failure pressure). Nothing characterizes: 12-task burst under the real cap, key-pool exhaustion arcs (X23's only proof is one live night), dead-key storms, journal flood past 20 rotations, 30-day held-chain soak. | Build `stress/run.mjs` — the design in §6. | M/L |
| **T7** | **MAJOR** | sim/gha-shim.mjs:59-208 | **The GHA 5-parallel cap + scheduler contention is modeled nowhere.** The shim models per-group depth-1 newest-wins only; there is no repo-wide concurrent-run cap, no cross-workflow contention (conductor tick + watchdog + N workers competing for 5 slots). sim2's scale-200 runs max_parallel=32 unencumbered. Yet the cap IS the live physics that motivated the AR overflow (a1 C-2) and X21's pacing — the overflow trigger conditions (`saturated`, in-flight ≥ 6) are unfalsifiable offline today. | `ParallelCap` class in gha-shim (per-repo run slots, queued-when-full, starvation counter) + a contention scenario driving the conductor's own self-tick under worker saturation (assert: backstop never starved >K ticks). | M |
| **T8** | MINOR | repo-wide (no mutation ledger) | **The mutation-check discipline is not institutionalized.** The s17 lesson (2/5 pins were lies) lives in worklog prose only. My 3 spot-checks (below, §7) all bite — the W-C1/AR/W-C3 waves are honest — but there is no recorded ledger, no scripted runner, so future waves depend on the author remembering. | `docs/test-discipline.md`: the mutation protocol (invert the guarded line, run the file, record bite/no-bite per pin) + a PR-checklist row; optionally a seeded weekly mutation sampler in CI. | S |
| **T9** | MINOR | conductor/turn.mjs:84, watchdog/scan.mjs:52, intake/turn.mjs:29,56, ops/turn.mjs:47 | **Adapters hardcode `https://api.github.com`** — no GITHUB_API_URL seam, so no local e2e can drive the REAL adapter I/O with scripted API responses (smoke must dead-proxy the network instead, smoke-conductor.sh:16-21). The git side already has its seams (CC_TASKBRANCH_ORIGIN cc-adapter.mjs:529, FSM_SESSIONS_ORIGIN scan.mjs). Prerequisite for T5's local mode. | One line ×5 files: `const API = process.env.GITHUB_API_URL \|\| 'https://api.github.com'` (GHA sets this env itself — behavior on live runners is byte-identical). | S |
| **T10** | MINOR | lib/worker-contract.mjs:411; tests/test-worker-contract.mjs:401 | **The E11 error-marker check lacks a realistic false-positive pin.** The only negative pin is one benign string ('all good, no markers here'). No pin covers a done whose ANSWER legitimately contains "rate limit"/"unauthorized" (this repo's own task vocabulary — a2's W4: false infra-class → net-zero ×3 → quarantine of GOOD work). Any fix has no regression target. | Negative fixtures: a good answer whose text discusses rate limits/unauthorized keys → must stay `done`. | S |
| **T11** | MINOR | tests/test-ar-overflow.mjs:250-265; conductor/turn.mjs:388-405 | **The adapter's dispatch composition is pinned only as source strings.** turn.mjs is unimportable, so the AR wiring test asserts substrings — and a1's C-2 double-dispatch bug lives exactly BETWEEN those strings (the post-204 in-flight arm ordering), invisible to the pin. Same story for the law-4 single-repo scan (C-1): the composed pin covers the saturated shape only. | Either extract the dispatch site into lib/ (the dispatchLadder pattern, one more fold) or land T5's local mode (which executes the real turn-file against the ghapi stand-in — the composition becomes observable). | M |
| **T12** | NICE | scripts/validate.sh:33 | `node --test … \| tail -4` hides everything but the last 4 lines — on failure, which tests failed (and the counts) are invisible in the gate's own output. | `tail -40` + echo the summary; or the CI reporter. | S |
| **T13** | NICE | sim/fixtures/github-events.json | The payload-shape fixtures are a frozen hand-curated set (no pinger wake, no TARGET_REPO worker run-name, no ops-console trigger shapes). New event classes require manual additions; nothing guards the fixture schema against drift. | Add the missing shapes when T5 lands (the drill consumes the same fixtures); a tiny schema check in the payload-shape scenario. | S |

**Severity roll-up: 1 BLOCKING · 6 MAJOR · 4 MINOR · 2 NICE.**

---

## §3 The 3 findings that most block production-grade

1. **T1 — the rotted gate.** Production-grade starts with a gate whose green MEANS something. Today `node --test tests/*.mjs` fails on a fresh checkout of the blessed commit — not because the code regressed, but because two adapter-e2e pins depend on wall-clock time crossing a fixture boundary. Every downstream claim ("all gates green") is now unverifiable-by-default. The fix is one line of clock injection; the meta-fix is T2.
2. **T5 — the missing e2e drill harness.** The principal's demand names e2e explicitly. Every integration truth in this system — the X-series, the recovery drills, the budget arc, the one-pass dogfood loop — is operator memory. A system whose only integration proof is manual ritual is one staffing gap away from having no integration proof. The design (§5) is ready to build: the hard prerequisites are already in the tree (gha-shim physics, harness-shim behaviors, the smoke's mkclone geometry, the fixtures, EPOCH_MODE=mock making live runners deterministic) — the only real lift is the ghapi stand-in + the one-line API seam (T9).
3. **T6 + T7 — the missing stress battery and the unmodeled 5-parallel cap.** Capacity claims (criterion 4) currently rest on one live night (X23) and one unencumbered 200-task sim. The overflow lane — the capacity multiplier — cannot be triggered offline at all because the saturation physics don't exist in the shim. Until the stress battery exists, "characterized concurrency limits" and "enforced quota arithmetic" are prose, not process.

(T2/T3 — CI + the gate's own drift — are the force multiplier: they're what keep T1-class rot from ever again surviving a weekend. S effort each; land them with T1.)

---

## §4 What is already production-grade (honest inventory)

- **The mock-first layering is genuinely excellent and rare**: pure decision cores (every lib/ module) → git-lane tests against REAL local bare repos ("no mocks on the transport path" — test-store/test-gc/test-taskbranch/test-ar-overflow) → adapter e2e spawning the REAL scan.mjs/turn.mjs → physics sims → a conformance PARITY suite through the REAL spawn boundary. This is the architecture production houses aspire to.
- **Determinism engineering**: seeded mulberry32 everywhere (ONE implementation, exported from gha-shim), virtual clocks in every sim, byte-reproducible verdicts (pinned by JSON.stringify equality), FNV-1a verified against PUBLISHED test vectors, commit dates minted via GIT_AUTHOR_DATE — the reproducibility discipline that makes "a test that proves the test" possible.
- **The sabotage-lane pattern** (sim2 actions-drop: wrap conductorTick, drop out.actions, ASSERT the run fails) — mutation discipline embedded IN the suite, not just around it.
- **The TTL-coupling test (test-ttl-sync)** — a live incident ($X21 hot-fix 3: three hand-synced constants, 245/245 green while real turns wall-died) converted into a structural cross-file pin. Exactly the right institutional response.
- **The conformance-cc spawn-boundary proof**: argv + full env contract + rotation + group-SIGKILL deadline verified through a real process boundary with a fake CLI — 26/26.
- **Pin density and honesty**: 479 unit pins + 123 sim/conformance checks over 9,069 production lines; my 3 mutation spot-checks (§7) all bite; the wave authors' claims ("+N pins") are real pins, not vapor (unlike s17).
- **Failure-injection breadth in the estate**: every failure class in the taxonomy has SOME pin — 429/401/402 rotation, 400/404 model fallthrough, empty-completion, content-poison (wb-violation), deadline/hang, CAS races, corrupt-tip recovery, dropped dispatches (law-4), dedup'd redeliveries, infra-flap net-zero. The taxonomy's test coverage is the strongest of the 8 criteria.
- **The X-series evidence ledger** — EVIDENCE.md is honest live-truth prose (wrinkles recorded, not hidden). As MANUAL process it is exemplary; as PROCESS it is the gap (T5).

---

## §5 THE E2E DRILL HARNESS — the design (the deliverable, to be built next)

### 5.0 The boundary decision (what sits where)

Three modes, one codebase. The boundary between them is the answer to "what can the shim own vs what needs live GHA":

| Truth | local | staged | live |
|---|---|---|---|
| CAS/git state, queues, journal | REAL (local bare origin) | REAL | REAL |
| Adapter I/O composition (turn-files) | REAL (child procs) | REAL | REAL |
| Event routing (event-ingest, fixtures) | REAL (EVENT env) | REAL | REAL |
| Worker behavior | harness-shim (EPOCH_MODE=mock) | harness-shim (same, on real runner) | real |
| GH API surface (issues/comments/PRs/runs) | ghapi stand-in (T9 seam) | REAL | REAL |
| Dispatch→run latency, concurrency physics | modeled (gha-shim + ParallelCap) | REAL | REAL |
| PAT-comment trigger law, 5-parallel cap, minute quota, runner cold-start, pagination | NOT | REAL | REAL |
| Paid-LLM lane | NOT | optional hook (--cc, one turn) | quiesced-read-only by default |

**Verdict: the boundary sits at the workflow yml files + the five turn-file adapters.** local mode executes everything above the yaml; staged mode adds the substrate truth; live mode is a read-only canary (quiesced chain + pinger markers — never an armed dispatch without an explicit flag). Cadence: local on every push (CI, ~2 min), staged nightly + pre-release (~20 min, mock epoch = $0 LLM), live weekly canary.

### 5.1 The one command

```
node e2e/drill.mjs [--mode local|staged|live] [--scenario x22|budget-pause|recovery|overflow|quiesce|all] \
                   [--seed N] [--keep] [--timeout-min 30] [--cc]
→ exit 0/1 + e2e/out/drill-<ts>-<scenario>.json (the DRILL-REPORT: per-phase assertions + per-hop latencies)
```

### 5.2 The modules

- **e2e/lib/ghapi.mjs — the GitHub API stand-in** (local mode's cloud). An http server on 127.0.0.1 implementing EXACTLY the surface the adapters call (inventoried from the tree):
  `POST /repos/:r/dispatches` (conductor self+worker, watchdog re-prime, intake wake, ops) · `GET /repos/:r/actions/workflows/{conductor,worker}.yml/runs?per_page=N` (law-4 verify + watchdog scan + worker verify) · `GET/POST /repos/:r/issues[?state=open&labels=fsm-watchdog-alert]` (alert open/search) · `POST /repos/:r/issues/:n/comments` (alerts, epoch-started, completion digest, intake acks) · `GET /repos/:r/issues/:n/comments?per_page=20&sort=created&direction=desc` (alert-dedup marker scan — law-20 pagination REPRODUCED: >20 comments pushes the newest marker off page 1, the a3/A2 shape becomes drillable) · `GET /repos/:r/collaborators/:u/permission` (door trust) · `POST /repos/:r/pulls` + status (task-pr flow). Every request logged as JSONL (the e2e telemetry — assertion food + criterion-3 blind-spot checks). Scenario-scripted responses (403-no-RA, 429+RA, 5xx windows, comment-flood).
  Requires **T9** first: `GITHUB_API_URL=http://127.0.0.1:PORT` in the spawned env (one line ×5 adapters; on real runners GHA sets this env to the same URL the code hardcodes — byte-identical behavior).
- **e2e/lib/scheduler.mjs — the mini-GHA** (local mode's runner fleet). Consumes the ghapi dispatch inbox; models per-workflow ConcurrencyGroup (reuse gha-shim verbatim) + **repo-wide ParallelCap(5)** (T7's new class: slots, queue-when-full, starvation counter) + dispatch→run-start latency (default 164s, live-measured X5 datum, compressible via --clock-scale) + timeout-minutes enforcement (SIGKILL the child). At run-start it spawns the REAL turn-file: `node conductor/turn.mjs` with `EVENT=<fixtures shape>`, `GITHUB_API_URL=…`, `GITHUB_REPOSITORY=local/fsm-lab`, `GITHUB_RUN_ID=<ledger id>`, `JOB_TTL_MIN`, dead proxy for anything unplanned. Workers spawn `node worker/turn.mjs` against a seat checkout whose origin is the staged bare repo (the AR mkTwoRepos geometry), `EPOCH_MODE=mock` → harness-shim behaviors for free, `CC_TASKBRANCH_ORIGIN`/`FSM_SESSIONS_ORIGIN` pointed at local bare repos.
- **e2e/lib/world.mjs** — repo factory (smoke's mkclone generalized): the state repo + the second bucket (AR) + fsm-sessions + task-branch remotes; env/vars assembly; the virtual-or-real clock; teardown (--keep for forensics).
- **e2e/phases.mjs** — the 8 phase gates (below), each = preconditions + spawn/wait + assertions on REAL git state (tip shas, queue lines, journal tails via Store/readJournalTail) + ghapi ledger.
- **e2e/staged.mjs / live.mjs** — the real-API drivers (PAT client; template-push a private throwaway repo from main@<commit>; set vars/secrets incl. deliberately-dead keys for quota shapes; poll run lists; identical phase gates against the real ledger).

### 5.3 The drill phases (scenario `x22` — the full loop; others subset)

1. **BOOT** — world up (repos + ghapi + scheduler + worktree at the audited commit). Assert: ghapi ledger empty, tips seeded.
2. **GENESIS/INTAKE** — open the intake issue (ghapi: a real-user-shaped author) carrying a fenced `fsm-task` spec (behavior `fast`, 2 artifacts). Assert: intake run fired (scheduler ledger), ack comment landed, `state/intake-queue.jsonl` carries the line (byte-exact body_sha8).
3. **EPOCH** — drive one conductor tick (schedule wake or the rollover path). Assert: GENESIS/CHAIN journal record, genesisSpec slim shape, epoch-started comment on the issue, worker dispatch accepted, lease assigned + envelope shape (assembleDispatchPayload output in the dispatch ledger).
4. **WORK** — scheduler starts the worker run at +latency. Assert: law-1 gate passes (envelope deadline sane), shim turn runs, transcripts BEFORE report (fsm-sessions + task branch exist), report line on reports-queue with attempt-scoped event_id.
5. **DRAIN/VERIFY** — next tick. Assert: report applied (done), task branch read-back, PR opened (ghapi pulls ledger) with the m-3 body, completion comment on the intake issue with the digest + PR link (the X22 one-pass criterion), milestone/phase advance.
6. **HALT+QUIESCE** — drain to halt. Assert: STOP_CHAIN filtered from actions, halt journal record, schedule-backstop wake → QUIESCED (tip frozen, no self-dispatch), watchdog scan green, GC ran (F-15a placement: GC precedes halted exit), alert issue NEVER opened.
7. **(scenario) budget-pause** — the X23 arc automated: 3 tasks with `infra-flaky`-quota behaviors → assert alert-first ordering (issue BEFORE pause commit — ghapi ledger timestamps), pause lands, zero post-pause assigns, resume control → **the straggler characterization**: 2 in-flight quota reports land post-resume → assert today's re-trigger honestly (T4's pin, `// FLIP-ME` when C-3 fixes).
8. **(scenario) recovery** — X15/X16 automated: corrupt the tip (the smoke c3 plumbing commit) → watchdog scan → alert opens + marker comment → 24h-dedup skip on the SECOND scan (law-20 pagination exercised at >20 comments) → re-prime dispatch → history-walk heal → tip advances.
   **(scenario) overflow** — X26 automated: ParallelCap(5) saturated by 6 workers → assert the AR re-target fires (dispatch ledger shows the second bucket call on the PAT) + report routes back to the target repo's fsm-state (the mkTwoRepos assertion) — AND the a1 C-2 double-dispatch becomes VISIBLE (the ledger shows both buckets getting the same lease — this drill is the C-2 regression pin).
9. **REPORT** — drill-<ts>.json: per-phase PASS/FAIL + **per-hop latencies measured real** (dispatch→run-start, tick→commit, report→drain — criterion 4's documented cadence costs, now regression-pinned per run).

### 5.4 What this design needs before it builds

T9 (the API seam, 5 lines) · T7 (ParallelCap in gha-shim) · T1's clock-injection pattern generalized (the drill passes the same env to spawned adapters so drill runs are reproducible). Everything else already exists in the tree. Estimated L: ghapi stand-in is the bulk (~400 lines; the surface is small and fully enumerated above).

---

## §6 THE STRESS BATTERY — the design (the deliverable, to be built next)

### 6.0 The one command

```
node stress/run.mjs [--battery burst12|quota-wall|dead-key-storm|journal-flood|soak30d|chaos|all] \
                    [--quick] [--seed N] [--json out/stress-<battery>.json]
→ STRESS-RESULT <n>/<n> checks + a per-battery JSON (metrics + assertion matrix); --quick = the CI subset (<60s each)
```

Discipline: offline (virtual clock + seeded rng — the sim law), every battery = fixtures + driver + assertions + METRICS (the characterization is the deliverable: numbers pinned as bounds, not vibes).

### 6.1 The six batteries

1. **burst12** — the X21 shape automated: 12 tasks spawned at t0, max_parallel=4, ParallelCap(5) LIVE, seeded worker durations (two 9-min grinds). Asserts: the conductor's own self-tick never starves >2 consecutive windows under worker saturation (the starvation counter); zero CAS losses across 12 concurrent report enqueues (ledger diff: every report applied exactly once); dispatch pacing within dispatchBudget; drain-time bounded (pin the baseline: ticks-to-drain ≤ N). Metrics: dispatch-queue depth curve, ticks-to-drain, slot-wait histogram.
2. **quota-wall** — the X23 arc parameterized: a **PoolLane** model (new, ~60 lines: per-key daily counters, 429+Retry-After with `X-RateLimit-Remaining: 0` headers after Q calls, 200s before). Drive a 24-task epoch over N keys × Q quota (e.g. 68-key pool, all exhausted by t0+3 tasks). Asserts: rotation visits keys per the FNV pick (coverage = pool size), the budget-pause fires at exactly `budget_pause_threshold` distinct tasks, alert-first order, zero work-ladder burn (attempts === 1 per task until the wall), resume-on-fresh-key drains clean. Parameterized (keys × quota × tasks) — the nightly sweep.
3. **dead-key-storm** — all keys 401 from t0. Asserts: per-turn lane_attempts bounded at 3, infra-exhausted quarantine with the distinct audit detail, AND two CHARACTERIZATION pins for the a2 findings: the KEY_2-unreachable shape (W1: key-major flatten × lane_attempts:3 ⇒ lanes 2+ never serve — the battery counts distinct keys actually used, pins today's wrong number, `// FLIP-ME` on the W1 fix) and the no-cross-turn-memory re-land count (W3: the hash-stable pick re-lands the same dead key every turn — counted, bounded-3-verified).
4. **journal-flood** — 10k events in one epoch (rotateAt=500): asserts readJournalTail correct across ≥20 rotations (numeric gen ordering under pressure), dedup-ring eviction absorbing a 100-report redelivery storm, **pinger-marker noise does not drown LANE_JOURNAL_WINDOW=64** (markers every 15min-virtual for 30d + 20 rec/tick epoch traffic — the a3-A4 kind filter holds), and the **alert-dedup pagination break characterized**: >20 comments on the alert issue → the law-20 skip never fires → duplicate-alert count pinned (a3/A2's `// FLIP-ME` for the since= fix). Metrics: retained bytes vs journal_seq curve (bounded), state.json bytes.
5. **soak30d** — 30 virtual days: pinger markers at the MEASURED 2-4h cadence (not nominal 15min — the a3 live datum), watchdog scans every 10min, one epoch with slow tasks, chain HELD 5 days mid-epoch, resume, drain to halt. Asserts: state bytes bounded (<25KB), zero false latch fires, GC cadence honored, and the headline metric — **the false-alarm count for PINGER_STALE_AFTER_MIN=45 against measured cadence** (a3-A1 quantified: expected ~12+/day false alerts; the number becomes the fix's before/after).
6. **chaos** — the kill-mid-flight battery: a seeded **KillScheduler** SIGKILLs adapter children at the dangerous boundaries — {pre-commit, post-commit-pre-dispatch (the crash class), mid-report-enqueue (the dup class), post-taskbranch-push-pre-report, mid-PR-flow} — 50 seeded kills across one epoch. Asserts the invariants that matter: every task reaches EXACTLY ONE terminal state, zero lost reports and zero double-applied reports (the report ledger diff), recovery path fires on the wedged shapes, final halt reachable. Process-level so not byte-deterministic, but seed-reproducible (the kill schedule is a function of the seed). This is the yardstick's chaos/kill-mid-flight GAP closed.

### 6.2 Gate wiring

- `--quick` subset (burst12, quota-wall small, journal-flood short): into validate.sh + CI (T2/T3's fix rides along).
- Full battery nightly (soak30d compressed to <5 min virtual; chaos full 50 kills).
- The stress JSONs accrue to `e2e/out/` — the capacity/economics evidence base (criterion 4/5's "documented and ENFORCED" becomes "measured and pinned").

### 6.3 Build order (dependencies)

T9 seam → ghapi stand-in (shared with e2e) → ParallelCap + PoolLane models in/next-to gha-shim → burst12 + quota-wall (highest value: X21+X23 arcs) → journal-flood + soak30d (a3's findings quantified) → chaos (needs the scheduler's kill hook) → dead-key-storm (W1/W3 flips tracked to the a2 fixes).

---

## §7 Mutation spot-checks (3 pins, hand-inverted, reverted — tree clean)

Protocol: invert the guarded line in lib/, run ONLY the owning test file, revert (`git checkout --`), verify clean.

1. **AR wave — the overflow boundary** (lib/conductor-core.mjs:827 `if (inFlightNow >= at)` → `>`): **BITES.** `ar decision: saturation signal 2 — in-flight >= 6 … the boundary is >=` fails (the off-by-one at inFlight=6 is exactly what the pin guards; 12/13 tests in the file still pass — the pin is precise, not shotgun).
2. **W-C1 wave — the F-10 budget gate** (lib/fsm.mjs:571 `if (budgetNow <= 0)` → `< 0`, making the break unreachable since budgetNow is Math.max(0,…)): **BITES.** Two pins fail (`budget=0 → ZERO assigns` + `budget=1 → exactly ONE assign`) — the skip-left-assigned bug class the F-10 pins exist to kill is caught both at zero and at the boundary count.
3. **W-C3 wave — the pinger actor gate** (lib/conductor-core.mjs:696 `ev.actor === PINGER_REASON` → `!==`): **BITES.** Five pins fail — the halted-marker positive, the paused variant, the NON-pinger-silence contrast, the duplicate-wake silence, and the drain-then-marker case. The actor-keyed marker contract is pinned from every side.

**Mutation verdict: 3/3 honest.** The s17 lesson (2/5 pins were lies) is internalized in the W-C1/AR/W-C3 waves. The residual risk is procedural, not authored: nothing ENFORCES this for future waves (T8).

---

## §8 Coverage map — the 8 yardstick criteria × what covers them × the hole

| # | Criterion | Covered by | The hole |
|---|---|---|---|
| 1 | Correctness under concurrency | CAS: test-store (3-way refresh, concurrent writers), sim1 cas, sim2 queue-cancel lane-2 (every report applied\|dup), X13 manual. Idempotent retries: test-fsm dedup, sim3 dup-report, test-conductor-core unified reset. Lease/TTL: test-ttl-sync (cross-file coupling + ceiling), sim1 stale/dropev, sim3 late-first-report + law-1. Overflow: test-ar-overflow (pure decision, composed fixture, source pins, real-git report routing). | **Straggler race: zero coverage (T4).** The adapter dispatch composition (a1 C-2 double-dispatch, C-1 single-repo verify) is source-string-pinned only — the bugs live between the strings (T11). X26 concurrent-overflow unproven even live. |
| 2 | Failure taxonomy completeness | classifyOutcome matrix + F-M4/E11 (test-worker-contract), conformance parity (26 checks), sim3 matrix (every behavior → designed terminal), 429/401/402 rotation (test-key-pool), 400/404 model fallthrough (test-realwork-deadmodel), corrupt-state recovery (test-store, smoke c3, gc guard), law-4 non-trigger (sim3 + w2 pins), infra net-zero (sim1 infra, fsm INFRA_RETRY_MAX pins). | **E11 false-positive unpinned (T10)** — quarantine-of-good-work has no regression target. Alert-side dedup break at >20 comments pinned-as-accepted (test-watchdog-core.mjs:179) — the fix's target is only in the stress design. Journal-corruption adapter pins currently ROTTEN (T1). |
| 3 | Observability | lane_stats end-to-end (test-lane-telemetry: JSONL shape → collect → compose → drain carry → console section), bridge one-line-per-call (test-cc-bridge, incl. crash lanes), hop_telemetry (test-lane-telemetry/test-worker-routing/test-key-pool), journal events universal, console matrix (test-console). | No single test asserts the FULL chain for one task birth→halt (the drill's phase-5+9 job). Bridge pre-flight/guardrail console-only + real-lane token telemetry — a2's blind spots, unpinnable until surfaced. |
| 4 | Capacity & throughput | sim2 scale-200 (200 tasks, ~0.77KB/task envelope, 9.9s wall), lease-margin formula as executable assertion (X14), DISPATCH_COST_MS pinned (4s), dispatchBudget arithmetic (test-budget F-10). | **The GHA 5-parallel cap modeled nowhere (T7)** — contention/starvation unfalsifiable offline; the AR saturation triggers untestable. Per-hop latency = manual probes only (X1b/c, probe/hop.mjs) — no regression pin (the drill's report fixes this). Quota arithmetic pinned at unit level only — no exhaustion arc (stress quota-wall). |
| 5 | Economics | cost field in lane JSONL (pinned shape), budget-pause = the control (F-6/7/8 pinned incl. rebuild parity + alert-first), dispatchBudget = the ceiling arithmetic, laneSection aggregates per hop. | No epoch-level cost rollup pin; no hard-spend-ceiling test (nothing exists to pin — a5's lens); the X23 economics proof is one live night, not a battery (stress quota-wall's metrics). |
| 6 | Testability | 479 unit + 602 total assertions, 4 sim suites + conformance + smoke; mock-first at every layer (§4). | **The lens itself: e2e GAP (T5), stress/soak/chaos GAPs (T6), CI GAP (T2), gate drift (T3), rotted pins (T1), mutation discipline not enforced (T8).** |
| 7 | Operability | pinger duty canonical spec + predicates (test-pinger-watch, 15 pins), console command matrix, watchdog latch live-proven + pinned, recovery drilled (X15/X16 — manual). | Recovery procedures have NO automated rehearsal (drill scenario `recovery`); secrets rotation = X23's manual arc (drill `budget-pause` includes the rotate+resume shape); no standalone runbook files (embedded in design docs/EVIDENCE — a NICE, the drill doubles as the executable runbook). |
| 8 | Security/trust posture | Intake door fail-closed (test-intake doorDecide matrix: stranger/null-permission/bot), key hygiene (pool rotation pinned, M6 CLI-env exclusion, m-8 client-auth-never-forwarded, B1 env-line pin), bridge auth + 32MB cap, write-back door pathspec governance, artifact binding+cap at the door. | No cross-cutting "no secret in logs" pin (scrubbers exist ad hoc — the gc scrub is inline-untested); TOS-safe egress is the other repo's surface (out of tree, noted). The ghapi stand-in (T5) makes the door's API-shaped attack surface drillable (permission-shape fuzzing). |

**The verdict in one line:** criteria 2 and 8 are near-production-grade as PINNED code; criterion 1 is strong at the state layer with two adapter-composition holes; criteria 3/4/5 are pinned at the unit level but unmeasured as systems; criterion 6 — the test process itself — is the blocker: the gate is red today (T1), unenforced (T2/T3), and its integration/stress layers don't exist yet (T5/T6/T7).

---

*Read-only audit maintained: mutations reverted (tree verified clean @ c146bcc), no branches, no commits, no pushes. Deliverable: this file. The e2e drill harness (§5) and stress battery (§6) designs are build-ready: T9 + T7 are the only prerequisite code changes.*
