import type { Activity, Category } from "@synapse/shared";
import { dot, type Embedder } from "../memory/embeddings";
import type { MemoryStore } from "../memory/store";
import type { EntityRec, ThoughtRec } from "../memory/types";
import { fold } from "../text";

/* ============================================================================
 * Hybrid retrieval over memory (TRD §7.3).
 * Research note: verbatim chunks beat LLM-extracted facts on lifelog data, so each thought
 * is scored with the BEST of its gist embedding and any of its verbatim fragments.
 *   score = 0.50·maxCos + 0.20·bm25 + 0.10·entityOverlap + 0.10·salience + 0.10·recency
 * ========================================================================== */

export interface SearchOpts {
  query: string;
  qEmb: Float32Array;
  now: number;
  from?: number;
  to?: number;
  activity?: Activity;
  device?: "desk" | "pocket";
  types?: Category[];
  /** person names the question is about */
  persons?: string[];
  exclude?: Set<string>;
  limit?: number;
  minScore?: number;
  /** also return thoughts that are still provisional (default true) */
  includeProvisional?: boolean;
}

export interface Hit {
  thought: ThoughtRec;
  score: number;
  parts: { vec: number; lex: number; ent: number; sal: number; rec: number };
  via: "gist" | "fragment";
  /** best-matching fragment text (for snippets) */
  fragmentText?: string;
}

const W = { vec: 0.5, lex: 0.2, ent: 0.1, sal: 0.1, rec: 0.1 };

/** Entities whose name or alias appears in the text (whole-word). */
export function entitiesInText(store: MemoryStore, text: string): EntityRec[] {
  const f = ` ${fold(text)} `;
  const out: EntityRec[] = [];
  for (const e of store.entities.values()) {
    const names = [e.name, ...e.aliases].map(fold).filter((n) => n.length >= 3);
    if (names.some((n) => f.includes(` ${n} `) || f.includes(` ${n}s `))) out.push(e);
  }
  return out;
}

export function searchThoughts(store: MemoryStore, embedder: Embedder, o: SearchOpts): Hit[] {
  const limit = o.limit ?? 8;
  const minScore = o.minScore ?? 0.2;
  const cal = (c: number): number => Math.max(0, embedder.calibrate(c));

  const gist = new Map<string, number>();
  for (const h of store.thoughtVec.search(o.qEmb, 80)) gist.set(h.id, cal(h.score));

  const fragBest = new Map<string, { s: number; text: string }>();
  for (const h of store.fragVec.search(o.qEmb, 160)) {
    const f = store.frags.get(h.id);
    if (!f) continue;
    const s = cal(h.score);
    const cur = fragBest.get(f.thoughtId);
    if (!cur || s > cur.s) fragBest.set(f.thoughtId, { s, text: f.text });
  }

  const lex = new Map<string, number>();
  for (const h of store.lex.search(o.query, 80)) lex.set(h.id, h.score);

  const ids = new Set<string>([...gist.keys(), ...fragBest.keys(), ...lex.keys()]);
  const qEntities = new Set(entitiesInText(store, o.query).map((e) => e.id));
  const personFilter = (o.persons ?? []).map(fold).filter(Boolean);

  const hits: Hit[] = [];
  for (const id of ids) {
    const t = store.thoughts.get(id);
    if (!t || o.exclude?.has(id) || !store.isRecallable(t)) continue;
    if (o.includeProvisional === false && t.provisional) continue;
    if (o.from !== undefined && t.createdAt < o.from) continue;
    if (o.to !== undefined && t.createdAt > o.to) continue;
    if (o.activity && t.activity !== o.activity) continue;
    if (o.device && t.deviceKind !== o.device) continue;
    if (o.types?.length && !o.types.includes(t.category)) continue;

    const g = gist.get(id) ?? 0;
    const fr = fragBest.get(id);
    const vec = Math.max(g, fr?.s ?? 0);
    const lx = lex.get(id) ?? 0;

    let ent = 0;
    if (qEntities.size) {
      const mine = new Set(t.entityIds);
      let n = 0;
      for (const q of qEntities) if (mine.has(q)) n++;
      ent = n / qEntities.size;
    }
    if (personFilter.length) {
      const names = t.entityIds.map((e) => fold(store.entities.get(e)?.name ?? ""));
      const inText = fold(`${t.title} ${t.intent}`);
      const ok = personFilter.some((p) => names.some((n) => n.includes(p)) || inText.includes(p));
      if (!ok) continue;
      ent = Math.max(ent, 1);
    }
    const sal = Math.min(1, t.salience);
    const rec = Math.exp(-(o.now - t.createdAt) / (72 * 3600_000));
    const score = W.vec * vec + W.lex * lx + W.ent * ent + W.sal * sal + W.rec * rec;
    if (score < minScore) continue;
    hits.push({
      thought: t,
      score,
      parts: { vec, lex: lx, ent, sal, rec },
      via: fr && fr.s >= g ? "fragment" : "gist",
      fragmentText: fr?.text,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Score entities against a query embedding (used for reference candidates like "Sarah"). */
export function searchEntities(store: MemoryStore, embedder: Embedder, qEmb: Float32Array, text: string, limit = 4): Array<{ entity: EntityRec; score: number }> {
  const inText = new Set(entitiesInText(store, text).map((e) => e.id));
  const out: Array<{ entity: EntityRec; score: number }> = [];
  for (const e of store.entities.values()) {
    const cos = Math.max(0, embedder.calibrate(dot(qEmb, e.emb)));
    const score = inText.has(e.id) ? Math.max(0.6, cos) : cos * 0.6;
    if (score >= 0.3) out.push({ entity: e, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
