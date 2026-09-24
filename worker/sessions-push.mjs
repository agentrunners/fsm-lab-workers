// sessions-push.mjs — the s25/b1 transcript-lane rebuild: session files via
// the GitHub CONTENTS API, race-free by construction (the X29 F3 fix), on
// the explicit custom-name repo/token seam (the X29 F2 fix).
//
// WHY CONTENTS-API (F3 — the X29 race, $0.005701 / 100,911 tokens / ~341
// runner-seconds of re-turned work, 22.9% of the epoch's spend): the old
// lane was a plain `git push origin fsm-sessions` from a depth-1 clone —
// N parallel workers holding the SAME tip produce N−1 guaranteed non-FF
// losers plus GitHub-side ref-lock rejections; the per-run file PATHS never
// collided (codexTranscriptPaths/cc transcriptPaths are per-task/per-run)
// — the shared BRANCH TIP was the contention. `PUT /repos/{repo}/contents/
// {path}` is per-file server-side CAS: no branch fast-forward constraint,
// no ref lock, no clone — 13-parallel (any parallel) never contends.
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

// the per-file GET+PUT budget: 3 attempts total (the X29 audit's tactical
// complement named "3–4 attempts with exponential backoff + jitter"; with
// the structural race GONE, retries only cover genuine API transients —
// 5xx blips and the rare stale-sha 409 — not contention).
export const SESSIONS_PUT_ATTEMPTS = 3;

// the backoff ladder (±25% jitter): wait 250ms after failure 1, 1s after
// failure 2 (the third tier, 4s, is the curve's documented ceiling — live
// only if SESSIONS_PUT_ATTEMPTS is ever raised; the burst that motivated
// the long tail no longer exists under per-file CAS).
export const SESSIONS_RETRY_BACKOFF_MS = [250, 1000, 4000];

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
      const tier = SESSIONS_RETRY_BACKOFF_MS[Math.min(attempt - 2, SESSIONS_RETRY_BACKOFF_MS.length - 1)];
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
        return { path: file.path, ok: false, err: `GET -> HTTP 200 without a sha (malformed contents payload)` };
      }
      const put = await ghJson(fetchImpl, putUrl(), 'PUT', token, {
        message: file.message,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch,
        sha,
      });
      if (put.status === 201 || put.status === 200) return { path: file.path, ok: true, updated: true };
      if (retryable(put)) { last = `PUT -> HTTP ${put.status}${errText(put.data) ? ` (${errText(put.data)})` : ''}`; continue; }
      return { path: file.path, ok: false, err: `PUT -> HTTP ${put.status}${errText(put.data) ? ` (${errText(put.data)})` : ''}` };
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
      if (retryable(put)) { last = `PUT(create) -> HTTP ${put.status}${errText(put.data) ? ` (${errText(put.data)})` : ''}`; continue; }
      return { path: file.path, ok: false, err: `PUT(create) -> HTTP ${put.status}${errText(put.data) ? ` (${errText(put.data)})` : ''}` };
    }
    if (retryable(get)) { last = `GET -> HTTP ${get.status}${get.networkError ? ` (${get.networkError})` : ''}`; continue; }
    // 401/403 (auth/permission) and the other 4xx are fatal per file — a
    // bad token retried 3× is 5 seconds of theater before the same death
    return { path: file.path, ok: false, err: `GET -> HTTP ${get.status}${errText(get.data) ? ` (${errText(get.data)})` : ''}${get.networkError ? ` (${get.networkError})` : ''}` };
  }
  return { path: file.path, ok: false, err: `exhausted ${SESSIONS_PUT_ATTEMPTS} attempts — ${String(last).slice(0, 160)}` };
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
    // one throw, every file's error — the aggregate is the diagnosis the
    // 120-char journal slice will keep: which paths, which statuses
    throw new Error(`sessions contents push: ${failures.length}/${outcomes.length} file(s) failed — ${failures.map((f) => `${f.path}: ${f.err}`).join(' | ').slice(0, 300)}`);
  }
  return { mode: 'pushed', branch, repo, files: outcomes.map((o) => o.path) };
}
