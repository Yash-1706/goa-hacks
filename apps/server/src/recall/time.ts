import * as chrono from "chrono-node";

/* ============================================================================
 * Temporal expressions → time ranges (TRD §4.1). chrono-node returns a point in time,
 * so ranges are built here: whole days, part-of-day windows, "earlier in the hackathon".
 * ========================================================================== */

export interface TimeRange {
  from: number;
  to: number;
  label: string;
  /** the exact words matched, so callers can strip them from a search query */
  matched: string;
  /** the concrete instant when the words named a time of day ("Thursday at 3pm"); otherwise undefined */
  point?: number;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** UTC offset (minutes) of an IANA zone at an instant. */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const wall = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(ms)
    .replace(" ", "T");
  return Math.round((Date.parse(`${wall}Z`) - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Epoch ms of 00:00 local time (in tz) of the day containing `ms`. */
export function startOfDay(ms: number, tz: string): number {
  const off = tzOffsetMinutes(ms, tz);
  const local = ms + off * 60_000;
  return Math.floor(local / DAY) * DAY - off * 60_000;
}

const PART_OF_DAY: Array<{ re: RegExp; from: number; to: number; name: string }> = [
  { re: /\bmorning\b/i, from: 5, to: 12, name: "morning" },
  { re: /\bafternoon\b/i, from: 12, to: 17, name: "afternoon" },
  { re: /\bevening\b/i, from: 17, to: 22, name: "evening" },
  { re: /\bnight\b/i, from: 22, to: 29, name: "night" },
  { re: /\bnoon\b/i, from: 11, to: 14, name: "noon" },
];

function partOfDay(text: string): { from: number; to: number; name: string } | null {
  for (const p of PART_OF_DAY) if (p.re.test(text)) return p;
  return null;
}

/**
 * `opts.future`: a bare weekday means the NEXT one (scheduling: "call the vendor on Thursday").
 * The default resolves to the closest one, which for recall ("what I said Tuesday") is usually past.
 */
export function chronoRange(text: string, now: number, tz: string, hackathonStart?: number, opts: { future?: boolean } = {}): TimeRange | null {
  const t = text.toLowerCase();
  const today = startOfDay(now, tz);

  // ---- phrases chrono does not model as ranges
  let m = t.match(/\b(earlier in the hackathon|so far in the hackathon|during the hackathon|since the hackathon started|earlier in this hackathon)\b/);
  if (m && hackathonStart) return { from: hackathonStart, to: now, label: "earlier in the hackathon", matched: m[0] };
  m = t.match(/\bearlier today\b/);
  if (m) return { from: today, to: now, label: "earlier today", matched: m[0] };
  m = t.match(/\blast night\b/);
  if (m) return { from: today - 6 * HOUR, to: today + 5 * HOUR, label: "last night", matched: m[0] };
  m = t.match(/\b(this|today)\s+(morning|afternoon|evening)\b/);
  if (m) {
    const p = partOfDay(m[2] ?? "") as { from: number; to: number };
    return { from: today + p.from * HOUR, to: Math.min(now, today + p.to * HOUR), label: m[0], matched: m[0] };
  }
  m = t.match(/\ba (few|couple of) days ago\b/);
  if (m) return { from: today - 5 * DAY, to: today - 1 * DAY, label: "a few days ago", matched: m[0] };
  m = t.match(/\b(the other day)\b/);
  if (m) return { from: today - 4 * DAY, to: today, label: "the other day", matched: m[0] };
  m = t.match(/\blast week\b/);
  if (m) {
    const dow = new Date(now + tzOffsetMinutes(now, tz) * 60_000).getUTCDay(); // local weekday, 0 = Sunday
    const sinceMonday = (dow + 6) % 7;
    const thisMonday = today - sinceMonday * DAY;
    return { from: thisMonday - 7 * DAY, to: thisMonday, label: "last week", matched: m[0] };
  }

  // ---- everything else: chrono
  const off = tzOffsetMinutes(now, tz);
  const results = chrono.parse(text, { instant: new Date(now), timezone: off }, { forwardDate: opts.future ?? false });
  const r = results.find((x) => x.start.isCertain("day") || x.start.isCertain("weekday") || x.start.isCertain("month") || x.start.isCertain("hour"));
  if (!r) return null;

  const start = r.start.date().getTime();
  const dayStart = startOfDay(start, tz);
  const pod = partOfDay(text);
  if (pod && !r.start.isCertain("hour")) {
    return { from: dayStart + pod.from * HOUR, to: dayStart + pod.to * HOUR, label: r.text, matched: r.text };
  }
  if (r.start.isCertain("hour")) {
    const end = r.end?.date().getTime() ?? start;
    return { from: start - HOUR, to: Math.max(end, start) + HOUR, label: r.text, matched: r.text, point: start };
  }
  if (r.end) return { from: dayStart, to: startOfDay(r.end.date().getTime(), tz) + DAY, label: r.text, matched: r.text };
  return { from: dayStart, to: dayStart + DAY, label: r.text, matched: r.text };
}

/** Remove matched time/place phrases from a spoken query so the topic is clean. */
export function stripPhrases(text: string, phrases: string[]): string {
  let out = text;
  for (const p of phrases) if (p) out = out.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  return out.replace(/\s+/g, " ").trim();
}
