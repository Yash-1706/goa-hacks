import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ephemeralApp, intFlag, liveEnv, liveProvider, patience, sharedGroqClient, spreadBy } from "../src/cli/common";
import { GroqClient } from "../src/llm/groq-client";
import { startFakeGroq, type FakeGroq } from "./fake-groq";

/**
 * The live-run plumbing of `pnpm eval` / `pnpm bench`: which provider a --live run would call (so the report header can say
 * "live groq/<model>"), the --limit sampler that protects a free tier's daily quota, and the guard that refuses a --live run with
 * nothing live configured. No request is ever made here.
 */

const serverDir = path.resolve(import.meta.dirname, "..");
const saved = { groq: process.env.GROQ_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER, local: process.env.LOCAL_ONLY, mode: process.env.LLM_MODE, base: process.env.GROQ_BASE_URL };
afterEach(() => {
  for (const [k, v] of [["GROQ_API_KEY", saved.groq], ["ANTHROPIC_API_KEY", saved.anthropic], ["LLM_PROVIDER", saved.provider], ["LOCAL_ONLY", saved.local], ["LLM_MODE", saved.mode], ["GROQ_BASE_URL", saved.base]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const setEnv = (e: Record<string, string>): void => {
  process.env.GROQ_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LLM_PROVIDER = "auto";
  process.env.LOCAL_ONLY = "0";
  Object.assign(process.env, e);
};

describe("which provider a --live run uses", () => {
  it("names the provider and model for the report header, or null when nothing live is configured", () => {
    setEnv({ GROQ_API_KEY: "gs\u006b_test_key_not_real_0000000000" });
    expect(liveProvider()).toEqual({ provider: "groq", model: "qwen/qwen3.8-27b", label: "groq/qwen/qwen3.8-27b" });
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-x", GROQ_API_KEY: "gs\u006b_test_key_not_real_0000000000" });
    expect(liveProvider()).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", label: "anthropic/claude-haiku-4-5" });
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-x", GROQ_API_KEY: "gs\u006b_test_key_not_real_0000000000", LLM_PROVIDER: "groq" });
    expect(liveProvider()?.label).toBe("groq/qwen/qwen3.8-27b");
    setEnv({});
    expect(liveProvider()).toBeNull();
    setEnv({ GROQ_API_KEY: "gs\u006b_test_key_not_real_0000000000", LOCAL_ONLY: "1" });
    expect(liveProvider()).toBeNull(); // LOCAL_ONLY wins over --live
  });

  it("a Groq run waits as long as it takes for the budget (it measures the model, not the queue) and can cap its requests; other providers add nothing", () => {
    expect(liveEnv("groq")).toEqual({ GROQ_MAX_WAIT_MS: "300000" });
    expect(liveEnv("groq", 80)).toEqual({ GROQ_MAX_WAIT_MS: "300000", GROQ_MAX_REQUESTS_PER_DAY: "80" });
    expect(liveEnv("anthropic", 80)).toEqual({});
    expect(liveEnv(undefined)).toEqual({});
  });
});

describe("offline tools never go live because .env turned the live model on for the server", () => {
  it("ephemeralApp (replay --local, eval, bench) is the offline cortex whatever the environment says, and live only when asked", async () => {
    setEnv({ GROQ_API_KEY: "gs\u006b_test_key_not_real_0000000000", LLM_MODE: "live", GROQ_BASE_URL: "http://127.0.0.1:1/openai/v1" });
    const off = await ephemeralApp({});
    try {
      expect(off.cfg.llm).toMatchObject({ mode: "mock", provider: "mock" });
      expect(off.ctx.live).toBeNull(); // nothing that could reach Groq was even built
    } finally {
      await off.stop();
    }
    const on = await ephemeralApp({ LLM_MODE: "live" });
    try {
      expect(on.cfg.llm).toMatchObject({ mode: "live", provider: "groq" });
      expect(on.ctx.live?.name).toBe("groq");
    } finally {
      await on.stop();
    }
  });

  it("pnpm seed pins the offline cortex as well (it writes dozens of fragments through the real pipeline)", () => {
    const src = fs.readFileSync(path.join(serverDir, "src/cli/seed.ts"), "utf8");
    expect(src).toMatch(/loadConfig\(\{\s*LLM_MODE:\s*"mock"\s*\}\)/);
    expect(src).not.toMatch(/loadConfig\(\)/);
  });
});

describe("--limit", () => {
  it("parses a positive integer and ignores everything else", () => {
    expect(intFlag("12")).toBe(12);
    expect(intFlag("7.9")).toBe(7);
    expect(intFlag("0")).toBeUndefined();
    expect(intFlag("-3")).toBeUndefined();
    expect(intFlag("many")).toBeUndefined();
    expect(intFlag(true)).toBeUndefined();
    expect(intFlag(undefined)).toBeUndefined();
  });

  const corpus = [
    ...["a1", "a2", "a3", "a4"].map((id) => ({ id, expect: { category: "action" } })),
    ...["b1", "b2", "b3"].map((id) => ({ id, expect: { category: "bug" } })),
    ...["c1", "c2"].map((id) => ({ id, expect: { category: "code" } })),
    ...["d1"].map((id) => ({ id, expect: { category: "decision" } })),
  ];
  const cat = (x: { expect: { category: string } }): string => x.expect.category;

  it("samples across the categories, not just the first few items (the corpora are grouped by category)", () => {
    expect(spreadBy(corpus, 4, cat).map((x) => x.id)).toEqual(["a1", "b1", "c1", "d1"]);
    expect(spreadBy(corpus, 6, cat).map((x) => x.id)).toEqual(["a1", "b1", "c1", "d1", "a2", "b2"]);
    expect(spreadBy(corpus, 2, cat).map((x) => x.id)).toEqual(["a1", "b1"]);
  });

  it("is deterministic, never repeats an item, and returns everything when the limit is not smaller", () => {
    expect(spreadBy(corpus, 9, cat).map((x) => x.id)).toEqual(spreadBy(corpus, 9, cat).map((x) => x.id));
    const nine = spreadBy(corpus, 9, cat).map((x) => x.id);
    expect(new Set(nine).size).toBe(9);
    expect(spreadBy(corpus, 10, cat)).toBe(corpus);
    expect(spreadBy(corpus, 99, cat)).toBe(corpus);
    expect(spreadBy(corpus, undefined, cat)).toBe(corpus);
    expect(spreadBy(corpus, 8, cat).map((x) => x.id)).toEqual(["a1", "b1", "c1", "d1", "a2", "b2", "c2", "a3"]);
  });
});

describe("a live run is patient", () => {
  let fake: FakeGroq;
  beforeAll(async () => {
    fake = await startFakeGroq();
  });
  afterAll(async () => {
    await fake.close();
  });
  const hi = (c: GroqClient) => c.chat({ model: "qwen/qwen3.8-27b", messages: [{ role: "user", content: "hi" }], maxCompletionTokens: 20 });

  it("waits out a 429's cool-down instead of racing through the fragments behind it, and does not wait without a client", async () => {
    fake.reset({ kind: "status", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached", retryAfter: "1" });
    const client = new GroqClient({ apiKey: "gs\u006b_test_key_not_real_0000000000", baseUrl: fake.url });
    await expect(hi(client)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(client.disabledReason).toBe("rate_limit");
    const t0 = Date.now();
    await patience(client)();
    expect(Date.now() - t0).toBeGreaterThan(500);
    expect(client.disabledReason).toBeNull();
    const t1 = Date.now();
    await patience(undefined)();
    await patience(client)();
    expect(Date.now() - t1).toBeLessThan(100);
  }, 15_000);

  it("does not wait out an authentication failure: a bad key should fail loudly, not hang the run", async () => {
    fake.reset({ kind: "status", status: 401, code: "invalid_api_key", message: "Invalid API Key" });
    const client = new GroqClient({ apiKey: "gs\u006b_test_key_not_real_0000000000", baseUrl: fake.url });
    await expect(hi(client)).rejects.toMatchObject({ kind: "auth" });
    const t0 = Date.now();
    await patience(client)();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(client.disabledReason).toBe("auth");
  });

  it("one shared client per run, built from the config of the chosen provider, and none for Claude", () => {
    process.env.GROQ_API_KEY = "gs\u006b_test_key_not_real_0000000000";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.LLM_PROVIDER = "groq";
    process.env.LOCAL_ONLY = "0";
    const c = sharedGroqClient("groq", 40);
    expect(c).toBeInstanceOf(GroqClient);
    expect(c?.stats()).toMatchObject({ maxRequestsPerDay: 40, tpmBudget: 7000 });
    expect(sharedGroqClient("anthropic", 40)).toBeUndefined();
    expect(sharedGroqClient(undefined)).toBeUndefined();
  });
});

describe("the CLIs refuse --live when nothing live is configured", () => {
  const run = (script: "eval" | "bench", env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join("src", "cli", `${script}.ts`), "--live", "--limit", "1"], {
      cwd: serverDir,
      env: { ...process.env, GROQ_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "auto", LOCAL_ONLY: "0", ...env },
      encoding: "utf8",
      timeout: 90_000,
    });

  it.each(["eval", "bench"] as const)("%s --live exits with a clear message and writes nothing", (script) => {
    const r = run(script, {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`${script} --live needs a live LLM: set ANTHROPIC_API_KEY or GROQ_API_KEY`));
    expect(r.stdout).not.toContain("wrote ");
  }, 120_000);

  it("including when a key exists but LOCAL_ONLY is on", () => {
    const r = run("eval", { GROQ_API_KEY: "gs\u006b_test_key_not_real_0000000000", LOCAL_ONLY: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("turn LOCAL_ONLY off");
  }, 120_000);
});
