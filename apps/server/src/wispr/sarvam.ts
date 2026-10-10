import { log } from "../log";
import { STT_SAMPLE_RATE, type SttBackend, type SttTranscript } from "./local-stt";

/* ============================================================================
 * Sarvam AI speech to text (https://docs.sarvam.ai, POST /speech-to-text): a CLOUD speech engine behind the same
 * Wispr-compatible endpoints as the on-device one (local-ws.ts), so the browser's streamer is used unchanged. Good for Indian
 * accents, Hindi and code-mixed Hinglish, which a tiny on-device model is not.
 *
 * Privacy: this is the one path on which an utterance leaves the machine for a cloud service other than Wispr. It is opt-in
 * (WISPR_MODE=sarvam or STT_PROVIDER=sarvam), local-only mode always switches to the on-device engine instead, every call is
 * recorded in the audit ledger (`sent_to_stt`: provider, model and the length of the audio, never its content), the audio is
 * held in memory only and the API key never leaves this process (a header, never logged, never in an error message).
 * Hint terms (the self-healing dictionary: names and jargon, at most 50) travel as `keyterms`, like Wispr's dictionary_context.
 * ========================================================================== */

export interface SarvamOpts {
  apiKey: string;
  /** https://api.sarvam.ai */
  baseUrl: string;
  /** saaras:v4 (current) or saaras:v3 */
  model: string;
  /** "unknown" detects the language; otherwise a BCP-47 code such as en-IN or hi-IN */
  languageCode: string;
  /** recognition hints (only the v4 model takes them): names, components, jargon */
  keyterms?: () => string[];
  /** an utterance is about to leave for Sarvam (the privacy ledger records it) */
  onSend?: (info: { model: string; audioMs: number }) => void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** the REST endpoint is meant for audio under 30 s: longer utterances go in pieces */
const CHUNK_SECS = 28;
const CHUNK_SAMPLES = CHUNK_SECS * STT_SAMPLE_RATE;
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 64;

export class SarvamError extends Error {
  constructor(
    readonly status: number,
    /** Sarvam's own error code (invalid_api_key_error, insufficient_quota_error, ...), never a message that could echo content */
    readonly code?: string,
  ) {
    super(`Sarvam HTTP ${status}${code ? ` ${code}` : ""}`);
    this.name = "SarvamError";
  }
}

/** 16 kHz mono 16-bit PCM in a 44-byte-header WAV: the format the API handles best */
export function wav16k(pcm: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, STT_SAMPLE_RATE, true);
  v.setUint32(28, STT_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i] as number)) * 32767), true);
  return out;
}

/** the hints the API accepts: trimmed, unique, at most 50, each at most 64 characters */
export function cleanKeyterms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t || t.length > MAX_KEYTERM_CHARS || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

export class SarvamStt implements SttBackend {
  constructor(private o: SarvamOpts) {}

  async transcribe(pcm: Float32Array): Promise<SttTranscript> {
    const parts: string[] = [];
    let language: string | undefined;
    for (let at = 0; at < pcm.length; at += CHUNK_SAMPLES) {
      const r = await this.one(pcm.subarray(at, Math.min(pcm.length, at + CHUNK_SAMPLES)));
      if (r.text) parts.push(r.text);
      language ??= r.language;
    }
    return { text: parts.join(" "), ...(language ? { language } : {}) };
  }

  private async one(piece: Float32Array): Promise<SttTranscript> {
    const { o } = this;
    const wav = wav16k(piece);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    form.append("model", o.model);
    form.append("language_code", o.languageCode);
    const terms = o.model === "saaras:v4" ? cleanKeyterms(o.keyterms?.() ?? []) : [];
    if (terms.length) form.append("keyterms", JSON.stringify(terms));
    wav.fill(0); // the encoded copy is in the form's blob now; this buffer is not needed any more

    o.onSend?.({ model: o.model, audioMs: Math.round((piece.length / STT_SAMPLE_RATE) * 1000) });
    const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl.replace(/\/$/, "")}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": o.apiKey },
      body: form,
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
    if (!res.ok) {
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: { code?: unknown } };
        if (typeof body.error?.code === "string") code = body.error.code;
      } catch {
        /* not JSON */
      }
      log.warn("stt", "Sarvam refused the request", { status: res.status, ...(code ? { code } : {}) });
      throw new SarvamError(res.status, code);
    }
    const j = (await res.json()) as { transcript?: unknown; language_code?: unknown };
    return { text: typeof j.transcript === "string" ? j.transcript : "", ...(typeof j.language_code === "string" && j.language_code ? { language: j.language_code } : {}) };
  }
}
