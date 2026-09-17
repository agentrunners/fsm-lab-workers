// fsm.mjs — the pure transition core of the fsm-lab.
//
// DESIGN CONTRACT (Task 43):
//  - NO I/O. Pure functions. state in -> {state', journal[], actions[]} out.
//  - Event-sourced: the JOURNAL (applied events) is the source of truth;
//    state.json is a materialized view. rebuild(genesis, journal) ≈ state.
//  - Idempotent by event.dedup_key (bounded dedup window in state).
//  - Deterministic given (state, event, now). `now` is ALWAYS an argument.
//
// The failure model is first-class: every rejected/stale/duplicate event is
// JOURNALED (applied=false, with a reason) — never silently dropped. The
// journal is the audit trail; stats count the waste (orphaned reports,
// rejected events) so the operator can see it.
//
// Journal record shapes (each carries everything rebuild() needs):
//   {id, ts, kind, applied, ...} where kind ∈
//   TICK           {seq, actor}                      (applied:false when held — F2: no record at all)
//   REPORT         {task, lease, to, run_id, reason?, error?}   (T46/F-B1: the FIVE report
//                  classes — done / work_failed (alias of legacy 'failed', byte-identical
//                  transition) / infra_failed (F-F: net-zero retry, reason infra-retry /
//                  infra-exhausted) / deadline (self-reported reaper: reason 'deadline',
//                  attempt-burn + lease release mirroring the TIMEOUT clock semantics) /
//                  poison (the quarantine door: reason 'poison', TERMINAL regardless of
//                  attempts, distinct from infra exhaustion). Work-class reports carry
//                  error only; infra/deadline/poison carry reason+error)
//   TASK_CREATED   {task, spec}
//   TIMEOUT        {task, from, to}
//   UNLOCK         {task, from, to}
//   RETRY          {task, from, to}
//   ASSIGN         {task, from, to, lease, expires, attempt, behavior, task_ref}
//                  (T46/F-M3 law-6: task_ref = {kind:'state-task', id} — the NEW-class
//                  pointer; payload stays in the state.json task record. Legacy records
//                  without task_ref are untouched and stay legal — the invariant scopes
//                  to NEW records ONLY; law6Violations() is the audit)
//   MILESTONE      {milestone, tasks: [specs]}       (legacy inline-spec class — F-M3:
//                  rebuild needs the specs; exempt from the pointer-only audit)
//   PHASE          {from, to, degraded?}              (degraded: the R2 quality gate)
//   REJECTED       {origKind, reason, event_id, outcome?}   (applied:false — audit only)
//   CONTROL        {command, patch?, before?, genesisSpec?} (configure/reset carry their payloads)
//   RECOVERY       {reason, dropFrom?, droppedRecords?, snapshotSha?}  (F-A: the
//                  rollback-sweep epoch marker; rebuild-skippable, audit-only)

export const TASK_STATUSES = [
  'backlog', 'ready', 'assigned', 'in_progress',
  'done', 'failed', 'quarantined', 'cancelled',
];
export const TERMINAL = new Set(['done', 'failed', 'quarantined', 'cancelled']);
const TERMINAL_CANCEL = new Set(['quarantined', 'cancelled']);
export const ACTIVE_LEASE = new Set(['assigned', 'in_progress']);

// F-F (T45): the infra-retry budget — a lib CONSTANT, not a config knob (a
// knob would grow CONFIG_BOUNDS + configure + journal shapes; escalate only
// if fleet tuning demands it). Semantics: TOTAL, not consecutive — a task
// that infra-flaps twice early and once late parks as infra-exhausted even
// with a healthy lane at the end (bounded loop, visible in infra_retries;
// reset is the remedy after the lane is fixed).
export const INFRA_RETRY_MAX = 3;

// T46/F-B2 (fsm half): the harness-mode vocabulary for genesis. Mirrors
// ENVELOPE_MODES in lib/worker-contract.mjs — ONE vocabulary, two modules:
// the FSM core stays import-free by design (tests/test-fsm.mjs pins the
// cross-module equality so the two lists cannot drift).
export const GENESIS_MODES = ['mock', 'real', 'cc'];

// Allowed directed edges of the task FSM. Anything else is a rejected event.
const EDGES = new Set([
  'backlog>ready', 'ready>assigned',
  'assigned>in_progress',
  'assigned>done', 'assigned>failed', 'assigned>ready', 'assigned>quarantined',
  'in_progress>done', 'in_progress>failed', 'in_progress>ready', 'in_progress>quarantined',
  'failed>ready', 'failed>quarantined',
  'ready>cancelled', 'backlog>cancelled', 'assigned>cancelled', 'in_progress>cancelled',
  'failed>cancelled', 'quarantined>cancelled',
]);

// F12/A3: config bounds — genesis and `configure` both validate through this.
// Upper bounds exist because max_parallel=999 would emit 999 dispatch actions
// with invariants clean (red-team probe D) — a flood class, not a correctness class.
export const CONFIG_BOUNDS = {
  max_parallel: [1, 32],
  lease_minutes: [1, 120],
  max_attempts: [1, 9],
  tick_min_interval_s: [0, 600],
  // T46/W-C1 (F-6): the lane-budget pause knobs — the X21 12-task burn's
  // structural fix. threshold = distinct TASKS with quota-shaped infra
  // reports inside the window; window bounds the memory (minutes).
  budget_pause_threshold: [1, 10],
  budget_pause_window_min: [5, 720],
  // T46/W-C1 (§5b): terminal task records compact after N observed ticks
  // terminal — state.json carries the active window only (0.77KB/task
  // design number must not erode; the journal retains everything).
  prune_tasks_after_ticks: [5, 500],
};

export function validateConfig(cfg, where) {
  for (const [k, [lo, hi]] of Object.entries(CONFIG_BOUNDS)) {
    const v = cfg[k];
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`${where}: config.${k} must be an integer in [${lo},${hi}] (got ${v})`);
    }
  }
  if (!Number.isInteger(cfg.dedup_window) || cfg.dedup_window < 16) {
    throw new Error(`${where}: config.dedup_window must be an integer >= 16`);
  }
}

export function genesis({ config, project, chainId, now, mode = 'mock', issue = null }) {
  const cfg = {
    max_parallel: 4,
    lease_minutes: 10,
    max_attempts: 3,
    tick_min_interval_s: 0,
    dedup_window: 300,
    budget_pause_threshold: 3,
    budget_pause_window_min: 15,
    prune_tasks_after_ticks: 20,
    ...config,
  };
  validateConfig(cfg, 'genesis');
  if (!(project.tasks || []).length) throw new Error('genesis: project.tasks must be non-empty');
  // T46/F-B2: the epoch's harness mode rides the genesis state as
  // project.mode (chosen over chain.mode: mode is an EPOCH/PROJECT property —
  // "which harness lane executes this project's tasks" — set at genesis
  // boundaries and carried by reset specs; chain carries runtime identity).
  // Default 'mock' (every legacy epoch); the X21 synthetic epoch passes 'cc'.
  if (!GENESIS_MODES.includes(mode)) {
    throw new Error(`genesis: mode must be one of ${GENESIS_MODES.join('|')} (got ${JSON.stringify(mode)})`);
  }
  const tasks = {};
  for (const t of project.tasks || []) tasks[t.id] = mkTask(t, now);
  return {
    schema: 1,
    version: 1,          // strictly increasing; bumped per state-changing commit
    journal_seq: 1,
    chain: { id: chainId, seq: 0, last_tick: now, primed_by: 'genesis', halted: false, paused: false },
    // T46/W-C1 (m-3): the intake thread — an epoch born from the door
    // remembers its issue so completion comments target the INTAKE issue
    // (the operator's thread), not just the ops console.
    project: { phase: 'executing', milestone: 1, milestones_total: (project.milestones || 1), mode, issue },
    config: cfg,
    tasks,
    stats: { done: 0, failed: 0, quarantined: 0, cancelled: 0, retries: 0, orphaned_reports: 0, rejected_events: 0, timeouts: 0, dispatched: 0, infra_retries: 0 },
    dedup: [],
  };
}

export function mkTask(t, now) {
  return {
    id: t.id,
    title: t.title || t.id,
    status: t.deps && t.deps.length ? 'backlog' : 'ready',
    behavior: t.behavior || 'succeed',
    work_ms: t.work_ms ?? 6000,
    deps: t.deps || [],
    attempts: 0,
    lease: null, // {token, expires, issued_at}
    created: now,
    updated: now,
    history: [{ at: now, status: t.deps && t.deps.length ? 'backlog' : 'ready', why: 'created' }],
    last_result: null,
    // T46/W-C1 (§2e): intake specs carry their accept-criteria as task
    // data — the dispatch envelope embeds it in the prompt (SPEC-DATA,
    // fence-neutralized transport-side). Absent on mock/drill tasks.
    ...(t.spec ? { spec: t.spec } : {}),
  };
}

// ---------------------------------------------------------------------------
// applyEvent — one incoming event against state.
// ---------------------------------------------------------------------------

export function applyEvent(state, ev, now) {
  const s = structuredClone(state);
  // Dedup = EVENT IDENTITY. A real worker generates a fresh event_id per
  // report POST; a network-retry of the same POST reuses it (that is the
  // duplicate the guard exists for). (run,task) identity would be WRONG:
  // progress-then-done from one run are two legitimate events.
  const dedupKey = ev.event_id || ev.dedup_key || `${ev.kind}:${ev.command || ''}:${ev.ts}:${ev.actor || ''}`;
  if (s.dedup.includes(dedupKey)) {
    s.stats.rejected_events += 1;
    return { state: s, applied: false, reason: 'duplicate', eventOut: jrec(s, { kind: 'REJECTED', origKind: ev.kind, task: ev.task || null, event_id: ev.event_id || null, reason: 'duplicate' }, now, false) };
  }
  // F11: event identity is consumed by the drain pipeline exactly once,
  // regardless of outcome — a re-enqueued rejected id arrives as 'duplicate'.
  // This is the consume-on-drain safety net (the queue is emptied each tick;
  // dedup bounds the journal noise of any re-delivery).
  pushDedup(s, dedupKey);
  switch (ev.kind) {
    case 'TICK': {
      // F2: a wake on a HELD chain is not an event — no journal record, no
      // seq bump, no state change. The conductor's noop path quiesces (no
      // commit, no self-dispatch). last_tick staleness is safe to leave: the
      // watchdog checks halted/paused BEFORE staleness (scan.mjs).
      if (s.chain.paused || s.chain.halted) {
        return { state: s, applied: false, reason: s.chain.paused ? 'held-paused' : 'held-halted' };
      }
      s.chain.seq += 1;
      s.chain.last_tick = now;
      s.chain.primed_by = ev.actor || 'chain';
      return { state: s, applied: true, reason: 'tick', eventOut: jrec(s, { kind: 'TICK', seq: s.chain.seq, actor: ev.actor || 'chain' }, now) };
    }
    case 'REPORT': {
      const t = s.tasks[ev.task];
      if (!t) return reject(s, ev, now, 'unknown-task');
      if (!ACTIVE_LEASE.has(t.status) || !t.lease) return reject(s, ev, now, `task-not-leased(${t.status})`);
      if (t.lease.token !== ev.lease) {
        s.stats.orphaned_reports += 1;
        return reject(s, ev, now, 'stale-lease');
      }
      const outcome = ev.outcome || {};
      if (outcome.status === 'progress') {
        return transition(s, t, 'in_progress', now, 'worker-progress', ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'in_progress', run_id: ev.run_id },
          { last_result: { status: 'progress', run_id: ev.run_id } });
      }
      if (outcome.status === 'done') {
        return transition(s, t, 'done', now, 'worker-done', ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'done', run_id: ev.run_id },
          { last_result: { status: 'done', run_id: ev.run_id, artifact: outcome.artifact || null, duration_ms: outcome.duration_ms || null } });
      }
      if (outcome.status === 'failed' || outcome.status === 'work_failed') {
        // T46/F-B1: 'work_failed' is the ALIAS of legacy 'failed' — the same
        // attempt-burn transition, byte-identical journal shape (legacy
        // epochs unchanged); last_result records which vocabulary the worker
        // used. The retry-scan clock pass moves failed->ready next tick.
        const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'failed';
        return transition(s, t, dest, now, `worker-failed(attempts=${t.attempts})`, ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: dest, run_id: ev.run_id },
          { last_result: { status: outcome.status, run_id: ev.run_id, error: outcome.error != null ? String(outcome.error).slice(0, 200) : null } });
      }
      if (outcome.status === 'deadline') {
        // T46/F-B1: the SELF-REPORTED reaper — the worker hit its lease-scoped
        // wall and says so (rc=124, OX_AGENT_DEADLINE_UTC). Attempt-burn +
        // lease release, mirroring the clock's lease-timeout semantics exactly
        // (reaper-equivalence): requeue when retries remain, quarantine when
        // the ladder is spent; timeouts counted as the reaper's own would
        // count them (the same semantic event, earlier signal — and the
        // reaper itself cannot double-fire: the lease is released here).
        const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'ready';
        s.stats.timeouts += 1;
        if (dest === 'ready') s.stats.retries += 1;
        const error = outcome.error != null ? String(outcome.error).slice(0, 200) : null;
        return transition(s, t, dest, now, `worker-deadline(attempts=${t.attempts})`, ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: dest, reason: 'deadline', run_id: ev.run_id, error },
          { lease: null, last_result: { status: 'deadline', run_id: ev.run_id, error } });
      }
      if (outcome.status === 'poison') {
        // T46/F-B1: the QUARANTINE DOOR — prompt-injection / anomaly /
        // contract violation (write-back door violations report here).
        // TERMINAL regardless of attempts (retrying an anomalous prompt is
        // pointless burn) and DISTINCT from infra exhaustion: reason 'poison'
        // on the journal record, no infra_attempts increment — an operator
        // must be able to tell task-poison quarantine from lane-death
        // quarantine from the audit trail alone.
        const error = outcome.error != null ? String(outcome.error).slice(0, 200)
          : outcome.detail != null ? String(outcome.detail).slice(0, 200) : null;
        return transition(s, t, 'quarantined', now, 'worker-poison', ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'quarantined', reason: 'poison', run_id: ev.run_id, error },
          { last_result: { status: 'poison', run_id: ev.run_id, error } });
      }
      if (outcome.status === 'infra_failed') {
        // F-F (T45): the lane-unavailable class — the worker never got to
        // ATTEMPT the work, so the assignment is voided (net-zero burn) and
        // the task returns to ready for a re-dispatch, bounded by the INFRA
        // retry budget (own counter — NEVER the work max_attempts ladder).
        // Exhaustion is terminal with a DISTINCT reason so an operator can
        // tell lane-death quarantine from task-poison quarantine.
        const infraAttempts = (t.infra_attempts ?? 0) + 1;
        const error = outcome.error != null ? String(outcome.error).slice(0, 200) : null;
        if (infraAttempts >= INFRA_RETRY_MAX) {
          return transition(s, t, 'quarantined', now, `infra-exhausted(infra_attempts=${infraAttempts})`, ev,
            { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'quarantined', reason: 'infra-exhausted', run_id: ev.run_id, error },
            { infra_attempts: infraAttempts, last_result: { status: 'infra_failed', run_id: ev.run_id, error } });
        }
        // net-zero: attempts counts REAL work attempts — void this assignment
        // (Math.max guards the floor; the attempts-negative invariant stands)
        s.stats.infra_retries += 1;
        return transition(s, t, 'ready', now, `infra-retry(lane-unavailable)`, ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'ready', reason: 'infra-retry', run_id: ev.run_id, error },
          { attempts: Math.max(0, t.attempts - 1), lease: null, infra_attempts: infraAttempts, last_result: { status: 'infra_failed', run_id: ev.run_id, error } });
      }
      return reject(s, ev, now, `bad-outcome(${outcome.status})`);
    }
    case 'TASK_CREATED': {
      if (!ev.task || !ev.task.id || s.tasks[ev.task.id]) return reject(s, ev, now, 'task-exists-or-bad');
      // F9: a ghost dep bricks the chain fail-closed downstream (never
      // unlocks, never cascade-cancels, invariant flags it, conductor
      // throws). Reject at the event boundary where it's recoverable.
      const missing = (ev.task.deps || []).filter(d => !s.tasks[d]);
      if (missing.length) return reject(s, ev, now, `unknown-dep(${missing.join(',')})`);
      s.tasks[ev.task.id] = mkTask(ev.task, now);
      bumpVersion(s);
      return { state: s, applied: true, reason: 'task-created', eventOut: jrec(s, { kind: 'TASK_CREATED', task: ev.task.id, spec: ev.task }, now) };
    }
    case 'CONTROL': {
      const cmd = ev.command;
      if (!['pause', 'resume', 'halt', 'unhalt', 'configure'].includes(cmd)) return reject(s, ev, now, `bad-command(${cmd})`);
      if (cmd === 'configure') {
        // F12: validated, bounded config patch — the runtime knob surface.
        const patch = ev.patch || {};
        const keys = Object.keys(patch);
        if (!keys.length) return reject(s, ev, now, 'configure-empty');
        const bad = keys.filter(k => !(k in CONFIG_BOUNDS));
        if (bad.length) return reject(s, ev, now, `bad-patch-key(${bad.join(',')})`);
        const next = { ...s.config };
        for (const k of keys) next[k] = patch[k];
        try { validateConfig(next, 'configure'); } catch (e) { return reject(s, ev, now, `bad-patch(${String(e.message).slice(0, 120)})`); }
        const changed = keys.filter(k => next[k] !== s.config[k]);
        if (!changed.length) return reject(s, ev, now, 'configure-noop');
        const before = {}, after = {};
        for (const k of changed) { before[k] = s.config[k]; after[k] = next[k]; }
        s.config = next;
        bumpVersion(s);
        // T45/F-G(c): actor + note on the journal record (audit-only fields;
        // rebuild ignores them — additive, F8-safe)
        const cnote = ev.note != null && String(ev.note) !== '' ? String(ev.note).slice(0, 200) : null;
        return { state: s, applied: true, reason: 'control:configure', eventOut: jrec(s, { kind: 'CONTROL', command: 'configure', patch: after, before, actor: ev.actor ?? null, note: cnote }, now) };
      }
      // F13: unhalt on a completed project would restart a done chain with
      // nothing to do — the reset control is the way to restart.
      if (cmd === 'unhalt' && s.project.phase === 'done') return reject(s, ev, now, 'phase-done');
      // T46/W-C1 (F-7): the budget pause is a JOURNALED CONTROL event whose
      // payload carries the reason — the chain record's paused_reason is the
      // projection (rebuild derives it from the journaled payload). A plain
      // operator pause (no payload) sets no reason — identical to pre-W-C.
      if (cmd === 'pause') {
        s.chain.paused = true;
        if (ev.payload && typeof ev.payload.reason === 'string' && ev.payload.reason) {
          s.chain.paused_reason = String(ev.payload.reason).slice(0, 80);
          // F-6 audit: one budget_pauses counter per lane-budget event
          s.stats.budget_pauses = (s.stats.budget_pauses ?? 0) + 1;
        }
      } else if (cmd === 'resume') {
        // resume = the operator's quota-reset assertion: the trigger window
        // MUST clear here or the still-warm entries would re-pause instantly
        // (the re-trigger loop). The pause event is durable (journaled);
        // the window is live-only memory — resume declares it stale.
        s.chain.paused = false;
        delete s.chain.paused_reason;
        s.budget_window = [];
      }
      else if (cmd === 'halt') s.chain.halted = true;
      else s.chain.halted = false;
      bumpVersion(s);
      // T45/F-G(c): actor + note on the journal record (audit-only fields;
      // rebuild ignores them — additive, F8-safe). The fleet core's audit
      // trail can now answer "who commanded pause/reset".
      const cnote = ev.note != null && String(ev.note) !== '' ? String(ev.note).slice(0, 200) : null;
      return { state: s, applied: true, reason: `control:${cmd}`, eventOut: jrec(s, { kind: 'CONTROL', command: cmd, actor: ev.actor ?? null, note: cnote }, now) };
    }
    default:
      return reject(s, ev, now, `bad-kind(${ev.kind})`);
  }
}

function reject(s, ev, now, reason) {
  s.stats.rejected_events += 1;
  // A4: REJECTED records carry the event identity + (for reports) a sliced
  // outcome — consumed rejects keep their audit trail (F1 deletes the queue
  // line; the journal is the only record of what the worker said).
  const out = { kind: 'REJECTED', origKind: ev.kind, task: ev.task || null, event_id: ev.event_id || null, reason };
  if (ev.kind === 'REPORT' && ev.outcome && typeof ev.outcome === 'object') {
    out.outcome = {
      status: ev.outcome.status ?? null,
      error: ev.outcome.error != null ? String(ev.outcome.error).slice(0, 200) : null,
      artifact: ev.outcome.artifact != null ? String(ev.outcome.artifact).slice(0, 200) : null,
    };
  }
  return { state: s, applied: false, reason, eventOut: jrec(s, out, now, false) };
}

function transition(s, t, dest, now, why, ev, journalFields, extra = {}) {
  const edge = `${t.status}>${dest}`;
  if (!EDGES.has(edge)) return reject(s, ev, now, `bad-edge(${edge})`);
  const from = t.status;
  t.status = dest;
  t.updated = now;
  t.history.push({ at: now, status: dest, why });
  Object.assign(t, extra);
  if (TERMINAL.has(dest)) t.lease = null;
  bumpVersion(s);
  recount(s);
  return { state: s, applied: true, reason: `task:${edge}`, eventOut: jrec(s, { ...journalFields, from }, now) };
}

function pushDedup(s, key) {
  s.dedup.push(key);
  if (s.dedup.length > s.config.dedup_window) s.dedup.splice(0, s.dedup.length - s.config.dedup_window);
}

function bumpVersion(s) { s.version += 1; }

export function recount(s) {
  let done = 0, failed = 0, quarantined = 0, cancelled = 0;
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'done') done++;
    else if (t.status === 'failed') failed++;
    else if (t.status === 'quarantined') quarantined++;
    else if (t.status === 'cancelled') cancelled++;
  }
  s.stats.done = done; s.stats.failed = failed;
  s.stats.quarantined = quarantined; s.stats.cancelled = cancelled;
}

function jrec(s, fields, now, applied = true) {
  const id = `e${s.journal_seq}`;
  s.journal_seq += 1;
  return { id, ts: now, applied, ...fields };
}

// ---------------------------------------------------------------------------
// clock — the scheduling/timeout/phase pass. Deterministic on (state, now).
// nextMilestone(m) -> {tasks:[...]} | null  (the project generator hook).
// ---------------------------------------------------------------------------

const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

export function clock(state, now, nextMilestone, opts = {}) {
  const nowMs = toMs(now);
  const s = structuredClone(state);
  const journal = [];
  const actions = [];
  const J = (fields, applied = true) => { const r = jrec(s, fields, now, applied); journal.push(r); return r; };
  // T46/W-C1 (F-10): the dispatch budget — a wall-clock-derived SLOT COUNT
  // recomputed before each assign. The fn comes from the adapter's
  // job-deadline budget (remaining − self-tick reserve, / DISPATCH_COST_MS);
  // null = disabled (legacy/test lanes). Honest note: the mutate is
  // synchronous so the wall-clock barely moves between assigns — the
  // budget's VALUE is minted against the adapter's real deadline at commit
  // time; the per-iteration recompute is architecture-robustness (correct
  // under any future move of dispatches into the mutate). A budget-exhausted
  // pass leaves the remaining ready tasks READY — never assigned — so the
  // skip-left-assigned bug class (X21 hot-fix 2) is dead by construction.
  const dispatchBudgetFn = typeof opts.dispatchBudgetFn === 'function' ? opts.dispatchBudgetFn : null;

  if (s.chain.paused || s.chain.halted) {
    return { state: s, journal, actions: [{ type: 'HOLD_CHAIN', reason: s.chain.paused ? 'paused' : 'halted' }] };
  }

  // 1) lease timeouts
  for (const t of Object.values(s.tasks)) {
    if (ACTIVE_LEASE.has(t.status) && t.lease && toMs(t.lease.expires) <= nowMs) {
      const from = t.status;
      const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'ready';
      t.status = dest; t.updated = now; t.lease = null;
      t.history.push({ at: now, status: dest, why: `lease-timeout(attempts=${t.attempts})` });
      s.stats.timeouts += 1;
      if (dest === 'ready') s.stats.retries += 1;
      bumpVersion(s);
      J({ kind: 'TIMEOUT', task: t.id, from, to: dest });
      // NOTE: alerting is a CONDUCTOR concern — it scans the commit's
      // journal for records with to:'quarantined' / PHASE:done and posts.
      // The FSM stays pure transitions + journal (single responsibility).
    }
  }

  // 2) dependency unlock
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'backlog' && t.deps.length && t.deps.every(d => s.tasks[d] && s.tasks[d].status === 'done')) {
      t.status = 'ready'; t.updated = now;
      t.history.push({ at: now, status: 'ready', why: 'deps-satisfied' });
      bumpVersion(s);
      J({ kind: 'UNLOCK', task: t.id, from: 'backlog', to: 'ready' });
    }
  }

  // 2.5) CASCADE cancellation (live-found design gap): a backlog task whose
  // deps include a quarantined/cancelled task can NEVER unlock — without this
  // the project deadlocks silently in 'executing' forever. The honest state
  // is cascade-cancelled (the feature cannot complete because its dependency
  // failed) — terminal, visible, counted.
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'backlog' && t.deps.some(d => s.tasks[d] && TERMINAL_CANCEL.has(s.tasks[d].status))) {
      t.status = 'cancelled'; t.updated = now;
      t.history.push({ at: now, status: 'cancelled', why: 'dep-failed-cascade' });
      bumpVersion(s);
      J({ kind: 'CANCEL_CASCADE', task: t.id, from: 'backlog', to: 'cancelled', reason: t.deps.find(d => s.tasks[d] && TERMINAL_CANCEL.has(s.tasks[d].status)) });
    }
  }

  // 3) retry pass: failed tasks -> ready (retries left) or quarantined
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'failed') {
      const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'ready';
      t.status = dest; t.updated = now;
      t.history.push({ at: now, status: dest, why: `retry-scan(attempts=${t.attempts})` });
      if (dest === 'ready') s.stats.retries += 1;
      bumpVersion(s);
      J({ kind: 'RETRY', task: t.id, from: 'failed', to: dest });
    }
  }

  recount(s);

  // 3.5) T46/W-C1 (§5b): task-record pruning — terminal records compact to
  // {id, status, attempts, done_at, pruned} after prune_tasks_after_ticks
  // OBSERVED ticks terminal (terminal_seq stamps lazily on first sight; ≤1
  // tick drift is harmless — the count is a bound, not an instant). The
  // journal retains everything (immutable); state carries the active
  // window. Idempotent via the pruned marker; rebuild() reconstructs full
  // records and the next live clock re-prunes (projection semantics).
  // NEVER non-terminal tasks; pruned records keep status so recount,
  // allTerminal and dep-satisfaction all hold.
  for (const t of Object.values(s.tasks)) {
    if (!TERMINAL.has(t.status) || t.pruned) continue;
    if (t.terminal_seq == null) t.terminal_seq = s.chain.seq;
    if (s.chain.seq - t.terminal_seq <= (s.config.prune_tasks_after_ticks ?? 20)) continue;
    const done_at = t.updated;
    s.tasks[t.id] = { id: t.id, status: t.status, attempts: t.attempts, done_at, pruned: true };
    J({ kind: 'PRUNE', task: t.id, from_status: t.status });
  }

  // 4) schedule: fill free slots from the ready queue (FIFO by id)
  const inFlight = Object.values(s.tasks).filter(t => ACTIVE_LEASE.has(t.status)).length;
  let free = s.config.max_parallel - inFlight;
  const ready = Object.values(s.tasks).filter(t => t.status === 'ready').sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const t of ready) {
    if (free <= 0) break;
    // F-10: budget recomputed before EACH assign — exhausted → the task
    // stays READY (assignment exists only inside a spent dispatch slot)
    if (dispatchBudgetFn) {
      const budgetNow = Math.max(0, Math.floor(dispatchBudgetFn()));
      if (budgetNow <= 0) {
        J({ kind: 'BUDGET', reason: 'dispatch-paced', budget: budgetNow, ready_remaining: ready.filter(x => x.status === 'ready').length });
        break;
      }
    }
    // 12-hex tokens: 8 hex had ~1e-4 birthday-collision odds at 1000 tasks —
    // and a token collision is a false-positive lease theft (bricks fail-closed).
    const token = `l-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const expires = new Date(nowMs + s.config.lease_minutes * 60_000).toISOString();
    const from = t.status;
    // T46/F-M3 (law 6): the NEW-class pointer — the dispatch envelope and
    // the journal record both point INTO the state.json task record; the
    // workload payload (title/prompt/spec) never rides the journal or the
    // dispatch. Legacy ASSIGN records without task_ref stay legal (the
    // invariant scopes to NEW records — law6Violations is the audit).
    const task_ref = { kind: 'state-task', id: t.id };
    t.status = 'assigned'; t.updated = now; t.attempts += 1;
    t.lease = { token, expires, issued_at: new Date(now).toISOString() };
    t.history.push({ at: now, status: 'assigned', why: `assigned(attempt=${t.attempts})` });
    s.stats.dispatched += 1;
    free -= 1;
    bumpVersion(s);
    J({ kind: 'ASSIGN', task: t.id, from, to: 'assigned', lease: token, expires, attempt: t.attempts, behavior: t.behavior, task_ref });
    actions.push({ type: 'DISPATCH_WORKER', task: t.id, lease: token, behavior: t.behavior, attempt: t.attempts, work_ms: t.work_ms, expires, task_ref });
  }

  // 5) phase advance — all tasks terminal? (F13: gated on phase !== 'done' —
  // an unhalt-then-tick on a completed project must not re-fire PHASE/STOP)
  const tasksArr = Object.values(s.tasks);
  const allTerminal = tasksArr.length > 0 && tasksArr.every(t => TERMINAL.has(t.status));
  if (allTerminal && s.project.phase !== 'done') {
    const next = nextMilestone ? nextMilestone(s.project.milestone) : null;
    if (next && next.tasks && next.tasks.length) {
      const valid0 = next.tasks.slice();
      // F9 (44-h P1): FIXPOINT prune — a dep on a sibling spec that is ITSELF
      // invalid must cascade (B1-ghost, B2-deps-B1 would brick the chain via
      // the invariant walk). Iteratively drop invalid specs until stable.
      let valid = valid0;
      let changed = true;
      while (changed) {
        changed = false;
        valid = valid.filter(spec => {
          const ok = (spec.deps || []).every(d => d !== spec.id && (s.tasks[d] || valid.some(x => x.id === d)));
          if (!ok) changed = true;
          return ok;
        });
      }
      for (const spec of valid0) {
        if (!valid.includes(spec)) {
          J({ kind: 'REJECTED', origKind: 'MILESTONE', task: spec.id, reason: 'unknown-dep' }, false);
          s.stats.rejected_events += 1;  // 44-h P2c: clock-emitted rejects count like all others
        }
      }
      if (!valid.length) {
        J({ kind: 'REJECTED', origKind: 'MILESTONE', reason: 'all-specs-invalid' }, false);
        s.stats.rejected_events += 1;
        const fromPhase0 = s.project.phase;
        s.project.phase = 'done';
        s.chain.halted = true;
        bumpVersion(s);
        J({ kind: 'PHASE', from: fromPhase0, to: 'done' });  // 44-h: rebuild must halt too
        actions.push({ type: 'STOP_CHAIN', reason: 'milestone-unusable' });
        return { state: s, journal, actions };
      }
      for (const spec of valid) s.tasks[spec.id] = mkTask(spec, now);
      s.project.milestone += 1;
      s.project.phase = 'executing';
      bumpVersion(s);
      J({ kind: 'MILESTONE', milestone: s.project.milestone, tasks: valid });
      actions.push({ type: 'MILESTONE_STARTED', milestone: s.project.milestone, tasks: valid.length });
    } else {
      const fromPhase = s.project.phase;  // read BEFORE the mutation (was always 'done')
      // R2 quality-gate (T45): a completion dominated by quarantine/cancel
      // is a DEGRADED halt, not a success — mass quarantine with all-green
      // runs is the probe1 kill; the completion signal must not read
      // "complete" when the work died. The PHASE record carries degraded:true
      // (additive; rebuild ignores it) so the conductor can alert distinctly.
      const degraded = s.stats.done * 2 < tasksArr.length;
      s.project.phase = 'done';
      s.chain.halted = true;
      bumpVersion(s);
      J({ kind: 'PHASE', from: fromPhase, to: 'done', ...(degraded ? { degraded: true } : {}) });
      actions.push({ type: 'STOP_CHAIN', reason: degraded ? 'project-degraded' : 'project-complete' });
    }
  }

  return { state: s, journal, actions };
}

// ---------------------------------------------------------------------------
// apply — the composite entry point the conductor calls:
// applyEvent(ev) then clock(). Journal = [event record, ...clock records].
// ---------------------------------------------------------------------------

export function apply(state, ev, now, nextMilestone, opts = {}) {
  const r1 = applyEvent(state, ev, now);
  // T46/W-C1 (F-10): the dispatch budget threads through to every clock
  // pass inside a tick (report-drain applies included — ANY apply may run
  // the schedule pass; the budget must bound them all uniformly).
  const c = clock(r1.state, now, nextMilestone, opts);
  return {
    state: c.state,
    journal: r1.eventOut ? [r1.eventOut, ...c.journal] : c.journal,
    actions: c.actions,
    applied: r1.applied,
    reason: r1.reason,
  };
}

// ---------------------------------------------------------------------------
// invariants — machine-checkable after every transition (tests + runtime).
// ---------------------------------------------------------------------------

export function invariants(state) {
  const v = [];
  if (typeof state.version !== 'number' || state.version < 1) v.push('version-bad');
  const leaseOwners = new Map();
  for (const [id, t] of Object.entries(state.tasks)) {
    if (!TASK_STATUSES.includes(t.status)) v.push(`${id}:bad-status(${t.status})`);
    if (ACTIVE_LEASE.has(t.status) && !t.lease) v.push(`${id}:active-without-lease`);
    if (TERMINAL.has(t.status) && t.lease) v.push(`${id}:terminal-with-lease`);
    // F10: a lease on a non-active, non-terminal task is a LEAK (the
    // timeout/retry/terminal paths all clear leases — this catches regressions).
    if (!ACTIVE_LEASE.has(t.status) && !TERMINAL.has(t.status) && t.lease) v.push(`${id}:inactive-with-lease`);
    if (ACTIVE_LEASE.has(t.status) && t.lease) {
      if (leaseOwners.has(t.lease.token)) v.push(`${leaseOwners.get(t.lease.token)}:${id}:duplicate-lease-token`);
      else leaseOwners.set(t.lease.token, id);
    }
    if (t.attempts < 0) v.push(`${id}:attempts-negative`);
    // T46/W-C1 (§5b): pruned records carry no deps array — the loop must
    // tolerate the absent field (pruned terminals have no live dep edges).
    for (const d of (t.deps || [])) {
      if (!state.tasks[d]) v.push(`${id}:missing-dep(${d})`);
      else if (ACTIVE_LEASE.has(t.status) && state.tasks[d].status !== 'done') v.push(`${id}:dep-not-done(${d})`);
    }
  }
  const cnt = { done: 0, failed: 0, quarantined: 0, cancelled: 0 };
  for (const t of Object.values(state.tasks)) if (t.status in cnt) cnt[t.status]++;
  for (const k of Object.keys(cnt)) {
    if (state.stats[k] !== cnt[k]) v.push(`stats.${k}=${state.stats[k]}!=${cnt[k]}`);
  }
  const inFlight = Object.values(state.tasks).filter(t => ACTIVE_LEASE.has(t.status)).length;
  if (inFlight > state.config.max_parallel) v.push(`parallel-exceeded(${inFlight}>${state.config.max_parallel})`);
  if (state.dedup.length > state.config.dedup_window) v.push('dedup-window-overflow');
  return v;
}

// ---------------------------------------------------------------------------
// law6Violations — the law-6 (blob budgets) journal audit, F-M3-SCOPED.
// ---------------------------------------------------------------------------
//
// The pointer-only invariant: NEW-class journal records point INTO the
// state.json task records (task_ref) instead of inlining workload payloads —
// payload in task records, ids in journal. The scoping (F-M3, the review
// round's kill): the invariant applies to NEW records ONLY. Legacy records
// (TASK_CREATED's spec, MILESTONE's tasks:[specs]) inline payloads BY DESIGN
// — rebuild() replays them — and MUST NOT be flagged (an unscoped pin-test
// would fail on every legacy epoch's journal).
//
// A record is NEW-class iff it carries a task_ref. The audit flags:
//   - task_ref records that ALSO inline a workload payload (prompt / spec /
//     body / title / tasks) — the pointer-plus-payload double-write class
//   - a malformed task_ref (not {kind:'state-task', id})
//   - an ASSIGN-shaped record missing its task_ref (new ASSIGN records mint
//     the pointer since T46 — a record that LOOKS new but lacks the pointer
//     is a minting regression). Legacy pre-T46 ASSIGN records carry no marker
//     that distinguishes them from new ones, so this check is OPT-IN via
//     {requireAssignTaskRef:true} for audits that know the journal is
//     post-T46 (the live conductor audit enables it after the W-B deploy).
//
// Pure: (records[, opts]) -> string[] (empty = law upheld).

export function law6Violations(records, { requireAssignTaskRef = false } = {}) {
  const v = [];
  const INLINE_SPEC_FIELDS = ['prompt', 'spec', 'body', 'title', 'tasks'];
  const list = Array.isArray(records) ? records : [];
  for (const j of list) {
    if (!j || typeof j !== 'object') continue;
    if (j.task_ref === undefined) continue;  // legacy class — out of scope (F-M3)
    const tr = j.task_ref;
    if (typeof tr !== 'object' || tr === null || Array.isArray(tr) || tr.kind !== 'state-task'
      || typeof tr.id !== 'string' || tr.id === '') {
      v.push(`${j.id ?? '?'}:bad-task-ref(${JSON.stringify(tr).slice(0, 60)})`);
      continue;
    }
    if (j.task !== undefined && j.task !== tr.id) {
      v.push(`${j.id}:task-ref-mismatch(${j.task}!=${tr.id})`);
    }
    for (const k of INLINE_SPEC_FIELDS) {
      if (j[k] !== undefined) v.push(`${j.id ?? '?'}:inline-spec(${k})`);
    }
  }
  if (requireAssignTaskRef) {
    for (const j of list) {
      if (j && typeof j === 'object' && j.kind === 'ASSIGN' && j.task_ref === undefined) {
        v.push(`${j.id ?? '?'}:assign-without-task-ref`);
      }
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// rebuild — event-sourced recovery: replay journal records into state.
// Records with applied:false are audit-only (skipped). The replay is
// edge-guarded: each record only fires if the task is in the recorded `from`
// state (or a compatible state for idempotent skips) — replaying a journal
// twice, or against a partially stale view, is safe by construction.
// ---------------------------------------------------------------------------

export function rebuild(genesisState, journalRecords, { nextMilestone } = {}) {
  // F-A (T45): KEEPS-LAST-ON-DUPLICATE-ID — the first pass resolves every id
  // to its LAST occurrence (content wins), then replays each id ONCE at its
  // first-occurrence position. Makes rebuild total on ANY duplicate-id journal
  // (the live branch's mixed-deploy gens 8-10 carry 992 duplicate lines until
  // pruned; a pre-F-A recovery shape; any future bug) instead of
  // double-applying. Id-less records replay as-is, each its own group.
  const lastById = new Map();
  const order = [];
  journalRecords.forEach((j, i) => {
    const key = j && j.id != null ? String(j.id) : `@idx-${i}`;
    if (!lastById.has(key)) order.push(key);
    lastById.set(key, j);
  });
  const replay = order.map(k => lastById.get(k));
  let s = structuredClone(genesisState);
  for (const j of replay) {
    // F8: applied:false records are real now (every jrec carries the flag).
    // Mirror the live counter semantics exactly: rejected_events on every
    // reject, orphaned_reports on stale-lease rejects.
    if (j.applied === false) {
      s.stats.rejected_events += 1;
      if (j.origKind === 'REPORT' && j.reason === 'stale-lease') s.stats.orphaned_reports += 1;
      s.journal_seq = Math.max(s.journal_seq, (parseInt((j.id || 'e0').slice(1), 10) || 0) + 1);
      continue;
    }
    const ts = j.ts;
    switch (j.kind) {
      case 'TICK': s.chain.seq = Math.max(s.chain.seq, j.seq || 0); s.chain.last_tick = ts; s.chain.primed_by = j.actor || 'chain'; break;
      case 'REPORT': {
        const t = s.tasks[j.task];
        if (t && ACTIVE_LEASE.has(t.status) && t.lease && t.lease.token === j.lease) {
          if (TASK_STATUSES.includes(j.to)) {
            t.status = j.to; t.updated = ts;
            t.history.push({ at: ts, status: j.to, why: 'replay:REPORT' });
            // F-F (T45): mirror the infra classes — infra-retry voids the
            // assignment (attempts-1, lease CLEARED — 'ready' is non-terminal
            // so the generic clear below does not cover it; omitting the
            // clear would leak the lease and break the F8 projection);
            // infra-exhausted is a normal terminal transition.
            // T46/F-B1: deadline mirrors the live reaper-equivalence —
            // attempt-burn, lease released, timeouts counted (retries too
            // when re-queued) — so the F8 projection converges on the new
            // class exactly as it does on TIMEOUT records.
            if (j.reason === 'infra-retry') {
              t.attempts = Math.max(0, t.attempts - 1);
              t.lease = null;
              t.infra_attempts = (t.infra_attempts ?? 0) + 1;
              s.stats.infra_retries += 1;
            } else if (j.reason === 'deadline') {
              s.stats.timeouts += 1;
              // released in EVERY dest: 'ready' needs the explicit clear
              // (non-terminal); the terminal dests need it too — this branch
              // shadows the generic TERMINAL clear below, so it clears here
              t.lease = null;
              if (j.to === 'ready') s.stats.retries += 1;
            } else {
              if (j.reason === 'infra-exhausted') t.infra_attempts = (t.infra_attempts ?? 0) + 1;
              if (TERMINAL.has(j.to)) t.lease = null;
            }
          }
        }
        break;
      }
      case 'TASK_CREATED': {
        if (j.spec && j.spec.id && !s.tasks[j.spec.id]) s.tasks[j.spec.id] = mkTask(j.spec, ts);
        break;
      }
      case 'TIMEOUT': {
        const t = s.tasks[j.task];
        if (t && (t.status === j.from || ACTIVE_LEASE.has(t.status))) {
          t.status = j.to; t.updated = ts; t.lease = null;
          t.history.push({ at: ts, status: j.to, why: 'replay:TIMEOUT' });
          s.stats.timeouts += 1;
          if (j.to === 'ready') s.stats.retries += 1;   // F8: mirror live
        }
        break;
      }
      case 'UNLOCK': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: 'replay:UNLOCK' });
          // NOT a retry — live's UNLOCK pass touches no stat
        }
        break;
      }
      case 'RETRY': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: 'replay:RETRY' });
          if (j.to === 'ready') s.stats.retries += 1;
        }
        break;
      }
      case 'CANCEL_CASCADE': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: 'replay:CANCEL_CASCADE' });
        }
        break;
      }
      case 'ASSIGN': {
        const t = s.tasks[j.task];
        if (t && t.status === 'ready') {
          t.status = 'assigned'; t.updated = ts; t.attempts += 1;
          t.lease = { token: j.lease, expires: j.expires, issued_at: ts };
          t.history.push({ at: ts, status: 'assigned', why: `replay:ASSIGN(attempt=${t.attempts})` });
          s.stats.dispatched += 1;
        }
        break;
      }
      case 'MILESTONE': {
        for (const spec of j.tasks || []) if (!s.tasks[spec.id]) s.tasks[spec.id] = mkTask(spec, ts);
        s.project.milestone = j.milestone;
        s.project.phase = 'executing';
        break;
      }
      case 'PHASE': {
        s.project.phase = j.to;
        if (j.to === 'done') s.chain.halted = true;
        break;
      }
      case 'CONTROL': {
        // F8: reset replays from the journaled slim genesis spec (a reset IS
        // a new epoch; the snapshot-in-journal is the honest representation).
        if (j.command === 'reset' && j.genesisSpec) {
          const sp = j.genesisSpec;
          const g = genesis({
            config: sp.config,
            project: { tasks: sp.tasks, milestones: sp.milestones ?? 1 },
            chainId: sp.chainId,
            now: sp.now || ts,
            // T46/F-B2: the reset spec carries the epoch's harness mode; a
            // legacy spec without it defaults to 'mock' inside genesis()
            mode: sp.mode,
            // T46/W-C1 (m-3): the intake thread survives replay — an
            // intake-born epoch's issue rides the genesisSpec.
            issue: sp.issue ?? null,
          });
          g.journal_seq = s.journal_seq;
          s = g;
        } else if (j.command === 'configure' && j.patch) {
          for (const [k, v] of Object.entries(j.patch)) s.config[k] = v;
        } else if (j.command === 'pause') {
          s.chain.paused = true;
          // T46/W-C1 (F-7): rebuild derives paused_reason from the journaled
          // payload (the projection rule — live and replay converge).
          if (j.payload && typeof j.payload.reason === 'string' && j.payload.reason) {
            s.chain.paused_reason = String(j.payload.reason).slice(0, 80);
            s.stats.budget_pauses = (s.stats.budget_pauses ?? 0) + 1;
          }
        } else if (j.command === 'resume') {
          s.chain.paused = false;
          delete s.chain.paused_reason;
          s.budget_window = [];   // resume declares the trigger memory stale
        } else if (j.command === 'halt') s.chain.halted = true;
        else if (j.command === 'unhalt') s.chain.halted = false;
        break;
      }
      case 'RECOVERY': break;  // epoch marker only — no state change
      // T46/W-C1: BUDGET (dispatch-paced audit) and PRUNE (state-level
      // projection) are rebuild-skippable — the pause they accompany is the
      // durable fact (the CONTROL record); pruning re-applies on the next
      // live clock pass (idempotent, the pruned marker).
      case 'BUDGET': break;
      case 'PRUNE': break;
      default: break;
    }
    recount(s);
    // F8: mirror live's version discipline — one bump per APPLIED non-TICK,
    // non-RECOVERY record (live: bumpVersion at transition/TASK_CREATED/
    // CONTROL/clock-transition sites; never on TICK or rejections). The RESET
    // record does NOT bump: it wholesale-replaces the state (genesis v=1).
    if (!(j.kind === 'TICK' || j.kind === 'RECOVERY' || (j.kind === 'CONTROL' && j.command === 'reset'))) s.version += 1;
    s.journal_seq = Math.max(s.journal_seq, (parseInt((j.id || 'e0').slice(1), 10) || 0) + 1);
  }
  return s;
}
