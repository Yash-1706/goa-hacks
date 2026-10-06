import { z } from "zod";

/* ============================================================================
 * Domain model shared by server and web.
 *
 * Two layers:
 *  1. LLM / storage schemas (snake_case, zod): what Claude returns and what we persist.
 *     These double as the structured-output contract (see TRD §6.6), so they avoid
 *     recursion and numeric/string constraints (unsupported by structured outputs).
 *  2. View types (camelCase, plain TS): what the web client renders.
 * ========================================================================== */

// ---------------------------------------------------------------- taxonomy --

export const CATEGORIES = [
  "action",
  "bug",
  "communication",
  "scheduling",
  "code",
  "decision",
  "idea",
  "question",
  "journal",
  "aside",
  "recall_query",
  "privacy",
  "correction",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

/** Categories that never persist content (only a counter, or an immediate side effect). */
export const NON_PERSISTENT_CATEGORIES: readonly Category[] = ["aside", "privacy"];
/** Categories that describe something the user may want done. */
export const ACTIONABLE_CATEGORIES: readonly Category[] = [
  "action",
  "bug",
  "communication",
  "scheduling",
  "code",
  "decision",
];

export const ENTITY_TYPES = [
  "person",
  "project",
  "component",
  "technology",
  "bug",
  "event",
  "place",
  "topic",
  "org",
] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const ACTIVITIES = ["still", "walking", "vehicle", "desk", "unknown"] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const SALIENCE_CUES = ["explicit_remember", "emphasis", "deadline", "commitment"] as const;
export type SalienceCue = (typeof SALIENCE_CUES)[number];

// ---------------------------------------------------------------- artifacts --

export const ARTIFACT_KINDS = [
  "ticket",
  "github_issue",
  "email_draft",
  "message_draft",
  "calendar_event",
  "code_snippet",
  "code_comment",
  "decision",
  "note",
  "journal",
  "recall",
  "none",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    title: z.string(),
    description: z.string(),
    issue_type: z.enum(["task", "story", "bug", "spike"]),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    labels: z.array(z.string()),
    component: z.string().nullable(),
    acceptance_criteria: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("github_issue"),
    title: z.string(),
    body_markdown: z.string(),
    labels: z.array(z.string()),
    hypotheses: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("email_draft"),
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    tone: z.enum(["casual", "neutral", "formal"]),
  }),
  z.object({
    kind: z.literal("message_draft"),
    to: z.string(),
    channel: z.enum(["slack", "whatsapp", "sms", "other"]),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("calendar_event"),
    title: z.string(),
    start_iso: z.string().nullable(),
    end_iso: z.string().nullable(),
    time_expression: z.string().nullable(),
    attendees: z.array(z.string()),
    is_reschedule: z.boolean(),
  }),
  z.object({
    kind: z.literal("code_snippet"),
    language: z.string(),
    approach: z.string(),
    signature: z.string().nullable(),
    code: z.string(),
    explanation: z.string(),
    needs_enrichment: z.boolean(),
  }),
  z.object({
    kind: z.literal("code_comment"),
    target: z.string().nullable(),
    comment: z.string(),
  }),
  z.object({
    kind: z.literal("decision"),
    question: z.string(),
    chosen: z.string().nullable(),
    rejected: z.array(z.string()),
    rationale: z.string().nullable(),
    status: z.enum(["tentative", "decided"]),
  }),
  z.object({
    kind: z.literal("note"),
    body: z.string(),
    tags: z.array(z.string()),
  }),
  // No mood / emotion fields on purpose (PRD PRV-12).
  z.object({
    kind: z.literal("journal"),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("recall"),
    topic_query: z.string(),
    time_expression: z.string().nullable(),
    activity: z.string().nullable(),
    device: z.string().nullable(),
    types: z.array(z.string()),
    persons: z.array(z.string()),
  }),
  z.object({ kind: z.literal("none") }),
]);
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactOf<K extends ArtifactKind> = Extract<Artifact, { kind: K }>;

export const ARTIFACT_STATUSES = [
  "draft",
  "staged",
  "accepted",
  "executed",
  "dismissed",
  "undone",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

// -------------------------------------------------------- LLM output schema --

export const LlmEntitySchema = z.object({
  name: z.string(),
  type: EntityTypeSchema,
  candidate_id: z.string().nullable(),
});

export const LlmReferenceSchema = z.object({
  mention: z.string(),
  resolved_id: z.string().nullable(),
  label: z.string(),
  confidence: z.number(),
});

export const LlmRepairSchema = z.object({
  rejected: z.string(),
  chosen: z.string(),
});

/** What the cortex (Claude, or the mock) returns for one thought thread. */
export const CortexResultSchema = z.object({
  thread_relation: z.enum(["continue", "new_thought", "correction_of_previous"]),
  category: CategorySchema,
  confidence: z.number(),
  title: z.string(),
  intent: z.string(),
  why: z.string(),
  references: z.array(LlmReferenceSchema),
  repairs: z.array(LlmRepairSchema),
  open_questions: z.array(z.string()),
  entities: z.array(LlmEntitySchema),
  salience_cues: z.array(z.enum(SALIENCE_CUES)),
  concern_key: z.string().nullable(),
  artifact: ArtifactSchema,
});
export type CortexResult = z.infer<typeof CortexResultSchema>;

// ------------------------------------------------------------------- views --

export interface FragmentView {
  id: string;
  thoughtId: string;
  sessionId: string;
  deviceId: string;
  text: string;
  tStart: number;
  tEnd: number;
  pauseBeforeMs: number;
  durationMs: number;
  whisper: boolean;
  lang?: string;
  activity: Activity;
  transport: FragmentTransport;
}

export type FragmentTransport = "wispr_ws" | "wispr_rest" | "wispr_proxy" | "local_stt" | "mock" | "replay";

export interface ReferenceView {
  mention: string;
  resolvedId: string | null;
  resolvedCode: string | null;
  label: string;
  confidence: number;
  /** true when the top candidates were too close; UI shows "assuming you mean …" */
  assumed: boolean;
  alternativeLabel?: string;
}

export interface RepairView {
  rejected: string;
  chosen: string;
}

export interface EntityRefView {
  id: string;
  code: string;
  name: string;
  type: EntityType;
}

export interface ArtifactView {
  id: string;
  code: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  autonomyLevel: number;
  payload: Artifact;
  externalRef?: string;
  externalUrl?: string;
  /** true when the external action was simulated (no credentials) */
  simulated?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ThoughtSource = "llm" | "local" | "mock";

export interface ThoughtTiming {
  /** server epoch ms */
  serverRecv?: number;
  firstPaintEmit?: number;
  llmStart?: number;
  llmDone?: number;
  artifactEmit?: number;
  /** durations (ms) */
  wisprMs?: number;
  triageMs?: number;
  embedMs?: number;
  llmMs?: number;
  fragToFirstPaintMs?: number;
  fragToArtifactMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface ThoughtView {
  id: string;
  code: string;
  sessionId: string;
  deviceId: string;
  status: "open" | "final";
  /** true until the first real (LLM or mock) result arrived; card is drawn from local triage */
  provisional: boolean;
  /** low-confidence result: shown as a tentative card */
  tentative: boolean;
  source: ThoughtSource;
  category: Category;
  confidence: number;
  title: string;
  intent: string;
  why: string;
  fragments: FragmentView[];
  references: ReferenceView[];
  repairs: RepairView[];
  openQuestions: string[];
  entities: EntityRefView[];
  artifact: ArtifactView | null;
  salience: number;
  salienceReasons: string[];
  promoted: boolean;
  /** epoch ms; null when promoted to long-term memory */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
  timing: ThoughtTiming;
  /** thread this thought corrected/retracted, if any */
  correctsThoughtId?: string;
  retracted?: boolean;
  /**
   * true while the cortex is still working on this thread. While true, `title`/`intent`/`artifact`
   * may be partial (streamed token by token): renderers must tolerate missing fields.
   */
  analyzing?: boolean;
  /** how many values were masked before the cloud call that produced this card */
  redactions?: number;
  /** why the live model was bypassed ("timeout", "rate_limit", ...) when source is mock after a live attempt */
  degraded?: string;
}

export const SUGGESTION_KINDS = [
  "reschedule",
  "make_task",
  "draft_ready",
  "snippet",
  "open_answer",
  "echo",
  "contradiction",
  "calendar_hold",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export type SuggestionStatus = "queued" | "delivered" | "accepted" | "dismissed" | "later" | "expired";

export interface SourceRef {
  thoughtId: string;
  code: string;
  title: string;
  when: number;
  activity?: Activity;
  deviceKind?: "desk" | "pocket";
}

export interface SuggestionView {
  id: string;
  kind: SuggestionKind;
  title: string;
  body: string;
  /** Always shown: "You've mentioned the Thursday conflict 3 times in 8 minutes." */
  why: string;
  value: number;
  status: SuggestionStatus;
  createdAt: number;
  deliveredAt?: number;
  sources: SourceRef[];
  /** kind-specific data: slots for reschedule, draft for draft_ready, code for snippet, ... */
  payload?: Record<string, unknown>;
  acceptLabel: string;
}

export interface RecallConstraints {
  topic: string;
  timeRange?: { from: number; to: number; label: string };
  activity?: Activity;
  device?: "desk" | "pocket";
  types: Category[];
  persons: string[];
}

export interface RecallSource {
  thoughtId: string;
  code: string;
  title: string;
  snippet: string;
  when: number;
  activity?: Activity;
  deviceKind?: "desk" | "pocket";
  category: Category;
  score: number;
  viaGraph?: boolean;
}

export interface EchoView {
  id: string;
  thoughtId: string;
  because: string;
  source: SourceRef;
  similarity: number;
  createdAt: number;
}

export interface BriefView {
  id: string;
  sessionId: string;
  headline: string;
  tasks: Array<{ title: string; thoughtCode: string }>;
  decisions: Array<{ title: string; chosen: string | null; rejected: string[]; thoughtCode: string }>;
  snippets: Array<{ title: string; language: string; thoughtCode: string }>;
  openLoops: string[];
  filteredCount: number;
  notableQuotes: string[];
  createdAt: number;
}

// ------------------------------------------------------------- graph model --

export type GraphNodeKind = "session" | "thought" | "entity" | "decision" | "artifact" | "open_loop";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  category?: Category;
  entityType?: EntityType;
  sessionId?: string;
  createdAt: number;
  /** epoch ms; null/undefined = long-term (does not fade) */
  expiresAt?: number | null;
  promoted?: boolean;
  salience?: number;
  deviceKind?: "desk" | "pocket";
  activity?: Activity;
}

export const EDGE_TYPES = [
  "in_session",
  "mentions",
  "produced",
  "refines",
  "contradicts",
  "answers",
  "follows_up",
  "same_topic",
  "related",
  "supersedes",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  type: EdgeType;
  weight: number;
  label?: string;
}

// --------------------------------------------------------------- misc views --

export interface DeviceInfo {
  deviceId: string;
  kind: "desk" | "pocket";
  name: string;
  connected: boolean;
  listening: boolean;
  speaking: boolean;
  activity?: Activity;
  battery?: { level: number; charging: boolean };
  mode?: "normal" | "eco";
  sessionId?: string;
}

export interface StageStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LatencySummary {
  n: number;
  /** stage name → stats (ms). Stages: wispr, firstPaint, artifact, speechToArtifact, cortex, pause */
  stages: Record<string, StageStats>;
  updatedAt: number;
}

export interface LedgerItem {
  id: string;
  code: string;
  kind: "thought" | "entity" | "artifact" | "open_loop";
  title: string;
  category?: Category;
  createdAt: number;
  expiresAt: number | null;
  promoted: boolean;
  whyKept: string[];
  sessionId?: string;
}

export interface DictionaryTerm {
  term: string;
  kind: "person" | "component" | "technology" | "project" | "jargon";
  source: string;
  salience: number;
  lastSeen: number;
}

export interface CalendarEventView {
  id: string;
  title: string;
  start: number;
  end: number;
  source: "seed" | "voice" | "manual";
}
