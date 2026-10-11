import type { Category, ThoughtView } from "@synapse/shared";

/* What a capture made, in the words a person would use ("GitHub issue", "Email", "Reminder"). */

const BY_KIND: Record<string, string> = {
  ticket: "Ticket",
  github_issue: "GitHub issue",
  email_draft: "Email",
  message_draft: "Message",
  calendar_event: "Event",
  reminder: "Reminder",
  code_snippet: "Code",
  code_comment: "Code note",
  decision: "Decision",
  journal: "Journal",
};

const BY_CATEGORY: Partial<Record<Category, string>> = {
  idea: "Idea",
  question: "Question",
  decision: "Decision",
  action: "Task",
  recall_query: "Question",
};

export function thingLabel(t: Pick<ThoughtView, "category" | "artifact">): string {
  const kind = t.artifact?.kind;
  if (kind && BY_KIND[kind]) return BY_KIND[kind] as string;
  return BY_CATEGORY[t.category] ?? "Note";
}

export function madeLine(thoughts: Array<Pick<ThoughtView, "category" | "artifact">>): string {
  if (!thoughts.length) return "Nothing to keep (asides are skipped)";
  return `Made ${thoughts.length} ${thoughts.length === 1 ? "thing" : "things"}: ${thoughts.map(thingLabel).join(" · ")}`;
}
