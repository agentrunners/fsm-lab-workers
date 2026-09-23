// watchdog-core.mjs — the watchdog's DECISION core, extracted from
// watchdog/scan.mjs (T45/F-B + F-D). The breaker/dedup arithmetic previously
// lived only in the adapter with ZERO automated coverage — exactly where the
// P1-c finding lives. Pure functions only: adapters-stay-thin is the house
// style (the conductor-core extraction pattern). NO I/O here — the scan
// adapter owns fetch/store/logging; these functions decide.

// F-B: the latch threshold — the newest N watchdog-reprime runs must ALL sit
// after state.chain.last_tick for the latch to trip. Replaces the old
// 30-minute sliding window (MAX_REPRIMES=3 in REPRIME_WINDOW_MIN): production
// cadences are ~2h (native) to 2-6h (executor) — the window could NEVER fill,
// so a permanently-dead conductor was re-primed FOREVER with zero operator
// alerts (probe3: 48 scans / 48 re-primes / 0 alerts = the eternal silent
// re-prime loop). The latch is cadence-proof: at 5-min manual cadence it trips
// on the 4th scan (same as the old breaker); at 2h it trips on the 4th scan
// ≈ 6h. One rule, all regimes.
export const LATCH_REPRIMES = 3;

// F-D: the alert-marker dedup window (24h — the T44 rate-limit discipline:
// a corrupt-state chain firing every ~2h scan must not comment the same alert
// 12x/day; the alert ISSUE itself is already deduped to one).
export const DEDUP_WINDOW_MS = 24 * 3600_000;

// F-D: trusted author associations for the alert-marker dedup. A marker
// comment refreshes the window ONLY if authored by MEMBER/COLLABORATOR/OWNER
// or a Bot — anonymous (NONE) and drive-by (CONTRIBUTOR, FIRST_TIME_*) markers
// are IGNORED (the stranger-suppression kill, w2f F-3: on a public repo ANY
// anonymous commenter could stay newest and strip diagnostics from a live
// alert). The watchdog's own posts pass via type==='Bot'
// (github-actions[bot]); the LAB_PAT fallback lane passes via COLLABORATOR.
// The gate bounds COMMENT NOISE only — never control.
const TRUSTED_ASSOC = new Set(['MEMBER', 'COLLABORATOR', 'OWNER']);

const tsMs = (x) => Date.parse(x?.created_at || x || '');

// ---------------------------------------------------------------------------
// F-B — the per-incident circuit-breaker LATCH.
//
// breakerDecision({ state, recentRuns, nowMs, inflightWindowMs })
//   state      — the state.json object as read by the scan (only
//                state.chain.last_tick / state.chain.seq are read).
//   recentRuns — the conductor workflow runs visible to this scan (ANY order;
//                the arithmetic is order-independent — W2-b law-20: sort/
//                direction params are IGNORED server-side on list endpoints).
//                Each run needs {name, status, created_at}.
//   nowMs      — the scan's clock (injected for testability).
//
// LATCH condition: the newest LATCH_REPRIMES runs named 'watchdog-reprime'
// ALL exist AND were all created_at > state.chain.last_tick — i.e. the last
// N re-primes ALL failed to produce an applied tick. last_tick is the
// progress witness (it advances in the same TICK branch as seq, with no
// run-name schema change). MEMORY-FREE: derived state only (run ledger +
// state.json) — nothing to persist, nothing to reset; ANY applied tick IS the
// re-arm (the latch condition is simply false on the next scan). A
// revived-but-slow chain never latches: its re-primes sit below last_tick.
//
// The in-flight guard (T44 semantics, unchanged): a queued/in_progress
// conductor run created within the lookback -> WAIT (no re-prime — it queues
// behind the live run rather than cancelling it; the group is
// cancel-in-progress:false). The 6-min lookback (< the 10-min conductor job
// TTL) also bounds a runner-starved 'queued' run from blocking re-primes
// forever.
//
// Fail-open direction: an unparseable/missing last_tick or unparseable
// run.created_at can never complete the "all after last_tick" predicate ->
// not latched -> re-prime continues (today's behavior — the self-heal lane).
// ---------------------------------------------------------------------------
export function breakerDecision({ state, recentRuns = [], nowMs = Date.now(), inflightWindowMs = 6 * 60_000 } = {}) {
  const inflight = recentRuns.filter(r =>
    ['queued', 'in_progress'].includes(r.status) && (nowMs - tsMs(r)) <= inflightWindowMs);

  const reprimes = recentRuns
    .filter(r => (r.name || '').includes('watchdog-reprime'))
    .sort((a, b) => tsMs(b) - tsMs(a)); // newest first — order-independent selection
  const newest = reprimes.slice(0, LATCH_REPRIMES);
  const lastTickMs = tsMs(state?.chain?.last_tick);
  const latched =
    newest.length === LATCH_REPRIMES &&
    Number.isFinite(lastTickMs) &&
    newest.every(r => Number.isFinite(tsMs(r)) && tsMs(r) > lastTickMs);

  return {
    latched,
    latchCount: newest.length,        // how many re-primes the predicate considered
    reprimesTotal: reprimes.length,   // re-primes in the fetched window (log color)
    inflight: inflight.length,
    lastTick: state?.chain?.last_tick || null,
    seq: state?.chain?.seq,
  };
}

// ---------------------------------------------------------------------------
// F-D — the alert-marker 24h dedup, hardened.
//
// alertDedup({ comments, nowMs, windowMs, marker }) -> { skip, markerAgeMin, ... }
//   comments — the issue comments the adapter fetched (s21/A-2:
//              alertCommentsPath — per_page=100 + since=<window floor>, ANY
//              order — law-20 again: the newest TRUSTED marker is selected by
//              created_at arithmetic, never by array position; an out-of-set
//              newest marker simply fails to dedup -> an extra alert comment,
//              the fail-NOISY direction, never the suppress direction).
//   marker   — the BODY SUBSTRING that identifies this alert class
//              (default '[fsm-watchdog]' — the watchdog's own class token;
//              s23/B9: the conductor's FREE-TAIL lane passes its own distinct
//              token so the dedup CLASSES separately — a budget-pause comment
//              never refreshes the tail's window and vice versa).
//
// skip=true  -> the 24h window is fresh (a trusted marker < 24h old): the
//               scan posts NOTHING (the alert issue already carries the body).
// skip=false -> post the marker comment.
// ---------------------------------------------------------------------------
export function alertDedup({ comments = [], nowMs = Date.now(), windowMs = DEDUP_WINDOW_MS, marker = '[fsm-watchdog]' } = {}) {
  const markers = comments.filter(c => (c.body || '').includes(marker));
  const trusted = markers.filter(c =>
    TRUSTED_ASSOC.has(c.author_association) || c.user?.type === 'Bot');
  if (trusted.length === 0) {
    return {
      skip: false, markerAgeMin: null, markerBy: null,
      reason: markers.length ? 'no-trusted-marker' : 'no-marker',
    };
  }
  let newest = trusted[0];
  for (const c of trusted) {
    // NaN comparisons are false — an unparseable created_at can never win
    if (tsMs(c) > tsMs(newest)) newest = c;
  }
  const ageMs = nowMs - tsMs(newest);
  if (Number.isFinite(ageMs) && ageMs < windowMs) {
    return {
      skip: true,
      markerAgeMin: Math.round(Math.max(ageMs, 0) / 60_000),
      markerBy: newest.user?.login || null,
      reason: 'trusted-marker-fresh',
    };
  }
  return {
    skip: false,
    markerAgeMin: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null,
    markerBy: newest.user?.login || null,
    reason: Number.isFinite(ageMs) ? 'marker-stale' : 'marker-unparseable',
  };
}

// ---------------------------------------------------------------------------
// s21/A-2 (audit a3, MAJOR): the comments-fetch path for the dedup above.
//
// The old fetch was `per_page=20&sort=created&direction=desc` — structurally
// blind once the alert issue passed 20 comments: law-20 (live A/B,
// T45-FIX-DESIGN.md:144) says sort/direction are IGNORED server-side on list
// endpoints, so during a sustained latch (the latch's exact use case — the
// watchdog's own marker comments accumulate past 20) the fetch can return
// the OLDEST page, the newest trusted marker falls out of the fetched set,
// and the skip NEVER fires again: ~12 duplicate alert comments/day for the
// incident's duration — the exact T44 rate-limit class F-D was built to
// kill, re-entering through pagination.
//
// The fix mirrors the law-4 scan's proven pattern (verifyScanRunsPath):
// per_page=100 + a `since=<now - window>` floor. `since` filters by UPDATED
// time server-side — every comment updated inside the dedup window returns
// REGARDLESS of ordering, so a fresh trusted marker can never fall off the
// page. Selection still keys on created_at inside alertDedup (an OLD marker
// edited recently appears in the fetch but does not refresh the window —
// fail-noisy, never the suppress direction). Residual: a >100-comments-
// updated-in-24h burst can still page the marker out — the fail direction
// is one extra alert comment, bounded and loud.
// ---------------------------------------------------------------------------
export const ALERT_COMMENTS_PER_PAGE = 100;

export function alertCommentsPath(repo, issue, nowMs, { windowMs = DEDUP_WINDOW_MS, perPage = ALERT_COMMENTS_PER_PAGE } = {}) {
  let q = `per_page=${perPage}`;
  // s22/FLIP-ME (journal-flood's mutation-verified pin — the mutation line):
  // comment out the since append below (the pre-A-2 shape) and the battery's
  // `with the A-2 since= fix — ZERO duplicate alerts` pin fails (0 -> ~1/scan
  // duplicates; the before/after number the battery reports as
  // duplicate_alerts_old_path). See the consumption-site note in
  // watchdog/scan.mjs openAlertIssue. Revert after the check.
  if (Number.isFinite(nowMs)) {
    q += `&since=${encodeURIComponent(new Date(nowMs - windowMs).toISOString())}`;
  }
  return `/repos/${repo}/issues/${issue}/comments?${q}`;
}

// ---------------------------------------------------------------------------
// T46/W-C2 (§5a, F-15) — the transcript-GC decision core.
//
// The watchdog scan gains a pass that deletes aged transcripts of TERMINAL
// tasks from the fsm-sessions branch in ONE commit per scan (the commit IS
// the audit — F-15b: NO journal record, NO fsm-state write; the watchdog
// NEVER writes fsm-state). Pure functions only, same contract as above: the
// scan adapter owns the git lane (clone/ls-tree/log/rm/commit/push) and the
// clock; these functions decide.
//
// Age source (the brief leaves it to the builder — DECIDED, git-local):
//   the adapter shallow-clones fsm-sessions with `--shallow-since` and maps
//   each path to its NEWEST touching commit via `git log --name-only
//   --format='@@@%H %cI'` (gcParseTouchLog). The REST trees API has no
//   mtime; the commits-list endpoint carries no per-commit file set; the
//   git lane is one clone with exact ages and mirrors pushSessionsBranch.
// ---------------------------------------------------------------------------

// F-15c: the runtime bail-out — a sessions tree beyond this size means the
// listing is untrusted-scale (or the branch is runaway); defer, never commit.
export const GC_TREE_LIMIT = 5000;

// The retention knob (env TRANSCRIPT_GC_DAYS): default 7, HARD CAP 90.
export const GC_DAYS_DEFAULT = 7;
export const GC_DAYS_CAP = 90;

// F-15 (brief §2 + design §5a): GC-terminal = done/quarantined/cancelled.
// NOTE: lib/fsm.mjs TERMINAL also contains 'failed' — deliberately EXCLUDED
// here: 'failed' is RETRYABLE in this FSM (attempts < max → reassigned), and
// the GC must "never touch non-terminal tasks' transcripts" — a failed task
// may still be re-run against its prior transcripts.
export const GC_TERMINAL = new Set(['done', 'quarantined', 'cancelled']);

// A transcript file as written by worker/cc-adapter.mjs transcriptPaths():
//   sessions/<task>/<run>-a<attempt>.txt | .meta.json
// Strays that do not match are NEVER deleted and never counted.
export const TRANSCRIPT_PATH_RE = /^sessions\/([^/]+)\/[^/]+-a\d+\.(?:txt|meta\.json)$/;

export const GC_DAY_MS = 86_400_000;

// gcDaysFromEnv(raw) -> { days, adjusted, raw }
//   adjusted: null (valid as given) | 'clamped' (>90 → 90) | 'defaulted'
//   (<1, unparseable, or absent → 7). The adapter logs the adjustment.
export function gcDaysFromEnv(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return { days: GC_DAYS_DEFAULT, adjusted: 'defaulted', raw: raw ?? null };
  }
  if (n > GC_DAYS_CAP) {
    return { days: GC_DAYS_CAP, adjusted: 'clamped', raw };
  }
  return { days: n, adjusted: null, raw };
}

// gcParseTouchLog(text) -> { touches: Map<path,ms>, horizonMs }
//   Parses `git log --name-only --format='@@@%H %cI'` output (newest-first).
//   touches: path -> newest touching commit's committer-date (first sighting
//   wins — log order is newest-first). horizonMs: the OLDEST commit date
//   seen — the fail-retention floor for paths the window does not cover.
//
//   The horizon rule (why unmapped paths are safe): a path absent from the
//   window was last touched at-or-before the boundary commit, so its true
//   age is ≥ (now − boundary). Using the boundary date UNDERSTATES age →
//   the fail direction is retention, never deletion. (Git's grafted shallow
//   boundary shows the tip tree as fully-added, which maps exactly those
//   paths to the boundary date — verdict-equivalent to this rule.)
export function gcParseTouchLog(text) {
  const touches = new Map();
  let horizonMs = null;
  let sawCommit = false;
  let curMs = NaN;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('@@@')) {
      const rest = line.slice(3).trim();
      const sp = rest.indexOf(' ');
      curMs = sp < 0 ? NaN : Date.parse(rest.slice(sp + 1));
      if (Number.isFinite(curMs)) {
        sawCommit = true;
        if (horizonMs === null || curMs < horizonMs) horizonMs = curMs;
      }
      continue;
    }
    const p = line.trim();
    if (!p || !Number.isFinite(curMs)) continue;
    if (!touches.has(p)) touches.set(p, curMs);
  }
  return { touches, horizonMs: sawCommit ? horizonMs : null };
}

// gcPlan({ files, touches, horizonMs, state, nowMs, gcDays }) ->
//   { treeCount, transcriptCount, victims, retained, deferred }
//     files      — ALL blob paths of the fsm-sessions tree (adapter's
//                  `git ls-tree -r --name-only`; core filters to sessions/).
//     touches    — Map path->ms from gcParseTouchLog.
//     horizonMs  — oldest fetched commit date (null = no history visible).
//     state      — the state.json the scan ALREADY read (read-only; a task
//                  ABSENT from state.tasks counts as terminal — prior-epoch
//                  residue, the GC's bulk value).
//     nowMs      — the scan's clock (injected).
//     gcDays     — effective days (post-clamp).
//
//   Victim rule (strict): path matches TRANSCRIPT_PATH_RE AND the task is
//   GC-terminal (or absent from state) AND age > gcDays (strictly older).
//   Age = nowMs − (touches.get(path) ?? horizonMs); a path with NEITHER a
//   touch NOR a horizon has unknown age → retained (fail-retention).
//   deferred: sessions/ blob count > GC_TREE_LIMIT (F-15c) — the adapter
//   logs GC-DEFERRED and does NOT commit.
export function gcPlan({ files = [], touches = new Map(), horizonMs = null, state = null, nowMs = Date.now(), gcDays = GC_DAYS_DEFAULT } = {}) {
  const sessionsFiles = files.filter(p => p.startsWith('sessions/'));
  const treeCount = sessionsFiles.length;
  const transcripts = sessionsFiles.filter(p => TRANSCRIPT_PATH_RE.test(p));
  const thresholdMs = gcDays * GC_DAY_MS;
  const victims = [];
  let ambiguous = 0;
  let terminalCount = 0;   // W-C2-R (F5/L2-1): terminal-or-absent transcripts — the deepen's ONLY trigger (an active epoch's live transcripts can never be deleted; deepening for them is pure cost)
  for (const p of transcripts) {
    const task = p.match(TRANSCRIPT_PATH_RE)[1];
    const rec = state?.tasks?.[task];
    const terminal = rec == null || GC_TERMINAL.has(rec.status);
    if (!terminal) continue;
    terminalCount++;
    if (!touches.has(p)) ambiguous++; // verdict rests on the horizon, not a real touch
    const touchMs = touches.has(p) ? touches.get(p) : horizonMs;
    if (touchMs == null || !Number.isFinite(touchMs)) continue; // unknown age — retain
    if (nowMs - touchMs > thresholdMs) victims.push(p);
  }
  victims.sort();
  return {
    treeCount,
    transcriptCount: transcripts.length,
    terminalCount,
    victims,
    retained: transcripts.length - victims.length,
    deferred: treeCount > GC_TREE_LIMIT,
    // terminal/absent transcripts whose age was NOT resolved by a real touch
    // (they sit on the horizon floor): >0 tells the adapter the shallow
    // window under-covers the terminal set — deepen to full history and
    // re-plan for exact ages (the inter-epoch gap case).
    ambiguous,
  };
}

// gcCommitMessage({ victims, retained, ageDays }) -> { subject, body }
//   F-15b shape (binding): subject `gc-transcripts: deleted=<n>
//   retained=<m> age_days=<d>`; body lists the deleted paths, bounded to the
//   first 50 with `… +N more` beyond. The commit itself is the audit record.
export function gcCommitMessage({ victims = [], retained = 0, ageDays = GC_DAYS_DEFAULT } = {}) {
  const subject = `gc-transcripts: deleted=${victims.length} retained=${retained} age_days=${ageDays}`;
  const listed = victims.slice(0, 50);
  const more = victims.length > 50 ? `\n… +${victims.length - 50} more` : '';
  return { subject, body: `${listed.join('\n')}${more}\n` };
}
