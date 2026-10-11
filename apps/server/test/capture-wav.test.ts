import { describe, expect, it } from "vitest";
import { WavError, parseWav } from "../src/capture/wav";
import { wav16k } from "../src/wispr/sarvam";

/** WAV → 16 kHz mono Float32 for the capture endpoint: the formats a browser, `afconvert` or a voice-recorder app produce. */

function wavOf(o: { rate: number; channels: number; format: "pcm16" | "float32" | "pcm24" | "extensible16"; frames: number[][]; extraChunk?: boolean }): Uint8Array {
  const bits = o.format === "float32" ? 32 : o.format === "pcm24" ? 24 : 16;
  const bps = bits / 8;
  const dataLen = o.frames.length * o.channels * bps;
  const extensible = o.format === "extensible16";
  const fmtLen = extensible ? 40 : 16;
  const list = o.extraChunk ? 8 + 4 : 0;
  const buf = new Uint8Array(12 + 8 + fmtLen + list + 8 + dataLen);
  const v = new DataView(buf.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, buf.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, fmtLen, true);
  v.setUint16(20, extensible ? 0xfffe : o.format === "float32" ? 3 : 1, true);
  v.setUint16(22, o.channels, true);
  v.setUint32(24, o.rate, true);
  v.setUint32(28, o.rate * o.channels * bps, true);
  v.setUint16(32, o.channels * bps, true);
  v.setUint16(34, bits, true);
  let at = 20 + 16;
  if (extensible) {
    v.setUint16(36, 22, true);
    v.setUint16(38, bits, true);
    v.setUint32(40, 0, true);
    v.setUint16(44, 1, true); // subformat GUID starts with the format code (PCM)
    at = 20 + 40;
  }
  if (o.extraChunk) {
    tag(at, "LIST");
    v.setUint32(at + 4, 4, true);
    tag(at + 8, "INFO");
    at += 12;
  }
  tag(at, "data");
  v.setUint32(at + 4, dataLen, true);
  at += 8;
  for (const frame of o.frames)
    for (const s of frame) {
      if (o.format === "float32") v.setFloat32(at, s, true);
      else if (o.format === "pcm24") {
        const n = Math.round(s * 8388607);
        v.setUint8(at, n & 0xff);
        v.setUint8(at + 1, (n >> 8) & 0xff);
        v.setUint8(at + 2, (n >> 16) & 0xff);
      } else v.setInt16(at, Math.round(s * 32767), true);
      at += bps;
    }
  return buf;
}

describe("parseWav", () => {
  it("round-trips the 16 kHz mono PCM16 WAV that Sarvam's encoder writes", () => {
    const pcm = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10) * 0.5);
    const out = parseWav(wav16k(pcm));
    expect(out.length).toBe(16000);
    for (let i = 0; i < out.length; i += 997) expect(out[i]).toBeCloseTo(pcm[i] as number, 3);
  });

  it("downmixes stereo and resamples 48 kHz to 16 kHz", () => {
    const frames = Array.from({ length: 48000 }, () => [0.4, 0.2]);
    const out = parseWav(wavOf({ rate: 48000, channels: 2, format: "pcm16", frames }));
    expect(out.length).toBe(16000);
    expect(out[8000]).toBeCloseTo(0.3, 3);
  });

  it("reads 32-bit float, 24-bit PCM and WAVE_FORMAT_EXTENSIBLE, skipping unknown chunks", () => {
    const frames = Array.from({ length: 1600 }, () => [0.25]);
    expect(parseWav(wavOf({ rate: 16000, channels: 1, format: "float32", frames }))[100]).toBeCloseTo(0.25, 5);
    expect(parseWav(wavOf({ rate: 16000, channels: 1, format: "pcm24", frames }))[100]).toBeCloseTo(0.25, 4);
    expect(parseWav(wavOf({ rate: 16000, channels: 1, format: "extensible16", frames, extraChunk: true }))[100]).toBeCloseTo(0.25, 3);
  });

  it("refuses what is not a WAV, an unsupported encoding, and clips over the length limit", () => {
    expect(() => parseWav(new TextEncoder().encode("ID3 this is an mp3"))).toThrow(WavError);
    const alaw = wavOf({ rate: 8000, channels: 1, format: "pcm16", frames: [[0]] });
    new DataView(alaw.buffer).setUint16(20, 6, true); // A-law
    expect(() => parseWav(alaw)).toThrow(/encoding/);
    const long = wavOf({ rate: 1000, channels: 1, format: "pcm16", frames: Array.from({ length: 1000 * 11 }, () => [0]) });
    expect(() => parseWav(long, { maxSeconds: 10 })).toThrow(/too long/);
  });
});
