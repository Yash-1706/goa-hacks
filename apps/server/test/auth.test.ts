import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@synapse/shared";
import { createApp, type AppCtx } from "../src/app";
import { FakeClock } from "../src/clock";
import { loadConfig } from "../src/config";
import { Auth, SESSION_COOKIE } from "../src/gateway/auth";
import { Db } from "../src/memory/db";
import { wav16k } from "../src/wispr/sarvam";
import { startFakeSarvam, type FakeSarvam } from "./fake-sarvam";
import { modelEmbedder } from "./helpers";

/**
 * Passcode auth (V1 phase 1b). On the LAN nothing changes: loopback is trusted and phones pair. Once a public URL is active (the
 * cloudflared tunnel, or PUBLIC_URL), every request arrives from loopback, so loopback is no longer trusted: every /api route,
 * the WebSocket and the on-device speech endpoints need the passcode session, except /api/health and the login itself.
 */

const PASS = "correct horse battery";
const DAY = 24 * 3600_000;

describe("Auth (unit)", () => {
  let db: Db;
  let clock: FakeClock;
  const auth = (passcode = PASS) => new Auth(db, { passcode, publicUrl: "" }, clock);
  beforeEach(() => {
    db = new Db(":memory:");
    clock = new FakeClock(Date.parse("2026-10-11T10:00:00Z"));
  });

  it("a right passcode yields an HttpOnly, SameSite=Lax session cookie valid for 90 days; a wrong one does not", () => {
    const a = auth();
    expect(a.login("nope", "10.0.0.2", true).ok).toBe(false);
    const r = a.login(PASS, "10.0.0.2", true);
    expect(r.ok).toBe(true);
    expect(r.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Lax/);
    expect(r.setCookie).toMatch(/Secure/);
    expect(r.setCookie).toMatch(/Max-Age=7776000/);
    const cookie = (r.setCookie as string).split(";")[0] as string;
    expect(a.hasSession(cookie)).toBe(true);
    clock.advance(89 * DAY);
    expect(a.hasSession(`other=1; ${cookie}`)).toBe(true);
    clock.advance(2 * DAY);
    expect(a.hasSession(cookie)).toBe(false);
  });

  it("plain-http LAN logins get a cookie without Secure (a browser would drop it otherwise)", () => {
    expect(auth().login(PASS, "192.168.1.5", false).setCookie).not.toMatch(/Secure/);
  });

  it("a forged or tampered cookie is refused, and changing the passcode ends every session", () => {
    const a = auth();
    const cookie = (a.login(PASS, "10.0.0.2", true).setCookie as string).split(";")[0] as string;
    expect(a.hasSession(cookie.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBe(false);
    expect(a.hasSession(`${SESSION_COOKIE}=v1.zzz.abc.def`)).toBe(false);
    expect(a.hasSession(undefined)).toBe(false);
    expect(auth("a new passphrase").hasSession(cookie)).toBe(false);
  });

  it("rate-limits wrong passcodes per address: the sixth try in 15 minutes is refused even when right", () => {
    const a = auth();
    for (let i = 0; i < 5; i++) expect(a.login("wrong", "203.0.113.9", true).ok).toBe(false);
    const locked = a.login(PASS, "203.0.113.9", true);
    expect(locked).toMatchObject({ ok: false, status: 429 });
    expect(locked.retryAfterS).toBeGreaterThan(0);
    expect(a.login(PASS, "198.51.100.1", true).ok).toBe(true); // another address is unaffected
    clock.advance(16 * 60_000);
    expect(a.login(PASS, "203.0.113.9", true).ok).toBe(true);
  });

  it("the capture token is capture-only, survives restarts, and rotating it revokes the old one", () => {
    const a = auth();
    const t = a.captureToken();
    expect(t).toMatch(/^syn_cap_/);
    expect(a.verifyCaptureToken(`Bearer ${t}`)).toBe(true);
    expect(auth().verifyCaptureToken(`Bearer ${t}`)).toBe(true); // same database, same secret
    expect(a.verifyCaptureToken(`Bearer ${t}x`)).toBe(false);
    a.rotateCaptureToken();
    expect(a.verifyCaptureToken(`Bearer ${t}`)).toBe(false);
    expect(a.verifyCaptureToken(`Bearer ${a.captureToken()}`)).toBe(true);
  });

  it("without a passcode configured, nobody can log in", () => {
    const a = auth("");
    expect(a.enabled).toBe(false);
    expect(a.login("", "127.0.0.1", true)).toMatchObject({ ok: false, status: 503 });
  });

  it("the public origin is exactly the active public URL's origin", () => {
    const a = auth();
    expect(a.publicOrigin).toBeNull();
    a.setPublicUrl("https://calm-river-1234.trycloudflare.com/");
    expect(a.publicOrigin).toBe("https://calm-river-1234.trycloudflare.com");
    expect(a.publicMode).toBe(true);
    expect(() => a.setPublicUrl("not a url")).toThrow();
  });
});

// ------------------------------------------------------------------------------------------------ over the wire

const SARVAM_KEY = "sk_test_sarvam_key_not_real";
const PUBLIC = "https://calm-river-1234.trycloudflare.com";
let ctx: AppCtx;
let stop: () => Promise<void>;
let base: string;
let sarvam: FakeSarvam;

beforeAll(async () => {
  sarvam = await startFakeSarvam({ key: SARVAM_KEY });
  const cfg = loadConfig({
    DATA_DIR: path.join(os.tmpdir(), `synapse-auth-${randomBytes(4).toString("hex")}`),
    PORT: "0",
    REQUIRE_PAIRING: "1",
    LLM_MODE: "mock",
    WISPR_MODE: "local",
    SYNAPSE_PASSCODE: PASS,
    SARVAM_API_KEY: SARVAM_KEY,
    SARVAM_BASE_URL: sarvam.url,
    PUBLIC_URL: "",
  });
  const app = await createApp(cfg, { dbFile: ":memory:", embedder: await modelEmbedder(), kek: randomBytes(32), quiet: true, sttBackend: { transcribe: async () => "" } });
  ctx = app.ctx;
  await ctx.fastify.listen({ port: 0, host: "127.0.0.1" });
  const addr = ctx.fastify.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  stop = app.stop;
});
afterAll(async () => {
  await stop?.();
  await sarvam?.close();
});

const call = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, init);
const login = async (origin = PUBLIC): Promise<string> => {
  const r = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-proto": "https" }, body: JSON.stringify({ passcode: PASS }) });
  expect(r.status).toBe(200);
  return (r.headers.get("set-cookie") as string).split(";")[0] as string;
};
const wsHello = (headers: Record<string, string>): Promise<ServerMessage | { closed: number }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers });
    ws.on("unexpected-response", (_req, res) => resolve({ closed: res.statusCode ?? 0 }));
    ws.on("error", () => resolve({ closed: -1 }));
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", deviceId: "phone-test-1", kind: "pocket" })));
    ws.on("message", (raw) => {
      resolve(JSON.parse(raw.toString()) as ServerMessage);
      ws.close();
    });
  });

describe("auth over the wire", () => {
  it("LAN mode (no public URL): loopback is trusted exactly as before", async () => {
    ctx.auth.setPublicUrl(null);
    expect((await call("/api/state")).status).toBe(200);
    expect((await call("/api/state", { headers: { "x-forwarded-for": "192.168.1.20" } })).status).toBe(401); // an unpaired phone
  });

  it("tunnel mode: a request through the tunnel (from loopback) without a cookie gets 401; with the session it is served", async () => {
    ctx.auth.setPublicUrl(PUBLIC);
    try {
      expect((await call("/api/state")).status).toBe(401);
      expect((await call("/api/state", { headers: { "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "203.0.113.7" } })).status).toBe(401);
      expect((await call("/api/health")).status).toBe(200);
      const status = await (await call("/api/auth/status")).json();
      expect(status).toEqual({ authenticated: false, passcodeSet: true, publicMode: true });
      const cookie = await login();
      expect((await call("/api/state", { headers: { cookie, origin: PUBLIC } })).status).toBe(200);
      expect(await (await call("/api/auth/status", { headers: { cookie } })).json()).toMatchObject({ authenticated: true });
      // pairing codes are a LAN mechanism: over the internet six digits are brute-forceable
      expect((await call("/api/state", { headers: { "x-synapse-device": "d1", "x-synapse-token": ctx.trust.tokenFor("d1") } })).status).toBe(401);
      // logout clears it
      const out = await call("/api/auth/logout", { method: "POST", headers: { cookie, origin: PUBLIC } });
      expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    } finally {
      ctx.auth.setPublicUrl(null);
    }
  });

  it("origin guard: the active public origin is allowed, any other public origin refused", async () => {
    ctx.auth.setPublicUrl(PUBLIC);
    try {
      const cookie = await login();
      expect((await call("/api/state", { headers: { cookie, origin: "https://evil.example.com" } })).status).toBe(403);
      expect((await call("/api/state", { headers: { cookie, origin: "https://other-tunnel.trycloudflare.com" } })).status).toBe(403);
      expect((await call("/api/state", { headers: { cookie, origin: PUBLIC } })).status).toBe(200);
    } finally {
      ctx.auth.setPublicUrl(null);
    }
    expect((await call("/api/state", { headers: { origin: PUBLIC } })).status).toBe(403); // no tunnel: that origin is just a website
  });

  it("tunnel mode: the WebSocket and the on-device speech endpoints need the session too", async () => {
    ctx.auth.setPublicUrl(PUBLIC);
    try {
      expect(await wsHello({ origin: PUBLIC })).toEqual({ closed: 401 });
      const cookie = await login();
      expect(await wsHello({ origin: PUBLIC, cookie })).toMatchObject({ type: "welcome" });
      expect((await call("/local-stt/client_api", { method: "POST" })).status).toBe(401);
    } finally {
      ctx.auth.setPublicUrl(null);
    }
  });

  it("the capture token works on POST /api/capture only; issuing it needs a session", async () => {
    ctx.auth.setPublicUrl(PUBLIC);
    try {
      expect((await call("/api/auth/capture-token")).status).toBe(401);
      const cookie = await login();
      const { token } = (await (await call("/api/auth/capture-token", { headers: { cookie } })).json()) as { token: string };
      const auth = { authorization: `Bearer ${token}` };
      const res = await call("/api/capture", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: "Note to self: the parking is on level 3.", context: { source: "ios" } }) });
      expect(res.status).toBe(200);
      expect((await call("/api/state", { headers: auth })).status).toBe(401);
      expect((await call("/api/thoughts", { headers: auth })).status).toBe(401);
    } finally {
      ctx.auth.setPublicUrl(null);
    }
  });

  it("login attempts are rate-limited over HTTP", async () => {
    const bad = (ip: string) => call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ passcode: "guess" }) });
    for (let i = 0; i < 5; i++) expect((await bad("198.51.100.77")).status).toBe(401);
    const sixth = await bad("198.51.100.77");
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("POST /api/capture over HTTP", () => {
  it("JSON text: returns the transcript and the thought ids", async () => {
    const res = await call("/api/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Email Sarah that the launch moves to Friday.", clientId: "http-json-0001", context: { source: "web" } }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { captureId: string; transcript: string; thoughtIds: string[] };
    expect(body.transcript).toBe("Email Sarah that the launch moves to Friday.");
    expect(body.thoughtIds).toHaveLength(1);
    const again = (await (await call("/api/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", clientId: "http-json-0001" }) })).json()) as { captureId: string; duplicate: boolean };
    expect(again).toMatchObject({ captureId: body.captureId, duplicate: true });
  });

  it("multipart audio: the WAV is transcribed by Sarvam and the fields are honoured", async () => {
    sarvam.reset({ kind: "ok", transcript: "Remind me to renew the passport next week.", language_code: "en-IN" });
    const form = new FormData();
    form.append("audio", new Blob([wav16k(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 9) * 0.3))], { type: "audio/wav" }), "clip.wav");
    form.append("clientId", "http-audio-0001");
    form.append("capturedAt", String(Date.now() - 60_000));
    form.append("context", JSON.stringify({ source: "android" }));
    const res = await call("/api/capture", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transcript: "Remind me to renew the passport next week." });
    expect(ctx.capture.list().find((c) => c.clientId === "http-audio-0001")).toMatchObject({ source: "android" });
  });

  it("bad requests are 400 with a reason; GET /api/captures lists the recent ones", async () => {
    expect((await call("/api/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).status).toBe(400);
    expect((await call("/api/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi", context: { source: "toaster" } }) })).status).toBe(400);
    const form = new FormData();
    form.append("audio", new Blob(["not a wav"], { type: "audio/wav" }), "x.wav");
    const bad = await call("/api/capture", { method: "POST", body: form });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/WAV/);
    const list = (await (await call("/api/captures")).json()) as Array<{ captureId: string }>;
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
