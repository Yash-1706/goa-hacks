import type { ThoughtView } from "@synapse/shared";

/* ============================================================================
 * The Inbox (V1): what needs you (drafts that can ship, questions), what is done (shipped), what is saved (notes, ideas,
 * decisions and everything else worth keeping). Asides, privacy commands and recall questions never show here.
 * ========================================================================== */

const SHIPPABLE = new Set(["github_issue", "email_draft", "reminder", "calendar_event", "message_draft"]);
const HIDDEN = new Set(["aside", "privacy", "recall_query", "correction"]);

export interface Buckets {
  needsYou: ThoughtView[];
  done: ThoughtView[];
  saved: ThoughtView[];
}

export function buckets(thoughts: ThoughtView[]): Buckets {
  const out: Buckets = { needsYou: [], done: [], saved: [] };
  for (const t of thoughts) {
    if (HIDDEN.has(t.category) || t.retracted) continue;
    const a = t.artifact;
    const status = a?.status;
    if (status === "dismissed" || status === "undone") continue;
    if (status === "executed") out.done.push(t);
    else if (a && (SHIPPABLE.has(a.kind) || (a.needs?.length ?? 0) > 0)) out.needsYou.push(t);
    else out.saved.push(t);
  }
  // newest capture (session) first; inside one capture, the order things were said in (time, then T-n for a tie)
  const latest = new Map<string, number>();
  for (const t of thoughts) latest.set(t.sessionId, Math.max(latest.get(t.sessionId) ?? 0, t.createdAt));
  const seq = (t: ThoughtView) => Number(t.code.replace(/^\D+/, "")) || 0;
  const newest = (x: ThoughtView, y: ThoughtView) =>
    (latest.get(y.sessionId) ?? 0) - (latest.get(x.sessionId) ?? 0) || (x.sessionId === y.sessionId ? x.createdAt - y.createdAt || seq(x) - seq(y) : y.createdAt - x.createdAt);
  out.needsYou.sort(newest);
  out.done.sort((x, y) => (y.artifact?.updatedAt ?? y.createdAt) - (x.artifact?.updatedAt ?? x.createdAt));
  out.saved.sort(newest);
  return out;
}

/** "Captured 4 things · 2 need you" for the thoughts of the last capture session. */
export function sessionSummary(thoughts: ThoughtView[]): string | null {
  if (!thoughts.length) return null;
  const need = buckets(thoughts).needsYou.length;
  return `Captured ${thoughts.length} ${thoughts.length === 1 ? "thing" : "things"} · ${need ? `${need} need${need === 1 ? "s" : ""} you` : "saved"}`;
}

export type Pill = "Listening" | "Paused" | "Offline" | "Not connected" | "Ready";

export function statusPill(s: { paused: boolean; conn: string; listening: boolean; online: boolean }): Pill {
  if (s.paused) return "Paused";
  if (s.conn !== "open") return s.online ? "Not connected" : "Offline";
  return s.listening ? "Listening" : "Ready";
}
