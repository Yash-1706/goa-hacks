import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CortexResult } from "@synapse/shared";
import { ClaudeCortex } from "../src/llm/anthropic";
import { EXAMPLE_OUTPUTS } from "../src/cortex/prompts";
import type { CortexBackend, CortexInput, CortexOutput } from "../src/cortex/types";
import { Triager } from "../src/gate/triage";
import { HashEmbedder } from "../src/memory/embeddings";
import { startFakeAnthropic, type FakeMode, type FakeServer } from "./fake-anthropic";

const canned: CortexResult = EXAMPLE_OUTPUTS[0] as CortexResult; // the S1 bug example

const baseInput = async (text: string): Promise<CortexInput> => {
  const embedder = new HashEmbedder();
  const triager = new Triager(embedder);
  await triager.init();
  const [emb] = await embedder.embed([text]);
  return {
    now: Date.parse("2026-10-06T15:42:10+05:30"),
    timezone: "Asia/Kolkata",
    user: { name: "Rio", role: "backend engineer", team: [{ name: "Sarah", role: "PM" }] },
    device: { kind: "desk", activity: "desk" },
    threadRef: "T-9",
    fragments: [{ id: "F1", dtMs: 0, text, whisper: false, pauseBeforeMs: 0 }],
    previous: null,
    lastCard: null,
    candidates: [{ id: "x", ref: "T-181", kind: "thought", label: "NPE when applying discount codes", snippet: "NPE when applying discount codes at checkout", score: 0.7 }],
    recent: [],
    triage: triager.classify(text, emb as Float32Array),
    vocabulary: ["cart-service"],
  };
};

const fallback: CortexBackend = {
  name: "stub-mock",
  async analyze(): Promise<CortexOutput> {
    return { result: { ...canned, title: "FALLBACK" }, source: "mock", model: "heuristic", ms: 1, redactions: 0 };
  },
};

let fake: FakeServer;
const prevEnv = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
beforeAll(async () => {
  fake = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_API_KEY = "sk\u002dant-test-key";
});
afterAll(async () => {
  await fake.close();
  process.env.ANTHROPIC_BASE_URL = prevEnv.url;
  process.env.ANTHROPIC_API_KEY = prevEnv.key;
});

const make = (timeoutMs = 4000) => new ClaudeCortex({ apiKey: "sk\u002dant-test-key", model: "claude-haiku-4-5", fallback, timeoutMs });
const reset = (...script: FakeMode[]) => fake.reset(...script);

describe("ClaudeCortex against a faithful Messages-API fake", () => {
  it("streams partial cards, validates the final result, maps usage and cache hits", async () => {
    reset({ kind: "ok", json: canned, cacheRead: 7800 });
    const partials: Array<Partial<CortexResult>> = [];
    const out = await make().analyze(await baseInput("That bug from yesterday, the null pointer in the cart service"), (p) => partials.push(structuredClone(p)));

    expect(out.source).toBe("llm");
    expect(out.degraded).toBeUndefined();
    expect(out.result.category).toBe("bug");
    expect(out.result.artifact.kind).toBe("github_issue");
    expect(out.usage?.cacheReadTokens).toBe(7800);
    expect(out.firstFieldMs).toBeGreaterThan(0);
    // the card "typed itself in": early partials had the category/title before the artifact existed
    expect(partials.length).toBeGreaterThan(3);
    const early = partials.find((p) => p.title && !p.artifact);
    expect(early).toBeTruthy();
    expect(partials.at(-1)?.artifact).toBeTruthy();
  });

  it("sends a cached, static system prompt and the strict schema; never the raw secret", async () => {
    reset({ kind: "ok", json: { ...canned, intent: "Rotate the key [SECRET_1]." } });
    const input = await baseInput("the api key is sk\u002dant-abcdefghijklmnop1234 please remember mail me at rio@example.com");
    const out = await make().analyze(input);
    const body = fake.requests[0]!.body as { system: Array<{ cache_control?: { type: string; ttl?: string }; text: string }>; output_config: { format: { schema: unknown } }; messages: Array<{ content: string }>; model: string; stream?: boolean };

    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.stream).toBe(true);
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(JSON.stringify(body.output_config.format.schema)).toContain('"enum"');
    const sent = JSON.stringify(body);
    expect(sent).not.toContain("sk\u002dant-abcdefghijklmnop1234");
    expect(sent).not.toContain("rio@example.com");
    expect(sent).toMatch(/\[SECRET_\d+\]|\[EMAIL_\d+\]/);
    expect(out.redactions).toBeGreaterThanOrEqual(2);
    // placeholders in the model's answer are restored locally
    expect(out.result.intent).toContain("sk\u002dant-abcdefghijklmnop1234");
  });

  it("falls back to the local cortex on auth failure and then stops calling the API for a while", async () => {
    reset({ kind: "status", status: 401, type: "authentication_error", message: "invalid x-api-key" });
    const c = make();
    const a = await c.analyze(await baseInput("hello there friend"));
    expect(a.source).toBe("mock");
    expect(a.degraded).toBe("auth");
    const before = fake.requests.length;
    const b = await c.analyze(await baseInput("another thought entirely"));
    expect(b.degraded).toBe("llm_disabled");
    expect(fake.requests.length).toBe(before); // no further HTTP while disabled
  });

  it("degrades on rate limit, refusal, truncation and malformed output", async () => {
    // generous cortex timeout: the 429 case includes the SDK's own retry backoff, and a loaded machine must not turn "rate_limit" into "timeout"
    reset({ kind: "status", status: 429, type: "rate_limit_error", message: "slow down" });
    expect((await make(12_000).analyze(await baseInput("x y z"))).degraded).toBe("rate_limit");

    reset({ kind: "ok", json: canned, stopReason: "refusal" });
    expect((await make(12_000).analyze(await baseInput("x y z"))).degraded).toBe("refusal");

    reset({ kind: "ok", json: canned, stopReason: "max_tokens" });
    expect((await make(12_000).analyze(await baseInput("x y z"))).degraded).toBe("max_tokens");

    reset({ kind: "garbage", text: "this is not json" });
    expect((await make(12_000).analyze(await baseInput("x y z"))).degraded).toBe("bad_json");

    reset({ kind: "ok", json: { ...canned, category: "not-a-category" } });
    expect((await make(12_000).analyze(await baseInput("x y z"))).degraded).toBe("schema_invalid");
  });

  it("times out instead of stalling the pipeline", async () => {
    reset({ kind: "slow", delayMs: 1500 });
    const t0 = Date.now();
    const out = await make(400).analyze(await baseInput("slow thought please"));
    expect(out.degraded).toBe("timeout");
    expect(out.source).toBe("mock");
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  it("retries once with the SDK schema when the API rejects the strict schema", async () => {
    reset({ kind: "status", status: 400, type: "invalid_request_error", message: "output_config.format.schema: 'enum' is not supported" }, { kind: "ok", json: canned });
    const out = await make().analyze(await baseInput("That bug from yesterday"));
    expect(out.source).toBe("llm");
    expect(fake.requests).toHaveLength(2);
    const first = JSON.stringify((fake.requests[0]!.body as { output_config: unknown }).output_config);
    const second = JSON.stringify((fake.requests[1]!.body as { output_config: unknown }).output_config);
    expect(first).toContain('"enum":["');
    expect(second).not.toContain('"enum":["'); // the SDK's helper moves enums into descriptions
  });
});
