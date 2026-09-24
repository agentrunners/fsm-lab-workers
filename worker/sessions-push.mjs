// sessions-push.mjs — the s25/b1 transcript-lane rebuild + the s25/X30
// ladder correction: session files via the GitHub CONTENTS API on the
// explicit custom-name repo/token seam (the X29 F2 fix).
//
// WHY CONTENTS-API (F3 — the X29 race, $0.005701 / 100,911 tokens / ~341
// runner-seconds of re-turned work, 22.9% of the epoch's spend): the old
// lane was a plain `git push origin fsm-sessions` from a depth-1 clone —
// N parallel workers holding the SAME tip produce N−1 guaranteed non-FF
// losers plus GitHub-side ref-lock rejections; the per-run file PATHS never
// collided (codexTranscriptPaths/cc transcriptPaths are per-task/per-run)
// — the shared BRANCH TIP was the contention.
//
// THE X30 LIVE CORRECTION (s25 — the drill caught the design's own wrong
// premise): "per-file server-side CAS, race-free by construction" was
// HALF right. The file PATHS never contend — but every PUT still updates
// the branch ref via a server-side read-tip→commit→CAS-ref cycle, and a
// 16-worker × 2-file burst makes the ref move CONTINUOUSLY for ~10-20s:
// every PUT whose internal tip-read predates a rival's landing 409s ("is
// at X but expected Y" — X30 run 36064447619, 9/24 tasks exhausted the
// 3-attempt/5s ladder while the storm outlasted it). The contents API
// MOVES the contention server-side; it does not remove it. The absorber is
// the STORE'S PROVEN PATTERN (lib/store.mjs commit()): a LONG jittered
// ladder that de-synchronizes writers and outlasts the storm — hence
// SESSIONS_PUT_ATTEMPTS=10 with the 250ms×i-capped-2s backoff below. The
// terminal semantic changed with it: retryable exhaustion now DEGRADES
// (the turn keeps its DONE status + the note rides the report summary)
// instead of throwing — because the escalation re-runs a COMPLETED PAID
// turn to recreate a record (the exact 22.9%-waste class X29's audit
// condemned; a lost transcript is a degraded record, a re-run is burned
// spend). PERSISTENT errors (auth/permission/malformed/oversize) still
// THROW — those are lane breakage the operator must see, not contention.
//
// WHY THE CUSTOM ENV NAMES (F2 — the GITHUB_* override law): worker.yml's
// old Work-step env mapped `GITHUB_REPOSITORY: ${{ vars.TARGET_REPO ||
// github.repository }}` — the step env RENDERS the override in the log but
// the spawned process keeps the runner's REAL github.repository (GitHub
// protects the default GITHUB_* names: step-env overrides of them are
// silently ignored). Live proof: mirror run 35999041887 rendered
// `GITHUB_REPOSITORY: claudecode-headless/fsm-lab` AND pushed `To
// https://github.com/agentrunners/fsm-lab-workers.git` (the URL was built
// from the process's un-overridden env). Custom names — FSM_SESSIONS_REPO /
// FSM_SESSIONS_TOKEN — are the only reliable seam. (GH_TOKEN is NOT a
// protected name, so its override worked; the failure was repo-selection
// only, which made the split SILENT: pushes landed, on the wrong repo.)
//
// THE CONTRACT: pushSessionFiles({ repo, token, branch, files, log, env,
// fetchImpl, sleepImpl, rand }) — files = [{path, content (utf8 string),
// message}]. Per file: GET the path at the branch (404 = create; 200 =
// update, capture the blob sha) then PUT {message, content: base64,
// branch, sha?} (201/200 = landed). Per-file retries: up to
// SESSIONS_PUT_ATTEMPTS GET+PUT cycles with backoff+jitter, on
// 409/422/5xx/network (409 = the ref moved between GET and PUT — the
// update-sha went stale; the retry takes a FRESH GET). Per-file failure
// after the retries = collected; ANY failure → ONE throw carrying every
// file's error (the turn-level transcript escalation turns it into
// infra_failed 'transcript-push-failed' — the same lane-unavailable class
// the FSM's net-zero ladder already absorbs). The 1 MiB size guard THROWS
// (fail-loud: transcripts are KB-scale; a >1 MiB transcript is its own bug
// to surface, never a silent truncation or a git-lane fallback).
//
// DETERMINISM (the mock-first doctrine): fetchImpl / sleepImpl / rand are
// injectable — the unit suite drives every branch (create/update/409/
// aggregate/env-resolution) with a scripted fetch, zero network; the
// defaults (globalThis.fetch, setTimeout sleep, Math.random jitter) are
// the live lane. API base rides the T9 (s21) seam convention:
// env.GITHUB_API_URL || 'https://api.github.com' — GHA sets the env itself
// on real runners, so live behavior is byte-identical to the literal.

const DEFAULT_API_BASE = 'https://api.github.com';

// transcripts are KB-scale (X29's 48 files: all < 32 KB); the contents API
// is for small files — a transcript over 1 MiB means the lane itself is
// broken (a runaway prompt echo, a pasted binary) and must fail LOUD.
export const SESSIONS_FILE_MAX_BYTES = 1024 * 1024;

// the per-file GET+PUT budget: 10 attempts (the X30 correction — the
// 3-attempt/5s ladder lost 9/24 tasks to a 409 storm that outlasted it;
// the store's proven de-sync ladder shape: 250ms×(attempt−1), capped at
// 2s, ±25% jitter — total sleep ~11s + ~10 server cycles ≈ a 15-20s
// window that spans the burst's decay with margin. The turn is already
// COMPLETE while this ladder runs (post-turn, parallel with the report):
// the cost of the long tail is latency, never spend).
export const SESSIONS_PUT_ATTEMPTS = 10;

// the backoff for attempt N (1-indexed): 250 × (N−1) capped at 2000, ±25%
// jitter (the store's ladder verbatim — the jitter is load-bearing: the
// tight-loop version starved 15/36 writers in the store's own 6-writer
// probe; de-synchronized retries are what makes a moving-ref storm
// converge instead of thundering).
export const sessionsBackoffMs = (attempt) => Math.min(250 * Math.max(0, attempt - 1), 2000);

const JITTER_LO = 0.75;   // backoff_ms * [0.75 .. 1.25]
const JITTER_HI = 1.25;

// THE F2 SEAM (pure, exported for the unit pins): the custom names win when
// non-empty; the GITHUB_* / GH_TOKEN names stay as the back-compat pair for
// tests/sims/local lanes that set the old vocabulary (same resolution shape
// as the CODEX_HOME seam — a non-empty custom wins, absent = the legacy
// source, never the reverse: a step-env GITHUB_* override is exactly the
// write that never reaches the process).
export function sessionsRepoFromEnv(env = process.env) {
  const custom = typeof env.FSM_SESSIONS_REPO === 'string' ? env.FSM_SESSIONS_REPO.trim() : '';
  if (custom !== '') return custom;
  const legacy = typeof env.GITHUB_REPOSITORY === 'string' ? env.GITHUB_REPOSITORY.trim() : '';
  return legacy !== '' ? legacy : null;
}

export function sessionsTokenFromEnv(env = process.env) {
  const custom = typeof env.FSM_SESSIONS_TOKEN === 'string' ? env.FSM_SESSIONS_TOKEN.trim() : '';
  if (custom !== '') return custom;
  const legacyRaw = env.GH_TOKEN || env.GITHUB_TOKEN;
  const legacy = typeof legacyRaw === 'string' ? legacyRaw.trim() : '';
  return legacy !== '' ? legacy : null;
}

// path segments get encodeURIComponent, '/' stays structural — a path with
// spaces/percent/unicode lands at the literal path, not a 404.
const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

const errText = (data) => {
  const m = data && typeof data === 'object' && typeof data.message === 'string' ? data.message : '';
  return m.slice(0, 120);
};

// one REST call; NEVER throws on HTTP — the status classifies. A network
// rejection (fetch's TypeError) becomes status -1 + networkError, the
// retryable class (DNS hiccups, connection resets).
async function ghJson(fetchImpl, url, method, token, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'User-Agent': 'fsm-lab-sessions-push',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { status: -1, networkError: String(e?.message ?? e).slice(0, 120), data: null };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body — the status still classifies */ }
  return { status: res.status, data };
}

const retryable = (r) => r.status === -1 || r.status === 409 || r.status === 422 || r.status >= 500;

// compact per-file error strings: the STATUS must survive every downstream
// slice (the X30 journal lesson — the aggregated error's 300-char slice + the
// adapter wrap's 120-char slice cut "HTTP 409" off the end, leaving the
// diagnosis-less "PUT(create) ->" in the record). Cap the server message at
// 60 chars: the status + the first clause carry the diagnosis; the full body
// stays in the run log's SESSIONS-PUT-RETRY lines.
const compactErr = (label, r) => `${label} HTTP ${r.status}${errText(r.data) ? ` (${errText(r.data).slice(0, 60)})` : ''}${r.networkError ? ` (${r.networkError.slice(0, 60)})` : ''}`;

// the per-file PUT ladder: GET (404 create / 200 update+sha / retryable /
// fatal) → PUT (201/200 landed / retryable / fatal). A retryable outcome
// burns the attempt, sleeps the jittered ladder tier, and takes a FRESH
// GET next cycle (a 409 PUT means the captured sha went stale — the ref
// moved between the GET and the PUT; only a fresh GET re-arms it).
async function putSessionFile(ctx, file) {
  const { repo, token, branch, apiBase, fetchImpl, sleepImpl, rand, log } = ctx;
  const bytes = Buffer.byteLength(file.content, 'utf8');
  if (bytes > SESSIONS_FILE_MAX_BYTES) {
    // fail-loud, BEFORE any request: the guard is a lane-health alarm, not
    // a size negotiation (the brief's own "no — THROW")
    throw new Error(`sessions file ${file.path} is ${bytes} bytes — over the ${SESSIONS_FILE_MAX_BYTES}-byte contents-API guard (transcripts are KB-scale; a >1MiB transcript is its own bug — fail-loud, never truncated)`);
  }
  const getUrl = () => `${apiBase}/repos/${repo}/contents/${encPath(file.path)}?ref=${encPath(branch)}`;
  const putUrl = () => `${apiBase}/repos/${repo}/contents/${encPath(file.path)}`;
  let last = 'no attempt recorded';
  for (let attempt = 1; attempt <= SESSIONS_PUT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const tier = sessionsBackoffMs(attempt);
      const ms = Math.round(tier * (JITTER_LO + rand() * (JITTER_HI - JITTER_LO)));
      log(`SESSIONS-PUT-RETRY ${file.path} attempt ${attempt}/${SESSIONS_PUT_ATTEMPTS} after ${ms}ms (last: ${String(last).slice(0, 100)})`);
      await sleepImpl(ms);
    }
    // fresh GET every attempt — the sha must describe the ref AS THE PUT
    // SEES IT, not as an earlier cycle saw it (the 409 absorber)
    const get = await ghJson(fetchImpl, getUrl(), 'GET', token);
    if (get.status === 200) {
      const sha = typeof get.data?.sha === 'string' ? get.data.sha : undefined;
      if (sha === undefined) {
        // 200 without a blob sha = a malformed contents payload — fatal,
        // never retried (retrying a shape break just burns the ladder)
        return { path: file.path, ok: false, fatal: true, err: `GET -> HTTP 200 without a sha (malformed contents payload)` };
      }
      const put = await ghJson(fetchImpl, putUrl(), 'PUT', token, {
        message: file.message,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch,
        sha,
      });
      if (put.status === 201 || put.status === 200) return { path: file.path, ok: true, updated: true };
      if (retryable(put)) { last = compactErr('PUT', put); continue; }
      return { path: file.path, ok: false, fatal: true, err: compactErr('PUT', put) };
    }
    if (get.status === 404) {
      // create path: the file is absent at the branch — the PUT carries NO
      // sha. (The branch itself must exist; a branch-less PUT 422s into the
      // retryable ladder and then fails loud — sessions is born on main
      // once, by ops, not per-run.)
      const put = await ghJson(fetchImpl, putUrl(), 'PUT', token, {
        message: file.message,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch,
      });
      if (put.status === 201 || put.status === 200) return { path: file.path, ok: true, created: true };
      if (retryable(put)) { last = compactErr('PUT(create)', put); continue; }
      return { path: file.path, ok: false, fatal: true, err: compactErr('PUT(create)', put) };
    }
    if (retryable(get)) { last = compactErr('GET', get); continue; }
    // 401/403 (auth/permission) and the other 4xx are fatal per file — a
    // bad token retried 10× is 20 seconds of theater before the same death
    return { path: file.path, ok: false, fatal: true, err: compactErr('GET', get) };
  }
  // retryable exhaustion (the 409-storm class): DEGRADED, never thrown —
  // the caller keeps the turn's DONE status (the X30 correction; the
  // `exhausted` marker is the classifier the adapters key on)
  return { path: file.path, ok: false, err: `exhausted ${SESSIONS_PUT_ATTEMPTS} attempts — ${String(last).slice(0, 100)}` };
}

// THE ENTRY (both adapters' real-mode transcript lane): pushes every file
// per-file-CAS; returns {mode:'pushed', branch, repo, files:[paths]} — the
// old git-lane return shape plus the repo the files LANDED on (the field
// the X29 split proved the log line needed). Throws ONE aggregated error
// when any file failed — the caller's transcript escalation (the
// done-turn-only infra_failed 'transcript-push-failed') is the consumer.
export async function pushSessionFiles({
  repo, token, branch, files,
  log = () => {},
  env = process.env,
  fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
  sleepImpl = (ms) => new Promise((res) => setTimeout(res, ms)),
  rand = Math.random,
} = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('pushSessionFiles: repo must be a non-empty string (owner/name)');
  if (typeof token !== 'string' || token.trim() === '') throw new Error('pushSessionFiles: token must be a non-empty string');
  if (typeof branch !== 'string' || branch.trim() === '') throw new Error('pushSessionFiles: branch must be a non-empty string');
  if (!Array.isArray(files) || files.length === 0) throw new Error('pushSessionFiles: files must be a non-empty [{path, content, message}]');
  if (typeof fetchImpl !== 'function') throw new Error('pushSessionFiles: fetchImpl must be a function (default = global fetch — Node >= 18)');
  const apiBase = (typeof env.GITHUB_API_URL === 'string' && env.GITHUB_API_URL.trim() !== ''
    ? env.GITHUB_API_URL.trim().replace(/\/+$/, '')
    : DEFAULT_API_BASE);   // the T9 (s21) seam: GHA sets the env itself — unset = the literal, byte-identical
  const ctx = { repo, token, branch, apiBase, fetchImpl, sleepImpl, rand, log };
  const outcomes = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path === '') {
      throw new Error(`pushSessionFiles: every file needs a non-empty string path (got ${JSON.stringify(file?.path)})`);
    }
    if (typeof file.content !== 'string') {
      throw new Error(`pushSessionFiles: file ${file.path} needs utf8 string content (got ${typeof file.content}) — base64 happens HERE, never at the caller`);
    }
    outcomes.push(await putSessionFile(ctx, file));
  }
  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length) {
    // the PERSISTENT class (auth/permission/malformed/validation): the lane
    // is broken — THROW, the operator must see it (the adapters escalate a
    // done-turn to infra_failed 'transcript-push-failed' exactly as before)
    const fatal = failures.filter((f) => f.fatal);
    if (fatal.length) {
      throw new Error(`sessions contents push: ${failures.length}/${outcomes.length} file(s) failed — ${failures.map((f) => `${f.path}: ${f.err}`).join(' | ').slice(0, 300)}`);
    }
    // the RETRYABLE-EXHAUSTION class (the 409 storm): DEGRADED — the landed
    // files are recorded, the unlanded are named, and the turn KEEPS ITS
    // DONE STATUS (re-running a completed paid turn to recreate a record is
    // the 22.9%-waste class; the adapters attach the note to the report)
    return {
      mode: 'degraded', branch, repo,
      files: outcomes.filter((o) => o.ok).map((o) => o.path),
      failures: failures.map((f) => ({ path: f.path, err: String(f.err).slice(0, 120) })),
    };
  }
  return { mode: 'pushed', branch, repo, files: outcomes.map((o) => o.path) };
}
