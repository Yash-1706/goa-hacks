import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactOf } from "@synapse/shared";
import { parseReminder } from "../src/cortex/reminder";
import { makeApp, type TestApp } from "./app-helper";

/** Findings of the whole-branch review, each reproduced here first. */

const PASS = "correct horse battery";
const PUBLIC = "https://calm-river-1234.trycloudflare.com";
let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const inject = (method: "GET" | "POST", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app!.ctx.fastify.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("review 1: a percent-encoded path never skips the auth hook", () => {
  it("/%61pi/... is refused in tunnel mode exactly like /api/...", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: PASS, REQUIRE_PAIRING: "1" });
    app.ctx.auth.setPublicUrl(PUBLIC);
    for (const url of ["/%61pi/state", "/%61pi/privacy/export", "/%61pi/profile", "/%61pi/auth/capture-token", "/a%70i/dev/consolidate", "/%2561pi/state"]) {
      const r = await inject(url.includes("consolidate") ? "POST" : "GET", url, { origin: PUBLIC });
      // refused, or (double-encoded: no route matches) at most the public HTML page, never data
      if (r.statusCode === 200) expect(String(r.headers["content-type"]), url).toMatch(/text\/html/);
      else expect([400, 401, 404], url).toContain(r.statusCode);
      expect(r.body, url).not.toMatch(/"thoughts"|"token"|syn_cap_/);
    }
    expect((await inject("GET", "/api/state", { origin: PUBLIC })).statusCode).toBe(401);
  });
});

describe("review 2: the login limit cannot be dodged by a spoofed x-forwarded-for", () => {
  it("behind the tunnel the limit keys on Cloudflare's client address, with a global cap as a backstop", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: PASS });
    app.ctx.auth.setPublicUrl(PUBLIC);
    const bad = (xff: string, cf = "203.0.113.50") => inject("POST", "/api/auth/login", { "x-forwarded-for": xff, "cf-connecting-ip": cf, "content-type": "application/json" }, { passcode: "guess" });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await bad(`198.51.100.${i}`)).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429); // same Cloudflare client, rotating XFF: still limited
    // many different addresses: the global backstop kicks in
    const many: number[] = [];
    for (let i = 0; i < 60; i++) many.push((await bad("x", `192.0.2.${i}`)).statusCode);
    expect(many).toContain(429);
  });

  it("a tunnel does not start with a passcode shorter than 8 characters", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: "short" });
    expect(() => app!.ctx.auth.setPublicUrl(PUBLIC)).toThrow(/8 characters/);
  });
});

describe("review 3: routing answers survive a restart", () => {
  it("an answered recipient is still there after the app reopens its database", async () => {
    const dbFile = path.join(os.tmpdir(), `synapse-route-${randomBytes(4).toString("hex")}.db`);
    const kek = randomBytes(32);
    app = await makeApp({}, undefined, dbFile, kek);
    const res = await app.ctx.capture.capture({ text: "Email Marco about the release notes." });
    const a = app.ctx.store.artifacts.get(app.ctx.store.getThought(res.thoughtIds[0]!)!.artifactId!)!;
    app.ctx.routing.answer(a, "to:marco", "marco@acme.io");
    await app.stop();
    app = await makeApp({}, undefined, dbFile, kek);
    const again = app.ctx.store.artifacts.get(a.id)!;
    expect(again.route).toEqual({ to: { marco: ["marco@acme.io"] } });
  });
});

describe("review 4: a retry while the first upload is still processing gets the real result", () => {
  it("both racing calls return the same thoughts", async () => {
    app = await makeApp();
    const req = { text: "Email Sarah that the launch moves to Friday.", clientId: "clip-race-000001" };
    const [a, b] = await Promise.all([app.ctx.capture.capture(req), app.ctx.capture.capture(req)]);
    expect(a.thoughtIds).toHaveLength(1);
    expect(b.thoughtIds).toEqual(a.thoughtIds);
    expect(b.transcript).toBe(a.transcript);
  });
});

describe("review 5: reminder times", () => {
  const TZ = "Asia/Kolkata";
  const at10 = Date.parse("2026-10-06T10:00:00+05:30");
  it("'tonight' is the evening, not 9 in the morning", () => {
    expect(parseReminder("Remind me tonight to call mom", at10, TZ).due_iso).toBe("2026-10-06T21:00:00+05:30");
    expect(parseReminder("Remind me this evening to water the plants", at10, TZ).due_iso).toBe("2026-10-06T19:00:00+05:30");
    expect(parseReminder("Remind me this afternoon to send the deck", at10, TZ).due_iso).toBe("2026-10-06T15:00:00+05:30");
  });
  it("a stated time already past is not silently in the past: the card asks", () => {
    expect(parseReminder("Remind me today at 8am to stretch", at10, TZ).due_iso).toBeNull();
  });
});

describe("review 6: wiping and exporting cover the profile", () => {
  it("wipe-all forgets learned facts and the saved GitHub token; export includes the profile without the token", async () => {
    app = await makeApp();
    app.ctx.profile.learn([{ kind: "repo_alias", key: "cart service", value: "acme/shop", at: 1 }]);
    app.ctx.db.setSetting("github_token_enc", app.ctx.vault.seal("ltm", "settings|github_token", "ghp_secret").toString("base64"));
    const exported = app.ctx.privacy.exportAll() as { profile?: { learned: unknown[] } };
    expect(exported.profile?.learned).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain("ghp_secret");
    app.ctx.privacy.wipeAll();
    expect(app.ctx.profile.get().learned).toEqual([]);
    expect(app.ctx.github.token()).toBeNull();
  });
});

describe("review 14: a tunnel started by hand is never trusted as loopback", () => {
  it("a request carrying Cloudflare's client header needs a session even without PUBLIC_URL", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: PASS, REQUIRE_PAIRING: "1" });
    expect((await inject("GET", "/api/state")).statusCode).toBe(200); // the Mac itself
    expect((await inject("GET", "/api/state", { "cf-connecting-ip": "203.0.113.9" })).statusCode).toBe(401);
    expect((await inject("GET", "/api/state", { "cf-ray": "8a1b2c3d4e5f-BOM" })).statusCode).toBe(401);
  });
});

void ({} as ArtifactOf<"reminder">);
