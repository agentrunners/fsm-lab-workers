// stress/lib/common.mjs — the stress battery's shared substrate (T46/s21-c2).
//
// The sim law, carried into the stress layer: OFFLINE (no network, no GHA),
// SEEDED (rng injectable — mulberry32 from sim/gha-shim.mjs, ONE source),
// VIRTUAL-CLOCK (the never-sleeps clock run-sim2 uses). Every battery =
// fixtures + driver + assertions + METRICS: the characterization numbers are
// the deliverable, pinned as bounds, not vibes.
//
// What each helper owns:
//   makeClock     — run-sim2's virtual clock verbatim (now/advance/advanceTo/ms)
//   setupRepo     — run-sim2's local bare origin + clone factory (real git,
//                   the Store's real substrate)
//   Recorder      — the per-battery check+metric ledger -> JSON report shape
//   iso/ms        — small time helpers
//   withTimeout   — a battery-level watchdog (a wedged battery fails LOUDLY,
//                   never hangs CI — the T1 date-rot lesson: gates must fail
//                   visibly, not never)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export { mulberry32 } from '../../sim/gha-shim.mjs';

export const T0 = Date.parse('2026-09-22T08:00:00.000Z');
export const iso = (ms) => new Date(ms).toISOString();

// run-sim2's clock, verbatim (plus a startMs default at the stress epoch).
export function makeClock(startMs = T0) {
  let t = startMs;
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; },
    advanceTo: (ms) => { if (ms > t) t = ms; },
    get ms() { return t; },
  };
}

// run-sim2's repo factory, verbatim: a local bare origin + a clone the Store
// can push to. Real git, real CAS physics — the burst/journal/chaos batteries
// ride the REAL substrate (that is the point of the stress layer: unit tests
// mock it, sims model it, stress SATURATES it).
export function setupRepo(prefix = 'fsm-stress-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { cwd: dir });
  const seed = join(dir, 'seed');
  spawnSync('git', ['init', '-b', 'main', seed], { cwd: dir });
  spawnSync('bash', ['-c', `echo stress > ${seed}/README.md && cd ${seed} && git add . && git -c user.name=s -c user.email=s@s.invalid commit -qm seed && git push -q ${origin} main`]);
  spawnSync('git', ['clone', '-q', origin, clone], { cwd: dir });
  return { dir, origin, clone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The battery recorder: checks (assertions) + metrics (the characterization
// numbers) + notes. One JSON shape for every battery -> last-stress-report.
export class Recorder {
  constructor(battery) {
    this.battery = battery;
    this.checks = [];
    this.metrics = {};
    this.notes = [];
    this.startedAt = Date.now();
  }
  check(name, pass, detail = '') {
    this.checks.push({ name, pass: !!pass, detail: String(detail) });
    console.log(`${pass ? '  ok ' : '  FAIL'} ${batteryPrefix(this.battery)}${name}${detail ? ` — ${detail}` : ''}`);
    return !!pass;
  }
  metric(name, value) {
    this.metrics[name] = value;
    return value;
  }
  note(text) {
    this.notes.push(String(text));
    console.log(`  · ${batteryPrefix(this.battery)}${text}`);
  }
  report() {
    return {
      battery: this.battery,
      pass: this.checks.every(c => c.pass),
      checks: this.checks,
      metrics: this.metrics,
      notes: this.notes,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

function batteryPrefix(b) {
  return `[${b}] `;
}

// A battery watchdog: resolves with the value, or rejects after ms. A wedged
// battery must FAIL (red, visible), never hang the gate.
export function withTimeout(promise, ms, label = 'battery') {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms (wedged — failing loudly, never hanging the gate)`)), ms);
    }),
  ]);
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
