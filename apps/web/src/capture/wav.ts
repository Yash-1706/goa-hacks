/* ============================================================================
 * Recorded clip → 16 kHz mono 16-bit WAV for POST /api/capture. The phone records compressed audio at its native rate;
 * after `decodeAudioData`, OfflineAudioContext resamples (band-limited) when the browser has it, and a linear resampler
 * is the fallback. All in memory: the caller zero-fills what it no longer needs.
 * ========================================================================== */

export const TARGET_RATE = 16_000;

export interface DecodedAudio {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
}

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;

export function encodeWav16k(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, TARGET_RATE, true);
  v.setUint32(28, TARGET_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i] as number)) * 32767), true);
  return out;
}

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0] as Float32Array;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (c[i] as number) / channels.length;
  return out;
}

export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
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

/** Decoded audio → 16 kHz mono. `offline: null` forces the linear fallback (tests, browsers without OfflineAudioContext). */
export async function toMono16k(buf: DecodedAudio, o: { offline?: OfflineCtor | null } = {}): Promise<Float32Array> {
  const Offline = o.offline === undefined ? (globalThis as { OfflineAudioContext?: OfflineCtor }).OfflineAudioContext : o.offline;
  if (Offline && buf.sampleRate !== TARGET_RATE) {
    const frames = Math.max(1, Math.ceil(buf.duration * TARGET_RATE));
    const ctx = new Offline(1, frames, TARGET_RATE);
    const src = ctx.createBufferSource();
    src.buffer = buf as AudioBuffer;
    src.connect(ctx.destination); // a mono destination downmixes the channels
    src.start();
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
  }
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return resampleLinear(mixToMono(channels), buf.sampleRate, TARGET_RATE);
}
