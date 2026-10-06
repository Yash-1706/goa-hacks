import { describe, expect, it } from "vitest";
import {
  FRAME_MS,
  FRAME_SAMPLES,
  PACKET_DURATION_S,
  SAMPLE_RATE,
  bytesToBase64,
  bytesToBase64Fallback,
  concatInt16,
  encodePacket,
  floatToInt16,
  int16ToBytesLE,
  rmsFloat,
  rmsInt16,
  wrapWav,
  zeroFill,
} from "./pcm";

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

describe("constants", () => {
  it("one frame is 512 samples = 32 ms @ 16 kHz", () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(FRAME_SAMPLES).toBe(512);
    expect(FRAME_MS).toBe(32);
    expect(PACKET_DURATION_S).toBe(0.032);
  });
});

describe("floatToInt16", () => {
  it("maps the extremes with the asymmetric 0x8000 / 0x7FFF scaling", () => {
    const out = floatToInt16(new Float32Array([-1, 1, 0, 0.5, -0.5]));
    expect(Array.from(out)).toEqual([-32768, 32767, 0, 16383, -16384]);
  });

  it("clamps out-of-range samples and turns NaN into silence", () => {
    const out = floatToInt16(new Float32Array([2.5, -3, Number.NaN, Infinity, -Infinity]));
    expect(Array.from(out)).toEqual([32767, -32768, 0, 32767, -32768]);
  });

  it("writes into a provided buffer without allocating", () => {
    const dst = new Int16Array(4);
    const ret = floatToInt16([0.25, -0.25, 1, -1], dst);
    expect(ret).toBe(dst);
    expect(Array.from(dst)).toEqual([8191, -8192, 32767, -32768]);
  });

  it("is little-endian on the wire", () => {
    const bytes = int16ToBytesLE(new Int16Array([0x0102, -2]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0xfe, 0xff]);
  });
});

describe("rms", () => {
  it("is 0 for silence and for an empty frame", () => {
    expect(rmsFloat(new Float32Array(512))).toBe(0);
    expect(rmsFloat(new Float32Array(0))).toBe(0);
    expect(rmsInt16(new Int16Array(0))).toBe(0);
  });

  it("matches the analytic value for a constant and for a sine", () => {
    expect(rmsFloat(new Float32Array(512).fill(0.5))).toBeCloseTo(0.5, 6);
    const sine = new Float32Array(512);
    for (let i = 0; i < 512; i++) sine[i] = 0.4 * Math.sin((2 * Math.PI * 8 * i) / 512);
    expect(rmsFloat(sine)).toBeCloseTo(0.4 / Math.SQRT2, 3);
  });

  it("int16 RMS agrees with float RMS after conversion", () => {
    const f = new Float32Array(512);
    for (let i = 0; i < 512; i++) f[i] = 0.1 * Math.sin(i / 7);
    expect(rmsInt16(floatToInt16(f))).toBeCloseTo(rmsFloat(f), 3);
  });

  it("never exceeds 1", () => {
    expect(rmsFloat(new Float32Array(8).fill(3))).toBe(1);
  });
});

describe("base64", () => {
  it("matches the RFC 4648 test vectors (fallback encoder)", () => {
    const enc = (s: string) => bytesToBase64Fallback(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg==");
    expect(enc("fo")).toBe("Zm8=");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foob")).toBe("Zm9vYg==");
    expect(enc("fooba")).toBe("Zm9vYmE=");
    expect(enc("foobar")).toBe("Zm9vYmFy");
  });

  it("native and fallback encoders agree on random data of every length mod 3, including > 8 KB", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed & 0xff;
    };
    for (const len of [0, 1, 2, 3, 4, 5, 1023, 1024, 1025, 8191, 8192, 8193, 30000]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = rnd();
      const viaFallback = bytesToBase64Fallback(bytes);
      expect(bytesToBase64(bytes)).toBe(viaFallback);
      expect(b64decode(viaFallback)).toEqual(bytes);
    }
  });

  it("handles very large buffers without a call-stack blowup", () => {
    const big = new Uint8Array(3_000_000).fill(7);
    expect(bytesToBase64Fallback(big).length).toBe(4_000_000);
  });
});

describe("wrapWav", () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
  const wav = wrapWav(pcm);
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!);

  it("is a canonical 44-byte header plus the data", () => {
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(tag(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(tag(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(pcm.byteLength);
  });

  it("carries the samples verbatim after the header", () => {
    for (let i = 0; i < pcm.length; i++) expect(v.getInt16(44 + i * 2, true)).toBe(pcm[i]);
  });

  it("honours the sample rate and accepts raw bytes", () => {
    const w8 = wrapWav(new Uint8Array([1, 2, 3, 4]), 8000);
    const dv = new DataView(w8.buffer);
    expect(dv.getUint32(24, true)).toBe(8000);
    expect(dv.getUint32(28, true)).toBe(16000);
    expect(Array.from(w8.slice(44))).toEqual([1, 2, 3, 4]);
  });

  it("handles an empty clip", () => {
    const empty = wrapWav(new Int16Array(0));
    expect(empty.byteLength).toBe(44);
    expect(new DataView(empty.buffer).getUint32(40, true)).toBe(0);
  });
});

describe("encodePacket", () => {
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < frame.length; i++) frame[i] = (i * 37) % 2000 - 1000;

  it("raw packets are 1024 bytes of int16 LE with NO RIFF header (1368 base64 chars)", () => {
    const b64 = encodePacket(frame);
    expect(b64.length).toBe(1368);
    const bytes = b64decode(b64);
    expect(bytes.byteLength).toBe(1024);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).not.toBe("RIFF");
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < 512; i += 31) expect(dv.getInt16(i * 2, true)).toBe(frame[i]);
  });

  it("wav packets carry a header (opt-in, for when Wispr wants per-packet WAV)", () => {
    const bytes = b64decode(encodePacket(frame, "wav"));
    expect(bytes.byteLength).toBe(44 + 1024);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
  });
});

describe("zeroFill / concat", () => {
  it("overwrites every byte of every view, including sub-views", () => {
    const a = new Int16Array([1, 2, 3, 4]);
    const sub = a.subarray(1, 3);
    zeroFill(sub, null, undefined);
    expect(Array.from(a)).toEqual([1, 0, 0, 4]);
    zeroFill(a, new Float32Array([1, 2]));
    expect(Array.from(a)).toEqual([0, 0, 0, 0]);
  });

  it("concatenates int16 chunks in order", () => {
    const out = concatInt16([new Int16Array([1, 2]), new Int16Array([]), new Int16Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
