import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactView, ThoughtView } from "@synapse/shared";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeGithub, type FakeGithub } from "./fake-github";

/**
 * V1 phase 3 over HTTP: the demo ramble's cards carry their questions and links; answering ships them; the GitHub issue is
 * created in the routed repo (against the recording fake); the email and calendar links decode right; the .ics has an alarm.
 */

const TOKEN = "ghp_routes_test_token_0000000000";
const NOW = "2026-10-06T10:00:00+05:30";
const RAMBLE =
  "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?";

let gh: FakeGithub;
beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN, login: "rio-dev", repos: [{ full_name: "rio-dev/synapse-sandbox", pushed_at: "2026-10-05T00:00:00Z" }] });
});
afterAll(async () => gh?.close());

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const inject = async <T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown): Promise<{ status: number; body: T }> => {
  const r = await app!.ctx.fastify.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : null) as T };
};

async function ramble(): Promise<ArtifactView[]> {
  const res = await inject<{ thoughtIds: string[] }>("POST", "/api/capture", { text: RAMBLE, context: { source: "android" } });
  const views = await Promise.all(res.body.thoughtIds.map((id) => inject<ThoughtView>("GET", `/api/thoughts/${id}`)));
  return views.map((v) => v.body.artifact as ArtifactView);
}

describe("V1 routes", () => {
  it("the demo ramble: an issue for the sandbox repo, an email that asks who 'the team' is, a reminder for tomorrow 18:00", async () => {
    app = await makeApp({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url, GITHUB_SANDBOX_REPO: "rio-dev/synapse-sandbox" }, NOW);
    const [issue, email, reminder] = await ramble();

    expect(issue).toMatchObject({ kind: "github_issue", route: { repo: "rio-dev/synapse-sandbox" }, needs: [], canCreate: true });
    const pushed = await inject<ArtifactView>("POST", `/api/artifacts/${issue!.id}/push`);
    expect(pushed.body).toMatchObject({ status: "executed", externalRef: "rio-dev/synapse-sandbox#1", externalUrl: "https://github.com/rio-dev/synapse-sandbox/issues/1" });
    expect(gh.issues[0]).toMatchObject({ repo: "rio-dev/synapse-sandbox", title: "Null pointer in cart-service" });
    expect(gh.issues[0]!.body).toContain("Captured by voice with Synapse");

    expect(email!.needs?.[0]).toMatchObject({ field: "to:team" });
    expect(email!.links).toEqual({});
    expect((await inject("POST", `/api/artifacts/${email!.id}/push`)).status).toBe(409); // an email is never pushed by Synapse
    const answered = await inject<ArtifactView>("POST", `/api/artifacts/${email!.id}/answer`, { field: "to:team", value: "sarah@acme.io, dev@acme.io" });
    expect(answered.body.needs).toEqual([]);
    const gmail = new URL(answered.body.links!.gmail!);
    expect(gmail.searchParams.get("to")).toBe("sarah@acme.io,dev@acme.io");
    expect(gmail.searchParams.get("su")).toBe("The launch moves to Friday");
    expect(gmail.searchParams.get("body")).toBe("Hi team,\n\nThe launch moves to Friday.\n\nThanks,\nRio");
    const mailto = new URL(answered.body.links!.mailto!);
    expect(decodeURIComponent(mailto.pathname)).toBe("sarah@acme.io,dev@acme.io");
    const shipped = await inject<ArtifactView>("POST", `/api/artifacts/${email!.id}/shipped`, { via: "gmail" });
    expect(shipped.body).toMatchObject({ status: "executed", externalRef: "opened:gmail" });

    expect(reminder).toMatchObject({ kind: "reminder", route: { dueAt: "2026-10-07T18:00:00+05:30" }, needs: [] });
    expect(new URL(reminder!.links!.calendar!).searchParams.get("dates")).toBe("20261007T123000Z/20261007T124500Z");
    const ics = await app.ctx.fastify.inject({ method: "GET", url: reminder!.links!.ics! });
    expect(ics.statusCode).toBe(200);
    expect(ics.body).toMatch(/BEGIN:VEVENT[\s\S]*DTSTART:20261007T123000Z[\s\S]*BEGIN:VALARM[\s\S]*TRIGGER:-PT0M[\s\S]*END:VALARM[\s\S]*END:VEVENT/);
    expect(ics.body).toContain("SUMMARY:Call the landlord");

    // a second, identical ramble asks nothing: "the team" was learned
    const [, email2] = await ramble();
    expect(email2!.needs).toEqual([]);
    expect(email2!.route?.to).toEqual(["sarah@acme.io", "dev@acme.io"]);
  });

  it("a bad answer is a 400 with the reason; an unknown artifact a 404", async () => {
    app = await makeApp({}, NOW);
    const [, email] = await ramble();
    const bad = await inject<{ error: string }>("POST", `/api/artifacts/${email!.id}/answer`, { field: "to:team", value: "not an address" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/email address/);
    expect((await inject("POST", "/api/artifacts/nope/answer", { field: "due", value: "x" })).status).toBe(404);
  });

  it("profile: GET, a validated PUT, merge and parse", async () => {
    app = await makeApp();
    const p = (await inject<{ name: string }>("GET", "/api/profile")).body;
    expect(p.name).toBe("Rio");
    expect((await inject("PUT", "/api/profile", { ...p, repos: [{ fullName: "bad" }] })).status).toBe(400);
    const merged = await inject<{ people: Array<{ name: string; email?: string }> }>("POST", "/api/profile/merge", { people: [{ name: "Sarah", aliases: ["sarah"], email: "sarah@acme.io" }] });
    expect(merged.body.people.find((x) => x.name === "Sarah")).toMatchObject({ email: "sarah@acme.io" });
    expect(merged.body.people.filter((x) => x.name === "Sarah")).toHaveLength(1); // filled in the seeded Sarah, not a second one
    const parsed = await inject<{ people: unknown[] }>("POST", "/api/profile/parse", { text: "Dev Patel <dev@acme.io>" });
    expect(parsed.body.people).toEqual([{ name: "Dev Patel", email: "dev@acme.io" }]);
  });

  it("GitHub: status, a pasted token, import suggestions, forget", async () => {
    app = await makeApp({ GITHUB_API_URL: gh.url });
    expect((await inject("GET", "/api/github/status")).body).toEqual({ source: null, login: null });
    expect((await inject("POST", "/api/github/token", { token: "ghp_definitely_wrong" })).status).toBe(400);
    expect((await inject("POST", "/api/github/token", { token: TOKEN })).body).toEqual({ login: "rio-dev" });
    const s = await inject<{ repos: Array<{ fullName: string }> }>("GET", "/api/github/import");
    expect(s.body.repos.map((r) => r.fullName)).toEqual(["rio-dev/synapse-sandbox"]);
    expect((await inject("DELETE", "/api/github/token")).status).toBe(200);
    expect((await inject("GET", "/api/github/import")).status).toBe(409);
  });
});
