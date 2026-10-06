import MiniSearch from "minisearch";
import { DIM } from "./embeddings";

/** Brute-force cosine index over L2-normalized vectors (measured: 20k × 384 ≈ 11 ms/query). */
export class VecIndex {
  private ids: string[] = [];
  private rowOf = new Map<string, number>();
  private mat: Float32Array;
  private cap: number;

  constructor(
    readonly dim: number = DIM,
    capacity = 1024,
  ) {
    this.cap = capacity;
    this.mat = new Float32Array(this.cap * dim);
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.rowOf.has(id);
  }

  upsert(id: string, v: Float32Array): void {
    if (v.length !== this.dim) throw new Error(`vector dim ${v.length} != index dim ${this.dim}`);
    let row = this.rowOf.get(id);
    if (row === undefined) {
      if (this.ids.length >= this.cap) this.grow();
      row = this.ids.length;
      this.ids.push(id);
      this.rowOf.set(id, row);
    }
    this.mat.set(v, row * this.dim);
  }

  remove(id: string): void {
    const row = this.rowOf.get(id);
    if (row === undefined) return;
    const last = this.ids.length - 1;
    if (row !== last) {
      const lastId = this.ids[last] as string;
      this.mat.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim);
      this.ids[row] = lastId;
      this.rowOf.set(lastId, row);
    }
    this.ids.pop();
    this.rowOf.delete(id);
  }

  get(id: string): Float32Array | undefined {
    const row = this.rowOf.get(id);
    return row === undefined ? undefined : this.mat.slice(row * this.dim, (row + 1) * this.dim);
  }

  /** Top-k by cosine. `accept` filters ids before they enter the heap. */
  search(q: Float32Array, k: number, accept?: (id: string) => boolean, minScore = -1): Array<{ id: string; score: number }> {
    const out: Array<{ id: string; score: number }> = [];
    const dim = this.dim;
    const n = this.ids.length;
    for (let r = 0; r < n; r++) {
      const id = this.ids[r] as string;
      if (accept && !accept(id)) continue;
      let s = 0;
      const base = r * dim;
      for (let i = 0; i < dim; i++) s += (q[i] as number) * (this.mat[base + i] as number);
      if (s < minScore) continue;
      if (out.length < k) {
        out.push({ id, score: s });
        if (out.length === k) out.sort((a, b) => a.score - b.score);
      } else if (s > (out[0] as { score: number }).score) {
        out[0] = { id, score: s };
        out.sort((a, b) => a.score - b.score);
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Cosine of the query against one stored id. */
  score(q: Float32Array, id: string): number {
    const row = this.rowOf.get(id);
    if (row === undefined) return -1;
    let s = 0;
    const base = row * this.dim;
    for (let i = 0; i < this.dim; i++) s += (q[i] as number) * (this.mat[base + i] as number);
    return s;
  }

  clear(): void {
    this.ids = [];
    this.rowOf.clear();
  }

  private grow(): void {
    this.cap *= 2;
    const bigger = new Float32Array(this.cap * this.dim);
    bigger.set(this.mat.subarray(0, this.ids.length * this.dim));
    this.mat = bigger;
  }
}

/** Light suffix stripper so "caching", "cached" and "cache" meet in the keyword index. */
export function stem(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** In-memory BM25-ish keyword index (never persisted: ciphertext cannot be searched). */
export class LexIndex {
  private ms = new MiniSearch<{ id: string; text: string; title: string }>({
    fields: ["text", "title"],
    storeFields: [],
    idField: "id",
    searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.2 },
    processTerm: (t) => {
      const term = stem(t.toLowerCase());
      return term.length < 2 ? null : term;
    },
  });
  private ids = new Set<string>();

  upsert(id: string, title: string, text: string): void {
    if (this.ids.has(id)) this.ms.discard(id);
    this.ms.add({ id, title, text });
    this.ids.add(id);
  }

  remove(id: string): void {
    if (!this.ids.has(id)) return;
    this.ms.discard(id);
    this.ids.delete(id);
  }

  /** Returns scores normalized to 0..1 (by the top hit). */
  search(query: string, limit = 50): Array<{ id: string; score: number }> {
    if (!query.trim()) return [];
    const hits = this.ms.search(query, { combineWith: "OR" }).slice(0, limit);
    const top = hits[0]?.score ?? 1;
    return hits.map((h) => ({ id: String(h.id), score: h.score / (top || 1) }));
  }

  get size(): number {
    return this.ids.size;
  }

  clear(): void {
    this.ms.removeAll();
    this.ids.clear();
  }
}
