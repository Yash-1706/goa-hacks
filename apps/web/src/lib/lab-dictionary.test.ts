import { describe, expect, it } from "vitest";
import type { DictionaryTerm } from "@synapse/shared";
import { KIND_META, KIND_ORDER, countTerms, filterTerms, isHealed, parseDictSource, primedSet, sortTerms } from "./lab-dictionary";

const t = (term: string, kind: DictionaryTerm["kind"], source: string, salience = 0.6, lastSeen = 1000): DictionaryTerm => ({ term, kind, source, salience, lastSeen });

const TERMS: DictionaryTerm[] = [
  t("Sarah", "person", "team", 0.9, 100),
  t("Rio", "person", "seed", 0.9, 50),
  t("cart-service", "component", "learned from T-1", 0.6, 300),
  t("JWT", "technology", "learned from T-2", 0.6, 200),
  t("OAuth2", "technology", "learned from T-2", 0.6, 250),
  t("Postgres", "technology", 'corrected "post grass" → "Postgres" in T-7', 0.8, 400),
  t("standup", "jargon", "learned from T-9", 0.55, 10),
];

describe("parseDictSource", () => {
  it("recognises a repaired mis-hearing, with either arrow and straight or curly quotes", () => {
    expect(parseDictSource('corrected "card service" → "cart-service" in T-5')).toEqual({ type: "corrected", heard: "card service", term: "cart-service", thought: "T-5" });
    expect(parseDictSource('corrected "card service" -> "cart-service"')).toEqual({ type: "corrected", heard: "card service", term: "cart-service", thought: undefined });
    expect(parseDictSource("corrected “card service” → “cart-service” in T-12")).toMatchObject({ type: "corrected", heard: "card service", thought: "T-12" });
  });

  it("recognises where a plain term was learned", () => {
    expect(parseDictSource("learned from T-181")).toEqual({ type: "learned", thought: "T-181" });
    expect(parseDictSource("  Learned from T-2 ")).toEqual({ type: "learned", thought: "T-2" });
  });

  it("recognises configured sources and keeps unknown ones verbatim", () => {
    expect(parseDictSource("team")).toEqual({ type: "team" });
    expect(parseDictSource("seed")).toEqual({ type: "seed" });
    expect(parseDictSource("imported by hand")).toEqual({ type: "other", text: "imported by hand" });
    expect(parseDictSource("")).toEqual({ type: "other", text: "" });
  });
});

describe("healed terms", () => {
  it("flags only repaired mis-hearings", () => {
    expect(TERMS.filter(isHealed).map((x) => x.term)).toEqual(["Postgres"]);
  });
});

describe("counting", () => {
  it("counts every kind (including empty ones) and the healed terms", () => {
    const c = countTerms(TERMS);
    expect(c.total).toBe(7);
    expect(c.byKind).toEqual({ person: 2, component: 1, technology: 3, project: 0, jargon: 1 });
    expect(c.healed).toBe(1);
    expect(countTerms([])).toEqual({ total: 0, byKind: { person: 0, component: 0, technology: 0, project: 0, jargon: 0 }, healed: 0 });
  });

  it("has metadata for every kind", () => {
    for (const k of KIND_ORDER) {
      expect(KIND_META[k].label).toBe(k);
      expect(KIND_META[k].tint).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("sorting", () => {
  it("puts repaired terms first, then by salience, recency and name", () => {
    expect(sortTerms(TERMS).map((x) => x.term)).toEqual(["Postgres", "Sarah", "Rio", "cart-service", "OAuth2", "JWT", "standup"]);
  });

  it("does not mutate its input", () => {
    const copy = [...TERMS];
    sortTerms(TERMS);
    expect(TERMS).toEqual(copy);
  });
});

describe("filtering", () => {
  it("filters by kind", () => {
    expect(filterTerms(TERMS, { filter: "technology" }).map((x) => x.term)).toEqual(["JWT", "OAuth2", "Postgres"]);
    expect(filterTerms(TERMS, { filter: "project" })).toEqual([]);
    expect(filterTerms(TERMS, { filter: "all" })).toHaveLength(7);
    expect(filterTerms(TERMS)).toHaveLength(7);
  });

  it("filters the healed ones", () => {
    expect(filterTerms(TERMS, { filter: "healed" }).map((x) => x.term)).toEqual(["Postgres"]);
  });

  it("searches term, source and kind, ignoring case, spaces and dashes", () => {
    expect(filterTerms(TERMS, { query: "cart service" }).map((x) => x.term)).toEqual(["cart-service"]);
    expect(filterTerms(TERMS, { query: "CART-SERVICE" }).map((x) => x.term)).toEqual(["cart-service"]);
    expect(filterTerms(TERMS, { query: "t-2" }).map((x) => x.term)).toEqual(["JWT", "OAuth2"]);
    expect(filterTerms(TERMS, { query: "post grass" }).map((x) => x.term)).toEqual(["Postgres"]);
    expect(filterTerms(TERMS, { query: "person" }).map((x) => x.term)).toEqual(["Sarah", "Rio"]);
    expect(filterTerms(TERMS, { query: "zzz" })).toEqual([]);
  });

  it("combines kind and query", () => {
    expect(filterTerms(TERMS, { filter: "technology", query: "oauth" }).map((x) => x.term)).toEqual(["OAuth2"]);
    expect(filterTerms(TERMS, { filter: "person", query: "oauth" })).toEqual([]);
  });
});

describe("primedSet", () => {
  it("lower-cases the terms Wispr is primed with", () => {
    const s = primedSet(["Sarah", "OAuth2"]);
    expect(s.has("sarah")).toBe(true);
    expect(s.has("oauth2")).toBe(true);
    expect(s.has("jwt")).toBe(false);
    expect(primedSet(null).size).toBe(0);
    expect(primedSet(undefined).size).toBe(0);
  });
});
