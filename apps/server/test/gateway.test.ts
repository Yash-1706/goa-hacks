import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@synapse/shared";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { modelEmbedder } from "./helpers";

/** A real listening server, real WebSockets. The "phone" is simulated with x-forwarded-for from loopback (what the Vite proxy does). */
let stop: () => Promise<void>;
let base: string;
let ctxRef: Awaited<ReturnType<typeof createApp>>["ctx"];

beforeAll(async () => {
  const cfg = loadConfig({
    DATA_DIR: path.join(os.tmpdir(), `synapse-gw-${randomBytes(4).toString("hex")}`),
    PORT: "0",
    THREAD_CLOSE_MS: "150",
    REQUIRE_PAIRING: "1",
    LLM_MODE: "mock",
    WISPR_MODE: "mock",
  });
  const app = await createApp(cfg, { dbFile: ":memory:", embedder: await modelEmbedder(), kek: randomBytes(32), quiet: true });
  ctxRef = app.ctx;
  await app.ctx.fastify.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.ctx.fastify.server.address();
  base = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  stop = app.stop;
});
afterAll(async () => stop?.());

interface Client {
  ws: WebSocket;
  got: ServerMessage[];
  send: (m: unknown) => void;
  waitFor: <T extends ServerMessage["type"]>(type: T, ms?: number) => Promise<Extract<ServerMessage, { type: T }>>;
  close: () => void;
}

function connect(opts: { xff?: string } = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: opts.xff ? { "x-forwarded-for": opts.xff } : {} });
    const got: ServerMessage[] = [];
    const waiters: Array<{ type: string; res: (m: never) => void }> = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      got.push(m);
      for (const w of [...waiters]) if (w.type === m.type) { waiters.splice(waiters.indexOf(w), 1); w.res(m as never); }
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws, got,
        send: (m) => ws.send(JSON.stringify(m)),
        waitFor: (type, ms = 4000) =>
          new Promise((res, rej) => {
            const existing = got.find((g) => g.type === type);
            if (existing) return res(existing as never);
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}; got ${got.map((g) => g.type).join(",")}`)), ms);
            waiters.push({ type, res: ((m: never) => { clearTimeout(t); res(m); }) as never });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

describe("gateway over real sockets", () => {
  it("a local device connects, streams a fragment and receives the provisional then analysed card", async () => {
    const c = await connect();
    c.send({ type: "hello", deviceId: "desk-test-1", kind: "desk" });
    const welcome = await c.waitFor("welcome");
    expect(welcome.config.wisprMode).toBe("mock");
    expect(welcome.state.devices.some((d) => d.deviceId === "desk-test-1")).toBe(true);

    c.send({ type: "session.start", sessionId: "gw-sess" });
    const now = Date.now();
    c.send({ type: "fragment.final", fragmentId: "gw-f1", sessionId: "gw-sess", text: "I need to email the team about the delay", t: { speechStart: now - 1500, speechEnd: now, commitSent: now, wisprFinal: now }, durationMs: 1500, pauseBeforeMs: 0, rmsMean: 0.08, rmsMax: 0.2, whisper: false, transport: "mock" });
    await c.waitFor("fragment.ack");
    await new Promise((r) => setTimeout(r, 700));
    const cards = c.got.filter((m) => m.type === "thought.upsert");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect((cards[0] as Extract<ServerMessage, { type: "thought.upsert" }>).thought.provisional).toBe(true);
    const last = cards.at(-1) as Extract<ServerMessage, { type: "thought.upsert" }>;
    expect(last.thought.category).toBe("communication");
    expect(last.thought.artifact?.kind).toMatch(/email_draft|message_draft/);
    c.close();
  });

  it("rejects malformed and unknown messages without dropping the connection", async () => {
    const c = await connect();
    c.send({ type: "hello", deviceId: "desk-test-2", kind: "desk" });
    await c.waitFor("welcome");
    c.ws.send("not json");
    c.send({ type: "fragment.final", text: "missing fields" });
    c.send({ type: "does.not.exist" });
    c.send({ type: "ping", t0: Date.now() });
    const pong = await c.waitFor("pong");
    expect(typeof pong.tServer).toBe("number");
    c.close();
  });

  it("a phone on the network must pair: no code, wrong code, right code, then token reconnect", async () => {
    const phone = "192.168.1.50";
    const a = await connect({ xff: phone });
    a.send({ type: "hello", deviceId: "phone-1", kind: "pocket" });
    expect((await a.waitFor("auth.required")).reason).toMatch(/pairing/);
    a.send({ type: "hello", deviceId: "phone-1", kind: "pocket", pairingCode: "000000" });
    await new Promise((r) => setTimeout(r, 150));
    expect(a.got.filter((m) => m.type === "welcome")).toHaveLength(0);
    a.send({ type: "hello", deviceId: "phone-1", kind: "pocket", pairingCode: ctxRef.trust.pairingCode });
    const welcome = await a.waitFor("welcome");
    expect(welcome.token).toBeTruthy();
    a.close();

    const b = await connect({ xff: phone });
    b.send({ type: "hello", deviceId: "phone-1", kind: "pocket", token: welcome.token });
    await b.waitFor("welcome");
    b.close();

    // the same token on another device id is refused
    const c = await connect({ xff: phone });
    c.send({ type: "hello", deviceId: "phone-2", kind: "pocket", token: welcome.token });
    await c.waitFor("auth.required");
    c.close();
  });

  it("voice pause over the wire: every device is told, trailing memory is purged, fragments are refused until a tap resumes", async () => {
    const desk = await connect();
    desk.send({ type: "hello", deviceId: "desk-test-3", kind: "desk" });
    await desk.waitFor("welcome");
    desk.send({ type: "session.start", sessionId: "gw-priv" });
    const now = Date.now();
    const frag = (id: string, text: string) => desk.send({ type: "fragment.final", fragmentId: id, sessionId: "gw-priv", text, t: { speechStart: now - 1000, speechEnd: now, commitSent: now, wisprFinal: now }, durationMs: 1000, pauseBeforeMs: 0, rmsMean: 0.03, rmsMax: 0.1, whisper: true, transport: "mock" });
    frag("gw-p1", "the staging database password is hunter two");
    await desk.waitFor("fragment.ack");
    desk.send({ type: "privacy.pause", via: "voice", purgeWindowSecs: 30 });
    const paused = await desk.waitFor("privacy.paused");
    expect(paused.purgedCount).toBeGreaterThanOrEqual(1);
    expect(ctxRef.store.frags.size).toBe(0);
    frag("gw-p2", "something said while paused");
    await new Promise((r) => setTimeout(r, 200));
    expect(desk.got.some((m) => m.type === "fragment.filtered" && m.reason === "paused")).toBe(true);
    expect(ctxRef.store.frags.size).toBe(0);
    desk.send({ type: "privacy.resume" });
    await desk.waitFor("privacy.resumed");
    desk.close();
  });
});

describe("origin guard (a website must not be able to read localhost)", () => {
  it("refuses a public-site origin on REST and on the WebSocket upgrade; allows the local dev origins", async () => {
    const evil = await fetch(`http://${base}/api/state`, { headers: { origin: "https://evil.example.com" } });
    expect(evil.status).toBe(403);
    const rebinding = await fetch(`http://${base}/api/privacy/export`, { headers: { origin: "http://attacker.test:8787" } });
    expect(rebinding.status).toBe(403);
    for (const ok of ["http://localhost:5173", "https://192.168.1.20:5173", "http://100.101.102.103:5173"]) {
      const r = await fetch(`http://${base}/api/state`, { headers: { origin: ok } });
      expect(r.status, ok).toBe(200);
    }
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://${base}/ws`, { headers: { origin: "https://evil.example.com" } });
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(-1));
    });
    expect(closed).toBe(1008);
  });
});

describe("REST surface", () => {
  it("serves health to anyone, guards the rest, and exposes ledger + audit verify to a trusted client", async () => {
    const health = await fetch(`http://${base}/api/health`);
    expect(health.ok).toBe(true);
    const guarded = await fetch(`http://${base}/api/state`, { headers: { "x-forwarded-for": "192.168.1.60" } });
    expect(guarded.status).toBe(401);
    const ok = await fetch(`http://${base}/api/privacy/ledger`);
    expect(ok.ok).toBe(true);
    const ledger = (await ok.json()) as { keys: Array<{ id: string }> };
    expect(ledger.keys.some((k) => k.id === "ltm")).toBe(true);
    const verify = (await (await fetch(`http://${base}/api/privacy/audit/verify`)).json()) as { ok: boolean };
    expect(verify.ok).toBe(true);
  });

  it("dev routes are loopback-only", async () => {
    const remote = await fetch(`http://${base}/api/dev/inject`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.168.1.60" }, body: JSON.stringify({ text: "hi there" }) });
    expect(remote.status).toBe(401);
    const local = await fetch(`http://${base}/api/dev/inject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "I should refactor the payment service", wait: true, sessionId: "rest-inject" }) });
    expect(local.ok).toBe(true);
  });
});
