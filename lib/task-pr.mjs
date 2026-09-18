// lib/task-pr.mjs — T46/W-C2 (§4): the task-branch/PR flow, conductor side.
//
// The CONTRACT (t46-wc2-brief.md §1, F-4/F-14 + m-3):
//   On a tick whose committed state contains a DONE task with DECLARED
//   artifacts (spec.artifacts) in a CC epoch and no `pr` stamp yet:
//     1. open PR `tasks/<id>` → main (title `task/<id>: <title>`, body =
//        the accept criteria + the report digest + the transcript pointer)
//     2. idempotence: an OPEN PR for the head already exists → reuse it;
//        a MERGED/CLOSED one (state=all probe) → reuse its NUMBER for the
//        stamp (the work landed; re-opening a merged task's diff is a
//        422-livelock — the W-C2-R L2-9 fold)
//     3. token ladder: GITHUB_TOKEN first (pull-requests:write per F-14 +
//        the repo's can_approve setting), LAB_PAT fallback on 403 ONLY
//        (422 is validation, not permission — the PAT retry is wasted)
//     4. the PR number lands in the task record (`pr: <n>`) via a SECOND
//        commit (the two-commit pattern) + a pointer-only journal REPORT
//        record (law 6 — the journal references, never carries, the
//        artifact); the record is REBUILD-REPLAYABLE (fsm.mjs replays a
//        lease-free REPORT-with-pr as a pr-stamp — the W-C2-R F1 fold)
//     5. PR-open failure = an ops-issue alert comment (law 5), NOT a run
//        failure — the epoch still completes; a DEFERRED remainder
//        (candidates beyond the per-tick cap or the budget guard) alerts
//        once too (the F4 fold: a halted epoch's deferred PRs were
//        previously invisible — no next tick, no alert, never opened)
//   Mock epochs skip (§4c): no declared artifacts → no branch, no PR.
//
// Pure decision helpers + injected-I/O drivers (REST + store.commit) — the
// conformance pattern: NO live API calls in tests, every seam injectable.

// F4 (W-C2-R): 12 covers every live shape (intake epochs = 1 task; W-D's
// multi-task epochs cap at max_parallel-per-tick drains) while the remainder
// alert below makes any overflow VISIBLE instead of permanently deferred.
export const PR_MAX_PER_TICK = 12;

// prFlowCandidates(state) — the pure decision: which done tasks get a PR
// this tick. Order: task id (deterministic; capped at PR_MAX_PER_TICK).
// T46/W-C2-R (F7): the conductor passes the PRE-ROLLOVER view of the state
// (conductorTick's out.prCandidates) — a same-tick intake rollover replaces
// out.state with the NEXT epoch and the completing epoch's PRs would vanish
// (the BLOCKING lens-1 finding: nothing can ever re-select the completed
// tasks once the rollover consumes them).
export function prFlowCandidates(state) {
  if (!state || state.project?.mode !== 'cc') return [];   // §4c: cc epochs only
  const tasks = state.tasks || {};
  const out = [];
  for (const id of Object.keys(tasks).sort()) {
    const t = tasks[id];
    if (!t || t.status !== 'done') continue;
    if (t.pr) continue;                                    // already stamped
    const arts = Array.isArray(t.spec?.artifacts) ? t.spec.artifacts : [];
    if (!arts.length) continue;                            // no declared artifacts → no PR
    out.push({ id, task: t, branch: `tasks/${id}`, artifacts: arts });
    if (out.length >= PR_MAX_PER_TICK) break;
  }
  return out;
}

// buildPrBody(task) — the pure composer: accept criteria + the report
// digest + the transcript pointer. T46/W-C2-R (F3): the transcript path is
// derived from the task record's REAL fields — last_result.run_id (the
// worker job's run id, present on every done record) + the attempts count —
// NEVER a fabricated last_lease field (the FSM mints no such field; the
// original derivation was dead code and its pin lied).
// Every string passes the fence-neutralizer (W-C2-R m1: ``` AND <), bounded.
const neut = (s, cap) => String(s ?? '')
  .replace(/</g, '\u2039')
  .replace(/```/g, "```​")   // zero-width joiner breaks the fence marker
  .slice(0, cap);

export function buildPrBody(task) {
  const t = task || {};
  const lines = [];
  lines.push('## Task write-back');
  lines.push('');
  lines.push(`Task \`${neut(t.id, 80)}\`${t.title ? ` — ${neut(t.title, 240)}` : ''} completed; the declared artifacts are committed on this branch (\`tasks/${t.id}\`, written by the worker through the write-back door).`);
  if (t.spec?.accept) {
    lines.push('');
    lines.push('**Accept criteria** (from the intake spec):');
    lines.push(neut(t.spec.accept, 1200));
  }
  if (t.last_result?.artifact) {
    lines.push('');
    lines.push('**Result digest** (the worker report):');
    lines.push(neut(t.last_result.artifact, 600));
  }
  const runId = t.last_result?.run_id;
  if (runId) {
    const attempt = Number.isInteger(t.attempts) && t.attempts >= 1 ? t.attempts : 1;
    lines.push('');
    lines.push(`**Transcript**: \`sessions/${t.id}/${runId}-a${attempt}.txt\` (fsm-sessions branch).`);
  }
  lines.push('');
  lines.push('---');
  lines.push('_Auto-opened by the fsm conductor (T46/W-C2 §4). Merging is the principal\u2019s call._');
  return lines.join('\n');
}

// openTaskPr({repo, candidate, api, tokenFallback}) — the idempotent open.
// api(path, method, body, token) mirrors conductor/turn.mjs's helper.
// Returns {prn, reused, err} — prn null + err on total failure.
// W-C2-R folds: the reuse lane probes state=open FIRST, then state=all (a
// MERGED/CLOSED PR's number still stamps — the work landed); the ladder
// falls back to the PAT on 403 ONLY (m7: 422 is validation, not permission).
export async function openTaskPr({ repo, candidate, api, tokenFallback = null }) {
  const c = candidate || {};
  const head = `${repo.split('/')[0]}:${c.branch}`;
  // 1. an OPEN PR for this head → reuse (the stamp-crash survivor)
  const ex = await api(`/repos/${repo}/pulls?head=${encodeURIComponent(head)}&state=open`, 'GET', null);
  if (ex.status === 200 && Array.isArray(ex.data) && ex.data.length) {
    return { prn: ex.data[0].number, reused: true };
  }
  // 2. create — the token ladder: GITHUB_TOKEN first, PAT fallback on 403
  const body = {
    title: `task/${c.id}: ${neut(c.task?.title, 200) || 'artifacts'}`,
    head: c.branch,
    base: 'main',
    body: buildPrBody(c.task),
  };
  let r = await api(`/repos/${repo}/pulls`, 'POST', body);
  if (r.status === 403 && tokenFallback) {
    r = await api(`/repos/${repo}/pulls`, 'POST', body, tokenFallback);
  }
  if (r.status === 201 && r.data?.number) return { prn: r.data.number, reused: false };
  // 3. the merged/closed edge (W-C2-R L2-9): creation 422'd (e.g. "no
  // commits between" after a merge) — probe state=all and stamp that number
  // (re-opening a merged task's diff is a livelock; the audit just needs
  // the pointer). Still nothing → the total-failure lane.
  const any = await api(`/repos/${repo}/pulls?head=${encodeURIComponent(head)}&state=all`, 'GET', null);
  if (any.status === 200 && Array.isArray(any.data) && any.data.length) {
    return { prn: any.data[0].number, reused: true, closed: any.data[0].state !== 'open' };
  }
  return { prn: null, err: `PR-open HTTP ${r.status}: ${String(JSON.stringify(r.data) ?? '').slice(0, 160)}` };
}

// stampPr({store, id, prn, note}) — the second commit: task.pr = prn + a
// pointer-only journal REPORT record (law 6). The mutate closure is
// I/O-free and CAS-safe (re-runs on fresh cur): an already-stamped task
// (a raced twin) is a TRUE no-op (W-C2-R F2: noop:true — no empty commit,
// the store skips the write). The commit carries a real message (F2: the
// old shape landed "undefined" on fsm-state). The queues are returned
// UNTOUCHED (pass-through — store.commit only rewrites a queue file when
// the out carries an array for it).
export async function stampPr({ store, id, prn, now = () => new Date().toISOString() }) {
  return store.commit({
    message: `pr stamp: task ${id} -> #${prn} (pointer-only journal record, law 6)`,
    mutate: (cur) => {
      if (!cur || !cur.tasks?.[id] || cur.tasks[id].pr) {
        return { state: cur, journal: [], noop: true, reason: 'already-stamped-or-vanished' };
      }
      const s = cur;   // store.commit hands a writable structuredClone (the conductorTick contract)
      const rec = {
        id: `e${s.journal_seq}`,
        ts: now(),
        applied: true,
        kind: 'REPORT',
        task: id,
        to: s.tasks[id].status,
        pr: prn,
        note: 'pr-opened (pointer-only, law 6)',
      };
      s.journal_seq += 1;
      s.tasks[id].pr = prn;
      s.version += 1;
      return { state: s, journal: [rec] };
    },
  });
}

// prFlow({candidates, state, repo, api, store, tokenFallback, alert}) — the
// whole pass for ONE conductor tick. T46/W-C2-R (F7): candidates come from
// the conductor's PRE-ROLLOVER view (conductorTick's out.prCandidates);
// `state` remains the in-memory stamp target (the live state object).
// W-C2-R (F4): candidates beyond the cap → deferred → ONE alert (a halted
// epoch has no next tick — silence would be permanent). Returns
// {candidates, opened, reused, stamped, failures, deferred} for the log.
export async function prFlow({ candidates, state, repo, api, store, tokenFallback = null, alert = null, now = () => new Date().toISOString(), log = console.log }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const capped = list.slice(0, PR_MAX_PER_TICK);
  const out = { candidates: list.length, opened: 0, reused: 0, stamped: 0, failures: 0, deferred: list.length - capped.length, links: [] };
  for (const c of capped) {
    const r = await openTaskPr({ repo, candidate: c, api, tokenFallback });
    if (!r.prn) {
      out.failures++;
      log(`PR-OPEN-FAILED task=${c.id} ${r.err} (law 5: alert, non-fatal — the epoch still runs)`);
      if (alert) await alert(`**[fsm-alert]** task ${c.id} PR-open FAILED — ${r.err}. The artifacts sit on branch \`${c.branch}\` (verify it exists); re-open the PR manually or reset the task.`);
      continue;
    }
    if (r.reused) out.reused++; else out.opened++;
    out.links.push({ id: c.id, prn: r.prn, ...(r.closed ? { closed: true } : {}) });
    const st = await stampPr({ store, id: c.id, prn: r.prn, now });
    if (st.committed) {
      out.stamped++;
      if (state?.tasks?.[c.id]) state.tasks[c.id].pr = r.prn;   // in-memory: the completion comment carries the link (m-3)
    } else {
      log(`PR-STAMP-SKIPPED task=${c.id} (${st.reason}) — the PR #${r.prn} exists; the next tick re-stamps via the reuse lane`);
    }
  }
  // F4: the deferred remainder is VISIBLE (one alert per tick while it
  // persists) — a completing+halted epoch has no next tick to drain it.
  if (out.deferred > 0 && alert) {
    await alert(`**[fsm-alert]** PR flow deferred ${out.deferred} task(s) this tick (cap ${PR_MAX_PER_TICK}) — a halted chain will NOT drain them automatically; dispatch a manual tick or open them from \`tasks/<id>\` branches.`);
  }
  return out;
}
