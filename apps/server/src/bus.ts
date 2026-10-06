import { EventEmitter } from "node:events";
import type { ArtifactStatus } from "@synapse/shared";

/** Typed in-process domain events. Detectors, metrics and the graph listen here. */
export interface BusEvents {
  "fragment.added": { thoughtId: string; fragmentId: string; deviceId: string };
  "thought.updated": { thoughtId: string };
  "thought.finalized": { thoughtId: string };
  "thought.removed": { thoughtId: string; reason: string };
  "speech.state": { deviceId: string; speaking: boolean; at: number };
  "artifact.status": { artifactId: string; thoughtId: string; status: ArtifactStatus };
  "privacy.paused": { by: string; at: number };
  "privacy.resumed": { by: string; at: number };
  "suggestion.resolved": { id: string; kind: string; action: "accept" | "dismiss" | "later" };
  "recall.hit": { thoughtIds: string[] };
  "session.started": { sessionId: string; deviceId: string };
  "session.ended": { sessionId: string; deviceId: string };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(50);
  }
  on<K extends keyof BusEvents>(event: K, handler: Handler<K>): () => void {
    this.ee.on(event, handler as (...a: unknown[]) => void);
    return () => this.ee.off(event, handler as (...a: unknown[]) => void);
  }
  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    // Handlers must never break the pipeline.
    for (const fn of this.ee.listeners(event) as Array<(p: BusEvents[K]) => void>) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for ${event} threw`, (err as Error).message);
      }
    }
  }
}
