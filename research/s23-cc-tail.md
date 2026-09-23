# s23 — the CC ladder's free-model tail (THE DESIGN)

**Status:** reviewed design (the W1 candidate improvement — EVIDENCE.md §W1's "Candidate code improvement noted in PLAN").
**Grounding:** LIVE free-model probes through the relay (this session, 45 relay calls, $0 spend — probe scripts + raw JSON: `/home/z/my-project/scripts/s23-cctail-probe{,2}.py` + `s23-cctail-probe{,2}-results.json`), the s19/s20/s22-bench model verdicts, and the live W1 arc.
**The one-line thesis:** the free tail is ALREADY in the chain (CC_MODEL_CHAIN_DEFAULTS m3); the defect is the ADVANCE POLICY — the W1 KEY-JUMP's no-next-key fallback burns the budget's final slot on the dead key's next PAID sibling. One rule in `ccNextLaneIndex` redirects that final slot to the `:free` sibling: the same `lane_attempts:3` budget, the third lane becomes the tail, the W1 quarantine arc becomes a completed turn.

---

## 1. The probe data (live, relay-transported, 2026-09-23)

Transport: the supabase edge relay, POST-JSON spec protocol (region-cycled us-east-1/eu-central-1/ap-southeast-1; auth = relay token, the OR key rides `spec.headers.Authorization` — the OPENROUTER-KEYS §S23 protocol note). 45 calls total: `s23-cctail-probe.py` (28) + `s23-cctail-probe2.py` (17). **Probe 1's or-074 rows are INVALID** (my transcription of the key was wrong — its 401 was my bug, not the key's death; probe 2 re-ran the control with the registry's exact value). Every number below cites probe 2 where the two disagree.

### 1a. The 32K pre-flight on the REAL CC surface — POST `/api/v1/messages` (the exact upstream shape `worker/cc-bridge.mjs` forwards: Authorization synthesized, `anthropic-version: 2023-06-01`, body verbatim, `max_tokens: 32000` the CLI's ask)

| key (state) | deepseek-v4.1-flash (paid) | glm-5.3-flash (paid) | nemotron-3.5-lightning:free | cohere/north-mini-code:free |
|---|---|---|---|---|
| **or-079 kasulty, OVERDRAWN −$0.384** | **402** billing_error, 383ms ("Insufficient credits") | **402**, 837ms | 500 ×2 (30–60s, capacity tax) — **never 402** | **200**, 978ms, text `OK`, cost 0 |
| or-083 zikomolapo, drained | 402, 686ms | 402, 837ms | 500 / relay-timeout(75s) | 200, 2040ms |
| or-082 ansgauretychis-B, $0.003 | 402, 700ms | **402: "You requested up to 32000 tokens, but can only afford 11464"**, 843ms | **200**, 3.3–6.3s | 200, 1657ms |
| or-074 paid control, $8.88 (probe 2, corrected key) | 200, 2677ms | 200, 1973ms | 500 (60s) then 200 (25s) | — |
| or-084 paid KEY_2, $5.76 (probe 2) | 200, 2083ms | 200, 1422ms, text `OK` | 200, 25006ms | — |
| or-001 standard free tier (50 free req/day) | (skip — known 402) | (skip) | 500, 60s | 200, 1379ms |

**THE CITATION PAIR (design answer 2's evidence):** the SAME overdrawn key (or-079, −$0.384) at the SAME `max_tokens=32000` on the SAME surface: paid deepseek → **402 billing_error** (sub-second); free cohere → **200 with text content at cost 0** (978ms); free nemotron → capacity 500s but **zero 402s across every key class**. The credit pre-flight is cost-proportional and a $0 request passes it — **a drained (even overdrawn) key serves the free tail**.

**The proportional gate, exact:** or-082's glm 402 body carries the arithmetic — "can only afford 11464" ≈ $0.003 remaining at glm's $0.30/M completion pricing (11464 × 0.30/1M = $0.0034). The 402 is `max_tokens`-proportional per KEY CREDIT STATE, not per key identity: both approved paid models 402 on every drained key in the matrix, and no sub-$0.019 key can pass the CLI's fixed 32000-token ask on deepseek ($0.60/M × 32K = $0.019) nor on glm ($0.0096 — or-082's $0.003 misses by 3.2×).

**The content shape on the Anthropic-compat surface (probe 2 raw bodies):** the 200s return multi-block `content: [{type:'thinking',…},{type:'text',text:'OK'}]` — text rides the block AFTER the thinking block. The real CLI parses Anthropic multi-block content natively (this is its native surface); my probe's single-block parser read `None` — a probe artifact, not a model defect. Raw bodies cited in `s23-cctail-probe2-results.json`.

### 1b. The free-model catalog + the dead slug (GET `/api/v1/models`, keyless, 200)

21 `:free` models live. The candidates: **nvidia/nemotron-3.5-lightning:free** — ctx 1,000,000, max_completion 65,536, $0/$0; **cohere/north-mini-code:free** — ctx 256,000, max_completion 64,000, $0/$0. **deepseek/deepseek-v4-flash-0731:free is GONE from the catalog** — 404 `not_found_error` on every key (probe 1 §B). The s19 poison exclusion ("hallucinated the task — never unsupervised on the cc lane") is now self-enforcing upstream; the real lane's chain slot 2 (turn.mjs `REAL_MODEL_CHAIN_DEFAULTS[1]`) is a dead slug — a separate one-line candidate fix, out of this design's scope, recorded in §8.

### 1c. The reliability datum (probe 2 §3: nemotron ×6 on or-082, back-to-back)

2/6 × 200 (3.6s, 21.8s) / 4/6 × 500 (30–60s walls) — **the bench F7 500-tax is ACTIVE today.** cohere: 6/6 × 200 across five key classes (overdrawn / drained / $0.003 / paid / free-tier), 978ms–5.2s, text verified on the messages surface. The chat/completions cross-check (probe 1 §F) agrees: cohere 200 + `OK` on both drained keys; nemotron 500/timeout.

### 1d. The envelope reality (the F7/F1 applicability check)

The FSM CC envelope is minted by `assembleDispatchPayload` (conductor-core.mjs:114–134): title (≤512B) + Spec JSON (≤2KB) + `briefs/project.md` as quoted data (measured: 2557B) + fences, hard-capped at 16KB. Live examples: the W1 drill task T-W1 (issue #16): envelope ≈ 3.2KB ≈ **~800 tokens**; the X27 soak one-liners (issue #19): ≈ 2.8KB ≈ ~700 tokens. Add the CLI's own ~13K-token stable system prefix (the bench F8's measured prefix) → **~14K ctx per call, 1–5 calls per turn** (s19: 4/4 calls).

The bench v3's nemotron failures are DEEP shapes: F1 needle 0.0 at **50K/120K ctx**, F7 transport-blocked at **10-turn × 13.5K threads** — both 3–10× outside the FSM envelope reality. The bench's own verdict ("the free lane serves SHORT, SHALLOW work only — F3-distractor passed") describes exactly the FSM CC turn. The s19 LIVE CC-CLI verdict through the real bridge: nemotron "done 22.1s, generic but valid" — the only free model ever verified end-to-end on the CC lane's own surface.

---

## 2. The seven design answers

### 2.1 Where does the tail attach? → **(a)-minimal: the advance-policy rule — the tail is already in the chain; the KEY-JUMP's no-next-key fallback is what strands it**

The deployed chain is `[deepseek-v4.1-flash, glm-5.3-flash, nemotron-3.5-lightning:free]` (cc-adapter.mjs `CC_MODEL_CHAIN_DEFAULTS`, the s19 D2 verdict) × the 2-key pool, flattened key-major = `[k1ds, k1glm, k1nem, k2ds, k2glm, k2nem]`, bounded by `lane_attempts:3` (cc-adapter.mjs:752).

**The defect, precisely:** `ccNextLaneIndex` (cc-adapter.mjs:160–168) on a KEY-CLASS failure (401/402/429 — `CC_KEY_CLASS_STATUSES`) jumps to the next key's block; when there IS no next key it falls back to ordinary `+1` — the dead key's next PAID sibling. The W1 live arc: `k1ds(401) →JUMP→ k2ds(402) →+1→ k2glm(402) → budget exhausted(3/6) → infra-retry ×2 → QUARANTINE`. The free slot (k2nem) sat ONE index away, untried, while the third slot burned on a model that shares the dead key's credit state. (The single-key pool does NOT have this defect: `k1ds(402)→k1glm(402)→k1nem` reaches the free slot at attempt 3 today — the pin at test-worker-routing.mjs:600–624 documents the 2-key shape `[k1/ds, k2/ds, k2/glm]` as current behavior.)

**THE RULE:** on a KEY-CLASS failure whose lane's key is the LAST key in the pool (no next key to jump to), advance DIRECTLY to the same key's next `:free` chain slot (skipping the paid siblings in between — they share the dead key's credit state; probe §1a: glm 402s wherever deepseek 402s on every drained key, and or-082's "can only afford 11464" proves the fixed 32K ask cannot fit any drained key on either paid model). The W1 arc becomes: `k1ds(401) →JUMP→ k2ds(402) →TAIL→ k2nem(:free)` — 3 attempts, the brief's exact arithmetic.

**Why not (b) lane-class fallback after product exhaustion:** the exhaustion IS the budget boundary — a post-exhaustion handoff either grows the budget (see 2.3) or needs a second exhaust class + a turn.mjs re-dispatch seam (see (c)'s costs). It also re-runs the whole CLI spawn (system-prompt re-priming, cache cold) for work the in-lane rotation serves cheaper.

**Why not (c) turn-level escalation (cc-adapter returns a distinct exhaust class → turn.mjs re-dispatches on the real lane's free chain):** (i) the real lane's chain is served by `OPENROUTER_KEY_POOL` keys whose documented precedence is "pool keys serve THE REAL LANE — the primary secret stays the CC/paid lane's key" (turn.mjs:117–134) — re-purposing them for a CC turn violates the lane/key precedence and couples the two lanes' failure domains; (ii) a turn-level re-dispatch burns a second wall window after the first already spent its lanes; (iii) the raw-completion stand-in (`realWork`) has none of the CC lane's transcript-before-report, door-governed write-back, or CLI argv machinery — the re-dispatch would need that surface re-wired or would silently LOSE the CC contract (transcripts/door) for tail-served turns.

**Why (a)-minimal wins:** zero change to `ccLanes`/the product; zero change to the budget clamp; the 5xx/provider-diversity arc KEEPS its existing ladder (ordinary `+1` advance still walks `k1ds→k1glm→k1nem` — the free slot reachable at m3 on non-key-class trouble, unchanged); the rule is one pure function + two env knobs; the W1 quarantine arc becomes a done turn at the SAME budget.

### 2.2 The 402 semantics on `:free` models — **CONFIRMED: a free model on a drained key does NOT 402 (the pre-flight is cost-proportional; $0 passes it)**

Citation (probe §1a, the pair on or-079 overdrawn −$0.384): paid deepseek @32K → **402 billing_error, 383ms**; free cohere @32K → **200, 978ms, text `OK`, usage cost 0**; free nemotron → 500s (capacity) with **zero 402s across every key class in the matrix** (overdrawn / drained / $0.003 / paid / free-tier). The tail therefore survives BOTH paid keys draining — even an OVERDRAWN key (or-079) serves free-model traffic cleanly. This is the designed last resort: the tail's serving requirement is AUTH-alive, not credit-alive — and the W1 KEY-JUMP has already rotated past auth-dead keys by the time the tail fires (the tail inherits the CURRENT lane's key = the last key the ladder touched = the last auth-known-alive key).

### 2.3 The lane-attempt budget — **RECOMMENDATION: the budget does NOT grow; the tail REPLACES the last paid lane (bounded total, the SAME `lane_attempts:3`)**

The arithmetic:

| | today (W1 live arc) | with the tail |
|---|---|---|
| attempt 1 | k1 deepseek → 401 (KEY-JUMP) | k1 deepseek → 401 (KEY-JUMP) |
| attempt 2 | k2 deepseek → 402 (no next key → +1) | k2 deepseek → 402 (**TAIL RULE**) |
| attempt 3 | k2 glm → 402 (credit-dead sibling) | **k2 nemotron:free → 200 → DONE** |
| then | exhausted(3/6) → infra-retry ×2 → QUARANTINE | — |

The glm slot is NOT lost where it matters: in the both-keys-dry arc glm-on-k2 is empirically dead (probe §1a: glm 402 on every drained key — the 32K ask can't fit); in the single-key-dry and 5xx/provider-diversity arcs the ladder is byte-identical (ordinary advance unchanged). `maxLanes` (cc-adapter.mjs:752) is untouched; the tail consumes ONE attempt ordinal like any lane.

**The quarantine verdict stays REACHABLE — the tail is a bridge, not an immunity:** if the tail itself fails key-class (429: the key's free-daily quota gone; 401: the key died between lanes), the ladder exhausts at 3 → the net-zero infra-retry ladder (INFRA_RETRY_MAX=3, fsm.mjs:63 — the W1 arc's 3 dispatches) → infra-exhausted quarantine. A fleet that exhausts even its free lane (429 × both keys' 1000/day free allowance) is honestly quarantinable. The F-6 budget-window machinery sees the tail's 429s exactly like paid 429s (quota-shaped infra) — the pause path needs NO change.

### 2.4 The quality economics — **a nemotron-class turn beats a quarantined task; the prompts are TRUSTED; the escape hatch is a repo var**

The trade: the bench v3's nemotron 3/20 is the graded-competence datum, but the failing facets are outside the FSM envelope (§1d: F1 50K+ ctx, F7 10-turn threads vs the FSM's ~14K-ctx one-shot turns); the in-shape facet (F3-distractor) passed; the s19 live bridge verdict was "done 22.1s, generic but valid". A generic-but-valid turn that completes the task ≫ a quarantined task that completes nothing (the W1 arc's terminal state).

**The trust argument:** the s20 stress battery's hard gate — nemotron COMPLIED with the planted prompt injection (0.0 on injection; the paid models resisted) — applies to UNTRUSTED-INPUT surfaces. The CC lane's prompts are TRUSTED by construction: the conductor mints them from the W-C intake-gated spec (`lib/intake.mjs` — hostile issue bodies never reach the conductor), `assembleDispatchPayload` neutralizes fence markers in title/spec (`untrusted()`, conductor-core.mjs:122) and carries the brief as explicitly-fenced QUOTED DATA; the output side is governed by the write-back door + the poison class. No untrusted content reaches a tail-served turn that doesn't equally reach a deepseek-served turn.

**The reliability reality (recorded honestly):** nemotron's per-call health TODAY is 2/6 (probe §1c — the 500-tax active). Three absorbers stack in front of it: (i) the CLI retries internally ~12× before the lane fails (the W1 arc's "401 ×12 retries" — a 500-window of minutes is ridden out INSIDE one lane attempt; the wall is the lease-derived deadline, conductor-core.mjs:156 `wall_ms = max(60s, deadline−now)` — ~43min at a 45-min lease, ample for 12 × 30–60s retries); (ii) the lane rotation; (iii) the infra-retry ladder's 3 dispatches. Coarse arithmetic on a 2/6 day: P(one lane's 12 internal retries all miss) ≈ (4/6)^12 ≈ 0.7%; P(3 dispatches all fail) is negligible. The 500-tax is a LATENCY tax on the tail, not an availability loss.

**cohere/north-mini-code:free is the recorded ALTERNATIVE** (probe: 6/6 across five key classes, 978ms–5.2s, 256K ctx, 64K completion, text verified on the messages surface — the reliability pick TODAY) — but it has NEVER run a live CC-CLI turn (the s19 eval benched it only on the real-lane shape). See open question §6.1.

**THE ESCAPE HATCH:** `CC_TAIL_MODEL` (repo var). Set to `''` (or a new `CC_TAIL_DISABLED=1`) → the chain carries no `:free` slot → the tail rule degenerates to today's `+1` advance, bit-for-bit. Set to any `:free` slug → the tail model swaps without a code change. The quality-vs-completion call stays the OPERATOR's.

### 2.5 The telemetry — **the tail must be DISTINCT on the LANE view (both paid keys dry = an operator action)**

The carry (all additive, no schema break):
1. **`lane_class: 'free-tail'`** on the adapter's laneLog row (cc-adapter.mjs:844–849 `laneInfo`) when the lane's model is the chain's `:free` slot — rides `telemetry.lanes[]` verbatim (the adapter's own display space, 1-based key_index unchanged).
2. **`lane_stats.models[<free-slug>]`** — already keyed by model slug (lane-telemetry.mjs aggregate): a tail-riding epoch renders `nemotron-3.5-lightning:free:N` as its own models row on the console's existing `lane models:` line (console.mjs:386). **The `:free` slug IS the tail marker in the journal** — no fsm.mjs `laneOutcomeFields` change required for visibility.
3. **`key_index`/`pool_size`** — the O-3 carry (cc-adapter.mjs:993–1007) already reports the serving key; the tail rides the last-served key, so the LANE-view key line shows the true serving key.
4. **The console gains one line** (ops/console.mjs `renderLaneLines`, derived from the models map's `:free` presence + the window's records): `- lane tail: N turns on nemotron-3.5-lightning:free (k1) — BOTH paid keys dry (operator: top up or swap a key)`. The accumulator already walks the models map (console.mjs:364) — the derivation is ~5 lines.

Optional explicit journal field `tail_served: true` on the outcome (the `laneOutcomeFields` allowlist family, fsm.mjs:458–474) if the orchestrator wants the journal self-describing rather than slug-derived — open question §6.3.

### 2.6 The alert — **N=3 turns / X=15 min, whichever first; the O-class alert lane (`fsm-watchdog-alert` issue family), ALERT-ONLY (no pause)**

Riding the tail means BOTH paid keys are dry — a bridge posture, never a home. **N=3 turns**: matches the F-6 budget-window threshold family (3 distinct = a real posture, not a blip — 1–2 turns can be a transient drain edge). **X=15 min**: a nemotron-class turn is 20–160s, so 15 min ≈ 5–45 tail turns — well past "a bridge", short of the budget-pause's epoch-level posture. The counter lives in the CONDUCTOR's drain (where the journaled REPORTs land — it already reads the lane fields via `laneOutcomeFields`): `stats.tail_turns` + a `tail_since` stamp, armed on the first tail-marked report, reset when any paid-model report lands (a key recovered). The threshold crossing posts through the established O-class alert lane — the `budgetAlertIssue` precedent (conductor/turn.mjs:127–157: find-open→comment / none→open, the 24h marker dedup) with a DISTINCT body token (`**[fsm-alert] FREE-TAIL RIDING**`) so the dedup classes it separately from the budget pause. The body states the operator action (top up / swap a key / set CC_TAIL_MODEL). **No pause** — the tail is serving work; parking the epoch would convert a degraded-but-alive fleet into a stopped one (the budget pause exists to stop ATTEMPT BURN; the tail burns nothing).

### 2.7 The model constraint compliance — **HARD RULE: the tail is `:free`, always; paid traffic rides ONLY the two approved models**

The principal's binding constraint (OPENROUTER-KEYS §S23): paid traffic rides ONLY `deepseek/deepseek-v4.1-flash` or `z-ai/glm-5.3-flash`; everything else must be `:free`; CC never runs its default model. The build enforces:
1. **`CC_TAIL_MODEL` must end `:free`** — a non-`:free` value fails LOUD at lane-build time (the adapter throws; the turn reports infra_failed with the distinct detail `bad-tail-model(...)`) — never a silent paid serve outside the approved pair.
2. **The default chain's non-tail models ∈ the approved pair** — a unit pin (the defaults are `[deepseek-v4.1-flash, glm-5.3-flash]`; a custom `CC_MODEL` that is neither approved-nor-`:free` is an operator misconfiguration the same pin family should surface as a documented behavior, not silently serve).
3. **The poison exclusion stays pinned in the defaults' comment + docs:** `deepseek-v4-flash-0731:free` (s19: hallucinated the task) is excluded from the CC lane — and is now 404-dead upstream anyway (probe §1b), making the exclusion self-enforcing.

---

## 3. The build items (file:line surface)

| # | surface | the change |
|---|---|---|
| B1 | `worker/cc-adapter.mjs:160–168` (`ccNextLaneIndex`) | THE RULE: on `keyClassFailure` with NO next key in the pool, scan FORWARD within the SAME `keyIndex` block for the first lane whose `model.endsWith(':free')` at index > i; return it (the skip); none found → `i + 1` (today's fallback). Pure, exported, unit-pinned. |
| B2 | `worker/cc-adapter.mjs:116–125` (`ccModelChain`) + new `CC_TAIL_MODEL` | The tail slot: default `nvidia/nemotron-3.5-lightning:free` (the s19 verdict); `CC_TAIL_MODEL` overrides (must end `:free` — LOUD throw otherwise); `CC_TAIL_MODEL=''` / `CC_TAIL_DISABLED=1` → no `:free` slot in the chain → the rule degenerates to `+1` (the escape hatch). The paid head stays `[CC_MODEL, deepseek, glm]` with the W7 dedup. |
| B3 | `worker/cc-adapter.mjs:844–849` (the laneLog row) | `laneInfo.lane_class = 'free-tail'` when the lane's model is the chain's `:free` slot (the tail marker rides `telemetry.lanes[]` verbatim). |
| B4 | `tests/test-cc-adapter.mjs:544–563` (the pure block) | Pins: the W1 shape (2-key pool, i at k2/ds, key-class → the k2/:free index, NOT +1); the no-free-slot degenerate (custom paid chain → +1, byte-identical); the tail-as-head degenerate (free slot at m1 → no forward free sibling → +1); `CC_TAIL_MODEL` validation (non-`:free` → throw; `''` → absent); the default-chain constraint pin (non-tail models ∈ the approved pair). |
| B5 | `tests/test-worker-routing.mjs:600–624` | **THE BEHAVIORAL PIN (the mutation spot):** the W2 mode:cc `[fixture:429]` drill's expected ladder changes `[k1/ds, k2/ds, k2/glm]` → `[k1/ds, k2/ds, k2/nemotron:free]` — the third spawn is the tail; `lane_attempts_used` stays 3; the exhaustion message stays `lane-exhausted(3/6 lanes, …)` when the tail also fails. |
| B6 | `tests/test-cc-adapter.mjs:491` (the key-jump recovery) | UNCHANGED and re-asserted: k1 429 → JUMP → k2 healthy → done at attempt 2 (the tail must NOT fire when a key is healthy — it fires only on the last key's key-class failure). |
| B7 | `worker/conformance-cc.mjs` | The parity matrix gains the tail-fire row (fake CLI, both keys `exit-api-402`-shaped, tail done) + the tail-also-fails row (exhaustion shape unchanged). |
| B8 | `ops/console.mjs:364, 386–411` (`accumulateLaneStats`/`renderLaneLines`) | The `lane tail:` line (derived from the `:free` slug in `lane_stats.models` + the record's `key_index`); degrade to no line on old-format records (the established guard family). |
| B9 | `lib/conductor-core.mjs` (the drain) + `conductor/turn.mjs:127–157` | `stats.tail_turns` + `tail_since` (armed on the first tail-marked REPORT — the `:free`-slug derivation or the explicit `tail_served` field per §6.3; reset on any paid-model report); the N=3/X=15min threshold posts the `**[fsm-alert] FREE-TAIL RIDING**` body through the `fsm-watchdog-alert` issue lane (find-open→comment / none→open, 24h marker dedup — the budgetAlertIssue precedent verbatim). ALERT-ONLY, no pause. |
| B10 | `worker/fake-cc.mjs` | NO CHANGE — the existing `exit-api-<status>-if:<substr>` fixture vocabulary already supports the tail drill (both keys 402-if their key substrings, the tail lane's spawn succeeds; the fake reads `ANTHROPIC_MODEL` from the lane env — the `:free` slug rides it unchanged). |

**The mutation spots (the build's self-verification, the s22-staged discipline):** (M1) revert B1's rule → B5 fails (glm returns as the third spawn) + B4's pure pins fail; (M2) drop B3's marker → the telemetry pin fails; (M3) invert B9's threshold (N=3→N=∞) → the alert pin fails; (M4) strip B2's `:free` validation → the constraint pin fails (a paid tail silently serves).

**Docs:** EVIDENCE.md gains the tail drill section when the build's live verification runs; `briefs/project.md`'s "Mode cc routes through the Claude-Code adapter (OpenRouter lanes, free-model fallback)" line becomes accurate for the 2-key posture.

---

## 4. What the design does NOT change (the blast-radius statement)

- `ccLanes`/the key-major product, the D2 chain order, the bridge (cc-bridge.mjs — the `:free` slug rides `CC_LANE_MODEL`/`ANTHROPIC_MODEL`/the `/v1/models` synth/the `/v1/messages` pin UNCHANGED; probe §1a verified the upstream accepts `:free` slugs on exactly the surface the bridge forwards), the wall/group-kill machinery, the transcripts/door surface, the infra-retry ladder, the F-6 budget window, `INFRA_RETRY_MAX`, the W7 dedup, the O-3 key/pool carry.
- The real lane (`worker/turn.mjs`) — untouched, including its OWN dead-slug problem (§1b, recorded §6.5).

## 5. The self-review pass (every mechanism claim re-cited against the live code)

- ✔ "The chain already contains the free slot": cc-adapter.mjs:105–109 `CC_MODEL_CHAIN_DEFAULTS` m3 = `nvidia/nemotron-3.5-lightning:free`; `ccLanes` (134–140) flattens per-key.
- ✔ "The no-next-key fallback is `+1`": cc-adapter.mjs:160–168 — the loop `for j…` returns `i+1` when no other keyIndex follows.
- ✔ "The W1 arc burned k2glm as attempt 3": EVIDENCE.md §W1 item 3 ("Lane 3 (k2 + glm-3.5-flash): 402 again"); the pin at test-worker-routing.mjs:619–623 asserts the same ladder shape in fake mode.
- ✔ "The budget clamp is untouched": cc-adapter.mjs:751–752 `maxLanes = min(lanes.length, clamp(1..8, lane_attempts))`; the tail is a lane in `lanes` — it consumes an attempt ordinal like any sibling.
- ✔ "The infra-retry ladder gives 3 dispatches": fsm.mjs:63 `INFRA_RETRY_MAX = 3`; the W1 arc's "re-dispatched twice, then the infra-exhaustion quarantine".
- ✔ "The CLI retries internally ×12": EVIDENCE.md §W1 item 1 ("the bridge calls 401 ×12 retries").
- ✔ "The wall is lease-derived": conductor-core.mjs:156 `wall_ms: Math.max(60_000, deadlineMs - nowMs)`; cc-adapter.mjs:745 `wallDeadlineMs = min(deadline, t0+wall_ms)`.
- ✔ "The prompt is title+spec+brief, capped 16KB": conductor-core.mjs:124–134; brief measured 2557B; T-W1 issue #16 body 440B; X27 issue #19 tasks one-line.
- ✔ "The 402 is max_tokens-proportional": EVIDENCE.md §W2 probe matrix + probe §1a or-082's "can only afford 11464" (glm $0.30/M → 11464 ≈ $0.0034 ≈ remaining).
- ✔ "The console renders per-model rows from lane_stats.models": console.mjs:364 + 386.
- ✔ "The alert lane exists as the budgetAlertIssue precedent": conductor/turn.mjs:127–157 (find-open→comment/none→open, `fsm-watchdog-alert` label).
- ✔ "The fake fixture vocabulary covers the drill": fake-cc.mjs:19–20 (`429-if:`), 37–50 (`exit-api-<status>-if:<substr>` — the recovery fixture).
- ✔ "The bridge needs no change": cc-bridge.mjs:69 (`CC_LANE_MODEL` env), 142–161 (the synth `/v1/models` for ANY id), 214–221 (the `/v1/messages` model pin) — all slug-agnostic; probe §1a exercised the exact upstream surface with `:free` slugs.
- ✔ "The pool precedence rule forbids (c)": turn.mjs:121–125 ("pool keys serve THE REAL LANE — the primary secret stays the CC/PAID lane's key").

## 6. Open questions for the orchestrator

1. **The tail default — nemotron vs cohere.** nemotron: the only free model LIVE-verified through the real bridge (s19: done 22.1s), the bench-characterized ceiling, conflict-flagging superpower; per-call health 2/6 TODAY (the 500-tax — absorbed by the CLI's ~12 internal retries + the infra ladder, per §2.4's arithmetic). cohere: 6/6 across five key classes TODAY, 1–5s, 256K ctx; NEVER CLI-evaluated. RECOMMENDATION: ship nemotron as the default (the verified surface beats the unverified one), spend 15 minutes on a live CC-CLI eval of cohere (the W1 drill shape, one task), and flip the default via `CC_TAIL_MODEL` if cohere wins. The var makes this an operator decision either way.
2. **A 2-slot free tail chain (nemotron→cohere internal rotation on the tail's own 500s)?** REJECTED here for budget boundedness (§2.3: the tail REPLACES the last paid lane — a second free slot would either grow the budget or displace a paid slot in the healthy arcs). Revist only if the live tail drill shows the 500-tax materially degrading completion rates.
3. **The explicit `tail_served` journal field vs the `:free`-slug derivation.** The slug derivation (§2.5) needs zero fsm.mjs schema change; the explicit field is self-describing and rides the `laneOutcomeFields` allowlist family (fsm.mjs:458–474 — an M4-class fold). RECOMMENDATION: the slug derivation for v1; the explicit field only if the alert counter (B9) proves awkward on the slug alone.
4. **The alert thresholds** N=3 turns / X=15 min (§2.6) — confirm or retune. The thresholds are conductor-config candidates (the specCapacity precedent — the B-1 knobs ride the spec), not hard constants, if the orchestrator prefers operator-tunable.
5. **The real lane's dead slug** (`deepseek-v4-flash-0731:free`, 404 upstream — probe §1b): a one-line `REAL_MODEL_CHAIN_DEFAULTS` fix. Fold into this build or dispatch separately? RECOMMENDATION: separately (different lane, different eval evidence — the s19 real-lane chain verdict would want a re-probe of candidates first).
6. **The 3-key pool future posture:** with a 3-key pool the budget of 3 exhausts on the three keys' primaries before any tail — the rule as designed fires only on the LAST key. If the fleet grows to 3 funded keys, either the budget grows to 4 or the rule generalizes to "the final attempt slot is ALWAYS the tail". Decide when that posture is real (today it is 2 keys).

---

*Probes: `s23-cctail-probe.py` / `s23-cctail-probe2.py` (+ result JSONs) in /home/z/my-project/scripts/ — 45 relay calls, $0 model spend, region-cycled. Design agent: 23-cctail, branch t46/s23-cctail.*
