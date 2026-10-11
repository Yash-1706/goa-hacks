import { STT_SAMPLE_RATE } from "../wispr/local-stt";

/* ============================================================================
 * WAV → 16 kHz mono Float32 for POST /api/capture. Accepts what browsers, `afconvert` and voice-recorder apps write:
 * PCM 8/16/24/32-bit, IEEE float 32, and WAVE_FORMAT_EXTENSIBLE wrapping either; any channel count (downmixed) and any
 * sample rate (linearly resampled). Everything happens in memory; the caller zero-fills the result when done.
 * ========================================================================== */

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

export function parseWav(bytes: Uint8Array, o: { maxSeconds?: number } = {}): Float32Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
  if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") throw new WavError("not a WAV file");

  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { at: number; len: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(at);
    const len = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && len >= 16) {
      let format = v.getUint16(body, true);
      if (format === EXTENSIBLE && len >= 26) format = v.getUint16(body + 24, true); // the subformat GUID starts with the real code
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      data = { at: body, len: Math.min(len, bytes.length - body) }; // a streamed WAV may carry a placeholder length
      break;
    }
    at = body + len + (len % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new WavError("WAV has no fmt or data chunk");
  const { format, channels, rate, bits } = fmt;
  const supported = (format === PCM && [8, 16, 24, 32].includes(bits)) || (format === FLOAT && bits === 32);
  if (!supported || channels < 1 || rate < 1000) throw new WavError(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);

  const bps = bits / 8;
  const frames = Math.floor(data.len / (bps * channels));
  if (o.maxSeconds !== undefined && frames / rate > o.maxSeconds) throw new WavError(`audio too long (${Math.round(frames / rate)} s, limit ${o.maxSeconds} s)`);

  const sample = (at: number): number => {
    if (format === FLOAT) return v.getFloat32(at, true);
    if (bits === 16) return v.getInt16(at, true) / 32768;
    if (bits === 8) return (v.getUint8(at) - 128) / 128;
    if (bits === 24) {
      const n = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16);
      return n / 8388608;
    }
    return v.getInt32(at, true) / 2147483648;
  };
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += sample(data.at + (f * channels + c) * bps);
    mono[f] = sum / channels;
  }
  if (rate === STT_SAMPLE_RATE) return mono;
  const out = resample(mono, rate, STT_SAMPLE_RATE);
  mono.fill(0);
  return out;
}

/** Linear resampling: plenty for speech recognition, which band-limits to 8 kHz anyway. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((input.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const a = input[i0] ?? 0;
    const b = input[Math.min(i0 + 1, input.length - 1)] ?? a;
    out[i] = a + (b - a) * (x - i0);
  }
  return out;
}
