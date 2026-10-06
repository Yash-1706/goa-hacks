import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApp, type TestApp } from "./app-helper";

/**
 * The Outbox's REAL adapters (GitHub issues, Jira Cloud), exercised against a stubbed `fetch`: no token is
 * needed and nothing leaves the machine, but the request shape, the result mapping, the failure behaviour and the
 * secret handling are all checked. (Whether GitHub/Jira accept the request is the part only a live token can prove.)
 */

const GH_TOKEN = "github_pat_TESTTOKEN_do_not_leak_0123456789";
const JIRA_TOKEN = "jira-api-token-do-not-leak-9876543210";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
  vi.unstubAllGlobals();
});

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

/** replaces global fetch; call this AFTER the app is built (model loading may use fetch) */
function stubFetch(responder: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      const call = { url: String(url), init: init as Call["init"] };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stage(kind: "github_issue" | "ticket") {
  const a0 = app!;
  const t = a0.ctx.store.createThought({ sessionId: "s", deviceId: "d", deviceKind: "desk", activity: "desk", category: "bug", title: "NPE in cart-service", intent: "fix it", emb: new Float32Array(384), source: "mock" });
  t.confidence = 0.9;
  t.tentative = false;
  const art =
    kind === "github_issue"
      ? { kind, title: "NPE in cart-service discount-code path", body_markdown: "Crashes with an empty discount code.\n\nHypothesis: the code is dereferenced before validation.", labels: ["bug", "cart-service"], hypotheses: ["null dereference"] }
      : { kind, title: "NPE in cart-service discount-code path", description: "Crashes with an empty discount code.\n\nSeen yesterday.", issue_type: "bug" as const, priority: "high" as const, labels: ["cart service", "bug"], component: "cart-service", acceptance_criteria: ["No crash on an empty code", "Regression test added"] };
  const a = a0.ctx.store.createArtifact(t, art, 2);
  a.status = "staged";
  return { t, a };
}

describe("GitHub adapter (stubbed fetch)", () => {
  it("creates the issue in the configured repo with the documented request shape and maps the response", async () => {
    app = await makeApp({ GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/synapse-sandbox" });
    const { a, t } = stage("github_issue");
    expect(app.ctx.outbox.githubReady()).toBe(true);
    const calls = stubFetch(() => json(201, { number: 42, html_url: "https://github.com/acme/synapse-sandbox/issues/42" }));

    const res = await app.ctx.outbox.push(a);

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.github.com/repos/acme/synapse-sandbox/issues");
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
    expect(c.init.headers.Accept).toBe("application/vnd.github+json");
    expect(c.init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(c.init.headers["User-Agent"]).toBeTruthy(); // GitHub rejects API calls without one
    expect(c.init.headers["Content-Type"]).toBe("application/json");
    expect(c.init.signal).toBeInstanceOf(AbortSignal); // bounded: a hung GitHub cannot hang the tap
    const sent = JSON.parse(c.init.body as string) as { title: string; body: string; labels: string[] };
    expect(sent.title).toBe("NPE in cart-service discount-code path");
    expect(sent.body).toContain("Crashes with an empty discount code.");
    expect(sent.body).toContain("Drafted by Synapse from a voice thought");
    expect(sent.body).toContain(t.code); // traceable back to the thought
    expect(sent.labels).toEqual(["bug", "cart-service"]);

    expect(res).toMatchObject({ simulated: false, system: "github", externalRef: "acme/synapse-sandbox#42", url: "https://github.com/acme/synapse-sandbox/issues/42" });
    expect(a).toMatchObject({ status: "executed", simulated: false, externalRef: "acme/synapse-sandbox#42" });
    const notice = app.sent.find((m) => m.type === "notice" && m.level === "success");
    expect(notice && "text" in notice ? notice.text : "").toBe("GitHub issue created: acme/synapse-sandbox#42"); // not labelled "(simulated)"
    expect(app.ctx.audit.list().map((r) => r.event)).toContain("artifact_executed");
  });

  it("a GitHub error is reported and the artifact stays staged: no phantom success", async () => {
    app = await makeApp({ GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/synapse-sandbox" });
    const { a } = stage("github_issue");
    stubFetch(() => json(422, { message: "Validation Failed" }));

    await expect(app.ctx.outbox.push(a)).rejects.toThrow(/GitHub 422.*Validation Failed/);
    expect(a.status).toBe("staged");
    expect(a.externalRef).toBeUndefined();
    expect(app.ctx.audit.list().map((r) => r.event)).not.toContain("artifact_executed");
    expect(app.sent.some((m) => m.type === "notice" && m.level === "success")).toBe(false);

    // through the REST route the UI uses: 409 with the reason
    const res = await app.ctx.fastify.inject({ method: "POST", url: `/api/artifacts/${a.id}/push` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("GitHub 422") });
  });

  it("a network failure or timeout is an error too (and a later retry can still succeed)", async () => {
    app = await makeApp({ GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/synapse-sandbox" });
    const { a } = stage("github_issue");
    let n = 0;
    stubFetch(() => {
      if (n++ === 0) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return json(201, { number: 7, html_url: "https://github.com/acme/synapse-sandbox/issues/7" });
    });

    await expect(app.ctx.outbox.push(a)).rejects.toThrow(/timeout/i);
    expect(a.status).toBe("staged");
    const res = await app.ctx.outbox.push(a);
    expect(res.externalRef).toBe("acme/synapse-sandbox#7");
    expect(a.status).toBe("executed");
  });

  it("undo closes the real issue as not planned", async () => {
    app = await makeApp({ GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/synapse-sandbox" });
    const { a } = stage("github_issue");
    const calls = stubFetch((c) => (c.init.method === "POST" ? json(201, { number: 9, html_url: "https://github.com/acme/synapse-sandbox/issues/9" }) : json(200, {})));
    await app.ctx.outbox.push(a);
    await app.ctx.outbox.undo(a);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/synapse-sandbox/issues/9");
    expect(calls[1]!.init.method).toBe("PATCH");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ state: "closed", state_reason: "not_planned" });
    expect(a.status).toBe("undone");
  });

  it("without credentials (or with a malformed repo) it is simulated and the network is never touched", async () => {
    const cases: Array<Record<string, string>> = [{}, { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "not-a-repo" }, { GITHUB_TOKEN: "", GITHUB_REPO: "acme/synapse-sandbox" }];
    for (const env of cases) {
      app = await makeApp(env);
      const { a } = stage("github_issue");
      const calls = stubFetch(() => {
        throw new Error("the network must not be used");
      });
      expect(app.ctx.outbox.githubReady()).toBe(false);
      const res = await app.ctx.outbox.push(a);
      expect(res.simulated).toBe(true);
      expect(res.externalRef).toMatch(/^GH-\d+$/);
      expect(calls).toHaveLength(0);
      await app.stop();
      app = undefined;
      vi.unstubAllGlobals();
    }
  });

  it("L3 into the sandbox repo: a GitHub outage leaves the artifact staged instead of crashing the pipeline", async () => {
    app = await makeApp({ AUTONOMY_LEVEL: "3", GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/synapse-sandbox" });
    app.ctx.autonomy.setLevel(3);
    const { a, t } = stage("github_issue");
    a.status = "draft";
    stubFetch(() => json(503, { message: "Service Unavailable" }));
    await app.ctx.autonomy.onArtifact(t, a);
    expect(a.status).toBe("staged");
    expect(app.ctx.audit.list().map((r) => r.event)).not.toContain("auto_executed");
  });
});

describe("Jira adapter (stubbed fetch)", () => {
  const jiraEnv = { JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "rio@example.com", JIRA_API_TOKEN: JIRA_TOKEN, JIRA_PROJECT_KEY: "SYN" };

  it("creates the issue with basic auth and an Atlassian-document description, then maps the key to a browse URL", async () => {
    app = await makeApp(jiraEnv);
    const { a } = stage("ticket");
    expect(app.ctx.outbox.jiraReady()).toBe(true);
    const calls = stubFetch(() => json(201, { key: "SYN-12" }));

    const res = await app.ctx.outbox.push(a);

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://acme.atlassian.net/rest/api/3/issue"); // trailing slash in the config is normalised
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.Authorization).toBe(`Basic ${Buffer.from(`rio@example.com:${JIRA_TOKEN}`).toString("base64")}`);
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    const sent = JSON.parse(c.init.body as string) as { fields: { project: { key: string }; summary: string; issuetype: { name: string }; labels: string[]; description: { type: string; version: number; content: Array<{ type: string }> } } };
    expect(sent.fields.project.key).toBe("SYN");
    expect(sent.fields.summary).toBe("NPE in cart-service discount-code path");
    expect(sent.fields.issuetype.name).toBe("Bug");
    expect(sent.fields.labels).toEqual(["cart-service", "bug"]); // Jira labels cannot contain spaces
    expect(sent.fields.description).toMatchObject({ type: "doc", version: 1 });
    expect(sent.fields.description.content.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(sent.fields.description)).toContain("No crash on an empty code");

    expect(res).toMatchObject({ simulated: false, system: "jira", externalRef: "SYN-12", url: "https://acme.atlassian.net/browse/SYN-12" });
    expect(a.status).toBe("executed");
  });

  it("a Jira error leaves the ticket staged; Jira is never 'self-only', so L3 never pushes it without a tap", async () => {
    app = await makeApp(jiraEnv);
    const { a } = stage("ticket");
    stubFetch(() => json(400, { errorMessages: ["project is required"] }));
    await expect(app.ctx.outbox.push(a)).rejects.toThrow(/Jira 400/);
    expect(a.status).toBe("staged");
    expect(app.ctx.outbox.isSelfOnly(a)).toBe(false); // assignees/watchers get notified: needs a human
  });
});

describe("secrets stay server-side", () => {
  it("neither token appears in anything emitted to clients, audited, or exposed by the REST surface", async () => {
    app = await makeApp({ AUTONOMY_LEVEL: "2", GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/synapse-sandbox", ...{ JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "rio@example.com", JIRA_API_TOKEN: JIRA_TOKEN, JIRA_PROJECT_KEY: "SYN" } });
    const gh = stage("github_issue");
    const jira = stage("ticket");
    stubFetch((c) => (c.url.includes("github") ? json(201, { number: 3, html_url: "https://github.com/acme/synapse-sandbox/issues/3" }) : json(201, { key: "SYN-3" })));
    await app.ctx.outbox.push(gh.a);
    await app.ctx.outbox.push(jira.a);

    const surfaces = [
      JSON.stringify(app.sent),
      JSON.stringify(app.ctx.audit.list(500)),
      JSON.stringify(app.ctx.clientConfig()),
      JSON.stringify(app.ctx.store.artifactView(gh.a)),
      JSON.stringify(app.ctx.store.artifactView(jira.a)),
    ];
    for (const path of ["/api/settings", "/api/health", "/api/state", "/api/outbox", "/api/privacy/ledger", "/api/privacy/export", "/api/privacy/audit"]) {
      const res = await app.ctx.fastify.inject({ method: "GET", url: path });
      expect(res.statusCode, path).toBe(200);
      surfaces.push(res.body);
    }
    for (const s of surfaces) {
      expect(s).not.toContain(GH_TOKEN);
      expect(s).not.toContain(JIRA_TOKEN);
      expect(s).not.toContain(Buffer.from(`rio@example.com:${JIRA_TOKEN}`).toString("base64"));
    }
    // the client only learns THAT the integrations are connected
    expect(app.ctx.clientConfig().integrations).toEqual({ github: true, jira: true });
  });
});
