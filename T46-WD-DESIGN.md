# T46/W-D — the model + key-pool + telemetry fold (design v1, session 19)

**Why now:** session 19's per-task model evals (real + cc lanes), the 82-key pool
rebuild (73 alive, ~7,550 free-lane req/day aggregate), and the logging-gap audit
(6 ranked gaps) landed the data. This fold converts them into worker-plane changes.
Full eval data: `cc-gha-exploration/context/OPENROUTER-KEYS.md` §S19 + the JSONL
artifacts listed there. Design status: v1 — needs the standard 2-lens review round
before build. Nothing here touches conductor/intake/ops (worker plane only).

## D1 — the real-lane model chain + the max_tokens landmine (P0)

The production shape (`realWork`, worker/turn.mjs:134) sends `max_tokens: 64`.
Every reasoning-style model returns `content: null` at 64 (reasoning eats the
budget — dots-studio: **0% content@64**, deepseek-v4-flash 41%, glm-5.3-flash
8-16%) → `work_failed 'empty-completion'` → retry/quarantine churn that LOOKS like
model failure but is a budget artifact.

Changes:
1. `max_tokens: 64` → `512` in realWork (measured: 100% content on the new chain
   at 500+; the extra tokens cost nothing on free models and ~$0.0001 on paid).
2. `REAL_MODEL_CHAIN_DEFAULTS` → `['nvidia/nemotron-3.5-lightning:free',
   'deepseek/deepseek-v4-flash-0731:free', 'cohere/north-mini-code:free']`
   (dots-studio demoted OUT — 0% content at the production shape; nemotron-3-ultra
   demoted to never — p95 32s + 30s burst walls, the exact upstream-rate-limit
   "long container wait" class the principal flagged).
3. Pin both chains in `tests/` (chain content + max_tokens — the seam, not just
   the pure function).

## D2 — the cc-lane model head (P0, vars-only first)

Eval verdict: `deepseek/deepseek-v4.1-flash` PRIMARY (20.6s turn, 4/4 calls,
p50 5.6s, flawless content), `z-ai/glm-5.3-flash` FALLBACK (provider diversity;
154.7s turn with 1 upstream 500 absorbed). Both need the paid key (or-074,
$9.32 ≈ 700+ turns at the measured $0.0126/turn).

Deploy order (NO code change for the first step):
1. Repo var `CC_MODEL=deepseek/deepseek-v4.1-flash` + secret
   `OPENROUTER_API_KEY` = the or-074 paid key (the chain head env-slot already
   exists — worker.yml reads `vars.CC_MODEL`).
2. Secret `OPENROUTER_API_KEY_2` = ansgauretychis-B (free-lane 1000/day, the
   degraded-mode fallback lane).
3. Code (this fold): `CC_MODEL_CHAIN_DEFAULTS` → `['deepseek/deepseek-v4.1-flash',
   'z-ai/glm-5.3-flash', 'nvidia/nemotron-3.5-lightning:free']` so the default
   matches the eval even without vars.

NEVER: `deepseek-v4-flash-0731:free` on the cc lane (hallucinated the eval task —
silent content-poison, measured live).

## D3 — the OR key pool (the 73-key rotation, P1)

Goal: spread the free-lane daily budget across accounts (71 × 50/day + 3 ×
1000/day) instead of one key's 1000/day.

Design:
- New secret `OPENROUTER_KEY_POOL` = comma-joined keys (registry order, free-tier
  + free-lane-capable only; paid key stays on OPENROUTER_API_KEY).
- Worker picks `pool[hash(task_ref.id) % pool.length]` — deterministic per task
  (idempotent re-dispatches reuse the same key), spreads load across accounts.
- The 429 `free-models-per-day` class on a pool key → the EXISTING infra-retry
  ladder already rotates the MODEL; a same-model retry would reuse the same key
  (hash-stable) — acceptable: the retry budget (2) bounds it, and the NEXT task
  lands on a different key. (A key-rotating variant is a v2 if burn concentrates.)
- The pool file lives in the PRIVATE cc-gha-exploration registry
  (`context/openrouter-pool.json`) — the SECRET carries only the values.
- TOS/IP note: worker calls originate from ephemeral GH runner IPs (already
  per-job-rotated, GitHub-wide shared — no single-IP multi-accounting signal);
  sandbox-side calls go through the supabase relay (the s19 shape, kept).

## D4 — the telemetry fold (P1 — the "extensive logging" ask)

The 19-b audit's gaps, folded (all worker-plane, no conductor contract changes
beyond the record's OPTIONAL fields — old records must keep applying):

- **G4+G2 (tokens/cost/429 tally):** `cc-bridge.mjs` already sees every response
  and every status — it gains a per-turn counter object `{calls, ok, err429,
  err5xx, tokens_in, tokens_out, cost, first_token_ms[], ratelimit_classes[]}`
  (SSE `usage` frames included; `x-ratelimit-*` + 429 `limit_source` parsed —
  G3). The adapter reads the bridge's final stat (the shutdown handshake or a
  GET /stats endpoint on the bridge) and puts it on the worker record as
  `lane_stats`.
- **G1 (drain drop):** `fsm.mjs applyEvent` passes the queue line's
  `lane_stats`/`models`/`key_index` into the task record's `last_result`
  (OPTIONAL fields — fixtures without them keep applying).
- **G5 (real-lane per-hop latency):** realWork's hop loop records per-model
  `{model, ms, status}` (it already tracks `models[]` — add the ms/status).
- **G6 (durable diagnostics):** the adapter's `CC-LANE-EXIT` line (rc/model/
  api_error_status) lands in the worker record's `detail` on infra outcomes.
- **Console (ops/console.mjs):** `status` gains a LANE section off
  `store.readJournalTail` + `last_result.lane_stats`: per-model call counts,
  429 tallies, p50/p95 latency, tokens, cost, key-pool spread — the operator's
  one-screen health view (the existing seam, zero new plumbing).

Pins: bridge stat extraction (feed a canned SSE stream), drain pass-through
(record survival through applyEvent — the prCandidates-drop lesson), console
rendering (shape pin), realWork per-hop (fixture).

## D5 — explicitly deferred (not this fold)

- Worker-plane relay egress (GH runners already rotate IPs; revisit only if
  OpenRouter ever fingerprints the GitHub ASN as a class).
- mcp-web's Netlify tier upgrade to the kit's 64-deploy fleet (separate lane —
  the kit is at Round 10, mcp-web still single-deploy; tracked in PLAN).
- agentrunners WORKER_REPO dispatch routing (W-C3-adjacent, next session).

## Build + review order

1. D1+D2 vars deploy (immediate, operator-lane — no code, no review needed).
2. D1+D2 code + pins → branch `t46/wd-a` (small, self-contained).
3. D4 bridge/stat + drain + console → branch `t46/wd-b` (the bulk).
4. D3 pool rotation → branch `t46/wd-c` (secret + worker pick + pins).
5. 2-lens adversarial review over the three branches (the discipline), fold,
   merge in a quiescent window, live re-probe (one mock epoch + one cc epoch),
   EVIDENCE.md entry.

---

## v2 FOLD (session 19, the 19-c review — 1 BLOCKING + 6 MAJOR folded; report: cc-gha-exploration-side /home/z/lab-s19-wd-review.md)

- **B1 (pool env path):** D3 REQUIRES a `worker.yml` env line — `OPENROUTER_KEY_POOL: ${{ secrets.OPENROUTER_KEY_POOL || '' }}` in the "Work the task" env block (lane C owns it; the secrets-free contract of the OTHER workflows is untouched — worker.yml already carries secrets).
- **M1 (unreachable degraded fallback):** honest scope-cut — the paid-key head + free fallback chain is reached only when `budget.lane_attempts` covers it; the conductor envelope pins lane_attempts (3). D2-code keeps the chain order; the DEGRADED-mode note becomes: free fallbacks engage only if the envelope's lane budget allows ≥2 hops (config-dependent), documented, not claimed.
- **M2 (bridge stat lifecycle):** REPLACED — no shutdown handshake, no in-memory stat. The bridge appends one JSONL line per upstream call to `<workdir>/bridge-lane.jsonl` (append-only fs write per request — survives the adapter's SIGKILL of the bridge). The adapter reads the file post-turn and aggregates into `lane_stats` on the worker record. The per-call lines are ALSO the raw 429/latency/cost signal store (G2/G3/G4 satisfied at the source).
- **M3 (journal durability):** the drain pass-through journals `lane_stats` (optional field) on the REPORT queue line AND the journal record — `fsm.mjs applyEvent` + the store's queue-line projection both carry it (old records without it keep applying).
- **M4 (composeReportOutcome allowlist):** `lane_stats` + `key_index` join the allowlist in `conductor/turn.mjs` composeReportOutcome — the first named drop point; without it nothing reaches the queue line.
- **M5 (quota-class key rotation):** on an infra retry whose detail is quota-class, the pool index ADVANCES: `key_index = (hash(task_id) + infra_attempt) % pool.length` — a burned key's retry lands on the NEXT key (bounded rotation; idempotency preserved per attempt, rotation across attempts). This kills the daily-terminal-quarantine failure mode the review flagged.
- **M6 (child-env leak):** `OPENROUTER_KEY_POOL` joins the adapter's `CC_ENV_DENYLIST` (the CLI child env must never see the 73 keys — the existing leak-prevention seam).

MINOR folds: capacity arithmetic reconciled (~7,550 free-lane/day = 71×50 + 3×1000, paid lanes excluded); D1 line-cite corrected (realWork payload at turn.mjs:143); D3's hash scope = task_ref.id string; the console window is 64 journal records (documented limit); the real lane REPORTS its key_index (drain carries it per M4).

Lane map (updated): A ✅ BUILT (t46/wd-a @ 4a09f68, 413/413). B = D4 with M2/M3/M4 amendments (bridge JSONL + adapter aggregation + allowlist + drain + console). C = D3 with B1/M5/M6 amendments (workflow env line + hash+attempt rotation + denylist + pins). Integration also folds the pre-existing conformance-cc acceptEdits argv drift (25/26 on main — 1-line fix, 19-d's handoff).
