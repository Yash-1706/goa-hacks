import { describe, expect, it } from "vitest";
import {
  SLIDER_MAX,
  advancePlayback,
  axisToTime,
  buildTimeAxis,
  edgeVisibleAt,
  isLiveSlider,
  isVisibleAt,
  playbackDuration,
  tickBins,
  timeToAxis,
} from "./graph-time";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("time axis", () => {
  const now = 10 * D;
  const times = [now - 2 * D, now - 2 * D + 5 * MIN, now - 20 * MIN, now - 19 * MIN, now - 18 * MIN, now - 10 * MIN];
  const axis = buildTimeAxis(times, now);

  it("starts empty, ends live, and is strictly increasing", () => {
    expect(axis.start).toBeLessThan(Math.min(...times));
    expect(axis.end).toBeGreaterThan(Math.max(...times));
    expect(axis.points[0]?.u).toBe(0);
    expect(axis.points[axis.points.length - 1]?.u).toBe(1);
    for (let i = 1; i < axis.points.length; i++) {
      expect((axis.points[i] as { u: number }).u).toBeGreaterThan((axis.points[i - 1] as { u: number }).u);
      expect((axis.points[i] as { t: number }).t).toBeGreaterThan((axis.points[i - 1] as { t: number }).t);
    }
    expect(axis.events).toBe(times.length);
  });

  it("round-trips time through the track", () => {
    for (const t of [axis.start, times[1] as number, times[3] as number, now - 14 * MIN, axis.end]) {
      expect(axisToTime(axis, timeToAxis(axis, t))).toBeCloseTo(t, 3);
    }
    for (const u of [0, 0.13, 0.5, 0.77, 1]) {
      expect(timeToAxis(axis, axisToTime(axis, u))).toBeCloseTo(u, 6);
    }
  });

  it("compresses a two-day silence so the burst that follows keeps room on the track", () => {
    const uBurstStart = timeToAxis(axis, now - 20 * MIN);
    const uBurstEnd = timeToAxis(axis, now - 10 * MIN);
    const uOldTwo = timeToAxis(axis, now - 2 * D + 5 * MIN);
    // 10 minutes of activity must get a visible stretch, even though the silence before it was 2 days
    expect(uBurstEnd - uBurstStart).toBeGreaterThan(0.1);
    // ...and the silence is not bigger than ~70% of the track although it is 99% of the real time
    expect(uBurstStart - uOldTwo).toBeLessThan(0.7);
    // a linear axis would have given the burst under 1% of the track
    expect((10 * MIN) / (axis.end - axis.start)).toBeLessThan(0.01);
  });

  it("clamps out-of-range input", () => {
    expect(axisToTime(axis, -3)).toBe(axis.start);
    expect(axisToTime(axis, 7)).toBe(axis.end);
    expect(timeToAxis(axis, axis.start - 1e9)).toBe(0);
    expect(timeToAxis(axis, axis.end + 1e9)).toBe(1);
  });

  it("handles an empty graph and a single event", () => {
    const empty = buildTimeAxis([], now);
    expect(empty.events).toBe(0);
    expect(axisToTime(empty, 0)).toBeLessThan(axisToTime(empty, 1));
    const one = buildTimeAxis([now - H], now);
    expect(one.events).toBe(1);
    const u = timeToAxis(one, now - H);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(1);
    expect(axisToTime(one, u)).toBeCloseTo(now - H, 3);
  });

  it("ignores duplicates and non-finite times", () => {
    const a = buildTimeAxis([5, 5, 5, Number.NaN, Infinity, 9], 20);
    expect(a.events).toBe(2);
  });

  it("caps the quiet tail so a long idle spell does not eat the track", () => {
    const fresh = buildTimeAxis([now - 30_000, now - 20_000], now);
    const stale = buildTimeAxis([now - 20 * D, now - 20 * D + 10_000], now);
    const lastU = (a: ReturnType<typeof buildTimeAxis>): number => (a.points[a.points.length - 2] as { u: number }).u;
    // 20 days of silence after the last event still leaves under two thirds of the track for the tail
    expect(1 - lastU(stale)).toBeLessThan(0.66);
    expect(lastU(fresh)).toBeGreaterThan(lastU(stale));
    expect(lastU(fresh)).toBeGreaterThan(0.45);
  });
});

describe("tick bins", () => {
  it("buckets events along the track and normalises to 0..1", () => {
    const now = 1_000_000_000;
    const times = [now - 100_000, now - 99_000, now - 98_000, now - 1_000];
    const axis = buildTimeAxis(times, now);
    const bins = tickBins(axis, times, 20);
    expect(bins).toHaveLength(20);
    expect(Math.max(...bins)).toBe(1);
    expect(Math.min(...bins)).toBe(0);
    expect(bins.filter((b) => b > 0).length).toBeGreaterThanOrEqual(2);
    expect(tickBins(axis, [], 8).every((b) => b === 0)).toBe(true);
  });
});

describe("playback", () => {
  it("takes a watchable time: short for few events, capped for many", () => {
    expect(playbackDuration(0)).toBe(6000);
    expect(playbackDuration(5)).toBe(6000);
    expect(playbackDuration(40)).toBeGreaterThan(6000);
    expect(playbackDuration(40)).toBeLessThan(18_000);
    expect(playbackDuration(5000)).toBe(18_000);
  });

  it("advances by wall time and reports the end exactly once it is reached", () => {
    let r = advancePlayback(0, 1000, 10_000);
    expect(r).toEqual({ u: 0.1, done: false });
    r = advancePlayback(r.u, 9000, 10_000);
    expect(r.done).toBe(true);
    expect(r.u).toBe(1);
    expect(advancePlayback(0.5, -100, 1000).u).toBe(0.5); // never runs backwards
    expect(advancePlayback(0, 5, 0).done).toBe(true); // degenerate duration still terminates
  });
});

describe("visibility at time t", () => {
  it("shows exactly what was created at or before t, and everything when live", () => {
    expect(isVisibleAt(100, 100)).toBe(true);
    expect(isVisibleAt(101, 100)).toBe(false);
    expect(isVisibleAt(1e15, Infinity)).toBe(true);
  });

  it("shows an edge only once BOTH of its ends exist", () => {
    expect(edgeVisibleAt(10, 20, 15)).toBe(false);
    expect(edgeVisibleAt(10, 20, 20)).toBe(true);
    expect(edgeVisibleAt(10, undefined, 99)).toBe(false);
    expect(edgeVisibleAt(10, 20, Infinity)).toBe(true);
  });

  it("treats the right end of the slider as live", () => {
    expect(isLiveSlider(SLIDER_MAX)).toBe(true);
    expect(isLiveSlider(SLIDER_MAX - 1)).toBe(true);
    expect(isLiveSlider(SLIDER_MAX - 2)).toBe(false);
    expect(isLiveSlider(0)).toBe(false);
  });
});
