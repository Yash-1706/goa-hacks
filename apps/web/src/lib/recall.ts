/* ============================================================================
 * Recall helpers (pure). The streamed answer cites sources as [T-12] or [T-12, T-14]; the UI turns those
 * into clickable chips that jump to the source card.
 * ========================================================================== */

export type AnswerSegment = { t: "text"; v: string } | { t: "cite"; codes: string[] };

const CITE = /\[\s*(T-\d+(?:\s*,\s*T-\d+)*)\s*\]/g;

/** Split an answer into plain text and citation segments. Tolerates a half-streamed "[T-1" tail. */
export function parseAnswer(text: string): AnswerSegment[] {
  const out: AnswerSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: text.slice(last, at) });
    out.push({ t: "cite", codes: (m[1] as string).split(/\s*,\s*/) });
    last = at + m[0].length;
  }
  let tail = text.slice(last);
  // hide a citation that is still being typed: "…as noted [T-1"
  const partial = /\[\s*T?-?\d*(?:\s*,\s*T?-?\d*)*$/.exec(tail);
  if (partial && partial.index !== undefined) tail = tail.slice(0, partial.index);
  if (tail) out.push({ t: "text", v: tail });
  return out;
}

/** Codes cited anywhere in the text (deduplicated, in order of first mention). */
export function citedCodes(text: string): string[] {
  const seen = new Set<string>();
  for (const seg of parseAnswer(text)) if (seg.t === "cite") for (const c of seg.codes) seen.add(c);
  return [...seen];
}

/** DOM id of a source card (used for citation → source scrolling). */
export const sourceDomId = (code: string): string => `src-${code}`;

/** Local, on-device voices only: some browser voices are cloud-backed and would send the answer elsewhere. */
export function pickLocalVoice<V extends { localService: boolean; lang: string; default?: boolean }>(voices: readonly V[], preferredLang = "en"): V | null {
  const local = voices.filter((v) => v.localService);
  if (!local.length) return null;
  const lang = preferredLang.toLowerCase();
  return local.find((v) => v.lang.toLowerCase().startsWith(lang) && v.default) ?? local.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? local.find((v) => v.default) ?? local[0] ?? null;
}
