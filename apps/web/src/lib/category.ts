import {
  Bug,
  CalendarClock,
  CircleHelp,
  Code2,
  Ghost,
  GitBranch,
  Lightbulb,
  BookOpen,
  Mail,
  PenLine,
  Search,
  Shield,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ArtifactKind, Category } from "@synapse/shared";

export interface CategoryMeta {
  label: string;
  /** hex, for canvas drawing (graph) and inline styles */
  color: string;
  icon: LucideIcon;
  /** one-line gloss shown in legends */
  gloss: string;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  bug: { label: "Bug", color: "#fb7185", icon: Bug, gloss: "Something is broken" },
  action: { label: "Action", color: "#a78bfa", icon: Zap, gloss: "Something to do" },
  communication: { label: "Message", color: "#38bdf8", icon: Mail, gloss: "Someone to tell" },
  scheduling: { label: "Schedule", color: "#fbbf24", icon: CalendarClock, gloss: "Time and calendar" },
  code: { label: "Code", color: "#34d399", icon: Code2, gloss: "An implementation idea" },
  decision: { label: "Decision", color: "#e879f9", icon: GitBranch, gloss: "A choice, with what was rejected" },
  idea: { label: "Idea", color: "#facc15", icon: Lightbulb, gloss: "A thought worth keeping" },
  question: { label: "Question", color: "#f4b393", icon: CircleHelp, gloss: "An open loop" },
  journal: { label: "Journal", color: "#94a3b8", icon: BookOpen, gloss: "Ephemeral remark (72 h)" },
  recall_query: { label: "Recall", color: "#818cf8", icon: Search, gloss: "A question for memory" },
  aside: { label: "Aside", color: "#6b7280", icon: Ghost, gloss: "Filtered, never stored" },
  privacy: { label: "Privacy", color: "#f4b393", icon: Shield, gloss: "Pause or forget" },
  correction: { label: "Correction", color: "#fb923c", icon: PenLine, gloss: "Revises or retracts a card" },
};

export const categoryMeta = (c: Category | undefined): CategoryMeta => CATEGORY_META[c ?? "idea"] ?? CATEGORY_META.idea;
export const categoryColor = (c: Category | undefined): string => categoryMeta(c).color;

export const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  ticket: "Ticket",
  github_issue: "GitHub issue",
  email_draft: "Email draft",
  message_draft: "Message draft",
  calendar_event: "Calendar event",
  reminder: "Reminder",
  code_snippet: "Code snippet",
  code_comment: "Code comment",
  decision: "Decision",
  note: "Note",
  journal: "Journal",
  recall: "Recall",
  none: "",
};

/** Edge styling for the knowledge graph (semantic edges are dashed + coloured). */
export const EDGE_STYLE: Record<string, { color: string; dash: number[]; label: string; semantic: boolean }> = {
  in_session: { color: "rgba(148,163,184,0.16)", dash: [], label: "in session", semantic: false },
  mentions: { color: "rgba(148,163,184,0.34)", dash: [], label: "mentions", semantic: false },
  produced: { color: "rgba(52,211,153,0.45)", dash: [], label: "produced", semantic: false },
  related: { color: "rgba(148,163,184,0.28)", dash: [1, 3], label: "co-occurs", semantic: false },
  refines: { color: "#38bdf8", dash: [5, 3], label: "refines", semantic: true },
  same_topic: { color: "#a78bfa", dash: [5, 3], label: "same topic", semantic: true },
  answers: { color: "#34d399", dash: [5, 3], label: "answers", semantic: true },
  follows_up: { color: "#fbbf24", dash: [5, 3], label: "follows up", semantic: true },
  contradicts: { color: "#fb7185", dash: [3, 3], label: "contradicts", semantic: true },
  supersedes: { color: "#e879f9", dash: [8, 3], label: "supersedes", semantic: true },
};
