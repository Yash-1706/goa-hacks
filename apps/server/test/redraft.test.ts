import { describe, expect, it } from "vitest";
import { RedraftQueue, type RedraftState } from "../src/cortex/redraft";

/**
 * V1.1: a card the offline model drafted because Groq's free tier was out of budget is re-drafted by the model when budget
 * returns, in place (the same card, never a duplicate), showing "improving…" meanwhile. A shipped, opened or hand-edited
 * card is never overwritten.
 */

function rig(states: Record<string, RedraftState>, o: { budget?: boolean; becomes?: RedraftState["source"] } = {}) {
  const improving = new Map<string, boolean>();
  const calls: string[] = [];
  const net = { budget: o.budget ?? true };
  const q = new RedraftQueue({
    state: (id) => states[id],
    reanalyze: async (id) => {
      calls.push(id);
      const s = states[id];
      if (s && o.becomes) states[id] = { ...s, source: o.becomes, degraded: o.becomes === "llm" ? undefined : s.degraded };
    },
    setImproving: (id, on) => void improving.set(id, on),
    budget: () => net.budget,
    maxAttempts: 3,
  });
  return { q, improving, calls, net, states };
}

const paced: RedraftState = { source: "mock", degraded: "paced" };

describe("re-draft queue", () => {
  it("queues an offline card that was paced, shows 'improving', and upgrades it in place when budget returns", async () => {
    const r = rig({ a: { ...paced } }, { budget: false, becomes: "llm" });
    r.q.consider("a");
    r.q.consider("a"); // never twice
    expect(r.q.size).toBe(1);
    expect(r.improving.get("a")).toBe(true);
    await r.q.tick();
    expect(r.calls).toEqual([]); // no budget yet
    r.net.budget = true;
    await r.q.tick();
    expect(r.calls).toEqual(["a"]);
    expect(r.q.size).toBe(0);
    expect(r.improving.get("a")).toBe(false);
  });

  it("ignores live cards, cards degraded for a reason re-drafting cannot fix, and shipped, opened or edited cards", () => {
    const r = rig({ live: { source: "llm" }, bad: { source: "mock", degraded: "bad_output" }, local: { source: "mock" }, done: { ...paced, artifactStatus: "executed" }, opened: { ...paced, artifactStatus: "opened" }, edited: { ...paced, edited: true } });
    for (const id of ["live", "bad", "local", "done", "opened", "edited", "gone"]) r.q.consider(id);
    expect(r.q.size).toBe(0);
  });

  it("one re-draft at a time; a card shipped while waiting is dropped, not overwritten", async () => {
    const r = rig({ a: { ...paced }, b: { ...paced } }, { becomes: "llm" });
    r.q.consider("a");
    r.q.consider("b");
    r.states.b = { ...paced, artifactStatus: "executed" };
    await Promise.all([r.q.tick(), r.q.tick()]);
    await r.q.tick();
    expect(r.calls).toEqual(["a"]);
    expect(r.improving.get("b")).toBe(false);
    expect(r.q.size).toBe(0);
  });

  it("gives up after a few failed attempts and clears the 'improving' state", async () => {
    const r = rig({ a: { ...paced } }); // re-analysis keeps coming back offline
    r.q.consider("a");
    for (let i = 0; i < 5; i++) await r.q.tick();
    expect(r.calls).toEqual(["a", "a", "a"]);
    expect(r.q.size).toBe(0);
    expect(r.improving.get("a")).toBe(false);
  });
});

describe("re-draft through the real app", () => {
  it("an offline (paced) card is upgraded in place by the model: same card, new title, no duplicate", async () => {
    const { makeApp } = await import("./app-helper");
    let calls = 0;
    const app = await makeApp({}, "2026-10-06T10:00:00+05:30", undefined, undefined, {
      backend: {
        name: "stub",
        async analyze(input) {
          calls++;
          const base = await app.ctx.mock.analyze(input);
          return calls === 1 ? { ...base, degraded: "paced" } : { ...base, source: "llm", model: "stub-model", result: { ...base.result, title: "Water the plants (model)" } };
        },
      },
      redraftBudget: () => true,
    });
    try {
      const res = await app.ctx.capture.capture({ text: "Remind me to water the plants tonight." });
      const id = res.thoughtIds[0]!;
      expect(app.ctx.engine.view(app.ctx.store.getThought(id)!)).toMatchObject({ source: "mock", improving: true });
      await app.ctx.redraft.tick();
      const t = app.ctx.store.getThought(id)!;
      expect(app.ctx.engine.view(t)).toMatchObject({ source: "llm", title: "Water the plants (model)", improving: false });
      expect(app.ctx.store.thoughts.size).toBe(1);
      const ups = app.sent.filter((m) => m.type === "thought.upsert" && m.thought.id === id);
      expect(ups.some((m) => m.type === "thought.upsert" && m.thought.improving === true)).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
