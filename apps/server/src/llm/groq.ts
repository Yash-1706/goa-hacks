import { CortexResultSchema, type CortexResult } from "@synapse/shared";
import { liteSystemPrompt, renderLiteUserMessage } from "../cortex/prompts-lite";
import type { CortexBackend, CortexInput, CortexOutput, PartialCallback } from "../cortex/types";
import type { GroqOutputMode } from "../config";
import { createRedactor, rehydrate } from "../gate/redact";
import { log } from "../log";
import { GroqError, type GroqClient, type GroqMessage, type GroqRequest, type GroqResponseFormat, type GroqResult } from "./groq-client";
import { parsePartialJson } from "./partial-json";
import { buildOutputFormat } from "./schema";

/* ============================================================================
 * Live cortex on Groq (an alternative to ClaudeCortex when only a Groq key exists; Claude stays the default).
 *  - A compact prompt (cortex/prompts-lite.ts): the 8.5k-token Claude prompt cannot fit Groq's free-tier minute budget.
 *  - Streaming + the same tolerant partial-JSON preview, so the card still "types in" where the provider streams tokens.
 *  - Output contract: `json_object` (the schema is described in the prompt, the answer is validated with zod) or strict
 *    `json_schema` (decoded against our schema; see GROQ_OUTPUT_MODE). A repair retry happens at most once.
 *  - Every outgoing string is redacted first and placeholders are rehydrated locally, exactly like ClaudeCortex.
 *  - On ANY failure (timeout, 429, 413, auth, bad output, local pacing) the local cortex answers, labelled with the reason.
 * ========================================================================== */

export interface GroqAttempt {
  attempt: number;
  streamed: boolean;
  /** the raw text parsed as JSON */
  jsonValid: boolean;
  /** valid against CortexResultSchema exactly as the model wrote it */
  strictValid: boolean;
  /** valid after the local defaults for omitted empty fields */
  lenientValid: boolean;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  ms: number;
  firstContentMs?: number;
  mode: "json_object" | "json_schema" | "text";
}

export interface GroqCortexOpts {
  client: GroqClient;
  model: string;
  fallback: CortexBackend;
  /** per HTTP call (default 6 s, like ClaudeCortex) */
  timeoutMs?: number;
  /** auto: json_schema for models that decode against it without spending prompt tokens, json_object otherwise */
  outputMode?: GroqOutputMode;
  maxCompletionTokens?: number;
  /** names to pseudonymize before the cloud call (PSEUDONYMIZE_PERSONS) */
  pseudonymNames?: () => string[];
  /** audit hook: a cloud call really left the machine (not called for calls the pacer refused) */
  onCloudCall?: (info: { model: string; redactions: number }) => void;
  /** diagnostics: how each model attempt turned out (no content) */
  onAttempt?: (a: GroqAttempt) => void;
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

/** The model's answer as JSON: tolerate a code fence or a sentence around the object. */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence?.[1]) s = fence[1];
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("no JSON object");
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** per artifact kind: the keys whose absence only means "empty" (null, [] or false). Everything else must come from the model. */
const EMPTY_DEFAULTS: Record<string, Obj> = {
  ticket: { labels: [], component: null, acceptance_criteria: [] },
  github_issue: { labels: [], hypotheses: [] },
  email_draft: {},
  message_draft: {},
  calendar_event: { start_iso: null, end_iso: null, time_expression: null, attendees: [], is_reschedule: false },
  code_snippet: { signature: null, needs_enrichment: false },
  code_comment: { target: null },
  decision: { chosen: null, rejected: [], rationale: null },
  note: { tags: [] },
  recall: { time_expression: null, activity: null, device: null, types: [], persons: [] },
};

/**
 * A small model sometimes leaves out a key whose value is empty. Fill those (and only those) with their empty value, so a
 * harmless omission does not cost a repair round trip. Required content (category, title, intent, artifact fields) is never
 * invented here: a missing one still fails validation and goes to the repair retry.
 */
export function withEmptyDefaults(json: unknown): unknown {
  if (!isObj(json)) return json;
  const out: Obj = { ...json };
  out.thread_relation ??= "continue";
  out.why ??= "";
  for (const k of ["references", "repairs", "open_questions", "entities", "salience_cues"]) if (out[k] == null) out[k] = [];
  out.concern_key ??= null;
  if (typeof out.confidence === "string" && Number.isFinite(Number(out.confidence))) out.confidence = Number(out.confidence);
  if (typeof out.artifact === "string") out.artifact = { kind: out.artifact };
  if (isObj(out.artifact)) {
    const art: Obj = { ...out.artifact };
    for (const [k, v] of Object.entries(EMPTY_DEFAULTS[String(art.kind)] ?? {})) if (art[k] == null) art[k] = v;
    if (art.kind === "email_draft" && typeof art.to === "string") art.to = [art.to];
    out.artifact = art;
  }
  return out;
}

const issueSummary = (err: { issues: Array<{ path: PropertyKey[]; code: string }> }): string =>
  [...new Set(err.issues.slice(0, 8).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.code}`))].slice(0, 6).join("; ");

export class GroqCortex implements CortexBackend {
  readonly name = "groq";
  private mode: "json_object" | "json_schema" | "text";
  private schemaFormat: { type: "json_schema"; schema: Record<string, unknown> } | undefined;
  private timeoutMs: number;
  private warned = new Set<string>();

  constructor(private opts: GroqCortexOpts) {
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.mode = resolveOutputMode(opts.model, opts.outputMode ?? "auto");
  }

  /** the output contract in force (it can fall back from json_schema to json_object at runtime) */
  get outputMode(): "json_object" | "json_schema" | "text" {
    return this.mode;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn("llm", msg);
  }

  /** Open the TLS connection before the first fragment. Costs no tokens and never throws. */
  async warm(): Promise<void> {
    try {
      const t0 = performance.now();
      const ok = await this.opts.client.ping();
      log.info("llm", "groq warmed", { model: this.opts.model, ok, ms: Math.round(performance.now() - t0) });
    } catch {
      /* the first real call will report it */
    }
  }

  analyze(input: CortexInput, onPartial?: PartialCallback): Promise<CortexOutput> {
    return this.run(input, onPartial);
  }

  private format(): GroqResponseFormat | undefined {
    if (this.mode === "text") return undefined;
    if (this.mode === "json_object") return { type: "json_object" };
    this.schemaFormat ??= buildOutputFormat(CortexResultSchema);
    return { type: "json_schema", name: "cortex_result", schema: this.schemaFormat.schema, strict: true };
  }

  private request(messages: GroqMessage[]): GroqRequest {
    const model = this.opts.model;
    return {
      model,
      messages,
      maxCompletionTokens: this.opts.maxCompletionTokens ?? 900,
      temperature: 0.2,
      reasoningEffort: model.startsWith("openai/") ? "low" : undefined,
      responseFormat: this.format(),
    };
  }

  private async run(input: CortexInput, onPartial: PartialCallback | undefined): Promise<CortexOutput> {
    const t0 = performance.now();
    const client = this.opts.client;
    const off = client.disabledReason;
    if (off === "auth") return this.degrade(input, "llm_disabled");
    if (off === "rate_limit") return this.degrade(input, "rate_limit");
    if (off === "network") return this.degrade(input, "network");

    // ---- redact everything that leaves the machine
    const rd = createRedactor({ pseudonymizeNames: this.opts.pseudonymNames?.() ?? [] });
    const safeInput: CortexInput = {
      ...input,
      // the speaker's and teammates' names too: with PSEUDONYMIZE_PERSONS on, no name may leave in the <user> line either
      user: { name: rd.text(input.user.name), role: rd.text(input.user.role), team: input.user.team.map((m) => ({ name: rd.text(m.name), role: rd.text(m.role) })) },
      fragments: input.fragments.map((f) => ({ ...f, text: rd.text(f.text) })),
      previous: input.previous ? mapStrings(input.previous, (s) => rd.text(s)) : null,
      lastCard: input.lastCard ? mapStrings(input.lastCard, (s) => rd.text(s)) : null,
      candidates: input.candidates.map((c) => ({ ...c, label: rd.text(c.label), snippet: rd.text(c.snippet) })),
      recent: input.recent.map((r) => ({ ...r, title: rd.text(r.title) })),
      vocabulary: input.vocabulary.map((v) => rd.text(v)),
    };
    const base: GroqMessage[] = [
      { role: "system", content: liteSystemPrompt() },
      { role: "user", content: renderLiteUserMessage(safeInput) },
    ];
    // time spent queueing for the token budget is not model time: it is kept out of `ms` and `firstFieldMs`
    let queued = 0;
    const onSend = (queuedMs: number): void => {
      queued += queuedMs;
      this.opts.onCloudCall?.({ model: this.opts.model, redactions: rd.count });
    };

    let firstFieldMs: number | undefined;
    let messages = base;
    let streamPreview = true;
    const usage = { prompt: 0, completion: 0, cached: 0 };

    for (let attempt = 0; attempt < 2; attempt++) {
      let lastSent = 0;
      let lastKey = "";
      const onDelta =
        onPartial && streamPreview
          ? (_d: string, soFar: string): void => {
              try {
                const now = performance.now();
                if (now - lastSent < 60) return;
                const parsed = parsePartialJson(soFar.replace(/^\s*```(?:json)?\s*/i, "")); // plain-text mode may open with a code fence
                if (!parsed || typeof parsed !== "object") return;
                const partial = rehydrate(parsed as Partial<CortexResult>, rd.map);
                const key = JSON.stringify([partial.category, partial.title, partial.intent, (partial.artifact as { kind?: string } | undefined)?.kind, JSON.stringify(partial.artifact ?? {}).length]);
                if (key === lastKey) return;
                lastKey = key;
                lastSent = now;
                if (firstFieldMs === undefined && (partial.category || partial.title)) firstFieldMs = now - t0 - queued;
                onPartial(partial);
              } catch {
                /* a preview is a courtesy: whatever goes wrong in it must never fail the call that is still generating the real answer */
              }
            }
          : undefined;

      let res: GroqResult;
      const mode = this.mode;
      try {
        res = await client.chat(this.request(messages), { stream: Boolean(onDelta), onDelta, timeoutMs: this.timeoutMs, onSend });
      } catch (err) {
        const e = err instanceof GroqError ? err : new GroqError("network", "unexpected error");
        if (!(err instanceof GroqError)) log.error("llm", `unexpected error in groq analyze: ${(err as Error)?.name ?? "error"}`); // the name only: a message can quote text
        // the API refused our strict schema: continue this very request once as a plain JSON object
        if (e.kind === "schema_rejected" && this.mode === "json_schema" && attempt === 0) {
          this.mode = "json_object";
          this.warnOnce("schema", "Groq rejected the strict output schema; continuing with json_object");
          continue;
        }
        // Groq's own JSON check failed on what the model wrote: one fresh attempt
        if (e.kind === "bad_output" && attempt === 0) continue;
        // pacing and cool-downs are routine; a dead socket or a server error deserves one line (kind and status, never content)
        if (e.kind === "network" || e.kind === "server") this.warnOnce(e.message, `groq call failed (${e.message}); using the local cortex for this card`);
        return this.degrade(input, reasonOf(e), t0);
      }

      usage.prompt += res.usage.promptTokens;
      usage.completion += res.usage.completionTokens;
      usage.cached += res.usage.cachedTokens;
      if (res.finishReason === "length") {
        this.report(attempt, mode, res, false, false, false);
        return this.degrade(input, "max_tokens", t0);
      }

      let json: unknown;
      let jsonValid = true;
      try {
        json = extractJson(res.text);
      } catch {
        jsonValid = false;
      }
      const strict = jsonValid ? CortexResultSchema.safeParse(json) : undefined;
      const lenient = jsonValid ? (strict?.success ? strict : CortexResultSchema.safeParse(withEmptyDefaults(json))) : undefined;
      this.report(attempt, mode, res, jsonValid, Boolean(strict?.success), Boolean(lenient?.success));

      if (lenient?.success) {
        return {
          result: rehydrate(relabelRevision(lenient.data, input.lastCard), rd.map),
          source: "llm",
          model: this.opts.model,
          usage: { inputTokens: usage.prompt, outputTokens: usage.completion, cacheReadTokens: usage.cached, cacheCreateTokens: 0 },
          ms: performance.now() - t0 - queued,
          firstFieldMs,
          redactions: rd.count,
        };
      }
      if (attempt === 1) break;
      // ONE repair round: show the model what is wrong with its own answer (paths and codes only, never content)
      const why = lenient ? issueSummary(lenient.error) : "the reply was not a single JSON object";
      log.warn("llm", "groq answer failed validation; one repair attempt", { issues: lenient ? lenient.error.issues.length : 0 });
      messages = [
        ...base,
        { role: "assistant", content: res.text.slice(0, 1800) },
        { role: "user", content: `That reply is not valid (${why}). Reply again with ONE corrected JSON object only: every key present, enums spelled exactly as listed, [] or null when empty.` },
      ];
      streamPreview = false;
    }
    return this.degrade(input, "bad_output", t0);
  }

  private report(attempt: number, mode: GroqAttempt["mode"], res: GroqResult, jsonValid: boolean, strictValid: boolean, lenientValid: boolean): void {
    this.opts.onAttempt?.({
      attempt,
      streamed: res.firstContentMs !== undefined,
      jsonValid,
      strictValid,
      lenientValid,
      finishReason: res.finishReason,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      reasoningTokens: res.usage.reasoningTokens,
      cachedTokens: res.usage.cachedTokens,
      ms: res.ms,
      firstContentMs: res.firstContentMs,
      mode,
    });
  }

  private async degrade(input: CortexInput, reason: string, t0 = performance.now()): Promise<CortexOutput> {
    const out = await this.opts.fallback.analyze(input);
    return { ...out, degraded: reason, ms: performance.now() - t0 };
  }
}

const CATEGORY_OF_KIND: Partial<Record<CortexResult["artifact"]["kind"], CortexResult["category"]>> = {
  ticket: "action", github_issue: "bug", email_draft: "communication", message_draft: "communication", calendar_event: "scheduling",
  code_snippet: "code", decision: "decision", note: "idea", journal: "journal", recall: "recall_query",
};

/**
 * Only a RETRACTION is category "correction", and a retraction has no artifact. A model that says "correction" and then writes a
 * whole card has revised that card, and the engine reads the category as a retraction and would delete the very card the speaker
 * meant to fix (measured: every model mislabelled "no wait, make it Monday" this way until the prompt was made explicit). Relabel
 * it as the card it revises, and say so with thread_relation.
 */
export function relabelRevision(r: CortexResult, lastCard: CortexInput["lastCard"]): CortexResult {
  if (r.category !== "correction" || r.artifact.kind === "none") return r;
  const target = lastCard && lastCard.result.category !== "correction" ? lastCard.result.category : CATEGORY_OF_KIND[r.artifact.kind];
  return target ? { ...r, category: target, thread_relation: "correction_of_previous" } : r;
}

/** Why a Groq call failed, as the short reason shown on a degraded card. */
export function reasonOf(e: GroqError): string {
  switch (e.kind) {
    case "auth":
      return "auth";
    case "rate_limit":
      return "rate_limit";
    case "paced":
      return "paced";
    case "daily_cap":
      return "daily_cap";
    case "too_large":
      return "too_large";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "truncated":
      return "truncated";
    case "bad_output":
      return "bad_output";
    case "schema_rejected":
    case "bad_request":
      return "bad_request";
    case "aborted":
      return "aborted";
    case "server":
      return `api_${e.status ?? 500}`;
    default:
      return "error";
  }
}

/**
 * How the cortex asks for JSON. `auto` is json_object for every model, measured on 18 mixed inputs per model: valid JSON 18/18
 * everywhere, and a single compact answer. The alternatives are opt-in (GROQ_OUTPUT_MODE):
 *  - json_schema: strict decoding against our schema, but gpt-oss renders the schema into the prompt (about 1.5k extra tokens per
 *    call, a third of a minute's budget), and Qwen aborted a streamed strict answer with a decoding error in a probe.
 *  - text: no response_format. The only mode in which Groq streams tokens as they are generated (a JSON mode arrives as ONE chunk
 *    after the reasoning), so cards type in; the cost is that Groq no longer guarantees JSON syntax (zod and the repair retry still
 *    do).
 */
export function resolveOutputMode(_model: string, mode: GroqOutputMode): "json_object" | "json_schema" | "text" {
  return mode === "auto" ? "json_object" : mode;
}
