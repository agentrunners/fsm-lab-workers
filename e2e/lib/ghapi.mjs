// e2e/lib/ghapi.mjs — the GitHub API STAND-IN (s21 audit §5.2, the drill's cloud).
//
// An http server on 127.0.0.1:<ephemeral> implementing EXACTLY the surface
// the five turn-file adapters call (inventoried from the tree; anything else
// 404s — and the 404 is LEDGERED, so an unplanned surface call is a visible
// drill assertion, criterion 3's blind-spot food):
//
//   POST /repos/:repo/dispatches
//        conductor (self-tick / worker / direct control), intake nudge, ops
//        nudge, watchdog re-prime. 204 + the scheduler's inbox hook.
//   GET  /repos/:repo/actions/workflows/{conductor,worker}.yml/runs?per_page=N[&created=>=ISO]
//        law-4 verify scan (conductor) + the watchdog's conductorRuns(). Served
//        from the scheduler's run ledger (injected provider).
//   GET  /repos/:repo/issues?state=open&labels=fsm-watchdog-alert&per_page=10
//        alert-issue search (budget pause + watchdog).
//   POST /repos/:repo/issues                     open alert/budget issues (and
//        the drill's own intake-issue opens, as the user).
//   POST /repos/:repo/issues/:n/comments         alerts, epoch-started notes,
//        completion digests, watchdog marker comments, stranger flood.
//   GET  /repos/:repo/issues/:n/comments?per_page=20&sort=created&direction=desc
//        the alert-dedup marker scan — LAW-20 REPRODUCED: ONE page of the
//        NEWEST per_page comments; a marker older than the newest 20 is
//        INVISIBLE (the a3/A2 pagination break becomes drillable).
//   GET  /repos/:repo/collaborators/:u/permission
//        the intake door's trust check (scenario-controlled class).
//   POST /repos/:repo/pulls  +  GET /repos/:repo/pulls?head=&state=
//        the task-PR flow (openTaskPr's reuse probe / create / merged-probe).
//
// EVERY request is appended to <scratch>/ghapi-ledger.jsonl (the e2e
// telemetry — assertion food + per-hop latency data): {i, t, method, path,
// status, actor, req} with actor resolved from the Authorization token.
//
// Identity model (token -> actor): the drill mints three in-repo tokens
// (job / PAT / user) plus ad-hoc stranger tokens for the recovery flood:
//   drill-job-token  -> github-actions[bot]  (type Bot, assoc NONE — the
//                       GITHUB_TOKEN lane; alertDedup trusts it via type Bot)
//   drill-pat        -> fsm-pat-bot          (the LAB_PAT cross-repo lane)
//   drill-user-pat   -> drill-operator       (the issue author, write class)
//   stranger-<n>     -> stranger-<n>         (assoc NONE — untrusted)
//
// NOT MODELED (the honest list — mirrored in the drill report):
//   real auth scopes/permission enforcement, secondary rate limits (the
//   ladder's 403/429+RA shapes stay in the unit/sim layers), pagination Link
//   headers beyond the single-page law-20 contract, check-run/artifact APIs,
//   the PAT-comment trigger law (workflow wake is the scheduler's job).

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The ledger slice: 32KB (was 4KB — s22/M-3 surfaced it: the fsm-task
// dispatch body embeds the ox envelope (prompt ≤ 16KB + JSON escaping), so a
// 4KB slice CUT the ox string mid-flight and the drill's envelope asserts
// parsed null on every dispatch. The ledger is drill-local scratch telemetry
// — full-fidelity request bodies are the assertion food; 32KB covers the
// prompt cap + envelope overhead with room to spare.)
const SLICE = 32_768;

export function createGhapi({ scratchDir, tokens = {}, defaultPermissionClass = 'write', log = () => {}, now = null } = {}) {
  const ACTORS = new Map(Object.entries({
    'drill-job-token': { login: 'github-actions[bot]', type: 'Bot', assoc: 'NONE' },
    'drill-pat': { login: 'fsm-pat-bot', type: 'User', assoc: 'OWNER' },
    'drill-user-pat': { login: 'drill-operator', type: 'User', assoc: 'OWNER' },
    ...tokens,
  }));
  // repo -> { issues: Map<number, issue>, comments: Map<number, comment[]>,
  //           pulls: [], nextIssue: 2 (1 is pre-seeded as the ops anchor),
  //           nextComment, nextPull }
  const repos = new Map();
  let issueSeq = 0;
  let commentSeq = 0;
  let pullSeq = 0;
  const ledger = [];
  let ledgerPath = null;
  if (scratchDir) {
    mkdirSync(scratchDir, { recursive: true });
    ledgerPath = join(scratchDir, 'ghapi-ledger.jsonl');
  }

  // hooks / providers injected by the harness
  let onDispatch = null;        // async (entry) => void  — the scheduler's inbox
  let runsProvider = null;      // (repo, workflow) -> run[] (the run ledger)
  const permissionClasses = new Map();   // login -> class (default 'write' for known actors)

  const repoState = (repo) => {
    if (!repos.has(repo)) {
      repos.set(repo, { issues: new Map(), comments: new Map(), pulls: [] });
    }
    return repos.get(repo);
  };

  const actorFor = (req) => {
    const h = req.headers.authorization || '';
    const m = /^token (.+)$/.exec(h.trim());
    const tok = m ? m[1] : null;
    if (tok && ACTORS.has(tok)) return { ...ACTORS.get(tok), token: tok };
    return { login: null, type: null, assoc: null, token: tok, anonymous: true };
  };

  const permClassFor = (login) => {
    if (permissionClasses.has(login)) return permissionClasses.get(login);
    if (login === null || login === undefined) return null;
    return defaultPermissionClass;
  };

  // s22/journal-flood (stress battery 4): the injected virtual clock — an
  // iso-string fn. Unset = real wall clock (the drill's shape,
  // byte-identical). Mirrors the T1 clock-injection discipline at the
  // adapter boundaries.
  const nowIso = typeof now === 'function' ? () => now() : () => new Date().toISOString();

  const recLedger = (entry) => {
    ledger.push(entry);
    if (ledgerPath) {
      try { appendFileSync(ledgerPath, JSON.stringify(entry) + '\n'); } catch { /* ledger is best-effort */ }
    }
  };

  const issueJson = (repo, it) => ({
    id: it.number, number: it.number, title: it.title, body: it.body,
    state: it.state, labels: (it.labels || []).map((name) => ({ name })),
    user: { login: it.user, type: it.userType },
    author_association: it.assoc,
    created_at: it.created_at, updated_at: it.updated_at,
    html_url: `https://github.test/${repo}/issues/${it.number}`,
    repository_url: `https://github.test/api/v3/repos/${repo}`,
  });

  const commentJson = (c) => ({
    id: c.id, body: c.body, created_at: c.created_at, updated_at: c.updated_at || c.created_at,
    user: { login: c.user, type: c.userType },
    author_association: c.assoc,
    html_url: `https://github.test/x/issues/${c.id}`,
  });

  const pullJson = (p) => ({
    id: p.number, number: p.number, title: p.title, body: p.body,
    state: p.state, head: { ref: p.head, label: p.headLabel },
    base: { ref: p.base }, user: { login: p.user, type: p.userType },
    created_at: p.created_at, merged_at: null,
    html_url: `https://github.test/${p.repo}/pull/${p.number}`,
  });

  // ---- the routes -----------------------------------------------------------
  const server = createServer(async (req, res) => {
    const actor = actorFor(req);
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;
    const q = u.searchParams;
    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { __unparseable: raw.slice(0, 200) }; }
    }
    const send = (status, data, extraHeaders = {}) => {
      const payload = data === null || data === undefined ? '' : JSON.stringify(data);
      const entry = {
        i: ledger.length + 1, t: Date.now(), method: req.method, path: req.url,
        status, actor: actor.login ?? '(anon)',
        ...(body ? { req: JSON.stringify(body).slice(0, SLICE) } : {}),
      };
      recLedger(entry);
      log(`GHAPI ${req.method} ${req.url} -> ${status} (${actor.login ?? 'anon'})`);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Github-Media-Type': 'github.v3; format=json',
        ...extraHeaders,
      });
      res.end(payload);
    };

    // POST /repos/:repo/dispatches
    let m = /^\/repos\/([^/]+\/[^/]+)\/dispatches$/.exec(path);
    if (m && req.method === 'POST') {
      if (!body || typeof body.event_type !== 'string') {
        return send(422, { message: 'event_type required' });
      }
      const entry = {
        repo: decodeURIComponent(m[1]), eventType: body.event_type,
        clientPayload: body.client_payload || {}, actor: actor.login,
        receivedAt: Date.now(),
      };
      if (onDispatch) { try { await onDispatch(entry); } catch (e) { log(`GHAPI dispatch hook error: ${e.message}`); } }
      return send(204, null);
    }

    // GET /repos/:repo/actions/workflows/:wf/runs
    m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/.exec(path);
    if (m && req.method === 'GET') {
      const repo = decodeURIComponent(m[1]);
      const wf = decodeURIComponent(m[2]);
      if (!/^(conductor|worker)\.yml$/.test(wf)) return send(404, { message: 'Not Found' });
      // (s23 fix — the workflow-name vocabulary: the URL carries the workflow
      // FILE id ('worker.yml' — GitHub's API shape), but the scheduler's run
      // ledger keys runs by the bare workflow NAME ('worker'). The old pass-
      // through matched NOTHING: every runs page served an EMPTY array, so
      // the law-4 union scan fetched "both buckets" and saw ZERO runs
      // forever (runs=0 keys=0 — the fail-open design masked it: no flips,
      // green-looking no-flip asserts on an empty scan). Normalize here —
      // the ROUTE knows the URL shape; the provider contract stays
      // "ledger runs for workflow <name>".)
      let runs = runsProvider ? runsProvider(repo, wf.replace(/\.yml$/, '')) : [];
      const created = q.get('created');
      if (created) {
        // the law-4 created>= floor (encoded '>=<ISO>')
        const mm = /^>=(.+)$/.exec(created);
        const floorMs = mm ? Date.parse(mm[1]) : NaN;
        if (Number.isFinite(floorMs)) {
          runs = runs.filter((r) => {
            const c = Date.parse(r.created_at || '');
            return !Number.isFinite(c) || c >= floorMs;   // unparseable fails OPEN (seenKeys' contract)
          });
        }
      }
      runs = [...runs].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
      const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') || '30', 10) || 30));
      const page = runs.slice(0, perPage);
      return send(200, { total_count: runs.length, workflow_runs: page });
    }

    // GET /repos/:repo/issues (open + label filter — the alert search)
    m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
    if (m && req.method === 'GET') {
      const st = repoState(decodeURIComponent(m[1]));
      const state = q.get('state') || 'open';
      const label = q.get('labels');
      const perPage = Math.max(1, parseInt(q.get('per_page') || '30', 10) || 30);
      let list = [...st.issues.values()].filter((it) => it.state === state);
      if (label) list = list.filter((it) => (it.labels || []).includes(label));
      list.sort((a, b) => b.number - a.number);
      return send(200, list.slice(0, perPage).map((it) => issueJson(decodeURIComponent(m[1]), it)));
    }

    // POST /repos/:repo/issues
    if (m && req.method === 'POST') {
      const repo = decodeURIComponent(m[1]);
      const st = repoState(repo);
      if (!body || typeof body.title !== 'string' || !body.title.trim()) {
        return send(422, { message: 'title required' });
      }
      issueSeq += 1;
      const n = issueSeq;
      const it = {
        number: n, title: body.title, body: body.body ?? '',
        labels: Array.isArray(body.labels) ? body.labels : [],
        state: 'open', user: actor.login ?? 'anonymous', userType: actor.type ?? 'User',
        assoc: actor.assoc ?? 'NONE', created_at: nowIso(), updated_at: nowIso(),
      };
      st.issues.set(n, it);
      return send(201, issueJson(repo, it));
    }

    // GET /repos/:repo/issues/:n/comments — LAW-20: one page, newest first.
    // s22/M-2(a) + s22/journal-flood (stress battery 4): `since=<ISO>` is
    // IMPLEMENTED (the s21/A-2 fix's SERVER half) — comments with
    // updated_at < since are filtered OUT server-side BEFORE the
    // newest-per_page slice, exactly what the watchdog's alertCommentsPath
    // (per_page=100 + since=<now-24h>) relies on: a fresh marker can never
    // fall off the page while >20 comments accumulate (the paginated dedup
    // break). Unparseable since leaves the list unfiltered (fail-open,
    // server tolerance). The stand-in's comments are never edited, so
    // updated_at === created_at; the filter reads the internal created_at.
    // The no-since fetch is UNCHANGED — the recovery drill's law-20
    // reproduction stays intact.
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (m && req.method === 'GET') {
      const st = repoState(decodeURIComponent(m[1]));
      const n = parseInt(m[2], 10);
      let all = st.comments.get(n) || [];
      const sinceRaw = q.get('since');
      if (sinceRaw) {
        const sinceMs = Date.parse(sinceRaw);
        if (Number.isFinite(sinceMs)) {
          all = all.filter((c) => {
            const upd = Date.parse(c.updated_at ?? c.created_at);
            return !Number.isFinite(upd) || upd >= sinceMs;   // unparseable stays (fail-open, the seenKeys convention)
          });
        }
      }
      const perPage = Math.max(1, parseInt(q.get('per_page') || '30', 10) || 30);
      // sort=created&direction=desc: GitHub serves the NEWEST per_page first;
      // anything older is past page 1 — the pagination the adapters never walk.
      const since = q.get('since');
      let filtered = all;
      if (since) {
        const sinceMs = Date.parse(since);
        if (Number.isFinite(sinceMs)) {
          filtered = all.filter((c) => {
            const u = Date.parse(c.updated_at || c.created_at || '');
            return !Number.isFinite(u) || u >= sinceMs;
          });
        }
      }
      const sorted = [...filtered].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return send(200, sorted.slice(0, perPage).map(commentJson));
    }

    // POST /repos/:repo/issues/:n/comments
    if (m && req.method === 'POST') {
      const repo = decodeURIComponent(m[1]);
      const st = repoState(repo);
      const n = parseInt(m[2], 10);
      if (!st.issues.has(n)) return send(404, { message: 'Not Found' });
      if (!body || typeof body.body !== 'string') return send(422, { message: 'body required' });
      commentSeq += 1;
      const c = {
        id: commentSeq, body: body.body, created_at: nowIso(),
        user: actor.login ?? 'anonymous', userType: actor.type ?? 'User',
        assoc: actor.assoc ?? 'NONE',
      };
      const list = st.comments.get(n) || [];
      list.push(c);
      st.comments.set(n, list);
      const it = st.issues.get(n);
      it.updated_at = nowIso();
      return send(201, commentJson(c));
    }

    // GET /repos/:repo/collaborators/:user/permission
    m = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(path);
    if (m && req.method === 'GET') {
      const login = decodeURIComponent(m[2]);
      const cls = permClassFor(login);
      if (cls === null) return send(404, { message: 'Not Found' });   // the API-error marker -> door fail-closed
      return send(200, {
        permission: cls, user: { login }, role_name: cls,
      });
    }

    // GET/POST /repos/:repo/pulls
    m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
    if (m && req.method === 'GET') {
      const repo = decodeURIComponent(m[1]);
      const st = repoState(repo);
      const head = q.get('head');
      const state = q.get('state') || 'open';
      let list = st.pulls.filter((p) => p.state === state);
      if (head) list = list.filter((p) => p.headLabel === head);
      return send(200, list.map(pullJson));
    }
    if (m && req.method === 'POST') {
      const repo = decodeURIComponent(m[1]);
      const st = repoState(repo);
      if (!body || typeof body.head !== 'string' || typeof body.base !== 'string') {
        return send(422, { message: 'head/base required' });
      }
      if (body.head === body.base) return send(422, { message: 'no commits between the heads' });
      const headLabel = `${repo.split('/')[0]}:${body.head}`;
      if (st.pulls.some((p) => p.headLabel === headLabel && p.state === 'open')) {
        return send(422, { message: 'A pull request already exists for the head' });
      }
      pullSeq += 1;
      const p = {
        number: pullSeq, repo, title: body.title || 'pull', body: body.body ?? '',
        head: body.head, headLabel, base: body.base, state: 'open',
        user: actor.login ?? 'anonymous', userType: actor.type ?? 'User', created_at: nowIso(),
      };
      st.pulls.push(p);
      return send(201, pullJson(p));
    }

    return send(404, { message: 'Not Found', drill_note: 'unplanned API surface — the adapters never call this' });
  });

  // ---- the harness-facing API ----------------------------------------------
  const api = {
    server,
    port: null,
    url: null,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      api.port = server.address().port;
      api.url = `http://127.0.0.1:${api.port}`;
      return api.url;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    setOnDispatch(fn) { onDispatch = fn; },
    setRunsProvider(fn) { runsProvider = fn; },
    setPermissionClass(login, cls) { permissionClasses.set(login, cls); },

    // ---- direct (in-process) operations the harness performs AS the cloud --
    // open an issue as a given token (the drill's "user opens the intake issue")
    openIssue(repo, { title, body, labels = [], token = 'drill-user-pat' }) {
      const actor = ACTORS.get(token);
      const st = repoState(repo);
      issueSeq += 1;
      const n = issueSeq;
      const it = {
        number: n, title, body, labels, state: 'open',
        user: actor?.login ?? 'anonymous', userType: actor?.type ?? 'User',
        assoc: actor?.assoc ?? 'NONE', created_at: nowIso(), updated_at: nowIso(),
      };
      st.issues.set(n, it);
      recLedger({ i: ledger.length + 1, t: Date.now(), method: 'DIRECT', path: `POST /repos/${repo}/issues`, status: 201, actor: it.user, req: JSON.stringify({ title, labels }).slice(0, 512), note: `issue #${n}` });
      return it;
    },
    addComment(repo, issueN, { body, token = 'drill-user-pat' }) {
      const actor = ACTORS.get(token);
      const st = repoState(repo);
      commentSeq += 1;
      const c = {
        id: commentSeq, body, created_at: nowIso(),
        user: actor?.login ?? 'anonymous', userType: actor?.type ?? 'User',
        assoc: actor?.assoc ?? 'NONE',
      };
      const list = st.comments.get(issueN) || [];
      list.push(c);
      st.comments.set(issueN, list);
      return c;
    },
    addStrangerToken(name) {
      ACTORS.set(name, { login: name, type: 'User', assoc: 'NONE' });
      permissionClasses.set(name, 'read');
      return name;
    },

    // ---- readers (assertion food) -------------------------------------------
    ledger() { return [...ledger]; },
    ledgerSince(tMs) { return ledger.filter((e) => e.t >= tMs); },
    issues(repo) { return [...repoState(repo).issues.values()].map((it) => issueJson(repo, it)); },
    comments(repo, issueN) {
      return [...(repoState(repo).comments.get(issueN) || [])].map(commentJson);
    },
    pulls(repo) { return repoState(repo).pulls.map(pullJson); },
    issueByTitle(repo, substr) {
      return this.issues(repo).find((it) => it.title.includes(substr)) || null;
    },
  };

  return api;
}
