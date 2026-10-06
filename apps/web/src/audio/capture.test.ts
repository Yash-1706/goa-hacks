import type { Activity, FragmentFinal } from "@synapse/shared";
import { describe, expect, it } from "vitest";
import { CaptureCore, FrameRing, PREROLL_FRAMES, type CaptureConfig } from "./capture";
import { NoiseFloor } from "./levels";
import { StatsCollector } from "./stats";
import { FakeClock } from "./test-utils";
import { frameWithRms } from "./test-vad";
import type { AudioDiagnostic, WisprTokenInfo } from "./types";
import type { ClaimOptions, StreamerLike, UtteranceHandle } from "./wispr";

/* ---------------------------------------------------------------- doubles */

class FakeHandle implements UtteranceHandle {
  state: "streaming" | "committed" | "settled" = "streaming";
  preroll: Array<{ pcm: Int16Array; rms: number }> = [];
  pushed: Array<{ pcm: Int16Array; rms: number }> = [];
  commits = 0;
  aborts: string[] = [];
  constructor(readonly opts: ClaimOptions) {}
  get fragmentId(): string {
    return this.opts.fragmentId;
  }
  get packetCount(): number {
    return this.preroll.length + this.pushed.length;
  }
  pushPreroll(frames: ReadonlyArray<{ pcm: Int16Array; rms: number }>): void {
    this.preroll.push(...frames);
  }
  push(pcm: Int16Array, rms: number): void {
    this.pushed.push({ pcm, rms });
  }
  commit(): void {
    this.commits++;
    this.state = "committed";
  }
  abort(reason?: string): void {
    this.aborts.push(reason ?? "");
    this.state = "settled";
  }
}

class FakeStreamer implements StreamerLike {
  handles: FakeHandle[] = [];
  standbyReady = true;
  start(): void {}
  stop(): void {}
  checkFreshness(): void {}
  primeToken(_i: WisprTokenInfo): void {}
  claim(opts: ClaimOptions): UtteranceHandle {
    const h = new FakeHandle(opts);
    this.handles.push(h);
    return h;
  }
}

function make(over: Partial<CaptureConfig> = {}, mode: { v: "normal" | "eco" } = { v: "normal" }) {
  const clock = new FakeClock();
  const streamer = new FakeStreamer();
  const speaking: Array<[boolean, number]> = [];
  const fragments: FragmentFinal[] = [];
  const failed: Array<[string, string]> = [];
  const pauses: Array<{ speechEnd: number }> = [];
  const levels: number[] = [];
  const diags: AudioDiagnostic[] = [];
  const vadThresholds: Array<[number, number]> = [];
  let activity: Activity = "walking";
  const stats = new StatsCollector({ clock, getMode: () => mode.v, onStats: () => undefined });
  const core = new CaptureCore({
    deviceId: "dev-1",
    sessionId: "sess-1",
    clock,
    stats,
    getMode: () => mode.v,
    getActivity: () => activity,
    streamer,
    callbacks: {
      onSpeaking: (s, at) => speaking.push([s, at]),
      onFragment: (f) => fragments.push(f),
      onFailed: (id, r) => failed.push([id, r]),
      onPauseIntent: (i) => pauses.push(i),
      onLevel: (l) => levels.push(l),
      onCalibrated: () => undefined,
      emit: (d) => diags.push(d),
    },
    setVadThresholds: (p, n) => vadThresholds.push([p, n]),
    ...over,
  });
  /** feed one frame the way the VAD driver does (onFrame, then the model's probability) */
  const feed = (rms: number, prob: number): Float32Array => {
    clock.advance(32);
    const f = frameWithRms(rms);
    if (core.onFrame(f)) core.onProbs(f, prob);
    return f;
  };
  return {
    clock,
    core,
    streamer,
    speaking,
    fragments,
    failed,
    pauses,
    levels,
    diags,
    vadThresholds,
    stats,
    feed,
    setActivity: (a: Activity) => (activity = a),
  };
}

const transcript = (text: string, over: Partial<{ tCommitSent: number; tFinal: number }> = {}) => ({
  text,
  transport: "wispr_ws" as const,
  tCommitSent: over.tCommitSent ?? 1,
  tFinal: over.tFinal ?? 2,
});

/* ---------------------------------------------------------------- the ring */

describe("FrameRing", () => {
  const frameOf = (v: number) => new Float32Array(512).fill(v);

  it("keeps the newest 16 frames, oldest first, and hands out copies", () => {
    expect(PREROLL_FRAMES).toBe(16);
    const ring = new FrameRing();
    for (let i = 1; i <= 20; i++) ring.push(frameOf(i / 100), i);
    expect(ring.size).toBe(16);
    const snap = ring.snapshot();
    expect(snap.map((s) => s.rms)).toEqual(Array.from({ length: 16 }, (_, i) => i + 5)); // frames 5..20
    snap[0]!.pcm.fill(0);
    expect(ring.snapshot()[0]!.pcm.some((v) => v !== 0)).toBe(true); // the ring was not touched
  });

  it("returns fewer frames before it is full", () => {
    const ring = new FrameRing();
    ring.push(frameOf(0.1), 0.1);
    ring.push(frameOf(0.2), 0.2);
    expect(ring.snapshot().map((s) => s.rms)).toEqual([0.1, 0.2]);
  });

  it("converts to int16 on the way in", () => {
    const ring = new FrameRing();
    const slot = ring.push(frameOf(0.5), 0.5);
    expect(slot[0]).toBe(16383);
  });

  it("clear() zero-fills every slot, including the one a caller still holds", () => {
    const ring = new FrameRing();
    const slot = ring.push(frameOf(0.9), 0.9);
    expect(ring.isBlank()).toBe(false);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(slot.every((v) => v === 0)).toBe(true);
    expect(ring.isBlank()).toBe(true);
    expect(ring.snapshot()).toEqual([]);
  });

  it("tolerates a different frame length (the slot is resized)", () => {
    const ring = new FrameRing(2);
    ring.push(new Float32Array(256).fill(0.1), 0.1);
    expect(ring.snapshot()[0]!.pcm.length).toBe(256);
  });
});

/* ---------------------------------------------------------------- the core */

describe("CaptureCore packetization", () => {
  it("before speech frames only go to the ring; at speech start the pre-roll is flushed in order, then frames stream", () => {
    const t = make();
    for (let i = 0; i < 30; i++) t.feed(0.002 + i * 0.0001, 0.02);
    expect(t.streamer.handles).toHaveLength(0);
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    expect(t.streamer.handles).toHaveLength(1);
    const h = t.streamer.handles[0]!;
    expect(h.preroll).toHaveLength(16);
    expect(h.preroll[15]!.rms).toBeCloseTo(0.08, 5); // the frame that triggered the VAD is the last pre-roll frame
    expect(h.preroll[0]!.rms).toBeCloseTo(0.002 + 15 * 0.0001, 5);
    expect(h.preroll.map((p) => p.rms)).toEqual([...h.preroll.map((p) => p.rms)].sort((a, b) => a - b)); // chronological
    t.feed(0.07, 0.9);
    t.feed(0.06, 0.9);
    expect(h.pushed.map((p) => Math.round(p.rms * 100) / 100)).toEqual([0.07, 0.06]);
    expect(h.pushed[0]!.pcm).toHaveLength(512);
  });

  it("the session owns its buffers: zero-filling them does not corrupt the ring or the next utterance's pre-roll", () => {
    const t = make();
    for (let i = 0; i < 20; i++) t.feed(0.05, 0.9);
    t.core.onSpeechStart();
    const h1 = t.streamer.handles[0]!;
    h1.preroll.forEach((p) => p.pcm.fill(0)); // what Utterance.finish() does
    t.core.onSpeechEnd();
    t.core.onSpeechStart();
    const h2 = t.streamer.handles[1]!;
    expect(h2.preroll.some((p) => p.pcm.some((v) => v !== 0))).toBe(true);
  });

  it("claims with 4 packets per append in normal mode and 8 in eco mode", () => {
    const mode = { v: "normal" as "normal" | "eco" };
    const t = make({}, mode);
    t.feed(0.05, 0.9);
    t.core.onSpeechStart();
    expect(t.streamer.handles[0]!.opts.packetsPerAppend).toBe(4);
    t.core.onSpeechEnd();
    mode.v = "eco";
    t.feed(0.05, 0.9);
    t.core.onSpeechStart();
    expect(t.streamer.handles[1]!.opts.packetsPerAppend).toBe(8);
  });

  it("without a streamer (typed-input mode) it still reports speech boundaries and levels, and buffers nothing", () => {
    const t = make({ streamer: null });
    for (let i = 0; i < 20; i++) t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    t.core.onSpeechEnd();
    expect(t.speaking.map((s) => s[0])).toEqual([true, false]);
    expect(t.levels.length).toBeGreaterThan(5);
    expect(t.core.bufferedFrames).toBe(0);
    expect(t.streamer.handles).toHaveLength(0);
  });

  it("a streamer attached later is used from the next utterance", () => {
    const t = make({ streamer: null });
    t.feed(0.05, 0.9);
    t.core.onSpeechStart();
    t.core.onSpeechEnd();
    t.core.setStreamer(t.streamer);
    t.feed(0.05, 0.9);
    t.core.onSpeechStart();
    expect(t.streamer.handles).toHaveLength(1);
  });
});

describe("CaptureCore utterance bookkeeping", () => {
  it("speechStart = start of the first voiced frame, speechEnd = end of the LAST VOICED frame (not the VAD event)", () => {
    const t = make();
    t.feed(0.002, 0.02);
    const before = t.clock.now();
    for (let i = 0; i < 10; i++) {
      const f = t.feed(0.08, 0.9);
      if (i === 0) t.core.onSpeechStart();
      void f;
    }
    const lastVoiced = t.clock.now();
    for (let i = 0; i < 15; i++) t.feed(0.002, 0.02); // redemption tail, not voiced
    t.core.onSpeechEnd();
    expect(t.speaking).toEqual([
      [true, before],
      [false, lastVoiced],
    ]);
    expect(t.streamer.handles[0]!.commits).toBe(1);
    expect(t.core.lastSpeechEnd).toBe(lastVoiced);
  });

  it("a voiced frame inside the redemption window moves the end (the VAD kept the utterance alive)", () => {
    const t = make();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    for (let i = 0; i < 5; i++) t.feed(0.002, 0.02);
    t.feed(0.08, 0.9); // speech resumes within the redemption window
    const end = t.clock.now();
    for (let i = 0; i < 15; i++) t.feed(0.002, 0.02);
    t.core.onSpeechEnd();
    expect(t.speaking[1]).toEqual([false, end]);
  });

  it("frames in the hysteresis band (neither voiced nor silent) do not extend the utterance or count as voiced", () => {
    const t = make();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    const end = t.clock.now();
    for (let i = 0; i < 4; i++) t.feed(0.05, 0.3); // 0.3 < positive threshold 0.35
    t.core.onSpeechEnd();
    expect(t.speaking[1]![1]).toBe(end);
  });

  it("a misfire aborts the session without a commit and reports speaking=false", () => {
    const t = make();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    t.core.onMisfire();
    const h = t.streamer.handles[0]!;
    expect(h.commits).toBe(0);
    expect(h.aborts).toEqual(["vad misfire"]);
    expect(t.speaking.map((s) => s[0])).toEqual([true, false]);
    expect(t.core.speaking).toBe(false);
    t.core.onMisfire(); // idempotent
    t.core.onSpeechEnd();
    expect(t.speaking).toHaveLength(2);
  });

  it("a speech start while an utterance is still open commits the old one first (never two open sessions)", () => {
    const t = make();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    expect(t.streamer.handles).toHaveLength(2);
    expect(t.streamer.handles[0]!.commits).toBe(1);
    expect(t.streamer.handles[1]!.commits).toBe(0);
  });

  it("probabilities for frames it never saw (or that were skipped) are ignored", () => {
    const t = make();
    t.core.onProbs(new Float32Array(512), 0.9);
    t.feed(0.08, 0.9);
    expect(() => t.core.onProbs(new Float32Array(512), 0.9)).not.toThrow();
  });

  it("whisper flag follows the calibrated floor and the configurable absolute ceiling", () => {
    const nf = new NoiseFloor({ calibrationMs: 640, warmupFrames: 0, minSilentFrames: 5 });
    const t = make({ noiseFloor: nf, whisperRmsAbs: 0.02 });
    for (let i = 0; i < 25; i++) t.feed(0.003, 0.02); // calibrate at 0.003
    expect(nf.calibrated).toBe(true);
    for (let i = 0; i < 6; i++) {
      t.feed(0.015, 0.9);
      if (i === 0) t.core.onSpeechStart();
    }
    t.core.onSpeechEnd();
    t.streamer.handles[0]!.opts.onTranscript(transcript("hello there"));
    expect(t.fragments[0]!.whisper).toBe(true); // 0.015 < max(0.009, 0.02)
    expect(t.fragments[0]!.activity).toBe("walking");
  });

  it("pauseBeforeMs is 0 for the first utterance and the true silence after that", () => {
    const t = make();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    t.feed(0.08, 0.9);
    const end1 = t.clock.now();
    t.core.onSpeechEnd();
    for (let i = 0; i < 40; i++) t.feed(0.002, 0.02);
    t.feed(0.08, 0.9);
    const start2 = t.clock.now() - 32;
    t.core.onSpeechStart();
    t.feed(0.08, 0.9);
    t.core.onSpeechEnd();
    const [h1, h2] = t.streamer.handles as [FakeHandle, FakeHandle];
    h1.opts.onTranscript(transcript("one"));
    h2.opts.onTranscript(transcript("two"));
    expect(t.fragments.map((f) => f.pauseBeforeMs)).toEqual([0, start2 - end1]);
  });
});

describe("CaptureCore transcripts", () => {
  function finished(text: string, over: Partial<CaptureConfig> = {}) {
    const t = make(over);
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    t.feed(0.08, 0.9);
    t.core.onSpeechEnd();
    t.streamer.handles[0]!.opts.onTranscript(transcript(text));
    return t;
  }

  it("a pause phrase is NEVER delivered as a fragment: it raises the kill switch with the end of the phrase", () => {
    const t = finished("Pause memory.");
    expect(t.fragments).toHaveLength(0);
    expect(t.failed).toHaveLength(0);
    expect(t.pauses).toHaveLength(1);
    expect(t.pauses[0]!.speechEnd).toBe(t.core.lastSpeechEnd);
  });

  it("ordinary speech is delivered, trimmed, with every field filled in", () => {
    const t = finished("  Call Dev about the deploy  ");
    expect(t.pauses).toHaveLength(0);
    expect(t.fragments).toHaveLength(1);
    expect(t.fragments[0]).toMatchObject({ text: "Call Dev about the deploy", transport: "wispr_ws", sessionId: "sess-1" });
  });

  it("empty text is dropped silently", () => {
    const t = finished("   ");
    expect(t.fragments).toHaveLength(0);
    expect(t.failed).toHaveLength(0);
    expect(t.pauses).toHaveLength(0);
  });

  it("a fragment that cannot satisfy the wire schema is reported as failed instead of being sent", () => {
    const t = finished("hello", { sessionId: "s".repeat(120) }); // schema caps sessionId at 80
    expect(t.fragments).toHaveLength(0);
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0]![1]).toBe("fragment failed validation");
  });

  it("Wispr failure for an utterance is passed through with its fragment id", () => {
    const t = make();
    t.feed(0.08, 0.9);
    t.core.onSpeechStart();
    t.core.onSpeechEnd();
    const h = t.streamer.handles[0]!;
    h.opts.onFailed("rest fallback failed: HTTP 500");
    expect(t.failed).toEqual([[h.fragmentId, "rest fallback failed: HTTP 500"]]);
  });
});

describe("CaptureCore eco pre-gate and mode switching", () => {
  it("after calibration and 3 s of quiet in eco mode every 2nd frame is kept from the VAD (and counted)", () => {
    const mode = { v: "eco" as "normal" | "eco" };
    const nf = new NoiseFloor({ calibrationMs: 640, warmupFrames: 0, minSilentFrames: 5 });
    const t = make({ noiseFloor: nf }, mode);
    let skipped = 0;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      t.clock.advance(32);
      const f = frameWithRms(0.001);
      total++;
      if (t.core.onFrame(f)) t.core.onProbs(f, 0.01);
      else skipped++;
    }
    expect(nf.calibrated).toBe(true);
    // 400 frames: ~20 to calibrate, 3 s (94 frames) of quiet at full duty, then half of the remaining ~286 are skipped
    expect(skipped).toBeGreaterThan(135);
    expect(skipped).toBeLessThan(150);
    const s = t.stats.snapshot();
    expect(s.framesTotal).toBe(total);
    expect(s.framesSkipped).toBe(skipped);
  });

  it("never skips while an utterance is in progress, and a loud frame ends the skipping at once", () => {
    const mode = { v: "eco" as "normal" | "eco" };
    const nf = new NoiseFloor({ calibrationMs: 640, warmupFrames: 0, minSilentFrames: 5 });
    const t = make({ noiseFloor: nf }, mode);
    for (let i = 0; i < 300; i++) t.feed(0.001, 0.01);
    // loud frame -> runs
    const loud = frameWithRms(0.2);
    t.clock.advance(32);
    expect(t.core.onFrame(loud)).toBe(true);
    t.core.onProbs(loud, 0.9);
    t.core.onSpeechStart();
    // mid-utterance quiet frames are never skipped
    for (let i = 0; i < 100; i++) {
      t.clock.advance(32);
      expect(t.core.onFrame(frameWithRms(0.0005))).toBe(true);
    }
  });

  it("retunes the VAD when the mode flips, deferred while an utterance is open", () => {
    const mode = { v: "normal" as "normal" | "eco" };
    const t = make({}, mode);
    expect(t.core.positiveThreshold).toBeCloseTo(0.35, 6);
    mode.v = "eco";
    t.feed(0.08, 0.9);
    t.core.onSpeechStart(); // boundary: picks eco up
    expect(t.core.positiveThreshold).toBeCloseTo(0.45, 6);
    expect(t.vadThresholds[t.vadThresholds.length - 1]![0]).toBeCloseTo(0.45, 6);
    mode.v = "normal";
    t.core.refreshMode(); // utterance open: deferred
    expect(t.core.positiveThreshold).toBeCloseTo(0.45, 6);
    t.core.onSpeechEnd(); // boundary
    expect(t.core.positiveThreshold).toBeCloseTo(0.35, 6);
    expect(t.diags.filter((d) => d.kind === "mode").map((d) => (d as { mode: string }).mode)).toEqual(["eco", "normal"]);
  });
});

describe("CaptureCore privacy teardown", () => {
  it("dispose() aborts the open utterance without a commit, blanks the ring and ignores everything afterwards", () => {
    const t = make();
    for (let i = 0; i < 20; i++) t.feed(0.05, 0.9);
    t.core.onSpeechStart();
    const h = t.streamer.handles[0]!;
    expect(t.core.bufferedFrames).toBe(16);
    t.core.dispose();
    expect(h.commits).toBe(0);
    expect(h.aborts).toEqual(["disposed"]);
    expect(t.core.buffersBlank).toBe(true);
    expect(t.core.bufferedFrames).toBe(0);
    // late VAD events and frames do nothing
    const events = t.speaking.length;
    const f = frameWithRms(0.2);
    expect(t.core.onFrame(f)).toBe(false);
    t.core.onProbs(f, 0.9);
    t.core.onSpeechStart();
    t.core.onSpeechEnd();
    t.core.onMisfire();
    expect(t.speaking).toHaveLength(events);
    expect(t.streamer.handles).toHaveLength(1);
    // a transcript that still arrives is dropped
    h.opts.onTranscript(transcript("too late"));
    expect(t.fragments).toHaveLength(0);
    expect(t.pauses).toHaveLength(0);
    t.core.dispose(); // idempotent
  });

  it("recalibrate() restarts the noise-floor measurement", () => {
    const nf = new NoiseFloor({ calibrationMs: 640, warmupFrames: 0, minSilentFrames: 5 });
    const t = make({ noiseFloor: nf });
    for (let i = 0; i < 30; i++) t.feed(0.003, 0.02);
    expect(nf.calibrated).toBe(true);
    t.core.recalibrate();
    expect(nf.calibrated).toBe(false);
  });
});

describe("CaptureCore empty transcripts", () => {
  function utter(frames: number, rms: number) {
    const t = make();
    t.feed(rms, 0.9);
    t.core.onSpeechStart();
    for (let i = 1; i < frames; i++) t.feed(rms, 0.9);
    t.core.onSpeechEnd();
    t.streamer.handles[0]!.opts.onTranscript(transcript(""));
    return t;
  }

  it("flags an empty Wispr transcript for clearly audible speech (the symptom of a wrong audio format)", () => {
    const t = utter(30, 0.08); // ~1 s at RMS 0.08
    expect(t.fragments).toHaveLength(0);
    expect(t.failed).toHaveLength(0);
    const anomaly = t.diags.find((d) => d.kind === "anomaly") as { detail: string } | undefined;
    expect(anomaly?.detail).toMatch(/^empty transcript for \d+ ms of voiced speech$/);
  });

  it("stays quiet for blips and for near-silent noise (empty is the right answer there)", () => {
    expect(utter(8, 0.08).diags.filter((d) => d.kind === "anomaly")).toHaveLength(0); // 256 ms
    expect(utter(30, 0.004).diags.filter((d) => d.kind === "anomaly")).toHaveLength(0); // far below speech level
  });
});
