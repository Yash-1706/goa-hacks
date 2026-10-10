import type { Activity, FragmentFinal } from "@synapse/shared";

/* ============================================================================
 * CONTRACT between the audio pipeline (src/audio, src/sensors) and the UI.
 * The UI owns the WebSocket to the Synapse server; the audio engine never talks to it.
 * The engine talks to Wispr Flow directly (client token) and reports fragments upward.
 * ========================================================================== */

export type AudioState =
  | "off" // not started
  | "starting" // acquiring mic / loading VAD
  | "listening" // mic open, no speech
  | "hearing" // VAD says someone is speaking
  | "paused" // privacy pause: mic RELEASED
  | "error";

export interface WisprTokenInfo {
  /** "local": the on-device engine on the server's machine; its URLs are relative to the origin the app was loaded from */
  mode: "client" | "proxy" | "mock" | "local";
  /** why the on-device engine was handed out although Wispr was wanted (Wispr unreachable) */
  note?: string;
  /** short-lived Wispr client JWT (mode=client) or on-device token (mode=local) */
  token?: string;
  expiresAt?: number;
  wsUrl?: string;
  restUrl?: string;
  error?: string;
}

export interface WisprContext {
  /** terms the self-healing dictionary wants Wispr to spell correctly */
  dictionary: string[];
  /** the last few transcribed fragments, for continuity */
  conversation: Array<{ role: "user"; content: string }>;
  /** ISO 639-1 codes; empty = auto-detect */
  language: string[];
  userFirstName: string;
}

export interface AudioStats {
  /** window length this report covers (ms) */
  windowMs: number;
  /** CPU time spent in VAD + packetization (ms) */
  cpuMs: number;
  /** time with an active streaming socket (ms) */
  radioMs: number;
  /** audio bytes sent upstream (base64 payload) */
  bytesUp: number;
  mode: "normal" | "eco";
  /** frames skipped by the energy pre-gate */
  framesSkipped: number;
  framesTotal: number;
}

/**
 * Diagnostics from the capture pipeline (ADDITIVE, optional). Never carries transcript text, audio or URLs.
 * Useful for the Lab screen and for verifying the Wispr assumptions listed in audio/README.md.
 */
export type AudioDiagnostic =
  | { kind: "standby"; state: "connecting" | "ready" | "down"; assumed?: boolean; detail?: string }
  | { kind: "fallback"; reason: string }
  | { kind: "latency"; commitToFinalMs: number; transport: "wispr_ws" | "wispr_rest" | "local_stt" }
  | { kind: "calibrated"; noiseFloor: number }
  | { kind: "mode"; mode: "normal" | "eco" }
  | { kind: "anomaly"; detail: string };

/** Optional tuning knobs (ADDITIVE). Every field has a default; see audio/README.md. */
export interface AudioTuning {
  /** Silero threshold to start speech (default 0.35; +ecoThresholdBoost in eco mode) */
  positiveSpeechThreshold?: number;
  /** Silero threshold below which a frame counts as silence (default 0.20) */
  negativeSpeechThreshold?: number;
  /** silence needed to end an utterance, ms (default 480, sensible range 300..900) */
  redemptionMs?: number;
  /** audio kept from before the VAD fired, ms (default 320) */
  preSpeechPadMs?: number;
  /** shorter segments are VAD misfires and are dropped without a commit (default 160) */
  minSpeechMs?: number;
  /** added to positiveSpeechThreshold in eco mode (default 0.10) */
  ecoThresholdBoost?: number;
  /** WISPR_FINAL_TIMEOUT_MS (default 4000) */
  wisprFinalTimeoutMs?: number;
  /** WISPR_STANDBY_MAX_AGE_MS (default 45000) */
  wisprStandbyMaxAgeMs?: number;
  /** getUserMedia autoGainControl (default true); turn off if AGC over-amplifies a noisy venue */
  autoGainControl?: boolean;
  /** noise-floor calibration window, ms (default 2000) */
  noiseCalibrationMs?: number;
  /** absolute RMS ceiling for the whisper flag (default 0.012) */
  whisperRmsAbs?: number;
  /** "pcm16" = raw int16 LE per packet (default), "wav" = every packet wrapped in a 44-byte RIFF header */
  packetFormat?: "pcm16" | "wav";
  /** where /vad assets are served from (default "/vad/") */
  vadAssetPath?: string;
  /** hard cap for one utterance before it is force-split, ms (default 90000) */
  maxUtteranceMs?: number;
}

export interface AudioEngineOptions {
  deviceId: string;
  sessionId: string;
  deviceKind: "desk" | "pocket";

  /** a transcribed utterance (already validated against FragmentFinal) */
  onFragment(msg: FragmentFinal): void;
  /** utterance boundaries from VAD (for the server's speech-aware delivery timing) */
  onSpeaking(speaking: boolean, at: number): void;
  onState(state: AudioState, detail?: string): void;
  /** smoothed input level 0..1 for the orb (called ~15×/s while the mic is open) */
  onLevel(rms: number): void;
  /** an utterance could not be transcribed (Wispr failed AND the REST fallback failed) */
  onFailed(fragmentId: string, reason: string): void;
  /**
   * The LOCAL kill switch fired (a pause phrase was recognised in the transcript).
   * By the time this is called the microphone is already released.
   * latencyMs = end of the pause phrase → mic released.
   */
  onPause(via: "voice" | "kws", latencyMs: number): void;
  onStats(stats: AudioStats): void;

  /** ask the server for a fresh Wispr client token (via the WebSocket) */
  requestWisprToken(opts?: { force?: boolean }): Promise<WisprTokenInfo>;
  getWisprContext(): WisprContext;
  getActivity(): Activity;
  /** current power mode; the engine re-reads it each utterance */
  getMode(): "normal" | "eco";

  /* ---- ADDITIVE optional members (the contract above is unchanged) ----
   * NOTE on onLevel above: the mic engine passes a NORMALISED level (0 at the calibrated noise floor, 1 at
   * ~36 dB above it, smoothed with fast attack / slow release), not a raw RMS. Use it directly (no extra scaling).
   */
  /** pipeline diagnostics for the Lab screen; never contains text or audio */
  onDiagnostic?(d: AudioDiagnostic): void;
  /** tuning overrides (VAD thresholds, Wispr timeouts, ...) */
  tuning?: AudioTuning;
  /** the origin the app was loaded from: the on-device engine's relative endpoints resolve against it (default: location.origin) */
  origin?: string;
}

export interface AudioEngine {
  /** open the mic (must be called from a user gesture) and start listening */
  start(): Promise<void>;
  /** release the mic and close every socket; audio buffers are zeroed */
  stop(): Promise<void>;
  /** privacy pause: same as stop() but reports state "paused" */
  pause(via: "tap" | "voice" | "kws" | "remote"): Promise<void>;
  readonly running: boolean;
  readonly state: AudioState;
  /**
   * Dev / test / no-key mode: feed a transcribed fragment as if Wispr had returned it.
   * Timing fields default to "now".
   */
  injectText?(text: string, opts?: { whisper?: boolean; pauseBeforeMs?: number; durationMs?: number }): void;
  /** re-measure the noise floor (call when the room or the input device changes). Mic engine only. */
  recalibrate?(): void;
  /**
   * The server switched the speech engine (local-only mode toggled): drop the token and every socket, abort what is being
   * streamed, and connect to the engine the server hands out next. The microphone stays open. Mic engine only.
   */
  reconnectSpeech?(): void;
}

export type AudioEngineFactory = (opts: AudioEngineOptions) => AudioEngine;
