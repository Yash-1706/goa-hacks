import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_KEYS, REPO_ROOT, loadConfig } from "../src/config";
import { EXAMPLE_OUTPUTS } from "../src/cortex/prompts";
import { GroqClient } from "../src/llm/groq-client";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeGroq, type FakeGroq } from "./fake-groq";

/**
 * Groq as a provider, end to end through the real app (real MiniLM embeddings, mock fallback cortex, a fake Groq endpoint that
 * records every request): provider selection, the wiring (fast cortex + DEEP share one paced client), /api/health, the
 * ClientConfig fields the UI shows, the audit trail, and the privacy switch: local-only blocks every path to Groq, exactly as it
 * blocks Anthropic (test/local-only.test.ts).
 */

const KEY = "gs\u006b_test_key_not_real_0000000000";
let fake: FakeGroq;
let app: TestApp | undefined;

beforeAll(async () => {
  fake = await startFakeGroq({ initial: [{ kind: "ok", json: EXAMPLE_OUTPUTS[0], chunkChars: 400, chunkDelayMs: 0 }] });
});
afterAll(async () => {
  await fake.close();
});
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

/** the env of a Groq-only setup; a huge budget so real-time pacing never interferes with what these tests are about */
const groqEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  LLM_MODE: "live",
  LLM_PROVIDER: "groq",
  ANTHROPIC_API_KEY: "",
  GROQ_API_KEY: KEY,
  GROQ_BASE_URL: fake.url,
  GROQ_TPM: "1000000",
  LOCAL_ONLY: "0",
  ...extra,
});
const sentToLlm = (a: TestApp): Array<{ ref: string | null; count: number | null }> => a.ctx.audit.list(1000).filter((r) => r.event === "sent_to_llm").map((r) => ({ ref: r.ref, count: r.count }));

describe("LLM provider selection (config)", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ LLM_MODE: "live", LLM_PROVIDER: "auto", ANTHROPIC_API_KEY: "", GROQ_API_KEY: "", LOCAL_ONLY: "0", ...env }).llm;

  it("auto: Anthropic when its key is set, else Groq when its key is set, else mock", () => {
    expect(cfg({ ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ mode: "live", provider: "anthropic", hasKey: true, fast: "claude-haiku-4-5", deep: "claude-opus-5-5" });
    expect(cfg({ GROQ_API_KEY: KEY })).toMatchObject({ mode: "live", provider: "groq", hasKey: true, fast: "qwen/qwen3.8-27b", deep: "openai/gpt-oss-120b" });
    expect(cfg({ ANTHROPIC_API_KEY: "sk-ant-x", GROQ_API_KEY: KEY }).provider).toBe("anthropic"); // Claude stays the default when both exist
    expect(cfg({})).toMatchObject({ mode: "mock", provider: "mock", hasKey: false });
    expect(cfg({ LLM_PROVIDER: "bogus", GROQ_API_KEY: KEY }).provider).toBe("groq"); // an unknown value means auto
    expect(cfg({ LLM_PROVIDER: "" , GROQ_API_KEY: KEY }).provider).toBe("groq");
  });

  it("an explicit provider is honoured; groq without its key is mock, anthropic without its key keeps the original live-then-degrade semantics", () => {
    expect(cfg({ LLM_PROVIDER: "groq", ANTHROPIC_API_KEY: "sk-ant-x", GROQ_API_KEY: KEY }).provider).toBe("groq");
    expect(cfg({ LLM_PROVIDER: "groq", ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ provider: "mock", mode: "mock" });
    expect(cfg({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x", GROQ_API_KEY: KEY }).provider).toBe("anthropic");
    expect(cfg({ LLM_PROVIDER: "anthropic" })).toMatchObject({ provider: "anthropic", mode: "live", hasKey: false }); // as before: live, and the call fails with an auth error
  });

  it("LLM_MODE=mock and LOCAL_ONLY always win", () => {
    expect(cfg({ LLM_MODE: "mock", GROQ_API_KEY: KEY, ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ mode: "mock", provider: "mock" });
    expect(cfg({ LOCAL_ONLY: "1", GROQ_API_KEY: KEY })).toMatchObject({ mode: "mock", provider: "mock" });
    expect(cfg({ LOCAL_ONLY: "1", LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ mode: "mock", provider: "mock" });
  });

  it("the Anthropic settings are untouched whatever Groq is set to", () => {
    const c = cfg({ ANTHROPIC_API_KEY: "sk-ant-x", MODEL_FAST: "my-fast", MODEL_DEEP: "my-deep", GROQ_API_KEY: KEY, GROQ_MODEL_FAST: "g-fast" });
    expect(c).toMatchObject({ provider: "anthropic", apiKey: "sk-ant-x", fast: "my-fast", deep: "my-deep" });
    expect(c.groq).toMatchObject({ apiKey: KEY, fast: "g-fast" });
  });

  it("Groq knobs: models, budget, wait and daily cap, with sane bounds", () => {
    const g = cfg({ GROQ_API_KEY: KEY, GROQ_MODEL_FAST: "qwen/qwen3.8-27b", GROQ_MODEL_DEEP: "openai/gpt-oss-120b", GROQ_TPM: "6000", GROQ_MAX_WAIT_MS: "500", GROQ_MAX_REQUESTS_PER_DAY: "50", GROQ_OUTPUT_MODE: "json_schema", GROQ_BASE_URL: "https://example.test/v1/" });
    expect(g).toMatchObject({ provider: "groq", fast: "qwen/qwen3.8-27b", deep: "openai/gpt-oss-120b" });
    expect(g.groq).toEqual({ apiKey: KEY, baseUrl: "https://example.test/v1", fast: "qwen/qwen3.8-27b", deep: "openai/gpt-oss-120b", outputMode: "json_schema", tpm: 6000, maxWaitMs: 500, maxRequestsPerDay: 50 });
    const d = cfg({ GROQ_API_KEY: KEY, GROQ_TPM: "10", GROQ_OUTPUT_MODE: "nonsense" }).groq;
    expect(d).toMatchObject({ outputMode: "auto", tpm: 500, maxWaitMs: 2000, maxRequestsPerDay: 900, baseUrl: "https://api.groq.com/openai/v1" });
  });

  it("every variable the server reads is documented in .env.example (and nothing stale lingers there)", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    const documented = new Set([...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1] as string));
    expect(ENV_KEYS.length).toBeGreaterThan(40);
    expect(ENV_KEYS.filter((k) => !documented.has(k))).toEqual([]);
    expect([...documented].filter((k) => !ENV_KEYS.includes(k))).toEqual([]);
    expect(text).not.toMatch(/gsk_[A-Za-z0-9]{10,}/); // no real key, ever
  });
});

describe("the app over Groq", () => {
  it("runs the pipeline on Groq, audits each call, and local-only blocks every path while it is on", async () => {
    fake.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0], chunkChars: 400, chunkDelayMs: 0 });
    app = await makeApp(groqEnv());
    expect(app.ctx.cfg.llm.provider).toBe("groq");
    expect(app.ctx.live?.name).toBe("groq");
    expect(app.ctx.groq).not.toBeNull();
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "live", llmProvider: "groq", llmModel: "qwen/qwen3.8-27b", localOnly: false });

    // 1. cloud allowed: the Groq model answers (and the cloud call is audited, content-free, with the provider named)
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests[0]!.body.model).toBe("qwen/qwen3.8-27b");
    const first = app.thoughts()[0];
    expect(first?.source).toBe("llm");
    expect(first?.degraded).toBeUndefined();
    const audited = sentToLlm(app);
    expect(audited.length).toBe(fake.requests.length);
    expect(audited[0]?.ref).toBe("groq:qwen/qwen3.8-27b");
    expect(JSON.stringify(audited)).not.toContain("discount"); // model name and a count, never text

    // 2. local-only on: every path stays on the machine
    app.ctx.privacy.setLocalOnly(true);
    const cc = app.ctx.clientConfig();
    expect(cc).toMatchObject({ llmMode: "mock", localOnly: true });
    expect(cc.llmProvider).toBeUndefined();
    expect(cc.llmModel).toBeUndefined();
    fake.requests.length = 0;
    const auditedBefore = sentToLlm(app).length;
    const requestsBefore = app.ctx.groq?.stats().requestsToday;

    await app.say("Remind me to email the team about the delay", { gapMs: 30_000 });
    await app.say("What was that bug about the cart service discount code?", { gapMs: 30_000 }); // a recall question: the DEEP path
    await app.settle();
    await app.ctx.proactive.brief("sess-desk"); // session brief: DEEP path
    await app.ctx.consolidator.run(); // consolidation: DEEP path

    expect(fake.requests, "a request escaped to Groq while local-only was on").toHaveLength(0);
    expect(sentToLlm(app)).toHaveLength(auditedBefore);
    expect(app.ctx.groq?.stats().requestsToday).toBe(requestsBefore);
    expect(app.thoughts().filter((v) => v.title.toLowerCase().includes("email") || v.title.toLowerCase().includes("delay")).every((v) => v.source !== "llm")).toBe(true);

    // 3. back off: Groq is used again
    app.ctx.privacy.setLocalOnly(false);
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "live", llmProvider: "groq" });
    await app.say("The checkout page also crashes when the cart is empty", { gapMs: 30_000 });
    await app.settle();
    expect(fake.requests.length).toBeGreaterThan(0);
  });

  it("the recall answer (DEEP) is streamed from the deep model through the same client", async () => {
    fake.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0], chunkChars: 400, chunkDelayMs: 0 });
    app = await makeApp(groqEnv());
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    fake.reset({ kind: "ok", json: "You noted a null pointer in the cart service [T-1].", chunkChars: 8, chunkDelayMs: 0 });
    expect(app.ctx.deep.available).toBe(true);
    await app.ctx.recall.ask("q-1", "What was that bug about the cart service discount code?", { id: "dev-desk", kind: "desk", activity: "desk" });
    const done = app.last("recall.done");
    expect(done?.answer).toContain("null pointer in the cart service");
    const req = fake.requests.find((r) => r.body.model === "openai/gpt-oss-120b");
    expect(req, "the deep model was not called").toBeTruthy();
    expect(req?.body.reasoning_effort).toBe("medium");
    expect(req?.body.stream).toBe(true);
    expect(sentToLlm(app).map((r) => r.ref)).toContain("groq:openai/gpt-oss-120b");
  });

  it("exposes the free-tier counters on /api/health (no content), and nothing for other providers", async () => {
    fake.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0], chunkChars: 400, chunkDelayMs: 0 });
    app = await makeApp(groqEnv());
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    const res = await app.ctx.fastify.inject({ method: "GET", url: "/api/health" });
    const h = res.json() as { modes: { llm: string }; llmProvider: string; models: { fast: string; deep: string }; groq: { requestsToday: number; remainingTokensLastSeen: number | null; tpmBudget: number } | null };
    expect(res.statusCode).toBe(200);
    expect(h.modes.llm).toBe("live");
    expect(h.llmProvider).toBe("groq");
    expect(h.models).toMatchObject({ fast: "qwen/qwen3.8-27b", deep: "openai/gpt-oss-120b" });
    expect(h.groq?.requestsToday).toBe(fake.requests.length);
    expect(h.groq?.requestsToday).toBeGreaterThan(0);
    expect(h.groq?.remainingTokensLastSeen).toBeGreaterThan(0);
    expect(h.groq?.tpmBudget).toBe(1_000_000);
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain("discount");
    await app.stop();

    app = await makeApp({ LLM_MODE: "mock" });
    const mock = (await app.ctx.fastify.inject({ method: "GET", url: "/api/health" })).json() as { llmProvider: string; groq: unknown };
    expect(mock).toMatchObject({ llmProvider: "mock", groq: null });
  });

  it("one client can serve several apps (an eval builds many): the budget belongs to the key, so a new app does not start with a full bucket and walk into a 429", async () => {
    // the fake enforces Groq's admission rule; a call needs prompt + the 900-token allowance, and the minute holds ~7,000
    const strict = await startFakeGroq({ enforceLimits: true });
    try {
      strict.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0], promptTokens: 2300, completionTokens: 300, chunkChars: 600, chunkDelayMs: 0 });
      const shared = new GroqClient({ apiKey: KEY, baseUrl: strict.url, tpm: 7000, maxWaitMs: 50 });
      const env = groqEnv({ GROQ_BASE_URL: strict.url });
      const first = await makeApp(env, undefined, ":memory:", randomBytes(32), { groq: shared });
      expect(first.ctx.groq).toBe(shared);
      for (const text of ["The login page crashes on Safari", "Remind me to rotate the staging keys on Friday", "There is a race condition in the queue worker"]) {
        await first.say(text, { gapMs: 30_000 });
        await first.settle();
      }
      await first.stop();
      const spent = strict.requests.length;
      expect(spent).toBe(2); // the third call did not fit the minute: paced, not sent
      expect(shared.stats().paced).toBeGreaterThanOrEqual(1);

      app = await makeApp(env, undefined, ":memory:", randomBytes(32), { groq: shared });
      await app.say("The checkout page also crashes when the cart is empty", { gapMs: 30_000 });
      await app.settle();
      expect(strict.requests).toHaveLength(spent); // the new app knew the minute was spent
      expect(app.thoughts()[0]?.degraded).toBe("paced");
      expect(shared.stats()).toMatchObject({ rateLimited: 0, requestsToday: 2 }); // never a 429
    } finally {
      await strict.close();
    }
  });

  it("the key stays server-side: in nothing sent to clients, audited, logged or exposed over REST, even when the API echoes it back in an error", async () => {
    fake.reset({ kind: "status", status: 401, code: "invalid_api_key", message: `Invalid API Key ${KEY}` });
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    try {
      app = await makeApp(groqEnv());
      await app.say("There is a null pointer exception in the cart service when applying a discount code");
      await app.settle();
      expect(app.thoughts()[0]?.degraded).toBe("auth"); // the card says why, in our words, never the server's
      const surfaces = [JSON.stringify(app.sent), JSON.stringify(app.ctx.audit.list(500)), JSON.stringify(app.ctx.clientConfig()), JSON.stringify(app.ctx.groq?.stats()), JSON.stringify(app.thoughts())];
      for (const path of ["/api/settings", "/api/health", "/api/state", "/api/outbox", "/api/privacy/ledger", "/api/privacy/export", "/api/privacy/audit", "/api/thoughts"]) {
        const res = await app.ctx.fastify.inject({ method: "GET", url: path });
        expect(res.statusCode, path).toBe(200);
        surfaces.push(res.body);
      }
      for (const s of surfaces) expect(s).not.toContain(KEY);
      expect(logs.join("\n")).not.toContain(KEY);
      expect(logs.join("\n")).toMatch(/Groq auth failed/); // it was logged, in a sentence that names the variable and never its value
      expect(logs.join("\n")).not.toContain("discount"); // nor any transcript text
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("LOCAL_ONLY at boot: nothing goes out, nothing is configured as live, the UI is told so", async () => {
    fake.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0] });
    app = await makeApp(groqEnv({ LOCAL_ONLY: "1" }));
    expect(app.ctx.cfg.llm.provider).toBe("mock");
    expect(app.ctx.groq).toBeNull();
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "mock", localOnly: true });
    expect(app.ctx.clientConfig().llmProvider).toBeUndefined();
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    expect(fake.requests).toHaveLength(0);
    expect(app.thoughts().length).toBeGreaterThan(0);
  });

  it("Anthropic stays the default: both keys set means Claude, with no Groq client around", async () => {
    app = await makeApp({ LLM_MODE: "live", LLM_PROVIDER: "auto", ANTHROPIC_API_KEY: "sk\u002dant-test-key", GROQ_API_KEY: KEY, GROQ_BASE_URL: fake.url, LOCAL_ONLY: "0" });
    expect(app.ctx.cfg.llm.provider).toBe("anthropic");
    expect(app.ctx.live?.name).toBe("claude");
    expect(app.ctx.groq).toBeNull();
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "live", llmProvider: "anthropic", llmModel: "claude-haiku-4-5" });
    expect(app.ctx.deep.model).toBe("claude-opus-5-5");
  });
});
