import type { Embedder } from "../memory/embeddings";
import type { MemoryStore } from "../memory/store";
import type { ThoughtRec } from "../memory/types";
import { entitiesInText, searchEntities, searchThoughts } from "../recall/search";
import { T } from "../thresholds";
import { chronoRange } from "../recall/time";
import { quickTitle } from "../text";
import type { Candidate, RecentThought } from "./types";

/* ============================================================================
 * Reference resolution (TRD §6.10): build the candidate set the model resolves
 * "that thing", "that bug from yesterday", "what Sarah said" against.
 *   (a) hybrid search over memory   (b) entities mentioned in the text / recently
 *   (c) open loops                  (d) temporal anchors ("from yesterday")
 * The model picks a candidate or null; ambiguity is detected from score margins.
 * ========================================================================== */

export interface ResolveArgs {
  text: string;
  emb: Float32Array;
  now: number;
  timezone: string;
  exclude: Set<string>;
  deviceKind: "desk" | "pocket";
}

const snippetOf = (t: ThoughtRec): string => `${t.title}${t.intent && t.intent !== t.title ? " — " + t.intent : ""}`.slice(0, 200);

export function buildCandidates(store: MemoryStore, embedder: Embedder, a: ResolveArgs): Candidate[] {
  const out: Candidate[] = [];

  // (d) a temporal anchor narrows the search to that window
  const range = chronoRange(a.text, a.now, a.timezone);
  const narrowed = range
    ? searchThoughts(store, embedder, { query: a.text, qEmb: a.emb, now: a.now, from: range.from, to: range.to, exclude: a.exclude, limit: 4, minScore: T.refCandidateMin })
    : [];
  const open = searchThoughts(store, embedder, { query: a.text, qEmb: a.emb, now: a.now, exclude: a.exclude, limit: 6, minScore: T.refCandidateMin });

  const seen = new Set<string>();
  for (const h of [...narrowed, ...open]) {
    if (seen.has(h.thought.id)) continue;
    seen.add(h.thought.id);
    out.push({
      id: h.thought.id,
      ref: h.thought.code,
      kind: "thought",
      label: h.thought.title,
      snippet: snippetOf(h.thought),
      when: h.thought.createdAt,
      deviceKind: h.thought.deviceKind,
      activity: h.thought.activity,
      category: h.thought.category,
      score: h.score + (range && narrowed.includes(h) ? 0.1 : 0),
    });
  }

  // (b) entities named in the text, plus semantically close ones
  const named = new Set(entitiesInText(store, a.text).map((e) => e.id));
  for (const { entity, score } of searchEntities(store, embedder, a.emb, a.text, 4)) {
    out.push({
      id: entity.id,
      ref: entity.code,
      kind: "entity",
      label: entity.name,
      snippet: `${entity.type}${entity.aliases.length ? ", aka " + entity.aliases.slice(0, 2).join(", ") : ""}`,
      entityType: entity.type,
      score: named.has(entity.id) ? Math.max(score, 0.6) : score,
    });
  }

  // (c) unanswered open loops are things the speaker may be resolving right now
  for (const o of store.openLoops.values()) {
    if (o.status !== "open") continue;
    const th = store.thoughts.get(o.thoughtId);
    if (!th || a.exclude.has(th.id)) continue;
    out.push({ id: th.id, ref: `${th.code}`, kind: "open_loop", label: o.question, snippet: `open question: ${o.question}`, when: o.createdAt, deviceKind: th.deviceKind, score: 0.3 });
  }

  // best first, thoughts+entities capped so the prompt stays small
  const dedup = new Map<string, Candidate>();
  for (const c of out.sort((x, y) => y.score - x.score)) if (!dedup.has(c.ref + c.kind)) dedup.set(c.ref + c.kind, c);
  return [...dedup.values()].slice(0, 8);
}

/** Recent thoughts for continuity (same device first), newest last. */
export function recentThoughts(store: MemoryStore, deviceId: string, now: number, exclude: Set<string>, limit = 4): RecentThought[] {
  return [...store.thoughts.values()]
    .filter((t) => !exclude.has(t.id) && !t.provisional && now - t.createdAt < 15 * 60_000 && store.isRecallable(t))
    .sort((a, b) => (a.deviceId === deviceId ? 1 : 0) - (b.deviceId === deviceId ? 1 : 0) || a.createdAt - b.createdAt)
    .slice(-limit)
    .map((t) => ({ ref: t.code, title: t.title || quickTitle(t.intent), category: t.category, when: t.createdAt }));
}

/** Top-2 margin check: when two candidates are too close the UI shows "assuming you mean …". */
export function ambiguity(cands: Candidate[], resolvedRef: string | null): { assumed: boolean; alternative?: Candidate } {
  if (!resolvedRef) return { assumed: false };
  const same = cands.filter((c) => c.kind === "thought");
  const idx = same.findIndex((c) => c.ref === resolvedRef);
  if (idx < 0) return { assumed: false };
  const me = same[idx] as Candidate;
  const other = same.find((c, i) => i !== idx && Math.abs(c.score - me.score) <= T.refAmbiguityMargin);
  return other ? { assumed: true, alternative: other } : { assumed: false };
}
