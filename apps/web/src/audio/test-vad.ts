/* ============================================================================
 * A VAD driver double for tests. It runs the REAL vad-web FrameProcessor (pure JS: thresholds, redemption, minSpeech,
 * event order) with a scripted model, so the engine is exercised against the event semantics of the real MicVAD
 * (FrameProcessed fires before SpeechStart for the same frame, misfires, redemption counting, ...).
 * ========================================================================== */
import { FrameProcessor, type FrameProcessorEvent } from "@ricky0123/vad-web/dist/frame-processor";
import { Message } from "@ricky0123/vad-web/dist/messages";
import { FRAME_SAMPLES } from "./pcm";
import type { VadDriver, VadDriverConfig, VadHandlers } from "./vad-driver";

export class ScriptedVad implements VadDriver {
  started = false;
  destroyed = false;
  skipped = 0;
  fed = 0;
  thresholds: { pos: number; neg: number };
  /** pretend model cost per processed frame, reported through onVadTime */
  modelCostMs = 0;
  readonly frameProcessor: FrameProcessor;
  private prob = 0.02;

  constructor(
    readonly cfg: VadDriverConfig,
    private readonly h: VadHandlers,
  ) {
    this.thresholds = { pos: cfg.positiveSpeechThreshold, neg: cfg.negativeSpeechThreshold };
    this.frameProcessor = new FrameProcessor(
      async () => ({ isSpeech: this.prob, notSpeech: 1 - this.prob }),
      () => undefined,
      {
        positiveSpeechThreshold: cfg.positiveSpeechThreshold,
        negativeSpeechThreshold: cfg.negativeSpeechThreshold,
        redemptionMs: cfg.redemptionMs,
        preSpeechPadMs: cfg.preSpeechPadMs,
        minSpeechMs: cfg.minSpeechMs,
        submitUserSpeechOnPause: false,
      },
      32,
    );
  }

  async start(): Promise<void> {
    this.started = true;
    this.frameProcessor.resume();
  }

  setThresholds(positive: number, negative: number): void {
    this.thresholds = { pos: positive, neg: negative };
    this.frameProcessor.setOptions({ positiveSpeechThreshold: positive, negativeSpeechThreshold: negative });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    // like MicVAD.destroy(): pauseStream stops the tracks
    for (const t of this.cfg.stream.getTracks()) t.stop();
    this.frameProcessor.pause(() => undefined);
  }

  /** deliver one 16 kHz frame exactly like the patched MicVAD.processFrame does */
  async feed(frame: Float32Array, speechProb: number): Promise<void> {
    if (!this.started || this.destroyed) return;
    this.fed++;
    this.prob = speechProb;
    const run = this.h.onFrame(frame);
    if (!run) {
      this.skipped++;
      return;
    }
    await this.frameProcessor.process(frame, (ev: FrameProcessorEvent) => this.dispatch(ev));
    if (this.modelCostMs > 0) this.h.onVadTime(this.modelCostMs);
  }

  private dispatch(ev: FrameProcessorEvent): void {
    switch (ev.msg) {
      case Message.FrameProcessed:
        this.h.onProbs(ev.frame, ev.probs.isSpeech);
        break;
      case Message.SpeechStart:
        this.h.onSpeechStart();
        break;
      case Message.SpeechRealStart:
        this.h.onSpeechRealStart();
        break;
      case Message.SpeechEnd:
        this.h.onSpeechEnd();
        break;
      case Message.VADMisfire:
        this.h.onMisfire();
        break;
    }
  }
}

/** a 512-sample frame whose RMS is exactly `rms` (alternating +-rms) */
export function frameWithRms(rms: number): Float32Array {
  const f = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < f.length; i++) f[i] = i % 2 ? rms : -rms;
  return f;
}
