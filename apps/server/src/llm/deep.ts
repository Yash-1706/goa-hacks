import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Config } from "../config";
import { createRedactor, rehydrate } from "../gate/redact";
import { log } from "../log";

/* ============================================================================
 * DEEP model client (Opus 5.5): recall answers (streamed), session briefs and consolidation
 * (structured). Off the <1 s hot path, so quality over speed: adaptive thinking is always on for
 * this model; depth is controlled with output_config.effort ("low" for interactive work).
 * Every prompt is redacted first; any failure returns null so callers use their local fallback.
 * Refusals are handled per the model docs: server-side refusal fallback is requested, and a
 * refusal stop_reason is treated as "no answer".
 * ========================================================================== */

export interface DeepUsage {
  inputTokens: number;
  outputTokens: number;
}

export class DeepLlm {
  private client: Anthropic;
  private useFallbacks = true;
  private disabledUntil = 0;
  private warned = new Set<string>();

  constructor(
    private cfg: Config,
    private opts: {
      isLocalOnly: () => boolean;
      pseudonymNames?: () => string[];
      onCloudCall?: (info: { model: string; redactions: number }) => void;
    },
  ) {
    this.client = new Anthropic({ apiKey: cfg.llm.apiKey || undefined, maxRetries: 1, timeout: 30_000 });
  }

  get available(): boolean {
    return this.cfg.llm.mode === "live" && !this.opts.isLocalOnly() && Date.now() >= this.disabledUntil;
  }

  get model(): string {
    return this.cfg.llm.deep;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn("llm.deep", msg);
  }

  private note(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      this.disabledUntil = Date.now() + 60_000;
      this.warnOnce("auth", "Anthropic auth failed for the deep model: using local fallbacks");
      return "auth";
    }
    if (err instanceof Anthropic.RateLimitError) {
      this.disabledUntil = Date.now() + 8_000;
      return "rate_limit";
    }
    if (err instanceof Anthropic.BadRequestError) {
      // the optional server-side fallback beta may be unavailable on this account: retry once without it
      if (this.useFallbacks && /fallback|beta/i.test(err.message)) {
        this.useFallbacks = false;
        this.warnOnce("fb", "server-side refusal fallback not accepted; continuing without it");
        return "retry_without_fallbacks";
      }
      this.warnOnce("bad", `deep request rejected: ${err.message.slice(0, 140)}`);
      return "bad_request";
    }
    return (err as Error)?.name === "AbortError" ? "timeout" : "error";
  }

  /** Stream a plain-text answer. Returns null when unavailable or failed. */
  async stream(o: { system: string; user: string; maxTokens?: number; onDelta: (s: string) => void; timeoutMs?: number }): Promise<{ text: string; usage: DeepUsage } | null> {
    if (!this.available) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const rd = createRedactor({ pseudonymizeNames: this.opts.pseudonymNames?.() ?? [] });
      const user = rd.text(o.user);
      this.opts.onCloudCall?.({ model: this.model, redactions: rd.count });
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 25_000);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any = {
          model: this.model,
          max_tokens: o.maxTokens ?? 1500, // thinking tokens count against max_tokens
          system: o.system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: "low" },
        };
        if (this.useFallbacks) {
          params.betas = ["server-side-fallback-2026-07-01"];
          params.fallbacks = "default";
        }
        const stream = this.client.beta.messages.stream(params, { signal: ctl.signal });
        let acc = "";
        stream.on("text", (delta: string) => {
          acc += delta;
          o.onDelta(rehydrate(delta, rd.map));
        });
        const final = await stream.finalMessage();
        clearTimeout(timer);
        if (final.stop_reason === "refusal") return null;
        const text = rehydrate(acc || final.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(""), rd.map);
        return { text, usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens } };
      } catch (err) {
        clearTimeout(timer);
        const verdict = this.note(err);
        if (verdict === "retry_without_fallbacks" && attempt === 0) continue;
        return null;
      }
    }
    return null;
  }

  /** Structured JSON (validated by zod). Returns null when unavailable or failed. */
  async json<S extends z.ZodType>(o: { system: string; user: string; schema: S; maxTokens?: number; timeoutMs?: number }): Promise<z.infer<S> | null> {
    if (!this.available) return null;
    const rd = createRedactor({ pseudonymizeNames: this.opts.pseudonymNames?.() ?? [] });
    const user = rd.text(o.user);
    this.opts.onCloudCall?.({ model: this.model, redactions: rd.count });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
    try {
      const res = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: o.maxTokens ?? 3000,
          system: o.system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: "low", format: zodOutputFormat(o.schema) },
        },
        { signal: ctl.signal },
      );
      clearTimeout(timer);
      if (res.stop_reason === "refusal" || !res.parsed_output) return null;
      return rehydrate(res.parsed_output as z.infer<S>, rd.map);
    } catch (err) {
      clearTimeout(timer);
      this.note(err);
      return null;
    }
  }
}
