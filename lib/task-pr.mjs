// lib/task-pr.mjs — T46/W-C2 (§4): the task-branch/PR flow, conductor side.
//
// The CONTRACT (t46-wc2-brief.md §1, F-4/F-14 + m-3):
//   On a tick whose committed state contains a DONE task with DECLARED
//   artifacts (spec.artifacts) in a CC epoch and no `pr` stamp yet:
//     1. open PR `tasks/<id>` → main (title `task/<id>: <title>`, body =
//        the accept criteria + the report digest + the transcript pointer)
//     2. idempotence: an OPEN PR for the head already exists → reuse it
//        (survives a stamp-commit failure without duplicating)
//     3. token ladder: GITHUB_TOKEN first (pull-requests:write per F-14 +
//        the repo's can_approve setting), LAB_PAT fallback (PAT-lane
//        PR-creation needs no setting — live-proven PR#5 open/close)
//     4. the PR number lands in the task record (`pr: <n>`) via a SECOND
//        commit (the established two-commit pattern) + a pointer-only
//        journal REPORT record (law 6 — the journal references, never
//        carries, the artifact)
//     5. PR-open failure = an ops-issue alert comment (law 5), NOT a run
//        failure — the epoch still completes
//   Mock epochs skip (§4c): no declared artifacts → no branch, no PR.
//
// Pure decision helpers + injected-I/O drivers (REST + store.commit) — the
// conformance pattern: NO live API calls in tests, every seam injectable.

export const PR_MAX_PER_TICK = 4;   // bounded: a drain completing many artifacts tasks opens at most 4 PRs per tick; the rest next tick (the tick stays short)

// prFlowCandidates(state) — the pure decision: which done tasks get a PR
// this tick. Order: task id (deterministic; capped at PR_MAX_PER_TICK).
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
// digest + the transcript pointer. The transcript path is derived from the
// task's LAST lease/session when present (sessions/<task>/<run>-a<n>) —
// derived, never trusted off the task record (the spec-data discipline:
// every string passes the fence-neutralizer, bounded).
const neut = (s, cap) => String(s ?? '').replace(/</g, '\u2039').slice(0, cap);

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
  const sess = typeof t.last_lease?.session === 'string' && t.last_lease.session ? t.last_lease.session : null;
  if (sess) {
    const run = sess.split('/').pop() || '';
    if (run) {
      lines.push('');
      lines.push(`**Transcript**: \`sessions/${t.id}/${run}.txt\` (fsm-sessions branch).`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('_Auto-opened by the fsm conductor (T46/W-C2 §4). Merging is the principal\u2019s call._');
  return lines.join('\n');
}

// openTaskPr({repo, owner, candidate, api, tokenFallback}) — the idempotent
// open. api(path, method, body, token) mirrors conductor/turn.mjs's helper.
// Returns {prn, reused, err} — prn null + err on total failure.
export async function openTaskPr({ repo, candidate, api, tokenFallback = null }) {
  const c = candidate || {};
  // 1. existing OPEN PR for this head → reuse (the stamp-crash survivor)
  const head = `${repo.split('/')[0]}:${c.branch}`;
  const ex = await api(`/repos/${repo}/pulls?head=${encodeURIComponent(head)}&state=open`, 'GET', null);
  if (ex.status === 200 && Array.isArray(ex.data) && ex.data.length) {
    return { prn: ex.data[0].number, reused: true };
  }
  // 2. create — the token ladder: GITHUB_TOKEN first, PAT fallback
  const body = {
    title: `task/${c.id}: ${neut(c.task?.title, 200) || 'artifacts'}`,
    head: c.branch,
    base: 'main',
    body: buildPrBody(c.task),
  };
  let r = await api(`/repos/${repo}/pulls`, 'POST', body);
  if ((r.status === 403 || r.status === 422) && tokenFallback) {
    r = await api(`/repos/${repo}/pulls`, 'POST', body, tokenFallback);
  }
  if (r.status === 201 && r.data?.number) return { prn: r.data.number, reused: false };
  return { prn: null, err: `PR-open HTTP ${r.status}: ${String(JSON.stringify(r.data) ?? '').slice(0, 160)}` };
}

// stampPr({store, id, prn, note}) — the second commit: task.pr = prn + a
// pointer-only journal REPORT record (law 6). The mutate closure is
// I/O-free and CAS-safe (re-runs on fresh cur): an already-stamped task
// (a raced twin) is a no-op journal-free pass-through. The queues are
// returned UNTOUCHED (pass-through — store.commit only rewrites a queue
// file when the out carries an array for it).
export async function stampPr({ store, id, prn, now = () => new Date().toISOString() }) {
  return store.commit({
    mutate: (cur) => {
      if (!cur || !cur.tasks?.[id] || cur.tasks[id].pr) {
        return { state: cur, journal: [] };   // raced twin or vanished task — no-op (store.commit: out.journal)
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

// prFlow({state, repo, api, store, tokenFallback, alert}) — the whole pass
// for ONE conductor tick. Returns {opened, reused, stamped, failures} for
// the log line. `alert(msg)` = the ops-issue comment lane (law 5).
export async function prFlow({ state, repo, api, store, tokenFallback = null, alert = null, now = () => new Date().toISOString(), log = console.log }) {
  const candidates = prFlowCandidates(state);
  const out = { candidates: candidates.length, opened: 0, reused: 0, stamped: 0, failures: 0 };
  for (const c of candidates) {
    const r = await openTaskPr({ repo, candidate: c, api, tokenFallback });
    if (!r.prn) {
      out.failures++;
      log(`PR-OPEN-FAILED task=${c.id} ${r.err} (law 5: alert, non-fatal — the epoch still runs)`);
      if (alert) await alert(`**[fsm-alert]** task ${c.id} PR-open FAILED — ${r.err}. The artifacts sit on branch \`${c.branch}\` (verify it exists); re-open the PR manually or reset the task.`);
      continue;
    }
    if (r.reused) out.reused++; else out.opened++;
    const st = await stampPr({ store, id: c.id, prn: r.prn, now });
    if (st.committed) {
      out.stamped++;
      state.tasks[c.id].pr = r.prn;   // in-memory: the completion comment carries the link (m-3)
    } else {
      log(`PR-STAMP-SKIPPED task=${c.id} (${st.reason}) — the PR #${r.prn} exists; the next tick re-stamps via the reuse lane`);
    }
  }
  return out;
}
