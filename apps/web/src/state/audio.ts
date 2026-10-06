import { create } from "zustand";
import type { Activity } from "@synapse/shared";
import type { AudioDiagnostic, AudioState, AudioStats } from "@/audio/types";

/* ============================================================================
 * Audio-side UI state. The mic LEVEL lives in its own tiny store so the ~15 Hz updates only wake the orb.
 * ========================================================================== */

export interface WisprContextMsg {
  dictionary: string[];
  conversation: Array<{ role: "user"; content: string }>;
  language: string[];
}

export type StampedDiagnostic = AudioDiagnostic & { at: number };

export interface AudioUiState {
  state: AudioState;
  detail?: string;
  /** which engine is actually running */
  engine: "mic" | "text" | null;
  /** false once the mic engine could not be loaded or started (typed input only) */
  micAvailable: boolean | null;
  speaking: boolean;
  mode: "normal" | "eco";
  /** eco was switched on by the low-battery rule, not by the user */
  autoEco: boolean;
  activity: Activity;
  battery: { level: number; charging: boolean } | null;
  wakeLock: boolean;
  /** the server resumed but this device still has its mic off */
  resumeHint: boolean;
  /** a human reason the pipeline runs degraded (wispr fallback, token failure, ...) */
  degraded: string | null;
  sessionId: string | null;
  wisprContext: WisprContextMsg | null;
  stats: AudioStats | null;
  diagnostics: StampedDiagnostic[];
  noiseFloor: number | null;
  standby: "connecting" | "ready" | "down" | null;
  lastFinalLatencyMs: number | null;
  set: (patch: Partial<Omit<AudioUiState, "set" | "addDiagnostic">>) => void;
  addDiagnostic: (d: AudioDiagnostic, at: number) => void;
}

export const useAudioUi = create<AudioUiState>()((set) => ({
  state: "off",
  detail: undefined,
  engine: null,
  micAvailable: null,
  speaking: false,
  mode: "normal",
  autoEco: false,
  activity: "unknown",
  battery: null,
  wakeLock: false,
  resumeHint: false,
  degraded: null,
  sessionId: null,
  wisprContext: null,
  stats: null,
  diagnostics: [],
  noiseFloor: null,
  standby: null,
  lastFinalLatencyMs: null,
  set: (patch) => set(patch),
  addDiagnostic: (d, at) =>
    set((s) => {
      const patch: Partial<AudioUiState> = { diagnostics: [...s.diagnostics, { ...d, at }].slice(-40) };
      if (d.kind === "calibrated") patch.noiseFloor = d.noiseFloor;
      if (d.kind === "standby") patch.standby = d.state;
      if (d.kind === "latency") patch.lastFinalLatencyMs = d.commitToFinalMs;
      return patch;
    }),
}));

export const useLevel = create<{ level: number; set: (n: number) => void }>()((set) => ({
  level: 0,
  set: (level) => set({ level }),
}));
