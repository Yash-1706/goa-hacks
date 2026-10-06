import { describe, expect, it } from "vitest";
import { isSafeUrl, parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("handles code, bold and italics", () => {
    expect(parseInline("a `b` **c** *d*")).toEqual([
      { t: "text", v: "a " },
      { t: "code", v: "b" },
      { t: "text", v: " " },
      { t: "b", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "i", c: [{ t: "text", v: "d" }] },
    ]);
  });

  it("does not italicise snake_case words", () => {
    expect(parseInline("call apply_discount_code now")).toEqual([{ t: "text", v: "call apply_discount_code now" }]);
  });

  it("keeps unmatched markers literal (partial, still-streaming text)", () => {
    expect(parseInline("a **bold that never closes")).toEqual([{ t: "text", v: "a **bold that never closes" }]);
    expect(parseInline("half `code")).toEqual([{ t: "text", v: "half `code" }]);
  });

  it("only links http(s) and mailto", () => {
    expect(parseInline("[ok](https://example.com)")).toEqual([{ t: "a", href: "https://example.com", c: [{ t: "text", v: "ok" }] }]);
    expect(parseInline("[bad](javascript:alert(1))")).toEqual([{ t: "text", v: "[bad](javascript:alert(1))" }]);
    expect(isSafeUrl("mailto:a@b.co")).toBe(true);
    expect(isSafeUrl("data:text/html;base64,AAAA")).toBe(false);
  });

  it("turns newlines into breaks", () => {
    expect(parseInline("a\nb")).toEqual([{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings, lists, task lists, quotes and rules", () => {
    const blocks = parseMarkdown(["# Title", "", "## Steps", "- one", "- [ ] two", "- [x] three", "", "1. first", "2. second", "", "> quoted", "", "---"].join("\n"));
    expect(blocks.map((b) => b.t)).toEqual(["h", "h", "ul", "ol", "quote", "hr"]);
    const ul = blocks[2];
    expect(ul?.t === "ul" && ul.items.map((i) => i.checked)).toEqual([undefined, false, true]);
    expect(blocks[0]).toMatchObject({ t: "h", level: 1 });
    expect(blocks[1]).toMatchObject({ t: "h", level: 2 });
  });

  it("parses fenced code with a language, including an unclosed fence that is still streaming", () => {
    const closed = parseMarkdown("```ts\nconst a = 1;\n```\nafter");
    expect(closed[0]).toEqual({ t: "code", lang: "ts", v: "const a = 1;" });
    expect(closed[1]?.t).toBe("p");
    const open = parseMarkdown("```py\nprint('hi')");
    expect(open[0]).toEqual({ t: "code", lang: "py", v: "print('hi')" });
  });

  it("joins consecutive lines into one paragraph and splits on blank lines", () => {
    const blocks = parseMarkdown("line one\nline two\n\nsecond paragraph");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ t: "p" });
  });

  it("never loops on odd input and handles an empty string", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n   \n")).toEqual([]);
    expect(parseMarkdown("#nospace").map((b) => b.t)).toEqual(["p"]);
    expect(parseMarkdown("- \n- x").length).toBeGreaterThan(0);
  });

  it("does not execute or pass through HTML: it stays text", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks).toEqual([{ t: "p", c: [{ t: "text", v: "<script>alert(1)</script>" }] }]);
  });
});
