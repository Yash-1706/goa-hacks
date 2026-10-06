import { create } from "zustand";

/* ============================================================================
 * Privacy state: the server-wide pause (authoritative), what the last pause / forget removed, and the
 * measured "pause phrase → mic released" latency of this device.
 * ========================================================================== */

export interface PrivacyState {
  paused: boolean;
  pausedAt: number | null;
  /** who paused: a device id (or "api") as the server reports it */
  pausedBy: string | null;
  /** how: tap / voice / kws, known only when THIS device paused */
  pausedVia: string | null;
  /** thoughts forgotten by the most recent pause */
  lastPurged: { count: number; at: number } | null;
  lastForgot: { scope: string; count: number; query?: string; at: number } | null;
  /** end of the pause phrase → microphone released, ms (this device) */
  pauseLatencyMs: number | null;
  hydrate: (p: { paused: boolean; pausedAt?: number; pausedBy?: string }) => void;
  paused_: (m: { by: string; purgedCount: number; at: number }) => void;
  resumed: () => void;
  forgot: (m: { scope: string; count: number; query?: string; at: number }) => void;
  setPauseLatency: (ms: number) => void;
  /** optimistic local pause (the mic was released a moment before the server confirms) */
  localPause: (via: string, at: number, by: string) => void;
}

export const usePrivacy = create<PrivacyState>()((set) => ({
  paused: false,
  pausedAt: null,
  pausedBy: null,
  pausedVia: null,
  lastPurged: null,
  lastForgot: null,
  pauseLatencyMs: null,

  hydrate: (p) =>
    set((s) => ({
      paused: p.paused,
      pausedAt: p.paused ? (p.pausedAt ?? s.pausedAt ?? Date.now()) : null,
      pausedBy: p.paused ? (p.pausedBy ?? s.pausedBy ?? "unknown") : null,
      pausedVia: p.paused ? s.pausedVia : null,
    })),

  paused_: (m) => set((s) => ({ paused: true, pausedAt: m.at, pausedBy: m.by, pausedVia: s.pausedVia, lastPurged: { count: m.purgedCount, at: m.at } })),

  resumed: () => set({ paused: false, pausedAt: null, pausedBy: null, pausedVia: null }),

  forgot: (m) => set({ lastForgot: m }),

  setPauseLatency: (ms) => set({ pauseLatencyMs: ms }),

  localPause: (via, at, by) => set((s) => (s.paused ? { ...s, pausedVia: s.pausedVia ?? via } : { paused: true, pausedAt: at, pausedBy: by, pausedVia: via })),
}));
