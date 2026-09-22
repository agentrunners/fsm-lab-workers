#!/usr/bin/env node
// stress/run.mjs — THE STRESS BATTERY, one command (T46/s21-c2, audit a6 §6).
//
//   node stress/run.mjs [--battery burst12|quota-wall|dead-key-storm|journal-flood|soak30d|chaos|all]
//                       [--quick] [--seed N] [--json <dir>]
//
//   -> per-battery checks + METRICS to stdout, STRESS-RESULT <n>/<n> verdict,
//      and stress/last-stress-report.json (the durable shape; --json <dir>
//      additionally writes out/stress-<battery>.json per battery — the
//      capacity/economics evidence base accrues there in CI).
//
// Discipline (the sim law, enforced here): OFFLINE (no network — nothing in
// this tree opens a socket), SEEDED (--seed feeds every battery's rng; same
// seed => same verdict lines), VIRTUAL-CLOCK (no battery sleeps to simulate
// time; chaos is the ONE process-level battery and documents its own
// wall-time). --quick = the CI subset: every battery in a compressed shape,
// the whole set < 90s; the full shapes are the nightly sweep (documented in
// each battery header + STRESS-FULL notes in the report).
//
// THE DELIVERABLE IS THE METRICS: the batteries that characterize CURRENT
// bugs print the NUMBER (journal-flood's pagination-break duplicate-alert
// count, soak30d's PINGER_STALE_AFTER_MIN=45 false-alarm count) — those
// numbers drive the Wave-4 fixes; pass/fail is the floor, not the point.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// s22/m-9: the registry is the PLAN (6 batteries); the tree is what LANDED
// (s21-c2 delivered 3 — burst12/quota-wall/dead-key-storm; journal-flood,
// soak30d, chaos are the not-landed remainder). The runner now guards each
// entry with existsSync and emits an honest SKIP note instead of crashing
// the battery (the old shape: `--battery all` = 3 BATTERY-FAILs + exit 1 —
// the gate read red on MISSING files, the least informative red there is).
// A skip is NOT a pass and NOT a fail: zero checks, explicit note, excluded
// from the ran/pass counts, never fails the exit code.
const BATTERIES = {
  'burst12': { load: () => import('./batteries/burst12.mjs'), quick: '12 tasks, cap(5) live, 2×9-min grinds, 12-child CAS storm', full: 'same + 3-seed sweep of the drain baseline' },
  'quota-wall': { load: () => import('./batteries/quota-wall.mjs'), quick: 'PoolLane 8 keys × quota 2 × 12 tasks (the X23 arc)', full: 'parameterized sweep: (keys × quota × tasks × pre-exhaust) matrix' },
  'dead-key-storm': { load: () => import('./batteries/dead-key-storm.mjs'), quick: '2-key CC lane + 4-key free pool, 50% dead', full: 'storm matrix: 50% / 100% dead × CC-lane / free-lane' },
  'journal-flood': { load: () => import('./batteries/journal-flood.mjs'), quick: '2k events / 4 rotations + 100-report dup storm + pagination model', full: '10k events / 20+ rotations + 30d marker noise + pagination model' },
  'soak30d': { load: () => import('./batteries/soak30d.mjs'), quick: '30 virtual days, duty scan every 60min', full: '30 days + duty-cadence sensitivity (30/60/120min) + dead-pinger lane' },
  'chaos': { load: () => import('./batteries/chaos.mjs'), quick: '~12 seeded SIGKILLs across the boundaries, 12 tasks', full: '50 seeded SIGKILLs, 18 tasks' },
};

function parseArgs(argv) {
  const out = { battery: 'all', quick: false, seed: 20260922, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--battery') out.battery = argv[++i];
    else if (a === '--quick') out.quick = true;
    else if (a === '--seed') out.seed = parseInt(argv[++i], 10) || out.seed;
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`unknown flag ${a}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node stress/run.mjs [--battery <name|all>] [--quick] [--seed N] [--json <dir>]');
  console.log('batteries:');
  for (const [k, v] of Object.entries(BATTERIES)) console.log(`  ${k.padEnd(16)} quick: ${v.quick}\n${' '.repeat(20)}full: ${v.full}`);
  process.exit(0);
}

const names = args.battery === 'all' ? Object.keys(BATTERIES) : args.battery.split(',');
for (const n of names) {
  if (!BATTERIES[n]) { console.error(`unknown battery ${n} (known: ${Object.keys(BATTERIES).join(', ')})`); process.exit(2); }
}

// batteries may be async (chaos spawns children); failures are RECORDED as a
// failed battery, never a hung or swallowed run (the gate fails loudly).
// s22/m-9: a registry entry whose battery FILE has not landed yet is an
// honest SKIP (existsSync guard — the note says so in the report + stdout).
const reports = [];
for (const name of names) {
  console.log(`\n=== battery ${name}${args.quick ? ' (quick)' : ' (full)'} — seed ${args.seed} ===`);
  const t = Date.now();
  let rep;
  const batteryPath = join(HERE, 'batteries', `${name}.mjs`);
  if (!existsSync(batteryPath)) {
    console.log(`  SKIP ${name}: battery file not landed yet (stress/batteries/${name}.mjs absent — the s21-c2 remainder) — honest skip, not a fail`);
    rep = {
      battery: name, skipped: true, pass: true, checks: [], metrics: {},
      notes: [`not landed yet — stress/batteries/${name}.mjs absent (the s21-c2 remainder); skipped honestly, not failed`],
      durationMs: Date.now() - t,
    };
  } else {
    try {
      const mod = await BATTERIES[name].load();
      const rec = await mod.run({ quick: args.quick, seed: args.seed });
      rep = rec.report();
    } catch (e) {
      console.log(`  FAIL ${name} crashed: ${e?.stack || e}`);
      rep = { battery: name, pass: false, checks: [{ name: 'battery-crashed', pass: false, detail: String(e?.stack || e).slice(0, 800) }], metrics: {}, notes: [], durationMs: Date.now() - t };
    }
  }
  rep.mode = args.quick ? 'quick' : 'full';
  rep.seed = args.seed;
  reports.push(rep);
  console.log(`  ${rep.skipped ? 'BATTERY-SKIP' : rep.pass ? 'BATTERY-PASS' : 'BATTERY-FAIL'} ${name}: ${rep.skipped ? 'not landed (0 checks)' : `${rep.checks.filter(c => c.pass).length}/${rep.checks.length} checks`} in ${rep.durationMs}ms`);
}

const ran = reports.filter(r => !r.skipped);
const skipped = reports.filter(r => r.skipped);
const total = ran.reduce((n, r) => n + r.checks.length, 0);
const passed = ran.reduce((n, r) => n + r.checks.filter(c => c.pass).length, 0);
const batteryPass = ran.filter(r => r.pass).length;
const failedBatteries = ran.filter(r => !r.pass).length;

// the durable report — always written (the numbers are the deliverable): the
// FULL per-battery reports ride inside (checks + metrics + notes), not just
// the summary.
const reportPath = join(HERE, 'last-stress-report.json');
writeFileSync(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: args.quick ? 'quick' : 'full',
  seed: args.seed,
  batteries: reports.length,
  batteriesRan: ran.length,
  batteriesSkipped: skipped.length,
  batteryPass,
  checks: `${passed}/${total}`,
  batteryReports: reports,
}, null, 1));
if (args.json) {
  const dir = resolve(process.cwd(), args.json);
  mkdirSync(dir, { recursive: true });
  for (const rep of reports) writeFileSync(join(dir, `stress-${rep.battery}.json`), JSON.stringify(rep, null, 1));
}

console.log(`\nSTRESS-RESULT ${passed}/${total} checks, ${batteryPass}/${ran.length} batteries ran${skipped.length ? `, ${skipped.length} SKIPPED (not landed: ${skipped.map(r => r.battery).join(', ')})` : ''} (${args.quick ? 'quick' : 'full'}, seed ${args.seed})`);
console.log(`report: ${reportPath}${args.json ? ` + per-battery JSON in ${resolve(process.cwd(), args.json)}` : ''}`);
// a skip never fails the gate (m-9); a real check failure or crashed battery does
process.exit(passed === total && failedBatteries === 0 ? 0 : 1);
