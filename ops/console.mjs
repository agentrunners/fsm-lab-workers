// ops/console.mjs — the OPS CONSOLE (T46/W-C2 lane C, §6; F-12/F-13 + m-8).
//
// The comment-command surface on the OPS issue: an issue_comment[created] on
// the ops issue authored by a write-class collaborator becomes a control
// queue record (the SAME git-CAS lane ops/turn.mjs uses) + a conductor nudge
// — the command applies within seconds. `status` is a READ-ONLY one-screen
// reply off the state branch (the watchdog's store.fetch() pattern; the
// console NEVER writes on the status path).
//
// SHAPE (mirrors intake/turn.mjs — the door's I/O half):
//   - a PURE parse+record half (zero I/O, unit-testable directly);
//   - runConsole({ event, env, api, store, now }) — the dispatch half with
//     INJECTED seams (the conformance pattern: the REST client and the git
//     store are parameters, so tests make ZERO live API calls);
//   - main() — wires the real fetch + Store + process.env and is the only
//     thing that touches the outside world.
//
// SECURITY CONTRACT (F-13 + the F-2 per-workflow form — see ops-console.yml):
//   - GITHUB_TOKEN ONLY (env GH_TOKEN). NO secrets.* is ever read here — the
//     console's reply comment and its fsm-tick nudge are GITHUB_TOKEN-
//     authored, and GITHUB_TOKEN-authored issue_comment events NEVER fire
//     workflows (the platform law) — anti-recursion BY CONSTRUCTION. The
//     nudge's repository_dispatch still wakes the conductor (X1a: dispatch
//     events are the law's stated exception).
//   - Fail-closed scoping (m-8): ONLY the OPS issue — env OPS_ISSUE (the
//     workflow maps the LOAD-BEARING repo variable `vars.OPS_ISSUE`, default
//     '1'). A comment anywhere else exits silently BEFORE any API call.
//   - The author gate: GET /repos/{repo}/collaborators/{user}/permission —
//     non-200 or below `write` → exit 0 SILENTLY (a stranger's comment on a
//     public repo must not burn a reply). Bots exit even earlier (zero API
//     calls — the intake pre-pass pattern).
//   - Non-command comments: ignored — zero work beyond the parse.
//
// Exit codes (visible, never silently green — mirrors intake/turn.mjs):
//   0 — the console decided + executed (enqueued+replied, status-replied, or
//       silent by design: out-of-scope / bot / non-command / no permission)
//   1 — the enqueue CAS push failed (nothing queued — the command is LOST,
//       the operator sees the run red and re-comments)
//   2 — the reply comment POST failed (law 5: the feedback loop's health is
//       part of the job; the queue line itself holds)
//   3 — the nudge dispatch failed (degraded, not lost: the next tick /
//       backstop / pinger still drains the queue)

import { Store } from '../lib/store.mjs';
import { pathToFileURL } from 'node:url';

const REPO_DEFAULT = 'claudecode-headless/fsm-lab';
const OPS_ISSUE_DEFAULT = '1';   // m-8: the load-bearing default

// s21/O-1 (audit a5): the SPEND CEILING — the repo variable
// `CC_SPEND_CEILING_USD` (mapped through ops-console.yml exactly like
// OPS_ISSUE; default 8.0). The console READS it and renders the epoch spend
// against it (ok / APPROACHING / EXCEEDED) — the ceiling is an OPERATOR
// surface here, not a control action: the console never writes, so the burn
// decision (pause / halt / reset) stays the operator's. Read through the env
// seam the same way CC_MODEL reaches the worker adapter.
export const SPEND_CEILING_DEFAULT_USD = 8.0;
const SPEND_CEILING_APPROACH_FRACTION = 0.8;

// parseSpendCeilingUsd(env) — the pure env read (vars come through the
// workflow's env mapping; absent / unparseable / non-positive → the default,
// never a NaN that would break the render).
export function parseSpendCeilingUsd(env = {}) {
  const raw = env == null ? null : env.CC_SPEND_CEILING_USD;
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SPEND_CEILING_DEFAULT_USD;
}

// epochSpend(journalRecords) — the s21/O-1 epoch-cumulative economics.
// Walks the FULL journal (store.readJournals()'s order: oldest → newest) from
// the END backward, summing every REPORT record's lane_stats cost + tokens,
// and STOPS at the newest applied `CONTROL command:'reset'` record — the
// epoch boundary (its genesisSpec mints the chain the live state renders;
// everything AFTER the boundary is the current epoch's spend). No boundary →
// the whole retained journal is the epoch (the bootstrap/first-epoch shape).
// REPORT records WITHOUT lane_stats (pre-W-D turns) contribute nothing but
// count in the denominator — the render prints `telemetry on X/Y turns` so
// the operator sees the honest floor (the audit's live case: 7-of-52 turns
// carried telemetry; pre-fold spend is unrecoverable and the line says so).
// REJECTED-duplicate / reset-duplicate records are kind REJECTED — they never
// bound the scan; an unapplied reset record is not a boundary either.
export function epochSpend(journalRecords) {
  const recs = Array.isArray(journalRecords) ? journalRecords : [];
  let cost = 0, tokens = 0, turns = 0, withTelemetry = 0;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'CONTROL' && r.command === 'reset' && r.applied !== false) break;   // the epoch boundary
    if (r.kind !== 'REPORT') continue;
    turns += 1;
    const ls = r.lane_stats;
    if (ls && typeof ls === 'object' && !Array.isArray(ls)) {
      withTelemetry += 1;
      cost += Number(ls.cost) || 0;
      tokens += Number(ls.tokens) || 0;
    }
  }
  return { cost, tokens, turns, withTelemetry };
}

export const CONSOLE_COMMANDS = ['pause', 'resume', 'halt', 'unhalt', 'reset', 'status', 'configure'];
const BARE_COMMANDS = new Set(['pause', 'resume', 'halt', 'unhalt']);
const RESET_FLAGS = ['from_queue', 'drop_queue'];
// the lease-bearing statuses = "active" for the status screen
const ACTIVE_STATUSES = new Set(['assigned', 'in_progress']);

// ---------------------------------------------------------------------------
// the PURE half — parse
// ---------------------------------------------------------------------------

// parseConsoleCommand(body) -> null | { command, patch, error }
//
// The FIRST LINE's first whitespace-delimited token must be an exact,
// case-sensitive command word (the brief's regex
// /(pause|resume|halt|unhalt|reset|status|configure .*)/ is a summary — an
// unanchored substring test would fire on prose: "paused for maintenance"
// would enqueue a PAUSE. The anchored-word parse is the fail-closed reading:
// a first token that is not a command word makes the whole comment a
// non-command → ignored silently, zero work).
//
//   null                 — not a console command (silent ignore)
//   { command, patch }   — a valid command; patch carries reset flags /
//                          the configure knob patch, else null
//   { command, error }   — a command WORD with bad arguments (reset garbage
//                          flag, configure bad JSON / non-object / empty) —
//                          the caller replies ONE line with the error
export function parseConsoleCommand(body) {
  const firstLine = String(body ?? '').split('\n')[0].trim();
  if (!firstLine) return null;
  const [word, ...rest] = firstLine.split(/\s+/);
  if (!CONSOLE_COMMANDS.includes(word)) return null;
  const argStr = rest.join(' ').trim();

  if (BARE_COMMANDS.has(word) || word === 'status') {
    // bare commands tolerate trailing prose ("pause until the quota resets")
    // — the first token is unambiguous. status ignores args likewise.
    return { command: word, patch: null };
  }

  if (word === 'reset') {
    // F-5 lanes: reset [from_queue|drop_queue] — may combine; each trailing
    // token must be a known flag (a garbage token is a REJECT with a
    // one-line reply, not a silent drop and not a bare reset)
    if (!argStr) return { command: 'reset', patch: null };
    const tokens = argStr.split(/\s+/);
    const bad = tokens.filter(t => !RESET_FLAGS.includes(t));
    if (bad.length) {
      return { command: 'reset', error: `unknown reset flag(s) ${bad.map(t => JSON.stringify(t)).join(', ')} — valid: ${RESET_FLAGS.join(' | ')} (may combine)` };
    }
    const flags = [...new Set(tokens)];
    return { command: 'reset', patch: Object.fromEntries(flags.map(f => [f, true])) };
  }

  // configure: requires a JSON patch argument on the line
  // (`configure {"max_parallel":8}`). Bad JSON → the parse error rides the
  // one-line reply. A non-object (array/string/number) or empty object is
  // rejected here too — the queue record must never carry a patch the drain
  // would only reject as unparseable-shape (fail at the door, not in the
  // conductor). Knob KEYS/BOUNDS stay the FSM's validateConfig at drain —
  // journaled REJECTED, the audit holds.
  if (!argStr) {
    return { command: 'configure', error: 'configure needs a JSON patch argument, e.g. configure {"max_parallel":8}' };
  }
  let patch;
  try {
    patch = JSON.parse(argStr);
  } catch (e) {
    return { command: 'configure', error: `configure patch is not valid JSON: ${e.message}` };
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { command: 'configure', error: `configure patch must be a JSON object (got ${Array.isArray(patch) ? 'an array' : typeof patch})` };
  }
  if (Object.keys(patch).length === 0) {
    return { command: 'configure', error: 'configure patch is empty (nothing to change)' };
  }
  return { command: 'configure', patch };
}

// ---------------------------------------------------------------------------
// the PURE half — the queue record (F-12's two-layer id)
// ---------------------------------------------------------------------------

// consoleQueueRecord({ command, patch, author, nodeId, nowIso }) — the
// enqueueControl record, mirroring ops/turn.mjs's rec shape:
//   id       `console-<comment_node_id>`   — LAYER 1: the queue id (stays on
//                                            the record as the audit trail;
//                                            also lands in the CAS commit
//                                            message + the reply comment)
//   node_id  <comment node_id>             — LAYER 2 seed: the conductor's
//                                            drain mints the CONTROL event id
//                                            `ctl-<nodeId>-<command>-<clockMs>`
//                                            through MINT_TABLE (the journal's
//                                            ONE id space), keeping the two
//                                            identities joined by the comment
//                                            node id
//   sender   the comment author (T45/F-G(c): the journal record's `actor` —
//            audit-only; the WRITE gate stays GitHub's permission model)
//   note     null (no note syntax on the comment surface; keeps F-1's
//            reset twin-guard semantics identical to the ops lane)
export function consoleQueueRecord({ command, patch = null, author = null, nodeId = null, nowIso }) {
  const nid = nodeId != null && String(nodeId) !== '' ? String(nodeId) : null;
  return {
    cmd: command,
    patch: patch ?? null,
    note: null,
    sender: author ?? null,
    ts: nowIso,
    id: `console-${nid ?? 'noid'}`,
    ...(nid ? { node_id: nid } : {}),
  };
}

// the reply shapes (ONE comment per decision — never per tick)
export function queuedReply(cmd, queueId) {
  return `**[fsm-console]** command ${cmd} queued (${queueId}) — next tick applies.`;
}

// ---------------------------------------------------------------------------
// the PURE half — the status screen (read-only, one screen)
// ---------------------------------------------------------------------------

// statusSummary({ state, depths, nowMs, journalReports, journalAll,
//                  spendCeilingUsd }) — phase, milestone,
// done/quarantined counts, chain id + age of last_tick, queue depths (report/
// control/intake), paused/halted, active task ids. NEVER writes anything.
// journalReports (optional, the W-D review fold A4): the journal-tail REPORT
// records — the LANE section's PRIMARY source (see laneSection).
// journalAll (optional, s21/O-1): the FULL journal record list
// (store.readJournals()) — the EPOCH economics line's source: epoch-cumulative
// cost + tokens since the newest reset boundary, checked against the spend
// ceiling. Absent (legacy callers / a failed journal read) → no epoch line —
// the screen never goes red over economics telemetry.
export function statusSummary({ state, depths = {}, nowMs = null, journalReports = null, journalAll = null, spendCeilingUsd = null }) {
  if (!state) {
    return '**[fsm-console]** status: state.json is UNREADABLE on the state branch (absent or corrupt — the conductor\'s git-history recovery owns it; the watchdog alerts if the chain is also stale).';
  }
  const chain = state.chain || {};
  const proj = state.project || {};
  const stats = state.stats || {};
  const lastTickMs = Date.parse(chain.last_tick || '');
  let age = '';
  if (Number.isFinite(lastTickMs) && Number.isFinite(nowMs)) {
    const s = Math.max(0, Math.round((nowMs - lastTickMs) / 1000));
    age = s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  } else {
    age = 'unknown';
  }
  const tasks = Object.values(state.tasks || {});
  const active = tasks.filter(t => t && ACTIVE_STATUSES.has(t.status)).map(t => t.id);
  const total = tasks.length;
  const d = (n) => (Number.isFinite(n) ? n : 0);
  // T46/W-D lane B (§D4 console) + the review fold (A4): the LANE section.
  // PRIMARY source = journalReports (the caller's readJournalTail(64,
  // 'REPORT') — the durable record; survives pruning + rebuild); FALLBACK =
  // the tasks' last_result.lane_stats (the drain's durable carry, M3; the
  // state projection is the cheaper read but the ~20-tick window). Absent
  // on every legacy/pre-W-D record → the single "no telemetry" line.
  const laneLines = laneSection(tasks, journalReports);
  const epochLines = epochSection(journalAll, spendCeilingUsd);
  return [
    `**[fsm-console]** status — chain \`${chain.id ?? '?'}\` (last tick ${age})`,
    `- phase: ${proj.phase ?? '?'} · milestone ${proj.milestone ?? '?'}/${proj.milestones_total ?? '?'} · mode ${proj.mode ?? '?'}`,
    `- tasks: ${d(stats.done)}/${total} done · ${d(stats.quarantined)} quarantined · ${d(stats.failed)} failed · ${d(stats.cancelled)} cancelled · active [${active.join(', ')}]`,
    `- holds: paused=${chain.paused === true} · halted=${chain.halted === true}`,
    `- queues: report ${d(depths.report)} · control ${d(depths.control)} · intake ${d(depths.intake)}`,
    ...epochLines,
    ...laneLines,
  ].join('\n');
}

// s21/O-1 (audit a5): the EPOCH economics section — the one line the
// operator's spend-ceiling arithmetic lives on. Pure; returns [] when the
// caller has no full-journal view (older fakes / failed read) so legacy
// screens are byte-identical. Ceiling states: ok (< 80% of the ceiling),
// APPROACHING (≥ 80%), EXCEEDED (≥ 100%) — the last two render LOUD
// (bold caps) because they are the two states an operator must act on.
function epochSection(journalAll, spendCeilingUsd) {
  if (!Array.isArray(journalAll)) return [];
  const sp = epochSpend(journalAll);
  const ceiling = Number.isFinite(spendCeilingUsd) && spendCeilingUsd > 0 ? spendCeilingUsd : SPEND_CEILING_DEFAULT_USD;
  const cap = `$${ceiling.toFixed(2)}`;
  if (sp.turns === 0) return [`- epoch: no turns yet · ceiling ${cap}`];
  const base = `- epoch: cost $${sp.cost.toFixed(4)} · tokens ${sp.tokens} · telemetry on ${sp.withTelemetry}/${sp.turns} turns`;
  const frac = sp.cost / ceiling;
  const pct = Math.round(frac * 100);
  if (frac >= 1) {
    return [`${base} — **SPEND CEILING EXCEEDED: $${sp.cost.toFixed(2)} of ${cap} (${pct}%) — pause the chain or raise the ceiling (repo var CC_SPEND_CEILING_USD)**`];
  }
  if (frac >= SPEND_CEILING_APPROACH_FRACTION) {
    return [`${base} — **SPEND CEILING APPROACHING: $${sp.cost.toFixed(2)} of ${cap} (${pct}%)**`];
  }
  return [`${base} · ceiling ${cap} (${pct}%)`];
}

// T46/W-D lane B (§D4 console): the LANE section — the W-D review fold
// (A4, lens-2 F2 + lens-1 F3) makes the JOURNAL the PRIMARY source:
// statusSummary's caller passes the last LANE_JOURNAL_WINDOW REPORT records
// (store.readJournalTail(64, 'REPORT')) — the durable record that survives
// task pruning AND a journal rebuild. The state-side last_result view (the
// pre-terminal window, ~prune_tasks_after_ticks) stays as the FALLBACK when
// the journal yields nothing usable; records lacking lane_stats (old-format
// / pre-fold) are skipped gracefully — absent everywhere → the single
// "no telemetry" line. Pure + exported for the pins.
export const LANE_JOURNAL_WINDOW = 64;

const laneStatsGuard = (s) => s && typeof s === 'object' && !Array.isArray(s);

// the shared accumulator: one lane_stats-shaped object per entry
function accumulateLaneStats(statsList) {
  let calls = 0, ok = 0, err429 = 0, err5xx = 0, tokens = 0, cost = 0;
  const lat = [];
  const models = {};
  const classes = {};
  for (const s of statsList) {
    calls += Number(s.calls) || 0;
    ok += Number(s.ok) || 0;
    err429 += Number(s.err429) || 0;
    err5xx += Number(s.err5xx) || 0;
    tokens += Number(s.tokens) || 0;
    cost += Number(s.cost) || 0;
    if (Number.isFinite(Number(s.p50_ms))) lat.push(Number(s.p50_ms));
    for (const [m, mm] of Object.entries(s.models || {})) models[m] = (models[m] || 0) + (Number(mm.calls) || 0);
    for (const [k, v] of Object.entries(s.rate_classes || {})) classes[k] = (classes[k] || 0) + (Number(v) || 0);
  }
  return { calls, ok, err429, err5xx, tokens, cost, lat, models, classes };
}

function renderLaneLines(acc, sourceLabel) {
  acc.lat.sort((a, b) => a - b);
  const p = (q) => acc.lat.length ? acc.lat[Math.min(acc.lat.length - 1, Math.floor(acc.lat.length * q))] : null;
  const top = Object.entries(acc.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m.split('/').pop()}:${n}`).join(' ');
  const cls = Object.entries(acc.classes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}:${v}`).join(' ');
  const lines = [
    `- lanes: ${acc.calls} calls (${acc.ok} ok · ${acc.err429}×429 · ${acc.err5xx}×5xx) · p50 ${p(0.5) ?? '?'}ms · p95 ${p(0.95) ?? '?'}ms · tokens ${acc.tokens} · cost $${acc.cost.toFixed(4)} · ${sourceLabel}`,
  ];
  if (top) lines.push(`- lane models: ${top}${cls ? ` · limits: ${cls}` : ''}`);
  return lines;
}

export function laneSection(tasks, journalReports = null) {
  // PRIMARY: the journal tail's REPORT records (the caller read them via
  // store.readJournalTail(LANE_JOURNAL_WINDOW, 'REPORT')). Old-format
  // records without lane_stats are skipped, never crash the screen.
  if (Array.isArray(journalReports) && journalReports.length) {
    const statsList = journalReports
      .filter(r => r && r.kind === 'REPORT' && laneStatsGuard(r.lane_stats))
      .map(r => r.lane_stats);
    if (statsList.length) {
      return renderLaneLines(accumulateLaneStats(statsList), `${statsList.length} turns (journal tail)`);
    }
  }
  // FALLBACK: the state-side view (last_result — the fast pre-terminal
  // window; decays after pruning, resets after a rebuild)
  const withStats = (tasks || []).filter(t => t?.last_result && laneStatsGuard(t.last_result.lane_stats));
  if (!withStats.length) return ['- lanes: no telemetry yet (pre-W-D records or no turns since the fold)'];
  return renderLaneLines(
    accumulateLaneStats(withStats.map(t => t.last_result.lane_stats)),
    `${withStats.length} tasks (state window)`,
  );
}

// ---------------------------------------------------------------------------
// the dispatch half — injected seams (the conformance pattern)
// ---------------------------------------------------------------------------

// runConsole({ event, env, api, store, now }) -> { outcome, exitCode }
//
//   event  the parsed github.event (issue_comment created payload)
//   env    { REPO?, OPS_ISSUE? }  (main() wires process.env; the token
//          NEVER crosses this seam — the api closure owns the credential)
//   api    async (path, method, body) -> { status, data }  — the REST seam
//          (comments, the permission gate, the nudge dispatch)
//   store  the Store-like seam: { fetch, readState, readControlQueue,
//          readIntakeQueue, readQueue, enqueueControl }
//   now    () -> ISO string (the clock seam)
//
// Outcomes (log lines always name the gate that decided):
//   silent-event        no issue/comment on the event
//   silent-scope        comment not on the OPS issue (m-8)      — exit 0
//   silent-bot          bot author (zero API calls)            — exit 0
//   silent-noncommand   first line is not a command            — exit 0
//   silent-permission   author below write / API non-200       — exit 0
//   rejected            command word + bad args → ONE-line reply
//   status              read-only screen → ONE comment, no writes
//   queued              enqueue + ONE reply + nudge
export async function runConsole({ event, env = {}, api, store, now = () => new Date().toISOString() }) {
  const repo = env.REPO || REPO_DEFAULT;
  const opsIssue = String(env.OPS_ISSUE || OPS_ISSUE_DEFAULT).trim() || OPS_ISSUE_DEFAULT;
  const ev = event || {};
  const issue = ev.issue;
  const comment = ev.comment;
  if (!issue || issue.number == null || !comment) {
    console.log('CONSOLE-SILENT: no issue/comment on the event (the workflow pins issue_comment[created] — nothing to do)');
    return { outcome: 'silent-event', exitCode: 0 };
  }

  // gate 1 — m-8 scoping: ONLY the ops issue, checked BEFORE any API call
  if (String(issue.number) !== opsIssue) {
    console.log(`CONSOLE-SILENT: issue #${issue.number} is not the ops issue (${opsIssue}) — ignoring`);
    return { outcome: 'silent-scope', exitCode: 0 };
  }

  // gate 2 — the bot pre-pass (the intake pattern): bots exit BEFORE any API
  // call. The console's OWN replies are github-actions[bot] — GITHUB_TOKEN
  // comments never fire issue_comment anyway (F-13, the platform law); this
  // pre-pass also shields the permission call from OTHER bots' comments.
  const author = comment.user?.login || ev.sender?.login || null;
  if (author == null || author.endsWith('[bot]')) {
    console.log(`CONSOLE-SILENT: bot/null author (${author}) — no permission call, no enqueue, zero API calls`);
    return { outcome: 'silent-bot', exitCode: 0 };
  }

  // gate 3 — the parse (non-command comments: zero work beyond the parse)
  const parsed = parseConsoleCommand(comment.body);
  if (!parsed) {
    console.log(`CONSOLE-SILENT: first line of comment on issue #${issue.number} is not a console command`);
    return { outcome: 'silent-noncommand', exitCode: 0 };
  }

  // gate 4 — the author permission gate (fail-closed): non-200 or below
  // write → exit 0 SILENTLY. A stranger's command on the (public) ops issue
  // must not burn a reply.
  const pr = await api(`/repos/${repo}/collaborators/${encodeURIComponent(author)}/permission`);
  const perm = pr.status === 200 && pr.data && typeof pr.data.permission === 'string' ? pr.data.permission : null;
  if (perm !== 'write' && perm !== 'admin') {
    console.log(`CONSOLE-SILENT: @${author} permission=${perm ?? 'unverified'} HTTP=${pr.status} (fail-closed — below write or unverified; no reply burned)`);
    return { outcome: 'silent-permission', exitCode: 0 };
  }

  // a command WORD with bad arguments → ONE-line reply (visible reject, the
  // operator learns the syntax; nothing enqueued)
  if (parsed.error) {
    const okc = await postComment(api, repo, issue.number, `**[fsm-console]** rejected: ${parsed.error}`);
    console.log(`CONSOLE-REJECTED ${parsed.command} by @${author}: ${parsed.error} — ${okc ? 'reply posted' : 'REPLY FAILED'}`);
    return { outcome: 'rejected', exitCode: okc ? 0 : 2 };
  }

  // status — the READ-ONLY lane: fetch + reads, ONE comment, NEVER a write
  // method (the watchdog's store.fetch() pattern; enqueueControl/commit are
  // never called on this path — test-pinned).
  if (parsed.command === 'status') {
    store.fetch();
    const { state } = store.readState();
    const depths = {
      report: store.readQueue().length,
      control: store.readControlQueue().length,
      intake: store.readIntakeQueue().length,
    };
    // T46/W-D review fold (A4): the LANE section's PRIMARY source — the
    // journal tail's REPORT records (the durable record the design named;
    // the state view is the ~prune-window fallback). A store seam without
    // readJournalTail (older fakes) or a failed read degrades gracefully
    // to the fallback — the status screen never goes red over telemetry.
    let journalReports = null;
    if (typeof store.readJournalTail === 'function') {
      try { journalReports = store.readJournalTail(LANE_JOURNAL_WINDOW, 'REPORT'); } catch { journalReports = null; }
    }
    // s21/O-1 (audit a5): the FULL journal record list — the EPOCH economics
    // line's source (readJournals is the rebuild-side full read, a READ; the
    // status lane stays write-free). Guarded like the tail read: a seam
    // without it (older fakes) or a failed read degrades to no epoch line —
    // never a red status over telemetry.
    let journalAll = null;
    if (typeof store.readJournals === 'function') {
      try { journalAll = store.readJournals(); } catch { journalAll = null; }
    }
    const body = statusSummary({ state, depths, nowMs: Date.parse(now()), journalReports, journalAll, spendCeilingUsd: parseSpendCeilingUsd(env) });
    const okc = await postComment(api, repo, issue.number, body);
    console.log(`CONSOLE-STATUS by @${author} — ${okc ? 'one-screen reply posted' : 'REPLY FAILED'}`);
    return { outcome: 'status', exitCode: okc ? 0 : 2 };
  }

  // a command — the SAME CAS lane ops/turn.mjs uses (the store owns fetch/
  // merge/push with retries; the next tick drains atomically)
  const rec = consoleQueueRecord({
    command: parsed.command, patch: parsed.patch, author,
    nodeId: comment.node_id ?? null, nowIso: now(),
  });
  const r = store.enqueueControl(rec);
  console.log(`CONSOLE-ENQUEUED ${rec.cmd} (${rec.id}) by @${author} -> ${r.ok ? 'ok (next tick drains it)' : 'FAILED: ' + (r.err || 'unknown')}`);
  if (!r.ok) return { outcome: 'enqueue-failed', exitCode: 1 };

  // ONE reply on the comment thread — the queue id names the audit trail
  const okc = await postComment(api, repo, issue.number, queuedReply(rec.cmd, rec.id));
  if (!okc) {
    console.error('CONSOLE-REPLY failed (the command IS queued; the next tick/backstop still drains it — the operator just missed the ack)');
    return { outcome: 'queued-reply-failed', exitCode: 2 };
  }

  // the nudge: seconds-latency apply instead of backstop cadence. A
  // GITHUB_TOKEN repository_dispatch (X1a — the platform law's stated
  // exception: dispatch events DO fire workflows when GITHUB_TOKEN-authored)
  // wakes the conductor; if the chain is hot the nudge may be superseded
  // (newest-wins) — the queue line is never lost. Rides the api SEAM (tests
  // inject it — zero live calls).
  const status = await nudgeTick(api, repo);
  console.log(`CONSOLE-NUDGE tick dispatch HTTP=${status}`);
  if (status !== 204) {
    console.error('CONSOLE-NUDGE failed (the command is queued; the next tick/backstop/pinger still drains it)');
    return { outcome: 'queued-nudge-failed', exitCode: 3 };
  }
  return { outcome: 'queued', exitCode: 0 };
}

async function postComment(api, repo, issueNumber, body) {
  const r = await api(`/repos/${repo}/issues/${issueNumber}/comments`, 'POST', { body });
  return r.status === 201;
}

async function nudgeTick(api, repo) {
  const post = () => api(`/repos/${repo}/dispatches`, 'POST', {
    event_type: 'fsm-tick',
    client_payload: { reason: 'console' },
  });
  let r = await post();
  if (r.status !== 204) {
    await new Promise(res => setTimeout(res, 2000));
    r = await post();
  }
  return r.status;
}

// ---------------------------------------------------------------------------
// main — the only code that touches the real world
// ---------------------------------------------------------------------------

async function main() {
  const env = {
    REPO: process.env.GITHUB_REPOSITORY || REPO_DEFAULT,
    OPS_ISSUE: process.env.OPS_ISSUE || OPS_ISSUE_DEFAULT,
    // s21/O-1: the spend ceiling rides the env seam (ops-console.yml maps the
    // repo variable vars.CC_SPEND_CEILING_USD, default '8.0' — the same
    // mapping shape m-8 uses for OPS_ISSUE)
    CC_SPEND_CEILING_USD: process.env.CC_SPEND_CEILING_USD,
    TOKEN: process.env.GH_TOKEN,   // F-13: the JOB token — the console's ONLY credential
  };
  const event = JSON.parse(process.env.EVENT || '{}');
  const store = new Store({ cwd: process.cwd() });
  const api = async (path, method = 'GET', body = null) => {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `token ${env.TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'fsm-lab-console',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies */ }
    return { status: r.status, data };
  };
  const r = await runConsole({ event, env, api, store });
  if (r.exitCode) process.exitCode = r.exitCode;
}

// main() runs only when invoked as a script (the tests import the pure +
// seam-injected halves; the seam injection is what keeps them API-free)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('CONSOLE-FAILED:', e.message); process.exitCode = 1; });
}
