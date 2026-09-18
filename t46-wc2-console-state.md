# T46/W-C2 lane C — the ops console (branch `t46/wc2-console`)

State file for the console lane. Recovery artifact: if this agent dies, the
next reader starts here. Updated at every milestone.

## Mission (from the briefs)

`.github/workflows/ops-console.yml` (issue_comment[created], GITHUB_TOKEN
only, fail-closed permission gate, OPS_ISSUE scoping — m-8) +
`ops/console.mjs` (pure parse+dispatch: pause/resume/halt/unhalt/reset[flags]
/status/configure) + the F-12 two-layer id (ONE surgical drain edit in
lib/conductor-core.mjs) + the F-13 no-recursion source pin +
`tests/test-console.mjs` (no live API calls). Baseline 328/328 must stay
green (especially test-conductor-core.mjs — the drain edit must not change
EXISTING ids for node_id-less records).

## Decisions (running log)

- D1 — parse semantics: the FIRST LINE's first whitespace-delimited token
  must be an exact (case-sensitive) command word. The brief's regex
  `/(pause|resume|halt|unhalt|reset|status|configure .*)/` is a summary; an
  unanchored substring test would fire on prose ("paused for maintenance"
  would enqueue a pause) — anchored-word parse is the fail-closed reading.
  Trailing text after bare commands is ignored; `reset` trailing tokens are
  FLAGS (from_queue|drop_queue, combinable; garbage token → one-line reject
  reply); `configure` requires a JSON object argument on the line.
- D2 — F-12 both-identities surface: with lib/fsm.mjs off-limits (not my
  file) and the cev construction as my ONE surgical site, the applied
  CONTROL journal record (jrec in fsm.mjs) cannot gain new audit fields —
  event ids land on REJECTED records + state.dedup only (verified against
  the live fsm-state journal: applied CONTROL records carry no event_id —
  pre-existing, global). So: the minted id `ctl-<nodeId>-<cmd>-<ms>` is
  answerable from the journal system via state.dedup (committed alongside
  the journal) and via REJECTED-duplicate records (journal); the queue id
  `console-<nodeId>` is answerable from the queue record itself + the
  enqueueControl commit message (`control-queue +1 <cmd> console-<n>`) +
  the console's reply comment; the nodeId is the shared JOIN KEY between
  the two layers (it is embedded in both ids). Pinned by the round-trip
  test. Open question for the reviewer: if "both identities in ONE journal
  record" is wanted literally, that is an fsm.mjs jrec fold (out of this
  lane's file ownership).
- D3 — reset keeps the queue id through the drain: the reset path in
  conductor-core has its own drain site (twelve lines above the cev line)
  and never reaches my edit — a console reset's drain identity stays
  `console-<n>` (lastAppliedReset.id + the reset-duplicate REJECTED
  record's event_id). Existing behavior preserved; the F-1 twin-guard
  extends to the console lane unchanged (two noteless console resets in
  one drain → the second is rejected as reset-duplicate, journaled).
- D4 — permissions deviation: the brief says `issues: write` +
  `contents: read`, but the command path enqueues via store.enqueueControl
  (a git CAS push to fsm-state) and the nudge posts repository_dispatch —
  both need `contents: write`. The intake door hit the same wall (the
  F-2a amendment, documented in intake.yml). Shipped
  `issues: write` + `contents: write` with the deviation documented in the
  YAML comment and the report. NOTED FOR THE REVIEWER.
- D5 — gate order (cheapest first, zero API for the common case):
  event-shape sanity → OPS_ISSUE scope (local) → bot author (local) →
  command parse (local; non-command = zero work beyond the parse) →
  permission API call (fail-closed: non-200 or below write → silent exit
  0, no reply burned) → dispatch (status = read-only reply; commands =
  enqueue + reply + nudge).
- D6 — exit codes mirror intake/turn.mjs: 0 decided-and-executed or
  silent; 1 enqueue/unexpected failure; 2 reply-comment POST failed (law 5
  — the operator feedback loop's health is visible); 3 nudge dispatch
  failed (the queue line holds; the tick/backstop/pinger still drains it).
- D7 — note on console queue records: null (no note syntax in the comment
  surface; the actor field already answers "who"; keeps F-1's twin-guard
  semantics identical to the ops/turn.mjs lane).

## Milestones

- [x] Repo cloned, branch t46/wc2-console created off origin/main@3ce598c.
- [x] Contracts read (t46-wc2-brief.md §3, T46-WC-DESIGN.md §6, agent
      brief), patterns read (ops/turn.mjs, intake/turn.mjs,
      event-ingest.mjs MINT_TABLE, conductor-core drain site, watchdog
      scan, store enqueueControl/fetch).
- [x] Baseline confirmed: 328/328 green on a clean checkout.
- [x] ops/console.mjs written (parse+record+status pure halves;
      runConsole with injected api/store/now seams; main() wires the real
      world; the nudge rides the api seam — zero live calls in tests).
- [x] ops-console.yml written (issue_comment[created] only, own group
      fsm-ops-console, GITHUB_TOKEN only, OPS_ISSUE from
      vars.OPS_ISSUE || '1' — m-8 documented load-bearing; permissions
      issues:write + contents:write per D4).
- [x] conductor-core F-12 edit landed (the cev construction: mint through
      MINT_TABLE when c.node_id, else c.id; + the mintEventId import).
      test-conductor-core.mjs 31/31 green after the edit.
- [x] tests/test-console.mjs written — 32/32 green; FULL suite 360/360
      (328 baseline + 32 new); sims 8/8 + 7/7 + 31/31 + 51/51;
      scripts/validate.sh VALIDATE-OK (YAML gate OK on ops-console.yml).
- [ ] Branch pushed, report + worklog finalized.

## Open questions (for the reviewer / orchestrator)

- Q1: D2 — the "both identities in the journal record" reading (see D2).
- Q2: D4 — the contents:write deviation (see D4); needs the orchestrator's
  sign-off as an F-2a-class amendment.
- Q3: OPS_ISSUE var is unset in this repo today → default '1' (the live ops
      issue is #1 — matches). The var is load-bearing (m-8): if the ops
      issue ever moves, the var must be set or the console goes silent
      (fail-closed).
