import { createHash } from "node:crypto";

/**
 * Logging policy (PRD PRV-12 / CLAUDE.md rule 6): never log user content.
 * Log ids, lengths and short hashes only. `safe()` turns text into a loggable stand-in.
 */
export function safe(text: string | undefined | null): string {
  if (!text) return "<empty>";
  const h = createHash("sha1").update(text).digest("hex").slice(0, 6);
  return `<len:${text.length} h:${h}>`;
}

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = process.env.LOG_LEVEL === "debug" ? "debug" : "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, tag: string, msg: string, meta?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const m = meta
    ? " " +
      Object.entries(meta)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}${m}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (tag: string, msg: string, meta?: Record<string, unknown>) => emit("debug", tag, msg, meta),
  info: (tag: string, msg: string, meta?: Record<string, unknown>) => emit("info", tag, msg, meta),
  warn: (tag: string, msg: string, meta?: Record<string, unknown>) => emit("warn", tag, msg, meta),
  error: (tag: string, msg: string, meta?: Record<string, unknown>) => emit("error", tag, msg, meta),
};
