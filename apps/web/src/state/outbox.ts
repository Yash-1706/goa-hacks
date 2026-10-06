import { create } from "zustand";
import type { ArtifactView } from "@synapse/shared";
import { pushability } from "@/lib/artifacts";
import type { OutboxItem } from "@/net/api-types";

/* The Outbox list (GET /api/outbox) kept fresh by artifact.upsert messages. */

export interface OutboxState {
  items: OutboxItem[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  setItems: (items: OutboxItem[]) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  /** merge a live artifact update (adds the item when it is new) */
  patch: (thoughtId: string, artifact: ArtifactView, meta?: { thoughtCode?: string; thoughtTitle?: string }) => void;
}

const HIDDEN_KINDS = new Set(["none", "recall"]);

export const useOutbox = create<OutboxState>()((set) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,

  setItems: (items) => set({ items, loaded: true, loading: false, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),

  patch: (thoughtId, artifact, meta) =>
    set((s) => {
      if (HIDDEN_KINDS.has(artifact.kind)) return s;
      const pushable = pushability(artifact);
      const i = s.items.findIndex((x) => x.id === artifact.id);
      if (i >= 0) {
        const items = [...s.items];
        items[i] = { ...(items[i] as OutboxItem), ...artifact, pushable };
        return { items };
      }
      if (!s.loaded) return s; // the first fetch will include it
      const item: OutboxItem = { ...artifact, thoughtId, thoughtCode: meta?.thoughtCode, thoughtTitle: meta?.thoughtTitle, pushable };
      return { items: [item, ...s.items] };
    }),
}));
