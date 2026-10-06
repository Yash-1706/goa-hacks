import type { ClientConfig } from "@synapse/shared";

/* Which cloud model the server is using for the live cortex, for UI copy. The server reports `llmProvider` / `llmModel`
 * in the welcome config (absent while mock or local-only, and from servers that predate the field); the copy then says
 * "Claude", which is the default provider. */

export interface LlmLabel {
  /** "Claude" or "Groq" */
  provider: string;
  /** the model id the server reported, e.g. "openai/gpt-oss-20b" */
  model?: string;
  /** the id without its vendor prefix, for tight spaces: "gpt-oss-20b" */
  shortModel?: string;
  /** "Groq · openai/gpt-oss-20b", or just "Claude" when the model is unknown */
  full: string;
}

type Provided = Pick<ClientConfig, "llmProvider" | "llmModel"> | null | undefined;

export function llmLabel(cfg: Provided): LlmLabel {
  const provider = cfg?.llmProvider === "groq" ? "Groq" : "Claude";
  const model = cfg?.llmModel?.trim() || undefined;
  const shortModel = model ? (model.split("/").pop() ?? model) : undefined;
  return { provider, model, shortModel, full: model ? `${provider} · ${model}` : provider };
}
