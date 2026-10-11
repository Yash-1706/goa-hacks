import { z } from "zod";
import { ArtifactSchema, CategorySchema, EntityTypeSchema, LlmRepairSchema, type CortexResult } from "@synapse/shared";
import { log } from "../log";
import { createRedactor, rehydrate } from "../gate/redact";
import { batchSystemPrompt, renderBatchUserMessage, type BatchPromptInput } from "../cortex/prompts-batch";
import type { CortexOutput } from "../cortex/types";
import { GroqError, type GroqClient, type GroqMessage } from "./groq-client";
import { extractJson } from "./groq";

/* ============================================================================
 * One model call per capture (V1.1). Groq's free tier allows ~2-3 calls a minute; a ramble with three intents used to need
 * three. Here the whole transcript goes out ONCE (redacted), and every item comes back drafted. Validated with zod; one repair
 * round; otherwise null, and the capture falls back to the per-thought path.
 * ========================================================================== */

export const BatchItemSchema = z.object({
  said: z.string(),
  category: CategorySchema,
  title: z.string(),
  intent: z.string(),
  confidence: z.number(),
  artifact: ArtifactSchema,
  repairs: z.array(LlmRepairSchema),
  entities: z.array(z.object({ name: z.string(), type: EntityTypeSchema })),
  corrects: z.string().nullable(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;
export const BatchResultSchema = z.object({ items: z.array(BatchItemSchema).max(12) });

/** keys a small model leaves out when they are empty */
function withDefaults(json: unknown): unknown {
  if (!json || typeof json !== "object" || !Array.isArray((json as { items?: unknown }).items)) return json;
  return {
    items: (json as { items: Array<Record<string, unknown>> }).items.map((it) => ({
      repairs: [],
      entities: [],
      corrects: null,
      confidence: 0.8,
      intent: typeof it.title === "string" ? it.title : "",
      ...it,
      ...(it.category === "aside" && !it.artifact ? { artifact: { kind: "none" } } : {}),
    })),
  };
}

export interface BatchDrafterOpts {
  client: GroqClient;
  model: string;
  /** how long the call may queue for the free tier's token budget (the capture path is patient; the live mic is not) */
  maxWaitMs: number;
  timeoutMs?: number;
  pseudonymNames?: () => string[];
  onCloudCall?: (info: { model: string; redactions: number }) => void;
  /** injected clock and sleep (tests) */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** answer tokens per capture call. A smaller allowance sized to the transcript was tried live and truncated answers (the model's
 *  reasoning counts against it: Groq's json_validate_failed), so it stays at the ceiling. */
const ALLOWANCE = 1600;

export interface BatchDraft {
  items: BatchItem[];
  model: string;
  ms: number;
  calls: number;
  redactions: number;
  /** answer tokens asked for, and what the calls really used (counters only) */
  allowance: number;
  usage: { prompt: number; completion: number };
}

export class BatchDrafter {
  constructor(private o: BatchDrafterOpts) {}

  /** null: no usable answer (the caller falls back). Never throws. */
  async draft(input: BatchPromptInput): Promise<BatchDraft | null> {
    const { client, model } = this.o;
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // a 429 cool-down is worth waiting out (below); an auth or network failure is not
    const off = client.disabledReasonFor(model);
    if (off && off !== "rate_limit") return null;
    const t0 = performance.now();
    const deadline = now() + this.o.maxWaitMs;
    const rd = createRedactor({ pseudonymizeNames: this.o.pseudonymNames?.() ?? [] });
    const safe: BatchPromptInput = {
      ...input,
      user: { name: rd.text(input.user.name), team: input.user.team.map((n) => rd.text(n)) },
      recent: input.recent.map((r) => ({ ...r, title: rd.text(r.title) })),
      transcript: rd.text(input.transcript),
    };
    let messages: GroqMessage[] = [
      { role: "system", content: batchSystemPrompt() },
      { role: "user", content: renderBatchUserMessage(safe) },
    ];
    const allowance = ALLOWANCE;
    const usage = { prompt: 0, completion: 0 };
    let calls = 0;
    let waited = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        const res = await client.chat(
          { model, messages, maxCompletionTokens: allowance, temperature: 0.2, reasoningEffort: model.startsWith("openai/") ? "low" : undefined, responseFormat: { type: "json_object" } },
          { stream: false, timeoutMs: this.o.timeoutMs ?? 25_000, maxWaitMs: Math.max(0, deadline - now()), onSend: () => this.o.onCloudCall?.({ model, redactions: rd.count }) },
        );
        calls++;
        usage.prompt += res.usage.promptTokens ?? 0;
        usage.completion += res.usage.completionTokens ?? 0;
        text = res.text;
      } catch (err) {
        const kind = err instanceof GroqError ? err.kind : "network";
        if (err instanceof GroqError && err.status !== undefined) calls++; // the server answered (a local refusal sent nothing)
        // Groq said "try again in N s" (or this model is still cooling from that): wait once, if the capture can afford it
        const retryAfter = err instanceof GroqError && kind === "rate_limit" ? (err.retryAfterMs ?? 0) : 0;
        if (!waited && retryAfter > 0 && now() + retryAfter + 250 <= deadline) {
          waited = true;
          log.info("batch", "rate limited: waiting, then the same call again", { waitMs: retryAfter + 250, attempt });
          await sleep(retryAfter + 250);
          attempt--;
          continue;
        }
        // Groq refused the answer as invalid JSON (usually cut off): the second attempt asks again, like an answer that did not validate
        if (kind === "bad_output" && attempt === 0) {
          log.warn("batch", "capture draft was not valid JSON: asking again", { attempt });
          continue;
        }
        log.warn("batch", "capture draft call failed", { kind, attempt });
        return null; // paced / rate-limited past the capture's patience / network: the per-thought path takes over
      }
      let json: unknown;
      try {
        json = withDefaults(extractJson(text));
      } catch {
        json = null;
      }
      const parsed = BatchResultSchema.safeParse(json);
      if (parsed.success && parsed.data.items.length) {
        const items = rehydrate(parsed.data.items, rd.map);
        return { items, model, ms: Math.round(performance.now() - t0), calls, redactions: rd.count, allowance, usage };
      }
      const issues = parsed.success ? "items: empty" : parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.code}`).join("; ");
      // schema paths and zod codes only ("items.1.artifact.kind: invalid_union"), never the answer's text
      log.warn("batch", "capture draft did not validate", { attempt, issues });
      messages = [...messages, { role: "assistant", content: text.slice(0, 6000) }, { role: "user", content: `That did not validate (${issues}). Reply with the corrected JSON only.` }];
    }
    return null;
  }
}

/** A batch item as the engine's result for its one-fragment thread (applied without another model call). */
export function itemToOutput(it: BatchItem, d: Pick<BatchDraft, "model" | "ms" | "redactions">): CortexOutput {
  const result: CortexResult = {
    thread_relation: it.corrects ? "correction_of_previous" : "new_thought",
    category: it.category,
    confidence: Math.max(0, Math.min(1, it.confidence)),
    title: it.title,
    intent: it.intent || it.title,
    why: it.corrects ? `Revises ${it.corrects}.` : "",
    references: it.corrects ? [{ mention: "it", resolved_id: it.corrects, label: "", confidence: 0.9 }] : [],
    repairs: it.repairs,
    open_questions: [],
    entities: it.entities.map((e) => ({ ...e, candidate_id: null })),
    salience_cues: it.artifact.kind === "reminder" && it.artifact.due_iso ? ["deadline"] : [],
    concern_key: null,
    artifact: it.category === "aside" ? { kind: "none" } : it.artifact,
  };
  return { result, source: "llm", model: d.model, ms: d.ms, redactions: d.redactions };
}
