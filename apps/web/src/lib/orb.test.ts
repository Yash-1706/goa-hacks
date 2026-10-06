import { describe, expect, it } from "vitest";
import { deriveOrb, type OrbInput } from "./orb";

const base: OrbInput = {
  audioState: "off",
  serverPaused: false,
  conn: "open",
  analyzing: false,
  suggesting: false,
  engine: null,
  resumeHint: false,
  speaking: false,
};
const orb = (o: Partial<OrbInput>) => deriveOrb({ ...base, ...o });

describe("deriveOrb", () => {
  it("off: tap starts listening", () => {
    expect(orb({})).toMatchObject({ mode: "off", action: "start", label: "Tap to start listening" });
  });

  it("listening breathes, hearing reacts, both pause on tap", () => {
    expect(orb({ audioState: "listening", engine: "mic" })).toMatchObject({ mode: "listening", action: "pause", label: "Listening" });
    expect(orb({ audioState: "hearing", engine: "mic" })).toMatchObject({ mode: "hearing", label: "Hearing you" });
  });

  it("typed input is labelled honestly and is not a degraded state", () => {
    expect(orb({ audioState: "listening", engine: "text", detail: "typed input (no microphone)" })).toMatchObject({ mode: "listening", label: "Listening (typed input)" });
  });

  it("typed speech makes the orb react even though the engine stays 'listening'", () => {
    expect(orb({ audioState: "listening", engine: "text", speaking: true }).mode).toBe("hearing");
  });

  it("paused wins over everything and tap resumes", () => {
    const v = orb({ audioState: "hearing", serverPaused: true, analyzing: true, suggesting: true });
    expect(v).toMatchObject({ mode: "paused", action: "resume", label: "Paused. Tap to resume", analyzing: false, suggesting: false });
    expect(orb({ audioState: "paused" }).mode).toBe("paused");
  });

  it("analyzing and suggesting are overlays on the base mode", () => {
    expect(orb({ audioState: "listening", analyzing: true, suggesting: true })).toMatchObject({ mode: "listening", analyzing: true, suggesting: true });
  });

  it("errors show the reason and offer a retry", () => {
    expect(orb({ audioState: "error", detail: "microphone permission denied" })).toMatchObject({ mode: "error", action: "retry", label: "Problem: microphone permission denied" });
    expect(orb({ audioState: "error" }).label).toMatch(/retry/);
  });

  it("a dropped connection is degraded, and says fragments are queued while listening", () => {
    expect(orb({ audioState: "listening", conn: "closed" })).toMatchObject({ mode: "degraded", label: "Listening, but offline. Fragments are queued" });
    expect(orb({ conn: "connecting" })).toMatchObject({ mode: "degraded", label: "Reconnecting…", action: "start" });
  });

  it("a mic engine running without transcription (no Wispr key) is degraded", () => {
    expect(orb({ audioState: "listening", engine: "mic", detail: "no Wispr key: using typed input" })).toMatchObject({ mode: "degraded", label: "Listening: no Wispr key: using typed input" });
    expect(orb({ audioState: "listening", engine: "mic", degraded: "Wispr REST fallback: timeout" }).mode).toBe("degraded");
  });

  it("starting shows the spinner state and ignores taps", () => {
    expect(orb({ audioState: "starting" })).toMatchObject({ mode: "starting", action: "none" });
  });

  it("after a remote resume the orb asks for a deliberate tap", () => {
    expect(orb({ resumeHint: true })).toMatchObject({ mode: "off", label: "Tap to resume listening", action: "start" });
  });
});
