// event-ingest.mjs — the conductor's wake-event router, extracted from
// conductor/turn.mjs's buildEvent (T44/F15/F16) so the strict-routing
// contract is testable outside a workflow run (the live payload-shape bug
// bit TWICE in production and zero local layers saw it).
//
// github.event shapes (the ONLY three wake sources — the triggers are
// pinned in conductor.yml: repository_dispatch [fsm-tick, fsm-control] /
// workflow_dispatch / schedule):
//   repository_dispatch  { action: 'fsm-tick' | 'fsm-control' | 'fsm-report',
//                          client_payload: {...} }
//   workflow_dispatch    { inputs: {...}, ref, ... }        (no `action`)
//   schedule             { schedule: '<cron>' }             (no `action`)
//
// STRICT routing (the live-bug #5 lesson):
//   - repository_dispatch carries its type in `action` — `event_name` does
//     NOT exist on dispatch payloads. A github.event carrying `event_name`,
//     or a `client_payload` WITHOUT `action`, is a MALFORMED dispatch:
//     THROW. (The old fallback silently routed such payloads to a tick —
//     the pause-instead-of-reset live bug: the ops ingest read `event_name`
//     where the field was `action`.) A real repository_dispatch ALWAYS
//     carries `action`; schedule/workflow_dispatch wakes NEVER carry
//     `client_payload`.
//   - an UNKNOWN non-empty action is a typo or sabotage: THROW.
//   - an EMPTY action is legitimate only for schedule / manual wakes
//     (and the bare local default `{}` -> manual tick).
//
// The same event_id minting as the pre-extraction buildEvent, with ONE
// T45/F-G(b) change: ids mint from the INJECTED clock, not Date.now() —
// two same-real-ms wakes used to mint IDENTICAL ids and the second
// legitimate wake was consumed as `duplicate` (probe6: applied=false, a
// silent wake loss + a burned journal slot; a determinism seam and a
// fast-lane hazard):
//   TICK    -> `tick-${reason}-${Date.parse(now())}`
//   CONTROL -> `ctl-direct-${command}-${Date.parse(now())}`
// (the id shape stays `<kind>-<reason>-<ms>`; ids remain opaque strings)
// T46/F-B3: both sites now route through mintEventId/MINT_TABLE (above) —
// the ONE mint source; the shapes and clock semantics are byte-identical.
//
// T45/F-E: the worker report-id minter lives here too (production converges
// to the shape sim2's worker model already uses — closing the "model more
// correct than the modeled code" gap):
//   REPORT  -> `rep-${runId}-a${attempt}` (GITHUB_RUN_ID is STABLE across GHA
//              re-runs; only GITHUB_RUN_ATTEMPT increments — attempt-scoping
//              keeps a re-run's report from being dedup-swallowed)
//
// T46/F-B3 + F-M9: the MINT TABLE — ONE table + ONE function is the single
// id-mint source for every journal kind (the exactly-once rule's other
// half). The table lives HERE (not in worker-contract.mjs) because the live
// mint sites are here; forking the source would regress probe6. The rules
// are UNCHANGED — the consolidation moves WHERE the shapes live, not what
// they mint. Where the W-B design sketch's seed slots (`<seq>`, `<node_id>`)
// could not express the live injected-clock discriminators exactly, the
// TABLE was fixed, not the call sites (the F-M9 rule):
//   TICK         {reason, clockMs}     -> `tick-${reason}-${clockMs}`
//   REPORT       {runId, attempt}      -> `rep-${runId}-a${attempt}` (tolerant
//                                         defaults: 'local' / '1')
//   CONTROL      {command, clockMs}    -> `ctl-direct-${command}-${clockMs}`
//                                         (nodeId defaults to the 'direct'
//                                         repository_dispatch lane; other
//                                         lanes pass their own nodeId)
//   TASK_CREATED {issue, bodySha8}     -> `task-${issue}-${bodySha8}` (the
//                                         W-C intake door's shape — no live
//                                         site yet; minted only by the table)
//   WAKE is never journaled — it has NO table entry and mintEventId('WAKE')
//   THROWS (an unjournaled kind minting an id is a contract violation).
// `clockMs` is Date.parse(now()) of the INJECTED clock — the call site owns
// the clock, the table owns the shape (F-G(b)/probe6: two same-real-ms wakes
// must mint DISTINCT ids or the second legitimate wake is consumed as
// `duplicate` — a silent wake loss).

// T46/W-C3 (X24): the pinger's dispatch reason — the single constant every
// pinger-aware site keys on (conductorTick's held-chain liveness marker,
// lib/pinger-watch.mjs's duty scan). The pinger (xfnwfpho1/pinger, cron
// */15) dispatches repository_dispatch fsm-tick with client_payload
// {reason:'pinger'} — live-proven run "pinger · conductor" 35206789111.
// F-3/L2-M4: the payload keys on `reason` (run names, mints, and the duty
// all read it); `note` was the invisible shape, rejected in review.
export const PINGER_REASON = 'pinger';

export const MINT_TABLE = {
  TICK: (seed) => `tick-${seed.reason}-${seed.clockMs}`,
  REPORT: (seed) => {
    const rid = seed.runId != null && String(seed.runId) !== '' ? String(seed.runId) : 'local';
    const att = seed.attempt != null && String(seed.attempt) !== '' ? String(seed.attempt) : '1';
    return `rep-${rid}-a${att}`;
  },
  CONTROL: (seed) => `ctl-${seed.nodeId ?? 'direct'}-${seed.command}-${seed.clockMs}`,
  TASK_CREATED: (seed) => `task-${seed.issue}-${seed.bodySha8}`,
};

// Per-kind seed guards: the DISCRIMINATOR must be present and well-typed
// BEFORE the template runs — a missing clock would mint `tick-x-undefined`,
// and two clock-less wakes would COLLIDE (the probe6 class, reintroduced
// from the minting side). REPORT is deliberately guard-free (the tolerant
// local-lane defaults ARE its rule).
const MINT_GUARDS = {
  TICK: (seed) => {
    if (typeof seed.reason !== 'string' || seed.reason === '') throw new Error('mintEventId(TICK): seed.reason must be a non-empty string');
    if (!Number.isFinite(seed.clockMs)) throw new Error('mintEventId(TICK): seed.clockMs must be a finite epoch-ms number (Date.parse of the injected clock)');
  },
  REPORT: () => {},
  CONTROL: (seed) => {
    if (typeof seed.command !== 'string' || seed.command === '') throw new Error('mintEventId(CONTROL): seed.command must be a non-empty string');
    if (!Number.isFinite(seed.clockMs)) throw new Error('mintEventId(CONTROL): seed.clockMs must be a finite epoch-ms number (Date.parse of the injected clock)');
  },
  TASK_CREATED: (seed) => {
    if (!(typeof seed.issue === 'string' || typeof seed.issue === 'number') || String(seed.issue) === '') throw new Error('mintEventId(TASK_CREATED): seed.issue must be a non-empty string or number');
    if (typeof seed.bodySha8 !== 'string' || seed.bodySha8 === '') throw new Error('mintEventId(TASK_CREATED): seed.bodySha8 must be a non-empty string');
  },
};

export function mintEventId(kind, seed = {}) {
  const mint = MINT_TABLE[kind];
  if (!mint) {
    throw new Error(`mintEventId: unknown journal kind ${JSON.stringify(kind)} (mintable: ${Object.keys(MINT_TABLE).join(', ')}; WAKE is never journaled and mints no id)`);
  }
  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new Error(`mintEventId(${kind}): seed must be an object`);
  }
  MINT_GUARDS[kind](seed);
  return mint(seed);
}

export function reportEventId({ runId, attempt } = {}) {
  return mintEventId('REPORT', { runId, attempt });
}

export function buildEvent(githubEvent, { now = () => new Date().toISOString() } = {}) {
  const gh = githubEvent || {};
  const cp = gh.client_payload || {};
  const action = typeof gh.action === 'string' ? gh.action : '';
  if (action === 'fsm-report') {
    // legacy lane — no workflow registers this type (the router branch is
    // kept for payload-shape strictness); reports ride git via the queue.
    return {
      kind: 'REPORT', event_id: cp.event_id, task: cp.task, lease: cp.lease,
      outcome: cp.outcome, run_id: cp.run_id, ts: now(),
    };
  }
  if (action === 'fsm-control') {
    // T45/F-G(c): direct control events carry the sender (the audit trail's
    // actor — journal-only, never a behavior gate). F-B3: the id routes
    // through the mint table (nodeId defaults to the 'direct' lane — the
    // live `ctl-direct-<command>-<ms>` shape, byte-identical).
    return { kind: 'CONTROL', command: cp.command, patch: cp.patch, actor: gh.sender?.login ?? null, note: cp.note ?? null, event_id: mintEventId('CONTROL', { command: cp.command, clockMs: Date.parse(now()) }), ts: now() };
  }
  if (action === 'fsm-tick' || action === '') {
    // an action-less dispatch SHAPE is the trap: repository_dispatch always
    // carries action; schedule/manual wakes never carry client_payload.
    if (action === '' && (gh.event_name !== undefined || gh.client_payload !== undefined)) {
      throw new Error(
        `buildEvent: malformed repository_dispatch payload (no action${gh.event_name !== undefined ? `, event_name=${JSON.stringify(gh.event_name)}` : ''}) — `
        + 'a real dispatch ALWAYS carries action; event_name does not exist on dispatch payloads (live bug #5)');
    }
    const reason = cp.reason || (gh.schedule ? 'schedule-backstop' : 'manual');
    return { kind: 'TICK', actor: reason, event_id: mintEventId('TICK', { reason, clockMs: Date.parse(now()) }), ts: now() };
  }
  throw new Error(`buildEvent: unknown repository_dispatch action "${action}" (expected fsm-tick | fsm-control | fsm-report)`);
}
