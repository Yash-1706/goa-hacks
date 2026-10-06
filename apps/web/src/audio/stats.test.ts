import { describe, expect, it } from "vitest";
import { StatsCollector } from "./stats";
import type { AudioStats } from "./types";
import { FakeClock } from "./test-utils";

function make(mode: "normal" | "eco" = "normal") {
  const clock = new FakeClock();
  const reports: AudioStats[] = [];
  let m: "normal" | "eco" = mode;
  const stats = new StatsCollector({ clock, getMode: () => m, onStats: (s) => reports.push(s) });
  return { clock, reports, stats, setMode: (x: "normal" | "eco") => (m = x) };
}

describe("StatsCollector counters", () => {
  it("accumulates cpu, bytes and frames, reports once per 5 s window, and resets", () => {
    const { clock, reports, stats } = make();
    stats.start();
    stats.addCpu(1.5);
    stats.addCpu(2.5);
    stats.addCpu(-3); // ignored
    stats.addBytes(1368);
    stats.addBytes(1368);
    for (let i = 0; i < 10; i++) stats.addFrame(i % 2 === 1);
    clock.advance(5000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      windowMs: 5000,
      cpuMs: 4,
      radioMs: 0,
      bytesUp: 2736,
      mode: "normal",
      framesSkipped: 5,
      framesTotal: 10,
    });
    clock.advance(5000);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ windowMs: 5000, cpuMs: 0, bytesUp: 0, framesTotal: 0, framesSkipped: 0 });
  });

  it("reports the mode at the time of the report", () => {
    const { clock, reports, stats, setMode } = make();
    stats.start();
    clock.advance(5000);
    setMode("eco");
    clock.advance(5000);
    expect(reports.map((r) => r.mode)).toEqual(["normal", "eco"]);
  });

  it("flushes the partial window on stop() and stays quiet afterwards", () => {
    const { clock, reports, stats } = make();
    stats.start();
    clock.advance(1200);
    stats.addFrame(false);
    stats.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.windowMs).toBe(1200);
    clock.advance(20_000);
    expect(reports).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("does not flush a window shorter than 250 ms", () => {
    const { clock, reports, stats } = make();
    stats.start();
    clock.advance(100);
    stats.stop();
    expect(reports).toHaveLength(0);
  });
});

describe("radioMs", () => {
  it("counts active streaming time plus a 2 s tail", () => {
    const { clock, reports, stats } = make();
    stats.start();
    clock.advance(1000);
    stats.radioStart();
    clock.advance(1500);
    stats.radioEnd();
    clock.advance(3500); // reach 5 s boundary
    expect(reports[0]!.radioMs).toBe(1500 + 2000);
  });

  it("merges overlapping streams (union, not sum)", () => {
    const { clock, reports, stats } = make();
    stats.start();
    stats.radioStart(); // A at 0
    clock.advance(1000);
    stats.radioStart(); // B at 1000
    clock.advance(1000);
    stats.radioEnd(); // A ends at 2000, B still active
    expect(stats.activeStreams).toBe(1);
    clock.advance(1000);
    stats.radioEnd(); // B ends at 3000 -> tail until 5000
    clock.advance(2000);
    expect(reports[0]!.radioMs).toBe(3000 + 2000);
  });

  it("does not double count when a new stream starts inside the tail", () => {
    const { clock, reports, stats } = make();
    stats.start();
    stats.radioStart();
    clock.advance(1000);
    stats.radioEnd(); // tail until 3000
    clock.advance(1000);
    stats.radioStart(); // at 2000, inside the tail
    clock.advance(500);
    stats.radioEnd(); // 2500 -> tail until 4500
    clock.advance(2500);
    // radio on continuously from 0 to 4500
    expect(reports[0]!.radioMs).toBe(4500);
  });

  it("splits a tail that straddles a window boundary between the two reports", () => {
    const { clock, reports, stats } = make();
    stats.start();
    clock.advance(4000);
    stats.radioStart();
    clock.advance(500);
    stats.radioEnd(); // 4500, tail until 6500
    clock.advance(500); // 5000 -> report 1
    clock.advance(5000); // 10000 -> report 2
    expect(reports[0]!.radioMs).toBe(500 + 500);
    expect(reports[1]!.radioMs).toBe(1500);
  });

  it("an utterance still streaming at the boundary counts fully in both windows", () => {
    const { clock, reports, stats } = make();
    stats.start();
    clock.advance(4000);
    stats.radioStart();
    clock.advance(3000); // 7000: window 1 had 1000 ms, window 2 has 2000 ms so far
    stats.radioEnd();
    clock.advance(3000); // 10000
    expect(reports[0]!.radioMs).toBe(1000);
    expect(reports[1]!.radioMs).toBe(2000 + 2000);
  });

  it("an unmatched radioEnd is ignored (no phantom tail)", () => {
    const { clock, reports, stats } = make();
    stats.start();
    stats.radioEnd();
    clock.advance(5000);
    expect(reports[0]!.radioMs).toBe(0);
  });
});
