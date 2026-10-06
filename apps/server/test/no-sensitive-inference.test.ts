import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CortexResultSchema } from "@synapse/shared";
import { EXAMPLE_OUTPUTS, systemPrompt } from "../src/cortex/prompts";

/**
 * PRV-12: "No sensitive inference: no emotion, health, relationship or other-speaker identification features anywhere
 * in the pipeline or schemas." A schema review made checkable: the persisted/wire schemas have no such field, the model's
 * output contract rejects/strips them, and the prompt keeps the prohibition.
 */

const root = path.resolve(import.meta.dirname, "../../..");
const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");

/** words that would indicate a sensitive attribute is being inferred, stored or transmitted */
const SENSITIVE = /\b(emotion\w*|sentiment|mood|feeling|health|diagnos\w*|disorder|voiceprint|speaker_?id|speaker_?embedding|gender|ethnic\w*|religio\w*|sexual\w*|biometric\w*|stress_?level|mental\w*)\b/i;

describe("no sensitive inference (PRV-12)", () => {
  it("no schema, storage or protocol file declares such a field", () => {
    const files = [
      "packages/shared/src/domain.ts",
      "packages/shared/src/protocol.ts",
      "apps/server/src/memory/types.ts",
      "apps/server/src/memory/db.ts",
      "apps/server/src/llm/schema.ts",
    ];
    for (const f of files) {
      const src = strip(fs.readFileSync(path.join(root, f), "utf8"));
      expect(src.length, f).toBeGreaterThan(500);
      expect(src, f).not.toMatch(SENSITIVE);
    }
  });

  it("the model's output contract has no place for them: extra attributes are stripped or rejected, never kept", () => {
    const valid = EXAMPLE_OUTPUTS[0]!;
    expect(CortexResultSchema.safeParse(valid).success).toBe(true);
    for (const extra of [{ emotion: "angry" }, { sentiment: "negative" }, { health: "tired" }, { speaker_id: "sarah" }, { mood: "low" }]) {
      const parsed = CortexResultSchema.safeParse({ ...valid, ...extra });
      if (parsed.success) for (const k of Object.keys(extra)) expect(parsed.data, k).not.toHaveProperty(k);
    }
  });

  it("the system prompt keeps the prohibition (so a prompt edit cannot silently drop it)", () => {
    const p = systemPrompt();
    expect(p).toMatch(/Do not infer emotions, health, mental state, relationships/);
    expect(p).toMatch(/Do not identify speakers/);
    expect(p).toMatch(/Speech addressed to another person/);
  });
});
