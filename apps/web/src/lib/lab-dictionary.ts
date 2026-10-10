import type { DictionaryTerm } from "@synapse/shared";

/* ============================================================================
 * Self-healing dictionary view logic (PRD MEM-5, TRD §10.7). The server stores a free-text `source` per term:
 *   "learned from T-12"                          the cortex found the name in a thought
 *   "team" | "seed"                              configured people / the seed script
 *   `corrected "card service" → "cart-service" in T-5`   a mis-hearing the cortex repaired (the interesting one)
 * ========================================================================== */

export type DictKind = DictionaryTerm["kind"];

export const KIND_ORDER: readonly DictKind[] = ["person", "component", "technology", "project", "jargon"];

export interface KindMeta {
  label: string;
  plural: string;
  /** CSS colour for the tag dot and tint (not status colours: those are reserved for good/bad) */
  tint: string;
  gloss: string;
}

export const KIND_META: Record<DictKind, KindMeta> = {
  person: { label: "person", plural: "People", tint: "#e879f9", gloss: "Names Wispr should spell right" },
  component: { label: "component", plural: "Components", tint: "#2dd4bf", gloss: "Services, modules, endpoints" },
  technology: { label: "technology", plural: "Technologies", tint: "#a78bfa", gloss: "Frameworks, protocols, tools" },
  project: { label: "project", plural: "Projects", tint: "#fb923c", gloss: "Things you are building" },
  jargon: { label: "jargon", plural: "Jargon", tint: "#94a3b8", gloss: "Words you keep repeating" },
};

export type ParsedSource =
  | { type: "corrected"; heard: string; term: string; thought?: string }
  | { type: "learned"; thought: string }
  | { type: "team" }
  | { type: "seed" }
  | { type: "other"; text: string };

const CORRECTED = /^corrected\s+["“]([^"”]+)["”]\s*(?:→|->|=>)\s*["“]([^"”]+)["”](?:\s+in\s+(T-\d+))?/i;
const LEARNED = /^learned from\s+(T-\d+)/i;

export function parseDictSource(source: string): ParsedSource {
  const s = source.trim();
  const c = CORRECTED.exec(s);
  if (c) return { type: "corrected", heard: c[1] as string, term: c[2] as string, thought: c[3] };
  const l = LEARNED.exec(s);
  if (l) return { type: "learned", thought: l[1] as string };
  if (/^team$/i.test(s)) return { type: "team" };
  if (/^seed$/i.test(s)) return { type: "seed" };
  return { type: "other", text: s };
}

/** a term the cortex repaired from a mis-hearing */
export const isHealed = (t: Pick<DictionaryTerm, "source">): boolean => parseDictSource(t.source).type === "corrected";

export interface DictCounts {
  total: number;
  byKind: Record<DictKind, number>;
  healed: number;
}

export function countTerms(terms: readonly DictionaryTerm[]): DictCounts {
  const byKind: Record<DictKind, number> = { person: 0, component: 0, technology: 0, project: 0, jargon: 0 };
  let healed = 0;
  for (const t of terms) {
    if (t.kind in byKind) byKind[t.kind]++;
    if (isHealed(t)) healed++;
  }
  return { total: terms.length, byKind, healed };
}

export type DictFilter = DictKind | "all" | "healed";

/** best first: repaired mis-hearings, then by salience, then most recently seen, then alphabetical */
export function sortTerms(terms: readonly DictionaryTerm[]): DictionaryTerm[] {
  return [...terms].sort((a, b) => {
    const ha = isHealed(a) ? 1 : 0;
    const hb = isHealed(b) ? 1 : 0;
    if (ha !== hb) return hb - ha;
    if (b.salience !== a.salience) return b.salience - a.salience;
    if (b.lastSeen !== a.lastSeen) return b.lastSeen - a.lastSeen;
    return a.term.localeCompare(b.term);
  });
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

/** filter by kind (or "healed") and a free-text query over the term and its source ("cart service" finds cart-service) */
export function filterTerms(terms: readonly DictionaryTerm[], opts: { filter?: DictFilter; query?: string } = {}): DictionaryTerm[] {
  const filter = opts.filter ?? "all";
  const q = (opts.query ?? "").trim().toLowerCase();
  const qs = squash(q);
  return terms.filter((t) => {
    if (filter === "healed" && !isHealed(t)) return false;
    if (filter !== "all" && filter !== "healed" && t.kind !== filter) return false;
    if (!q) return true;
    const hay = `${t.term} ${t.source} ${t.kind}`.toLowerCase();
    return hay.includes(q) || squash(hay).includes(qs);
  });
}

/** which of the terms Wispr is being primed with right now (case-insensitive) */
export function primedSet(primed: readonly string[] | undefined | null): Set<string> {
  return new Set((primed ?? []).map((p) => p.toLowerCase()));
}
