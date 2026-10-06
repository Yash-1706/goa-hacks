import { describe, expect, it } from "vitest";
import { tokenize } from "./highlight";

const kinds = (code: string, lang = "ts") => tokenize(code, lang).map((t) => `${t.kind}:${t.text}`);

describe("tokenize", () => {
  it("recognises keywords, types, calls, numbers and strings", () => {
    const out = kinds("const memo = new Map<number, number>(); return fib(10) + 'x';");
    expect(out).toContain("keyword:const");
    expect(out).toContain("keyword:new");
    expect(out).toContain("type:Map");
    expect(out).toContain("call:fib");
    expect(out).toContain("number:10");
    expect(out).toContain("string:'x'");
  });

  it("handles line and block comments per language", () => {
    expect(kinds("a // hi\nb")).toContain("comment:// hi");
    expect(kinds("a /* x */ b")).toContain("comment:/* x */");
    expect(kinds("x = 1  # note", "python")).toContain("comment:# note");
    expect(kinds("select 1 -- why", "sql")).toContain("comment:-- why");
  });

  it("does not turn # into a comment in C-style languages, and survives unterminated strings", () => {
    expect(tokenize("let a = '#x'", "ts").some((t) => t.kind === "comment")).toBe(false);
    expect(() => tokenize("const s = 'never closed\nnext", "ts")).not.toThrow();
    expect(() => tokenize("/* never closed", "ts")).not.toThrow();
  });

  it("reproduces the input exactly (lossless)", () => {
    const code = "function solve(n: number): number {\n  const x = [0, 1];\n  return x[n]; // done\n}\n";
    expect(tokenize(code, "typescript").map((t) => t.text).join("")).toBe(code);
  });
});
