# S21 Audit 21-a8 — LENS: the model-eval BENCH v3 (drop injection, add in-house facets)

Repo audited read-only: `/home/z/cc-gha-exploration` @ `329a28d` (worktree clean, no commits, no pushes).
Binding directive honored: the adversarial prompt-injection facet (s20 S5) is **DROPPED** from the bench —
friendly in-house system, no adversarial-safety facets proposed anywhere below.

---

## §1 Files audited

| file | lines | role |
|---|---|---|
| `scripts/s20/s20_common.py` | 102 | shared substrate: relay transport, key pool, egress JSONL |
| `scripts/s20/s20_instr.py` | 121 | instruction-tuning matrix (V0/V1/V2 × mt512/1536 × effort) |
| `scripts/s20/s20-cache-cost.py` | 226 | cached-cost study (10-turn sessions, pinned/rotated regions, 2 surfaces) |
| `scripts/s20/s20_stress.py` | 239 | stress battery v1 (needle/conflict/grounded/tool-seq/injection) |
| `scripts/s20/s20_stress2.py` | 145 | battery v2 (effort arms, re-adjudicated tool-seq, resume-set) |
| `scripts/s20/s20_deploy.py` | 69 | one-off GH vars/secrets deploy (out of bench runtime scope) |
| `context/OPENROUTER-KEYS.md` §S19+§S20 | 240–321 | the verdicts the v3 routing refresh rides on |
| `context/openrouter-pool.json` | 82 keys | registry (68 free+alive; 2 paid) |
| results: `experiments/s20/*.jsonl` + `/home/z/my-project/scripts/s20-*.jsonl` | 193 recs | durable + working copies (verified byte-identical source) |
| `/home/z/agent-fetch-kit/.env` | — | SUPABASE_PROXY_URL/TOKEN (relay egress, used by smoke) |

## §2 Findings table (the s20 bench vs the production-grade yardstick — criteria 4/5/6 primarily)

| ID | sev | file:line | gap vs yardstick | remedy | eff |
|---|---|---|---|---|---|
| B1 | MAJOR | `s20_instr.py:104-105` | Epilogue `open(OUT,'w')` + `for r in results[:0]` **truncates the results JSONL to zero at end-of-run** (body would also NameError on `rec` if reachable). On-disk file survived only as 39/70 cells via post-truncation re-appends — the §S20 instr verdicts rest on console prints, not the damaged file. Criteria-6 fail: a bench that destroys its own durable evidence. | Append-only + resume-set (stress2's `done_set` pattern) as the ONLY write mode; never `'w'` on a results path. | S |
| B2 | MAJOR | `s20_common.py:48-72` (transport), all scripts | **No budget enforcement** (criteria 5): no cost ledger, no cap, no dry-run — s20 spent ~$0.60 unsupervised on or-074 ($9.30→$8.7); a fat-fingered facet matrix would drain the remaining ~$9 silently. | Harness-level spend ledger per run + `--cap-usd` hard abort + pre-flight dry-run that prices the cell set from manifest pricing. | S |
| B3 | MAJOR | `s20_common.py:27-28` + `s20_{instr,stress,stress2,cache-cost}.py` model blocks | **Key/model identity hardcoded in code, registry drifted**: or-074 selected by prefix `sk-or-v1-86578` in code; or-075 is `status:'alive'` in `openrouter-pool.json` but DRAINED $10/$10.0004 (OPENROUTER-KEYS.md:289). Model list + tuning (glm effort-low) duplicated across 4 scripts; tuning knowledge exists only as prose in §S20.2. Adding a candidate model = editing 4 files. | `manifest.yaml`: models, tier, tuning arm, pricing, pass bars; registry refresh (or-075 → drained) so selection = registry query, not prefix hacks. | M |
| B4 | MINOR | all 4 scripts' record shapes | **No unified results schema / run-id / grader version** — every script invents its record keys (stress: model/test/grade; instr: variant/arm/judge; cache: label/surface/turn). No compare command exists; runs are eyeball-diffed (criteria-6 repeatability fail). | One record schema `{runid, facet, cell, model, arm, key6, status, ms, usage{pt,ct,cached,cost}, grade, pass, grader_v}` + `compare.py`. | M |
| B5 | MINOR | `s20_stress2.py:112-117`, `s20-cache-cost.py:149-150` | **Ad-hoc retry, silent cell loss**: stress2 hand-rolls 2 retries (sleep 4/6); cache-cost sleeps 3s on non-200 and CONTINUES — a 500 = a silently missing cell (criteria-2 fail inside the bench itself). My smoke reproduced this: nemotron 500 on 1/3 F6 reps. | Transport-level retry ladder (429/5xx, ≤2 attempts, jittered) with per-cell outcome classification recorded. | S |
| B6 | MINOR | `s20_common.py:42-46` | **No cross-run key ledger**: free keys round-robined per-process only; no per-key 50/day quota arithmetic (criteria 4) and no dead-key memory across runs (same class as worker-lens W3). | `key-status.json` sidecar updated per run; skip keys with known-402/401 until date rollover. | S |
| B7 | MINOR | `s20_stress.py:142-149,135,161-180` | **Grader portability/determinism debt**: conflict grader counts "unable" anywhere as a flag (false-positive prone); needle grader's double `split(' is ')` is dead code; the v1→v2 tool-seq adjudication (single `queue_peek` = correct dependent-wait) lives only in the worklog — a future grader author would re-ship the wrong v1 grader. Pass bars never defined in code; routing was human post-hoc. | Graders versioned per facet + pass bars in the manifest + the adjudication note in the facet docstring. | S |
| B8 | NICE | `s20-cache-cost.py:125`; consumers' `sys.path.insert` | Dead ternary `region or 'ROTATE' if False else region`; every consumer imports s20_common from `/home/z/my-project/scripts`, so the repo copy is a durable MIRROR not the runtime import path — substrate must be rebuilt per sandbox (worklog 20-main confirms). | Package-relative import or `pip install -e`; delete the dead ternary. | S |
| B9 | NICE | `s20_common.py:9,92-96` | Single global egress log interleaves all runs, no run-id correlation. | runid field in every log_call record (my smoke already does this). | S |

## §3 The 3 findings that most block production-grade (of the bench as a product)

1. **B1 — self-truncating results** (evidence destruction): a bench whose artifact can be zeroed by its own
   epilogue cannot back any verdict durably. Cheapest fix, lands first.
2. **B2 — no budget ceiling** (economics): the paid key is a ~$9 finite resource shared with the LIVE CC lane;
   an uncapped bench run competes with production turns for the same or-074 balance.
3. **B3 — manifest absence + registry drift** (capacity/operability): model/key/tuning knowledge smeared across
   4 scripts and a prose file, with the drained key still marked alive in the registry — every re-run re-encodes
   stale state. This is what makes the bench one-off instead of re-runnable.

## §4 Already production-grade (honest inventory — kept as the v3 substrate)

- **Relay-only egress, structurally guaranteed**: `relay_post`/`relay_get` are the only transports in
  `scripts/s20/*`; a grep for `openrouter.ai` outside the two URL constants returns nothing. TOS-safe by
  construction (criteria 8) — keep as a hard rule + a lint gate in v3.
- **Key masking at rest** (`key6`) in every record; keys never printed in full.
- **Thread-safe region + free-key rotation** (locks at `s20_common.py:32-46`), 16-region spread.
- **Resume-safe append pattern** (`s20_stress2.py:86-93,104-106`) — the seed of the v3 cell-dedup.
- **Deterministic graders where they matter**: needle recall+order, grounded exact-substring hits +
  fabrication count, tool-seq v2 behavior classes — all pure functions, replayable offline.
- **Durable evidence discipline**: raw JSONLs pushed to `experiments/s20/` in-repo (criteria-3 style telemetry:
  `s20-egress-log.jsonl` per call, 151 records).
- **Cost telemetry on every record** (usage.cost + tokens + cached_tokens) — the economics raw material exists;
  only the ceiling/aggregation is missing.

---

# THE BENCH v3 DESIGN

## §5 Facet set v3 (8 facets — 5 kept from s20 minus injection, 3 new; all in-house-relevant)

**Dropped: s20 S5 injection** (principal's binding directive — friendly in-house system; the facet bought no
routing signal for any in-house job class).

### F1 — needle-in-haystack at spread depths (kept; s20 S1 evolved)
- **Cells**: v3a = 5 `[NOTE]` facts at 10/30/50/70/90% depth in ~50KB filler (real-lane scale);
  v3b = same 5 at ~120KB (~30K tokens, CC-lane context scale).
- **Prompt**: s20 `build_s1` verbatim — "list each one verbatim, one per line, in the order they appear. Then stop."
- **Grader** (deterministic): substring recall per fact (5 pts) + order-ascending check (1 pt); record WHICH
  depth was missed (per-depth recall — the diagnostic the s20 aggregate lost).
- **Params**: mt1536; glm arm effort-low.
- **Pass bar**: CC-lane candidates ≥4/5 recall AND order; real-lane candidates ≥3/5. s20 baseline: ds 1.0,
  glm 1.0, nem 0.8 (4/5 unordered), dsf-0731 0.0 → the 0731 exclusion stays pinned by this facet.

### F2 — instruction-conflict flagging (kept; s20 S2 evolved to 3 cells)
- **Cells**: (a) word-count-vs-12-fields (s20 S2 verbatim, incl. the optional crab);
  (b) numeric impossibility — genesisSpec-shaped: "lease_minutes: 9" + "the task runs three 5-min phases";
  (c) dependency cycle — 4-step plan where C depends on A which depends on C.
- **Grader** (deterministic + adjudication column): flags = names BOTH conflicting requirement labels/values
  AND contains a conflict keyword (cannot/contradict/impossible/incompatible/tension/unable); bare keyword
  without both references = 0.5; crab = 0.25 bonus (optional-instruction-following signal).
- **Pass bar**: adjudication-role candidates flag ≥2/3 cells fully; worker-role candidates ≥1/3 (a worker may
  pick a side, but must notice SOMETHING at least once). s20 baseline: nem 3.0 (the only flagger), ds 0
  (silent B-over-A), glm 0.5.

### F3 — grounded exact-figure digest (kept; the poison detector)
- **Cells**: (a) s20 `build_s3` verbatim (8 telemetry lines, 6 graded figures, "use each number verbatim, do
  not compute"); (b) distractor pair cell — two near-identical fields (`lane 429s: 214` vs `lane 403s: 96`)
  where only one is asked for, plus one arithmetic trap ("total turns" is stated, must NOT be recomputed).
- **Grader** (deterministic): exact-substring hits per field + fabrication count = ≥2-digit numbers not in the
  source set. Score = hits/fields, hard-zeroed by any fabrication (poison = fail regardless of hits).
- **Pass bar**: 100% hits, 0 fabrications. s20 baseline: ds 6/6, glm 6/6, nem 1.0* (500-tax caveat).

### F4 — tool-sequencing dependent-call correctness (kept; v2 adjudication pinned)
- **Cells**: multi-round (the s20 single-round "correct-wait" shape extended): R1 tools = queue_peek/task_get/
  lease_take → correct answer is EXACTLY `[queue_peek]` (correct-wait; the s20 v1 grader bug is enshrined as
  a docstring warning); harness feeds the peek result naming `T-209`; R2 correct = `[task_get{"task_id":"T-209"}]`
  (args parsed from the observed result — not invented); R3 after the record shows `status: pending` →
  `[lease_take{"task_id":"T-209"}]`.
- **Grader** (deterministic): per round — call-set equality + JSON-arg equality against values sourced from
  prior tool results; behavior classes correct-wait / premature-batch / narrated-no-call / wrong-args.
- **Pass bar**: 3/3 rounds exact. s20 baseline (single-round): ds/glm/nem/dsf all 1.0 correct-wait — v3's
  3-round extension is the actual discriminator.

### F5 — multi-step plan decomposition quality (NEW; genesisSpec-shaped)
- **Cells**: (a) clean spec — a 6-unit job (read-state → analyze → {fix-a ∥ fix-b} → integrate → verify+report),
  dependencies explicit; (b) implied-prerequisite spec — same shape but read-before-write never stated, only
  inferable; both ask: "emit the task DAG as JSON: `{"tasks":[{"id","title","depends_on":[...],"lane_hint":"cc|real|human"}]}`".
- **Grader** (deterministic): JSON parse; unit coverage (keyword match per ground-truth unit, 6 pts);
  edge F1 = (TP−FP)/expected against the authored ground-truth DAG; parallelism detected (fix-a,fix-b as
  siblings, 1 pt); invented-task penalty. Ground truth authored once per cell, versioned in the manifest.
- **Pass bar**: units 6/6 AND edge-F1 ≥0.8 AND schema-valid. **No s20 baseline — this is the v3 discriminator
  for the spec-adjudication seat (expected: nem strong on flagging-shaped structure, ds on clean decomposition).**

### F6 — JSON-output discipline (NEW; the worker-contract shape)
- **Cells**: 10 reps of the worker door's contract: system = "Reply ONLY with compact JSON on one line:
  `{"summary":"<one line>","status":"done|blocked"}`", user = varied real task prompts (s19-real-prompts corpus,
  rotating); arms = plain-mt512 and effort-low-mt512.
- **Grader** (fully deterministic): `json.loads` OK; exact key set `{summary,status}`; status ∈ enum;
  single line; summary ≤120 chars (the real door's cap); no markdown fences; no surrounding prose.
- **Pass bar**: **10/10 schema-valid — 9/10 means one poisoned report at the machine-parsed door**; tolerance
  floor 0.9 with 0 hard-parse failures. Seeds: s20 V2 arm + **my smoke: nem 2/3 (one upstream 500 — capacity,
  not discipline), glm 3/3 parse with 1/3 len-violation (summary >120 chars — the cap needs prompt hardening
  or a truncation guard at the door).**

### F7 — long-conversation state retention (NEW; 10+ turn CC-shaped thread)
- **Cells** (3): the s20-cache-cost session generator as substrate — stable ~13K-token system block + 10
  user/assistant turns; at turn 3 plant a CONSTRAINT (cell A: a value — "the migration lock token is
  7f3a9c21, keep it for all later turns"; cell B: a node name; cell C: an output rule — "from now on, report
  the queue depth first"); at turn 10 the ask requires the turn-3 constraint (verbatim recall for A/B;
  format compliance — does the turn-10 answer lead with the queue depth — for C).
- **Grader** (deterministic): substring recall for A/B; prefix/format regex for C. Record cached_tokens per
  turn (feeds F8).
- **Pass bar**: 3/3 recall cells + ≥2/3 rule-compliance. **No s20 baseline — measures whether the CC lane's
  multi-call turns degrade constraints as the thread grows.**

### F8 — cached-cost steady-state (kept; the §S20 method verbatim)
- **Cells**: 10-turn agentic session, ~13K-token stable prefix, turns 1-5 region-pinned + 6-10 region-rotated,
  both surfaces (chat; anthropic + `cache_control`), per deployed CC-lane model.
- **Grader/metric** (measurement, not pass/fail): warm avg cost/turn, cache-engagement count, pinned-vs-rotated
  engagement delta, cold turn-1 cost. Regression flag: warm avg >2× the s20 baseline ($0.0005–0.001) or
  engagement <50%.
- **Budget rule**: ≤2 sessions × 10 turns per paid model per run.

### v3 cell-set arithmetic (full run, per the manifest)
F1 2 + F2 3 + F3 2 + F4 3 + F5 2 + F6 10 + F7 3 + F8 ~20 calls ≈ **45 calls/model**; paid-model full run ≈
**$0.05–0.15** (measured: my 4 paid calls = $0.00026). Free-model full run $0 + the 500-tax absorbed by retry.

## §6 Routing matrix refresh (§S20 verdicts + v3 facet set)

| job class | primary | fallback | evidence (facet → score) | tuning |
|---|---|---|---|---|
| CC turns (agentic coding) | deepseek-v4.1-flash | glm-5.3-flash | F1 1.0 / F3 1.0 / F4 1.0 / F8 ~$0.003-warm; latency 2-6s/call (§S19 cc eval) | none (bridge sends cache_control natively) |
| CC fallback / cold-heavy epochs | glm-5.3-flash | — | F8 9/10 engagement (most cache-robust), 40% cheaper cold, equal graded competence | `reasoning:{effort:low}` REQUIRED |
| Real-lane FSM one-liners | nemotron:free + 68-key pool | cohere north-mini-code:free (s19 3rd) | pass/fail regime — all passing models equivalent; $0; FSM ladder absorbs 500s (§S20.3, smoke 1/3 500s reproduced) | none |
| Spec adjudication / intake lens | nemotron (supervised, verbose-OK) | deepseek (conflict-silence caveat) | F2 3.0 (only flagger) / **F5 TBD — v3's new discriminator** | mt1536 |
| Digest / grounded summarize | deepseek-v4.1-flash | glm; nem on free budget | F3 6/6 zero fabrications (ds+glm); ds latency | effort-low |
| Code-gen on tasks/<id> branches | = CC lane row (deepseek→glm) | — | §S19 live CC turns: ds done 20.6s vs glm 154.7s | — |
| Worker-contract JSON emitters | per F6 v3 measurement — early signal: glm needs cap-hardening, nem clean-but-flaky, ds untested (next run) | | F6 | glm: effort-low |
| Long-thread ops summaries | per F7 v3 measurement (no baseline yet) | | F7 | — |

Hard exclusions carried forward: `deepseek-v4-flash-0731:free` (F1 0.0 + s19 poison), `dots-studio` old head
(0% content@64), qwen3.8/gemma-4/glm-5.2:free (429-dead upstream).
Dependency note: the deepseek→glm failover is only real once worker-lens **W1** (key-major flatten makes
KEY_2 unreachable) lands — the bench routing table assumes the fix; v3's F8 per-model cells keep the
fallback's tuning arm verified so the swap is evidence-backed.

## §7 Harness spec — `bench/` in cc-gha-exploration (Python; s20_common is the transport seed)

```
bench/
  manifest.yaml            # THE single source: models (id, tier, key-role, tuning arm, pricing),
                           #   facets (cells, params, pass bars, grader version), budget cap, baselines
  run.py                   # ONE command — see below
  transport.py             # the ONLY socket-opener: supabase relay from /home/z/agent-fetch-kit/.env
                           #   + retry ladder (429/5xx, ≤2, jittered) + spend ledger + key6 masking
  facets/f1_needle.py … f8_cache.py
                           #   each: build(cell) -> payload, grade(resp) -> {score, components}, DOCSTRING
                           #   carries the adjudication history (e.g. F4's v1-wrong/v2-right note)
  graders/common.py        # json-contract, dag-check, exact-figures, keyword-flag (shared, pure, versioned)
  results/runs/<runid>/results.jsonl        # append-only, one line per cell, resume-safe
  results/runs/<runid>/manifest.snapshot.json
  results/runs/<runid>/spend.json           # cost ledger; the cap ENFORCES here
  results/key-status.json                    # cross-run key ledger (dead-401/402, quota date)
  compare.py               # bench/compare.py RUN_A RUN_B -> markdown model×facet matrix + deltas + $/facet
```

**One command**: `python bench/run.py [--facets F1,F6] [--models ds,glm] [--arm effortlow] [--smoke]
[--dry-run] [--cap-usd 0.50] [--resume runid]`
- `--dry-run`: prints the priced cell plan (from manifest pricing), spends nothing.
- `--smoke`: the 3-cell plumbing probe (F3@ds paid, F6×3@nem free, F6×3@glm effort-low) — exactly my §8 cells.
- `--resume`: cell-dedup on `(runid, facet, cell, model, arm)` from results.jsonl (B1's cure, stress2's pattern).
- **Record schema (uniform, B4's cure)**: `{runid, facet, cell, model, arm, key6, status, ms, region,
  usage:{pt,ct,cached,cost}, grade, score, pass, grader_v, ts}`.
- **Budget (B2's cure)**: pre-flight price + runtime accumulator in spend.json; hard abort at cap
  (default $0.50 — criteria-5 ENFORCED, not advisory); per-facet per-model cost surfaces in compare.py.
- **Keys (B3/B6's cure)**: from `context/openrouter-pool.json` via manifest ROLES (`paid-primary` =
  tier:paid + registry status; `free-pool` = tier:free + alive) — zero key identity in code; registry gets
  or-075 → `drained` so the hack dies; `key-status.json` carries cross-run dead-key + quota-date memory.
- **Egress rule (kept from s20, now enforced)**: transport.py is the only module permitted to open a socket;
  validate gate = `grep -rn "openrouter.ai" bench/` matching only transport.py's two URL constants (TOS-safe,
  criteria-8 posture unchanged — verified this shape already holds in scripts/s20/*).
- **Grader discipline (B7's cure)**: every grader is a pure function with a version string; pass bars live in
  the manifest, not in prose; every ambiguous-adjudication cell (F2 conflict wording) keeps a `content_head`
  field for human audit — deterministic score + inspectable evidence.
- **Why Python not run.mjs**: the entire eval substrate (s20_common relay client, graders, corpus) is Python
  and live-proven through the relay; a Node rewrite would duplicate the transport for zero signal. The fsm-lab
  repo stays untouched — the bench lives in the eval repo (cc-gha-exploration) where experiments/s20/ already
  keeps the durable JSONLs.

## §8 Smoke results (3 cells, runid `s21a8-smoke`, relay egress only, $0.00026 total)

| cell | model | key | status | ms | grade | verdict |
|---|---|---|---|---|---|---|
| F3 grounded-telemetry | deepseek-v4.1-flash | or-074 | 200 | 2642 | 6/6 exact hits, 0 fabrications | **PASS** (poison-detector + paid relay + deterministic grader all live) |
| F6 json ×3 | nemotron:free | b8675b/cf20c6/007c08 (rotating) | 200/**500**/200 | 40643/30919/23154 | 2/3 perfect one-line JSON | plumbing PASS; the 500 = nemotron's known upstream tax (cell retriable via resume) — discipline itself clean |
| F6 json ×3 +effort-low | glm-5.3-flash | or-074 | 200×3 | 1549/2115/1504 | 3/3 parse, 2/3 full score (1 summary >120 chars) | effort-low arm + arm-plumbing verified; **first v3 datapoint: glm overruns the 120-char door cap ~1/3 reps** |

Egress: 7/7 calls logged to `s20-egress-log.jsonl` via `log_call` (runid-correlated);
results at `/home/z/my-project/scripts/s21a8-smoke-results.jsonl` (append-only, resume-set — the B1-cured
pattern); smoke script at `/home/z/my-project/scripts/s21a8_smoke.py` (repo untouched, read-only honored).

**Next actions**: (1) land B1+B2+B3 first (append-only, cap, manifest+registry refresh) — all S/M;
(2) build `bench/` per §7 with F3+F6 as the seeded facets (already smoke-proven), then F1/F2/F4 ports;
(3) author F5/F7 ground truths + graders; (4) first full v3 run (~$0.10) fills the two TBD routing rows
(F5 spec-adjudication, F7 long-thread) and re-pins the F6 worker-contract row.
