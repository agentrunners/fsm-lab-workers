// tests/test-cc-bridge.mjs — the T46/R2 LANE B suite (46-R2-FIX-B).
// Pins worker/cc-bridge.mjs end-to-end: every test spawns the REAL bridge
// process (port-file contract, 127.0.0.1) against a MOCK UPSTREAM — a local
// http server that records exactly what the bridge forwards and answers
// programmatically — plus a RAW TCP SOCKET for the crash-regression class
// no HTTP client API can even express:
//   - M-2: a request target that won't parse (raw `GET ///`, the live-proven
//     killer) answers the loud 501 and the bridge SURVIVES
//   - M-3: the model pin — /v1/messages with model !== LANE_MODEL is a loud
//     403 and is NEVER forwarded; a non-JSON body is a loud 400
//   - M-3: BRIDGE_AUTH — when set, /v1/messages demands exactly
//     `Authorization: Bearer <BRIDGE_AUTH>` (401 otherwise, not forwarded);
//     when unset, no auth check (back-compat until the spawn-site wiring)
//   - m-7: GET /v1/models/{id} returns the BARE model object; GET /v1/models
//     keeps the LIST shape
//   - m-8: anthropic-beta forwarded up, client Authorization NEVER
//     forwarded (synthesized from the lane key), request-id/x-ratelimit-*
//     passed back, 32MB body cap → loud 413 (exact-at-cap passes)
//   - verified-sound passthrough pinned so the fixes can't regress it:
//     statuses verbatim, SSE streaming, query string preserved

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_PATH = fileURLToPath(new URL('../worker/cc-bridge.mjs', import.meta.url));
const LANE_KEY = 'sk-or-bridge-test-key';
const LANE_MODEL = 'test/lane-model:free';
const CAP_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// a mock upstream: records every request the bridge forwards (method, full
// URL, headers, body) and answers with a programmable per-request response.
function startMockUpstream() {
  const seen = [];
  const events = [];
  let next = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks) });
      const r = next || { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
      next = null;
      res.writeHead(r.status, r.headers || {});
      if (r.stream) {
        let i = 0;
        const step = () => {
          events.push(`mock:chunk${i + 1}`);
          res.write(r.stream[i]);
          if (++i >= r.stream.length) { res.end(); return; }
          setTimeout(step, r.gap ?? 150);
        };
        step();
      } else {
        res.end(r.body ?? '');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen, events,
      setNext: (r) => { next = r; },
      close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
    }));
  });
}

// spawn the real bridge with a lane key/model aimed at the mock upstream;
// resolves once the port file appears (the adapter's startBridge contract).
// T46/W-D review fold (A2, lens-1 F1): BRIDGE_LANE_LOG points at the spawn's
// OWN scratch path — the bridge's cwd fallback (./bridge-lane.jsonl) is the
// committed-residue class this fold killed; gates must never dirty the tree.
function startBridge({ auth, upstreamBase }) {
  const scratch = mkdtempSync(join(tmpdir(), 'bridge-b-test-'));
  const portFile = join(scratch, 'port');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    OPENROUTER_API_KEY: LANE_KEY,
    CC_LANE_MODEL: LANE_MODEL,
    OPENROUTER_BASE: upstreamBase,
    BRIDGE_LANE_LOG: join(scratch, 'bridge-lane.jsonl'),
  };
  if (auth !== undefined) env.BRIDGE_AUTH = auth;
  const child = spawn(process.execPath, [BRIDGE_PATH, portFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function wait() {
      let port = null;
      try { port = parseInt(readFileSync(portFile, 'utf8').trim(), 10); } catch { /* not yet */ }
      if (Number.isInteger(port) && port > 0) {
        resolve({
          port,
          url: `http://127.0.0.1:${port}`,
          output: () => out,
          hasExited: () => child.exitCode !== null,
          stop() { try { child.kill('SIGKILL'); } catch { /* already gone */ } rmSync(scratch, { recursive: true, force: true }); },
        });
        return;
      }
      if (child.exitCode !== null) { rmSync(scratch, { recursive: true, force: true }); reject(new Error(`bridge exited rc=${child.exitCode}: ${out.slice(0, 300)}`)); return; }
      if (Date.now() - t0 > 10_000) { try { child.kill('SIGKILL'); } catch { /* already gone */ } rmSync(scratch, { recursive: true, force: true }); reject(new Error(`bridge never listened: ${out.slice(0, 300)}`)); return; }
      setTimeout(wait, 25);
    })();
  });
}

// one bridge + one mock upstream, torn down after the body runs
async function withBridge(fn, { auth } = {}) {
  const upstream = await startMockUpstream();
  const bridge = await startBridge({ auth, upstreamBase: upstream.base });
  try {
    await fn(bridge, upstream);
  } finally {
    bridge.stop();
    await upstream.close();
  }
}

// a raw HTTP exchange over a TCP socket — the only way to send request
// targets (like `///`) that high-level clients refuse to express
function rawHttp(port, raw, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    let buf = '';
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('raw socket timeout')); });
    sock.on('error', reject);
    sock.on('connect', () => sock.write(raw));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('close', () => resolve(buf));
  });
}

// decode the body of a raw HTTP/1.1 response (Node answers res.end(string)
// with chunked framing; the test needs the logical body)
function responseBody(raw) {
  let body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  if (/^[0-9a-f]+\r\n/i.test(body)) {
    let out = '';
    for (;;) {
      const m = /^([0-9a-f]+)\r\n/i.exec(body);
      if (!m || parseInt(m[1], 16) === 0) break;
      out += body.slice(m[0].length, m[0].length + parseInt(m[1], 16));
      body = body.slice(m[0].length + parseInt(m[1], 16) + 2);
    }
    return out;
  }
  return body;
}

const msgBody = (model, extra = {}) => JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

// ---------------------------------------------------------------------------
// M-2 — the crash (live-proven: `GET ///` killed the credential holder)
// ---------------------------------------------------------------------------

test('M-2 crash regression: raw `GET ///` answers the loud 501 and the bridge SURVIVES', async () => {
  await withBridge(async (bridge) => {
    // the live-proven killer: `///` throws ERR_INVALID_URL in new URL() —
    // pre-fix this escaped the handler and exited the process (rc=1)
    const resp = await rawHttp(bridge.port, 'GET /// HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(resp, /^HTTP\/1\.1 501/, `the malformed target gets the loud 501, not a crash (${resp.slice(0, 60)})`);
    const parsed = JSON.parse(responseBody(resp));
    assert.equal(parsed.type, 'error');
    assert.ok(parsed.error.type, 'the 501 carries the error envelope shape');
    // same class, empty authority: `//` also fails URL parsing
    const resp2 = await rawHttp(bridge.port, 'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(resp2, /^HTTP\/1\.1 501/, 'the empty-authority form is also contained');
    // hammer it — survival, not a one-off
    for (let i = 0; i < 3; i++) {
      const again = await rawHttp(bridge.port, 'GET /// HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      assert.match(again, /^HTTP\/1\.1 501/);
    }
    assert.equal(bridge.hasExited(), false, 'the bridge process is still alive after the malformed-target storm');
    // ...and it still SERVES (not a zombie): the synthesized models route
    const r = await fetch(`${bridge.url}/v1/models`);
    assert.equal(r.status, 200);
    // the unknown-route contract is untouched: still the loud 501
    const r2 = await fetch(`${bridge.url}/v1/something-else`, { method: 'POST' });
    assert.equal(r2.status, 501);
    assert.match(bridge.output(), /BRIDGE-BAD-TARGET/, 'the rejection is LOUD in the bridge log');
  });
});

// ---------------------------------------------------------------------------
// M-3 — the model pin (fail-noisy; the lane key only ever buys LANE_MODEL)
// ---------------------------------------------------------------------------

test('M-3 model pin: a foreign model is a LOUD 403 and is NEVER forwarded', async () => {
  await withBridge(async (bridge, upstream) => {
    const r = await post(`${bridge.url}/v1/messages`, msgBody('anthropic/paid-expensive-model'));
    assert.equal(r.status, 403, 'no silent rewrite, no passthrough — 403');
    const body = await r.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'bridge_model_not_allowed');
    assert.match(body.error.message, /test\/lane-model:free/, 'the error names the pinned lane model');
    // missing model entirely: same loud refusal (fail-closed)
    const r2 = await post(`${bridge.url}/v1/messages`, JSON.stringify({ max_tokens: 64, messages: [] }));
    assert.equal(r2.status, 403);
    assert.equal(upstream.seen.length, 0, 'NOTHING reached the upstream — the key was never aimed at a foreign model');
    assert.match(bridge.output(), /BRIDGE-MODEL-REJECT/, 'the rejection is LOUD in the bridge log');
    // the pinned model passes and is forwarded VERBATIM with the lane key
    const ok = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL));
    assert.equal(ok.status, 200);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].method, 'POST');
    assert.equal(upstream.seen[0].url, '/api/v1/messages');
    assert.equal(upstream.seen[0].headers.authorization, `Bearer ${LANE_KEY}`);
    assert.deepEqual(JSON.parse(upstream.seen[0].body.toString('utf8')), JSON.parse(msgBody(LANE_MODEL)));
  });
});

test('M-3 model pin: a non-JSON body is a LOUD 400 and is NEVER forwarded', async () => {
  await withBridge(async (bridge, upstream) => {
    const r = await post(`${bridge.url}/v1/messages`, 'this is not json at all');
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.type, 'bridge_invalid_body');
    assert.equal(upstream.seen.length, 0, 'garbage never reaches the upstream with the key attached');
    assert.match(bridge.output(), /BRIDGE-BAD-BODY/, 'the rejection is LOUD in the bridge log');
  });
});

// ---------------------------------------------------------------------------
// M-3 — BRIDGE_AUTH (optional; enforced only when present)
// ---------------------------------------------------------------------------

test('M-3 BRIDGE_AUTH set: exact `Authorization: Bearer <BRIDGE_AUTH>` required — 401 otherwise, never forwarded', async () => {
  await withBridge(async (bridge, upstream) => {
    // missing / wrong / wrong-scheme: all loud 401s, none forwarded
    const cases = [
      ['missing', {}],
      ['wrong token', { authorization: 'Bearer wrong-token' }],
      ['non-bearer scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
      ['prefix trick', { authorization: `Bearerx ${'bridge-local-no-key'}` }],
    ];
    for (const [name, headers] of cases) {
      const r = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL), headers);
      assert.equal(r.status, 401, `${name}: 401`);
      const body = await r.json();
      assert.equal(body.error.type, 'bridge_auth_rejected');
    }
    assert.equal(upstream.seen.length, 0, 'no unauthorized request was forwarded');
    assert.match(bridge.output(), /BRIDGE-AUTH-REJECT/, 'the rejection is LOUD in the bridge log');
    // the exact bearer passes
    const ok = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL), { authorization: 'Bearer bridge-local-no-key' });
    assert.equal(ok.status, 200);
    assert.equal(upstream.seen.length, 1);
    // scope pin: the models route is a keyless synth — it stays open (the
    // auth guard protects the credential-SPENDING route only)
    const models = await fetch(`${bridge.url}/v1/models/${encodeURIComponent(LANE_MODEL)}`);
    assert.equal(models.status, 200);
  }, { auth: 'bridge-local-no-key' });
});

test('M-3 BRIDGE_AUTH unset: no auth check (back-compat until the spawn-site wiring lands)', async () => {
  await withBridge(async (bridge, upstream) => {
    const r = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL));   // no Authorization at all
    assert.equal(r.status, 200, 'current no-auth local behavior is preserved when BRIDGE_AUTH is absent');
    assert.equal(upstream.seen.length, 1);
  });
});

// ---------------------------------------------------------------------------
// m-7 — the models route shapes (detail = bare object, list = {data:[...]})
// ---------------------------------------------------------------------------

test('m-7: GET /v1/models/{id} returns the BARE model object; GET /v1/models keeps the LIST shape', async () => {
  await withBridge(async (bridge, upstream) => {
    // the LIST route (this is what a CLI list call expects)
    const list = await fetch(`${bridge.url}/v1/models`);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.ok(Array.isArray(listBody.data), 'list route: data is an array');
    assert.equal(listBody.data[0].id, LANE_MODEL);
    assert.equal(listBody.first_id, LANE_MODEL);
    assert.equal(listBody.has_more, false);
    // the DETAIL route (the CLI pre-flight — slug percent-encoded, as the
    // SDK sends it): the real Anthropic shape is the BARE object
    const detail = await fetch(`${bridge.url}/v1/models/${encodeURIComponent(LANE_MODEL)}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.id, LANE_MODEL);
    assert.equal(detailBody.type, 'model');
    assert.equal(detailBody.display_name, LANE_MODEL);
    assert.ok(detailBody.created_at);
    assert.equal(detailBody.data, undefined, 'detail route: NO list wrapper — the shape lie is gone');
    // the raw-slug form (unencoded slash) hits the same detail branch
    const rawSlug = await fetch(`${bridge.url}/v1/models/${LANE_MODEL}`);
    assert.equal(rawSlug.status, 200);
    assert.equal((await rawSlug.json()).id, LANE_MODEL);
    // documented semantics: any id gets LANE_MODEL's record (a foreign model
    // ask is blocked loudly at /v1/messages by the pin)
    const foreign = await fetch(`${bridge.url}/v1/models/some-other-model`);
    assert.equal(foreign.status, 200);
    assert.equal((await foreign.json()).id, LANE_MODEL);
    assert.equal(upstream.seen.length, 0, 'the models routes are pure synth — no upstream traffic');
  });
});

// ---------------------------------------------------------------------------
// m-8 — the body cap (32MB, loud 413, boundary-exact)
// ---------------------------------------------------------------------------

test('m-8 body cap: exactly 32MB passes; one byte over is a LOUD 413 and is NEVER forwarded', async () => {
  await withBridge(async (bridge, upstream) => {
    const prefix = `{"model":${JSON.stringify(LANE_MODEL)},"pad":"`;
    const suffix = '"}';
    const padLen = CAP_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const atCap = prefix + 'A'.repeat(padLen) + suffix;
    assert.equal(Buffer.byteLength(atCap), CAP_BYTES, 'test construction: exactly at the cap');
    const over = prefix + 'A'.repeat(padLen + 1) + suffix;
    assert.equal(Buffer.byteLength(over), CAP_BYTES + 1, 'test construction: one byte over');
    // at-cap passes (the cap is >, not >=)
    const ok = await post(`${bridge.url}/v1/messages`, atCap);
    assert.equal(ok.status, 200);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].body.length, CAP_BYTES, 'the full at-cap body was forwarded');
    // one byte over: loud 413, nothing forwarded
    const r = await post(`${bridge.url}/v1/messages`, over);
    assert.equal(r.status, 413);
    const body = await r.json();
    assert.equal(body.error.type, 'bridge_body_too_large');
    assert.equal(upstream.seen.length, 1, 'the over-cap body was NOT forwarded');
    assert.match(bridge.output(), /BRIDGE-BODY-CAP/, 'the rejection is LOUD in the bridge log');
    // the bridge still serves afterwards (not a crash, a guardrail)
    const after = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL));
    assert.equal(after.status, 200);
    assert.equal(upstream.seen.length, 2);
  });
});

// ---------------------------------------------------------------------------
// m-8 — header fidelity (safe subset up, safe subset back)
// ---------------------------------------------------------------------------

test('m-8 headers: anthropic-beta forwarded up; client Authorization NEVER forwarded (synthesized); request-id/x-ratelimit passed back', async () => {
  await withBridge(async (bridge, upstream) => {
    upstream.setNext({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_test_123',
        'x-ratelimit-remaining-requests': '42',
        'anthropic-ratelimit-requests-remaining': '7',
        'retry-after': '3',
      },
      body: '{"ok":true}',
    });
    const r = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL), {
      'anthropic-beta': 'context-1m-2025-08-07',
      accept: 'text/event-stream',                 // distinctive value — must NOT be forwarded
      authorization: 'Bearer EVIL-CLIENT-TOKEN',   // must be REPLACED by the lane key
      'x-api-key': 'evil-key',                     // must be DROPPED
      'x-custom-junk': 'dropped',                  // must be DROPPED
    });
    assert.equal(r.status, 200);
    const fwd = upstream.seen[0].headers;
    assert.equal(fwd['anthropic-beta'], 'context-1m-2025-08-07', 'anthropic-beta is forwarded');
    assert.equal(fwd.authorization, `Bearer ${LANE_KEY}`, 'Authorization is SYNTHESIZED from the lane key — the client token never reaches upstream');
    assert.equal(fwd['x-api-key'], undefined, 'client x-api-key is dropped');
    assert.equal(fwd['x-custom-junk'], undefined, 'unknown client headers are dropped (safe subset only)');
    assert.equal(fwd.accept, '*/*', "the client's distinctive accept is NOT forwarded — the mock sees only undici's own fetch default");
    assert.equal(fwd['anthropic-version'], '2023-06-01', 'anthropic-version stays synthesized');
    assert.equal(fwd['content-type'], 'application/json');
    // response headers back: request ids + rate-limit telemetry
    assert.equal(r.headers.get('request-id'), 'req_test_123');
    assert.equal(r.headers.get('x-ratelimit-remaining-requests'), '42');
    assert.equal(r.headers.get('anthropic-ratelimit-requests-remaining'), '7');
    assert.equal(r.headers.get('retry-after'), '3');
    assert.equal(r.headers.get('content-type'), 'application/json');
  });
});

// ---------------------------------------------------------------------------
// verified-sound passthrough — pinned so the fixes can't regress it
// ---------------------------------------------------------------------------

test('verified-sound passthrough: statuses verbatim, query string preserved, SSE streams chunk-by-chunk', async () => {
  await withBridge(async (bridge, upstream) => {
    // status + body pass through VERBATIM (an upstream 503 is a 503)
    upstream.setNext({ status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"upstream said no"}' });
    const r = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL));
    assert.equal(r.status, 503);
    assert.equal(await r.text(), '{"error":"upstream said no"}');
    assert.equal(r.headers.get('content-type'), 'application/json');
    // the query string is preserved (the SDK posts /v1/messages?beta=true)
    const rq = await post(`${bridge.url}/v1/messages?beta=true`, msgBody(LANE_MODEL));
    assert.equal(rq.status, 200);
    assert.equal(upstream.seen[upstream.seen.length - 1].url, '/api/v1/messages?beta=true', 'the query string reached the upstream');
    // SSE: the bridge streams — the client sees chunk 1 BEFORE the mock
    // even writes chunk 2 (150ms gap; no whole-body buffering)
    upstream.setNext({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      stream: ['data: {"a":1}\n\n', 'data: {"b":2}\n\n'],
      gap: 150,
    });
    const sse = await post(`${bridge.url}/v1/messages`, msgBody(LANE_MODEL, { stream: true }));
    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get('content-type'), 'text/event-stream', 'the SSE content-type survives');
    let text = '';
    let first = true;
    for await (const chunk of sse.body) {
      if (first) { upstream.events.push('client:chunk1'); first = false; }
      text += Buffer.from(chunk).toString('utf8');   // Uint8Array.toString() would comma-join the bytes
    }
    assert.equal(text, 'data: {"a":1}\n\ndata: {"b":2}\n\n', 'the SSE body passes through verbatim');
    const firstClient = upstream.events.indexOf('client:chunk1');
    const secondMock = upstream.events.indexOf('mock:chunk2');
    assert.ok(firstClient !== -1 && secondMock !== -1 && firstClient < secondMock,
      `the client streamed chunk 1 before the mock wrote chunk 2 (events: ${upstream.events.join(' -> ')})`);
  });
});
