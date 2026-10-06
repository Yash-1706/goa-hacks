import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOISE_FLOOR,
  EnergyGate,
  LevelMeter,
  MIN_NOISE_FLOOR,
  NoiseFloor,
  WHISPER_RMS_ABS,
  isWhisper,
  median,
  rmsToLevel,
  whisperThreshold,
} from "./levels";

describe("median", () => {
  it("handles odd, even, empty and unsorted input", () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("NoiseFloor calibration", () => {
  it("is p50 of the frame RMS over ~2 s and ignores the warm-up frames", () => {
    const nf = new NoiseFloor();
    let doneAt = -1;
    for (let i = 0; i < 80; i++) {
      const rms = i < 8 ? 0.5 /* startup glitch */ : 0.004 + (i % 3) * 0.0005; // 0.004,0.0045,0.005
      if (nf.observe(rms, false)) doneAt = i + 1;
    }
    expect(doneAt).toBe(63); // ceil(2000 / 32) = 63 frames
    expect(nf.calibrated).toBe(true);
    expect(nf.value).toBeGreaterThan(0.0039);
    expect(nf.value).toBeLessThan(0.0051);
  });

  it("excludes frames the VAD calls speech and waits for enough silent ones", () => {
    const nf = new NoiseFloor();
    // the user starts talking immediately: 100 loud voiced frames
    for (let i = 0; i < 100; i++) expect(nf.observe(0.1, true)).toBe(false);
    expect(nf.calibrated).toBe(false);
    // then silence
    let done = false;
    for (let i = 0; i < 40 && !done; i++) done = nf.observe(0.002, false);
    expect(done).toBe(true);
    expect(nf.value).toBeCloseTo(0.002, 6);
  });

  it("falls back to the default after maxFrames of nothing but speech", () => {
    const nf = new NoiseFloor({ maxFrames: 50 });
    let done = false;
    for (let i = 0; i < 60 && !done; i++) done = nf.observe(0.2, true);
    expect(done).toBe(true);
    expect(nf.value).toBe(DEFAULT_NOISE_FLOOR);
    expect(nf.calibrated).toBe(true);
  });

  it("never reports a floor below the minimum (digital silence from noise suppression)", () => {
    const nf = new NoiseFloor();
    for (let i = 0; i < 100; i++) nf.observe(0, false);
    expect(nf.value).toBe(MIN_NOISE_FLOOR);
  });

  it("stops observing once calibrated and can be reset", () => {
    const nf = new NoiseFloor();
    for (let i = 0; i < 100; i++) nf.observe(0.004, false);
    const v = nf.value;
    expect(nf.observe(0.9, false)).toBe(false);
    expect(nf.value).toBe(v);
    nf.reset();
    expect(nf.calibrated).toBe(false);
    expect(nf.value).toBe(DEFAULT_NOISE_FLOOR);
    for (let i = 0; i < 100; i++) nf.observe(0.01, false);
    expect(nf.value).toBeCloseTo(0.01, 6);
  });
});

describe("whisper flag", () => {
  it("uses max(noiseFloor x 3, 0.012)", () => {
    expect(whisperThreshold(0.002)).toBeCloseTo(WHISPER_RMS_ABS, 9);
    expect(whisperThreshold(0.01)).toBeCloseTo(0.03, 9);
    expect(whisperThreshold(0.01, 0.05)).toBeCloseTo(0.05, 9);
  });

  it("flags quiet speech and not normal speech", () => {
    expect(isWhisper(0.008, 0.002)).toBe(true);
    expect(isWhisper(0.05, 0.002)).toBe(false);
    // in a noisy room the relative term dominates: 0.025 is a whisper over a 0.01 floor but not over 0.002
    expect(isWhisper(0.025, 0.01)).toBe(true);
    expect(isWhisper(0.025, 0.002)).toBe(false);
  });

  it("is not a whisper when there was no voiced audio at all", () => {
    expect(isWhisper(0, 0.002)).toBe(false);
  });
});

describe("rmsToLevel", () => {
  it("is 0 at the floor, 1 at +36 dB, monotonic in between, and clamped", () => {
    const floor = 0.003;
    expect(rmsToLevel(floor, floor)).toBeCloseTo(0, 9);
    expect(rmsToLevel(floor * 0.1, floor)).toBe(0);
    expect(rmsToLevel(floor * 10 ** (36 / 20), floor)).toBeCloseTo(1, 6);
    expect(rmsToLevel(1, floor)).toBe(1);
    let prev = -1;
    for (const r of [0.003, 0.006, 0.012, 0.05, 0.1, 0.2]) {
      const l = rmsToLevel(r, floor);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });

  it("puts a whisper in the middle and normal speech near the top", () => {
    expect(rmsToLevel(0.012, 0.003)).toBeGreaterThan(0.25);
    expect(rmsToLevel(0.012, 0.003)).toBeLessThan(0.45);
    expect(rmsToLevel(0.08, 0.003)).toBeGreaterThan(0.7);
  });
});

describe("LevelMeter", () => {
  it("emits ~15 values per second from 32 ms frames", () => {
    const m = new LevelMeter();
    let t = 0;
    let emitted = 0;
    for (let i = 0; i < 313; i++) {
      // 10 s
      t += 32;
      if (m.push(0.05, 0.003, t) !== null) emitted++;
    }
    expect(emitted / 10).toBeGreaterThan(14);
    expect(emitted / 10).toBeLessThan(17);
  });

  it("rises faster than it falls", () => {
    const up = new LevelMeter({ intervalMs: 0 });
    const a = up.push(0.1, 0.003, 0)!;
    const down = new LevelMeter({ intervalMs: 0 });
    for (let i = 0; i < 20; i++) down.push(0.1, 0.003, i);
    const top = down.push(0.1, 0.003, 21)!;
    const b = down.push(0.003, 0.003, 22)!;
    expect(a).toBeGreaterThan(0.3); // one frame of loud input already moves the orb
    expect(top - b).toBeLessThan(0.3 * top); // one frame of silence barely moves it
  });

  it("stays in 0..1 and settles near 0 in silence", () => {
    const m = new LevelMeter({ intervalMs: 0 });
    let last = 1;
    for (let i = 0; i < 200; i++) last = m.push(0.002, 0.003, i)!;
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThan(0.02);
  });
});

describe("EnergyGate (eco pre-gate)", () => {
  const FLOOR = 0.004;
  const QUIET = 0.002; // < floor x 1.5
  const LOUD = 0.02;

  it("runs the VAD on every frame while there is energy", () => {
    const g = new EnergyGate();
    for (let t = 0; t < 10_000; t += 32) expect(g.shouldRun(LOUD, FLOOR, t)).toBe(true);
  });

  it("keeps full duty for the first 3 s of quiet, then alternates run / skip", () => {
    const g = new EnergyGate();
    let t = 0;
    for (; t <= 3000; t += 32) expect(g.shouldRun(QUIET, FLOOR, t)).toBe(true);
    const decisions: boolean[] = [];
    for (let i = 0; i < 10; i++, t += 32) decisions.push(g.shouldRun(QUIET, FLOOR, t));
    expect(decisions.filter(Boolean)).toHaveLength(5);
    // strictly alternating
    for (let i = 1; i < decisions.length; i++) expect(decisions[i]).not.toBe(decisions[i - 1]);
  });

  it("goes back to full duty as soon as energy rises, and needs another 3 s of quiet to skip again", () => {
    const g = new EnergyGate();
    let t = 0;
    for (; t < 4000; t += 32) g.shouldRun(QUIET, FLOOR, t);
    expect(g.shouldRun(LOUD, FLOOR, t)).toBe(true);
    t += 32;
    for (let i = 0; i < 20; i++, t += 32) expect(g.shouldRun(QUIET, FLOOR, t)).toBe(true);
  });

  it("reset() restores full duty (called while speech is in progress)", () => {
    const g = new EnergyGate();
    let t = 0;
    for (; t < 5000; t += 32) g.shouldRun(QUIET, FLOOR, t);
    g.reset();
    expect(g.shouldRun(QUIET, FLOOR, t)).toBe(true);
    expect(g.shouldRun(QUIET, FLOOR, t + 32)).toBe(true);
  });

  it("the skip fraction over a long quiet stretch tends to 50 %", () => {
    const g = new EnergyGate();
    let skipped = 0;
    let total = 0;
    for (let t = 0; t < 60_000; t += 32) {
      total++;
      if (!g.shouldRun(QUIET, FLOOR, t)) skipped++;
    }
    expect(skipped / total).toBeGreaterThan(0.45);
    expect(skipped / total).toBeLessThan(0.5);
  });
});
