// conductor-core.mjs — the conductor's turn ALGORITHM, extracted from
// conductor/turn.mjs's mutate closure (T44/F15). Everything I/O-shaped (the
// git store, the GitHub API, env parsing, pacing, self-dispatch) stays in
// the adapter; this module is the pure-ish drain+apply+commit-shaping core
// that ALL FOUR test layers drive (unit tests, store tests, the sim, the
// GHA adapter) — closing the "integration logic lives in turn-files" gap
// that let five live bug classes escape every local layer.
//
// CONTRACT
//   conductorTick({ cur, queue, controlQueue, queueBad, ctlBad, ev, now,
//                   nextMilestone, recover, makeGenesis })
//     -> { state, journal, actions, queue: [], controlQueue: [],
//          noop?, reason, message }
//
//   cur / queue / controlQueue / queueBad / ctlBad — exactly what
//     Store.commit() hands its mutate callback (the on-branch state read +
//     the parsed queue items + the unparseable lines).
//   now   — a FUNCTION. The conductor stamps multiple ts values per commit
//     (journal ts, apply() timestamps, genesis stamps); it is never
//     collapsed to one value. (P3 finding from the 44-d fidelity audit.)
//   recover() -> { state, reason: 'bootstrap' | 'history-walk',
//                   journalMaxId?, dropFrom?, droppedRecords?, snapshotSha? }
//     | { state: null, reason: 'bootstrap', journalMaxId } | null — injected
//     closure (cur is null: walk git history for a parseable snapshot, or
//     return null to force fresh genesis). The store I/O stays out of this
//     module. F-A (T45): journalMaxId (the newest on-branch journal id)
//     reconciles the id space on EVERY repair shape; dropFrom (the snapshot's
//     pre-repair journal_seq) arms store.commit()'s rollback sweep and
//     droppedRecords/snapshotSha enrich the RECOVERY record (audit). A
//     state:null marker with journalMaxId = bootstrap-ON-AN-EXISTING-BRANCH
//     (fresh genesis, ids reconciled above the leftover journal).
//   makeGenesis({ config }?) -> { state, spec } — injected closure; a fresh
//     genesis state plus the SLIM journal-spec pieces
//     { tasks, milestones, chainId } the reset record embeds (rebuild()
//     replays them). `config` adopts the current config on reset (F12).
//   nextMilestone — the project generator hook (fsm.clock).
//
// PRESERVED VERBATIM through the extraction (the 44-f amendments — the trap
// doors; each has a regression test in tests/test-conductor-core.mjs):
//   - the noop gate keys on the ACCUMULATED journal (drain + wake + repair)
//     — NEVER the wake event's journal alone (probe 2c: a wake-journal-only
//     gate stalls project completion forever: the final report drain halts
//     the chain mid-mutate and the PHASE/STOP records must still land).
//   - the unified reset path: a direct reset becomes a PREPENDED control
//     item; ONE drain handles queued+direct resets; reports drain AFTER the
//     reset (rejected as unknown-task against the fresh genesis, journaled,
//     consumed — auditable, nothing silently dropped).
//   - control-first drain ordering; consume-everything semantics
//     (queue: [], controlQueue: []).
//   - the RECOVERY record + repair-forces-commit (A2); the
//     BOOTSTRAP_NOTICE / RECOVERY_NOTICE actions.
//   - invariants() fail-closed INSIDE (throws pre-commit).
//   - the reset journal record's slim genesisSpec
//     { config, tasks, milestones, chainId, now, journal_seq }.
//   - unparseable-line REJECTED records (queueBad/ctlBad) + the stats
//     counter.

import { apply, invariants } from './fsm.mjs';

// ---------------------------------------------------------------------------
// F-C (T45): the per-turn dispatch budget vs the job TTL — pure arithmetic,
// unit-testable without I/O. The conductor turn's worst case (pacing 240s +
// k×240s worker dispatches + 240s self-tick) exceeds the 10-min job TTL at
// k=1: the job dies MID-DISPATCH (exit 3 unreachable, leases already
// committed, the self-tick lost) — the dead-chain blind window. The budget
// makes every call FIT or SKIP loudly.
//
// makeBudget({ startMs, ttlMs, safetyMs, nowMs }) ->
//   { deadlineMs, remaining(), clamp(ms), fits(minMs) }
//   remaining() = startMs + ttlMs - safetyMs - now()   (may go negative —
//     every consumer floors at 0 before use)
//   clamp(ms)   = max(0, min(ms, remaining()))         (clamp a requested
//     wait/budget to what actually fits)
//   fits(minMs) = remaining() >= minMs                 (the skip threshold)
//
// The ADAPTER owns the reserve discipline (R3 D1-M2, hardened): every WORKER
// ladder's budget is max(0, remaining() - SELF_TICK_RESERVE) — the heartbeat
// window is carved out FIRST, so no Retry-After ladder can starve the
// self-tick; the self-tick itself gets the full remaining() (it is the turn's
// LAST call).
// ---------------------------------------------------------------------------
export function makeBudget({ startMs, ttlMs, safetyMs = 45_000, nowMs = () => Date.now() } = {}) {
  const deadlineMs = startMs + ttlMs - safetyMs;
  const remaining = () => deadlineMs - nowMs();
  return {
    deadlineMs,
    remaining,
    clamp: (ms) => Math.max(0, Math.min(ms, remaining())),
    fits: (minMs) => remaining() >= minMs,
  };
}

export function conductorTick({
  cur, queue = [], controlQueue = [], queueBad = [], ctlBad = [],
  ev, now, nextMilestone, recover, makeGenesis,
}) {
  let base = cur;
  let repaired = null;
  let rec = null;
  if (!base) {
    rec = recover ? recover() : null;
    if (rec && rec.state) {
      base = rec.state;
      repaired = rec.reason || 'history-walk';
    } else {
      const g = makeGenesis();
      base = g.state;
      repaired = 'bootstrap';
    }
    // F-A (T45): reconcile the id space with the ON-BRANCH journal BEFORE
    // the first mkJ. A rollback snapshot's journal_seq can sit BELOW ids
    // already on the retained gen files (the corrupt era journaled past the
    // snapshot); minting from the snapshot alone re-uses ids = duplicate
    // primary keys (probe1 CHECK1) and journal_seq <= max on-branch id
    // (CHECK2). Applies to history-walk AND bootstrap-on-existing-branch.
    const maxId = rec?.journalMaxId;
    if (Number.isFinite(maxId) && maxId + 1 > base.journal_seq) {
      base.journal_seq = maxId + 1;
    }
  }
  // hand-crafted journal records (ids from the CURRENT journal_seq)
  const journals = [];
  const actionsAll = [];
  const mkJ = (s, fields, applied = true) => {
    const id = `e${s.journal_seq}`;
    s.journal_seq += 1;
    journals.push({ id, ts: now(), applied, ...fields });
  };

  // DRAIN: control queue FIRST (pause/resume/reset/configure gate the
  // rest). F1: controls are CONSUMED applied-or-rejected — reject reasons
  // are permanent (bad-command / phase-done / bad-patch), never reparked.
  // T44 restructure: ONE drain path — the direct-dispatch reset becomes a
  // prepended control-queue item (the old special case returned before the
  // report drain and silently DELETED queued reports/controls, unjournaled).
  const ctl = [];
  if (ev.kind === 'CONTROL' && ev.command === 'reset') {
    // T45/F-G(c): the direct reset carries the sender + note like queued ones
    ctl.push({ cmd: 'reset', id: ev.event_id, ts: ev.ts, direct: true, sender: ev.actor ?? null, note: ev.note ?? null });
  }
  ctl.push(...controlQueue);
  let s = base;
  const skipWake = ev.kind === 'CONTROL' && ev.command === 'reset';
  let resetDone = false;
  for (const c of ctl) {
    if (c.cmd === 'reset') {
      // reset: fresh project instance (ADOPTS the current config — F12;
      // the journal carries the slim genesis spec so rebuild() replays it)
      const cfg = { ...s.config, tick_min_interval_s: Math.max(s.config.tick_min_interval_s ?? 0, 25) };
      const g = makeGenesis({ config: cfg });
      const seqBase = s.journal_seq;
      g.state.journal_seq = seqBase + 1;
      mkJ(s, {
        kind: 'CONTROL', command: 'reset',
        actor: c.sender ?? null,
        note: c.note != null && String(c.note) !== '' ? String(c.note).slice(0, 200) : null,
        genesisSpec: {
          config: cfg, tasks: g.spec.tasks, milestones: g.spec.milestones,
          chainId: g.spec.chainId, now: now(), journal_seq: seqBase,
        },
      });
      s = g.state;
      resetDone = true;
      console.log(`RESET (${c.direct ? 'direct' : 'queued'}) control ${c.id}: new chain ${s.chain.id}`);
      continue;
    }
    // T45/F-G(c): the CONTROL event carries the sender (actor) + note so the
    // journal record can answer "who commanded this" — audit-only fields,
    // never a behavior gate (the ops WRITE gate stays GitHub's model)
    const cev = { kind: 'CONTROL', command: c.cmd, patch: c.patch, actor: c.sender ?? null, note: c.note ?? null, event_id: c.id, ts: c.ts || now() };
    const cr = apply(s, cev, now(), nextMilestone);
    s = cr.state;
    journals.push(...cr.journal);
    actionsAll.push(...cr.actions);
    if (!cr.applied && cr.reason !== 'duplicate') {
      console.log(`CONTROL-REJECTED ${c.cmd} (${c.id}): ${cr.reason}`);
    }
  }
  // unparseable control lines: audited then dropped (the rewrite removes them)
  for (const raw of ctlBad) {
    mkJ(s, { kind: 'REJECTED', origKind: 'CONTROL', reason: 'unparseable', raw: String(raw).slice(0, 160) }, false);
    s.stats.rejected_events += 1;  // 44-h P2c: count like every other reject
  }

  // DRAIN: report queue. F1: consumed applied-or-rejected — every reject
  // reason is permanent (unknown-task / task-not-leased / stale-lease /
  // bad-outcome), and F11's early pushDedup makes any re-enqueue of the
  // same event_id a duplicate. The zombie-park loop (re-rejecting the
  // same lines every tick, forever) is dead by construction. Reports are
  // NOT pause-gated — at-least-once drain (a held chain still consumes its
  // queue; a tick wake on the held chain is the only non-event).
  let drained = 0;
  for (const q of queue) {
    const rev = { kind: 'REPORT', event_id: q.event_id, task: q.task, lease: q.lease, outcome: q.outcome, run_id: q.run_id };
    const rr = apply(s, rev, now(), nextMilestone);
    s = rr.state;
    journals.push(...rr.journal);
    actionsAll.push(...rr.actions);
    drained++;
  }
  for (const raw of queueBad) {
    mkJ(s, { kind: 'REJECTED', origKind: 'REPORT', reason: 'unparseable', raw: String(raw).slice(0, 160) }, false);
    s.stats.rejected_events += 1;
  }

  // wake event (a direct reset WAS the control — already applied above)
  let wakeApplied = false, wakeReason = 'ok';
  if (!skipWake) {
    const r = apply(s, ev, now(), nextMilestone);
    s = r.state;
    journals.push(...r.journal);
    actionsAll.push(...r.actions);
    wakeApplied = r.applied;
    wakeReason = r.reason;
  }

  // fail-closed: invariant violations never commit (unchanged discipline)
  const viol = invariants(s);
  if (viol.length) throw new Error(`INVARIANT VIOLATION: ${viol.join('; ')}`);

  // A2: repair forces the commit — under quiescence a recovered state
  // must PERSIST or corruption never heals (red-team probe: 3 wakes, tip
  // frozen, state still corrupt). RECOVERY journals the epoch boundary.
  // F-A (T45): the record carries the rollback's audit — dropFrom (what the
  // store's sweep arms on), droppedRecords (what it voided), snapshotSha
  // (the state the repair rolled back TO).
  if (repaired) {
    mkJ(s, {
      kind: 'RECOVERY', reason: repaired,
      dropFrom: Number.isFinite(rec?.dropFrom) ? rec.dropFrom : null,
      droppedRecords: Number.isFinite(rec?.droppedRecords) ? rec.droppedRecords : null,
      snapshotSha: rec?.snapshotSha || null,
    });
    if (repaired === 'bootstrap') actionsAll.push({ type: 'BOOTSTRAP_NOTICE', reason: repaired });
    else actionsAll.push({ type: 'RECOVERY_NOTICE', reason: repaired });
    console.log(`RECOVERY: base rebuilt from ${repaired === 'bootstrap' ? 'fresh genesis (state branch was absent or history unreadable)' : 'git-history snapshot'}`);
  }

  // F2 noop gate — on the ACCUMULATED journal (drain + wake), never the
  // wake event alone: a drain that halts the chain mid-mutate still
  // commits (its PHASE/STOP records must land).
  if (journals.length === 0 && !wakeApplied && !repaired) {
    return { noop: true, reason: wakeReason || 'quiesced', state: s };
  }
  return {
    state: s, journal: journals, actions: actionsAll,
    queue: [], controlQueue: [],   // F1: the drain consumed everything
    reason: wakeReason || 'ok',
    // F-A: arms store.commit()'s rollback sweep (drop records with
    // idNum >= dropFrom out of the retained gens) — history-walk repairs only
    ...(repaired && Number.isFinite(rec?.dropFrom) ? { journalDropFrom: rec.dropFrom } : {}),
    message: `${skipWake ? 'reset' : ev.kind}${drained ? `+${drained}r` : ''} seq=${s.chain.seq} v${s.version} done=${s.stats.done} [${journals[0]?.id}..${journals[journals.length - 1]?.id}]${resetDone ? ' RESET' : ''}${repaired ? ' RECOVERED' : ''}`,
  };
}
