import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Config } from "../config";
import { createRedactor, rehydrate, type Redaction } from "../gate/redact";
import { log } from "../log";
import { extractJson } from "./groq";
import { GroqError, type GroqClient, type GroqRequest } from "./groq-client";
import { buildOutputFormat } from "./schema";

/* ============================================================================
 * DEEP model client: recall answers (streamed), session briefs and consolidation (structured).
 * Off the <1 s hot path, so quality over speed.
 *  - Anthropic (default): Opus 5.5 with adaptive thinking always on; depth is controlled with output_config.effort ("low"
 *    for interactive work).
 *  - Groq (LLM_PROVIDER=groq, a shared GroqClient): GROQ_MODEL_DEEP with reasoning_effort "medium", the same compact prompts,
 *    and completion allowances sized for the 8,000 tokens-per-minute free tier.
 * Every prompt is redacted first; any failure returns null so callers use their local fallback.
 * Refusals are handled per the model docs: server-side refusal fallback is requested, and a
 * refusal stop_reason is treated as "no answer".
 * ========================================================================== */

export interface DeepUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Groq: completion allowances. The free tier admits a call only while (prompt + allowance) fits the minute budget. */
const GROQ_STREAM_MAX = 1100;
const GROQ_JSON_MAX = 1800;
/** Groq: how long a deep call may queue for the budget (interactive recall waits less than background work) */
const GROQ_WAIT_STREAM_MS = 8_000;
const GROQ_WAIT_JSON_MS = 20_000;

/** A consumer's callback that throws (a closed socket, a renderer) must not fail the call that is still producing the answer. */
const safely = (fn: () => void): void => {
  try {
    fn();
  } catch {
    /* the final text is returned whole regardless */
  }
};

/** Re-inserts redacted values into streamed text, holding back a placeholder that is split across deltas ("[EMA" + "IL_1]"). */
function rehydratingEmitter(map: Redaction["map"], emit: (s: string) => void): { push(delta: string): void; flush(): void } {
  let pending = "";
  return {
    push(delta) {
      pending += delta;
      const open = pending.lastIndexOf("[");
      const hold = map.length > 0 && open >= 0 && open > pending.length - 24 && !pending.slice(open).includes("]") ? open : pending.length;
      const out = pending.slice(0, hold);
      pending = pending.slice(hold);
      if (out) emit(rehydrate(out, map));
    },
    flush() {
      if (pending) emit(rehydrate(pending, map));
      pending = "";
    },
  };
}

export class DeepLlm {
  private client: Anthropic;
  private groq: GroqClient | undefined;
  private useFallbacks = true;
  private disabledUntil = 0;
  private warned = new Set<string>();

  constructor(
    private cfg: Config,
    private opts: {
      isLocalOnly: () => boolean;
      pseudonymNames?: () => string[];
      onCloudCall?: (info: { model: string; redactions: number }) => void;
      /** the shared Groq client (pacing and counters are per key, so the fast cortex and this class must share one) */
      groq?: GroqClient;
    },
  ) {
    this.client = new Anthropic({ apiKey: cfg.llm.apiKey || undefined, maxRetries: 1, timeout: 30_000 });
    if (cfg.llm.provider === "groq") this.groq = opts.groq;
  }

  get available(): boolean {
    if (this.cfg.llm.mode !== "live" || this.opts.isLocalOnly()) return false;
    if (this.cfg.llm.provider === "groq") return Boolean(this.groq && this.groq.hasKey && this.groq.disabledReasonFor(this.cfg.llm.deep) === null);
    return Date.now() >= this.disabledUntil;
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
    if (this.groq) return this.streamGroq(this.groq, o);
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
    if (this.groq) return this.jsonGroq(this.groq, o);
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

  // ------------------------------------------------------------------- Groq --

  private groqEffort(): GroqRequest["reasoningEffort"] {
    return this.model.startsWith("openai/") ? "medium" : undefined;
  }

  private noteGroq(err: unknown): void {
    // the client owns the auth window and the 429 cool-down; this only keeps the log honest (kinds and statuses, never content)
    if (err instanceof GroqError) log.debug("llm.deep", `groq ${err.kind}`, { status: err.status });
    else log.error("llm.deep", `unexpected error in a groq deep call: ${(err as Error)?.name ?? "error"}`); // the name only: a message can quote text
  }

  private async streamGroq(g: GroqClient, o: { system: string; user: string; maxTokens?: number; onDelta: (s: string) => void; timeoutMs?: number }): Promise<{ text: string; usage: DeepUsage } | null> {
    const rd = createRedactor({ pseudonymizeNames: this.opts.pseudonymNames?.() ?? [] });
    const user = rd.text(o.user);
    const out = rehydratingEmitter(rd.map, o.onDelta);
    try {
      const res = await g.chat(
        {
          model: this.model,
          messages: [
            { role: "system", content: o.system },
            { role: "user", content: user },
          ],
          maxCompletionTokens: Math.min(o.maxTokens ?? 1500, GROQ_STREAM_MAX),
          temperature: 0.3,
          reasoningEffort: this.groqEffort(),
        },
        { stream: true, onDelta: (d) => safely(() => out.push(d)), timeoutMs: o.timeoutMs ?? 25_000, maxWaitMs: GROQ_WAIT_STREAM_MS, onSend: () => this.opts.onCloudCall?.({ model: this.model, redactions: rd.count }) },
      );
      safely(() => out.flush());
      if (!res.text.trim()) return null;
      return { text: rehydrate(res.text, rd.map), usage: { inputTokens: res.usage.promptTokens, outputTokens: res.usage.completionTokens } };
    } catch (err) {
      this.noteGroq(err);
      return null;
    }
  }

  private async jsonGroq<S extends z.ZodType>(g: GroqClient, o: { system: string; user: string; schema: S; maxTokens?: number; timeoutMs?: number }): Promise<z.infer<S> | null> {
    const rd = createRedactor({ pseudonymizeNames: this.opts.pseudonymNames?.() ?? [] });
    const user = rd.text(o.user);
    const fmt = buildOutputFormat(o.schema);
    let strict = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await g.chat(
          {
            model: this.model,
            messages: [
              { role: "system", content: strict ? o.system : `${o.system}\nReply with ONE JSON object that matches this JSON Schema: ${JSON.stringify(fmt.schema)}` },
              { role: "user", content: user },
            ],
            maxCompletionTokens: Math.min(o.maxTokens ?? 3000, GROQ_JSON_MAX),
            temperature: 0.2,
            reasoningEffort: this.groqEffort(),
            responseFormat: strict ? { type: "json_schema", name: "result", schema: fmt.schema, strict: true } : { type: "json_object" },
          },
          { timeoutMs: o.timeoutMs ?? 30_000, maxWaitMs: GROQ_WAIT_JSON_MS, onSend: () => this.opts.onCloudCall?.({ model: this.model, redactions: rd.count }) },
        );
        if (res.finishReason === "length") return null;
        const parsed = (() => {
          try {
            return o.schema.safeParse(extractJson(res.text));
          } catch {
            return undefined;
          }
        })();
        if (parsed?.success) return rehydrate(parsed.data as z.infer<S>, rd.map);
        if (attempt === 0) {
          strict = false; // one more try, with the schema spelled out in the prompt
          continue;
        }
        return null;
      } catch (err) {
        if (err instanceof GroqError && (err.kind === "schema_rejected" || err.kind === "bad_output") && attempt === 0) {
          strict = false;
          continue;
        }
        this.noteGroq(err);
        return null;
      }
    }
    return null;
  }
}
