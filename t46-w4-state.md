# T46-W4 STATE — the adapter wave (CC adapter + conformance + sim3 + brief seed + X20 surface)

**Task ID:** 46-W4. **Status:** COMPLETE — all gates green. **Branch:** `t46/wb-4` (base `677e679` = the W1+W2+W3 integrated tip). Two implementation incarnations (the first landed the adapter core + tests; the second — the main agent during a Task-tool outage — finished sim3's four check/driver fixes, the brief seed, and the X20 workflow).

| Gate | Result |
|---|---|
| `node --test tests/*.mjs` | **241/241** (214 base → +27: 25 cc-adapter + routing-row updates) |
| `node sim/run-sim.mjs` | **8/8** |
| `node sim/run-sim2.mjs` | **7/7** |
| `node sim/run-sim3.mjs` | **31/31** (NEW — matrix/law-1/law-4) |
| `node worker/conformance-cc.mjs` | **21/21** (the C3 multi-harness proof: shim vs adapter parity) |
| `bash scripts/validate.sh` | **VALIDATE-OK** |
| x20-cc-smoke.yml | YAML-OK (workflow_dispatch only, feature-branch physics per F-M5) |

## What landed

| Commit | Contents |
|---|---|
| `4b98ca7` (incarnation 1) | **worker/cc-adapter.mjs** (620L): `ccTurn(envelope, opts)` — the lane picker (key pool × model chain, key-major, bounded by budget.lane_attempts; infra-class hops, work-class no-hop), the CLI invocation (npx -y @anthropic-ai/claude-code@CC_VERSION, -p, --max-turns, --output-format json, --disallowedTools WebFetch,WebSearch), the F-M8 env contract per lane (ANTHROPIC_BASE_URL=openrouter bridge, AUTH_TOKEN/MODEL/SMALL_FAST_MODEL, DISABLE_TELEMETRY, OX_AGENT_DEADLINE_UTC), the F-M6 process-group wall (SIGKILL the group at min(deadline, start+wall); grandchild-kill proven), CC_FAKE_LLM=1 → **worker/fake-cc.mjs** (178L: the REAL argv with the command head swapped; fixture markers [fixture:429|429-if|auth-text|reasoning|fail|exit-transport|exit-app|sleep-ms|dup-report|max-turns|artifacts|scratch|wb-violation]; the FAKE_CC_ECHO spawn-boundary record), transcripts BEFORE the report (fsm-sessions branch in real mode / local dir in fake mode; push retry → infra 'transcript-push-failed'), artifacts through the write-back door (violations → poison; allowed refs staged locally — the W-C task-branch seam). **worker/conformance-cc.mjs** (353L): 21 checks — 9 matrix parity rows (shim vs adapter vs expected), the spawn boundary (real argv + complete F-M8 env), lane rotation (lane 2 = rotated model, lane 4 = rotated KEY), the lane_attempts bound, the deadline group-kill, every SHIM_BEHAVIOR covered. **tests/test-cc-adapter.mjs** (470L, 25 tests). **worker/turn.mjs**: MODE=cc imports the REAL ccTurn (the stub is dead). **worker.yml**: OPENROUTER_API_KEY_2/CC_MODEL/CC_VERSION mappings. |
| this commit (incarnation 2 = main agent) | **sim/run-sim3.mjs** finished (600L): the FSM↔shim conformance driver — genesis → clock ASSIGN → assembleDispatchPayload (the W2 envelope, never hand-rolled) → law-1 gate → shimInvoke(seedFromRunId) → classifyOutcome → the door → attempt-scoped enqueue → conductorTick drain → terminal states; 31 checks (the behavior matrix end-to-end, the degraded gate, law-1's past-deadline class, law-4's dropped-run flip + net-zero + re-dispatch + seen-guard). Four check/driver fixes: the resolveFates twin-disambiguation (two-pass consumption: applied-REPORT records FIRST, REJECTED-by-event_id for the leftover — twins sharing an event_id disambiguate only by consumption), the post-halt backstop drain (F1: a halted chain still consumes its queue — X18-live-proven semantics), the law-4 flip assertion (journal REPORT records carry run_id, not the synthetic event_id), the brief fixture. **briefs/project.md** (NEW): the memory v1 seed — digest-of header + the contract summary + epoch conventions + environment facts; ~2.1KB; the conductor embeds it AS QUOTED DATA (W2's fences). **.github/workflows/x20-cc-smoke.yml** (NEW): the X20 LOWER-BOUND ceiling probe — workflow_dispatch only (F-M5 feature-branch physics), timed CLI install + ONE real-lane adapter turn + telemetry readback. |

## The ccTurn contract (as implemented)

```js
export async function ccTurn(envelope, opts = {})
// → { status, detail?, artifact?, artifact_refs?, telemetry, transcript_path, models, lane_attempts_used }
//   status ∈ the five classes (classifyOutcome the ONE normalizer; the
//   adapter re-derives per lane to decide the hop; runTurn re-derives once
//   at the report). opts: { runId, now, log, env?, spawnImpl? } — injectable
//   for tests; env defaults to process.env.
// Lane algebra: lanes = [key1×model1..4, key2×model1..4] flattened KEY-MAJOR,
//   sliced to budget.lane_attempts (default 3). Infra-class = transport stderr,
//   401/402/429/5xx text-as-answer (classifyOutcome markers), budget-
//   misconfigured truncation → NEXT lane. Work-class (empty completion,
//   deterministic app exit, max-turns) → NO hop.
// Wall: min(envelope.deadline_ms, start + budget.wall_ms); process-group
//   SIGKILL at the wall → { status:'deadline', detail:'wall-budget-exceeded' }.
// Transcripts: sessions/<task>/<run>-a<attempt>.txt + .meta.json BEFORE the
//   return (real mode: fsm-sessions branch push, retry once → infra
//   'transcript-push-failed'; fake mode: local dir).
```

## Discrepancies + resolutions (this wave)

1. **Journal REPORT records carry no event_id** — sim3's fate resolver and the law-4 check both assumed it; fixed consumer-side (run_id 'dispatch-verify' is the audit marker; the synthetic event_id is consumed at apply-time). The REJECTED path DOES record event_id (the twin-disambiguation asymmetry).
2. **The sim's halt cut late reports** — the live backstop drains a halted chain's queue (F1, X18-proven); the driver now runs one post-halt drain tick.
3. **briefs/project.md absent broke the envelope check** — the file is a W4 deliverable; creating it fixed the check AND completed the deliverable.
4. **The X20 workflow's env merge** — one env block per step (the draft had two).
5. (incarnation 1's records) — see the commit message of 4b98ca7 for the adapter-side resolutions (the fake-CLI argv fidelity, the workdir scan surface, the scratch exclusions).

## What's next (the session close sequence)

1. **Adversarial review round** on the whole `t46/wb` + `t46/wb-4` diff vs main (2-3 fresh-context reviewers: the deep-correctness lens, the red-team lens, the conformance-honesty lens) → fold → merge t46/wb-4 into t46/wb.
2. **Merge to main** in the quiescent window (the epoch is halted; drills done) → the deployed conductor begins minting envelopes on the next epoch.
3. **X20**: dispatch the smoke workflow ON the branch (ref t46/wb-4) with the real lane → record install/turn numbers as the LOWER-BOUND ceiling.
4. **X21**: EPOCH_MODE=cc var → reset → the synthetic CC epoch (shim sanity task + one real cc task through the FSM) → the dogfood-gate recording.
5. EVIDENCE.md (X19-X21), GAP-AUDIT closure, PLAN flip, SKILL §15, HANDOFF, /home/sync bundles.

## X20 dispatch instructions (exact)

```bash
curl -X POST -H "Authorization: token <PAT>" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/claudecode-headless/fsm-lab/actions/workflows/x20-cc-smoke.yml/dispatches \
  -d '{"ref":"t46/wb-4"}'
# then poll: /actions/workflows/x20-cc-smoke.yml/runs?per_page=1 → the run's log
# carries X20-RESULT (the adapter telemetry JSON) + install_s + turn_s.
```
