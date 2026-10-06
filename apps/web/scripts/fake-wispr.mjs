#!/usr/bin/env node
/* ============================================================================
 * fake-wispr: a tiny stand-in for the Wispr Flow API (TRD §5.5) so the whole voice path can be exercised
 * WITHOUT a key: browser mic -> VAD -> client_ws -> final text -> Synapse.
 *
 *   node apps/web/scripts/fake-wispr.mjs                       (listens on 127.0.0.1:8799)
 *   FAKE_WISPR_TEXT="Email the team about the delay|What did Sarah say about OAuth2?" node apps/web/scripts/fake-wispr.mjs
 *
 * Point the Synapse server at it (the server derives ws:// and /client_api from WISPR_BASE):
 *   WISPR_MODE=client  WISPR_API_KEY=fl-fake  WISPR_BASE=http://127.0.0.1:8799/api/v1/dash
 *
 * It speaks the documented protocol:
 *   POST /api/v1/dash/generate_access_token   {client_id, duration_secs} -> {access_token, expires_in}
 *   GET  /api/v1/dash/warmup_dash             -> {status:"warmed"}
 *   POST /api/v1/dash/client_api | /api/v1/dash/api   {audio(base64 WAV), language?, context}  -> {text, detected_language,...}
 *   WS   /api/v1/dash/client_ws?client_key=Bearer%20<jwt>     (also /api/v1/dash/ws?api_key=...)
 *        auth   -> {"status":"auth"}
 *        append -> {"status":"info","message":{"event":"session_started"|"chunk_received"}}
 *        commit -> {"status":"info","message":{"event":"commit_received"}}, then {"status":"text","final":true,...}, then close
 *
 * It is STRICT by default: protocol violations (wrong append position, changing packet_duration, total_packets mismatch,
 * screenshot/content fields that are not null, > 150 dictionary terms, > 6 conversation messages, ...) are answered with
 * {"status":"error"} and recorded in `stats.violations`, so regressions in the browser streamer are caught early.
 *
 * Env: FAKE_WISPR_PORT (8799) FAKE_WISPR_HOST (127.0.0.1) FAKE_WISPR_TEXT ("a|b|c", round-robin)
 *      FAKE_WISPR_LATENCY_MS (250, commit -> final) FAKE_WISPR_PARTIALS=1 (send a partial before the final)
 *      FAKE_WISPR_FAIL=none|error|drop|silent|rest-error  FAKE_WISPR_STRICT=0 (lenient)  FAKE_WISPR_QUIET=1
 *
 * Zero dependencies: a minimal RFC 6455 server on node:http. It never writes audio anywhere and never logs transcript text.
 * ========================================================================== */
import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BASE = "/api/v1/dash";

export const CANNED_TEXTS = [
  "Uhh, so the auth thing, maybe JWT but shorter expiry? Or no, OAuth2. What did Sarah say?",
  "That bug from yesterday, the one with the null pointer, in the cart service, probably the discount code.",
  "I need to email the team about the delay.",
  "Maybe a recursive, no, iterative approach with memoization.",
  "What was that idea I had about caching last Tuesday while I was walking?",
];

/* ----------------------------------------------------------------------------- tiny WebSocket frames */

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

/** incremental parser for client (masked) frames; calls onMessage(opcode, Buffer) per complete message */
function createParser(onMessage, onProtocolError) {
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let frags = [];
  let fragBytes = 0;
  const MAX = 16 * 1024 * 1024;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX)) return onProtocolError("frame too large");
        len = Number(big);
        off = 10;
      }
      if (len > MAX) return onProtocolError("frame too large");
      if (!masked) return onProtocolError("client frames must be masked");
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (opcode >= 0x8) {
        onMessage(opcode, payload); // control frames are never fragmented
      } else if (opcode === 0x0) {
        frags.push(payload);
        fragBytes += payload.length;
        if (fragBytes > MAX) return onProtocolError("message too large");
        if (fin) {
          onMessage(fragOpcode, Buffer.concat(frags));
          frags = [];
          fragBytes = 0;
        }
      } else if (fin) {
        onMessage(opcode, payload);
      } else {
        fragOpcode = opcode;
        frags = [payload];
        fragBytes = payload.length;
      }
    }
  };
}

/* ----------------------------------------------------------------------------- the server */

function envBool(v, dflt) {
  if (v === undefined || v === "") return dflt;
  return !/^(0|false|no|off)$/i.test(v);
}

function fakeJwt(clientId, ttlSecs) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + ttlSecs;
  return `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ sub: clientId ?? "fake", exp, iss: "fake-wispr" })}.${crypto.randomBytes(8).toString("base64url")}`;
}

/**
 * @param {import("./fake-wispr.d.mts").FakeWisprOptions} [options]
 * @returns {Promise<import("./fake-wispr.d.mts").FakeWisprServer>}
 */
export function startFakeWispr(options = {}) {
  const env = process.env;
  const cfg = {
    host: options.host ?? env.FAKE_WISPR_HOST ?? "127.0.0.1",
    port: options.port ?? Number(env.FAKE_WISPR_PORT ?? 8799),
    texts: options.texts ?? (env.FAKE_WISPR_TEXT ? env.FAKE_WISPR_TEXT.split("|").map((s) => s.trim()).filter(Boolean) : CANNED_TEXTS),
    latencyMs: options.finalDelayMs ?? Number(env.FAKE_WISPR_LATENCY_MS ?? 250),
    partials: options.partials ?? envBool(env.FAKE_WISPR_PARTIALS, false),
    info: options.info ?? true,
    fail: options.failMode ?? env.FAKE_WISPR_FAIL ?? "none",
    strict: options.strict ?? envBool(env.FAKE_WISPR_STRICT, true),
    quiet: options.quiet ?? envBool(env.FAKE_WISPR_QUIET, false),
    requireToken: options.requireToken ?? false,
    closeAfterFinal: options.closeAfterFinal ?? true,
  };
  if (!cfg.texts.length) cfg.texts = CANNED_TEXTS;

  const stats = {
    tokens: 0,
    warmups: 0,
    connections: 0,
    openConnections: 0,
    auths: 0,
    appends: 0,
    packets: 0,
    commits: 0,
    finals: 0,
    restCalls: 0,
    /** protocol violations the strict checker found (descriptions never contain content) */
    violations: [],
    /** packet payload sizes seen, e.g. [1024] for raw PCM16, [1068] for per-packet WAV */
    packetBytes: new Set(),
    /** commit -> final text delays are configured, not measured; kept for symmetry with a real run */
    lastTotalPackets: 0,
    lastPacketDuration: 0,
    lastAuth: null,
  };
  let textIdx = 0;
  const nextText = () => cfg.texts[textIdx++ % cfg.texts.length];
  const say = (...a) => {
    if (!cfg.quiet) console.log("[fake-wispr]", ...a);
  };
  const violation = (msg) => {
    stats.violations.push(msg);
    say("PROTOCOL VIOLATION:", msg);
  };
  const sockets = new Set();

  /* ---- HTTP ---- */
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  const json = (res, status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      let n = 0;
      req.on("data", (c) => {
        n += c.length;
        if (n < 40 * 1024 * 1024) chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(""));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (url.pathname === "/health") return json(res, 200, { ok: true, fake: "wispr", ...snapshot() });
    if (url.pathname === `${BASE}/generate_access_token` && req.method === "POST") {
      const body = safeJson(await readBody(req));
      stats.tokens++;
      const ttl = Number(body?.duration_secs) > 0 ? Number(body.duration_secs) : 900;
      return json(res, 200, { access_token: fakeJwt(body?.client_id, ttl), expires_in: ttl });
    }
    if (url.pathname === `${BASE}/warmup_dash`) {
      stats.warmups++;
      return json(res, 200, { status: "warmed" });
    }
    if ((url.pathname === `${BASE}/client_api` || url.pathname === `${BASE}/api`) && req.method === "POST") {
      stats.restCalls++;
      if (cfg.fail === "rest-error") return json(res, 500, { error: "simulated REST failure" });
      const auth = req.headers.authorization ?? "";
      if (cfg.requireToken && !/^Bearer\s+\S+/.test(auth)) return json(res, 401, { error: "missing bearer token" });
      const body = safeJson(await readBody(req));
      if (cfg.strict) checkRestBody(body, violation);
      return json(res, 200, {
        id: crypto.randomUUID(),
        text: nextText(),
        detected_language: "en",
        total_time: 120,
        generated_tokens: 12,
      });
    }
    json(res, 404, { error: "not found" });
  });

  /* ---- WebSocket ---- */
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://x");
    const okPath = url.pathname === `${BASE}/client_ws` || url.pathname === `${BASE}/ws`;
    const key = req.headers["sec-websocket-key"];
    if (!okPath || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const clientKey = url.searchParams.get("client_key") ?? url.searchParams.get("api_key") ?? "";
    if (cfg.requireToken && !/^Bearer\s+\S+/.test(clientKey)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    if (cfg.strict && clientKey && !/^Bearer\s\S+$/.test(clientKey)) violation("client_key is not 'Bearer <jwt>'");
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    stats.connections++;
    stats.openConnections++;
    handleConnection(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      stats.openConnections--;
    });
  });

  function handleConnection(socket) {
    const sess = { authed: false, packets: 0, packetDuration: null, committed: false, timers: [] };
    const send = (obj) => {
      if (socket.destroyed || !socket.writable) return;
      socket.write(encodeFrame(0x1, JSON.stringify(obj)));
    };
    const closeNow = (code = 1000) => {
      if (socket.destroyed) return;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code, 0);
      socket.write(encodeFrame(0x8, p));
      socket.end();
    };
    const err = (message) => {
      send({ status: "error", message });
    };
    const parser = createParser(
      (opcode, payload) => {
        if (opcode === 0x8) return closeNow(1000);
        if (opcode === 0x9) return socket.write(encodeFrame(0xa, payload));
        if (opcode !== 0x1) return;
        const msg = safeJson(payload.toString("utf8"));
        if (!msg || typeof msg.type !== "string") {
          if (cfg.strict) violation("message is not JSON with a type");
          return err("bad message");
        }
        switch (msg.type) {
          case "auth": {
            stats.auths++;
            sess.authed = true;
            stats.lastAuth = summarizeAuth(msg);
            if (cfg.strict) checkAuth(msg, violation);
            return send({ status: "auth" });
          }
          case "append": {
            if (!sess.authed) {
              violation("append before auth");
              return err("not authenticated");
            }
            if (sess.committed) {
              violation("append after commit");
              return err("session already committed");
            }
            const ap = msg.audio_packets;
            const packets = ap?.packets;
            if (!Array.isArray(packets) || packets.some((p) => typeof p !== "string")) {
              violation("append without a packets array of strings");
              return err("bad packets");
            }
            if (cfg.strict) {
              if (msg.position !== sess.packets) violation(`append position ${msg.position} != packets received so far ${sess.packets}`);
              if (!Array.isArray(ap.volumes) || ap.volumes.length !== packets.length) violation("volumes length != packets length");
              if (typeof ap.packet_duration !== "number") violation("packet_duration missing");
              else if (sess.packetDuration === null) sess.packetDuration = ap.packet_duration;
              else if (sess.packetDuration !== ap.packet_duration) violation("packet_duration changed during the session");
              if (ap.audio_encoding !== "wav") violation(`audio_encoding is ${String(ap.audio_encoding)}`);
              if (ap.byte_encoding !== "base64") violation(`byte_encoding is ${String(ap.byte_encoding)}`);
              if (packets.length === 0) violation("empty append");
            }
            for (const p of packets) stats.packetBytes.add(Buffer.from(p, "base64").length);
            if (cfg.info && sess.packets === 0) send({ status: "info", message: { event: "session_started" } });
            sess.packets += packets.length;
            stats.appends++;
            stats.packets += packets.length;
            stats.lastPacketDuration = ap.packet_duration;
            if (cfg.info) send({ status: "info", message: { event: "chunk_received" } });
            return;
          }
          case "commit": {
            if (!sess.authed) {
              violation("commit before auth");
              return err("not authenticated");
            }
            stats.commits++;
            sess.committed = true;
            stats.lastTotalPackets = msg.total_packets;
            if (cfg.strict && msg.total_packets !== sess.packets) violation(`commit total_packets ${msg.total_packets} != received ${sess.packets}`);
            if (cfg.info) send({ status: "info", message: { event: "commit_received" } });
            if (cfg.fail === "error") return err("simulated failure");
            if (cfg.fail === "drop") return socket.destroy();
            if (cfg.fail === "silent") return;
            const text = nextText();
            const total = sess.packets;
            const t1 = setTimeout(() => {
              if (cfg.partials) send({ status: "text", position: Math.max(0, total - 1), final: false, body: { text: text.split(" ").slice(0, 3).join(" "), detected_language: "en" } });
            }, Math.min(80, cfg.latencyMs / 2));
            const t2 = setTimeout(() => {
              stats.finals++;
              send({ status: "text", position: total, final: true, body: { text, detected_language: "en" } });
              if (cfg.closeAfterFinal) setTimeout(() => closeNow(1000), 20);
            }, cfg.latencyMs);
            sess.timers.push(t1, t2);
            return;
          }
          default:
            if (cfg.strict) violation(`unknown message type '${msg.type}'`);
        }
      },
      (m) => {
        violation(m);
        socket.destroy();
      },
    );
    socket.on("data", parser);
    socket.on("error", () => undefined);
    socket.on("close", () => sess.timers.forEach(clearTimeout));
  }

  function snapshot() {
    const { packetBytes, violations, ...rest } = stats;
    return { ...rest, packetBytes: [...packetBytes], violations: violations.length };
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.port;
      const httpUrl = `http://${cfg.host}:${port}${BASE}`;
      resolve({
        port,
        host: cfg.host,
        httpUrl,
        wsUrl: `ws://${cfg.host}:${port}${BASE}/client_ws`,
        restUrl: `${httpUrl}/client_api`,
        stats,
        setTexts(texts) {
          cfg.texts = texts.length ? texts : CANNED_TEXTS;
          textIdx = 0;
        },
        setFailMode(mode) {
          cfg.fail = mode;
        },
        setLatency(ms) {
          cfg.latencyMs = ms;
        },
        close() {
          return new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

/* ----------------------------------------------------------------------------- strict checks (content-free messages) */

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function summarizeAuth(msg) {
  const c = msg.context ?? {};
  return {
    hasAccessToken: typeof msg.access_token === "string" && msg.access_token.length > 0,
    language: msg.language ?? null,
    dictionaryTerms: Array.isArray(c.dictionary_context) ? c.dictionary_context.length : -1,
    conversationMessages: Array.isArray(c.conversation?.messages) ? c.conversation.messages.length : -1,
    appType: c.app?.type ?? null,
  };
}

function checkContext(c, violation) {
  if (!c || typeof c !== "object") return violation("context missing");
  if (c.screenshot !== null) violation("context.screenshot must be null");
  if (c.content_text !== null) violation("context.content_text must be null");
  if (c.content_html !== null) violation("context.content_html must be null");
  const tb = c.textbox_contents;
  if (!tb || tb.before_text !== "" || tb.selected_text !== "" || tb.after_text !== "") violation("textbox_contents must be empty strings");
  if (!Array.isArray(c.dictionary_context)) violation("dictionary_context must be an array");
  else if (c.dictionary_context.length > 150) violation(`dictionary_context has ${c.dictionary_context.length} terms (max 150)`);
  const msgs = c.conversation?.messages;
  if (!Array.isArray(msgs)) violation("conversation.messages must be an array");
  else {
    if (msgs.length > 6) violation(`conversation has ${msgs.length} messages (max 6)`);
    if (msgs.some((m) => m?.role !== "user" || typeof m.content !== "string")) violation("conversation messages must be {role:'user', content}");
  }
  if (c.app?.name !== "Synapse" || c.app?.type !== "ai") violation("context.app must be {name:'Synapse', type:'ai'}");
}

function checkAuth(msg, violation) {
  if (typeof msg.access_token !== "string" || !msg.access_token) violation("auth.access_token missing");
  if ("language" in msg && (!Array.isArray(msg.language) || msg.language.length === 0)) violation("auth.language must be omitted or a non-empty array");
  checkContext(msg.context, violation);
}

function checkRestBody(body, violation) {
  if (!body || typeof body.audio !== "string") return violation("REST body.audio missing");
  const wav = Buffer.from(body.audio, "base64");
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") violation("REST audio is not a WAV with a RIFF header");
  else if (wav.readUInt32LE(40) !== wav.length - 44) violation("REST WAV data length does not match the header");
  else if (wav.readUInt32LE(24) !== 16000) violation("REST WAV is not 16 kHz");
  checkContext(body.context, violation);
}

/* ----------------------------------------------------------------------------- CLI */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeWispr().then((s) => {
    console.log(`fake-wispr listening on ${s.host}:${s.port}`);
    console.log("  point the Synapse server at it with:");
    console.log(`    WISPR_MODE=client WISPR_API_KEY=fl-fake WISPR_BASE=${s.httpUrl}`);
    console.log(`  WS: ${s.wsUrl}   REST: ${s.restUrl}`);
    console.log(`  health + counters: http://${s.host}:${s.port}/health`);
    console.log(`  failure drills: FAKE_WISPR_FAIL=error|drop|silent|rest-error   latency: FAKE_WISPR_LATENCY_MS=1500`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }).catch((e) => {
    console.error("fake-wispr failed to start:", e.message);
    process.exit(1);
  });
}
