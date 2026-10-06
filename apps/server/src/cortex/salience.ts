import { ACTIONABLE_CATEGORIES } from "@synapse/shared";
import { dot, type Embedder } from "../memory/embeddings";
import type { MemoryStore } from "../memory/store";
import type { ThoughtRec } from "../memory/types";
import { T } from "../thresholds";

/* ============================================================================
 * Implicit promotion by speech patterns (PRD MEM-2, TRD §8.2).
 * Working memory forgets after 72 h. A thought is promoted to long-term memory by signals in
 * HOW it was said, not by a command. Every contribution is named so "why kept" is explainable.
 * ========================================================================== */

export interface Salience {
  score: number;
  reasons: string[];
  repeats: number;
}

export function computeSalience(store: MemoryStore, embedder: Embedder, t: ThoughtRec, opts: { revisited?: boolean; emphasisFromAudio?: boolean } = {}): Salience {
  let s = 0;
  const reasons: string[] = [];

  if (t.salienceCues.includes("explicit_remember")) {
    s += 0.6;
    reasons.push('said "note to self" / remember');
  }
  if (ACTIONABLE_CATEGORIES.includes(t.category)) {
    s += 0.4;
    reasons.push(`actionable (${t.category})`);
  }
  if (t.salienceCues.includes("deadline")) {
    s += 0.15;
    reasons.push("has a deadline");
  }
  if (t.salienceCues.includes("commitment")) {
    s += 0.1;
    reasons.push("a commitment");
  }

  // rehearsal: the same thought, again (another thread, within the working window)
  let repeats = 0;
  for (const o of store.thoughts.values()) {
    if (o.id === t.id || !store.isRecallable(o) || o.provisional) continue;
    if (t.createdAt - o.createdAt > store.ttlMs || o.createdAt > t.createdAt) continue;
    const sameConcern = t.concernKey && o.concernKey && t.concernKey === o.concernKey;
    const sim = Math.max(0, embedder.calibrate(dot(t.emb, o.emb)));
    if (sameConcern || sim >= T.repeat) repeats++;
  }
  if (repeats > 0) {
    s += Math.min(0.6, 0.3 * repeats);
    reasons.push(`repeated ${repeats + 1}×`);
  }

  const anchored = t.entityIds.some((id) => (store.entities.get(id)?.longTerm ?? 0) > 0);
  if (anchored) {
    s += 0.2;
    reasons.push("anchored to a known entity");
  }
  if (opts.emphasisFromAudio || t.salienceCues.includes("emphasis")) {
    s += 0.1;
    reasons.push("said with emphasis");
  }
  if (opts.revisited) {
    s += 0.3;
    reasons.push("revisited later");
  }
  if (t.tentative) s *= 0.7;
  return { score: Math.min(1.5, s), reasons, repeats };
}
