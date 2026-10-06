/* ============================================================================
 * Microphone engine: the real implementation of the AudioEngine contract (types.ts).
 *
 *   getUserMedia (inside the user gesture) -> AudioContext -> Silero VAD v5 (vad-driver.ts)
 *     -> CaptureCore (capture.ts): ring buffer, RMS, levels, noise floor, whisper flag, utterances, kill switch
 *     -> WisprStreamer (wispr.ts): standby socket, one session per utterance, REST fallback
 *
 * Privacy rules enforced here:
 *  - The kill switch (pause phrase in a Wispr final, or pause()) stops every MediaStreamTrack FIRST, then destroys the VAD,
 *    closes every Wispr socket WITHOUT commit and zero-fills the audio buffers. The phrase is never delivered as a fragment.
 *  - Audio exists only in memory and only until the final text arrives. No Blob / IndexedDB / storage / download.
 *  - Nothing here logs transcript text or audio.
 * ========================================================================== */
import { matchPauseIntent, type FragmentFinal } from "@synapse/shared";
import { CaptureCore } from "./capture";
import { realClock, type Clock, type TimerId } from "./clock";
import { buildFragmentFinal, makeFragmentId } from "./fragment";
import { NoiseFloor, WHISPER_RMS_ABS } from "./levels";
import { StatsCollector } from "./stats";
import type {
  AudioDiagnostic,
  AudioEngine,
  AudioEngineFactory,
  AudioEngineOptions,
  AudioState,
  AudioTuning,
  WisprTokenInfo,
} from "./types";
import { createMicVadDriver, type VadDriver, type VadDriverFactory, type VadHandlers } from "./vad-driver";
import { WisprStreamer, scrub, type StreamerLike, type WisprStreamerConfig, type WsFactory } from "./wispr";

/** detail shown when no Wispr client token is available: capture works, transcription is typed */
export const NO_KEY_DETAIL = "no Wispr key: using typed input";
export const PROXY_UNSUPPORTED_DETAIL = "proxy mode not supported in this build";

/** everything the engine touches outside itself, injectable for tests */
export interface MicEngineDeps {
  clock?: Clock;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  createVad?: VadDriverFactory;
  createSocket?: WsFactory;
  fetch?: typeof fetch;
  createStreamer?: (cfg: WisprStreamerConfig) => StreamerLike;
  /** page visibility events (to resume a suspended AudioContext); pass null to disable */
  document?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null;
  /** window "online" events (to reconnect the Wispr standby right away); pass null to disable */
  window?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  /** max wait for the server's token answer (default 8000 ms) */
  tokenTimeoutMs?: number;
}

type TokenOutcome =
  | { kind: "client"; info: WisprTokenInfo }
  | { kind: "mock" }
  | { kind: "proxy" }
  | { kind: "error"; reason: string };

const defaultGetUserMedia = (constraints: MediaStreamConstraints): Promise<MediaStream> => {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md || typeof md.getUserMedia !== "function") {
    const err = new Error("navigator.mediaDevices is unavailable (needs HTTPS or localhost)");
    err.name = "NotSupportedError";
    return Promise.reject(err);
  }
  return md.getUserMedia(constraints);
};

const defaultCreateAudioContext = (): AudioContext => {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) {
    const err = new Error("Web Audio is unavailable");
    err.name = "NotSupportedError";
    throw err;
  }
  return new Ctor({ latencyHint: "interactive" });
};

/** human-readable reason for a getUserMedia failure */
export function micErrorDetail(e: unknown): string {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "microphone permission denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no microphone found";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "microphone is busy or unavailable";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "microphone does not support the requested settings";
    case "SecurityError":
    case "NotSupportedError":
      return "microphone needs a secure page (HTTPS or localhost)";
    default:
      return `microphone error${name ? `: ${name}` : ""}`;
  }
}

const errText = (e: unknown): string => scrub(e instanceof Error ? e.message : String(e)).slice(0, 160);

function withTimeout<T>(p: Promise<T>, ms: number, clock: Clock, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clock.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clock.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

class MicEngine implements AudioEngine {
  private _state: AudioState = "off";
  private detail: string | undefined;
  /** the standing detail (typed-input notice, muted notice) re-used on hearing/listening transitions */
  private baseDetail: string | undefined;
  /** bumped by start/stop/pause/fail: invalidates every in-flight async step of an older start() */
  private gen = 0;

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private vad: VadDriver | null = null;
  private core: CaptureCore | null = null;
  private streamer: StreamerLike | null = null;
  private stats: StatsCollector | null = null;
  private tokenRetry: TimerId | null = null;
  private tokenRetryCount = 0;
  private removeListeners: Array<() => void> = [];

  private lastInjectEnd = 0;
  private injectSeq = 0;

  private readonly clock: Clock;
  private readonly tuning: AudioTuning;
  private readonly tokenTimeoutMs: number;

  constructor(
    private readonly opts: AudioEngineOptions,
    private readonly d: Required<Pick<MicEngineDeps, "getUserMedia" | "createAudioContext" | "createVad" | "createStreamer">> &
      MicEngineDeps,
  ) {
    this.clock = d.clock ?? realClock;
    this.tuning = opts.tuning ?? {};
    this.tokenTimeoutMs = d.tokenTimeoutMs ?? 8000;
  }

  /* ------------------------------------------------------------------ AudioEngine */

  get running(): boolean {
    return this._state === "listening" || this._state === "hearing";
  }

  get state(): AudioState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this._state === "starting" || this.running) return;
    const gen = ++this.gen;

    // ---- user-gesture-sensitive section: no `await` and no UI callbacks before these two calls ----
    let ctx: AudioContext | null = null;
    try {
      ctx = this.d.createAudioContext();
      void ctx.resume().catch(() => undefined);
    } catch {
      ctx = null; // the VAD driver can still create its own
    }
    let mediaP: Promise<MediaStream>;
    try {
      mediaP = this.d.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: this.tuning.autoGainControl ?? true,
        },
      });
    } catch (e) {
      mediaP = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    // -------------------------------------------------------------------------------------------

    this.baseDetail = undefined;
    this.tokenRetryCount = 0;
    this.setState("starting");

    let stream: MediaStream;
    try {
      stream = await mediaP;
    } catch (e) {
      this.closeCtx(ctx);
      if (gen === this.gen) this.fail(micErrorDetail(e));
      return;
    }
    if (gen !== this.gen) {
      // stop()/pause() won the race: give the microphone straight back
      for (const t of stream.getTracks()) t.stop();
      this.closeCtx(ctx);
      return;
    }
    this.stream = stream;
    this.audioCtx = ctx;
    this.watchStream(stream, ctx, gen);

    // ---- pipeline objects (the core must exist before the VAD delivers a single frame) ----
    const t = this.tuning;
    const noise = new NoiseFloor({ calibrationMs: t.noiseCalibrationMs ?? 2000 });
    const stats = new StatsCollector({
      clock: this.clock,
      getMode: () => this.opts.getMode(),
      onStats: (s) => {
        this.safe(() => this.opts.onStats(s));
        // piggy-back the cheap periodic maintenance on the 5 s stats tick
        this.core?.refreshMode();
        this.streamer?.checkFreshness();
      },
    });
    this.stats = stats;
    const core = new CaptureCore({
      deviceId: this.opts.deviceId,
      sessionId: this.opts.sessionId,
      clock: this.clock,
      stats,
      getMode: () => this.opts.getMode(),
      getActivity: () => this.opts.getActivity(),
      noiseFloor: noise,
      positiveSpeechThreshold: t.positiveSpeechThreshold ?? 0.35,
      negativeSpeechThreshold: t.negativeSpeechThreshold ?? 0.2,
      ecoThresholdBoost: t.ecoThresholdBoost ?? 0.1,
      whisperRmsAbs: t.whisperRmsAbs ?? WHISPER_RMS_ABS,
      maxUtteranceMs: t.maxUtteranceMs ?? 90_000,
      setVadThresholds: (pos, neg) => this.vad?.setThresholds(pos, neg),
      callbacks: {
        onSpeaking: (speaking, at) => {
          if (gen !== this.gen) return;
          this.setState(speaking ? "hearing" : "listening", this.baseDetail);
          this.safe(() => this.opts.onSpeaking(speaking, at));
        },
        onFragment: (f) => {
          if (gen === this.gen) this.safe(() => this.opts.onFragment(f));
        },
        onFailed: (id, reason) => {
          if (gen === this.gen) this.safe(() => this.opts.onFailed(id, reason));
        },
        onPauseIntent: ({ speechEnd }) => {
          if (gen === this.gen) this.killSwitch("voice", speechEnd);
        },
        onLevel: (level) => {
          if (gen === this.gen) this.safe(() => this.opts.onLevel(level));
        },
        onCalibrated: (noiseFloor) => this.diag({ kind: "calibrated", noiseFloor }),
        emit: (dg) => this.diag(dg),
      },
    });
    this.core = core;

    // ---- load the VAD model and ask for the Wispr token in parallel ----
    const tokenP = this.fetchToken();
    const handlers: VadHandlers = {
      onFrame: (f) => core.onFrame(f),
      onProbs: (f, p) => core.onProbs(f, p),
      onVadTime: (ms) => core.onVadTime(ms),
      onSpeechStart: () => core.onSpeechStart(),
      onSpeechRealStart: () => core.onSpeechRealStart(),
      onSpeechEnd: () => core.onSpeechEnd(),
      onMisfire: () => core.onMisfire(),
    };
    let driver: VadDriver;
    try {
      driver = await this.d.createVad(
        {
          stream,
          audioContext: ctx,
          positiveSpeechThreshold: core.positiveThreshold,
          negativeSpeechThreshold: t.negativeSpeechThreshold ?? 0.2,
          redemptionMs: t.redemptionMs ?? 480,
          preSpeechPadMs: t.preSpeechPadMs ?? 320,
          minSpeechMs: t.minSpeechMs ?? 160,
          assetPath: t.vadAssetPath ?? "/vad/",
          perf: () => this.clock.perf(),
        },
        handlers,
      );
    } catch (e) {
      if (gen === this.gen) this.fail(`voice detection failed to load: ${errText(e)}`);
      return;
    }
    if (gen !== this.gen) {
      void driver.destroy().catch(() => undefined);
      return;
    }
    this.vad = driver;

    const outcome = await tokenP;
    if (gen !== this.gen) return; // someone stopped us while waiting; teardown already ran
    if (outcome.kind === "proxy") {
      this.fail(PROXY_UNSUPPORTED_DETAIL);
      return;
    }
    if (outcome.kind === "client") {
      this.attachStreamer(outcome.info, core, stats);
    } else {
      this.baseDetail = NO_KEY_DETAIL;
      if (outcome.kind === "error") this.scheduleTokenRetry(gen);
    }

    try {
      await driver.start();
    } catch (e) {
      if (gen === this.gen) this.fail(`voice detection failed to start: ${errText(e)}`);
      return;
    }
    if (gen !== this.gen) return;
    stats.start();
    // speech may already have started while the worklet was spinning up
    this.setState(core.speaking ? "hearing" : "listening", this.baseDetail);
  }

  async stop(): Promise<void> {
    if (this._state === "off") return;
    this.gen++;
    this.stopMicNow();
    const background = this.teardown();
    this.setState("off");
    await background;
  }

  async pause(via: "tap" | "voice" | "kws" | "remote"): Promise<void> {
    this.gen++;
    const lastEnd = this.lastUtteranceEnd(); // read before teardown drops the core
    this.stopMicNow();
    const releasedAt = this.clock.now();
    const background = this.teardown();
    this.setState("paused", via);
    if (via === "voice" || via === "kws") {
      // an external trigger (e.g. a keyword spotter): latency since the last utterance ended, when that was recent
      const since = releasedAt - lastEnd;
      const latency = lastEnd > 0 && since >= 0 && since < 5000 ? since : 0;
      this.safe(() => this.opts.onPause(via, Math.max(1, Math.round(latency))));
    }
    await background;
  }

  private lastUtteranceEnd(): number {
    return Math.max(this.lastInjectEnd, this.core?.lastSpeechEnd ?? 0);
  }

  recalibrate(): void {
    this.core?.recalibrate();
  }

  /** dev / test / no-mic fallback: behaves exactly like the text engine (but the kill switch is the real one) */
  injectText(text: string, o: { whisper?: boolean; pauseBeforeMs?: number; durationMs?: number } = {}): void {
    if (this._state === "paused" || this._state === "off") return;
    const now = this.clock.now();
    const durationMs = o.durationMs ?? Math.max(600, text.split(/\s+/).length * 320);
    const start = now - durationMs;
    const lastEnd = this.lastUtteranceEnd();
    const pauseBeforeMs = o.pauseBeforeMs ?? (lastEnd ? Math.max(0, start - lastEnd) : 0);
    this.lastInjectEnd = now;
    this.safe(() => this.opts.onSpeaking(true, start));
    this.safe(() => this.opts.onSpeaking(false, now));
    if (matchPauseIntent(text).match) {
      this.killSwitch("voice", now);
      return;
    }
    const msg: FragmentFinal = buildFragmentFinal({
      fragmentId: makeFragmentId(this.opts.deviceId, now, this.injectSeq++),
      sessionId: this.opts.sessionId,
      text,
      speechStart: start,
      speechEnd: now,
      commitSent: now,
      wisprFinal: now,
      pauseBeforeMs,
      rmsMean: o.whisper ? 0.02 : 0.08,
      rmsMax: o.whisper ? 0.05 : 0.2,
      whisper: Boolean(o.whisper),
      activity: this.opts.getActivity(),
      transport: "mock",
    });
    this.safe(() => this.opts.onFragment(msg));
  }

  /* ------------------------------------------------------------------ kill switch / teardown */

  /**
   * LOCAL KILL SWITCH. Order matters: the microphone is released first (the OS indicator turns off), then the VAD is
   * destroyed, every Wispr socket is closed without a commit and every audio buffer is zero-filled. Only then is the UI told.
   */
  private killSwitch(via: "voice" | "kws", speechEnd: number): void {
    if (this._state === "paused" || this._state === "off") return;
    this.gen++; // also cancels a start() that is still loading
    this.stopMicNow();
    const releasedAt = this.clock.now();
    const background = this.teardown();
    this.setState("paused", via);
    this.safe(() => this.opts.onPause(via, Math.max(1, Math.round(releasedAt - speechEnd))));
    void background;
  }

  /** stop every MediaStreamTrack right now (synchronously) */
  private stopMicNow(): void {
    const stream = this.stream;
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
    }
  }

  /**
   * Release everything. The synchronous part (core, sockets, buffers, timers) completes before this returns; the returned
   * promise covers the asynchronous VAD / AudioContext close. Never rejects.
   */
  private teardown(): Promise<void> {
    for (const off of this.removeListeners.splice(0)) off();
    if (this.tokenRetry !== null) {
      this.clock.clearTimeout(this.tokenRetry);
      this.tokenRetry = null;
    }
    const core = this.core;
    const streamer = this.streamer;
    const stats = this.stats;
    const vad = this.vad;
    const ctx = this.audioCtx;
    this.core = null;
    this.streamer = null;
    this.stats = null;
    this.vad = null;
    this.audioCtx = null;
    this.stream = null;
    this.baseDetail = undefined;

    core?.dispose(); // aborts every utterance (no commit), zero-fills the ring + PCM
    streamer?.stop(); // closes the standby and any remaining socket
    stats?.stop(true);
    const vadDone = vad
      ? vad.destroy().catch(() => undefined)
      : Promise.resolve();
    return vadDone.then(() => this.closeCtxAsync(ctx));
  }

  private fail(detail: string): void {
    this.gen++;
    this.stopMicNow();
    const background = this.teardown();
    this.setState("error", detail);
    void background;
  }

  private closeCtx(ctx: AudioContext | null): void {
    void this.closeCtxAsync(ctx);
  }

  private async closeCtxAsync(ctx: AudioContext | null): Promise<void> {
    if (!ctx) return;
    try {
      await ctx.close();
    } catch {
      /* already closed */
    }
  }

  /* ------------------------------------------------------------------ Wispr token / streamer */

  private async fetchToken(): Promise<TokenOutcome> {
    try {
      const info = await withTimeout(this.opts.requestWisprToken(), this.tokenTimeoutMs, this.clock, "token request");
      if (info.mode === "proxy") return { kind: "proxy" };
      if (info.mode === "client") {
        if (info.error) return { kind: "error", reason: info.error };
        if (!info.token || !info.wsUrl) return { kind: "error", reason: "token response incomplete" };
        return { kind: "client", info };
      }
      return { kind: "mock" };
    } catch (e) {
      return { kind: "error", reason: errText(e) };
    }
  }

  private attachStreamer(info: WisprTokenInfo, core: CaptureCore, stats: StatsCollector): void {
    const t = this.tuning;
    const streamer = this.d.createStreamer({
      deviceId: this.opts.deviceId,
      sessionId: this.opts.sessionId,
      getToken: (o) => withTimeout(this.opts.requestWisprToken(o), this.tokenTimeoutMs, this.clock, "token request"),
      getContext: () => this.opts.getWisprContext(),
      clock: this.clock,
      ...(this.d.createSocket ? { createSocket: this.d.createSocket } : {}),
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
      ...(t.wisprFinalTimeoutMs !== undefined ? { finalTimeoutMs: t.wisprFinalTimeoutMs } : {}),
      ...(t.wisprStandbyMaxAgeMs !== undefined ? { standbyMaxAgeMs: t.wisprStandbyMaxAgeMs } : {}),
      ...(t.packetFormat ? { packetFormat: t.packetFormat } : {}),
      emit: (dg) => this.diag(dg),
      onRadio: (active) => (active ? stats.radioStart() : stats.radioEnd()),
      onBytes: (n) => stats.addBytes(n),
    });
    streamer.primeToken(info);
    streamer.start();
    this.streamer = streamer;
    core.setStreamer(streamer);
    this.tokenRetryCount = 0;
  }

  /** the first token request failed (server not reachable yet, Wispr outage): keep trying quietly */
  private scheduleTokenRetry(gen: number): void {
    if (this.tokenRetry !== null) return;
    const delay = Math.min(60_000, 10_000 * 2 ** this.tokenRetryCount);
    this.tokenRetryCount++;
    this.tokenRetry = this.clock.setTimeout(() => {
      this.tokenRetry = null;
      if (gen !== this.gen) return;
      void this.fetchToken().then((outcome) => {
        if (gen !== this.gen || !this.core || !this.stats) return;
        if (outcome.kind === "client") {
          this.attachStreamer(outcome.info, this.core, this.stats);
          this.baseDetail = undefined;
          this.setState(this._state, undefined);
        } else if (outcome.kind === "error") {
          this.scheduleTokenRetry(gen);
        }
      });
    }, delay);
  }

  /* ------------------------------------------------------------------ stream health */

  private watchStream(stream: MediaStream, ctx: AudioContext | null, gen: number): void {
    for (const track of stream.getAudioTracks()) {
      const onEnded = () => {
        if (gen === this.gen) this.fail("microphone disconnected");
      };
      const onMute = () => {
        if (gen !== this.gen) return;
        this.baseDetail = "microphone muted by the system";
        if (this.running) this.setState(this._state, this.baseDetail);
      };
      const onUnmute = () => {
        if (gen !== this.gen) return;
        if (this.baseDetail === "microphone muted by the system") this.baseDetail = undefined;
        if (this.running) this.setState(this._state, this.baseDetail);
      };
      track.addEventListener("ended", onEnded);
      track.addEventListener("mute", onMute);
      track.addEventListener("unmute", onUnmute);
      this.removeListeners.push(() => {
        track.removeEventListener("ended", onEnded);
        track.removeEventListener("mute", onMute);
        track.removeEventListener("unmute", onUnmute);
      });
    }
    // a suspended / interrupted AudioContext (tab hidden, phone call) must be woken up again
    const wake = () => {
      if (ctx && ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => undefined);
    };
    if (ctx) {
      ctx.addEventListener("statechange", wake);
      this.removeListeners.push(() => ctx.removeEventListener("statechange", wake));
    }
    const doc = this.d.document === undefined ? (typeof document !== "undefined" ? document : null) : this.d.document;
    if (doc) {
      const onVisible = () => {
        if (doc.visibilityState !== "visible") return;
        wake();
        this.streamer?.kick?.(); // the tab may have been frozen: do not trust the standby's backoff timer
      };
      doc.addEventListener("visibilitychange", onVisible);
      this.removeListeners.push(() => doc.removeEventListener("visibilitychange", onVisible));
    }
    const win = this.d.window === undefined ? (typeof window !== "undefined" ? window : null) : this.d.window;
    if (win) {
      const onOnline = () => this.streamer?.kick?.(); // venue Wi-Fi blips: reconnect now, not after the backoff
      win.addEventListener("online", onOnline);
      this.removeListeners.push(() => win.removeEventListener("online", onOnline));
    }
  }

  /* ------------------------------------------------------------------ plumbing */

  private setState(state: AudioState, detail?: string): void {
    if (state === this._state && detail === this.detail) return;
    this._state = state;
    this.detail = detail;
    this.safe(() => this.opts.onState(state, detail));
  }

  private diag(d: AudioDiagnostic): void {
    this.safe(() => this.opts.onDiagnostic?.(d));
  }

  /** a throwing UI callback must never take the audio pipeline down */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* swallow */
    }
  }
}

/** build an engine factory with injected dependencies (tests); `createMicEngine` below is the production one */
export function createMicEngineFactory(deps: MicEngineDeps = {}): AudioEngineFactory {
  const resolved = {
    ...deps,
    getUserMedia: deps.getUserMedia ?? defaultGetUserMedia,
    createAudioContext: deps.createAudioContext ?? defaultCreateAudioContext,
    createVad: deps.createVad ?? createMicVadDriver,
    createStreamer: deps.createStreamer ?? ((cfg: WisprStreamerConfig): StreamerLike => new WisprStreamer(cfg)),
  };
  return (opts: AudioEngineOptions): AudioEngine => new MicEngine(opts, resolved);
}

/** The microphone engine used by the UI (see audio/index.ts, which loads this module lazily). */
export const createMicEngine: AudioEngineFactory = createMicEngineFactory();
