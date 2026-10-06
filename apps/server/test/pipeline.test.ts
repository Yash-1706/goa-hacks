import { afterEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./app-helper";

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
