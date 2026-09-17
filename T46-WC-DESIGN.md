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
