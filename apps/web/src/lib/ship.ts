import type { ArtifactView } from "@synapse/shared";

/* ============================================================================
 * The V1 card face (pure helpers, tested): a plain label, where the card goes, a short preview, and ONE primary action.
 * Hand off, don't hold: the action opens the app people already use, or files the GitHub issue when an account is connected.
 * ========================================================================== */

export type PrimaryAction =
  | { label: string; kind: "push"; disabled?: boolean; reason?: string }
  | { label: string; kind: "link"; url: string; via: string; disabled?: boolean; reason?: string };

const LABEL: Record<string, string> = {
  github_issue: "GitHub issue",
  email_draft: "Email draft",
  reminder: "Reminder",
  calendar_event: "Calendar event",
  message_draft: "Message",
  ticket: "Ticket",
  code_snippet: "Code snippet",
  code_comment: "Code note",
  decision: "Decision",
  journal: "Journal",
  note: "Note",
};

export function cardLabel(a: Pick<ArtifactView, "kind">): string {
  return LABEL[a.kind] ?? "Note";
}

export function formatWhen(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d).toLowerCase();
  return `${day}, ${time}`;
}

export function destination(a: ArtifactView, tz: string): string | null {
  const p = a.payload;
  if (p.kind === "github_issue") return a.route?.repo ?? null;
  if (p.kind === "email_draft") return `To ${(a.route?.to ?? p.to).join(", ")}`;
  if (p.kind === "message_draft") return `To ${p.to}`;
  if (p.kind === "reminder" || p.kind === "calendar_event") {
    const due = a.route?.dueAt ?? (p.kind === "reminder" ? p.due_iso : p.start_iso);
    const when = due ? formatWhen(due, tz) : null;
    const rec = p.kind === "reminder" && p.recurrence ? ` · ${p.recurrence}` : "";
    return when ? `${when}${rec}` : null;
  }
  return null;
}

const firstLines = (s: string, max = 160): string => {
  const text = s
    .replace(/\*\*[^*]+\*\*\n?/g, "")
    .replace(/^(hi|hello|hey)\b[^\n]*\n+/i, "")
    .replace(/\n+(thanks|cheers|best)[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function preview(a: ArtifactView): string {
  const p = a.payload;
  switch (p.kind) {
    case "github_issue":
      return firstLines(p.body_markdown.split(/\n\*\*Observed\*\*/)[0] ?? p.body_markdown);
    case "email_draft":
      return firstLines(p.body);
    case "message_draft":
      return firstLines(p.body);
    case "note":
    case "journal":
      return firstLines(p.body);
    case "decision":
      return p.chosen ? `${p.status === "decided" ? "Chose" : "Leaning to"} ${p.chosen}${p.rejected.length ? ` over ${p.rejected.join(", ")}` : ""}` : p.question;
    case "ticket":
      return firstLines(p.description);
    case "code_snippet":
      return firstLines(p.approach);
    default:
      return "";
  }
}

export function primaryAction(a: ArtifactView, o: { mobile: boolean; emailApp: "gmail" | "mailto" }): PrimaryAction | null {
  const blocked = (a.needs?.length ?? 0) > 0 ? { disabled: true, reason: "Needs one answer" } : {};
  const links = a.links ?? {};
  switch (a.kind) {
    case "github_issue":
      if (a.canCreate) return { label: "Create issue", kind: "push", ...blocked };
      return links.newIssue ? { label: "Create issue", kind: "link", url: links.newIssue, via: "github", ...blocked } : { label: "Create issue", kind: "push", disabled: true, reason: "Needs one answer" };
    case "email_draft": {
      const gmail = !o.mobile && o.emailApp === "gmail";
      const url = gmail ? links.gmail : links.mailto;
      return url ? { label: "Open draft", kind: "link", url, via: gmail ? "gmail" : "mail", ...blocked } : { label: "Open draft", kind: "push", disabled: true, reason: "Needs one answer" };
    }
    case "reminder":
    case "calendar_event":
      return links.calendar ? { label: "Add to calendar", kind: "link", url: links.calendar, via: "calendar", ...blocked } : { label: "Add to calendar", kind: "push", disabled: true, reason: "Needs one answer" };
    case "message_draft":
      return links.whatsapp ? { label: "Send on WhatsApp", kind: "link", url: links.whatsapp, via: "whatsapp" } : null;
    default:
      return null;
  }
}

const VIA: Record<string, string> = { gmail: "Opened in Gmail", mail: "Opened in your mail app", calendar: "Added to calendar", github: "Opened on GitHub", whatsapp: "Opened in WhatsApp" };

/** "Created #123 ↗" / "Opened in Gmail": what happened to a shipped card. */
export function shippedText(a: ArtifactView): { text: string; url?: string } | null {
  if (a.status !== "executed") return null;
  const ref = a.externalRef ?? "";
  if (ref.startsWith("opened:")) return { text: VIA[ref.slice(7)] ?? "Shipped" };
  const n = ref.match(/#(\d+)$/)?.[1];
  if (n) return { text: `${a.simulated ? "Simulated" : "Created"} #${n}`, ...(a.externalUrl ? { url: a.externalUrl } : {}) };
  return { text: a.simulated ? "Simulated" : "Done", ...(a.externalUrl ? { url: a.externalUrl } : {}) };
}

export function isMobile(ua: string): boolean {
  return /Android|iPhone|iPad|iPod/i.test(ua);
}
