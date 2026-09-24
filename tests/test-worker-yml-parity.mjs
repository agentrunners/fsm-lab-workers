// test-worker-yml-parity.mjs — s25/A2-m1: the x29↔worker.yml install-step
// parity gate (the "verbatim copy" comment-law made executable).
//
// The x29-codex-smoke workflow's codex-install step claims (its own header
// comment + the s24/B10 EVIDENCE + the merge note 65ec6df4) to run the
// worker.yml "Install the Codex CLI" step's run body VERBATIM — verified by
// hand at build time (a programmatic diff), leaving a STANDING SYNC
// OBLIGATION ("any worker.yml install-step change re-syncs here", the D12a
// discipline) that lived only in prose. Nothing failed loud on drift: an
// install fix/upgrade landed in worker.yml but missed in the smoke lane
// would leave the smoke exercising a DIFFERENT install path than every real
// codex dispatch — silently, until the divergence bit a live run. This test
// is that gate: the sync obligation now FAILS LOUD.
//
// The ONE documented exception (read from both files at build time, pinned
// byte-exact below): the smoke body carries ONE additive line — the
// install_s GITHUB_OUTPUT carriage (`echo "install_s=$((T1-T0))" >>
// "$GITHUB_OUTPUT"`, the x20-cc-smoke pattern, sitting inside the codex
// branch after the version-assert esac) — the timed-install measurement the
// smoke exists to make. The env seam (OX_RAW's source: worker.yml reads
// github.event.client_payload.ox, the smoke sets the dispatch-equivalent
// envelope '{"mode":"codex"}') is a STEP-ENV difference, not a run-body
// difference — the commands under test are the dispatch path's either way;
// out of this gate's scope.
//
// Parsing follows the repo's own test precedent: there is NO node yaml
// dependency anywhere (lib/intake.mjs parses by hand by the brief's rule;
// scripts/validate.sh's YAML gate is python-side), and the workflow-reading
// tests (test-ttl-sync.mjs / test-staged.mjs / test-ar-overflow.mjs /
// test-console.mjs) all read the raw TEXT with anchored extraction. Same
// here: find the step by its name line, take the `run: |` block scalar,
// dedent by the block's own first-line indent, compare byte-for-byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWorkflow = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');

// THE one documented additive line, byte-exact (2-space indent — it sits
// inside the codex branch after the version-assert esac, before the else).
const INSTALL_S_CARRIAGE = '  echo "install_s=$((T1-T0))" >> "$GITHUB_OUTPUT"';

// Extract a step's `run: |` block-scalar body as an array of dedented
// lines. The workflows' steps indent at 6, their keys at 8, block bodies at
// 10+; the block ends at the first non-blank line indented ≤ the key (8).
// Dedent is by the block's own first-line indent (10) — the YAML
// block-scalar rule, so the comparison is byte-level on the body text.
function stepRunBody(src, stepNamePrefix, file) {
  const lines = src.split('\n');
  const stepIdxs = [];
  lines.forEach((l, i) => { if (/^ {6}- name: /.test(l) && l.includes(stepNamePrefix)) stepIdxs.push(i); });
  assert.equal(stepIdxs.length, 1, `${file}: exactly one '${stepNamePrefix}*' step (found ${stepIdxs.length} — the extractor must stay unambiguous)`);
  let runIdx = -1;
  for (let i = stepIdxs[0] + 1; i < lines.length; i++) {
    if (/^ {6}- name: /.test(lines[i])) break;              // next step began — no run block
    if (/^ {8}run: \|$/.test(lines[i])) { runIdx = i; break; }
  }
  assert.ok(runIdx >= 0, `${file}: the '${stepNamePrefix}' step carries a run: | block`);
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (/^ {0,8}\S/.test(l)) break;                          // key-level dedent ends the block
    body.push(l);
  }
  while (body.length && body[body.length - 1] === '') body.pop();   // trailing blanks belong to the step, not the body
  return body.map((l) => (l === '' ? '' : l.slice(10)));
}

test('x29↔worker.yml parity: the codex-install run bodies are byte-identical modulo the ONE install_s carriage line', () => {
  const workerBody = stepRunBody(readWorkflow('worker.yml'), 'Install the Codex CLI', 'worker.yml');
  const smokeBody = stepRunBody(readWorkflow('x29-codex-smoke.yml'), 'Install the Codex CLI', 'x29-codex-smoke.yml');
  assert.ok(workerBody.length >= 10, `worker.yml: a sane install body (got ${workerBody.length} lines — extraction broke?)`);
  // the ONE additive line: present exactly once, byte-exact
  const occurrences = smokeBody.filter((l) => l === INSTALL_S_CARRIAGE).length;
  assert.equal(occurrences, 1, `x29-codex-smoke.yml: exactly ONE install_s carriage line (found ${occurrences}) — the single documented exception; anything else must be parity`);
  // modulo that line: BYTE-IDENTICAL (the standing sync obligation, now a gate)
  const smokeMinus = smokeBody.filter((l) => l !== INSTALL_S_CARRIAGE);
  assert.deepEqual(
    smokeMinus, workerBody,
    `the x29 codex-install run body must be the worker.yml 'Install the Codex CLI' run body VERBATIM — drift means the smoke lane installs a DIFFERENT codex than every real dispatch; re-sync per the D12a discipline\n--- worker.yml body ---\n${workerBody.join('\n')}\n--- x29-codex-smoke.yml body (minus the carriage) ---\n${smokeMinus.join('\n')}`
  );
});

test('x29↔worker.yml parity: the gate and the pin ride the SAME names in both bodies (the OX_RAW mode gate + the 0.156.0 default pin)', () => {
  // a cheap canary on top of the byte-parity: the two load-bearing lines of
  // the install path — the injection-safe OX_RAW mode gate (never a ${{ }}
  // interpolation into the shell) and the never-latest npm pin with its
  // 0.156.0 default — appear verbatim in BOTH bodies. If either file's gate
  // shape changes, the byte-parity test above already fails; this pin keeps
  // the failure readable when someone greps for WHY the sync law exists.
  const workerBody = stepRunBody(readWorkflow('worker.yml'), 'Install the Codex CLI', 'worker.yml');
  const smokeBody = stepRunBody(readWorkflow('x29-codex-smoke.yml'), 'Install the Codex CLI', 'x29-codex-smoke.yml').filter((l) => l !== INSTALL_S_CARRIAGE);
  const GATE = 'MODE=$(printf \'%s\' "$OX_RAW" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(typeof o==="object"&&o?String(o.mode||""):"")}catch{console.log("")}})\')';
  const PIN = 'CODEX_PIN="${CODEX_VERSION:-0.156.0}"';
  for (const [label, body] of [['worker.yml', workerBody], ['x29-codex-smoke.yml', smokeBody]]) {
    const text = body.join('\n');
    assert.ok(text.includes(GATE), `${label}: the OX_RAW mode gate line rides the install body verbatim`);
    assert.ok(text.includes(PIN), `${label}: the never-latest npm pin (default 0.156.0) rides the install body verbatim`);
  }
});
