import { describe, expect, it, vi } from "vitest";
import { normalizeActivity, normalizeBattery, toStop } from "./sensors";

describe("normalizeActivity", () => {
  it("accepts labels and objects, maps synonyms, rejects junk", () => {
    expect(normalizeActivity("walking")).toBe("walking");
    expect(normalizeActivity({ activity: "vehicle" })).toBe("vehicle");
    expect(normalizeActivity({ label: "still" })).toBe("still");
    expect(normalizeActivity("DRIVING")).toBe("vehicle");
    expect(normalizeActivity("stationary")).toBe("still");
    expect(normalizeActivity("desk")).toBe("desk");
    expect(normalizeActivity("flying")).toBeNull();
    expect(normalizeActivity(42)).toBeNull();
  });
});

describe("normalizeBattery", () => {
  it("accepts {level, charging} (0..1) and (level, charging) (0..100)", () => {
    expect(normalizeBattery({ level: 0.42, charging: true })).toEqual({ level: 0.42, charging: true });
    expect(normalizeBattery(85, false)).toEqual({ level: 0.85, charging: false });
    expect(normalizeBattery({ percent: 30 })).toEqual({ level: 0.3, charging: false });
  });
  it("clamps and rejects non-numbers", () => {
    expect(normalizeBattery({ level: 7, charging: false })?.level).toBe(0.07);
    expect(normalizeBattery({ level: -1 })?.level).toBe(0);
    expect(normalizeBattery({ level: "x" })).toBeNull();
    expect(normalizeBattery(undefined)).toBeNull();
  });
});

describe("toStop", () => {
  it("accepts a bare function and objects with stop/release/dispose", () => {
    const f = vi.fn();
    toStop(f)?.();
    expect(f).toHaveBeenCalledOnce();
    const stop = vi.fn();
    toStop({ stop, supported: true })?.();
    expect(stop).toHaveBeenCalledOnce();
    const release = vi.fn(async () => undefined);
    toStop({ release, active: true })?.();
    expect(release).toHaveBeenCalledOnce();
  });
  it("returns null for anything else", () => {
    expect(toStop(undefined)).toBeNull();
    expect(toStop({})).toBeNull();
    expect(toStop(3)).toBeNull();
  });
  it("binds the method to its object", () => {
    const obj = {
      n: 0,
      stop() {
        this.n++;
      },
    };
    toStop(obj)?.();
    expect(obj.n).toBe(1);
  });
});
