import { create } from "zustand";
import type { GhostFragment, PendingFragment } from "@/lib/stream-group";

/* ============================================================================
 * Live stream: fragments this device just sent (shown at once, before the server acks them), the
 * dissolving "ghost" of a filtered aside, and the asides counter. Filtered text is RAM-only and short-lived.
 * ========================================================================== */

export const PENDING_TTL_MS = 12_000;
export const GHOST_TTL_MS = 2_400;

export interface StreamState {
  pending: PendingFragment[];
  /** ids of fragments this device spoke recently (only those may dissolve into a visible ghost) */
  localIds: string[];
  ghosts: GhostFragment[];
  asideCount: number;
  /** increments every time the counter goes up (drives the chip bump animation) */
  asideBump: number;
  addPending: (p: PendingFragment) => void;
  /** fragments that now appear inside a thought no longer need their pending line */
  absorb: (fragmentIds: Iterable<string>) => void;
  prune: (now: number) => void;
  filtered: (fragmentId: string, asideCount: number, reason: "aside" | "noise" | "paused", now: number) => void;
  /** a provisional card turned out to be an aside: its local fragments dissolve into the counter */
  ghostify: (fragments: Array<{ id: string; text: string }>, now: number) => void;
  dropGhost: (id: string) => void;
  setAsideCount: (n: number) => void;
  clearPending: () => void;
}

export const useStream = create<StreamState>()((set, get) => ({
  pending: [],
  localIds: [],
  ghosts: [],
  asideCount: 0,
  asideBump: 0,

  addPending: (p) => set((s) => ({ pending: [...s.pending.filter((x) => x.id !== p.id), p].slice(-20), localIds: [...s.localIds.filter((x) => x !== p.id), p.id].slice(-60) })),

  absorb: (ids) => {
    const drop = new Set(ids);
    if (!drop.size) return;
    const cur = get().pending;
    if (!cur.some((p) => drop.has(p.id))) return;
    set({ pending: cur.filter((p) => !drop.has(p.id)) });
  },

  prune: (now) => {
    const { pending, ghosts } = get();
    const p2 = pending.filter((p) => now - p.sentAt < PENDING_TTL_MS);
    const g2 = ghosts.filter((g) => now - g.at < GHOST_TTL_MS);
    if (p2.length !== pending.length || g2.length !== ghosts.length) set({ pending: p2, ghosts: g2 });
  },

  filtered: (fragmentId, asideCount, reason, now) => {
    set((s) => {
      const mine = s.pending.find((p) => p.id === fragmentId);
      const bumped = asideCount > s.asideCount;
      return {
        asideCount,
        asideBump: bumped ? s.asideBump + 1 : s.asideBump,
        pending: mine ? s.pending.filter((p) => p.id !== fragmentId) : s.pending,
        // only fragments this device just said can dissolve visibly; others just bump the counter
        ghosts: mine && reason !== "paused" ? [...s.ghosts, { id: fragmentId, text: mine.text, at: now }].slice(-4) : s.ghosts,
      };
    });
  },

  ghostify: (fragments, now) =>
    set((s) => {
      const mine = fragments.filter((f) => s.localIds.includes(f.id) && !s.ghosts.some((g) => g.id === f.id));
      if (!mine.length) return s;
      return { ghosts: [...s.ghosts, ...mine.map((f) => ({ id: f.id, text: f.text, at: now }))].slice(-4) };
    }),

  dropGhost: (id) => set((s) => ({ ghosts: s.ghosts.filter((g) => g.id !== id) })),

  setAsideCount: (n) => set((s) => ({ asideCount: n, asideBump: n > s.asideCount ? s.asideBump + 1 : s.asideBump })),

  clearPending: () => set({ pending: [], ghosts: [] }),
}));
