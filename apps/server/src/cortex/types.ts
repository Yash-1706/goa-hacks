import type { Activity, Category, CortexResult, EntityType } from "@synapse/shared";
import type { Triage } from "../gate/triage";
import type { TeamMember } from "../config";

/** A thing the model may point at when resolving "that bug", "what Sarah said", ... */
export interface Candidate {
  /** internal id of the thought or entity this candidate points at (never sent to the model) */
  id: string;
  /** short code the model must echo back, e.g. T-181, E-12 */
  ref: string;
  kind: "thought" | "entity" | "open_loop";
  label: string;
  snippet: string;
  when?: number;
  deviceKind?: "desk" | "pocket";
  activity?: Activity;
  category?: Category;
  entityType?: EntityType;
  score: number;
}

export interface RecentThought {
  ref: string;
  title: string;
  category: Category;
  when: number;
}

export interface CortexFragment {
  id: string;
  dtMs: number;
  text: string;
  whisper: boolean;
  pauseBeforeMs: number;
}

export interface CortexInput {
  now: number;
  timezone: string;
  user: { name: string; role: string; team: TeamMember[] };
  device: { kind: "desk" | "pocket"; activity: Activity };
  threadRef: string;
  fragments: CortexFragment[];
  previous: CortexResult | null;
  /** the most recent other thought's card, supplied only when this looks like a correction */
  lastCard: { ref: string; result: Partial<CortexResult> & { category: Category } } | null;
  candidates: Candidate[];
  recent: RecentThought[];
  triage: Triage;
  /** dictionary terms (jargon the user is known to use) */
  vocabulary: string[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface CortexOutput {
  result: CortexResult;
  source: "llm" | "mock";
  model: string;
  usage?: LlmUsage;
  /** total call time (ms) */
  ms: number;
  /** time to the first parsed field when streaming (ms) */
  firstFieldMs?: number;
  redactions: number;
  /** set when the LLM was attempted but we fell back */
  degraded?: string;
}

export type PartialCallback = (partial: Partial<CortexResult>) => void;

export interface CortexBackend {
  readonly name: string;
  analyze(input: CortexInput, onPartial?: PartialCallback): Promise<CortexOutput>;
  /** warm connections / compile schemas; must never throw */
  warm?(): Promise<void>;
}
