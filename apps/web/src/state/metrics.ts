import { create } from "zustand";
import type { LatencySummary } from "@synapse/shared";

/* ============================================================================
 * Latency: the server's rolling summary (metrics.update) plus what THIS client measured for the
 * fragments it spoke (wispr final → first paint / artifact render; same clock, no offset needed).
 * ========================================================================== */

export interface LatencySample {
  at: number;
  fragmentId: string;
  firstPaintMs?: number;
  artifactMs?: number;
}

export interface MetricsState {
  summary: LatencySummary | null;
  samples: LatencySample[];
  /** thoughtId → latest client-measured latencies */
  byThought: Record<string, { firstPaintMs?: number; artifactMs?: number }>;
  setSummary: (s: LatencySummary) => void;
  recordFirstPaint: (fragmentId: string, thoughtId: string, ms: number, at: number) => void;
  recordArtifact: (fragmentId: string, thoughtId: string, ms: number, at: number) => void;
}

const MAX_SAMPLES = 40;

export const useMetrics = create<MetricsState>()((set) => ({
  summary: null,
  samples: [],
  byThought: {},

  setSummary: (summary) => set({ summary }),

  recordFirstPaint: (fragmentId, thoughtId, ms, at) =>
    set((s) => {
      const i = s.samples.findIndex((x) => x.fragmentId === fragmentId);
      const samples = [...s.samples];
      if (i >= 0) samples[i] = { ...(samples[i] as LatencySample), firstPaintMs: ms };
      else samples.push({ at, fragmentId, firstPaintMs: ms });
      return {
        samples: samples.slice(-MAX_SAMPLES),
        byThought: { ...s.byThought, [thoughtId]: { ...s.byThought[thoughtId], firstPaintMs: ms } },
      };
    }),

  recordArtifact: (fragmentId, thoughtId, ms, at) =>
    set((s) => {
      const i = s.samples.findIndex((x) => x.fragmentId === fragmentId);
      const samples = [...s.samples];
      if (i >= 0) samples[i] = { ...(samples[i] as LatencySample), artifactMs: ms };
      else samples.push({ at, fragmentId, artifactMs: ms });
      return {
        samples: samples.slice(-MAX_SAMPLES),
        byThought: { ...s.byThought, [thoughtId]: { ...s.byThought[thoughtId], artifactMs: ms } },
      };
    }),
}));
