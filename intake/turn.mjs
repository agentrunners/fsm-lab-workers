// intake/turn.mjs — the intake door's I/O HALF (T46/W-C1 §4c, lane B
// finished by the orchestrator after the agent died mid-lane — the store
// queue + lib/intake.mjs pure half were landed; this file + intake.yml +
// test-intake.mjs + the TTL pin + the README contract are the completion).
//
// Mirrors ops/turn.mjs's shape: the door runs in its OWN workflow with its
// OWN concurrency group (never contends with the hot conductor chain). The
// decision core is lib/intake.mjs (zero I/O); this file owns ONLY transport:
// the permission API call, the issue comments (law-5 checked), the queue
// CAS push, and the conductor nudge.
//
// Wake: issues[opened | reopened] (intake.yml — GITHUB_TOKEN ONLY, no
// secrets.* anywhere: the F-2 security contract's per-workflow form).
//
// Exit codes (visible, never silently green):
//   0 — door decided + executed (enqueued, rejected-with-comment, or silent)
//   2 — a comment POST failed (law 5: the lane's health is part of the job)
//   3 — the nudge dispatch failed (the queue line still holds; the next
//       tick/backstop/pinger still drains it — degraded, not lost)

import { Store } from '../lib/store.mjs';
import { doorDecide, bodySha8 } from '../lib/intake.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const TOKEN = process.env.GH_TOKEN;   // the JOB token — the door's ONLY credential
const EVENT = JSON.parse(process.env.EVENT || '{}');

async function api(path, method = 'GET', body = null) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-intake',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies */ }
  return { status: r.status, data };
}

async function postComment(issue, body) {
  const r = await api(`/repos/${REPO}/issues/${issue}/comments`, 'POST', { body });
  return r.status === 201;
}

async function nudgeTick() {
  // wake the conductor so the queue drains within seconds (a halted chain's
  // rollover fires on this nudge; an active epoch's tick parks harmlessly —
  // the nudge is one dispatch, GITHUB_TOKEN, the X1a same-repo exception)
  const post = async () => {
    const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'fsm-lab-intake',
      },
      body: JSON.stringify({ event_type: 'fsm-tick', client_payload: { reason: 'intake' } }),
      signal: AbortSignal.timeout(20_000),
    });
    return r.status;
  };
  let status = await post();
  if (status !== 204) {
    await new Promise(res => setTimeout(res, 2000));
    status = await post();
  }
  return status;
}

async function main() {
  const it = EVENT.issue;
  if (!it || !it.number) {
    console.error('INTAKE-SKIP: no issue on the event (the workflow pins issues[opened|reopened] — nothing to do)');
    return;
  }
  const author = it.user?.login || null;
  const isBot = author == null ? true : author.endsWith('[bot]');
  const store = new Store({ cwd: process.cwd() });

  // the pre-pass: bots exit BEFORE any API call (loop safety — the door
  // must never wake itself; GITHUB_TOKEN comments fire no issue_comment
  // anyway, but a bot-OPENED issue would still burn the permission call)
  if (isBot) {
    console.log(`INTAKE-SILENT bot author ${author} — no comment, no enqueue, zero API calls`);
    return;
  }

  // the permission gate (fail-closed): non-200 → null → doorDecide rejects
  let permission;
  {
    const r = await api(`/repos/${REPO}/collaborators/${encodeURIComponent(author)}/permission`);
    if (r.status === 200 && r.data && typeof r.data.permission === 'string') {
      permission = r.data.permission;
    } else {
      permission = null;
      console.log(`INTAKE-PERMISSION-UNVERIFIED HTTP=${r.status} (fail-closed — the door rejects)`);
    }
  }

  const queue = store.readIntakeQueue();
  const d = doorDecide({ author, isBot, permission, body: it.body || '', issue: it.number, queue });

  if (d.decision === 'silent') {
    console.log(`INTAKE-SILENT issue #${it.number} (${d.comment ? 'idempotent-dedup' : 'bot'})`);
    if (d.comment) {
      // the dedup note is informational — a failed POST is visible but not
      // fatal (exit 2 would re-run the door on re-open for a comment that
      // carries no state)
      const okc = await postComment(it.number, d.comment);
      console.log(`INTAKE-DEDUP-COMMENT ${okc ? 'ok' : 'FAILED (non-fatal — informational only)'}`);
    }
    return;
  }

  if (d.decision === 'reject') {
    const okc = await postComment(it.number, d.comment);
    console.log(`INTAKE-REJECTED issue #${it.number} by @${author} (permission=${permission ?? 'unverified'}) — ${okc ? 'comment posted' : 'COMMENT FAILED'}`);
    if (!okc) process.exitCode = 2;   // law 5: the reject lane's health is visible
    return;
  }

  // enqueue: the CAS append (the enqueueControl pattern — fetch/merge/push
  // with retries inside store.enqueueIntake)
  const rec = {
    issue: it.number,
    body_sha8: bodySha8(it.body || ''),
    spec: d.spec,
    enqueued_at: new Date().toISOString(),
    author,
  };
  // W-C1-R (lens-1 MINOR-4): the dedup predicate rides the CAS loop itself
  // (store.enqueueIntake re-checks it on every fresh read) — the TOCTOU
  // double-enqueue of a same-issue+same-body race dies here, not at the
  // door's pre-read
  const r = store.enqueueIntake(rec, {
    matches: (l) => String(l.issue) === String(rec.issue) && l.body_sha8 === rec.body_sha8,
  });
  if (r.deduped) {
    console.log(`INTAKE-DEDUPED issue #${it.number} (the line landed between the read and the push — the race loser exits clean)`);
    return;
  }
  console.log(`INTAKE-ENQUEUED issue #${it.number} id=${d.id} sha8=${rec.body_sha8} -> ${r.ok ? 'ok' : 'FAILED: ' + (r.err || 'unknown')}`);
  if (!r.ok) { process.exitCode = 1; return; }

  // the position comment (once, at enqueue — §2d: never per tick)
  if (queue.length > 0) {
    const okc = await postComment(it.number, `**[fsm-intake]** Queued behind the active epoch — position ${queue.length + 1}. The conductor drains the queue at the next epoch boundary (the rollover).`);
    if (!okc) console.log('INTAKE-POSITION-COMMENT-FAILED (non-fatal — the queue line holds)');
  }

  // the nudge: seconds-latency drain instead of backstop cadence
  const status = await nudgeTick();
  console.log(`INTAKE-NUDGE tick dispatch HTTP=${status}`);
  if (status !== 204) {
    console.error('INTAKE-NUDGE failed (the spec is queued; the next tick/backstop/pinger still drains it)');
    process.exitCode = 3;
  }
}

main().catch(e => { console.error('INTAKE-FAILED:', e.message); process.exitCode = 1; });
