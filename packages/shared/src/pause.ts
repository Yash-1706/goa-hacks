/* ============================================================================
 * Pause-intent matcher: "pause memory", "off the record", "stop listening", ...
 * Pure and dependency-free: the browser uses it for the instant client-side kill
 * switch, the server uses the same code as the backstop (TRD §5.6, §8.4, §10.2).
 *
 * Matching is fuzzy (edit distance) so whispered / mis-transcribed variants still
 * trigger, but only for SHORT, command-shaped utterances so a sentence such as
 * "we should pause recording the metrics" does not pause the system.
 * ========================================================================== */

export interface PauseMatch {
  match: boolean;
  score: number;
  phrase?: string;
}

export const PAUSE_PHRASES: readonly string[] = [
  "pause memory",
  "pause the memory",
  "pause my memory",
  "memory pause",
  "pause recording",
  "pause the recording",
  "pause listening",
  "pause synapse",
  "synapse pause",
  "stop memory",
  "stop the memory",
  "stop listening",
  "stop recording",
  "stop capturing",
  "turn off memory",
  "turn off the memory",
  "memory off",
  "mute memory",
  "off the record",
  "go off the record",
  "go private",
  "private mode",
  "privacy mode",
  "dont remember this",
  "do not remember this",
  "dont record this",
  "do not record this",
  // Hinglish / Hindi (romanized)
  "memory band karo",
  "memory band kar do",
  "memory rok do",
  "recording band karo",
  "sunna band karo",
  "record mat karo",
  "yaad mat rakhna",
];

/** words that may surround the command without changing its meaning */
const POLITE = new Set(["please", "now", "okay", "ok", "hey", "synapse", "right", "just", "for", "a", "bit", "while", "moment", "thanks", "thank", "you", "yeah", "um", "uh", "hmm", "can", "could", "you", "will", "kindly", "so", "and", "then", "i", "want", "to", "need", "would", "like"]);

export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function editDist(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

const PHRASE_TOKENS = PAUSE_PHRASES.map((p) => ({ phrase: p, tokens: foldText(p).split(" ") }));

export function matchPauseIntent(text: string): PauseMatch {
  const folded = foldText(text);
  if (!folded) return { match: false, score: 0 };
  const toks = folded.split(" ");
  if (toks.length > 12) return { match: false, score: 0 };

  let best: PauseMatch = { match: false, score: 0 };
  for (const { phrase, tokens } of PHRASE_TOKENS) {
    const m = tokens.length;
    for (const size of [m, m - 1, m + 1]) {
      if (size < 1 || size > toks.length) continue;
      for (let i = 0; i + size <= toks.length; i++) {
        const window = toks.slice(i, i + size).join(" ");
        const target = tokens.join(" ");
        const dist = editDist(window, target);
        const allowed = target.length >= 12 ? 3 : target.length >= 8 ? 2 : 1;
        if (dist > allowed) continue;
        // command-shaped: what is left outside the matched window must be polite filler
        const rest = [...toks.slice(0, i), ...toks.slice(i + size)].filter((t) => !POLITE.has(t));
        if (rest.length > 1) continue;
        const score = 1 - dist / Math.max(window.length, target.length);
        if (score > best.score) best = { match: true, score, phrase };
      }
    }
  }
  return best;
}
