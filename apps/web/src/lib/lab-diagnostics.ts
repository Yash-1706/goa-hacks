import type { CalendarEventView } from "@synapse/shared";
import type { StampedDiagnostic } from "@/state/audio";

/* ============================================================================
 * Lab diagnostics: turn the audio pipeline's `onDiagnostic` events into short readable lines, and the local calendar into
 * "what is next / what clashes". The diagnostics contract (audio/types.ts) guarantees no transcript text, audio or URLs;
 * free-text details are still length-capped here.
 * ========================================================================== */

export type DiagTone = "ok" | "warn" | "bad" | "info";

export interface DiagLine {
  at: number;
  kind: StampedDiagnostic["kind"];
  label: string;
  text: string;
  tone: DiagTone;
}

const cap = (s: string, n = 140): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** dB relative to full scale for a linear RMS (floor at -100 dB) */
export function dbfs(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-5));
}

/** "0.0042 RMS · −47.5 dBFS" */
export function noiseFloorText(rms: number | null | undefined): string {
  if (rms === null || rms === undefined || !Number.isFinite(rms)) return "–";
  const db = dbfs(rms).toFixed(1).replace("-", "−");
  return `${rms >= 0.1 ? rms.toFixed(2) : rms.toFixed(4)} RMS · ${db} dBFS`;
}

export function describeDiagnostic(d: StampedDiagnostic): DiagLine {
  switch (d.kind) {
    case "standby": {
      const tone: DiagTone = d.state === "ready" ? "ok" : d.state === "down" ? "warn" : "info";
      const base = d.state === "ready" ? "Standby socket ready" : d.state === "down" ? "Standby socket down" : "Standby socket connecting";
      const extra = [d.assumed ? "assumed ready (no auth ack)" : "", d.detail ? cap(d.detail, 90) : ""].filter(Boolean).join(" · ");
      return { at: d.at, kind: d.kind, label: "Standby", text: extra ? `${base} · ${extra}` : base, tone };
    }
    case "fallback":
      return { at: d.at, kind: d.kind, label: "Fallback", text: `Used the REST fallback · ${cap(d.reason, 100)}`, tone: "warn" };
    case "latency": {
      const ms = Math.round(d.commitToFinalMs);
      const tone: DiagTone = ms <= 600 ? "ok" : ms <= 1500 ? "info" : "warn";
      const local = d.transport === "local_stt";
      return { at: d.at, kind: d.kind, label: local ? "On-device" : "Wispr", text: `Commit → final text ${ms} ms (${local ? "on-device Whisper" : d.transport === "wispr_ws" ? "websocket" : "REST"})`, tone };
    }
    case "calibrated":
      return { at: d.at, kind: d.kind, label: "Calibrated", text: `Noise floor measured: ${noiseFloorText(d.noiseFloor)}`, tone: "ok" };
    case "mode":
      return { at: d.at, kind: d.kind, label: "Mode", text: d.mode === "eco" ? "Switched to Eco: stricter VAD, bigger packet batches, energy pre-gate on" : "Switched to Normal mode", tone: "info" };
    case "anomaly":
      return { at: d.at, kind: d.kind, label: "Anomaly", text: cap(d.detail), tone: "bad" };
  }
}

/** newest first */
export function describeDiagnostics(list: readonly StampedDiagnostic[], limit = 12): DiagLine[] {
  return list
    .slice(-limit)
    .map(describeDiagnostic)
    .reverse();
}

// ----------------------------------------------------------------- calendar --

/** event id → titles of the events it overlaps (start < other.end && other.start < end). Back-to-back is not a clash. */
export function findOverlaps(events: readonly CalendarEventView[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sorted = [...events].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i] as CalendarEventView;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j] as CalendarEventView;
      if (b.start >= a.end) break;
      (out.get(a.id) ?? out.set(a.id, []).get(a.id)!).push(b.title);
      (out.get(b.id) ?? out.set(b.id, []).get(b.id)!).push(a.title);
    }
  }
  return out;
}

export interface CalendarView {
  events: CalendarEventView[];
  /** false when everything is in the past (the list then shows the most recent ones) */
  upcoming: boolean;
  clashes: Map<string, string[]>;
  total: number;
}

/** the next `limit` events from `now`; falls back to the latest past ones when nothing is ahead */
export function calendarWindow(events: readonly CalendarEventView[], now: number, limit = 6): CalendarView {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const ahead = sorted.filter((e) => e.end >= now);
  const clashes = findOverlaps(events);
  if (ahead.length > 0) return { events: ahead.slice(0, limit), upcoming: true, clashes, total: sorted.length };
  return { events: sorted.slice(-Math.min(limit, 4)), upcoming: false, clashes, total: sorted.length };
}
