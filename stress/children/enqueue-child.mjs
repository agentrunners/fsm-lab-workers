#!/usr/bin/env node
// stress/children/enqueue-child.mjs — ONE Store.enqueueReport as a REAL
// separate process (the burst battery's 12-writer CAS storm).
//
// argv: <cloneDir> <recordJsonFile>
// stdout: {"ok":true} | {"ok":false,"err":"..."} — the parent diffs these
// against the drain tick's ledger (zero CAS losses = every one landed AND
// every report applied exactly once).
//
// The child shares the parent's clone (the X3 live shape: many writers on
// one clone — fetch ref-lock races + non-FF pushes + the jittered backoff
// ladder all fire for real).

import { readFileSync } from 'node:fs';
import { Store } from '../../lib/store.mjs';

const [clone, recFile] = process.argv.slice(2);
if (!clone || !recFile) { console.log(JSON.stringify({ ok: false, err: 'usage: enqueue-child.mjs <cloneDir> <recordJsonFile>' })); process.exit(2); }
try {
  const rec = JSON.parse(readFileSync(recFile, 'utf8'));
  const store = new Store({ cwd: clone });
  const r = store.enqueueReport(rec);
  console.log(JSON.stringify(r));
} catch (e) {
  console.log(JSON.stringify({ ok: false, err: String(e?.message || e).slice(0, 300) }));
  process.exit(1);
}
