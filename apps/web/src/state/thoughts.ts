import { create } from "zustand";
import type { ArtifactView, ThoughtView } from "@synapse/shared";

/* ============================================================================
 * Thoughts: by id + ordered (oldest → newest) + the ack map (fragmentId → thoughtId) that the latency
 * reporting and the stream grouping use. Removal can be two-phase: a retracted / forgotten / purged card
 * first "fades" (the UI plays the exit), then is deleted.
 * ========================================================================== */

export type RemoveReason = "purged" | "retracted" | "expired" | "forgotten" | "aside" | "merged";
const ANIMATED_REMOVALS: ReadonlySet<RemoveReason> = new Set(["purged", "retracted", "expired", "forgotten"]);
export const MAX_THOUGHTS = 160;

export interface ThoughtsState {
  byId: Record<string, ThoughtView>;
  /** oldest → newest */
  order: string[];
  ack: Record<string, string>;
  lastFragment: Record<string, string>;
  /** thoughtId → removal reason while the exit animation plays */
  fading: Record<string, RemoveReason>;
  hydrate: (ts: ThoughtView[]) => void;
  upsert: (t: ThoughtView) => void;
  setArtifact: (thoughtId: string, a: ArtifactView) => void;
  noteAck: (fragmentId: string, thoughtId: string) => void;
  /** returns true when the removal is animated (caller schedules finishRemoval) */
  remove: (id: string, reason: RemoveReason) => boolean;
  finishRemoval: (id: string) => void;
  clear: () => void;
}

function insertSorted(order: string[], id: string, byId: Record<string, ThoughtView>): string[] {
  const t = byId[id];
  if (!t) return order;
  const out = order.filter((x) => x !== id);
  let i = out.length;
  while (i > 0 && (byId[out[i - 1] as string]?.createdAt ?? 0) > t.createdAt) i--;
  out.splice(i, 0, id);
  return out;
}

function trim(byId: Record<string, ThoughtView>, order: string[]): { byId: Record<string, ThoughtView>; order: string[] } {
  if (order.length <= MAX_THOUGHTS) return { byId, order };
  const drop = order.slice(0, order.length - MAX_THOUGHTS);
  const next = { ...byId };
  for (const id of drop) delete next[id];
  return { byId: next, order: order.slice(drop.length) };
}

export const useThoughts = create<ThoughtsState>()((set, get) => ({
  byId: {},
  order: [],
  ack: {},
  lastFragment: {},
  fading: {},

  hydrate: (ts) => {
    const byId: Record<string, ThoughtView> = {};
    for (const t of ts) byId[t.id] = t;
    const order = [...ts].sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id);
    set((s) => ({ byId, order, fading: {}, ack: s.ack, lastFragment: s.lastFragment }));
  },

  upsert: (t) => {
    set((s) => {
      const byId = { ...s.byId, [t.id]: t };
      const known = Boolean(s.byId[t.id]);
      const order = known && s.byId[t.id]?.createdAt === t.createdAt ? s.order : insertSorted(s.order, t.id, byId);
      const trimmed = trim(byId, order);
      return { byId: trimmed.byId, order: trimmed.order };
    });
  },

  setArtifact: (thoughtId, a) => {
    const t = get().byId[thoughtId];
    if (!t) return;
    set((s) => ({ byId: { ...s.byId, [thoughtId]: { ...t, artifact: a } } }));
  },

  noteAck: (fragmentId, thoughtId) => {
    set((s) => ({ ack: { ...s.ack, [fragmentId]: thoughtId }, lastFragment: { ...s.lastFragment, [thoughtId]: fragmentId } }));
  },

  remove: (id, reason) => {
    const s = get();
    if (!s.byId[id]) return false;
    if (ANIMATED_REMOVALS.has(reason)) {
      set({ fading: { ...s.fading, [id]: reason } });
      return true;
    }
    get().finishRemoval(id);
    return false;
  },

  finishRemoval: (id) => {
    set((s) => {
      if (!s.byId[id] && !s.fading[id]) return s;
      const byId = { ...s.byId };
      delete byId[id];
      const fading = { ...s.fading };
      delete fading[id];
      const lastFragment = { ...s.lastFragment };
      delete lastFragment[id];
      return { byId, fading, lastFragment, order: s.order.filter((x) => x !== id) };
    });
  },

  clear: () => set({ byId: {}, order: [], ack: {}, lastFragment: {}, fading: {} }),
}));

/** Newest first, as the cards column renders them. */
export const selectNewestFirst = (s: Pick<ThoughtsState, "order">): string[] => [...s.order].reverse();

export const anyAnalyzing = (byId: Record<string, ThoughtView>): boolean => {
  for (const id in byId) if (byId[id]?.analyzing) return true;
  return false;
};
