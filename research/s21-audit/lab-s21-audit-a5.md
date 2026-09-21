# S21 Audit — lens a5: THE OPS CONSOLE (the operator's eyes)

Repo: /home/z/fsm-lab @ c146bcc (clean tree, read-only audit). Lens brief: agent-briefs/s21-a5.md;
yardstick: agent-briefs/s21-audit-criteria.md.

## §1 Files audited (deep)

| file | lines | role |
|---|---|---|
| `ops/console.mjs` | 468 | the console: pure parse/record/status halves + injected-seam dispatch + main |
| `ops/turn.mjs` | 108 | the direct operator-command ingest (repository_dispatch fsm-control / workflow_dispatch) |
| `.github/workflows/ops-console.yml` | 64 | the comment-command trigger (GITHUB_TOKEN only, m-8 scoping, own concurrency group) |
| `.github/workflows/ops.yml` | 52 | the direct-lane trigger (the console's sibling surface) |
| `lib/store.mjs` | 701 | seams: `fetch` :67-74, `readState` :113-121, `readJournalTail` :534-555, `enqueueControl` :375-401, queue readers :345-445 |
| `lib/fsm.mjs` | 1010 | seams: REPORT journal records :238-304, `laneOutcomeFields` :429-438, `recount` :442-452, CONTROL/configure reject :320-342 |
| `lib/conductor-core.mjs` | 880 | seams: console-record drain + MINT_TABLE mint :479-501, reset `seqBase` :457-458, budget_window :561-602 |
| `worker/turn.mjs` | 555 | seams: hop telemetry :200-248, key_index/pool_size :213, `composeReportOutcome` allowlist :347-373 |
| `worker/lane-telemetry.mjs` | 252 | the `lane_stats` shape (p50_ms AND p95_ms per record) :179-228 |
| `conductor/turn.mjs` | 626 | the alert/comment surface the console shares :456-513 |
| `tests/test-console.mjs` | 680 | the pin inventory (gates, read-only status, fold A4, F-12 round-trip, F-13 source pins) |
| `tests/test-lane-telemetry.mjs` | 141 | the M4 allowlist + drain-carry pins |
| `T46-WD-DESIGN.md` | 161 | §D4 console spec :88-95 + the v3 fold's named residuals :154-159 |

**LIVE verification (read-only):** `git fetch origin fsm-state` → tip `cdc64fc` (remote-tracking only;
no checkout, no branches, no commits, no pushes, no API writes). Census of the journal REPORT records
(journal-14: 49 REPORTs / 4 with lane_stats; journal-15: 3 REPORTs / 3 with lane_stats; **0 with
key_index, 0 with hop_telemetry**), state.json console-relevant fields, and the exact status screen
rendered by the pure functions against the live state+journal (see §2 O-1/O-2/O-9 for what it showed).

## §2 Findings

| ID | Sev | file:line | the gap vs the yardstick | remedy | eff |
|---|---|---|---|---|---|
| **O-1** | MAJOR | console.mjs:251 · fsm.mjs:442-452 · conductor-core.mjs:561-602 | **No cumulative per-epoch cost exists anywhere.** The console's only cost line is the 64-REPORT window aggregate (`cost $${acc.cost.toFixed(4)}`); `recount` carries only done/failed/quarantined/cancelled; the only budget state is the quota-event `budget_window`. Live render: `cost $0.0485` = the 7 W-D turns of a 52-turn window — the other ~45 pre-W-D turns' spend is unrecoverable, and the epoch total (the spend-ceiling quantity, or-074 at $9.06) is invisible. Criterion 5 ("cost per task/turn/epoch tracked and surfaced") fails at the epoch level. | Accumulate `stats.cost_total` (tokens too) in the REPORT apply path beside `laneOutcomeFields`; reset at genesis; render `- epoch: cost $X · tokens Y` in `statusSummary`. History across epochs rides the journal already. | S/M |
| **O-2** | MAJOR | console.mjs:238, :247, :251 · lane-telemetry.mjs:216-217 | **The rendered "p95" is a percentile of per-turn p50s — the median-of-medians trap — and the label hides it.** The accumulator collects only `p50_ms` (console.mjs:238) while every `lane_stats` also carries `p95_ms` (produced at lane-telemetry.mjs:216-217, live values 12606–21406ms). Live/demo: screen says `p50 7384ms · p95 15593ms` where 15593 is max-of-p50s; with 2 records p50 and p95 render IDENTICAL. Systematic tail understatement on the one latency line the operator sees. Named a residual in T46-WD-DESIGN.md:157-158 but the operator-facing output carries no caveat — the screen asserts a p95 it never computed. | Cheapest honest fix: also collect `p95_ms` and render `p95≈max(p95_ms)` or label `p95(median)`; right fix: carry a small latency histogram (`ms[]` counts, or the bridge's raw lines) so the aggregate percentile is over hops. | S |
| **O-3** | MAJOR | console.mjs:50, :201-277 · fsm.mjs:434-436 · worker/turn.mjs:213, :347-373 · T46-WD-DESIGN.md:88-91 vs :158 | **hop_telemetry and the key_index histogram are journaled but rendered NOWHERE; §D4's promised "key-pool spread" is unfulfilled.** No `hop_telemetry`/`key_index` string exists in console.mjs; grep-verified the render path never touches them. Compounding: in the LIVE journal **zero** key_index records exist — the real lane reports it only when a pool is set (worker/turn.mjs:213), and the CC lane's key pick (cc-adapter.mjs:750/786) never rides the report outcome at all — so even a rendered histogram would be empty in the CURRENT deployed mode. The operator has no surface to see which key served what, key liveness, or per-key spend vs 50/day — exactly the blind spot behind a2's W1 (KEY_2 unreachable) and W3 (no dead-key memory). Criterion 3 (no blind spots) + 4 (quota arithmetic visible). | (a) render a `keys:` line from the window's key_index×pool_size pairs; (b) make the CC lane report its serving key index through `composeReportOutcome` like the real lane; (c) per-key 429/401 tallies from `hop_telemetry`/`rate_classes`. | M |
| **O-4** | MAJOR | console.mjs:164 · fsm.mjs:329-332 · conductor-core.mjs:499-501 · conductor/turn.mjs:461-513 | **A rejected `configure` never reaches the operator — false confirmation.** The console's ack promises "next tick applies" (console.mjs:164); the drain rejects an out-of-bounds patch with a log line + a REJECTED journal record only (conductor-core.mjs:499-501; reject at fsm.mjs:329-332); the conductor's alert-comment scan has no CONTROL-REJECTED arm (conductor/turn.mjs:461-513 covers quarantine/TIMEOUT/MILESTONE/reset-rollover/PHASE only). The operator believes a knob (e.g. `max_parallel`) landed when it silently didn't — the feedback loop breaks at the drain, the exact class law-5 exists to prevent. | Add a CONTROL-REJECTED arm to the alert scan: one ops-issue comment citing the journal id + reject reason (dedup by event_id so redelivery doesn't double-post). | S |
| **O-5** | MAJOR | console.mjs:340-345 | **A transient API failure on the permission GET silently drops a VALID command.** Gate 4 treats any non-200 as below-write/unverified → exit 0, silent (no reply, nothing enqueued, GREEN run). A 5xx/timeout on `GET /collaborators/{user}/permission` during an incident — exactly when `pause` is needed — loses the command with zero operator-visible trace. Asymmetric with the reply-POST failure path (exit 2, red, law-5 — console.mjs:392-395): the stranger-gate's "don't burn a reply" rationale is being conflated with transport error. | Distinguish definitive verdict (200 + below write → silent) from error (non-200-that-is-not-a-verdict: 403/404/422 → silent; 5xx/network → one retry, then red run exit 4). | S |
| **O-6** | MINOR | console.mjs:202-209 · store.mjs:67-74 | **Stale-view hazard: the status screen has no as-of marker.** `store.fetch()` tolerates failure silently (acceptCodes [1,128]) and `statusSummary` renders no sha/commit-date — a failed fetch renders an older fsm-state commit as current truth (queue depths, task counts, holds). The last-tick age line partially mitigates but itself reads the stale view. The 4th-straggler artifact was the report QUEUE racing resume (a write-path race) — the console does NOT share that path; this is the read-path sibling hazard. | Render `as of <short-sha> (state commit age)` from `store.headSha()` + the commit ts, or flag a failed fetch with a caveat line. | S |
| **O-7** | MINOR | store.mjs:534-555 · conductor-core.mjs:457-458 · fsm.mjs:238-304 · console.mjs:257-267 | **Post-reset/fresh-epoch misattribution: the LANE section renders the PREVIOUS epoch's telemetry.** The journal continues across a reset (`seqBase = s.journal_seq`, conductor-core.mjs:457-458), REPORT records carry no chain id (fsm.mjs:238-304), and `readJournalTail` has no chain filter (store.mjs:534-555). Demo: fresh chain `c-NEW`, 0 tasks → screen still shows `11 calls · cost $0.0128 · 2 turns (journal tail)` from the old epoch. Bounded by the 64-REPORT window, but it poisons exactly the fresh-epoch moment (X26/post-reset first status). | Stamp REPORT records with the chain id (one additive field, rebuild-safe class) and filter the tail; interim: label the line `turns within last 64 REPORTs (may span epochs)`. | S/M |
| **O-8** | MINOR | console.mjs:205 | **Ready-made ops counters are dropped from the screen.** `state.stats` carries `retries/orphaned_reports/rejected_events/timeouts/dispatched/infra_retries/budget_pauses` (live: 17/2/8/4/43/10/4 — including the X23 arc's 4 budget pauses) but `statusSummary` renders only done/quarantined/failed/cancelled. The brief's "recent infra_retry/quarantine trend" ask is one line away, already in the state the console reads. | Add `- infra: dispatched X · retries Y (infra Z) · timeouts T · budget-pauses B · orphans O · rejected R` to the screen; trend = diff against the previous status (journal has both). | S |
| **O-9** | MINOR | console.mjs:373, :183-190 | **Liveness blindness: the console cannot tell quiesced-healthy from conductor-dead.** Live render says `last tick 45h ago` while pinger markers flowed through 09-21 (a3's live census) — the markers are kind-TICK journal records the console's own `readJournalTail` could see but the status lane filters `REPORT` only (console.mjs:373), and the marker apply is byte-identical so `chain.last_tick` never advances. Compounds a3's A3/A8 (no deadman): from the console, "epoch over + pinger alive" and "everything dead" look identical. | One liveness line: last `tick-pinger-*` marker age from a `readJournalTail(N,'TICK')` scan (cheap — the journals are already fetched for the LANE section). | S |
| **O-10** | MINOR | console.mjs:350/376/392 · conductor/turn.mjs:456-513 · EVIDENCE.md:66,373 | **Output-destination rot: the OPS issue thread is an unbounded, unsearchable append-only log.** Every ack/status/reject (console) + every quarantine/milestone/completion alert (conductor) posts a NEW comment on issue #1; GH paginates 30/page with no in-issue comment search, no archival/collapse, and the watchdog's own alert-dedup already breaks >20 comments (a3-A2 — law-20 pagination). Status history (the only epoch-to-epoch cost record that exists today) is buried page by page. | Rotate the ops issue per epoch (reset/rollover already mints a fresh chain — pair it with a fresh ops issue + `OPS_ISSUE` var update), or collapse to a single edited status-board comment for `status` while alerts keep their own issue. | S/M |
| **O-11** | NICE | ops/turn.mjs:96-105 | The direct dispatch lane has no ack at all (fire-and-forget enqueue + nudge; the dispatching operator is the ack). Acceptable for a human at the Actions UI, silent for scripted/PAT automation. | One ops-issue comment on the direct lane mirroring the console's queuedReply. | S |
| **O-12** | NICE | console.mjs:50 | No "what would the conductor do next" preview verb (dry-run of the dispatch ladder/budget/overflow decision). Ranked LAST of the four missing panels: the decision is reconstructable from state+journal by hand, and a stale preview risks being trusted over the real tick. | A `plan` command rendering `dispatchBudgetFromWall` + ready set + overflow arm from the freshly-fetched state, clearly labeled as a projection. | M |

**The brief's four missing-panel ranking** (asked explicitly): 1. quota/pool health (O-3 — closes the
blind spot behind the live key failure modes), 2. epoch-to-epoch cost history (O-1 — the spend ceiling
is otherwise unenforceable-by-sight), 3. infra_retry/quarantine trend (O-8 — the cheapest, data already
in state), 4. conductor-next preview (O-12 — nice, risk of stale-truth).

## §3 The 3 findings that most block production-grade

1. **O-1 — no cumulative per-epoch cost:** the console (the operator's ONLY economics surface) renders
   a 64-turn window; the epoch total and the burn-vs-ceiling arithmetic that criterion 5 demands are
   invisible, and pre-W-D turns' spend is already unrecoverable. Everything needed (cost on every
   REPORT record) is already journaled — it is never accumulated.
2. **O-3 — key/pool telemetry journaled but invisible:** hop_telemetry + key_index/pool_size ride the
   journal (pinned end-to-end) yet render nowhere, and the deployed CC mode never even produces
   key_index — so the #1 worker-lane failure class (dead/duplicated keys, W1/W3) is undetectable from
   the console. §D4's "key-pool spread" promise is unmet.
3. **O-2 — the p95 the operator reads is not a p95:** percentiles-of-medians rendered with an unqualified
   `p95` label (per-record p95_ms discarded at console.mjs:238) — the primary latency number on the
   one-screen health view systematically understates the tail. An observability surface that misstates
   its own numbers is worse than one that shows none.

(Honorable mention for the control path: O-5 — a transient 5xx silently swallows a valid command on
the exact surface operators use during incidents.)

## §4 What is already production-grade (honest inventory)

- **The gate ladder** (scope-before-any-API → bot pre-pass → anchored-word parse → permission), with
  zero-API proofs for every silent path — pinned test-console.mjs:233-289; the fail-closed scoping
  (m-8) and the stranger-silence rationale are documented in the workflow header (ops-console.yml:15-26).
- **The status lane's read-only discipline**: fetch + reads + ONE comment, never a write method, never
  a nudge — pinned (test-console.mjs:400-414) and live-verified in this audit's render.
- **The anchored-word command parse** (prose cannot command; trailing prose tolerated on bare commands;
  reset flags and configure JSON validated AT THE DOOR with one-line rejects) — console.mjs:76-126,
  pinned :133-199.
- **The two-layer id discipline**: `console-<nodeId>` queue id + the drain's MINT_TABLE
  `ctl-<nodeId>-<cmd>-<clockMs>` journal id, reset excluded to keep the F-1 twin-guard semantics —
  the comment↔journal audit trail joins by node id; round-tripped through the REAL drain and pinned
  (test-console.mjs:501-587).
- **Journal-primary + state-fallback lane sourcing** (fold A4): the LANE section survives pruning and
  rebuild, old-format records skip gracefully (pinned :435-463; live-proven — 57 old-format records in
  the current window, clean render), zero records → the honest "no telemetry yet" line.
- **The exit-code contract** (1 enqueue lost / 2 reply failed / 3 nudge failed — named outcomes, never
  silently green on the write paths), and the graceful UNREADABLE-state one-screen reply (:466-474).
- **The security posture**: GITHUB_TOKEN only, no secrets.* anywhere, anti-recursion by construction
  (F-13 platform law), source-pinned in the YAML (test-console.mjs:634-672); the command path rides
  the same CAS lane as ops/turn.mjs with verbatim bad-line preservation (store.mjs:375-401).
- **The live data flow is REAL**: the last epoch's 3 real CC turns landed full lane_stats (tokens,
  cost to 7 decimals, p50/p95, model map) in the journal and in 7 tasks' last_result — the console's
  sources are populated with genuine production telemetry, not fixtures.

## §5 The brief's focus questions — answered with citations

- **hop_telemetry rendered ANYWHERE?** NO. Produced (worker/turn.mjs:200-248), carried through the
  composer (:371), the REPORT record and last_result (fsm.mjs:436), pinned (test-lane-telemetry.mjs:85,
  test-key-pool.mjs:129) — but zero references in ops/console.mjs (grep-verified). Also NOT produced by
  the deployed CC mode (real-lane only), and the live journal holds 0 hop_telemetry records. See O-3.
- **key_index histogram?** NOT rendered (no `key_index` in console.mjs); the v3 fold names it a known
  residual (T46-WD-DESIGN.md:158). Live journal: 0 records carry it (CC mode gates it on pool.length>0,
  worker/turn.mjs:213). See O-3.
- **p50/p95 labeled honestly?** NO — percentile-of-p50s rendered as `p50 Xms · p95 Yms` with no
  caveat; per-record p95_ms discarded (console.mjs:238 vs lane-telemetry.mjs:217). See O-2.
- **Cumulative per-epoch cost line?** NO — windowed only (`cost $0.0485` over 7-of-52 turns live);
  no epoch cost in state (recount has none), no cost accumulation in the drain. See O-1.
- **Console data sources / stale-prone surface?** journal tail + state.json + the three queue files,
  all via ONE `store.fetch()` + `git show` off the remote-tracking ref (console.mjs:359-374,
  store.mjs:67-105). NO runs API. It does NOT share the 4th-straggler stale path (that was the report
  queue racing resume — a write-path race); its own hazard is the fetch-tolerant stale view with no
  as-of marker (O-6).
- **Output destination + rot?** Issue comments on the OPS issue (#1 — EVIDENCE.md:373); acks, rejects,
  status screens + the conductor's alert/milestone/completion comments all land there; unbounded,
  paginated 30/page, no in-issue search; the watchdog's >20-comment dedup break (a3-A2) shows the rot
  is already biting the sibling surface. See O-10.
- **Rendering robustness (old-format / 0 records / halted / fresh epoch)?** Old-format skip + 0-records
  line + halted-chain render: all verified live and pinned (test-console.mjs:435-463). Fresh epoch:
  renders the PREVIOUS epoch's lanes (journal unscoped across reset) — the one robustness hole (O-7).
- **What's missing, ranked?** See the ranking under §2 (pool health > epoch cost > infra trend >
  next-preview).

*Read-only discipline kept: one `git fetch origin fsm-state` (remote-tracking only), pure-function
renders in-process, no checkouts, no branches, no commits, no pushes, no API writes. Worktree clean.*
