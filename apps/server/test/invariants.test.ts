import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./app-helper";

/**
 * Lifecycle invariants under a messy day: the golden corpora spoken in random order, with random gaps, across three
 * sessions on two devices, with hours passing in between. Whatever the pipeline decides, the memory must stay
 * consistent. (This is the test that would have caught the thought that began as a recall question, became a decision,
 * and silently expired thirty minutes later.)
 */

const root = path.resolve(import.meta.dirname, "../../..");
interface Item { id: string; fragments: string[]; gaps?: number[]; expect?: { category: string } }
const corpus: Item[] = ["intent.jsonl", "intent_heldout.jsonl"].flatMap((f) =>
  fs.readFileSync(path.join(root, "eval", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item),
);

/** question-shaped openers that the classifier reads as a recall query on their own, then often turn into something else */
const OPENERS = ["Hmm, the auth module needs a decision", "What was the thing about the cart service", "What did we say about the staging keys", "Hmm, what about the retry logic", "What is the plan for the release"];

/** mulberry32: a tiny seeded PRNG so a failure is reproducible */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3600_000;
let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

function consistency(a: TestApp): string[] {
  const { store } = a.ctx;
  const bad: string[] = [];
  const known = new Set<string>([
    ...store.thoughts.keys(), ...store.entities.keys(), ...store.artifacts.keys(), ...store.sessions.keys(), ...store.openLoops.keys(),
  ]);
  for (const t of store.thoughts.values()) {
    if (t.status !== "final") bad.push(`${t.code} is still ${t.status} after settle()`);
    if (t.provisional) bad.push(`${t.code} is still provisional after settle()`);
    if (!store.sessions.has(t.sessionId)) bad.push(`${t.code} belongs to a missing session`);
    for (const fid of t.fragmentIds) {
      const f = store.frags.get(fid);
      if (!f) bad.push(`${t.code} lists a missing fragment`);
      else if (f.thoughtId !== t.id) bad.push(`fragment of ${t.code} points at another thought`);
    }
    if (t.artifactId) {
      const art = store.artifacts.get(t.artifactId);
      if (!art) bad.push(`${t.code} lists a missing artifact`);
      else if (art.thoughtId !== t.id) bad.push(`artifact of ${t.code} points at another thought`);
    }
    for (const eid of t.entityIds) if (!store.entities.has(eid)) bad.push(`${t.code} references a missing entity`);
    // retention: ordinary working memory keeps the full TTL; only a thought that IS a recall question is short-lived
    if (!t.promoted && t.expiresAt !== null) {
      const full = t.createdAt + a.ctx.cfg.memory.ttlHours * HOUR;
      if (t.category === "recall_query") {
        if (t.expiresAt > t.createdAt + 31 * 60_000 + (a.clock.now() - t.createdAt) && t.expiresAt > full) bad.push(`${t.code} (recall) outlives a normal thought`);
      } else if (t.expiresAt < full) bad.push(`${t.code} (${t.category}) has short retention (${Math.round((t.expiresAt - t.createdAt) / 60_000)} min)`);
    }
  }
  for (const f of store.frags.values()) if (!store.thoughts.has(f.thoughtId)) bad.push("orphan fragment");
  for (const art of store.artifacts.values()) if (!store.thoughts.has(art.thoughtId)) bad.push("orphan artifact");
  for (const o of store.openLoops.values()) if (!store.thoughts.has(o.thoughtId)) bad.push("orphan open loop");
  for (const e of store.edges.values()) {
    if (!known.has(e.src) || !known.has(e.dst)) bad.push(`dangling edge ${e.type}`);
  }
  return bad;
}

describe("memory stays consistent through a messy day", () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: 70 random threads across 3 sessions, hours passing, then a TTL sweep`, async () => {
      const rnd = prng(seed);
      app = await makeApp({ SUGGESTION_MIN_GAP_S: "0" });
      const sessions = [
        { id: "s-desk-1", device: "desk" as const },
        { id: "s-walk", device: "pocket" as const },
        { id: "s-desk-2", device: "desk" as const },
      ];
      for (let i = 0; i < 70; i++) {
        const item = corpus[Math.floor(rnd() * corpus.length)] as Item;
        const s = sessions[Math.floor(rnd() * sessions.length)] as (typeof sessions)[number];
        if (rnd() < 0.15) app.clock.advance(Math.floor(rnd() * 3 * HOUR));
        // a question-shaped opener right before the thread: the first analysis says recall_query, later ones may not
        if (rnd() < 0.3) await app.say(OPENERS[Math.floor(rnd() * OPENERS.length)] as string, { gapMs: Math.floor(400 + rnd() * 1500), session: s.id, device: s.device });
        for (let k = 0; k < item.fragments.length; k++) {
          const gap = k === 0 ? Math.floor(500 + rnd() * 9000) : (item.gaps?.[k] ?? Math.floor(300 + rnd() * 3000));
          await app.say(item.fragments[k] as string, { gapMs: gap, session: s.id, device: s.device, whisper: rnd() < 0.1 });
        }
        if (rnd() < 0.3) await app.settle(); // sometimes the thread ends here, sometimes the next one starts mid-flow
      }
      await app.settle();
      expect(app.ctx.store.thoughts.size).toBeGreaterThan(20); // the day actually produced memory

      const bad = consistency(app);
      expect(bad, bad.slice(0, 8).join("\n")).toEqual([]);

      // five hours on, the TTL sweep may only remove recall questions: nothing else is anywhere near its 72 h
      const before = [...app.ctx.store.thoughts.values()].filter((t) => t.category !== "recall_query").map((t) => t.id);
      app.clock.advance(5 * HOUR);
      app.ctx.store.sweep();
      const lost = before.filter((id) => !app.ctx.store.thoughts.has(id));
      expect(lost, `${lost.length} non-recall thoughts vanished in a 5 h sweep`).toEqual([]);
      expect(consistency(app).filter((m) => !m.includes("still"))).toEqual([]);
    }, 240_000);
  }
});
