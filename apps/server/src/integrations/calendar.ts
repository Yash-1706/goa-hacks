import type { CalendarEventView } from "@synapse/shared";
import type { Config } from "../config";
import type { MemoryStore } from "../memory/store";
import type { CalendarRec } from "../memory/types";
import { startOfDay, tzOffsetMinutes } from "../recall/time";

/* ============================================================================
 * Local calendar model (TRD §12.3): conflict detection, free-slot finding, .ics export.
 * Real calendars (Google) are P2; this is enough to make "reschedule?" suggestions concrete.
 * ========================================================================== */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const view = (c: CalendarRec): CalendarEventView => ({ id: c.id, title: c.title, start: c.start, end: c.end, source: c.source });

export function listEvents(store: MemoryStore): CalendarRec[] {
  return [...store.calendar.values()].sort((a, b) => a.start - b.start);
}

/** Pairs of events that overlap in time. */
export function conflicts(events: CalendarRec[]): Array<[CalendarRec, CalendarRec]> {
  const out: Array<[CalendarRec, CalendarRec]> = [];
  const sorted = [...events].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as CalendarRec;
      const b = sorted[j] as CalendarRec;
      if (b.start >= a.end) break;
      out.push([a, b]);
    }
  }
  return out;
}

/** The next `count` free slots of `minutes` within working hours over the next `days` business days. */
export function findSlots(
  store: MemoryStore,
  cfg: Pick<Config, "timezone">,
  now: number,
  o: { count?: number; minutes?: number; days?: number; workStart?: number; workEnd?: number; avoid?: Array<{ start: number; end: number }> } = {},
): Array<{ start: number; end: number; label: string }> {
  const count = o.count ?? 3;
  const dur = (o.minutes ?? 30) * 60_000;
  const ws = o.workStart ?? 9.5;
  const we = o.workEnd ?? 18.5;
  const busy = [...listEvents(store).map((e) => ({ start: e.start, end: e.end })), ...(o.avoid ?? [])];
  const slots: Array<{ start: number; end: number; label: string }> = [];
  const off = tzOffsetMinutes(now, cfg.timezone);
  let day = startOfDay(now, cfg.timezone);
  for (let d = 0, seen = 0; d < 14 && seen < (o.days ?? 3) && slots.length < count; d++, day += DAY) {
    const dow = new Date(day + off * 60_000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    seen++;
    let today = 0;
    let lastStart = -Infinity;
    for (let t = day + ws * HOUR; t + dur <= day + we * HOUR && slots.length < count && today < 2; t += 30 * 60_000) {
      if (t < now + 15 * 60_000) continue;
      if (t - lastStart < 2 * HOUR) continue; // spread the options out instead of listing back-to-back half hours
      if (busy.some((b) => t < b.end && t + dur > b.start)) continue;
      slots.push({ start: t, end: t + dur, label: fmtSlot(t, cfg.timezone, now) });
      lastStart = t;
      today++;
    }
  }
  return slots;
}

export function fmtSlot(ms: number, tz: string, now: number): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
  const same = startOfDay(ms, tz) === startOfDay(now, tz);
  const tomorrow = startOfDay(ms, tz) === startOfDay(now + DAY, tz);
  return `${same ? "Today" : tomorrow ? "Tomorrow" : day} ${time}`;
}

const icsDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

export function toIcs(e: { id: string; title: string; start: number; end: number; description?: string; /** a display alarm this many minutes before the start */ alarmMinutes?: number }): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Synapse//Voice second brain//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.id}@synapse.local`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end)}`,
    `SUMMARY:${esc(e.title)}`,
    e.description ? `DESCRIPTION:${esc(e.description)}` : "",
    ...(e.alarmMinutes !== undefined ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${Math.max(0, Math.round(e.alarmMinutes))}M`, "END:VALARM"] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

/**
 * Keep a realistic demo calendar (incl. the demo conflict: Thursday standup vs dentist) for THIS week and NEXT week,
 * so "Thursday" always has a clash to find, whenever the database was created. Idempotent per week; seed events from
 * weeks that are over are dropped; events the person added (voice / manual) are never touched.
 */
export function seedCalendar(store: MemoryStore, cfg: Pick<Config, "timezone">, now: number): void {
  const tz = cfg.timezone;
  const off = tzOffsetMinutes(now, tz);
  const today = startOfDay(now, tz);
  const dow = new Date(today + off * 60_000).getUTCDay(); // 0=Sun
  const thisMonday = today - ((dow + 6) % 7) * DAY;

  for (const rec of [...store.calendar.values()]) if (rec.source === "seed" && rec.end < thisMonday) store.removeCalendar(rec.id);

  for (const week of [0, 1]) {
    const monday = thisMonday + week * 7 * DAY;
    const weekEnd = monday + 7 * DAY;
    if ([...store.calendar.values()].some((c) => c.source === "seed" && c.start >= monday && c.start < weekEnd)) continue;
    const at = (dayOffset: number, h: number, m = 0): number => monday + dayOffset * DAY + (h + m / 60) * HOUR;
    const ev = (title: string, d: number, h: number, m: number, mins: number): void => {
      store.addCalendar(title, at(d, h, m), at(d, h, m) + mins * 60_000, "seed");
    };
    // the demo conflict: Thursday standup vs dentist
    ev("Team standup", 3, 10, 0, 30);
    ev("Dentist appointment", 3, 10, 0, 60);
    ev("Team standup", 0, 10, 0, 30);
    ev("Team standup", 1, 10, 0, 30);
    ev("Team standup", 2, 10, 0, 30);
    ev("Team standup", 4, 10, 0, 30);
    ev("Sprint planning", 0, 14, 0, 60);
    ev("1:1 with Sarah", 2, 15, 0, 30);
    ev("Design review", 1, 16, 0, 45);
    ev("Release sync", 4, 15, 30, 30);
    ev("Lunch with Dev", 3, 13, 0, 60);
  }
}
