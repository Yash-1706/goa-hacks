import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactOf } from "@synapse/shared";
import { parseContacts } from "../src/profile/parse";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeGithub, type FakeGithub } from "./fake-github";

/** The context profile (V1 phase 3a/3b): seeded, encrypted, editable, learned from answers, imported from GitHub and pastes. */

const TOKEN = "ghp_fake_token_for_tests_000000000000";
let gh: FakeGithub;
beforeAll(async () => {
  const day = (n: number) => new Date(Date.parse("2026-10-06T00:00:00Z") - n * 86_400_000).toISOString();
  gh = await startFakeGithub({
    token: TOKEN,
    login: "rio-dev",
    email: "rio@example.com",
    name: "Rio",
    repos: [
      { full_name: "rio-dev/cart-service", description: "Cart and checkout", topics: ["ecommerce", "payments"], pushed_at: day(0), commits: [
        { name: "Rio", email: "rio@example.com", login: "rio-dev" },
        { name: "Sarah Chen", email: "sarah@acme.io", login: "sarahc" },
        { name: "Sarah Chen", email: "sarah@acme.io", login: "sarahc" },
        { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", login: "dependabot[bot]" },
        { name: "Dev Patel", email: "dev@acme.io", login: "devp" },
        { name: "Ghost", email: "12345+ghost@users.noreply.github.com", login: "ghost" },
      ] },
      ...Array.from({ length: 34 }, (_, i) => ({ full_name: `rio-dev/repo-${i}`, pushed_at: day(i + 1), commits: [{ name: "Sarah Chen", email: "sarah@acme.io" }] })),
    ],
  });
});
afterAll(async () => gh?.close());

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe("profile", () => {
  it("seeds from the config: name, timezone, USER_TEAM as people, the sandbox repo as the default", async () => {
    app = await makeApp({ USER_FIRST_NAME: "Rio", USER_TEAM: "Sarah:PM,Dev:SRE", GITHUB_SANDBOX_REPO: "rio-dev/synapse-sandbox", TIMEZONE: "Asia/Kolkata" });
    const p = app.ctx.profile.get();
    expect(p).toMatchObject({ name: "Rio", timezone: "Asia/Kolkata", onboarded: false });
    expect(p.people.map((x) => x.name)).toEqual(["Sarah", "Dev"]);
    expect(p.repos).toEqual([{ fullName: "rio-dev/synapse-sandbox", aliases: ["synapse sandbox"], isDefault: true }]);
  });

  it("is stored encrypted and survives a restart", async () => {
    const dbFile = path.join(os.tmpdir(), `synapse-profile-${randomBytes(4).toString("hex")}.db`);
    const kek = randomBytes(32);
    app = await makeApp({}, undefined, dbFile, kek);
    app.ctx.profile.put({ ...app.ctx.profile.get(), people: [{ name: "Marco Rossi", aliases: ["marco"], email: "marco@secret-client.io" }] });
    const raw = JSON.stringify(app.ctx.db.all("SELECT * FROM settings"));
    expect(raw).not.toContain("secret-client.io");
    expect(raw).not.toContain("Marco");
    await app.stop();
    app = await makeApp({}, undefined, dbFile, kek);
    expect(app.ctx.profile.get().people[0]).toMatchObject({ name: "Marco Rossi", email: "marco@secret-client.io" });
  });

  it("validates a PUT, and the cortex knows the people afterwards", async () => {
    app = await makeApp();
    expect(() => app!.ctx.profile.put({ ...app!.ctx.profile.get(), repos: [{ fullName: "nope", aliases: [], isDefault: true }] } as never)).toThrow();
    app.ctx.profile.put({ ...app.ctx.profile.get(), people: [{ name: "Marco", aliases: [], email: "marco@acme.io" }] });
    const res = await app.ctx.capture.capture({ text: "Email Marco about the release notes." });
    const t = app.ctx.store.getThought(res.thoughtIds[0]!)!;
    const a = app.ctx.store.artifacts.get(t.artifactId!)!;
    expect((a.payload as ArtifactOf<"email_draft">).to).toEqual(["Marco"]);
    expect(app.ctx.store.artifactView(a).route).toEqual({ to: ["marco@acme.io"] });
  });

  it("learn() keeps the newest fact per question", async () => {
    app = await makeApp();
    app.ctx.profile.learn([{ kind: "person_email", key: "priya", value: "p@old.io", at: 1 }]);
    app.ctx.profile.learn([{ kind: "person_email", key: "priya", value: "p@new.io", at: 2 }]);
    expect(app.ctx.profile.get().learned.filter((f) => f.key === "priya")).toEqual([{ kind: "person_email", key: "priya", value: "p@new.io", at: 2 }]);
  });
});

describe("GitHub account", () => {
  it("GITHUB_TOKEN from .env: connected as its login", async () => {
    app = await makeApp({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url });
    expect(await app.ctx.github.status()).toEqual({ source: "env", login: "rio-dev" });
  });

  it("the gh CLI's token is offered, saved encrypted only on 'Use it'", async () => {
    app = await makeApp({ GITHUB_API_URL: gh.url }, undefined, undefined, undefined, { ghToken: async () => TOKEN });
    expect(await app.ctx.github.status()).toEqual({ source: "gh", login: "rio-dev" });
    expect(app.ctx.github.token()).toBeNull(); // offered, not used yet
    expect(await app.ctx.github.useGh()).toBe("rio-dev");
    expect(app.ctx.github.token()).toBe(TOKEN);
    expect(JSON.stringify(app.ctx.db.all("SELECT * FROM settings"))).not.toContain(TOKEN);
    expect((await app.ctx.github.status()).source).toBe("saved");
  });

  it("a pasted token is checked before it is saved", async () => {
    app = await makeApp({ GITHUB_API_URL: gh.url });
    await expect(app.ctx.github.saveToken("ghp_wrong")).rejects.toThrow(/refused/);
    expect(app.ctx.github.token()).toBeNull();
    expect(await app.ctx.github.saveToken(TOKEN)).toBe("rio-dev");
    expect(app.ctx.github.token()).toBe(TOKEN);
    app.ctx.github.forget();
    expect(app.ctx.github.token()).toBeNull();
  });

  it("import suggestions: newest 30 repos, 5 preselected, the newest the default; teammates from commits without me, bots or noreply", async () => {
    app = await makeApp({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url });
    const s = await app.ctx.github.importSuggestions();
    expect(s.login).toBe("rio-dev");
    expect(s.repos).toHaveLength(30);
    expect(s.repos.filter((r) => r.selected)).toHaveLength(5);
    expect(s.repos[0]).toMatchObject({ fullName: "rio-dev/cart-service", isDefault: true, selected: true, aliases: ["cart service", "ecommerce", "payments"], description: "Cart and checkout" });
    expect(s.repos.filter((r) => r.isDefault)).toHaveLength(1);
    expect(s.people.map((p) => [p.name, p.email, p.commits])).toEqual([
      ["Sarah Chen", "sarah@acme.io", 6],
      ["Dev Patel", "dev@acme.io", 1],
    ]);
    expect(s.people[0]).toMatchObject({ githubLogin: "sarahc", selected: true, aliases: ["sarah"] });
    // only the selected repos' commits were read, and nothing was written
    expect(gh.requests.filter((r) => r.path.includes("/commits")).length).toBe(5);
    expect(gh.requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("pasting a team list", () => {
  it("reads vCards", () => {
    const v = "BEGIN:VCARD\nVERSION:3.0\nFN:Sarah Chen\nEMAIL;TYPE=work:sarah@acme.io\nTEL;TYPE=cell:+91 98765 43210\nEND:VCARD\nBEGIN:VCARD\nFN:Dev Patel\nEMAIL:dev@acme.io\nEND:VCARD";
    expect(parseContacts(v)).toEqual([
      { name: "Sarah Chen", email: "sarah@acme.io", phone: "+91 98765 43210" },
      { name: "Dev Patel", email: "dev@acme.io" },
    ]);
  });
  it("reads CSV with a header", () => {
    expect(parseContacts("Name,Email,Phone\nSarah Chen,sarah@acme.io,+1 555 0100\n\"Patel, Dev\",dev@acme.io,")).toEqual([
      { name: "Sarah Chen", email: "sarah@acme.io", phone: "+1 555 0100" },
      { name: "Patel, Dev", email: "dev@acme.io" },
    ]);
  });
  it("reads 'Name <email>' lists and loose lines", () => {
    expect(parseContacts("Sarah Chen <sarah@acme.io>, Dev Patel <dev@acme.io>\nPriya - priya@acme.io - 98765 43210\nmarco@acme.io")).toEqual([
      { name: "Sarah Chen", email: "sarah@acme.io" },
      { name: "Dev Patel", email: "dev@acme.io" },
      { name: "Priya", email: "priya@acme.io", phone: "98765 43210" },
      { name: "Marco", email: "marco@acme.io" },
    ]);
    expect(parseContacts("just some words")).toEqual([]);
  });
});
