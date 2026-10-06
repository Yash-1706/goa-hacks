export const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** Nearest-rank percentile on an unsorted list. p in [0,100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[clamp(rank - 1, 0, sorted.length - 1)] as number;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Compact relative time, e.g. "2m ago", "yesterday". */
export function relativeTime(then: number, now = Date.now()): string {
  const d = now - then;
  if (d < 45_000) return "just now";
  if (d < HOUR) return `${Math.round(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  const days = Math.round(d / DAY);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}
