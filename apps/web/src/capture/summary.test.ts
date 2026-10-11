import { describe, expect, it } from "vitest";
import type { ThoughtView } from "@synapse/shared";
import { madeLine, thingLabel } from "./summary";

const t = (category: ThoughtView["category"], kind?: string): Pick<ThoughtView, "category" | "artifact"> => ({
  category,
  artifact: kind ? ({ kind } as ThoughtView["artifact"]) : null,
});

describe("capture summary", () => {
  it("names what each thought became, in plain words", () => {
    expect(thingLabel(t("bug", "github_issue"))).toBe("GitHub issue");
    expect(thingLabel(t("communication", "email_draft"))).toBe("Email");
    expect(thingLabel(t("scheduling", "reminder"))).toBe("Reminder");
    expect(thingLabel(t("scheduling", "calendar_event"))).toBe("Event");
    expect(thingLabel(t("idea", "note"))).toBe("Idea");
    expect(thingLabel(t("decision", "decision"))).toBe("Decision");
    expect(thingLabel(t("journal", "note"))).toBe("Note");
    expect(thingLabel(t("question"))).toBe("Question");
  });

  it("one line per capture", () => {
    expect(madeLine([t("bug", "github_issue"), t("communication", "email_draft"), t("scheduling", "reminder")])).toBe("Made 3 things: GitHub issue · Email · Reminder");
    expect(madeLine([t("idea", "note")])).toBe("Made 1 thing: Idea");
    expect(madeLine([])).toBe("Nothing to keep (asides are skipped)");
  });
});
