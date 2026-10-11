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
}

export interface BatchDraft {
  items: BatchItem[];
  model: string;
  ms: number;
  calls: number;
  redactions: number;
}

export class BatchDrafter {
  constructor(private o: BatchDrafterOpts) {}

  /** null: no usable answer (the caller falls back). Never throws. */
  async draft(input: BatchPromptInput): Promise<BatchDraft | null> {
    const { client, model } = this.o;
    if (client.disabledReasonFor(model)) return null;
    const t0 = performance.now();
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
    let calls = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        calls++;
        const res = await client.chat(
          { model, messages, maxCompletionTokens: 1600, temperature: 0.2, reasoningEffort: model.startsWith("openai/") ? "low" : undefined, responseFormat: { type: "json_object" } },
          { stream: false, timeoutMs: this.o.timeoutMs ?? 25_000, maxWaitMs: this.o.maxWaitMs, onSend: () => this.o.onCloudCall?.({ model, redactions: rd.count }) },
        );
        text = res.text;
      } catch (err) {
        const kind = err instanceof GroqError ? err.kind : "network";
        log.warn("batch", "capture draft call failed", { kind, attempt });
        return null; // paced / rate-limited / network: the per-thought path (and the re-draft queue) take over
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
        return { items, model, ms: Math.round(performance.now() - t0), calls, redactions: rd.count };
      }
      const issues = parsed.success ? "items: empty" : parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.code}`).join("; ");
      log.warn("batch", "capture draft did not validate", { attempt, issues: issues.length });
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
