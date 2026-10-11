import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactOf } from "@synapse/shared";
import { batchSystemPrompt, renderBatchUserMessage } from "../src/cortex/prompts-batch";
import { EXAMPLE_OUTPUTS } from "../src/cortex/prompts";
import { BatchDrafter } from "../src/llm/batch";
import { estimatePromptTokens, GroqClient } from "../src/llm/groq-client";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeGroq, type FakeGroq } from "./fake-groq";

/**
 * V1.1: one model call per capture on Groq's free tier. The whole transcript goes out once (redacted); every item comes back
 * drafted and lands in the engine without another call. Corrections, retractions and asides still work; a bad answer falls
 * back to the per-thought path.
 */

const KEY = "gsk_test_key_not_real_0000000000";
const NOW = "2026-10-06T10:00:00+05:30";
const RAMBLE =
  "That bug from yesterday, the null pointer in cart service, probably the discount code, oh, and email the team at team@acme.io that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone? Actually make it 7.";

const items = {
  items: [
    { said: "That bug from yesterday, the null pointer in cart service, probably the discount code", category: "bug", title: "NPE in cart-service discount code", intent: "Null pointer in the cart service.", confidence: 0.9, artifact: { kind: "github_issue", title: "NPE in cart-service discount code", body_markdown: "**Summary**\nNPE.", labels: ["bug"], hypotheses: ["discount code"] }, repairs: [], entities: [{ name: "cart-service", type: "component" }], corrects: null },
    // the model only ever sees the placeholder; the address comes back rehydrated on this machine
    { said: "email the team at [EMAIL_1] that the launch moves to Friday", category: "communication", title: "Email the team: launch moves to Friday", intent: "Tell the team.", confidence: 0.9, artifact: { kind: "email_draft", to: ["[EMAIL_1]"], subject: "The launch moves to Friday", body: "Hi team,\n\nThe launch moves to Friday.\n\nThanks,\nRio", tone: "neutral" }, repairs: [], entities: [], corrects: null },
    { said: "Remind me to call the landlord tomorrow at 6. Actually make it 7.", category: "scheduling", title: "Call the landlord", intent: "Call at 7 pm.", confidence: 0.9, artifact: { kind: "reminder", what: "Call the landlord", due_iso: "2026-10-07T19:00:00+05:30", due_text: "tomorrow at 7", recurrence: null }, repairs: [{ rejected: "6", chosen: "7" }], entities: [], corrects: null },
    { said: "Wait, was that my phone?", category: "aside", title: "Aside", intent: "", confidence: 0.9, artifact: { kind: "none" }, repairs: [], entities: [], corrects: null },
  ],
};

let fake: FakeGroq;
beforeAll(async () => {
  fake = await startFakeGroq({ initial: [{ kind: "ok", json: items }] });
});
afterAll(async () => fake.close());
let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});
const groq = (extra: Record<string, string> = {}) => ({ LLM_MODE: "live", LLM_PROVIDER: "groq", ANTHROPIC_API_KEY: "", GROQ_API_KEY: KEY, GROQ_BASE_URL: fake.url, GROQ_TPM: "1000000", LOCAL_ONLY: "0", ...extra });
const cards = (ids: string[]) =>
  ids.map((id) => {
    const t = app!.ctx.store.getThought(id)!;
    return { t, a: t.artifactId ? app!.ctx.store.artifacts.get(t.artifactId) : undefined };
  });

describe("one call per capture", () => {
  it("fits Groq's free tier: prompt + transcript + answer allowance well under 8k tokens a minute", () => {
    const user = renderBatchUserMessage({ now: Date.parse(NOW), timezone: "Asia/Kolkata", user: { name: "Rio", team: ["Sarah", "Dev"] }, recent: [{ ref: "T-3", title: "Call the landlord", kind: "reminder", due: "2026-10-07T18:00:00+05:30" }], transcript: RAMBLE });
    const tokens = estimatePromptTokens({ model: "qwen/qwen3.8-27b", messages: [{ role: "system", content: batchSystemPrompt() }, { role: "user", content: user }], maxCompletionTokens: 1600 });
    expect(tokens).toBeLessThan(4500);
  });

  it("the whole ramble: ONE request (redacted), three drafted cards from the model, the aside dropped", async () => {
    fake.reset({ kind: "ok", json: items });
    app = await makeApp(groq(), NOW);
    const asides = app.ctx.asides.count;
    const res = await app.ctx.capture.capture({ text: RAMBLE, context: { source: "android" } });
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]!.body)).not.toContain("team@acme.io");
    const made = cards(res.thoughtIds);
    expect(made.map((m) => [m.t.source, m.a?.kind])).toEqual([
      ["llm", "github_issue"],
      ["llm", "email_draft"],
      ["llm", "reminder"],
    ]);
    expect(made[0]!.t.title).toBe("NPE in cart-service discount code");
    expect((made[1]!.a!.payload as ArtifactOf<"email_draft">).to).toEqual(["team@acme.io"]);
    expect((made[2]!.a!.payload as ArtifactOf<"reminder">).due_iso).toBe("2026-10-07T19:00:00+05:30");
    expect(app.ctx.asides.count).toBe(asides + 1);
    expect(app.ctx.audit.list(50).filter((r) => r.event === "sent_to_llm")).toHaveLength(1);
  });

  it("a correction of an EARLIER card in the next capture revises that card in place (still one call)", async () => {
    fake.reset({ kind: "ok", json: items });
    app = await makeApp(groq(), NOW);
    const first = await app.ctx.capture.capture({ text: RAMBLE, context: { source: "android" } });
    const reminder = cards(first.thoughtIds)[2]!.t;
    const revised = { items: [{ said: "Actually make it Friday.", category: "scheduling", title: "Call the landlord", intent: "Call on Friday at 7 pm.", confidence: 0.9, artifact: { kind: "reminder", what: "Call the landlord", due_iso: "2026-10-09T19:00:00+05:30", due_text: "Friday at 7", recurrence: null }, repairs: [], entities: [], corrects: reminder.code }] };
    fake.reset({ kind: "ok", json: revised });
    const fix = await app.ctx.capture.capture({ text: "Actually make it Friday.", context: { source: "android" } });
    expect(fake.requests).toHaveLength(1);
    expect(fix.thoughtIds).toEqual([reminder.id]);
    expect((app.ctx.store.artifacts.get(reminder.artifactId!)!.payload as ArtifactOf<"reminder">).due_iso).toBe("2026-10-09T19:00:00+05:30");
    expect(app.ctx.store.thoughts.size).toBe(3);
  });

  it("'scratch that' retracts the earlier card it names", async () => {
    fake.reset({ kind: "ok", json: items });
    app = await makeApp(groq(), NOW);
    const first = await app.ctx.capture.capture({ text: RAMBLE, context: { source: "android" } });
    const reminder = cards(first.thoughtIds)[2]!.t;
    fake.reset({ kind: "ok", json: { items: [{ said: "Scratch that.", category: "correction", title: "Retract", intent: "", confidence: 0.9, artifact: { kind: "none" }, repairs: [], entities: [], corrects: reminder.code }] } });
    await app.ctx.capture.capture({ text: "Scratch that.", context: { source: "android" } });
    expect(app.ctx.store.getThought(reminder.id)).toBeUndefined();
  });

  it("an answer that does not validate twice falls back to the per-thought path (cards are still made)", async () => {
    fake.reset({ kind: "garbage", text: "not json" }, { kind: "garbage", text: "still not json" }, { kind: "ok", json: EXAMPLE_OUTPUTS[0] });
    app = await makeApp(groq(), NOW);
    const res = await app.ctx.capture.capture({ text: "The checkout page crashes on empty carts. Remind me to call the landlord tomorrow at 6.", context: { source: "web" } });
    expect(fake.requests.length).toBeGreaterThanOrEqual(3); // two batch attempts, then per-thought calls
    expect(res.thoughtIds.length).toBe(2);
  });

  it("local-only mode never calls the model: the offline path makes the cards", async () => {
    fake.reset({ kind: "ok", json: items });
    app = await makeApp(groq(), NOW);
    app.ctx.privacy.setLocalOnly(true);
    const res = await app.ctx.capture.capture({ text: RAMBLE, context: { source: "android" } });
    expect(fake.requests).toHaveLength(0);
    expect(cards(res.thoughtIds).map((m) => m.a?.kind)).toEqual(["github_issue", "email_draft", "reminder"]);
  });
});

describe("V1.1 live findings: Groq asks us to wait", () => {
  const input = { now: Date.parse(NOW), timezone: "Asia/Kolkata", user: { name: "Rio", team: ["Sarah", "Dev"] }, recent: [], transcript: RAMBLE };
  const rig = () => {
    let t = Date.parse(NOW);
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const client = new GroqClient({ apiKey: KEY, baseUrl: fake.url, now, sleep, tpm: 1_000_000 });
    return { client, now, sleep, waited: () => t - Date.parse(NOW) };
  };
  const tooMany = (s: string) => ({ kind: "status" as const, status: 429, code: "rate_limit_exceeded", message: `Rate limit reached for model on tokens per minute (TPM). Please try again in ${s}s.`, retryAfter: s });

  it("a 429 with a short retry-after: waits it out and retries the ONE batch call (live: R5 fell back to 7 per-thought calls)", async () => {
    fake.reset(tooMany("9"), { kind: "ok", json: items });
    const r = rig();
    const d = new BatchDrafter({ client: r.client, model: "qwen/qwen3.8-27b", maxWaitMs: 25_000, now: r.now, sleep: r.sleep });
    const out = await d.draft(input);
    expect(out?.items).toHaveLength(4);
    expect(out?.calls).toBe(2);
    expect(fake.requests).toHaveLength(2);
    expect(r.waited()).toBeGreaterThanOrEqual(9000);
  });

  it("a retry-after longer than the capture's patience: no second call; null so the caller falls back", async () => {
    fake.reset(tooMany("40"), { kind: "ok", json: items });
    const r = rig();
    const d = new BatchDrafter({ client: r.client, model: "qwen/qwen3.8-27b", maxWaitMs: 25_000, now: r.now, sleep: r.sleep });
    expect(await d.draft(input)).toBeNull();
    expect(fake.requests).toHaveLength(1);
  });

  it("Groq refuses the answer as invalid JSON (json_validate_failed, live R2): asked again once, not the per-thought path", async () => {
    fake.reset({ kind: "status", status: 400, code: "json_validate_failed", message: "Failed to generate JSON. Please adjust your prompt." }, { kind: "ok", json: items });
    const r = rig();
    const d = new BatchDrafter({ client: r.client, model: "qwen/qwen3.8-27b", maxWaitMs: 25_000, now: r.now, sleep: r.sleep });
    const out = await d.draft(input);
    expect(out?.items).toHaveLength(4);
    expect(out?.calls).toBe(2);
    expect(fake.requests[1]!.body).toMatchObject({ max_completion_tokens: 1600 });
  });
});

