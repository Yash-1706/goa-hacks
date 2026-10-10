import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CortexResult } from "@synapse/shared";
import { EXAMPLE_OUTPUTS } from "../src/cortex/prompts";
import type { CortexBackend, CortexInput, CortexOutput } from "../src/cortex/types";
import { FailoverBackend } from "../src/llm/failover";
import { GroqCortex } from "../src/llm/groq";
import { GroqClient, GroqError } from "../src/llm/groq-client";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeGroq, type FakeGroq, type FakeMode } from "./fake-groq";

/**
 * Groq meters tokens and requests per model, and a free account reaches its DAILY cap on one model long before the other
 * (measured: a day of testing exhausted Qwen while gpt-oss still had room). A 429 therefore pauses only the model it came from, a
 * daily limit is respected for far longer than a per-minute one, and the fast cortex asks the other model before it gives up and
 * hands the card to the offline cortex.
 */

const canned: CortexResult = EXAMPLE_OUTPUTS[0] as CortexResult;
const KEY = "gs\u006b_test_key_not_real_0000000000";
const FAST = "qwen/qwen3.8-27b";
const SPARE = "openai/gpt-oss-120b";

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

const tpm = (model: string, retryAfter = "7"): FakeMode => ({
  kind: "status",
  status: 429,
  code: "rate_limit_exceeded",
  message: `Rate limit reached for model \`${model}\` in organization \`org_fake\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1500. Please try again in ${retryAfter}s.`,
  retryAfter,
});
const tpd = (model: string, retryAfter = "1023"): FakeMode => ({
  kind: "status",
  status: 429,
  code: "rate_limit_exceeded",
  message: `Rate limit reached for model \`${model}\` in organization \`org_fake\` service tier \`on_demand\` on tokens per day (TPD): Limit 500000, Used 499500, Requested 2000. Please try again in 17m3s.`,
  retryAfter,
});
const ok: FakeMode = { kind: "ok", json: canned, chunkChars: 400, chunkDelayMs: 0 };
const modelsAsked = (): string[] => fake.requests.map((r) => String(r.body.model));

const baseInput = (text: string): CortexInput => ({
  now: Date.parse("2026-10-06T15:42:10+05:30"),
  timezone: "Asia/Kolkata",
  user: { name: "Rio", role: "backend engineer", team: [{ name: "Sarah", role: "PM" }] },
  device: { kind: "desk", activity: "desk" },
  threadRef: "T-9",
  fragments: [{ id: "F1", dtMs: 0, text, whisper: false, pauseBeforeMs: 0 }],
  previous: null,
  lastCard: null,
  candidates: [],
  recent: [],
  triage: {} as never,
  vocabulary: [],
});
const fallback: CortexBackend = {
  name: "stub-mock",
  async analyze(): Promise<CortexOutput> {
    return { result: { ...canned, title: "FALLBACK" }, source: "mock", model: "heuristic", ms: 1, redactions: 0 };
  },
};
const ask = { messages: [{ role: "user" as const, content: "hello" }], maxCompletionTokens: 50 };

describe("a 429 pauses only the model it came from", () => {
  it("the refused model is paused, the other one is not, and the pause ends when the server said it would", async () => {
    fake.reset(tpm("model-a", "7"), ok);
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep });
    await expect(client.chat({ model: "model-a", ...ask })).rejects.toMatchObject({ kind: "rate_limit" });

    expect(client.disabledReasonFor("model-a")).toBe("rate_limit");
    expect(client.disabledReasonFor("model-b")).toBeNull();
    expect(client.disabledReason).toBe("rate_limit"); // "is anything paused" keeps its old meaning
    expect(Object.keys(client.cooling())).toEqual(["model-a"]);
    expect(client.stats().cooling).toEqual(client.cooling());

    // the other model answers; the paused one is refused locally, without a request
    await expect(client.chat({ model: "model-b", ...ask })).resolves.toMatchObject({ finishReason: "stop" });
    const before = fake.requests.length;
    const refused = await client.chat({ model: "model-a", ...ask }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(GroqError);
    expect(refused).toMatchObject({ kind: "rate_limit" });
    expect((refused as GroqError).message).toContain("model-a");
    expect(fake.requests.length).toBe(before);

    clock.t += 7_500; // the server said 7 s
    expect(client.disabledReasonFor("model-a")).toBeNull();
    expect(client.disabledReason).toBeNull();
    fake.reset(ok);
    await expect(client.chat({ model: "model-a", ...ask })).resolves.toMatchObject({ finishReason: "stop" });
  });

  it("a per-minute pause is capped at two minutes; a DAILY limit is respected for as long as the server says, up to half an hour", async () => {
    const pause = async (mode: FakeMode): Promise<number> => {
      fake.reset(mode);
      const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep });
      await client.chat({ model: "m", ...ask }).catch(() => undefined);
      return client.disabledUntilFor("m") - now();
    };
    expect(await pause(tpm("m", "7"))).toBe(7_000);
    expect(await pause(tpm("m", "900"))).toBe(120_000); // a minute limit never needs more than the cap
    expect(await pause(tpd("m", "1023"))).toBe(1_023_000);
    expect(await pause(tpd("m", "86400"))).toBe(30 * 60_000); // "try again in a day": check back in half an hour
  });

  it("a lost connection pauses every model, not one: the problem is the link", async () => {
    const client = new GroqClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/openai/v1", now, sleep });
    await expect(client.chat({ model: "model-a", ...ask })).rejects.toMatchObject({ kind: "network" });
    expect(client.disabledReasonFor("model-a")).toBe("network");
    expect(client.disabledReasonFor("model-b")).toBe("network");
    clock.t += 4_500;
    expect(client.disabledReasonFor("model-b")).toBeNull();
  });

  it("an authentication failure is key-wide", async () => {
    fake.reset({ kind: "status", status: 401, code: "invalid_api_key", message: "Invalid API Key" });
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep });
    await expect(client.chat({ model: "model-a", ...ask })).rejects.toMatchObject({ kind: "auth" });
    expect(client.disabledReasonFor("model-b")).toBe("auth");
  });
});

describe("the fast cortex falls over to the spare model", () => {
  const build = (): { fo: FailoverBackend; client: GroqClient; sent: string[] } => {
    const sent: string[] = [];
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep, tpm: 1_000_000 });
    const mk = (model: string): GroqCortex => new GroqCortex({ client, model, fallback, outputMode: "json_object", timeoutMs: 20_000, onCloudCall: (i) => sent.push(i.model) });
    return { fo: new FailoverBackend(mk(FAST), mk(SPARE)), client, sent };
  };

  it("a day on which the fast model is capped: the card still comes from the model, and the capped one is left alone until its pause ends", async () => {
    fake.reset(tpd(FAST), ok);
    const { fo, sent } = build();

    const first = await fo.analyze(baseInput("null pointer in the cart service"));
    expect(first.source).toBe("llm");
    expect(first.degraded).toBeUndefined();
    expect(first.model).toBe(SPARE);
    expect(modelsAsked()).toEqual([FAST, SPARE]); // refused once, then the spare

    const second = await fo.analyze(baseInput("the discount code throws again"));
    expect(second.model).toBe(SPARE);
    expect(modelsAsked()).toEqual([FAST, SPARE, SPARE]); // the capped model is not asked again (no wasted request, no second 429)

    clock.t += 1_100_000; // the pause (1,023 s) is over
    fake.reset(ok);
    const third = await fo.analyze(baseInput("one more thing about the cart"));
    expect(third.model).toBe(FAST); // the fast model is back
    expect(modelsAsked()).toEqual([FAST]);
    expect(sent).toEqual([FAST, SPARE, SPARE, FAST]); // every request that really left the machine was reported, and only those
  });

  it("a healthy fast model never touches the spare", async () => {
    fake.reset(ok);
    const { fo } = build();
    for (let i = 0; i < 3; i++) expect((await fo.analyze(baseInput(`bug number ${i} in the cart service`))).model).toBe(FAST);
    expect(modelsAsked()).toEqual([FAST, FAST, FAST]);
  });

  it("both models capped: the offline cortex answers, labelled rate_limit, and nothing more is requested until a pause ends", async () => {
    fake.reset(tpd(FAST), tpd(SPARE));
    const { fo } = build();
    const out = await fo.analyze(baseInput("null pointer in the cart service"));
    expect(out.source).toBe("mock");
    expect(out.degraded).toBe("rate_limit");
    expect(modelsAsked()).toEqual([FAST, SPARE]);

    const again = await fo.analyze(baseInput("and another one"));
    expect(again.degraded).toBe("rate_limit");
    expect(modelsAsked()).toEqual([FAST, SPARE]); // both paused: no request leaves the machine
  });

  it("only a rate limit fails over: a bad key is the same on both models", async () => {
    fake.reset({ kind: "status", status: 401, code: "invalid_api_key", message: "Invalid API Key" });
    const { fo } = build();
    const out = await fo.analyze(baseInput("null pointer in the cart service"));
    expect(out.source).toBe("mock");
    expect(out.degraded).toBe("auth");
    expect(modelsAsked()).toEqual([FAST]);
  });

  it("the spare's own limit does not pause the fast model", async () => {
    fake.reset(tpd(SPARE), ok);
    const { fo, client } = build();
    // paused by an earlier call of its own (the deep path uses the same model)
    await client.chat({ model: SPARE, ...ask }).catch(() => undefined);
    expect(client.disabledReasonFor(SPARE)).toBe("rate_limit");
    expect((await fo.analyze(baseInput("null pointer in the cart service"))).model).toBe(FAST);
  });
});

describe("through the app", () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });
  const groqEnv = (): Record<string, string> => ({
    LLM_MODE: "live",
    LLM_PROVIDER: "groq",
    ANTHROPIC_API_KEY: "",
    GROQ_API_KEY: KEY,
    GROQ_BASE_URL: fake.url,
    GROQ_TPM: "1000000",
    LOCAL_ONLY: "0",
  });

  it("the default two models: Qwen is out for the day, a spoken thought is still understood by gpt-oss, and the ledger names each call", async () => {
    fake.reset(tpd(FAST), ok);
    app = await makeApp(groqEnv(), "2026-10-06T10:00:00+05:30", ":memory:", undefined, {});
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();

    expect(modelsAsked()).toEqual([FAST, SPARE]);
    const t = app.thoughts()[0]!;
    expect(t.source).toBe("llm");
    expect(t.degraded).toBeUndefined();
    expect(Object.keys(app.ctx.groq!.stats().cooling)).toEqual([FAST]);
    const ledger = app.ctx.audit.list(1000).filter((r) => r.event === "sent_to_llm").map((r) => r.ref);
    expect([...ledger].sort()).toEqual([`groq:${SPARE}`, `groq:${FAST}`].sort()); // the refused attempt and the answer, each named
  });

  it("with one model configured there is nothing to fail over to", async () => {
    fake.reset(tpd(FAST));
    app = await makeApp({ ...groqEnv(), GROQ_MODEL_DEEP: FAST }, "2026-10-06T10:00:00+05:30", ":memory:", undefined, {});
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    expect(modelsAsked()).toEqual([FAST]);
    expect(app.thoughts()[0]!.degraded).toBe("rate_limit");
  });
});
