/* ============================================================================
 * The real voice-activity driver: @ricky0123/vad-web 0.0.31 (Silero v5, 16 kHz / 512-sample frames).
 *
 * Why this wrapper exists instead of using MicVAD's callbacks directly:
 *  - We acquire the MediaStream ourselves (getUserMedia inside the user gesture), so the kill switch can stop the tracks
 *    synchronously. MicVAD gets it through `getStream`.
 *  - We create the AudioContext ourselves (inside the gesture, iOS Safari) and close it ourselves.
 *  - Eco mode's energy pre-gate has to keep frames away from the model. MicVAD offers no hook for that, but its public
 *    `processFrame` is what the audio worklet calls for every frame. With `startOnLoad:false` we wrap it BEFORE start(), so
 *    the capture core sees every frame first (ring buffer, RMS, level, packetization) and decides whether the model runs.
 *    If a future version stops exposing `processFrame`, we fall back to onFrameProcessed (no frame skipping, nothing else lost).
 *  - vad-web / onnxruntime-web are loaded with a dynamic import so the ~0.5 MB of JS (and the wasm) is only fetched when the
 *    microphone is actually used, and so node-side unit tests never touch them.
 * ========================================================================== */

export interface VadHandlers {
  /** every 16 kHz frame BEFORE the model runs; return false to skip inference for it (eco pre-gate) */
  onFrame(frame: Float32Array): boolean;
  /** model output for a frame that was let through */
  onProbs(frame: Float32Array, isSpeech: number): void;
  /** wall time spent in the model + its event handlers for one frame */
  onVadTime(ms: number): void;
  onSpeechStart(): void;
  onSpeechRealStart(): void;
  onSpeechEnd(): void;
  onMisfire(): void;
}

export interface VadDriverConfig {
  stream: MediaStream;
  /** created by the engine inside the user gesture; the driver never closes it */
  audioContext: AudioContext | null;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
  /** where vad.worklet.bundle.min.js, silero_vad_v5.onnx and the ORT wasm are served from (default "/vad/") */
  assetPath: string;
  perf(): number;
}

export interface VadDriver {
  /** start delivering frames (opens the worklet) */
  start(): Promise<void>;
  /** retune the live model thresholds (eco mode) */
  setThresholds(positive: number, negative: number): void;
  /** release the model, the worklet and (via pauseStream) the microphone */
  destroy(): Promise<void>;
}

export type VadDriverFactory = (cfg: VadDriverConfig, handlers: VadHandlers) => Promise<VadDriver>;

/** the real thing */
export const createMicVadDriver: VadDriverFactory = async (cfg, h) => {
  const { MicVAD } = await import("@ricky0123/vad-web");

  const stopTracks = () => {
    for (const t of cfg.stream.getTracks()) t.stop();
  };

  // true once we sit in front of MicVAD's frame entry point; otherwise onFrameProcessed has to feed onFrame() itself
  let wrapped = false;

  const vad = await MicVAD.new({
    model: "v5", // the default is "legacy"; v5 needs >= 0.0.31 (64-sample context fix) for quiet speech
    baseAssetPath: cfg.assetPath,
    onnxWASMBasePath: cfg.assetPath,
    positiveSpeechThreshold: cfg.positiveSpeechThreshold,
    negativeSpeechThreshold: cfg.negativeSpeechThreshold,
    redemptionMs: cfg.redemptionMs,
    preSpeechPadMs: cfg.preSpeechPadMs,
    minSpeechMs: cfg.minSpeechMs,
    submitUserSpeechOnPause: false, // pausing / destroying must never emit a late "speech end"
    startOnLoad: false,
    ...(cfg.audioContext ? { audioContext: cfg.audioContext } : {}),
    getStream: async () => cfg.stream,
    // pause / destroy => the microphone is released (same as MicVAD's default, but on OUR stream object)
    pauseStream: async () => stopTracks(),
    resumeStream: async () => cfg.stream,
    ortConfig: (ort) => {
      ort.env.logLevel = "error";
      ort.env.wasm.numThreads = 1; // no cross-origin isolation needed, and the model is tiny
    },
    onFrameProcessed: (probs, frame) => {
      if (!wrapped) h.onFrame(frame); // fallback path: still runs before onSpeechStart for this frame
      h.onProbs(frame, probs.isSpeech);
    },
    onSpeechStart: () => h.onSpeechStart(),
    onSpeechRealStart: () => h.onSpeechRealStart(),
    onSpeechEnd: () => h.onSpeechEnd(),
    onVADMisfire: () => h.onMisfire(),
  });

  // Wrap the frame entry point (see the header comment). Must happen before start().
  const original = vad.processFrame;
  if (typeof original === "function") {
    vad.processFrame = async (frame: Float32Array) => {
      const run = h.onFrame(frame);
      if (!run) return;
      const t0 = cfg.perf();
      try {
        await original(frame);
      } finally {
        h.onVadTime(cfg.perf() - t0);
      }
    };
    wrapped = true;
  }

  // MicVAD.destroy() throws BEFORE it releases the ONNX session when start() never completed (it needs the audio nodes),
  // which would leak the model on every aborted start. In that case release it ourselves.
  const releaseModel = async (): Promise<void> => {
    const model = (vad as unknown as { model?: { release?: () => Promise<void> } }).model;
    try {
      await model?.release?.();
    } catch {
      /* already released */
    }
  };

  let startP: Promise<void> | null = null;
  let destroyed = false;

  return {
    start: () => {
      startP = vad.start();
      return startP;
    },
    setThresholds: (positive, negative) =>
      vad.setOptions({ positiveSpeechThreshold: positive, negativeSpeechThreshold: negative }),
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      stopTracks(); // the microphone first, whatever else happens
      if (startP) {
        // destroying while start() is still wiring the worklet would leave the nodes connected: let it settle (bounded)
        await Promise.race([startP.catch(() => undefined), new Promise<void>((r) => setTimeout(r, 3000))]);
      }
      try {
        await vad.destroy();
      } catch {
        await releaseModel();
      } finally {
        stopTracks();
      }
    },
  };
};
