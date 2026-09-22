// test-intake.mjs — T46/W-C1 lane B: the intake door's pure-half pins.
//
// Coverage map (§4a's contract, every rule × valid/invalid):
//   parseSpecBlock   3/4-backtick fences, FIRST tagged block, no-block null,
//                    quoted values (literal ` #`), list literals, comment
//                    stripping, garbage lines + duplicate keys → problems.
//   validateSpec     the FULL rule matrix — 4KB, id charset + default id,
//                    title (required/140/fences), accept XOR behavior,
//                    deps CUT (F-1), artifacts bound to the minted id (m-4)
//                    + '..' traversal, lease/milestone bounds, mode, unknown
//                    keys, problems passthrough, ONE-pass-all-errors.
//   doorDecide       the decision table: bot-silent (flag OR login shape),
//                    no-block → how-to, stranger reject, null-permission
//                    FAIL-CLOSED, invalid-spec one-comment, already-queued
//                    idempotent dedup, enqueue.
//   specToTask       accept → behavior 'real' + spec.accept; behavior spec
//                    passes through; the id default.
//   bodySha8         deterministic 8-hex.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpecBlock, validateSpec, specToTask, doorDecide, bodySha8, howToComment,
  INTAKE_BEHAVIORS, PERMISSION_CLASSES, ID_RE, validId, TASKS_MAX,
} from '../lib/intake.mjs';

const BLOCK = (inner) => '```fsm-task\n' + inner + '\n```';

// ---------------------------------------------------------------------------
// parseSpecBlock
// ---------------------------------------------------------------------------

test('parse: the basic 3-backtick block; keys + values; raw carried', () => {
  const p = parseSpecBlock('preamble\n' + BLOCK('id: T-501\ntitle: research the frob nozzle\naccept: one paragraph with citations') + '\nepilogue');
  assert.ok(p, 'parsed');
  assert.equal(p.spec.id, 'T-501');
  assert.equal(p.spec.title, 'research the frob nozzle');
  assert.equal(p.spec.accept, 'one paragraph with citations');
  assert.ok(p.raw.includes('id: T-501'));
  assert.deepEqual(p.problems, []);
});

test('parse: 4-backtick fences tolerated (CommonMark); FIRST tagged block wins', () => {
  const body = '````fsm-task\nid: FIRST\naccept: a\n````\n\n```fsm-task\nid: SECOND\naccept: b\n```';
  const p = parseSpecBlock(body);
  assert.equal(p.spec.id, 'FIRST');
  const q = parseSpecBlock('```fsm-task\nid: FOUR\naccept: a\n````');   // 3-open, 4-close
  assert.equal(q.spec.id, 'FOUR');
});

test('parse: no tagged block -> null (the how-to lane); empty body -> null', () => {
  assert.equal(parseSpecBlock('just an issue body'), null);
  assert.equal(parseSpecBlock('```python\nprint(1)\n```'), null);
  assert.equal(parseSpecBlock(''), null);
  assert.equal(parseSpecBlock(null), null);
});

test('parse: quoted values keep literal ` #`; unquoted values strip ` #` comments; list literals', () => {
  const p = parseSpecBlock(BLOCK('title: "see issue #5"\naccept: fix it # the real thing\nartifacts: [tasks/T-1/report.md, tasks/T-1/data.json]\ndeps: T-9'));
  assert.equal(p.spec.title, 'see issue #5');
  assert.equal(p.spec.accept, 'fix it');
  assert.deepEqual(p.spec.artifacts, ['tasks/T-1/report.md', 'tasks/T-1/data.json']);
  assert.deepEqual(p.spec.deps, ['T-9']);
});

test('parse: garbage lines + duplicate keys -> problems (fail-closed, never silently ignored)', () => {
  const p = parseSpecBlock(BLOCK('title: x\naccept: y\nthis is garbage\ntitle: duplicate'));
  assert.equal(p.spec.title, 'x', 'the first key wins');
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /not a `key: value` pair/);
  assert.match(p.problems[1], /duplicate key `title`/);
});

// ---------------------------------------------------------------------------
// validateSpec — the rule matrix
// ---------------------------------------------------------------------------

const VALID = { id: 'T-501', title: 'research the frob nozzle', accept: 'one paragraph' };

test('validate: the canonical valid spec passes; the default id derives from the issue', () => {
  const v = validateSpec({ ...VALID }, { issue: 42 });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.id, 'T-501');
  const d = validateSpec({ title: 't', accept: 'a' }, { issue: 42 });
  assert.ok(d.ok);
  assert.equal(d.id, 'task-i42');
});

test('validate: the id charset kills the run-name hazard at the door (R2-MINOR-4)', () => {
  for (const bad of ['T 501', 'T·501', 'task/x', 'a'.repeat(25), 'x·y', 'T-501 · succeed · a2']) {
    const v = validateSpec({ ...VALID, id: bad }, { issue: 1 });
    assert.ok(!v.ok, `id ${JSON.stringify(bad)} must be rejected`);
    assert.ok(v.errors.some(e => e.includes('charset')), `the charset rule names itself for ${JSON.stringify(bad)}`);
  }
  for (const good of ['T-501', 'task_i42', 'a.b_c-d', 'x'.repeat(24)]) {
    assert.ok(validateSpec({ ...VALID, id: good }, { issue: 1 }).ok, `id ${good} is legal`);
  }
});

test('validate: title rules — required, ≤140, no fence sequences', () => {
  assert.ok(!validateSpec({ accept: 'a' }, { issue: 1 }).ok, 'missing title');
  assert.ok(!validateSpec({ title: '   ', accept: 'a' }, { issue: 1 }).ok, 'blank title');
  assert.ok(!validateSpec({ title: 'x'.repeat(141), accept: 'a' }, { issue: 1 }).ok, '141 chars');
  assert.ok(!validateSpec({ title: 'has ``` fence', accept: 'a' }, { issue: 1 }).ok, 'fence sequence');
  assert.ok(validateSpec({ title: 'x'.repeat(140), accept: 'a' }, { issue: 1 }).ok, 'exactly 140 is legal');
});

test('validate: EXACTLY ONE of accept | behavior; the behavior vocabulary is the shim\'s own', () => {
  assert.ok(!validateSpec({ title: 't' }, { issue: 1 }).ok, 'neither');
  assert.ok(!validateSpec({ title: 't', accept: 'a', behavior: 'succeed' }, { issue: 1 }).ok, 'both');
  assert.ok(!validateSpec({ title: 't', accept: '  ' }, { issue: 1 }).ok, 'blank accept');
  assert.ok(!validateSpec({ title: 't', behavior: 'explode' }, { issue: 1 }).ok, 'unknown behavior');
  assert.ok(!validateSpec({ title: 't', behavior: 'real' }, { issue: 1 }).ok, "'real' is NOT door-acceptable (accept: is the real lane)");
  for (const b of INTAKE_BEHAVIORS) {
    const v = validateSpec({ title: 't', behavior: b }, { issue: 1 });
    assert.ok(v.ok, `behavior ${b} is door-legal (${JSON.stringify(v.errors)})`);
  }
});

test('validate: F-1 — deps are CUT unconditionally (the W-D future)', () => {
  const v = validateSpec({ ...VALID, deps: ['T-101'] }, { issue: 1 });
  assert.ok(!v.ok);
  assert.ok(v.errors.some(e => e.includes('deps arrive with multi-task epochs')), 'the error names the fold');
});

test('validate: artifacts bind to the MINTED id (m-4) + the .. traversal fold', () => {
  assert.ok(validateSpec({ ...VALID, artifacts: ['tasks/T-501/report.md'] }, { issue: 1 }).ok, 'bound path is legal');
  assert.ok(!validateSpec({ ...VALID, artifacts: ['tasks/OTHER/report.md'] }, { issue: 1 }).ok, 'foreign-task path rejected');
  assert.ok(!validateSpec({ ...VALID, artifacts: ['tasks/T-501/../evil.md'] }, { issue: 1 }).ok, 'traversal rejected');
  const d = validateSpec({ title: 't', accept: 'a', artifacts: ['tasks/task-i9/report.md'] }, { issue: 9 });
  assert.ok(d.ok, 'the DEFAULT id binds too');
  assert.ok(!validateSpec({ ...VALID, artifacts: 'tasks/T-501/report.md' }, { issue: 1 }).ok, 'a bare string must be normalized by parseSpecBlock — direct spec without it rejects');
});

test('validate: lease_minutes + milestone bounds; mode vocabulary', () => {
  assert.ok(validateSpec({ ...VALID, lease_minutes: 45, milestone: 2, mode: 'cc' }, { issue: 1 }).ok);
  // s22/B-1: the floor moved 1 -> 3 (the advertised bounds and the enforcement
  // together): 3 is the minimum legal lease; 1-2 are the work-destroying trap
  // (envelope deadline = min(lease,48) - 120s <= 0 at assign) and now REJECTED
  // at the door — the carry (specLeaseMinutes) clamps any pre-floor queue line
  assert.ok(validateSpec({ ...VALID, lease_minutes: 3 }, { issue: 1 }).ok, 'the floor 3 is legal');
  for (const lm of [0, 1, 2, 121, -1, 'x']) assert.ok(!validateSpec({ ...VALID, lease_minutes: lm }, { issue: 1 }).ok, `lease_minutes ${lm} rejected`);
  const v2 = validateSpec({ ...VALID, lease_minutes: 2 }, { issue: 1 });
  assert.ok(v2.errors.some(e => e.includes('lease_minutes 2 is outside [3, 120]')), 'the rejection names the NEW bounds (the how-to text and the error agree)');
  for (const ms of [0, 10]) assert.ok(!validateSpec({ ...VALID, milestone: ms }, { issue: 1 }).ok, `milestone ${ms} rejected`);
  assert.ok(!validateSpec({ ...VALID, mode: 'docker' }, { issue: 1 }).ok, 'unknown mode');
});

test('validate: unknown keys rejected WITH the key named (typo protection)', () => {
  const v = validateSpec({ ...VALID, acept: 'typo', titel: 'typo2' }, { issue: 1 });
  assert.ok(!v.ok);
  assert.ok(v.errors.some(e => e.includes('acept') && e.includes('titel')), 'the unknown keys are named');
});

test('validate: the 4KB bound (raw block); ONE pass collects EVERY violation (anti-drip)', () => {
  const big = 'x'.repeat(4097);
  const v = validateSpec({ title: '```', accept: 'a', behavior: 'succeed', deps: [], id: 'bad id', artifact: 1 }, { issue: 1, raw: big });
  assert.ok(!v.ok);
  assert.ok(v.errors.some(e => e.includes('4096 bytes')));
  assert.ok(v.errors.length >= 5, `every violation lands in ONE list (got ${v.errors.length}: ${v.errors.join(' | ')})`);
});

test('validate: parse problems become rejection errors verbatim', () => {
  const v = validateSpec({ ...VALID }, { issue: 1, problems: ['line 3: not a `key: value` pair ("garbage")'] });
  assert.ok(!v.ok);
  assert.ok(v.errors.some(e => e.includes('line 3')));
});

// ---------------------------------------------------------------------------
// doorDecide — the decision table
// ---------------------------------------------------------------------------

const BODY_OK = BLOCK('title: research the frob nozzle\naccept: one paragraph');

test('door: bots are SILENT (flag OR login shape) — before any API call', () => {
  assert.deepEqual(doorDecide({ author: 'github-actions[bot]', isBot: true, permission: 'admin', body: BODY_OK, issue: 1 }), { decision: 'silent' });
  const d = doorDecide({ author: 'some-app[bot]', isBot: false, permission: 'admin', body: BODY_OK, issue: 1 });
  assert.equal(d.decision, 'silent', 'the login shape alone is sufficient');
});

test('door: no fsm-task block -> the how-to comment (schema template verbatim)', () => {
  const d = doorDecide({ author: 'op', isBot: false, permission: 'admin', body: 'just talking', issue: 5 });
  assert.equal(d.decision, 'reject');
  assert.ok(d.comment.includes('```fsm-task'));
  assert.ok(d.comment === howToComment(), 'the verbatim template');
});

test('door: strangers rejected (one comment, stays open); the class list is the write side', () => {
  assert.deepEqual(PERMISSION_CLASSES, ['admin', 'maintain', 'write', 'owner']);
  const d = doorDecide({ author: 'stranger', isBot: false, permission: 'read', body: BODY_OK, issue: 5 });
  assert.equal(d.decision, 'reject');
  assert.match(d.comment, /write access/);
  assert.match(d.comment, /read/);
  const d2 = doorDecide({ author: 'stranger', isBot: false, permission: 'none', body: BODY_OK, issue: 5 });
  assert.equal(d2.decision, 'reject');
});

test('door: permission null (API error) -> FAIL-CLOSED with its own comment', () => {
  const d = doorDecide({ author: 'op', isBot: false, permission: null, body: BODY_OK, issue: 5 });
  assert.equal(d.decision, 'reject');
  assert.match(d.comment, /failing closed/i);
});

test('door: invalid spec -> ONE comment listing EVERY violated rule', () => {
  const body = BLOCK('deps: [T-1]\nid: "bad id"\ntitle: x```y\naccept: a\nbehavior: succeed\nunknown_key: 1');
  const d = doorDecide({ author: 'op', isBot: false, permission: 'write', body, issue: 5 });
  assert.equal(d.decision, 'reject');
  assert.match(d.comment, /rule\(s\) violated/);
  assert.ok(d.comment.includes('deps arrive with multi-task epochs'));
  assert.ok(d.comment.includes('charset'));
  assert.ok(d.comment.includes('fence-forming'));
  assert.ok(d.comment.includes('exactly ONE'));
  assert.ok(d.comment.includes('unknown_key'));
});

test('door: already-queued (same issue + same body sha8) -> SILENT + the idempotence comment', () => {
  const queue = [{ issue: 5, body_sha8: bodySha8(BODY_OK), spec: {}, enqueued_at: 't', author: 'op' }];
  const d = doorDecide({ author: 'op', isBot: false, permission: 'write', body: BODY_OK, issue: 5, queue });
  assert.equal(d.decision, 'silent');
  assert.match(d.comment, /already queued/);
  // a DIFFERENT body (edited) re-queues — F-11's edited-spec contract
  const d2 = doorDecide({ author: 'op', isBot: false, permission: 'write', body: BODY_OK + '\n(edited)', issue: 5, queue });
  assert.equal(d2.decision, 'enqueue');
  // a different ISSUE with the same body also enqueues
  const d3 = doorDecide({ author: 'op', isBot: false, permission: 'write', body: BODY_OK, issue: 6, queue });
  assert.equal(d3.decision, 'enqueue');
});

test('door: the happy path — enqueue with the parsed spec + the minted id', () => {
  const d = doorDecide({ author: 'op', isBot: false, permission: 'maintain', body: BODY_OK, issue: 42, queue: [] });
  assert.equal(d.decision, 'enqueue');
  assert.equal(d.id, 'task-i42');
  assert.equal(d.spec.title, 'research the frob nozzle');
});

// ---------------------------------------------------------------------------
// specToTask + bodySha8
// ---------------------------------------------------------------------------

test('specToTask: accept -> behavior real + spec.accept; behavior passes; the id default; deps always []', () => {
  const a = specToTask({ title: 't', accept: 'criteria' }, { issue: 42, bodySha8: 'abcd1234' });
  assert.equal(a.id, 'task-i42');
  assert.equal(a.behavior, 'real');
  assert.equal(a.spec.accept, 'criteria');
  assert.equal(a.spec.issue, 42);
  assert.deepEqual(a.deps, []);
  const b = specToTask({ id: 'T-9', title: 't', behavior: 'flaky', artifacts: ['tasks/T-9/r.md'] }, { issue: 3 });
  assert.equal(b.id, 'T-9');
  assert.equal(b.behavior, 'flaky');
  assert.deepEqual(b.spec.artifacts, ['tasks/T-9/r.md']);
});

test('bodySha8: deterministic 8-hex; distinguishes bodies', () => {
  const h = bodySha8('hello world');
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(h, bodySha8('hello world'));
  assert.notEqual(h, bodySha8('hello worlds'));
  assert.equal(bodySha8(''), 'e3b0c442', 'the empty-string sha256 prefix');
});

// ---------------------------------------------------------------------------
// T46/W-C2-R fold pins (m2/m3 — lens 1's intake findings)
// ---------------------------------------------------------------------------

test('W-C2-R m2: the id charset is ONE path language — git-ref-valid AND door-compatible (no .lock / no leading dash / no .. runs)', () => {
  // valid: alnum first char, then [A-Za-z0-9._-]
  for (const ok of ['T-900', 'a', 'task_1.x', 'A9']) {
    assert.equal(validId(ok), true, `${ok} should pass`);
  }
  // the old charset admitted these; each is a live failure downstream:
  // 'T-900.lock' — invalid git ref (checkout -b dies → infra → quarantine)
  for (const bad of ['T-900.lock', '-x', '.hidden', 'a..b', 'T-900.', '', 'x'.repeat(25)]) {
    assert.equal(validId(bad), false, `${bad} must be rejected at the door`);
  }
});

test('W-C2-R m3: artifacts count capped at 32 (the envelope\'s ENVELOPE_ARTIFACTS_MAX — the rejection belongs at intake, not the worker gate)', () => {
  const arts = [];
  for (let i = 0; i < 33; i++) arts.push(`tasks/i99/file${i}.md`);
  const r = validateSpec({ id: 'i99', title: 't', accept: 'a', artifacts: arts }, { issue: 99 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /artifacts carries 33 paths \(cap 32/.test(e)), `the count rejection: ${r.errors.join(' | ')}`);
  // 32 passes the count check (path binding still governs each)
  const r2 = validateSpec({ id: 'i99', title: 't', accept: 'a', artifacts: arts.slice(0, 32) }, { issue: 99 });
  assert.equal(r2.ok, true, `32 is fine: ${JSON.stringify(r2.errors || [])}`);
  assert.ok(!(r2.errors || []).some(e => e.startsWith('artifacts carries')));
});

// ---------------------------------------------------------------------------
// s22/B-1 (staged-mode §2.2): the MULTI-TASK DOOR — the tasks form. The
// staged design's verbatim shape (§2.2's worked example): epoch-level
// `mode`/`lease_minutes` + one bracketed one-liner entry per task; the SAME
// per-task rules per entry (the shared validateTaskFields table); per-entry
// duplicate-id rejection; the 32-entry cap (the machine's own max_parallel
// ceiling — the X27 soak's headroom); the single-task form byte-identical.
// ---------------------------------------------------------------------------

// the §2.2 verbatim nightly body (the seed job's template shape)
const STAGED_BLOCK = BLOCK([
  'mode: mock',
  'lease_minutes: 15',
  'tasks:',
  '  - { id: T-STG-A-1031, behavior: fast, title: staged nightly A (happy path) }',
  '  - { id: T-STG-B-1031, behavior: fast, title: staged nightly B (mirror overflow) }',
  '  - { id: T-STG-C-1031, behavior: infra-flaky, title: staged nightly C (infra retry) }',
  '  - { id: T-STG-H-1031, behavior: hang, title: staged nightly H (lease expiry) }',
].join('\n'));

test('B-1 parse: the staged §2.2 verbatim block — 4 bracketed one-liners, epoch-level mode/lease', () => {
  const p = parseSpecBlock(STAGED_BLOCK);
  assert.ok(p, 'parsed');
  assert.deepEqual(p.problems, []);
  assert.equal(p.spec.mode, 'mock');
  assert.equal(p.spec.lease_minutes, '15');
  assert.equal(p.spec.tasks.length, 4);
  assert.deepEqual(p.spec.tasks[0], { id: 'T-STG-A-1031', behavior: 'fast', title: 'staged nightly A (happy path)' });
  assert.deepEqual(p.spec.tasks[3], { id: 'T-STG-H-1031', behavior: 'hang', title: 'staged nightly H (lease expiry)' });
  assert.ok(p.raw.includes('T-STG-H-1031'), 'the raw block (4KB input) covers the entries');
});

test('B-1 parse: entry quoting + comma survival — a quoted title comma and an artifacts list literal inside one entry', () => {
  const p = parseSpecBlock(BLOCK([
    'tasks:',
    '  - { id: T-1, title: "a, b, c", behavior: fast, artifacts: [tasks/T-1/r.md, tasks/T-1/d.json] }',
    '  - { id: T-2, accept: "see #5" }',
  ].join('\n')));
  assert.deepEqual(p.problems, []);
  assert.equal(p.spec.tasks[0].title, 'a, b, c', 'the quoted comma stays ONE title');
  assert.deepEqual(p.spec.tasks[0].artifacts, ['tasks/T-1/r.md', 'tasks/T-1/d.json'], 'the entry-level list literal parses like the block level');
  assert.equal(p.spec.tasks[1].accept, 'see #5', 'quoted ` #` rides');
});

test('B-1 parse: entry garbage is a PROBLEM (fail-closed) — bad segment + duplicate entry key; a non-entry line ends the list', () => {
  const p = parseSpecBlock(BLOCK([
    'tasks:',
    '  - { id: T-1, just garbage here, title: x }',
    '  - { id: T-2, id: T-2, behavior: fast }',
    'milestone: 2',
  ].join('\n')));
  assert.equal(p.spec.tasks.length, 2, 'both entry lines still parse (problems reject, not drop)');
  assert.equal(p.spec.tasks[1].id, 'T-2', 'the first entry key wins');
  assert.equal(p.spec.milestone, '2', 'the ordinary key line AFTER the list still parses');
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /task entry segment is not a `key: value` pair/);
  assert.match(p.problems[1], /task entry duplicate key `id`/);
  const v = validateSpec(p.spec, { issue: 1, raw: p.raw, problems: p.problems });
  assert.ok(!v.ok, 'the problems reject the spec (the anti-drip contract)');
});

test('B-1 parse: the single-task form is byte-identical (no tasks member, the old shape)', () => {
  const p = parseSpecBlock(BLOCK('id: T-501\ntitle: research the frob nozzle\naccept: one paragraph\nlease_minutes: 45\nmilestone: 2'));
  assert.deepEqual(p.spec, { id: 'T-501', title: 'research the frob nozzle', accept: 'one paragraph', lease_minutes: '45', milestone: '2' });
  assert.ok(!Object.prototype.hasOwnProperty.call(p.spec, 'tasks'), 'no tasks member minted');
  assert.deepEqual(p.problems, []);
});

test('B-1 validate: the staged 4-task mix ACCEPTS (the §2.2 nightly body, verbatim)', () => {
  const p = parseSpecBlock(STAGED_BLOCK);
  const v = validateSpec(p.spec, { issue: 31, raw: p.raw, problems: p.problems });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.id, 'task-i31', 'the queue-line id stays the issue default; the real ids ride the entries');
  // the 1-entry form accepts too (the minimal multi-task epoch)
  const one = validateSpec({ lease_minutes: '15', tasks: [{ id: 'T-1', title: 't', behavior: 'fast' }] }, { issue: 3 });
  assert.ok(one.ok, JSON.stringify(one.errors));
});

test('B-1 validate: mixed accept/behavior entries — each entry independently exactly-one-of', () => {
  const p = parseSpecBlock(BLOCK([
    'tasks:',
    '  - { id: T-1, title: real lane, accept: one paragraph }',
    '  - { id: T-2, title: mock lane, behavior: hang }',
    '  - { id: T-3, title: quoted real, accept: "criteria, with commas" }',
  ].join('\n')));
  const v = validateSpec(p.spec, { issue: 9, raw: p.raw, problems: p.problems });
  assert.ok(v.ok, JSON.stringify(v.errors));
  // an entry with BOTH rejects; an entry with NEITHER rejects — same rule text, entry-prefixed
  const both = validateSpec({ tasks: [{ id: 'T-1', title: 't', accept: 'a', behavior: 'fast' }] }, { issue: 9 });
  assert.ok(!both.ok);
  assert.ok(both.errors.some(e => /task entry 1 \(T-1\): exactly ONE of accept or behavior — both are present/.test(e)), both.errors.join(' | '));
  const neither = validateSpec({ tasks: [{ id: 'T-1', title: 't' }] }, { issue: 9 });
  assert.ok(!neither.ok);
  assert.ok(neither.errors.some(e => /task entry 1 \(T-1\): exactly ONE of accept or behavior is required/.test(e)), neither.errors.join(' | '));
});

test('B-1 validate: the per-entry duplicate-id REJECT (names the id + both positions)', () => {
  const p = parseSpecBlock(BLOCK([
    'tasks:',
    '  - { id: T-1, behavior: fast, title: a }',
    '  - { id: T-2, behavior: fast, title: b }',
    '  - { id: T-1, behavior: hang, title: c }',
  ].join('\n')));
  const v = validateSpec(p.spec, { issue: 5, raw: p.raw, problems: p.problems });
  assert.ok(!v.ok);
  const dup = v.errors.find(e => e.includes('duplicate task id'));
  assert.ok(dup, `the duplicate-id error exists: ${v.errors.join(' | ')}`);
  assert.match(dup, /duplicate task id "T-1" — task entry 3 repeats task entry 1/);
  assert.match(dup, /task map is keyed by id/);
});

test('B-1 validate: the count cap — 33 entries REJECTS at the 32 ceiling; 32 accepts', () => {
  assert.equal(TASKS_MAX, 32, 'the cap is the machine\'s own max_parallel ceiling (CONFIG_BOUNDS [1,32])');
  const mk = (n) => ({ id: `T-${String(i).padStart(2, '0')}`, title: `t${n}`, behavior: 'fast' });
  const entries = [];
  for (let i = 0; i < 33; i++) entries.push({ id: `T-${String(i).padStart(2, '0')}`, title: 't', behavior: 'fast' });
  const over = validateSpec({ tasks: entries }, { issue: 1 });
  assert.ok(!over.ok);
  assert.ok(over.errors.some(e => /tasks carries 33 entries \(cap 32 — the machine's own max_parallel ceiling, CONFIG_BOUNDS \[1,32\]\)/.test(e)), over.errors.join(' | '));
  const at = validateSpec({ tasks: entries.slice(0, 32) }, { issue: 1 });
  assert.ok(at.ok, `exactly 32 is legal (the X27 soak's headroom): ${JSON.stringify(at.errors)}`);
});

test('B-1 validate: per-entry violations list EVERY violation, entry-prefixed, in ONE pass (anti-drip)', () => {
  const v = validateSpec({
    tasks: [
      { id: 'T-1', title: 'ok', behavior: 'fast' },
      { id: 'bad id', title: 'x'.repeat(141), accept: 'a', behavior: 'hang', deps: ['T-1'], artifacts: ['tasks/OTHER/r.md'], lease_minutes: 2, milestone: 0, mode: 'docker', prio: 'high' },
    ],
  }, { issue: 7 });
  assert.ok(!v.ok);
  const e2 = v.errors.filter(e => e.startsWith('task entry 2'));
  assert.ok(e2.some(x => x.includes('fails the charset')), 'entry id charset');
  assert.ok(e2.some(x => x.includes('title is 141 chars')), 'entry title bound');
  assert.ok(e2.some(x => x.includes('exactly ONE of accept or behavior — both are present')), 'entry XOR');
  assert.ok(e2.some(x => x.includes('deps arrive with multi-task epochs')), 'entry deps CUT');
  assert.ok(e2.some(x => x.includes('must live under tasks/<id-invalid>/')), 'entry artifacts bind to the ENTRY id (invalid id -> the <id-invalid> placeholder, same as the single-task lane)');
  assert.ok(e2.some(x => x.includes('lease_minutes 2 is outside [3, 120]')), 'entry lease floor');
  assert.ok(e2.some(x => x.includes('milestone 0 is outside [1, 9]')), 'entry milestone bound');
  assert.ok(e2.some(x => x.includes('is not one of [mock, real, cc]')), 'entry mode vocab');
  assert.ok(e2.some(x => x.includes('unknown key(s): prio')), 'entry unknown key');
  assert.ok(v.errors.every(e => !e.startsWith('task entry 1')), 'the CLEAN entry contributes no errors');
});

test('B-1 validate: the tasks form degenerates the top level — task keys beside tasks REJECT; epoch keys keep their rules', () => {
  const p = parseSpecBlock(BLOCK([
    'title: should not be here',
    'accept: nor this',
    'mode: docker',
    'lease_minutes: 2',
    'tasks:',
    '  - { id: T-1, behavior: fast, title: a }',
  ].join('\n')));
  const v = validateSpec(p.spec, { issue: 11, raw: p.raw, problems: p.problems });
  assert.ok(!v.ok);
  assert.ok(v.errors.some(e => /the tasks form takes no top-level title, accept/.test(e)), v.errors.join(' | '));
  assert.ok(v.errors.some(e => e.includes('lease_minutes 2 is outside [3, 120]')), 'the epoch-level lease keeps its rule');
  assert.ok(v.errors.some(e => e.includes('mode "docker" is not one of')), 'the epoch-level mode keeps its rule');
  // and the epoch-level knobs ACCEPT on the happy path (§2.2's shape)
  const ok = validateSpec({ mode: 'mock', lease_minutes: '15', tasks: [{ id: 'T-1', title: 't', behavior: 'fast' }] }, { issue: 11 });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
});

test('B-1 validate: entry id REQUIRED in the tasks form (the default would collide across entries); tasks-shape rejects', () => {
  const noId = validateSpec({ tasks: [{ title: 't', behavior: 'fast' }] }, { issue: 42 });
  assert.ok(!noId.ok);
  assert.ok(noId.errors.some(e => /task entry 1: id is required in the tasks form/.test(e)), noId.errors.join(' | '));
  // a scalar tasks value is not the list form
  const scalar = validateSpec({ tasks: 'T-1' }, { issue: 42 });
  assert.ok(!scalar.ok);
  assert.ok(scalar.errors.some(e => e.includes('tasks must be a list of one-line { ... } entries')), scalar.errors.join(' | '));
  // the single-line bracketed literal is NOT the entry form (its comma-split strings are not maps)
  const bracketed = parseSpecBlock(BLOCK('tasks: [{ id: T-1, behavior: fast }, { id: T-2, behavior: hang }]'));
  const bv = validateSpec(bracketed.spec, { issue: 42, raw: bracketed.raw, problems: bracketed.problems });
  assert.ok(!bv.ok, 'the one-line bracket list rejects (one entry PER LINE is the form)');
  assert.ok(bv.errors.some(e => e.includes('task entry 1: must be a one-line { ... } map')), bv.errors.join(' | '));
  // empty tasks list
  const empty = validateSpec({ tasks: [] }, { issue: 42 });
  assert.ok(!empty.ok);
  assert.ok(empty.errors.some(e => e.includes('tasks carries 0 entries')), empty.errors.join(' | '));
});

test('B-1 validate: entry-level artifacts bind to the ENTRY id (m-4 per entry); entry milestone/mode are validated metadata', () => {
  const ok = validateSpec({ tasks: [
    { id: 'T-1', title: 't', behavior: 'fast', artifacts: ['tasks/T-1/report.md'], milestone: '5', mode: 'cc', lease_minutes: '9' },
  ] }, { issue: 2 });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  const foreign = validateSpec({ tasks: [
    { id: 'T-1', title: 't', behavior: 'fast', artifacts: ['tasks/T-2/report.md'] },
  ] }, { issue: 2 });
  assert.ok(!foreign.ok);
  assert.ok(foreign.errors.some(e => e.includes('must live under tasks/T-1/')), foreign.errors.join(' | '));
});

test('B-1 door: the multi-task enqueue path — the decision table is form-agnostic; ONE comment lists every entry violation', () => {
  const d = doorDecide({ author: 'op', isBot: false, permission: 'write', body: STAGED_BLOCK, issue: 31, queue: [] });
  assert.equal(d.decision, 'enqueue');
  assert.equal(d.spec.tasks.length, 4);
  assert.equal(d.id, 'task-i31');
  const bad = doorDecide({
    author: 'op', isBot: false, permission: 'write', issue: 31, queue: [],
    body: BLOCK([
      'tasks:',
      '  - { id: T-1, behavior: fast, title: a }',
      '  - { id: T-1, behavior: fast, title: b }',
      '  - { id: T-2, behavior: explode, title: c }',
    ].join('\n')),
  });
  assert.equal(bad.decision, 'reject');
  assert.match(bad.comment, /rule\(s\) violated/);
  assert.ok(bad.comment.includes('duplicate task id "T-1" — task entry 2 repeats task entry 1'), 'the dup-id lands in the ONE comment');
  assert.ok(bad.comment.includes('task entry 3 (T-2): behavior "explode"'), 'the per-entry violation lands, entry-named');
});

test('B-1 how-to: the multi-task form + the 32 cap are documented (the template a stranger sees)', () => {
  const h = howToComment();
  assert.ok(h.includes('tasks:'), 'the tasks form appears');
  assert.ok(h.includes('- { id: T-601, behavior: fast, title: night check A }'), 'the bracketed one-liner example appears');
  assert.ok(h.includes('1–32 entries'), 'the cap is documented');
  assert.ok(h.includes('every entry needs its OWN id'), 'the per-entry id rule is documented');
  assert.ok(h.includes('not per entry either'), 'the per-entry deps rule is documented');
  // the template's own example blocks must SURVIVE the parser (paste-safe).
  // parseSpecBlock returns the FIRST tagged block; the multi-task example
  // is the SECOND — parse from its fence onward.
  const h2 = h.slice(h.indexOf('```fsm-task', h.indexOf('```fsm-task') + 1));
  const p1 = parseSpecBlock(h2);
  assert.ok(p1 && Array.isArray(p1.spec.tasks) && p1.spec.tasks.length === 2, 'the multi-task example parses');
  assert.deepEqual(p1.problems, []);
  const v1 = validateSpec(p1.spec, { issue: 99, raw: p1.raw, problems: p1.problems });
  assert.ok(v1.ok, `the how-to's own multi-task example is door-legal: ${JSON.stringify(v1.errors)}`);
  const p0 = parseSpecBlock(h);
  assert.ok(p0 && p0.spec.id === 'T-501', 'the single-task example still parses');
});
