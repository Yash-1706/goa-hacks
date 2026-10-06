import { beforeAll, describe, expect, it } from "vitest";
import {
  activityLabel,
  clamp,
  describePause,
  formatAgo,
  formatBytes,
  formatClock,
  formatCountdown,
  formatDayTime,
  formatGap,
  formatMs,
  formatPct,
  formatRange,
  latencyTone,
  lifeLeft,
  placeLabel,
  plural,
  setDisplayTimezone,
  stripCitations,
} from "./format";

describe("formatCountdown", () => {
  it("shows days and hours for long retention", () => {
    expect(formatCountdown(3 * 86_400_000 + 5 * 3_600_000)).toBe("3d 5h");
  });
  it("shows hours and zero-padded minutes under three days", () => {
    expect(formatCountdown(71 * 3_600_000 + 12 * 60_000)).toBe("71h 12m");
    expect(formatCountdown(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
  });
  it("shows minutes and seconds under an hour, seconds under a minute", () => {
    expect(formatCountdown(42 * 60_000 + 9_000)).toBe("42m 09s");
    expect(formatCountdown(58_000)).toBe("58s");
  });
  it("never goes negative", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5000)).toBe("now");
    expect(formatCountdown(Number.NaN)).toBe("now");
  });
});

describe("lifeLeft", () => {
  it("is 1 for long-term memory", () => {
    expect(lifeLeft(null, 0, 100)).toBe(1);
    expect(lifeLeft(undefined, 0, 100)).toBe(1);
  });
  it("falls linearly towards expiry and clamps", () => {
    expect(lifeLeft(1000, 0, 250)).toBeCloseTo(0.75);
    expect(lifeLeft(1000, 0, 2000)).toBe(0);
    expect(lifeLeft(1000, 0, -500)).toBe(1);
  });
});

describe("formatGap", () => {
  it("renders pause gaps like the stream does", () => {
    expect(formatGap(1400)).toBe("1.4s");
    expect(formatGap(12_000)).toBe("12s");
    expect(formatGap(125_000)).toBe("2m 05s");
    expect(formatGap(400)).toBe("0.4s");
  });
});

describe("formatMs / latencyTone", () => {
  it("formats milliseconds and seconds", () => {
    expect(formatMs(820)).toBe("820 ms");
    expect(formatMs(1240)).toBe("1.24 s");
    expect(formatMs(15_300)).toBe("15.3 s");
    expect(formatMs(undefined)).toBe("–");
    expect(formatMs(Number.NaN)).toBe("–");
  });
  it("applies the PRD latency targets", () => {
    expect(latencyTone(900)).toBe("good");
    expect(latencyTone(1200)).toBe("ok");
    expect(latencyTone(2400)).toBe("bad");
  });
});

describe("misc formatters", () => {
  it("formats bytes, percents and plurals", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatPct(0.734)).toBe("73%");
    expect(formatPct(0.7342, 1)).toBe("73.4%");
    expect(plural(1, "card")).toBe("1 card");
    expect(plural(3, "card")).toBe("3 cards");
    expect(plural(2, "entity", "entities")).toBe("2 entities");
  });
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
  it("describes places and activities in plain words", () => {
    expect(placeLabel("walking")).toBe("on a walk");
    expect(placeLabel("vehicle")).toBe("while travelling");
    expect(placeLabel("desk", "desk")).toBe("at your desk");
    expect(placeLabel("still", "pocket")).toBe("on your phone");
    expect(placeLabel(undefined, "pocket")).toBe("on your phone");
    expect(activityLabel("walking")).toBe("Walking");
    expect(activityLabel("unknown")).toBe("No motion data");
  });
  it("strips citations for speech", () => {
    expect(stripCitations("You chose OAuth2 [T-12] on Monday [T-3, T-9].")).toBe("You chose OAuth2 on Monday.");
    expect(stripCitations("no citations here")).toBe("no citations here");
  });
});

describe("relative and absolute times", () => {
  beforeAll(() => setDisplayTimezone("UTC"));
  const now = Date.UTC(2026, 9, 7, 12, 0, 0); // Wed 7 Oct 2026 12:00 UTC

  it("formatAgo", () => {
    expect(formatAgo(now - 10_000, now)).toBe("just now");
    expect(formatAgo(now - 4 * 60_000, now)).toBe("4m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAgo(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(formatAgo(now - 5 * 86_400_000, now)).toBe("5d ago");
  });

  it("formatClock uses the configured time zone", () => {
    expect(formatClock(Date.UTC(2026, 9, 7, 9, 5))).toBe("09:05");
    setDisplayTimezone("Asia/Kolkata");
    expect(formatClock(Date.UTC(2026, 9, 7, 9, 5))).toBe("14:35");
    setDisplayTimezone("UTC");
  });

  it("formatDayTime says Today / Yesterday / weekday / date", () => {
    expect(formatDayTime(Date.UTC(2026, 9, 7, 10, 42), now)).toBe("Today 10:42");
    expect(formatDayTime(Date.UTC(2026, 9, 6, 16, 10), now)).toBe("Yesterday 16:10");
    expect(formatDayTime(Date.UTC(2026, 9, 5, 11, 20), now)).toMatch(/^Mon 11:20$/);
    expect(formatDayTime(Date.UTC(2026, 8, 20, 9, 0), now)).toBe("20 Sept 09:00");
  });

  it("formatRange appends the end time", () => {
    const s = Date.UTC(2026, 9, 8, 10, 30);
    expect(formatRange(s, s + 30 * 60_000)).toBe("Thu 8 Oct · 10:30–11:00");
    expect(formatRange(s)).toBe("Thu 8 Oct · 10:30");
  });

  it("survives an unknown time zone name", () => {
    setDisplayTimezone("Not/AZone");
    expect(formatClock(Date.UTC(2026, 9, 7, 9, 5))).toMatch(/^\d\d:\d\d$/);
    setDisplayTimezone("UTC");
  });
});

describe("describePause", () => {
  const devices = [
    { deviceId: "desk-1", name: "Desk" },
    { deviceId: "phone-1", name: "Phone" },
  ];
  it("says how and where memory was paused", () => {
    expect(describePause({ by: "desk-1", via: "voice", selfId: "desk-1", devices })).toBe("by voice on this device");
    expect(describePause({ by: "desk-1", via: "tap", selfId: "desk-1", devices })).toBe("with a tap on this device");
    expect(describePause({ by: "phone-1", via: null, selfId: "desk-1", devices })).toBe("from Phone");
    expect(describePause({ by: "api", via: null, selfId: "desk-1", devices })).toBe("through the API");
    expect(describePause({ by: "ghost", via: null, selfId: "desk-1", devices })).toBe("from another device");
    expect(describePause({ by: null, via: null, selfId: "desk-1", devices })).toBe("");
    expect(describePause({ by: "unknown", via: "kws", selfId: "x", devices })).toBe("by keyword");
  });
});
