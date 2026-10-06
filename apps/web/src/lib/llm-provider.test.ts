import { describe, expect, it } from "vitest";
import { llmLabel } from "./llm-provider";

describe("llmLabel", () => {
  it("names Groq and its model when the server says so", () => {
    expect(llmLabel({ llmProvider: "groq", llmModel: "openai/gpt-oss-20b" })).toEqual({
      provider: "Groq",
      model: "openai/gpt-oss-20b",
      shortModel: "gpt-oss-20b",
      full: "Groq · openai/gpt-oss-20b",
    });
  });

  it("names Claude for the Anthropic provider", () => {
    expect(llmLabel({ llmProvider: "anthropic", llmModel: "claude-haiku-4-5" })).toMatchObject({ provider: "Claude", shortModel: "claude-haiku-4-5", full: "Claude · claude-haiku-4-5" });
  });

  it("falls back to Claude when the server does not report a provider (mock, local-only, an older server)", () => {
    expect(llmLabel(undefined)).toEqual({ provider: "Claude", model: undefined, shortModel: undefined, full: "Claude" });
    expect(llmLabel(null).provider).toBe("Claude");
    expect(llmLabel({}).provider).toBe("Claude");
    expect(llmLabel({ llmModel: "  " }).model).toBeUndefined();
  });

  it("keeps a model id without a vendor prefix whole", () => {
    expect(llmLabel({ llmProvider: "groq", llmModel: "allam-2-7b" }).shortModel).toBe("allam-2-7b");
  });
});
