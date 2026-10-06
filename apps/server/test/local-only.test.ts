import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXAMPLE_OUTPUTS } from "../src/cortex/prompts";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeAnthropic, type FakeServer } from "./fake-anthropic";

/**
 * PRV-10: "Local-only mode: a toggle disables ALL cloud LLM calls, degrading to local heuristics."
 * Proven against a fake Anthropic endpoint that records every request: while the switch is on, nothing reaches it,
 * from any path (fast cortex, DEEP recall answer, session brief, consolidation); when it is off, the calls resume.
 */

let fake: FakeServer;
let app: TestApp | undefined;
const prevBase = process.env.ANTHROPIC_BASE_URL;

beforeAll(async () => {
  fake = await startFakeAnthropic([{ kind: "ok", json: EXAMPLE_OUTPUTS[0] }]);
  process.env.ANTHROPIC_BASE_URL = fake.url;
});
afterAll(async () => {
  await fake.close();
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = prevBase;
});
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const LIVE = { LLM_MODE: "live", ANTHROPIC_API_KEY: "sk-ant-test-key" };
const sentToLlm = (a: TestApp): number => a.ctx.audit.list(1000).filter((r) => r.event === "sent_to_llm").length;

describe("local-only mode", () => {
  it("flipped at runtime: no request reaches the cloud from any path while it is on, and the calls resume when it is off", async () => {
    fake.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0] });
    app = await makeApp(LIVE);
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "live", localOnly: false });

    // 1. cloud allowed: the live model is used (and the cloud call is audited, content-free)
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(sentToLlm(app)).toBeGreaterThan(0);

    // 2. local-only on: every path stays on the machine
    app.ctx.privacy.setLocalOnly(true);
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "mock", localOnly: true });
    expect(app.ctx.audit.list(1000).map((r) => r.event)).toContain("local_only_on");
    fake.requests.length = 0;
    const auditedBefore = sentToLlm(app);

    await app.say("Remind me to email the team about the delay", { gapMs: 30_000 });
    await app.say("What was that idea I had about the cart service?", { gapMs: 30_000 }); // a recall question: DEEP path
    await app.settle();
    await app.ctx.proactive.brief("sess-desk"); // session brief: DEEP path
    await app.ctx.consolidator.run(); // consolidation: DEEP path

    expect(fake.requests, "a request escaped to the cloud while local-only was on").toHaveLength(0);
    expect(sentToLlm(app)).toBe(auditedBefore); // and nothing was audited as sent
    const views = app.thoughts();
    expect(views.length).toBeGreaterThanOrEqual(2); // the pipeline still produced thoughts, locally
    const local = views.filter((v) => v.title.toLowerCase().includes("email") || v.title.toLowerCase().includes("delay"));
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((v) => v.source !== "llm")).toBe(true);

    // 3. back off: the live model is used again
    app.ctx.privacy.setLocalOnly(false);
    await app.say("The checkout page also crashes when the cart is empty", { gapMs: 30_000 });
    await app.settle();
    expect(fake.requests.length).toBeGreaterThan(0);
  });

  it("the setting survives a restart-shaped re-read, and is also honoured when set at boot (LOCAL_ONLY=1)", async () => {
    fake.reset({ kind: "ok", json: EXAMPLE_OUTPUTS[0] });
    app = await makeApp({ ...LIVE, LOCAL_ONLY: "1" });
    expect(app.ctx.clientConfig()).toMatchObject({ llmMode: "mock", localOnly: true });
    await app.say("There is a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    expect(fake.requests).toHaveLength(0);
    expect(app.thoughts().length).toBeGreaterThan(0);
  });
});
