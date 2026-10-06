import type { Tone } from "@/lib/format";
import type { BatteryResponse, BatteryRow } from "@/net/api-types";

/* ============================================================================
 * Battery Lab maths (PRD DEV-4, TRD §11.4). Everything here is a MODEL in relative units, never joules:
 *
 *     E = cpu_ms × cpuMsCost + radio_ms × radioMsCost + bytes × byteCost        (constants come from the server)
 *
 * compared with a naive baseline that streams audio all the time: radio on 100 % of the window,
 * 16 kHz × 16-bit PCM = 32 000 B/s, sent as base64 (× 4/3), plus a flat 5 % CPU for capture and packetizing.
 * The baseline and the formula mirror apps/server/src/metrics/latency.ts (`naiveBaseline`, `modelledEnergy`).
 * ========================================================================== */

export type EnergyModel = BatteryResponse["model"];

export interface Usage {
  windowMs: number;
  cpuMs: number;
  radioMs: number;
  bytesUp: number;
}

/** PRD §8: modelled energy at least this much below naive streaming */
export const REDUCTION_TARGET = 70;

export const NAIVE_BYTES_PER_SEC = 32_000 * (4 / 3);
export const NAIVE_CPU_SHARE = 0.05;

export function energyOf(u: Pick<Usage, "cpuMs" | "radioMs" | "bytesUp">, m: EnergyModel): number {
  return u.cpuMs * m.cpuMsCost + u.radioMs * m.radioMsCost + u.bytesUp * m.byteCost;
}

/** what always-on streaming would use over the same window */
export function naiveUsage(windowMs: number): Usage {
  return { windowMs, cpuMs: windowMs * NAIVE_CPU_SHARE, radioMs: windowMs, bytesUp: Math.round((windowMs / 1000) * NAIVE_BYTES_PER_SEC) };
}

export function naiveEnergy(windowMs: number, m: EnergyModel): number {
  return energyOf(naiveUsage(windowMs), m);
}

/** percent saved vs. naive; 0 when there is no baseline yet. Not clamped: more than naive shows as negative. */
export function savedPercent(energy: number, naive: number): number {
  if (!(naive > 0) || !Number.isFinite(energy)) return 0;
  return Math.round((1 - energy / naive) * 100);
}

/**
 * The headline change in modelled energy as sign + figure: "−89" (89 % less than naive), "+12" (more), "−99.8" (never a
 * rounded "−100" while some energy is still being used).
 */
export function reductionText(energy: number, naive: number): { sign: "−" | "+" | ""; value: string } {
  if (!(naive > 0) || !Number.isFinite(energy)) return { sign: "", value: "–" };
  const pct = (1 - energy / naive) * 100;
  const abs = Math.abs(pct);
  const nearlyAll = abs >= 99.5 && abs < 100;
  const value = nearlyAll ? abs.toFixed(1) : String(Math.round(abs));
  const sign = nearlyAll || Math.round(pct) > 0 ? (pct > 0 ? "−" : "+") : Math.round(pct) < 0 ? "+" : "";
  return { sign, value };
}

/** Synapse's energy as a 0..1 share of the naive bar (the bar the UI draws) */
export function energyShare(energy: number, naive: number): number {
  if (!(naive > 0) || !Number.isFinite(energy)) return 0;
  return Math.min(1, Math.max(0, energy / naive));
}

/** the same percentage as a bar position: how far along the naive bar the reduction target sits (30 % for ≥ 70 %) */
export function targetShare(targetPct: number = REDUCTION_TARGET): number {
  return Math.min(1, Math.max(0, 1 - targetPct / 100));
}

export function reductionTone(pct: number, target: number = REDUCTION_TARGET): Tone {
  if (pct >= target) return "good";
  return pct >= target - 20 ? "ok" : "bad";
}

export interface Rates {
  /** CPU time per minute of wall clock */
  cpuMsPerMin: number;
  /** upstream audio payload per minute */
  bytesPerMin: number;
  /** share of the window with the radio streaming, 0..100 */
  radioPct: number;
  /** share of the window spent computing, 0..100 */
  cpuPct: number;
}

export function ratesOf(u: Usage): Rates {
  if (!(u.windowMs > 0)) return { cpuMsPerMin: 0, bytesPerMin: 0, radioPct: 0, cpuPct: 0 };
  const minutes = u.windowMs / 60_000;
  return {
    cpuMsPerMin: u.cpuMs / minutes,
    bytesPerMin: u.bytesUp / minutes,
    radioPct: Math.min(100, (u.radioMs / u.windowMs) * 100),
    cpuPct: Math.min(100, (u.cpuMs / u.windowMs) * 100),
  };
}

export function sumUsage(list: readonly Usage[]): Usage {
  return list.reduce<Usage>((a, u) => ({ windowMs: a.windowMs + u.windowMs, cpuMs: a.cpuMs + u.cpuMs, radioMs: a.radioMs + u.radioMs, bytesUp: a.bytesUp + u.bytesUp }), {
    windowMs: 0,
    cpuMs: 0,
    radioMs: 0,
    bytesUp: 0,
  });
}

export interface Comparison {
  usage: Usage;
  energy: number;
  naive: number;
  savedPct: number;
  /** Synapse's share of the naive bar, 0..1 */
  share: number;
}

/** model energy of one usage record against its naive baseline */
export function compare(u: Usage, m: EnergyModel): Comparison {
  const energy = energyOf(u, m);
  const naive = naiveEnergy(u.windowMs, m);
  return { usage: u, energy, naive, savedPct: savedPercent(energy, naive), share: energyShare(energy, naive) };
}

/** every device and mode of the server report, added up and compared with naive over the same time */
export function compareReport(rows: readonly BatteryRow[]): Comparison | null {
  if (rows.length === 0) return null;
  const usage = sumUsage(rows);
  const energy = rows.reduce((a, r) => a + r.energy, 0);
  const naive = rows.reduce((a, r) => a + r.naiveEnergy, 0);
  return { usage, energy, naive, savedPct: savedPercent(energy, naive), share: energyShare(energy, naive) };
}

/** "373k" / "12.4k" / "842": relative energy units, compact */
export function formatUnits(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 10_000) return `${Math.round(n / 1000)}k`;
  if (a >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** "41 s" | "12 min" | "3.2 h" */
export function formatWindow(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** share of frames the energy pre-gate kept away from the VAD, 0..100 (null before any frame) */
export function skipPct(framesSkipped: number, framesTotal: number): number | null {
  if (!(framesTotal > 0)) return null;
  return Math.min(100, Math.max(0, (framesSkipped / framesTotal) * 100));
}
