# t46/wc2-gc — lane B state (transcript GC)

Branch: `t46/wc2-gc` off main @ 3ce598c. Owner: Task 18-B agent.
Scope: watchdog transcript-GC pass per t46-wc2-brief.md §2 (F-15 binding) +
T46-WC-DESIGN.md §5a. Files owned: watchdog/scan.mjs, lib/watchdog-core.mjs,
.github/workflows/watchdog.yml, tests/test-gc.mjs, this state file.

## Decisions (binding-relevant)

- **D1 — age source (brief: "your call, document it"):** git-local, NOT the
  REST trees API. One shallow clone `--shallow-since=<now-(gc_days+2)d>
  --branch fsm-sessions --single-branch` serves listing + age map + deletion
  staging. Age map from `git log --name-only --format='@@@%H %cI'` (newest
  touch per path). Rationale: the trees API has NO mtime; the commits-list
  API has no per-commit file set without N detail calls; per-file `?path=`
  commits calls are 1 call/file. The git lane is 1 clone, exact ages, and is
  the same mechanics as pushSessionsBranch (worker/cc-adapter.mjs).
- **D2 — unmapped-file age (the horizon rule):** a path not touched by any
  fetched commit has last-touch ≤ the oldest fetched commit (the boundary);
  git's grafted boundary shows the full tip tree as "added", mapping unmapped
  files to the boundary date — which UNDERSTATES age → fail-retention. Exact
  statement: unmapped files are eligible iff (now − boundary_date) >
  gc_days. With `--shallow-since = now − (gc_days + 2d)` and an active
  branch, the boundary sits past the threshold → prior-epoch residue (the
  bulk value) is collected; on a QUIET branch collection is delayed until the
  horizon crosses (conservative, documented).
- **D3 — audit = the fsm-sessions deletion commit (F-15b).** DEVIATION from
  T46-WC-DESIGN.md §5a's older text ("The fsm-state commit that records the
  GC (a GC journal kind, pointer-only) keeps the audit"): the later brief
  (t46-wc2-brief.md §2, F-15b) supersedes it — sessions-commit-is-audit, NO
  journal record, NO fsm-state write (the watchdog NEVER writes fsm-state).
- **D4 — GC-terminal = {done, quarantined, cancelled}:** the brief + design
  §5a both name done/quarantined/cancelled. lib/fsm.mjs TERMINAL also has
  'failed' — EXCLUDED here because 'failed' is retryable in this FSM
  (attempts < max → reassigned); deleting a failed task's transcripts while
  it may still be re-run would violate "never touches non-terminal tasks'
  transcripts". Absent-from-state.tasks counts as terminal (prior-epoch
  residue).
- **D5 — corrupt/unreadable state ⇒ NO GC this scan:** with state.json
  unreadable every task counts as "absent" → the bulk-delete-of-live-audit
  hazard. The GC sits AFTER the `!state` early-return (still before the
  halted/paused exits per F-15a — placement holds for every readable state).
- **D6 — CAS discipline:** per attempt (≤3): FRESH shallow clone → re-list →
  re-decide (pure core, fresh read — the W-C1-R m4 fold discipline) → git rm
  → ONE commit → push; any push failure ⇒ next attempt with a fresh clone.
  Full re-decision (not victim∩tree) protects the racing RE-PUSH of an
  existing victim path (age resets → retained).
- **D7 — scratch dir + token scrub:** every clone in mkdtemp scratch (the
  scan's checkout is never touched; the Store's remote-tracking refs are
  never contaminated). Token embedded only in the git URL, never logged;
  error text scrubbed via replaceAll(token,'***').
- **D8 — counting:** bail-out tree=<n> counts ALL blobs under sessions/ (>
  5000 → GC-DEFERRED, no commit — F-15c). deleted/retained count
  TRANSCRIPT-SHAPED files only (`sessions/<task>/<run>-a<n>.{txt,meta.json}`);
  strays are never deleted and not counted. age rule strictly `>` gc_days.
- **D9 — env knob:** TRANSCRIPT_GC_DAYS, default 7; >90 clamps to 90; <1 or
  unparseable rejects to 7 (gcDaysFromEnv, pure, logged when adjusted).
  Passed through watchdog.yml as '7' (visible knob; the scan clamps
  regardless). Test seam: FSM_SESSIONS_ORIGIN overrides the remote URL
  (local bare repos; file:// — shallow-since is ignored on plain paths).

## Progress log

- [x] briefs + contracts read; scan.mjs / pushSessionsBranch / enqueueControl
      / watchdog-core / test patterns read.
- [x] baseline green on the fresh branch: 328/328 (~21s).
- [x] git behaviors verified empirically (/tmp/gcexp): shallow-since needs
      file:// for local remotes; grafted-boundary full-tree diff confirmed
      (D2 basis); depth-1 push FF works; non-FF rejection shape confirmed;
      absent-branch clone rc=128 'not found in upstream'.
- [ ] lib/watchdog-core.mjs: gcDaysFromEnv / gcPlan / gcCommitMessage (+tests)
- [ ] watchdog/scan.mjs: runTranscriptGc + git lane + F-15a insertion
- [ ] tests/test-gc.mjs (pure pins + git-lane pins + e2e halt-path pin)
- [ ] gates + push

## Open questions

- OQ1: should retained=<m> count non-transcript strays under sessions/? (D8:
  no — transcripts only; documented.)
- OQ2: quiet-branch delayed collection (D2) — acceptable? Yes per
  fail-retention; noted for the review lens.
