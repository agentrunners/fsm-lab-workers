# Task 45 — Fix-Wave Design (W2-e deep-code + W2-f live-security audits)

**Round:** Task 45 (session 14), wave-2 fix design — the pre-fleet hardening wave.
**Inputs:** W2-e probe-verified audit (`research/audits/w45-wave2/w2e-evidence.txt`, probes 1–6 under `/home/z/lab/probe-45w2/`), W2-f live+security audit (`w2f-live-security.md`, 747-run ledger, fsm-state @ fdd387b), the T44 landed base (main @ f8fad6a, gates 57/57 + sim 7/7 + sim2 7/7 + smoke 11/11).
**Live state at design time:** project `phase=done halted=true` v65 seq154, 7+ days of perfect quiescence under schedule pressure; all 5 workflows active at f8fad6a; no stranger activity ever. The deploy window is maximally safe (wakes are QUIESCED no-ops — no in-flight chain to split-deploy against).
**Scope discipline:** GAP-AUDIT G-15/G-17/G-18 + the W2-e P2/P3 set + the 44-h residuals still open. G-16 (lease renewal + ceilings for the CC drop-in) is deliberately OUT — it is assigned to the phase-2 worker-contract design, not this wave.

**Probe re-verification (this design round):** probes 1, 4, 6 re-run against the real lib at f8fad6a — probe1 reproduces exactly (CHECK1/2/3 all violated); probe6 reproduces. Probe4's headline was re-examined with a follow-up probe (`/home/z/probe-45p1a/p1a-followup-probe4.mjs`) and **partially reversed** — see F-A Finding-2.

**Review amendments (R3 + main-agent adjudications — folded BEFORE implementation; these override any conflicting earlier text in this document):**

- **R3 D1-B1 (BLOCKING) — F-A sweep direction, CORRECTED:** the earlier Semantics §2 text ("records `idNum < journalDropFrom` filtered out") inverted the filter — it would have dropped the GOOD pre-snapshot records and kept the rolled-back ones. The normative semantics (below, restated) is the fix-list table's: the repair commit **KEEPS records with `idNum < journalDropFrom`** (the pre-snapshot good records) and **DROPS records with `idNum ≥ journalDropFrom`** (the rolled-back ones). The Risk section's compare is likewise a KEEP-side compare.
- **R3 D1-M1 (MAJOR) — sweep↔rotatePlan integration, PINNED:** the sweep integrates **INSIDE `rotatePlan`'s append path** — the current gen's `[...prev, ...new]` block is assembled from the SWEPT previous lines, and non-current retained gens get their rewrite mappings from the same plan. **One writer per gen path per commit; never two update-index passes on the same file** (two mappings to one path = the later silently wins — either the sweep is undone or the repair's own records are lost). If the sweep empties the current gen entirely, **the gen file is removed and the repair's records land in the NEXT gen** (adjudicated choice; id-safe either way).
- **R3 D1-M2 (MAJOR) — F-C reserve clamp, HARDENED:** every dispatch budget clamps to `remaining() − SELF_TICK_RESERVE` — **the reserve is carved out FIRST**, not merely mentioned in the pacing formula. The self-tick dispatch can then never be starved by worker-dispatch ladders.
- **R3 D1-M3 — F-C loudness claim, REMOVED:** the earlier claim "with F-B landed, a persistent skip-chain becomes LOUD" is FALSE — a skip-chain still applies ticks (commit-before-act), so `last_tick` advances and F-B's latch can never fire; the runs are green. The real alert path for skip-chains is the **WORK-LANE BREAKER — an executor-side duty (cc-gha-public-executor repo), a CROSS-REPO DEPENDENCY deliberately out of this repo's scope**; noted here so the gap is owned there (in-lab, the eventual signal is the quarantine alert path ~max_attempts×lease late). In-repo, the skips are loud in logs/TURN-COMPLETE/step summary only.
- **Landing plan (main-agent adjudication):** F-B+F-D co-land in Push 2 (inseparable per R3); **F-C is pulled forward into Push 2**; F-G(b,c,d,d2) ride Push 3 (moved off Push 1); F-F lands whole (FSM half + worker half + rebuild mirror) in Push 1. F-F's `attempts -= 1` arithmetic vs the `max_attempts` doors and the classification split are R3-verified sound (adjudications #5/#6 confirmed as designed; `INFRA_RETRY_MAX` stays a lib constant, not a config knob).
- **R3's implementation gate for Push 1:** the probe1-shape store test PLUS a **"the repair's own records are present on-branch post-commit"** assertion must pass before Push 1 leaves the branch (the (b)-side double-writer failure mode: `journal_seq` advanced past records that never landed).
- **Added per main-agent instruction (R2's probe1 kill):** a minimal phase **QUALITY-GATE** in `fsm.mjs`'s completion branch — all-terminal with `done < 50%` of tasks halts as `project-degraded` (STOP_CHAIN reason `project-degraded`, PHASE record carries `degraded: true`, and the conductor posts a distinct `[fsm-alert] PROJECT HALTED DEGRADED` comment). The full start-gate + quality-gate laws live in phase-2's system repo, NOT here; this is the ~3-line lab-side half that makes a mass-quarantine "completion" read as degraded instead of "PROJECT COMPLETE".

---

## Fix list (ranked)

| # | Sev | One-line semantics change |
|---|---|---|
| F-A | P1 (G-15) | Recovery reconciles `journal_seq = max(snapshot, on-branch max id)+1`, the repair commit SWEEPS rolled-back journal records (ids ≥ snapshot seq) out of the retained gens, and rebuild becomes keeps-last-on-duplicate-id |
| F-B | P1 (G-17a) | The breaker's 30-min sliding window is replaced by a per-incident latch: N consecutive re-primes with zero chain progress (no `last_tick` advance past any of them) trips a LATCHED alert; re-arm = operator's manual fsm-tick (auto-releases on progress) |
| F-C | P1 (G-17b) | The conductor turn tracks a job-TTL deadline; every dispatch call's budget is clamped to remaining, and calls that no longer fit are SKIPPED loudly (lease/watchdog self-heal covers, per the documented failure model) |
| F-D | P2 (G-18a) | The 24h alert-marker dedup fetches `per_page=20&direction=desc`, takes the newest marker by `created_at` (order-independent), and only honors markers authored by MEMBER/COLLABORATOR/OWNER or a Bot |
| F-E | P2 | Worker report ids become `rep-${RUN_ID}-a${GITHUB_RUN_ATTEMPT}` + the documented re-run contract ("re-run only un-enqueued failures; the FSM retry ladder is the retry mechanism") |
| F-F | P2 | New REPORT outcome class `infra_failed` (lane unavailable): returns the task to ready with a net-zero attempt burn, own retry budget, and a distinct terminal reason on exhaustion |
| F-G | P3 batch | (a) mock sleep cap = TTL − margin; (b) event-ingest ids mint from the injected clock; (c) CONTROL records journal `actor` + `note`; (d) strict queue reads (ls-tree presence check); (d2) enqueue merges preserve unparseable lines; (e) document the TTL-kill-as-cancelled signature |
| F-H | P3 batch | 44-h residuals verified-current: F5 file-count assertion, F10 unconditional duplicate-token assertion, conductor-header fsm-report legacy note |

---

## F-A. Corruption-recovery journal integrity (G-15, W2-e P1-a)

**Where:** `lib/store.mjs` (`findLastGoodState` :438-451, `rotatePlan` :402-426, new sweep), `lib/conductor-core.mjs` (`mkJ` :73-77, repair path :59-69/:167-172), `lib/fsm.mjs` (`rebuild` :489-609), `conductor/turn.mjs` (`recover` closure :141-144).

**Problem:** recovery is ROLLBACK (state = last parseable snapshot) but the journal is never rolled back and the recovered state's `journal_seq` is never reconciled with the ids already on-branch. Three coupled defects:
1. **Duplicate primary keys** — `mkJ` mints from the snapshot's `journal_seq`, which is ≤ ids already sitting in the retained gen files.
2. **Event-sourcing inversion** — `rebuild(genesis, readJournals())` replays the rolled-back-era records and RESURRECTS work the recovery just rolled back; live and rebuilt diverge (the F8 parity contract inverts exactly when it is needed most).
3. **Gen mixing** — the repair commit's `rotatePlan` appends its new records into the current gen AFTER the corrupt-era records, so the corruption persists ~`keepGens×rotateAt` records until rotation prunes it.

**Evidence (probe1, re-run this round, byte-same as w2e-evidence):**
- era1 snapshot `journal_seq=6` → corrupt-era records `e7..e9` on-branch → recovery mints `e7`(TICK), `e8`(RECOVERY): `CHECK1 duplicate ids: e7 TICK|TICK, e8 ASSIGN|RECOVERY`.
- `CHECK2 state.journal_seq=9 ≤ max on-branch id=e9` — 1 phantom record (monotonicity violated).
- `CHECK3 live {v3, done=0, dispatched=2, A5=ready} vs rebuilt {v5, done=1, dispatched=3, A5=done}` — rebuild resurrects the rolled-back ASSIGN+REPORT.

**Finding-2 (P2-b REVERSED — adjudication needed):** W2-e P2-b claimed "recovery drops rolled-back worker reports unaudited". Follow-up probe (`/home/z/probe-45p1a/p1a-followup-probe4.mjs`) shows the recovery turn's queue drain processes EVERY on-branch queue line against the recovered snapshot: with the snapshot-valid lease the report **APPLIES** (`A1→done`, journaled `e4:REPORT>done`); with a rolled-back-era lease it is **stale-lease REJECTED** (journaled, `orphaned_reports+1`). Probe4's "journal records about it: 0" was a filter artifact (it matched `event_id` on records — applied REPORT records carry none — and never printed the task status). **The queue-audit hole as described does not exist.** The real unaudited drops live elsewhere: the enqueue-merge unparseable-line drops (G-11, folded here as F-G-d2) and the JOURNAL side of rollback (this fix's drop-sweep). The one-commit report-loss window (a report drained by the corrupt-era commit itself, then rolled back) remains the T44 deliberate non-fix — lease self-healing covers the work; after this fix the journal agrees with the rolled-back state instead of contradicting it.

**Semantics (before → after):**

*Before:* `recover()` → snapshot state → `mkJ` mints from snapshot seq; corrupt-era journal records stay on-branch; `rotatePlan` appends into the corrupt gen; rebuild replays everything in file order.

*After:*
1. **Reconciliation** — `recover()` (adapter closure) additionally returns `journalMaxId` (parsed from `store.readJournalTail(1)`'s newest record; `undefined` when no branch/journal). `conductorTick`, on any repair (history-walk **and** bootstrap-on-existing-branch), sets `base.journal_seq = Math.max(base.journal_seq, journalMaxId+1)` BEFORE the first `mkJ`. The RECOVERY record and everything after it mint strictly above every on-branch id. → CHECK1/CHECK2 dead.
2. **Rollback sweep (drop, not epoch-mark) — direction per R3 D1-B1, CORRECTED:** the repair marks `journalDropFrom = <snapshot's pre-repair journal_seq>`. `store.commit()` threads it into `rotatePlan`, which rewrites the retained gens so that **each contains ONLY records with `idNum < journalDropFrom`** (the pre-snapshot good records are KEPT); **records with `idNum ≥ journalDropFrom`** (the rolled-back era) **are DROPPED**, counted into the RECOVERY record's `droppedRecords`; a gen file whose swept content empties is **REMOVED** (add/remove gen files as their content empties). Rationale: the rollback decision ("state = snapshot") is a decision about the journal too — records above the snapshot are void-by-construction (their state.json was the garbage we just rejected); keeping them epoch-marked leaves two truths on-branch and keeps CHECK3's inversion alive for rebuild callers. **Integration point (R3 D1-M1, pinned):** the sweep lives INSIDE `rotatePlan` — the current gen's append block is `[...sweptPrev, ...newRecords]`, and non-current retained gens get their rewrite mappings from the SAME plan: one writer per gen path per commit, never a second update-index pass over the same file. If the sweep empties the current gen entirely, the gen file is removed and the records land in the NEXT gen (adjudicated; id-safe either way). The sweep happens ONCE, at repair; subsequent commits are clean. → probe1 CHECK3 converged: rebuild's input no longer contains the rolled-back era.
3. **RECOVERY record enrichment** — the epoch record carries `{reason, dropFrom, droppedRecords: N, snapshotSha}` (audit: what the repair voided; grep-able). The proposed `dropped_reports`/REJECTED-for-queue-lines sub-fix from the brief is **dropped** per Finding-2 (the queue drain already journals everything).
4. **Rebuild keeps-last-on-duplicate-id** — `rebuild()` first-pass builds `lastById` (last occurrence wins, content identical for the frozen branch's overlap residue), then replays each id once at its first-occurrence position. Defense-in-depth: makes rebuild total on ANY duplicate-id journal (the live branch's mixed-deploy gens 8-10 carry 992 dup lines until pruned; a pre-fix recovery shape; any future bug) instead of double-applying.
5. `journalRecordsAfter()` (dead code) stays dead; the recovery replay path remains deliberately not-built (T44 non-fix stands — convergence argument unchanged, now honest).

**Tests:**
- `tests/test-store.mjs` (new): repair-sweep test — probe1's exact shape driven through a real Store: assert (a) zero duplicate ids on-branch post-repair, (b) `state.journal_seq > max on-branch id`, (c) all records `≥ snapshot seq` gone (listStateFiles + readJournals), (d) gen file removed when the sweep empties it, (e) multi-gen straddle: corrupt-era records spanning the last two gens are swept from BOTH, (f) **R3's gate: the repair commit's OWN records are present on-branch post-commit** (the (b)-side double-writer failure — journal_seq advanced past records that never landed).
- `tests/test-conductor-core.mjs` (new): recovery with `journalMaxId` — the RECOVERY record's id > maxId; `journalDropFrom` returned when repairing; bootstrap-with-existing-branch also reconciles.
- `tests/test-fsm.mjs` (new): rebuild keeps-last — journal with duplicated ids (different content) replays the LAST content once; `journal_seq` monotonic through duplicates.
- Existing F8 parity test extended: drive a corruption-recovery into the rich sequence and assert live ≡ rebuilt on the projection.
- Sim2: optional — the shim could inject a corrupt-commit; keep out (unit+store cover; sim2's value is GHA physics, not git corruption).

**Rollout / atomicity:** all four files (`store.mjs`, `conductor-core.mjs`, `fsm.mjs`, `conductor/turn.mjs`) MUST land in ONE push — a conductor running new `conductor-core` against an old `store` (or any mix) re-creates duplicate ids. Live migration: none needed (the live branch has never had a recovery; gens 8-10's duplicate lines are read-safe under keeps-last rebuild).

**Risk:** the sweep rewrites gen files in the repair commit — a bug there could drop GOOD records. Mitigations: the filter KEEPS records on a strict `idNum < dropFrom` numeric compare (it drops only `idNum ≥ dropFrom`); `droppedRecords: N` on the RECOVERY record makes every sweep auditable; the multi-gen straddle test pins the sweep's coverage; the repair's-own-records assertion pins the double-writer hazard; git history retains the pre-sweep blobs (a bad sweep is itself recoverable by history-walk — the exact machinery being fixed). Residual: an unparseable newest journal line under-reports `journalMaxId` (readJournalTail WARN-skips it) — accepted, the next id merely re-uses a slot occupied by an unparseable line (no valid-record collision). Journal-DESTRUCTIVE damage (gens deleted, not state corrupted) still leaves rebuild divergent below the snapshot — the T44 no-replay non-fix stands; the parity claim covers corrupt-state damage (the X15 drill shape).

---

## F-B. Circuit-breaker latch (G-17a, W2-e P1-c)

**Where:** `watchdog/scan.mjs` (:26-27 window consts, :121-134 breaker block, :137-149 re-prime), new `lib/watchdog-core.mjs` (pure decision extracted — the breaker arithmetic currently has ZERO automated coverage; P1-c lives exactly there).

**Problem:** the breaker requires ≥3 re-primes inside a 30-minute sliding window, but production cadences are ~2h (native) to 2-6h (executor) — the window can never fill. A permanently-dead conductor is re-primed FOREVER with zero operator alerts (watchdog runs green; the conductor's red runs are watched by nobody — G-A2). Even when it does fire (dense regime), it unlatches when the window slides — probe3: "breaker opened 6× in 24 scans": a 30-min pause, not a latch.

**Evidence (probe3A, arithmetic re-verified by reading scan.mjs:123-133):** manual 5-min scans → breaker fires; dense 10-min → fires; observed live ~2h (48 scans/48 re-primes/0 alerts) and executor 2-6h (24/24/0) → `ETERNAL SILENT RE-PRIME LOOP`.

**Semantics (before → after):**

*Before:* `reprimes-in-30min ≥ 3 && stale` → open alert, stop re-priming (resumes when the window empties).

*After — a per-incident, memory-free LATCH:*
1. Each scan (stale, not in-flight) fetches the newest `per_page=100` conductor runs and selects the newest `MAX_LATCH_REPRIMES = 3` runs named `watchdog-reprime`.
2. **LATCH condition:** all 3 exist AND all 3 were `created_at > state.chain.last_tick` — i.e. the last 3 re-primes ALL failed to produce an applied tick. This is exactly "no chain progress across N consecutive re-primes" with `last_tick` as the progress witness (equivalent to the seq variant — both advance in the same TICK branch — but needs no run-name schema change).
3. Latched → do NOT re-prime; open/refresh the ONE alert issue (24h-deduped comment, F-D-hardened) with the breaker body restated: `latched after 3 re-primes with no chain progress (seq frozen at N, last_tick T) — re-priming DISABLED until a tick lands`.
4. **Re-arm (the T43 breaker contract, unchanged):** the operator fixes the root cause and dispatches `fsm-tick` manually (the curl already printed in every alert body). If that tick lands, `last_tick` advances past the re-prime runs → the latch condition is false on the next scan → re-priming resumes automatically. No new ops command is introduced (adjudication point below): the latch is DERIVED state (run ledger + `last_tick`), so there is nothing to persist and nothing to reset — any applied tick IS the re-arm.
5. The 30-min window is **removed** (subsumed: at X5b's manual 5-min cadence the latch trips on the 4th scan, same as today's breaker; at 2h it trips on the 4th scan ≈ 6h — cadence-proof). The dense-window code dies; one rule, all regimes.
6. Self-healing corollary: any backstop tick that commits also advances `last_tick` → unlatch. A revived-but-slow chain never latches (its re-primes sit below `last_tick`).

**Tests:** new `tests/test-watchdog-core.mjs` driving the extracted pure `breakerDecision({state, recentRuns, nowMs})`:
- probe3A's four regimes as table tests (5-min/10-min/2h/2-6h scan spacings, dead chain): latch fires in ALL four (the probe's headline inverted).
- progress case: a re-prime followed by `last_tick` advance → counter effectively resets, no latch.
- revival case: 3 latched re-primes then a landed tick → unlatch on the next scan.
- in-flight guard unchanged (queued/running conductor run → wait, no re-prime).
- corrupt-state path (early return, alert-only) unchanged.

**Rollout / atomicity:** watchdog-only (no state writes ever — single-writer discipline untouched). Independent of every other fix; can land alone. Live migration: none (the alert issue is closed; the latch first arms whenever the next dead-chain incident occurs).

**Risk:** a chain whose ticks apply but whose WORK never progresses (FSM livelock with live heartbeats) never latches — same blind spot as the seq-progress variant (seq advances on every applied TICK); that class belongs to the executor failure-watch (G-A2 wiring), not the watchdog. Run-ledger dependency: re-prime runs must remain listable (90-day default retention; a dead chain latches within hours — ample). `last_tick` is read from state.json each scan — a corrupt state takes the corrupt path (alert, no re-prime), which is itself latch-shaped. Worst case of a WRONG latch (chain actually alive, `last_tick` somehow stale): one alert comment + no re-primes until any tick lands — fail-safe direction.

---

## F-C. Per-turn dispatch budget vs the 10-min job TTL (G-17b, W2-f F-2)

**Where:** `conductor/turn.mjs` (`dispatchRetry` :75-98 — `BUDGET_MS=240_000` PER CALL; action loop :163-173; pacing + self-tick :199-211), `conductor.yml` (:55 `timeout-minutes: 10`; env block).

**Problem:** the turn's worst case is pacing 240s + k×240s worker dispatches + 240s self-tick. k=1 → 720s > the 600s job TTL: the job dies MID-DISPATCH (exit code 3 unreachable, summary never written), leases are already committed (workers never dispatched), the self-tick is lost → dead chain → the F-1 blind window (median 74min, worst 5.4h). Never observed live (turns p50 33s / max 71s; 461/461 dispatch-fired runs OK) — unsound headroom, not an incident. The 44-f F6 amendment said "cap total retry budget under the job timeout"; it was implemented per-CALL.

**Evidence:** w2f §3.1 (arithmetic + conductor.yml:55 + turn duration stats); 44-h P3(i) (the same finding at review time, unfixed).

**Semantics (before → after):**

*Before:* every `dispatchRetry` call gets its own fresh 240s budget; pacing sleeps up to 240s unconditionally; nothing knows the job deadline.

*After:*
1. **Deadline plumbing:** conductor.yml env gains `RUN_STARTED_AT: ${{ github.run_started_at }}` (R3-verified: the github-context property exists but there is NO default runner env var — the explicit mapping is REQUIRED) and `JOB_TTL_MIN: '10'` (comment: keep in sync with `timeout-minutes`). The adapter computes `deadlineMs = Date.parse(RUN_STARTED_AT) + JOB_TTL_MIN*60_000 − SAFETY_MS(45s)`; local fallback (no env) = process start + 10min (the smoke path).
2. **Clamp — the reserve is carved out FIRST (R3 D1-M2, hardened):** `dispatchRetry(eventType, payload, {budgetMs})` — every WORKER-dispatch call's budget is `max(0, remaining() − SELF_TICK_RESERVE(30s))`; every internal wait uses `min(wait, budgetLeft)`; a budget ≤ 0 aborts the ladder. The self-tick's own call gets the full `remaining()` (it is the turn's LAST call) — with the reserve carved out of every worker ladder up front, the heartbeat's window can never be starved by dispatch ladders.
3. **Skip, don't die:** `MIN_CALL_MS = 30s` (one POST + the 20s AbortSignal cap + slack). Before each worker dispatch: the post-reserve budget `< MIN_CALL_MS` → skip the dispatch, log `DISPATCH-SKIPPED task=X budget-exhausted`, count into `dispatchSkipped` (surfaced in TURN-COMPLETE and the step summary next to `dispatchFailures`), and BREAK the action loop (remaining only shrinks). The lease deadline re-covers the un-dispatched task (timeout → retry) — the documented crash-between-3-and-4 model, now entered deliberately and visibly.
4. **Pacing under budget:** the pace sleep becomes `min(intervalMs − elapsed, remaining() − SELF_TICK_RESERVE(30s), 240s)`; ≤ 0 → skip pacing (a faster tick is harmless; the throttle is a nicety).
5. **Self-tick under budget:** `remaining() < MIN_CALL_MS` → skip, log `SELF-TICK-SKIPPED budget-exhausted — watchdog/backstop revives` (the documented crash-between-4-and-5 model). NOTE (R3 D1-M3, corrected): a persistent skip-chain does NOT alert via F-B — skip-chains still apply ticks, `last_tick` advances, the latch can never fire, and the runs stay green. The real alert path for skip-chains is the work-lane breaker — an EXECUTOR-SIDE duty (cross-repo dependency on cc-gha-public-executor, out of scope here); in-lab the skips are loud in logs + TURN-COMPLETE + the step summary, and the quarantine path eventually fires late.
6. Extraction: the budget arithmetic goes into a tiny pure helper (`makeBudget({startMs, ttlMs, safetyMs, nowMs}) → {remaining(), clamp(ms), fits(minMs)}` in `lib/conductor-core.mjs`) — unit-testable without I/O.

**Tests:** `tests/test-conductor-core.mjs` (or a new test-budget file): clamp math, skip thresholds, monotonic remaining, fallback deadline. `scripts/smoke-conductor.sh`: new case — run the REAL adapter with `JOB_TTL_MIN` tiny (e.g. 0.01) and ≥1 dispatch action: assert the commit LANDED, dispatches were skipped with the log line, exit code stays 0, and the self-tick was skipped (offline dispatch death already tolerated there). Existing suites unchanged.

**Rollout / atomicity:** YAML env + adapter code must co-land (one push). No lib changes — independent of F-A/F-F semantics. A mixed window (new yaml, old code) is impossible within one push; the yaml env is additive (old code ignores it).

**Risk:** `run_started_at` vs actual job start (checkout ~20-60s before the node step): covered by the 45s safety margin — the budget is advisory headroom, never a correctness deadline (the job TTL itself is the backstop, as today). Over-conservative skips cost one lease-timeout retry cycle (~lease_minutes) — bounded, visible, self-healing; under-protection (deadline too late) degrades to today's behavior exactly. The `JOB_TTL_MIN`/`timeout-minutes` sync risk is documented in the yaml comment; a future mismatch can only make the budget conservative or equal — never larger than the real TTL unless someone lowers `timeout-minutes` without the env (noted).

---

## F-D. Alert-marker author hardening (G-18a, W2-f F-3 + W2-e P2-d)

**Where:** `watchdog/scan.mjs` `openAlertIssue` :52-76 (the dedup fetch :61-62).

**Problem:** (a) STRANGER-REACHABLE SUPPRESSION — the newest comment containing `[fsm-watchdog]` <24h suppresses the alert body; on a public repo ANY anonymous commenter can stay newest and strip diagnostics + re-arm instructions from a live alert (bounded impact: alert content only; re-priming unaffected; dormant today — issue #2 closed, strangers cannot create labeled issues). (b) PER_PAGE=1 REGRESSION — one operator reply (no marker) makes `find()` miss → one extra marker comment per scan (~12/day while a human keeps replying).

**Evidence:** w2f §1.3 + F-3 (scan.mjs:61-66); probe3B (the 4-step comment-interleave table: `skip(per_page=1)=NO` exactly when an operator reply is newest; `per_page=20,DESC` skips correctly); W2-b law-20 live A/B (`sort`/`direction` params IGNORED on list endpoints — the fetch must not depend on server-side ordering).

**Semantics (before → after):**

*Before:* fetch `?per_page=1&sort=created&direction=desc`; `find()` the first comment containing `[fsm-watchdog]`; if <24h old → skip.

*After:*
1. Fetch `?per_page=20&sort=created&direction=desc` (also fixes P2-d: the marker is found even when an operator reply is newest).
2. **Order-independent newest-marker:** select among the fetched comments the marker comment with MAX `created_at` (robust to law-20: if the server returns ascending/oldest-20, the arithmetic still picks the newest marker IN the fetched set — an out-of-set newest marker simply fails to dedup → an extra alert comment, the fail-NOISY direction, never the suppress direction).
3. **Author gate:** a marker comment refreshes the 24h window ONLY if `c.author_association ∈ {MEMBER, COLLABORATOR, OWNER}` OR `c.user?.type === 'Bot'`. Anonymous (`NONE`) and drive-by (`CONTRIBUTOR`, `FIRST_TIME_*`) markers are ignored. The watchdog's own posts pass via `type === 'Bot'` (github-actions[bot]); the LAB_PAT fallback lane passes via `COLLABORATOR` (zikomolapoutl). Both trust lanes stay functional; the stranger lane dies.
4. The dedup decision is extracted to `lib/watchdog-core.mjs` (`alertDedup({comments, nowMs}) → {skip, markerAgeMin}`) sharing the module with F-B's `breakerDecision`.

**Tests:** `tests/test-watchdog-core.mjs`: anonymous newest marker → NO skip (the suppression kill); bot marker <24h → skip; operator reply newest + marker 10min old in the set → skip (the P2-d fix); 25 comments with the marker outside the fetched 20 → no skip (fail-noisy); ascending-order server response → same verdicts; marker >24h → no skip.

**Rollout / atomicity:** watchdog-only; co-lands with F-B (same file/module — one push, one review). Independent of everything else. Dormant channel live (issue #2 closed): first exercise is the next alert.

**Risk:** an attacker-gamed `CONTRIBUTOR` marker (they'd need a merged PR — the repo takes no PRs) — excluded anyway. A trusted-but-compromised collaborator marker is inside the trust boundary (equivalent to write access — accepted). Over-alerting if both gates mis-fire: bounded by the 24h window + one-issue dedup (12 comments/day worst case — the pre-44-h status quo). The `type==='Bot'` lane admits any bot that can comment on the repo (Apps must be installed to comment; github-actions[bot]/dependabot only in practice) — accepted for a marker that gates COMMENT NOISE, not control.

---

## F-E. Worker re-run event ids (W2-e P2-a)

**Where:** `worker/turn.mjs` (:88 repeatReport payload, :100 normal payload — `event_id: rep-${RUN_ID}`), `worker.yml` (env: `GITHUB_RUN_ID` only), `lib/event-ingest.mjs` (id-minter home).

**Problem:** `GITHUB_RUN_ID` is STABLE across GHA re-runs (only `GITHUB_RUN_ATTEMPT` increments). A re-run of a flaky worker whose first report already enqueued gets its better result DEDUP-SWALLOWED (F11 consumed the identity on the failed outcome): success artifact lost, a retry attempt burned, a fresh worker dispatched for work that is already done. Probe2's contrast shows attempt-scoping alone converts the swallow into a stale-lease ORPHAN (the failed-report drain reassigns in the same clock pass) — so a re-run can never IMPROVE an outcome; it can only stop silently destroying information.

**Evidence:** probe2 (Shape A: `duplicate-rejects=1`, attempts 1→2, artifact swallowed; Contrast: attempt-scoped id → applies/orphans by lease, never dedup-swallowed); w2e P2-a.

**Semantics (before → after):**

*Before:* `event_id = rep-${GITHUB_RUN_ID}` — one identity per run, re-run attempts collide.

*After:*
1. `worker.yml` env gains `GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}`.
2. `event_id = rep-${RUN_ID}-a${ATTEMPT}` (both payload sites :88/:100; the dup-behavior's two posts share ONE id per attempt — the dedup regression's shape is preserved on purpose). The minter moves to `lib/event-ingest.mjs` as exported `reportEventId({runId, attempt})` (production converges to the shape sim2's worker model already uses — `rep-<task>-<attempt>-<seq>` — closing the "model more correct than the modeled code" gap).
3. **Re-run contract documented** (worker header comment + README failure-matrix row): *re-run only workers whose report never enqueued (enqueue failure, infra blip). Once a report is enqueued, the FSM's retry ladder is the retry mechanism; a re-run cannot improve an outcome — its report lands as a stale-lease orphan (journaled, `orphaned_reports`), visible waste, never silent.*

**Tests:** `tests/test-event-ingest.mjs` (new file or fold into conductor-core tests): `reportEventId` format + uniqueness across attempts; existing dedup tests unchanged. `tests/test-store.mjs` or conductor-core: probe2's Shape A re-driven — two lines `rep-111-a1{failed}` + `rep-111-a2{done}`: the failed applies (attempt burn), the second is stale-lease REJECTED (task reassigned in the same pass) — the documented contract, asserted (NOT a dedup swallow).

**Rollout / atomicity:** worker.yml env + worker code co-land (one push). Loose coupling to the FSM (old FSM + new ids: fine — ids are opaque; new FSM + old worker: nothing changes). Independent of F-A/F-B/F-C.

**Risk:** `github.run_attempt` on the FIRST attempt is `1` — ids become `rep-<run>-a1`; old-shape ids (`rep-<run>`) remain valid opaque strings in dedup (no migration). Double-report-per-attempt (the dup behavior) unchanged. The orphan-noise increase on naive re-runs is bounded (one REJECTED + one orphan stat per re-run) and is exactly the visibility the contract wants.

---

## F-F. `infra_failed` outcome class (W2-e P2-c)

**Where:** `worker/turn.mjs` `realWork` :31-61 (classification), `lib/fsm.mjs` REPORT case :148-174 (new branch), `lib/fsm.mjs` genesis stats :92 + `rebuild` REPORT case :504-513, `conductor/turn.mjs` `summaryMd` :107-119, `lib/mock.mjs` (new behavior).

**Problem:** the worker maps EVERY non-200/timeout/empty to `outcome.status='failed'` (or throws → no report at all → lease timeout), and the FSM burns an attempt on every `failed`. Free-lane 429/5xx flaps (the documented free-key lifecycle: RPD limits, 5xx flaps, 402 drained keys) systematically quarantine HEALTHY tasks at `max_attempts=3` — the failure model conflates "the lane was unavailable" with "the work failed".

**Evidence:** w2e P2-c (code-walk: worker/turn.mjs:56-58 maps all non-200 to failed; fsm.mjs:167-172 burns attempts); the key-pool lifecycle laws (sa2 ledger; OPENROUTER-KEYS: 402-with-top-up vs 401-expired).

**Semantics (before → after):**

*Worker classification* (`realWork`):
- transport/timeout: the `fetch` is wrapped — a throw (AbortSignal timeout, DNS, socket) → `{status:'infra_failed', error:'transport-<name>'}` (previously: uncaught → no report → lease timeout → attempt burn + `timeouts` stat).
- HTTP `{401, 402, 429, 5xx}` → `{status:'infra_failed', error:'openrouter-<status>'}` (lane/key state — operator action, not task poison; 402 = drained-with-top-up, 401 = expired key: both infra per the key-pool laws).
- 200 + content → `done` (unchanged).
- 200 + empty completion → `failed` (`error:'empty-completion'`) — **work-class** (the lane answered; the model produced nothing; retrying is meaningful; adjudication point below).
- other 4xx → `failed` with the status code (our-payload/deterministic class; fail fast through the normal ladder).

*FSM REPORT branch* (new, before the `failed` branch):
- `outcome.status === 'infra_failed'`:
  - `t.infra_attempts += 1` (new per-task counter; absent-field-tolerant `?? 0` for existing states).
  - If `t.infra_attempts >= INFRA_RETRY_MAX` (constant, 3) → `quarantined` with history why `infra-exhausted(lane-dead)`; journal `REPORT {to:'quarantined', reason:'infra-exhausted', run_id, error}` — terminal, visible, counted; the attempts count is left as-is for forensics.
  - Else → `ready` with `attempts -= 1` (**net-zero burn**: the assignment is voided — the worker never got to attempt the work), `lease = null`, history why `infra-retry(lane-unavailable)`, `stats.infra_retries += 1`; journal `REPORT {to:'ready', reason:'infra-retry', run_id, error}` (the reason field is new on REPORT records — additive).
- `failed` (work-class) branch unchanged (burns attempts, `max_attempts` gate, quarantine).
- `stats` gains `infra_retries` (genesis default 0; recount untouched — not a status count; `summaryMd` row added; rebuild mirrors it).
- `rebuild` REPORT case mirrors both reasons (`infra-retry`: status→ready, `attempts=max(0,attempts−1)`, lease=null; `infra-exhausted`: status→quarantined) — F8 parity discipline.
- `mock.mjs` gains behavior `infra` (returns `{status:'infra_failed', error:'mock-lane-429'}` for the first K attempts via ctx) so the sim/tests can drive the class deterministically.

**Why the decrement (net-zero) rather than a parallel failure counter:** `attempts` is load-bearing (journal, history, `max_attempts` gating, ASSIGN records); a parallel counter would need its own gate everywhere the ladder reads `attempts`. Voiding the assignment restores the invariant "attempts counts real work attempts" with one line. The infra budget is then the ONLY thing that can park the task — via the explicit `infra-exhausted` terminal reason.

**Tests:** `tests/test-fsm.mjs`: infra report on an assigned task → ready, attempts back to pre-assign value, `infra_retries++`, lease cleared; reassignment next clock; `INFRA_RETRY_MAX` → quarantined with the distinct reason; work-failed still burns; dedup/edge behavior unchanged (infra report on a terminal task → task-not-leased reject). Rebuild parity for a sequence containing infra-retry + infra-exhausted records. `tests/test-conductor-core.mjs`: infra report drains through the tick. Sim: `run-sim.mjs` scenario optional (mock behavior + assertion `failed==0 && infra_retries==K` on a flapping lane).

**Rollout / atomicity:** the FSM half and worker half are LOOSELY coupled (a new worker against an old FSM produces `bad-outcome(infra_failed)` rejects — journaled, id consumed, task lease-timeout'd = today's degraded behavior, safe; an old worker never emits the class). Recommended: land both halves in the semantics push (wave 1) so the class is end-to-end real; the worker half may ride the lane push instead if review splits — documented hazard: none.

**Risk:** a worker that misclassifies a poison task as infra loops `assign→infra` up to `INFRA_RETRY_MAX` (3 dispatches) before parking — bounded by the constant, visible in `infra_retries`. A permanently-dead lane parks ALL in-flight tasks as `infra-exhausted` (distinct reason + stat — the operator can distinguish lane-death quarantine from task-poison quarantine and re-run via reset after fixing the lane). The `attempts` decrement can never go negative (`Math.max(0, …)` + the `attempts-negative` invariant already exists).

---

## F-G. P3 batch (W2-e P3s + W2-f F-5)

### (a) Mock sleep cap = TTL − margin — probe5A
**Where:** `worker/turn.mjs:74` (`Math.min(w.sleepMs, 20*60_000)`), `worker.yml:40`.
**Problem:** the cap EQUALS `timeout-minutes: 20` — the job is SIGTERM-killed ~30-60s before the capped sleep resolves (checkout+node startup), so `slow` (T-108) degenerates to no-report and the designed orphaned-report lane is unreachable from the mock lane (probe5A: `TIMEOUT-KILLED`, no report; A2 with cap<timeout: report enqueued — the lane lives).
**Semantics:** cap = `(WORKER_TTL_MIN − 2) * 60_000`, with `WORKER_TTL_MIN` from env (worker.yml adds `WORKER_TTL_MIN: '20'`, comment: keep in sync with `timeout-minutes`), default 20. `slow`'s 30-min work sleeps 18min, exits 0, reports late → stale-lease orphan — the stat becomes reachable live.
**Tests:** none beyond existing (behavioral, GHA-side); note in EVIDENCE when first observed. Unit option: none (the cap is env arithmetic).
**Risk:** none — strictly widens the report lane.

### (b) Event-ingest ids mint from the injected clock — probe6
**Where:** `lib/event-ingest.mjs:45,56` (`Date.now()` in `ctl-direct-${cmd}-…` and `tick-${reason}-…`).
**Problem:** identity escapes the injected `now()` — two same-real-ms wakes mint IDENTICAL ids and the second legitimate wake is consumed as `duplicate` (probe6: `applied=false`, REJECTED/duplicate, a silent wake loss + a burned journal slot). Improbable at 164s dispatch latency; a determinism seam and a fast-lane (executor pinger) hazard.
**Semantics:** `…-${Date.parse(now())}` (the injected ISO → ms; the id shape stays `<kind>-<reason>-<ms>`). Probe6's virtual-clock wake2 now mints a distinct id and applies.
**Tests:** event-ingest test — frozen `Date.now` (monkeypatched), virtual clock advancing 1s → distinct ids, second wake applies (probe6 as regression).
**Risk:** none observable (ids remain opaque strings; same-ms collisions were already possible in the old scheme — this only removes the clock escape).

### (c) Ops note + sender journaling — W2-e P3-c
**Where:** `ops/turn.mjs` (rec :71-77 — `note` already rides the queue record; add `sender: EVENT.sender?.login`), `lib/conductor-core.mjs:113` (`cev` — pass `note`, `actor: c.sender`), `lib/fsm.mjs` CONTROL case (:186-216 — journal `actor` + `note`), `lib/event-ingest.mjs` (direct CONTROL events: carry `githubEvent.sender?.login` as actor).
**Problem:** ops.yml promises "operator note (journaled)" but the drain drops `c.note`; CONTROL journal records carry NO actor anywhere — the fleet core's audit trail cannot answer "who commanded pause/reset" (the w2f F-4 identity gap is the security face of the same hole).
**Semantics:** control-queue records and direct control events carry `sender`; the CONTROL journal record gains `actor: <sender||null>` + `note: <String(note).slice(0,200)||null>`; rebuild ignores both (audit-only fields — additive, F8-safe). The ops issue comment already echoes the command; nothing else changes.
**Tests:** conductor-core test — queued pause with note+sender → the CONTROL journal record carries both; direct dispatch control carries the sender; note absence → null.
**Risk:** journal-record growth is bounded (200c). No behavior gate reads actor (audit-only — the ops WRITE gate stays GitHub's write-access model; see adjudication #6).

### (d) Strict queue reads (ls-tree presence check) — W2-e P3-d
**Where:** `lib/store.mjs` `readFile` :81-84; queue/control readers :288-299/:333-344; enqueue paths :305-327/:347-369.
**Problem:** `readFile` returns `null` for BOTH "path absent on branch" and "`git show` failed" (both rc 128 — verified by W2-e). Local-clone object damage after a successful fetch would make a drain or enqueue-merge treat an EXISTING queue as empty and rewrite/delete it.
**Semantics:** new `readFileStrict(path)`: `ls-tree --name-only <remoteRef> -- <path>` first; path present + `show` fails → **throw** (loud; the CAS push is untouched — no data loss, the turn fails visibly); path absent → `null`. Used by `readQueueEx`/`readControlQueueEx` (and therefore the drain, the enqueues, and `rotatePlan`'s gen reads via `readJournalLines`… keep `readJournals`' WARN-skip semantics for journal CONTENT lines — the strict check is about FILE presence, not line parseability).
**Tests:** store test — sabotage `git show` via a PATH-shimmed spawn? Simpler: fault-injection env `FSM_LAB_FAULT_READ_SHOW=1` (mirroring `FSM_LAB_FAULT_COMMIT_TREE === '1'`) making `show` fail while ls-tree succeeds → assert the drain/enqueue THROWS and the branch tip is unchanged.
**Risk:** one extra `git ls-tree` spawn per queue read (~2/commit) — noise. The throw path converts a silent data loss into a failed run — the correct direction (lease/watchdog cover).

### (d2) Enqueue merges preserve unparseable lines — G-11 (folded here: same code, same discipline)
**Where:** `store.mjs` `enqueueReport` :353 / `enqueueControl` :311 — both merge over `readQueue()`/`readControlQueue()` (items only).
**Problem:** a worker/ops CAS-append onto a queue holding an unparseable line SILENTLY DELETES that line in the merge (the audit-before-drop discipline only holds if the conductor drains first — 44-h P3(iii), the last real unaudited-drop surface after F-A's Finding-2).
**Semantics:** enqueues read via `readQueueEx()` and re-serialize the bad lines verbatim ahead of the appended record (`[...bad.map(String), ...items, rec]`); the conductor's drain journals them REJECTED(unparseable) then drops them (existing behavior). Nothing is dropped by a non-drain writer.
**Tests:** store test — queue with one bad line + enqueue → the branch queue still holds 2 lines (bad preserved + new); then a drain → REJECTED(unparseable) journaled, queue emptied (the full discipline, end-to-end).
**Risk:** bad lines persist until the next drain (bounded by queue file size; the drain is the only consumer). Ordering (bad-first) is cosmetic.

### (e) TTL-kill-as-cancelled signature documented — W2-f F-5, doc-only
**Where:** `README.md` (failure matrix row), `worker.yml` header comment, `EVIDENCE.md` footnote.
**Problem:** a `timeout-minutes` kill presents as `conclusion=cancelled` (run 34073438112: step 20m03s, cancelled) — any failure-watch counting `failure` conclusions is blind to the worker TTL-kill class; in-lab the lease deadline is the semantic handler BY DESIGN, but the executor failure-watch porting contract must carry the signature.
**Semantics:** doc-only: "a worker TTL kill = conclusion `cancelled` with a step duration ≈ timeout-minutes; failure-watch porting must count it as the kill class (in-lab: the lease/quarantine path is the handler — the run conclusion is cosmetic)". No cheap marker exists (the killed process can't log); the doc note is the deliverable.
**Risk:** none.

---

## F-H. 44-h residuals still open (G-11) — verified current

Re-verified against main @ f8fad6a before designing (the 44-h review-round commit 401d948 already resolved several):

| 44-h item | Status @ f8fad6a | Action |
|---|---|---|
| ops.yml header omits `configure` | **RESOLVED** (ops.yml:6 lists all six commands; 401d948) | none |
| F9 test tautology (`const rej = true; assert.ok(rej)`) | **RESOLVED** (no tautology present; 401d948 cleanups) | none |
| F5 test never asserts files ≤ keepGens | **OPEN** — test-store.mjs:325-359 asserts distinct ids + `ids.length ≤ 40` but never the FILE count | add `assert.ok(files.length <= st.keepGens + 1)` (the +1 covers the in-flight gen at the append boundary) |
| F10 duplicate-token assertion conditional | **OPEN** — test-fsm.mjs:539-542 silently skips when <2 actives | boot with `max_parallel: 4` (≥2 ready tasks guaranteed — fastProject m1 has 4+) and assert UNCONDITIONALLY |
| conductor header documents the fsm-report wake shape | **OPEN** — conductor/turn.mjs:15 lists the legacy lane without noting the workflow no longer triggers it (conductor.yml:27 has no fsm-report type; the buildEvent branch is dead-but-reachable only via a write-access direct dispatch that fires nothing) | annotate the line: `(legacy — no workflow registers this type; the router branch is kept for payload-shape strictness)`; same note in event-ingest.mjs:35 |

**Tests:** the two assertion upgrades ARE the fix (they harden existing tests); no new tests.
**Rollout:** doc/test-only — rides any push; zero risk.

---

## Deliberate non-fixes / out-of-scope (recorded decisions)

- **G-16 (W2-e P1-b): lease renewal + ceilings for the CC drop-in** — progress reports don't extend `expires`, `lease_minutes ≤ 120`, worker TTL 20min, `realWork` 150s cap. Assigned to the **phase-2 worker-contract design** (GAP-AUDIT's routing), not this wave: the fix is a lane-parameterization + renewal-policy design, not a defect repair, and it needs the CC-ceiling validation run first (sa2 §2.19). F-G(a) restores the orphan lane so the CURRENT semantics are at least exercisable.
- **G-18b (W2-f F-4): ops-gate identity check** (`author_association` gate on the ops ingest) — the write set is exactly {xfnwpho1, zikomolapoutl} + job bot and GitHub's write-access model IS the gate (w2f §1.1); F-G(c) journals the actor so the audit trail can answer "who", which is the cheap half. A hard identity allowlist adds a config surface for defense-in-depth only — main-agent adjudication (#6), deliberately not designed here.
- **F-1/G-A2: executor-scheduler wiring for the watchdog** — the highest-value operational fix (makes F-B's latch rarely needed) but it is executor-repo work + an operator decision, not an fsm-lab code fix.
- **Journal-ahead replay on recovery** — the T44 non-fix stands (convergence via lease self-healing + queue re-drain); F-A makes the journal AGREE with the rollback instead of replaying through it.
- **Dedup-window semantics, state.json size at scale, `node --test` quirks** — the T44 non-fix list carries over unchanged.

---

## Wave-landing plan

**Base fact:** the live project is quiesced (done+halted since Sep 7; wakes are no-op); workflows hot-pick-up main per wake. Every push is a single atomic ref update — a wake mid-push sees a self-consistent tree. The split-deploy hazard class (T44's A1) requires a fix pair whose halves MUTUALLY ACTIVATE dormant behavior; no fix pair in this wave has that shape (verified: F-B/F-D write no state; F-C/F-E are adapter-local; F-A/F-F touch the drain but nothing in the OLD tree depends on the NEW tree's behavior — mixed windows degrade to today's semantics, never worse). Therefore a single push OR the split below are both safe; the split exists to keep reviews small.

- **Push 1 — semantics (FSM/store/core cluster): F-A + F-F (whole: FSM branch + worker classification + rebuild mirror + stats) + their tests.**
  Internal atomicity constraints: F-A's four files inseparable (store sweep-in-rotatePlan ↔ core reconcile ↔ rebuild keeps-last ↔ adapter recover-closure); F-F's FSM half + rebuild mirror + stats in the same push (journal-shape changes must land with the reader that understands them). Includes the lab-side phase QUALITY-GATE (DEGRADED halt) per the main-agent instruction.
- **Push 2 — watchdog + budget (main-agent adjudication): F-B + F-D (inseparable — the latch's alert text rides the F-D-hardened dedup) + F-C (pulled forward from Push 3) + tests/test-watchdog-core.mjs + the makeBudget unit tests + the smoke tiny-TTL case.**
  One new lib module (lib/watchdog-core.mjs) + scan.mjs rewrite of the breaker/dedup blocks (zero state writes) + conductor.yml env + conductor/turn.mjs budget plumbing (F-C's yaml env + adapter code co-land — one push). Independent of Push 1.
- **Push 3 — lane/adapters/docs (main-agent adjudication): F-E + F-G(a,b,c,d,d2,e) + F-H.**
  Internal atomicity: F-E's worker.yml env + worker code together; F-G(a)'s WORKER_TTL_MIN env + cap arithmetic together. All independent of each other.

**Order rationale:** Push 1 first (the P1 correctness core — F-A), Push 2 second (the other P1 — F-B), Push 3 last (P2/P3 adapters + docs). Gates before each push: `FSM_SMOKE=1 bash scripts/validate.sh` (VALIDATE-OK required; suite counts grow with the new tests — update validate.sh's expectations only if it hard-codes counts, it does not).

**Live verification plan (post-landing; quiescence makes these drills safe):**
- **X15 (F-A, operator-approved drill):** push a garbage state.json commit onto fsm-state (probe1's shape, rolled-back records included) during a quiet window; the next backstop (~2h) must: RECOVERY commit with `journal_seq > max on-branch id`, zero duplicate ids, the sweep gone, `droppedRecords` on the RECOVERY record; branch re-quiesces (halted state restored, then frozen tip). Byte-exact assertions from a scratch clone.
- **X16 (F-B/F-D):** dormant until the next alert-worthy incident (chain is halted — the watchdog exits early by design). Verification is unit-level until the next project epoch (reset); when an alert next opens, the log line `WATCHDOG-ALERT-SKIP (recent marker <24h …)` + a stranger-comment drill on the drill-issue (comment `[fsm-watchdog]` anonymously → next scan must NOT skip) closes it.
- **X17 (F-C):** no live path exercises the budget (turns are 33s p50) — the smoke case is the proof; optionally a `configure max_parallel=8` burst on the next epoch to widen the action list.
- **X18 (F-E/F-F/F-G):** next project epoch (reset) — re-run T-108 (orphan stat now reachable live), a re-run drill on a flaky worker, and one real-lane infra blap if the free lane is degraded that day.

---

## Design decisions requiring main-agent adjudication

1. **F-A Finding-2 (P2-b reversal):** the queue-audit hole as briefed does not exist (probe4 filter artifact; follow-up probe proves both drain shapes journal everything). The `dropped_reports`/REJECTED-for-queue-lines sub-fix is DROPPED; the RECOVERY record carries epoch bookkeeping instead. Confirm the reversal (or re-probe) before implementation.
2. **F-A drop-vs-epoch-mark:** DROP rolled-back records at repair (one truth on-branch) + rebuild keeps-last-on-duplicate-id (defense-in-depth). The alternative (epoch-mark + rebuild ignores pre-RECOVERY records) keeps more audit bytes but leaves two truths; chosen: drop. Confirm.
3. **F-B latch rule:** per-incident latch on "newest 3 re-primes all created after `state.chain.last_tick`", REPLACING the 30-min window (subsumed at dense cadence — probe3's X5b regime trips at the same 4th scan). Alternative: keep the window as a fast-path AND add the latch (two rules, no gain). Chosen: replace. Confirm.
4. **F-B re-arm:** the manual fsm-tick dispatch (already printed in every alert body) IS the re-arm — the latch is derived state and auto-releases on any landed tick; NO new ops control command (`breaker-rearm`) is added. If the principal wants an explicit operator-scoped re-arm (e.g., before a long lease would naturally expire), that is a new command on the ops whitelist — small, but a new control surface. Decide.
5. **F-F classification split:** `{transport-throw, timeout, 401, 402, 429, 5xx} → infra_failed`; `{200+empty, other-4xx} → failed (work-class)`. The 401/402-as-infra and empty-completion-as-work calls are judgment (a permanently-expired key parks tasks as infra-exhausted instead of quarantined-poison — visible either way; an empty-completing free model burns attempts). Confirm the split.
6. **F-F exhaustion terminal:** `quarantined` with the distinct `infra-exhausted` reason + `infra_retries` stat (bounded loop, no new task status, reset is the remedy after lane fix). Alternative: a non-terminal holding status (needs EDGES/invariant/recount changes). Chosen: quarantined+reason. Also: `INFRA_RETRY_MAX` is a lib constant (3), NOT a config knob — a knob would grow CONFIG_BOUNDS + configure + journal shapes; escalate only if fleet tuning demands it.
7. **F-D author gate breadth:** `{MEMBER, COLLABORATOR, OWNER} ∪ type Bot`; `CONTRIBUTOR`/`FIRST_TIME_*` excluded. The Bot lane admits any repo-commenting bot (Apps must be installed on the repo — in practice github-actions[bot] only). Confirm the exclusion set.
8. **F-B/F-D module:** new `lib/watchdog-core.mjs` (pure `breakerDecision` + `alertDedup`) — the watchdog adapter gains its first local coverage, mirroring the conductor-core extraction pattern. Confirm the module (vs testing through scan.mjs with fetch stubs — rejected: adapters-stay-thin is the house style).
9. **Wave split:** three pushes as planned vs one atomic push (both safe — no mutual-activation pairs; documented above). Also confirm F-F's worker half placement (Push 1 recommended, Push 3 tolerated).
10. **Adjacent-but-not-designed (flagged, not scoped):** G-16 (lease renewal/ceilings — phase-2 worker contract), G-18b (ops ingest identity allowlist — currently write-access-only by design), F-1/G-A2 (executor scheduler wiring — the fix that makes F-B's latch rarely needed). All three are deliberate exclusions, not omissions.
