import { describe, expect, it } from "vitest";
import type { ArtifactKind } from "@synapse/shared";
import { setDisplayTimezone } from "./format";
import { KIND_TINT, distinctExcerpt, excerptOf, plainLine, refLabel } from "./outbox-excerpt";

const a = (kind: ArtifactKind, payload: Record<string, unknown>) => ({ kind, payload: { kind, ...payload } as never });

describe("plainLine", () => {
  it("flattens markdown to one readable line", () => {
    const md = "## NPE in cart-service\n\n**Steps**\n- apply a `discount` code\n- see the [log](http://x/y) \n\n```ts\nconst x = 1;\n```\n> quoted";
    expect(plainLine(md)).toBe("NPE in cart-service: Steps: • apply a discount code • see the log quoted");
  });

  it("treats a line that is only bold as a heading, and keeps bold inside a sentence", () => {
    expect(plainLine("**Summary**\nIt crashes.\n\n**Observed:**\nA null pointer.")).toBe("Summary: It crashes. Observed: A null pointer.");
    expect(plainLine("This is **really** bad")).toBe("This is really bad");
  });

  it("turns headings into labels and numbered items into bullets", () => {
    expect(plainLine("## Summary\nIt crashes.\n\n## Next steps:\n1. Reproduce\n2. Fix")).toBe("Summary: It crashes. Next steps: • Reproduce • Fix");
  });

  it("keeps snake_case and single stars that are not emphasis", () => {
    expect(plainLine("fix cart_service 2 * 3")).toBe("fix cart_service 2 * 3");
    expect(plainLine("a *really* bad bug")).toBe("a really bad bug");
  });

  it("handles empty input", () => {
    expect(plainLine("")).toBe("");
    expect(plainLine("   \n\n ")).toBe("");
  });
});

describe("excerptOf", () => {
  it("summarises an email with its recipients", () => {
    expect(excerptOf(a("email_draft", { to: ["team@acme.dev", "Sarah"], subject: "Delay", body: "Hi all,\nthe release slips by two days." }))).toBe("To team@acme.dev, Sarah. Hi all, the release slips by two days.");
    expect(excerptOf(a("email_draft", { to: [], subject: "x", body: "Quick note." }))).toBe("Quick note.");
  });

  it("summarises messages, issues and tickets from their body", () => {
    expect(excerptOf(a("message_draft", { to: "Sarah", channel: "slack", body: "Can you review?" }))).toBe("To Sarah. Can you review?");
    expect(excerptOf(a("github_issue", { title: "t", body_markdown: "## Problem\nNull pointer when the code is empty.", labels: [], hypotheses: [] }))).toBe("Problem: Null pointer when the code is empty.");
    expect(excerptOf(a("ticket", { title: "t", description: "Rotate the staging keys before Friday." }))).toBe("Rotate the staging keys before Friday.");
  });

  it("states a decision with what was rejected", () => {
    expect(excerptOf(a("decision", { question: "q", chosen: "OAuth2", rejected: ["JWT"], status: "decided" }))).toBe("Chose OAuth2 over JWT");
    expect(excerptOf(a("decision", { question: "q", chosen: "OAuth2", rejected: [], status: "tentative" }))).toBe("Leaning towards OAuth2");
    expect(excerptOf(a("decision", { question: "q", chosen: null, rejected: [], status: "tentative" }))).toBe("Not decided yet");
  });

  it("says when a calendar event still needs a time", () => {
    expect(excerptOf(a("calendar_event", { title: "Design review", start_iso: null, end_iso: null, time_expression: "Thursday at 3pm", attendees: [] }))).toBe("You said “Thursday at 3pm”: it needs a concrete time");
    expect(excerptOf(a("calendar_event", { title: "x", start_iso: null, end_iso: null, time_expression: null, attendees: [] }))).toBe("Needs a time");
  });

  it("prints a concrete calendar time with attendees", () => {
    setDisplayTimezone("UTC");
    const out = excerptOf(a("calendar_event", { title: "x", start_iso: "2026-10-08T10:30:00.000Z", end_iso: "2026-10-08T11:00:00.000Z", time_expression: null, attendees: ["Sarah"] }));
    setDisplayTimezone(undefined);
    expect(out).toBe("Thu 8 Oct · 10:30–11:00 · with Sarah");
  });

  it("uses the approach for a snippet and the target for a code comment", () => {
    expect(excerptOf(a("code_snippet", { language: "ts", approach: "Iterative with memoization", code: "x", explanation: "long" }))).toBe("Iterative with memoization");
    expect(excerptOf(a("code_snippet", { language: "ts", approach: "", code: "x", explanation: "It caches results." }))).toBe("It caches results.");
    expect(excerptOf(a("code_comment", { target: "cart.ts:42", comment: "why" }))).toBe("On cart.ts:42");
    expect(excerptOf(a("code_comment", { target: null, comment: "why" }))).toBe("");
  });

  it("reads notes and journal entries, and truncates long text", () => {
    expect(excerptOf(a("note", { body: "Look at caching.", tags: [] }))).toBe("Look at caching.");
    const long = excerptOf(a("journal", { body: "word ".repeat(100) }), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });

  it("copes with empty or partial payloads", () => {
    expect(excerptOf({ kind: "email_draft", payload: {} as never })).toBe("");
    expect(excerptOf({ kind: "none", payload: { kind: "none" } as never })).toBe("");
    expect(excerptOf({ kind: "ticket", payload: undefined as never })).toBe("");
  });
});

describe("distinctExcerpt", () => {
  it("drops an excerpt that only repeats the title", () => {
    expect(distinctExcerpt("Tell Sarah the OAuth flow needs PKCE", "Tell Sarah the OAuth flow needs PKCE.")).toBe("");
    expect(distinctExcerpt("Tell Sarah the OAuth flow needs PKCE", "tell sarah the oauth flow needs pkce")).toBe("");
    expect(distinctExcerpt("A long title that contains the excerpt text", "A long title")).toBe("");
    expect(distinctExcerpt("anything", "")).toBe("");
  });

  it("keeps only the continuation when the title is the start of the same text", () => {
    const body = "The retry policy for webhooks, maybe exponential backoff with jitter and a dead letter queue after five tries";
    const title = body.slice(0, 40); // "The retry policy for webhooks, maybe exp" cuts a word in half
    expect(distinctExcerpt(title, body)).toBe("…backoff with jitter and a dead letter queue after five tries");
    expect(distinctExcerpt("The retry policy for webhooks,", body)).toBe("…maybe exponential backoff with jitter and a dead letter queue after five tries");
  });

  it("hides a continuation that is too short to be worth a line", () => {
    expect(distinctExcerpt("Rotate the staging keys before Friday", "Rotate the staging keys before Friday please")).toBe("");
  });

  it("keeps an excerpt that says something else", () => {
    expect(distinctExcerpt("NPE in cart-service", "Summary: it crashes with an empty discount code")).toBe("Summary: it crashes with an empty discount code");
  });
});

describe("kinds and references", () => {
  it("tints every artifact kind", () => {
    for (const hex of Object.values(KIND_TINT)) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("hides internal calendar ids", () => {
    expect(refLabel("cal:01M4ABCDEF")).toBe("On your calendar");
    expect(refLabel("GH-101")).toBe("GH-101");
    expect(refLabel("acme/app#12")).toBe("acme/app#12");
  });
});
