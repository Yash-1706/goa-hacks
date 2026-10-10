import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_KINDS, CATEGORIES, CortexResultSchema, ENTITY_TYPES, SALIENCE_CUES, type CortexResult } from "@synapse/shared";
import { EXAMPLES, EXAMPLE_OUTPUTS, renderUserMessage } from "../src/cortex/prompts";
import { LITE_EXAMPLE_INDEXES, LITE_EXAMPLE_OUTPUTS, LITE_INSTRUCTIONS, daysLine, liteSystemPrompt, renderLiteUserMessage } from "../src/cortex/prompts-lite";
import type { CortexBackend, CortexInput, CortexOutput } from "../src/cortex/types";
import { GroqCortex, extractJson, relabelRevision, withEmptyDefaults, type GroqAttempt } from "../src/llm/groq";
import { GroqClient, TokenBucket, estimatePromptTokens, parseDuration } from "../src/llm/groq-client";
import { startFakeGroq, type FakeGroq, type FakeMode } from "./fake-groq";

/**
 * GroqCortex / GroqClient against a faithful fake of Groq's OpenAI-compatible endpoint (test/fake-groq.ts): streaming,
 * validation, the repair retry, every degrade path, the auth window, redaction, and pacing to the free tier's
 * tokens-per-minute budget. Time is injected (a shared fake clock), so waits and windows cost no real time.
 */

const canned: CortexResult = EXAMPLE_OUTPUTS[0] as CortexResult; // the S1 bug example
const KEY = "gs\u006b_test_key_not_real_0000000000";
const MODEL = "openai/gpt-oss-20b";

const baseInput = (text: string, extra: Partial<CortexInput> = {}): CortexInput => ({
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
  triage: {} as never,
  vocabulary: ["cart-service"],
  ...extra,
});

const fallback: CortexBackend = {
  name: "stub-mock",
  async analyze(): Promise<CortexOutput> {
    return { result: { ...canned, title: "FALLBACK" }, source: "mock", model: "heuristic", ms: 1, redactions: 0 };
  },
};

const clock = { t: Date.parse("2026-10-06T10:00:00Z") };
const now = (): number => clock.t;
const sleep = async (ms: number): Promise<void> => {
  clock.t += ms; // a wait for the token budget costs no real time
};

let fake: FakeGroq;
beforeAll(async () => {
  fake = await startFakeGroq({ now });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  clock.t = Date.parse("2026-10-06T10:00:00Z");
});

interface Rig {
  cortex: GroqCortex;
  client: GroqClient;
  attempts: GroqAttempt[];
  sent: Array<{ model: string; redactions: number }>;
}
const rig = (o: { client?: Partial<ConstructorParameters<typeof GroqClient>[0]>; cortex?: Partial<ConstructorParameters<typeof GroqCortex>[0]> } = {}): Rig => {
  const attempts: GroqAttempt[] = [];
  const sent: Rig["sent"] = [];
  const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep, maxWaitMs: 2000, ...o.client });
  const cortex = new GroqCortex({ client, model: MODEL, fallback, timeoutMs: 20_000, outputMode: "json_object", onAttempt: (a) => attempts.push(a), onCloudCall: (i) => sent.push(i), ...o.cortex });
  return { cortex, client, attempts, sent };
};
const reset = (...script: FakeMode[]): void => fake.reset(...script);
const bodyOf = (i: number): { model: string; messages: Array<{ role: string; content: string }>; stream?: boolean; response_format?: { type: string; json_schema?: { strict?: boolean; schema?: unknown } }; reasoning_effort?: string; max_completion_tokens?: number; temperature?: number; stream_options?: unknown; max_tokens?: unknown } =>
  fake.requests[i]!.body as never;

describe("GroqCortex against a faithful chat-completions fake", () => {
  it("streams partial cards token by token, validates the final result and maps usage", async () => {
    reset({ kind: "ok", json: canned, promptTokens: 2100, completionTokens: 380, reasoningTokens: 60 });
    const { cortex } = rig();
    const partials: Array<Partial<CortexResult>> = [];
    const out = await cortex.analyze(baseInput("That bug from yesterday, the null pointer in the cart service"), (p) => partials.push(structuredClone(p)));

    expect(out.source).toBe("llm");
    expect(out.degraded).toBeUndefined();
    expect(out.model).toBe(MODEL);
    expect(out.result.category).toBe("bug");
    expect(out.result.artifact.kind).toBe("github_issue");
    expect(out.usage).toMatchObject({ inputTokens: 2100, outputTokens: 380, cacheReadTokens: 0 });
    expect(out.firstFieldMs).toBeGreaterThan(0);
    // the card "typed itself in": early partials had the category/title before the artifact existed
    expect(partials.length).toBeGreaterThan(3);
    expect(partials.find((p) => p.title && !p.artifact)).toBeTruthy();
    expect(partials.at(-1)?.artifact).toBeTruthy();
  });

  it("a preview callback that throws never fails the call that is still generating the real answer", async () => {
    reset({ kind: "ok", json: canned, chunkChars: 48, chunkDelayMs: 6 });
    const out = await rig().cortex.analyze(baseInput("null pointer in the cart service"), () => {
      throw new Error("the card renderer fell over");
    });
    expect(out.source).toBe("llm");
    expect(out.degraded).toBeUndefined();
    expect(out.result.title).toBe(canned.title);
  });

  it("copes with gpt-oss on Groq: reasoning chunks first, then the whole answer in ONE content chunk", async () => {
    reset({ kind: "ok", json: canned, oneChunk: true, reasoningTokens: 40 });
    const { cortex, attempts } = rig();
    const partials: Array<Partial<CortexResult>> = [];
    const out = await cortex.analyze(baseInput("null pointer in the cart service"), (p) => partials.push(structuredClone(p)));
    expect(out.source).toBe("llm");
    expect(out.result.title).toBe(canned.title);
    expect(JSON.stringify(out.result)).not.toContain("Need to answer"); // reasoning never leaks into the card
    expect(partials).toHaveLength(1); // no progressive preview exists to show: one preview, with everything in it
    expect(partials[0]?.artifact).toBeTruthy();
    expect(attempts[0]).toMatchObject({ jsonValid: true, strictValid: true, reasoningTokens: 40 });
  });

  it("sends the compact static prompt, the JSON-object contract, a tight allowance and the bearer key; nothing volatile in the system part", async () => {
    reset({ kind: "ok", json: canned });
    const { cortex } = rig();
    await cortex.analyze(baseInput("null pointer in the cart service"), () => undefined);

    const b = bodyOf(0);
    expect(b.model).toBe(MODEL);
    expect(b.stream).toBe(true);
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.response_format).toEqual({ type: "json_object" });
    expect(b.reasoning_effort).toBe("low");
    expect(b.max_completion_tokens).toBeLessThanOrEqual(1000);
    expect(b.max_tokens).toBeUndefined();
    expect(b.temperature).toBeLessThanOrEqual(0.3);
    expect(b.messages[0]).toEqual({ role: "system", content: liteSystemPrompt() });
    expect(b.messages[1]?.role).toBe("user");
    expect(b.messages[1]?.content).toContain("<thread");
    expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    // small enough for the free tier: a whole call (prompt + allowance) must fit well inside 8,000 tokens per minute
    expect(estimatePromptTokens({ model: MODEL, messages: b.messages as never, maxCompletionTokens: 900 })).toBeLessThan(3200);
  });

  it("only reasoning models get a reasoning effort", async () => {
    reset({ kind: "ok", json: canned });
    await rig({ cortex: { model: "qwen/qwen3.8-27b" } }).cortex.analyze(baseInput("x y z w"));
    expect(bodyOf(0).reasoning_effort).toBeUndefined();
    expect(bodyOf(0).model).toBe("qwen/qwen3.8-27b");
  });

  it("redacts before the call (no raw email, key or name in any request body) and restores the values locally", async () => {
    reset({ kind: "ok", json: { ...canned, intent: "Mail [EMAIL_1] about [PERSON_A] and rotate [SECRET_1]." } });
    const { cortex, sent } = rig({ cortex: { pseudonymNames: () => ["Priya"] } });
    const input = baseInput("the api key is sk\u002dant-abcdefghijklmnop1234 please mail me at rio@example.com and tell Priya", {
      user: { name: "Rio", role: "engineer", team: [{ name: "Priya", role: "PM" }] },
      candidates: [{ id: "x", ref: "T-1", kind: "thought", label: "Ping rio@example.com", snippet: "call 9876543210 about it", score: 0.5 }],
    });
    const out = await cortex.analyze(input);

    const sentText = JSON.stringify(fake.requests.map((r) => r.body));
    for (const raw of ["sk\u002dant-abcdefghijklmnop1234", "rio@example.com", "9876543210", "Priya"]) expect(sentText, raw).not.toContain(raw);
    expect(sentText).toMatch(/\[SECRET_\d+\]/);
    expect(sentText).toMatch(/\[EMAIL_\d+\]/);
    expect(sentText).toContain("[PERSON_");
    expect(out.redactions).toBeGreaterThanOrEqual(4);
    // the model's placeholders are rehydrated locally
    expect(out.result.intent).toBe("Mail rio@example.com about Priya and rotate sk\u002dant-abcdefghijklmnop1234.");
    // the audit hook saw exactly one cloud call, with a model name and a count, never content
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ model: MODEL, redactions: out.redactions });
  });

  it("an omitted empty field costs nothing: local defaults make the answer valid without a repair round trip", async () => {
    const sparse = JSON.parse(JSON.stringify(canned)) as Record<string, unknown>;
    for (const k of ["references", "repairs", "open_questions", "entities", "salience_cues", "concern_key", "why", "thread_relation"]) delete sparse[k];
    delete (sparse.artifact as Record<string, unknown>).hypotheses;
    reset({ kind: "ok", json: sparse });
    const { cortex, attempts } = rig();
    const out = await cortex.analyze(baseInput("null pointer in the cart service"));
    expect(out.source).toBe("llm");
    expect(fake.requests).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ jsonValid: true, strictValid: false, lenientValid: true });
    expect(out.result).toMatchObject({ thread_relation: "continue", references: [], concern_key: null });
  });

  it("repairs a wrong answer ONCE: the retry carries the model's own reply and the issues (paths and codes), never more", async () => {
    reset({ kind: "ok", json: { ...canned, category: "not-a-category" } }, { kind: "ok", json: canned });
    const { cortex, attempts } = rig();
    const out = await cortex.analyze(baseInput("null pointer in the cart service"));

    expect(out.source).toBe("llm");
    expect(out.degraded).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    const second = bodyOf(1).messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[2]?.content).toContain("not-a-category");
    expect(second[3]?.content).toMatch(/category: invalid_value|category: invalid_enum/);
    expect(bodyOf(1).stream).toBe(false); // a repair is not previewed on the card
    expect(attempts.map((a) => [a.attempt, a.strictValid])).toEqual([[0, false], [1, true]]);
    expect(out.usage?.inputTokens).toBe(attempts[0]!.promptTokens + attempts[1]!.promptTokens);
  });

  it("gives up after that one repair (two requests, never three) and degrades with bad_output", async () => {
    reset({ kind: "ok", json: { ...canned, category: "nope" } });
    const { cortex } = rig();
    const out = await cortex.analyze(baseInput("null pointer in the cart service"));
    expect(out.degraded).toBe("bad_output");
    expect(out.source).toBe("mock");
    expect(fake.requests).toHaveLength(2);

    reset({ kind: "garbage", text: "this is not json" });
    const g = await rig().cortex.analyze(baseInput("null pointer in the cart service"));
    expect(g.degraded).toBe("bad_output");
    expect(fake.requests).toHaveLength(2);
  });

  it("text mode (GROQ_OUTPUT_MODE=text) sends no response_format and streams token by token: cards type in, even behind a code fence", async () => {
    reset({ kind: "ok", json: "```json\n" + JSON.stringify(canned) + "\n```", chunkChars: 64, chunkDelayMs: 5 });
    const { cortex, attempts } = rig({ cortex: { outputMode: "text" } });
    expect(cortex.outputMode).toBe("text");
    const partials: Array<Partial<CortexResult>> = [];
    const out = await cortex.analyze(baseInput("That bug from yesterday, the null pointer in the cart service"), (p) => partials.push(structuredClone(p)));

    expect(bodyOf(0).response_format).toBeUndefined();
    expect(out.source).toBe("llm");
    expect(out.result.category).toBe("bug");
    expect(out.firstFieldMs).toBeGreaterThan(0);
    expect(partials.length).toBeGreaterThan(3);
    expect(partials.find((p) => p.title && !p.artifact)).toBeTruthy(); // the title arrived before the artifact
    expect(attempts[0]).toMatchObject({ mode: "text", streamed: true, jsonValid: true });
  });

  it("tolerates a code fence around the JSON", async () => {
    reset({ kind: "ok", json: "```json\n" + JSON.stringify(canned) + "\n```" });
    const out = await rig().cortex.analyze(baseInput("null pointer in the cart service"));
    expect(out.source).toBe("llm");
    expect(out.result.category).toBe("bug");
  });

  it("a stream that Groq aborts for invalid JSON gets one fresh attempt", async () => {
    reset({ kind: "stream_error", code: "json_validate_failed" }, { kind: "ok", json: canned });
    const out = await rig().cortex.analyze(baseInput("null pointer in the cart service"));
    expect(out.source).toBe("llm");
    expect(fake.requests).toHaveLength(2);

    reset({ kind: "stream_error", code: "json_validate_failed" });
    const bad = await rig().cortex.analyze(baseInput("null pointer in the cart service"));
    expect(bad.degraded).toBe("bad_output");
    expect(fake.requests).toHaveLength(2);
  });

  it("switches from the strict schema to json_object when Groq rejects the schema, and remembers", async () => {
    reset({ kind: "status", status: 400, code: "invalid_request_error", message: "response_format.json_schema.schema: 'enum' is not supported here" }, { kind: "ok", json: canned });
    const { cortex } = rig({ cortex: { outputMode: "json_schema" } });
    expect(cortex.outputMode).toBe("json_schema");
    const out = await cortex.analyze(baseInput("null pointer in the cart service"));

    expect(out.source).toBe("llm");
    expect(fake.requests).toHaveLength(2);
    expect(bodyOf(0).response_format?.type).toBe("json_schema");
    expect(bodyOf(0).response_format?.json_schema?.strict).toBe(true);
    expect(JSON.stringify(bodyOf(0).response_format?.json_schema?.schema)).toContain('"enum"');
    expect(bodyOf(1).response_format).toEqual({ type: "json_object" });
    expect(cortex.outputMode).toBe("json_object");
    await cortex.analyze(baseInput("another thought entirely"));
    expect(bodyOf(2).response_format).toEqual({ type: "json_object" }); // no second schema attempt
  });

  describe("degrades to the local cortex, with the reason, and never retries a refusal", () => {
    it("auth failure: falls back, switches the live path off for 60 s with no further HTTP, then resumes", async () => {
      reset({ kind: "status", status: 401, code: "invalid_api_key", message: "Invalid API Key" }, { kind: "ok", json: canned });
      const { cortex, sent } = rig();
      const a = await cortex.analyze(baseInput("hello there friend"));
      expect(a.source).toBe("mock");
      expect(a.degraded).toBe("auth");
      expect(a.result.title).toBe("FALLBACK");
      expect(fake.requests).toHaveLength(1);

      clock.t += 30_000;
      const b = await cortex.analyze(baseInput("another thought entirely"));
      expect(b.degraded).toBe("llm_disabled");
      expect(fake.requests).toHaveLength(1); // no further HTTP while the window is open
      expect(sent).toHaveLength(1); // and nothing was audited as sent

      clock.t += 31_000; // past 60 s
      const c = await cortex.analyze(baseInput("a third thought entirely"));
      expect(c.source).toBe("llm");
      expect(fake.requests).toHaveLength(2);
    });

    it("429: honours retry-after with ONE request (no retry storm), then resumes", async () => {
      reset({ kind: "status", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached", retryAfter: "7" }, { kind: "ok", json: canned });
      const { cortex, client } = rig();
      const a = await cortex.analyze(baseInput("x y z w"));
      expect(a.degraded).toBe("rate_limit");
      expect(fake.requests).toHaveLength(1);
      expect(client.stats().rateLimited).toBe(1);

      clock.t += 3_000;
      expect((await cortex.analyze(baseInput("x y z w"))).degraded).toBe("rate_limit");
      expect(fake.requests).toHaveLength(1); // still cooling down: nothing went out

      clock.t += 4_500; // 7.5 s since the 429
      const c = await cortex.analyze(baseInput("x y z w"));
      expect(c.source).toBe("llm");
      expect(fake.requests).toHaveLength(2);
    });

    it("413 (request too large) degrades as too_large without disabling anything", async () => {
      reset({ kind: "status", status: 413, code: "rate_limit_exceeded", message: "Request too large for model on tokens per minute (TPM): Limit 8000, Requested 10179", retryAfter: "17" }, { kind: "ok", json: canned });
      const { cortex } = rig();
      expect((await cortex.analyze(baseInput("x y z w"))).degraded).toBe("too_large");
      expect((await cortex.analyze(baseInput("x y z w"))).source).toBe("llm");
    });

    it("a prompt that could never fit the minute budget is refused locally, before any HTTP", async () => {
      reset({ kind: "ok", json: canned });
      const { cortex, client } = rig({ client: { tpm: 1000 } });
      const out = await cortex.analyze(baseInput("x y z w"));
      expect(out.degraded).toBe("too_large");
      expect(fake.requests).toHaveLength(0);
      expect(client.stats().requestsToday).toBe(0);
    });

    it("server errors, truncated output, a cut stream and a dead socket each get their own reason", async () => {
      reset({ kind: "status", status: 503, code: "service_unavailable", message: "Service Unavailable" });
      expect((await rig().cortex.analyze(baseInput("x y z w"))).degraded).toBe("api_503");

      reset({ kind: "ok", json: canned, finishReason: "length" });
      expect((await rig().cortex.analyze(baseInput("x y z w"))).degraded).toBe("max_tokens");
      expect(fake.requests).toHaveLength(1); // a cut-off answer is not retried

      reset({ kind: "truncated", json: canned });
      expect((await rig().cortex.analyze(baseInput("x y z w"), () => undefined)).degraded).toBe("truncated");

      const dead = new GroqClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/openai/v1", now, sleep });
      const out = await new GroqCortex({ client: dead, model: MODEL, fallback, timeoutMs: 2000 }).analyze(baseInput("x y z w"));
      expect(out.degraded).toBe("network");
      expect(out.source).toBe("mock");
    });

    it("times out instead of stalling the pipeline", async () => {
      reset({ kind: "slow", delayMs: 1500 });
      const t0 = Date.now();
      const out = await rig({ cortex: { timeoutMs: 400 } }).cortex.analyze(baseInput("slow thought please"));
      expect(out.degraded).toBe("timeout");
      expect(out.source).toBe("mock");
      expect(Date.now() - t0).toBeLessThan(1400);
    });
  });

  describe("pacing to the free tier's tokens-per-minute budget", () => {
    // the fake enforces Groq's real admission rule: a call is refused (429) unless remaining >= prompt + max_completion_tokens
    let strict: FakeGroq;
    beforeAll(async () => {
      strict = await startFakeGroq({ now, enforceLimits: true });
    });
    afterAll(async () => {
      await strict.close();
    });
    beforeEach(() => strict.reset({ kind: "ok", json: canned, promptTokens: 2200, completionTokens: 300, chunkChars: 600, chunkDelayMs: 0 }));

    const pacedRig = (maxWaitMs: number) => {
      const client = new GroqClient({ apiKey: KEY, baseUrl: strict.url, now, sleep, maxWaitMs, tpm: 7000 });
      const sent: number[] = [];
      const cortex = new GroqCortex({ client, model: MODEL, fallback, timeoutMs: 4000, outputMode: "json_object", onCloudCall: () => sent.push(clock.t) });
      return { client, cortex, sent };
    };

    it("a realistic burst never reaches the server's limit: the calls it cannot afford degrade as 'paced' instead of earning a 429", async () => {
      const { cortex, client, sent } = pacedRig(2000);
      const outs: CortexOutput[] = [];
      for (let i = 0; i < 6; i++) {
        outs.push(await cortex.analyze(baseInput(`thought number ${i} about the cart service`)));
        clock.t += 1500; // 1.5 s between fragments
      }
      const live = outs.filter((o) => o.source === "llm").length;
      const paced = outs.filter((o) => o.degraded === "paced").length;
      expect(live).toBeGreaterThanOrEqual(2); // the first calls use the full bucket
      expect(paced).toBeGreaterThanOrEqual(3); // the rest degrade, quickly
      expect(live + paced).toBe(6);
      expect(strict.requests).toHaveLength(live); // every request that left was admitted: not one 429, not one 413
      expect(sent).toHaveLength(live); // and only those were audited as sent
      expect(client.stats().rateLimited).toBe(0);
      expect(client.stats().paced).toBe(paced);
    });

    it("waits for the budget when the wait is short enough, then recovers as the bucket refills", async () => {
      const { cortex, client } = pacedRig(30_000);
      const t0 = clock.t;
      for (let i = 0; i < 4; i++) {
        const out = await cortex.analyze(baseInput(`thought number ${i} about the cart service`));
        expect(out.source, `call ${i}`).toBe("llm");
      }
      expect(strict.requests).toHaveLength(4);
      expect(client.stats().rateLimited).toBe(0);
      // the later calls had to wait: about (reserved - available) / (7000 / 60 s) each
      expect(clock.t - t0).toBeGreaterThan(10_000);
      expect(clock.t - t0).toBeLessThan(60_000);

      // and after a quiet minute the bucket is full again
      clock.t += 60_000;
      expect(client.stats().bucketTokens).toBeGreaterThan(6900);
    });

    it("meters each model on its own, as Groq does: spending the fast model's minute leaves the deep model's budget alone", async () => {
      strict.reset({ kind: "ok", json: "ok", promptTokens: 6200, chunkChars: 600, chunkDelayMs: 0 }, { kind: "ok", json: "ok", promptTokens: 300, completionTokens: 10, chunkChars: 600, chunkDelayMs: 0 });
      const client = new GroqClient({ apiKey: KEY, baseUrl: strict.url, now, sleep, maxWaitMs: 100, tpm: 7000 });
      const ask = (model: string) => client.chat({ model, messages: [{ role: "user", content: "hello" }], maxCompletionTokens: 1500 });
      await ask("openai/gpt-oss-20b"); // the server reports 6,200 prompt tokens: this model's minute is nearly gone
      await expect(ask("openai/gpt-oss-20b")).rejects.toMatchObject({ kind: "paced" });
      await expect(ask("openai/gpt-oss-120b")).resolves.toMatchObject({ text: "ok" }); // a different model, a different bucket
      expect(strict.requests.map((r) => r.body.model)).toEqual(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
      const s = client.stats();
      expect(Object.keys(s.models).sort()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
      expect(s.models["openai/gpt-oss-20b"]!.bucketTokens).toBeLessThan(1000);
      expect(s.models["openai/gpt-oss-120b"]!.bucketTokens).toBeGreaterThan(6000);
      expect(s.bucketTokens).toBe(s.models["openai/gpt-oss-120b"]!.bucketTokens); // the headline bucket is the one used last
      expect(s.requestsToday).toBe(2);
    });

    it("reports how long a call queued for the budget separately from the model's own time (so benchmarks do not mistake queueing for latency)", async () => {
      strict.reset({ kind: "ok", json: "ok", promptTokens: 6200, chunkChars: 600, chunkDelayMs: 0 }, { kind: "ok", json: "ok", promptTokens: 300, completionTokens: 20, chunkChars: 600, chunkDelayMs: 0 });
      const client = new GroqClient({ apiKey: KEY, baseUrl: strict.url, now, sleep, maxWaitMs: 60_000, tpm: 7000 });
      const first = await client.chat({ model: MODEL, messages: [{ role: "user", content: "drain" }], maxCompletionTokens: 100 });
      expect(first.queuedMs).toBe(0);
      const sends: number[] = [];
      const second = await client.chat({ model: MODEL, messages: [{ role: "user", content: "hello" }], maxCompletionTokens: 1500 }, { onSend: (q) => sends.push(q) });
      expect(second.queuedMs).toBeGreaterThan(5_000); // about 1,650 tokens short at 116.7 tokens/s
      expect(second.queuedMs).toBeLessThan(20_000);
      expect(sends).toEqual([second.queuedMs]);
      expect(second.ms).toBeLessThan(2_000); // real time of the call itself: the wait ran on the injected clock
    });

    it("corrects its own books from the server's headers (another process shares the key)", async () => {
      strict.reset({ kind: "ok", json: canned, promptTokens: 400, completionTokens: 100, chunkChars: 600, chunkDelayMs: 0 });
      const client = new GroqClient({ apiKey: KEY, baseUrl: strict.url, now, sleep, maxWaitMs: 100, tpm: 7000 });
      await client.chat({ model: MODEL, messages: [{ role: "user", content: "hello" }], maxCompletionTokens: 100 });
      expect(client.stats().bucketTokens).toBeGreaterThan(6000);
      strict.drain(7000); // someone else spent the minute
      await client.chat({ model: MODEL, messages: [{ role: "user", content: "hello again" }], maxCompletionTokens: 100 }).catch(() => undefined);
      const s = client.stats();
      expect(s.remainingTokensLastSeen).not.toBeNull();
      expect(s.remainingTokensLastSeen as number).toBeLessThan(1500);
      expect(s.bucketTokens).toBeLessThan(500); // the local bucket now agrees with the server instead of believing it is full
    });
  });

  it("caps requests per day locally (the free tier allows 1,000) and starts a new count on a new UTC day", async () => {
    reset({ kind: "ok", json: canned });
    const { cortex, client, sent } = rig({ client: { maxRequestsPerDay: 2 } });
    expect((await cortex.analyze(baseInput("one thought here"))).source).toBe("llm");
    expect((await cortex.analyze(baseInput("two thoughts here"))).source).toBe("llm");
    const third = await cortex.analyze(baseInput("three thoughts here"));
    expect(third.degraded).toBe("daily_cap");
    expect(fake.requests).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(client.stats()).toMatchObject({ requestsToday: 2, maxRequestsPerDay: 2 });

    clock.t += 24 * 3600_000;
    expect((await cortex.analyze(baseInput("a fourth thought here"))).source).toBe("llm");
    expect(client.stats().requestsToday).toBe(1);
  });

  it("exposes counters for /api/health: requests today, the last remaining-token reading, the pacing state (no content)", async () => {
    reset({ kind: "ok", json: canned });
    const { cortex, client } = rig();
    await cortex.analyze(baseInput("one thought here"));
    const s = client.stats();
    expect(s.requestsToday).toBe(1);
    expect(s.day).toBe("2026-10-06");
    expect(s.remainingTokensLastSeen).toBeGreaterThan(0);
    expect(s.limitTokens).toBe(8000);
    expect(s.tpmBudget).toBe(7000);
    expect(s.lastStatus).toBe(200);
    expect(JSON.stringify(s)).not.toContain(KEY);
  });

  it("warm() opens the connection with a free GET /models: no tokens, not counted as a request", async () => {
    reset({ kind: "ok", json: canned });
    const { cortex, client } = rig();
    await cortex.warm();
    expect(client.stats().requestsToday).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("a revision the model mislabelled as a retraction", () => {
  const revision = (over: Partial<CortexResult> = {}): CortexResult => ({
    ...canned,
    thread_relation: "correction_of_previous",
    category: "correction",
    title: "Sync with vendor on Monday",
    artifact: { kind: "calendar_event", title: "Sync with vendor", start_iso: "2026-10-12T15:00:00+05:30", end_iso: "2026-10-12T15:30:00+05:30", time_expression: "Monday 3pm", attendees: ["vendor"], is_reschedule: true },
    ...over,
  });
  const last = { ref: "T-216", result: { category: "scheduling" as const, title: "Sync with vendor on Thursday" } };

  it("is relabelled as the card it revises: the engine reads category 'correction' as a retraction and would delete that card", async () => {
    reset({ kind: "ok", json: revision() });
    const out = await rig().cortex.analyze(baseInput("No wait, make it Monday instead", { lastCard: last }));
    expect(out.source).toBe("llm");
    expect(out.result).toMatchObject({ category: "scheduling", thread_relation: "correction_of_previous" });
    expect(out.result.artifact.kind).toBe("calendar_event");
  });

  it("only a real retraction (no artifact) stays category correction", async () => {
    reset({ kind: "ok", json: revision({ artifact: { kind: "none" } }) });
    const out = await rig().cortex.analyze(baseInput("Scratch that", { lastCard: last }));
    expect(out.result).toMatchObject({ category: "correction", artifact: { kind: "none" } });
  });

  it("falls back to the artifact's own category when there is no last card to name, and never invents one for a retraction", () => {
    expect(relabelRevision(revision(), null).category).toBe("scheduling");
    expect(relabelRevision(revision({ artifact: { kind: "ticket", title: "t", description: "d", issue_type: "task", priority: "low", labels: [], component: null, acceptance_criteria: [] } }), null).category).toBe("action");
    const retraction = revision({ artifact: { kind: "none" } });
    expect(relabelRevision(retraction, last)).toBe(retraction);
    const other = { ...canned, category: "bug" as const };
    expect(relabelRevision(other, last)).toBe(other); // not a correction at all
    // a last card that is itself a "correction" is no help: use the artifact
    expect(relabelRevision(revision(), { ref: "T-1", result: { category: "correction" } }).category).toBe("scheduling");
  });
});

describe("GroqClient windows", () => {
  const hi = (c: GroqClient) => c.chat({ model: MODEL, messages: [{ role: "user", content: "hi" }], maxCompletionTokens: 50 });

  it("a call refused during a 429 cool-down neither extends the cool-down nor counts as another 429", async () => {
    reset({ kind: "status", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached", retryAfter: "10" }, { kind: "ok", json: "ok", chunkChars: 100, chunkDelayMs: 0 });
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep });
    await expect(hi(client)).rejects.toMatchObject({ kind: "rate_limit", status: 429, retryAfterMs: 10_000 });
    clock.t += 9_800;
    await expect(hi(client)).rejects.toMatchObject({ kind: "rate_limit" }); // refused here, nothing sent
    expect(fake.requests).toHaveLength(1);
    clock.t += 300; // 10.1 s after the 429: the server's retry-after has passed, and the refusal above did not move it
    await expect(hi(client)).resolves.toMatchObject({ text: "ok" });
    expect(client.stats().rateLimited).toBe(1);
  });

  it("a call refused during the 60 s auth window does not restart it", async () => {
    reset({ kind: "status", status: 401, code: "invalid_api_key", message: "Invalid API Key" }, { kind: "ok", json: "ok", chunkChars: 100, chunkDelayMs: 0 });
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep });
    await expect(hi(client)).rejects.toMatchObject({ kind: "auth" });
    clock.t += 59_000;
    await expect(hi(client)).rejects.toMatchObject({ kind: "auth" });
    expect(client.disabledReason).toBe("auth");
    expect(fake.requests).toHaveLength(1);
    clock.t += 2_000; // 61 s after the failure
    expect(client.disabledReason).toBeNull();
    await expect(hi(client)).resolves.toMatchObject({ text: "ok" });
  });

  it("a 429 about another limit (per day) is honoured by retry-after but never read as this minute's numbers: its 'Used' is on another scale and would wreck the bucket", async () => {
    reset({ kind: "status", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached for model `m` on tokens per day (TPD): Limit 500000, Used 499100, Requested 3500. Please try again in 9m.", retryAfter: "5" });
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep, tpm: 7000 });
    await expect(hi(client)).rejects.toMatchObject({ kind: "rate_limit", message: expect.stringContaining("(TPD)"), limits: undefined });
    clock.t += 6_000; // past the retry-after
    expect(client.disabledReason).toBeNull();
    expect(client.stats().bucketTokens).toBeGreaterThan(-1000); // recovering from the retry-after, not 490,000 tokens in debt
  });

  it("after a failed connection or a timeout it skips the cloud for 4 s, so a flaky network does not hold every fragment for a whole timeout", async () => {
    const dead = new GroqClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/openai/v1", now, sleep });
    await expect(hi(dead)).rejects.toMatchObject({ kind: "network" });
    expect(dead.stats().requestsToday).toBe(1);
    await expect(hi(dead)).rejects.toMatchObject({ kind: "network" }); // refused here: no second attempt at the socket
    expect(dead.stats().requestsToday).toBe(1);
    clock.t += 4_100;
    await expect(hi(dead)).rejects.toMatchObject({ kind: "network" });
    expect(dead.stats().requestsToday).toBe(2);

    reset({ kind: "slow", delayMs: 1500 }, { kind: "ok", json: "ok", chunkChars: 100, chunkDelayMs: 0 });
    const slow = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep });
    await expect(slow.chat({ model: MODEL, messages: [{ role: "user", content: "hi" }], maxCompletionTokens: 50 }, { timeoutMs: 300 })).rejects.toMatchObject({ kind: "timeout" });
    await expect(hi(slow)).rejects.toMatchObject({ kind: "network" });
    expect(fake.requests).toHaveLength(1); // the second call never left
    clock.t += 4_100;
    await expect(hi(slow)).resolves.toMatchObject({ text: "ok" });
    expect(slow.stats().rateLimited).toBe(0); // a 429 window it is not
  });

  it("one queue per model: a deep call parked waiting for ITS budget does not hold up the hot path's call", async () => {
    reset({ kind: "ok", json: "ok", promptTokens: 6200, chunkChars: 100, chunkDelayMs: 0 }, { kind: "ok", json: "ok", chunkChars: 100, chunkDelayMs: 0 });
    const sleepers: Array<() => void> = [];
    const client = new GroqClient({
      apiKey: KEY, baseUrl: fake.url, now, tpm: 7000, maxWaitMs: 60_000,
      sleep: (ms) => new Promise<void>((r) => sleepers.push(() => { clock.t += ms; r(); })), // parks until the test lets it go
    });
    const ask = (model: string) => client.chat({ model, messages: [{ role: "user", content: "hello" }], maxCompletionTokens: 1500 });
    await ask("openai/gpt-oss-120b"); // the server reports 6,200 prompt tokens: the deep model's minute is spent
    const deepWaiting = ask("openai/gpt-oss-120b"); // needs ~6 s of refill, so it parks in its sleep
    await vi.waitFor(() => expect(sleepers).toHaveLength(1));
    const hot = await ask("qwen/qwen3.8-27b"); // a different model: straight through, not queued behind the parked call
    expect(hot.text).toBe("ok");
    expect(sleepers).toHaveLength(1); // the deep call is still parked
    sleepers.shift()!();
    await expect(deepWaiting).resolves.toMatchObject({ text: "ok" });
  });

  it("a 429 body's own numbers correct the bucket: it believes what the server says is already spent", async () => {
    reset({ kind: "status", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached for model `m` on tokens per minute (TPM): Limit 8000, Used 7600, Requested 3100. Please try again in 5s.", retryAfter: "5" });
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep, tpm: 7000 });
    await expect(hi(client)).rejects.toMatchObject({ kind: "rate_limit", limits: { limit: 8000, used: 7600, requested: 3100 } });
    expect(client.stats().bucketTokens).toBeLessThanOrEqual(0); // 7000 - 7600
  });
});

describe("token bucket and helpers", () => {
  it("refills continuously at tpm/60 per second and reports how long a request must wait", () => {
    let t = 0;
    const b = new TokenBucket(7000, 7000, () => t);
    expect(b.available()).toBe(7000);
    b.take(5000);
    expect(b.waitFor(1000)).toBe(0);
    expect(b.waitFor(4000)).toBe(Math.ceil((2000 * 60_000) / 7000)); // 2000 short at 116.7 tokens/s
    t += 30_000;
    expect(Math.round(b.available())).toBe(2000 + 3500);
    t += 600_000;
    expect(b.available()).toBe(7000); // never above capacity
    expect(b.waitFor(7001)).toBe(Infinity);
  });

  it("give() returns an unused reservation, take() can overdraw, clampTo() only ever lowers", () => {
    let t = 0;
    const b = new TokenBucket(1000, 600, () => t);
    b.take(800);
    b.give(300);
    expect(b.available()).toBe(500);
    b.take(900);
    expect(b.available()).toBe(-400);
    expect(b.waitFor(100)).toBe(Math.ceil((500 * 60_000) / 600));
    b.clampTo(5000);
    expect(b.available()).toBe(-400);
    t += 120_000;
    b.clampTo(200);
    expect(b.available()).toBe(200);
  });

  it("parses Groq's duration headers", () => {
    expect(parseDuration("1m26.4s")).toBe(86_400);
    expect(parseDuration("855ms")).toBe(855);
    expect(parseDuration("2.227s")).toBe(2227);
    expect(parseDuration("7m12s")).toBe(432_000);
    expect(parseDuration("17")).toBe(17_000); // retry-after is plain seconds
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("soon")).toBeUndefined();
  });

  it("extractJson and withEmptyDefaults", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow();
    const filled = withEmptyDefaults({ category: "bug", confidence: "0.8", artifact: { kind: "ticket", title: "t", description: "d", issue_type: "task", priority: "low" } }) as Record<string, unknown>;
    expect(filled).toMatchObject({ confidence: 0.8, references: [], concern_key: null, why: "", thread_relation: "continue" });
    expect(filled.artifact).toMatchObject({ labels: [], component: null, acceptance_criteria: [] });
    // content is never invented: a missing title is still missing
    expect(CortexResultSchema.safeParse(withEmptyDefaults({ category: "bug", confidence: 0.8, artifact: { kind: "none" } })).success).toBe(false);
    expect(withEmptyDefaults("nope")).toBe("nope");
  });
});

describe("the compact prompt", () => {
  const system = liteSystemPrompt();

  it("fits the free tier: far smaller than the Claude prompt, and static", () => {
    expect(system.length).toBeLessThan(8200); // about 2.1k tokens
    expect(liteSystemPrompt()).toBe(system);
    expect(system).not.toContain("<thread ref="); // the examples carry no thread ids: nothing in the static part changes per request
  });

  it("names every category, artifact kind and enum value the schema accepts", () => {
    for (const c of CATEGORIES) expect(LITE_INSTRUCTIONS, c).toContain(c);
    for (const k of ARTIFACT_KINDS) expect(LITE_INSTRUCTIONS, k).toContain(k === "none" ? "none {kind}" : `${k} {kind`);
    for (const e of ENTITY_TYPES) expect(LITE_INSTRUCTIONS, e).toContain(e);
    for (const c of SALIENCE_CUES) expect(LITE_INSTRUCTIONS, c).toContain(c);
    for (const w of ["task|story|bug|spike", "low|medium|high|urgent", "casual|neutral|formal", "slack|whatsapp|sms|other", "tentative|decided", "continue", "new_thought", "correction_of_previous"]) expect(LITE_INSTRUCTIONS, w).toContain(w);
  });

  it("keeps the privacy prohibitions and the abstention rule", () => {
    expect(LITE_INSTRUCTIONS).toMatch(/do not infer emotions, health, mental state or relationships/i);
    expect(LITE_INSTRUCTIONS).toMatch(/do not identify speakers/i);
    expect(LITE_INSTRUCTIONS).toMatch(/speech to another person are "aside"/);
    expect(LITE_INSTRUCTIONS).toMatch(/Never invent/);
    expect(LITE_INSTRUCTIONS).toMatch(/\[EMAIL_1\]/);
  });

  it("its worked examples are valid CortexResults, and share the one <now>/<user> header the prompt prints once", () => {
    expect(LITE_EXAMPLE_OUTPUTS.length).toBeGreaterThanOrEqual(2);
    for (const ex of LITE_EXAMPLE_OUTPUTS) expect(CortexResultSchema.safeParse(ex).success).toBe(true);
    for (const ex of LITE_EXAMPLE_OUTPUTS) expect(system).toContain(JSON.stringify(ex));
    const headers = new Set(LITE_EXAMPLE_INDEXES.map((i) => renderUserMessage({ ...EXAMPLES[i]!.input, vocabulary: [] }).split("\n").slice(0, 2).join("\n")));
    expect(headers.size).toBe(1);
    expect((system.match(/<now>\d{4}-/g) ?? []).length).toBe(1); // printed once, not once per example
  });

  it("hands the model the calendar (weekday arithmetic is where small models slip), in the user's time zone and DST-proof", () => {
    const line = daysLine(Date.parse("2026-10-06T15:42:10+05:30"), "Asia/Kolkata");
    expect(line).toBe("<days>Tue 2026-10-06 (today), Wed 2026-10-07, Thu 2026-10-08, Fri 2026-10-09, Sat 2026-10-10, Sun 2026-10-11, Mon 2026-10-12, Tue 2026-10-13</days>");
    // 23:30 the evening before a US spring-forward: a naive "+24 h" lands on Monday and skips Sunday the 8th
    expect(daysLine(Date.parse("2026-03-07T23:30:00-05:00"), "America/New_York")).toContain("Sat 2026-03-07 (today), Sun 2026-03-08, Mon 2026-03-09");
    // late evening UTC is already tomorrow in Kolkata: "today" follows the user's zone
    expect(daysLine(Date.parse("2026-10-06T20:00:00Z"), "Asia/Kolkata")).toContain("Wed 2026-10-07 (today)");
    expect(renderLiteUserMessage(baseInput("hello")).split("\n")[1]).toBe(line);
    expect(LITE_INSTRUCTIONS).toContain("<days>");
  });

  it("the per-call message is trimmed to a small budget", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: "x", ref: `T-${i}`, kind: "thought" as const, label: "l".repeat(300), snippet: "s".repeat(600), score: 0.5 }));
    const msg = renderLiteUserMessage(
      baseInput("hello", {
        candidates: many,
        vocabulary: Array.from({ length: 80 }, (_, i) => `term${i}`),
        recent: Array.from({ length: 9 }, (_, i) => ({ ref: `T-${i}`, title: "t", category: "idea" as const, when: 0 })),
        previous: canned,
        lastCard: { ref: "T-3", result: { category: "action", title: "x".repeat(900) } },
      }),
    );
    expect((msg.match(/<c ref=/g) ?? []).length).toBe(5);
    expect(msg).not.toContain("term25");
    expect(msg.length).toBeLessThan(3500);
    expect(msg).toContain("<previous_card>");
    expect(msg).toContain('<last_card ref="T-3">');
    expect(msg).not.toContain("**Summary**"); // the previous card is reduced to its category, title, intent and artifact kind
  });
});
