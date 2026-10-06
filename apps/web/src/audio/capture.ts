/* ============================================================================
 * Capture core: everything between "a 16 kHz frame arrived" and "a fragment.final is ready", with no browser APIs.
 *
 *   frame  -> RMS + orb level + noise-floor calibration + ring buffer (pre-roll) + packetization into the open utterance
 *   VAD    -> speech start: claim the Wispr standby, flush the pre-roll, stream
 *             speech end:   commit (keep PCM until the final), compute whisper / pauseBefore / durations
 *             misfire:      abort the utterance WITHOUT commit
 *   final  -> LOCAL KILL SWITCH first (matchPauseIntent), otherwise build the FragmentFinal
 *
 * Time semantics (documented because the server's stitcher and the latency report depend on them):
 *   speechStart = start of the first voiced frame (VAD onset),
 *   speechEnd   = END OF THE LAST VOICED FRAME, i.e. when the user actually stopped talking. The VAD event itself fires
 *                 ~redemptionMs later; that wait is part of the user-visible latency and is therefore counted in
 *                 "speech-end -> artifact" and in the pause-to-mic-off latency (PRV-1 measures from the end of the phrase).
 *   pauseBeforeMs = speechStart - previous speechEnd = the real silence between the two utterances.
 *
 * The VAD driver (real MicVAD, or a test double) calls the on* methods; the engine owns lifecycle / state.
 * ========================================================================== */
import { matchPauseIntent, type Activity, type FragmentFinal } from "@synapse/shared";
import type { Clock } from "./clock";
import { buildFragmentFinal, isValidFragment, makeFragmentId } from "./fragment";
import { EnergyGate, LevelMeter, NoiseFloor, WHISPER_RMS_ABS, isWhisper } from "./levels";
import { FRAME_MS, FRAME_SAMPLES, floatToInt16, rmsFloat, zeroFill } from "./pcm";
import type { StatsCollector } from "./stats";
import type { AudioDiagnostic } from "./types";
import type { StreamerLike, UtteranceHandle, WisprTranscript } from "./wispr";

/** frames kept before the VAD fired so the first syllable is not clipped (16 x 32 ms = 512 ms) */
export const PREROLL_FRAMES = 16;

interface RingSlot {
  pcm: Int16Array;
  rms: number;
}

/** fixed-size ring of the most recent int16 frames. Slots are reused; snapshots are copies. */
export class FrameRing {
  private slots: RingSlot[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number = PREROLL_FRAMES) {
    this.slots = Array.from({ length: capacity }, () => ({ pcm: new Int16Array(FRAME_SAMPLES), rms: 0 }));
  }

  get size(): number {
    return this.count;
  }

  /** convert + store one frame; returns the slot's int16 view (valid until the slot is reused) */
  push(frame: Float32Array, rms: number): Int16Array {
    const slot = this.slots[this.head] as RingSlot;
    if (slot.pcm.length !== frame.length) slot.pcm = new Int16Array(frame.length);
    floatToInt16(frame, slot.pcm);
    slot.rms = rms;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return slot.pcm;
  }

  /** oldest -> newest, as COPIES the caller owns */
  snapshot(): RingSlot[] {
    const out: RingSlot[] = [];
    for (let i = 0; i < this.count; i++) {
      const s = this.slots[(this.head - this.count + i + this.capacity * 2) % this.capacity] as RingSlot;
      out.push({ pcm: s.pcm.slice(), rms: s.rms });
    }
    return out;
  }

  /** zero-fill and forget everything */
  clear(): void {
    for (const s of this.slots) {
      zeroFill(s.pcm);
      s.rms = 0;
    }
    this.head = 0;
    this.count = 0;
  }

  /** true when nothing is buffered and every slot is all zeros (privacy assertion for tests) */
  isBlank(): boolean {
    if (this.count !== 0) return false;
    return this.slots.every((s) => s.rms === 0 && s.pcm.every((v) => v === 0));
  }
}

export interface CaptureCallbacks {
  /** VAD boundaries (`at` = epoch ms of the onset / of the end of the last voiced frame) */
  onSpeaking(speaking: boolean, at: number): void;
  /** a transcribed utterance, schema-valid, never a pause phrase */
  onFragment(f: FragmentFinal): void;
  onFailed(fragmentId: string, reason: string): void;
  /** the kill switch fired: a pause phrase was found in a Wispr final. `speechEnd` = end of that phrase. */
  onPauseIntent(info: { speechEnd: number }): void;
  /** normalised orb level 0..1, ~15x per second */
  onLevel(level: number): void;
  onCalibrated(noiseFloor: number): void;
  emit(d: AudioDiagnostic): void;
}

export interface CaptureConfig {
  deviceId: string;
  sessionId: string;
  clock: Clock;
  stats: StatsCollector;
  getMode(): "normal" | "eco";
  getActivity(): Activity;
  callbacks: CaptureCallbacks;
  /** null = no transcription (typed-input fallback): the core only reports speech boundaries and levels */
  streamer?: StreamerLike | null;
  noiseFloor?: NoiseFloor;
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  ecoThresholdBoost?: number;
  whisperRmsAbs?: number;
  /** an utterance longer than this is committed and a new one started (stuck VAD / constant noise). Default 90 s. */
  maxUtteranceMs?: number;
  /** retune the live VAD when eco mode switches */
  setVadThresholds?(positive: number, negative: number): void;
}

interface FrameMeta {
  rms: number;
  /** epoch ms when the frame reached us = end of the frame */
  arrival: number;
}

interface UttMeta {
  speechEnd: number;
  durationMs: number;
  pauseBeforeMs: number;
  rmsMean: number;
  rmsMax: number;
  whisper: boolean;
  activity: Activity;
}

interface Utt {
  id: string;
  speechStart: number;
  lastVoicedEnd: number;
  voicedFrames: number;
  rmsSum: number;
  rmsMax: number;
  handle: UtteranceHandle | null;
  meta: UttMeta | null;
}

export class CaptureCore {
  readonly noise: NoiseFloor;

  private readonly clock: Clock;
  private readonly cb: CaptureCallbacks;
  private readonly ring = new FrameRing();
  private readonly meter = new LevelMeter();
  private readonly gate = new EnergyGate();
  private readonly inflight = new Map<Float32Array, FrameMeta>();
  private streamer: StreamerLike | null;

  private readonly basePositive: number;
  private readonly negative: number;
  private readonly ecoBoost: number;
  private readonly whisperAbs: number;
  private readonly maxUtteranceMs: number;

  private positive: number;
  private eco = false;
  private disposed = false;
  private utt: Utt | null = null;
  private lastProbsMeta: FrameMeta | null = null;
  private prevSpeechEnd = 0;
  private seq = 0;

  constructor(private readonly cfg: CaptureConfig) {
    this.clock = cfg.clock;
    this.cb = cfg.callbacks;
    this.streamer = cfg.streamer ?? null;
    this.noise = cfg.noiseFloor ?? new NoiseFloor();
    this.basePositive = cfg.positiveSpeechThreshold ?? 0.35;
    this.negative = cfg.negativeSpeechThreshold ?? 0.2;
    this.ecoBoost = cfg.ecoThresholdBoost ?? 0.1;
    this.whisperAbs = cfg.whisperRmsAbs ?? WHISPER_RMS_ABS;
    this.maxUtteranceMs = cfg.maxUtteranceMs ?? 90_000;
    this.positive = this.basePositive;
    this.refreshMode(true);
  }

  /** attach / detach the Wispr streamer later (e.g. the token arrived after the VAD started) */
  setStreamer(s: StreamerLike | null): void {
    this.streamer = s;
  }

  get speaking(): boolean {
    return this.utt !== null;
  }

  /** frames currently held in the pre-roll ring (test / debug hook) */
  get bufferedFrames(): number {
    return this.ring.size;
  }

  /** true when the pre-roll ring holds no audio at all, not even zeros-after-clear leftovers (test / debug hook) */
  get buffersBlank(): boolean {
    return this.ring.isBlank();
  }

  /** epoch ms of the end of the last completed utterance (0 = none yet) */
  get lastSpeechEnd(): number {
    return this.prevSpeechEnd;
  }

  get ecoActive(): boolean {
    return this.eco;
  }

  /** speech threshold currently applied to the VAD */
  get positiveThreshold(): number {
    return this.positive;
  }

  recalibrate(): void {
    this.noise.reset();
  }

  /* ------------------------------------------------------------------ frames */

  /**
   * Every 16 kHz frame, BEFORE the VAD model runs. Returns whether the VAD should run on it
   * (false only for the eco-mode energy pre-gate).
   */
  onFrame(frame: Float32Array): boolean {
    if (this.disposed) return false;
    const t0 = this.clock.perf();
    const now = this.clock.now();
    const rms = rmsFloat(frame);

    const level = this.meter.push(rms, this.noise.value, now);
    if (level !== null) this.cb.onLevel(level);

    if (this.streamer) {
      const pcm = this.ring.push(frame, rms);
      this.utt?.handle?.push(pcm.slice(), rms); // the session owns its copy
    }

    if (this.utt && now - this.utt.speechStart > this.maxUtteranceMs) this.splitUtterance(now);

    let run = true;
    if (this.eco && this.noise.calibrated) {
      if (this.utt) this.gate.reset();
      else run = this.gate.shouldRun(rms, this.noise.value, now);
    }
    this.cfg.stats.addFrame(!run);
    if (run) {
      this.inflight.set(frame, { rms, arrival: now });
      if (this.inflight.size > 64) {
        const oldest = this.inflight.keys().next().value;
        if (oldest) this.inflight.delete(oldest);
      }
    }
    this.cfg.stats.addCpu(this.clock.perf() - t0);
    return run;
  }

  /** the VAD model's speech probability for a frame that onFrame() let through */
  onProbs(frame: Float32Array, isSpeech: number): void {
    if (this.disposed) return;
    const meta = this.inflight.get(frame);
    if (!meta) return;
    this.inflight.delete(frame);
    const voiced = isSpeech >= this.positive;
    if (this.noise.observe(meta.rms, voiced)) this.cb.onCalibrated(this.noise.value);
    this.lastProbsMeta = meta;
    const u = this.utt;
    if (u && voiced) {
      u.lastVoicedEnd = meta.arrival;
      u.voicedFrames++;
      u.rmsSum += meta.rms;
      if (meta.rms > u.rmsMax) u.rmsMax = meta.rms;
    }
  }

  /** wall time the VAD callback took (inference + its event handlers) */
  onVadTime(ms: number): void {
    this.cfg.stats.addCpu(ms);
  }

  /* ------------------------------------------------------------------ VAD events */

  onSpeechStart(): void {
    if (this.disposed) return;
    if (this.utt) this.finishUtterance(this.utt.lastVoicedEnd, true); // defensive: never leave one open
    const meta = this.lastProbsMeta;
    const startAt = (meta?.arrival ?? this.clock.now()) - FRAME_MS;
    this.beginUtterance(startAt, meta, true, true);
  }

  /** speech confirmed (>= minSpeechMs). Nothing to do: the utterance is already streaming since onSpeechStart. */
  onSpeechRealStart(): void {
    /* intentionally empty */
  }

  onSpeechEnd(): void {
    if (this.disposed || !this.utt) return;
    this.finishUtterance(this.utt.lastVoicedEnd, true);
  }

  onMisfire(): void {
    if (this.disposed) return;
    const u = this.utt;
    if (!u) return;
    this.utt = null;
    u.handle?.abort("vad misfire"); // closes the socket WITHOUT commit, zero-fills
    this.cb.onSpeaking(false, this.clock.now());
    this.refreshMode();
  }

  /* ------------------------------------------------------------------ mode */

  /** re-read eco/normal; retunes the VAD thresholds (deferred while an utterance is open) */
  refreshMode(force = false): void {
    if (this.utt && !force) return;
    const eco = this.cfg.getMode() === "eco";
    if (!force && eco === this.eco) return;
    const changed = eco !== this.eco;
    this.eco = eco;
    this.positive = Math.min(0.95, this.basePositive + (eco ? this.ecoBoost : 0));
    this.gate.reset();
    if (changed || force) this.cfg.setVadThresholds?.(this.positive, Math.min(this.negative, this.positive));
    if (changed) this.cb.emit({ kind: "mode", mode: eco ? "eco" : "normal" });
  }

  /* ------------------------------------------------------------------ teardown */

  /** privacy teardown: abort every utterance without commit, zero-fill, ignore all further events */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const u = this.utt;
    this.utt = null;
    u?.handle?.abort("disposed");
    this.ring.clear();
    this.inflight.clear();
    this.lastProbsMeta = null;
    this.gate.reset();
    this.meter.reset();
  }

  /* ------------------------------------------------------------------ internals */

  private beginUtterance(startAt: number, first: FrameMeta | null, withPreroll: boolean, emitSpeaking: boolean): void {
    this.refreshMode();
    const now = this.clock.now();
    const u: Utt = {
      id: makeFragmentId(this.cfg.deviceId, now, this.seq++),
      speechStart: startAt,
      lastVoicedEnd: first ? first.arrival : startAt + FRAME_MS,
      voicedFrames: first ? 1 : 0,
      rmsSum: first ? first.rms : 0,
      rmsMax: first ? first.rms : 0,
      handle: null,
      meta: null,
    };
    this.utt = u;
    this.gate.reset();
    if (emitSpeaking) this.cb.onSpeaking(true, startAt);
    const streamer = this.streamer;
    if (streamer) {
      const handle = streamer.claim({
        fragmentId: u.id,
        packetsPerAppend: this.eco ? 8 : 4,
        onTranscript: (t) => this.onTranscript(u, t),
        onFailed: (reason) => {
          if (!this.disposed) this.cb.onFailed(u.id, reason);
        },
      });
      u.handle = handle;
      if (withPreroll) handle.pushPreroll(this.ring.snapshot());
    }
  }

  /** close the open utterance: stats, whisper flag, commit */
  private finishUtterance(speechEnd: number, emitSpeaking: boolean): void {
    const u = this.utt;
    if (!u) return;
    this.utt = null;
    const durationMs = Math.max(FRAME_MS, speechEnd - u.speechStart);
    const rmsMean = u.voicedFrames > 0 ? u.rmsSum / u.voicedFrames : 0;
    u.meta = {
      speechEnd,
      durationMs,
      pauseBeforeMs: this.prevSpeechEnd > 0 ? Math.max(0, u.speechStart - this.prevSpeechEnd) : 0,
      rmsMean,
      rmsMax: u.rmsMax,
      whisper: isWhisper(rmsMean, this.noise.value, this.whisperAbs),
      activity: this.cfg.getActivity(),
    };
    this.prevSpeechEnd = speechEnd;
    if (emitSpeaking) this.cb.onSpeaking(false, speechEnd);
    u.handle?.commit();
    this.refreshMode();
  }

  /** hard cap reached (stuck VAD, constant noise): commit what we have and carry on with a fresh utterance */
  private splitUtterance(now: number): void {
    const u = this.utt;
    if (!u) return;
    this.cb.emit({ kind: "anomaly", detail: "utterance hit the maximum length and was split" });
    this.finishUtterance(now, false);
    this.beginUtterance(now, null, false, false);
  }

  private onTranscript(u: Utt, t: WisprTranscript): void {
    if (this.disposed) return;
    const text = t.text.trim();
    const meta = u.meta;
    if (!meta) return; // cannot happen: transcripts only follow a commit
    if (!text) {
      // Wispr heard nothing: no fragment, not a failure. But if WE heard clear speech, say so: it is the symptom of a
      // wrong audio format on the wire (see README, unverified assumption 3).
      if (meta.durationMs >= 600 && meta.rmsMean >= Math.max(this.noise.value * 2, 0.01)) {
        this.cb.emit({ kind: "anomaly", detail: `empty transcript for ${Math.round(meta.durationMs)} ms of voiced speech` });
      }
      return;
    }
    // LOCAL KILL SWITCH: the phrase itself is never delivered as a fragment
    if (matchPauseIntent(text).match) {
      this.cb.onPauseIntent({ speechEnd: meta.speechEnd });
      return;
    }
    const f = buildFragmentFinal({
      fragmentId: u.id,
      sessionId: this.cfg.sessionId,
      text,
      detectedLanguage: t.detectedLanguage,
      speechStart: u.speechStart,
      speechEnd: meta.speechEnd,
      commitSent: t.tCommitSent,
      wisprFinal: t.tFinal,
      pauseBeforeMs: meta.pauseBeforeMs,
      rmsMean: meta.rmsMean,
      rmsMax: meta.rmsMax,
      whisper: meta.whisper,
      activity: meta.activity,
      transport: t.transport,
    });
    if (!isValidFragment(f)) {
      this.cb.onFailed(u.id, "fragment failed validation");
      return;
    }
    this.cb.onFragment(f);
  }
}
