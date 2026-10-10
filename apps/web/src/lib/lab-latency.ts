import { percentile, type LatencySummary, type StageStats } from "@synapse/shared";
import type { Tone } from "@/lib/format";
import type { LatencyRowView } from "@/net/api-types";

/* ============================================================================
 * Lab: latency stages, PRD targets, histogram bucketing and gauge scaling. Pure, so it is unit-tested.
 * Stage names and their meaning mirror apps/server/src/metrics/latency.ts; the targets are PRD §8
 * ("Success metrics") and TRD §6.1 (first draft within ~80 ms of the fragment reaching the server).
 * ========================================================================== */

export type StageKey = "wispr" | "toServer" | "triage" | "firstPaint" | "llmFirstField" | "cortex" | "artifact" | "speechToArtifact" | "pause";

/** good = within target, ok = up to 25 % over (amber), bad = more than that (red), none = no target for this stage. */
export type TargetTone = Tone | "none";

/** amber band: a value up to this multiple of its limit is "close", beyond is "over target" */
export const TARGET_MARGIN = 1.25;

export interface StageTarget {
  p50?: number;
  p95?: number;
  /** prd = a number the PRD promises; budget = an internal design budget (TRD) */
  basis: "prd" | "budget";
}

export interface StageDef {
  key: StageKey;
  label: string;
  /** "from → to" in plain words */
  span: string;
  /** one sentence a judge can read */
  blurb: string;
  /** an end-to-end number the user feels (vs. an internal pipeline stage) */
  feel: boolean;
  target?: StageTarget;
  /** shown when there are no samples yet */
  empty: string;
}

export const STAGE_DEFS: readonly StageDef[] = [
  {
    key: "wispr",
    label: "Speech transcription",
    span: "commit sent → final text",
    blurb: "How long the speech engine (Wispr Flow, or Whisper on this machine when it is the on-device engine) takes to turn the sentence into text after you pause. Its own clock, reported as measured.",
    feel: false,
    empty: "Appears once a spoken fragment has been transcribed.",
  },
  {
    key: "toServer",
    label: "Device → server",
    span: "final text → server receipt",
    blurb: "The network hop from your device to the Synapse server (clock-corrected).",
    feel: false,
    empty: "Needs a device with a synced clock (a paired phone or this browser).",
  },
  {
    key: "triage",
    label: "Instant triage",
    span: "server receipt → first draft card",
    blurb: "Embedding plus on-device triage: a first draft is painted before the model has answered.",
    feel: false,
    target: { p50: 80, basis: "budget" },
    empty: "Appears with the first fragment.",
  },
  {
    key: "firstPaint",
    label: "First paint",
    span: "final text → first card on screen",
    blurb: "The draft card shows up almost immediately and then morphs as the model fills it in.",
    feel: true,
    target: { p50: 600, p95: 1000, basis: "prd" },
    empty: "Appears with the first fragment.",
  },
  {
    key: "llmFirstField",
    label: "Model: first field",
    span: "model call start → first field",
    blurb: "Streaming: how soon the first structured field arrives, which is what the card starts to fill from.",
    feel: false,
    empty: "Needs a streaming model call (the mock cortex does not stream).",
  },
  {
    key: "cortex",
    label: "Cortex (model call)",
    span: "model call start → done",
    blurb: "The whole model call that reads the thought and drafts the artifact.",
    feel: false,
    empty: "Appears once the cortex has processed a fragment.",
  },
  {
    key: "artifact",
    label: "Finished card",
    span: "final text → artifact on screen",
    blurb: "The headline number: from final text to a complete, rendered artifact.",
    feel: true,
    target: { p50: 1000, p95: 1600, basis: "prd" },
    empty: "Appears once a card has been finished and rendered.",
  },
  {
    key: "speechToArtifact",
    label: "Speech → finished card",
    span: "end of speech → artifact on screen",
    blurb: "Everything you actually wait for, Wispr included.",
    feel: true,
    target: { p50: 1600, basis: "prd" },
    empty: "Needs a spoken fragment with a synced clock (typed input has no speech end).",
  },
  {
    key: "pause",
    label: "Pause → mic released",
    span: "end of “pause memory” → mic off",
    blurb: "The privacy kill-switch: how fast the microphone is physically released.",
    feel: true,
    target: { p95: 1000, basis: "prd" },
    empty: "Say “pause memory” once to measure it.",
  },
];

const BY_KEY = new Map<StageKey, StageDef>(STAGE_DEFS.map((d) => [d.key, d]));

export function stageDef(key: StageKey): StageDef {
  return BY_KEY.get(key) as StageDef;
}

// ------------------------------------------------------------------ targets --

/** green within the limit, amber up to `margin` × the limit, red beyond; none without a value or a limit. */
export function toneAgainst(value: number | undefined | null, limit: number | undefined, margin: number = TARGET_MARGIN): TargetTone {
  if (value === undefined || value === null || !Number.isFinite(value) || limit === undefined) return "none";
  if (value <= limit) return "good";
  return value <= limit * margin ? "ok" : "bad";
}

const RANK: Record<TargetTone, number> = { none: 0, good: 1, ok: 2, bad: 3 };

/** the most severe of several verdicts (none when there is nothing to judge) */
export function worstTone(...tones: Array<TargetTone | undefined>): TargetTone {
  let out: TargetTone = "none";
  for (const t of tones) if (t && RANK[t] > RANK[out]) out = t;
  return out;
}

export interface StageVerdict {
  p50: TargetTone;
  p95: TargetTone;
  overall: TargetTone;
}

export function evaluateStage(def: StageDef, stats: Pick<StageStats, "p50" | "p95"> | undefined | null): StageVerdict {
  const t = def.target;
  const p50 = t && stats ? toneAgainst(stats.p50, t.p50) : "none";
  const p95 = t && stats ? toneAgainst(stats.p95, t.p95) : "none";
  return { p50, p95, overall: worstTone(p50, p95) };
}

/** a latency split into number and unit for big-figure typography: 66 → 66 + "ms", 1207 → "1.21" + "s" */
export function splitMs(ms: number | undefined | null): { num: string; unit: string } {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return { num: "–", unit: "" };
  const r = Math.round(ms);
  if (r < 1000) return { num: String(r), unit: "ms" };
  return { num: (ms / 1000).toFixed(ms < 10_000 ? 2 : 1), unit: "s" };
}

function fmtLimit(ms: number): string {
  return ms >= 1000 ? `${trimZero((ms / 1000).toFixed(2))} s` : `${ms} ms`;
}

/** "p50 ≤ 600 ms · p95 ≤ 1 s" */
export function targetText(t: StageTarget | undefined): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.p50 !== undefined) parts.push(`p50 ≤ ${fmtLimit(t.p50)}`);
  if (t.p95 !== undefined) parts.push(`p95 ≤ ${fmtLimit(t.p95)}`);
  return parts.join(" · ");
}

/** the stricter of the two limits: where the histogram draws its target line */
export function strictLimit(t: StageTarget | undefined): number | undefined {
  if (!t) return undefined;
  if (t.p95 !== undefined && t.p50 !== undefined) return Math.min(t.p95, t.p50);
  return t.p95 ?? t.p50;
}

/** the limit that matters for the p95 marker (falls back to p50's when only that exists) */
export function p95Limit(t: StageTarget | undefined): number | undefined {
  return t?.p95 ?? t?.p50;
}

// ---------------------------------------------------------------- summaries --

export function summarize(values: readonly number[]): StageStats | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0);
  if (v.length === 0) return null;
  return { n: v.length, p50: Math.round(percentile(v, 50)), p95: Math.round(percentile(v, 95)), max: Math.round(Math.max(...v)) };
}

/** the fresher of two summaries (the live websocket one vs. the REST one) */
export function freshestSummary(a: LatencySummary | null | undefined, b: LatencySummary | null | undefined): LatencySummary | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** every finite, non-negative per-fragment value of one stage */
export function valuesFor(rows: readonly Pick<LatencyRowView, "stages">[], key: StageKey): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r.stages[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- histogram --

/**
 * Log-ish bucket edges in ms. Bucket 0 is [0, 10), bucket i is [edges[i-1], edges[i]) and the last one is [5 s, ∞).
 * The PRD targets (600 ms, 1 s, 1.6 s) sit exactly on edges so a target line never cuts a bar in half.
 */
export const HIST_EDGES: readonly number[] = [10, 25, 50, 100, 200, 300, 450, 600, 800, 1000, 1300, 1600, 2000, 3000, 5000];
export const HIST_BUCKETS = HIST_EDGES.length + 1;

export function bucketIndex(ms: number): number {
  for (let i = 0; i < HIST_EDGES.length; i++) if (ms < (HIST_EDGES[i] as number)) return i;
  return HIST_EDGES.length;
}

export function histogram(values: readonly number[]): number[] {
  const counts = new Array<number>(HIST_BUCKETS).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) continue;
    counts[bucketIndex(v)] = (counts[bucketIndex(v)] as number) + 1;
  }
  return counts;
}

export function bucketRange(i: number): { lo: number; hi: number } {
  const lo = i <= 0 ? 0 : (HIST_EDGES[Math.min(i, HIST_EDGES.length) - 1] as number);
  const hi = i < HIST_EDGES.length ? (HIST_EDGES[i] as number) : Number.POSITIVE_INFINITY;
  return { lo, hi };
}

function trimZero(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** "10 ms" | "1 s" | "1.3 s" */
export function edgeLabel(ms: number): string {
  return ms >= 1000 ? `${trimZero((ms / 1000).toFixed(1))} s` : `${Math.round(ms)} ms`;
}

/** "<10 ms" | "200–300 ms" | "800 ms–1 s" | "1.3–1.6 s" | "5 s+" */
export function bucketLabel(i: number): string {
  const { lo, hi } = bucketRange(i);
  if (i <= 0) return `<${edgeLabel(hi)}`;
  if (!Number.isFinite(hi)) return `${edgeLabel(lo)}+`;
  const a = edgeLabel(lo);
  const b = edgeLabel(hi);
  const unitA = a.endsWith(" ms") ? "ms" : "s";
  const unitB = b.endsWith(" ms") ? "ms" : "s";
  return unitA === unitB ? `${a.replace(/ (ms|s)$/, "")}–${b}` : `${a}–${b}`;
}

/**
 * Where a value sits on the bucket axis, 0..HIST_BUCKETS: the bucket index plus the linear fraction inside it
 * (the open last bucket is treated as [5 s, 10 s]). Used for the p50/p95/max markers under the bars.
 */
export function axisPosition(ms: number): number {
  const v = Math.max(0, ms);
  const i = bucketIndex(v);
  const { lo, hi } = bucketRange(i);
  const top = Number.isFinite(hi) ? hi : lo * 2;
  return i + Math.min(1, Math.max(0, (v - lo) / (top - lo)));
}

/** position of a limit on the bucket axis (exactly the boundary when the limit is an edge) */
export function boundaryPosition(limitMs: number): number {
  const at = HIST_EDGES.indexOf(limitMs);
  return at >= 0 ? at + 1 : axisPosition(limitMs);
}

/**
 * Bar height as a fraction 0..1 of the tallest bucket. A non-empty bucket never drops below `floor`, so a lone
 * sample stays visible (an empty bucket is exactly 0).
 */
export function scaleBar(count: number, max: number, floor = 0.14): number {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.min(1, Math.max(floor, count / max));
}

/** one sentence for screen readers: "12 fragments: 9 under 100 ms, 3 between 100 ms and 1 s ..." */
export function describeHistogram(counts: readonly number[]): string {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return "No samples";
  let fast = 0;
  let mid = 0;
  let slow = 0;
  counts.forEach((c, i) => {
    const { hi } = bucketRange(i);
    if (hi <= 100) fast += c;
    else if (hi <= 1000) mid += c;
    else slow += c;
  });
  const parts: string[] = [];
  if (fast) parts.push(`${fast} under 100 ms`);
  if (mid) parts.push(`${mid} from 100 ms to 1 s`);
  if (slow) parts.push(`${slow} over 1 s`);
  return `${total} ${total === 1 ? "sample" : "samples"}: ${parts.join(", ")}`;
}

// -------------------------------------------------------------------- gauge --

const NICE_MAX = [1000, 1500, 2000, 3000, 4000, 5000, 7500, 10_000, 15_000, 30_000, 60_000];

/** a round axis maximum that holds every value with a little air on top (never below 1 s) */
export function gaugeMax(...values: Array<number | undefined>): number {
  const need = Math.max(0, ...values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))) * 1.08;
  return NICE_MAX.find((n) => n >= need) ?? Math.ceil(need / 10_000) * 10_000;
}

/** 0..1 position of a value on a 0..max axis */
export function gaugePos(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

export function gaugeTicks(max: number): number[] {
  const step = max <= 2000 ? 500 : max <= 5000 ? 1000 : max <= 10_000 ? 2000 : 10_000;
  const out: number[] = [];
  for (let v = 0; v <= max + 0.001; v += step) out.push(v);
  return out;
}

// -------------------------------------------------------------------- trace --

export interface TracePoint {
  id: string;
  value: number;
  at: number;
  transport: string;
  source?: string;
  model?: string;
}

/** the last `limit` fragments that have a value for this stage, oldest first */
export function traceSeries(rows: readonly LatencyRowView[], key: StageKey, limit = 48): TracePoint[] {
  const out: TracePoint[] = [];
  for (const r of rows) {
    const v = r.stages[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    out.push({ id: r.fragmentId, value: v, at: r.createdAt, transport: r.transport, source: r.source, model: r.model });
  }
  return out.slice(-limit);
}

/** vertical axis for the trace: holds the target line and the tallest bar, clipped to `cap` */
export function traceMax(values: readonly number[], target: number | undefined, cap = 5000): number {
  const top = Math.max(target ? target * 1.25 : 0, ...values.filter((v) => Number.isFinite(v)), 100);
  return Math.min(cap, top);
}

export interface ModelMix {
  /** model calls that went to a live model */
  live: number;
  /** of those, the ones that reused cached prompt tokens */
  cacheHits: number;
  /** model ids by frequency */
  models: Array<{ model: string; n: number }>;
}

export function modelMix(rows: readonly Pick<LatencyRowView, "model" | "source" | "cachedTokens">[]): ModelMix {
  const counts = new Map<string, number>();
  let live = 0;
  let cacheHits = 0;
  for (const r of rows) {
    if (r.model) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
    if (r.source === "llm") {
      live++;
      if ((r.cachedTokens ?? 0) > 0) cacheHits++;
    }
  }
  const models = [...counts.entries()].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
  return { live, cacheHits, models };
}
