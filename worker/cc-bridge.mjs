// cc-bridge.mjs — the LOCAL harness bridge (T46/X20 run-3 root cause).
//
// claude-code 2.1.273 pre-flights GET /v1/models/{id} before a turn; the
// OpenRouter Anthropic-compat surface (/api/v1/messages — verified 200)
// lacks the per-model info route (404), so the CLI aborts with
// [claude-code:unrecognized_model] and api_error_status 404 BEFORE the main
// call (live-proven: X20 run 3 + the x20-diag matrix — every env/flag
// variant, query_source "sdk", 333ms single-round-trip death).
//
// THE BRIDGE (zero dependencies, one process per turn, 127.0.0.1 only):
//   GET  /v1/models*            -> a synthesized Anthropic-style model info
//                                  response for the lane's slug (the
//                                  pre-flight just needs a 200 with an id)
//   POST /v1/messages*          -> forwarded VERBATIM (query string kept —
//                                  the SDK posts /v1/messages?beta=true) to
//                                  OPENROUTER_BASE/api/v1/messages with the
//                                  REAL key (Authorization: Bearer)
//   anything else               -> 501 (loud in the log — an unknown route
//                                  the CLI starts needing must be VISIBLE,
//                                  not a silent 404 mirror)
//
// KEY HYGIENE: the OpenRouter key lives ONLY in this process's env — the
// CLI's env carries ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and a dummy
// token. A CLI process (or anything it spawns) can no longer read the real
// credential. (F-M8 amended: the bridge is local; the lane key never rides
// the harness env.)
//
// Lifecycle: the ADAPTER spawns this per real-mode turn and kills it in its
// finally. Not used in CC_FAKE_LLM mode (the fake CLI never touches the
// network).
//
// Usage (spawned, not imported): node cc-bridge.mjs <port-file>
//   Writes the chosen port to <port-file> when listening, then serves.

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT_FILE = process.argv[2];
const UPSTREAM_BASE = (process.env.OPENROUTER_BASE || 'https://openrouter.ai').replace(/\/+$/, '');
const LANE_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2 || '';
const LANE_MODEL = process.env.CC_LANE_MODEL || '';

if (!PORT_FILE) {
  console.error('cc-bridge: usage: node cc-bridge.mjs <port-file>');
  process.exit(2);
}
if (!LANE_KEY) {
  console.error('cc-bridge: no lane key in env (OPENROUTER_API_KEY[_2])');
  process.exit(2);
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const path = u.pathname;
  try {
    // ---- the pre-flight: model info (synthesized — 200 + an id is the ask)
    if (req.method === 'GET' && /^\/v1\/models/.test(path)) {
      const body = JSON.stringify({
        data: [{
          id: LANE_MODEL,
          type: 'model',
          display_name: LANE_MODEL,
          created_at: '2026-01-01T00:00:00Z',
        }],
        // the LIST shape (GET /v1/models) carries the same array field
        first_id: LANE_MODEL, last_id: LANE_MODEL, has_more: false,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      console.log(`BRIDGE models ${path} -> 200 (synth ${LANE_MODEL})`);
      return;
    }
    // ---- the main lane: messages passthrough (query string preserved)
    if (req.method === 'POST' && /^\/v1\/messages/.test(path)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const up = await fetch(`${UPSTREAM_BASE}/api/v1/messages${u.search}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${LANE_KEY}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body,
      });
      const respHeaders = {
        'Content-Type': up.headers.get('content-type') || 'application/json',
      };
      res.writeHead(up.status, respHeaders);
      if (up.body) {
        // stream the upstream body through (SSE included)
        for await (const chunk of up.body) res.write(chunk);
      }
      res.end();
      console.log(`BRIDGE messages${u.search} -> ${up.status} (${body.length}B in)`);
      return;
    }
    // ---- unknown route: LOUD (a 404 mirror would recreate the bug class)
    console.error(`BRIDGE-UNKNOWN-ROUTE ${req.method} ${path} — the CLI grew a new route; extend the bridge (501 returned, never a silent 404)`);
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_unknown_route', message: `cc-bridge does not implement ${req.method} ${path}` } }));
  } catch (e) {
    console.error(`BRIDGE-FAILED ${req.method} ${path}: ${String(e?.message ?? e).slice(0, 200)}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_error', message: String(e?.message ?? e).slice(0, 200) } }));
    } else {
      res.end();
    }
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  writeFileSync(PORT_FILE, String(port));
  console.log(`BRIDGE-LISTENING 127.0.0.1:${port} -> ${UPSTREAM_BASE} (model ${LANE_MODEL})`);
});

// the adapter kills this process in its finally; a stray bridge dies with
// the job (never survives the runner)
process.on('SIGTERM', () => { server.close(() => process.exit(0)); process.exit(0); });
