import { truncate, type ArtifactKind, type ArtifactView } from "@synapse/shared";
import { str, strArr } from "@/lib/artifacts";
import { formatRange } from "@/lib/format";

/* ============================================================================
 * One or two plain lines of what an Outbox item says, so a collapsed card still carries substance. Pure (unit-tested).
 * ========================================================================== */

/**
 * markdown to a single readable line: no code fences, link targets or emphasis stars; a heading becomes "Heading:" and a
 * list item gets a bullet, so "## Summary / text / - a / - b" reads "Summary: text • a • b".
 */
export function plainLine(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+(.+?)[\s:.]*$/gm, "$1: ")
    .replace(/^\s{0,3}(?:\*\*|__)([^*_\n]+?)[\s:.]*(?:\*\*|__)[\s:.]*$/gm, "$1: ") // a line that is only bold is a heading too
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "• ")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)\*(\S[^*]*)\*(?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The excerpt without what the title already says. A note's title is the start of its own body, so the excerpt would
 * repeat it: keep only the continuation (and drop a word the title cut in half), or nothing when there is none.
 */
export function distinctExcerpt(headline: string, excerpt: string): string {
  const h = norm(headline);
  const e = norm(excerpt);
  if (!e || e === h || (h !== "" && h.startsWith(e))) return "";
  const head = headline.trim();
  if (head && excerpt.toLowerCase().startsWith(head.toLowerCase())) {
    let rest = excerpt.slice(head.length);
    if (/[\p{L}\p{N}]/u.test(rest.charAt(0))) rest = rest.replace(/^\S+\s*/, ""); // the title ended mid-word
    rest = rest.replace(/^[\s,;:.\-–—]+/, "");
    return rest.length >= 24 ? `…${rest}` : "";
  }
  return excerpt;
}

function when(p: Record<string, unknown>): string {
  const start = typeof p.start_iso === "string" ? Date.parse(p.start_iso) : NaN;
  if (Number.isFinite(start)) {
    const end = typeof p.end_iso === "string" ? Date.parse(p.end_iso) : NaN;
    return formatRange(start, Number.isFinite(end) ? end : undefined);
  }
  const expr = str(p.time_expression);
  return expr ? `You said “${expr}”: it needs a concrete time` : "Needs a time";
}

/** what the artifact says in a nutshell ("" when there is nothing beyond its title) */
export function excerptOf(a: Pick<ArtifactView, "kind" | "payload">, max = 170): string {
  const p = ((a.payload as unknown) ?? {}) as Record<string, unknown>;
  const kind: ArtifactKind = a.kind;
  let s = "";
  switch (kind) {
    case "email_draft": {
      const to = strArr(p.to);
      s = `${to.length ? `To ${to.join(", ")}. ` : ""}${plainLine(str(p.body))}`;
      break;
    }
    case "message_draft":
      s = `${str(p.to) ? `To ${str(p.to)}. ` : ""}${plainLine(str(p.body))}`;
      break;
    case "github_issue":
      s = plainLine(str(p.body_markdown));
      break;
    case "ticket":
      s = plainLine(str(p.description));
      break;
    case "calendar_event": {
      const people = strArr(p.attendees);
      s = `${when(p)}${people.length ? ` · with ${people.join(", ")}` : ""}`;
      break;
    }
    case "code_snippet":
      s = plainLine(str(p.approach) || str(p.explanation));
      break;
    case "code_comment":
      s = str(p.target) ? `On ${str(p.target)}` : "";
      break;
    case "decision": {
      const chosen = str(p.chosen);
      const rejected = strArr(p.rejected);
      s = chosen ? `${p.status === "decided" ? "Chose" : "Leaning towards"} ${chosen}${rejected.length ? ` over ${rejected.join(", ")}` : ""}` : "Not decided yet";
      break;
    }
    case "note":
    case "journal":
      s = plainLine(str(p.body));
      break;
    default:
      s = "";
  }
  return truncate(s.trim(), max);
}

/** the colour a kind wears on its icon badge (the category palette, never the status colours) */
export const KIND_TINT: Record<ArtifactKind, string> = {
  ticket: "#a78bfa",
  github_issue: "#fb7185",
  email_draft: "#38bdf8",
  message_draft: "#38bdf8",
  calendar_event: "#fbbf24",
  reminder: "#fbbf24",
  code_snippet: "#34d399",
  code_comment: "#34d399",
  decision: "#e879f9",
  note: "#facc15",
  journal: "#94a3b8",
  recall: "#818cf8",
  none: "#94a3b8",
};

/** "cal:01M4…" is an internal calendar id: show it as words; anything else (GH-101, owner/repo#12, SYN-7) as is */
export function refLabel(ref: string): string {
  return ref.startsWith("cal:") ? "On your calendar" : ref;
}
