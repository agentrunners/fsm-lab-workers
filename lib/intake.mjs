// intake.mjs — the intake door's PURE half (T46/W-C1 §4a, lane B).
//
// The door turns a public issue into a validated task spec queued on
// state/intake-queue.jsonl. This file is the decision core: zero I/O, zero
// network, fully testable. The I/O half (intake/turn.mjs — the workflow
// adapter: permission API, issue comments, the queue push, the nudge) mirrors
// ops/turn.mjs's shape and owns nothing but transport.
//
// WHY A DOOR AT ALL (T46-WC-DESIGN §0/§2): W-B made the machine plane real
// but the only way IN was an operator with curl. The door is the human-plane
// entry — with the trust boundary drawn HERE, at parse+validate time, so a
// hostile issue body can never reach the conductor, the dispatch prompt, or
// the run-name regex as anything but already-vetted data:
//   - the id charset kills the R2-MINOR-4 run-name hazard AT THE DOOR (an id
//     that would mis-split law-4's `task-<id> · <behavior> · a<n>` matching
//     can never exist — it is rejected before it is queued);
//   - F-1 (L1-B1): deps are CUT — per-issue epochs make cross-epoch deps
//     structurally incoherent (every enqueue-legal dep is a drain-time ghost)
//     and the unspecified failure path dead-loops the chain. The door rejects
//     `deps:` unconditionally — PER ENTRY too in the s22/B-1 multi-task form
//     (intra-epoch deps arrive with the future W-D lane).
//   - m-4 (L2): artifacts bind to `^tasks/<minted-id>/` — foreign-task paths
//     are rejected at the door AND the write-back door enforces the same
//     shape (W-C2), so the two doors speak one path language.
//   - the permission class gate FAILS CLOSED: permission null (the API-error
//     marker) rejects — a flaky permission API must never become a free
//     compute lane (§2a).
//
// Every rule is fail-closed and the door NEVER drips: one rejection comment
// lists EVERY violated rule (the anti-drip contract, §2b).

import { createHash } from 'node:crypto';
import { SHIM_BEHAVIORS, LEGACY_BEHAVIORS } from '../sim/harness-shim.mjs';
import { LEASE_FLOOR_MINUTES } from './conductor-core.mjs';

// The behavior vocabulary: IMPORTED from the harness shim, not forked (the
// brief's directive — the door and the harness can never disagree). The
// brief's bracket list mixes the shim's two vocabularies (the contract set
// `succeed|flaky|fail|hang|slow|poison|wb-violation` straddles both), so the
// accepted set is the UNION of the shim's own exported lists — every string
// shimInvoke implements MEANINGFULLY (its default arm turns anything else
// into a visible work_failed burn; the door stops that at the boundary).
// 'real' is deliberately NOT door-acceptable: a real-lane task is expressed
// as `accept:` (specToTask mints behavior 'real' for it).
export const INTAKE_BEHAVIORS = [...SHIM_BEHAVIORS, ...LEGACY_BEHAVIORS];

// §5's contract extension: the spec MAY carry `mode` (the X22 operator
// switch — `mode: cc` mints a CC epoch). Validated against GENESIS_MODES'
// values HERE so a typo fails at the door, not at genesis.
export const INTAKE_MODES = ['mock', 'real', 'cc'];

export const SPEC_MAX_BYTES = 4096;        // §2b: total spec ≤ 4KB (the raw block)
export const TITLE_MAX_CHARS = 140;        // §2b
export const ACCEPT_MAX_CHARS = 2048;      // §4a
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;  // run-name-hazard killer + first-char-alnum (door-compatible: TASK_BRANCH_RE requires it)
// W-C2-R m2: the FULL git-ref-validity gate — the charset alone admits
// '.lock' suffixes, '..' runs and trailing dots, each an INVALID git ref
// (checkout -b fails → 3 infra retries → quarantine). One path language
// across intake/git/door: the minted id must be a ref-safe tasks/<id> name.
export function validId(id) {
  return typeof id === 'string' && ID_RE.test(id)
    && !id.includes('..') && !id.endsWith('.') && !id.endsWith('.lock');
}
export const ARTIFACTS_MAX = 32;  // W-C2-R m3: must match the envelope's ENVELOPE_ARTIFACTS_MAX — a 33-artifact spec used to pass the door then die at EVERY worker envelope gate (3 net-zero retries → quarantine); the rejection belongs at intake
// s22/B-1 (BLOCKING, lens-1): LEASE_MIN is the FLOOR 3, imported from
// conductor-core (LEASE_FLOOR_MINUTES — ONE definition; the two modules
// must never disagree). The old floor 1 advertised a knob whose use
// destroys the work it names: the dispatch envelope's deadline =
// min(lease,48)·60s − 120s margin lands at/before the assign for lease ≤ 2
// → every worker start rejects 'late-start' → re-dispatch loop → DEGRADED
// halt (verified live in the e2e recovery drill). The door's advertised
// bounds and its enforcement move TOGETHER — a spec with lease_minutes 1-2
// is REJECTED here (one violation line, the anti-drip contract), and the
// conductor-side carry (specLeaseMinutes) clamps defensively for any
// pre-floor queue line still parked. CONFIG_BOUNDS.lease_minutes stays
// [1,120] — see its comment for the operator-seam decision.
export const LEASE_MIN = LEASE_FLOOR_MINUTES, LEASE_MAX = 120;
export const MILESTONE_MIN = 1, MILESTONE_MAX = 9;
export const PERMISSION_CLASSES = ['admin', 'maintain', 'write', 'owner'];
// s22/B-1 (staged-mode §2.2/§8 B-1): the multi-task door. The tasks-count cap
// is 32 — the machine's OWN ceiling (CONFIG_BOUNDS.max_parallel [1,32] in
// lib/fsm.mjs): a spec wider than the machine's parallelism bound can never
// run as designed, so the rejection belongs HERE, at the trust boundary (the
// staged nightly uses 4; the X27 capacity soak ~24; the design doc's
// "suggest ≤ 8" was superseded by the brief's adjudication — the X27 soak
// needs the headroom above 8). ONE definition, door-side only.
export const TASKS_MAX = 32;
// s22/B-1 (the s22/Q1 adjudication — spec-level capacity knobs): the two
// EPOCH-level knobs. max_parallel mirrors CONFIG_BOUNDS.max_parallel [1,32]
// (the machine's own ceiling — ONE bound, two seams); overflow_at [1,32] is
// the overflow PRE-FLIGHT threshold (carried into the genesis config, then
// consumed with the state.config precedence: config ?? env ?? DEFAULT — a
// drill epoch runs its own posture while the repo var stays production).
export const CAPACITY_MIN = 1, CAPACITY_MAX = 32;

// ---------------------------------------------------------------------------
// parseSpecBlock(body) -> { spec, raw, problems } | null
//
// The FIRST fenced block tagged `fsm-task` in the issue body. Fences of 3 OR
// 4 backticks are tolerated (hosts and humans paste 4-backtick fences around
// 3-backtick examples; CommonMark's own tolerance). The content is YAML-ish
// `key: value` lines parsed BY HAND (no yaml dep — the brief's rule):
//   - keys: any word; UNKNOWN keys are validateSpec's to reject (typo
//     protection lives there, with the key NAMED in the error);
//   - values: comment-stripped (` #…` — whitespace-preceded hash, the YAML
//     rule) UNLESS quoted; wrapping "…" or '…' quotes are unwrapped, which
//     is how a literal ` #` rides in (`accept: "see issue #5"` works);
//   - `deps`/`artifacts` accept `[a, b]` list literals or bare single values;
//   - s22/B-1 (staged-mode §2.2): `tasks:` on its own line opens the
//     MULTI-TASK list — ONE bracketed map per line (`- { id: …, title: …,
//     accept: … | behavior: … }`), the same one-line list-literal convention
//     the door already normalizes for `deps`/`artifacts`, so no new
//     indentation grammar: a non-`- {…}` line simply ENDS the list and
//     parses as an ordinary key line. Entry segments split on TOP-LEVEL
//     commas (quotes protect `title: "a, b"`; `[…]` depth protects an
//     entry's own artifacts list literal); a segment that is not a
//     `key: value` pair, or a duplicate entry key, is a `problem`
//     (fail-closed, same as the block level);
//   - a line that is neither blank nor `key: value`, or a DUPLICATE key, is
//     collected into `problems` — fail-closed: validateSpec turns every
//     problem into a rejection error (a garbage line is never silently
//     ignored; the anti-drip contract cuts both ways).
//
// Returns null when no tagged block exists (the door's "how to write a task"
// lane). `raw` is the block's CONTENT between the fences (the 4KB bound's
// measured bytes — what actually rides the queue line and the prompt).
// The brief's documented return is `{ spec }`; `raw`/`problems` are additive
// members (callers reading `.spec` are unaffected).
// ---------------------------------------------------------------------------
const OPEN_FENCE_RE = /(^|\n)(`{3,4})[ \t]*fsm-task[ \t]*\r?\n/;

// s22/B-1 (staged §2.2): one tasks entry per line — `- { … }` (the leading
// dash may carry any spacing; the braces close the line). GREEDY to the LAST
// `}` so a title containing a `}` still parses.
const TASKS_ENTRY_RE = /^[ \t]*-[ \t]*\{(.*)\}[ \t]*$/;

export function parseSpecBlock(body) {
  const text = String(body ?? '');
  const open = OPEN_FENCE_RE.exec(text);
  if (!open) return null;
  const ticks = open[2];
  const rest = text.slice(open.index + open[0].length);
  // closing fence: a line that is only backticks, >= the opening count
  const closeRe = new RegExp(`(^|\\n)[ \\t]*\`{${ticks.length},}[ \\t]*(\\r?\\n|$)`);
  const close = closeRe.exec(rest);
  const raw = close ? rest.slice(0, close.index + (close[1] ? close[1].length : 0)) : rest;

  const spec = {};
  const problems = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  let inTasks = false;   // collecting `- { … }` entries after a bare `tasks:`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (inTasks) {
      const e = TASKS_ENTRY_RE.exec(line);
      if (e) {
        spec.tasks.push(parseTaskEntry(e[1], i + 1, problems));
        continue;
      }
      // any other line ENDS the entry list — it parses as whatever it is
      // (an ordinary key line, or a garbage problem). No indentation grammar.
      inTasks = false;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:(?:[ \t](.*))?$/.exec(line);
    if (!m) {
      problems.push(`line ${i + 1}: not a \`key: value\` pair ("${line.trim().slice(0, 80)}")`);
      continue;
    }
    const key = m[1];
    if (seen.has(key)) {
      problems.push(`line ${i + 1}: duplicate key \`${key}\``);
      continue;
    }
    seen.add(key);
    if (key === 'tasks' && String(m[2] ?? '').trim() === '') {
      // the multi-task list form: entries follow, one bracketed map per line.
      // An EMPTY value is the list opener — `tasks: <scalar>` is NOT the list
      // form (validateSpec rejects it with the form named).
      inTasks = true;
      spec.tasks = [];
      continue;
    }
    let v = parseValue(m[2] ?? '');
    // the documented normalization (the doc comment + validateSpec's own
    // error text promise it): deps/artifacts accept list literals OR bare
    // single values — the key-aware wrap happens HERE so validateSpec sees
    // ONE shape. (Found by the lane-B completion's test matrix: parseValue
    // alone is key-agnostic and left bare values as scalars.)
    if ((key === 'deps' || key === 'artifacts') && typeof v === 'string' && v.trim() !== '') {
      v = [v];
    }
    spec[key] = v;
  }
  return { spec, raw, problems };
}

// parseTaskEntry(inner, lineNo, problems) — the `{ … }` interior of ONE
// tasks-entry line. Segments split on TOP-LEVEL commas only: quotes ('…' /
// "…") protect a title's own commas, and […] depth protects an entry-level
// artifacts list literal. Each segment must be a `key: value` pair (the SAME
// pair grammar as the block level); a bad segment or a duplicate entry key
// is a problem, fail-closed. Values ride parseValue (comment-strip, quote
// unwrap, list literal) + the deps/artifacts bare-value normalization — the
// SAME value language as the block level, one grammar everywhere.
function parseTaskEntry(inner, lineNo, problems) {
  const entry = {};
  const seen = new Set();
  for (const seg of splitTopLevel(inner)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:(?:[ \t](.*))?$/.exec(seg);
    if (!m) {
      problems.push(`line ${lineNo}: task entry segment is not a \`key: value\` pair ("${seg.slice(0, 60)}")`);
      continue;
    }
    const key = m[1];
    if (seen.has(key)) {
      problems.push(`line ${lineNo}: task entry duplicate key \`${key}\``);
      continue;
    }
    seen.add(key);
    let v = parseValue(m[2] ?? '');
    if ((key === 'deps' || key === 'artifacts') && typeof v === 'string' && v.trim() !== '') {
      v = [v];
    }
    entry[key] = v;
  }
  return entry;
}

// top-level comma split: quotes protect, brackets nest. Trailing/empty
// segments drop (tolerant, the deps/artifacts list-literal convention).
function splitTopLevel(s) {
  const out = [];
  let cur = '', depth = 0, q = null;
  for (const c of String(s)) {
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ']' || c === '}') { depth = Math.max(0, depth - 1); cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map(x => x.trim()).filter(x => x !== '');
}

// value parse: comment-strip (unless quoted) -> trim -> unwrap quotes ->
// list-literal for bracketed values. deps/artifacts are normalized to
// arrays HERE so validateSpec sees one shape (the §4a rule).
function parseValue(v) {
  let s = String(v);
  // YAML-ish comment: '#' preceded by whitespace, only when unquoted
  if (!(s.startsWith('"') || s.startsWith("'"))) {
    const hash = s.match(/\s#/);
    if (hash) s = s.slice(0, hash.index);
  }
  s = s.trim();
  // list literal [a, b] (possibly empty); falls through to scalar otherwise
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(x => unquote(x.trim())).filter(x => x !== '');
  }
  return unquote(s);
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// validateTaskFields(t, { issue, prefix, requireId, only }) — the PER-TASK
// rule block, ONE table shared by the single-task spec and EVERY tasks
// entry (s22/B-1: "the SAME per-task rules" — a shared implementation is the
// only way the two lanes can never disagree; the canonical-mapper
// discipline). Returns { errors, id }.
//   prefix    '' for the single-task spec (byte-identical messages — the
//             existing pins hold verbatim); `task entry N (id): ` per entry.
//   requireId the tasks form REQUIRES an explicit id per entry — the
//             single-task default (task-i<issue#>) would mint ONE id for
//             every entry and the machine's task map is keyed by id.
//   only      restrict the checked fields (the tasks form validates the
//             EPOCH-level lease_minutes/mode through the same rule code).
// ---------------------------------------------------------------------------
const TASK_FIELD_KEYS = ['id', 'title', 'accept', 'behavior', 'deps', 'artifacts', 'lease_minutes', 'milestone', 'mode'];
// the single-task spec's top level is BOTH task and epoch level — it adds
// the two capacity knobs (epoch-level only: an ENTRY carrying them is an
// unknown key, and the tasks form's top level takes them directly)
const SPEC_FIELD_KEYS = [...TASK_FIELD_KEYS, 'max_parallel', 'overflow_at'];

function validateTaskFields(t, { issue, prefix = '', requireId = false, only = TASK_FIELD_KEYS } = {}) {
  const errors = [];
  const on = (k) => !only || only.includes(k);
  const has = (k) => Object.prototype.hasOwnProperty.call(t, k);

  // id: OPTIONAL with default task-i<issue#> (single-task form); REQUIRED per
  // entry (tasks form). charset (the run-name hazard dies HERE)
  let id;
  const hasId = has('id');
  if (on('id')) {
    if (requireId && !hasId) {
      errors.push(`${prefix}id is required in the tasks form — the single-task default (task-i<issue#>) would mint ONE id for every entry`);
      id = undefined;
    } else {
      id = hasId ? t.id : (String(issue) !== '' ? `task-i${issue}` : undefined);
      if (hasId) {
        if (typeof id !== 'string') {
          errors.push(`${prefix}id must be a string (got ${JSON.stringify(id)?.slice(0, 40)})`);
          id = undefined;
        } else if (!validId(id)) {
          errors.push(`${prefix}id "${id.slice(0, 40)}" fails the charset ^[-A-Za-z0-9_.]{1,24}$ (the run-name hazard is killed here — see law-4's task-<id> · <behavior> · a<n> matching)`);
          id = undefined;
        }
      } else if (id !== undefined && !validId(id)) {
        // the DEFAULT failed the charset (a hostile issue number) — same rejection
        errors.push(`${prefix}default id "${id}" fails the charset ^[-A-Za-z0-9_.]{1,24}$`);
        id = undefined;
      }
    }
  }

  // title: REQUIRED, ≤ 140 chars, no fence-forming sequences
  if (on('title')) {
    const title = t.title;
    if (typeof title !== 'string' || title.trim() === '') {
      errors.push(`${prefix}title is required (non-empty, ≤ 140 chars)`);
    } else {
      if (title.length > TITLE_MAX_CHARS) errors.push(`${prefix}title is ${title.length} chars (max ${TITLE_MAX_CHARS})`);
      if (/`{3}/.test(title)) errors.push(`${prefix}title must not contain fence-forming sequences (` + '```' + `)`);
    }
  }

  // EXACTLY ONE of accept | behavior
  if (on('accept') && on('behavior')) {
    const hasAccept = has('accept');
    const hasBehavior = has('behavior');
    if (hasAccept && hasBehavior) {
      errors.push(`${prefix}exactly ONE of accept or behavior — both are present`);
    } else if (!hasAccept && !hasBehavior) {
      errors.push(`${prefix}exactly ONE of accept or behavior is required (accept for real work, behavior for mock epochs)`);
    }
    if (hasAccept) {
      const accept = t.accept;
      if (typeof accept !== 'string' || accept.trim() === '') {
        errors.push(`${prefix}accept must be a non-empty string (≤ 2048 chars)`);
      } else if (accept.length > ACCEPT_MAX_CHARS) {
        errors.push(`${prefix}accept is ${accept.length} chars (max ${ACCEPT_MAX_CHARS})`);
      }
    }
    if (hasBehavior && !INTAKE_BEHAVIORS.includes(t.behavior)) {
      errors.push(`${prefix}behavior "${String(t.behavior).slice(0, 40)}" is not one of [${INTAKE_BEHAVIORS.join(', ')}]`);
    }
  }

  // F-1 (L1-B1): deps are CUT — cross-epoch deps are structurally incoherent
  // until W-D; the failure path dead-loops the chain. ANY presence rejects —
  // PER ENTRY in the tasks form (the pre-W-D rule applies per task).
  if (on('deps') && has('deps')) {
    errors.push(`${prefix}deps arrive with multi-task epochs (W-D) — remove the deps line`);
  }

  // artifacts: OPTIONAL array; every path bound to the MINTED id (m-4)
  if (on('artifacts') && has('artifacts')) {
    const arts = t.artifacts;
    if (!Array.isArray(arts)) {
      errors.push(`${prefix}artifacts must be a list ("[tasks/<id>/report.md]" or a bare path)`);
    } else {
      if (arts.length > ARTIFACTS_MAX) {
        errors.push(`${prefix}artifacts carries ${arts.length} paths (cap ${ARTIFACTS_MAX} — the envelope's ENVELOPE_ARTIFACTS_MAX; more would die at every worker gate)`);
      }
      const boundId = typeof id === 'string' ? id : '<id-invalid>';
      const artRe = new RegExp(`^tasks/${escapeRe(boundId)}/[-A-Za-z0-9_./]*$`);
      for (const a of arts) {
        if (typeof a !== 'string') {
          errors.push(`${prefix}artifact ${JSON.stringify(a)?.slice(0, 40)} is not a string`);
          continue;
        }
        if (!artRe.test(a)) {
          errors.push(`${prefix}artifact "${a.slice(0, 80)}" must live under tasks/${boundId}/ (bound to the minted id — m-4)`);
        } else if (a.split('/').includes('..')) {
          // the brief's charset admits '..' but m-4's intent (one path
          // language with the write-back door) forbids traversal — the
          // conservative fold, documented in t46-wc1-state.md
          errors.push(`${prefix}artifact "${a.slice(0, 80)}" must not contain '..' path segments`);
        }
      }
    }
  }

  // lease_minutes: OPTIONAL integer [3, 120] (s22/B-1: the floor is 3 — see
  // LEASE_MIN above; lease_minutes*60_000 must exceed the W2 envelope margin
  // of 120s or the deadline lands at/before assign)
  if (on('lease_minutes') && has('lease_minutes')) {
    const lm = t.lease_minutes;
    if (!/^-?\d+$/.test(String(lm).trim())) {
      errors.push(`${prefix}lease_minutes must be an integer in [${LEASE_MIN}, ${LEASE_MAX}] (got ${JSON.stringify(lm)?.slice(0, 20)})`);
    } else {
      const n = parseInt(String(lm).trim(), 10);
      if (n < LEASE_MIN || n > LEASE_MAX) errors.push(`${prefix}lease_minutes ${n} is outside [${LEASE_MIN}, ${LEASE_MAX}]`);
    }
  }

  // milestone: OPTIONAL integer [1, 9]
  if (on('milestone') && has('milestone')) {
    const ms = t.milestone;
    if (!/^-?\d+$/.test(String(ms).trim())) {
      errors.push(`${prefix}milestone must be an integer in [${MILESTONE_MIN}, ${MILESTONE_MAX}] (got ${JSON.stringify(ms)?.slice(0, 20)})`);
    } else {
      const n = parseInt(String(ms).trim(), 10);
      if (n < MILESTONE_MIN || n > MILESTONE_MAX) errors.push(`${prefix}milestone ${n} is outside [${MILESTONE_MIN}, ${MILESTONE_MAX}]`);
    }
  }

  // mode: OPTIONAL, one of GENESIS_MODES' values (§5 — the X22 switch)
  if (on('mode') && has('mode')) {
    if (!INTAKE_MODES.includes(t.mode)) {
      errors.push(`${prefix}mode "${String(t.mode).slice(0, 20)}" is not one of [${INTAKE_MODES.join(', ')}]`);
    }
  }

  // s22/B-1 (the s22/Q1 adjudication): the EPOCH-level capacity knobs —
  // integer [1,32] each (CAPACITY_MIN/MAX; max_parallel mirrors the
  // machine's CONFIG_BOUNDS ceiling; overflow_at is the pre-flight
  // threshold). Epoch-level ONLY: reached from the single-task top level
  // and the tasks form's top level (SPEC_FIELD_KEYS / the epoch shim) — an
  // entry carrying either is an unknown key (TASK_FIELD_KEYS excludes
  // them). The conductor-side carry (specCapacity) bounds-checks the same
  // window defensively.
  for (const k of ['max_parallel', 'overflow_at']) {
    if (!on(k) || !has(k)) continue;
    const v = t[k];
    if (!/^-?\d+$/.test(String(v).trim())) {
      errors.push(`${prefix}${k} must be an integer in [${CAPACITY_MIN}, ${CAPACITY_MAX}] (got ${JSON.stringify(v)?.slice(0, 20)})`);
    } else {
      const n = parseInt(String(v).trim(), 10);
      if (n < CAPACITY_MIN || n > CAPACITY_MAX) {
        errors.push(`${prefix}${k} ${n} is outside [${CAPACITY_MIN}, ${CAPACITY_MAX}] (the machine's own ceiling — CONFIG_BOUNDS)`);
      }
    }
  }

  return { errors, id };
}

// ---------------------------------------------------------------------------
// validateSpec(spec, { issue, raw, problems }) -> { ok: true, id } |
// { ok: false, errors: string[] }
//
// EVERY rule, fail-closed, ONE pass collecting ALL violations (the door
// never drips — one comment lists every broken rule). `raw` (the block
// content from parseSpecBlock) is the 4KB bound's input; when absent (direct
// calls), the serialized spec stands in — the bound still holds. `problems`
// (line-level parse failures) become errors verbatim.
//
// s22/B-1 (staged-mode §2.2): the spec may carry `tasks:` — the multi-task
// form. Each entry is validated with the SAME per-task rules
// (validateTaskFields — the shared rule table); the top level degenerates to
// the EPOCH-level keys (`mode`, `lease_minutes` keep their current meaning:
// the A4-F1 carry + the mode precedence), and per-entry ids must be UNIQUE.
// The single-task path (no `tasks:` key) is byte-identical to the
// pre-multi-task door.
// s22/B-1 commit 3 (the s22/Q1 adjudication): the EPOCH-level CAPACITY
// knobs — `max_parallel` [1,32] and `overflow_at` [1,32] — validated here,
// carried into the genesis config at the rollover AND reset {from_queue}
// (specCapacity, the A4-F1 pattern), and consumed by the overflow PRE-FLIGHT
// with the state.config precedence (config ?? env ?? DEFAULT — a drill
// epoch runs its own posture while the repo var stays production).
// ---------------------------------------------------------------------------
export function validateSpec(spec, { issue, raw, problems = [] } = {}) {
  const errors = [...problems];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: [...errors, 'spec must be a parsed fsm-task block (object)'] };
  }
  if (issue === undefined || issue === null || String(issue) === '') {
    // the default id is built FROM the issue number — without it the door
    // would mint `task-iundefined` (charset-legal!). Fail closed.
    errors.push('issue number is required (the default id is derived from it)');
  }

  // 4KB bound (the raw block; serialized fallback for direct calls)
  const measured = raw != null ? String(raw) : JSON.stringify(spec);
  if (Buffer.byteLength(measured, 'utf8') > SPEC_MAX_BYTES) {
    errors.push(`spec exceeds ${SPEC_MAX_BYTES} bytes (${Buffer.byteLength(measured, 'utf8')} — the raw block)`);
  }

  // s22/B-1: the multi-task branch. The returned id (the queue line's log
  // identity) stays the issue-derived default — the epoch's REAL task ids
  // ride the entries.
  if (Object.prototype.hasOwnProperty.call(spec, 'tasks')) {
    if (!Array.isArray(spec.tasks)) {
      errors.push(`tasks must be a list of one-line { ... } entries, one per line after "tasks:" (got ${typeof spec.tasks})`);
    } else {
      if (spec.tasks.length < 1) {
        errors.push('tasks carries 0 entries — an epoch needs at least 1');
      }
      if (spec.tasks.length > TASKS_MAX) {
        errors.push(`tasks carries ${spec.tasks.length} entries (cap ${TASKS_MAX} — the machine's own max_parallel ceiling, CONFIG_BOUNDS [1,32])`);
      }
      const ids = new Map();   // effective id -> entry number (1-based)
      spec.tasks.forEach((e, idx) => {
        const n = idx + 1;
        if (e === null || typeof e !== 'object' || Array.isArray(e)) {
          errors.push(`task entry ${n}: must be a one-line { ... } map (got ${Array.isArray(e) ? 'array' : typeof e})`);
          return;
        }
        const idLabel = typeof e.id === 'string' && e.id ? ` (${e.id.slice(0, 24)})` : '';
        const prefix = `task entry ${n}${idLabel}: `;
        // per-entry unknown keys (typo protection — the entry key set is the
        // per-task key set; epoch-level keys do NOT ride entries)
        const unknown = Object.keys(e).filter(k => !TASK_FIELD_KEYS.includes(k));
        if (unknown.length) {
          errors.push(`${prefix}unknown key(s): ${unknown.join(', ')} (known: ${TASK_FIELD_KEYS.join(', ')})`);
        }
        const r = validateTaskFields(e, { issue, prefix, requireId: true });
        errors.push(...r.errors);
        if (r.id != null) {
          if (ids.has(r.id)) {
            errors.push(`duplicate task id "${r.id}" — task entry ${n} repeats task entry ${ids.get(r.id)} (the machine's task map is keyed by id; the second entry would vanish)`);
          } else {
            ids.set(r.id, n);
          }
        }
      });
      // the top level degenerates: only the EPOCH-level keys may ride
      // alongside tasks (per-task keys belong to the entries — a top-level
      // title next to tasks is ambiguous, and ambiguity at a trust boundary
      // is a rejection). s22/B-1 commit 3: the capacity knobs are EPOCH
      // keys too (max_parallel/overflow_at — the s22/Q1 adjudication).
      const TOP_KNOWN = ['tasks', 'mode', 'lease_minutes', 'max_parallel', 'overflow_at'];
      const badTop = Object.keys(spec).filter(k => !TOP_KNOWN.includes(k));
      if (badTop.length) {
        errors.push(`the tasks form takes no top-level ${badTop.join(', ')} — per-task keys ride each { ... } entry (epoch-level: ${TOP_KNOWN.join(', ')})`);
      }
      // the epoch-level knobs keep their CURRENT rules — through the SAME
      // shared rule table (lease_minutes/mode + the capacity knobs are
      // checked on the shim)
      const shim = {};
      if (Object.prototype.hasOwnProperty.call(spec, 'lease_minutes')) shim.lease_minutes = spec.lease_minutes;
      if (Object.prototype.hasOwnProperty.call(spec, 'mode')) shim.mode = spec.mode;
      if (Object.prototype.hasOwnProperty.call(spec, 'max_parallel')) shim.max_parallel = spec.max_parallel;
      if (Object.prototype.hasOwnProperty.call(spec, 'overflow_at')) shim.overflow_at = spec.overflow_at;
      errors.push(...validateTaskFields(shim, { issue, only: ['lease_minutes', 'mode', 'max_parallel', 'overflow_at'] }).errors);
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, id: String(issue) !== '' ? `task-i${issue}` : undefined };
  }

  // the single-task path — the shared rule table, no prefix: byte-identical
  // messages (the pre-B-1 pins hold verbatim). SPEC_FIELD_KEYS adds the two
  // EPOCH-level capacity knobs to the single-task top level (the top level
  // is both task and epoch there).
  const r = validateTaskFields(spec, { issue, only: SPEC_FIELD_KEYS });
  errors.push(...r.errors);

  // unknown keys: REJECT, listing them (typo protection)
  const KNOWN = SPEC_FIELD_KEYS;   // + 'tasks' (the multi-task form — not a single-task key)
  const unknown = Object.keys(spec).filter(k => !KNOWN.includes(k) && k !== 'tasks');
  if (unknown.length) {
    errors.push(`unknown key(s): ${unknown.join(', ')} (known: ${[...KNOWN, 'tasks'].join(', ')})`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, id: r.id };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// specToTask — RE-EXPORTED from conductor-core (the ONE canonical mapper;
// the conductor's makeGenesis and the door must never disagree on shape —
// the lane-B draft duplicated it and the integration folded them back).
// Shape: {id, title, behavior ('real' for accept-specs), work_ms, deps: [],
// spec: {accept?, artifacts?, issue, body_sha8?}}.
// ---------------------------------------------------------------------------
export { specToTask } from './conductor-core.mjs';

// ---------------------------------------------------------------------------
// doorDecide({ author, isBot, permission, body, issue, queue })
//   -> { decision: 'enqueue'|'reject'|'silent', comment?, spec?, id? }
//
// The door's decision table, in the brief's EXACT order:
//   1. bot (github-actions[bot] / any [bot] login) -> SILENT, no comment —
//      loop safety: the door must never wake itself (and GITHUB_TOKEN-
//      authored comments fire no issue_comment anyway, F-13).
//   2. no fsm-task block -> reject, the how-to comment (schema template).
//   3. permission NOT in [admin, maintain, write, owner] -> reject, the
//      stranger comment (ONE comment, the issue stays open for triage).
//      permission null (the API-error marker) -> reject FAIL-CLOSED with
//      its own comment (a flaky permission API is never a free lane).
//   4. validateSpec errors -> reject, ONE comment listing EVERY rule.
//   5. already queued (same issue + same body sha8) -> SILENT + the
//      idempotence comment (kills the double-queue; cross-epoch re-runs
//      still work once the queue drains — F-11).
//   6. else enqueue.
// ---------------------------------------------------------------------------
export function doorDecide({ author, isBot, permission, body, issue, queue = [] } = {}) {
  // 1. bot-silent — belt AND suspenders: trust the flag OR the login shape
  // (a login ending '[bot]' is a bot on GitHub, whoever computed the flag).
  if (isBot === true || String(author || '').endsWith('[bot]')) {
    return { decision: 'silent' };
  }

  // 2. no block -> the how-to comment
  const parsed = parseSpecBlock(body);
  if (!parsed) {
    return { decision: 'reject', comment: howToComment() };
  }

  // 3. the permission class gate (fail-closed on null)
  if (!PERMISSION_CLASSES.includes(permission)) {
    if (permission === null || permission === undefined) {
      return { decision: 'reject', comment:
        '**[fsm-intake]** The door could not verify your permission (GitHub API error) — failing closed: a flaky permission check must never become a free compute lane.\n\n'
        + 'Nothing was queued. Close and re-open this issue to retry, or ask an operator to nudge it.' };
    }
    return { decision: 'reject', comment:
      `**[fsm-intake]** Thanks @${author || 'there'} — the FSM intake door only accepts work from collaborators with write access to this repo (observed permission: \`${permission}\`).\n\n`
      + 'This issue stays open for triage by an operator; nothing was queued. If you believe you should have access, contact a maintainer.' };
  }

  // 4. full validation — ONE comment, EVERY rule
  const v = validateSpec(parsed.spec, { issue, raw: parsed.raw, problems: parsed.problems });
  if (!v.ok) {
    return { decision: 'reject', comment:
      `**[fsm-intake]** The \`fsm-task\` spec was rejected — ${v.errors.length} rule(s) violated:\n\n`
      + v.errors.map(e => `- ${e}`).join('\n')
      + '\n\nFix the spec and re-open this issue (close + open) to retry.' };
  }

  // 5. already-queued dedup (issue + body sha8): the door is idempotent
  const sha = bodySha8(body);
  if (queue.some(l => String(l.issue) === String(issue) && l.body_sha8 === sha)) {
    return { decision: 'silent', comment:
      `**[fsm-intake]** already queued (issue #${issue}, same body) — the door is idempotent.` };
  }

  // 6. enqueue
  return { decision: 'enqueue', spec: parsed.spec, id: v.id };
}

// The how-to comment — the schema template VERBATIM (§4a). No inline
// comments in the template itself: pasted specs must survive the parser
// without quoting surprises.
export function howToComment() {
  return [
    '**[fsm-intake]** This issue has no `fsm-task` spec block, so the FSM intake door ignored it (it stays a normal issue — nothing was queued).',
    '',
    'To queue machine work, include a fenced block tagged `fsm-task`:',
    '',
    '```fsm-task',
    'id: T-501',
    'title: research the frob nozzle',
    'accept: one paragraph on frob options with citations',
    'artifacts: [tasks/T-501/report.md]',
    'lease_minutes: 45',
    'milestone: 1',
    '```',
    '',
    'Multiple tasks in one epoch — the `tasks:` form (1–32 entries, one bracketed map per line):',
    '',
    '```fsm-task',
    'mode: mock',
    'lease_minutes: 15',
    'tasks:',
    '  - { id: T-601, behavior: fast, title: night check A }',
    '  - { id: T-602, title: summarize the log, accept: one paragraph of findings, artifacts: [tasks/T-602/report.md] }',
    '```',
    '',
    'Rules (one comment lists every violation — fix them all, then close and re-open the issue to retry):',
    '- `id` optional — default `task-i<issue#>`; charset `[-A-Za-z0-9_.]{1,24}` (in the `tasks:` form every entry needs its OWN id, unique across entries)',
    '- `title` required — ≤ 140 chars, no fence-forming sequences',
    '- exactly ONE of `accept` (non-empty, ≤ 2048 chars) or `behavior` (mock epochs; one of the harness behaviors) — per task: once per entry in the `tasks:` form',
    '- `deps` is not accepted yet — not per entry either (arrives with the W-D multi-task lanes)',
    '- `artifacts` optional — every path under `tasks/<task-id>/`',
    '- `lease_minutes` optional — integer [3, 120]; `milestone` optional — integer [1, 9]; per entry or epoch-level (an epoch-level `lease_minutes` serves every task)',
    '- `mode` optional — one of mock | real | cc (epoch-level)',
    '- `tasks` optional — 1–32 one-line entries; the epoch-level keys beside it are `mode`, `lease_minutes`, `max_parallel`, `overflow_at`',
    '- `max_parallel` / `overflow_at` optional (epoch-level) — integer [1, 32] each: the epoch parallelism ceiling and the overflow pre-flight threshold (the machine bound)',
    '- unknown keys are rejected (typo protection); the whole block must be ≤ 4KB',
    '- values containing ` #` must be quoted (`accept: "see #5"`) — otherwise ` #` starts a comment',
  ].join('\n');
}

// bodySha8(body) — the re-delivery discriminator (§2c): the TASK_CREATED
// mint is `task-<issue#>-<bodySha8>`; the queue line carries the same sha8
// so the drain and the door dedupe on one identity.
export function bodySha8(body) {
  return createHash('sha256').update(String(body ?? '')).digest('hex').slice(0, 8);
}
