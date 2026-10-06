/* ============================================================================
 * Timeline for the graph scrubber. Pure.
 *
 * Memory is bursty: a demo makes 40 nodes in ten minutes, while the seed data may be days old. A linear
 * time axis would squash the interesting part into a sliver, so the slider position `u` (0..1) is a
 * log-compressed axis: every gap between events gets log(1 + gap/τ) of the track. Close events stay
 * distinguishable, long silences are visibly longer but never dominate, and playback runs through them
 * quickly. Inside one gap, time still interpolates linearly, so scrubbing is continuous.
 * ========================================================================== */

export interface AxisPoint {
  /** epoch ms */
  t: number;
  /** 0..1 position on the track */
  u: number;
}

export interface TimeAxis {
  points: AxisPoint[];
  /** time at u = 0: just before the first event, i.e. an empty graph */
  start: number;
  /** time at u = 1: "live" (the last event plus a short tail) */
  end: number;
  /** number of distinct event times */
  events: number;
}

/** Gap weight scale: a 5 s gap weighs about log(2), a day about log(17 000). */
export const GAP_TAU_MS = 5_000;
const LEAD_MS = 2_000;
const MAX_TAIL_WEIGHT = 2.5;

const weightOf = (gapMs: number): number => Math.log1p(Math.max(0, gapMs) / GAP_TAU_MS);

/**
 * Build the axis from the creation times of everything that will be shown. `now` only shapes the quiet
 * tail after the last event (capped, so a long idle spell does not eat the track).
 */
export function buildTimeAxis(times: readonly number[], now: number): TimeAxis {
  const ts = [...new Set(times.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  if (ts.length === 0) {
    const t = Number.isFinite(now) ? now : 0;
    return { points: [{ t: t - 1, u: 0 }, { t, u: 1 }], start: t - 1, end: t, events: 0 };
  }
  const first = ts[0] as number;
  const last = ts[ts.length - 1] as number;
  const start = first - LEAD_MS;
  const tail = Math.min(MAX_TAIL_WEIGHT, weightOf(Math.max(0, now - last)));
  const tailMs = Math.max(2_000, Math.min(Math.max(0, now - last), 60 * 60_000));

  const weights: number[] = [weightOf(LEAD_MS)];
  for (let i = 1; i < ts.length; i++) weights.push(weightOf((ts[i] as number) - (ts[i - 1] as number)));
  weights.push(Math.max(0.35, tail));
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  const points: AxisPoint[] = [{ t: start, u: 0 }];
  let acc = 0;
  for (let i = 0; i < ts.length; i++) {
    acc += weights[i] as number;
    points.push({ t: ts[i] as number, u: acc / total });
  }
  const end = last + tailMs;
  points.push({ t: end, u: 1 });
  return { points, start, end, events: ts.length };
}

/** Real time at track position `u` (clamped to 0..1). */
export function axisToTime(axis: TimeAxis, u0: number): number {
  const u = u0 < 0 ? 0 : u0 > 1 ? 1 : u0;
  const p = axis.points;
  for (let i = 1; i < p.length; i++) {
    const b = p[i] as AxisPoint;
    if (u <= b.u) {
      const a = p[i - 1] as AxisPoint;
      const span = b.u - a.u;
      if (span <= 1e-12) return b.t;
      return a.t + ((u - a.u) / span) * (b.t - a.t);
    }
  }
  return axis.end;
}

/** Track position of a real time (clamped; times past the end map to 1 = live). */
export function timeToAxis(axis: TimeAxis, t: number): number {
  const p = axis.points;
  if (t <= axis.start) return 0;
  if (t >= axis.end) return 1;
  for (let i = 1; i < p.length; i++) {
    const b = p[i] as AxisPoint;
    if (t <= b.t) {
      const a = p[i - 1] as AxisPoint;
      const span = b.t - a.t;
      if (span <= 0) return b.u;
      return a.u + ((t - a.t) / span) * (b.u - a.u);
    }
  }
  return 1;
}

/** Event density along the track in `bins` buckets (for the tick marks behind the slider), each 0..1. */
export function tickBins(axis: TimeAxis, times: readonly number[], bins: number): number[] {
  const out = new Array<number>(Math.max(1, bins)).fill(0);
  let max = 0;
  for (const t of times) {
    const u = timeToAxis(axis, t);
    const i = Math.min(out.length - 1, Math.max(0, Math.floor(u * out.length)));
    out[i] = (out[i] as number) + 1;
    if ((out[i] as number) > max) max = out[i] as number;
  }
  return max > 0 ? out.map((v) => v / max) : out;
}

// ----------------------------------------------------------------- playback --

/** A replay always takes a watchable time: ~6 s for a handful of events, up to 18 s for hundreds. */
export function playbackDuration(events: number): number {
  return Math.max(6_000, Math.min(18_000, 4_500 + events * 160));
}

/** Advance the track position by `dtMs` of wall time. Returns the new position and whether it hit the end. */
export function advancePlayback(u: number, dtMs: number, durationMs: number): { u: number; done: boolean } {
  const next = u + Math.max(0, dtMs) / Math.max(1, durationMs);
  return next >= 1 ? { u: 1, done: true } : { u: next, done: false };
}

// ------------------------------------------------------------- visibility --

/** Everything with createdAt <= t exists at time t. `Infinity` = live (everything, including future arrivals). */
export const isVisibleAt = (createdAt: number, t: number): boolean => createdAt <= t;

/** An edge exists once both of its ends do. */
export function edgeVisibleAt(srcCreated: number | undefined, dstCreated: number | undefined, t: number): boolean {
  return srcCreated !== undefined && dstCreated !== undefined && srcCreated <= t && dstCreated <= t;
}

/** Scrubber value (0..1000) → whether it means "live" (the right end of the track). */
export const SLIDER_MAX = 1000;
export const isLiveSlider = (value: number): boolean => value >= SLIDER_MAX - 1;
