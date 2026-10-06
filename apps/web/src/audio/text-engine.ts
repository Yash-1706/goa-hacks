import { matchPauseIntent, type FragmentFinal } from "@synapse/shared";
import type { AudioEngine, AudioEngineFactory, AudioEngineOptions, AudioState } from "./types";

/**
 * No-microphone engine: fragments come from typed text (WISPR_MODE=mock, demos without a mic,
 * tests). Implements the same AudioEngine contract as the real mic engine so the UI never branches.
 * The local kill-switch still works on typed text ("pause memory").
 */
export const createTextEngine: AudioEngineFactory = (opts: AudioEngineOptions): AudioEngine => {
  let state: AudioState = "off";
  let lastEnd = 0;
  let seq = 0;
  const set = (s: AudioState, detail?: string) => {
    state = s;
    opts.onState(s, detail);
  };

  return {
    get running() {
      return state === "listening" || state === "hearing";
    },
    get state() {
      return state;
    },
    async start() {
      set("listening", "typed input (no microphone)");
    },
    async stop() {
      set("off");
    },
    async pause(via) {
      set("paused", via);
    },
    injectText(text, o = {}) {
      if (state === "paused" || state === "off") return;
      const now = Date.now();
      const durationMs = o.durationMs ?? Math.max(600, text.split(/\s+/).length * 320);
      const start = now - durationMs;
      const pauseBeforeMs = o.pauseBeforeMs ?? (lastEnd ? Math.max(0, start - lastEnd) : 0);
      lastEnd = now;
      opts.onSpeaking(true, start);
      opts.onSpeaking(false, now);
      if (matchPauseIntent(text).match) {
        set("paused", "voice");
        opts.onPause("voice", Math.max(1, Date.now() - now));
        return;
      }
      const msg: FragmentFinal = {
        type: "fragment.final",
        fragmentId: `${opts.deviceId}-${now.toString(36)}-${(seq++).toString(36)}`,
        sessionId: opts.sessionId,
        text,
        t: { speechStart: start, speechEnd: now, commitSent: now, wisprFinal: now },
        durationMs,
        pauseBeforeMs,
        rmsMean: o.whisper ? 0.02 : 0.08,
        rmsMax: o.whisper ? 0.05 : 0.2,
        whisper: Boolean(o.whisper),
        activity: opts.getActivity(),
        transport: "mock",
      };
      opts.onFragment(msg);
    },
  };
};
