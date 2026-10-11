import { describe, expect, it } from "vitest";
import type { ArtifactView } from "@synapse/shared";
import { cardLabel, destination, preview, primaryAction, shippedText } from "./ship";

/** The V1 card face: one plain label, where it goes, and ONE primary action (or a reason it cannot ship yet). */

const view = (payload: ArtifactView["payload"], extra: Partial<ArtifactView> = {}): ArtifactView => ({
  id: "a1",
  code: "A-1",
  kind: payload.kind,
  status: "staged",
  autonomyLevel: 2,
  payload,
  createdAt: 0,
  updatedAt: 0,
  needs: [],
  links: {},
  ...extra,
});

const issue = view(
  { kind: "github_issue", title: "Null pointer in cart-service", body_markdown: "**Summary**\nIt crashes.", labels: ["bug"], hypotheses: [] },
  { route: { repo: "acme/shop" }, links: { newIssue: "https://github.com/acme/shop/issues/new?title=x" } },
);
const email = view(
  { kind: "email_draft", to: ["team"], subject: "The launch moves to Friday", body: "Hi team,\n\nThe launch moves to Friday.\n\nThanks,\nRio", tone: "neutral" },
  { route: { to: ["sarah@acme.io", "dev@acme.io"] }, links: { mailto: "mailto:sarah@acme.io,dev@acme.io?subject=x", gmail: "https://mail.google.com/mail/?view=cm&to=x" } },
);
const reminder = view(
  { kind: "reminder", what: "Call the landlord", due_iso: "2026-10-07T18:00:00+05:30", due_text: "tomorrow at 6", recurrence: null },
  { route: { dueAt: "2026-10-07T18:00:00+05:30" }, links: { calendar: "https://calendar.google.com/calendar/render?action=TEMPLATE", ics: "/api/artifacts/a1/export?format=ics" } },
);

describe("card face", () => {
  it("plain labels", () => {
    expect([issue, email, reminder].map((a) => cardLabel(a))).toEqual(["GitHub issue", "Email draft", "Reminder"]);
    expect(cardLabel(view({ kind: "note", body: "x", tags: [] }))).toBe("Note");
    expect(cardLabel(view({ kind: "decision", question: "q", chosen: null, rejected: [], rationale: null, status: "tentative" }))).toBe("Decision");
  });

  it("where it goes", () => {
    expect(destination(issue, "Asia/Kolkata")).toBe("acme/shop");
    expect(destination(email, "Asia/Kolkata")).toBe("To sarah@acme.io, dev@acme.io");
    expect(destination(reminder, "Asia/Kolkata")).toMatch(/^Wed 7 Oct, 6:00\s?pm$/i);
    expect(destination(view(email.payload), "Asia/Kolkata")).toBe("To team");
  });

  it("a short preview of the content", () => {
    expect(preview(issue)).toBe("It crashes.");
    expect(preview(email)).toBe("The launch moves to Friday.");
  });
});

describe("the one primary action", () => {
  it("GitHub issue: create for real when an account is connected, else open the prefilled page", () => {
    expect(primaryAction({ ...issue, canCreate: true }, { mobile: false, emailApp: "gmail" })).toEqual({ label: "Create issue", kind: "push" });
    expect(primaryAction(issue, { mobile: false, emailApp: "gmail" })).toEqual({ label: "Create issue", kind: "link", url: issue.links!.newIssue, via: "github" });
  });

  it("email: Gmail on a laptop (or the mail app if chosen), the mail app on a phone", () => {
    expect(primaryAction(email, { mobile: false, emailApp: "gmail" })).toMatchObject({ label: "Open draft", kind: "link", url: email.links!.gmail, via: "gmail" });
    expect(primaryAction(email, { mobile: false, emailApp: "mailto" })).toMatchObject({ url: email.links!.mailto, via: "mail" });
    expect(primaryAction(email, { mobile: true, emailApp: "gmail" })).toMatchObject({ url: email.links!.mailto, via: "mail" });
  });

  it("reminder: add to calendar", () => {
    expect(primaryAction(reminder, { mobile: true, emailApp: "gmail" })).toEqual({ label: "Add to calendar", kind: "link", url: reminder.links!.calendar, via: "calendar" });
  });

  it("an open question disables it, with the reason; a note has none; shipped says where it went", () => {
    const asking = { ...email, needs: [{ field: "to:team", question: "Who is “the team”?", options: [], allowFreeText: true }], links: {} };
    expect(primaryAction(asking, { mobile: false, emailApp: "gmail" })).toMatchObject({ label: "Open draft", disabled: true, reason: "Needs one answer" });
    expect(primaryAction(view({ kind: "note", body: "x", tags: [] }), { mobile: false, emailApp: "gmail" })).toBeNull();
    expect(shippedText({ ...issue, status: "executed", externalRef: "acme/shop#123", externalUrl: "https://github.com/acme/shop/issues/123" })).toEqual({ text: "Created #123", url: "https://github.com/acme/shop/issues/123" });
    // V1.1: a handoff is "Opened" (still waiting for one tap on Done), then Done
    expect(shippedText({ ...email, status: "opened", externalRef: "opened:gmail" })).toEqual({ text: "Opened in Gmail", opened: true });
    expect(shippedText({ ...reminder, status: "opened", externalRef: "opened:calendar" })).toEqual({ text: "Opened in Calendar", opened: true });
    expect(shippedText({ ...email, status: "executed", externalRef: "opened:gmail" })).toEqual({ text: "Sent from Gmail" });
    expect(shippedText({ ...reminder, status: "executed", externalRef: "opened:calendar" })).toEqual({ text: "Added to calendar" });
    expect(shippedText(issue)).toBeNull();
  });
});
