import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@synapse/shared";
import { makeApp, type TestApp } from "./app-helper";

let app: TestApp | undefined;
afterEach(async () => {
  app?.ctx.proactive.stop();
  await app?.stop();
  app = undefined;
});

const H = 3600_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const of = <T extends ServerMessage["type"]>(a: TestApp, t: T) => a.sent.filter((m) => m.type === t) as Array<Extract<ServerMessage, { type: T }>>;

describe("memory echo", () => {
  it("resurfaces a related thought from an EARLIER session, with when/where, never from the same session", async () => {
    app = await makeApp({}, "2026-10-04T08:05:00+05:30");
    await app.say("What if we cached the embeddings on disk and kept the hot ones in memory", { device: "pocket", activity: "walking", session: "walk" });
    await app.settle();
    app.ctx.proactive.start();
    app.clock.advance(30 * H);
    await app.say("Maybe cache the embeddings in memory with an LRU so lookups are fast", { session: "desk" });
    await app.settle();
    await wait(900);
    const echoes = of(app, "echo.push");
    expect(echoes.length).toBeGreaterThanOrEqual(1);
    expect(echoes[0]!.echo.because).toMatch(/Related to what you said/);
    expect(echoes[0]!.echo.because).toMatch(/on a walk/);
    expect(echoes[0]!.echo.source.thoughtId).not.toBe(echoes[0]!.echo.thoughtId);
  });
});

describe("contradiction", () => {
  it("flags a decision that disagrees with an earlier one, and accepting records supersedes", async () => {
    app = await makeApp({}, "2026-10-04T10:00:00+05:30");
    await app.say("Maybe JWT for the auth module...", { session: "A" });
    await app.say("or no, OAuth2 with PKCE", { gapMs: 1500, session: "A" });
    await app.settle();
    app.ctx.proactive.start();
    app.clock.advance(26 * H);
    await app.say("The auth module decision again, maybe OAuth2...", { session: "B" });
    await app.say("or no, JWT is simpler, going with JWT", { gapMs: 1500, session: "B" });
    await app.settle();
    await wait(900);
    const s = app.suggestions().find((x) => x.kind === "contradiction");
    expect(s).toBeTruthy();
    expect(s!.title).toMatch(/OAuth2.*JWT/i);
    expect(s!.sources).toHaveLength(2);
    await app.ctx.proactive.action(s!.id, "accept");
    expect([...app.ctx.store.edges.values()].some((e) => e.type === "supersedes")).toBe(true);
    expect([...app.ctx.store.edges.values()].some((e) => e.type === "contradicts")).toBe(true);
  });
});

describe("contradiction from a plain-spoken leaning (no self-repair needed)", () => {
  it("'Sarah suggested OAuth2' then 'I'm leaning towards JWT' → a revisit prompt that says what the earlier thought was", async () => {
    app = await makeApp({}, "2026-10-04T10:00:00+05:30");
    await app.say("Sarah suggested we use OAuth2 with PKCE for the mobile app login", { session: "A" });
    await app.settle();
    const sarah = [...app.ctx.store.thoughts.values()][0]!;
    const sa = app.ctx.store.artifacts.get(sarah.artifactId!);
    // a teammate's suggestion is recorded as a tentative leaning, never as the user's decision
    if (sa?.kind === "decision") expect((sa.payload as { status: string }).status).toBe("tentative");

    app.ctx.proactive.start();
    app.clock.advance(26 * H);
    await app.say("Hmm, the auth module needs a decision", { session: "B" });
    await app.say("JWT with a short expiry or OAuth2 with PKCE", { gapMs: 2200, session: "B" });
    await app.say("I'm leaning towards JWT because it's simpler", { gapMs: 1800, session: "B" });
    await app.settle();
    await wait(900);

    const mine = [...app.ctx.store.thoughts.values()].find((t) => t.sessionId === "B")!;
    expect(mine.category).toBe("decision");
    const art = app.ctx.store.artifacts.get(mine.artifactId!)!;
    expect(art.payload).toMatchObject({ kind: "decision", chosen: "JWT", status: "tentative" });

    const s = app.suggestions().find((x) => x.kind === "contradiction");
    expect(s, "a leaning that disagrees with an earlier thought on the same topic should be flagged").toBeTruthy();
    expect(s!.title).toMatch(/OAuth2.*JWT/i);
    expect(s!.body).toMatch(/you were considering OAuth2/); // not "you chose": it was Sarah's suggestion
    app.ctx.proactive.stop();
  });
});

describe("repeated pattern → reusable snippet", () => {
  it("notices the same code idea in two sessions and offers one reusable snippet", async () => {
    app = await makeApp({}, "2026-10-05T12:00:00+05:30");
    await app.say("Maybe retry with exponential backoff and jitter for the webhook sender", { session: "one" });
    await app.settle();
    app.ctx.proactive.start();
    app.clock.advance(19 * H);
    await app.say("A retry wrapper with exponential backoff and jitter on network errors", { session: "two" });
    await app.settle();
    await wait(900);
    const s = app.suggestions().find((x) => x.kind === "snippet");
    expect(s).toBeTruthy();
    expect(s!.body).toMatch(/2×/);
    expect((s!.payload as { code: string }).code.length).toBeGreaterThan(20);
    await app.ctx.proactive.action(s!.id, "accept");
    expect([...app.ctx.store.thoughts.values()].filter((t) => t.promoted).length).toBeGreaterThanOrEqual(2);
  });
});

describe("open loops", () => {
  it("answers a question LATER, when the answer finally gets said", async () => {
    app = await makeApp();
    app.ctx.proactive.start();
    await app.say("Wait, what did Sarah say about the mobile login?", { session: "ask" });
    await app.settle();
    await wait(600);
    expect(app.suggestions().some((s) => s.kind === "open_answer")).toBe(false);
    expect([...app.ctx.store.openLoops.values()].some((o) => o.status === "open")).toBe(true);

    app.clock.advance(20 * 60_000);
    await app.say("Sarah said we should use OAuth2 with PKCE for the mobile login", { session: "answer" });
    await app.settle();
    await wait(900);
    const a = app.suggestions().find((s) => s.kind === "open_answer");
    expect(a).toBeTruthy();
    expect(a!.body.toLowerCase()).toContain("oauth2");
    expect([...app.ctx.store.openLoops.values()].every((o) => o.status === "answered")).toBe(true);
    expect([...app.ctx.store.edges.values()].some((e) => e.type === "answers")).toBe(true);
  });
});

describe("feedback adaptation + delivery rules", () => {
  async function conflictSuggestion(a: TestApp) {
    a.ctx.proactive.start();
    for (let i = 0; i < 3; i++) {
      await a.say(i === 0 ? "Ugh, Thursday's standup is going to clash with the dentist" : i === 1 ? "The dentist overlaps with the Thursday standup again" : "I really need to sort out the standup and dentist clash on Thursday", { gapMs: 2000 });
      await a.settle();
      a.clock.advance(2 * 60_000);
    }
    await wait(900);
    return a.suggestions().find((s) => s.kind === "reschedule");
  }

  it("dismissing raises the bar for that kind and the recurrence count; accepting lowers it; 'later' snoozes", async () => {
    app = await makeApp({ RECURRING_N: "3" });
    const s = await conflictSuggestion(app);
    expect(s).toBeTruthy();
    const get = (key: string) => app!.ctx.store.db.get<{ threshold: number; dismisses: number; accepts: number }>("SELECT threshold, dismisses, accepts FROM pattern_state WHERE key = ?", key);
    await app.ctx.proactive.action(s!.id, "later");
    expect(app.ctx.proactive.snapshot().suggestions.find((x) => x.id === s!.id)?.status).toBe("later");
    await app.ctx.proactive.action(s!.id, "dismiss");
    expect(get("kind:reschedule")!.threshold).toBeCloseTo(0.6, 5); // 0.5 + 0.1
    expect(get("kind:reschedule")!.dismisses).toBe(1);
    expect(get("recurring_n")!.threshold).toBe(4); // 3 → 4: it must repeat more before speaking up again
    expect(app.sent.some((m) => m.type === "suggestion.update" && m.status === "dismissed")).toBe(true);
  });

  it("a dismissed concern is on cooldown (no immediate repeat)", async () => {
    app = await makeApp({ RECURRING_N: "3" });
    const s = await conflictSuggestion(app);
    await app.ctx.proactive.action(s!.id, "dismiss");
    const before = app.sent.filter((m) => m.type === "suggestion.push").length;
    await app.say("The dentist clash with the standup on Thursday is still there", { gapMs: 2000 });
    await app.settle();
    await wait(900);
    expect(app.sent.filter((m) => m.type === "suggestion.push").length).toBe(before);
  });

  it("holds a suggestion while anyone is speaking and honours the minimum gap between suggestions", async () => {
    app = await makeApp({ SUGGESTION_MIN_GAP_S: "120" });
    app.ctx.proactive.start();
    await app.say("Dev needs the staging URL, I'll ping him");
    await app.say("I should also message Sarah about the release", { gapMs: 4000 });
    await app.settle();
    await wait(1000);
    const delivered = of(app, "suggestion.push");
    expect(delivered.length).toBe(1); // second draft waits: 120 s gap
    app.clock.advance(125_000);
    await wait(700);
    expect(of(app, "suggestion.push").length).toBe(2);
  });
});

describe("session brief", () => {
  it("summarises tasks, decisions, snippets, open loops and how many asides were filtered", async () => {
    app = await makeApp();
    app.ctx.proactive.start();
    app.ctx.bus.emit("session.started", { sessionId: "sess-desk", deviceId: "dev-desk" });
    await app.say("I need to refactor the payment service");
    await app.say("Wait, was that my phone?", { gapMs: 4000 });
    await app.say("Maybe JWT...", { gapMs: 4000 });
    await app.say("or no, OAuth2 with PKCE", { gapMs: 1500 });
    await app.say("Maybe a recursive...", { gapMs: 4000 });
    await app.say("no, iterative approach with memoization", { gapMs: 1400 });
    await app.say("What did Sarah say about the rollout?", { gapMs: 4000 });
    await app.settle();
    const brief = await app.ctx.proactive.brief("sess-desk");
    expect(brief).toBeTruthy();
    expect(brief!.tasks.length).toBeGreaterThanOrEqual(1);
    expect(brief!.decisions.some((d) => /oauth/i.test(d.chosen ?? ""))).toBe(true);
    expect(brief!.snippets.length).toBeGreaterThanOrEqual(1);
    expect(brief!.openLoops.join(" ").toLowerCase()).toContain("sarah");
    expect(brief!.filteredCount).toBeGreaterThanOrEqual(1);
    expect(of(app, "brief.ready")).toHaveLength(1);
  });
});
