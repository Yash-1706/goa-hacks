import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config";
import { DeepLlm } from "../src/llm/deep";
import { GroqClient } from "../src/llm/groq-client";
import { startFakeGroq, type FakeGroq, type FakeMode } from "./fake-groq";

/**
 * DeepLlm over Groq (LLM_PROVIDER=groq): the same public surface as the Claude path (available, model, stream, json), served by
 * GROQ_MODEL_DEEP with reasoning_effort "medium", the shared pacing client, and the same redaction round trip. Callers
 * (recall answers, the session brief, consolidation labels) are unchanged; they only ever see text, a parsed object, or null.
 */

const KEY = "gs\u006b_test_key_not_real_0000000000";
const clock = { t: Date.parse("2026-10-06T10:00:00Z") };
const now = (): number => clock.t;
const sleep = async (ms: number): Promise<void> => {
  clock.t += ms;
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

const BriefLike = z.object({ headline: z.string(), tasks: z.array(z.object({ title: z.string(), thought_code: z.string() })), open_loops: z.array(z.string()) });
const brief = { headline: "Two bugs, one decision", tasks: [{ title: "Fix the discount NPE", thought_code: "T-181" }], open_loops: [] };

function make(o: { localOnly?: boolean; env?: Record<string, string>; client?: Partial<ConstructorParameters<typeof GroqClient>[0]> } = {}) {
  const cfg = loadConfig({ LLM_MODE: "live", LLM_PROVIDER: "groq", ANTHROPIC_API_KEY: "", GROQ_API_KEY: KEY, GROQ_BASE_URL: fake.url, LOCAL_ONLY: "0", ...o.env });
  const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep, maxWaitMs: 2000, ...o.client });
  const sent: Array<{ model: string; redactions: number }> = [];
  const deep = new DeepLlm(cfg, { isLocalOnly: () => Boolean(o.localOnly), onCloudCall: (i) => sent.push(i), groq: client });
  return { deep, client, sent, cfg };
}
const reset = (...script: FakeMode[]): void => fake.reset(...script);
const bodyOf = (i: number): { model: string; messages: Array<{ role: string; content: string }>; reasoning_effort?: string; max_completion_tokens?: number; stream?: boolean; response_format?: { type: string; json_schema?: { name?: string; strict?: boolean; schema?: { properties?: Record<string, unknown> } } } } => fake.requests[i]!.body as never;

describe("DeepLlm over Groq", () => {
  it("is the same surface: available, the deep model id, and nothing without a live groq provider", () => {
    const { deep, cfg } = make();
    expect(cfg.llm.provider).toBe("groq");
    expect(deep.available).toBe(true);
    expect(deep.model).toBe("openai/gpt-oss-120b");
    expect(make({ localOnly: true }).deep.available).toBe(false);
    // mock provider: a Groq key alone does not make the deep path live
    expect(make({ env: { LLM_MODE: "mock" } }).deep.available).toBe(false);
  });

  it("streams a recall answer with the deep model at medium reasoning and a tight allowance, and audits the call (model + count only)", async () => {
    reset({ kind: "ok", json: "You had that idea on a walk, see [T-12]. I could not find the date.", chunkChars: 10, chunkDelayMs: 0, promptTokens: 700, completionTokens: 90 });
    const { deep, sent } = make();
    const deltas: string[] = [];
    const out = await deep.stream({ system: "Answer from the sources only.", user: "Question: what was that caching idea?\nSources:\n[T-12] a walk", maxTokens: 1500, onDelta: (d) => deltas.push(d) });

    expect(out?.text).toBe("You had that idea on a walk, see [T-12]. I could not find the date.");
    expect(deltas.join("")).toBe(out?.text);
    expect(deltas.length).toBeGreaterThan(3);
    expect(out?.usage).toEqual({ inputTokens: 700, outputTokens: 90 });
    const b = bodyOf(0);
    expect(b.model).toBe("openai/gpt-oss-120b");
    expect(b.reasoning_effort).toBe("medium");
    expect(b.stream).toBe(true);
    expect(b.max_completion_tokens).toBeLessThanOrEqual(1100);
    expect(b.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(sent).toEqual([{ model: "openai/gpt-oss-120b", redactions: 0 }]);
  });

  it("redacts the prompt and restores values in the stream even when a placeholder is split across deltas", async () => {
    reset({ kind: "ok", json: "Write to [EMAIL_1] about it, then check [T-3].", chunkChars: 3, chunkDelayMs: 0 });
    const { deep, sent } = make();
    const deltas: string[] = [];
    const out = await deep.stream({ system: "s", user: "Sources:\n[T-3] mail rio@example.com the plan", onDelta: (d) => deltas.push(d) });

    expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain("rio@example.com");
    expect(out?.text).toBe("Write to rio@example.com about it, then check [T-3].");
    expect(deltas.join("")).toBe(out?.text);
    for (const d of deltas) expect(d).not.toMatch(/\[EMA|IL_1\]/); // never half a placeholder
    expect(sent[0]?.redactions).toBe(1);
  });

  it("a delta consumer that throws does not fail the answer: the full text is still returned", async () => {
    reset({ kind: "ok", json: "You noted it on a walk [T-12].", chunkChars: 6, chunkDelayMs: 0 });
    const out = await make().deep.stream({
      system: "s",
      user: "u",
      onDelta: () => {
        throw new Error("socket closed");
      },
    });
    expect(out?.text).toBe("You noted it on a walk [T-12].");
  });

  it("an empty or failed stream is null so the caller keeps its local answer", async () => {
    reset({ kind: "ok", json: "   ", chunkChars: 10, chunkDelayMs: 0 });
    expect(await make().deep.stream({ system: "s", user: "u", onDelta: () => undefined })).toBeNull();
    reset({ kind: "status", status: 503, code: "service_unavailable", message: "down" });
    expect(await make().deep.stream({ system: "s", user: "u", onDelta: () => undefined })).toBeNull();
  });

  it("returns structured JSON validated by the caller's zod schema, decoded against it (strict json_schema)", async () => {
    reset({ kind: "ok", json: brief });
    const { deep } = make();
    const out = await deep.json({ system: "Write a session brief.", user: "Thoughts:\n[T-181] bug: discount NPE", schema: BriefLike, maxTokens: 3000 });

    expect(out).toEqual(brief);
    const b = bodyOf(0);
    expect(b.stream).toBe(false);
    expect(b.reasoning_effort).toBe("medium");
    expect(b.max_completion_tokens).toBeLessThanOrEqual(1800);
    expect(b.response_format?.type).toBe("json_schema");
    expect(b.response_format?.json_schema).toMatchObject({ name: "result", strict: true });
    expect(Object.keys(b.response_format?.json_schema?.schema?.properties ?? {})).toEqual(["headline", "tasks", "open_loops"]);
  });

  it("an answer that does not fit the schema gets ONE more try with the schema spelled out in the prompt, then null", async () => {
    reset({ kind: "ok", json: { headline: 5 } }, { kind: "ok", json: brief });
    const { deep } = make();
    expect(await deep.json({ system: "Write a session brief.", user: "u", schema: BriefLike })).toEqual(brief);
    expect(fake.requests).toHaveLength(2);
    expect(bodyOf(1).response_format).toEqual({ type: "json_object" });
    expect(bodyOf(1).messages[0]?.content).toContain("JSON Schema");
    expect(bodyOf(1).messages[0]?.content).toContain("open_loops");

    reset({ kind: "ok", json: { headline: 5 } });
    expect(await make().deep.json({ system: "s", user: "u", schema: BriefLike })).toBeNull();
    expect(fake.requests).toHaveLength(2); // never a third
  });

  it("falls back to json_object when Groq rejects the schema", async () => {
    reset({ kind: "status", status: 400, code: "invalid_request_error", message: "response_format.json_schema: unsupported keyword" }, { kind: "ok", json: brief });
    expect(await make().deep.json({ system: "s", user: "u", schema: BriefLike })).toEqual(brief);
    expect(bodyOf(1).response_format).toEqual({ type: "json_object" });
  });

  it("restores redacted values in structured output", async () => {
    reset({ kind: "ok", json: { headline: "Mail [EMAIL_1]", tasks: [], open_loops: [] } });
    const out = await make().deep.json({ system: "s", user: "Thoughts:\n[T-1] mail rio@example.com", schema: BriefLike });
    expect(out?.headline).toBe("Mail rio@example.com");
    expect(JSON.stringify(fake.requests[0]?.body)).not.toContain("rio@example.com");
  });

  it("a cut-off answer is null, never a half-parsed object", async () => {
    reset({ kind: "ok", json: brief, finishReason: "length" });
    expect(await make().deep.json({ system: "s", user: "u", schema: BriefLike })).toBeNull();
  });

  it("local-only: nothing is sent and the call is null", async () => {
    reset({ kind: "ok", json: brief });
    const { deep, sent } = make({ localOnly: true });
    expect(await deep.stream({ system: "s", user: "u", onDelta: () => undefined })).toBeNull();
    expect(await deep.json({ system: "s", user: "u", schema: BriefLike })).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("an auth failure switches the deep path off for 60 s (shared with the fast cortex), then it resumes", async () => {
    reset({ kind: "status", status: 401, code: "invalid_api_key", message: "Invalid API Key" }, { kind: "ok", json: brief });
    const { deep } = make();
    expect(await deep.json({ system: "s", user: "u", schema: BriefLike })).toBeNull();
    expect(deep.available).toBe(false);
    expect(await deep.json({ system: "s", user: "u", schema: BriefLike })).toBeNull();
    expect(fake.requests).toHaveLength(1);
    clock.t += 61_000;
    expect(deep.available).toBe(true);
    expect(await deep.json({ system: "s", user: "u", schema: BriefLike })).toEqual(brief);
  });

  it("a 429 pauses it for retry-after, with one request", async () => {
    reset({ kind: "status", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached", retryAfter: "4" }, { kind: "ok", json: brief });
    const { deep } = make();
    expect(await deep.json({ system: "s", user: "u", schema: BriefLike })).toBeNull();
    expect(deep.available).toBe(false);
    clock.t += 4_500;
    expect(deep.available).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it("waits for the token budget longer than the interactive path would (a brief is not latency critical) before giving up", async () => {
    // a nearly empty bucket: the wait for a ~2k-token call is about 10 s, which the 20 s allowance for structured work covers
    reset({ kind: "ok", json: "ok", promptTokens: 6200 }, { kind: "ok", json: brief, promptTokens: 400, completionTokens: 100 });
    const { deep, client } = make({ client: { tpm: 7000 } });
    await client.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "drain" }], maxCompletionTokens: 100 }); // the server reports 6,200 prompt tokens: most of the bucket is gone
    expect(client.stats().bucketTokens).toBeLessThan(1000);
    const t0 = clock.t;
    expect(await deep.json({ system: "s", user: "u", schema: BriefLike })).toEqual(brief);
    expect(clock.t - t0).toBeGreaterThan(2000);
  });
});
