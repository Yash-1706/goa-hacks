/* Small, dependency-free text helpers shared by the gate, cortex and recall. */

export const FILLERS = new Set([
  "uh", "uhh", "um", "umm", "uhm", "er", "erm", "hmm", "hm", "mm", "mmm", "ah", "ahh", "eh",
  "like", "basically", "literally", "actually", "so", "well", "okay", "ok", "right", "yeah", "yep",
  "you", "know", "i", "mean", "kinda", "sorta", "matlab", "toh", "yaar", "haan", "accha", "arre",
]);

const DISFLUENT_ONLY = new Set(["uh", "uhh", "um", "umm", "uhm", "er", "erm", "hmm", "hm", "mm", "mmm", "ah", "ahh", "eh"]);

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** lowercase, strip diacritics + punctuation (keeps Devanagari), collapse spaces */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ऀ-ॿ\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function words(s: string): string[] {
  const f = fold(s);
  return f ? f.split(" ") : [];
}

export function contentWords(s: string): string[] {
  return words(s).filter((w) => !FILLERS.has(w) && w.length > 1);
}

export interface TextFeatures {
  wordCount: number;
  contentWordCount: number;
  fillerRatio: number;
  disfluentOnly: boolean;
  incomplete: boolean;
  isQuestion: boolean;
  startsWithRepairCue: boolean;
  hasRepairCue: boolean;
  startsWithConnector: boolean;
  hedged: boolean;
}

const REPAIR_CUE = /\b(or no|no wait|no,? wait|wait no|actually|i mean|scratch that|rather|not that|no no|nahi|nahin|correction|sorry)\b/i;
const REPAIR_START = /^(or no|no wait|no,? wait|wait no|actually|i mean|scratch that|rather|no no|no,|nahi|or,? maybe|or actually)\b/i;
const CONNECTOR_START = /^(and|or|but|so|then|also|plus|because|which|that|the one|in the|on the|with the|probably|maybe)\b/i;
const HEDGE = /\b(maybe|probably|perhaps|i think|i guess|might|could be|not sure|kind of|sort of|shayad)\b/i;
const QUESTION_LEAD = /^(what|why|how|when|where|who|which|did|do|does|is|are|was|were|can|could|should|would|will)\b/i;
const TRAILING_OPEN = /(\.\.\.|…|,|-|–)\s*$/;
const DANGLING_END = /\b(and|or|but|with|the|to|of|a|an|in|on|for|that|which|because|if|so|ki|aur|ya|ka|ke|ko)\s*$/i;

export function textFeatures(raw: string): TextFeatures {
  const ws = words(raw);
  const content = ws.filter((w) => !FILLERS.has(w) && w.length > 1);
  const fillers = ws.filter((w) => FILLERS.has(w)).length;
  const t = normalizeText(raw);
  return {
    wordCount: ws.length,
    contentWordCount: content.length,
    fillerRatio: ws.length ? fillers / ws.length : 0,
    disfluentOnly: ws.length > 0 && ws.every((w) => DISFLUENT_ONLY.has(w)),
    incomplete: TRAILING_OPEN.test(t) || DANGLING_END.test(t) || (content.length > 0 && content.length < 3 && !/[.!?]$/.test(t)),
    isQuestion: /\?\s*$/.test(t) || QUESTION_LEAD.test(t),
    startsWithRepairCue: REPAIR_START.test(t),
    hasRepairCue: REPAIR_CUE.test(t),
    startsWithConnector: CONNECTOR_START.test(t),
    hedged: HEDGE.test(t),
  };
}

/** Jaccard overlap of content-word sets (cheap lexical similarity). */
export function jaccard(a: string, b: string): number {
  const A = new Set(contentWords(a));
  const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Damerau–Levenshtein (optimal string alignment) distance, for fuzzy phrase matching. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j <= n; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((d[i - 1] as number[])[j]! + 1, (d[i] as number[])[j - 1]! + 1, (d[i - 1] as number[])[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (d[i - 2] as number[])[j - 2]! + 1);
      (d[i] as number[])[j] = v;
    }
  }
  return (d[m] as number[])[n] as number;
}

/** A short working title from raw speech: drop fillers/leading connectors, keep ~8 content words. */
export function quickTitle(raw: string, maxWords = 8): string {
  const cleaned = normalizeText(raw)
    .replace(/\b(uh+|um+|hmm+|er+|ah+)\b[,.]?/gi, "")
    .replace(/\.{2,}|…/g, " ")
    .replace(/^(so|well|okay|ok|and|or|but|like|yeah|right|actually)[, ]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean).slice(0, maxWords);
  const t = parts.join(" ").replace(/[,;:\-–]+$/, "");
  return t ? t[0]!.toUpperCase() + t.slice(1) : "…";
}
