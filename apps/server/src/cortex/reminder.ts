import * as chrono from "chrono-node";
import { startOfDay, tzOffsetMinutes } from "../recall/time";
import { localIso } from "./prompts";

/* ============================================================================
 * Reminders (V1): "remind me to call the landlord tomorrow at 6" → what + when, in the user's timezone. Deterministic and
 * local; the offline cortex uses it, and the router uses it for a typed answer to "When?".
 *
 * Spoken times are underspecified, so: a bare hour from 1 to 7 means the afternoon or evening ("at 6" is 18:00; nobody sets
 * a 6 am call by saying "at 6"); a day without a time means 9:00; a time already past today means tomorrow.
 * ========================================================================== */

const HOUR = 3600_000;
const MIN = 60_000;
const REMIND_LEAD = /^\s*(?:(?:hey|ok(?:ay)?|so|and|oh|also)[,\s]+)*(?:please\s+)?(?:remind me(?:\s+(?:to|that|about))?|set (?:a|an) reminder(?:\s+(?:to|for))?|don'?t let me forget(?:\s+to)?)\s+/i;
export const REMIND = /\b(remind me|set (?:a|an) reminder|don'?t let me forget)\b/i;
const RECURRENCE = /\b(every\s+(?:day|morning|evening|night|week|weekday|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly)\b/i;
const DANGLING = /(?:\s+(?:at|on|by|for|in|around|about|before|after|this|next|tomorrow|tonight|today))+\s*$/i;

export interface SpokenTime {
  at: number;
  matched: string;
}

/** The first time the text names, resolved forward from `now` (see the rules above). */
export function spokenTime(text: string, now: number, tz: string): SpokenTime | null {
  const results = chrono.parse(text, { instant: new Date(now), timezone: tzOffsetMinutes(now, tz) }, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const s = r.start;
  const daySaid = s.isCertain("day") || s.isCertain("weekday");
  // the day that was said, or today (chrono's forwardDate would already have pushed a bare "at 4" past 04:00 to tomorrow)
  const day = startOfDay(daySaid ? s.date().getTime() : now, tz);
  let hour = 9; // a day without a time ("tomorrow", "on Friday"): 9 in the morning
  let minute = 0;
  if (s.isCertain("hour")) {
    hour = s.get("hour") ?? 0;
    minute = s.get("minute") ?? 0;
    if (!s.isCertain("meridiem") && hour >= 1 && hour <= 7) hour += 12;
  }
  let at = day + hour * HOUR + minute * MIN;
  if (at <= now && !daySaid) at += 24 * HOUR;
  return { at, matched: r.text };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export interface ReminderParts {
  what: string;
  due_iso: string | null;
  due_text: string | null;
  recurrence: string | null;
}

export function parseReminder(text: string, now: number, tz: string): ReminderParts {
  const recurrenceRaw = text.match(RECURRENCE)?.[1] ?? null;
  const recurrence = recurrenceRaw ? recurrenceRaw.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (d) => capitalize(d.toLowerCase())) : null;
  const time = spokenTime(text, now, tz);
  let what = text.replace(REMIND_LEAD, "");
  if (recurrenceRaw) what = what.replace(recurrenceRaw, " "); // first: "every Monday" contains the time text "Monday"
  if (time) what = what.replace(time.matched, " ");
  what = what
    .replace(/^\s*(?:to|that|about)\s+/i, "")
    .replace(/[.,!?;:…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(DANGLING, "")
    .replace(/[.,!?;:…\s]+$/g, "");
  return {
    what: capitalize(what || "Reminder"),
    due_iso: time ? localIso(time.at, tz) : null,
    due_text: time ? time.matched : null,
    recurrence,
  };
}

/**
 * A spoken change to a reminder's time: "make it 7" keeps the day and sets the hour (7 after 6 pm means 7 pm), "make it
 * Friday" keeps the time and moves the day, "make it Friday at 10am" sets both. Null when nothing time-like was said.
 */
export function reviseDue(oldIso: string | null, text: string, now: number, tz: string): { due_iso: string; matched: string } | null {
  const old = oldIso ? Date.parse(oldIso) : NaN;
  const bare = text.match(/\b(?:make it|change it to|move it to|to|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*[.!]?\s*$/i);
  if (bare && Number.isFinite(old) && !/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|next|week)\b/i.test(text)) {
    let h = Number(bare[1]);
    const m = Number(bare[2] ?? 0);
    const mer = bare[3]?.toLowerCase().replace(/\./g, "");
    if (h > 23 || m > 59) return null;
    const oldHour = Math.floor((old - startOfDay(old, tz)) / HOUR);
    if (mer === "pm" && h < 12) h += 12;
    else if (mer === "am" && h === 12) h = 0;
    else if (!mer && h < 12 && (oldHour >= 12 || (h >= 1 && h <= 7))) h += 12;
    return { due_iso: localIso(startOfDay(old, tz) + h * HOUR + m * MIN, tz), matched: bare[0].trim() };
  }
  const t = spokenTime(text, Number.isFinite(old) ? Math.min(old, now) : now, tz);
  if (!t) return null;
  const results = chrono.parse(text, { instant: new Date(now), timezone: tzOffsetMinutes(now, tz) }, { forwardDate: true });
  const hourSaid = results[0]?.start.isCertain("hour") ?? false;
  if (!hourSaid && Number.isFinite(old)) {
    // a new day, same time of day
    const timeOfDay = old - startOfDay(old, tz);
    return { due_iso: localIso(startOfDay(t.at, tz) + timeOfDay, tz), matched: t.matched };
  }
  return { due_iso: localIso(t.at, tz), matched: t.matched };
}
