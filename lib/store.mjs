// store.mjs — the state anchor: a versioned JSON state + journal-rotation log
// on a dedicated git branch, written via plumbing (no checkout, no worktree).
//
// WHY GIT-AS-STATE-ANCHOR (the Task-43 decision, argued in ARCHITECTURE.md):
//  - CAS for free: push to an existing branch refuses non-FF -> optimistic
//    concurrency; retry = re-read + re-apply + re-push (dedup keys make the
//    re-apply idempotent). Survived the 5-writer wave in the prior track.
//  - History for free: every commit carries the FULL materialized state ->
//    corruption recovery = find the last parseable state.json in git log.
//  - Bounded growth by construction: state.json is OVERWRITTEN (never
//    appended); the journal rotates (N generations, pruned via commits).
//  - No TTL: branches don't expire (unlike artifacts, 90d) and are writable
//    from ephemeral runners with job-scoped credentials.
//
// THE PLUMBING WRITE (atomic per commit):
//   git read-tree <remote head>            (into a TEMP index — the runner's
//                                           main checkout is never touched)
//   git hash-object -w <file>              (new blobs)
//   git update-index --cacheinfo/--force-remove
//   tree   = git write-tree
//   commit = git commit-tree tree -p <head> -m "..."
//   git push origin commit:refs/heads/fsm-state    (non-FF = CAS failure)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDENTITY = {
  name: 'fsm-lab-bot',
  email: 'fsm-bot@fsm-lab.invalid', // RFC-2606: never maps to a real account
};

export class Store {
  // opts: {cwd, branch='fsm-state', remote='origin', repoName, rotateAt, keepGens}
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.branch = opts.branch || 'fsm-state';
    this.remote = opts.remote || 'origin';
    this.repoName = opts.repoName || 'fsm-lab';
    this.rotateAt = opts.rotateAt || 500;
    this.keepGens = opts.keepGens || 4;
    this.remoteRef = `refs/remotes/${this.remote}/${this.branch}`;
    this.pushRef = `refs/heads/${this.branch}`;
  }

  git(args, { acceptCodes = [] } = {}) {
    const r = spawnSync('git', args, {
      cwd: this.cwd, encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      },
    });
    if (r.status !== 0 && !acceptCodes.includes(r.status)) {
      throw new Error(`git ${args.join(' ')} failed rc=${r.status}: ${r.stderr?.slice(0, 400)}`);
    }
    return r;
  }

  refExists() {
    const r = this.git(['ls-remote', this.remote, `refs/heads/${this.branch}`], { acceptCodes: [128] });
    return (r.stdout || '').trim().length > 0;
  }

  fetch() {
    // Tolerate transient fetch failures — the remote-tracking ref can race
    // when multiple processes share one clone (X3 burst finding: 'cannot
    // lock ref'); the CAS loop's push (FF-only) is the correctness backstop,
    // so a failed fetch just means a stale view that the next push reject
    // will catch. Missing branch (bootstrap) is also acceptable.
    this.git(['fetch', this.remote, `+refs/heads/${this.branch}:${this.remoteRef}`], { acceptCodes: [1, 128] });
  }

  headSha() {
    const r = this.git(['rev-parse', '--verify', this.remoteRef], { acceptCodes: [128] });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  readFile(path) {
    const r = this.git(['show', `${this.remoteRef}:${path}`], { acceptCodes: [128] });
    return r.status === 0 ? r.stdout : null;
  }

  // T45/F-G(d): STRICT read — distinguish "path absent on the branch" from
  // "git show failed" (readFile returns null for BOTH; W2-e P3-d: both are
  // rc 128). Local-clone object damage after a successful fetch would make a
  // drain/enqueue treat an EXISTING queue as empty and rewrite/delete it —
  // silent data loss. Here: ls-tree proves presence first; present + show
  // failing THROWS (loud — the CAS push is untouched, the turn fails visibly,
  // lease/watchdog cover); absent -> null. The FSM_LAB_FAULT_READ_SHOW=1 seam
  // (mirroring FSM_LAB_FAULT_COMMIT_TREE) makes `show` fail while ls-tree
  // succeeds so the hazard is regression-testable.
  readFileStrict(path) {
    const lt = this.git(['ls-tree', '--name-only', this.remoteRef, '--', path], { acceptCodes: [128] });
    const listed = (lt.stdout || '').split('\n').map(x => x.trim()).filter(Boolean);
    if (!listed.includes(path)) return null;  // genuinely absent on the branch
    const fault = process.env.FSM_LAB_FAULT_READ_SHOW === '1';
    const r = fault ? { status: 128, stdout: '', stderr: 'injected fault: git show failed' } : this.git(['show', `${this.remoteRef}:${path}`], { acceptCodes: [128] });
    if (r.status !== 0) {
      throw new Error(`readFileStrict: git show failed for ${path} (path PRESENT on ${this.branch} — object damage suspected; refusing to treat an EXISTING file as absent)`);
    }
    return r.stdout;
  }

  listStateFiles() {
    const r = this.git(['ls-tree', '--name-only', this.remoteRef, 'state/'], { acceptCodes: [128] });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map(x => x.trim()).filter(Boolean);
  }

  readState() {
    const raw = this.readFile('state/state.json');
    if (!raw) return { state: null, sha: this.headSha() };
    try {
      return { state: JSON.parse(raw), sha: this.headSha() };
    } catch {
      return { state: null, sha: this.headSha(), corrupt: true };
    }
  }

  readJournals() {
    // F5: numeric generation ordering (lexicographic misreads gen >= 10)
    const gens = this.listStateFiles()
      .map(f => f.match(/^state\/journal-(\d+)\.jsonl$/))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => a - b);
    const out = [];
    for (const g of gens) {
      const raw = this.readFile(`state/journal-${g}.jsonl`);
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { console.warn(`journal-${g}: unparseable line skipped (full read)`); }
      }
    }
    return out;
  }

  // init(genesisState): create the branch if absent.
  init(genesisState) {
    if (this.refExists()) return { initialized: false };
    this.fetch();
    const dir = mkdtempSync(join(tmpdir(), 'fsm-init-'));
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify(genesisState, null, 1) + '\n');
      const commit = this.buildCommit(
        [[join(dir, 'state.json'), 'state/state.json']],
        [], null, 'genesis v=1');
      this.git(['push', this.remote, `${commit}:${this.pushRef}`]);
      return { initialized: true, sha: commit };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // buildCommit(tmpDirs, mappings, parent, message)
  //   mappings: array of [srcAbsPath, branchPath] to add
  //   removes: array of branchPaths to remove (rotation pruning)
  //   parent: sha or null
  // Uses a TEMP index so the checked-out worktree is untouched.
  buildCommit(mappings, removes, parent, message) {
    const idx = mkdtempSync(join(tmpdir(), 'fsm-idx-'));
    const idxFile = join(idx, 'index');
    try {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: idxFile,
        GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      };
      const run = (args) => {
        const r = spawnSync('git', args, { cwd: this.cwd, encoding: 'utf8', env });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} rc=${r.status}: ${r.stderr?.slice(0, 300)}`);
        return r.stdout;
      };
      // start from the parent's tree (or an empty index for genesis)
      if (parent) run(['read-tree', parent]);
      else run(['read-tree', '--empty']);
      for (const [src, dest] of mappings) {
        const sha = run(['hash-object', '-w', src]).trim();
        run(['update-index', '--add', '--cacheinfo', `100644,${sha},${dest}`]);
      }
      for (const p of removes) {
        run(['update-index', '--force-remove', p]);
      }
      const tree = run(['write-tree']).trim();
      const pargs = parent ? ['-p', parent] : [];
      // F4: commit-tree result MUST be status-checked and sha-shaped. An
      // unchecked failure yields an empty sha -> the push refspec becomes
      // ":refs/heads/fsm-state" -> the branch is DELETED and commit()
      // reports success (probe-confirmed). FSM_LAB_FAULT_COMMIT_TREE is the
      // test seam for exactly this path.
      const ct = spawnSync('git', ['commit-tree', tree, ...pargs, '-m', message], {
        cwd: this.cwd, encoding: 'utf8', env,
      });
      if (process.env.FSM_LAB_FAULT_COMMIT_TREE === '1' || ct.status !== 0) {
        throw new Error(`commit-tree failed rc=${ct.status}: ${String(ct.stderr || '').slice(0, 200)}`);
      }
      const commit = String(ct.stdout || '').trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) {
        throw new Error(`commit-tree produced a non-sha output (${commit.slice(0, 40)}) — refusing to build a push refspec from it`);
      }
      return commit;
    } finally {
      rmSync(idx, { recursive: true, force: true });
    }
  }

  // commit({mutate, message}) — CAS loop with jittered backoff:
  //   mutate(currentState, queue, controlQueue, queueBad, ctlBad,
  //          intakeQueue, intakeBad)
  //     -> {state, journalRecords, queue?, controlQueue?, intakeQueue?,
  //         actions?, message?, noop?}
  //   Queue out-fields (ALL three, same discipline):
  //     Array  -> rewrite the file (EMPTY array = DELETE = consume-all)
  //     undefined -> UNTOUCHED (park — the pre-W-C1 callers' shape)
  // Retries on non-FF push (concurrent writer landed). The sleep between
  // attempts (250ms × attempt × jitter) de-synchronizes contending writers —
  // the tight-loop version starved 15/36 writers in the 6-writer probe.
  commit({ mutate, message, attempts = 6 }) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        // sync jittered backoff — de-synchronizes contending CAS writers
        const ms = Math.round(250 * i * (0.8 + Math.random() * 0.4));
        spawnSync('sleep', [String(Math.min(ms, 2000) / 1000)]);
      }
      this.fetch();
      const head = this.headSha();
      const { state } = this.readState();
      const q = this.readQueueEx();
      const cq = this.readControlQueueEx();
      // T46/W-C1 §4b: the THIRD queue — the intake door's parking lot. Read
      // on EVERY commit (params 6-7) so the conductor's rollover/drain sees
      // it exactly like the other two; callers that ignore the params are
      // unaffected (the backward-compat rule).
      const iq = this.readIntakeQueueEx();
      // NOTE: state=null (corrupt/missing) is NOT fatal — mutate(null) is the
      // recovery path: the caller repairs from findLastGoodState()/journal.
      const out = mutate(state ? structuredClone(state) : null, q.items, cq.items, q.bad, cq.bad, iq.items, iq.bad);
      // T46/W-C2-R (F7 live follow-up): prCandidates MUST ride the commit's
      // return — the conductor's PR flow consumes it AFTER the commit, and
      // this wrapper reconstructing its own shape silently dropped it (the
      // X22 live probe: the completing tick logged no PR-FLOW line at all;
      // the candidates scan on the live state found the task — the key never
      // arrived). The allowlist stays explicit (never a blind spread).
      if (out.noop) return { committed: false, reason: out.reason, state, actions: out.actions || [], ...(Array.isArray(out.prCandidates) ? { prCandidates: out.prCandidates } : {}) };
      const journalRecords = out.journal || [];
      const dir = mkdtempSync(join(tmpdir(), 'fsm-c-'));
      try {
        // rotation: DISJOINT generations — the new gen carries ONLY the new
        // records; the previous gen file is left untouched on the branch
        // (F5: the old seed-with-previous-500 behavior made each gen a ~99%
        // duplicate of its predecessor — 2000 lines / 512 distinct ids live).
        // F-A: the repair's journalDropFrom threads the rollback sweep INTO
        // the plan (one writer per gen path — see rotatePlan).
        const rot = this.rotatePlan(journalRecords, { dropFrom: out.journalDropFrom });
        if (rot.dropped > 0) {
          console.log(`journal sweep: dropped ${rot.dropped} rolled-back record(s) with id >= ${out.journalDropFrom} (rollback repair)`);
        }
        const mappings = [];
        const removes = [];
        writeFileSync(join(dir, 'state.json'), JSON.stringify(out.state, null, 1) + '\n');
        mappings.push([join(dir, 'state.json'), 'state/state.json']);
        if (rot.currentBlock.length > 0 || rot.fresh) {
          writeFileSync(join(dir, 'journal.jsonl'), rot.currentBlock.map(l => JSON.stringify(l)).join('\n') + '\n');
          mappings.push([join(dir, 'journal.jsonl'), `state/journal-${rot.gen}.jsonl`]);
        }
        // F-A: swept non-current retained gens (rewrite with kept records)
        for (const sw of rot.sweeps || []) {
          writeFileSync(join(dir, `journal-sweep-${sw.gen}.jsonl`), sw.records.map(l => JSON.stringify(l)).join('\n') + '\n');
          mappings.push([join(dir, `journal-sweep-${sw.gen}.jsonl`), `state/journal-${sw.gen}.jsonl`]);
        }
        // the report queue: the tick drain writes the EMPTIED queue (F1:
        // consume-on-drain — rejected events are journaled, never re-parked)
        if (Array.isArray(out.queue)) {
          if (out.queue.length > 0) {
            writeFileSync(join(dir, 'queue.jsonl'), out.queue.map(l => JSON.stringify(l)).join('\n') + '\n');
            mappings.push([join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']);
          } else {
            removes.push('state/reports-queue.jsonl');
          }
        } else if (out.queueAppend) {
          const merged = [...this.readQueue(), ...out.queueAppend];
          writeFileSync(join(dir, 'queue.jsonl'), merged.map(l => JSON.stringify(l)).join('\n') + '\n');
          mappings.push([join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']);
        }
        // control queue: same discipline (drained tick writes survivors — now
        // always empty: controls are consumed applied-or-rejected)
        if (Array.isArray(out.controlQueue)) {
          if (out.controlQueue.length > 0) {
            writeFileSync(join(dir, 'ctl.jsonl'), out.controlQueue.map(l => JSON.stringify(l)).join('\n') + '\n');
            mappings.push([join(dir, 'ctl.jsonl'), 'state/control-queue.jsonl']);
          } else {
            removes.push('state/control-queue.jsonl');
          }
        }
        // T46/W-C1 §4b (m-5): the INTAKE queue — third queue, same discipline.
        // Array -> rewrite the file: the epoch rollover's consume is
        // rewrite-MINUS-HEAD, and the full drain returns [] which DELETES the
        // file (consume-all). undefined -> UNTOUCHED: the park case — a
        // park-only tick journals nothing, so a live chain with a parked
        // queue still quiesces cleanly (the file is the cross-tick surface).
        if (Array.isArray(out.intakeQueue)) {
          if (out.intakeQueue.length > 0) {
            writeFileSync(join(dir, 'intake.jsonl'), out.intakeQueue.map(l => JSON.stringify(l)).join('\n') + '\n');
            mappings.push([join(dir, 'intake.jsonl'), 'state/intake-queue.jsonl']);
          } else {
            removes.push('state/intake-queue.jsonl');
          }
        }
        for (const dead of rot.remove) removes.push(dead);
        const commit = this.buildCommit(mappings, removes, head, out.message || message);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) {
          // carry the caller's extra fields (actions!) — the conductor
          // executes them AFTER the commit; losing them here would assign
          // leases that no worker ever serves (the live-caught bug)
          // T46/W-C2-R (F7 live follow-up): same pass-through on the committed
          // path (see the noop branch above for the rationale).
          return { committed: true, sha: commit, state: out.state, journal: journalRecords, actions: out.actions || [], message: out.message, ...(Array.isArray(out.prCandidates) ? { prCandidates: out.prCandidates } : {}) };
        }
        // error taxonomy: non-FF (a rival landed — retry) vs transport
        const errText = (push.stderr || '');
        const isFF = errText.includes('rejected') || errText.includes('non-fast-forward') || errText.includes('!');
        lastErr = new Error(
          (isFF ? 'CAS conflict' : 'TRANSPORT (push)')
          + ` (attempt ${i + 1}/${attempts}): ${errText.split('\n').filter(l => l.includes('!') || l.includes('rejected') || l.includes('fatal') || l.includes('error')).join(' ').slice(0, 200)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw lastErr || new Error('commit failed');
  }

  // The last `n` journal records currently on the branch (the active tail —
  // enough for dedup keys and rotation bookkeeping without full replay).
  // The report queue: workers CAS-append lines; the tick drains atomically.
  // Data flows through git; dispatches stay the WAKE mechanism only (the
  // concurrency-group depth-1 discovery made run-per-report lossy).
  readQueue() {
    return this.readQueueEx().items;
  }

  // F1-audit: surface unparseable lines — the drain journals them as
  // REJECTED(unparseable) before the rewrite drops them (audit trail).
  // T45/F-G(d): strict presence check — an EXISTING-but-unreadable queue file
  // throws instead of masquerading as empty.
  readQueueEx() {
    const raw = this.readFileStrict('state/reports-queue.jsonl');
    if (!raw) return { items: [], bad: [] };
    const items = [];
    const bad = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { items.push(JSON.parse(t)); } catch { bad.push(t.slice(0, 160)); }
    }
    return { items, bad };
  }

  // enqueueControl(rec) — the OPS side: CAS-append one line to the control
  // queue. The conductor's tick drains controls atomically (external
  // dispatches into the hot conductor group get newest-wins-cancelled —
  // the live discovery; controls ride git instead).
  // T45/F-G(d2): the merge reads via readControlQueueEx and re-serializes any
  // unparseable lines VERBATIM ahead of the appended record — a non-drain
  // writer never silently deletes a line it cannot parse (G-11; the
  // audit-before-drop discipline holds: only the conductor's drain journals
  // REJECTED(unparseable) and drops them).
  enqueueControl(rec, { attempts = 8 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) spawnSync('sleep', [String(Math.round(250 * i * (0.8 + Math.random() * 0.4)) / 1000)]);
      this.fetch();
      const head = this.headSha();
      const { items, bad } = this.readControlQueueEx();
      const dir = mkdtempSync(join(tmpdir(), 'fsm-ctl-'));
      try {
        // F-G(d2): bad lines are re-serialized VERBATIM (raw bytes, NOT
        // JSON.stringify-quoted — quoting would make them parseable and
        // silently change their class); parsed items + the new record are
        // stringified normally.
        const merged = [...bad.map(String), ...items.map(l => JSON.stringify(l)), JSON.stringify(rec)];
        writeFileSync(join(dir, 'ctl.jsonl'), merged.join('\n') + '\n');
        const commit = this.buildCommit(
          [[join(dir, 'ctl.jsonl'), 'state/control-queue.jsonl']], [], head,
          `control-queue +1 ${rec.cmd} ${rec.id}`);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) return { ok: true };
        lastErr = new Error(`control CAS conflict (attempt ${i + 1})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: false, err: String(lastErr) };
  }

  readControlQueue() {
    return this.readControlQueueEx().items;
  }

  readControlQueueEx() {
    // T45/F-G(d): strict presence check (same discipline as the report queue)
    const raw = this.readFileStrict('state/control-queue.jsonl');
    if (!raw) return { items: [], bad: [] };
    const items = [];
    const bad = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { items.push(JSON.parse(t)); } catch { bad.push(t.slice(0, 160)); }
    }
    return { items, bad };
  }

  // T46/W-C1 §4b: the INTAKE queue — the door's parking lot. The THIRD
  // queue, mirroring the control-queue discipline EXACTLY (F-G(d) strict
  // presence, F-G(d2) merge-reserialize): the DOOR CAS-appends one line per
  // accepted issue spec; the conductor's epoch rollover (§5, lane A) drains
  // atomically inside its own commit — consume = rewrite-minus-head or
  // DELETE-on-empty (m-5); park (an active epoch) = the file untouched.
  // Lines: {issue, body_sha8, spec, enqueued_at, author} (§2c).
  readIntakeQueue() {
    return this.readIntakeQueueEx().items;
  }

  readIntakeQueueEx() {
    // T45/F-G(d): strict presence check (same discipline as the other two
    // queues — present-but-unreadable THROWS, never masquerades as empty)
    const raw = this.readFileStrict('state/intake-queue.jsonl');
    if (!raw) return { items: [], bad: [] };
    const items = [];
    const bad = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { items.push(JSON.parse(t)); } catch { bad.push(t.slice(0, 160)); }
    }
    return { items, bad };
  }

  // enqueueIntake(rec) — the DOOR side: CAS-append one line to the intake
  // queue (the enqueueControl pattern VERBATIM). The conductor's rollover
  // drains atomically; a burst of doors CAS-conflict and retry harmlessly.
  // T45/F-G(d2): the merge reads via readIntakeQueueEx and re-serializes any
  // unparseable lines VERBATIM ahead of the appended record — the door never
  // silently deletes a line it cannot parse (only the conductor's drain
  // journals REJECTED(unparseable) and drops; §5, lane A).
  // T46/W-C1-R (lens-1 MINOR-4 fold): the optional `matches` predicate is
  // re-checked on the FRESH read inside EVERY CAS attempt — the door's
  // read-decide-append raced a second door run for the same issue+body
  // (close→reopen within seconds) and both appended (the TOCTOU double-
  // enqueue). With matches, the second run's CAS attempt sees the first's
  // line and returns {ok:true, deduped:true} — the append never lands twice.
  enqueueIntake(rec, { attempts = 8, matches } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) spawnSync('sleep', [String(Math.round(250 * i * (0.8 + Math.random() * 0.4)) / 1000)]);
      this.fetch();
      const head = this.headSha();
      const { items, bad } = this.readIntakeQueueEx();
      if (typeof matches === 'function' && items.some(matches)) {
        return { ok: true, deduped: true };
      }
      const dir = mkdtempSync(join(tmpdir(), 'fsm-intake-'));
      try {
        // F-G(d2): bad lines re-serialized VERBATIM (raw bytes, NOT
        // JSON.stringify-quoted — quoting would make them parseable and
        // silently change their class); parsed items + the new record are
        // stringified normally.
        const merged = [...bad.map(String), ...items.map(l => JSON.stringify(l)), JSON.stringify(rec)];
        writeFileSync(join(dir, 'intake.jsonl'), merged.join('\n') + '\n');
        const commit = this.buildCommit(
          [[join(dir, 'intake.jsonl'), 'state/intake-queue.jsonl']], [], head,
          `intake-queue +1 issue ${rec.issue} ${rec.body_sha8}`);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) return { ok: true };
        lastErr = new Error(`intake CAS conflict (attempt ${i + 1})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: false, err: String(lastErr) };
  }

  // enqueueReport(report) — the WORKER side: CAS-append one line.
  // T45/F-G(d2): the merge reads via readQueueEx and re-serializes any
  // unparseable lines VERBATIM ahead of the appended record — a worker's
  // CAS-append onto a queue holding a bad line preserves it (G-11: the last
  // real unaudited-drop surface; the conductor's drain is the only consumer
  // that may drop, and it journals first).
  enqueueReport(report, { attempts = 8 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) spawnSync('sleep', [String(Math.round(250 * i * (0.8 + Math.random() * 0.4)) / 1000)]);
      this.fetch();
      const head = this.headSha();
      const { items, bad } = this.readQueueEx();
      const dir = mkdtempSync(join(tmpdir(), 'fsm-q-'));
      try {
        // F-G(d2): bad lines are re-serialized VERBATIM (raw bytes, NOT
        // JSON.stringify-quoted — quoting would make them parseable and
        // silently change their class); parsed items + the new record are
        // stringified normally.
        const merged = [...bad.map(String), ...items.map(l => JSON.stringify(l)), JSON.stringify(report)];
        writeFileSync(join(dir, 'queue.jsonl'), merged.join('\n') + '\n');
        const commit = this.buildCommit(
          [[join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']], [], head,
          `report-queue +1 ${report.task} ${report.event_id}`);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) return { ok: true };
        lastErr = new Error(`queue CAS conflict (attempt ${i + 1})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: false, err: String(lastErr) };
  }

  // The last `n` journal records currently on the branch (the active tail —
  // enough for dedup keys and rotation bookkeeping without full replay).
  // F5: NUMERIC generation ordering — lexicographic sorts journal-10 before
  // journal-9, silently hiding the newest generation from the tail.
  readJournalTail(n = 64) {
    const gens = this.listStateFiles()
      .map(f => f.match(/^state\/journal-(\d+)\.jsonl$/))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => a - b);
    const out = [];
    for (const g of gens.reverse()) {
      const raw = this.readFile(`state/journal-${g}.jsonl`);
      if (!raw) continue;
      const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
      for (const line of lines.reverse()) {
        try { out.push(JSON.parse(line)); } catch { console.warn(`journal-${g}: unparseable line skipped (tail read)`); }
        if (out.length >= n) break;
      }
      if (out.length >= n) break;
    }
    return out.reverse();
  }

  // Rotation plan: rotate_at records per generation, keep_gens retained.
  // F5 DISJOINT generations: on overflow the new generation carries ONLY the
  // new records — the previous gen file stays as-is on the branch. (The old
  // behavior seeded the new gen with the previous 500 lines = a ~99%
  // duplicate sliding window: 2000 retained lines / 512 distinct ids.)
  // An oversized batch (new records > rotateAt in one commit) lands in one
  // big gen and rotates again next commit — bounded by drain sizes.
  //
  // F-A (T45): the corruption-repair ROLLBACK SWEEP lives INSIDE this plan
  // ({ dropFrom }). Direction (R3 D1-B1, adjudicated): each retained gen is
  // rewritten to contain ONLY records with idNum < dropFrom (the pre-snapshot
  // GOOD records are KEPT); records with idNum >= dropFrom (the rolled-back
  // era) are DROPPED and counted into `dropped`. Integration point (R3 D1-M1,
  // pinned): ONE writer per gen path per commit — the current gen's append
  // block is assembled from the SWEPT previous lines, and non-current retained
  // gens get their rewrite mappings (`sweeps`) from this same plan; never a
  // second update-index pass over the same file (two mappings to one path =
  // the later silently wins — either the sweep is undone or the repair's own
  // records are lost). If the sweep empties the current gen entirely, the gen
  // file is REMOVED and the records land in the NEXT gen (adjudicated choice;
  // id-safe either way). Records with unparseable ids are KEPT (fail-safe
  // toward preserving bytes when the predicate cannot decide).
  rotatePlan(newRecords, { dropFrom } = {}) {
    const sweepActive = Number.isFinite(dropFrom);
    const keepPred = (j) => {
      if (!sweepActive) return true;
      const n = parseInt(String(j?.id || '').slice(1), 10);
      return !Number.isFinite(n) || n < dropFrom;
    };
    let dropped = 0;
    const sweepRecords = (recs) => recs.filter(j => {
      if (keepPred(j)) return true;
      dropped += 1;
      return false;
    });
    // non-current retained gens: swept here so THIS plan is the one writer
    // per gen path (pruned gens are skipped — the prune-remove covers them).
    // No sweep active -> zero extra reads (the plan is byte-identical to the
    // pre-F-A behavior).
    const sweepOthers = (currentGen, pruneSet) => {
      if (!sweepActive) return { sws: [], rms: [] };
      const sws = [];
      const rms = [];
      for (const g of gens) {
        if (g === currentGen) continue;
        if (pruneSet.has(`state/journal-${g}.jsonl`)) continue;
        const recs = this.readJournalLines(g);
        const kept = sweepRecords(recs);
        if (kept.length === 0) rms.push(`state/journal-${g}.jsonl`);
        else if (kept.length < recs.length) sws.push({ gen: g, records: kept });
      }
      return { sws, rms };
    };

    const gens = this.listStateFiles()
      .map(f => f.match(/^state\/journal-(\d+)\.jsonl$/))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => a - b);
    let gen = gens.length ? gens[gens.length - 1] : 1;
    const currentRecords = gens.length ? this.readJournalLines(gen) : [];
    const sweptCurrent = sweepActive ? sweepRecords(currentRecords) : currentRecords;
    // a sweep that empties the current gen entirely: the gen file is removed
    // and the records land in the NEXT gen (adjudicated)
    const emptied = sweepActive && sweptCurrent.length === 0 && currentRecords.length > 0;

    const ROTATE_AT = this.rotateAt;
    const mergedCount = sweptCurrent.length + newRecords.length;
    if (!emptied && mergedCount <= ROTATE_AT) {
      // append into the current gen: SWEPT previous lines + new records — the
      // single mapping for this path carries the whole block
      const { sws, rms } = sweepOthers(gen, new Set());
      return { gen, currentBlock: [...sweptCurrent, ...newRecords], remove: rms, sweeps: sws, dropped, fresh: newRecords.length > 0 };
    }
    // rotate: NEW generation carries ONLY the new records (disjoint); the
    // swept current gen is rewritten in place (or removed if emptied / pruned)
    const nextGen = gen + 1;
    const keep = this.keepGens;
    const pruneSet = new Set([...gens, nextGen].filter(g => g <= nextGen - keep).map(g => `state/journal-${g}.jsonl`));
    const { sws, rms } = sweepOthers(gen, pruneSet);
    const sweeps = [...sws];
    const removes = [...rms];
    if (sweepActive) {
      const curPath = `state/journal-${gen}.jsonl`;
      if (pruneSet.has(curPath)) { /* the prune-remove covers it — no rewrite */ }
      else if (emptied) removes.push(curPath);
      else sweeps.push({ gen, records: sweptCurrent });
    }
    return { gen: nextGen, currentBlock: newRecords, remove: [...new Set([...pruneSet, ...removes])], sweeps, dropped, fresh: true };
  }

  readJournalLines(gen) {
    // T45/F-G(d): strict presence check — a gen file PRESENT but unreadable
    // throws instead of reading as empty (the F-A sweep would otherwise treat
    // it as emptied and REMOVE it — silent record loss exactly when the
    // system is already damaged). Line-parseability stays WARN-skip (the
    // strict check is about FILE presence, not line parseability).
    const raw = this.readFileStrict(`state/journal-${gen}.jsonl`);
    if (!raw) return [];
    return raw.split('\n').map(s => s.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { console.warn(`journal-${gen}: unparseable line dropped on rewrite (F5-WARN)`); return null; } })
      .filter(Boolean);
  }

  // findLastGoodState(): walk git log of the branch for the most recent
  // commit whose state/state.json parses. Returns {state, sha} | null.
  findLastGoodState() {
    let sha = this.headSha();
    for (let i = 0; i < 200 && sha; i++) {
      const r = this.git(['show', `${sha}:state/state.json`], { acceptCodes: [128] });
      if (r.status === 0) {
        try {
          return { state: JSON.parse(r.stdout), sha };
        } catch { /* keep walking */ }
      }
      const p = this.git(['rev-parse', `${sha}^`], { acceptCodes: [128] });
      sha = p.status === 0 ? p.stdout.trim() : null;
    }
    return null;
  }

  // journalRecordsAfter(sha): all journal records from commits strictly after
  // the given sha (for the corruption-recovery replay path).
  journalRecordsAfter(sha) {
    // collect every journal line ever (bounded by rotation window) — sufficient
    // because recovery replay only needs the recent window; older generations
    // were already folded into the snapshot at that sha.
    return this.readJournals();
  }

  // F-A: count on-branch journal records with idNum >= dropFrom — the
  // rollback sweep's audit count (the RECOVERY record carries it). Same
  // predicate as rotatePlan's sweep; reads the same freshly-fetched tip the
  // repair commit is being built against.
  countJournalFrom(dropFrom) {
    if (!Number.isFinite(dropFrom)) return 0;
    let n = 0;
    for (const j of this.readJournals()) {
      const num = parseInt(String(j?.id || '').slice(1), 10);
      if (Number.isFinite(num) && num >= dropFrom) n += 1;
    }
    return n;
  }
}
