import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { log } from "../log";
import { safeEqual } from "../memory/crypto";

/* ============================================================================
 * On-device speech to text (PRD CAP-8, TRD §5.5a "local_stt"): Whisper through transformers.js (ONNX, CPU) on the machine that
 * runs this server. It is used when WISPR_MODE=local, when local-only mode is on while a Wispr setup is configured, and (opt-in,
 * STT_FALLBACK) when Wispr cannot be reached. Nothing leaves the machine.
 *
 * Privacy: audio exists here only as a Float32Array for the length of one utterance and the caller zeroes it. Nothing is written
 * to disk, nothing is logged except lengths and timings, and the transcript goes back to the one socket that sent the audio.
 * ========================================================================== */

export const STT_SAMPLE_RATE = 16_000;

/** the model behind the engine: 16 kHz mono samples in [-1, 1] → text */
export interface SttBackend {
  transcribe(pcm: Float32Array, o: { language?: string }): Promise<string>;
}

export interface LocalSttOpts {
  model: string;
  dtype: string;
  cacheDir: string;
  /** ISO 639-1 codes (WISPR_LANGUAGES); a multilingual model is told the language when exactly one is configured */
  languages: string[];
  /** replace the model (tests) */
  loader?: () => Promise<SttBackend>;
  /** the longest one transcription may take (ms) */
  timeoutMs?: number;
}

export type SttState = "idle" | "loading" | "ready" | "error";

export interface SttStats {
  model: string;
  state: SttState;
  /** model load time (a download the first time), ms */
  loadMs: number | null;
  /** utterances transcribed */
  calls: number;
  /** the last transcription: audio length and the time it took, ms */
  lastAudioMs: number | null;
  lastMs: number | null;
  error?: string;
}

export interface SttResult {
  text: string;
  /** time spent transcribing (0 when the clip was skipped), ms */
  ms: number;
  audioMs: number;
  language: string;
}

/** shorter than this is a click or a breath, never speech */
const MIN_AUDIO_MS = 250;
/** essentially digital silence: not worth an inference, and Whisper invents words for it */
const SILENCE_RMS = 0.0015;
/** what Whisper tends to "hear" in a short, very quiet clip */
const PHANTOM = /^(?:thank you(?: so much)?|thanks(?: for watching)?|thank you for watching|you|bye(?: bye)?|\.+)[.!\s]*$/i;

export function rmsOf(pcm: Float32Array): number {
  if (!pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += (pcm[i] as number) * (pcm[i] as number);
  return Math.sqrt(s / pcm.length);
}

/** Whisper's bracketed non-speech tags and runs of spaces, removed. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE|APPLAUSE)[^\]]*\]/gi, " ")
    .replace(/\((?:silence|music|noise|inaudible|applause)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

/** The real model: Whisper via transformers.js. The first inference compiles the graph, so it is spent here, on a second of silence. */
async function loadWhisper(o: LocalSttOpts): Promise<SttBackend> {
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = path.join(o.cacheDir, "models");
  tf.env.allowLocalModels = true;
  const asr = (await tf.pipeline("automatic-speech-recognition", o.model, { dtype: o.dtype as "q8" })) as unknown as AsrPipeline;
  await asr(new Float32Array(STT_SAMPLE_RATE), { chunk_length_s: 30 }).catch(() => undefined);
  return {
    async transcribe(pcm, { language }) {
      const out = await asr(pcm, { chunk_length_s: 30, return_timestamps: false, ...(language ? { language, task: "transcribe" } : {}) });
      return Array.isArray(out) ? out.map((x) => x.text).join(" ") : out.text;
    },
  };
}

export class LocalStt {
  private backend: Promise<SttBackend> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private _state: SttState = "idle";
  private loadMs: number | null = null;
  private calls = 0;
  private lastAudioMs: number | null = null;
  private lastMs: number | null = null;
  private error: string | undefined;

  constructor(private o: LocalSttOpts) {}

  get state(): SttState {
    return this._state;
  }

  get model(): string {
    return this.o.model;
  }

  stats(): SttStats {
    return { model: this.o.model, state: this._state, loadMs: this.loadMs, calls: this.calls, lastAudioMs: this.lastAudioMs, lastMs: this.lastMs, ...(this.error ? { error: this.error } : {}) };
  }

  /** Load the model now (a download the first time). Never throws: a failure is remembered and the next call tries again. */
  async warm(): Promise<void> {
    try {
      await this.load();
    } catch {
      /* recorded in stats() and logged */
    }
  }

  private load(): Promise<SttBackend> {
    if (this.backend) return this.backend;
    this._state = "loading";
    const t0 = performance.now();
    const p = (this.o.loader ?? (() => loadWhisper(this.o)))().then(
      (b) => {
        this._state = "ready";
        this.error = undefined;
        this.loadMs = Math.round(performance.now() - t0);
        log.info("stt", "on-device speech model ready", { model: this.o.model, ms: this.loadMs });
        return b;
      },
      (err: unknown) => {
        this._state = "error";
        this.error = (err instanceof Error ? err.message : "load failed").slice(0, 160);
        this.backend = null;
        log.warn("stt", "on-device speech model could not be loaded (is it downloaded? the first load needs the network)", { model: this.o.model, error: this.error });
        throw err;
      },
    );
    this.backend = p;
    return p;
  }

  /** a multilingual model is told the language only when exactly one is configured (an English-only model never is) */
  private language(): string | undefined {
    if (/\.en$/i.test(this.o.model) || this.o.languages.length !== 1) return undefined;
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(this.o.languages[0] as string)?.toLowerCase();
    } catch {
      return undefined;
    }
  }

  /** The language reported with a transcript. */
  get reportedLanguage(): string {
    return this.o.languages.length === 1 ? (this.o.languages[0] as string) : /\.en$/i.test(this.o.model) ? "en" : (this.o.languages[0] ?? "en");
  }

  /**
   * One utterance, one inference at a time (it is CPU-bound: two at once only make both slower). The caller owns `pcm` and
   * zeroes it afterwards. An empty `text` means nothing intelligible was said.
   */
  transcribe(pcm: Float32Array): Promise<SttResult> {
    const job = this.queue.then(() => this.runOne(pcm));
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async runOne(pcm: Float32Array): Promise<SttResult> {
    const audioMs = Math.round((pcm.length / STT_SAMPLE_RATE) * 1000);
    const language = this.reportedLanguage;
    const rms = rmsOf(pcm);
    if (audioMs < MIN_AUDIO_MS || rms < SILENCE_RMS) return { text: "", ms: 0, audioMs, language };

    const backend = await this.load();
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = this.o.timeoutMs ?? 30_000;
    const raw = await Promise.race([
      backend.transcribe(pcm, { language: this.language() }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("transcription timed out")), limit))),
    ]).finally(() => clearTimeout(timer));
    const ms = Math.round(performance.now() - t0);

    let text = cleanTranscript(raw);
    // a short, nearly silent clip becomes "Thank you." in Whisper's mouth: that is the model talking, not the user
    if (audioMs < 1500 && rms < 0.004 && PHANTOM.test(text)) text = "";
    this.calls++;
    this.lastAudioMs = audioMs;
    this.lastMs = ms;
    log.debug("stt", "utterance transcribed", { audioMs, ms, chars: text.length });
    return { text, ms, audioMs, language };
  }
}

/* ----------------------------------------------------------------- tokens */

/**
 * Short-lived tokens for the on-device endpoints, signed with a per-process secret (they die with the process; a client that
 * is refused simply asks the server for a new one). A token is only handed out over the authenticated main socket, so holding
 * one proves the device is paired.
 */
export class LocalSttAuth {
  private secret = randomBytes(32);

  mint(deviceId: string, ttlMs: number, now: number): { token: string; expiresAt: number } {
    const expiresAt = now + ttlMs;
    const payload = Buffer.from(JSON.stringify({ d: deviceId, e: expiresAt })).toString("base64url");
    return { token: `lt1.${payload}.${this.sign(payload)}`, expiresAt };
  }

  /** the device a valid, unexpired token was minted for, or null */
  verify(token: string | undefined, now: number): { deviceId: string } | null {
    const parts = (token ?? "").replace(/^Bearer\s+/i, "").split(".");
    if (parts.length !== 3 || parts[0] !== "lt1") return null;
    const [, payload, sig] = parts as [string, string, string];
    if (!safeEqual(this.sign(payload), sig)) return null;
    try {
      const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { d?: unknown; e?: unknown };
      if (typeof j.d !== "string" || typeof j.e !== "number" || j.e <= now) return null;
      return { deviceId: j.d };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}
