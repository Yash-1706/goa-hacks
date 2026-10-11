import { encodeWav16k, toMono16k } from "./wav";

/* ============================================================================
 * Tap → talk → tap on the phone: getUserMedia + MediaRecorder for the clip, a screen wake lock while recording
 * (foreground only: a phone suspends web audio in the background, so we never promise background recording), then
 * decode → 16 kHz mono → WAV in memory. The compressed chunks and every intermediate buffer are dropped or zeroed.
 * ========================================================================== */

type WakeLockLike = { release: () => Promise<void> };

/** Decode any audio the browser can play (a recording, a shared voice note) into a 16 kHz mono WAV. */
export async function audioToWav(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(encoded);
    const mono = await toMono16k(decoded);
    const wav = encodeWav16k(mono);
    mono.fill(0);
    for (let c = 0; c < decoded.numberOfChannels; c++) decoded.getChannelData(c).fill(0);
    return wav;
  } finally {
    void ctx.close();
  }
}

export class ClipRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private wake: WakeLockLike | null = null;
  startedAt = 0;

  get recording(): boolean {
    return this.rec?.state === "recording";
  }

  async start(): Promise<void> {
    if (this.recording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(500);
    this.startedAt = Date.now();
    try {
      this.wake = (await (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockLike> } }).wakeLock?.request("screen")) ?? null;
    } catch {
      this.wake = null; // no wake lock (battery saver, unsupported): the UI still asks to keep the screen on
    }
  }

  /** Stop and return the clip as a 16 kHz mono WAV. */
  async stop(): Promise<{ wav: Uint8Array<ArrayBuffer>; durationMs: number }> {
    const rec = this.rec;
    if (!rec) throw new Error("not recording");
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    if (rec.state !== "inactive") rec.stop();
    await stopped;
    const durationMs = Date.now() - this.startedAt;
    const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
    this.release();
    const wav = await audioToWav(blob);
    return { wav, durationMs };
  }

  cancel(): void {
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    this.release();
  }

  private release(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    void this.wake?.release().catch(() => undefined);
    this.wake = null;
  }
}
