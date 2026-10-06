import { describe, expect, it } from "vitest";
import { chronoRange, startOfDay, tzOffsetMinutes } from "../src/recall/time";

const TZ = "Asia/Kolkata";
// Tuesday 2026-10-06 15:42 IST
const NOW = Date.parse("2026-10-06T15:42:10+05:30");
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 16).replace("T", " ");

describe("temporal parsing", () => {
  it("knows the zone offset and local midnight", () => {
    expect(tzOffsetMinutes(NOW, TZ)).toBe(330);
    expect(iso(startOfDay(NOW, TZ))).toBe("2026-10-06 00:00");
  });

  it("yesterday → the whole previous day", () => {
    const r = chronoRange("that bug from yesterday", NOW, TZ)!;
    expect(iso(r.from)).toBe("2026-10-05 00:00");
    expect(iso(r.to)).toBe("2026-10-06 00:00");
  });

  it("yesterday afternoon → 12:00–17:00", () => {
    const r = chronoRange("the thing I said yesterday afternoon", NOW, TZ)!;
    expect(iso(r.from)).toBe("2026-10-05 12:00");
    expect(iso(r.to)).toBe("2026-10-05 17:00");
  });

  it("last Tuesday → a past Tuesday (not today)", () => {
    const r = chronoRange("what was that idea last Tuesday", NOW, TZ)!;
    expect(r).not.toBeNull();
    expect(r.to).toBeLessThanOrEqual(startOfDay(NOW, TZ));
    const day = new Date(r.from + 5.5 * HOUR).getUTCDay();
    expect(day).toBe(2); // Tuesday
  });

  it("three days ago", () => {
    const r = chronoRange("three days ago I mentioned the queue", NOW, TZ)!;
    expect(iso(r.from)).toBe("2026-10-03 00:00");
  });

  it("earlier in the hackathon uses the hackathon start", () => {
    const start = Date.parse("2026-10-06T09:00:00+05:30");
    const r = chronoRange("something I said earlier in the hackathon", NOW, TZ, start)!;
    expect(r.from).toBe(start);
    expect(r.to).toBe(NOW);
  });

  it("earlier today / this morning", () => {
    expect(chronoRange("earlier today", NOW, TZ)!.from).toBe(startOfDay(NOW, TZ));
    const m = chronoRange("this morning I said", NOW, TZ)!;
    expect(iso(m.from)).toBe("2026-10-06 05:00");
  });

  it("returns null when there is no time expression", () => {
    expect(chronoRange("the caching idea about embeddings", NOW, TZ)).toBeNull();
  });
});
