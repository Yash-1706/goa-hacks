import { describe, expect, it } from "vitest";
import { parsePartialJson } from "../src/llm/partial-json";

describe("partial JSON", () => {
  const full = JSON.stringify({
    thread_relation: "continue",
    category: "bug",
    confidence: 0.9,
    title: "NPE in cart-service",
    entities: [{ name: "cart-service", type: "component", candidate_id: null }],
    artifact: { kind: "github_issue", title: "NPE", labels: ["bug", "cart"] },
  });

  it("parses complete JSON untouched", () => {
    expect(parsePartialJson(full)).toEqual(JSON.parse(full));
  });

  it("recovers every prefix without throwing and never returns garbage types", () => {
    let last: Record<string, unknown> = {};
    for (let i = 1; i <= full.length; i++) {
      const p = parsePartialJson(full.slice(0, i));
      if (p && typeof p === "object") {
        last = p as Record<string, unknown>;
        // monotonic: once a top-level scalar is known with a full value it stays valid JSON
        if ("category" in last) expect(typeof last.category).toBe("string");
      }
    }
    expect(last).toEqual(JSON.parse(full));
  });

  it("exposes early fields while later ones are still streaming", () => {
    const cut = full.indexOf('"entities"') + 4;
    const p = parsePartialJson(full.slice(0, cut)) as Record<string, unknown>;
    expect(p.category).toBe("bug");
    expect(p.title).toBe("NPE in cart-service");
  });

  it("handles a string cut mid-word and dangling keys", () => {
    expect((parsePartialJson('{"title":"NPE in car') as { title: string }).title).toBe("NPE in car");
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"b":')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"b":tru')).toEqual({ a: 1, b: true });
    expect(parsePartialJson("not json")).toBeUndefined();
  });
});
