import { describe, expect, it } from "vitest";
import type { ArtifactView, ThoughtView } from "@synapse/shared";
import { buckets, sessionSummary, statusPill } from "./inbox";

/** The Inbox: Needs you (drafts and questions, newest first) · Done (shipped) · Saved (notes, ideas, decisions). */

let n = 0;
const thought = (category: ThoughtView["category"], artifact: Partial<ArtifactView> | null, createdAt = ++n): ThoughtView =>
  ({
    id: `t${n}`,
    code: `T-${n}`,
    category,
    title: `t${n}`,
    createdAt,
    provisional: false,
    artifact: artifact ? ({ id: `a${n}`, status: "staged", needs: [], payload: { kind: artifact.kind }, ...artifact } as ArtifactView) : null,
  }) as ThoughtView;

describe("inbox buckets", () => {
  it("drafts and ask-cards need you (newest first); shipped is done; notes, ideas and decisions are saved; asides never show", () => {
    const issue = thought("bug", { kind: "github_issue" }, 10);
    const email = thought("communication", { kind: "email_draft", needs: [{ field: "to:team", question: "q", options: [], allowFreeText: true }] }, 20);
    const shipped = thought("scheduling", { kind: "reminder", status: "executed" }, 5);
    const opened = thought("communication", { kind: "email_draft", status: "opened" }, 15);
    const note = thought("idea", { kind: "note" }, 7);
    const decision = thought("decision", { kind: "decision" }, 8);
    const question = thought("question", null, 9);
    const dismissed = thought("bug", { kind: "github_issue", status: "dismissed" }, 11);
    const aside = thought("aside", null, 12);
    const recall = thought("recall_query", { kind: "recall" }, 13);
    const b = buckets([issue, email, shipped, opened, note, decision, question, dismissed, aside, recall]);
    expect(b.needsYou.map((t) => t.id)).toEqual([email.id, opened.id, issue.id]); // opened waits for its Done
    expect(b.done.map((t) => t.id)).toEqual([shipped.id]);
    expect(b.saved.map((t) => t.id)).toEqual([question.id, decision.id, note.id]);
  });
});

describe("session summary", () => {
  it("'Captured 4 things · 2 need you'", () => {
    const ts = [thought("bug", { kind: "github_issue" }), thought("communication", { kind: "email_draft" }), thought("idea", { kind: "note" }), thought("scheduling", { kind: "reminder", status: "executed" })];
    expect(sessionSummary(ts)).toBe("Captured 4 things · 2 need you");
    expect(sessionSummary([ts[2]!])).toBe("Captured 1 thing · saved");
    expect(sessionSummary([])).toBeNull();
  });
});

describe("the one status pill", () => {
  it("Paused wins, then Not connected, Offline, Listening, else Ready", () => {
    expect(statusPill({ paused: true, conn: "open", listening: true, online: true })).toBe("Paused");
    expect(statusPill({ paused: false, conn: "auth", listening: false, online: true })).toBe("Not connected");
    expect(statusPill({ paused: false, conn: "closed", listening: false, online: false })).toBe("Offline");
    expect(statusPill({ paused: false, conn: "closed", listening: false, online: true })).toBe("Not connected");
    expect(statusPill({ paused: false, conn: "open", listening: true, online: true })).toBe("Listening");
    expect(statusPill({ paused: false, conn: "open", listening: false, online: true })).toBe("Ready");
  });
});

describe("order within one capture", () => {
  it("cards made by one capture keep the order they were said in", () => {
    // a few milliseconds apart, one session; an older capture in another session
    const a = { ...thought("bug", { kind: "github_issue" }, 100), code: "T-7", sessionId: "cap-2" } as ThoughtView;
    const b = { ...thought("communication", { kind: "email_draft" }, 103), code: "T-8", sessionId: "cap-2" } as ThoughtView;
    const c = { ...thought("scheduling", { kind: "reminder" }, 106), code: "T-9", sessionId: "cap-2" } as ThoughtView;
    const older = { ...thought("bug", { kind: "github_issue" }, 50), code: "T-2", sessionId: "cap-1" } as ThoughtView;
    expect(buckets([c, older, a, b]).needsYou.map((t) => t.code)).toEqual(["T-7", "T-8", "T-9", "T-2"]);
  });
});
