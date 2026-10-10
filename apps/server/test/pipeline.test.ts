import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CortexBackend } from "../src/cortex/types";
import type { Embedder } from "../src/memory/embeddings";
import { makeApp, type TestApp } from "./app-helper";
import { modelEmbedder } from "./helpers";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const HOUR = 3600_000;

describe("fragment → structure (problem statement examples)", () => {
  it("stitches a mumbled bug report (4 pauses) into ONE thought and drafts a GitHub issue", async () => {
    app = await makeApp();
    await app.say("That bug from yesterday...");
    await app.say("the one with the null pointer...", { gapMs: 1600 });
    await app.say("in the cart service...", { gapMs: 1100, whisper: true });
    await app.say("probably the discount code", { gapMs: 900 });
    await app.settle();

    const ts = app.thoughts();
    expect(ts).toHaveLength(1);
    const t = ts[0]!;
    expect(t.fragments).toHaveLength(4);
    expect(t.fragments[2]!.whisper).toBe(true);
    expect(t.category).toBe("bug");
    expect(t.artifact?.kind).toBe("github_issue");
    expect(t.provisional).toBe(false);
    expect(t.entities.map((e) => e.name.toLowerCase())).toContain("cart-service");
    expect(t.status).toBe("final");
  });

  it("emits a provisional first-paint card before the analysis result (two-speed cognition)", async () => {
    app = await makeApp();
    await app.say("I need to email the team about the delay");
    const ups = app.sent.filter((m) => m.type === "thought.upsert");
    expect(ups.length).toBeGreaterThanOrEqual(2);
    const first = ups[0] as Extract<(typeof app.sent)[number], { type: "thought.upsert" }>;
    const lastUp = ups[ups.length - 1] as typeof first;
    expect(first.thought.provisional).toBe(true);
    expect(first.thought.analyzing).toBe(true);
    expect(lastUp.thought.provisional).toBe(false);
    expect(lastUp.thought.category).toBe("communication");
    expect(lastUp.thought.artifact?.kind).toMatch(/email_draft|message_draft/);
    // the first card must precede the analysed one by construction; the engine records its own cost
    expect(first.thought.timing.fragToFirstPaintMs).toBeLessThan(500);
  });

  it("splits unrelated topics into separate thoughts", async () => {
    app = await makeApp();
    await app.say("I need to email the team about the delay");
    await app.say("The sky is nice today", { gapMs: 3500 });
    await app.settle();
    const ts = app.thoughts();
    expect(ts.length).toBe(2);
    expect(ts.map((t) => t.category)).toEqual(expect.arrayContaining(["communication", "journal"]));
  });

  it("resolves a self-repair: JWT is rejected, OAuth2 is chosen, the open question is captured", async () => {
    app = await makeApp();
    await app.say("Uhh, so the auth thing...");
    await app.say("maybe JWT but shorter expiry?", { gapMs: 1800 });
    await app.say("Or no, OAuth2...", { gapMs: 2100 });
    await app.say("what did Sarah say?", { gapMs: 1500 });
    await app.settle();
    const t = app.thoughts().find((x) => x.category === "decision");
    expect(t).toBeTruthy();
    expect(t!.repairs.length).toBeGreaterThan(0);
    expect(t!.repairs.at(-1)!.chosen.toLowerCase()).toContain("oauth");
    expect(t!.repairs.at(-1)!.rejected.toLowerCase()).toContain("jwt");
    expect(t!.openQuestions.join(" ").toLowerCase()).toContain("sarah");
    const art = t!.artifact?.payload as { kind: string; chosen: string | null; rejected: string[] };
    expect(art.kind).toBe("decision");
    expect(art.chosen?.toLowerCase()).toContain("oauth");
  });

  it("a thread that STARTS like a question but becomes a decision keeps its normal 72 h retention (it must not expire as a recall query)", async () => {
    app = await makeApp();
    const sweepAfter = async (ms: number) => {
      app!.clock.advance(ms);
      return app!.ctx.store.sweep();
    };
    await app.say("Hmm, the auth module needs a decision");
    // the first fragment alone really is analysed as a recall-style question (that is what makes this scenario)
    expect(app.thoughts()[0]!.category).toBe("recall_query");
    await app.say("JWT with a short expiry or OAuth2 with PKCE", { gapMs: 2200 });
    await app.say("I'm leaning towards JWT because it's simpler", { gapMs: 1800 });
    await app.settle();

    const t = [...app.ctx.store.thoughts.values()].find((x) => x.category === "decision")!;
    expect(t).toBeTruthy();
    expect(t.expiresAt).toBeGreaterThanOrEqual(t.createdAt + app.ctx.cfg.memory.ttlHours * HOUR);
    for (const f of app.ctx.store.fragmentsOf(t)) expect(f.expiresAt).toBe(t.expiresAt);
    if (t.artifactId) expect(app.ctx.store.artifacts.get(t.artifactId)!.expiresAt).toBe(t.expiresAt);

    // five hours later the sleep cycle's TTL sweep must still find it
    await sweepAfter(5 * HOUR);
    expect(app.ctx.store.thoughts.has(t.id)).toBe(true);
    // and it expires only when the real TTL is up
    await sweepAfter((app.ctx.cfg.memory.ttlHours + 1) * HOUR);
    expect(app.ctx.store.thoughts.has(t.id)).toBe(false);
  });

  it("engineering to-dos that merely mention a sender / queue / endpoint are work items, not messages to someone", async () => {
    app = await makeApp();
    const lines = [
      "we should add a retry budget to the webhook sender",
      "the webhook sender needs a retry budget",
      "Need to add pagination to the orders endpoint",
      "I think we should migrate the queue consumer to batches",
    ];
    for (const [i, line] of lines.entries()) {
      await app.say(line, { session: `s${i}`, gapMs: 9000 });
      await app.settle();
    }
    const cats = app.thoughts().map((t) => t.category);
    expect(cats).toHaveLength(lines.length);
    expect(cats.every((c) => c === "action"), cats.join(",")).toBe(true);
    // ...while a genuine message about the same component still is one
    await app.say("tell Dev the webhook sender is retrying too often", { session: "m", gapMs: 9000 });
    await app.settle();
    expect(app.thoughts().some((t) => t.category === "communication")).toBe(true);
  });

  it("a real recall question stays ephemeral (30 minutes) and is never promoted", async () => {
    app = await makeApp();
    await app.say("What was that idea I had about caching last Tuesday while I was walking?");
    await app.settle();
    const q = [...app.ctx.store.thoughts.values()].find((x) => x.category === "recall_query")!;
    expect(q).toBeTruthy();
    expect(q.promoted).toBe(false);
    expect(q.expiresAt! - app.clock.now()).toBeLessThanOrEqual(30 * 60_000 + 1000);
    app.clock.advance(31 * 60_000);
    app.ctx.store.sweep();
    expect(app.ctx.store.thoughts.has(q.id)).toBe(false);
  });

  it("filters asides without storing them", async () => {
    app = await makeApp();
    await app.say("Wait, was that my phone?");
    await app.say("uh um hmm", { gapMs: 2000 });
    await app.settle();
    expect(app.thoughts()).toHaveLength(0);
    expect(app.ctx.asides.count).toBeGreaterThanOrEqual(1);
    expect(app.ctx.store.frags.size).toBe(0);
  });

  it("keeps a half-formed code thought and drafts a snippet", async () => {
    app = await makeApp();
    await app.say("Maybe a recursive...");
    await app.say("no, iterative approach with memoization", { gapMs: 1400 });
    await app.settle();
    const t = app.thoughts()[0]!;
    expect(t.category).toBe("code");
    expect(t.artifact?.kind).toBe("code_snippet");
    expect(t.repairs[0]?.chosen.toLowerCase()).toContain("iterative");
  });
});

describe("cross-session memory", () => {
  it("resolves 'that bug from yesterday' to yesterday's thought", async () => {
    app = await makeApp({}, "2026-10-05T16:10:00+05:30");
    await app.say("There's a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    const yesterday = app.thoughts()[0]!;
    expect(yesterday.category).toBe("bug");

    app.clock.advance(23 * HOUR);
    await app.say("That bug from yesterday...", { session: "sess-today" });
    await app.say("the one in the cart service, probably the discount code", { gapMs: 1500, session: "sess-today" });
    await app.settle();
    const today = app.thoughts().find((t) => t.sessionId === "sess-today")!;
    expect(today.references.some((r) => r.resolvedId === yesterday.id)).toBe(true);
  });

  it("answers an open question from an earlier session (what did Sarah say?)", async () => {
    app = await makeApp({}, "2026-10-04T11:20:00+05:30");
    await app.say("Sarah suggested we use OAuth2 with PKCE for the mobile app login", { session: "sess-mon" });
    await app.settle();
    app.ctx.proactive.start();

    app.clock.advance(50 * HOUR);
    await app.say("Okay so the auth thing...", { session: "sess-now" });
    await app.say("maybe JWT or no, OAuth2", { gapMs: 1500, session: "sess-now" });
    await app.say("what did Sarah say?", { gapMs: 1400, session: "sess-now" });
    await app.settle();
    await new Promise((r) => setTimeout(r, 900)); // delivery tick
    const answer = app.suggestions().find((s) => s.kind === "open_answer");
    expect(answer).toBeTruthy();
    expect(answer!.body.toLowerCase()).toMatch(/oauth/);
    app.ctx.proactive.stop();
  });

  it("recalls a vague, time- and place-constrained query", async () => {
    // the caching idea was spoken last Tuesday on a walk (phone)
    app = await makeApp({}, "2026-09-29T08:05:00+05:30");
    await app.say("What if we cached the embeddings on disk and kept the hot ones in memory", { device: "pocket", activity: "walking", session: "walk" });
    await app.settle();
    app.clock.advance(HOUR);
    await app.say("Remember to rotate the staging keys on Friday", { device: "desk", session: "desk-tue" });
    await app.settle();

    app.clock.set(Date.parse("2026-10-06T15:42:00+05:30"));
    const res = await app.ctx.recall.search(
      (await import("../src/recall/engine")).parseQuery("What was that idea I had about caching last Tuesday while I was walking?", { now: app.clock.now(), timezone: app.ctx.cfg.timezone, hackathonStart: app.ctx.cfg.hackathonStart, persons: [] }),
    );
    expect(res.constraints.activity).toBe("walking");
    expect(res.constraints.timeRange?.label.toLowerCase()).toContain("tuesday");
    expect(res.hits[0]?.thought.title.toLowerCase()).toMatch(/cach/);
  });
});

describe("privacy controls", () => {
  it("'pause memory' stops capture, purges the trailing window, and never stores the phrase", async () => {
    app = await makeApp();
    await app.say("The staging database password is hunter two", { whisper: true });
    await app.say("pause memory", { gapMs: 800, whisper: true });
    expect(app.ctx.privacy.isPaused()).toBe(true);
    expect(app.thoughts()).toHaveLength(0); // trailing window purged
    expect(app.ctx.store.frags.size).toBe(0);
    await app.say("this must not be stored at all");
    expect(app.thoughts()).toHaveLength(0);
    expect([...app.ctx.store.frags.values()].some((f) => /pause memory/i.test(f.text))).toBe(false);
    const audit = app.ctx.audit.list().map((r) => r.event);
    expect(audit).toContain("paused");
    expect(app.ctx.audit.verify().ok).toBe(true);
    expect(app.sent.some((m) => m.type === "privacy.paused")).toBe(true);
    // resume is a deliberate action, not voice
    app.ctx.privacy.resume("tap");
    await app.say("I need to rotate the keys on Friday");
    await app.settle();
    expect(app.thoughts().length).toBe(1);
  });

  it("'forget the last five minutes' removes recent thoughts", async () => {
    app = await makeApp();
    await app.say("I need to refactor the payment service");
    await app.settle();
    app.clock.advance(60_000);
    await app.say("forget the last five minutes", { gapMs: 500 });
    expect(app.thoughts()).toHaveLength(0);
    expect(app.sent.some((m) => m.type === "privacy.forgot")).toBe(true);
  });

  it("'scratch that' retracts the previous thought", async () => {
    app = await makeApp();
    await app.say("Note to self, rotate the staging keys on Friday");
    await app.settle();
    expect(app.thoughts()).toHaveLength(1);
    await app.say("Scratch that", { gapMs: 1500 });
    await app.settle();
    expect(app.thoughts()).toHaveLength(0);
    expect(app.sent.some((m) => m.type === "thought.remove" && m.reason === "retracted")).toBe(true);
  });
});

describe("corrections are safe", () => {
  it("'actually make it Friday' REVISES the call (same time of day) instead of deleting it", async () => {
    app = await makeApp({}, "2026-10-06T10:00:00+05:30"); // a Tuesday
    await app.say("Set up a call with the vendor on Thursday at 3pm");
    await app.settle();
    const before = app.thoughts()[0]!;
    const a0 = before.artifact!.payload as { kind: string; start_iso: string | null; time_expression: string | null };
    expect(a0.kind).toBe("calendar_event");
    expect(a0.start_iso).toBe("2026-10-08T15:00:00+05:30");

    await app.say("Actually make it Friday", { gapMs: 1500 });
    await app.settle();
    const ts = app.thoughts();
    expect(ts).toHaveLength(1); // revised in place, not deleted, not duplicated
    expect(ts[0]!.id).toBe(before.id);
    const a1 = ts[0]!.artifact!.payload as { start_iso: string | null; end_iso: string | null; time_expression: string | null };
    expect(a1.start_iso).toBe("2026-10-09T15:00:00+05:30");
    expect(a1.end_iso).toBe("2026-10-09T15:30:00+05:30");
    expect(a1.time_expression?.toLowerCase()).toContain("friday");
    expect(ts[0]!.fragments.length).toBe(2); // the correction joins the thought's trail
    expect(app.sent.some((m) => m.type === "thought.remove" && m.reason === "retracted")).toBe(false);
  });

  it("a correction nobody can interpret leaves the previous thought alone", async () => {
    app = await makeApp();
    await app.say("Note to self, rotate the staging keys on Friday");
    await app.settle();
    await app.say("Actually, hmm, I mean, whatever", { gapMs: 1500 });
    await app.settle();
    expect(app.thoughts().some((t) => /rotate/i.test(t.title))).toBe(true);
  });

  /** The model is "slow": the first analysis takes `ms`, every later one is immediate. */
  function slowFirstAnalysis(a: TestApp, ms: number): void {
    const deps = (a.ctx.engine as unknown as { d: { backend: CortexBackend } }).d;
    const real = deps.backend;
    let n = 0;
    deps.backend = {
      name: real.name,
      analyze: async (input, onPartial) => {
        if (n++ === 0) await new Promise((r) => setTimeout(r, ms));
        return real.analyze(input, onPartial);
      },
    };
  }

  it("a revision spoken while the model is still reading the original waits for that card, then revises it", async () => {
    app = await makeApp({}, "2026-10-06T10:00:00+05:30");
    slowFirstAnalysis(app, 300);
    await app.say("Set up a call with the vendor on Thursday at 3pm", { wait: false });
    // a long pause (so it is its own thread, not a continuation), yet the first card is still being written (a queued or retried model call)
    await app.say("Actually make it Friday", { gapMs: 9000 });
    const ts = app.thoughts();
    expect(ts).toHaveLength(1);
    const a = ts[0]!.artifact!.payload as { kind: string; start_iso: string | null };
    expect(a.kind).toBe("calendar_event");
    expect(a.start_iso).toBe("2026-10-09T15:00:00+05:30"); // Friday: the original's late result must not win
    expect(ts[0]!.fragments).toHaveLength(2);
  });

  it("'scratch that' does not wait for the model: the card is retracted at once and the late result is discarded", async () => {
    app = await makeApp({}, "2026-10-06T10:00:00+05:30");
    slowFirstAnalysis(app, 1500);
    await app.say("Note to self, rotate the staging keys on Friday", { wait: false });
    expect(app.thoughts()).toHaveLength(1); // the provisional first-paint card
    const t0 = Date.now();
    await app.say("Scratch that", { gapMs: 1200, wait: false });
    while (app.thoughts().length > 0 && Date.now() - t0 < 1400) await new Promise((r) => setTimeout(r, 20));
    expect(app.thoughts()).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(1200); // retracted long before the 1.5 s model call returns
    await app.ctx.engine.idle();
    expect(app.thoughts()).toHaveLength(0); // the late result found nothing to write to
  });

  it("idle() does not report quiet while a merged correction is still being written to its card", async () => {
    let embedDelay = 0;
    const real = await modelEmbedder();
    const slow = Object.create(real) as Embedder;
    slow.embed = async (texts, kind) => {
      if (embedDelay) await new Promise((r) => setTimeout(r, embedDelay));
      return real.embed(texts, kind);
    };
    app = await makeApp({}, "2026-10-06T10:00:00+05:30", ":memory:", randomBytes(32), { embedder: slow });
    await app.say("Set up a call with the vendor on Thursday at 3pm");
    await app.settle();
    embedDelay = 120; // a loaded machine: every embedding now takes 120 ms
    await app.say("Actually make it Friday", { gapMs: 1500 });
    // no settle(): say() alone must not return until the revision is on the card
    const a = app.thoughts()[0]!.artifact!.payload as { start_iso: string | null };
    expect(a.start_iso).toBe("2026-10-09T15:00:00+05:30");
  });
});

describe("proactivity", () => {
  it("three calendar-clash mutters in ten minutes → one reschedule suggestion with concrete slots", async () => {
    app = await makeApp({ RECURRING_N: "3" }, "2026-10-06T10:00:00+05:30");
    app.ctx.proactive.start();
    await app.say("Ugh, Thursday's standup is going to clash with the dentist");
    await app.settle();
    app.clock.advance(3 * 60_000);
    await app.say("The dentist overlaps with the Thursday standup again", { gapMs: 2000 });
    await app.settle();
    app.clock.advance(3 * 60_000);
    await app.say("I really need to sort out the standup and dentist clash on Thursday", { gapMs: 2000 });
    await app.settle();
    await new Promise((r) => setTimeout(r, 900));
    const s = app.suggestions().find((x) => x.kind === "reschedule");
    expect(s).toBeTruthy();
    expect(s!.why).toMatch(/3 times/);
    const slots = (s!.payload as { slots: unknown[] }).slots;
    expect(slots.length).toBeGreaterThan(0);
    // accepting holds a slot on the calendar and adapts thresholds
    const before = app.ctx.store.calendar.size;
    await app.ctx.proactive.action(s!.id, "accept");
    expect(app.ctx.store.calendar.size).toBe(before + 1);
    app.ctx.proactive.stop();
  });

  it("holds the slot the person PICKED, not always the first (and ignores an out-of-range pick)", async () => {
    app = await makeApp({ RECURRING_N: "3" }, "2026-10-06T10:00:00+05:30");
    app.ctx.proactive.start();
    const clash = async (text: string) => {
      await app!.say(text, { gapMs: 2000 });
      await app!.settle();
      app!.clock.advance(3 * 60_000);
    };
    await clash("Ugh, Thursday's standup is going to clash with the dentist");
    await clash("The dentist overlaps with the Thursday standup again");
    await clash("I really need to sort out the standup and dentist clash on Thursday");
    await new Promise((r) => setTimeout(r, 900));
    const s = app.suggestions().find((x) => x.kind === "reschedule")!;
    const slots = (s.payload as { slots: Array<{ start: number; end: number }> }).slots;
    expect(slots.length).toBeGreaterThanOrEqual(3);

    const held = new Set([...app.ctx.store.calendar.values()].map((c) => c.id));
    await app.ctx.proactive.action(s.id, "accept", 2);
    const added = [...app.ctx.store.calendar.values()].filter((c) => !held.has(c.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.start).toBe(slots[2]!.start);
    expect(added[0]!.end).toBe(slots[2]!.end);
    expect(added[0]!.title).toMatch(/\(proposed\)$/);
    const notice = app.sent.filter((m) => m.type === "notice").map((m) => ("text" in m ? m.text : "")).find((t) => t.startsWith("Held "));
    expect(notice).toBeTruthy();
    app.ctx.proactive.stop();

    // an out-of-range pick falls back to the first slot instead of failing or holding nothing
    const app2 = await makeApp({ RECURRING_N: "3" }, "2026-10-06T10:00:00+05:30");
    try {
      app2.ctx.proactive.start();
      for (const text of ["Ugh, Thursday's standup is going to clash with the dentist", "The dentist overlaps with the Thursday standup again", "I really need to sort out the standup and dentist clash on Thursday"]) {
        await app2.say(text, { gapMs: 2000 });
        await app2.settle();
        app2.clock.advance(3 * 60_000);
      }
      await new Promise((r) => setTimeout(r, 900));
      const s2 = app2.suggestions().find((x) => x.kind === "reschedule")!;
      const slots2 = (s2.payload as { slots: Array<{ start: number }> }).slots;
      const before = new Set([...app2.ctx.store.calendar.values()].map((c) => c.id));
      await app2.ctx.proactive.action(s2.id, "accept", 9);
      const add2 = [...app2.ctx.store.calendar.values()].filter((c) => !before.has(c.id));
      expect(add2).toHaveLength(1);
      expect(add2[0]!.start).toBe(slots2[0]!.start);
      app2.ctx.proactive.stop();
    } finally {
      await app2.stop();
    }
  });

  it("never delivers a suggestion while someone is speaking", async () => {
    app = await makeApp();
    // pretend a device is mid-utterance
    app.ctx.hub.quietForMs = () => 0;
    app.ctx.proactive.start();
    await app.say("Dev needs the staging URL, I'll ping him");
    await app.settle();
    await new Promise((r) => setTimeout(r, 700));
    expect(app.suggestions()).toHaveLength(0);
    app.ctx.hub.quietForMs = () => Infinity;
    await new Promise((r) => setTimeout(r, 700));
    expect(app.suggestions().some((s) => s.kind === "draft_ready")).toBe(true);
    app.ctx.proactive.stop();
  });
});
