import { describe, expect, it } from "vitest";
import type { Artifact, Profile } from "@synapse/shared";
import { applyAnswer, buildLinks, resolveRoute, whenOptions, type RouteInput } from "../src/routing/router";

/**
 * "Ask instead of guess" (V1 phase 3c): where each card goes, from the capture's context, the profile and earlier answers;
 * one question with tap-able options when a fact is missing; and the prefilled handoff links.
 */

const TZ = "Asia/Kolkata";
const NOW = Date.parse("2026-10-06T10:00:00+05:30"); // Tuesday

const profile = (o: Partial<Profile> = {}): Profile => ({
  name: "Rio",
  timezone: TZ,
  repos: [
    { fullName: "acme/shop", aliases: ["shop", "cart service", "checkout"], isDefault: false, topics: ["ecommerce"], description: "Storefront and cart" },
    { fullName: "acme/infra", aliases: ["infra", "terraform"], isDefault: false, topics: ["devops"] },
    { fullName: "rio/synapse-sandbox", aliases: ["synapse sandbox"], isDefault: true },
  ],
  people: [
    { name: "Sarah Chen", aliases: ["sarah"], email: "sarah@acme.io" },
    { name: "Dev Patel", aliases: ["dev"], email: "dev.patel@acme.io" },
    { name: "Dev Rao", aliases: ["dev"], email: "dev.rao@acme.io" },
    { name: "Priya", aliases: [] },
  ],
  learned: [],
  emailApp: "gmail",
  onboarded: true,
  ...o,
});

const issue: Artifact = { kind: "github_issue", title: "Null pointer in cart-service", body_markdown: "**Summary**\nNPE.", labels: ["bug", "cart-service"], hypotheses: [] };
const input = (artifact: Artifact, o: Partial<RouteInput> = {}): RouteInput => ({ artifact, stored: {}, text: "", keywords: [], profile: profile(), now: NOW, tz: TZ, ...o });

describe("GitHub issue: which repo", () => {
  it("1. the capture's context wins", () => {
    expect(resolveRoute(input(issue, { context: { source: "mac", repo: "acme/infra" }, text: "the cart service crashes" })).route.repo).toBe("acme/infra");
  });
  it("2. then a repo name or alias in the speech", () => {
    expect(resolveRoute(input(issue, { text: "the null pointer in the cart service" })).route.repo).toBe("acme/shop");
    expect(resolveRoute(input(issue, { text: "terraform plan fails" })).route.repo).toBe("acme/infra");
  });
  it("3. then the only repo", () => {
    const one = profile({ repos: [{ fullName: "acme/only", aliases: [], isDefault: false }] });
    expect(resolveRoute(input(issue, { text: "something broke", profile: one })).route.repo).toBe("acme/only");
  });
  it("then the default repo; with no default, ask with the top 3 ranked by similarity", () => {
    expect(resolveRoute(input(issue, { text: "something broke" })).route.repo).toBe("rio/synapse-sandbox");
    const noDefault = profile({ repos: profile().repos.map((r) => ({ ...r, isDefault: false })) });
    const r = resolveRoute(input(issue, { text: "the storefront throws on empty carts", profile: noDefault }));
    expect(r.route.repo).toBeUndefined();
    expect(r.needs).toHaveLength(1);
    expect(r.needs[0]).toMatchObject({ field: "repo", question: "Which repo?", allowFreeText: true });
    expect(r.needs[0]!.options.map((o) => o.value)).toEqual(["acme/shop", "acme/infra", "rio/synapse-sandbox"]);
  });
  it("no repos at all: ask, free text only", () => {
    const r = resolveRoute(input(issue, { profile: profile({ repos: [] }) }));
    expect(r.needs[0]).toMatchObject({ field: "repo", options: [], allowFreeText: true, placeholder: "owner/repo" });
  });
  it("an answer is used, and learned against the thought's keywords so the next one is not asked", () => {
    const noDefault = profile({ repos: profile().repos.map((r) => ({ ...r, isDefault: false })) });
    const a = applyAnswer({ artifact: issue, stored: {}, field: "repo", value: "acme/infra", profile: noDefault, keywords: ["queue-worker"], now: NOW, tz: TZ });
    expect(a.stored.repo).toBe("acme/infra");
    expect(a.learned).toEqual([{ kind: "repo_alias", key: "queue-worker", value: "acme/infra", at: NOW }]);
    const next = resolveRoute(input(issue, { text: "the queue-worker is stuck again", profile: { ...noDefault, learned: a.learned } }));
    expect(next.route.repo).toBe("acme/infra");
    expect(() => applyAnswer({ artifact: issue, stored: {}, field: "repo", value: "not a repo", profile: noDefault, keywords: [], now: NOW, tz: TZ })).toThrow(/owner\/name/);
  });
});

describe("email: who", () => {
  const email = (to: string[]): Artifact => ({ kind: "email_draft", to, subject: "Launch", body: "Hi", tone: "neutral" });
  it("names resolve to addresses; an address stays as is", () => {
    expect(resolveRoute(input(email(["Sarah", "ops@acme.io"]))).route.to).toEqual(["sarah@acme.io", "ops@acme.io"]);
  });
  it("two people called Dev: 'Which Dev?'", () => {
    const r = resolveRoute(input(email(["Dev"])));
    expect(r.needs[0]).toMatchObject({ field: "to:dev", question: "Which Dev?" });
    expect(r.needs[0]!.options.map((o) => o.value)).toEqual(["dev.patel@acme.io", "dev.rao@acme.io"]);
  });
  it("a person without an address: 'Priya's email?'; an unknown person too", () => {
    expect(resolveRoute(input(email(["Priya"]))).needs[0]).toMatchObject({ field: "to:priya", question: "Priya's email?", allowFreeText: true });
    expect(resolveRoute(input(email(["Marco"]))).needs[0]).toMatchObject({ field: "to:marco", question: "Marco's email?" });
  });
  it("'the team' asks once for the recipients and is remembered as a group", () => {
    const r = resolveRoute(input(email(["team"])));
    expect(r.needs[0]).toMatchObject({ field: "to:team", question: "Who is “the team”?", allowFreeText: true });
    const a = applyAnswer({ artifact: email(["team"]), stored: {}, field: "to:team", value: "sarah@acme.io, dev.patel@acme.io", profile: profile(), keywords: [], now: NOW, tz: TZ });
    expect(a.learned).toEqual([{ kind: "group_emails", key: "team", value: "sarah@acme.io,dev.patel@acme.io", at: NOW }]);
    expect(resolveRoute(input(email(["team"]), { stored: a.stored })).route.to).toEqual(["sarah@acme.io", "dev.patel@acme.io"]);
    // a second, identical ramble asks nothing
    const again = resolveRoute(input(email(["team"]), { profile: profile({ learned: a.learned }) }));
    expect(again.needs).toEqual([]);
    expect(again.route.to).toEqual(["sarah@acme.io", "dev.patel@acme.io"]);
    expect(() => applyAnswer({ artifact: email(["team"]), stored: {}, field: "to:team", value: "nope", profile: profile(), keywords: [], now: NOW, tz: TZ })).toThrow(/email address/);
  });
  it("a person's answered address is learned for next time", () => {
    const a = applyAnswer({ artifact: email(["Priya"]), stored: {}, field: "to:priya", value: "priya@acme.io", profile: profile(), keywords: [], now: NOW, tz: TZ });
    expect(a.learned[0]).toMatchObject({ kind: "person_email", key: "priya", value: "priya@acme.io" });
    expect(resolveRoute(input(email(["Priya"]), { profile: profile({ learned: a.learned }) })).route.to).toEqual(["priya@acme.io"]);
  });
});

describe("reminder: when", () => {
  const rem = (due_iso: string | null): Artifact => ({ kind: "reminder", what: "Call the landlord", due_iso, due_text: null, recurrence: null });
  it("a time from the speech needs nothing", () => {
    expect(resolveRoute(input(rem("2026-10-07T18:00:00+05:30")))).toEqual({ route: { dueAt: "2026-10-07T18:00:00+05:30" }, needs: [] });
  });
  it("no time: 'When?' with Tonight 9 pm, Tomorrow 9 am, This weekend, and free text", () => {
    const r = resolveRoute(input(rem(null)));
    expect(r.needs[0]).toMatchObject({ field: "due", question: "When?", allowFreeText: true });
    expect(r.needs[0]!.options).toEqual(whenOptions(NOW, TZ));
    expect(whenOptions(NOW, TZ)).toEqual([
      { label: "Tonight 9 pm", value: "2026-10-06T21:00:00+05:30" },
      { label: "Tomorrow 9 am", value: "2026-10-07T09:00:00+05:30" },
      { label: "This weekend", value: "2026-10-10T10:00:00+05:30" },
    ]);
    const typed = applyAnswer({ artifact: rem(null), stored: {}, field: "due", value: "friday 5pm", profile: profile(), keywords: [], now: NOW, tz: TZ });
    expect(typed.stored.dueAt).toBe("2026-10-09T17:00:00+05:30");
    expect(() => applyAnswer({ artifact: rem(null), stored: {}, field: "due", value: "whenever", profile: profile(), keywords: [], now: NOW, tz: TZ })).toThrow(/time/);
  });
});

describe("handoff links", () => {
  it("GitHub: a prefilled new-issue URL with the Synapse footer", () => {
    const l = buildLinks({ artifact: issue, route: { repo: "acme/shop" }, artifactId: "a1", tz: TZ, emailApp: "gmail" });
    const u = new URL(l.newIssue!);
    expect(u.origin + u.pathname).toBe("https://github.com/acme/shop/issues/new");
    expect(u.searchParams.get("title")).toBe("Null pointer in cart-service");
    expect(u.searchParams.get("body")).toContain("Captured by voice with Synapse");
    expect(u.searchParams.get("labels")).toBe("bug,cart-service");
  });
  it("email: mailto and Gmail compose decode to the same recipients, subject and body", () => {
    const art: Artifact = { kind: "email_draft", to: ["team"], subject: "The launch moves to Friday", body: "Hi team,\n\nThe launch moves to Friday.\n\nThanks,\nRio", tone: "neutral" };
    const l = buildLinks({ artifact: art, route: { to: ["sarah@acme.io", "dev.patel@acme.io"] }, artifactId: "a2", tz: TZ, emailApp: "gmail" });
    const m = new URL(l.mailto!);
    expect(decodeURIComponent(m.pathname)).toBe("sarah@acme.io,dev.patel@acme.io");
    expect(m.searchParams.get("subject")).toBe("The launch moves to Friday");
    expect(m.searchParams.get("body")).toBe(art.body);
    const g = new URL(l.gmail!);
    expect(g.host).toBe("mail.google.com");
    expect(Object.fromEntries(g.searchParams)).toMatchObject({ view: "cm", fs: "1", to: "sarah@acme.io,dev.patel@acme.io", su: "The launch moves to Friday", body: art.body });
  });
  it("reminder: a Google Calendar template for a 15-minute block in UTC, plus the .ics export", () => {
    const l = buildLinks({ artifact: { kind: "reminder", what: "Call the landlord", due_iso: null, due_text: null, recurrence: null }, route: { dueAt: "2026-10-07T18:00:00+05:30" }, artifactId: "a3", tz: TZ, emailApp: "gmail" });
    const c = new URL(l.calendar!);
    expect(c.searchParams.get("action")).toBe("TEMPLATE");
    expect(c.searchParams.get("text")).toBe("Call the landlord");
    expect(c.searchParams.get("dates")).toBe("20261007T123000Z/20261007T124500Z");
    expect(c.searchParams.get("ctz")).toBe(TZ);
    expect(l.ics).toBe("/api/artifacts/a3/export?format=ics");
  });
  it("message: a WhatsApp share link; nothing until a destination is known", () => {
    expect(buildLinks({ artifact: { kind: "message_draft", to: "Sarah", channel: "whatsapp", body: "On my way" }, route: {}, artifactId: "a4", tz: TZ, emailApp: "gmail" }).whatsapp).toBe("https://wa.me/?text=On%20my%20way");
    expect(buildLinks({ artifact: issue, route: {}, artifactId: "a5", tz: TZ, emailApp: "gmail" })).toEqual({});
  });
});
