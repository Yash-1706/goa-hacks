import type { ArtifactKind, ArtifactOf, ArtifactStatus, ArtifactView } from "@synapse/shared";

/* ============================================================================
 * Artifact helpers. Payloads can be PARTIAL while the cortex streams them (every field optional),
 * so every accessor here is defensive.
 * ========================================================================== */

export type PartialArtifact<K extends ArtifactKind> = Partial<ArtifactOf<K>>;

/** The payload as a partial of kind K, or null when the artifact is of another kind. */
export function partialOf<K extends ArtifactKind>(a: ArtifactView | null | undefined, kind: K): PartialArtifact<K> | null {
  if (!a) return null;
  const k = (a.payload as { kind?: string } | undefined)?.kind ?? a.kind;
  if (k !== kind) return null;
  return (a.payload ?? { kind }) as PartialArtifact<K>;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

const EXTERNAL: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["ticket", "github_issue", "calendar_event"]);

export interface Pushability {
  ok: boolean;
  reason?: string;
}

/** Mirrors the server's Outbox.pushability so the button state is right before any round trip. */
export function pushability(a: ArtifactView | null | undefined): Pushability {
  if (!a) return { ok: false, reason: "no artifact yet" };
  if (!EXTERNAL.has(a.kind)) return { ok: false, reason: "nothing to push: copy or open the draft" };
  if (a.status === "executed") return { ok: false, reason: "already pushed" };
  if (a.status === "dismissed") return { ok: false, reason: "dismissed" };
  if (a.kind === "calendar_event" && !str((a.payload as { start_iso?: unknown }).start_iso)) return { ok: false, reason: "needs a time: say when" };
  return { ok: true };
}

export function pushLabel(kind: ArtifactKind): string {
  switch (kind) {
    case "github_issue":
      return "Create issue";
    case "ticket":
      return "Create ticket";
    case "calendar_event":
      return "Add to calendar";
    default:
      return "Push";
  }
}

export const STATUS_LABEL: Record<ArtifactStatus, string> = {
  draft: "Draft",
  staged: "Staged",
  accepted: "Kept",
  opened: "Opened",
  executed: "Done",
  dismissed: "Dismissed",
  undone: "Undone",
};

export const STATUS_HINT: Record<ArtifactStatus, string> = {
  draft: "Drafted by Synapse. Nothing has left this device.",
  staged: "Ready to go: one tap commits it.",
  accepted: "You kept it. It stays in memory.",
  opened: "Handed to another app. Tap Done once it's sent.",
  executed: "Created in the target system.",
  dismissed: "You dismissed it.",
  undone: "It was created and then undone.",
};

export const AUTONOMY_NAME = ["Observe", "Draft", "Stage", "Execute"] as const;

/** Plain-text rendering used by the "Copy" buttons. */
export function artifactText(a: ArtifactView | null | undefined): string {
  if (!a) return "";
  const p = a.payload as Record<string, unknown>;
  switch (a.kind) {
    case "email_draft":
      return [`To: ${strArr(p.to).join(", ")}`, `Subject: ${str(p.subject)}`, "", str(p.body)].join("\n");
    case "message_draft":
      return [`To: ${str(p.to)}${p.channel ? ` (${str(p.channel)})` : ""}`, "", str(p.body)].join("\n");
    case "github_issue":
      return `# ${str(p.title)}\n\n${str(p.body_markdown)}`;
    case "ticket":
      return [str(p.title), "", str(p.description), "", ...strArr(p.acceptance_criteria).map((c) => `- [ ] ${c}`)].join("\n").trim();
    case "code_snippet":
      return str(p.code);
    case "code_comment":
      return str(p.comment);
    case "decision":
      return [str(p.question), str(p.chosen) ? `Chosen: ${str(p.chosen)}` : "", strArr(p.rejected).length ? `Rejected: ${strArr(p.rejected).join("; ")}` : "", str(p.rationale)].filter(Boolean).join("\n");
    case "note":
    case "journal":
      return str(p.body);
    case "calendar_event":
      return [str(p.title), str(p.start_iso) || str(p.time_expression)].filter(Boolean).join("\n");
    default:
      return "";
  }
}

/** A short human title for lists (Outbox, ledger). */
export function artifactHeadline(a: ArtifactView): string {
  const p = a.payload as Record<string, unknown>;
  return str(p.title) || str(p.subject) || str(p.question) || str(p.comment) || str(p.body).slice(0, 80) || str(p.approach) || a.kind.replace("_", " ");
}

// ------------------------------------------------------------------ editing --

export type EditKind = "text" | "textarea" | "code" | "list" | "select" | "datetime";
export interface EditField {
  key: string;
  label: string;
  kind: EditKind;
  options?: string[];
  placeholder?: string;
}

export const EDIT_FIELDS: Partial<Record<ArtifactKind, EditField[]>> = {
  ticket: [
    { key: "title", label: "Title", kind: "text" },
    { key: "description", label: "Description", kind: "textarea" },
    { key: "issue_type", label: "Type", kind: "select", options: ["task", "story", "bug", "spike"] },
    { key: "priority", label: "Priority", kind: "select", options: ["low", "medium", "high", "urgent"] },
    { key: "labels", label: "Labels (one per line)", kind: "list" },
    { key: "acceptance_criteria", label: "Acceptance criteria (one per line)", kind: "list" },
  ],
  github_issue: [
    { key: "title", label: "Title", kind: "text" },
    { key: "body_markdown", label: "Body (markdown)", kind: "textarea" },
    { key: "labels", label: "Labels (one per line)", kind: "list" },
  ],
  email_draft: [
    { key: "to", label: "To (one per line)", kind: "list" },
    { key: "subject", label: "Subject", kind: "text" },
    { key: "body", label: "Body", kind: "textarea" },
  ],
  message_draft: [
    { key: "to", label: "To", kind: "text" },
    { key: "body", label: "Message", kind: "textarea" },
  ],
  calendar_event: [
    { key: "title", label: "Title", kind: "text" },
    { key: "start_iso", label: "Starts", kind: "datetime" },
    { key: "end_iso", label: "Ends", kind: "datetime" },
    { key: "attendees", label: "Attendees (one per line)", kind: "list" },
  ],
  code_snippet: [
    { key: "language", label: "Language", kind: "text" },
    { key: "code", label: "Code", kind: "code" },
    { key: "explanation", label: "Explanation", kind: "textarea" },
  ],
  code_comment: [
    { key: "target", label: "Target", kind: "text" },
    { key: "comment", label: "Comment", kind: "textarea" },
  ],
  decision: [
    { key: "question", label: "Question", kind: "text" },
    { key: "chosen", label: "Chosen", kind: "text" },
    { key: "rejected", label: "Rejected (one per line)", kind: "list" },
    { key: "rationale", label: "Rationale", kind: "textarea" },
    { key: "status", label: "Status", kind: "select", options: ["tentative", "decided"] },
  ],
  note: [
    { key: "body", label: "Note", kind: "textarea" },
    { key: "tags", label: "Tags (one per line)", kind: "list" },
  ],
  journal: [{ key: "body", label: "Entry", kind: "textarea" }],
};

export const isEditable = (kind: ArtifactKind): boolean => Boolean(EDIT_FIELDS[kind]);

/** "2026-10-08T10:30" (local) from an ISO string; "" when absent or invalid. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function localInputToIso(local: string): string | null {
  if (!local) return null;
  const t = Date.parse(local);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Form value (always a string) for a field of the current payload. */
export function fieldToText(field: EditField, payload: Record<string, unknown>): string {
  const v = payload[field.key];
  if (field.kind === "list") return strArr(v).join("\n");
  if (field.kind === "datetime") return isoToLocalInput(typeof v === "string" ? v : null);
  return typeof v === "string" ? v : "";
}

/** Convert edited form text back to payload values and keep ONLY what changed (server merges the patch). */
export function buildPatch(kind: ArtifactKind, form: Record<string, string>, payload: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of EDIT_FIELDS[kind] ?? []) {
    const raw = form[f.key];
    if (raw === undefined) continue;
    if (raw === fieldToText(f, payload)) continue;
    if (f.kind === "list") patch[f.key] = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    else if (f.kind === "datetime") patch[f.key] = localInputToIso(raw);
    else patch[f.key] = raw;
  }
  return patch;
}
