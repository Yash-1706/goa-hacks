import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/memory/db";
import { revokeAllSessions } from "../src/gateway/auth";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeGithub, type FakeGithub } from "./fake-github";

/** V1.1 phase 2: the review's remaining fixes, each proven here first. */

const PASS = "a long enough passphrase";
const PUBLIC = "https://mac.tail0000.ts.net";
const TOKEN = "ghp_v11_review_token_000000000000";
let gh: FakeGithub;
beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN, login: "rio", repos: [{ full_name: "rio/sandbox", pushed_at: "2026-10-05T00:00:00Z" }] });
});
afterAll(async () => gh?.close());
let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});
const inject = (method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app!.ctx.fastify.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const login = async (): Promise<string> => {
  const r = await inject("POST", "/api/auth/login", { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" }, { passcode: PASS });
  expect(r.statusCode).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0] as string;
};

describe("revocable sessions", () => {
  it("'Log out all devices' ends every session (and the capture token); new logins work", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: PASS });
    app.ctx.auth.setPublicUrl(PUBLIC);
    const a = await login();
    const tok = (await inject("GET", "/api/auth/capture-token", { cookie: a })).json().token as string;
    expect((await inject("GET", "/api/state", { cookie: a })).statusCode).toBe(200);
    expect((await inject("POST", "/api/auth/revoke-all", { cookie: a })).statusCode).toBe(200);
    expect((await inject("GET", "/api/state", { cookie: a })).statusCode).toBe(401);
    expect(app.ctx.auth.verifyCaptureToken(`Bearer ${tok}`)).toBe(false);
    const b = await login();
    expect((await inject("GET", "/api/state", { cookie: b })).statusCode).toBe(200);
  });

  it("`pnpm run sessions:revoke` on the database file ends the sessions of a running server", async () => {
    const dbFile = path.join(os.tmpdir(), `synapse-revoke-${randomBytes(4).toString("hex")}.db`);
    app = await makeApp({ SYNAPSE_PASSCODE: PASS }, undefined, dbFile);
    app.ctx.auth.setPublicUrl(PUBLIC);
    const a = await login();
    const other = new Db(dbFile); // what the CLI does, from another process
    revokeAllSessions(other);
    other.close();
    expect((await inject("GET", "/api/state", { cookie: a })).statusCode).toBe(401);
  });
});

describe("idempotent push, answer and shipped", () => {
  it("a double tap on Create issue files ONE issue; a retried push returns the same card", async () => {
    app = await makeApp({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url, GITHUB_SANDBOX_REPO: "rio/sandbox" });
    const res = await app.ctx.capture.capture({ text: "The checkout page crashes with a null pointer on empty carts." });
    const a = app.ctx.store.getThought(res.thoughtIds[0]!)!.artifactId!;
    const before = gh.issues.length;
    const [r1, r2] = await Promise.all([inject("POST", `/api/artifacts/${a}/push`), inject("POST", `/api/artifacts/${a}/push`)]);
    const r3 = await inject("POST", `/api/artifacts/${a}/push`);
    expect(gh.issues.length - before).toBe(1);
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200]);
    expect(r3.json()).toMatchObject({ status: "executed", externalRef: `rio/sandbox#${gh.issues.at(-1)!.number}` });
  });

  it("answer refuses a shipped or dismissed card; shipped never overwrites a created issue", async () => {
    app = await makeApp({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url, GITHUB_SANDBOX_REPO: "rio/sandbox" });
    const res = await app.ctx.capture.capture({ text: "The checkout page crashes with a null pointer on empty carts. Email Priya that the deploy is on hold." });
    const [issue, email] = res.thoughtIds.map((id) => app!.ctx.store.getThought(id)!.artifactId!);
    await inject("POST", `/api/artifacts/${issue}/push`);
    const ref = app.ctx.store.artifacts.get(issue!)!.externalRef;
    expect((await inject("POST", `/api/artifacts/${issue}/shipped`, { "content-type": "application/json" }, { via: "github" })).statusCode).toBe(409);
    expect(app.ctx.store.artifacts.get(issue!)!.externalRef).toBe(ref);
    await inject("POST", `/api/artifacts/${email}/dismiss`);
    expect((await inject("POST", `/api/artifacts/${email}/answer`, { "content-type": "application/json" }, { field: "to:priya", value: "p@acme.io" })).statusCode).toBe(409);
  });
});

describe("'Opened' before Done", () => {
  it("Open draft marks the card Opened (still in Needs you); one tap on Done finishes it; both are idempotent", async () => {
    app = await makeApp();
    const res = await app.ctx.capture.capture({ text: "Remind me to call the landlord tomorrow at 6." });
    const a = app.ctx.store.getThought(res.thoughtIds[0]!)!.artifactId!;
    const j = { "content-type": "application/json" };
    expect((await inject("POST", `/api/artifacts/${a}/shipped`, j, { via: "calendar" })).json()).toMatchObject({ status: "opened", externalRef: "opened:calendar" });
    expect((await inject("POST", `/api/artifacts/${a}/shipped`, j, { via: "calendar" })).statusCode).toBe(200); // a retry
    expect((await inject("POST", `/api/artifacts/${a}/done`)).json()).toMatchObject({ status: "executed", externalRef: "opened:calendar" });
    expect((await inject("POST", `/api/artifacts/${a}/done`)).statusCode).toBe(200);
  });
});

describe("default-deny auth", () => {
  const variants = ["/api/state", "/%61pi/state", "//api/state", "/api//state", "/api./state", "/API/state", "/Api/privacy/export", "/api/state.", "/ws", "//ws", "/WS", "/w%73", "/local-stt/client_api", "/LOCAL-STT/client_api", "/local-stt./client_api", "/%6cocal-stt/client_api", "/app/../api/state"];
  it("every spelling of a protected path is refused through the tunnel without a session; nothing protected is ever served", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: PASS, WISPR_MODE: "local" }, undefined, undefined, undefined, { sttBackend: { transcribe: async () => "" } });
    app.ctx.auth.setPublicUrl(PUBLIC);
    for (const url of variants) {
      for (const method of ["GET", "POST"]) {
        const r = await inject(method, url, { origin: PUBLIC });
        expect([401, 404], `${method} ${url} → ${r.statusCode}`).toContain(r.statusCode);
        expect(r.body, url).not.toMatch(/"thoughts"|"items"|syn_cap_/);
      }
    }
  });
  it("the public allowlist: health, sign-in and the app's static shell", async () => {
    app = await makeApp({ SYNAPSE_PASSCODE: PASS });
    app.ctx.auth.setPublicUrl(PUBLIC);
    expect((await inject("GET", "/api/health")).statusCode).toBe(200);
    expect((await inject("GET", "/api/auth/status")).statusCode).toBe(200);
    expect((await inject("POST", "/api/auth/logout")).statusCode).toBe(200);
    expect((await inject("GET", "/api/auth/capture-token")).statusCode).toBe(401); // not public
  });
});

describe("transactional migrations", () => {
  it("a crash between ALTER TABLE and the version bump leaves a database that still opens", () => {
    const file = path.join(os.tmpdir(), `synapse-mig-${randomBytes(4).toString("hex")}.db`);
    const db = new Db(file);
    // simulate a crash mid-v3 on an older binary: the column exists but the version says 2
    db.exec("PRAGMA user_version = 2");
    db.close();
    expect(() => new Db(file).close()).not.toThrow();
  });
});
