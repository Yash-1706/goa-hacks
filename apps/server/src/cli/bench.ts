import "../silence";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchPauseIntent, percentile } from "@synapse/shared";
import { REPO_ROOT, loadConfig } from "../config";
import { Db } from "../memory/db";
import { STAGES, stagesOf, type LatencyRow } from "../metrics/latency";
import { ephemeralApp, parseArgs } from "./common";
import { speak } from "./replay-lib";

/**
 * pnpm bench [--live] [--runs 2] [--out docs/LATENCY.md]
 * Replays the intent corpora through the REAL pipeline (embed → triage → stitch → first paint → cortex → artifact)
 * and documents per-stage timing. Without a Wispr key the Wispr stage cannot be measured here; real captured
 * sessions (data/synapse.db latency table) are appended when present.
 */
const { flags } = parseArgs(process.argv.slice(2));
const live = flags.live === true;
const runs = Math.max(1, Number(flags.runs ?? 2));
const outFile = path.resolve(REPO_ROOT, String(flags.out ?? "docs/LATENCY.md"));
const csvFile = path.resolve(path.dirname(outFile), "latency.csv");

interface Item { id: string; fragments: string[]; gaps?: number[] }
const readJsonl = (f: string): Item[] => fs.readFileSync(path.join(REPO_ROOT, "eval", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item);
const items = [...readJsonl("intent_heldout.jsonl"), ...readJsonl("intent.jsonl")];

const rows: LatencyRow[] = [];
const wall: number[] = [];
let cacheHits = 0;
let calls = 0;
for (let r = 0; r < runs; r++) {
  const { ctx, stop } = await ephemeralApp({ LLM_MODE: live ? "live" : "mock", THREAD_CLOSE_MS: "100" });
  // warm: the first call pays JIT, ONNX graph init and (live) schema compilation / cache writes
  await speak(ctx, { fragments: ["warm up the pipeline"], sessionId: `warm-${r}` });
  await ctx.engine.finalizeAll();
  for (const it of items) {
    const t0 = performance.now();
    await speak(ctx, { fragments: it.fragments, gaps: it.gaps, sessionId: `b${r}-${it.id}` });
    wall.push(performance.now() - t0);
    await ctx.engine.finalizeAll();
  }
  for (const row of ctx.metrics.rowsSnapshot()) {
    if (row.fragmentId.startsWith("warm-")) continue;
    rows.push(row);
    if (row.model && row.model !== "heuristic") {
      calls++;
      if ((row.cachedTokens ?? 0) > 0) cacheHits++;
    }
  }
  await stop();
}

// the stages every row can have in this synthetic setting (no Wispr, no real network hop)
const buckets: Record<string, number[]> = {};
for (const row of rows) for (const [k, v] of Object.entries(stagesOf(row))) if (v !== undefined && Number.isFinite(v)) (buckets[k] ??= []).push(v);
// time to the first model field only exists for streamed (live) results
const stat = (xs: number[]) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: Math.max(...xs) });
const f = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

// pause path micro-benchmarks
const pauseTimes: number[] = [];
for (let i = 0; i < 2000; i++) {
  const t0 = performance.now();
  matchPauseIntent(["pause memory", "okay pause memory please", "stop listening", "the memory leak is in the handler"][i % 4] as string);
  pauseTimes.push((performance.now() - t0) * 1000); // µs
}

const lines: string[] = [];
const say = (s = "") => lines.push(s);
say("# Latency benchmark");
say();
say(`Generated ${new Date().toISOString()} · cortex: **${live ? `live (${loadConfig().llm.fast})` : "offline mock (heuristics + local triage)"}** · ${rows.length} fragments over ${runs} run(s) · ${os.cpus()[0]?.model ?? "cpu"} · Node ${process.version}`);
say();
if (!live) say("> **Offline run.** The cortex stage here is the local heuristic cortex, so the end-to-end numbers show the pipeline overhead, not model latency. Run `pnpm bench --live` with `ANTHROPIC_API_KEY` for the real fragment→artifact numbers.");
say();
say("## What each stage measures");
say();
say("| stage | from → to | measured here |");
say("|---|---|---|");
say("| `wispr` | commit sent → Wispr final text | needs a Wispr key (see *Real sessions*) |");
say("| `triage` | fragment received → first card on the wire (embed 384-d + kNN triage + persist) | ✔ server-side |");
say("| `firstPaint` | = triage here (no device clock in the benchmark) | ✔ server-side |");
say("| `llmFirstField` | model call start → first parsed field (streamed) | " + (live ? "✔" : "n/a offline") + " |");
say("| `cortex` | model call start → complete result | ✔ |");
say("| `artifact` | fragment received → complete artifact emitted | ✔ server-side |");
say();
say("## Results (milliseconds)");
say();
say("| stage | n | p50 | p95 | max |");
say("|---|---:|---:|---:|---:|");
// The replay stamps a constant Wispr/device timeline, so those stages are not observations here.
const SYNTHETIC = new Set<string>(["wispr", "toServer", "speechToArtifact", "pause"]);
for (const k of STAGES) {
  const xs = buckets[k];
  if (!xs?.length || SYNTHETIC.has(k)) continue;
  const s = stat(xs);
  say(`| ${k} | ${s.n} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.max)} |`);
}
say();
const first = stat(buckets.firstPaint ?? [0]);
const art = stat(buckets.artifact ?? [0]);
say(`**First paint:** p50 ${f(first.p50)} ms, p95 ${f(first.p95)} ms (budget ≤ 80 ms p50). **Fragment → complete artifact:** p50 ${f(art.p50)} ms, p95 ${f(art.p95)} ms (budget ≤ 1000 ms p50 for "incoherent vocalization → structured ticket in under a second", measured from Wispr's final text).`);
say();
if (live) say(`Prompt cache: ${cacheHits}/${calls} model calls were served with cached prompt tokens.`);
say();
say("## The honest end-to-end budget (voice → action)");
say();
say("| segment | typical | notes |");
say("|---|---:|---|");
say("| VAD end-of-speech redemption | 480 ms | tunable 300–900 ms; shorter = more fragments (the stitcher merges them) |");
say(`| Wispr commit → final text | *unmeasured* | pre-authenticated standby socket removes connect+auth from the path; needs a live key |`);
say(`| Wispr → server (WebSocket hop) | ~10–40 ms LAN | clock-offset corrected per device |`);
say(`| Server: embed + triage → first card | **${f(first.p50)} ms** | measured above |`);
say(`| Server: complete artifact | **${f(art.p50)} ms** | ${live ? "measured with the live model (streamed; first fields appear much earlier)" : "offline cortex; the live number is dominated by model generation"} |`);
say();
say("## Pause path (\"pause memory\")");
say();
say(`Client-side phrase matcher: p50 ${f(percentile(pauseTimes, 50))} µs, p95 ${f(percentile(pauseTimes, 95))} µs per utterance (2000 samples). The microphone is released the moment Wispr returns the phrase's text; the browser pipeline reports the end-of-phrase → mic-released latency (\`pause\` stage) when run with a live key. The server backstop (semantic match) adds one embedding (~5 ms).`);
say();

// real sessions, if any
try {
  const dbFile = path.join(loadConfig().dataDir, "synapse.db");
  if (fs.existsSync(dbFile)) {
    const db = new Db(dbFile);
    const real = db.all<{ wispr_ms: number | null; first_paint_ms: number | null; artifact_ms: number | null; speech_to_artifact_ms: number | null; cortex_ms: number | null; transport: string }>(
      "SELECT wispr_ms, first_paint_ms, artifact_ms, speech_to_artifact_ms, cortex_ms, transport FROM latency WHERE transport LIKE 'wispr%' ORDER BY created_at DESC LIMIT 500",
    );
    db.close();
    if (real.length) {
      say("## Real sessions (live microphone → Wispr → Synapse)");
      say();
      say(`${real.length} fragments captured with a real Wispr key.`);
      say();
      say("| stage | n | p50 | p95 | max |");
      say("|---|---:|---:|---:|---:|");
      for (const [k, col] of [["wispr", "wispr_ms"], ["firstPaint", "first_paint_ms"], ["cortex", "cortex_ms"], ["artifact", "artifact_ms"], ["speechToArtifact", "speech_to_artifact_ms"]] as const) {
        const xs = real.map((r) => r[col]).filter((x): x is number => typeof x === "number" && x >= 0);
        if (xs.length) {
          const s = stat(xs);
          say(`| ${k} | ${s.n} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.max)} |`);
        }
      }
      say();
    }
  }
} catch {
  /* no real sessions yet */
}
say("## Method");
say();
say(`Items: ${items.length} threads (both intent corpora), each spoken as 1–3 fragments with realistic gaps, one thread at a time; \`${runs}\` run(s); a warm-up thread is excluded (JIT, ONNX graph init, schema compile, cache write). Timestamps are taken inside the pipeline: \`serverRecv\` → \`firstPaintEmit\` → \`llmStart/llmDone\` → \`artifactEmit\`. Reproduce with \`pnpm bench${live ? " --live" : ""}\`.`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join("\n") + "\n");
fs.writeFileSync(csvFile, ["fragment_id,transport,model,cached_tokens," + STAGES.join(","), ...rows.map((r) => { const st = stagesOf(r); return [r.fragmentId, r.transport, r.model ?? "", r.cachedTokens ?? "", ...STAGES.map((s) => (st[s] !== undefined ? Math.round(st[s] as number) : ""))].join(","); })].join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\nwrote ${path.relative(REPO_ROOT, outFile)} and ${path.relative(REPO_ROOT, csvFile)}`);
process.exit(0);
