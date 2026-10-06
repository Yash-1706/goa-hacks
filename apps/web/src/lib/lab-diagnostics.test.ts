import { describe, expect, it } from "vitest";
import type { CalendarEventView } from "@synapse/shared";
import type { StampedDiagnostic } from "@/state/audio";
import { calendarWindow, dbfs, describeDiagnostic, describeDiagnostics, findOverlaps, noiseFloorText } from "./lab-diagnostics";

type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;
const at = 1_000;
const d = (x: WithoutAt<StampedDiagnostic>): StampedDiagnostic => ({ ...x, at }) as StampedDiagnostic;

describe("noise floor", () => {
  it("converts a linear RMS to dBFS", () => {
    expect(dbfs(0.01)).toBeCloseTo(-40, 6);
    expect(dbfs(1)).toBeCloseTo(0, 6);
    expect(dbfs(0)).toBeCloseTo(-100, 6); // floored
  });

  it("prints RMS and dBFS together", () => {
    expect(noiseFloorText(0.0042)).toBe("0.0042 RMS · −47.5 dBFS");
    expect(noiseFloorText(0.25)).toBe("0.25 RMS · −12.0 dBFS");
    expect(noiseFloorText(null)).toBe("–");
    expect(noiseFloorText(NaN)).toBe("–");
  });
});

describe("describeDiagnostic", () => {
  it("reads the standby socket", () => {
    expect(describeDiagnostic(d({ kind: "standby", state: "ready" }))).toMatchObject({ label: "Standby", tone: "ok", text: "Standby socket ready" });
    expect(describeDiagnostic(d({ kind: "standby", state: "connecting" })).tone).toBe("info");
    const down = describeDiagnostic(d({ kind: "standby", state: "down", detail: "closed 1006" }));
    expect(down.tone).toBe("warn");
    expect(down.text).toBe("Standby socket down · closed 1006");
    expect(describeDiagnostic(d({ kind: "standby", state: "ready", assumed: true })).text).toContain("assumed ready");
  });

  it("flags fallbacks as warnings and anomalies as bad", () => {
    expect(describeDiagnostic(d({ kind: "fallback", reason: "socket closed before final" }))).toMatchObject({ tone: "warn", text: "Used the REST fallback · socket closed before final" });
    expect(describeDiagnostic(d({ kind: "anomaly", detail: "mic track ended" }))).toMatchObject({ tone: "bad", text: "mic track ended" });
  });

  it("grades commit → final latency", () => {
    expect(describeDiagnostic(d({ kind: "latency", commitToFinalMs: 420.4, transport: "wispr_ws" }))).toMatchObject({ tone: "ok", text: "Commit → final text 420 ms (websocket)" });
    expect(describeDiagnostic(d({ kind: "latency", commitToFinalMs: 1200, transport: "wispr_rest" })).tone).toBe("info");
    expect(describeDiagnostic(d({ kind: "latency", commitToFinalMs: 2500, transport: "wispr_rest" }))).toMatchObject({ tone: "warn", text: expect.stringContaining("REST") });
  });

  it("reports calibration and mode changes", () => {
    expect(describeDiagnostic(d({ kind: "calibrated", noiseFloor: 0.005 })).text).toContain("Noise floor measured");
    expect(describeDiagnostic(d({ kind: "mode", mode: "eco" })).text).toContain("Eco");
    expect(describeDiagnostic(d({ kind: "mode", mode: "normal" })).text).toBe("Switched to Normal mode");
  });

  it("caps very long free text", () => {
    const line = describeDiagnostic(d({ kind: "anomaly", detail: "x".repeat(400) }));
    expect(line.text.length).toBeLessThanOrEqual(140);
    expect(line.text.endsWith("…")).toBe(true);
  });

  it("lists the newest events first and honours the limit", () => {
    const list = [1, 2, 3, 4].map((i) => ({ kind: "mode", mode: i % 2 ? "eco" : "normal", at: i * 10 }) as StampedDiagnostic);
    expect(describeDiagnostics(list, 3).map((l) => l.at)).toEqual([40, 30, 20]);
    expect(describeDiagnostics([], 3)).toEqual([]);
  });
});

const ev = (id: string, title: string, start: number, end: number): CalendarEventView => ({ id, title, start, end, source: "seed" });
const H = 3_600_000;

describe("calendar clashes", () => {
  it("finds overlapping events and not back-to-back ones", () => {
    const events = [ev("a", "Team standup", 10 * H, 10.5 * H), ev("b", "Dentist", 10.25 * H, 11 * H), ev("c", "Lunch", 11 * H, 12 * H), ev("d", "Review", 13 * H, 14 * H)];
    const clashes = findOverlaps(events);
    expect(clashes.get("a")).toEqual(["Dentist"]);
    expect(clashes.get("b")).toEqual(["Team standup"]);
    expect(clashes.has("c")).toBe(false); // starts exactly when Dentist ends
    expect(clashes.has("d")).toBe(false);
  });

  it("handles one long event covering several short ones", () => {
    const events = [ev("a", "Workshop", 9 * H, 17 * H), ev("b", "Call", 10 * H, 11 * H), ev("c", "Sync", 12 * H, 13 * H)];
    const clashes = findOverlaps(events);
    expect(clashes.get("a")).toEqual(["Call", "Sync"]);
    expect(clashes.get("b")).toEqual(["Workshop"]);
    expect(clashes.get("c")).toEqual(["Workshop"]);
  });

  it("is empty without events", () => {
    expect(findOverlaps([]).size).toBe(0);
  });
});

describe("calendarWindow", () => {
  const events = [ev("p", "Past", 1 * H, 2 * H), ev("a", "Now", 9 * H, 11 * H), ev("b", "Next", 12 * H, 13 * H), ev("c", "Later", 20 * H, 21 * H)];

  it("shows what is still ahead (including what is running now), soonest first", () => {
    const w = calendarWindow(events, 10 * H, 2);
    expect(w.upcoming).toBe(true);
    expect(w.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(w.total).toBe(4);
  });

  it("falls back to the latest past events when nothing is ahead", () => {
    const w = calendarWindow(events, 99 * H, 6);
    expect(w.upcoming).toBe(false);
    expect(w.events.map((e) => e.id)).toEqual(["p", "a", "b", "c"]);
    expect(calendarWindow([], 0).events).toEqual([]);
  });

  it("carries the clash map", () => {
    const w = calendarWindow([ev("a", "A", 0, 2 * H), ev("b", "B", H, 3 * H)], 0);
    expect(w.clashes.get("a")).toEqual(["B"]);
  });
});
