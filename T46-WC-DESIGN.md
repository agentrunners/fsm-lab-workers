# T46-WC — Intake Door + Dispatch Budget + Lane-Pause + PR Flow + Pinger (the W-C build)

**Task ID:** 46 (session 16, W-C). **Status:** design v1 for adversarial review.
**Inputs:** PHASE2-ARCHITECTURE §5/§8/§9/§10/§11 (v2), T46-WB-DESIGN v2 (deployed base a01a624), the X21-final dogfood verdict (EVIDENCE.md: machinery PASS, lane-quota exhaustion is the finding), the 46-R2 review + fix wave (276/276 @ a01a624 — law-4 scan hardened, api-error classification fixed, env stripped, CLI pinned).
**Deploy base:** fsm-lab main @ a01a624, quiesced (halted after X21-final).

## 0. What W-C is for (the thesis)

W-B made the machine plane real: workers turn leases into five-class reports
through a typed contract. W-C opens the machine to the HUMAN plane and closes
the two structural gaps X21 exposed: **nobody can put work in except an
operator with curl** (no intake), and **the system spends what it cannot pay**
(no budget awareness). Every piece below serves one of those two, plus the
availability story (the pinger) that makes 24×7 honest.

## 1. Law + finding ownership

| Source | Item | Owner |
|---|---|---|
| X21-final F-1 | 429→work_failed misclassification | **FIXED in R2** (B-1: api_error_status family → infra rotate) |
| X21-final F-2 | no budget-aware pause (12-task quarantine burn) | **THIS BUILD (§3)** |
| X21-final F-3 | bridge route gap `HEAD /api/hello` | **THIS BUILD (§7 trivia)** |
| R2 M-A1 | law-4 scan reliability | **FIXED in R2** (per_page=100 + time correlation) |
| R2 MINOR-4 | run-name regex hostile after intake | **THIS BUILD (§2e — validated at the door, the hazard never exists)** |
| R2 MINOR-1 | law-4 verify pass not hold-gated | **THIS BUILD (§3d trivia)** |
| R2 m-7 rebuild `last_result` | undocumented projection tolerance | documented in §6 (no code — pre-existing F8 semantics) |
| PHASE2 law 6 | transcript GC duty | **THIS BUILD (§5)** |
| PHASE2 law 8 | monitor quota isolation | operator-gated (§8 — needs the second account decision) |
| PHASE2 R1-B4 | intake trust boundary | **THIS BUILD (§2)** |
| PHASE2 R2-A9 | intake vs active epoch | **THIS BUILD (§2d)** |
| PHASE2 D3/D4 | transcript GC + task-branch/PR flow | **THIS BUILD (§4/§5)** |
| PHASE2 rung-4 | the pinger + watch-the-watcher | **THIS BUILD (§8)** |

## 2. The intake door (issue → validated task spec → epoch genesis)

### 2a. Trigger + trust gate
`on: issues[opened]` on fsm-lab. The workflow (`.github/workflows/intake.yml`,
own concurrency group, ~15s runtime) runs the door:

1. **Author gate (fail-closed):** `GET /repos/{org}/{repo}/collaborators/{author}/permission`
   → accept `admin|write|maintain|owner` (MEMBER/COLLABORATOR/OWNER class).
   API error → REJECT (fail-closed — a flaky permission API must never become
   a free compute lane). Strangers: ONE explanatory comment (rate-limited:
   the issue id mints the comment id — no re-comment on re-runs), zero runs,
   issue stays open for triage.
2. **Marker:** the body must carry a fenced spec block (below). No block →
   one "how to write a task" comment, done (the issue is just an issue).
3. **Bots:** `github-actions[bot]` author → hard reject, no comment (loop
   safety — the door must never wake itself).

### 2b. The spec schema (the fenced block)
````fsm-task
id: T-501            # OPTIONAL — default task-i<issue#>; charset [-A-Za-z0-9_.]{1,24}
title: research the frob nozzle
accept: one paragraph on frob options with citations   # OR behavior: succeed|flaky|... (mock epochs)
deps: [T-101, T-102]  # OPTIONAL — must exist in the CURRENT epoch or the intake queue
artifacts: [tasks/T-501/report.md]   # OPTIONAL — door-shape paths only
lease_minutes: 45     # OPTIONAL — bounds [1, 120], default = config
milestone: 2          # OPTIONAL — default 1; a new max milestone extends the project
````
Validation (all fail-closed, ONE comment listing EVERY violated rule — not a
 drip of retries): charset on id (**the run-name hazard dies here** — ids that
 survive this gate can never mis-split law-4's `task-<id> · <behavior> · a<n>`
 matching); title ≤140 chars, no fence-forming sequences (the R-hardening
 neutralizer runs at prompt-build anyway — defense in depth); deps
 ghost-check (F9): deps not in {epoch tasks, queued specs} → reject with the
 missing list; artifacts paths must match `^tasks/[-A-Za-z0-9_.]+/` (the
 write-back door's own shape — the door and the intake speak one path
 language); lease bounds; milestone ≥1 ≤9; total spec ≤4KB.

### 2c. The queue write (git-CAS, the established pattern)
Valid spec → append to `state/intake-queue.jsonl` on fsm-state (CAS retry,
FF-only push — the report-queue pattern verbatim): one line
`{issue, body_sha8, spec, enqueued_at, author}`. The TASK_CREATED mint:
`task-<issue#>-<bodySha8>` — re-delivery (issue re-opened with same body) is
idempotent; the queue line carries the same id so the drain can dedupe.

### 2d. The conductor's drain (R2-A9 — never auto-reset)
The tick's control-drain gains a pass AFTER control events, BEFORE the clock:
- No active epoch (phase=done or no project) AND queue non-empty → pop the
  HEAD spec → `makeGenesis(spec)` → the epoch runs. The intake comment thread
  gets the "epoch started" note (at the FIRST milestone transition — not
  another API call in the hot tick; the ops-issue milestone comments already
  fire).
- Active epoch → PARK (no action — the queue is the parking lot). Queue
  depth >1 → the OLDER entries stay parked; a burst comment fires ONCE per
  issue at enqueue time ("queued behind the active epoch — position N"), not
  per tick.
- **The reset interplay:** an operator reset while specs are queued → the
  reset's makeGenesis uses the QUEUE HEAD (an operator reset is an explicit
  "drop the current epoch" — the queued intake was already accepted work).
  The `reset` control payload may carry `"drop_queue": true` to discard.

### 2e. Genesis from spec
`makeGenesis(spec)` (new sibling of `mockProject`): one task from the spec
(behavior = spec.behavior for mock epochs; accept-criteria tasks carry
`behavior: 'real'` — the worker prompt embeds the accept text as the task
definition, the report's summary is the evidence). deps resolve against the
new epoch's ids (the ghost-check ran at enqueue; re-check at drain — the
queue may have waited epochs). milestone count = max(spec.milestone, 1).

## 3. The budget architecture (F-2 + dispatchBudget — the X21 lesson as code)

### 3a. dispatchBudget (the pacing floor's replacement — structural, not timed)
The clock's dispatch phase: **assign-and-dispatch atomically, count-capped.**
```
dispatch_budget = clamp(1..max_parallel, floor(tick_time_remaining_ms / DISPATCH_COST_MS))
```
`DISPATCH_COST_MS` default 4000 (measured: a dispatch+commit ≈ 2-4s; the tick
timeout is 10min with the verify pass after). The loop: for each ready task
while budget > 0 AND assigned < max_parallel: assign + dispatch + budget--.
**Budget exhausted → the task stays READY (never assigned)** — the
skip-left-assigned bug class is structurally dead because assignment exists
only inside a spent dispatch slot. The `DISPATCH-PACED` log line fires per
exhausted-tick with the budget number (observable, testable). The old pacing
floor is deleted (dead concept — count, not delay).

### 3b. The lane-budget pause (F-2)
New config: `budget_pause_threshold` (default 3), `budget_pause_window_min`
(default 15). The REPORT drain tracks infra reports whose detail matches
`lane-exhausted.*429|lane-429` (the quota signature — the R2 fix made the
classification correct; W-C makes the REACTION correct):
- ≥threshold distinct TASKS reporting quota-exhaustion inside the window →
  the conductor sets `chain.paused=true, paused_reason:
  'lane-budget-exhausted'`, commits, **opens the operator alert issue**
  (`fsm-watchdog-alert` label — the established alert lane): body carries
  the task list, the observed 429 detail verbatim, the key indexes involved,
  and the resume command. NO further dispatches (the pause is the circuit
  breaker for spend).
- Resume: the standard `resume` control (the operator, after quota reset —
  daily UTC rollover for OpenRouter free tiers). The pause auto-lifts NEVER
  (a budget condition is an operator fact, not a transient).
- The stats gain `budget_pauses` (audit). The quarantined-by-quota class
  (X21's 12) becomes impossible: the epoch parks with 0 attempts burned on
  the remaining tasks.

### 3c. The lease-budget ceiling (honest dispatch arithmetic)
`assembleDispatchPayload` gains: `budget.wall_ms` floors at 60s (exists);
NEW: if `lease_minutes > W2_WORKER_TTL_MIN`, the payload's deadline caps at
the TTL (never lease a task the job cannot host) — the X21 TTL-override
class's last hiding place. Pinned by a unit test (TTL-sync suite extends).

### 3d. Trivia (folded from R2 minors)
- Law-4 verify pass: skip when `chain.paused` (was: only task-state-gated).
- Bridge: answer `HEAD /api/hello` with 204 (the CLI's liveness probe —
  kills the 501 noise; the route stays loud for everything else).

## 4. The task-branch/PR flow (D4's human half — X22's artifact leg)

### 4a. The worker side (small)
The write-back door's `branch` param becomes live: cc-mode tasks with
declared `artifacts` commit to `refs/heads/task/<id>` (NOT main — the PR is
the review gate). The door's pathspec on the task branch: `tasks/<id>/**` +
declared artifacts only (same rules, different base ref). The task branch is
created from the dispatch commit (the envelope carries `base_sha` — the
worker verifies ancestry, fail-closed on divergence: the epoch moved on →
report infra `base-diverged`, net-zero).

### 4b. The conductor side (at done)
On a done report for a task with declared artifacts (cc mode): open PR
`task/<id>` → main via REST (title `task/<id>: <title>`, body = the accept
criteria + the report summary + the transcript link). **No auto-merge — Q4
is the principal's** (the standing law). PR-open failure = alert comment on
the ops issue (law 5: alert-lane health), NOT a run failure. The PR number
lands in the task record (`pr: 42`) — the journal REPORT record gains the
field (pointer-only, law 6).

### 4c. Mock epochs skip the flow (no artifacts declared → no branch, no PR).

## 5. Transcript GC + task-window pruning (law 6's deferred halves)

### 5a. Transcript GC (the watchdog duty)
The watchdog scan gains a pass: list `sessions/` on fsm-sessions; files whose
task is terminal (done/quarantined/cancelled) AND older than
`transcript_gc_days` (default 7; hard cap 90 — config-bounded) → delete in
ONE commit per scan; the scan log line carries
`GC-TRANSCRIPTS deleted=<n> retained=<m>`. Never touches non-terminal tasks'
transcripts. The fsm-state commit that records the GC (a `GC` journal kind,
pointer-only) keeps the audit.

### 5b. Task-record pruning (state.json growth)
`prune_tasks_after_ticks` (default 20): terminal task records compact to
`{id, status, attempts, done_at}` (drop prompt/history/lease) after N ticks
terminal. The journal retains everything (immutable) — state carries the
active window only. rebuild() parity: pruning is a state-level projection
(post-rebuild prune reapplies — idempotent).

## 6. The ops console (G-18b — comment commands)
`on: issue_comment[created]` (`.github/workflows/ops-console.yml`, own group):
- ONLY on issue #1 (the ops console) AND author permission ≥ write (same
  gate as intake, fail-closed).
- Body parse: FIRST line `/(pause|resume|halt|unhalt|reset|status|configure .*)/`
  → enqueue to the control queue (the git-CAS lane) with
  `ctl-<command>-<comment_node_id>` mint. `status` → the bot replies with a
  one-screen state summary (phase, milestone, done/quarantined, chain age,
  queue depth — read-only, no enqueue).
- Non-command comments: ignored (zero runs beyond the parse).

## 7. Test + sim surface (the honesty bar)
- `tests/test-intake.mjs`: the spec validator (every rule × valid/invalid ×
  the one-comment contract), the author-gate class list, the mint idempotency,
  the ghost-dep door, the charset hazard (an id that would mis-split law-4
  REJECTED at the door).
- `tests/test-budget.mjs`: dispatchBudget arithmetic (budget=0 → zero assigns,
  task stays ready — the regression pin), the pause trigger (3×429-window →
  paused + alert + zero new ASSIGNs; resume → continues; attempts unburned),
  the TTL-lease ceiling.
- `sim/run-sim4.mjs` (NEW): the intake→epoch→pause→resume→complete loop
  offline: enqueue specs → tick drains genesis → inject quota-shaped infra
  reports → assert pause + zero-dispatch + alert shape → resume → dones →
  halt → queue-drains-next-spec. Reuses sim3's world model.
- `tests/test-gc.mjs`: transcript GC terminal-age rule, the 90d cap, the
  journal GC record; task pruning idempotence + rebuild parity.
- conformance: the PR-open path mocked (no live API in tests — the REST
  client injectable).
- All existing gates stay green (276/276 + sims + conformance 26/26).

## 8. The pinger (rung 4, honest v1) + law-8
- **v1 (this build):** quiet-lab (public, zero-secrets, the R3 rehearsal
  surface) hosts `pinger.yml`: cron `*/15` → POST fsm-lab
  `repository_dispatch fsm-tick {note: 'pinger'}`. GHA schedule sparsity
  applies (the X5 physics — nominal 15min ≈ effective 1-2h; stated honestly).
  The executor's external scheduler stays rung 3 (~2-6h worst). The
  watch-the-watcher duty (executor repo, this build wires it into the
  existing duty roster): no pinger-note run on fsm-lab in 45min → duty
  comment on the ops issue (visible, not fatal — the chain may simply be
  alive-and-self-ticking; the duty reports the PINGER's health, not the
  chain's).
- **The true external pinger** (a real HTTP cron hitting the dispatch API on
  a PAT) remains operator-wiring: one curl line documented in the runbook —
  when the operator provides it, quiet-lab's cron becomes redundant.
- **Law-8 (monitor quota isolation):** operator-gated — moving the executor
  to the second account (`ansgaureutychis` namespace) is an account-migration
  decision, not code. The design records the trigger (measured starvation at
  fleet scale) and the shape (executor repo transfer + PAT re-issue); it does
  not execute it this wave.

## 9. X-proofs (W-C's stamp)
- **X22 (the dogfood loop):** issue (operator-authored, spec block) → door
  accepts → epoch (cc mode, free lane, post-quota-reset window) → CC worker
  completes with artifacts → task-branch → PR opened → completion comment on
  the intake issue → epoch halts done. Every leg carries its run-ID/issue#
  /PR# in EVIDENCE.md.
- **X23 (the budget pause):** a live cc epoch driven into the quota wall
  (or the threshold lowered to trip on the natural free-lane exhaustion) →
  epoch PARKS (paused, alert issue open, zero post-pause attempts) → resume
  after reset → completes. The X21 12-task burn cannot recur — proven live.
- **X24 (the pinger duty):** quiet-lab pinger fires (observed 204 + the
  fsm-tick run with note 'pinger'); the watch-the-watcher duty reports
  pinger-liveness in its scan.

## 10. Build waves (each gated: brief → build → review → merge)
- **W-C1 (conductor core):** §3 (budget+pause+trivia) + §2 (intake door) +
  §5b (pruning) — one branch, sim4 + tests, offline-provable end-to-end.
- **W-C2 (artifact+ops):** §4 (task-branch/PR) + §5a (transcript GC) + §6
  (ops console) — needs the workflow files + REST clients (injectable).
- **W-C3 (availability):** §8 (pinger + duty) — mostly workflow YAML + the
  executor duty edit; smallest wave, rides any merge window.
- **X22-X24:** live proofs, quota-window-dependent (X22/X23 need the free
  lane post-reset; schedule at the session's start).

## 11. Anti-scope (this build does NOT)
- No multi-project epochs (per-issue epochs stay v2 — one active project).
- No heartbeat/lease renewal (v2 per PHASE2 §4).
- No auto-merge of PRs (Q4 is the principal's).
- No edit-reconciliation on intake specs (an edited body = a new issue; the
  mint is body-sha-scoped — documented operator contract).
- No external pinger service (operator wiring; the runbook line ships).
- No law-8 migration (operator-gated; trigger + shape recorded).
- No ctxown/bundle memory (v2 seam stays).

## 12. Recorded decisions (mine, numbered W-C-D)
1. **Ids validated at the door, not escaped downstream** — R2 MINOR-4's
   "stop round-tripping identity through run names" loses to the cheaper
   door-side charset gate: run names stay human-readable, law-4's regex
   stays simple, and the hazard never exists to escape.
2. **Budget = count, not delay** — the pacing floor (time between dispatches)
   is deleted; a per-tick dispatch slot count cannot skip-and-leave-assigned
   by construction. The bug class dies with the concept.
3. **The pause never auto-lifts** — a budget condition is an operator fact.
   Auto-resume after a timer would re-enter the wall blind (the quota state
   is unknowable from inside); the alert carries the resume command.
4. **PR-per-tasked-artifact, never auto-merge** — the review gate is the
   product (human-plane trust); the flow's success metric is the PR existing,
   not merging fast.
5. **Artifacts to `task/<id>` branches (not main)** — the write-back door's
   pathspec is branch-agnostic; task branches make the review boundary a ref,
   which GitHub already understands (PR machinery for free).
6. **quiet-lab hosts the pinger** — public repo = free minutes, zero secrets
   (the R3 surface), org-adjacent (good-enough de-correlation for v1; the
   true external pinger stays the runbook line).

---

## v2 fold (2026-09-17 — both review lenses: 4 BLOCKING / 15 MAJOR / 21 MINOR folded)

Reviewers: 46-WC-R-1 (trust/state-machine, `/home/z/lab/probe-46/wc-r-lens-1.md`) + 46-WC-R-2 (integration, `/home/z/lab/probe-46/wc-r-lens-2.md`). Both converged on the security-contract violation (L1-B2 ≡ L2-M5) from independent lenses. The adjudications:

### BLOCKING folds

**F-1 (L1-B1): deps are CUT from v1.** Per-issue epochs make cross-epoch deps structurally incoherent (every enqueue-legal dep is a drain-time ghost), and the unspecified failure path dead-loops the chain (the missing-dep invariant throws pre-commit; the queue line never consumes — poison-loop + latch). The door REJECTS `deps:` with a one-line "deps arrive with multi-task epochs (W-D)" comment. The FSM's TASK_CREATED receiver keeps its unknown-dep door for the future.

**F-2 (L1-B2 ≡ L2-M5): the security contract is re-adjudicated PER-WORKFLOW, not per-repo.** The standing rule ("never issue_comment/issues triggers on a PAT-holding repo") was written when one workflow ran everything. v2: intake.yml + ops-console.yml are **provably secrets-free** — no `secrets.*` mapping anywhere in their env, GITHUB_TOKEN only, least-privilege `permissions:` blocks (intake: issues:write+contents:read; console: issues:write). LAB_PAT stays exclusively in conductor.yml (dispatch/schedule triggers only). The README contract line is REWRITTEN to the per-workflow form. The stranger-wake cost is documented honestly: every public issue/comment wakes a ~5s runner (GitHub has no pre-job gate); the in-run author gate is the compute firewall; the wake itself is the accepted cost of a public door.

**F-3 (L2-B1): the pinger lives on the USER ACCOUNT (`xfnwfpho1/pinger`, public, cron */15), not quiet-lab.** Cross-repo dispatch needs a PAT (X1 physics); quiet-lab is zero-secrets BY CONSTRAINT; same-org cron is the correlated class (X5). The user-account public repo gives: free minutes, a genuinely de-correlated schedule, and a PAT secret posture identical to mirror-runner (already holds the PAT). The dispatch payload is `{reason:'pinger'}` (L2-M4: `note` is invisible — run names, mints, and the duty all key on `reason`). X24's criterion: the fsm-tick run named `pinger · conductor` + journal `tick-pinger-<ms>`. quiet-lab stays the rehearsal surface (R3's original shape).

**F-4 (L2-B2 + M-7): task branches fork from MAIN, named `tasks/<id>`, base_sha CUT.** The dispatch commit lives on the orphan fsm-state branch — forking there produces unrelated-history PRs that would merge the state tree into main and mutually conflict. v2: the worker's artifact commit branches from its checkout (main) — clean diffs, mergeable pairs, the door's existing `TASK_BRANCH_RE` (`^tasks/<id>`) matches both live call sites unchanged. Epoch freshness rides the chain id already in the envelope's session (the PR body carries it; the conductor correlates) — the ancestry check was near-vacuous anyway (FF-only history).

### MAJOR folds

**F-5 (L1-M1 + L2-m7): the epoch ROLLOVER replaces reset-pops-queue.** `reset` keeps its exact current meaning (fresh mock/drill epoch — the X16-X23 drill contract is sacred). The queue drains on NATURAL completion: the halting tick (phase=done detected in the report drain) with a non-empty queue mints the next genesis IN THE SAME TICK instead of STOP_CHAIN (the rollover); empty queue → STOP_CHAIN as today. `reset {from_queue: true}` opts into queue-head genesis explicitly; `drop_queue: true` discards. The second spec's start latency = one tick (not hours — the halted-chain handoff dies).

**F-6 (L1-M2 + L2-M3): the pause trigger is class-based with an OR-backstop.** Trigger = **(≥3 distinct tasks with quota-shaped infra reports) OR (≥1 infra-exhausted quarantine with a quota detail)** inside a PERSISTED window (state field `budget_window: [{ts, task, detail}]`, config `budget_pause_window_min` default 15 — NOT the rolling dedup window, which is epoch-wiped). Quota-shaped = detail matches `lane-exhausted(`, `lane-429`, or the error-as-answer rate-limit marker (the rc=0 text class). The backstop catches the sequential burn (max_parallel=1: one task's full ladder → 1 infra-exhausted → immediate pause, zero further tasks dispatched).

**F-7 (L1-M7): the pause is a JOURNALED EVENT (the F8 law).** The conductor mints CONTROL `ctl-<alert-issue#>-budget-pause-<clockMs>` (nodeId = the alert issue — the table's shape) with payload `{reason:'lane-budget-exhausted', window}`; the existing CONTROL receiver applies paused; rebuild() replays it. `paused_reason` rides the chain record (projection). Un-pause = the existing resume control (same receiver).

**F-8 (L1-M8): alert-FIRST-then-pause, fail-loud, self-retrying.** Order: (1) open the alert issue (label fsm-watchdog-alert, body = task list + 429 detail verbatim + key indexes + resume command); (2) POST failure → the tick FAILS (red run, law 5) with NO pause committed — the chain self-ticks, the persisted window re-triggers the attempt next tick (the correlated-failure case — a 5xx storm that killed the alert POST also paused the world's API — self-heals); (3) alert open → mint the pause event → commit → HOLD_CHAIN. The alert is the ONLY exit and it EXISTS before the world goes quiet.

**F-9 (L1-M3): law-4's verify pass skips on paused OR halted** (both hold states — the quiesced-noop contract holds across the board).

**F-10 (L1-M4): dispatchBudget is wall-clock-recomputed per iteration.** `budget = min(count_cap, floor(remaining_ms / DISPATCH_COST_MS))` recomputed before each assign+dispatch; the dispatchRetry ladder's Retry-After waits count against remaining (a 60-120s RA at low remaining → budget 0 → stop). The honest residual, documented: a tick dying mid-ladder leaves assigned-but-undispatched tasks — exactly law-4's class (the 720s flip recovers them net-zero); the ASSIGN-in-mutate + dispatch-in-IO split makes the mid-kill state safe BY CONSTRUCTION (already deployed semantics, now stated).

**F-11 (L1-M5): intake re-delivery = intentional re-run.** The mint `task-<issue>-<sha8>` dedupes within an epoch (TASK_CREATED's receiver); across epochs (a done task's issue re-opened with the same body), the fresh genesis re-runs it — that is the operator's "run it again". The dedup window's epoch-wipe is irrelevant to the queue's semantics (the queue file is the cross-tick surface). Documented as the operator contract.

**F-12 (L1-M6): the console's two-layer id.** The queue record's id = `console-<comment_node_id>` (free-form, the ops-queue lane); the CONTROL event minted at drain = the table's `ctl-<nodeId>-<command>-<clockMs>` with nodeId = the comment node_id. Both layers documented; the mint guards stay untouched.

**F-13 (L1-M6c): the console's `status` reply pins the GH_TOKEN lane** — GITHUB_TOKEN-authored comments never fire issue_comment (anti-recursion law) → the reply cannot wake the console. Test-pinned.

**F-14 (L2-M1): conductor.yml gains `pull-requests: write`** + the repo setting "Allow GitHub Actions to create and approve pull requests" is flipped (API) as an X22 precondition; PRs created by GITHUB_TOKEN trigger no PR workflows (documented — human review is the product).

**F-15 (L2-M2): the watchdog NEVER writes fsm-state (charter kept).** The transcript-GC pass: (a) placement BEFORE the halted/paused exits (a completed epoch is the GC's primary target); (b) the fsm-sessions deletion commit IS the audit (branch history retains deletions — no journal record, no state write); (c) runtime bail-out: tree >5000 files → `GC-DEFERRED` log, no commit; (d) the deletion CAS uses the proven 3-way-refresh (law 15) against live transcript pushes.

**F-16 (L2-M6 + L1's sim4 list): sim4's scenario list, enumerated to sim3's bar:** (1) happy pause loop; (2) window boundary (2-in + 1-aged-out → no pause); (3) distinct-task counting (one task's 3 reports → backstop pause only at exhaustion); (4) single-task ladder (max_parallel=1 → backstop fires at 1 infra-exhausted); (5) pause-with-inflight (reports drain during pause; resume → the reaper burns the expired in-flight leases — the honest residual, asserted); (6) alert-failure (tick red, no pause, window persists, next tick retries); (7) reset-vs-queue (from_queue both values + drop_queue); (8) the epoch rollover (drain-on-halt in the same tick); (9) re-opened-spec re-run; (10) the console mint round-trip + the GH_TOKEN no-recursion pin.

### MINOR folds (one line each)
- **m-1 (L2):** §3c re-scoped — the TTL-lease ceiling EXISTS (conductor-core min(lease, TTL)); W-C1 ships only the pin test.
- **m-2 (L2):** the journal retention contract stated honestly (4×500-record tail; pruning + rotation = evidence window is the tail).
- **m-3 (L2):** the queue line carries `issue` → genesis → completion comments target the INTAKE issue (new comment action, issue-numbered).
- **m-4 (L2):** intake artifacts bind to `^tasks/<minted-id>/` (foreign-task paths rejected at the door AND at the write-back door).
- **m-5 (L2):** the parked-queue writeback contract in store.mutate (consume = rewrite-minus-head; park keeps the file; a park-only tick journals nothing → quiesce while live — stated).
- **m-6 (L2):** W-C1's gate names the offline/live split (routing shapes offline; the permission API + comment contracts are X-proof surfaces).
- **m-7 (L2):** folded into F-5 (the rollover).
- **m-8 (L2):** the ops anchor issue number is a repo var (`OPS_ISSUE`), #1 documented as load-bearing.
- **L1's minors** (branch naming — folded F-4; trigger-types pin — folded F-2; the rest) are build-time hygiene named in the wave briefs.

### The wave map after the fold
- **W-C1 (conductor core):** §3 as folded (F-6/F-7/F-8/F-9/F-10 + F-6's persisted window) + the intake door (§2 minus deps, F-1/F-2) + the rollover (F-5) + pruning (§5b) + sim4 (F-16's ten scenarios) + the TTL pin (m-1). Offline-provable except the door's live halves (m-6).
- **W-C2 (artifact+ops):** the task-branch/PR flow as folded (F-4/F-14 + m-3/m-4) + transcript GC (F-15) + the ops console (F-12/F-13 + m-8).
- **W-C3 (availability):** the pinger on the user account (F-3) + the watch-the-watcher duty.
- **X22-X24:** as §9 with F-3/F-4's corrected criteria (X23 = machinery proof with a wall-condition appendix per L2's schedulability analysis).
