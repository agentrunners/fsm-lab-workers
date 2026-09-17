# T46/W-C1 build brief — the conductor core (budget + pause + intake door + rollover + pruning)

**Base:** fsm-lab main @ a01a624 (276/276 tests). **Branch:** `t46/wc1`. **Design:** T46-WC-DESIGN.md v2 — the "v2 fold" section is BINDING where it conflicts with v1 text.
**Gates to merge:** all existing suites green (276 + conformance 26 + sims 8/8, 7/7, 31/31) + the new suites below + validate.sh clean.

## 0. Scope map (who touches what — lanes must NOT cross files)

- **Lane A (orchestrator-owned):** `lib/conductor-core.mjs`, `lib/fsm.mjs`, `conductor/turn.mjs`, `worker/cc-bridge.mjs`, `tests/test-budget.mjs` (NEW), `tests/test-conductor-core.mjs` (extends), `tests/test-cc-bridge.mjs` (extends).
- **Lane B (agent-owned):** `lib/store.mjs`, `lib/intake.mjs` (NEW), `intake/turn.mjs` (NEW), `.github/workflows/intake.yml` (NEW), `tests/test-intake.mjs` (NEW), `tests/test-store.mjs` (extends), `tests/test-ttl-sync.mjs` (extends), `README.md` (security-contract section).
- **Post-integration (orchestrator):** `sim/run-sim4.mjs` (NEW) — the ten scenarios against the integrated tree.

## 1. dispatchBudget (F-10 — the pacing floor's replacement)

**DELETE the pacing floor entirely:** `pacingFloorDecision`, `resolvePacingFloorS`, `PACING_FLOOR_S`, `PACING_FLOOR_MIN_LEASE_MIN`, `PACING_FLOOR_DEFAULT_S` from conductor-core; the floor call-site + `dispatchPaced` counter from conductor/turn.mjs; their tests from test-w2-conductor.mjs (keep the file, drop only the floor cases; the `|| '0'`-style regression pins for the floor die with the concept). The repo VARIABLE `PACING_FLOOR_S` on GitHub becomes dead (leave it; operator cleans up).

**ADD (conductor-core):**
```js
export const DISPATCH_COST_MS = 4_000;  // measured: dispatch+commit ≈ 2-4s
```
`conductorTick({..., dispatchBudgetFn})` — `dispatchBudgetFn: (() => number) | null` (null = disabled = old behavior). Thread it into EVERY `apply(...)` call inside conductorTick via a new 5th param: `apply(state, ev, now, nextMilestone, { dispatchBudgetFn })`.

**fsm.mjs:** `clock(state, now, nextMilestone, { dispatchBudgetFn } = {})`. In the schedule pass (step 4), recompute before EACH assign:
```js
for (const t of ready) {
  if (free <= 0) break;
  const budgetNow = dispatchBudgetFn ? Math.max(0, Math.floor(dispatchBudgetFn())) : Infinity;
  if (budgetNow <= 0) {
    // remaining ready tasks STAY READY — never assigned (the skip-left-assigned class is dead)
    J({ kind: 'BUDGET', reason: 'dispatch-paced', budget: budgetNow, ready_remaining: <count of ready left incl. t> });
    break;
  }
  ... existing assign ...
}
```
The BUDGET record fires at most ONCE per clock pass, only when ready tasks were left unassigned by the budget. `rebuild()`: `case 'BUDGET': break;` (audit-only). Law-6: it's pointer-only (no payload) — compliant.

**conductor/turn.mjs (adapter):** build the fn from the job budget — the SELF-TICK RESERVE is carved FIRST (R3 D1-M2 discipline):
```js
const dispatchBudgetFn = () => Math.max(0, Math.floor((BUDGET.remaining() - SELF_TICK_RESERVE_MS) / DISPATCH_COST_MS));
```
Pass into conductorTick. In the journal scan (where quarantine alerts post), add: `if (j.kind === 'BUDGET') console.log(\`DISPATCH-PACED budget-exhausted (budget=${j.budget}, ready_remaining=${j.ready_remaining}) — tasks stay ready, next tick re-assigns\`)`. The F-C per-dispatch skip (`workerBudgetMs < MIN_CALL_MS` → break) STAYS as the I/O-side backstop.

**Honest note (goes in the code comment):** the mutate is synchronous — the fn's wall-clock barely moves between assigns; the budget's VALUE comes from the adapter's job-deadline clock at mutate time. The per-iteration recompute is robustness (correct under any future architecture that moves dispatches into the mutate). A tick dying mid-dispatch-ladder leaves assigned-but-undispatched tasks = law-4's class (720s flip recovers net-zero) — documented residual, unchanged.

## 2. The lane-budget pause (F-6/F-7/F-8 — the X21 12-task burn's structural fix)

**Quota matcher (conductor-core):**
```js
export function isQuotaDetail(detail) {
  const s = String(detail ?? '');
  return s.includes('lane-exhausted(') || s.includes('lane-429') || /error-as-answer\(rate limit\)/i.test(s);
}
```
(`lane-429` from classifyError; `lane-exhausted(` from the lane chains; `error-as-answer(rate limit)` = the E11 rc=0 text class.)

**Config surface (fsm.mjs):** `budget_pause_threshold` (default 3, bounds [1,10]), `budget_pause_window_min` (default 15, bounds [5,720]) — add to `CONFIG_BOUNDS`, the genesis defaults, and `validateConfig`. The configure control can patch them (documented knob growth).

**Window tracking (conductorTick, inside the report drain):** for each drained REPORT with `outcome.status === 'infra_failed'` AND `isQuotaDetail(outcome.error ?? outcome.detail)`: push `{ts: now(), task, detail: String(...).slice(0,120)}` onto `s.budget_window` (array; create if absent). AFTER the drain, trim entries older than `budget_pause_window_min` (compare against now()).

**Trigger check (conductorTick, after the trim):** SKIP entirely when `s.chain.paused || s.chain.halted || s.project.phase === 'done'`. Fire when:
- distinct task ids in the trimmed window ≥ `budget_pause_threshold`, OR
- any journal record from THIS tick's drain with `to === 'quarantined' && reason === 'infra-exhausted'` whose error detail `isQuotaDetail` (the backstop — max_parallel=1 sequential burn).

On fire: push action `{ type: 'BUDGET_PAUSE_ALERT', window: trimmedWindow, tasks: [...distinct ids], detail: <first quota detail> }`. DO NOT pause in this tick (F-8: alert first). The window persists via the normal state commit. The action carries NO journal record of its own (the pause event lands in the second commit).

**The second commit (conductor/turn.mjs):** after the action loop, if a BUDGET_PAUSE_ALERT fired:
1. **Open/find the alert issue** — the established lane: `GET /repos/{repo}/issues?state=open&labels=fsm-watchdog-alert&per_page=10`; existing → comment; none → `POST /repos/{repo}/issues` `{title: '[fsm-alert] lane budget exhausted — epoch parked', body, labels: ['fsm-watchdog-alert']}`. Body carries: the task list, the observed 429 detail VERBATIM, the key/lane context if in the window details, and the resume command: `gh api -X POST repos/{repo}/dispatches -f event_type=fsm-control -F 'client_payload[command]=resume'` (or the ops workflow_dispatch form). ALL alert-POST results are CHECKED (law 5): failure → log `ALERT-POST-FAILED`, still self-tick, then `process.exitCode = 1` (red run, the chain retries next tick — F-8's self-heal).
2. **On alert success:** second `store.commit` whose mutate applies a minted CONTROL event:
```js
const ev = { kind: 'CONTROL', command: 'pause', payload: { reason: 'lane-budget-exhausted', window: <trimmed> },
             event_id: mintEventId('CONTROL', { nodeId: String(alertIssueNumber), command: 'budget-pause', clockMs: Date.now() }),
             ts: now() };
```
(`ctl-<issue#>-budget-pause-<ms>` — the table's shape with nodeId = the alert issue number.) Apply via the same `apply(s, ev, now(), NM)` + consume queues pattern; the clock in that commit sees `paused=true` → HOLD_CHAIN → the adapter skips self-tick. The stats gain `budget_pauses` (fsm.mjs: recount passes it through; increment in the pause receiver when payload.reason === 'lane-budget-exhausted' — hmm, simpler: increment `s.stats.budget_pauses = (s.stats.budget_pauses ?? 0) + 1` inside the CONTROL pause receiver when a payload.reason is present).

**fsm.mjs CONTROL receiver:** `if (cmd === 'pause') { s.chain.paused = true; if (ev.payload?.reason) s.chain.paused_reason = String(ev.payload.reason).slice(0, 80); }` / `resume`: `s.chain.paused = false; delete s.chain.paused_reason; s.budget_window = [];` (resume = the operator's quota-reset assertion — the window MUST clear or the re-trigger re-pauses instantly). Mirror BOTH in rebuild()'s CONTROL branch (rebuild derives paused_reason from the journaled payload; the window is live-only ephemeral — rebuild drops it, next ticks re-accumulate; the PAUSE EVENT is the durable protection. Document this in the rebuild comment).

**Pause idempotency:** the trigger skips when `s.chain.paused` — a paused chain never re-fires. After resume, the window is empty → no instant re-pause. ✓

## 3. F-9 — law-4 verify pass skips on paused OR halted

conductor-core, the verify block: `if (seenDispatchKeys !== null && !s.chain.paused && !s.chain.halted) { ... }` (both hold states — the quiesced-noop contract holds across the board).

## 4. The intake door (§2 with F-1/F-2 folds — lane B)

### 4a. lib/intake.mjs (NEW — the pure half)
- `export function parseSpecBlock(body)` → `{ spec } | null` — the FIRST fenced block tagged `fsm-task` (```` ```fsm-task ... ``` ````; tolerate 3-4 backticks; the content is YAML-ish key: value lines — parse by hand, NO yaml dep: keys `id, title, accept, behavior, deps, artifacts, lease_minutes, milestone`; `deps`/`artifacts` as `[a, b]` list literals or bare single values).
- `export function validateSpec(spec, { issue })` → `{ ok: true, id } | { ok: false, errors: string[] }` — EVERY rule, fail-closed:
  - total spec ≤ 4096 bytes (the raw block);
  - `id`: OPTIONAL, default `task-i${issue}`; charset `^[-A-Za-z0-9_.]{1,24}$` (the run-name hazard dies HERE — an id that would mis-split law-4's `task-<id> · <behavior> · a<n>` regex is rejected at the door);
  - `title`: REQUIRED, ≤ 140 chars, no fence-forming sequences (``` sequences);
  - EXACTLY ONE of `accept` (non-empty string ≤ 2048) or `behavior` (in `['succeed','flaky','fail','hang','slow','poison','wb-violation']` — mirror sim/harness-shim SHIM_BEHAVIORS + 'wb-violation' if the shim exports it; import and reuse, don't fork the list);
  - `deps`: REJECTED unconditionally (F-1): error line "deps arrive with multi-task epochs (W-D) — remove the deps line";
  - `artifacts`: OPTIONAL array; each matches `^tasks/<the task's final id>/[-A-Za-z0-9_./]*$` (m-4: bound to the MINTED id — default or declared; foreign-task paths rejected at the door AND the write-back door enforces the same shape);
  - `lease_minutes`: OPTIONAL integer [1, 120]; `milestone`: OPTIONAL integer [1, 9];
  - unknown keys: REJECT (typo protection — list them).
- `export function specToTask(spec, { issue, bodySha8 })` → the genesis task `{ id, title, behavior, work_ms: 4000, deps: [], spec: { accept?, artifacts?, issue } }` — behavior = spec.behavior ?? 'real' (accept-criteria tasks carry behavior 'real'; the worker prompt embeds the accept text — it already rides `t.spec` into assembleDispatchPayload's prompt).
- `export function doorDecide({ author, isBot, permission, body, issue, queue })` → `{ decision: 'enqueue'|'reject'|'silent', comment?: string, spec?, id? }`:
  - isBot (github-actions[bot] / [bot] suffix) → `silent` (loop safety — the door must never wake itself);
  - no fsm-task block → reject with the "how to write a task" comment (include the schema template verbatim);
  - permission NOT in `['admin','maintain','write','owner']` → reject with the stranger comment (ONE explanatory comment, issue stays open for triage);
  - permission undefined/API-error marker (pass `permission: null`) → reject fail-closed (a flaky permission API must never become a free compute lane);
  - validateSpec errors → reject with ONE comment listing EVERY violated rule (never a drip);
  - already-queued check: `queue.some(l => String(l.issue) === String(issue) && l.body_sha8 === bodySha8)` → `silent` + comment "already queued (issue #N, same body) — the door is idempotent" (kills the double-queue; cross-epoch re-runs still work once the queue drains);
  - else enqueue.
- `export function bodySha8(body)` → `crypto.createHash('sha256').update(body).digest('hex').slice(0, 8)`.

### 4b. lib/store.mjs — the THIRD queue
Mirror the control-queue discipline EXACTLY (F-G(d) strict presence, F-G(d2) merge-reserialize):
- `readIntakeQueueEx()` → `{ items, bad }` from `state/intake-queue.jsonl`;
- `readIntakeQueue()` → items;
- `enqueueIntake(rec, { attempts = 8 } = {})` — CAS-append one line (the enqueueControl pattern verbatim: fetch → merge → push mapping `state/intake-queue.jsonl`);
- `commit()`'s mutate callback gains TWO params: `(cur, queue, controlQueue, queueBad, ctlBad, intakeQueue, intakeBad)`; `out.intakeQueue` handling: `Array` → rewrite the file (empty array = DELETE the file — the consume case; m-5: consume = rewrite-minus-head); `undefined` → untouched (the park case: a park-only tick journals nothing → quiesce while live). `intakeBad` → journal REJECTED records like queueBad (the mutate does this — see §5).
- Backward compat: existing mutate callers (tests, sims) that return the old shape are UNAFFECTED (undefined = untouched).

### 4c. intake/turn.mjs (NEW — the I/O half, mirrors ops/turn.mjs)
Env: `GITHUB_REPOSITORY`, `EVENT` (github.event for issues.opened/reopened), `GH_TOKEN` (the JOB token). Steps:
1. `const it = EVENT.issue`; author = `it.user.login`; isBot = login endsWith '[bot]';
2. `doorDecide` pre-pass for the bot case (silent exit 0 BEFORE any API call);
3. permission: `GET /repos/{repo}/collaborators/{author}/permission` with GH_TOKEN → 200: use `data.permission`; non-200 → `permission = null` (fail-closed — doorDecide rejects);
4. `doorDecide({ author, isBot, permission, body: it.body, issue: it.number, queue: store.readIntakeQueue() })`;
5. reject → POST the comment to the issue (checked: failure = exitCode 2, law 5), exit 0;
6. enqueue → `store.enqueueIntake({ issue: it.number, body_sha8: bodySha8(it.body), spec, enqueued_at: new Date().toISOString(), author })`; then the position comment when the queue had prior entries: "queued behind the active epoch — position N" (N = prior length + 1; fires ONCE at enqueue, never per tick);
7. nudge the conductor (same-repo fsm-tick dispatch on GH_TOKEN — the X1a anti-recursion exception; retry once; failure = exitCode 3, the queue line still holds).

### 4d. .github/workflows/intake.yml (NEW)
```yaml
name: fsm-intake
run-name: "intake · #${{ github.event.issue.number }} ${{ github.event.action }}"
on:
  issues:
    types: [opened, reopened]
concurrency:
  group: fsm-intake
  cancel-in-progress: false
permissions:
  issues: write    # the door's comments
  contents: write  # F-2a AMENDMENT (adjudicated): the queue CAS-push to fsm-state needs it.
                   # Still provably secrets-free — GITHUB_TOKEN ONLY, no secrets.* anywhere.
jobs:
  door:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
      - name: Intake door
        env:
          GITHUB_REPOSITORY: ${{ github.repository }}
          EVENT: ${{ toJSON(github.event) }}
          GH_TOKEN: ${{ github.token }}
        run: node intake/turn.mjs
```
**F-2a (recorded adjudication):** the review's "contents:read" was impossible against §2c's queue push (the door WRITES state/intake-queue.jsonl). The security contract's substance — no PAT secrets, GITHUB_TOKEN only, hostile inputs never reach a secrets-holding workflow — holds. The stranger-wake cost stays documented: every public issue-open wakes a ~5s runner; the in-run author gate is the compute firewall.

### 4e. README.md — the security-contract rewrite (F-2)
Replace the repo-level "never issue_comment/issues triggers on a PAT-holding repo" line with the PER-WORKFLOW form: conductor.yml keeps the rule absolutely (dispatch/schedule triggers only, holds LAB_PAT); intake.yml + ops-style lanes are allowed issues/comment triggers BECAUSE they are provably secrets-free (GITHUB_TOKEN only, least-privilege permissions blocks, no secrets.* in env). State the stranger-wake cost honestly.

## 5. The intake drain + epoch rollover (F-5 — conductor-core, lane A)

`conductorTick({..., intakeQueue = [], intakeBad = [] })`. Placement: AFTER the report drain (and after the budget-trigger check), BEFORE the wake apply.

```js
// unparseable intake lines: audited then dropped (same as queueBad/ctlBad)
for (const raw of intakeBad) { mkJ(s, { kind: 'REJECTED', origKind: 'INTAKE', reason: 'unparseable', raw: String(raw).slice(0,160) }, false); s.stats.rejected_events += 1; }

// the drain/rollover: phase done (this tick's halt OR a previously-halted chain) + queue non-empty
if (intakeQueue.length && s.project.phase === 'done') {
  const head = intakeQueue[0];
  const cfg = { ...s.config, tick_min_interval_s: Math.max(s.config.tick_min_interval_s ?? 0, 25) };
  const g = makeGenesis({ config: cfg, spec: head.spec, issue: head.issue });   // extended contract
  const seqBase = s.journal_seq;
  g.state.journal_seq = seqBase + 1;
  mkJ(s, { kind: 'CONTROL', command: 'reset', actor: `intake-door:${head.author ?? 'unknown'}`,
           note: `intake-rollover issue #${head.issue}`,
           genesisSpec: { config: cfg, tasks: g.spec.tasks, milestones: g.spec.milestones,
                          chainId: g.spec.chainId, now: now(), journal_seq: seqBase,
                          mode: g.spec.mode || 'mock', issue: head.issue } });
  s = g.state;
  // the halting tick's STOP_CHAIN dies here — the chain CONTINUES into the new epoch
  for (let i = actionsAll.length - 1; i >= 0; i--) if (actionsAll[i].type === 'STOP_CHAIN') actionsAll.splice(i, 1);
  intakeRest = intakeQueue.slice(1);   // consume = rewrite-minus-head (m-5)
  console.log(`ROLLOVER: epoch from intake issue #${head.issue} -> chain ${s.chain.id}`);
}
```
Return `intakeQueue: intakeRest` ONLY when consumed (undefined otherwise = park, file untouched). The wake apply then runs on the FRESH state → assigns M1 → DISPATCH actions. The journal-as-CONTROL-reset means rebuild() replays it with ZERO new rebuild code (the existing genesisSpec path). The PHASE-done journal + its alert comments still fire (the old epoch's completion is a fact — the adapter's journal scan sees it).

**makeGenesis contract extension (adapter + sims):** `makeGenesis({ config, spec, issue })` — when `spec` present: `genesis({ config, project: { tasks: [specToTask(spec, { issue, bodySha8: head.body_sha8 })], milestones: Math.max(spec.milestone ?? 1, 1) }, chainId: c-<now>, now, mode: <spec-carrying-mode? see below>, issue })`. Mode: the spec MAY carry `mode` (validate against GENESIS_MODES at the door? NO — the door rejects unknown keys... ADD `mode` as an OPTIONAL known key, validated `['mock','real','cc']`, absent → the injected EPOCH_MODE default (same as today's reset). This is X22's switch: the operator's spec says `mode: cc`.)
- `genesis()` (fsm.mjs) gains an OPTIONAL `issue` param → `state.project.issue = issue ?? null` (the intake thread — m-3's completion comments target it). The reset genesisSpec carries `issue` (additive; rebuild passes it through).
- The adapter's PHASE-done comment handler: when `state.project.issue` is set, ALSO post the completion comment to that issue (`TASK COMPLETE — stats` + the task's last_result summary pointer). And on the ROLLOVER journal record (note matches `intake-rollover`), post "epoch started for issue #N (chain X)" to the intake issue. These ride the EXISTING journal-scan loop (one extra POST each, once per epoch).

**reset flags (F-5):** the control record's `patch` may carry `{ from_queue?: true, drop_queue?: true }` on reset. In the reset branch: `drop_queue` → return `intakeQueue: []` (discard); `from_queue` → genesis from the queue HEAD + consume (identical shape to the rollover, note `reset-from-queue issue #N`); plain reset → queue UNTOUCHED (parks — the drill contract is sacred). buildEvent/op lane: no change needed (patch already flows).

## 6. Task-record pruning (§5b — fsm.mjs, lane A)

Config: `prune_tasks_after_ticks` (default 20, bounds [5, 500]) — same config-surface treatment as §2's knobs. In clock(), a NEW pass between step 3 (retry) and step 4 (schedule):
```js
// prune: terminal task records compact after N observed ticks terminal
for (const t of Object.values(s.tasks)) {
  if (!TERMINAL.has(t.status)) continue;
  if (t.pruned) continue;
  t.terminal_seq ??= s.chain.seq;                      // lazy stamp (≤1 tick drift, harmless)
  if (s.chain.seq - t.terminal_seq <= s.config.prune_tasks_after_ticks) continue;
  const done_at = t.updated;
  s.tasks[t.id] = { id: t.id, status: t.status, attempts: t.attempts, done_at, pruned: true };
  J({ kind: 'PRUNE', task: t.id, from_status: t.status });
}
```
- `invariants()`: `for (const d of (t.deps || []))` (pruned records carry no deps — the current loop would throw on undefined).
- `rebuild()`: `case 'PRUNE': break;` (audit-only — rebuild reconstructs full records; the next live clock re-prunes; idempotent by the `pruned` marker).
- Pruned records keep status → recount, allTerminal, dep-satisfaction (`s.tasks[d].status === 'done'`) all hold. NEVER prune non-terminal tasks. The 0.77KB/task design number must not erode — the pruned record is ~90 bytes.
- Test: terminal task + N ticks → compacted shape asserted; idempotent (second pass no-op); rebuild parity (rebuild → full record → next clock re-prunes); a backlog task depending on a PRUNED done task still unlocks (the deps check survives).

## 7. Trivia (lane A: bridge; lane B: TTL pin)

- **Bridge (F-2/X21-F-3):** `worker/cc-bridge.mjs` — answer `HEAD /api/hello` with 204 (the CLI's liveness probe — kills the 501 noise; every other unmatched route stays LOUD). Test in test-cc-bridge.mjs.
- **TTL pin (m-1):** `tests/test-ttl-sync.mjs` extends — pin `assembleDispatchPayload`'s deadline = min(lease, now+TTL) − margin for: short lease (lease wins), long lease (TTL wins), lease-in-margin (past deadline → the worker's late-start gate). The ceiling EXISTS; this is only the pin.

## 8. sim4 — the ten scenarios (post-integration, orchestrator)

`sim/run-sim4.mjs` reusing sim3's Sim3Driver world model (in-memory state, virtual clock, report queue array + intake queue array). Scenarios (F-16, each = one check-set with named asserts):
1. happy pause loop: 3 distinct tasks' quota-429 infra reports → BUDGET_PAUSE_ALERT action (window + tasks + detail) → alert issue opened (mocked) → pause event minted + applied → HOLD_CHAIN → zero new ASSIGNs → attempts unburned → resume control → epoch completes.
2. window boundary: 2 quota reports in-window + 1 aged out (ts manipulated) → NO pause.
3. distinct-task counting: ONE task's 3 quota reports → no count-trigger (needs 3 DISTINCT); the task's infra ladder exhausts → infra-exhausted quarantine with quota detail → BACKSTOP fires.
4. single-task ladder at max_parallel=1 → backstop at 1 infra-exhausted → immediate pause, zero further dispatches.
5. pause-with-inflight: reports for already-assigned tasks drain DURING the pause (they complete) → resume → the reaper burns only genuinely-expired in-flight leases — assert the honest residual.
6. alert-failure: the alert POST fails → NO pause committed, window persists in state, the turn goes red (exitCode path asserted at the driver level), next tick re-triggers.
7. reset-vs-queue: reset {from_queue:true} → genesis from head + consume; reset {drop_queue:true} → discard; plain reset → queue parks untouched.
8. epoch rollover: epoch completes with 2 queued specs → the halting tick mints the FIRST genesis in the SAME tick (STOP_CHAIN filtered, queue minus head), the second waits for the next halt; both eventually run.
9. re-opened-spec re-run: the same issue+body re-enqueued after its epoch completed → re-runs (fresh genesis); re-enqueued while queued → deduped (silent + comment).
10. console mint round-trip + the budget arithmetic: dispatchBudgetFn returning 0 → zero assigns, task stays ready, BUDGET record journaled, next tick (fn healthy) assigns. (The console half is W-C2 — here pin only the mint-table shapes used.)

## 9. Honest-split labeling (m-6)

W-C1's gate: everything above is OFFLINE-provable (tests + sims). The LIVE halves (the permission API's real behavior with GITHUB_TOKEN, the issue-comment contracts, the alert-issue lane, the nudge) are X22's surfaces — labeled in EVIDENCE, not claimed here.

## 10. Discipline

- Branch `t46/wc1` off main@a01a624. NEVER force push. Commit in small slices with the why in the message.
- Every new code path: comment WHY (the house style — comments carry the design rationale + the fold id).
- No new deps. node:*, lib/* imports only.
- Tests before merge: `node --test tests/` (all files), `node sim/run-sim.mjs && node sim/run-sim2.mjs && node sim/run-sim3.mjs`, `bash scripts/validate.sh`.
- Lane state files: append `t46-wc1-state.md` notes as you go (the recovery artifact if an agent dies mid-lane).
