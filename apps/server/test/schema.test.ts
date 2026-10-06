import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CATEGORIES, CortexResultSchema, ARTIFACT_KINDS } from "@synapse/shared";
import { EXAMPLE_OUTPUTS, EXAMPLE_COUNT, systemPrompt } from "../src/cortex/prompts";
import { auditSchema, buildOutputFormat } from "../src/llm/schema";

describe("structured-output schema", () => {
  const fmt = buildOutputFormat(CortexResultSchema);
  const json = JSON.stringify(fmt.schema);

  it("keeps enums and const discriminators (the SDK helper does not)", () => {
    const sdk = JSON.stringify(zodOutputFormat(CortexResultSchema).schema);
    expect(sdk).not.toContain('"enum"'); // documents why we build our own
    for (const c of CATEGORIES) expect(json).toContain(`"${c}"`);
    expect(json).toContain('"enum"');
    expect(json).toContain('"const"');
    for (const k of ARTIFACT_KINDS) expect(json).toContain(`"${k}"`);
  });

  it("uses only constructs the API documents as supported", () => {
    expect(auditSchema(fmt.schema)).toEqual([]);
    expect(json).not.toContain("oneOf");
    expect(json).not.toContain('"type":["');
  });

  it("every few-shot example validates against the schema it teaches", () => {
    expect(EXAMPLE_COUNT).toBeGreaterThanOrEqual(15);
    for (const ex of EXAMPLE_OUTPUTS) expect(CortexResultSchema.safeParse(ex).success).toBe(true);
  });

  it("the static system prompt is large enough to be cached on Haiku 4.5 (≥ 4096 tokens)", () => {
    // conservative: 1 token ≈ 4 characters of English / JSON
    expect(systemPrompt().length / 4).toBeGreaterThan(4096);
    // and contains nothing volatile that would invalidate the cache
    expect(systemPrompt()).not.toMatch(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?!\+05:30)/);
  });
});
