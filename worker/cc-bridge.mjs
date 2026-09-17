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
//   GET  /v1/models           -> the LIST shape {data:[...], first_id,
//                                 last_id, has_more} (m-7)
//   GET  /v1/models/{id}      -> the BARE model object — the real Anthropic
//                                 detail shape (m-7; any requested id gets
//                                 LANE_MODEL's record — the CLI only ever
//                                 pre-flights the lane slug)
//   POST /v1/messages*        -> forwarded VERBATIM (query string kept —
//                                 the SDK posts /v1/messages?beta=true) to
//                                 OPENROUTER_BASE/api/v1/messages with the
//                                 REAL key (Authorization: Bearer), behind
//                                 three loud guardrails (M-3/m-8):
//                                   - BRIDGE_AUTH set and Authorization not
//                                     exactly `Bearer <BRIDGE_AUTH>` → 401
//                                   - body > 32MB → 413
//                                   - body not JSON, or model not exactly
//                                     LANE_MODEL → 400/403
//                                 The lane key is ONLY ever spent on the
//                                 lane model — fail-noisy, never a silent
//                                 rewrite, never a passthrough.
//   anything else             -> 501 (loud in the log — an unknown route
//                                 the CLI starts needing must be VISIBLE,
//                                 not a silent 404 mirror); a request
//                                 target that won't even PARSE (raw
//                                 `GET ///`) is also a 501, never a crash
//                                 (M-2 — live-proven killer, now contained)
//
// KEY HYGIENE: the OpenRouter key lives ONLY in this process's env — the
// CLI's env carries ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and a dummy
// token. A CLI process (or anything it spawns) can no longer read the real
// credential. (F-M8 amended: the bridge is local; the lane key never rides
// the harness env.)
//
// BRIDGE_AUTH (M-3, optional): when set, POST /v1/messages must carry
// exactly `Authorization: Bearer <BRIDGE_AUTH>` or it is a LOUD 401 and is
// NOT forwarded. The intended wiring (orchestrator, post-merge): the
// adapter's startBridge() spawns this process with BRIDGE_AUTH set to the
// SAME dummy it hands the CLI as ANTHROPIC_AUTH_TOKEN ('bridge-local-no-key'
// in bridge mode), so the CLI's own requests pass while unrelated local
// processes cannot silently spend the lane key. When unset, no auth check
// runs (back-compat with the current spawn site). The check guards the
// credential-SPENDING route only — the models route is a keyless synth and
// unknown routes 501 on their own.
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
const BRIDGE_AUTH = process.env.BRIDGE_AUTH || '';   // M-3: enforced only when present

// m-8: request-body cap — an over-cap body is a LOUD 413; it is never
// buffered whole and never forwarded.
const MAX_BODY_BYTES = 32 * 1024 * 1024;
// m-8: explicit hard cap on the upstream fetch. NOTE: AbortSignal.timeout
// bounds the WHOLE exchange (connect + headers + response-body streaming),
// not just idle time — a mid-stream abort surfaces as BRIDGE-FAILED and the
// client's stream simply ends.
const UPSTREAM_TIMEOUT_MS = 300_000;

if (!PORT_FILE) {
  console.error('cc-bridge: usage: node cc-bridge.mjs <port-file>');
  process.exit(2);
}
if (!LANE_KEY) {
  console.error('cc-bridge: no lane key in env (OPENROUTER_API_KEY[_2])');
  process.exit(2);
}

const server = createServer(async (req, res) => {
  // `path` doubles as the catch-path log label until the URL parses
  let path = String(req.url).slice(0, 120);
  try {
    // M-2 fix (r2 lens C): this parse used to sit ABOVE the try — a raw
    // `GET ///` (live-proven) threw ERR_INVALID_URL out of the handler and
    // KILLED the credential-holding process. It now parses inside; a
    // malformed request-target answers the loud 501 (same shape as the
    // unknown-route family) and the bridge stays up.
    let u = null;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { /* handled below */ }
    if (!u) {
      console.error(`BRIDGE-BAD-TARGET ${req.method} ${JSON.stringify(path)} — unparseable request target (501, bridge alive)`);
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_bad_request_target', message: `cc-bridge cannot parse request target ${JSON.stringify(path)}` } }));
      return;
    }
    path = u.pathname;
    // ---- the pre-flight: model info (synthesized — 200 + an id is the ask)
    if (req.method === 'GET' && /^\/v1\/models/.test(path)) {
      // m-7 fix (r2 lens C): the DETAIL route (GET /v1/models/{id}) returns
      // the BARE model object — the real Anthropic shape — while the LIST
      // route (GET /v1/models) keeps {data:[...], first_id, last_id,
      // has_more}. Any requested id still gets LANE_MODEL's record
      // (pre-existing semantics; a foreign model ask is blocked loudly at
      // /v1/messages by the model pin).
      const modelObj = {
        id: LANE_MODEL,
        type: 'model',
        display_name: LANE_MODEL,
        created_at: '2026-01-01T00:00:00Z',
      };
      const idPart = path.startsWith('/v1/models/') ? path.slice('/v1/models/'.length) : '';
      if (idPart) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(modelObj));
        console.log(`BRIDGE models ${path} -> 200 (synth detail ${LANE_MODEL})`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [modelObj],
        first_id: LANE_MODEL, last_id: LANE_MODEL, has_more: false,
      }));
      console.log(`BRIDGE models ${path} -> 200 (synth list ${LANE_MODEL})`);
      return;
    }
    // ---- the main lane: messages passthrough (query string preserved)
    if (req.method === 'POST' && /^\/v1\/messages/.test(path)) {
      // M-3 auth half: when BRIDGE_AUTH is set, the request must prove it
      // holds the CLI's dummy — EITHER `Authorization: Bearer <BRIDGE_AUTH>`
      // (the SDK's auth-token shape) OR `x-api-key: <BRIDGE_AUTH>` (the
      // API-key shape; the real CLI's exact header depends on which env var
      // it keyed off — both are accepted rather than betting a live epoch
      // on one). Anything else is a LOUD 401 and is NOT forwarded. Unset →
      // no check (back-compat).
      if (BRIDGE_AUTH) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        const xKey = req.headers['x-api-key'];
        const ok = (bearer && bearer[1] === BRIDGE_AUTH) || xKey === BRIDGE_AUTH;
        if (!ok) {
          console.error(`BRIDGE-AUTH-REJECT ${req.method} ${path} — Authorization/x-api-key missing or wrong (401, NOT forwarded)`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_auth_rejected', message: 'cc-bridge: missing or invalid credentials (expected the CLI dummy via Authorization: Bearer or x-api-key)' } }));
          return;
        }
      }
      // m-8 body cap: >32MB is a LOUD 413. Past the cap we keep consuming
      // (and discarding) so the response is delivered cleanly on the same
      // connection — an adversarial unbounded sender can only waste a
      // localhost socket, never bridge memory.
      const chunks = [];
      let size = 0;
      let capped = false;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES) { capped = true; continue; }
        chunks.push(c);
      }
      if (capped) {
        console.error(`BRIDGE-BODY-CAP ${req.method} ${path} — body ${size}B exceeds ${MAX_BODY_BYTES}B cap (413, NOT forwarded)`);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_body_too_large', message: `cc-bridge: request body exceeds the ${MAX_BODY_BYTES}-byte cap` } }));
        return;
      }
      const body = Buffer.concat(chunks);
      // M-3 model half: the lane key must ONLY ever be spent on LANE_MODEL.
      // The body must parse as a JSON object — a body that doesn't is a LOUD
      // 400 — and pin the exact lane slug, else a LOUD 403. No silent
      // rewrite, no passthrough: fail-noisy on the credential holder.
      let parsed = null;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* handled below */ }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error(`BRIDGE-BAD-BODY ${req.method} ${path} — body is not a JSON object (${body.length}B) (400, NOT forwarded)`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_invalid_body', message: 'cc-bridge: /v1/messages request body must be a JSON object' } }));
        return;
      }
      const model = parsed.model;
      if (model !== LANE_MODEL) {
        const asked = typeof model === 'string' ? model.slice(0, 120) : model;
        console.error(`BRIDGE-MODEL-REJECT ${req.method} ${path} — model ${JSON.stringify(asked)} !== lane model ${JSON.stringify(LANE_MODEL)} (403, NOT forwarded)`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'bridge_model_not_allowed', message: `cc-bridge: this lane is pinned to model ${JSON.stringify(LANE_MODEL)}; refusing ${JSON.stringify(asked)}` } }));
        return;
      }
      // m-8: forward a SAFE subset of client headers upstream — only
      // `anthropic-beta` (the CLI's feature-flag header; Node comma-joins
      // repeats). Authorization/Content-Type/anthropic-version stay
      // SYNTHESIZED (never client-controllable — verified-sound, keep it);
      // x-api-key and every other client header stay dropped.
      const fwd = {
        Authorization: `Bearer ${LANE_KEY}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (req.headers['anthropic-beta']) fwd['anthropic-beta'] = req.headers['anthropic-beta'];
      const up = await fetch(`${UPSTREAM_BASE}/api/v1/messages${u.search}`, {
        method: 'POST',
        headers: fwd,
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      // m-8: forward a SAFE subset of upstream response headers back —
      // request ids, retry-after, rate-limit telemetry. NEVER the framing
      // headers (content-length/transfer-encoding — undici re-frames the
      // passthrough) nor content-encoding (undici decompresses; forwarding
      // it would corrupt the body).
      const respHeaders = { 'Content-Type': up.headers.get('content-type') || 'application/json' };
      for (const h of ['request-id', 'anthropic-request-id', 'retry-after']) {
        const v = up.headers.get(h);
        if (v) respHeaders[h] = v;
      }
      for (const [k, v] of up.headers) {
        if (/^(x-ratelimit-|anthropic-ratelimit-)/.test(k)) respHeaders[k] = v;
      }
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

// Lifecycle contract (m-4, r2 lens C): the ADAPTER stops this process with a
// group-scoped SIGKILL (startBridge().stop() in worker/cc-adapter.mjs —
// `kill(-pid, 'SIGKILL')`, uncatchable by design; the wall is a hard
// deadline). There is NO graceful shutdown: a SIGTERM handler here would be
// dead code under that contract (it was — deleted), in-flight sockets are
// RST'd by design, and a stray bridge dies with the job. Do not re-add
// signal handlers.
