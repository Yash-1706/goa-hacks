import type {
  Activity,
  Artifact,
  ArtifactKind,
  ArtifactStatus,
  Category,
  DictionaryTerm,
  EdgeType,
  EntityType,
  FragmentTransport,
  ReferenceView,
  RepairView,
  SalienceCue,
  SuggestionView,
  ThoughtSource,
  ThoughtTiming,
} from "@synapse/shared";

export interface SessionRec {
  id: string;
  code: string;
  deviceId: string;
  deviceKind: "desk" | "pocket";
  startedAt: number;
  endedAt: number | null;
  activity: Activity;
  label: string | null;
  keyId: string;
}

export interface FragRec {
  id: string;
  sessionId: string;
  thoughtId: string;
  deviceId: string;
  text: string;
  tStart: number;
  tEnd: number;
  pauseBeforeMs: number;
  durationMs: number;
  rmsMean: number;
  whisper: boolean;
  lang?: string;
  activity: Activity;
  transport: FragmentTransport;
  emb: Float32Array;
  keyId: string;
  expiresAt: number | null;
  createdAt: number;
  /** guards against split/merge loops (not persisted) */
  splitDone?: boolean;
}

export interface ThoughtRec {
  id: string;
  code: string;
  sessionId: string;
  deviceId: string;
  deviceKind: "desk" | "pocket";
  activity: Activity;
  status: "open" | "final";
  provisional: boolean;
  tentative: boolean;
  source: ThoughtSource;
  category: Category;
  confidence: number;
  title: string;
  intent: string;
  why: string;
  references: ReferenceView[];
  repairs: RepairView[];
  openQuestions: string[];
  fragmentIds: string[];
  entityIds: string[];
  artifactId: string | null;
  salience: number;
  salienceReasons: string[];
  salienceCues: SalienceCue[];
  promoted: boolean;
  concernKey: string | null;
  /** gist embedding (title + intent) */
  emb: Float32Array;
  keyId: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
  timing: ThoughtTiming;
  correctsThoughtId?: string;
  retracted?: boolean;
  /** transient diagnostics (not persisted): values masked before the cloud call / why the live model was bypassed */
  redactions?: number;
  degraded?: string;
}

export interface EntityRec {
  id: string;
  code: string;
  type: EntityType;
  name: string;
  aliases: string[];
  emb: Float32Array;
  salience: number;
  mentionCount: number;
  firstSeen: number;
  lastSeen: number;
  /** 0 auto, 1 promoted long-term, 2 pinned seed (never garbage collected) */
  longTerm: 0 | 1 | 2;
  expiresAt: number | null;
  keyId: string;
}

export interface EdgeRec {
  id: string;
  src: string;
  dst: string;
  type: EdgeType;
  weight: number;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
}

export interface ArtifactRec {
  id: string;
  code: string;
  thoughtId: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  autonomyLevel: number;
  payload: Artifact;
  externalRef?: string;
  externalUrl?: string;
  simulated: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  keyId: string;
  /** V1 routing answers: repo, recipients by name, due time */
  route?: { repo?: string; to?: Record<string, string[]>; dueAt?: string };
}

export interface OpenLoopRec {
  id: string;
  thoughtId: string;
  question: string;
  status: "open" | "answered" | "dropped";
  answerThoughtId?: string;
  createdAt: number;
  expiresAt: number | null;
  keyId: string;
}

export interface SuggestionRec {
  view: SuggestionView;
  keyId: string;
}

export interface DictRec extends DictionaryTerm {
  id: string;
  keyId: string;
}

export interface CalendarRec {
  id: string;
  title: string;
  start: number;
  end: number;
  source: "seed" | "voice" | "manual";
  keyId: string;
}

export interface DeleteReport {
  thoughtId: string;
  fragments: number;
  artifacts: number;
  openLoops: number;
  entities: number;
  edges: number;
  suggestions: number;
  dictionary: number;
  /** artifacts that had already been executed externally (only the local copy was removed) */
  externalLeft: Array<{ ref: string; url?: string }>;
}
