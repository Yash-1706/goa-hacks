import type { Activity } from "@synapse/shared";

/* ============================================================================
 * Display helpers. All pure (except the configurable display time zone) so they are unit-tested.
 * Labels intentionally match the server's (en-GB, 24h) so "Thu 10:30" means the same on both sides.
 * ========================================================================== */

let displayTz: string | undefined;
/** Use the server's configured time zone for every absolute time we print. */
export function setDisplayTimezone(tz: string | undefined): void {
  displayTz = tz;
  cache.clear();
}

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${displayTz ?? ""}|${key}`;
  let f = cache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: displayTz });
    } catch {
      f = new Intl.DateTimeFormat("en-GB", opts); // unknown time zone name: fall back to the device's
    }
    cache.set(k, f);
  }
  return f;
}

/** "10:42" */
export function formatClock(ms: number): string {
  return dtf("clock", { hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

/** "10:42:07" */
export function formatClockSeconds(ms: number): string {
  return dtf("clock-s", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(ms);
}

const dayKey = (ms: number): string => dtf("day", { year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** "Today 10:42" | "Yesterday 16:10" | "Mon 11:20" (this week) | "12 Oct 11:20" */
export function formatDayTime(ms: number, now = Date.now()): string {
  const time = formatClock(ms);
  const d = dayKey(ms);
  if (d === dayKey(now)) return `Today ${time}`;
  if (d === dayKey(now - 86_400_000)) return `Yesterday ${time}`;
  if (now - ms < 6 * 86_400_000 && ms < now) return `${dtf("wd", { weekday: "short" }).format(ms)} ${time}`;
  return `${dtf("dm", { day: "numeric", month: "short" }).format(ms)} ${time}`;
}

/** "Thu 8 Oct" */
export function formatDate(ms: number): string {
  return dtf("date", { weekday: "short", day: "numeric", month: "short" }).format(ms);
}

/** "Thu 8 Oct · 10:30–11:00" (end optional) */
export function formatRange(startMs: number, endMs?: number | null): string {
  const base = `${formatDate(startMs)} · ${formatClock(startMs)}`;
  return endMs && endMs > startMs ? `${base}–${formatClock(endMs)}` : base;
}

/** Weekday + time without the "Today" substitution: "Mon 11:20" (matches the PRD wording for echoes). */
export function formatWeekdayTime(ms: number): string {
  return `${dtf("wd", { weekday: "short" }).format(ms)} ${formatClock(ms)}`;
}

/** "just now" | "4m ago" | "3h ago" | "yesterday" | "5d ago" */
export function formatAgo(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  const days = Math.round(d / 86_400_000);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Remaining retention: "3d 4h" | "71h 12m" | "42m 10s" | "58s" | "now". Negative/zero is "now". */
export function formatCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "now";
  const s = Math.floor(remainingMs / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d >= 3) return `${d}d ${h}h`;
  if (s >= 3600) return `${d * 24 + h}h ${String(m).padStart(2, "0")}m`;
  if (s >= 60) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Fraction of working-memory life that is left (1 → fresh, 0 → expired). null expiry = long-term = 1. */
export function lifeLeft(expiresAt: number | null | undefined, createdAt: number, now = Date.now()): number {
  if (expiresAt === null || expiresAt === undefined) return 1;
  const span = Math.max(1, expiresAt - createdAt);
  return Math.max(0, Math.min(1, (expiresAt - now) / span));
}

/** Pause gap between fragments: "1.4s" | "12s" | "2m 05s". */
export function formatGap(ms: number): string {
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** Latency: "820 ms" | "1.24 s". */
export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export type Tone = "good" | "ok" | "bad";
/** PRD targets: p50 under ~1 s is good, up to 1.6 s is acceptable. */
export function latencyTone(ms: number): Tone {
  return ms < 1000 ? "good" : ms < 1600 ? "ok" : "bad";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatPct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "on a walk" | "at your desk" | "on your phone" | "while travelling" */
export function placeLabel(activity?: Activity, deviceKind?: "desk" | "pocket"): string {
  if (activity === "walking") return "on a walk";
  if (activity === "vehicle") return "while travelling";
  if (activity === "still") return deviceKind === "pocket" ? "on your phone" : "sitting still";
  if (deviceKind === "pocket") return "on your phone";
  return "at your desk";
}

export function activityLabel(a: Activity | undefined): string {
  switch (a) {
    case "walking":
      return "Walking";
    case "vehicle":
      return "In a vehicle";
    case "still":
      return "Still";
    case "desk":
      return "At desk";
    default:
      return "No motion data";
  }
}

/** Strip the bracket syntax of citations so TTS reads naturally: "[T-12]" → "". */
export function stripCitations(text: string): string {
  return text.replace(/\s*\[T-\d+(?:\s*,\s*T-\d+)*\]/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * "by voice on this device" / "with a tap from Phone" / "from the Desk": who paused memory and how.
 * `by` is the device id the server reports; `via` is only known when this device paused.
 */
export function describePause(o: { by: string | null; via: string | null; selfId: string; devices: ReadonlyArray<{ deviceId: string; name: string }> }): string {
  const how = o.via === "voice" || o.via === "semantic" ? "by voice" : o.via === "tap" ? "with a tap" : o.via === "kws" ? "by keyword" : "";
  let where = "";
  if (o.by) {
    if (o.by === o.selfId) where = "on this device";
    else if (o.by === "api") where = "through the API";
    else {
      const d = o.devices.find((x) => x.deviceId === o.by);
      where = d ? `from ${d.name}` : o.by === "unknown" ? "" : "from another device";
    }
  }
  return [how, where].filter(Boolean).join(" ");
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
