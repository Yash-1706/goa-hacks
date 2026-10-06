import { z } from "zod";
import type {
  Activity,
  ArtifactView,
  BriefView,
  CalendarEventView,
  Category,
  DeviceInfo,
  EchoView,
  GraphEdge,
  GraphNode,
  LatencySummary,
  RecallConstraints,
  RecallSource,
  SuggestionStatus,
  SuggestionView,
  ThoughtView,
} from "./domain";

/* ============================================================================
 * Realtime protocol (WebSocket /ws). JSON messages: { type, ... }.
 * Client → server messages are validated with zod (security boundary).
 * Server → client messages are plain TS types (the web client trusts the server).
 * ========================================================================== */

const ActivitySchema = z.enum(["still", "walking", "vehicle", "desk", "unknown"]);

export const TransportSchema = z.enum([
  "wispr_ws",
  "wispr_rest",
  "wispr_proxy",
  "local_stt",
  "mock",
  "replay",
]);

// ------------------------------------------------------------ client → server

export const HelloSchema = z.object({
  type: z.literal("hello"),
  deviceId: z.string().min(3).max(80),
  kind: z.enum(["desk", "pocket"]),
  name: z.string().max(80).optional(),
  /** device token from a previous pairing */
  token: z.string().max(256).optional(),
  pairingCode: z.string().max(16).optional(),
});

export const PingSchema = z.object({ type: z.literal("ping"), t0: z.number() });

export const SessionStartSchema = z.object({
  type: z.literal("session.start"),
  sessionId: z.string().min(3).max(80),
  activity: ActivitySchema.optional(),
});

export const SessionEndSchema = z.object({
  type: z.literal("session.end"),
  sessionId: z.string().min(3).max(80),
});

export const SpeechStateSchema = z.object({
  type: z.literal("speech.state"),
  speaking: z.boolean(),
  at: z.number(),
});

export const FragmentFinalSchema = z.object({
  type: z.literal("fragment.final"),
  fragmentId: z.string().min(3).max(80),
  sessionId: z.string().min(3).max(80),
  text: z.string().min(1).max(4000),
  detectedLanguage: z.string().max(16).optional(),
  t: z.object({
    speechStart: z.number(),
    speechEnd: z.number(),
    commitSent: z.number().optional(),
    wisprFinal: z.number().optional(),
  }),
  durationMs: z.number().min(0).max(600_000),
  pauseBeforeMs: z.number().min(0).max(86_400_000),
  rmsMean: z.number().min(0).max(1),
  rmsMax: z.number().min(0).max(1),
  whisper: z.boolean(),
  activity: ActivitySchema.optional(),
  transport: TransportSchema,
});

export const FragmentFailedSchema = z.object({
  type: z.literal("fragment.failed"),
  fragmentId: z.string().min(3).max(80),
  reason: z.string().max(200),
});

export const PrivacyPauseSchema = z.object({
  type: z.literal("privacy.pause"),
  via: z.enum(["voice", "tap", "kws", "api"]),
  purgeWindowSecs: z.number().min(0).max(3600).optional(),
});

export const PrivacyResumeSchema = z.object({ type: z.literal("privacy.resume") });

export const PrivacyForgetSchema = z.object({
  type: z.literal("privacy.forget"),
  scope: z.enum(["last", "window", "query"]),
  windowSecs: z.number().min(1).max(86_400).optional(),
  query: z.string().max(500).optional(),
});

export const CardActionSchema = z.object({
  type: z.literal("card.action"),
  thoughtId: z.string().optional(),
  artifactId: z.string().optional(),
  action: z.enum(["accept", "dismiss", "edit", "push", "undo", "forget", "promote"]),
  patch: z.record(z.string(), z.unknown()).optional(),
});

export const SuggestionActionSchema = z.object({
  type: z.literal("suggestion.action"),
  id: z.string(),
  action: z.enum(["accept", "dismiss", "later"]),
  /** reschedule suggestions: which of the offered slots to hold (index into payload.slots) */
  pick: z.number().int().min(0).max(9).optional(),
});

export const RecallAskSchema = z.object({
  type: z.literal("recall.ask"),
  queryId: z.string().min(3).max(80),
  text: z.string().min(1).max(1000),
});

export const ContextUpdateSchema = z.object({
  type: z.literal("context.update"),
  activity: ActivitySchema.optional(),
  battery: z.object({ level: z.number().min(0).max(1), charging: z.boolean() }).optional(),
  mode: z.enum(["normal", "eco"]).optional(),
  listening: z.boolean().optional(),
});

export const MetricsClientSchema = z.object({
  type: z.literal("metrics.client"),
  fragmentId: z.string(),
  firstPaint: z.number().optional(),
  artifactRender: z.number().optional(),
  pauseLatencyMs: z.number().optional(),
});

export const MetricsBatterySchema = z.object({
  type: z.literal("metrics.battery"),
  mode: z.enum(["normal", "eco"]),
  cpuMs: z.number().min(0),
  radioMs: z.number().min(0),
  bytesUp: z.number().min(0),
  windowMs: z.number().min(1),
  level: z.number().min(0).max(1).optional(),
  charging: z.boolean().optional(),
});

export const WisprTokenRequestSchema = z.object({
  type: z.literal("wispr.token.request"),
  /** mint a fresh token even if a recent one is cached (sent after Wispr rejected the previous one) */
  force: z.boolean().optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  PingSchema,
  SessionStartSchema,
  SessionEndSchema,
  SpeechStateSchema,
  FragmentFinalSchema,
  FragmentFailedSchema,
  PrivacyPauseSchema,
  PrivacyResumeSchema,
  PrivacyForgetSchema,
  CardActionSchema,
  SuggestionActionSchema,
  RecallAskSchema,
  ContextUpdateSchema,
  MetricsClientSchema,
  MetricsBatterySchema,
  WisprTokenRequestSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type FragmentFinal = z.infer<typeof FragmentFinalSchema>;
export type ClientMessageType = ClientMessage["type"];

// ------------------------------------------------------------ server → client

export interface ClientConfig {
  wisprMode: "client" | "proxy" | "mock";
  languages: string[];
  llmMode: "live" | "mock";
  localOnly: boolean;
  autonomyLevel: number;
  pauseWindowSecs: number;
  ttlHours: number;
  userFirstName: string;
  timezone: string;
  hackathonStart: number;
  embeddings: "model" | "hash";
  /** thread close timer, used by UI for "thinking" animation */
  threadCloseMs: number;
  /** true when the server runs with a development-only surface (inject/replay) */
  dev: boolean;
  /** which integrations are really connected (otherwise simulated) */
  integrations: { github: boolean; jira: boolean };
}

export interface StateSnapshot {
  paused: boolean;
  pausedAt?: number;
  pausedBy?: string;
  devices: DeviceInfo[];
  /** recent thoughts, oldest first */
  thoughts: ThoughtView[];
  suggestions: SuggestionView[];
  echoes: EchoView[];
  asideCount: number;
  metrics: LatencySummary;
  calendar: CalendarEventView[];
}

export type ServerMessage =
  | {
      type: "welcome";
      deviceId: string;
      serverTime: number;
      config: ClientConfig;
      state: StateSnapshot;
      /** issued once pairing succeeds; store and send in later hello */
      token?: string;
    }
  | { type: "auth.required"; reason: string }
  | { type: "pong"; t0: number; tServer: number }
  | { type: "state.update"; paused: boolean; pausedAt?: number; pausedBy?: string; devices: DeviceInfo[] }
  | {
      type: "wispr.token";
      mode: "client" | "proxy" | "mock";
      token?: string;
      expiresAt?: number;
      wsUrl?: string;
      restUrl?: string;
      /** set when the token could not be minted (UI falls back to mock/typed input) */
      error?: string;
    }
  | {
      type: "wispr.context";
      dictionary: string[];
      conversation: Array<{ role: "user"; content: string }>;
      language: string[];
    }
  | { type: "fragment.ack"; fragmentId: string; thoughtId: string }
  | { type: "fragment.filtered"; fragmentId: string; reason: "aside" | "noise" | "paused"; asideCount: number }
  | { type: "thought.upsert"; thought: ThoughtView }
  | { type: "thought.remove"; id: string; reason: "purged" | "retracted" | "expired" | "forgotten" | "aside" | "merged" }
  | { type: "artifact.upsert"; thoughtId: string; artifact: ArtifactView }
  | { type: "suggestion.push"; suggestion: SuggestionView }
  | { type: "suggestion.update"; id: string; status: SuggestionStatus }
  | { type: "echo.push"; echo: EchoView }
  | {
      type: "recall.sources";
      queryId: string;
      queryText: string;
      constraints: RecallConstraints;
      sources: RecallSource[];
      relaxations: string[];
      ms: number;
    }
  | { type: "recall.delta"; queryId: string; text: string }
  | { type: "recall.done"; queryId: string; answer: string; citations: string[]; notFound: boolean; ms: number }
  | { type: "graph.delta"; nodes: GraphNode[]; edges: GraphEdge[]; removedNodes: string[]; removedEdges: string[] }
  | { type: "brief.ready"; brief: BriefView }
  | { type: "privacy.paused"; by: string; purgedCount: number; at: number }
  | { type: "privacy.resumed"; by: string; at: number }
  | { type: "privacy.forgot"; scope: "last" | "window" | "query" | "ledger"; count: number; query?: string; at: number }
  /** transient, human-readable notice (shown as a toast): "Retracted: Rotate the staging keys" */
  | { type: "notice"; level: "info" | "warn" | "success"; text: string; at: number }
  | { type: "metrics.update"; summary: LatencySummary }
  | { type: "calendar.update"; events: CalendarEventView[] }
  | { type: "error"; code: string; message: string };

export type ServerMessageType = ServerMessage["type"];

export interface PauseIntentResult {
  match: boolean;
  score: number;
  via: "phrase" | "semantic" | "none";
}

export type { Activity, Category };
