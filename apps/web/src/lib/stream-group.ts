import type { Category, ThoughtView } from "@synapse/shared";

/* ============================================================================
 * Live stream model: transcribed fragments grouped into the thought the stitcher assigned them to.
 * Pure function so the "snap together" behaviour is unit-tested.
 *
 *  - every thought is one group; its fragments are the stitched utterances in speaking order
 *  - a locally-sent fragment shows up IMMEDIATELY as "pending" (before the server acks it) and is
 *    absorbed into its thought group the moment the thought carries its id
 *  - pause gaps are the silence between consecutive fragments of the same group
 *  - filtered asides never become groups: they only feed a counter (plus a short-lived ghost line)
 * ========================================================================== */

export interface PendingFragment {
  id: string;
  text: string;
  whisper: boolean;
  pauseBeforeMs: number;
  tStart: number;
  tEnd: number;
  /** client clock when it was sent */
  sentAt: number;
}

export interface GhostFragment {
  id: string;
  text: string;
  at: number;
}

export interface StreamFragment {
  id: string;
  text: string;
  whisper: boolean;
  /** silence before this fragment (0 for the first of a group) */
  gapBeforeMs: number;
  at: number;
  pending: boolean;
}

export interface StreamGroup {
  key: string;
  thoughtId: string | null;
  code?: string;
  category?: Category;
  title?: string;
  analyzing: boolean;
  provisional: boolean;
  fragments: StreamFragment[];
  startedAt: number;
  /** removal animation in progress (retracted / forgotten / purged) */
  fading?: string;
}

export const MIN_VISIBLE_GAP_MS = 300;

export interface StreamInput {
  /** oldest first */
  thoughts: ThoughtView[];
  pending: PendingFragment[];
  fading?: Record<string, string>;
  /** newest groups to keep */
  limit?: number;
}

export function buildStream({ thoughts, pending, fading = {}, limit = 24 }: StreamInput): StreamGroup[] {
  const inThought = new Set<string>();
  const groups: StreamGroup[] = [];

  for (const t of thoughts) {
    const frags = [...t.fragments].sort((a, b) => a.tStart - b.tStart);
    for (const f of frags) inThought.add(f.id);
    if (!frags.length) continue;
    const fragments: StreamFragment[] = frags.map((f, i) => {
      const prev = frags[i - 1];
      const tsGap = prev ? Math.max(0, f.tStart - prev.tEnd) : 0;
      const gap = i === 0 ? 0 : f.pauseBeforeMs > 0 ? f.pauseBeforeMs : tsGap;
      return { id: f.id, text: f.text, whisper: f.whisper, gapBeforeMs: gap, at: f.tEnd, pending: false };
    });
    groups.push({
      key: t.id,
      thoughtId: t.id,
      code: t.code,
      category: t.category,
      title: t.provisional && !t.title ? undefined : t.title,
      analyzing: Boolean(t.analyzing),
      provisional: t.provisional,
      fragments,
      startedAt: t.createdAt,
      fading: fading[t.id],
    });
  }

  const loose = pending.filter((p) => !inThought.has(p.id)).sort((a, b) => a.tStart - b.tStart);
  if (loose.length) {
    groups.push({
      key: "pending",
      thoughtId: null,
      analyzing: true,
      provisional: true,
      startedAt: loose[0]?.tStart ?? Date.now(),
      fragments: loose.map((p, i) => ({
        id: p.id,
        text: p.text,
        whisper: p.whisper,
        gapBeforeMs: i === 0 ? 0 : p.pauseBeforeMs,
        at: p.tEnd,
        pending: true,
      })),
    });
  }

  // newest first. Thought groups sort by creation; the pending group is always the newest.
  groups.sort((a, b) => {
    if (a.key === "pending") return -1;
    if (b.key === "pending") return 1;
    return b.startedAt - a.startedAt;
  });
  return groups.slice(0, limit);
}

/** Total fragment count across groups (used for "N fragments, M thoughts"). */
export function countFragments(groups: StreamGroup[]): number {
  return groups.reduce((n, g) => n + g.fragments.length, 0);
}
