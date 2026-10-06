import { create } from "zustand";
import type { Category, EdgeType } from "@synapse/shared";
import { GraphCache } from "@/lib/graph-cache";
import { getItem, setItem } from "@/lib/storage";

/* ============================================================================
 * UI state of the graph screen (not the graph itself: that is `useGraph`). A zustand store so the canvas,
 * timeline, legend and detail panel can each subscribe to just the slice they need, and so the replay
 * loop can drive the canvas without re-rendering the screen.
 * ========================================================================== */

/**
 * The one object cache between the graph store and the force engine. Module-level on purpose: when you
 * leave the screen and come back the constellation is still laid out (and session colours are the same).
 */
export const graphCache = new GraphCache();

export interface GraphViewState {
  /** follow "now": everything is visible and new nodes pulse in */
  live: boolean;
  /** replay time (epoch ms) while not live */
  t: number;
  playing: boolean;
  selectedId: string | null;
  hoverId: string | null;
  /** a node a row in the detail panel is pointing at: ringed and named on the canvas, nothing else changes */
  emphasisId: string | null;
  /** show every label regardless of zoom (the collision pass still keeps them readable) */
  alwaysLabels: boolean;
  legendOpen: boolean;
  /** the camera follows the graph as it grows; any pan / zoom by the user switches it off */
  autoFit: boolean;
  hiddenEdgeTypes: ReadonlySet<EdgeType>;
  categories: ReadonlySet<Category>;

  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  emphasize: (id: string | null) => void;
  goLive: () => void;
  scrubTo: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggleLabels: () => void;
  toggleLegend: (open?: boolean) => void;
  setAutoFit: (on: boolean) => void;
  toggleEdgeType: (t: EdgeType) => void;
  toggleCategory: (c: Category) => void;
  clearFilters: () => void;
  reset: () => void;
}

const LS_LEGEND = "synapse.graph.legend";
const LS_LABELS = "synapse.graph.labels";

function readBool(key: string, fallback: boolean): boolean {
  const v = getItem(key);
  return v === null ? fallback : v === "1";
}

const fresh = (): Pick<GraphViewState, "live" | "t" | "playing" | "selectedId" | "hoverId" | "emphasisId" | "autoFit" | "hiddenEdgeTypes" | "categories"> => ({
  live: true,
  t: Date.now(),
  playing: false,
  selectedId: null,
  hoverId: null,
  emphasisId: null,
  autoFit: true,
  hiddenEdgeTypes: new Set<EdgeType>(),
  categories: new Set<Category>(),
});

const toggled = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

export const useGraphView = create<GraphViewState>()((set, get) => ({
  ...fresh(),
  alwaysLabels: readBool(LS_LABELS, false),
  legendOpen: readBool(LS_LEGEND, typeof window !== "undefined" ? window.innerWidth >= 1500 : false),

  select: (id) => set({ selectedId: id }),
  hover: (id) => {
    if (get().hoverId !== id) set({ hoverId: id });
  },
  emphasize: (id) => {
    if (get().emphasisId !== id) set({ emphasisId: id });
  },
  goLive: () => set({ live: true, playing: false }),
  scrubTo: (t) => set({ live: false, t, playing: false }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggleLabels: () => {
    const next = !get().alwaysLabels;
    setItem(LS_LABELS, next ? "1" : "0");
    set({ alwaysLabels: next });
  },
  toggleLegend: (open) => {
    const next = open ?? !get().legendOpen;
    setItem(LS_LEGEND, next ? "1" : "0");
    set({ legendOpen: next });
  },
  setAutoFit: (on) => {
    if (get().autoFit !== on) set({ autoFit: on });
  },
  toggleEdgeType: (t) => set((s) => ({ hiddenEdgeTypes: toggled(s.hiddenEdgeTypes, t) })),
  toggleCategory: (c) => set((s) => ({ categories: toggled(s.categories, c) })),
  clearFilters: () => set({ hiddenEdgeTypes: new Set(), categories: new Set() }),
  reset: () => set({ ...fresh() }),
}));
