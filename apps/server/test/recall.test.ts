import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@synapse/shared";
import { makeApp, type TestApp } from "./app-helper";
import { parseQuery } from "../src/recall/engine";
import { stem } from "../src/memory/vindex";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});
const H = 3600_000;

describe("query parsing", () => {
  const now = Date.parse("2026-10-06T15:42:00+05:30");
  const opts = { now, timezone: "Asia/Kolkata", hackathonStart: Date.parse("2026-10-06T09:00:00+05:30"), persons: [] as string[] };

  it("extracts topic, time, activity, device, types from a vague spoken question", () => {
    const p = parseQuery("What was that idea I had about caching last Tuesday while I was walking?", opts);
    expect(p.topic.toLowerCase()).toContain("caching");
    expect(p.topic.toLowerCase()).not.toMatch(/tuesday|walking|what|idea/);
    expect(p.constraints.activity).toBe("walking");
    expect(p.constraints.timeRange?.label.toLowerCase()).toContain("tuesday");
    expect(p.constraints.types).toContain("idea");
    expect(parseQuery("what did I say on my phone earlier in the hackathon", opts).constraints).toMatchObject({ device: "pocket" });
    expect(parseQuery("something from earlier in the hackathon about auth", opts).constraints.timeRange?.from).toBe(opts.hackathonStart);
  });

  it("uses the model's refined constraints when it provides them", () => {
    const p = parseQuery("that thing from the car", { ...opts, llm: { kind: "recall", topic_query: "retry wrapper", time_expression: "yesterday", activity: "driving", device: null, types: ["code"], persons: ["Dev"] } });
    expect(p.topic).toBe("retry wrapper");
    expect(p.constraints.activity).toBe("vehicle");
    expect(p.constraints.persons).toContain("Dev");
    expect(p.constraints.timeRange).toBeTruthy();
  });

  it("stems so that caching / cached / cache meet", () => {
    expect(new Set(["caching", "cached", "cache", "caches"].map(stem)).size).toBe(1);
  });
});

describe("recall conversation (what the UI receives)", () => {
  it("streams: sources first, then a cited answer, then done; marks revisited thoughts as salient", async () => {
    app = await makeApp({}, "2026-09-29T08:05:00+05:30");
    await app.say("What if we cached the embeddings on disk and kept the hot ones in memory", { device: "pocket", activity: "walking", session: "walk" });
    await app.settle();
    app.clock.set(Date.parse("2026-10-06T15:42:00+05:30"));
    app.sent.length = 0;
    await app.ctx.recall.ask("q1", "What was that idea I had about caching last Tuesday while I was walking?", { id: "dev-desk", kind: "desk", activity: "desk" });
    const order = app.sent.map((m) => m.type).filter((t) => t.startsWith("recall."));
    expect(order[0]).toBe("recall.sources");
    expect(order.at(-1)).toBe("recall.done");
    expect(order.filter((t) => t === "recall.delta").length).toBeGreaterThanOrEqual(1);
    const sources = app.sent.find((m) => m.type === "recall.sources") as Extract<ServerMessage, { type: "recall.sources" }>;
    expect(sources.constraints.activity).toBe("walking");
    expect(sources.sources[0]!.title.toLowerCase()).toMatch(/cach/);
    expect(sources.ms).toBeLessThan(500); // phase A: the sources must appear almost instantly
    const done = app.sent.find((m) => m.type === "recall.done") as Extract<ServerMessage, { type: "recall.done" }>;
    expect(done.answer).toContain(sources.sources[0]!.code);
    expect(done.notFound).toBe(false);
    const t = [...app.ctx.store.thoughts.values()][0]!;
    expect(t.salienceReasons.join(" ")).toContain("revisited");
  });

  it("says plainly when nothing matches, and relaxes a wrong constraint instead of failing", async () => {
    app = await makeApp({}, "2026-10-05T09:00:00+05:30");
    await app.say("The login page crashes on Safari", { session: "s" });
    await app.settle();
    app.clock.advance(20 * H);
    app.sent.length = 0;
    // wrong activity AND wrong day: should relax and still find the Safari crash, saying so
    await app.ctx.recall.ask("q2", "What did I say about the Safari crash last Monday while I was driving?", { id: "d", kind: "desk", activity: "desk" });
    const s = app.sent.find((m) => m.type === "recall.sources") as Extract<ServerMessage, { type: "recall.sources" }>;
    expect(s.relaxations.length).toBeGreaterThan(0);
    expect(s.sources[0]?.title.toLowerCase()).toMatch(/safari|crash/);

    app.sent.length = 0;
    await app.ctx.recall.ask("q3", "What did I say about quantum chromodynamics?", { id: "d", kind: "desk", activity: "desk" });
    const done = app.sent.find((m) => m.type === "recall.done") as Extract<ServerMessage, { type: "recall.done" }>;
    expect(done.notFound).toBe(true);
    expect(done.answer.toLowerCase()).toContain("couldn't find");
  });
});

describe("forgetting by meaning", () => {
  it("'forget what I said about Sarah' deletes the thoughts about Sarah and nothing else", async () => {
    app = await makeApp();
    await app.say("Sarah suggested we use OAuth2 with PKCE for the mobile login", { session: "a" });
    await app.settle();
    await app.say("The login page crashes on Safari", { session: "b", gapMs: 5000 });
    await app.settle();
    expect(app.thoughts()).toHaveLength(2);
    await app.say("forget what I said about Sarah", { session: "c", gapMs: 5000 });
    await app.settle();
    const left = app.thoughts().map((t) => t.title.toLowerCase());
    expect(left.some((t) => /safari|crash/.test(t))).toBe(true);
    expect(left.some((t) => /oauth|sarah|pkce/.test(t))).toBe(false);
    expect(app.sent.some((m) => m.type === "privacy.forgot" && m.scope === "query" && m.count >= 1)).toBe(true);
    // the forget command itself is never stored
    expect([...app.ctx.store.frags.values()].some((f) => /forget what i said/i.test(f.text))).toBe(false);
  });
});
