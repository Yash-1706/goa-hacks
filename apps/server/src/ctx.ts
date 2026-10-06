import type { Activity, DeviceInfo, ServerMessage } from "@synapse/shared";
import type { ArtifactRec, ThoughtRec } from "./memory/types";
import type { ControlIntent } from "./gate/intent";

/** Light-weight handle for the device a fragment came from. */
export interface DeviceRef {
  id: string;
  kind: "desk" | "pocket";
  activity: Activity;
}

/** What services need from the realtime layer (implemented by gateway/hub.ts). */
export interface Hub {
  broadcast(msg: ServerMessage): void;
  sendTo(deviceId: string, msg: ServerMessage): void;
  devices(): DeviceInfo[];
  /** true while any connected device is mid-utterance */
  anySpeaking(): boolean;
  /** ms since every device went silent (0 while someone speaks, Infinity when nobody is connected) */
  quietForMs(): number;
  /** estimated (server − client) clock offset for a device, ms */
  clockOffset(deviceId: string): number | undefined;
}

/** Autonomy ladder enforcement (TRD §9.6): decides what an artifact may do on its own. */
export interface Autonomy {
  onArtifact(t: ThoughtRec, a: ArtifactRec): Promise<void>;
}

/** Control intents (pause / forget) detected in speech. Never stored. */
export interface Controls {
  handle(intent: ControlIntent, dev: DeviceRef, via: "voice" | "semantic"): Promise<void>;
  isPaused(): boolean;
}

export type EmitFn = (msg: ServerMessage) => void;

/** Recall engine surface used by the hub (TRD §7). */
export interface RecallApi {
  ask(queryId: string, text: string, dev: DeviceRef): Promise<void>;
}

/** Proactive engine surface used by the hub (TRD §9). */
export interface ProactiveApi {
  action(id: string, action: "accept" | "dismiss" | "later"): Promise<void>;
  snapshot(): { suggestions: import("@synapse/shared").SuggestionView[]; echoes: import("@synapse/shared").EchoView[] };
}
