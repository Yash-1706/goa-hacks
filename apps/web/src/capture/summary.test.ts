import { describe, expect, it } from "vitest";
import type { ThoughtView } from "@synapse/shared";
import { macUnreachable, madeLine, thingLabel, waitingLine } from "./summary";

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

  it("V1.1: a clip waiting because the Mac does not answer says so (the phone is online; the Mac is asleep or off)", () => {
    expect(macUnreachable("network")).toBe(true); // fetch threw while the phone had signal
    expect(macUnreachable("HTTP 530")).toBe(true); // Cloudflare: origin unreachable (a proxy page, not our JSON)
    expect(macUnreachable("HTTP 502")).toBe(true); // Tailscale Funnel with the server down
    expect(macUnreachable("HTTP 404")).toBe(true); // ngrok: endpoint offline
    expect(macUnreachable("The server is busy, try again")).toBe(false); // our own JSON error: the Mac answered
    expect(waitingLine({ error: "network" }, true)).toBe("Saved on your phone. It will sync when your Mac is awake.");
    expect(waitingLine({ error: "HTTP 530" }, true)).toBe("Saved on your phone. It will sync when your Mac is awake.");
    expect(waitingLine({ error: "network" }, false)).toBe("Waiting for network");
    expect(waitingLine({}, true)).toBe("Waiting to send");
  });
});

