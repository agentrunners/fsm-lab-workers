# S21 ARCHITECTURE audit (lens a7) — the whole-system "distributed cloud harness on native GH constructs" verdict

Auditor: sub-agent 21-a7. Tree: fsm-lab main @ c146bcc (clean, read-only). Yardstick: agent-briefs/s21-audit-criteria.md.
Cross-lens inputs honored: a1 (conductor), a2 (worker/bridge), a3 (watchdog/GC/pinger), a4 (intake/task-PR) — their findings are cross-referenced, not re-derived.

---

## §1 Files audited

Code (read line/section-level): `.github/workflows/{conductor,worker,watchdog,intake,ops,ops-console}.yml`,
`lib/conductor-core.mjs` (dispatch loop, overflow, ladder, pacing), `lib/fsm.mjs` (CONFIG_BOUNDS, genesis defaults,
schedule pass, pruning), `lib/store.mjs` (CAS commit loop, rotation plan, queue discipline), `lib/event-ingest.mjs`
(wake router + MINT_TABLE), `lib/pinger-watch.mjs` (45-min window), `lib/worker-contract.mjs` (envelope budget),
`worker/turn.mjs` (key pool, real-lane chain), `worker/cc-adapter.mjs` (lane algebra, CLI pin), `conductor/turn.mjs`
(dispatch/overflow/PR-flow site), `intake/turn.mjs` (nudge).
Docs/evidence: EVIDENCE.md (all X-numbers cited below), T44-DESIGN.md, README.md, cc-gha-exploration HANDOFF.md §1/§2,
context/OPENROUTER-KEYS.md §S20, exploration worklog lines 1715/2014 (bucket limits), session-20 close (worklog.md).
Live read-only probes (no writes, no pushes): repo visibility/permissions for all 4 repos; workflow states on
`agentrunners/fsm-lab-workers` (9 workflows ACTIVE) and `xfnwfpho1/pinger` (1).

**A premise correction, evidence-first:** the brief's "main bucket 5-parallel" is contradicted by the corpus and by
live check. All of `claudecode-headless/fsm-lab`, `agentrunners/fsm-lab-workers`, `xfnwfpho1/pinger` are **public**
(API-verified this session); the operator's own red-team (exploration worklog:1715) names "the shared
claudecode-headless bucket hits the **20-concurrent** cliff" and :2014 "the org's 20-job bucket". X25: the mirror was
created public for "free minutes + its own 20-concurrent-jobs bucket". **The main bucket is the org-wide 20-slot
pool** (shared with the private `cc-gha-exploration` executor duties); the mirror org adds a second 20; the pinger
account is a third (trivial). All ceiling math below uses 20/20.

---

## §2 Findings table

| ID | Sev | file:line | Gap vs the yardstick | Remedy | Eff |
|---|---|---|---|---|---|
| ARCH-1 | **BLOCKING** | conductor/turn.mjs:388–405 + lib/conductor-core.mjs:820–829 (in-flight overflow arm ignores `d.ok`); conductor/turn.mjs:275 + lib/conductor-core.mjs:194–199 (`verifyScanRunsPath` called with main `REPO` only) | Capacity & throughput (#4): the 2-bucket capacity multiplier is unusable as merged. With deployed `WORKER_OVERFLOW_AT=1`, every multi-assign tick double-dispatches tasks 2..N to BOTH buckets (same payload/lease → duplicate ~9-min grinds + orphan reports); a repo2-only dispatch is invisible to the law-4 verify scan → false `dispatch-unverified` at 720s → infra churn → quarantine of live bucket-2 work. (= a1 C-1+C-2, architecture-level because it nullifies the bucket topology.) | Gate the in-flight arm on `!d.ok` (or decide overflow BEFORE the same-repo dispatch); make the verify scan repo-aware (`repo2` runs too). X26 then drills the real concurrent-overflow moment. | S–M |
| ARCH-2 | MAJOR | lib/fsm.mjs:115 (`max_parallel: 4` default), :86 (bounds [1,32]); lib/conductor-core.mjs:806 (`WORKER_OVERFLOW_AT_DEFAULT=6`, deployed 1) | Capacity (#4): the system idles at ~20% of its built capacity — the binding constraint is the FSM lease bound (4), not GHA (2×20 minus overhead ≈ 34–36). No guardrail aligns max_parallel/overflow_at with bucket capacity, and the r2 red-team's monitor-starvation kill (16×20-min workers FIFO-starving the 16s executor scan in the SAME org bucket, exploration worklog:1715) has no segregation. | After ARCH-1: `configure {max_parallel:16}`, `WORKER_OVERFLOW_AT≈12–15` (monitor-plane headroom stays free); document the ceiling formula; optionally a dedicated monitor repo/bucket if wide epochs become routine. | S |
| ARCH-3 | MAJOR | worker/cc-adapter.mjs:102–131 (key-major lane flatten; deployed CC_MODEL duplicates `CC_MODEL_CHAIN_DEFAULTS[0]` → 4 models/key), lib/conductor-core.mjs:145 (`lane_attempts: 3` in every dispatch budget) | Economics (#5) + failure taxonomy (#2): the paid CC lane has NO reachable redundancy — all 3 lane attempts ride `OPENROUTER_API_KEY` (or-074, **$9.06 left ≈ ~3,000 turns at §S20's $0.003/turn warm ≈ 30 days at 100 turns/day**); a drained primary quarantines every cc task via infra-exhaustion while `OPENROUTER_API_KEY_2` sits idle. (= a2 W1 — architecture-level because it converts the §S20 "cost converged, redundancy cheap" finding into a single point of fleet death.) | Interleave lanes key-alternating (k1m1, k2m1, k1m2…) or attempt-major per key; de-duplicate the CC_MODEL/defaults slot; optionally raise `lane_attempts` to 4–6 for the cc lane. | S |
| ARCH-4 | MAJOR | lib/pinger-watch.mjs:42 (`PINGER_STALE_AFTER_MIN=45` vs measured 2h00m–4h07m marker gaps, a3 live); watchdog.yml:15 + conductor.yml:42 (the only schedulers); xfnwfpho1/pinger = 1 account/1 PAT/1 repo/1 workflow (live-verified) | Operability (#7): the wake plane's watch-the-watcher matrix has two uncovered nodes (nobody watches the watchdog; nobody watches the executor duty host) and the pinger is a single-account SPOF. Compound worst case (a3-A3): pinger dead + executor dead + held chain → repo inactivity → GH's 60-day scheduled-workflow auto-disable → total silence, zero alerts. The 45-min threshold calibrated to a nominal */15 that measures 2–4h = a permanent false-alarm lane. | Second pinger account (a natural third-bucket use); recalibrate `staleAfterMin` to ≥5h or make the pinger cron honest; deadman on the watchdog + executor (an external/GitLab-side check — the r2 red-team counter). (= a3 A1/A3, endorsed at architecture level.) | M |
| ARCH-5 | MAJOR | tests/ (479 unit + 4 sim suites — no e2e harness); EVIDENCE.md X5b/X16–X18/X22/X23 (all drills manual, single-operator) | Testability (#6): the distributed system's actual integration surface — 2 org buckets, cross-org dispatch, live GHA semantics (queue delay, cancel propagation, rate limits) — has NO automated e2e/stress/soak/chaos drill harness. X26 (the concurrent-overflow seam) is itself unproven live. The four-layer local pyramid is excellent but stops at the sandbox boundary. | A drill driver repo/workflow that scripts the X-series shapes on cadence (issue→epoch→overflow→pause→resume→PR) against a disposable mirror, with pass/fail journals. | M |
| ARCH-6 | MINOR | agentrunners/fsm-lab-workers workflows (live-verified: conductor.yml + watchdog.yml + intake.yml + ops*.yml all ACTIVE with crons — the full stack, not a worker-only seat) | Correctness under concurrency (#1) / operability (#7): the mirror carries live conductor/watchdog schedules against its synced (stale) fsm-state → ~12 zombie runs/hour; benign while the synced state is halted (F2 quiescence), but a mid-epoch sync would give the mirror its own live chain → divergent state copies + double alert lanes. | Strip the mirror to worker.yml only (disable the other 8) or sync an always-halted state; the zombie burn itself is ~6–12 runner-min/hour on a free public bucket — the divergence risk is the real cost. | S |
| ARCH-7 | MINOR | lib/store.mjs:267 (full `state.json` rewrite per commit), lib/fsm.mjs:553–560 (task pruning — terminal only); a3-A9 (recovery walk ≤200 commits vs 2,000-record journal window) | Capacity (#4): the state plane's scaling law is real but undocumented in-repo: state.json is O(active tasks) ≈ 1.2KB/task live (22KB @ 18 tasks) → ~12MB/commit at 10K active tasks → tick wall grows → the single-writer chain slows; the recovery walk diverges from the journal window at hot-epoch scale. No cliff marker, no escape-hatch doc. | Document the law (state ≈ 1.2KB × active tasks; writers ≈ ≤30 comfortable); add a state-size signal to the watchdog scan; write down the per-epoch branch escape (`fsm-state/<chain.id>` — chain.id already in state) for the 10×+ future. | S |
| ARCH-8 | MINOR | conductor/turn.mjs:405 (all overflow dispatches ride `PAT`), lib/task-pr.mjs (PR ladder same PAT), worker.yml:82/139 (`TARGET_REPO` pushes same PAT) | Capacity (#4): one PAT actor concentrates every cross-bucket operation (dispatch ×N, PR opens, transcript/report pushes) against one account's secondary rate limits — at max_parallel=16+, the dispatch bursts share one actor's 429 budget. | A second PAT (bucket-3's companion) for the mirror lane; or pre-warm dispatch pacing. | S |
| ARCH-9 | NICE | ops/console.mjs status surface (no per-hop latency); worklog session-20 open item "hop_telemetry console rendering" | Observability (#3): the end-to-end latency budget (measured live, §5.6 below) is computed nowhere at runtime — the console cannot answer "why is my epoch slow" with hop data. | Render hop_telemetry (already journaled per lane) in console status. | S |
| ARCH-10 | NICE | lib/conductor-core.mjs:806 (default 6) vs deployed var `WORKER_OVERFLOW_AT=1` | Operability (#7): the deployed posture (1) is a test value that wastes the main bucket's ~15 free worker slots; the documented default (6) predates the ARCH-2 capacity math. Neither value reflects a characterized main-bucket capacity. | Set it from the ceiling formula post-ARCH-1 (≈12–15). | S |

---

## §3 The 3 findings that most block production-grade

1. **ARCH-1 (BLOCKING)** — the overflow lane double-dispatches and is verify-blind to bucket-2. Until fixed, the
   system's headline capacity claim (2 buckets) is architecturally inert and actively harmful under the deployed
   `WORKER_OVERFLOW_AT=1`; X26 walks straight into it.
2. **ARCH-3 (MAJOR)** — the paid lane's redundancy is unreachable at the dispatched budget: one drained key
   (~30 days of runway left) is a fleet-wide silent stop of all cc work, the exact "production customer files a P1"
   shape, for an S-effort fix.
3. **ARCH-4 + ARCH-5 (MAJOR, paired)** — the detection layer has unwatched watchers + a miscalibrated threshold, and
   the integration surface has no automated drills. Together they are the difference between "works in the lab" and
   "operable in production": the compound silent-death path and the manual-only drill discipline.

---

## §4 What is already production-grade (honest — don't churn)

1. **The state anchor: single `fsm-state` branch, CAS, disjoint rotation, consume-on-drain, quiescence, corruption
   walk.** Live-proven: 10 concurrent writers zero-lost (X3: slowest 31.1s; X13 under live contention 39.4s);
   2,000-record rotation exact at 500/gen × 4 (X6, a3 live gens 12–15); quiesced wakes FREE (X9: 10 wakes, 0 commits);
   corruption → history-walk recovery (X15); rebuild parity pinned. This is the RIGHT native construct at
   1×–10× scale (see §5.2 for the honest cliff).
2. **The wake topology: GITHUB_TOKEN `repository_dispatch` self-chain, data-through-git / wake-through-dispatch
   separation, watchdog re-prime + circuit breaker.** Zero-secret infinite chain at ~9–10s/hop (X1c, X2); the
   X2 bug-#2 lesson (reports CAS-append, dispatches are wake-only) is architecturally settled; the dead→detect→
   alert→human→re-arm→revive cycle closed end-to-end twice (X5b, X2-final). Alternatives are correctly rejected
   (workflow_run = hostile-input surface; schedule-only = measured ~2h sparse + 3.6h cold-start).
3. **The two-lane model economics + the §S20 routing policy.** Cache-converged ~$0.003/CC-turn warm (either flash
   model), cache survives relay IP rotation, deepseek primary/glm fallback is a competence/latency choice not a cost
   choice; the free pool (nemotron head, ~70 keys, hash-stable + rotate-on-quota/dead) is $0 and correctly confined
   to pass/fail real-lane shapes with the FSM absorbing its 500-windows; injection-resistance as a hard gate for
   untrusted surfaces is policy-recorded. The lane STRUCTURE is optimal — only its redundancy reachability (ARCH-3)
   is broken.
4. (Worthy mention) The five-class failure taxonomy with exactly-once report semantics and the F2/GITHUB_TOKEN-only
   intake door — per a2/a4, genuinely production-grade code.

---

## §5 The lens's quantitative answers (the brief's questions)

### §5.1 The compute plane — actual concurrency ceilings

**Ceiling = min(FSM lease bound, Σ bucket slots − overhead):**

- **Today (live config: max_parallel=4, WORKER_OVERFLOW_AT=1, ARCH-1 live):** ceiling = **4 concurrent CC turns**
  (dispatch 1 → main; 2–4 → mirror *and* main again via the C-2 double-dispatch — a 4-assign tick launches **7
  worker runs for 4 leases**, ~43% duplicate burn at ~9 min/grind each). Throughput ≈ 24–48 tasks/hour
  (5–11 min/task-slot incl. report+drain).
- **Post-ARCH-1, tuned (max_parallel=16, overflow_at≈13):** **16 concurrent turns** (≈13 main + 3 mirror; main then
  holds 13 workers + conductor + watchdog + intake/ops + the private-repo executor duties ≈ 17/20) ≈ **80–190
  tasks/hour**.
- **Absolute 2-bucket ceiling:** ~34–36 usable slots — the FSM's own bound (32, fsm.mjs:86) binds FIRST. **A third
  org adds ZERO capacity today**; it becomes worth +20 only for sustained >32-wide epochs — its real near-term value
  is ARCH-8 rate-limit isolation + ARCH-4 pinger de-correlation (a second pinger account), at ~1 session-hour
  integration cost (X25 precedent: repo + secrets parity + vars + sync).
- **Where the ceiling bites first:** the FSM bound, then the main org bucket (shared with the executor and the
  monitor plane — the r2 red-team starvation shape), then the single PAT actor (ARCH-8). The mirror's 20 slots are
  the most headroom-bearing and least contended.

### §5.2 The state plane — throughput ceiling and the honest cliff

- **Single-writer tick rate:** conductor turn ≈ 10s wall live (X2 "~10s/tick"; X1c 8.9s hop cadence) → theoretical
  ~300 ticks/h unpaced; the cc epochs' observed lease-paced cadence = 152 turns / 6.5h ≈ 23/h (X21-final). Each
  commit rewrites state.json (22KB live) + the current journal gen (≤500 recs ≈ 50KB) + queue deltas → **<100KB
  tree, ~25KB push per commit** — ~7 events/commit observed (X6: 286 commits / ~2,000 ids).
- **Report path does NOT serialize through the conductor:** workers CAS-append `reports-queue.jsonl` independently
  (store.mjs enqueue ladders, 5–8 attempts, jittered); the tick drains BATCH-atomic (X17: 8 reports in ONE tick).
  Drain ceiling ≈ 8+ reports/tick × 100–300 ticks/h ≈ **10²–10³ reports/hour** — two orders above any projected load.
- **Journal growth:** bounded by construction — 4 gens × 500 = 2,000 records ≈ 250KB steady-state on-branch
  (live-verified a3); tail reads bounded (numeric-gen ordering pinned); state.json grows with ACTIVE task count only
  (terminal pruning at 20 ticks, ~0.77KB compacted records).
- **The cliff (10×–100×):** state.json = O(active tasks) ≈ 1.2KB/task → ~12MB/commit at 10K active tasks → tick
  wall inflates → the ~10s chain becomes tens of seconds and the 45-min reaper margin erodes; simultaneously >
  ~30 simultaneous queue-writers exceed the 6–8-attempt CAS ladders (starvation class, 44-b's pre-jitter datum).
  **Escape hatch (documented, cheap): per-epoch branches `fsm-state/<chain.id>`** — chain.id already rides every
  genesis; writers already segregate by epoch. Issue-comments-as-events = NO CAS, no ordering — a regression.
  GH artifacts = 90-day TTL — rejected rightly (README:43). **Verdict: single-branch event store is the right
  native construct through ~10×; wedge at ~100×; the hatch is a naming change, not a redesign.**

### §5.3 The wake plane — latency per hop, live numbers

| Hop | Live number | Source |
|---|---|---|
| comment/issue → workflow triggered | ~1–3s | E7-class reply→fired 3s (HANDOFF §3) |
| dispatch POST 204 → run created | ~10s (worst 164s queued) | X1a; X5 |
| runner cold start → steps | ~5–20s (bounded by X8: 2-run arc = 77s total) | X8 |
| checkout + setup-node + CLI install | ~15–25s (install 4–9s npm; the ~7-min npx class is DEAD via pre-install, worker.yml:88–107) | X20, W2 |
| conductor turn (state+commit+dispatch) | ~10s | X2 |
| CC turn | 196s (T-107), 202s (T-101), 3–16+min research-y; ~9min quota-storm grinds | X21, X23, X20 |

- **The self-chain is the correct primary** (~9–10s/hop, zero-secret, quiescence-free-when-idle X9). The backstop
  ladder's honest physics: schedules cold-start ~3.6h then ~2h apart (~5% duty); the pinger's nominal */15 measures
  **2h00m–4h07m marker gaps** (a3 live, e2556–e2561). So effective revival latency for a dead chain: minutes
  (watchdog scan if schedule fires) to hours (pinger/schedule reality).
- **Pinger SPOF:** one account/PAT/repo/workflow (verified). Its deadman is the executor's duty-7 canary (3h) on the
  PRIVATE repo — itself unwatched (ARCH-4). A second pinger in a third bucket is the cheap de-correlation.

### §5.4 The model plane — two-lane economics vs §S20

- §S20: both flash models converge to **~$0.003/CC-turn warm** (cache discount ~4× vs one-shot; cache survives the
  relay's IP rotation at −20–30% engagement); or-074 = $9.06 ≈ **~3,000 turns**; or-075 dead.
- The free lane's 40–60% nemotron 500-window tax costs: 3 lane attempts × 60s aborts + INFRA_RETRY_MAX=3
  re-dispatches ≈ up to ~9–12 min/task of extra wall + alert noise (X23's straggler double-pause) — **$0 in dollars
  on free public runners**. It "costs more than it saves" only past an epoch SLA, or when infra-exhaustion
  quarantines cascade (X21's 12×3 burn against the daily wall — the extreme). The FSM's net-zero ladder absorbs it
  BY DESIGN; §S20.4's policy (free = pass/fail lane + supervised adjudication; NEVER latency-critical or untrusted
  input) is the correct discipline.
- **The economics verdict: the two-lane split is optimal.** The gap is ARCH-3 — the paid lane's failover is
  unreachable, so the "cheap redundancy" the §S20 economics assume does not exist at runtime.

### §5.5 The bucket topology

Covered in §5.1: main (org, 20, shared with the private executor + monitor plane) + mirror (org, 20, ~9 zombie
workflows burning ~6–12 runner-min/h, ARCH-6) + pinger account (trivial). **Third org: capacity +0 today; its value
is PAT rate-limit isolation + pinger de-correlation; ~1 session-hour to integrate (X25 precedent).**
`WORKER_OVERFLOW_AT=1` is right ONLY as the X26 test posture — the characterized production value is ~12–15
(main-bucket headroom for the monitor plane, per the r2 starvation kill).

### §5.6 The end-to-end latency budget (issue → epoch live → first worker turn → first PR)

| Segment | Budget | Live anchors |
|---|---|---|
| issue open → intake run (cold+door+CAS+nudge) | ~25–50s | X8 shape; intake nudge turn.mjs:51–64 |
| nudge → conductor rollover+genesis+first dispatch | ~20–45s | X1a ~10s run-create; ~10s turn |
| **epoch live** | **~45–95s from issue-open** (call it ~1–1.5 min) | |
| dispatch → worker turn START (run-create + cold + checkout + node + CLI) | ~50–90s | X1a, X20, X2 |
| CC turn (the work) | 196s–16min | X21/X23/X20 |
| **first worker turn DONE** | **~4–17 min from epoch live** | |
| report CAS + completing-tick drain + PR ladder | ~45–75s | X22-final one-pass |
| **first PR** | **~5–19 min from issue-open** | X22-final |

**Dominant term: the CC turn itself (80–90% of the budget).** The machinery overhead is ~1.5–3 min across 3–4 runner
cold starts — already near the GHA platform floor; the historical killers are fixed (7-min npx → 4–9s npm;
acceptEdits; quiesced-early-return). **What would cut it most: nothing structural — the optimization frontier is
THROUGHPUT (§5.1), not latency.** (Latency-adjacent residual worth an S: a4-F1's dropped spec `lease_minutes` — a
short inherited lease under a 9-min grind causes reap→duplicate-dispatch latency+noise at epoch starts.)

### §5.7 The productization verdict

**The architecture is sound as a distributed cloud harness on native GH constructs** — the state/wake/compute/model
plane SEPARATIONS are correctly chosen and live-proven; the productization gap is concentrated in three places:
a broken capacity multiplier, unreachable paid redundancy, and an unwatched detection layer with manual drills.

**The 3 structural changes that move MOST toward optimal (ranked impact/effort):**

1. **Repair + arm the overflow lane (ARCH-1) and retune capacity (ARCH-2):** C-1+C-2 fixes (S) +
   `max_parallel` 4→16 + `WORKER_OVERFLOW_AT` 1→~13 (one `configure`). **~5× the compute ceiling for S–M effort** —
   the single highest-leverage change in the system; X26 then becomes the drill that proves it.
2. **Make the §S20 economics real at runtime (ARCH-3):** key-alternating lanes + CC_MODEL de-dup (S) + a hard spend
   ceiling (pause is a control, not a ceiling — yardstick #5). Eliminates the "one drained key silently stops all
   cc work" class; the paid lane's ~30-day runway stops being a countdown.
3. **Close the detection layer + automate the drills (ARCH-4+ARCH-5):** second pinger + honest thresholds + deadmen
   on the watchdog/executor (M), plus a scripted X-series e2e drill harness incl. X26's concurrent-overflow shape (M).
   This is what converts "live-proven by an operator" into "production-grade by process".

**The 3 already-optimal things (don't churn):** the single-branch CAS state anchor with rotation/quiescence
(§4.1 — its cliff is 10× away and the escape hatch is a naming change); the GITHUB_TOKEN self-dispatch wake chain +
watchdog/breaker (§4.2); the two-lane model split with §S20's routing policy (§4.3 — fix reachability, not
structure).

---

*Read-only audit: no branches, no commits, no pushes, no API writes. Live probes were GET-only (repo metadata,
workflow listings). Deliverable: this file.*
