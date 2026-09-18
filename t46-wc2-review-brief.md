# T46/W-C2-R — the pre-merge adversarial review (2 lenses)

**Tree under review:** branch `t46/wc2` @ HEAD (lanes A+B+C integrated; base main@3ce598c). Gates at review time: 400/400 tests, sims 8/8+7/7+31/31+51/51, VALIDATE-OK.

**The wave:** task-branch/PR flow (§4: F-4 branch-from-MAIN, F-14 pull-requests:write, m-3 PR-link comment, m-4 allowed-only pathspec, worker artifact commits + conductor PR-open + the pr stamp two-commit), transcript GC (§5a: F-15 charter), ops console (§6: F-12 two-layer id, F-13 GITHUB_TOKEN no-recursion, m-8 OPS_ISSUE var).

**Binding contracts:** t46-wc2-brief.md + T46-WC-DESIGN.md v2 (§4/§5a/§6) + this file.

## Lens 1 — state-machine + trust boundaries
Attack surface, in priority order:
1. `lib/task-pr.mjs` (NEW — the PR flow): prFlowCandidates' §4c matrix vs the FSM's actual task lifecycle (a done task that later resets? a pr-stamped task through reset/rebuild — does task.pr survive where it must NOT?); stampPr's mutate vs store.commit's CAS semantics (journal_seq minting, version bumps, queue pass-through, the twin-stamp no-op); openTaskPr's reuse lane (a CLOSED PR for the head + a stale task.pr? an OPEN PR by a HUMAN on tasks/<id>?); the token ladder's failure shapes (what does 422-vs-403 actually mean here); buildPrBody's neutralization (the fence discipline vs the PR body surface).
2. The artifacts envelope threading: envelopeFromDispatch's fail-closed validation vs the dispatch 10-property limit; a task whose spec.artifacts changes mid-epoch (the envelope vs the door's allowRoot drift).
3. The worker's task-branch push (worker/cc-adapter.mjs pushTaskBranch): the branch-exists-continues vs fork-from-MAIN race (a task retried AFTER main moved — the shallow clone path); the read-back verify vs a pushed-but-different tree; the escalation's interaction with the FSM retry ladder (can the net-zero retry loop forever? attempt counting?).
4. The GC (watchdog): the deepen-always redesign — cost bounds (an unshallow on a HUGE sessions branch every scan?), the fabricated-touch fallback retention direction, the CAS exhaustion path, the corrupt-state guard's placement vs the GC's absent-from-state=terminal rule.
5. The prFlow placement in conductor/turn.mjs: post-commit pre-comment ordering — what happens when the PHASE-done comment fires but the PR-open FAILED (the alert lane)? What if the stamp commit CAS-conflicts with a concurrent worker report (the interleaving)? PR_MAX_PER_TICK=4 vs an epoch completing 5 artifact tasks — does the completion comment carry a link for an unstamped task?
6. Mutation-test YOUR findings: for each claimed gap, check whether ANY existing test would catch the code being broken (delete/invert the guard, run the suite). Report which pins are missing (the honest-test finding).

## Lens 2 — integration + adapter protocol
1. The conductor turn's full I/O sequence with the new PR block: budget interaction (the PR ladder eats turn budget? BUDGET.remaining() vs the PR calls + the comment posts + the dispatches), the two-commit ordering vs the self-tick, failure containment (prFlow throws → the tick continues — but is the WORKER dispatch loop still reached? the alert lane dead?).
2. The console (ops/console.mjs + ops-console.yml + the conductor-core cev mint edit): the F-12 two-layer id round-trip through the REAL drain (queue record → minted journal id → the audit fields), the permission gate's non-200 handling (rate-limited → silent = a command swallowed? or is silence the design?), the OPS_ISSUE var default, the status lane's read (a state.json read via git on a PUBLIC repo with GITHUB_TOKEN — contents:read suffices? the enqueueControl CAS with GITHUB_TOKEN contents:write on the state branch), the nudge dispatch (GITHUB_TOKEN repository_dispatch — X1a exception), the reply comment (GITHUB_TOKEN-authored → never fires issue_comment — pin it).
3. The GC's live wiring: watchdog.yml env additions, the scan's placement vs the corrupt-state guard, TRANSCRIPT_GC_DAYS plumbing, the sessions remote derivation (GH_TOKEN || LAB_PAT — the scan's own token works for fsm-sessions pushes?), the scheduled cadence cost (the unshallow fetch every ~2h scan).
4. Cross-lane interactions: the console's reset flags riding the SAME control queue the GC/pause/conductor drain — drain ordering interactions; the PR flow's second commit vs the console's enqueued control landing between commit-1 and commit-2 (CAS retry paths); the intake door's completion comment vs the m-3 PR link (both target the issue — double comments?).
5. YAML discipline: all three workflows' permissions blocks vs their actual API surface (least privilege per F-2a); the conductor's pull-requests:write scope (token can create PRs repo-wide — is that the minimal grant?).
6. Mutation-test YOUR findings (same discipline: break the code, see if anything goes red; report the unpinned gaps).

## Deliverable
`/home/z/lab-46wc2-r{1,2}-report.md` — WRITE THE FILE AS YOU GO (incremental, after EVERY finding — a dead agent's partial report still delivers). Counts: BLOCKING / MAJOR / MINOR with file:line and a repro/mutation note each. End with the verdict line: `W-C2-R VERDICT: <merge-now | fold-first>`.
