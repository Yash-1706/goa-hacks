import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CortexResultSchema, type CortexResult } from "@synapse/shared";
import { renderUserMessage, systemPrompt } from "../cortex/prompts";
import type { CortexBackend, CortexInput, CortexOutput, PartialCallback } from "../cortex/types";
import { createRedactor, rehydrate } from "../gate/redact";
import { log } from "../log";
import { parsePartialJson } from "./partial-json";

/* ============================================================================
 * Live cortex on Claude (TRD §6.5–6.6).
 *  - Hot path model: Haiku 4.5 (latency is a requirement, not a cost choice).
 *  - Structured output (zod → JSON schema) so the card is always schema-valid.
 *  - Streaming + tolerant partial-JSON parsing so the card "types in" within ~400 ms
 *    even though the full artifact takes ~1 s.
 *  - Static system prompt carries cache_control (1h) so only the thread is processed per call.
 *  - Every outgoing string is redacted first; placeholders are rehydrated locally.
 *  - Strict timeout; on ANY failure fall back to the local cortex so the demo never stalls.
 * ========================================================================== */

export interface ClaudeCortexOpts {
  apiKey?: string;
  model: string;
  fallback: CortexBackend;
  timeoutMs?: number;
  /** names to pseudonymize before the cloud call (PSEUDONYMIZE_PERSONS) */
  pseudonymNames?: () => string[];
  /** audit hook: a cloud call happened */
  onCloudCall?: (info: { model: string; redactions: number }) => void;
}

const mapStrings = <T>(value: T, fn: (s: string) => string): T => {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
};

export class ClaudeCortex implements CortexBackend {
  readonly name = "claude";
  private client: Anthropic;
  private format = zodOutputFormat(CortexResultSchema);
  private disabledUntil = 0;
  private warned = new Set<string>();
  private timeoutMs: number;

  constructor(private opts: ClaudeCortexOpts) {
    this.client = new Anthropic({ apiKey: opts.apiKey || undefined, maxRetries: 1, timeout: 15_000 });
    this.timeoutMs = opts.timeoutMs ?? 6000;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn("llm", msg);
  }

  /** Compile the schema, write the prompt cache and open the TLS connection before the first real fragment. */
  async warm(): Promise<void> {
    try {
      const t0 = performance.now();
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 60,
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: renderUserMessage({
          now: Date.now(), timezone: "UTC", user: { name: "Rio", role: "engineer", team: [] }, device: { kind: "desk", activity: "desk" },
          fragments: [{ id: "F0", dtMs: 0, text: "warm up", whisper: false, pauseBeforeMs: 0 }], previous: null, lastCard: null, candidates: [], recent: [],
        }) }],
        output_config: { format: this.format },
      });
      log.info("llm", "warmed", {
        model: this.opts.model,
        ms: Math.round(performance.now() - t0),
        cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
        cacheRead: res.usage.cache_read_input_tokens ?? 0,
        promptTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0),
      });
    } catch (err) {
      this.handleError(err, "warm");
    }
  }

  async analyze(input: CortexInput, onPartial?: PartialCallback): Promise<CortexOutput> {
    const t0 = performance.now();
    if (Date.now() < this.disabledUntil) return this.degrade(input, "llm_disabled");

    // ---- redact everything that leaves the machine
    const rd = createRedactor({ pseudonymizeNames: this.opts.pseudonymNames?.() ?? [] });
    const safeInput: CortexInput = {
      ...input,
      fragments: input.fragments.map((f) => ({ ...f, text: rd.text(f.text) })),
      previous: input.previous ? mapStrings(input.previous, (s) => rd.text(s)) : null,
      lastCard: input.lastCard ? mapStrings(input.lastCard, (s) => rd.text(s)) : null,
      candidates: input.candidates.map((c) => ({ ...c, label: rd.text(c.label), snippet: rd.text(c.snippet) })),
      recent: input.recent.map((r) => ({ ...r, title: rd.text(r.title) })),
      vocabulary: input.vocabulary.map((v) => rd.text(v)),
    };
    const user = renderUserMessage(safeInput);
    this.opts.onCloudCall?.({ model: this.opts.model, redactions: rd.count });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let firstFieldMs: number | undefined;
    let lastSent = 0;
    let lastKey = "";
    try {
      const stream = this.client.messages.stream(
        {
          model: this.opts.model,
          max_tokens: 1100,
          temperature: 0.2,
          system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [{ role: "user", content: user }],
          output_config: { format: this.format },
        },
        { signal: ctl.signal },
      );

      stream.on("text", (_delta: string, snapshot: string) => {
        if (!onPartial) return;
        const now = performance.now();
        if (now - lastSent < 60) return;
        const parsed = parsePartialJson(snapshot);
        if (!parsed || typeof parsed !== "object") return;
        const partial = rehydrate(parsed as Partial<CortexResult>, rd.map);
        const key = JSON.stringify([partial.category, partial.title, partial.intent, (partial.artifact as { kind?: string } | undefined)?.kind, JSON.stringify(partial.artifact ?? {}).length]);
        if (key === lastKey) return;
        lastKey = key;
        lastSent = now;
        if (firstFieldMs === undefined && (partial.category || partial.title)) firstFieldMs = now - t0;
        onPartial(partial);
      });

      const final = await stream.finalMessage();
      clearTimeout(timer);

      if (final.stop_reason === "refusal") return this.degrade(input, "refusal", t0);
      if (final.stop_reason === "max_tokens") return this.degrade(input, "max_tokens", t0);
      const text = final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return this.degrade(input, "bad_json", t0);
      }
      const parsed = CortexResultSchema.safeParse(json);
      if (!parsed.success) {
        log.warn("llm", "schema validation failed", { issues: parsed.error.issues.length });
        return this.degrade(input, "schema_invalid", t0);
      }
      const result = rehydrate(parsed.data, rd.map);
      const u = final.usage;
      return {
        result,
        source: "llm",
        model: this.opts.model,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
        },
        ms: performance.now() - t0,
        firstFieldMs,
        redactions: rd.count,
      };
    } catch (err) {
      clearTimeout(timer);
      return this.degrade(input, this.handleError(err, "analyze"), t0);
    }
  }

  private handleError(err: unknown, where: string): string {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      this.disabledUntil = Date.now() + 60_000;
      this.warnOnce("auth", `Anthropic auth failed (${where}): check ANTHROPIC_API_KEY. Falling back to the local cortex.`);
      return "auth";
    }
    if (err instanceof Anthropic.RateLimitError) {
      this.disabledUntil = Date.now() + 5_000;
      this.warnOnce("rate", "Anthropic rate limit: local cortex for a few seconds");
      return "rate_limit";
    }
    if (err instanceof Anthropic.BadRequestError) {
      this.warnOnce("bad", `Anthropic rejected the request (${where}): ${err.message.slice(0, 160)}`);
      return "bad_request";
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError || (err as Error)?.name === "AbortError" || /abort/i.test((err as Error)?.message ?? "")) return "timeout";
    if (err instanceof Anthropic.APIConnectionError) return "network";
    if (err instanceof Anthropic.APIError) {
      this.warnOnce(`api${err.status}`, `Anthropic API error ${err.status} (${where})`);
      return `api_${err.status}`;
    }
    log.error("llm", `unexpected error in ${where}: ${(err as Error)?.message}`);
    return "error";
  }

  private async degrade(input: CortexInput, reason: string, t0 = performance.now()): Promise<CortexOutput> {
    const out = await this.opts.fallback.analyze(input);
    return { ...out, degraded: reason, ms: performance.now() - t0 };
  }
}
