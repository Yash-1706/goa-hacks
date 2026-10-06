import type { ClientMessage } from "@synapse/shared";

/* ============================================================================
 * Client-side latency reporting (TRD §15.1). For every fragment THIS device spoke:
 *   - when the first thought.upsert that follows its ack has been painted → metrics.client {firstPaint}
 *   - when the upsert with the finished analysis (analyzing=false, no longer provisional) has been painted
 *     → metrics.client {artifactRender}, attributed to the thought's LATEST acked fragment (the model call
 *     covers all earlier fragments of the thread, and the server records the LLM timings on the last one)
 * Fragments spoken on other devices are never reported: their clock is not ours.
 * ========================================================================== */

export interface LatencyDeps {
  send: (msg: ClientMessage) => boolean;
  now: () => number;
  /** run after the browser painted (requestAnimationFrame + a macrotask) */
  afterPaint: (cb: () => void) => void;
  onFirstPaint?: (fragmentId: string, thoughtId: string, ms: number, at: number) => void;
  onArtifact?: (fragmentId: string, thoughtId: string, ms: number, at: number) => void;
}

export interface UpsertLike {
  id: string;
  analyzing?: boolean;
  provisional: boolean;
}

export class LatencyTracker {
  /** local fragment → client time its transcript became final */
  private local = new Map<string, number>();
  private awaitingFirst = new Map<string, string>();
  private awaitingArtifact = new Map<string, string>();

  constructor(private d: LatencyDeps) {}

  /** a fragment this device is sending (wisprFinal is the client-clock time it became final text) */
  noteLocal(fragmentId: string, wisprFinal: number): void {
    this.local.set(fragmentId, wisprFinal);
    if (this.local.size > 200) {
      const first = this.local.keys().next().value;
      if (first !== undefined) this.local.delete(first);
    }
  }

  onAck(fragmentId: string, thoughtId: string): void {
    if (!this.local.has(fragmentId)) return;
    this.awaitingFirst.set(fragmentId, thoughtId);
    this.awaitingArtifact.set(thoughtId, fragmentId); // latest acked fragment wins
  }

  onUpsert(t: UpsertLike): void {
    const firsts: string[] = [];
    for (const [f, th] of this.awaitingFirst) if (th === t.id) firsts.push(f);
    const lastFragment = this.awaitingArtifact.get(t.id);
    const artifactDone = lastFragment !== undefined && !t.analyzing && !t.provisional;
    if (!firsts.length && !artifactDone) return;
    for (const f of firsts) this.awaitingFirst.delete(f);
    if (artifactDone) this.awaitingArtifact.delete(t.id);

    this.d.afterPaint(() => {
      const at = this.d.now();
      for (const f of firsts) {
        this.d.send({ type: "metrics.client", fragmentId: f, firstPaint: at });
        const base = this.local.get(f);
        if (base !== undefined) this.d.onFirstPaint?.(f, t.id, Math.max(0, at - base), at);
      }
      if (artifactDone && lastFragment !== undefined) {
        this.d.send({ type: "metrics.client", fragmentId: lastFragment, artifactRender: at });
        const base = this.local.get(lastFragment);
        if (base !== undefined) this.d.onArtifact?.(lastFragment, t.id, Math.max(0, at - base), at);
      }
    });
  }

  /** a thought disappeared: nothing more to report for it */
  forget(thoughtId: string): void {
    this.awaitingArtifact.delete(thoughtId);
    for (const [f, th] of this.awaitingFirst) if (th === thoughtId) this.awaitingFirst.delete(f);
  }
}

/** Frames can be throttled (occluded window, background pane): never let that stretch a latency measurement. */
export const PAINT_FALLBACK_MS = 120;

/** After the next paint (rAF + macrotask), at the latest PAINT_FALLBACK_MS from now; immediately when the tab is hidden. */
export function afterPaint(cb: () => void): void {
  if (typeof document === "undefined" || document.hidden || typeof requestAnimationFrame === "undefined") {
    cb();
    return;
  }
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    cb();
  };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, PAINT_FALLBACK_MS);
}
