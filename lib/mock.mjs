// mock.mjs — the deterministic agent simulator (the worker's brain in mock
// mode). Behavior profiles map 1:1 to the failure matrix — this is how the
// lab stress-tests failure handling WITHOUT any LLM in the loop.
//
// Contract: mockWork(behavior, ctx) ->
//   { outcome: {status, ...}, sleepMs, extraReports: [...], repeatReport? }
// The worker workflow: sleep(sleepMs) -> report(outcome) -> [extraReports].
// ctx: { attempt, workMs, task, infraLeft } — infraLeft is the 'infra'
// behavior's flap budget (caller-decremented; see the F-F note in the case).

export function mockWork(behavior, ctx = {}) {
  const { attempt = 1, workMs = 5000 } = ctx;
  switch (behavior) {
    case 'succeed':
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:attempt${attempt}` }, sleepMs: workMs };
    case 'flaky':
      if (attempt < 2) return { outcome: { status: 'failed', error: 'flaky-fail-1' }, sleepMs: Math.min(workMs, 2000) };
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:attempt${attempt}` }, sleepMs: workMs };
    case 'poison':
      return { outcome: { status: 'failed', error: 'poison-always' }, sleepMs: Math.min(workMs, 2000) };
    case 'hang':
      // sleeps far past the job timeout — the runner kills us; no report
      // ever fires; the CONDUCTOR's lease deadline is the handler.
      return { outcome: null, sleepMs: 24 * 3600 * 1000 };
    case 'slow':
      // succeeds but after the lease expires — an ORPHANED report (rejected
      // as stale; the work is wasted and counted in stats.orphaned_reports).
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:late` }, sleepMs: 30 * 60 * 1000 };
    case 'dup':
      // posts the SAME report payload twice (identical event_id) — the
      // network-retry shape. The conductor's dedup must eat the second.
      return {
        outcome: { status: 'done', artifact: `artifact:${ctx.task}` },
        sleepMs: workMs,
        repeatReport: true,
      };
    case 'no-report':
      // works, but the report dispatch "dies" — lease timeout is the handler.
      return { outcome: null, sleepMs: workMs };
    case 'fail':
      return { outcome: { status: 'failed', error: 'explicit-fail' }, sleepMs: Math.min(workMs, 2000) };
    case 'infra': {
      // F-F (T45): the lane-unavailable class. ctx.infraLeft (default 2) is
      // the caller-owned flap budget — the worker that keeps getting 429s
      // reports infra_failed (net-zero burn in the FSM) until the lane
      // recovers. NOTE: attempts do NOT grow during infra flapping (the FSM
      // voids each assignment), so the flap count CANNOT ride the attempt
      // number — the caller (sim/tests) decrements infraLeft per flap.
      const left = ctx.infraLeft ?? 2;
      if (left > 0) return { outcome: { status: 'infra_failed', error: 'mock-lane-429' }, sleepMs: Math.min(workMs, 1000) };
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:post-infra` }, sleepMs: workMs };
    }
    default:
      return { outcome: { status: 'failed', error: `unknown-behavior:${behavior}` }, sleepMs: 100 };
  }
}
