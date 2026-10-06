import { matchPauseIntent, PAUSE_PHRASES } from "@synapse/shared";
import { dot, type Embedder } from "../memory/embeddings";
import { fold } from "../text";
import { T } from "../thresholds";

/* ============================================================================
 * Control intents handled before anything is stored (TRD §8.4, §10.2):
 *   pause  — "pause memory" and meaning-equivalents (phrase match + semantic backstop)
 *   forget — "forget that", "forget the last five minutes", "forget what I said about Sarah"
 * ========================================================================== */

export type ControlIntent =
  | { kind: "pause"; via: "phrase" | "semantic"; score: number }
  | { kind: "forget"; scope: "last" | "window" | "query"; windowSecs?: number; query?: string };

const NUM: Record<string, number> = {
  a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, sixty: 60,
};

export function parseForget(text: string): ControlIntent | null {
  const f = fold(text);
  if (!f || f.split(" ").length > 16) return null;

  const window = f.match(/\b(?:forget|delete|erase|remove|wipe)\b.*?\b(?:last|past)\s+(\w+)?\s*(second|seconds|minute|minutes|min|mins|hour|hours)\b/);
  if (window) {
    const raw = window[1] ?? "a";
    const n = /^\d+$/.test(raw) ? Number(raw) : (NUM[raw] ?? 1);
    const unit = window[2] ?? "minute";
    const secs = unit.startsWith("sec") ? n : unit.startsWith("min") ? n * 60 : n * 3600;
    return { kind: "forget", scope: "window", windowSecs: Math.min(secs, 86_400) };
  }

  const about = f.match(/\b(?:forget|delete|erase|remove|wipe)\b(?:\s+(?:everything|anything|what i (?:said|mentioned)|my (?:thoughts|notes)|all))?\s+(?:about|on|regarding|related to)\s+(.{2,60})$/);
  if (about?.[1]) return { kind: "forget", scope: "query", query: about[1].trim() };

  if (/^(?:ok(?:ay)?\s+|please\s+|hey\s+)?(?:forget|delete|erase|remove|wipe)\s+(?:that|this|it|what i (?:just )?said|the last (?:thing|one|thought))(?:\s+please)?$/.test(f)) {
    return { kind: "forget", scope: "last" };
  }
  return null;
}

export class ControlIntents {
  private pauseEmb: Float32Array[] = [];

  constructor(private embedder: Embedder) {}

  async init(): Promise<void> {
    this.pauseEmb = await this.embedder.embed([...PAUSE_PHRASES], "passage");
  }

  /**
   * `emb` is optional: pass the fragment embedding to enable the semantic backstop.
   * Phrase matching alone is enough for the common case and has zero latency.
   */
  detect(text: string, emb?: Float32Array): ControlIntent | null {
    const forget = parseForget(text);
    if (forget) return forget;

    const m = matchPauseIntent(text);
    if (m.match) return { kind: "pause", via: "phrase", score: m.score };

    const wc = fold(text).split(" ").filter(Boolean).length;
    if (emb && wc >= 1 && wc <= 8 && this.pauseEmb.length) {
      let best = 0;
      for (const p of this.pauseEmb) best = Math.max(best, this.embedder.calibrate(dot(emb, p)));
      // semantic backstop is only trusted for command-shaped text about memory/recording/listening
      if (best >= T.pauseSemantic && /\b(memory|record\w*|listen\w*|private|privacy|capture|capturing|remember|synapse)\b/.test(fold(text))) {
        return { kind: "pause", via: "semantic", score: best };
      }
    }
    return null;
  }
}
