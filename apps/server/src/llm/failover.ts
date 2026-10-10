import type { CortexBackend, CortexInput, CortexOutput, PartialCallback } from "../cortex/types";
import type { GroqCortex } from "./groq";

/**
 * Groq meters tokens and requests PER MODEL, and a free account reaches its daily cap on one model long before the other. When the
 * fast model is out (its 429 pause is running, or it refuses this very call with a 429) the same card is asked of the spare model
 * instead of dropping straight to the offline cortex. The fast model is tried again as soon as its pause ends; the spare is only
 * ever asked when the fast model could not answer, so a healthy day never touches it.
 */
export class FailoverBackend implements CortexBackend {
  readonly name: string;

  constructor(
    private primary: GroqCortex,
    private spare: GroqCortex,
  ) {
    this.name = primary.name;
  }

  warm(): Promise<void> {
    return this.primary.warm();
  }

  async analyze(input: CortexInput, onPartial?: PartialCallback): Promise<CortexOutput> {
    if (this.primary.cooling && !this.spare.cooling) return this.spare.analyze(input, onPartial);
    const out = await this.primary.analyze(input, onPartial);
    if (out.degraded === "rate_limit" && !this.spare.cooling) {
      const alt = await this.spare.analyze(input, onPartial);
      if (alt.source === "llm") return alt;
    }
    return out;
  }
}
