import type { Activity } from "@synapse/shared";
import { describe, expect, it, vi } from "vitest";
import { FakeClock, flush } from "../audio/test-utils";
import {
  MIN_WINDOW_SAMPLES,
  accelMagnitude,
  classifyMotionWindow,
  majorityVote,
  oscillationHz,
  startActivityClassifier,
  type MotionEventLike,
} from "./activity";

/* deterministic noise */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5; // -0.5 .. 0.5
  };
}

/** magnitude samples for `seconds` at `rate` Hz */
function signal(seconds: number, rate: number, f: (t: number, noise: () => number) => number, seed = 1): number[] {
  const noise = rng(seed);
  const out: number[] = [];
  const n = Math.round(seconds * rate);
  for (let i = 0; i < n; i++) out.push(f(i / rate, noise));
  return out;
}

const G = 9.81;
const walk = (hz: number, amp: number, seed = 1) =>
  signal(4, 60, (t, n) => G + amp * Math.sin(2 * Math.PI * hz * t) + 0.3 * n(), seed);

describe("accelMagnitude", () => {
  it("is the vector length, and null when the sensor reports nothing", () => {
    expect(accelMagnitude({ x: 3, y: 4, z: 0 })).toBe(5);
    expect(accelMagnitude({ x: 0, y: 0, z: 9.81 })).toBeCloseTo(9.81, 6);
    expect(accelMagnitude(null)).toBeNull();
    expect(accelMagnitude(undefined)).toBeNull();
    expect(accelMagnitude({ x: null, y: null, z: null })).toBeNull(); // desktop Chrome's one empty event
    expect(accelMagnitude({ x: 1, y: Number.NaN, z: 2 })).toBeNull();
  });
});

describe("oscillationHz (zero-crossings of the detrended signal)", () => {
  it("recovers the frequency of a clean oscillation, independent of the DC offset", () => {
    for (const hz of [1.0, 1.4, 1.9, 2.5, 3.2]) {
      const s = signal(4, 60, (t) => G + 2 * Math.sin(2 * Math.PI * hz * t));
      expect(oscillationHz(s, 4)).toBeGreaterThan(hz - 0.25);
      expect(oscillationHz(s, 4)).toBeLessThan(hz + 0.25);
      const shifted = s.map((v) => v + 100);
      expect(oscillationHz(shifted, 4)).toBeCloseTo(oscillationHz(s, 4), 6);
    }
  });

  it("is robust to noise riding on the oscillation", () => {
    const s = walk(1.9, 2, 7);
    expect(oscillationHz(s, 4)).toBeGreaterThan(1.6);
    expect(oscillationHz(s, 4)).toBeLessThan(2.2);
  });

  it("reports nothing for a constant or too few samples, and nothing step-like for a ramp", () => {
    expect(oscillationHz(new Array(240).fill(9.81), 4)).toBe(0);
    expect(oscillationHz(signal(4, 60, (t) => t), 4)).toBeLessThan(1.3);
    expect(oscillationHz([1, 2, 3], 4)).toBe(0);
  });

  it("white noise looks far faster than any step rhythm (so vehicle vibration is not 'walking')", () => {
    const s = signal(4, 60, (_t, n) => G + n());
    expect(oscillationHz(s, 4)).toBeGreaterThan(2.6);
  });
});

describe("classifyMotionWindow (TRD §11.3 thresholds)", () => {
  it("still: sigma < 0.15", () => {
    const r = classifyMotionWindow(signal(4, 60, (_t, n) => G + 0.05 * n()), 4);
    expect(r.label).toBe("still");
    expect(r.sigma).toBeLessThan(0.15);
    expect(r.mean).toBeCloseTo(G, 1);
  });

  it("walking: 0.6 <= sigma <= 4 with a 1.3-2.6 Hz rhythm", () => {
    for (const hz of [1.4, 1.9, 2.4]) {
      const r = classifyMotionWindow(walk(hz, 2), 4);
      expect(r.label, `${hz} Hz`).toBe("walking");
      expect(r.sigma).toBeGreaterThan(0.6);
      expect(r.sigma).toBeLessThan(4);
      expect(r.stepHz).toBeGreaterThan(1.3);
      expect(r.stepHz).toBeLessThan(2.6);
    }
  });

  it("vehicle: 0.15 <= sigma < 0.6 without step periodicity (road noise, slow sway)", () => {
    const noisy = classifyMotionWindow(signal(4, 60, (_t, n) => G + 0.9 * n(), 5), 4); // sigma ~0.26
    expect(noisy.sigma).toBeGreaterThan(0.15);
    expect(noisy.sigma).toBeLessThan(0.6);
    expect(noisy.label).toBe("vehicle");
    const sway = classifyMotionWindow(signal(4, 60, (t) => G + 0.6 * Math.sin(2 * Math.PI * 0.4 * t)), 4); // 0.4 Hz sway
    expect(sway.label).toBe("vehicle");
  });

  it("anything outside the three rules is 'unknown'", () => {
    // violent shaking / running: sigma > 4
    expect(classifyMotionWindow(walk(2.2, 8), 4).label).toBe("unknown");
    // big motion but no step rhythm (fidgeting at 0.8 Hz, 4 Hz)
    expect(classifyMotionWindow(walk(0.8, 2), 4).label).toBe("unknown");
    expect(classifyMotionWindow(walk(4, 2), 4).label).toBe("unknown");
    // gentle sway WITH a step rhythm is neither walking (sigma too low) nor vehicle (periodic)
    const gentle = classifyMotionWindow(signal(4, 60, (t) => G + 0.45 * Math.sin(2 * Math.PI * 1.9 * t)), 4);
    expect(gentle.sigma).toBeGreaterThan(0.15);
    expect(gentle.sigma).toBeLessThan(0.6);
    expect(gentle.label).toBe("unknown");
  });

  it("does not trust windows with too few samples", () => {
    expect(MIN_WINDOW_SAMPLES).toBeGreaterThan(10);
    const r = classifyMotionWindow(walk(1.9, 2).slice(0, MIN_WINDOW_SAMPLES - 1), 0.4);
    expect(r.label).toBe("unknown");
    expect(classifyMotionWindow([], 4).label).toBe("unknown");
    expect(classifyMotionWindow(walk(1.9, 2), 0).label).toBe("unknown");
  });

  it("works at a 30 Hz or 100 Hz sample rate", () => {
    for (const rate of [30, 100]) {
      const s = signal(4, rate, (t, n) => G + 2 * Math.sin(2 * Math.PI * 1.8 * t) + 0.2 * n());
      expect(classifyMotionWindow(s, 4).label, `${rate} Hz`).toBe("walking");
    }
  });
});

describe("majorityVote (last 3 windows)", () => {
  it("takes the first window at face value", () => {
    expect(majorityVote(["walking"], "unknown")).toBe("walking");
  });
  it("two out of three win", () => {
    expect(majorityVote(["walking", "walking", "still"], "unknown")).toBe("walking");
    expect(majorityVote(["still", "walking", "walking"], "still")).toBe("walking");
    expect(majorityVote(["vehicle", "walking", "vehicle"], "still")).toBe("vehicle");
  });
  it("with no majority the previous stable label stays", () => {
    expect(majorityVote(["walking", "still", "vehicle"], "still")).toBe("still");
    expect(majorityVote(["walking", "still"], "vehicle")).toBe("vehicle");
  });
  it("only the last three count", () => {
    const h: Activity[] = ["walking", "walking", "walking", "still", "still"];
    expect(majorityVote(h, "walking")).toBe("still");
  });
  it("empty history keeps the previous label", () => {
    expect(majorityVote([], "desk")).toBe("desk");
  });
});

/* ====================================================================== the wrapper */

class FakeTarget {
  private fns = new Set<(e: MotionEventLike) => void>();
  addEventListener(type: string, fn: (e: never) => void): void {
    if (type === "devicemotion") this.fns.add(fn as unknown as (e: MotionEventLike) => void);
  }
  removeEventListener(type: string, fn: (e: never) => void): void {
    if (type === "devicemotion") this.fns.delete(fn as unknown as (e: MotionEventLike) => void);
  }
  emit(e: MotionEventLike): void {
    for (const f of [...this.fns]) f(e);
  }
  get listeners(): number {
    return this.fns.size;
  }
}

/** push `samples` (magnitudes) as DeviceMotion events starting at `t0` ms, 60 Hz */
function feed(target: FakeTarget, samples: number[], t0: number): number {
  let t = t0;
  for (const m of samples) {
    target.emit({ accelerationIncludingGravity: { x: 0, y: 0, z: m }, timeStamp: t });
    t += 1000 / 60;
  }
  return t;
}

function env(over: { DME?: object | null } = {}) {
  const clock = new FakeClock();
  const target = new FakeTarget();
  const changes: Activity[] = [];
  const deps = {
    target,
    deviceMotionEvent: over.DME === undefined ? {} : over.DME,
    now: () => clock.now(),
    setTimeout: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clock.clearTimeout(id),
  };
  return { clock, target, changes, deps, onChange: (a: Activity) => changes.push(a) };
}

describe("startActivityClassifier", () => {
  it("emits the voted label once per change (walk -> still needs two windows to flip)", async () => {
    const e = env();
    const p = startActivityClassifier(e.onChange, e.deps);
    // the first real reading resolves the promise as supported
    let t = feed(e.target, walk(1.9, 2, 1).slice(0, 1), 0);
    const handle = await p;
    expect(handle.supported).toBe(true);
    // finish the first window: 4 s of walking
    t = feed(e.target, walk(1.9, 2, 1).slice(1), t);
    expect(e.changes).toEqual([]); // the window closes on the first sample at/after 4 s
    t = feed(e.target, walk(1.9, 2, 2), t);
    expect(e.changes).toEqual(["walking"]);
    t = feed(e.target, walk(1.9, 2, 3), t);
    expect(e.changes).toEqual(["walking"]); // unchanged: no repeat
    const still = () => signal(4, 60, (_t, n) => G + 0.04 * n(), 9);
    t = feed(e.target, still(), t); // [walking, walking, still] -> walking
    expect(e.changes).toEqual(["walking"]);
    t = feed(e.target, still(), t); // [walking, still, still] -> still
    t = feed(e.target, still(), t);
    expect(e.changes).toEqual(["walking", "still"]);
    handle.stop();
  });

  it("desktop / no DeviceMotion: resolves {supported:false} and says 'desk' exactly once", async () => {
    const e = env({ DME: null });
    const h = await startActivityClassifier(e.onChange, e.deps);
    expect(h.supported).toBe(false);
    expect(e.changes).toEqual(["desk"]);
    expect(e.target.listeners).toBe(0);
    h.stop(); // harmless
  });

  it("no window object at all (SSR / worker) is also 'desk'", async () => {
    const changes: Activity[] = [];
    const h = await startActivityClassifier((a) => changes.push(a), { target: null, deviceMotionEvent: {} });
    expect(h.supported).toBe(false);
    expect(changes).toEqual(["desk"]);
  });

  it("DeviceMotion exists but no reading arrives (desktop Chrome): 'desk' after the probe, listener removed", async () => {
    const e = env();
    const p = startActivityClassifier(e.onChange, e.deps);
    e.target.emit({ accelerationIncludingGravity: { x: null, y: null, z: null }, timeStamp: 1 }); // the one empty event
    expect(e.changes).toEqual([]);
    e.clock.advance(1499);
    expect(e.changes).toEqual([]);
    e.clock.advance(2);
    const h = await p;
    expect(h.supported).toBe(false);
    expect(e.changes).toEqual(["desk"]);
    expect(e.target.listeners).toBe(0);
  });

  it("iOS: the permission request is issued synchronously (inside the tap), granted -> classifies", async () => {
    const requestPermission = vi.fn(async () => "granted");
    const e = env({ DME: { requestPermission } });
    const p = startActivityClassifier(e.onChange, e.deps);
    expect(requestPermission).toHaveBeenCalledTimes(1); // before anything was awaited
    await flush();
    let t = feed(e.target, walk(1.9, 2, 1), 0);
    const h = await p;
    expect(h.supported).toBe(true);
    t = feed(e.target, walk(1.9, 2, 2), t);
    expect(e.changes).toEqual(["walking"]);
    h.stop();
  });

  it("iOS: permission denied -> {supported:false} and 'unknown' (not 'desk': it IS a phone)", async () => {
    const e = env({ DME: { requestPermission: async () => "denied" } });
    const h = await startActivityClassifier(e.onChange, e.deps);
    expect(h.supported).toBe(false);
    expect(e.changes).toEqual(["unknown"]);
    expect(e.target.listeners).toBe(0);
  });

  it("iOS: a throwing / rejecting permission request never throws out of the classifier", async () => {
    const e1 = env({
      DME: {
        requestPermission: () => {
          throw new Error("not from a gesture");
        },
      },
    });
    await expect(startActivityClassifier(e1.onChange, e1.deps)).resolves.toMatchObject({ supported: false });
    expect(e1.changes).toEqual(["unknown"]);
    const e2 = env({ DME: { requestPermission: () => Promise.reject(new Error("nope")) } });
    await expect(startActivityClassifier(e2.onChange, e2.deps)).resolves.toMatchObject({ supported: false });
    expect(e2.changes).toEqual(["unknown"]);
  });

  it("stop() detaches the listener and silences further events", async () => {
    const e = env();
    const p = startActivityClassifier(e.onChange, e.deps);
    let t = feed(e.target, walk(1.9, 2, 1), 0);
    const h = await p;
    h.stop();
    expect(e.target.listeners).toBe(0);
    t = feed(e.target, walk(1.9, 2, 2), t);
    expect(e.changes).toEqual([]);
    h.stop(); // idempotent
  });

  it("a throwing onChange does not break the sensing loop (later changes are still delivered)", async () => {
    const e = env();
    const seen: Activity[] = [];
    const p = startActivityClassifier((a) => {
      seen.push(a);
      throw new Error("ui bug");
    }, e.deps);
    const still = (seed: number) => signal(4, 60, (_t, n) => G + 0.04 * n(), seed);
    let t = feed(e.target, walk(1.9, 2, 1), 0);
    const h = await p;
    t = feed(e.target, walk(1.9, 2, 2), t); // closes W1 -> "walking" (the callback throws)
    expect(seen).toEqual(["walking"]);
    t = feed(e.target, still(3), t); // closes W2 (walking)
    t = feed(e.target, still(4), t); // closes W3 (still) -> [walking, walking, still] -> walking
    t = feed(e.target, still(5), t); // closes W4 (still) -> [walking, still, still] -> still
    expect(seen).toEqual(["walking", "still"]);
    h.stop();
  });
});
