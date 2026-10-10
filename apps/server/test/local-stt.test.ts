import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LocalStt, LocalSttAuth, cleanTranscript, rmsOf, type SttBackend } from "../src/wispr/local-stt";
import { decodeWav, pcm16ToFloat } from "../src/wispr/local-ws";
import { makeApp, type TestApp } from "./app-helper";

/**
 * On-device speech (CAP-8). The model is replaced by a faithful fake so everything else is real: the engine's queue and guards,
 * the token scheme, and the Wispr-compatible WebSocket and REST endpoints over real sockets. The properties that matter most
 * are the privacy ones: audio is refused unless the on-device engine is in use, it is zeroed after use, and nothing is written.
 */

const MODEL = "Xenova/whisper-tiny.en";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeStt extends SttBackend {
  calls: Array<{ pcm: Float32Array; copy: Float32Array; language?: string }>;
  inFlight: number;
  maxInFlight: number;
}
function fakeStt(reply: string | ((n: number) => string) = "remind me to email the team about the delay", delayMs = 0): FakeStt {
  const f: FakeStt = {
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    async transcribe(pcm, o) {
      f.inFlight++;
      f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
      f.calls.push({ pcm, copy: Float32Array.from(pcm), ...(o.language ? { language: o.language } : {}) });
      const n = f.calls.length;
      if (delayMs) await sleep(delayMs);
      f.inFlight--;
      return typeof reply === "function" ? reply(n) : reply;
    },
  };
  return f;
}

/** a sine "voice" */
const tone = (secs: number, amp = 0.3, hz = 220): Float32Array => Float32Array.from({ length: Math.round(secs * 16000) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / 16000));
/** Wispr-style packets: 512 samples of 16-bit little-endian PCM each, base64 */
function packetsOf(pcm: Float32Array): string[] {
  const out: string[] = [];
  for (let at = 0; at < pcm.length; at += 512) {
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 512; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[at + i] ?? 0)) * 32767), i * 2);
    out.push(buf.toString("base64"));
  }
  return out;
}
function wavOf(samples: Int16Array, rate = 16000, channels = 1): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const toInt16 = (f: Float32Array): Int16Array => Int16Array.from(f, (x) => Math.round(x * 32767));

const engine = (backend: SttBackend, o: Partial<ConstructorParameters<typeof LocalStt>[0]> = {}): LocalStt =>
  new LocalStt({ model: MODEL, dtype: "q8", cacheDir: os.tmpdir(), languages: ["en"], loader: async () => backend, ...o });

describe("the engine", () => {
  it("transcribes one utterance at a time, in order (the model is CPU-bound: two at once only slow both)", async () => {
    const b = fakeStt((n) => `utterance ${n}`, 25);
    const s = engine(b);
    const out = await Promise.all([s.transcribe(tone(1)), s.transcribe(tone(1)), s.transcribe(tone(1))]);
    expect(out.map((r) => r.text)).toEqual(["utterance 1", "utterance 2", "utterance 3"]);
    expect(b.maxInFlight).toBe(1);
    expect(s.stats()).toMatchObject({ model: MODEL, state: "ready", calls: 3 });
    expect(s.stats().lastMs).toBeGreaterThanOrEqual(0);
  });

  it("does not wake the model for a click or for silence (and Whisper would invent words for silence)", async () => {
    const b = fakeStt();
    const s = engine(b);
    expect((await s.transcribe(tone(0.1))).text).toBe("");
    expect((await s.transcribe(new Float32Array(16000))).text).toBe("");
    expect((await s.transcribe(tone(1, 0.0005))).text).toBe(""); // below the noise floor of any microphone
    expect(b.calls).toHaveLength(0);
    expect(s.state).toBe("idle");
  });

  it("drops the 'Thank you.' Whisper hears in a short, nearly silent clip, and keeps it everywhere else", async () => {
    const s = engine(fakeStt("Thank you."));
    expect((await s.transcribe(tone(1, 0.003))).text).toBe(""); // short and quiet: the model talking, not the user
    expect((await s.transcribe(tone(1, 0.3))).text).toBe("Thank you."); // said at a normal level
    expect((await s.transcribe(tone(3, 0.003))).text).toBe("Thank you."); // long enough to be real
  });

  it("cleans the non-speech tags Whisper writes", () => {
    expect(cleanTranscript("[BLANK_AUDIO] Hello   (silence) world [MUSIC]")).toBe("Hello world");
    expect(cleanTranscript("  ")).toBe("");
  });

  it("a model that cannot load is reported, never thrown from warm(), and the next call tries again", async () => {
    let loads = 0;
    const s = new LocalStt({
      model: MODEL,
      dtype: "q8",
      cacheDir: os.tmpdir(),
      languages: ["en"],
      loader: async () => {
        if (loads++ === 0) throw new Error("no network for the download");
        return fakeStt("recovered");
      },
    });
    await s.warm();
    expect(s.state).toBe("error");
    expect(s.stats().error).toMatch(/no network/);
    expect((await s.transcribe(tone(1))).text).toBe("recovered");
    expect(loads).toBe(2);
    expect(s.state).toBe("ready");
    expect(s.stats().error).toBeUndefined();
  });

  it("a hung model fails the call instead of holding the microphone's answer forever", async () => {
    const s = engine({ transcribe: () => new Promise<string>(() => undefined) }, { timeoutMs: 40 });
    await expect(s.transcribe(tone(1))).rejects.toThrow(/timed out/);
  });

  it("tells a multilingual model the language when exactly one is configured, and never an English-only model", async () => {
    const hindi = fakeStt();
    await engine(hindi, { model: "Xenova/whisper-tiny", languages: ["hi"] }).transcribe(tone(1));
    expect(hindi.calls[0]?.language).toBe("hindi");
    const auto = fakeStt();
    await engine(auto, { model: "Xenova/whisper-tiny", languages: ["en", "hi"] }).transcribe(tone(1));
    expect(auto.calls[0]?.language).toBeUndefined();
    const english = fakeStt();
    const s = engine(english, { languages: ["en"] });
    await s.transcribe(tone(1));
    expect(english.calls[0]?.language).toBeUndefined();
    expect(s.reportedLanguage).toBe("en");
  });

  it("measures level the way the guards need", () => {
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(rmsOf(tone(1, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});

describe("tokens", () => {
  it("round-trip, expire, and cannot be forged or moved to another process", () => {
    const a = new LocalSttAuth();
    const { token, expiresAt } = a.mint("desk-1", 60_000, 1_000);
    expect(expiresAt).toBe(61_000);
    expect(a.verify(token, 2_000)).toEqual({ deviceId: "desk-1" });
    expect(a.verify(`Bearer ${token}`, 2_000)).toEqual({ deviceId: "desk-1" });
    expect(a.verify(token, 61_000)).toBeNull(); // expired
    const [p, payload, sig] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ d: "other", e: 99_999_999 })).toString("base64url");
    expect(a.verify(`${p}.${forged}.${sig}`, 2_000)).toBeNull();
    expect(a.verify(`${p}.${payload}.${sig.slice(0, -2)}AA`, 2_000)).toBeNull();
    expect(new LocalSttAuth().verify(token, 2_000)).toBeNull(); // another process's secret
    for (const junk of [undefined, "", "lt1", "lt1.a.b.c", "xx.a.b"]) expect(a.verify(junk, 2_000)).toBeNull();
  });
});

describe("audio decoding", () => {
  it("reads the 16-bit PCM packets Wispr's protocol carries, and tolerates a RIFF header on a packet", () => {
    const f = Float32Array.from([0, 0.5, -0.5, 1]);
    const raw = Buffer.from(toInt16(f).buffer);
    const back = pcm16ToFloat(raw);
    expect(back.length).toBe(4);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    const withHeader = Buffer.concat([wavOf(toInt16(tone(0.01))).subarray(0, 44), raw]);
    expect([...pcm16ToFloat(withHeader)]).toEqual([...back]);
  });

  it("decodes a WAV to 16 kHz mono: as is, resampled, or mixed down; refuses what it cannot read", () => {
    const t = tone(0.5, 0.4);
    const same = decodeWav(wavOf(toInt16(t)));
    expect(same.length).toBe(t.length);
    expect(same[100]).toBeCloseTo(t[100] as number, 3);

    const stereo44 = Int16Array.from({ length: 44_100 * 2 }, (_, i) => (i % 2 === 0 ? 8000 : 0)); // one second, left only
    const down = decodeWav(wavOf(stereo44, 44_100, 2));
    expect(down.length).toBe(16_000);
    expect(down[1000]).toBeCloseTo(4000 / 32768, 2); // (left + right) / 2

    expect(() => decodeWav(Buffer.from("definitely not audio, just some text bytes of a decent length ok"))).toThrow(/not a WAV/);
    const mp3ish = wavOf(new Int16Array(100));
    mp3ish.writeUInt16LE(85, 20); // an MP3 format tag
    expect(() => decodeWav(mp3ish)).toThrow(/unsupported/);
  });
});

/* ------------------------------------------------------------------ the endpoints */

let app: TestApp | undefined;
let port = 0;
let backend: FakeStt;
const extraServers: http.Server[] = [];
afterEach(async () => {
  await app?.stop();
  app = undefined;
  for (const s of extraServers.splice(0)) await new Promise((r) => s.close(r));
});

async function boot(env: Record<string, string> = {}, reply: string | ((n: number) => string) = "remind me to email the team about the delay"): Promise<TestApp> {
  backend = fakeStt(reply);
  app = await makeApp({ WISPR_MODE: "local", ...env }, "2026-10-06T10:00:00+05:30", ":memory:", undefined, { sttBackend: backend });
  await app.ctx.fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (app.ctx.fastify.server.address() as AddressInfo).port;
  return app;
}

interface Local {
  ws: WebSocket;
  got: Array<Record<string, unknown>>;
  closed: Promise<number>;
  send(m: unknown): void;
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
}
function openLocal(token: string, headers: Record<string, string> = { origin: "http://localhost:5173" }): Promise<Local> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/local-stt/client_ws?client_key=${encodeURIComponent(`Bearer ${token}`)}`, { headers });
    const got: Local["got"] = [];
    const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; res: (m: Record<string, unknown>) => void }> = [];
    const closed = new Promise<number>((res) => ws.on("close", (code) => res(code)));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      got.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        got,
        closed,
        send: (m) => ws.send(JSON.stringify(m)),
        waitFor: (pred, ms = 3000) =>
          new Promise((res, rej) => {
            const hit = got.find(pred);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(got)}`)), ms);
            waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
          }),
      }),
    );
  });
}
const append = (c: Local, packets: string[], position: number): void =>
  c.send({ type: "append", position, audio_packets: { packets, volumes: packets.map(() => 0.1), packet_duration: 0.032, audio_encoding: "wav", byte_encoding: "base64" } });
const tokenOf = async (a: TestApp, device = "dev-1"): Promise<string> => {
  const t = await a.ctx.wispr.token(device);
  expect(t.token).toBeTruthy();
  return t.token as string;
};

describe("WISPR_MODE=local: the token and the WebSocket", () => {
  it("hands the browser relative on-device URLs and a token, and the config says 'local'", async () => {
    const a = await boot();
    const t = await a.ctx.wispr.token("dev-1");
    expect(t).toMatchObject({ type: "wispr.token", mode: "local", wsUrl: "/local-stt/client_ws", restUrl: "/local-stt/client_api" });
    expect(t.expiresAt).toBeGreaterThan(a.clock.now());
    expect(a.ctx.clientConfig().wisprMode).toBe("local");
    expect(a.ctx.cfg.wispr.mode).toBe("local"); // no key was needed
  });

  it("an utterance in Wispr's own protocol comes back as text, the model gets exactly that audio, and the buffers are zeroed", async () => {
    const a = await boot();
    const tok = await tokenOf(a);
    const c = await openLocal(tok);
    c.send({ type: "auth", access_token: tok, language: ["en"], context: { app: { name: "Synapse", type: "ai" } } });
    await c.waitFor((m) => m.status === "auth");

    const voice = tone(1.2, 0.3);
    const packets = packetsOf(voice);
    let pos = 0;
    for (let i = 0; i < packets.length; i += 4) {
      const part = packets.slice(i, i + 4);
      append(c, part, pos);
      pos += part.length;
    }
    c.send({ type: "commit", total_packets: packets.length });
    const fin = await c.waitFor((m) => m.status === "text" && m.final === true);
    expect(fin).toMatchObject({ status: "text", final: true, body: { text: "remind me to email the team about the delay", detected_language: "en" } });

    const events = c.got.filter((m) => m.status === "info").map((m) => (m.message as { event: string }).event);
    expect(events[0]).toBe("session_started");
    expect(events).toContain("chunk_received");
    expect(events.at(-1)).toBe("commit_received");
    await expect(c.closed).resolves.toBe(1000); // one utterance per socket, like Wispr's

    expect(backend.calls).toHaveLength(1);
    const heard = backend.calls[0]!;
    expect(heard.copy.length).toBe(packets.length * 512); // every packet, in order
    expect(heard.copy[300]).toBeCloseTo(voice[300] as number, 3);
    expect(heard.copy.at(-1)).toBe(0); // the last packet is padded with silence
    // the privacy property: the audio the engine held is gone
    await sleep(60);
    expect(heard.pcm.every((x) => x === 0)).toBe(true);
  });

  it("refuses a bad token, a stranger's origin, a skipped auth, a position that does not follow and a wrong packet count", async () => {
    const a = await boot();
    const tok = await tokenOf(a);

    const bad = await openLocal(tok);
    bad.send({ type: "auth", access_token: "lt1.forged.token" });
    await bad.waitFor((m) => m.status === "error");
    await expect(bad.closed).resolves.toBe(1008);

    const stranger = await openLocal(tok, { origin: "https://evil.example" });
    await expect(stranger.closed).resolves.toBe(1008);

    const noAuth = await openLocal(tok);
    append(noAuth, [packetsOf(tone(0.032))[0] as string], 0);
    await noAuth.waitFor((m) => m.status === "error");
    await expect(noAuth.closed).resolves.toBe(1008);

    const gap = await openLocal(tok);
    gap.send({ type: "auth", access_token: tok });
    await gap.waitFor((m) => m.status === "auth");
    append(gap, packetsOf(tone(0.1)).slice(0, 2), 5); // starts at 5, nothing was received yet
    const err = await gap.waitFor((m) => m.status === "error");
    expect(String(err.message)).toMatch(/position/);
    gap.send({ type: "commit", total_packets: 2 });
    await gap.waitFor((m) => m.status === "error" && /not accepted/.test(String(m.message)));

    const miscount = await openLocal(tok);
    miscount.send({ type: "auth", access_token: tok });
    await miscount.waitFor((m) => m.status === "auth");
    append(miscount, packetsOf(tone(0.1)).slice(0, 3), 0);
    miscount.send({ type: "commit", total_packets: 7 });
    await miscount.waitFor((m) => m.status === "error" && /total_packets/.test(String(m.message)));
    expect(backend.calls).toHaveLength(0); // none of that reached the model
  });

  it("an utterance longer than two minutes is refused, not transcribed, and not kept", async () => {
    const a = await boot();
    const tok = await tokenOf(a);
    const c = await openLocal(tok);
    c.send({ type: "auth", access_token: tok });
    await c.waitFor((m) => m.status === "auth");
    const silence = Array.from({ length: 256 }, () => Buffer.alloc(1024).toString("base64")); // 8.2 s per append
    for (let i = 0; i < 16; i++) append(c, silence, i * 256);
    await c.waitFor((m) => m.status === "error" && /longer than/.test(String(m.message)), 4000);
    c.send({ type: "commit", total_packets: 16 * 256 });
    await c.waitFor((m) => m.status === "error" && /not accepted/.test(String(m.message)));
    expect(backend.calls).toHaveLength(0);
  });

  it("an empty transcript (nothing intelligible) is a final with no text, which the browser drops", async () => {
    const a = await boot({}, "");
    const tok = await tokenOf(a);
    const c = await openLocal(tok);
    c.send({ type: "auth", access_token: tok });
    await c.waitFor((m) => m.status === "auth");
    const packets = packetsOf(tone(1));
    append(c, packets, 0);
    c.send({ type: "commit", total_packets: packets.length });
    const fin = await c.waitFor((m) => m.status === "text" && m.final === true);
    expect((fin.body as { text: string }).text).toBe("");
  });

  it("a failing model is an error message, and the audio is still zeroed", async () => {
    const a = await boot();
    backend.transcribe = async (pcm) => {
      backend.calls.push({ pcm, copy: Float32Array.from(pcm) });
      throw new Error("onnx exploded");
    };
    const tok = await tokenOf(a);
    const c = await openLocal(tok);
    c.send({ type: "auth", access_token: tok });
    await c.waitFor((m) => m.status === "auth");
    const packets = packetsOf(tone(1));
    append(c, packets, 0);
    c.send({ type: "commit", total_packets: packets.length });
    await c.waitFor((m) => m.status === "error" && /on-device speech failed/.test(String(m.message)));
    await sleep(40);
    expect(backend.calls[0]!.pcm.every((x) => x === 0)).toBe(true);
  });

  it("a socket that closes mid-utterance leaves nothing behind (the pause kill switch closes sockets without a commit)", async () => {
    const a = await boot();
    const tok = await tokenOf(a);
    const c = await openLocal(tok);
    c.send({ type: "auth", access_token: tok });
    await c.waitFor((m) => m.status === "auth");
    append(c, packetsOf(tone(0.5)), 0);
    await c.waitFor((m) => m.status === "info" && (m.message as { event: string }).event === "chunk_received");
    c.ws.close();
    await c.closed;
    await sleep(30);
    expect(backend.calls).toHaveLength(0);
  });

  it("writes nothing to disk, however many utterances it hears", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-stt-"));
    try {
      const a = await boot({ DATA_DIR: dir });
      const listing = (): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();
      const before = listing();
      const tok = await tokenOf(a);
      for (let i = 0; i < 3; i++) {
        const c = await openLocal(tok);
        c.send({ type: "auth", access_token: tok });
        await c.waitFor((m) => m.status === "auth");
        const packets = packetsOf(tone(1));
        append(c, packets, 0);
        c.send({ type: "commit", total_packets: packets.length });
        await c.waitFor((m) => m.status === "text");
        await c.closed;
      }
      expect(listing()).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WISPR_MODE=local: the REST fallback", () => {
  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/local-stt/client_api`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173", ...headers }, body: JSON.stringify(body) });

  it("transcribes a WAV like Wispr's client_api does, and zeroes it afterwards", async () => {
    const a = await boot();
    const tok = await tokenOf(a);
    const wav = wavOf(toInt16(tone(1.5, 0.3)));
    const res = await post({ audio: wav.toString("base64"), language: ["en"], context: {} }, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { text: string; detected_language: string; id: string; total_time: number };
    expect(j).toMatchObject({ text: "remind me to email the team about the delay", detected_language: "en" });
    expect(j.id).toBeTruthy();
    expect(backend.calls[0]!.copy.length).toBe(24_000);
    expect(backend.calls[0]!.pcm.every((x) => x === 0)).toBe(true);
  });

  it("refuses without a valid token, from a stranger's origin, and for what is not a WAV", async () => {
    const a = await boot();
    const tok = await tokenOf(a);
    const audio = wavOf(toInt16(tone(1))).toString("base64");
    expect((await post({ audio })).status).toBe(401);
    expect((await post({ audio }, { authorization: "Bearer lt1.a.b" })).status).toBe(401);
    expect((await post({ audio }, { authorization: `Bearer ${tok}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ nothing: true }, { authorization: `Bearer ${tok}` })).status).toBe(400);
    const garbage = await post({ audio: Buffer.from("not audio at all, only some bytes to fill the body").toString("base64") }, { authorization: `Bearer ${tok}` });
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: string }).error).toMatch(/not a WAV/);
    expect(backend.calls).toHaveLength(0);
    void a;
  });
});

describe("when the on-device engine is NOT in use, no audio is accepted at all", () => {
  it("plain client mode: the endpoints refuse, and the token goes to Wispr (a dead one here), not to this machine", async () => {
    const a = await boot({ WISPR_MODE: "client", WISPR_API_KEY: "fl-test", WISPR_BASE: "http://127.0.0.1:1/api/v1/dash" });
    expect(a.ctx.wispr.usesLocal()).toBe(false);
    expect(a.ctx.wispr.localAllowed()).toBe(false);
    expect(a.ctx.clientConfig().wisprMode).toBe("client");
    const t = await a.ctx.wispr.token("dev-1");
    expect(t.mode).toBe("client");
    expect(t.error).toMatch(/Wispr token request failed/); // no silent fallback: the audio path stays what the user configured
    expect(t.token).toBeUndefined();

    const minted = new LocalSttAuth(); // even a perfectly good token is refused while the engine is off
    void minted;
    const c = await openLocal("lt1.whatever.token");
    await expect(c.closed).resolves.toBe(1008);
    const res = await fetch(`http://127.0.0.1:${port}/local-stt/client_api`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173", authorization: "Bearer lt1.a.b" }, body: JSON.stringify({ audio: "AAAA" }) });
    expect(res.status).toBe(403);
    expect(backend.calls).toHaveLength(0);
  });

  it("the mock setup has no on-device engine and no route for it", async () => {
    const a = await boot({ WISPR_MODE: "mock" });
    expect(a.ctx.localStt).toBeNull();
    expect(a.ctx.fastify.printRoutes({ commonPrefix: false })).not.toMatch(/local-stt/);
  });
});

describe("STT_FALLBACK (opt-in): Wispr cannot be used", () => {
  it("the same token request is answered by the on-device engine, with the reason", async () => {
    const a = await boot({ WISPR_MODE: "client", WISPR_API_KEY: "fl-test", WISPR_BASE: "http://127.0.0.1:1/api/v1/dash", STT_FALLBACK: "1" });
    expect(a.ctx.wispr.localAllowed()).toBe(true);
    const t = await a.ctx.wispr.token("dev-1");
    expect(t).toMatchObject({ mode: "local", wsUrl: "/local-stt/client_ws" });
    expect(t.note).toMatch(/Wispr unavailable.*on-device speech is active/);
    const c = await openLocal(t.token as string);
    c.send({ type: "auth", access_token: t.token });
    await c.waitFor((m) => m.status === "auth"); // and the endpoint now takes the audio
    c.ws.close();
  });
});

describe("local-only mode with a Wispr setup", () => {
  /** a stand-in for Wispr that counts every request it gets */
  async function countingWispr(): Promise<{ base: string; requests: () => number }> {
    let n = 0;
    const srv = http.createServer((req, res) => {
      n++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.includes("generate_access_token") ? JSON.stringify({ access_token: "jwt-abc", expires_in: 900 }) : JSON.stringify({ status: "warmed" }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    extraServers.push(srv);
    return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1/dash`, requests: () => n };
  }

  it("switches the speech engine to this machine: no token, not even a warm-up, reaches Wispr, and every device is told", async () => {
    const w = await countingWispr();
    const a = await boot({ WISPR_MODE: "client", WISPR_API_KEY: "fl-test", WISPR_BASE: w.base });
    expect(a.ctx.wispr.mode).toBe("client");
    expect((await a.ctx.wispr.token("dev-1")).mode).toBe("client");
    expect(w.requests()).toBe(1);

    const res = await a.ctx.fastify.inject({ method: "POST", url: "/api/privacy/local-only", payload: { on: true } });
    expect(res.statusCode).toBe(200);
    expect(a.ctx.wispr.mode).toBe("local");
    expect(a.ctx.clientConfig()).toMatchObject({ wisprMode: "local", localOnly: true });
    const update = a.sent.find((m) => m.type === "config.update") as { type: "config.update"; config: { wisprMode: string; localOnly: boolean } } | undefined;
    expect(update?.config).toMatchObject({ wisprMode: "local", localOnly: true });

    const t = await a.ctx.wispr.token("dev-1", true);
    expect(t.mode).toBe("local");
    await a.ctx.wispr.warmup();
    expect(w.requests()).toBe(1); // nothing more left the machine

    const c = await openLocal(t.token as string);
    c.send({ type: "auth", access_token: t.token });
    await c.waitFor((m) => m.status === "auth");
    c.ws.close();

    await a.ctx.fastify.inject({ method: "POST", url: "/api/privacy/local-only", payload: { on: false } });
    expect(a.ctx.clientConfig().wisprMode).toBe("client");
    expect((await a.ctx.wispr.token("dev-1", true)).mode).toBe("client");
    expect(w.requests()).toBe(2);
    expect(a.sent.filter((m) => m.type === "config.update")).toHaveLength(2);
    const closed = await openLocal("lt1.x.y"); // and the endpoints close again
    await expect(closed.closed).resolves.toBe(1008);
  });

  it("is also announced when the settings route changes it", async () => {
    const a = await boot({ WISPR_MODE: "client", WISPR_API_KEY: "fl-test", WISPR_BASE: "http://127.0.0.1:1/api/v1/dash" });
    await a.ctx.fastify.inject({ method: "POST", url: "/api/settings", payload: { localOnly: true } });
    expect((a.sent.find((m) => m.type === "config.update") as { config: { wisprMode: string } } | undefined)?.config.wisprMode).toBe("local");
  });
});

describe("what the operator sees", () => {
  it("/api/health reports the engine, its model and whether it is in use; settings report the effective mode", async () => {
    const a = await boot();
    const h = (await (await a.ctx.fastify.inject({ method: "GET", url: "/api/health" })).json()) as { modes: { wispr: string }; stt: { model: string; state: string; active: boolean; fallback: boolean } | null };
    expect(h.modes.wispr).toBe("local");
    expect(h.stt).toMatchObject({ model: MODEL, active: true, fallback: false });
    const tok = await tokenOf(a);
    void tok;
    const s = (await (await a.ctx.fastify.inject({ method: "GET", url: "/api/settings" })).json()) as { wisprMode: string };
    expect(s.wisprMode).toBe("local");
  });

  it("preloads the model at start when the mode is local (and says so in the config), but not otherwise", async () => {
    const dflt = (env: Record<string, string>) => (async () => { const { loadConfig } = await import("../src/config"); return loadConfig(env).stt.preload; })();
    expect(await dflt({ WISPR_MODE: "local" })).toBe(true);
    expect(await dflt({ WISPR_MODE: "client", WISPR_API_KEY: "k" })).toBe(false);
    expect(await dflt({ WISPR_MODE: "client", WISPR_API_KEY: "k", STT_PRELOAD: "1" })).toBe(true);
    expect(await dflt({ WISPR_MODE: "local", STT_PRELOAD: "0" })).toBe(false);
    expect(await dflt({ WISPR_MODE: "mock" })).toBe(false);
  });
});

describe("the browser's own streamer against the real endpoints", () => {
  /** wispr:check runs the real WisprStreamer (the code that runs in the browser) against whatever the server hands out */
  it("gets a transcript over the WebSocket, and over REST, and reports the on-device engine as such", async () => {
    const a = await boot();
    const base = `http://127.0.0.1:${port}`;
    // an absolute URL held in a variable: the server's type check must not pull the browser's code in
    const libUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../web/scripts/wispr-check-lib.ts")).href;
    const lib = (await import(/* @vite-ignore */ libUrl)) as {
      runWisprCheck(o: Record<string, unknown>): Promise<{ ok: boolean; items: Array<{ id: string; verdict: string; title: string; detail: string }>; transcript?: { text: string; transport: string } }>;
    };
    const voice = Int16Array.from(tone(2, 0.3), (x) => Math.round(x * 32767));
    const common = {
      getToken: async () => {
        const t = await a.ctx.wispr.token("check-dev", true);
        return { mode: t.mode, token: t.token, expiresAt: t.expiresAt, wsUrl: t.wsUrl, restUrl: t.restUrl };
      },
      pcm: voice,
      pace: 0,
      origin: base,
      createSocket: (url: string) => new WebSocket(url, { headers: { origin: "http://localhost:5173" } }),
    };

    const viaWs = await lib.runWisprCheck(common);
    expect(viaWs.ok, JSON.stringify(viaWs.items, null, 1)).toBe(true);
    expect(viaWs.transcript).toMatchObject({ text: "remind me to email the team about the delay", transport: "local_stt" });
    const byId = Object.fromEntries(viaWs.items.map((i) => [i.id, i]));
    expect(byId.token).toMatchObject({ verdict: "pass", title: expect.stringContaining("on-device") });
    expect(byId["A1+A5"]?.verdict).toBe("pass"); // the explicit {"status":"auth"} acknowledgement, not an assumed one
    expect(byId.A3).toMatchObject({ verdict: "pass", title: expect.stringContaining("the on-device engine") });
    expect(byId.A3?.detail).toMatch(/over the WebSocket/);
    expect(byId.A6?.verdict).toBe("pass"); // exactly one final per commit
    expect(byId.A7?.verdict).toBe("info"); // same origin: no CORS question

    const viaRest = await lib.runWisprCheck({ ...common, forceRest: true, createSocket: undefined });
    expect(viaRest.ok, JSON.stringify(viaRest.items, null, 1)).toBe(true);
    expect(viaRest.transcript).toMatchObject({ text: "remind me to email the team about the delay", transport: "local_stt" });
    expect(viaRest.items.find((i) => i.id === "REST")).toMatchObject({ verdict: "pass" });
    expect(backend.calls).toHaveLength(2);
    for (const c of backend.calls) expect(c.pcm.every((x) => x === 0)).toBe(true); // both utterances were zeroed afterwards
  });
});
