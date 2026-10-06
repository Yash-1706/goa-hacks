import { describe, expect, it } from "vitest";
import type { Artifact, ArtifactView } from "@synapse/shared";
import {
  EDIT_FIELDS,
  artifactHeadline,
  artifactText,
  buildPatch,
  fieldToText,
  isEditable,
  isoToLocalInput,
  localInputToIso,
  partialOf,
  pushLabel,
  pushability,
  str,
  strArr,
} from "./artifacts";

const view = (payload: Artifact | Record<string, unknown>, over: Partial<ArtifactView> = {}): ArtifactView => ({
  id: "a1",
  code: "A-1",
  kind: (payload as { kind: ArtifactView["kind"] }).kind,
  status: "draft",
  autonomyLevel: 1,
  payload: payload as Artifact,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("pushability (mirrors the server's Outbox.pushability)", () => {
  it("only external kinds can be pushed", () => {
    expect(pushability(view({ kind: "github_issue", title: "t", body_markdown: "b", labels: [], hypotheses: [] })).ok).toBe(true);
    expect(pushability(view({ kind: "ticket" })).ok).toBe(true);
    const email = pushability(view({ kind: "email_draft", to: [], subject: "", body: "", tone: "neutral" }));
    expect(email.ok).toBe(false);
    expect(email.reason).toMatch(/copy or open/);
  });
  it("a calendar event needs a concrete time", () => {
    const noTime = pushability(view({ kind: "calendar_event", title: "x", start_iso: null, end_iso: null, time_expression: "thursday", attendees: [], is_reschedule: false }));
    expect(noTime).toEqual({ ok: false, reason: "needs a time: say when" });
    expect(pushability(view({ kind: "calendar_event", title: "x", start_iso: "2026-10-08T10:30:00Z", end_iso: null, time_expression: null, attendees: [], is_reschedule: false })).ok).toBe(true);
  });
  it("is false once executed or dismissed, and for no artifact", () => {
    expect(pushability(view({ kind: "github_issue" }, { status: "executed" })).reason).toBe("already pushed");
    expect(pushability(view({ kind: "github_issue" }, { status: "dismissed" })).ok).toBe(false);
    expect(pushability(null).ok).toBe(false);
  });
  it("labels the push button per kind", () => {
    expect(pushLabel("github_issue")).toBe("Create issue");
    expect(pushLabel("ticket")).toBe("Create ticket");
    expect(pushLabel("calendar_event")).toBe("Add to calendar");
  });
});

describe("partial payload access", () => {
  it("returns the payload only for the matching kind and survives missing fields", () => {
    const a = view({ kind: "ticket", title: "Half-streamed" });
    expect(partialOf(a, "ticket")?.title).toBe("Half-streamed");
    expect(partialOf(a, "github_issue")).toBeNull();
    expect(partialOf(null, "ticket")).toBeNull();
  });
  it("str / strArr coerce unknown values safely", () => {
    expect(str(undefined)).toBe("");
    expect(str(3)).toBe("");
    expect(str("x")).toBe("x");
    expect(strArr(["a", 1, "", "b", null])).toEqual(["a", "b"]);
    expect(strArr("nope")).toEqual([]);
  });
});

describe("copy text and headlines", () => {
  it("renders an email draft as plain text", () => {
    const a = view({ kind: "email_draft", to: ["a@b.co", "team"], subject: "Delay", body: "Hi", tone: "casual" });
    expect(artifactText(a)).toBe("To: a@b.co, team\nSubject: Delay\n\nHi");
  });
  it("renders other kinds", () => {
    expect(artifactText(view({ kind: "code_snippet", code: "x = 1", language: "py" }))).toBe("x = 1");
    expect(artifactText(view({ kind: "github_issue", title: "T", body_markdown: "B" }))).toBe("# T\n\nB");
    expect(artifactText(view({ kind: "decision", question: "Q?", chosen: "OAuth2", rejected: ["JWT"], rationale: "r", status: "decided" }))).toContain("Rejected: JWT");
    expect(artifactText(null)).toBe("");
  });
  it("finds a sensible headline", () => {
    expect(artifactHeadline(view({ kind: "email_draft", subject: "Subject!", to: [], body: "", tone: "casual" }))).toBe("Subject!");
    expect(artifactHeadline(view({ kind: "note", body: "x".repeat(200), tags: [] }))).toHaveLength(80);
  });
});

describe("editing", () => {
  it("knows which kinds are editable", () => {
    expect(isEditable("ticket")).toBe(true);
    expect(isEditable("recall")).toBe(false);
    expect(isEditable("none")).toBe(false);
    expect(Object.keys(EDIT_FIELDS).length).toBeGreaterThan(8);
  });

  it("round-trips local datetime values", () => {
    const iso = "2026-10-08T10:30:00.000Z";
    const local = isoToLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    expect(localInputToIso(local)).toBe(new Date(local).toISOString());
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput("garbage")).toBe("");
    expect(localInputToIso("")).toBeNull();
  });

  it("builds a patch of ONLY the changed fields, converting lists", () => {
    const payload = { kind: "ticket", title: "Old", description: "d", issue_type: "task", priority: "low", labels: ["a"], acceptance_criteria: ["x", "y"] };
    const form = Object.fromEntries((EDIT_FIELDS.ticket ?? []).map((f) => [f.key, fieldToText(f, payload)]));
    expect(buildPatch("ticket", form, payload)).toEqual({});
    const patch = buildPatch("ticket", { ...form, title: "New", acceptance_criteria: "x\n\n z \n", priority: "high" }, payload);
    expect(patch).toEqual({ title: "New", acceptance_criteria: ["x", "z"], priority: "high" });
  });

  it("turns an emptied datetime into null (clears the time)", () => {
    const payload = { kind: "calendar_event", title: "t", start_iso: "2026-10-08T10:30:00.000Z", end_iso: null, time_expression: null, attendees: [], is_reschedule: false };
    const form = Object.fromEntries((EDIT_FIELDS.calendar_event ?? []).map((f) => [f.key, fieldToText(f, payload)]));
    expect(buildPatch("calendar_event", { ...form, start_iso: "" }, payload)).toEqual({ start_iso: null });
  });
});
