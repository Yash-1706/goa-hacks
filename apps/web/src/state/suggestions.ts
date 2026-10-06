import { create } from "zustand";
import type { BriefView, EchoView, SuggestionStatus, SuggestionView } from "@synapse/shared";

/* ============================================================================
 * The Synapse rail: suggestions (with slot picks for reschedules), memory echoes and session briefs.
 * ========================================================================== */

export const LIVE_STATUSES: ReadonlySet<SuggestionStatus> = new Set(["queued", "delivered"]);

export interface SuggestionsState {
  items: SuggestionView[];
  echoes: EchoView[];
  briefs: BriefView[];
  /** reschedule slot chosen by the user, per suggestion id */
  picks: Record<string, number>;
  /** when the last suggestion arrived (drives the orb's soft pulse and the rail dot) */
  lastPushAt: number;
  /** items the user has not looked at yet (rail badge on phones) */
  unseen: number;
  hydrate: (items: SuggestionView[], echoes: EchoView[]) => void;
  push: (s: SuggestionView, now: number) => void;
  update: (id: string, status: SuggestionStatus) => void;
  finish: (id: string) => void;
  pushEcho: (e: EchoView, now: number) => void;
  dismissEcho: (id: string) => void;
  pushBrief: (b: BriefView, now: number) => void;
  dismissBrief: (id: string) => void;
  setPick: (id: string, index: number) => void;
  markSeen: () => void;
}

export const useSuggestions = create<SuggestionsState>()((set) => ({
  items: [],
  echoes: [],
  briefs: [],
  picks: {},
  lastPushAt: 0,
  unseen: 0,

  hydrate: (items, echoes) => set({ items, echoes: echoes.slice(-10).reverse() }),

  push: (s, now) =>
    set((st) => ({
      items: [s, ...st.items.filter((x) => x.id !== s.id)].slice(0, 12),
      lastPushAt: now,
      unseen: st.unseen + 1,
    })),

  update: (id, status) => set((st) => ({ items: st.items.map((x) => (x.id === id ? { ...x, status } : x)) })),

  finish: (id) =>
    set((st) => {
      const picks = { ...st.picks };
      delete picks[id];
      return { items: st.items.filter((x) => x.id !== id), picks };
    }),

  pushEcho: (e, now) =>
    set((st) => ({ echoes: [e, ...st.echoes.filter((x) => x.id !== e.id)].slice(0, 10), lastPushAt: now, unseen: st.unseen + 1 })),

  dismissEcho: (id) => set((st) => ({ echoes: st.echoes.filter((x) => x.id !== id) })),

  pushBrief: (b, now) =>
    set((st) => ({ briefs: [b, ...st.briefs.filter((x) => x.id !== b.id)].slice(0, 3), lastPushAt: now, unseen: st.unseen + 1 })),

  dismissBrief: (id) => set((st) => ({ briefs: st.briefs.filter((x) => x.id !== id) })),

  setPick: (id, index) => set((st) => ({ picks: { ...st.picks, [id]: index } })),

  markSeen: () => set({ unseen: 0 }),
}));

/** Suggestions to show now (resolved ones linger briefly so the user sees the outcome). */
export const visibleSuggestions = (items: SuggestionView[]): SuggestionView[] => items.filter((s) => s.status !== "later" && s.status !== "expired");
