# T46-W1 STATE — the W-B CORE wave (contract lib + mint consolidation + five-class FSM receiver)

**Task ID:** 46-W1. **Status:** COMPLETE — all gates green. **Branch:** `t46/wb` (base `3595f2a` = main tip, the design-doc commit; never touched main, no force pushes).

| Gate | Result |
|---|---|
| `node --test tests/*.mjs` | **146/146 pass** (98 at base → +48 new; 0 fail) |
| `node sim/run-sim.mjs` | **8/8** |
| `node sim/run-sim2.mjs` | **7/7** |
| `bash scripts/validate.sh` | **VALIDATE-OK** |

Gate invocation note: the brief's literal `node --test tests/` fails on Node v24.19.0 (MODULE_NOT_FOUND — a trailing-slash dir arg is treated as a module). The repo-canonical invocation — the one `scripts/validate.sh` runs — is `node --test tests/*.mjs`; that is the gate above. (`FSM_SMOKE` stays opt-off, as in CI-like environments.)

## What landed (commits on t46/wb)

| Commit | Contents |
|---|---|
| `5b2e014` | **F-B3 + F-M9** — `MINT_TABLE` + `mintEventId()` live in `lib/event-ingest.mjs` (the ONE id-mint source); TICK/CONTROL/REPORT sites route through it, byte-identical shapes + injected-clock semantics; per-kind seed guards fail-closed on missing discriminators; `WAKE` has no entry (never journaled — minting for it THROWS). `tests/test-event-ingest.mjs` is **byte-unchanged** — probe6 stays green unchanged, as required. |
| `c2138d3` | **§1a** — NEW `lib/worker-contract.mjs` (463 lines): `envelopeFromDispatch` (F-B2 legacy-compat), `writeBackDoor` (pure validation, read-back-shaped return), `classifyOutcome` (F-M4-hardened five-class normalizer), `mintEventId`/`MINT_TABLE` re-export. + NEW `tests/test-worker-contract.mjs` (**35 tests**: envelope ok-shapes full+legacy-verbatim, the fail-closed matrix, the door allow/deny matrix, every classifier shape incl. error-as-answer + reasoning-first + budget-misconfigured, the mint table + probe6 rule table-side). |
| `0847475` | **F-B1 + F-B2(fsm half) + F-M3 + law-7** — `lib/fsm.mjs`: the five-class REPORT receiver, `rebuild()` parity, `genesis({mode})`, `law6Violations()`, ASSIGN/`DISPATCH_WORKER` task_ref pointers. Tests: +12 in `tests/test-fsm.mjs` (receiver/parity/genesis/law-6), +1 in `tests/test-conductor-core.mjs` (law-7 cold-start pin). |

**Test counts:** base 98 → **146**. Per file: worker-contract **35** (new), fsm **47** (35→47), conductor-core **25** (24→25), event-ingest 5 (unchanged), store 18 (unchanged), watchdog-core 16 (unchanged).

**Out-of-scope discipline:** nothing outside the IN list was touched (`git diff origin/main --stat` = exactly the 6 files above). Unrelated observations are recorded below, not "fixed".

## The interface contract — EXACT signatures as implemented

```js
// lib/worker-contract.mjs  (NEW — pure, zero I/O)
export function envelopeFromDispatch(cp, nowMs = Date.now())
//   → {ok:true,  envelope: {
//        task_ref:   {kind:'state-task', id},        // v1: record lives in state.json
//        prompt:     string,                         // prompt > title > `task <id>`
//        deadline_ms: number,                        // explicit cp.deadline_ms passthrough, else
//                                                  //   min(lease expiry, now+ttl_ms) − 120_000
//        session:    string,                         // cp.session or `${chain|'chain'}/${taskId}/${run_id|'local'}-a${attempt}`
//        budget:     {max_turns:int≥1 (dflt 40), wall_ms:int≥60_000 (dflt: remaining window, floored),
//                     lane_attempts:int 1..8 (dflt 3)},
//        mode:       'mock'|'real'|'cc',              // absent → 'mock'
//        attempt:    int≥1 }}                        // absent → 1
//   → {ok:false, class:'infra_failed', reason, detail?}   // FAIL-CLOSED only for corrupt/
//     // contradictory shapes: missing/empty task id, bad task_ref (kind/id mismatch),
//     // non-integer/negative attempt, unknown mode, non-string prompt/title, bad budget
//     // fields, no deadline source, deadline ≤ now (the law-1 late-start class).
//     // Legacy-minimal (today's live ASSIGN: task/lease/behavior/attempt/work_ms/expires/
//     // chain) gets DEFAULTS — minimalism is NOT corrupt (F-B2).
// Exported knobs: ENVELOPE_MARGIN_MS=120_000, ENVELOPE_MODES=['mock','real','cc'],
//   ENVELOPE_DEFAULT_MAX_TURNS=40, ENVELOPE_DEFAULT_LANE_ATTEMPTS=3,
//   ENVELOPE_MIN_WALL_MS=60_000, ENVELOPE_LANE_ATTEMPTS_BOUNDS=[1,8].

export function writeBackDoor({branch, paths, sizes = {}, allowRoot = []} = {})
//   → {ok:boolean, violations:string[], branch, taskId, allowed:string[], totalBytes, caps}
//     // PURE VALIDATION (no git calls — the remote read-back lands with the adapter wave
//     // and consumes {branch, allowed[], totalBytes, caps}). branch MUST match
//     // ^tasks/<id>$ (main/fsm-state/fsm-sessions refused). DENY ALWAYS, checked BEFORE
//     // the allowlist (declaring does not unlock): `.git*` segments (covers .github/**,
//     // .git, .gitignore…), path escapes (absolute, `..`, empty segments, backslashes).
//     // ALLOW: `tasks/<branch-id>/**` + entries of allowRoot (the cp.artifacts
//     // declared pathspecs — passed by the caller; the door stays pure). Root files
//     // (no `/`) allowed ONLY via allowRoot. Caps: 10MB/file (sizes[path]), 10MB/task
//     // total (WRITE_BACK_CAP_FILE_BYTES / WRITE_BACK_CAP_TASK_BYTES); a missing size
//     // reads as 0 (read-back measures actuals).

export function classifyOutcome(raw, ctx = {})
//   → {status:'done'|'work_failed'|'infra_failed'|'deadline'|'poison', detail?, artifact?}
//     // ONE pure function. Precedence: explicit 5-class status passthrough (done gets an
//     // E11 marker RE-CHECK even when stamped done) → legacy 'failed'→work_failed (the
//     // F-B1 alias) → unknown status→poison 'unknown-status(...)' → {error:{status:
//     // 401|402|429|5xx|'transport'}}→infra_failed 'lane-<n>' (other statuses→work_failed)
//     // → marker text in content (ctx.errorMarkers, default ['invalid api key',
//     // 'unauthorized', 'insufficient credits', 'rate limit'])→infra_failed
//     // 'error-as-answer(...)' BEFORE done → content→done → reasoning→done
//     // 'reasoning-as-answer' (F-M4 reasoning-first) → finish:'length' + nothing
//     // extracted→infra_failed 'budget-misconfigured' (F-M4) → both empty→work_failed
//     // 'empty-completion'. Non-string content/reasoning→poison 'bad-*-shape'.
//     // Non-object raw→work_failed 'empty-completion'. /g regexes are de-flagged
//     // (stateful .test would break purity). Exported: OUTCOME_CLASSES,
//     // DEFAULT_ERROR_MARKERS.

export { mintEventId, MINT_TABLE } from './event-ingest.mjs'   // F-B3: table lives THERE
```

```js
// lib/event-ingest.mjs  (CHANGED — mint consolidation only; mint rules UNCHANGED)
export const MINT_TABLE = {
  TICK:        (seed) => `tick-${seed.reason}-${seed.clockMs}`,          // clockMs = Date.parse(now())
  REPORT:      (seed) => `rep-${runId ?? 'local'}-a${attempt ?? '1'}`,   // F-E attempt-scoped
  CONTROL:     (seed) => `ctl-${seed.nodeId ?? 'direct'}-${seed.command}-${seed.clockMs}`,
  TASK_CREATED:(seed) => `task-${seed.issue}-${seed.bodySha8}`,          // W-C intake shape (no live site yet)
};  // WAKE: NO entry — mintEventId('WAKE', …) THROWS (never journaled)
export function mintEventId(kind, seed = {})   // unknown kind → throw; per-kind seed guards → throw
```

```js
// lib/fsm.mjs  (CHANGED — the receiver + genesis mode + law-6 audit)
// REPORT outcome.status handlers now: 'done' | 'progress' (unchanged) |
//   'failed' | 'work_failed' (ALIAS — byte-identical attempt-burn transition;
//     last_result.status records which vocabulary the worker used) |
//   'infra_failed' (F-F, unchanged: net-zero retry / infra-exhausted) |
//   'deadline' (attempt-burn + lease release; dest = attempts ≥ max_attempts ?
//     'quarantined' : 'ready'; counts stats.timeouts + (if requeued) stats.retries —
//     the TIMEOUT/reaper mirror; journal {kind:REPORT, reason:'deadline', error}) |
//   'poison' (quarantined TERMINAL regardless of attempts; journal
//     {kind:REPORT, reason:'poison', error← outcome.error ?? outcome.detail};
//     NO infra_attempts — task-poison vs lane-death stay distinguishable in the audit) |
//   anything else → reject `bad-outcome(<status>)` (fail-closed, unchanged)
// rebuild(): REPORT records with reason 'deadline' replay the same mirror
//   (timeouts++, lease cleared in EVERY dest, retries++ when to='ready') — F8 parity.
export function genesis({config, project, chainId, now, mode = 'mock'})  // mode rides project.mode
export const GENESIS_MODES = ['mock', 'real', 'cc']    // pinned === ENVELOPE_MODES by test
export function law6Violations(records, {requireAssignTaskRef = false} = {})  // → string[]
//   // NEW-class records (carry task_ref) audited: bad pointer shape, task/task_ref
//   // mismatch, inline payload fields (prompt|spec|body|title|tasks). Legacy records
//   // (no task_ref: TASK_CREATED.spec, MILESTONE.tasks) OUT OF SCOPE by design (F-M3).
//   // requireAssignTaskRef:true additionally flags pre-T46-shaped ASSIGN records —
//   // OPT-IN for journals known post-T46 (the live conductor audit enables it after
//   // the W-B deploy). clock()'s ASSIGN journal records + DISPATCH_WORKER actions now
//   // mint task_ref = {kind:'state-task', id}; rebuild()'s CONTROL/reset genesisSpec
//   // passthrough gains mode (legacy specs default 'mock').
```

## Discrepancies found (design vs code — resolutions per the discipline: design wins for NEW surfaces; live semantics preserved for existing)

1. **Mint-table seed slots (design sketch vs live rules).** The design sketch (`T46-WB-DESIGN.md` §1a / the brief) wrote `TICK: tick-<reason>-<seq>` and `CONTROL: ctl-<command>-<node_id>`. The LIVE discriminators are the F-G(b) injected-clock ms (`tick-<reason>-<clockMs>`, `ctl-direct-<command>-<clockMs>` — probe6 depends on them). Resolved per the brief's own F-M9 rule: **fixed the TABLE, not the call sites** — seeds are `{reason, clockMs}` / `{nodeId, command, clockMs}` with nodeId defaulting to `'direct'` (the repository_dispatch lane). REPORT seeds are `{runId, attempt}` (the sketch's slots were right there).
2. **`writeBackDoor` declared-artifact source.** The design says "paths declared in cp.artifacts"; the implemented signature takes `allowRoot = []` (the declared pathspecs) — the door stays PURE (no cp reaching in, no I/O), the adapter/caller passes `cp.artifacts`. The design's "remote read-back verification" is deferred to the adapter wave per the brief; the return shape (`{branch, taskId, allowed[], totalBytes, caps}`) is designed for it.
3. **`makeGenesis` is not an fsm.mjs export.** In the codebase `makeGenesis` is the injected closure in `conductor/turn.mjs` (W2's OUT-of-scope file) / conductor-core's dependency. The W1 half landed where the brief's §F-B2's fsm-lab halves say: `genesis()` gained `mode` (rides `project.mode` — chosen over `chain.mode` and documented: mode is an EPOCH/project property, chain carries runtime identity), the reset genesisSpec carries it, legacy specs default `'mock'`. The conductor-closure wiring (reading epoch config → passing mode) is W2's.
4. **Receiver's deadline stats counting.** The design text says "attempt-burn + lease release"; the implementation ALSO counts `stats.timeouts` (+ `stats.retries` when requeued) — the exact TIMEOUT mirror needed for rebuild/F8 parity (rebuild's TIMEOUT branch does the same). Pinned by tests; recorded as an interpretation, not a rule change.
5. **classifyOutcome vs the receiver on unknown statuses.** The classifier maps an unknown status → `poison 'unknown-status(...)'` (loud+terminal beats silent remapping; workers route ALL modes through the classifier per §1c). The RECEIVER still fail-closed rejects unknown statuses (`bad-outcome(...)`) for anything that bypasses the contract. Two layers, both pinned by tests — intentional, recorded so W2/W3 don't "fix" one away.
6. **Gate command spelling.** `node --test tests/` (the brief's literal form) errors on Node v24.19.0; the repo-canonical `node --test tests/*.mjs` (validate.sh's form) is what's green. Noted above.
7. **Session/deadline fallback vocabulary.** Envelope `session` falls back to `chain`/`local` segments when `cp.chain`/`cp.run_id` are absent (legacy-minimal carries `chain` but not `run_id`); the design's `${chainId}/${taskId}/${runId}-a${attempt}` is the full shape. `classifyOutcome` returns `artifact` (sliced 200) for done shapes — a documented superset of the design's `{status, detail?}`.

**Unrelated observations (NOT fixed, for the record):** none new this wave — the B4-era F-1 (reset not idempotent under double-dispatch) and S-3 (cron sparsity) items remain open for the W2 control-plane pass.

## What's next (W2 / W3 / W4 — building against the surfaces above)

- **W2 — conductor wave (`conductor/turn.mjs`, `conductor.yml`, `lib/conductor-core.mjs`):** mint the FULL envelope on ASSIGN (prompt from the task record + `briefs/project.md` AS QUOTED DATA + task window; `deadline_ms` from lease/TTL arithmetic; budget defaults; `mode` from `state.project.mode` — now riding genesis) — the ASSIGN action already carries `task_ref`; wire `makeGenesis`'s mode from epoch config (the F-B2 conductor half). Law-4 run-creation verification (dispatched run EXISTS after the F-M1 window: 360s probe + one 360s re-check; missing → assignment flips `infra_failed 'dispatch-unverified'`, net-zero). `conductor.yml` `permissions: actions: read`; runless synthetic reports `rep-synthetic-<uuid8>-a1`. F-M2 pacing floor (≥300s only when `lease_minutes ≥ 7`, config-bounded, tested at both sides). F-1 reset epoch-guard (B4 finding). Consume `envelopeFromDispatch`'s fail-closed returns as infra-class, never work.
- **W3 — worker/shim wave (`sim/harness-shim.mjs`, `worker/turn.mjs`, `worker.yml`):** `shimInvoke(envelope, behavior, seed)` — behaviors `fast, slow, poison, infra-flaky, deadline, hang, dup-report, wb-violation`, seeded RNG. `worker/turn.mjs` routes ALL modes through `envelopeFromDispatch` FIRST (law-1 start-gate: lease expired at job start → report `infra_failed 'late-start'`, exit 0), then MODE=mock→shim / real→raw stand-in / cc→adapter; report enqueue keeps the CAS + attempt-scoped `mintEventId('REPORT', …)`; the enqueue-failure retry-then-run-conclusion hardening.
- **W4 — CC adapter + conformance (`worker/cc-adapter.mjs`, `worker/conformance-cc.mjs`, `sim/run-sim3.mjs`, `briefs/project.md`):** the lane picker (key pool × model chain, bounded by `budget.lane_attempts`), `CC_FAKE_LLM=1` deterministic stub, `OX_AGENT_DEADLINE_UTC` from `envelope.deadline_ms` (rc=124 → `deadline`), `classifyOutcome` as the ONE completion normalizer (error-as-answer markers BEFORE done), transcripts to `fsm-sessions` BEFORE report enqueue, artifacts through `writeBackDoor` + the remote read-back (consumes W1's `{branch, allowed[], totalBytes, caps}` return shape), sim3 driving FSM↔shim end-to-end, the `briefs/project.md` seed, then X20/X21.
