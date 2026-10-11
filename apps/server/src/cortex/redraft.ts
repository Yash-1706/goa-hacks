/* ============================================================================
 * Re-draft queue (V1.1). When Groq's free tier has no budget, a card is drafted by the offline cortex so nothing waits. Such a
 * card joins this queue and is re-drafted by the model, in place, when budget returns: the same thought, never a duplicate,
 * with an "improving…" state meanwhile. Cards the user shipped, opened or edited are never overwritten.
 * ========================================================================== */

export interface RedraftState {
  source: "llm" | "local" | "mock";
  degraded?: string;
  artifactStatus?: string;
  edited?: boolean;
}

/** degradations that budget returning can fix (not bad_output: the model already answered badly once) */
const FIXABLE = new Set(["paced", "rate_limit", "timeout", "network"]);
const FINAL = new Set(["executed", "opened", "dismissed", "undone"]);

export interface RedraftDeps {
  state: (thoughtId: string) => RedraftState | undefined;
  reanalyze: (thoughtId: string) => Promise<void>;
  setImproving: (thoughtId: string, on: boolean) => void;
  /** the model has budget for one more call right now */
  budget: () => boolean;
  maxAttempts?: number;
}

export class RedraftQueue {
  private queue: string[] = [];
  private attempts = new Map<string, number>();
  private busy = false;

  constructor(private d: RedraftDeps) {}

  get size(): number {
    return this.queue.length;
  }

  private eligible(id: string): boolean {
    const s = this.d.state(id);
    return Boolean(s && s.source !== "llm" && s.degraded && FIXABLE.has(s.degraded) && !s.edited && !(s.artifactStatus && FINAL.has(s.artifactStatus)));
  }

  /** a thought changed: queue it if it is an offline draft the model could improve */
  consider(id: string): void {
    if (this.queue.includes(id) || !this.eligible(id)) return;
    this.queue.push(id);
    this.d.setImproving(id, true);
  }

  private drop(id: string): void {
    this.queue = this.queue.filter((x) => x !== id);
    this.attempts.delete(id);
    this.d.setImproving(id, false);
  }

  /** re-draft the oldest card if there is budget (one at a time) */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.eligible(this.queue[0] as string)) this.drop(this.queue[0] as string);
      const id = this.queue[0];
      if (!id || !this.d.budget()) return;
      const n = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, n);
      try {
        await this.d.reanalyze(id);
      } catch {
        /* counted as a failed attempt */
      }
      const s = this.d.state(id);
      if (!s || s.source === "llm" || n >= (this.d.maxAttempts ?? 5) || !this.eligible(id)) this.drop(id);
      else this.queue = [...this.queue.slice(1), id]; // still offline: try the next one first
    } finally {
      this.busy = false;
    }
  }
}
