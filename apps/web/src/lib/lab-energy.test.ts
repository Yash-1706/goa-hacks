import { describe, expect, it } from "vitest";
import {
  NAIVE_BYTES_PER_SEC,
  REDUCTION_TARGET,
  compare,
  compareReport,
  energyOf,
  energyShare,
  formatUnits,
  formatWindow,
  naiveEnergy,
  naiveUsage,
  ratesOf,
  reductionText,
  reductionTone,
  savedPercent,
  skipPct,
  sumUsage,
  targetShare,
} from "./lab-energy";
import type { BatteryRow } from "@/net/api-types";

const MODEL = { cpuMsCost: 1, radioMsCost: 6, byteCost: 0.004 };

describe("energy model", () => {
  it("is cpu_ms × c + radio_ms × r + bytes × b", () => {
    expect(energyOf({ cpuMs: 100, radioMs: 1000, bytesUp: 5000 }, MODEL)).toBe(100 + 6000 + 20);
    expect(energyOf({ cpuMs: 0, radioMs: 0, bytesUp: 0 }, MODEL)).toBe(0);
    expect(energyOf({ cpuMs: 10, radioMs: 10, bytesUp: 1000 }, { cpuMsCost: 2, radioMsCost: 0, byteCost: 1 })).toBe(1020);
  });

  it("defines the naive baseline as 100% radio, 5% CPU and raw 16 kHz 16-bit PCM as base64", () => {
    expect(NAIVE_BYTES_PER_SEC).toBeCloseTo(42_666.67, 1);
    const n = naiveUsage(60_000);
    expect(n.cpuMs).toBe(3000);
    expect(n.radioMs).toBe(60_000);
    expect(n.bytesUp).toBe(2_560_000); // the "≈ 2.6 MB/min" in the TRD
    expect(naiveEnergy(60_000, MODEL)).toBe(3000 + 360_000 + 10_240);
    expect(naiveEnergy(0, MODEL)).toBe(0);
  });

  it("matches the server's saved-percent maths", () => {
    // 5 s of a VAD-gated mic that streamed 1.5 s (with its tail) and used 12 ms of CPU
    const used = { cpuMs: 12, radioMs: 1500, bytesUp: 8000 };
    const e = energyOf(used, MODEL); // 12 + 9000 + 32 = 9044
    const n = naiveEnergy(5000, MODEL); // 250 + 30000 + 853.33 (bytes 213333 × 0.004)
    expect(e).toBe(9044);
    expect(savedPercent(e, n)).toBe(Math.round((1 - 9044 / n) * 100));
    expect(savedPercent(e, n)).toBe(71);
  });

  it("returns 0 when there is no baseline and does not clamp overspending", () => {
    expect(savedPercent(5, 0)).toBe(0);
    expect(savedPercent(NaN, 100)).toBe(0);
    expect(savedPercent(200, 100)).toBe(-100);
    expect(savedPercent(0, 100)).toBe(100);
  });

  it("prints the headline as sign + figure and never rounds a non-zero use up to a full 100%", () => {
    expect(reductionText(11, 100)).toEqual({ sign: "−", value: "89" });
    expect(reductionText(0, 100)).toEqual({ sign: "−", value: "100" });
    expect(reductionText(0.2, 100)).toEqual({ sign: "−", value: "99.8" });
    expect(reductionText(0.6, 100)).toEqual({ sign: "−", value: "99" });
    expect(reductionText(112, 100)).toEqual({ sign: "+", value: "12" });
    expect(reductionText(100, 100)).toEqual({ sign: "", value: "0" });
    expect(reductionText(99.7, 100)).toEqual({ sign: "", value: "0" });
    expect(reductionText(5, 0)).toEqual({ sign: "", value: "–" });
    expect(reductionText(NaN, 100)).toEqual({ sign: "", value: "–" });
  });

  it("draws Synapse's share of the naive bar, clamped to 0..1", () => {
    expect(energyShare(25, 100)).toBe(0.25);
    expect(energyShare(250, 100)).toBe(1);
    expect(energyShare(-5, 100)).toBe(0);
    expect(energyShare(5, 0)).toBe(0);
  });

  it("puts the 70% target at 30% of the naive bar", () => {
    expect(REDUCTION_TARGET).toBe(70);
    expect(targetShare()).toBeCloseTo(0.3, 10);
    expect(targetShare(90)).toBeCloseTo(0.1, 10);
  });

  it("calls ≥ 70% good, ≥ 50% ok and the rest bad", () => {
    expect(reductionTone(92)).toBe("good");
    expect(reductionTone(70)).toBe("good");
    expect(reductionTone(69)).toBe("ok");
    expect(reductionTone(50)).toBe("ok");
    expect(reductionTone(49)).toBe("bad");
    expect(reductionTone(-20)).toBe("bad");
  });
});

describe("usage rates", () => {
  it("normalises a window to per-minute and percent figures", () => {
    const r = ratesOf({ windowMs: 5000, cpuMs: 12, radioMs: 1500, bytesUp: 8000 });
    expect(r.cpuMsPerMin).toBeCloseTo(144, 6);
    expect(r.bytesPerMin).toBeCloseTo(96_000, 6);
    expect(r.radioPct).toBe(30);
    expect(r.cpuPct).toBeCloseTo(0.24, 6);
  });

  it("caps percentages at 100 and survives an empty window", () => {
    expect(ratesOf({ windowMs: 1000, cpuMs: 5000, radioMs: 5000, bytesUp: 0 })).toMatchObject({ radioPct: 100, cpuPct: 100 });
    expect(ratesOf({ windowMs: 0, cpuMs: 5, radioMs: 5, bytesUp: 5 })).toEqual({ cpuMsPerMin: 0, bytesPerMin: 0, radioPct: 0, cpuPct: 0 });
  });

  it("adds windows up", () => {
    expect(sumUsage([])).toEqual({ windowMs: 0, cpuMs: 0, radioMs: 0, bytesUp: 0 });
    expect(
      sumUsage([
        { windowMs: 5000, cpuMs: 1, radioMs: 2, bytesUp: 3 },
        { windowMs: 5000, cpuMs: 10, radioMs: 20, bytesUp: 30 },
      ]),
    ).toEqual({ windowMs: 10_000, cpuMs: 11, radioMs: 22, bytesUp: 33 });
  });

  it("measures the share of frames the energy pre-gate skipped", () => {
    expect(skipPct(30, 120)).toBe(25);
    expect(skipPct(0, 0)).toBeNull();
    expect(skipPct(500, 100)).toBe(100);
  });
});

describe("comparison", () => {
  it("compares one usage record with its naive baseline", () => {
    const c = compare({ windowMs: 60_000, cpuMs: 300, radioMs: 6000, bytesUp: 250_000 }, MODEL);
    expect(c.energy).toBe(300 + 36_000 + 1000);
    expect(c.naive).toBe(373_240);
    expect(c.savedPct).toBe(90);
    expect(c.share).toBeCloseTo(c.energy / c.naive, 10);
  });

  const row = (over: Partial<BatteryRow>): BatteryRow => ({
    deviceId: "phone",
    mode: "normal",
    windowMs: 60_000,
    cpuMs: 0,
    radioMs: 0,
    bytesUp: 0,
    energy: 0,
    naiveEnergy: 0,
    savedPct: 0,
    radioActivePct: 0,
    ...over,
  });

  it("adds up every device and mode of the server report", () => {
    expect(compareReport([])).toBeNull();
    const c = compareReport([
      row({ windowMs: 60_000, cpuMs: 300, radioMs: 6000, bytesUp: 250_000, energy: 37_300, naiveEnergy: 373_240 }),
      row({ deviceId: "laptop", mode: "eco", windowMs: 120_000, cpuMs: 400, radioMs: 4000, bytesUp: 100_000, energy: 24_800, naiveEnergy: 746_480 }),
    ]);
    expect(c).not.toBeNull();
    expect(c!.usage).toEqual({ windowMs: 180_000, cpuMs: 700, radioMs: 10_000, bytesUp: 350_000 });
    expect(c!.energy).toBe(62_100);
    expect(c!.naive).toBe(1_119_720);
    expect(c!.savedPct).toBe(94);
  });
});

describe("formatting", () => {
  it("shortens relative energy units", () => {
    expect(formatUnits(842)).toBe("842");
    expect(formatUnits(1234)).toBe("1.2k");
    expect(formatUnits(12_400)).toBe("12k");
    expect(formatUnits(373_240)).toBe("373k");
    expect(formatUnits(2_500_000)).toBe("2.5M");
    expect(formatUnits(NaN)).toBe("–");
  });

  it("formats a window of time", () => {
    expect(formatWindow(41_000)).toBe("41 s");
    expect(formatWindow(100)).toBe("1 s");
    expect(formatWindow(720_000)).toBe("12 min");
    expect(formatWindow(7_200_000)).toBe("2.0 h");
    expect(formatWindow(0)).toBe("–");
  });
});
