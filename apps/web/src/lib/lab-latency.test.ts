import { describe, expect, it } from "vitest";
import {
  HIST_BUCKETS,
  HIST_EDGES,
  STAGE_DEFS,
  axisPosition,
  boundaryPosition,
  bucketIndex,
  bucketLabel,
  bucketRange,
  describeHistogram,
  edgeLabel,
  evaluateStage,
  freshestSummary,
  gaugeMax,
  gaugePos,
  gaugeTicks,
  histogram,
  modelMix,
  p95Limit,
  scaleBar,
  splitMs,
  stageDef,
  strictLimit,
  summarize,
  targetText,
  toneAgainst,
  traceMax,
  traceSeries,
  valuesFor,
  worstTone,
} from "./lab-latency";
import type { LatencyRowView } from "@/net/api-types";

const row = (id: string, stages: Record<string, number>, extra: Partial<LatencyRowView> = {}): LatencyRowView => ({
  fragmentId: id,
  deviceId: "d1",
  transport: "mock",
  createdAt: 1000,
  stages,
  ...extra,
});

describe("stage catalogue", () => {
  it("has every stage the server reports, once, each with a plain-language description", () => {
    const keys = STAGE_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["wispr", "toServer", "triage", "firstPaint", "llmFirstField", "cortex", "artifact", "speechToArtifact", "pause"]);
    for (const d of STAGE_DEFS) {
      expect(d.blurb.length).toBeGreaterThan(20);
      expect(d.span).toContain("→");
    }
  });

  it("carries the PRD targets", () => {
    expect(stageDef("firstPaint").target).toMatchObject({ p50: 600, p95: 1000, basis: "prd" });
    expect(stageDef("artifact").target).toMatchObject({ p50: 1000, p95: 1600 });
    expect(stageDef("speechToArtifact").target).toMatchObject({ p50: 1600 });
    expect(stageDef("pause").target).toMatchObject({ p95: 1000 });
    expect(stageDef("wispr").target).toBeUndefined();
  });
});

describe("targets", () => {
  it("is green within the limit, amber up to 25% over, red beyond", () => {
    expect(toneAgainst(600, 600)).toBe("good");
    expect(toneAgainst(601, 600)).toBe("ok");
    expect(toneAgainst(750, 600)).toBe("ok");
    expect(toneAgainst(751, 600)).toBe("bad");
  });

  it("has no verdict without a value or a limit", () => {
    expect(toneAgainst(undefined, 600)).toBe("none");
    expect(toneAgainst(NaN, 600)).toBe("none");
    expect(toneAgainst(100, undefined)).toBe("none");
  });

  it("picks the most severe verdict", () => {
    expect(worstTone("good", "ok")).toBe("ok");
    expect(worstTone("ok", "bad", "good")).toBe("bad");
    expect(worstTone("none", "good")).toBe("good");
    expect(worstTone()).toBe("none");
    expect(worstTone(undefined, "none")).toBe("none");
  });

  it("judges p50 and p95 separately and reports the worst", () => {
    const artifact = stageDef("artifact");
    expect(evaluateStage(artifact, { p50: 66, p95: 1207 })).toEqual({ p50: "good", p95: "good", overall: "good" });
    expect(evaluateStage(artifact, { p50: 1100, p95: 1500 })).toEqual({ p50: "ok", p95: "good", overall: "ok" });
    expect(evaluateStage(artifact, { p50: 900, p95: 2500 })).toEqual({ p50: "good", p95: "bad", overall: "bad" });
    // pause only has a p95 target
    expect(evaluateStage(stageDef("pause"), { p50: 5000, p95: 900 })).toEqual({ p50: "none", p95: "good", overall: "good" });
  });

  it("has no verdict for stages without a target or without samples", () => {
    expect(evaluateStage(stageDef("wispr"), { p50: 9999, p95: 9999 }).overall).toBe("none");
    expect(evaluateStage(stageDef("artifact"), undefined).overall).toBe("none");
  });

  it("prints targets the way the PRD writes them", () => {
    expect(targetText(stageDef("firstPaint").target)).toBe("p50 ≤ 600 ms · p95 ≤ 1 s");
    expect(targetText(stageDef("artifact").target)).toBe("p50 ≤ 1 s · p95 ≤ 1.6 s");
    expect(targetText(stageDef("pause").target)).toBe("p95 ≤ 1 s");
    expect(targetText(stageDef("triage").target)).toBe("p50 ≤ 80 ms");
    expect(targetText(undefined)).toBe("");
  });

  it("splits a latency into figure and unit", () => {
    expect(splitMs(66)).toEqual({ num: "66", unit: "ms" });
    expect(splitMs(66.6)).toEqual({ num: "67", unit: "ms" });
    expect(splitMs(999.4)).toEqual({ num: "999", unit: "ms" });
    expect(splitMs(1207)).toEqual({ num: "1.21", unit: "s" });
    expect(splitMs(12_500)).toEqual({ num: "12.5", unit: "s" });
    expect(splitMs(undefined)).toEqual({ num: "–", unit: "" });
    expect(splitMs(NaN)).toEqual({ num: "–", unit: "" });
  });

  it("finds the limit a histogram draws its line at", () => {
    expect(strictLimit(stageDef("firstPaint").target)).toBe(600);
    expect(strictLimit(stageDef("pause").target)).toBe(1000);
    expect(strictLimit(undefined)).toBeUndefined();
    expect(p95Limit(stageDef("firstPaint").target)).toBe(1000);
    expect(p95Limit(stageDef("speechToArtifact").target)).toBe(1600);
  });
});

describe("summaries", () => {
  it("computes n / p50 / p95 / max with nearest-rank percentiles", () => {
    const v = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
    expect(summarize(v)).toEqual({ n: 20, p50: 100, p95: 190, max: 200 });
  });

  it("ignores junk and returns null when nothing is left", () => {
    expect(summarize([NaN, -5, Infinity])).toBeNull();
    expect(summarize([])).toBeNull();
    expect(summarize([42, NaN])).toEqual({ n: 1, p50: 42, p95: 42, max: 42 });
  });

  it("picks the fresher of two summaries", () => {
    const a = { n: 1, stages: {}, updatedAt: 10 };
    const b = { n: 2, stages: {}, updatedAt: 20 };
    expect(freshestSummary(a, b)).toBe(b);
    expect(freshestSummary(b, a)).toBe(b);
    expect(freshestSummary(null, a)).toBe(a);
    expect(freshestSummary(a, undefined)).toBe(a);
    expect(freshestSummary(null, null)).toBeNull();
  });

  it("collects the finite per-fragment values of one stage", () => {
    const rows = [row("a", { artifact: 100 }), row("b", { artifact: NaN, firstPaint: 5 }), row("c", { artifact: -3 }), row("d", { artifact: 0 }), row("e", {})];
    expect(valuesFor(rows, "artifact")).toEqual([100, 0]);
    expect(valuesFor(rows, "firstPaint")).toEqual([5]);
    expect(valuesFor(rows, "pause")).toEqual([]);
  });
});

describe("histogram bucketing", () => {
  it("uses edges that include the PRD targets", () => {
    for (const t of [600, 1000, 1600]) expect(HIST_EDGES).toContain(t);
    expect(HIST_BUCKETS).toBe(HIST_EDGES.length + 1);
    expect([...HIST_EDGES]).toEqual([...HIST_EDGES].sort((a, b) => a - b));
  });

  it("assigns half-open buckets [lo, hi)", () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(9.99)).toBe(0);
    expect(bucketIndex(10)).toBe(1);
    expect(bucketIndex(24)).toBe(1);
    expect(bucketIndex(25)).toBe(2);
    expect(bucketIndex(599)).toBe(7);
    expect(bucketIndex(600)).toBe(8);
    expect(bucketIndex(999)).toBe(9);
    expect(bucketIndex(1000)).toBe(10);
    expect(bucketIndex(4999)).toBe(14);
    expect(bucketIndex(5000)).toBe(15);
    expect(bucketIndex(1e9)).toBe(15);
  });

  it("counts values per bucket and drops junk", () => {
    const counts = histogram([5, 7, 12, 12, 12, 999, 1000, 60_000, NaN, -1]);
    expect(counts).toHaveLength(HIST_BUCKETS);
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBe(3);
    expect(counts[9]).toBe(1);
    expect(counts[10]).toBe(1);
    expect(counts[15]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("describes bucket ranges and labels", () => {
    expect(bucketRange(0)).toEqual({ lo: 0, hi: 10 });
    expect(bucketRange(9)).toEqual({ lo: 800, hi: 1000 });
    expect(bucketRange(15)).toEqual({ lo: 5000, hi: Infinity });
    expect(bucketLabel(0)).toBe("<10 ms");
    expect(bucketLabel(1)).toBe("10–25 ms");
    expect(bucketLabel(5)).toBe("200–300 ms");
    expect(bucketLabel(9)).toBe("800 ms–1 s");
    expect(bucketLabel(10)).toBe("1–1.3 s");
    expect(bucketLabel(11)).toBe("1.3–1.6 s");
    expect(bucketLabel(14)).toBe("3–5 s");
    expect(bucketLabel(15)).toBe("5 s+");
    expect(edgeLabel(1000)).toBe("1 s");
    expect(edgeLabel(1300)).toBe("1.3 s");
    expect(edgeLabel(450)).toBe("450 ms");
  });

  it("places values on the bucket axis (linear inside a bucket)", () => {
    expect(axisPosition(0)).toBe(0);
    expect(axisPosition(10)).toBe(1);
    expect(axisPosition(17.5)).toBeCloseTo(1.5, 6);
    expect(axisPosition(600)).toBe(8);
    expect(axisPosition(1000)).toBe(10);
    expect(axisPosition(5000)).toBe(15);
    expect(axisPosition(7500)).toBeCloseTo(15.5, 6);
    expect(axisPosition(1e6)).toBe(HIST_BUCKETS); // saturates at the right edge
    expect(axisPosition(-5)).toBe(0);
  });

  it("puts a limit exactly on the boundary when it is a bucket edge", () => {
    expect(boundaryPosition(600)).toBe(8);
    expect(boundaryPosition(1000)).toBe(10);
    expect(boundaryPosition(1600)).toBe(12);
    const between = boundaryPosition(700);
    expect(between).toBeGreaterThan(8);
    expect(between).toBeLessThan(9);
  });

  it("scales bars against the tallest one and keeps a lone sample visible", () => {
    expect(scaleBar(0, 10)).toBe(0);
    expect(scaleBar(10, 10)).toBe(1);
    expect(scaleBar(5, 10)).toBe(0.5);
    expect(scaleBar(1, 100)).toBe(0.14);
    expect(scaleBar(1, 100, 0.2)).toBe(0.2);
    expect(scaleBar(3, 0)).toBe(0);
    expect(scaleBar(30, 10)).toBe(1);
  });

  it("describes a histogram for screen readers", () => {
    expect(describeHistogram(histogram([]))).toBe("No samples");
    // 5 and 60 land in buckets that end at or below 100 ms, 700 ends at 800 ms, 1500 ends at 1.6 s
    expect(describeHistogram(histogram([5, 60, 700, 1500]))).toBe("4 samples: 2 under 100 ms, 1 from 100 ms to 1 s, 1 over 1 s");
    expect(describeHistogram(histogram([42]))).toBe("1 sample: 1 under 100 ms");
  });
});

describe("gauge scale", () => {
  it("picks a round maximum with headroom, never below 1 s", () => {
    expect(gaugeMax()).toBe(1000);
    expect(gaugeMax(66, 1207)).toBe(1500);
    expect(gaugeMax(1850)).toBe(2000);
    expect(gaugeMax(3400)).toBe(4000);
    expect(gaugeMax(undefined, NaN, 200)).toBe(1000);
    expect(gaugeMax(100_000)).toBe(110_000);
  });

  it("positions a value on the axis and clamps", () => {
    expect(gaugePos(500, 2000)).toBe(0.25);
    expect(gaugePos(5000, 2000)).toBe(1);
    expect(gaugePos(-1, 2000)).toBe(0);
    expect(gaugePos(NaN, 2000)).toBe(0);
    expect(gaugePos(10, 0)).toBe(0);
  });

  it("ticks every half second up to 2 s, then coarser", () => {
    expect(gaugeTicks(2000)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(gaugeTicks(1500)).toEqual([0, 500, 1000, 1500]);
    expect(gaugeTicks(4000)).toEqual([0, 1000, 2000, 3000, 4000]);
  });
});

describe("trace", () => {
  const rows = [
    row("a", { artifact: 100 }, { createdAt: 1, model: "m", source: "llm", cachedTokens: 0 }),
    row("b", {}, { createdAt: 2 }),
    row("c", { artifact: 300 }, { createdAt: 3, model: "m", source: "llm", cachedTokens: 900 }),
    row("d", { artifact: 200 }, { createdAt: 4, model: "heuristic", source: "mock" }),
  ];

  it("keeps the last N fragments that have the stage, oldest first", () => {
    expect(traceSeries(rows, "artifact").map((p) => p.id)).toEqual(["a", "c", "d"]);
    expect(traceSeries(rows, "artifact", 2).map((p) => p.id)).toEqual(["c", "d"]);
    expect(traceSeries(rows, "artifact", 2).map((p) => p.value)).toEqual([300, 200]);
    expect(traceSeries(rows, "pause")).toEqual([]);
  });

  it("scales the vertical axis to the target and the tallest bar, capped", () => {
    expect(traceMax([100, 200], 1000)).toBe(1250);
    expect(traceMax([100, 4000], 1000)).toBe(4000);
    expect(traceMax([100, 90_000], 1000)).toBe(5000);
    expect(traceMax([], undefined)).toBe(100);
  });

  it("summarises the model mix and prompt-cache reuse", () => {
    expect(modelMix(rows)).toEqual({ live: 2, cacheHits: 1, models: [{ model: "m", n: 2 }, { model: "heuristic", n: 1 }] });
    expect(modelMix([])).toEqual({ live: 0, cacheHits: 0, models: [] });
  });
});
