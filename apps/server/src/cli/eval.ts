import "../silence";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATEGORIES, type Category } from "@synapse/shared";
import { FakeClock } from "../clock";
import { EXEMPLARS } from "../gate/exemplars";
import { fold } from "../text";
import { REPO_ROOT } from "../config";
import { parseQuery } from "../recall/engine";
import { ephemeralApp, intFlag, liveEnv, liveProvider, parseArgs, patience, sharedGroqClient, spreadBy } from "./common";
import { speak } from "./replay-lib";

/**
 * pnpm eval [--live] [--out docs/EVAL.md] [--limit N] [--budget R]
 * Scores the fragment-intelligence pipeline against the golden corpora in /eval:
 *   intent (category + artifact), control phrases (pause/forget), reference resolution,
 *   recall@3 on vague queries, and robustness to a 2-minute nonsense ramble.
 * Default runs the offline mock cortex. --live uses the configured live cortex (Claude, or Groq when only a Groq key
 * exists; LLM_PROVIDER picks one): it needs a key and spends quota.
 *   --limit N   at most N items per section (intent sets sampled evenly across categories; coref items; nonsense fragments)
 *   --budget R  stop sending Groq requests after R (the rest degrade to the local cortex and are counted in the report)
 *   --live-recall  seed the recall section's memories with the live cortex too (on Groq they are seeded locally to save requests)
 * A Groq run writes docs/EVAL.groq.md unless --out says otherwise: docs/EVAL.md is the committed offline report.
 */
const { flags } = parseArgs(process.argv.slice(2));
const live = flags.live === true;
const liveInfo = live ? liveProvider() : null;
if (live && !liveInfo) {
  console.error("eval --live needs a live LLM: set ANTHROPIC_API_KEY or GROQ_API_KEY (LLM_PROVIDER=anthropic|groq picks one when both exist) and turn LOCAL_ONLY off.");
  process.exit(2);
}
const limit = intFlag(flags.limit);
const budget = intFlag(flags.budget);
const groq = sharedGroqClient(liveInfo?.provider, budget);
const patient = patience(groq);
// Retrieval does not depend on the cortex, and seeding the recall section's 9 sessions live costs ~14 requests of a free tier's day:
// on Groq the memories are seeded by the local cortex unless --live-recall asks for the live one.
const liveRecall = flags["live-recall"] === true || liveInfo?.provider !== "groq";
const outFile = path.resolve(REPO_ROOT, String(flags.out ?? (liveInfo?.provider === "groq" ? "docs/EVAL.groq.md" : "docs/EVAL.md")));
const readJsonl = <T>(f: string): T[] =>
  fs.readFileSync(path.join(REPO_ROOT, "eval", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

const env = { LLM_MODE: live ? "live" : "mock", THREAD_CLOSE_MS: "100", SUGGESTION_MIN_GAP_S: "0", ...liveEnv(liveInfo?.provider, budget) };
const H = 3600_000;
const md: string[] = [];
const say = (s = "") => {
  console.log(s);
  md.push(s);
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** thoughts whose live call fell back to the local cortex, by reason (a degraded card is the mock's answer, not the model's) */
const degradedBy: Record<string, number> = {};
let liveCalls = 0;
const tally = (ctx: { store: { thoughts: Map<string, { source: string; degraded?: string }> } }): void => {
  for (const t of ctx.store.thoughts.values()) {
    if (t.degraded) degradedBy[t.degraded] = (degradedBy[t.degraded] ?? 0) + 1;
    else if (t.source === "llm") liveCalls++;
  }
};

const EXPECT_KIND: Partial<Record<Category, string[]>> = {
  action: ["ticket"], bug: ["github_issue"], communication: ["email_draft", "message_draft"], scheduling: ["calendar_event"], code: ["code_snippet"],
  decision: ["decision"], idea: ["note"], question: ["none"], journal: ["journal"], aside: ["none"], recall_query: ["recall"],
};

// ------------------------------------------------------------------ intent --
interface IntentItem { id: string; fragments: string[]; gaps?: number[]; expect: { category: Category }; tags?: string[] }

const EXEMPLAR_SET = new Set(Object.values(EXEMPLARS).flat().map((e) => fold(e)));

async function evalIntent(file: string): Promise<{ accuracy: number; macroF1: number; artifactAcc: number; ms: number[]; n: number; leaked: number }> {
  const all = readJsonl<IntentItem>(file);
  // an item whose wording is (nearly) an exemplar is "seen": it measures memorisation, not generalisation
  const isSeen = (it: IntentItem): boolean => EXEMPLAR_SET.has(fold(it.fragments.join(" "))) || it.fragments.some((f) => EXEMPLAR_SET.has(fold(f)) && f.split(" ").length >= 4);
  const leaked = all.filter(isSeen).length;
  const items = spreadBy(file.includes("heldout") ? all.filter((it) => !isSeen(it)) : all, limit, (it) => it.expect.category);
  const { ctx, stop } = await ephemeralApp(env, { groq });
  const classes = [...CATEGORIES].filter((c) => !["privacy", "correction"].includes(c));
  const conf: Record<string, Record<string, number>> = {};
  for (const c of classes) conf[c] = Object.fromEntries(classes.map((x) => [x, 0]));
  let correct = 0;
  let kindOk = 0;
  let kindN = 0;
  const wrong: string[] = [];
  const ms: number[] = [];
  for (const it of items) {
    const session = `eval-${it.id}`;
    const t0 = performance.now();
    await speak(ctx, { fragments: it.fragments, gaps: it.gaps, sessionId: session, beforeFragment: patient });
    await ctx.engine.finalizeAll();
    ms.push(performance.now() - t0);
    const ts = [...ctx.store.thoughts.values()].filter((t) => t.sessionId === session);
    const top = ts.sort((a, b) => b.confidence - a.confidence)[0];
    const predicted: Category = top ? top.category : "aside"; // nothing stored == filtered as an aside
    const row = conf[it.expect.category] as Record<string, number>;
    row[predicted] = (row[predicted] ?? 0) + 1;
    if (predicted === it.expect.category) correct++;
    else wrong.push(`${it.id}: expected ${it.expect.category}, got ${predicted}${top ? ` ("${top.title}")` : " (filtered)"}`);
    const kind = top?.artifactId ? (ctx.store.artifacts.get(top.artifactId)?.kind ?? "none") : "none";
    const want = EXPECT_KIND[it.expect.category];
    if (want) {
      kindN++;
      if (want.includes(kind)) kindOk++;
    }
  }
  const f1s: number[] = [];
  say("| class | precision | recall | F1 | support |");
  say("|---|---:|---:|---:|---:|");
  for (const c of classes) {
    const tp = (conf[c] as Record<string, number>)[c] as number;
    const support = Object.values(conf[c] as Record<string, number>).reduce((a, b) => a + b, 0);
    const predictedC = classes.reduce((a, k) => a + ((conf[k] as Record<string, number>)[c] ?? 0), 0);
    const p = predictedC ? tp / predictedC : 0;
    const r = support ? tp / support : 0;
    const f = p + r ? (2 * p * r) / (p + r) : 0;
    // a sampled run (--limit) has classes that never occur: they carry no information and would cap the average at sample/classes
    if (support > 0 || predictedC > 0) f1s.push(f);
    say(`| ${c} | ${pct(p)} | ${pct(r)} | ${pct(f)} | ${support} |`);
  }
  say();
  say("Confusion matrix (rows = expected, columns = predicted):");
  say();
  say(`| | ${classes.map((c) => c.slice(0, 4)).join(" | ")} |`);
  say(`|---|${classes.map(() => "---:").join("|")}|`);
  for (const c of classes) say(`| **${c}** | ${classes.map((k) => (conf[c] as Record<string, number>)[k]).join(" | ")} |`);
  if (wrong.length) {
    say();
    say("Misclassified:");
    for (const w of wrong) say(`- ${w}`);
  }
  await ctx.idleRecall();
  tally(ctx);
  await stop();
  return { accuracy: correct / items.length, macroF1: f1s.reduce((a, b) => a + b, 0) / f1s.length, artifactAcc: kindN ? kindOk / kindN : 0, ms, n: items.length, leaked };
}

// ----------------------------------------------------------------- control --
async function evalControl(): Promise<{ pauseRecall: number; pausePrecision: number; forgetRecall: number; falsePositives: number; n: number }> {
  const items = readJsonl<{ text: string; expect: "pause" | "forget" | "none" }>("control.jsonl");
  const { ctx, stop } = await ephemeralApp({ ...env, LLM_MODE: "mock" });
  let pTP = 0, pFP = 0, pFN = 0, fTP = 0, fN = 0, fp = 0, nones = 0;
  const bad: string[] = [];
  for (const it of items) {
    const [emb] = await ctx.embedder.embed([it.text]);
    const got = ctx.intents.detect(it.text, emb as Float32Array);
    const kind = got?.kind ?? "none";
    if (it.expect === "pause") { if (kind === "pause") pTP++; else { pFN++; bad.push(`missed pause: "${it.text}"`); } }
    if (it.expect !== "pause" && kind === "pause") { pFP++; bad.push(`false pause: "${it.text}"`); }
    if (it.expect === "forget") { fN++; if (kind === "forget") fTP++; else bad.push(`missed forget: "${it.text}"`); }
    if (it.expect === "none") { nones++; if (kind !== "none") fp++; }
  }
  await stop();
  say(`- pause recall ${pct(pTP / (pTP + pFN))} (${pTP}/${pTP + pFN}) · pause precision ${pct(pTP / Math.max(1, pTP + pFP))} · forget recall ${pct(fTP / Math.max(1, fN))} · false triggers on ${nones} ordinary sentences: ${fp}`);
  for (const b of bad) say(`  - ${b}`);
  return { pauseRecall: pTP / (pTP + pFN), pausePrecision: pTP / Math.max(1, pTP + pFP), forgetRecall: fTP / Math.max(1, fN), falsePositives: fp, n: items.length };
}

// ------------------------------------------------------------------- coref --
interface CorefItem { id: string; history: Array<{ tag: string; hoursAgo: number; say: string[] }>; utterance: string[]; expect: string }

async function evalCoref(): Promise<{ accuracy: number; n: number }> {
  const items = readJsonl<CorefItem>("coref.jsonl").slice(0, limit);
  let ok = 0;
  const bad: string[] = [];
  for (const it of items) {
    const clock = new FakeClock(Date.now());
    const { ctx, stop } = await ephemeralApp(env, { clock, groq });
    const ids = new Map<string, string>();
    for (const h of [...it.history].sort((a, b) => b.hoursAgo - a.hoursAgo)) {
      clock.set(Date.now() - h.hoursAgo * H);
      const sid = `h-${h.tag}`;
      await speak(ctx, { fragments: h.say, sessionId: sid, beforeFragment: patient });
      await ctx.engine.finalizeAll();
      const t = [...ctx.store.thoughts.values()].find((x) => x.sessionId === sid);
      if (t) ids.set(h.tag, t.id);
    }
    clock.set(Date.now());
    await speak(ctx, { fragments: it.utterance, sessionId: "now", beforeFragment: patient });
    await ctx.engine.finalizeAll();
    const t = [...ctx.store.thoughts.values()].find((x) => x.sessionId === "now");
    const target = ids.get(it.expect);
    const got = t?.references.some((r) => r.resolvedId === target);
    // a resolved open question counts too (what did X say?): the answer thought is linked by an `answers` edge
    const viaEdge = t && target ? ctx.store.edgesOf(target).some((e) => e.type === "answers" && (e.src === t.id || e.dst === t.id)) : false;
    if (got || viaEdge) ok++;
    else bad.push(`${it.id}: expected ${it.expect}; refs=${JSON.stringify(t?.references.map((r) => `${r.mention}→${r.resolvedCode ?? "∅"}`))}`);
    await ctx.idleRecall();
    tally(ctx);
    await stop();
  }
  say(`- reference resolution: ${ok}/${items.length} = ${pct(ok / items.length)}`);
  for (const b of bad) say(`  - miss ${b}`);
  return { accuracy: ok / items.length, n: items.length };
}

// ------------------------------------------------------------------ recall --
function lastWeekday(now: number, weekday: number): number {
  const d = new Date(now);
  const back = ((d.getDay() - weekday + 7) % 7) || 7;
  d.setHours(8, 5, 0, 0);
  return d.getTime() - back * 24 * H;
}

async function evalRecall(): Promise<{ recallAt3: number; n: number }> {
  const items = readJsonl<{ id: string; query: string; expect: string }>("recall.jsonl");
  const now = Date.now();
  const clock = new FakeClock(now);
  const { ctx, stop, cfg } = await ephemeralApp(liveRecall ? env : { ...env, LLM_MODE: "mock" }, { clock, groq: liveRecall ? groq : undefined });
  const memory: Array<{ at: number; sid: string; device: "desk" | "pocket"; act: "desk" | "walking" | "vehicle"; say: string[] }> = [
    { at: now - 52 * H, sid: "m1", device: "desk", act: "desk", say: ["Sarah suggested we use OAuth2 with PKCE for the mobile app login", "she also wants refresh token rotation turned on"] },
    { at: now - 27 * H, sid: "m2", device: "desk", act: "desk", say: ["There's a null pointer exception in the cart service when applying a discount code", "I think the validator doesn't handle an empty string"] },
    { at: now - 26 * H, sid: "m3", device: "pocket", act: "vehicle", say: ["Remember to rotate the staging keys on Friday", "and tell Dev the staging URL will change after the rotation"] },
    { at: now - 20 * H, sid: "m4", device: "desk", act: "desk", say: ["Maybe retry with exponential backoff and jitter for the webhook sender"] },
    { at: lastWeekday(now, 2), sid: "m5", device: "pocket", act: "walking", say: ["What if we cached the embeddings on disk", "and kept the hot ones in memory with an LRU"] },
    { at: now - 5 * H, sid: "m6", device: "desk", act: "desk", say: ["The auth module needs a decision", "JWT with a short expiry or OAuth2 with PKCE, leaning towards JWT"] },
    { at: now - 3 * H, sid: "m7", device: "desk", act: "desk", say: ["The login page crashes on Safari"] },
    { at: now - 1 * H, sid: "m8", device: "desk", act: "desk", say: ["Thursday's standup clashes with the dentist"] },
    { at: now - 9 * H, sid: "m9", device: "pocket", act: "walking", say: ["Idea: let users pin their favorite searches"] },
  ];
  for (const m of memory.sort((a, b) => a.at - b.at)) {
    clock.set(m.at);
    await speak(ctx, { fragments: m.say, sessionId: m.sid, device: m.device, activity: m.act, beforeFragment: patient });
    await ctx.engine.finalizeAll();
  }
  clock.set(now);
  let ok = 0;
  const bad: string[] = [];
  for (const it of items) {
    const parsed = parseQuery(it.query, { now, timezone: cfg.timezone, hackathonStart: cfg.hackathonStart, persons: cfg.user.team.filter((m) => it.query.toLowerCase().includes(m.name.toLowerCase())).map((m) => m.name) });
    const res = await ctx.recall.search(parsed);
    const top3 = res.hits.slice(0, 3).map((h) => `${h.thought.title} ${h.thought.intent} ${ctx.store.fragmentsOf(h.thought).map((f) => f.text).join(" ")}`.toLowerCase());
    if (top3.some((t) => t.includes(it.expect.toLowerCase()))) ok++;
    else bad.push(`${it.id} "${it.query}" → ${res.hits.slice(0, 3).map((h) => h.thought.title).join(" | ") || "(nothing)"}`);
  }
  say(`- Recall@3 on ${items.length} vague queries over ${ctx.store.thoughts.size} remembered thoughts${liveRecall ? "" : " (seeded by the local cortex: retrieval does not depend on the cortex, and live seeding would spend ~14 requests of the free tier; `--live-recall` seeds them live)"}: ${ok}/${items.length} = ${pct(ok / items.length)}`);
  for (const b of bad) say(`  - miss ${b}`);
  await ctx.idleRecall();
  tally(ctx);
  await stop();
  return { recallAt3: ok / items.length, n: items.length };
}

// ---------------------------------------------------------------- nonsense --
const RAMBLE = [
  "Hmm, uh, the the thing with...", "yeah no", "ugh", "okay okay okay", "where did I put my keys", "uh huh uh huh", "hold on one sec",
  "do you want a coffee?", "sorry, what?", "mmm", "wait, was that my phone?", "never mind", "testing, testing", "hello, can you hear me?",
  "yeah I'll be there in five", "uh um uh", "hmm hmm okay", "thanks, bye", "oh the the...", "no no never mind", "ugh my headphones", "yes yes I know",
  "okay so", "uhh", "right right",
];

async function evalNonsense(): Promise<{ thoughts: number; artifacts: number; filtered: number; n: number }> {
  const { ctx, stop } = await ephemeralApp(env, { groq });
  let i = 0;
  const ramble = RAMBLE.slice(0, limit);
  for (const r of ramble) await speak(ctx, { fragments: [r], sessionId: "ramble", gaps: [i++ === 0 ? 0 : 3000], beforeFragment: patient });
  await ctx.engine.finalizeAll();
  const ts = [...ctx.store.thoughts.values()];
  const artifacts = ts.filter((t) => t.artifactId && !["none", "journal", "note"].includes(ctx.store.artifacts.get(t.artifactId)?.kind ?? "none")).length;
  say(`- ${ramble.length} fragments of mumbling / filler / speech to others: ${ts.length} thought(s) stored, ${artifacts} spurious artifact(s), ${ctx.asides.count} filtered as asides`);
  await ctx.idleRecall();
  tally(ctx);
  await stop();
  return { thoughts: ts.length, artifacts, filtered: ctx.asides.count, n: ramble.length };
}

// -------------------------------------------------------------------- main --
say("# Evaluation report");
say();
say(`Generated ${new Date().toISOString()} · cortex: **${liveInfo ? `live ${liveInfo.label}` : "offline mock (heuristics + local triage)"}** · embeddings: MiniLM (local) · node ${process.version} · ${os.cpus()[0]?.model ?? "cpu"}`);
say();
if (!live) say("> **Mock mode**: this measures the offline fallback path. Run `pnpm eval --live` with an `ANTHROPIC_API_KEY` (or a `GROQ_API_KEY`) for real model numbers.");
else if (liveInfo?.provider === "groq")
  say(
    `> Live mode on **Groq's free tier** (${liveInfo.model}): the compact prompt of \`cortex/prompts-lite.ts\` (the full Claude prompt cannot fit the 8,000 tokens-per-minute limit), calls paced to the token budget so each item waits for its answer. Sampled run: ${limit ? `at most ${limit} items per section` : "all items"}${budget ? `, request budget ${budget}` : ""}. These are not the numbers of the production Claude cortex.`,
  );
else say(`> Live mode: results include real model behaviour and cost${limit ? ` (sampled: at most ${limit} items per section)` : ""}.`);
say();
say("## 1a. Intent classification: held-out set (phrasings that are not in the classifier's exemplars)");
say();
say("> Not a blind test: the same people wrote this set and the classifier, and the offline cue patterns were adjusted while an earlier run of it was in view. It is the more meaningful of the two intent numbers here because no sentence is shared with the exemplars, but real speech will be messier. The number that matters is the live model on speech nobody here wrote (`pnpm eval --live`, ideally on a teammate's phrasings).");
say();
const intent = await evalIntent("intent_heldout.jsonl");
say();
say(`**${intent.n} unseen threads · accuracy ${pct(intent.accuracy)} · macro-F1 ${pct(intent.macroF1)} · artifact-kind accuracy ${pct(intent.artifactAcc)}** (target macro-F1 ≥ 85%)`);
say();
say("## 1b. Intent classification: dev set (includes the problem statement's verbatim examples)");
say();
say("> ⚠️ Optimistic by construction: the offline classifier's exemplars contain these exact sentences, and the live model's few-shot examples contain several of them. Shown for transparency and as a regression gate, not as a generalisation claim.");
say();
const dev = await evalIntent("intent.jsonl");
say();
say(`${dev.n} threads · accuracy ${pct(dev.accuracy)} · macro-F1 ${pct(dev.macroF1)}`);
say();
say("## 2. Privacy control phrases");
say();
const control = await evalControl();
say();
say("## 3. Reference resolution (\"that bug from yesterday\", \"what did Sarah say?\")");
say();
const coref = await evalCoref();
say();
say("## 4. Recall (vague, time/place-constrained questions)");
say();
const recall = await evalRecall();
say();
say("## 5. Robustness to nonsense (2-minute ramble)");
say();
const nonsense = await evalNonsense();
say();
say("## Summary");
say();
say("| metric | result | target |");
say("|---|---:|---:|");
say(`| intent macro-F1 (held-out, ${intent.n} unseen threads) | ${pct(intent.macroF1)} | ≥ 85% |`);
say(`| intent macro-F1 (dev set, seen wording) | ${pct(dev.macroF1)} | regression gate |`);
say(`| artifact-kind accuracy | ${pct(intent.artifactAcc)} | |`);
say(`| pause phrase recall / precision | ${pct(control.pauseRecall)} / ${pct(control.pausePrecision)} | ≥ 95% / 100% |`);
say(`| reference resolution | ${pct(coref.accuracy)} | ≥ 80% |`);
say(`| Recall@3 | ${pct(recall.recallAt3)} | ≥ 80% |`);
say(`| spurious artifacts on nonsense | ${nonsense.artifacts} | ≤ 1 |`);
if (live) {
  const dropped = Object.entries(degradedBy).map(([k, v]) => `${k} ×${v}`).join(", ");
  say();
  say(`Live cortex answers: ${liveCalls} thought(s) were answered by the model; ${Object.values(degradedBy).reduce((a, b) => a + b, 0)} fell back to the local cortex${dropped ? ` (${dropped})` : ""}. Fallback answers are the offline cortex's, so they dilute every number above.${liveInfo?.provider === "groq" ? ` Requests sent to Groq in this run: ${groq?.stats().requestsToday ?? 0}, one pacing budget shared by every app the run built (free tier: 1,000 per day).` : ""}`);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, md.join("\n") + "\n");
console.log(`\nwrote ${path.relative(REPO_ROOT, outFile)}`);
// let the HTTP connections of a live run go quiet before exiting (an immediate process.exit right after a fetch trips a libuv assertion on Windows)
if (live) await new Promise((r) => setTimeout(r, 1500));
process.exit(0);
