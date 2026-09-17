# T46/W-C2 build brief — artifact+ops wave (task-branch/PR + transcript GC + ops console)

**Base:** fsm-lab main @ ae3ab7b (W-C1 merged: 328/328 + sims 8/8+7/7+31/31+51/51). **Branch:** `t46/wc2`. **Design:** T46-WC-DESIGN.md v2 (§4, §5a, §6; folds F-4, F-14, F-15, F-12, F-13, m-3, m-4, m-8).

## Scope (three surfaces)

### 1. The task-branch/PR flow (§4, F-4/F-14 + m-3/m-4)
- **F-4 (the binding fold):** task branches fork from MAIN (the worker's checkout), named `tasks/<id>` — NOT from the fsm-state orphan branch (unrelated-history PRs). The dispatch envelope already carries the task id; the write-back door's existing `TASK_BRANCH_RE` (`^tasks/<id>`) matches both call sites unchanged. base_sha CUT (epoch freshness rides the chain id in the envelope's session + the PR body).
- **Worker side (worker/turn.mjs + lib/worker-contract.mjs):** cc-mode tasks with declared `artifacts` (the task's `spec.artifacts`, riding the dispatch envelope's task record) commit to `refs/heads/tasks/<id>` on completion: create the branch from the current checkout (main), write the declared artifacts under their paths, ONE commit `task/<id>: artifacts` — via the worker's existing git push lane (the report-queue CAS pattern; GITHUB_TOKEN, contents:write already on worker.yml). Failures report `infra_failed 'artifact-push'` (net-zero, the lane rotates). Mock epochs skip (no artifacts declared → no branch, no PR — §4c).
- **Conductor side (conductor/turn.mjs at the done-report handling):** on a done report for a task with declared artifacts AND mode cc: open PR `tasks/<id>` → main via REST (title `task/<id>: <title>`, body = the accept criteria from the task's spec + the report's summary + the transcript pointer). **F-14: conductor.yml gains `pull-requests: write`** in permissions. PR-open failure = an alert comment on the ops issue (law 5), NOT a run failure. The PR number lands in the task record (`pr: <n>`) + the journal REPORT record (pointer-only, law 6).
- **m-3:** the intake-issue completion comment (already in W-C1) gains the PR link when present.
- **m-4:** the write-back door's pathspec on the task branch: `tasks/<id>/**` + declared artifacts only — same rules, different base ref.
- **X22 preconditions (document, operator executes):** the repo setting flip — `PUT /repos/{repo}/actions/permissions/workflow` `{can_approve_pull_requests: true}` (do NOT flip it yourself; it's an operator action — note it in the state file + HANDOFF).

### 2. Transcript GC (§5a, F-15 — the watchdog charter)
- The watchdog scan gains a pass: list `sessions/` on fsm-sessions; files whose task is terminal (done/quarantined/cancelled — read the task id from the path `sessions/<task>/<run>-a<n>`) AND older than `transcript_gc_days` (config via env `TRANSCRIPT_GC_DAYS`, default 7; hard cap 90) → delete in ONE commit per scan; the log line `GC-TRANSCRIPTS deleted=<n> retained=<m>`.
- **F-15 (binding):** (a) placement BEFORE the halted/paused exits (a completed epoch is the GC's primary target); (b) the fsm-sessions deletion commit IS the audit (branch history retains deletions — no journal record, NO fsm-state write — the watchdog NEVER writes fsm-state, charter kept); (c) runtime bail-out: tree >5000 files → `GC-DEFERRED` log, no commit; (d) the deletion CAS uses the proven 3-way-refresh pattern against live transcript pushes.
- Tests: terminal-age rule, the 90d cap, the bail-out, the charter (no fsm-state touch — assert the scan's fsm-state read is read-only).

### 3. The ops console (§6, F-12/F-13 + m-8)
- `.github/workflows/ops-console.yml` (NEW): `on: issue_comment[created]`, own concurrency group, GITHUB_TOKEN only, permissions `issues: write` (+ `contents: read` for the status read). ONLY issue #1 (the OPS_ISSUE repo var — m-8: the var, default 1, documented load-bearing) AND author permission ≥ write (the same fail-closed gate as intake: GET collaborators/permission; non-200 → ignore silently — a comment from a stranger on a public repo must not burn a comment).
- `ops/console.mjs` (NEW — the parse+dispatch half, pure-testable): first line `/(pause|resume|halt|unhalt|reset|status|configure .*)/` → the control-queue enqueue with **F-12's two-layer id**: the queue record's id = `console-<comment_node_id>`; the CONTROL event minted at drain keeps the table's shape (the conductor's drain mints `ctl-<nodeId>-<command>-<clockMs>` — nodeId = the comment node_id — the mint table already supports it). `status` → a read-only one-screen reply (phase, milestone, done/quarantined, chain age, queue depth, paused/halted) — GITHUB_TOKEN-authored (F-13: never fires issue_comment — anti-recursion by construction; test-pinned via the source shape).
- Non-command comments: ignored (zero runs beyond the parse).
- Reset flags: the console's reset accepts `reset [from_queue|drop_queue]` patch flags (W-C1's F-5 lanes — the patch rides the queue record).
- Tests: the command matrix, the two-layer mint round-trip, the permission gate, the issue-#1 scoping, the GH_TOKEN no-recursion source pin.

## Gates
All existing suites green (328 + conformance 26 + the four sims) + the new suites + validate.sh. NO live API calls in tests (REST clients injectable — the conformance pattern). Work on `t46/wc2` off main@ae3ab7b; NEVER force push; small commits with rationale; `t46-wc2-state.md` notes as you go (the recovery artifact).

## Out of scope (W-C3/next)
The pinger (DONE — xfnwfpho1/pinger live), the watch-the-watcher duty, X22-X24 live proofs (the operator's repo-setting flip is their precondition), auto-merge (Q4 is the principal's).
