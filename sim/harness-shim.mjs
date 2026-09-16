// harness-shim.mjs — the DETERMINISTIC CONTRACT IMPLEMENTER (T46 §1b).
//
// The shim implements the SAME work-harness surface the CC adapter
// implements (worker/cc-adapter.mjs, W4): consume a turn envelope, produce a
// contract return. It is the conformance reference — C3 folded here per D1:
// the multi-harness proof is "shim and adapter pass the SAME behavior
// matrix", so the matrix lives in THIS file and W4's worker/conformance-cc.mjs
// + sim/run-sim3.mjs drive against it (F-M7's spawn-boundary conformance
// groundwork: the adapter wave asserts argv+env at the spawn level for the
// SAME behaviors this table defines).
//
// DETERMINISM LAW (the conformance suite's foundation): the return is a pure
// function of (envelope, behavior, seed, opts). No clock, no Math.random, no
// I/O. SAME (behavior, seed) against the SAME envelope → a byte-identical
// return (pinned by test: JSON.stringify equality). All randomness flows
// from the seeded mulberry32 (the same rng sim/gha-shim.mjs exports — ONE
// implementation in the repo), consumed in a FIXED order per behavior path.
//
// THE CONTRACT RETURN:
//   {status, artifact_refs, summary, telemetry}
//     status        one of classifyOutcome's five classes (done | work_failed
//                   | infra_failed | deadline | poison) — with ONE sanctioned
//                   exception: the 'hang' marker (below).
//     artifact_refs paths the harness "wrote" — legal tasks/<id>/... paths,
//                   plus (wb-violation) ILLEGAL paths the write-back door
//                   must flag. Consumers run writeBackDoor on these before
//                   trusting a done.
//     summary       human text (the worker maps it to outcome.artifact for
//                   done reports — the one-line result).
//     telemetry     {turns, wall_ms, lane_attempts_used} — the turn's
//                   self-measured budget consumption. wall_ms is SIMULATED
//                   wall time: the mock-lane worker sleeps min(wall_ms, the
//                   F-G(a) TTL cap) to reproduce the live timing classes
//                   (slow → late report → stale-lease orphan; hang → silent).
//   Optional extra keys (behavior control-plane, documented per behavior):
//     detail        the failure text (present on non-done / deadline shapes;
//                   classifyOutcome's passthrough carries it to the report
//                   as the journal error).
//     repeat_report true for 'dup-report' — the caller enqueues the SAME
//                   report payload (same event_id) twice; the conductor's
//                   drain must dedup the second.
//
// THE 'hang' MARKER (the one status OUTSIDE the five classes, on purpose):
// a real hang never returns, so the shim cannot be both deterministic AND
// literally hanging. opts.deadlineEnforced (default false) selects the
// caller's side of the contract:
//   false (the worker's mock lane, live semantics preserved) → the marker
//     {status:'hang'}: the caller reports NOTHING, exits 0 — the lease
//     deadline is the handler (exactly the legacy mock 'hang'/'no-report').
//   true (a wall-enforcing harness — the W4 adapter kills its process group
//     at the wall) → the same turn returns status 'deadline'
//     ('wall-budget-exceeded') — the self-reported reaper.
// Callers must handle the marker BEFORE classification: classifyOutcome
// would mis-map the literal 'hang' to poison 'unknown-status' (it is not an
// anomaly, it is the designed silent class).
//
// BEHAVIORS (the seeded contract set):
//   fast          done, quick — the happy path.
//   slow          done, but wall_ms exceeds the envelope's window — the
//                 late-report / stale-lease-orphan class.
//   poison        work_failed EVERY attempt (the CONTRACT's work_failed, not
//                 the legacy 'failed' string — the FSM receiver aliases
//                 them, the audit trail records the new vocabulary). The
//                 ladder burns, then parks.
//   infra-flaky   infra_failed on attempt 1 (all lane attempts burned), done
//                 on attempt 2+ — the lane-rotate shape (net-zero retry in
//                 the FSM, the next assignment lands on a rotated lane).
//   deadline      status 'deadline', self-reported at the wall budget — the
//                 reaper-equivalent (attempt-burn + lease release without
//                 waiting for the clock pass).
//   hang          never returns — see the marker contract above.
//   dup-report    done + repeat_report:true — the same report twice.
//   wb-violation  done + artifact_refs including .github/workflows/evil.yml
//                 (dotgit — ALWAYS denied) and a root file (not declared) —
//                 writeBackDoor MUST flag both when the caller runs it; the
//                 governing caller reports the poison class.
//
// LEGACY VOCABULARY (live semantics preserved — the mock lane's task records
// carry these behavior names, so shimInvoke accepts them as aliases):
//   succeed→fast  flaky→work_failed@1,done@2+  fail→work_failed  poison→poison
//   infra→infra-flaky  slow→slow  hang/no-report→hang  dup→dup-report
//   unknown→work_failed 'unknown-behavior(...)' (the legacy mock's answer —
//   a typo'd behavior burns the ladder visibly; it is not an anomaly).

import { mulberry32 } from './gha-shim.mjs';

export { mulberry32 };

// The seeded contract set + the legacy aliases (the worker passes CP.behavior
// through; both vocabularies flow).
export const SHIM_BEHAVIORS = ['fast', 'slow', 'poison', 'infra-flaky', 'deadline', 'hang', 'dup-report', 'wb-violation'];
export const LEGACY_BEHAVIORS = ['succeed', 'flaky', 'fail', 'no-report', 'infra', 'dup'];

// seedFromRunId — the worker's seed derivation: FNV-1a 32 over
// `<runId>:a<attempt>`. The SAME run re-executed mints the SAME seed (a
// re-run is byte-reproducible); every new run mints a fresh one.
export function seedFromRunId(runId, attempt) {
  const s = `${runId ?? 'local'}:a${attempt ?? '1'}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const hex4 = (rng) => Math.floor(rng() * 0x10000).toString(16).padStart(4, '0');
const intIn = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo));   // [lo, hi)

// ---------------------------------------------------------------------------
// shimInvoke(envelope, behavior, seed, opts) — the contract turn.
//
//   envelope  the OK envelope from envelopeFromDispatch (task_ref.id used for
//             artifact paths, attempt for attempt-keyed behaviors, budget
//             for the wall/turn/lane figures). Lenient reads with the
//             contract defaults — but a missing task_ref.id is a caller bug
//             and THROWS (loud, never a silent wrong-task artifact path).
//   behavior  one of SHIM_BEHAVIORS or the legacy vocabulary (above).
//   seed      uint32 — the entire RNG input.
//   opts      {workMs?          the intended work duration (the live mock
//                              lane's work_ms; default per-behavior),
//             deadlineEnforced? the 'hang' dual-return switch (above)}
// ---------------------------------------------------------------------------

export function shimInvoke(envelope, behavior = 'fast', seed = 0, opts = {}) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`shimInvoke: envelope must be the ok-envelope object from envelopeFromDispatch (got ${envelope === null ? 'null' : typeof envelope})`);
  }
  const taskId = envelope.task_ref?.id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error(`shimInvoke: envelope.task_ref.id must be a non-empty string (got ${JSON.stringify(taskId)}) — the artifact namespace depends on it`);
  }
  const attempt = Number.isInteger(envelope.attempt) && envelope.attempt >= 1 ? envelope.attempt : 1;
  const budget = {
    max_turns: Number.isInteger(envelope.budget?.max_turns) && envelope.budget.max_turns >= 1 ? envelope.budget.max_turns : 40,
    wall_ms: Number.isFinite(envelope.budget?.wall_ms) ? envelope.budget.wall_ms : 60_000,
    lane_attempts: Number.isInteger(envelope.budget?.lane_attempts) && envelope.budget.lane_attempts >= 1 ? envelope.budget.lane_attempts : 3,
  };
  const workMs = Number.isFinite(opts.workMs) ? opts.workMs : null;
  const rng = mulberry32(seed >>> 0);
  const taskPath = (p) => `tasks/${taskId}/${p}`;

  // the shared done shape (rng consumed in FIXED order per behavior — the
  // determinism law)
  const doneTurn = (name, wall, turns) => ({
    status: 'done',
    artifact_refs: [taskPath(`artifacts/out-${hex4(rng)}.md`)],
    summary: `shim(${name}): completed task ${taskId} attempt ${attempt}`,
    telemetry: { turns, wall_ms: wall, lane_attempts_used: 1 },
  });

  switch (behavior) {
    // ----- the seeded contract set -----------------------------------------

    case 'fast':
      return doneTurn('fast', workMs ?? 5000, Math.max(1, Math.min(budget.max_turns, intIn(rng, 1, 4))));

    case 'slow': {
      // done, but PAST the envelope's window: max(the legacy 30-min work,
      // budget + 60s + jitter) — the caller's capped sleep makes the report
      // land late (stale-lease orphan) exactly like the live mock 'slow'.
      const wall = Math.max(workMs ?? 1_800_000, budget.wall_ms + 60_000 + intIn(rng, 0, 60_000));
      const r = doneTurn('slow', wall, Math.max(1, Math.min(budget.max_turns, intIn(rng, 3, 8))));
      r.summary = `shim(slow): completed task ${taskId} attempt ${attempt} AFTER the window (wall ${wall}ms > budget ${budget.wall_ms}ms — the late-report class)`;
      return r;
    }

    case 'poison':
      return {
        status: 'work_failed',
        detail: 'poison-always',
        artifact_refs: [],
        summary: `shim(poison): task ${taskId} attempt ${attempt} produced an unusable result (work_failed on EVERY attempt — the ladder burns, then parks)`,
        telemetry: { turns: intIn(rng, 1, 3), wall_ms: Math.min(workMs ?? 2000, 2000), lane_attempts_used: 1 },
      };

    case 'infra-flaky':
      if (attempt <= 1) {
        return {
          status: 'infra_failed',
          detail: 'lane-429',
          artifact_refs: [],
          summary: `shim(infra-flaky): lane unavailable for task ${taskId} attempt ${attempt} (all ${budget.lane_attempts} lane attempts burned — net-zero retry, the lane rotates)`,
          telemetry: { turns: 1, wall_ms: Math.min(workMs ?? 1000, 1000), lane_attempts_used: budget.lane_attempts },
        };
      }
      return doneTurn('infra-flaky', workMs ?? 5000, intIn(rng, 1, 3));

    case 'deadline': {
      const wall = budget.wall_ms + 1 + intIn(rng, 0, 60_000);
      return {
        status: 'deadline',
        detail: 'wall-budget-exceeded',
        artifact_refs: [],
        summary: `shim(deadline): task ${taskId} attempt ${attempt} hit the wall budget (${budget.wall_ms}ms) — SELF-REPORTED (the reaper equivalent: attempt-burn + lease release now, not at the clock pass)`,
        telemetry: { turns: budget.max_turns, wall_ms: wall, lane_attempts_used: 1 },
      };
    }

    case 'hang':
      if (opts.deadlineEnforced) {
        // the wall-enforcing caller (the W4 adapter's process-group kill):
        // the same turn reports deadline instead of hanging
        const wall = budget.wall_ms + 1 + intIn(rng, 0, 60_000);
        return {
          status: 'deadline',
          detail: 'wall-budget-exceeded',
          artifact_refs: [],
          summary: `shim(hang): task ${taskId} attempt ${attempt} exceeded the wall budget (${budget.wall_ms}ms) under an enforcing harness — reported deadline`,
          telemetry: { turns: budget.max_turns, wall_ms: wall, lane_attempts_used: 1 },
        };
      }
      // the marker: the caller reports NOTHING (the lease deadline is the
      // handler) — see the header contract before feeding returns to
      // classifyOutcome
      return {
        status: 'hang',
        detail: 'hang-by-design',
        artifact_refs: [],
        summary: `shim(hang): task ${taskId} attempt ${attempt} NEVER returns (simulated) — the caller's hang contract: no report, exit 0, the lease deadline is the handler`,
        telemetry: { turns: 0, wall_ms: 86_400_000, lane_attempts_used: 1 },
      };

    case 'dup-report': {
      const r = doneTurn('dup-report', workMs ?? 5000, 1);
      r.summary = `shim(dup-report): task ${taskId} attempt ${attempt} completed — the report is delivered TWICE (same event_id; the drain must dedup)`;
      r.repeat_report = true;
      return r;
    }

    case 'wb-violation': {
      const suffix = hex4(rng);
      return {
        status: 'done',
        artifact_refs: [
          taskPath('out/report.md'),                 // legal: the task namespace
          taskPath(`out/data-${suffix}.json`),       // legal: the task namespace
          '.github/workflows/evil.yml',              // ILLEGAL: dotgit — denied ALWAYS, declaring does not unlock
          'evil.txt',                                // ILLEGAL: root file, not declared in allowRoot
        ],
        summary: `shim(wb-violation): task ${taskId} attempt ${attempt} "completed" with artifact paths OUTSIDE the task namespace — writeBackDoor must flag them (the governing caller reports poison)`,
        telemetry: { turns: 2, wall_ms: workMs ?? 5000, lane_attempts_used: 1 },
      };
    }

    // ----- the legacy vocabulary (live mock-lane semantics preserved) ------

    case 'succeed':
      return doneTurn('fast', workMs ?? 5000, Math.max(1, Math.min(budget.max_turns, intIn(rng, 1, 4))));

    case 'flaky':
      if (attempt < 2) {
        return {
          status: 'work_failed',
          detail: 'flaky-fail-1',
          artifact_refs: [],
          summary: `shim(flaky): task ${taskId} attempt ${attempt} failed (succeeds from attempt 2)`,
          telemetry: { turns: 1, wall_ms: Math.min(workMs ?? 2000, 2000), lane_attempts_used: 1 },
        };
      }
      return doneTurn('flaky', workMs ?? 5000, Math.max(1, Math.min(budget.max_turns, intIn(rng, 1, 4))));

    case 'fail':
      return {
        status: 'work_failed',
        detail: 'explicit-fail',
        artifact_refs: [],
        summary: `shim(fail): task ${taskId} attempt ${attempt} failed explicitly`,
        telemetry: { turns: 1, wall_ms: Math.min(workMs ?? 2000, 2000), lane_attempts_used: 1 },
      };

    case 'no-report':
      return shimInvoke(envelope, 'hang', seed, opts);   // the silent class

    case 'infra':
      return shimInvoke(envelope, 'infra-flaky', seed, opts);

    case 'dup':
      return shimInvoke(envelope, 'dup-report', seed, opts);

    default:
      // the legacy mock's answer to a typo'd behavior: WORK class — the
      // ladder burns visibly; it is not an anomaly (poison) class
      return {
        status: 'work_failed',
        detail: `unknown-behavior(${behavior})`,
        artifact_refs: [],
        summary: `shim: unknown behavior ${JSON.stringify(behavior)} on task ${taskId} attempt ${attempt}`,
        telemetry: { turns: 0, wall_ms: 100, lane_attempts_used: 1 },
      };
  }
}
