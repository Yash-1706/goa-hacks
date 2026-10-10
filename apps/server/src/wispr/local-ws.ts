import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { isAllowedOrigin } from "../gateway/trust";
import { log } from "../log";
import { STT_SAMPLE_RATE, type LocalStt, type LocalSttAuth } from "./local-stt";

/* ============================================================================
 * The on-device speech endpoints. They speak the SAME protocol as Wispr's client WebSocket and client REST API (TRD §5.5), so the
 * browser's streamer (VAD, packetizer, standby sockets, REST fallback, timeouts, kill switch) is used unchanged: only the token
 * it was handed points here instead of at Wispr.
 *
 *   WS   /local-stt/client_ws?client_key=Bearer%20<token>   auth → append* → commit → one final text → close
 *   POST /local-stt/client_api   {audio: base64 WAV}, Authorization: Bearer <token>   → {text, ...}
 *
 * Audio arrives here ONLY while the on-device engine is in use (`allowed()`): in plain client mode these routes refuse, so the
 * promise "with Wispr configured, audio never reaches this server" holds at the protocol level. It lives in memory for one
 * utterance and is zeroed after the transcript is sent, after an error, or when the socket closes. Nothing here touches the disk.
 * ========================================================================== */

export interface LocalSttRouteDeps {
  /** the engine for the NEXT utterance (decided at commit time: local-only mode may switch it between two utterances) */
  stt: () => LocalStt;
  auth: LocalSttAuth;
  /** true while the on-device engine may take audio (WISPR_MODE=local, local-only mode, or STT_FALLBACK) */
  allowed: () => boolean;
  now: () => number;
  /** one utterance transcribed (lengths only, never content) */
  onUtterance?: (info: { audioMs: number; ms: number; chars: number; via: "ws" | "rest" }) => void;
}

/** one utterance is capped: Whisper's cost grows with it, and a person does not speak for two minutes without a pause */
const MAX_UTTERANCE_SECS = 120;
const MAX_SAMPLES = STT_SAMPLE_RATE * MAX_UTTERANCE_SECS;
const MAX_SOCKETS = 12;
const AUTH_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;

const AuthMsg = z.object({ type: z.literal("auth"), access_token: z.string().min(1).max(4000) }).passthrough();
const AppendMsg = z
  .object({
    type: z.literal("append"),
    position: z.number().int().min(0),
    audio_packets: z.object({ packets: z.array(z.string().max(32_000)).min(1).max(256) }).passthrough(),
  })
  .passthrough();
const CommitMsg = z.object({ type: z.literal("commit"), total_packets: z.number().int().min(0) }).passthrough();
const RestBody = z.object({ audio: z.string().min(1) }).passthrough();

/** 16-bit little-endian PCM → floats in [-1, 1]. A packet that starts with a RIFF header (the `--packets wav` escape hatch) loses it. */
export function pcm16ToFloat(buf: Buffer): Float32Array {
  const body = buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" ? buf.subarray(44) : buf;
  const n = body.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = body.readInt16LE(i * 2) / 32768;
  return out;
}

/** A WAV file (16-bit PCM or 32-bit float, any channel count and rate) → 16 kHz mono floats. Throws on anything else. */
export function decodeWav(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let p = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    if (id === "fmt " && body.length >= 16) fmt = { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === "data") {
      data = body;
      break;
    }
    p += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV without fmt or data");
  const bytes = fmt.bits >> 3;
  if (!((fmt.tag === 1 && fmt.bits === 16) || (fmt.tag === 3 && fmt.bits === 32)) || fmt.channels < 1 || fmt.rate < 8000 || fmt.rate > 96_000) throw new Error("unsupported WAV format");
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = (i * fmt.channels + c) * bytes;
      sum += fmt.tag === 1 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
    }
    mono[i] = sum / fmt.channels;
  }
  if (fmt.rate === STT_SAMPLE_RATE) return mono;
  // linear resampling: speech recognition is not sensitive to it, and the browser already sends 16 kHz
  const outLen = Math.floor((frames * STT_SAMPLE_RATE) / fmt.rate);
  const out = new Float32Array(outLen);
  const step = fmt.rate / STT_SAMPLE_RATE;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const f = x - i0;
    out[i] = (mono[i0] as number) * (1 - f) + (mono[Math.min(frames - 1, i0 + 1)] as number) * f;
  }
  mono.fill(0);
  return out;
}

export function registerLocalStt(app: FastifyInstance, deps: LocalSttRouteDeps): { openSockets: () => number } {
  let open = 0;

  const bearer = (v: string | undefined): string | undefined => v?.replace(/^Bearer\s+/i, "");

  app.get("/local-stt/client_ws", { websocket: true }, (socket: WebSocket, req) => {
    if (!isAllowedOrigin(req.headers.origin)) return void socket.close(1008, "origin not allowed");
    if (!deps.allowed()) return void socket.close(1008, "on-device speech is off");
    if (open >= MAX_SOCKETS) return void socket.close(1013, "busy");
    open++;

    // the token also travels in the URL, like Wispr's client_key; when present it must be valid (the auth message repeats it)
    const urlKey = new URL(req.url, "http://localhost").searchParams.get("client_key");
    let authed = false;
    let committed = false;
    let failed = false;
    let packets = 0;
    let samples = 0;
    let chunks: Float32Array[] = [];
    let idle: ReturnType<typeof setTimeout> | undefined;

    const send = (obj: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(obj));
    };
    const error = (message: string): void => send({ status: "error", message });
    /** audio is gone the moment it is not needed any more */
    const wipe = (): void => {
      for (const c of chunks) c.fill(0);
      chunks = [];
      samples = 0;
    };
    const armIdle = (ms: number): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => socket.close(1000, "idle"), ms);
      idle.unref?.();
    };
    armIdle(AUTH_TIMEOUT_MS);

    socket.on("close", () => {
      open--;
      if (idle) clearTimeout(idle);
      wipe();
    });
    socket.on("error", () => wipe());

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return error("binary frames are not supported");
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return error("bad message");
      }
      const type = (msg as { type?: unknown } | null)?.type;
      armIdle(IDLE_TIMEOUT_MS);

      if (type === "auth") {
        const m = AuthMsg.safeParse(msg);
        const ok = m.success && deps.auth.verify(m.data.access_token, deps.now()) && (!urlKey || deps.auth.verify(urlKey, deps.now()));
        if (!ok) {
          error("invalid token");
          return void socket.close(1008, "invalid token");
        }
        authed = true;
        return send({ status: "auth" });
      }
      if (!authed) {
        error("not authenticated");
        return void socket.close(1008, "not authenticated");
      }
      if (!deps.allowed()) {
        error("on-device speech is off");
        return void socket.close(1008, "on-device speech is off");
      }

      if (type === "append") {
        const m = AppendMsg.safeParse(msg);
        if (!m.success) return error("bad append");
        if (committed) return error("session already committed");
        if (failed) return; // the client was told; it falls back
        if (m.data.position !== packets) {
          failed = true;
          wipe();
          return error(`append position ${m.data.position} does not follow the ${packets} packets received`);
        }
        if (packets === 0) send({ status: "info", message: { event: "session_started" } });
        for (const b64 of m.data.audio_packets.packets) {
          const pcm = pcm16ToFloat(Buffer.from(b64, "base64"));
          if (samples + pcm.length > MAX_SAMPLES) {
            failed = true;
            wipe();
            return error(`utterance longer than ${MAX_UTTERANCE_SECS} s`);
          }
          chunks.push(pcm);
          samples += pcm.length;
        }
        packets += m.data.audio_packets.packets.length;
        return send({ status: "info", message: { event: "chunk_received" } });
      }

      if (type === "commit") {
        const m = CommitMsg.safeParse(msg);
        if (!m.success) return error("bad commit");
        if (committed) return error("session already committed");
        if (failed) return error("the audio was not accepted");
        committed = true;
        if (m.data.total_packets !== packets) {
          wipe();
          return error(`commit total_packets ${m.data.total_packets} != received ${packets}`);
        }
        send({ status: "info", message: { event: "commit_received" } });
        const pcm = new Float32Array(samples);
        let at = 0;
        for (const c of chunks) {
          pcm.set(c, at);
          at += c.length;
        }
        wipe();
        deps.stt().transcribe(pcm).then(
          (r) => {
            pcm.fill(0);
            deps.onUtterance?.({ audioMs: r.audioMs, ms: r.ms, chars: r.text.length, via: "ws" });
            send({ status: "text", position: packets, final: true, body: { text: r.text, detected_language: r.language } });
            setTimeout(() => socket.close(1000, "done"), 20).unref?.();
          },
          (err: unknown) => {
            pcm.fill(0);
            log.warn("stt", "on-device transcription failed", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
            error("speech engine failed");
          },
        );
        return;
      }
      // anything else (a future message type) is ignored, like a server that does not know it
    });
  });

  app.post("/local-stt/client_api", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    if (!isAllowedOrigin(req.headers.origin)) return reply.code(403).send({ error: "origin not allowed" });
    if (!deps.allowed()) return reply.code(403).send({ error: "on-device speech is off" });
    if (!deps.auth.verify(bearer(req.headers.authorization), deps.now())) return reply.code(401).send({ error: "invalid token" });
    const body = RestBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "audio (base64 WAV) is required" });
    let pcm: Float32Array;
    try {
      pcm = decodeWav(Buffer.from(body.data.audio, "base64"));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (pcm.length > MAX_SAMPLES) {
      pcm.fill(0);
      return reply.code(413).send({ error: `audio longer than ${MAX_UTTERANCE_SECS} s` });
    }
    try {
      const t0 = performance.now();
      const r = await deps.stt().transcribe(pcm);
      deps.onUtterance?.({ audioMs: r.audioMs, ms: r.ms, chars: r.text.length, via: "rest" });
      return { id: `local-${Date.now().toString(36)}`, text: r.text, detected_language: r.language, total_time: Math.round(performance.now() - t0), generated_tokens: 0 };
    } catch (err) {
      log.warn("stt", "on-device transcription failed", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
      return reply.code(500).send({ error: "speech engine failed" });
    } finally {
      pcm.fill(0);
    }
  });

  return { openSockets: () => open };
}
