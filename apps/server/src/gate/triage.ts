import { CATEGORIES, type Category } from "@synapse/shared";
import { dot, type Embedder } from "../memory/embeddings";
import { textFeatures, type TextFeatures } from "../text";
import { EXEMPLARS } from "./exemplars";

/* ============================================================================
 * Local triage (TRD §6.3): kNN over exemplar embeddings + cheap lexical cues.
 * No LLM. ~5 ms after the embedding. Drives first paint, noise skipping, the
 * "LLM down" degradation path and the mock cortex.
 * ========================================================================== */

export interface Triage {
  label: Category;
  probs: Record<Category, number>;
  confidence: number;
  topSim: number;
  pNoise: number;
  features: TextFeatures;
}

interface Ex {
  label: Category;
  emb: Float32Array;
}

const K = 7;

const CUES: Array<{ re: RegExp; boost: Partial<Record<Category, number>> }> = [
  { re: /\b(bug|crash(es|ed)?|exception|null pointer|npe|stack ?trace|race condition|memory leak|segfault|broken|doesn'?t work|fails?|failing|500 error|404|timeout|time out)\b/i, boost: { bug: 0.35 } },
  { re: /\b(e-?mail|message|ping|dm|text|write to|tell|let .{1,20} know|follow up|reply to|send (an )?update|draft (a )?note)\b/i, boost: { communication: 0.3 } },
  { re: /\b(meeting|standup|stand-up|sync|call|dentist|doctor|appointment|calendar|reschedule|double booked|clash(es)?|conflict|overlap(s)?|block time|monday|tuesday|wednesday|thursday|friday|tomorrow|next week)\b/i, boost: { scheduling: 0.3 } },
  { re: /\b(recursive|iterative|memoiz\w*|debounce|throttle|binary search|trie|lru|reducer|regex|hash ?map|backoff|jitter|sliding window|worker pool|generic hook)\b/i, boost: { code: 0.4 } },
  { re: /\b(what|which) (was|were|did)\b.*\b(i|my)\b.*\b(say|said|think|thought|decide|decided|mention|mentioned|had|idea)\b/i, boost: { recall_query: 0.55 } },
  { re: /\b(last (monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|yesterday|earlier|on my walk|while (i was )?(walking|driving))\b.*\?|\?.*\b(last (tuesday|week)|yesterday|earlier)\b/i, boost: { recall_query: 0.35 } },
  { re: /\b(i (need|have|gotta|should|must|want) to|need to|have to|remind me|todo|let'?s get)\b/i, boost: { action: 0.25 } },
  { re: /\b(maybe|or no|go(ing)? with|decided|it is then|leaning (towards|toward)|instead of|rather than|not .{1,20} but)\b.*\b(jwt|oauth2?|postgres|mongo|redis|queue|cron|session|monorepo|rest|graphql|fastify|express)\b/i, boost: { decision: 0.4 } },
  { re: /\b(pause memory|stop listening|off the record|go private|forget (that|this|the last))\b/i, boost: { privacy: 0.9 } },
  { re: /\b(scratch that|undo that|never mind the last|i meant|actually make it|not that one|the other one)\b/i, boost: { correction: 0.45 } },
  { re: /\b(sky|weather|coffee|hungry|beautiful|sunset|lovely|nice day|pouring|lunch|music today|calm afternoon)\b/i, boost: { journal: 0.3 } },
  // questions about one's OWN past speech / notes
  { re: /\b(where did i (land|leave|end up)|what did i (say|decide|think|note|mention|want)|remind me (what|about)|find (my|the|that) (notes?|thing|idea)|what (was|were) (the|that|my) (idea|thought|bug|decision|plan))\b/i, boost: { recall_query: 0.6 } },
  { re: /\b(gotta|got to|i keep meaning to|oh and i have to|should probably|let me (write|draft|fix|clean|update|check|sort))\b/i, boost: { action: 0.3 } },
  { re: /\b(final call|going with|i'?ll go with|let'?s keep|we(?:'| a)re not|we will not|okay,? (spaces|tabs)|either .{3,40} or)\b/i, boost: { decision: 0.4 } },
  { re: /\b(imagine if|what if|might be nice|it would be (cool|nice)|we could|how about|what about)\b/i, boost: { idea: 0.3 } },
  { re: /\b(drop a note|let \w+ know|owe \w+ a reply|status update|write to|send (the|a) (client|team))\b/i, boost: { communication: 0.3 } },
  { re: /\b(airport|o'clock|all hands|free up|put .{2,30} on the calendar|move the (retro|meeting|call|review)|be at)\b/i, boost: { scheduling: 0.3 } },
  { re: /\b(argon2|bloom filter|generator|topological|throttle|requestanimationframe|async await|promises|hash the)\b/i, boost: { code: 0.35 } },
  { re: /^(how many|how much|how long|how do|where did we|is the|are we|which|who|what's the)\b/i, boost: { question: 0.3 } },
  { re: /\b(was that my phone|hold on|one sec|sorry what|can you hear|testing|someone('s| is) at the door|do you want|bye)\b/i, boost: { aside: 0.5 } },
];

export class Triager {
  private ex: Ex[] = [];
  ready = false;

  constructor(private embedder: Embedder) {}

  async init(): Promise<void> {
    const flat: Array<{ label: Category; text: string }> = [];
    for (const c of CATEGORIES) for (const text of EXEMPLARS[c]) flat.push({ label: c, text });
    const embs: Float32Array[] = [];
    for (let i = 0; i < flat.length; i += 64) {
      embs.push(...(await this.embedder.embed(flat.slice(i, i + 64).map((f) => f.text), "passage")));
    }
    this.ex = flat.map((f, i) => ({ label: f.label, emb: embs[i] as Float32Array }));
    this.ready = true;
  }

  classify(text: string, emb: Float32Array, features = textFeatures(text)): Triage {
    const sims = this.ex
      .map((e) => ({ label: e.label, s: this.embedder.calibrate(dot(emb, e.emb)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, K);
    const score = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
    for (const { label, s } of sims) score[label] += Math.max(0, s) ** 3;
    const topSim = sims[0]?.s ?? 0;

    // lexical cue overlays
    for (const cue of CUES) {
      if (!cue.re.test(text)) continue;
      for (const [c, b] of Object.entries(cue.boost) as Array<[Category, number]>) score[c] += b * Math.max(0.4, topSim + 0.4);
    }
    // structural overlays
    if (features.disfluentOnly || features.contentWordCount === 0) score.aside += 1;
    if (features.isQuestion && features.contentWordCount >= 3) score.question += 0.12;
    if (features.hasRepairCue && /\b(jwt|oauth|vs|or)\b/i.test(text)) score.decision += 0.1;

    const total = Object.values(score).reduce((a, b) => a + b, 0) || 1;
    const probs = Object.fromEntries(CATEGORIES.map((c) => [c, score[c] / total])) as Record<Category, number>;
    let label: Category = "idea";
    let best = -1;
    for (const c of CATEGORIES) {
      if (probs[c] > best) {
        best = probs[c];
        label = c;
      }
    }
    // out of distribution: nothing in memory resembles this → weak "idea" rather than a confident guess
    const ood = topSim < 0.25 && Object.values(score).every((v) => v < 0.2);
    if (ood) label = features.contentWordCount >= 4 ? "idea" : "aside";
    return {
      label,
      probs,
      confidence: ood ? 0.3 : best,
      topSim,
      pNoise: features.disfluentOnly ? 1 : probs.aside,
      features,
    };
  }
}
