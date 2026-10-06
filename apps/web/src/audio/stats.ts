import type { Clock, TimerId } from "./clock";
import type { AudioStats } from "./types";

/**
 * Battery-Lab counters (TRD §11.4).
 *  - cpuMs        time spent in the VAD callback + packetization (performance.now deltas)
 *  - radioMs      time any socket is ACTIVELY streaming audio (first append sent -> utterance settled) + a 2 s tail.
 *                 Overlapping utterances are merged (a union of intervals, not a sum). Standby sockets do not count.
 *  - bytesUp      base64 characters of audio sent (the `packets` payload; control messages are not counted)
 *  - framesTotal / framesSkipped   frames seen / frames the energy pre-gate kept away from the VAD
 * One report per `windowMs` (5 s), each covering only that window.
 */
export interface StatsOptions {
  clock: Clock;
  getMode(): "normal" | "eco";
  onStats(stats: AudioStats): void;
  /** report period (default 5000 ms) */
  windowMs?: number;
  /** radio tail after the last active stream (default 2000 ms) */
  radioTailMs?: number;
}

export class StatsCollector {
  private readonly clock: Clock;
  private readonly period: number;
  private readonly tailMs: number;

  private windowStart: number;
  private cpuMs = 0;
  private bytesUp = 0;
  private framesTotal = 0;
  private framesSkipped = 0;
  private radioMs = 0;

  private active = 0;
  private lastT: number;
  private tailUntil = 0;
  private timer: TimerId | null = null;

  constructor(private readonly opts: StatsOptions) {
    this.clock = opts.clock;
    this.period = opts.windowMs ?? 5000;
    this.tailMs = opts.radioTailMs ?? 2000;
    this.windowStart = this.clock.now();
    this.lastT = this.windowStart;
  }

  addCpu(ms: number): void {
    if (ms > 0) this.cpuMs += ms;
  }

  addFrame(skipped: boolean): void {
    this.framesTotal++;
    if (skipped) this.framesSkipped++;
  }

  addBytes(chars: number): void {
    if (chars > 0) this.bytesUp += chars;
  }

  radioStart(): void {
    this.accrue(this.clock.now());
    this.active++;
  }

  radioEnd(): void {
    if (this.active <= 0) return; // unmatched end: nothing was streaming
    const t = this.clock.now();
    this.accrue(t);
    this.active--;
    if (this.active === 0) this.tailUntil = t + this.tailMs;
  }

  /** number of streams currently active (for tests / debugging) */
  get activeStreams(): number {
    return this.active;
  }

  /** close the current window, return it and start a new one */
  snapshot(): AudioStats {
    const t = this.clock.now();
    this.accrue(t);
    const out: AudioStats = {
      windowMs: Math.max(1, t - this.windowStart),
      cpuMs: this.cpuMs,
      radioMs: this.radioMs,
      bytesUp: this.bytesUp,
      mode: this.opts.getMode(),
      framesSkipped: this.framesSkipped,
      framesTotal: this.framesTotal,
    };
    this.windowStart = t;
    this.cpuMs = 0;
    this.radioMs = 0;
    this.bytesUp = 0;
    this.framesSkipped = 0;
    this.framesTotal = 0;
    return out;
  }

  /** begin periodic reporting */
  start(): void {
    if (this.timer !== null) return;
    this.windowStart = this.clock.now();
    this.lastT = this.windowStart;
    this.timer = this.clock.setInterval(() => this.opts.onStats(this.snapshot()), this.period);
  }

  /** stop reporting; by default flushes the partial window so the Lab does not lose the tail */
  stop(flush = true): void {
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
      if (flush && this.clock.now() - this.windowStart >= 250) this.opts.onStats(this.snapshot());
    }
    this.active = 0;
  }

  private accrue(t: number): void {
    const dt = t - this.lastT;
    if (dt <= 0) return;
    if (this.active > 0) this.radioMs += dt;
    else if (this.tailUntil > this.lastT) this.radioMs += Math.min(t, this.tailUntil) - this.lastT;
    this.lastT = t;
  }
}
