import { create } from "zustand";
import type { CaptureView } from "@synapse/shared";
import type { QueueItem } from "@/capture/queue";

/* Captures: this device's offline queue (what is waiting / sending / sent) and the server's recent captures (any device). */

export interface CapturesState {
  queue: QueueItem[];
  recent: CaptureView[];
  setQueue: (q: QueueItem[]) => void;
  hydrate: (r: CaptureView[]) => void;
  upsert: (c: CaptureView) => void;
}

const MAX_RECENT = 30;

export const useCaptures = create<CapturesState>()((set) => ({
  queue: [],
  recent: [],
  setQueue: (queue) => set({ queue }),
  hydrate: (recent) => set({ recent: [...recent].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECENT) }),
  upsert: (c) =>
    set((s) => ({
      recent: [c, ...s.recent.filter((x) => x.captureId !== c.captureId)].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECENT),
    })),
}));
