# EVIDENCE — live experiment ledger (fsm-lab, Task 43)

Every claim carries its run ID / log line. Nothing here is aspiration.
Timestamps UTC. Session: 2026-09-06.

## X1 — chain physics (the continuity substrate) — COMPLETE

### X1a: GITHUB_TOKEN self-dispatch STARTS workflows ⭐

- Probe run **34025596219** (`hop 0 · github-token`, 09:46:38Z): dispatch with
  the job token → `HTTP=204` → log: `VERDICT: GITHUB-TOKEN-WOKE — 1 run(s) fired`.
- Follow-up run **34025603333** (`hop 1 · verify`): `event=repository_dispatch`,
  `triggering_actor=github-actions[bot]`, created 10s after the dispatch.

**Architectural consequence:** same-repo orchestration (conductor self-chain,
worker dispatches, watchdog re-prime, ops nudges) needs **zero PAT** — the
job-scoped ephemeral token suffices (`repository_dispatch`/`workflow_dispatch`
are the documented exceptions to the anti-recursion rule; `issue_comment`
and content events are NOT — that part of E7 stands). Cross-repo dispatch
still needs a PAT — why the prior track never saw this. The lab keeps
`LAB_PAT` wired as a fallback lane.

### X1b: PAT chain — 15 hops, 9.2s avg cadence, 129s span, all success

Runs `hop 1..15 · pat` (09:51:21Z→09:53:30Z).

### X1c: GITHUB_TOKEN chain — 15 hops, 8.9s avg cadence, all success ⭐

Solo epoch (10:24Z→10:26Z). Actor sequence: `zikomolapoutl` (PAT-seeded
hop 1) → `github-actions[bot]` for all 14 subsequent hops. **A zero-secret
infinite chain.**

**Measurement gotcha:** two chains sharing one `concurrency` group
interleave-cancel (newest-wins) — the dual-launch gh-chain "stopped" at 1
hop until re-run solo.

## X2 — conductor live loop — COMPLETE (two epochs)

**Polluted epoch (09:52–10:20):** bootstrap 34025876490; chain live at ~10s/tick.
Five live-caught defects, each absorbed by the failure model or fixed
in-session (the list below is the session's core yield):

1. **store.commit dropped `actions`** — leases assigned, no worker dispatched
   (silent livelock; `v=5 seq=1 actions=0` was the tell). Fixed: commit
   carries mutate's actions/journal.
2. **GHA concurrency groups are depth-1, newest-wins — NOT FIFO queues.**
   Four report runs (09:57:12Z, runs 34026063838/4081/4542/5711) CANCELLED by
   the next self-tick. Architectural fix: reports CAS-append to
   `state/reports-queue.jsonl`; each tick drains atomically in the SAME state
   commit (`TICK+2r`/`TICK+3r` commits observed live). Data flows through
   git; dispatches are wake-only.
3. **Quarantined deps deadlocked blocked dependents** (T-103..106 forever in
   backlog). Fixed: CANCEL_CASCADE (live at 10:05Z: cascade + `M2 STARTED`).
4. **External dispatches into the hot conductor group get newest-wins-cancelled**
   (the reset control run 34026571647 died at 10:08:09Z). Fixed: controls ride
   git — fsm-ops workflow (own group) enqueues `control-queue.jsonl`; ticks
   drain controls atomically (+ ops-nudge wakes a stopped chain).
5. **Payload-shape family (×2):** repository_dispatch carries its type in
   `action`, NOT `event_name` — ops silently enqueued `pause` for a dispatched
   `reset` (10:13:55Z, state pause observed at 10:14Z); conductor buildEvent
   misrouted direct fsm-control to a tick. Both fixed, both caught live.

**Clean epoch (10:20–10:53):** reset via ops queue → full mock project
END-TO-END: `phase=done M3`, stats `{done:14, quarantined:4, retries:10,
orphaned_reports:4(injected), rejected_events:21, timeouts:9, dispatched:28}`,
STOP_CHAIN fired, ops issue carries milestone/quarantine/completion comments.

## X3 — parallel workers + burst contention — COMPLETE

- Organic: 4-parallel workers across M2 (interleaved `report-queue +1` commits
  + `TICK+Nr` drains under the live chain).
- Synthetic burst: **10 concurrent writers, each in its own clone** (the
  production shape): `BURST-RESULT writers=10 ok=10 lost=0
  slowestWriter=31100ms` — every contention resolved by CAS retries; zero
  lost writes (run from the operator sandbox, 10:56Z).
- **Live-found bug #6:** 10 writers sharing ONE clone race the local
  tracking ref (`cannot lock ref`); fetch() treated it as fatal. Fixed:
  fetch tolerates transient ref-lock races (the FF-only push remains the
  correctness backstop — a stale local view can only be rejected, never
  corrupt).

## X4 — failure-injection matrix — COMPLETE

| Class | Injection | Live evidence |
|---|---|---|
| duplicate report | `dup` behavior (identical event_id enqueued twice) | `rejected_events` +1; task done once (clean epoch) |
| stale/orphan report | operator-injected wrong-lease reports (10:54Z) | `orphaned_reports: 2`, task untouched |
| flaky | behavior (fail → retry → succeed) | T-102 done at attempts=2 |
| poison | behavior (always fail) | T-207 quarantined at attempts=3 + alert comment |
| hang | behavior (worker silent past lease) | T-105 quarantined via lease timeouts (polluted epoch); SUPERSeded by the real worker (X7) |
| slow (late report) | behavior | quarantined via lease timeouts — live discovery: per-task supersession CANCELS the late worker before it can report (the orphan path narrows to the reassignment race window; operator injection keeps it proven) |
| no-report | behavior (report dropped) | T-205 burned 3 lease cycles → quarantined |
| lease timeout / retry | all of the above | `timeouts: 9`, `retries: 10` (clean epoch totals) |
| CAS races | burst + rival writers | zero lost updates (X3) |
| corruption | store suite (git-history walk) + sim | local 7/7; never corrupted live |

## X5 — watchdog re-prime — COMPLETE (with a caveat)

- Deterministic chain kill: caught a QUEUED tick (run 34028133963) and
  cancelled it before start — no self-dispatch fires (10:41:43Z).
- Watchdog scan (manually dispatched, 10:47Z, run 34028385812) — byte-exact
  log: `WATCHDOG-SCAN seq=38 last_tick=10:41:16 age=367s stale=true done=12/16`
  → `WATCHDOG-REPRIME dispatch=204 (reprime 1/3 in window)` → the chain
  revived (ticks at 10:47:58Z+).
- First kill attempt (10:32Z) missed: the cancel API is ~24s slow to
  propagate and the turn finished + self-dispatched first — the 3m18s "gap"
  was a **dispatch-to-run latency of ~2m44s** (accepted 204, delayed run
  creation). Known class from the prior track, now measured.
- **Caveat (live datum):** on this ~1h-old public repo, NEITHER cron has
  fired ONCE (watchdog :03/:13/… and conductor backstop :08/:18/… both
  dead all session) — the prior track's "native schedule is intermittent,
  external dispatch is primary" reconfirmed on fresh repos. The watchdog
  scan was driven manually (workflow_dispatch). Production shape: the org
  executor's external scheduler drives it (the t1 pattern).
- Circuit breaker (X5b): kill ×3 → re-prime ×3 → 4th scan trips the breaker
  (no re-prime + one alert issue). See the trace below.

### X5b trace (breaker test, 10:59Z–11:34Z) — PASS

Cycles: kill-queued-tick → 4.5-min staleness → watchdog scan (manual
dispatch). The scan at 11:16:20Z (run 34029759397) counted **3 re-prime
runs in the 30-min window** (10:47 X5 + 11:04 + 11:10) → **BREAKER OPENED**:
no re-prime, alert issue **#2** created 11:16:31Z with the runbook body
("Re-priming is now DISABLED. Manual intervention required: …re-arm: POST
…/dispatches"). The chain stayed dead 11:11:46Z→11:33Z awaiting the
operator.

**Operator loop closed (11:31Z):** manual re-arm tick (the exact action the
alert prescribed) + issue #2 commented and closed. The chain revived
(11:33:39Z+) and the project resumed completing itself — the full
dead→detect→alert→human→re-arm→revive cycle, end to end.

Bonus datum: the cycle-3 re-prime dispatch (11:16:20Z) was
accepted-but-never-fired (the drop class) — masked by the breaker opening
the same second; the system's response was correct either way (dead chain
+ breaker + alert, not a loop).

One test-harness note: the script's cycle-4 "kill" cancelled the first
re-arm tick as collateral (its queued-run hunter was still live) —
terminated, re-armed again cleanly. The breaker itself tripped one cycle
earlier than the script expected because the X5 re-prime legitimately
counted inside the 30-min window — correct window semantics, slightly
off test expectation.

## X6 — state growth — VERIFIED LIVE (incl. ROTATION)

- Mid-run (357 events): state.json 8.3KB, journal gen-1 43KB.
- At completion (~2,000+ journal ids across epochs): **journal-1 (498
  lines) + journal-2/3/4 (500 lines each) — the rotation fired exactly at
  the 500-record threshold, 4 generations retained, ~250KB hard ceiling.**
  state.json 19KB (18 tasks with attempt-bounded history + dedup window;
  scales with task count, not event count). 286 branch commits — each
  carrying the full materialized state (the recovery substrate).
- Residual: 3 late reports parked in the queue after the project halted
  (stragglers from superseded slow workers) — 522B, harmless; the next
  drain would consume them as not-leased rejections.
- Scaling note (honest): per-task `history` is attempt-bounded (≤ max_attempts
  entries) so state.json grows with TASK COUNT, not time; for 1000+-task
  projects, trim task history to a rolling window (the journal retains the
  full audit regardless).

## X2 final closing datum — the post-recovery epoch

After the X5b breaker cycle (3 kills → breaker → alert → operator re-arm),
the system **completed the entire remaining project autonomously**:
`phase=done M3 halted=true`, stats `{done:15, quarantined:3, retries:11,
timeouts:9, dispatched:29}`, 19 ops-issue comments, STOP_CHAIN fired, journal
at e518. Kill the chain three times, trip the breaker, re-arm with ONE
dispatch — and the work finishes itself. That is the resilience thesis,
closed end-to-end.

## X7 — the real-LLM seam — COMPLETE ⭐

- Reset epoch: the hung mock worker `task-T-105 · hang · a1` (run 34028775261)
  was CANCELLED by the real worker's dispatch (per-task supersession).
- Real worker run **34028833818** (`task-T-105 · real · a1`, 10:57:07Z):
  one OpenRouter completion (minimax/minimax-m3:free via the kasulty key)
  → reported through the lease contract → drained → **T-105 `done`,
  attempts=1, artifact = the model's actual answer** ("…viable long-term
  only with external persistent state, durable idempotent steps, and
  aggressive…" — the model independently describing the architecture it was
  running inside).
- The seam is proven: a non-deterministic agent inside the deterministic
  FSM, same lease/dedup/orphan machinery, zero special-casing. The next step
  (a full CC turn via the agent-turn composite action) drops into
  `worker/turn.mjs`'s real path unchanged.

---

## Task 44 (2026-09-07) — the audit + deepen round (X8–X14)

Five parallel sub-agent audits (44-a..e) + two design-review rounds (44-f/g)
+ a pre-push code review (44-h) drove waves 1-2 (13 fixes) and wave 3 (the
fourth test layer). All fixes landed in ONE atomic push (401d948) after
local gates: 41/41→57/57 tests, sim 7/7, offline conductor smoke
(drain + quiesce). The post-audit LIVE evidence:

### X11 — consume-on-drain: the zombie loop's tombstone ⭐
- Pre-fix (live, since session 12): 3 stale X2-era reports re-rejected
  every backstop tick (journal e519..e538 across 5 fires; ~4 records/tick
  forever; `rejected_events` 85→100).
- Wake 1 post-fix (run of dispatch `t44-x11-drain-v2`, 00:05:49Z): commit
  `TICK+3r seq=48 v71 [e543..e545]` — **exactly 3 REJECTED records, NO TICK
  record (the held wake is not an event), seq FROZEN, queue emptied to 0
  lines.** (The first X11 attempt at 00:03:52 ran the OLD code — its
  checkout sha 6bdef4e proved the earlier push had silently failed; a
  pipe-masked rc. Caught by evidence, re-pushed, re-run.)

### X9 — quiescence: 10 wakes, ZERO commits
- 10 consecutive `fsm-tick` dispatches (00:06–00:11Z, all 204): every run
  logs `QUIESCED: held-halted (chain halted) — no commit, no self-dispatch`;
  branch tip byte-identical across all 10 (1450b19). The A1 livelock attack
  (mixed-deploy noop self-dispatch, ~2.9k-10.4k runs/day) is structurally
  dead: the noop path never dispatches.

### X8 — ops-nudge latency: ~77s end-to-end (was: broken since birth)
- The nudge had 401'd on EVERY run since session 12 (runs 34026953026,
  34028691734 logged `OPS-NUDGE tick dispatch HTTP=401`, both runs green —
  the status was never checked). One env line (`GH_TOKEN`) fixes it.
- Live: `pause` control dispatched 00:11:34Z → ops enqueue + **nudge 204**
  → conductor tick 00:12:29Z → control applied + committed
  (`control-queue +1 pause` → `TICK ... [e547]` — the held wake again
  journal-less) → total ~77s vs the previous effective latency = the
  schedule backstop (~2h, sparse).

### X10 — full-project regression + DISJOINT rotation on the new code ⭐
- Reset (unified drain path) → the 3-milestone / 18-task project ran
  END-TO-END again on T44 code: v69, seq=55, 14 done / 4 quarantined,
  phase=done, STOP_CHAIN, self-stop at 00:45:02Z; 26 ops-issue comments
  (milestones, quarantines, PROJECT COMPLETE); 12-hex lease tokens live
  (`l-7223772fc8e9`, `l-1e67c735bc4c`).
- **The completion turn proves F2's hardest case LIVE**: the drain of
  T-302's report ran the clock to `phase=done + halted` MID-MUTATE; the
  wake TICK on that same turn was correctly HELD (no journal record, seq
  frozen at 55) while the accumulated journal [REPORT e673, PHASE e674]
  still committed — the 44-f "drain-halts-mid-mutate still commits" trap.
- **Rotation (disjoint gens)**: journal-11 = [e543..e674], 132 lines = 132
  DISTINCT ids, created from a FULL gen-10 (500 lines) + new records only
  (the old code would have written another 500-line 99%-duplicate window).
  Gens ≥10 exist → the numeric-ordering fix is exercised live
  (lexicographic sorts would hide the newest gen from the tail read).
  The pre-fix gens (8-10, overlapping) prune away as gen climbs — the
  documented migration path; retained window converges to 4×500 distinct.

### X14 — the real-lane lease budget (configure control, live)
- `configure {lease_minutes: 15}` dispatched 00:54Z → applied through the
  full ops→queue→drain→FSM pipeline (commit `CONTROL ... [e675..e676]`,
  state.config.lease_minutes=15) — the runtime knob surface works.
- Reset adopts the new config → the HANG task T-105 leased (15-min lease) →
  a REAL worker (mode=real, minimax-m3:free via kasulty, slow-prompt)
  dispatched on the same lease superseded the hung mock worker and
  completed: **T-105 done, attempts=1, artifact = the model's answer**
  (run 34071849623, 01:05Z), well inside the lease. The lease formula is
  now executable: the sim2 `lease-margin` scenario flags lease=4min as
  NEGATIVE budget (-358s at 164s dispatch latency) and lease=15min as
  +302s — matching this live run.

### X5c — watchdog re-prime regression on T44 code
- In-progress tick cancelled mid-pacing (01:08:33Z — the deterministic
  kill; last_tick frozen 01:08:39Z) → manual watchdog scan (workflow_dispatch,
  01:16Z): `WATCHDOG-SCAN seq=10 last_tick=... age=446s stale=true done=7/8`
  → `WATCHDOG-REPRIME dispatch=204 (reprime 1/3)` → chain revived 01:16:40Z+,
  project continued. Same byte-exact behavior as session 12's X5.

### X13 — CAS burst re-run under the new jittered backoff
- 10 concurrent writers, each in its own clone, against the LIVE repo with
  the conductor chain actively ticking and draining (contention last
  round's burst never had): `BURST-RESULT writers=10 ok=10 lost=0
  slowestWriter=39423ms` — zero lost writes; the burst items were drained
  as journaled+consumed REJECTED(unknown-task) records, exactly per design.

### X12 — commit-tree fault guard (local, fault-injected)
- `FSM_LAB_FAULT_COMMIT_TREE=1` → commit() THROWS
  (`commit-tree failed rc=...`), the push refspec is never built from an
  empty sha, the branch survives byte-identical (test in
  tests/test-store.mjs; the probe-confirmed branch-DELETION path is dead).

### Post-session schedule physics (refines X5's caveat)
- Schedules COLD-START ~3.6h after repo creation (first fire 13:11:45Z vs
  repo ~09:35Z), then ~2h cadence vs the 10-min nominal (~5% duty) —
  "dead on fresh repos" revised to "cold-start + sparse". External driving
  remains the production answer; the quiescence fix makes the sparse
  backstops FREE (no commit, no self-dispatch).

### T45/F-G(e) — the worker TTL-kill signature (doc-only, porting contract)
- A `timeout-minutes` kill presents as conclusion=**cancelled** (NOT failure)
  with a step duration ≈ timeout-minutes — live datum run 34073438112
  (step 20m03s, conclusion cancelled, no report). In-lab the lease deadline
  is the semantic handler BY DESIGN (the run conclusion is cosmetic); the
  porting contract for any failure-watch: count cancelled-at-TTL as the kill
  class. No cheap in-run marker exists (the killed process can't log).
- Companion (F-G(a)): the mock sleep cap is now WORKER_TTL_MIN − 2 (margin),
  so the `slow` behavior reports LATE (stale-lease orphan) instead of being
  SIGTERM-killed at the cap — the orphaned-report lane is reachable from the
  mock lane; first live observation to be noted here (X18).

## X19 — the alert-lane end-to-end proof (2026-09-15, session 15/16)
The executor's mirror-health duty opened latch issue #3 on fsm-lab (`duty alert: mirror-health`, 04:22:44Z, run 34928576456 — 16s after the duty ran) after the A2 repair (exec-duty-lib retarget + curl POST lane + numeric guards; commits d92d82b/b7ec174/cf8201f). Zero wake collisions (fsm-lab is schedule/dispatch-only). The 410-dead-target / error-body-as-issue-number / canary-scope triple bug class closed with regression shapes.

## X15 — garbage-state recovery (2026-09-15)
Probe1-shape corruption (torn state.json + unapplied-era records, commit c3a3888) → the conductor's findLastGoodState walk landed 7af0c02 `TICK seq=154 v65 done=15 RECOVERED`. G-15 closed.

## X16/X17/X18 — the T45 fix-wave drills (2026-09-16, runs 35044234419/35044369441/35044420601/35044483639 + 34947001617)
X16: corrupt-state → alert issue #4 opened → marker comment 5690657920 → `WATCHDOG-ALERT-SKIP (recent trusted marker <24h on issue #4: age=1min by=github-actions[bot])` → manual-tick recovery b85e3ff → #4 closed. X17: the 8-wide burst (e1020, conductor run 34947001617 `actions=8`) + revert (e1157). X18: 3 re-runs at attempt=2, all a2 reports absorbed (`task-not-leased(done/done/quarantined)`, zero double-count). Full report: research/w46-wave/b4-drill-report.md in the exploration repo.

## X20 — the GHA CC ceiling, LOWER BOUND (2026-09-16, run 35125728011 GREEN after 7 diagnostic runs)
**The datum: CLI install 4-9s + one adapter turn ~5s (trivial prompt) through the local bridge on the free lane (dots-studio:free); a research-y multi-turn task runs 3-16+ minutes.** Kill-F9 label applies (free lane, rate-limited). The 8-run root-cause chain: ISO-now NaN wall → node-20 EBADENGINE + GH_TOKEN/workdir/stderr-mask → **the CLI's /v1/models/{id} pre-flight 404s on OpenRouter** (the compat surface lacks the route) → the LOCAL bridge (worker/cc-bridge.mjs) → mkdtemp/files.map trivia → permissions → the raw-extraction gate → an apostrophe. Each failure live-diagnosed, root-caused, fixed, and pinned by a test.

## X21 — the synthetic CC epoch (2026-09-16, in flight at session close)
**The stamp is delivered: journal e1416 `T-107 → done` (run 35137019099, 195.8s of real Claude Code work, transcript sessions/T-107/35137019099-a3) + e1421 `T-102 → done` (run 35137088565)** — real CC workers completing lease-scoped tasks through the FSM: dispatch → the ox envelope → the worker's law-1 gate → the per-lane bridge → multi-turn CC work → the transcript push → the five-class report → the drain → done. The three prior buggy epochs each root-caused live (the 10-property dispatch limit → the ox payload; the npm npx tax → per-job pre-install; the pacing-floor skip-left-assigned → default-off; the TTL-cap override → 48min) with the failure machinery absorbing every one (law-4 net-zero flips, infra ladders, deadline self-reports, lane rotation, cross-epoch orphan absorption). The final clean epoch (chain c-1789583988738, 45-min leases) continues autonomously; the dogfood-gate verdict (§11-1) records at its completion.

## X21-final — the dogfood-gate verdict (chain c-1789583988738, completed 2026-09-16T20:06Z)
**The epoch ran to natural completion UNATTENDED: 152 self-chained turns, M1→M2→M3→halt, phase=done, `stats {done:4, quarantined:12, cancelled:2, retries:31, dispatched:47, orphaned_reports:0, rejected_events:0}` — the machinery verdict is PASS.** Every failure-absorption path held under real load: attempt-scoped reports (26 REPORT records, zero double-counts), retry ladders, CANCEL_CASCADE on quarantine, STOP_CHAIN + halt, and the transcript push's non-FF retry recovered live (`CC-TRANSCRIPT-RETRY` → `CC-TRANSCRIPT-PUSHED 2 file(s)`, run 35141387718).

**The lane verdict is the finding: the free-model daily quota exhausted mid-epoch.** The 4 dones are all M1 (T-101 succeed a2, T-102 flaky a3, T-107 dup a3, T-108 slow a3 — the hard behaviors all passed); the first 429 landed 19:38:26Z (T-204's report) and every subsequent M2/M3 turn died to `API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day-high-balance` (the CLI wraps it as `[claude-code:unrecognized_model]`, `api_error_status=429`). 12 tasks × 3 attempts burned into quarantine on a condition that is NOT work failure. Three findings carry to W-C: **(F-1) rate-limit-aware classification** — `api_error_status=429` in the lane exit must map to infra/lane-budget, not work_failed; **(F-2) budget-aware dispatch** — an exhausted lane budget must PAUSE assignment (stop dispatching, open an operator alert), not burn the fleet into quarantine — this is the dispatchBudget architecture's sharpest requirement; **(F-3) bridge route gap** — the CLI probes `HEAD /api/hello` (501 fail-noisy, correct behavior, route worth adding). Bonus: the worker job emits Node-20 deprecation warnings (cosmetic; node 22 is pinned for the CLI step only).

## R2-verification epoch — the fix-wave's live regression datum (chain c-1789613587421, mock mode, halted 2026-09-17T07:28Z)
**The R2-merged code (main a01a624) ran a full mock epoch clean under live GHA load: 15 done / 3 quarantined (83%, above the 50% quality gate — a CLEAN halt, not degraded), M1→M2→M3→halt, seq 484, `stats {done:15, quarantined:3, retries:8, timeouts:6, dispatched:26, infra_retries:0, orphaned_reports:0, rejected_events:1}` — 484 journal events, one stray re-delivery absorbed as duplicate.** The R2 fixes held: **0 infra_retries** (vs X21's quota-storm — mock mode has no lane, but the classification path stayed clean across 26 dispatches), the 3 quarantined are the mock project's DESIGNED failure behaviors (hang/slow/poison classes — their ladders burned exactly as specified), and the law-4 scan never false-flipped a live task (26 dispatches, zero dispatch-unverified records). The comparison that matters: X21-final (pre-R2, cc mode) = 4/18 done with 12 quota-misclassified quarantines; this epoch (post-R2, mock) = 15/18 with the failure classes landing exactly where the contract says they must. The R2 wave is live-proven; the remaining X21 class (the budget PAUSE reaction) is W-C1's F-6/F-7/F-8 — built this session on branch t46/wc1, offline-proven, X23's live proof pending the next quota window.

## X24 (first half) — the pinger lane LIVE (2026-09-17, pinger run 35206612744 → fsm-lab run 35206626620)
**The rung-4 heartbeat exists and works: xfnwfpho1/pinger (public, user account — the F-3 adjudication) cron */15 → `POST fsm-lab/dispatches {fsm-tick, reason:'pinger'}` on PINGER_PAT (secret set, the mirror-runner posture) → fsm-lab run named `pinger · conductor` (35206626620, repository_dispatch, success — the halted epoch's wake QUIESCED cleanly per F2).** The manual workflow_dispatch rehearsal fired 204 first-try. Remaining X24 legs: the journal `tick-pinger-<ms>` record (lands on a LIVE epoch — this wake quiesced on the halted one, by design) + the executor's watch-the-watcher duty (W-C3's second half, not yet built). Honest physics stands: nominal 15min ≈ effective 15min-2h (the X5 schedule sparsity datum) — this is the de-correlated backstop, not the primary driver.

## X25 — the agentrunners second bucket (2026-09-18, session 18)

The principal created org `agentrunners` (2026-09-17T23:45:54Z; xfnwfpho1 admin).
Live-proven end-to-end:
- `agentrunners/fsm-lab-workers` created (public — free minutes + its own
  20-concurrent-jobs bucket), fsm-lab main pushed, secrets set
  (OPENROUTER_API_KEY/_2 = the free-lane pool, STATE_REPORT_PAT for the future
  cross-org report lane), var CC_VERSION=2.1.273.
- Dispatch 204 (PAT) → run **35292565961** `task-X-25 · fast · a1`
  completed/success in the second bucket → the report queue landed on the
  mirror's fsm-state (`rep-35292565961-a1`, outcome done).
Law-8's quota isolation is DELIVERED as org buckets (not a second-account
migration): the worker plane can spread across buckets. Remaining (next wave):
WORKER_REPO dispatch routing + STORE_REPO report routing (the conductor
dispatches cross-org; the mirror's workers report back to the real fsm-state).

## X22 — the dogfood loop (2026-09-18, session 18) — GREEN after 3 live fixes

Attempt 1 (issue #6, chain c-1789696860858): the loop ran (door → rollover →
cc epoch → worker 35297656079 → transcript → done 1/1 → the m-3 completion
comment with the completing epoch's stats) but the ARTIFACT never landed:
headless `-p` mode DEFERS file-write prompts ("The write needs your
approval"). **Fix 1**: `--permission-mode acceptEdits` (the workdir sandbox +
the write-back door are the boundary).
Attempt 2 (issue #7, chain c-1789697601515): the worker WROTE the artifact
(run 35298497608), the task branch `tasks/X22-REPORT2` landed with the
read-back — but no PR on the completing tick. Root causes, live-diagnosed:
(1) **Fix 2**: store.commit reconstructed its own return and silently DROPPED
conductorTick's `prCandidates` (the completing tick logged no PR-FLOW line);
(2) **Fix 3** (lens-1 F4's residual, live-confirmed by verify tick
35298996619): the QUIESCED early-return preceded the PR flow — a halted
epoch's PRs would never open. Both folded + pinned (410/410).
The verify ticks then opened **PR #8** (`tasks/X22-REPORT2` → main, the
PAT ladder — GITHUB_TOKEN 403'd, the LAB_PAT lane carried it; body = accept
criteria + result digest + the transcript pointer) and stamped `pr: 8` in
state. The artifact is real content the CC turn wrote (it read the repo
context and produced a coherent status report).
X22-final (issue #9, chain c-1789698520934): **GREEN in ONE PASS** — the
completion comment carries the result digest AND "**Pull requests**: task
`X22-FINAL` → PR #10" on the same tick-set; PR #10 opened + stamped. The
loop criterion (issue → door → cc epoch → artifacts → PR → completion
comment with the link) is closed.

## X23 — the budget-pause live proof (2026-09-19, session 19)

**The PARK half is LIVE-PROVEN in the multi-task shape; the resume arc ran with
one honest wrinkle (a straggler re-pause).** The wall was engineered honestly:
kasulty's fresh 1000/day free-model quota burned to the day-wall
(`free-models-per-day-high-balance`, X-RateLimit-Remaining: 0) at 00:07Z, then
`EPOCH_MODE=cc` + console `reset` birthed the 8-task epoch (reset comments
5737684542/5737690584 on ops issue #1).

- **Arc 1 (single-task, issue #11, chain pre-midnight):** the infra-retry ladder
  held perfectly — 3 dispatches, 2 infra retries, both quota reports captured in
  `budget_window` (`lane-exhausted(3/6 lanes, last lane-429)`), task QUARANTINED,
  epoch closed degraded-halt, zero uncontrolled burn (worker logs: 11 CC-CLI
  retries per attempt, ~9min grind each, clean `infra_failed` classification —
  the X21 burn-class is dead). **Finding: a single-task epoch halts BEFORE the
  pause can fire** (the trigger's `!halted && phase!=='done'` gate — by design,
  nothing left to protect). The park proof needs the multi-task shape.
- **Arc 2 (the complete proof):** the 8-task cc epoch dispatched 4-parallel into
  the wall at 00:11Z; THREE DISTINCT tasks' quota infra-reports landed inside
  the 15-min window (00:19:32) → the count trigger fired → **alert issue #12
  opened FIRST** ("[fsm-alert] lane budget exhausted — epoch parked") → the
  pause CONTROL landed (`budget_pauses: 1`, chain `paused: true`, project
  `executing` — alive) with **4 backlog tasks PROTECTED** (the burn stops at
  exactly the protection point the design promised).
- **The operator remedy + resume:** `OPENROUTER_API_KEY` rotated to the
  ansgauretychis-B lane (fresh 1000/day — the credit reality: kasulty
  $10/$10.38 overdrawn, ansgauretychis-B $9.997/$10 spent, both free-lane-only
  keys) + the remedy recorded on the alert issue (comment 5737850985) + console
  `resume` (comment 5737851388, 00:29:59Z) → the re-dispatched workers ran
  REAL turns on the fresh lane — **T-101 done in 202s** (run logs: pure 200s on
  dots-studio after a session of pure 429s — the lane swap verbatim in the
  bridge lines).
- **The wrinkle (recorded honestly):** a SECOND pause fired
  (`budget_pauses: 2`) from straggler infra-reports landing just after the
  resume (the first batch's 9-minute grinds were still in flight when the
  window cleared — their reports re-populated the window post-resume). The
  at-least-once drain kept consuming reports while parked (T-101's done + 2
  work_failed + 1 poison landed) — the chain held correctly through both
  pauses. Resume #2 at 01:19:20Z (comment 5738198340) drains the backlog 4.
- Final tally (to be amended at halt): 1 done / 2 work_failed / 1 poison / 1
  quarantined (arc 1) / 4 backlog draining; `budget_pauses: 2`; zero burn
  beyond the bounded retry ladders.

**Machinery verdict: the lane-budget pause is live-proven end-to-end in its
designed shape (alert-first → pause → protection → operator remedy → resume →
real work completes).** The straggler re-pause is a benign race (the window
persists across a resume that races in-flight grinds) — candidate polish for
the W-D review round: clear the window only after the in-flight cohort's
reports drain, or accept the double-resume as operator routine.

**Session-close amendment (01:44Z):** the epoch is STILL DRAINING at session close — M2 unlocked (4 ready + 4 assigned) after M1's terminals: the chain is alive and progressing post-resume (the resume→work-completes half beyond T-101: milestone advancement is the structural proof). The dots-studio lane quarantines honestly on the harder tasks (`error_max_turns` — weak-model symptoms, exactly what the W-D model swap fixes). Next session records the final halt tally. EPOCH_MODE restored to 'mock' at 01:45Z (mid-flight safe — mode is baked at genesis).
