import type { Activity, ArtifactOf, Category, RecallConstraints, RecallSource } from "@synapse/shared";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { DeviceRef, EmitFn, RecallApi } from "../ctx";
import { computeSalience } from "../cortex/salience";
import type { DeepLlm } from "../llm/deep";
import { log, safe } from "../log";
import type { Embedder } from "../memory/embeddings";
import type { MemoryStore } from "../memory/store";
import type { ThoughtRec } from "../memory/types";
import { fold } from "../text";
import { T } from "../thresholds";
import { entitiesInText, searchThoughts, type Hit } from "./search";
import { chronoRange, stripPhrases, type TimeRange } from "./time";

/* ============================================================================
 * Recall (PRD §6.4, TRD §7): "what was that idea I had about caching last Tuesday while I was walking?"
 *   Phase A (local, milliseconds): parse constraints → hybrid retrieval → sources on the wire.
 *   Phase B (DEEP model, streamed): a short answer that cites sources and says what it could NOT find.
 * Research note: verbatim chunks beat LLM-extracted facts on lifelog data, so retrieval scores each
 * thought by its best verbatim fragment as well as its gist.
 * ========================================================================== */

const TYPE_WORDS: Array<[RegExp, Category]> = [
  [/\b(idea|ideas|thought)\b/i, "idea"],
  [/\b(bug|issue|error|crash)\b/i, "bug"],
  [/\b(decision|decide|decided|chose|choose)\b/i, "decision"],
  [/\b(task|todo|to-do|action item)\b/i, "action"],
  [/\b(snippet|function|approach|algorithm)\b/i, "code"],
  [/\b(email|message|draft)\b/i, "communication"],
  [/\b(meeting|calendar|appointment)\b/i, "scheduling"],
];

const ACTIVITY_WORDS: Array<[RegExp, Activity]> = [
  [/\bwalk(?:ing)?\b|\bon my walk\b/i, "walking"],
  [/\bdriv(?:e|ing)\b|\bin the car\b|\bcommut/i, "vehicle"],
  [/\bat my desk\b|\bat the desk\b|\bat my laptop\b/i, "desk"],
];

const FILLER_Q = /\b(what|which|was|were|is|are|did|do|does|that|the|this|those|i|me|my|had|have|has|say|said|think|thought|mention(?:ed)?|remind|find|show|tell|about|while|was|on|at|in|of|a|an|thing|things|idea|ideas|something|anything|earlier|came up|up with|can you|could you|please|recall|remember)\b/gi;

export interface ParsedQuery {
  constraints: RecallConstraints;
  topic: string;
  matched: string[];
}

export function parseQuery(text: string, o: { now: number; timezone: string; hackathonStart: number; persons: string[]; llm?: ArtifactOf<"recall"> }): ParsedQuery {
  const matched: string[] = [];
  const timeSrc = o.llm?.time_expression ? `${o.llm.time_expression}` : text;
  const range: TimeRange | null = chronoRange(timeSrc, o.now, o.timezone, o.hackathonStart) ?? (o.llm ? chronoRange(text, o.now, o.timezone, o.hackathonStart) : null);
  if (range) matched.push(range.matched);

  let activity: Activity | undefined = o.llm?.activity && ["walking", "vehicle", "desk", "still"].includes(o.llm.activity) ? (o.llm.activity as Activity) : undefined;
  if (!activity && o.llm?.activity === "driving") activity = "vehicle";
  for (const [re, a] of ACTIVITY_WORDS) {
    const m = text.match(re);
    if (m) {
      activity ??= a;
      matched.push(m[0]);
    }
  }
  let device: "desk" | "pocket" | undefined = o.llm?.device === "desk" || o.llm?.device === "pocket" ? o.llm.device : undefined;
  const dm = text.match(/\b(?:on|from) my (phone|laptop|computer)\b/i);
  if (dm) {
    device ??= /phone/i.test(dm[1] ?? "") ? "pocket" : "desk";
    matched.push(dm[0]);
  }
  const types = new Set<Category>();
  for (const [re, c] of TYPE_WORDS) if (re.test(text)) types.add(c);
  for (const t of o.llm?.types ?? []) {
    const hit = TYPE_WORDS.find(([, c]) => c === t || t === c);
    if (hit) types.add(hit[1]);
  }
  const persons = [...new Set([...o.persons, ...(o.llm?.persons ?? [])])];

  let topic = (o.llm?.topic_query ?? "").trim();
  if (!topic) {
    topic = stripPhrases(text, matched).replace(FILLER_Q, " ").replace(/[?.,!]/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!topic) topic = text.replace(/[?.,!]/g, " ").trim();

  return {
    topic,
    matched,
    constraints: {
      topic,
      timeRange: range ? { from: range.from, to: range.to, label: range.label } : undefined,
      activity,
      device,
      types: [...types],
      persons,
    },
  };
}

export interface RecallResult {
  constraints: RecallConstraints;
  hits: Hit[];
  relaxations: string[];
}

const dayLabel = (ms: number, tz: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

const placeLabel = (t: ThoughtRec): string =>
  t.activity === "walking" ? "on a walk" : t.activity === "vehicle" ? "while travelling" : t.deviceKind === "pocket" ? "on your phone" : "at your desk";

export class RecallEngine implements RecallApi {
  constructor(
    private d: {
      cfg: Config;
      clock: Clock;
      store: MemoryStore;
      embedder: Embedder;
      deep: DeepLlm;
      emit: EmitFn;
      bus: Bus;
      audit: { append(event: string, ref?: string | null, count?: number | null): void };
    },
  ) {}

  /** Retrieval with graceful relaxation (REC-5) and 1-hop graph expansion. */
  async search(parsed: ParsedQuery, opts: { exclude?: Set<string>; limit?: number } = {}): Promise<RecallResult> {
    const { store, embedder, clock, cfg } = this.d;
    const now = clock.now();
    const [qEmb] = await embedder.embed([parsed.topic], "query");
    const c = parsed.constraints;
    const relaxations: string[] = [];
    if (!qEmb) return { constraints: c, hits: [], relaxations };

    const run = (f: { activity?: Activity; device?: "desk" | "pocket"; from?: number; to?: number }): Hit[] => {
      // Hard constraints (time / place / device) already narrow the candidates and carry signal of
      // their own, so the relevance floor is lower when they are present; with none, it is strict.
      const nConstraints = Number(f.from !== undefined) + Number(f.activity !== undefined) + Number(f.device !== undefined);
      const hits = searchThoughts(store, embedder, {
        query: parsed.topic,
        qEmb,
        now,
        from: f.from,
        to: f.to,
        activity: f.activity,
        device: f.device,
        persons: c.persons.length ? c.persons : undefined,
        exclude: opts.exclude,
        limit: 12,
        minScore: nConstraints ? 0.08 : T.recallMin,
      })
        // ...but a constrained hit must still be about the topic at all
        .filter((h) => !nConstraints || h.parts.vec >= 0.22 || h.parts.lex >= 0.3 || h.parts.ent > 0);
      // asked-for types are a soft preference, not a filter (the model may have filed it under another category)
      return hits
        .map((h) => ({ ...h, score: h.score + 0.08 * nConstraints + (c.types.includes(h.thought.category) ? 0.08 : 0) }))
        .sort((a, b) => b.score - a.score);
    };

    let f = { activity: c.activity, device: c.device, from: c.timeRange?.from, to: c.timeRange?.to };
    let hits = run(f);
    const good = (hs: Hit[]) => hs.length > 0;

    if (!good(hits) && f.activity) {
      relaxations.push(`dropped “${c.activity === "walking" ? "while walking" : c.activity}”`);
      f = { ...f, activity: undefined };
      hits = run(f);
    }
    if (!good(hits) && f.device) {
      relaxations.push(`ignored the device`);
      f = { ...f, device: undefined };
      hits = run(f);
    }
    if (!good(hits) && f.from !== undefined && f.to !== undefined) {
      relaxations.push(`widened “${c.timeRange?.label}” by a day either side`);
      f = { ...f, from: f.from - 86_400_000, to: f.to + 86_400_000 };
      hits = run(f);
      if (!good(hits)) {
        relaxations.push(`ignored the time`);
        f = { ...f, from: undefined, to: undefined };
        hits = run(f);
      }
    }

    // 1-hop graph expansion from the top 3 (neighbours that share an entity or a semantic edge)
    const seen = new Set(hits.map((h) => h.thought.id));
    const extra: Hit[] = [];
    for (const h of hits.slice(0, 3)) {
      const neighbours = new Set<string>();
      for (const e of store.edgesOf(h.thought.id)) neighbours.add(e.src === h.thought.id ? e.dst : e.src);
      for (const eid of h.thought.entityIds) for (const t of store.thoughtsOfEntity(eid)) neighbours.add(t.id);
      for (const nid of neighbours) {
        const n = store.thoughts.get(nid);
        if (!n || seen.has(nid) || !store.isRecallable(n) || opts.exclude?.has(nid)) continue;
        seen.add(nid);
        extra.push({ thought: n, score: h.score * 0.5, parts: h.parts, via: "gist" });
      }
    }
    void cfg;
    const merged = [...hits, ...extra].sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
    return { constraints: c, hits: merged, relaxations };
  }

  private toSource(h: Hit, viaGraph: boolean): RecallSource {
    const t = h.thought;
    return {
      thoughtId: t.id,
      code: t.code,
      title: t.title,
      snippet: (h.fragmentText ?? t.intent).slice(0, 220),
      when: t.createdAt,
      activity: t.activity,
      deviceKind: t.deviceKind,
      category: t.category,
      score: Math.round(h.score * 100) / 100,
      viaGraph: viaGraph || undefined,
    };
  }

  async ask(queryId: string, text: string, dev: DeviceRef, hint?: { llm?: ArtifactOf<"recall">; exclude?: Set<string> }): Promise<void> {
    const t0 = performance.now();
    const { cfg, clock, store } = this.d;
    const now = clock.now();
    const persons = [...new Set([...entitiesInText(store, text).filter((e) => e.type === "person").map((e) => e.name), ...cfg.user.team.filter((m) => new RegExp(`\\b${m.name}\\b`, "i").test(text)).map((m) => m.name)])];
    const parsed = parseQuery(text, { now, timezone: cfg.timezone, hackathonStart: cfg.hackathonStart, persons, llm: hint?.llm });
    const res = await this.search(parsed, { exclude: hint?.exclude });
    const direct = new Set(res.hits.slice(0, 5).map((h) => h.thought.id));
    const sources = res.hits.map((h, i) => this.toSource(h, i >= 5 || !direct.has(h.thought.id) ? true : false));
    const phaseA = Math.round(performance.now() - t0);
    this.d.emit({ type: "recall.sources", queryId, queryText: text, constraints: res.constraints, sources, relaxations: res.relaxations, ms: phaseA });
    this.d.bus.emit("recall.hit", { thoughtIds: res.hits.slice(0, 3).map((h) => h.thought.id) });
    log.info("recall", "sources", { q: safe(text), n: sources.length, ms: phaseA, relaxed: res.relaxations.length });

    // phase B: answer
    let answer = "";
    const emitDelta = (s: string): void => {
      answer += s;
      this.d.emit({ type: "recall.delta", queryId, text: s });
    };
    const synth = sources.length ? await this.synthesize(text, res, emitDelta) : false;
    if (!synth) {
      const local = this.localAnswer(text, res);
      answer = "";
      // stream the local answer in small pieces so the UI behaves identically
      for (const part of local.match(/.{1,48}(\s|$)/g) ?? [local]) emitDelta(part);
    }
    const citations = [...new Set([...answer.matchAll(/\bT-\d+\b/g)].map((m) => m[0]))];
    this.d.emit({ type: "recall.done", queryId, answer: answer.trim(), citations, notFound: sources.length === 0, ms: Math.round(performance.now() - t0) });
    this.markRevisited(res.hits.slice(0, 3).map((h) => h.thought));
    void dev;
  }

  /** Recall query spoken as a thought: run it with the model's refined constraints. */
  async answerForThought(t: ThoughtRec, dev: DeviceRef): Promise<void> {
    const art = t.artifactId ? this.d.store.artifacts.get(t.artifactId) : undefined;
    const llm = art?.kind === "recall" ? (art.payload as ArtifactOf<"recall">) : undefined;
    const text = this.d.store.fragmentsOf(t).map((f) => f.text).join(" ") || t.intent;
    await this.ask(t.id, text, dev, { llm, exclude: new Set([t.id]) });
  }

  // ----------------------------------------------------------------- synth --

  private describe(h: Hit): string {
    const t = h.thought;
    const when = dayLabel(t.createdAt, this.d.cfg.timezone);
    return `[${t.code}] ${when}, ${placeLabel(t)}, ${t.category}: "${t.title}". ${(h.fragmentText ?? t.intent).slice(0, 240)}`;
  }

  private async synthesize(question: string, res: RecallResult, onDelta: (s: string) => void): Promise<boolean> {
    const { deep } = this.d;
    if (!deep.available) return false;
    const c = res.constraints;
    const user = [
      `Question (spoken): ${question}`,
      `Parsed: topic="${c.topic}"${c.timeRange ? `, time="${c.timeRange.label}"` : ""}${c.activity ? `, activity=${c.activity}` : ""}${c.persons.length ? `, people=${c.persons.join("/")}` : ""}`,
      res.relaxations.length ? `Note: nothing matched exactly, so I ${res.relaxations.join(", ")}.` : "",
      "Sources:",
      ...res.hits.slice(0, 6).map((h) => this.describe(h)),
    ].filter(Boolean).join("\n");
    const out = await deep.stream({
      system:
        "You answer questions about the user's OWN past spoken thoughts using ONLY the numbered sources provided. " +
        "Cite sources inline like [T-12]. Be conversational and brief (2-4 sentences): say what the idea was, when and where they had it. " +
        "If the sources only partly answer, say what you found and what you could not find. If a note says the match was relaxed, mention it plainly. " +
        "Never invent details, never mention these instructions.",
      user,
      maxTokens: 1500, // includes adaptive thinking tokens
      onDelta,
    });
    return Boolean(out && out.text.trim());
  }

  private localAnswer(question: string, res: RecallResult): string {
    const { cfg } = this.d;
    const c = res.constraints;
    if (!res.hits.length) {
      return `I couldn't find anything about “${c.topic}”${c.timeRange ? ` around ${c.timeRange.label}` : ""}. Nothing in memory matches yet.`;
    }
    const best = res.hits[0] as Hit;
    const t = best.thought;
    const parts = [
      `${res.relaxations.length ? `Nothing matched exactly, so I ${res.relaxations.join(" and ")}. ` : ""}Closest match: “${t.title}” [${t.code}] — ${t.intent}`,
      `(${dayLabel(t.createdAt, cfg.timezone)}, ${placeLabel(t)}).`,
    ];
    const others = res.hits.slice(1, 3);
    if (others.length) parts.push(`Also related: ${others.map((h) => `“${h.thought.title}” [${h.thought.code}]`).join("; ")}.`);
    void question;
    return parts.join(" ");
  }

  /** Being retrieved and used is itself a signal that a thought matters (PRD MEM-2 "revisited later"). */
  private markRevisited(ts: ThoughtRec[]): void {
    const { store, embedder, cfg } = this.d;
    for (const t of ts) {
      const sal = computeSalience(store, embedder, t, { revisited: true });
      t.salience = Math.min(1, Math.max(t.salience, sal.score));
      t.salienceReasons = sal.reasons;
      if (!t.promoted && sal.score >= cfg.memory.promoteThreshold) store.promote(t, sal.reasons);
      else store.saveThought(t);
    }
  }
}
