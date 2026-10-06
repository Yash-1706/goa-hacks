/* ============================================================================
 * Level-domain helpers: noise-floor calibration, whisper flag, orb level meter, energy pre-gate.
 * All pure / clock-injected so they are unit-testable (TRD §5.1, §11.4).
 * ========================================================================== */
import { FRAME_MS } from "./pcm";

/** RMS assumed until the 2 s calibration finishes (about -50 dBFS) */
export const DEFAULT_NOISE_FLOOR = 0.003;
/** floor lower bound: browsers' noise suppression can return digital silence, which would make "x1.5" meaningless */
export const MIN_NOISE_FLOOR = 0.0008;
/** absolute RMS ceiling of the whisper flag */
export const WHISPER_RMS_ABS = 0.012;

/** whisper <=> utterance mean RMS < max(noiseFloor x 3, WHISPER_RMS_ABS) while the VAD says speech */
export function whisperThreshold(noiseFloor: number, abs: number = WHISPER_RMS_ABS): number {
  return Math.max(noiseFloor * 3, abs);
}

export function isWhisper(meanVoicedRms: number, noiseFloor: number, abs: number = WHISPER_RMS_ABS): boolean {
  return meanVoicedRms > 0 && meanVoicedRms < whisperThreshold(noiseFloor, abs);
}

/** median of a list (p50); 0 for an empty list */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface NoiseFloorConfig {
  /** calibration window (default 2000 ms) */
  calibrationMs?: number;
  /** frames ignored at the start while AGC / the mic settle (default 8 = 256 ms) */
  warmupFrames?: number;
  /** minimum silent frames needed to finish (default 20) */
  minSilentFrames?: number;
  /** give up and keep the default after this many frames (default 400 = 12.8 s of continuous speech) */
  maxFrames?: number;
  minValue?: number;
}

/**
 * First ~2 s of frames: noiseFloor = p50 of the frame RMS. Frames the VAD calls speech are excluded so a user who
 * starts talking immediately does not inflate the floor; calibration just takes a little longer then.
 */
export class NoiseFloor {
  value = DEFAULT_NOISE_FLOOR;
  calibrated = false;

  private samples: number[] = [];
  private seen = 0;
  private readonly calibrationFrames: number;
  private readonly warmup: number;
  private readonly minSilent: number;
  private readonly maxFrames: number;
  private readonly minValue: number;

  constructor(cfg: NoiseFloorConfig = {}) {
    this.calibrationFrames = Math.max(1, Math.round((cfg.calibrationMs ?? 2000) / FRAME_MS));
    this.warmup = cfg.warmupFrames ?? 8;
    this.minSilent = cfg.minSilentFrames ?? 20;
    this.maxFrames = cfg.maxFrames ?? 400;
    this.minValue = cfg.minValue ?? MIN_NOISE_FLOOR;
  }

  /** feed one frame; returns true on the call that completes the calibration */
  observe(rms: number, voiced: boolean): boolean {
    if (this.calibrated) return false;
    this.seen++;
    if (this.seen > this.warmup && !voiced) this.samples.push(rms);
    const done = this.seen >= this.calibrationFrames && this.samples.length >= this.minSilent;
    if (!done && this.seen < this.maxFrames) return false;
    if (this.samples.length > 0) this.value = Math.max(median(this.samples), this.minValue);
    this.calibrated = true;
    this.samples = [];
    return true;
  }

  /** start over (device changed, room changed, user asked) */
  reset(): void {
    this.value = DEFAULT_NOISE_FLOOR;
    this.calibrated = false;
    this.samples = [];
    this.seen = 0;
  }
}

/**
 * Perceptual orb level 0..1: 0 at the calibrated noise floor, 1 at `rangeDb` above it.
 * Raw RMS of speech is tiny (0.01..0.2) so a dB mapping is what makes an orb look alive.
 */
export function rmsToLevel(rms: number, noiseFloor: number, rangeDb = 36): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  const floorDb = 20 * Math.log10(Math.max(noiseFloor, 1e-4));
  const x = (db - floorDb) / rangeDb;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface LevelMeterConfig {
  /** minimum spacing between emitted levels (default 60 ms => ~15/s with 32 ms frames) */
  intervalMs?: number;
  /** smoothing factor per frame when rising (default 0.5) */
  attack?: number;
  /** smoothing factor per frame when falling (default 0.2) */
  release?: number;
  rangeDb?: number;
}

/** smooths per-frame RMS into a ~15 Hz orb level */
export class LevelMeter {
  private smooth = 0;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private readonly interval: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly range: number;

  constructor(cfg: LevelMeterConfig = {}) {
    this.interval = cfg.intervalMs ?? 60;
    this.attack = cfg.attack ?? 0.5;
    this.release = cfg.release ?? 0.2;
    this.range = cfg.rangeDb ?? 36;
  }

  /** returns a level to emit now, or null when it is not time yet */
  push(rms: number, noiseFloor: number, now: number): number | null {
    const target = rmsToLevel(rms, noiseFloor, this.range);
    this.smooth += (target - this.smooth) * (target > this.smooth ? this.attack : this.release);
    if (now - this.lastEmit < this.interval) return null;
    this.lastEmit = now;
    return Math.round(this.smooth * 1000) / 1000;
  }

  reset(): void {
    this.smooth = 0;
    this.lastEmit = Number.NEGATIVE_INFINITY;
  }
}

export interface EnergyGateConfig {
  /** a frame is "quiet" below noiseFloor x this (default 1.5) */
  quietRatio?: number;
  /** after this much continuous quiet, only every 2nd frame goes to the VAD (default 3000 ms) */
  quietMs?: number;
}

/**
 * Eco-mode energy pre-gate (TRD §11.4 layer 2). Cheap RMS check per frame; after > 3 s of quiet the VAD runs on every
 * 2nd frame until a frame with real energy shows up. The caller resets it whenever speech is in progress.
 */
export class EnergyGate {
  private quietSince: number | null = null;
  private parity = 0;
  private readonly ratio: number;
  private readonly quietMs: number;

  constructor(cfg: EnergyGateConfig = {}) {
    this.ratio = cfg.quietRatio ?? 1.5;
    this.quietMs = cfg.quietMs ?? 3000;
  }

  /** true = run the VAD on this frame, false = skip it */
  shouldRun(rms: number, noiseFloor: number, now: number): boolean {
    if (rms >= noiseFloor * this.ratio) {
      this.quietSince = null;
      this.parity = 0;
      return true;
    }
    if (this.quietSince === null) {
      this.quietSince = now;
      return true;
    }
    if (now - this.quietSince <= this.quietMs) return true;
    this.parity ^= 1;
    return this.parity === 0;
  }

  /** speech in progress / not applicable: full duty cycle again */
  reset(): void {
    this.quietSince = null;
    this.parity = 0;
  }

  get quiet(): boolean {
    return this.quietSince !== null;
  }
}
