import path from "node:path";
import { log } from "../log";

/* ============================================================================
 * Local embeddings (TRD §8.8). Two implementations behind one interface:
 *  - TransformersEmbedder: ONNX sentence model via @huggingface/transformers (CPU).
 *  - HashEmbedder: deterministic hashed word/char n-grams (offline fallback + tests).
 * Vectors are L2-normalized so cosine = dot product.
 * ========================================================================== */

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  /** "model" when the neural model is active, "hash" for the fallback. */
  readonly mode: "model" | "hash";
  embed(texts: string[], kind?: "query" | "passage"): Promise<Float32Array[]>;
  /** map a raw cosine into the calibrated 0..1 scale all thresholds assume */
  calibrate(cos: number): number;
}

export const DIM = 384;

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += (v[i] as number) * (v[i] as number);
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n;
  return v;
}

/** Mean of vectors, re-normalized. */
export function centroid(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs[0]?.length ?? DIM);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (v[i] as number);
  return normalize(out);
}

// ------------------------------------------------------------------- hash --

const STOP = new Set(
  "a an the and or but so to of in on at for with by from is are was were be been being it its this that these those i me my we our you your he she they them his her their as if then than do does did have has had not no yes um uh uhh hmm like just really very".split(
    " ",
  ),
);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter(Boolean);
}

export class HashEmbedder implements Embedder {
  readonly name = "hash-384";
  readonly dim = DIM;
  readonly mode = "hash" as const;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  calibrate(c: number): number {
    return c;
  }

  one(text: string): Float32Array {
    const v = new Float32Array(DIM);
    const toks = tokens(text);
    const content = toks.filter((t) => !STOP.has(t) && t.length > 1);
    const add = (feat: string, w: number): void => {
      const h = fnv1a(feat);
      const idx = h % DIM;
      const sign = (h >>> 16) & 1 ? 1 : -1;
      v[idx] = (v[idx] as number) + sign * w;
    };
    for (const t of content) {
      add(`w:${t}`, 1.0);
      // light stemming: share features across simple inflections
      const stem = t.replace(/(ing|ed|es|s|ly)$/, "");
      if (stem.length > 2 && stem !== t) add(`w:${stem}`, 0.7);
      // char trigrams give typo/inflection robustness
      const padded = `^${t}$`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`c:${padded.slice(i, i + 3)}`, 0.25);
    }
    for (let i = 0; i + 1 < content.length; i++) add(`b:${content[i]}_${content[i + 1]}`, 0.6);
    return normalize(v);
  }
}

// ----------------------------------------------------------- transformers --

type Extractor = (
  input: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export class TransformersEmbedder implements Embedder {
  readonly mode = "model" as const;
  dim = DIM;
  private extractor!: Extractor;
  private e5: boolean;

  private constructor(readonly name: string) {
    this.e5 = /e5/i.test(name);
  }

  static async create(model: string, cacheDir: string): Promise<TransformersEmbedder> {
    const self = new TransformersEmbedder(model);
    const tf = await import("@huggingface/transformers");
    tf.env.cacheDir = path.join(cacheDir, "models");
    tf.env.allowLocalModels = true;
    const pipe = await tf.pipeline("feature-extraction", model, { dtype: "q8" });
    self.extractor = pipe as unknown as Extractor;
    // warm: first call compiles the graph
    const probe = await self.extractor(["warm up"], { pooling: "mean", normalize: true });
    self.dim = probe.dims[probe.dims.length - 1] ?? DIM;
    return self;
  }

  calibrate(c: number): number {
    // e5 similarities live in ~0.70..1.0; stretch into 0..1 so shared thresholds hold.
    return this.e5 ? Math.max(0, Math.min(1, (c - 0.72) / 0.28)) : c;
  }

  async embed(texts: string[], kind: "query" | "passage" = "passage"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefixed = this.e5 ? texts.map((t) => `${kind}: ${t}`) : texts;
    const out = await this.extractor(prefixed, { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1] as number;
    const res: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) res.push(Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
    return res;
  }
}

export interface EmbedderOpts {
  mode: "model" | "hash";
  model: string;
  dataDir: string;
}

/** Never throws: falls back to the hash embedder if the model cannot load. */
export async function createEmbedder(opts: EmbedderOpts): Promise<Embedder> {
  if (opts.mode === "hash") return new HashEmbedder();
  try {
    const t0 = performance.now();
    const e = await TransformersEmbedder.create(opts.model, opts.dataDir);
    log.info("embed", `model ready`, { model: opts.model, dim: e.dim, ms: Math.round(performance.now() - t0) });
    return e;
  } catch (err) {
    log.error("embed", `model failed to load, using hash fallback: ${(err as Error).message}`);
    return new HashEmbedder();
  }
}
