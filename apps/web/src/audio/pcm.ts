/* ============================================================================
 * PCM helpers: float32 -> int16 LE, RMS, base64, WAV wrapping, zero-fill.
 *
 * Audio only ever lives in these in-memory typed arrays. Nothing here touches
 * Blob / URL.createObjectURL / IndexedDB / storage, and nothing may be added that does.
 * ========================================================================== */

/** Silero v5 + Wispr both run at 16 kHz mono. */
export const SAMPLE_RATE = 16_000;
/** one VAD frame = one Wispr packet */
export const FRAME_SAMPLES = 512;
/** 32 ms */
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
/** `packet_duration` sent to Wispr (seconds). Must stay constant for the whole session. */
export const PACKET_DURATION_S = FRAME_SAMPLES / SAMPLE_RATE;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;

/**
 * float32 [-1, 1] -> int16, clamped. `s < 0 ? s * 0x8000 : s * 0x7FFF` (truncating, like DataView.setInt16).
 * NaN becomes 0. When `out` is given it must be at least as long as `input`.
 */
export function floatToInt16(input: ArrayLike<number>, out?: Int16Array): Int16Array {
  const n = input.length;
  const dst = out ?? new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = input[i] as number;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    dst[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return dst;
}

/** root-mean-square of a float32 frame in [-1, 1], returned in 0..1 */
export function rmsFloat(frame: ArrayLike<number>): number {
  const n = frame.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = frame[i] as number;
    sum += v * v;
  }
  const r = Math.sqrt(sum / n);
  return r > 1 ? 1 : r;
}

/** root-mean-square of an int16 buffer, normalised to 0..1 */
export function rmsInt16(pcm: Int16Array): number {
  const n = pcm.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (pcm[i] as number) / 32768;
    sum += v * v;
  }
  const r = Math.sqrt(sum / n);
  return r > 1 ? 1 : r;
}

/** int16 samples as little-endian bytes (a zero-copy view on little-endian machines, which is all of them in practice) */
export function int16ToBytesLE(pcm: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] as number, true);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Table-driven base64 (no btoa, no spread of big arrays into String.fromCharCode). Exported for tests. */
export function bytesToBase64Fallback(bytes: Uint8Array): string {
  const len = bytes.length;
  const parts: string[] = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    chunk += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rem = len - i;
  if (rem === 1) {
    const n = (bytes[i] as number) << 16;
    chunk += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    chunk += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

type WithToBase64 = Uint8Array & { toBase64?: () => string };

/** Standard base64 (with padding). Uses the native Uint8Array.prototype.toBase64 when present. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as WithToBase64).toBase64;
  if (typeof native === "function") return native.call(bytes);
  return bytesToBase64Fallback(bytes);
}

/**
 * Wrap raw little-endian 16-bit mono PCM in a canonical 44-byte RIFF/WAVE header.
 * Accepts samples (Int16Array) or already-LE bytes (Uint8Array).
 */
export function wrapWav(pcm16: Int16Array | Uint8Array, sampleRate: number = SAMPLE_RATE): Uint8Array {
  const data = pcm16 instanceof Int16Array ? int16ToBytesLE(pcm16) : pcm16;
  const dataLen = data.byteLength;
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  tag(36, "data");
  v.setUint32(40, dataLen, true);
  out.set(data, 44);
  return out;
}

/** concatenate int16 chunks into one buffer */
export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** overwrite buffers with zeros (audio hygiene: call before dropping references) */
export function zeroFill(...bufs: Array<ArrayBufferView | null | undefined>): void {
  for (const b of bufs) {
    if (!b) continue;
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength).fill(0);
  }
}

/** Wispr packet encoding: ONE frame -> base64 of raw int16 LE (default) or of a per-packet WAV */
export function encodePacket(pcm: Int16Array, format: "pcm16" | "wav" = "pcm16"): string {
  if (format === "wav") return bytesToBase64(wrapWav(pcm));
  return bytesToBase64(int16ToBytesLE(pcm));
}
