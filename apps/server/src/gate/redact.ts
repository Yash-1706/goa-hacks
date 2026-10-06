/* ============================================================================
 * Redaction before any cloud call (PRD PRV-6, TRD §10.6).
 * Sensitive spans are replaced with stable placeholders ([EMAIL_1], [SECRET_2], ...),
 * the model is told to treat them as opaque tokens, and placeholders in its answer are
 * rehydrated locally. Optional pseudonymization of known person names.
 * ========================================================================== */

export interface Redaction {
  text: string;
  map: Array<{ placeholder: string; original: string; kind: string }>;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** return false to skip a false positive */
  accept?: (match: string) => boolean;
  /** capture group to redact instead of the whole match */
  group?: number;
}

const RULES: Rule[] = [
  { kind: "SECRET", re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g },
  { kind: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    kind: "CARD",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  { kind: "ID", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g }, // PAN
  { kind: "ID", re: /\b\d{3}-\d{2}-\d{4}\b/g }, // SSN
  { kind: "ID", re: /\b\d{4}\s\d{4}\s\d{4}\b/g }, // Aadhaar (spaced)
  { kind: "IBAN", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { kind: "IP", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, accept: (m) => m.split(".").every((p) => Number(p) <= 255) },
  {
    kind: "PHONE",
    re: /(?<![\w.])\+?\d[\d\s().-]{8,16}\d(?![\w])/g,
    accept: (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 9 && d.length <= 15;
    },
  },
  // spoken credentials: "the password is hunter two", "pin 4 4 1 2", "api key is ..."
  {
    kind: "SECRET",
    re: /\b(?:password|passcode|passphrase|pin|otp|secret|api key|token)\s*(?:is|was|=|:)?\s+((?:\S+\s*){1,4})/gi,
    group: 1,
  },
];

/**
 * Redact one string. Pass shared `counters` + `map` to keep placeholder numbering unique
 * across every string of one prompt (see `createRedactor`).
 */
export function redact(input: string, counters: Record<string, number> = {}, map: Redaction["map"] = []): Redaction {
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      const whole = args[0] as string;
      if (rule.accept && !rule.accept(whole)) return whole;
      if (/^\[[A-Z]+_\d+\]$/.test(whole.trim())) return whole;
      const target = rule.group ? (args[rule.group] as string | undefined) : whole;
      if (!target || /\[[A-Z]+_\d+\]/.test(target)) return whole;
      counters[rule.kind] = (counters[rule.kind] ?? 0) + 1;
      const placeholder = `[${rule.kind}_${counters[rule.kind]}]`;
      map.push({ placeholder, original: target.trim(), kind: rule.kind });
      return rule.group ? whole.replace(target, `${placeholder} `) : placeholder;
    });
  }
  return { text, map };
}

/** Stateful redactor for one outgoing prompt: consistent placeholders, one rehydration map. */
export function createRedactor(opts: { pseudonymizeNames?: string[] } = {}) {
  const counters: Record<string, number> = {};
  const map: Redaction["map"] = [];
  const names = opts.pseudonymizeNames ?? [];
  return {
    text(input: string): string {
      let out = redact(input, counters, map).text;
      if (names.length) {
        const p = pseudonymize(out, names);
        out = p.text;
        for (const m of p.map) if (!map.some((x) => x.placeholder === m.placeholder)) map.push(m);
      }
      return out;
    },
    get map(): Redaction["map"] {
      return map;
    },
    /** values hidden from the cloud (PII + pseudonyms) */
    get count(): number {
      return map.length;
    },
  };
}

/** Replace known person names with [PERSON_A], [PERSON_B], ... (optional, PSEUDONYMIZE_PERSONS). */
export function pseudonymize(input: string, names: string[]): Redaction {
  const map: Redaction["map"] = [];
  let text = input;
  names.forEach((name, i) => {
    if (!name || name.length < 2) return;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (!re.test(text)) return;
    const placeholder = `[PERSON_${String.fromCharCode(65 + (i % 26))}]`;
    text = text.replace(re, placeholder);
    map.push({ placeholder, original: name, kind: "PERSON" });
  });
  return { text, map };
}

export function mergeRedactions(...rs: Redaction[]): Redaction["map"] {
  return rs.flatMap((r) => r.map);
}

/** Restore placeholders inside any JSON-ish value (strings, arrays, objects). */
export function rehydrate<T>(value: T, map: Redaction["map"]): T {
  if (map.length === 0) return value;
  const sub = (s: string): string => {
    let out = s;
    for (const m of map) out = out.split(m.placeholder).join(m.original);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
