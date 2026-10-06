import { create } from "zustand";
import type { RecallConstraints, RecallSource } from "@synapse/shared";

/* ============================================================================
 * Recall, per queryId. Typed queries are created locally the moment they are asked; voice queries
 * (the server detected a recall_query thought) appear here when their first recall.* message arrives.
 * Sources show immediately, the answer streams in token by token.
 * ========================================================================== */

export interface RecallQuery {
  id: string;
  text: string;
  origin: "typed" | "voice";
  startedAt: number;
  constraints?: RecallConstraints;
  relaxations: string[];
  sources: RecallSource[];
  /** server time to produce the sources (phase A) */
  sourcesMs?: number;
  answer: string;
  done: boolean;
  notFound: boolean;
  citations: string[];
  totalMs?: number;
  error?: string;
  /** not looked at on the Recall screen yet */
  unseen: boolean;
}

export interface RecallState {
  queries: Record<string, RecallQuery>;
  /** newest first */
  order: string[];
  activeId: string | null;
  /** queries that arrived by voice and were not opened yet (nav badge) */
  unseenVoice: number;
  start: (id: string, text: string, origin: "typed" | "voice", now: number) => void;
  sources: (m: { queryId: string; queryText: string; constraints: RecallConstraints; sources: RecallSource[]; relaxations: string[]; ms: number }, now: number) => void;
  delta: (queryId: string, text: string, now: number) => void;
  done: (m: { queryId: string; answer: string; citations: string[]; notFound: boolean; ms: number }, now: number) => void;
  fail: (queryId: string, message: string) => void;
  setActive: (id: string | null) => void;
  markSeen: () => void;
  clear: () => void;
}

const blank = (id: string, text: string, origin: "typed" | "voice", now: number): RecallQuery => ({
  id,
  text,
  origin,
  startedAt: now,
  relaxations: [],
  sources: [],
  answer: "",
  done: false,
  notFound: false,
  citations: [],
  unseen: origin === "voice",
});

function ensure(s: RecallState, id: string, text: string, now: number): { queries: Record<string, RecallQuery>; order: string[]; created: boolean } {
  if (s.queries[id]) return { queries: s.queries, order: s.order, created: false };
  const q = blank(id, text, "voice", now);
  return { queries: { ...s.queries, [id]: q }, order: [id, ...s.order].slice(0, 30), created: true };
}

export const useRecall = create<RecallState>()((set) => ({
  queries: {},
  order: [],
  activeId: null,
  unseenVoice: 0,

  start: (id, text, origin, now) =>
    set((s) => ({
      queries: { ...s.queries, [id]: blank(id, text, origin, now) },
      order: [id, ...s.order.filter((x) => x !== id)].slice(0, 30),
      activeId: id,
    })),

  sources: (m, now) =>
    set((s) => {
      const e = ensure(s, m.queryId, m.queryText, now);
      const q = e.queries[m.queryId] as RecallQuery;
      const next: RecallQuery = {
        ...q,
        text: q.text || m.queryText,
        constraints: m.constraints,
        sources: m.sources,
        relaxations: m.relaxations,
        sourcesMs: m.ms,
        answer: "",
        done: false,
        error: undefined,
      };
      return {
        queries: { ...e.queries, [m.queryId]: next },
        order: e.order,
        // a spoken query takes over the screen, a typed one is already active
        activeId: e.created ? m.queryId : s.activeId,
        unseenVoice: e.created ? s.unseenVoice + 1 : s.unseenVoice,
      };
    }),

  delta: (queryId, text, now) =>
    set((s) => {
      const e = ensure(s, queryId, "", now);
      const q = e.queries[queryId] as RecallQuery;
      return { queries: { ...e.queries, [queryId]: { ...q, answer: q.answer + text } }, order: e.order };
    }),

  done: (m, now) =>
    set((s) => {
      const e = ensure(s, m.queryId, "", now);
      const q = e.queries[m.queryId] as RecallQuery;
      return {
        queries: {
          ...e.queries,
          [m.queryId]: { ...q, answer: m.answer || q.answer, citations: m.citations, notFound: m.notFound, totalMs: m.ms, done: true },
        },
        order: e.order,
      };
    }),

  fail: (queryId, message) =>
    set((s) => {
      const q = s.queries[queryId];
      if (!q) return s;
      return { queries: { ...s.queries, [queryId]: { ...q, error: message, done: true } } };
    }),

  setActive: (id) => set({ activeId: id }),

  markSeen: () =>
    set((s) => {
      if (!s.unseenVoice && !Object.values(s.queries).some((q) => q.unseen)) return s;
      const queries: Record<string, RecallQuery> = {};
      for (const [k, q] of Object.entries(s.queries)) queries[k] = q.unseen ? { ...q, unseen: false } : q;
      return { queries, unseenVoice: 0 };
    }),

  clear: () => set({ queries: {}, order: [], activeId: null, unseenVoice: 0 }),
}));
