import { describe, expect, it } from "vitest";
import { encodeWav16k, mixToMono, resampleLinear, toMono16k } from "./wav";

/** The phone records with MediaRecorder (Opus/AAC at 48 kHz); the server wants a 16 kHz mono 16-bit WAV. */

describe("capture WAV encoding", () => {
  it("writes a 44-byte RIFF header and little-endian 16-bit samples, clipping out-of-range values", () => {
    const bytes = encodeWav16k(Float32Array.from([0, 0.5, -0.5, 1.5, -2]));
    const v = new DataView(bytes.buffer);
    const tag = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
    expect(tag(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 10);
    expect(tag(8)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 16384, -16383, 32767, -32767]); // Math.round(-16383.5) is -16383, as on the server
  });

  it("averages channels to mono", () => {
    expect(Array.from(mixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])]))).toEqual([0.5, 0]);
    const one = Float32Array.from([0.25]);
    expect(mixToMono([one])).toBe(one);
  });

  it("resamples 48 kHz to 16 kHz (a third of the samples, values interpolated)", () => {
    const ramp = Float32Array.from({ length: 48 }, (_, i) => i / 48);
    const out = resampleLinear(ramp, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[5]).toBeCloseTo(15 / 48, 5);
    expect(resampleLinear(ramp, 16000, 16000)).toBe(ramp);
  });

  it("turns a decoded buffer into 16 kHz mono without OfflineAudioContext (the fallback path)", async () => {
    const left = new Float32Array(44100).fill(0.2);
    const right = new Float32Array(44100).fill(0.4);
    const buf = { numberOfChannels: 2, sampleRate: 44100, length: 44100, duration: 1, getChannelData: (c: number) => (c === 0 ? left : right) };
    const out = await toMono16k(buf, { offline: null });
    expect(out.length).toBe(16000);
    expect(out[8000]).toBeCloseTo(0.3, 5);
  });
});
