import { FragmentFinalSchema } from "@synapse/shared";
import { describe, expect, it } from "vitest";
import { buildFragmentFinal, isValidFragment, makeFragmentId, type FragmentInput } from "./fragment";

const base: FragmentInput = {
  fragmentId: "dev-1-abc-0",
  sessionId: "sess-1",
  text: "Email the team about the delay",
  speechStart: 1_700_000_000_000,
  speechEnd: 1_700_000_002_400,
  commitSent: 1_700_000_002_880,
  wisprFinal: 1_700_000_003_140,
  pauseBeforeMs: 1888,
  rmsMean: 0.0587,
  rmsMax: 0.1,
  whisper: false,
  transport: "wispr_ws",
};

describe("makeFragmentId", () => {
  it("is `${deviceId}-${epochMs in base36}-${seq in base36}`", () => {
    const t = 1_700_000_000_123;
    expect(makeFragmentId("dev-1", t, 0)).toBe(`dev-1-${t.toString(36)}-0`);
    expect(makeFragmentId("dev-1", t, 35)).toBe(`dev-1-${t.toString(36)}-z`);
  });

  it("is unique per utterance even within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 500 }, (_, i) => makeFragmentId("dev-1", 1_700_000_000_000, i)));
    expect(ids.size).toBe(500);
  });

  it("never exceeds the 80-character wire limit, even for a very long device id (the left part is cut)", () => {
    const longId = "d".repeat(200) + "-tail";
    const id = makeFragmentId(longId, 1_700_000_000_000, 7);
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id.endsWith(`-${(1_700_000_000_000).toString(36)}-7`)).toBe(true);
    expect(id).toContain("-tail-");
    expect(FragmentFinalSchema.shape.fragmentId.safeParse(id).success).toBe(true);
  });
});

describe("buildFragmentFinal", () => {
  it("produces a payload that satisfies the shared wire schema", () => {
    const f = buildFragmentFinal({ ...base, detectedLanguage: "en", activity: "walking" });
    expect(FragmentFinalSchema.safeParse(f).success).toBe(true);
    expect(f).toEqual({
      type: "fragment.final",
      fragmentId: "dev-1-abc-0",
      sessionId: "sess-1",
      text: "Email the team about the delay",
      detectedLanguage: "en",
      t: { speechStart: 1_700_000_000_000, speechEnd: 1_700_000_002_400, commitSent: 1_700_000_002_880, wisprFinal: 1_700_000_003_140 },
      durationMs: 2400,
      pauseBeforeMs: 1888,
      rmsMean: 0.0587,
      rmsMax: 0.1,
      whisper: false,
      activity: "walking",
      transport: "wispr_ws",
    });
  });

  it("omits optional fields that are absent", () => {
    const f = buildFragmentFinal(base);
    expect("detectedLanguage" in f).toBe(false);
    expect("activity" in f).toBe(false);
  });

  it("rounds times to whole milliseconds and derives durationMs from them", () => {
    const f = buildFragmentFinal({ ...base, speechStart: 1000.4, speechEnd: 3400.6, commitSent: 3500.5, wisprFinal: 3800.49 });
    expect(f.t).toEqual({ speechStart: 1000, speechEnd: 3401, commitSent: 3501, wisprFinal: 3800 });
    expect(f.durationMs).toBe(2401);
  });

  it("clamps everything into its schema range instead of producing an invalid message", () => {
    const f = buildFragmentFinal({
      ...base,
      speechEnd: base.speechStart - 500, // clock went backwards
      pauseBeforeMs: -20,
      rmsMean: 1.7,
      rmsMax: Number.NaN,
      text: "x".repeat(5000),
      detectedLanguage: "language-that-is-way-too-long",
    });
    expect(f.durationMs).toBe(0);
    expect(f.t.speechEnd).toBe(f.t.speechStart);
    expect(f.pauseBeforeMs).toBe(0);
    expect(f.rmsMean).toBe(1);
    expect(f.rmsMax).toBe(0);
    expect(f.text).toHaveLength(4000);
    expect(f.detectedLanguage).toHaveLength(16);
    expect(isValidFragment(f)).toBe(true);
  });

  it("trims the text and keeps the whisper flag and transport", () => {
    const f = buildFragmentFinal({ ...base, text: "  quiet words \n", whisper: true, transport: "wispr_rest" });
    expect(f.text).toBe("quiet words");
    expect(f.whisper).toBe(true);
    expect(f.transport).toBe("wispr_rest");
  });

  it("isValidFragment rejects what the server would reject", () => {
    const f = buildFragmentFinal(base);
    expect(isValidFragment(f)).toBe(true);
    expect(isValidFragment({ ...f, text: "" })).toBe(false);
    expect(isValidFragment({ ...f, sessionId: "s".repeat(81) })).toBe(false);
  });
});
