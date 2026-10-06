import type {
  ArtifactView,
  CalendarEventView,
  DictionaryTerm,
  GraphEdge,
  GraphNode,
  LatencySummary,
  LedgerItem,
  ThoughtView,
} from "@synapse/shared";

/* Shapes of the REST responses (apps/server/src/gateway/routes.ts). The WebSocket messages and domain
 * views come from @synapse/shared; these are the few REST-only payloads. */

export interface HealthResponse {
  ok: boolean;
  uptimeS: number;
  modes: { wispr: string; llm: string; embeddings: string; kek: string };
  /** "anthropic" | "groq" | "mock" (absent from older servers) */
  llmProvider?: string;
  models: { fast: string; deep: string; embed: string };
  /** free-tier counters; null unless the live provider is Groq (absent from older servers) */
  groq?: { requestsToday: number; remainingTokensLastSeen: number | null; remainingRequestsLastSeen?: number | null; tpmBudget?: number } | null;
  paused: boolean;
  memory: { thoughts: number; promoted: number; fragments: number; entities: number; edges: number; artifacts: number };
}

export interface AdaptationRow {
  key: string;
  threshold: number;
  accepts: number;
  dismisses: number;
}

export interface SettingsResponse {
  autonomyLevel: number;
  localOnly: boolean;
  llmMode: "live" | "mock";
  wisprMode: "client" | "proxy" | "mock";
  ttlHours: number;
  pauseWindowSecs: number;
  promoteThreshold: number;
  recurring: { n: number; windowMin: number; minGapS: number };
  adaptation: AdaptationRow[];
  integrations: { github: boolean; jira: boolean };
  kekSource: string;
  pseudonymize: boolean;
}

export interface KeyInfo {
  id: string;
  scope: string;
  createdAt: number;
  destroyedAt: number | null;
}

export interface LedgerResponse {
  items: LedgerItem[];
  keys: KeyInfo[];
  retention: { workingMemoryHours: number; pauseWindowSecs: number };
  paused: boolean;
  localOnly: boolean;
  kekSource: string;
  stats: { thoughts: number; promoted: number; fragments: number; entities: number; edges: number; artifacts: number };
  asides: number;
}

export interface AuditRow {
  seq: number;
  ts: number;
  event: string;
  ref: string | null;
  count: number | null;
  prevHash: string;
  hash: string;
}

export interface AuditVerify {
  ok: boolean;
  count: number;
  brokenAt?: number;
}

export interface AuditResponse {
  rows: AuditRow[];
  verify: AuditVerify;
}

export interface OutboxItem extends ArtifactView {
  thoughtId: string;
  thoughtCode?: string;
  thoughtTitle?: string;
  pushable: { ok: boolean; reason?: string };
}

export interface LatencyRowView {
  fragmentId: string;
  deviceId: string;
  transport: string;
  createdAt: number;
  model?: string;
  cachedTokens?: number;
  source?: string;
  stages: Record<string, number>;
}

export interface LatencyResponse {
  summary: LatencySummary;
  rows: LatencyRowView[];
}

export interface BatteryRow {
  deviceId: string;
  mode: string;
  windowMs: number;
  cpuMs: number;
  radioMs: number;
  bytesUp: number;
  energy: number;
  naiveEnergy: number;
  savedPct: number;
  radioActivePct: number;
  lastLevel?: number;
}

export interface BatteryResponse {
  report: BatteryRow[];
  model: { cpuMsCost: number; radioMsCost: number; byteCost: number };
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PairingResponse {
  code: string;
  requirePairing: boolean;
}

export type DictionaryResponse = DictionaryTerm[];
export type CalendarResponse = CalendarEventView[];
export type ThoughtResponse = ThoughtView;
