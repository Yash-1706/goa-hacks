/* ============================================================================
 * A deliberately small markdown parser for GitHub-issue bodies (no HTML, no deps).
 * Output is a plain tree that React renders node by node, so nothing is ever injected as HTML.
 * It tolerates PARTIAL input (the body streams in token by token): unclosed code fences run to the end,
 * unmatched emphasis markers stay literal.
 * ========================================================================== */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Array<{ checked?: boolean; c: Inline[] }> }
  | { t: "ol"; items: Array<{ c: Inline[] }> }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
export const isSafeUrl = (u: string): boolean => SAFE_URL.test(u);

const isWord = (ch: string | undefined): boolean => Boolean(ch && /[A-Za-z0-9]/.test(ch));

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;
  const flush = (): void => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === "`") {
      const j = src.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    } else if (ch === "*" && src[i + 1] === "*") {
      const j = src.indexOf("**", i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(src.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      const j = src.indexOf(ch, i + 1);
      const prev = src[i - 1];
      const inner = src.slice(i + 1, j);
      const ok =
        j > i + 1 &&
        inner.trim() === inner &&
        !isWord(prev) &&
        (ch === "*" || !isWord(src[j + 1])) &&
        !inner.includes("\n");
      if (ok) {
        flush();
        out.push({ t: "i", c: parseInline(inner) });
        i = j + 1;
        continue;
      }
    } else if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m && isSafeUrl(m[2] as string)) {
        flush();
        out.push({ t: "a", href: m[2] as string, c: parseInline(m[1] as string) });
        i += m[0].length;
        continue;
      }
    } else if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const RE = {
  fence: /^\s*```\s*([\w+-]*)\s*$/,
  heading: /^(#{1,4})\s+(.*?)\s*#*\s*$/,
  hr: /^\s*([-*_])(?:\s*\1){2,}\s*$/,
  ul: /^\s*[-*+]\s+(.*)$/,
  ol: /^\s*\d+[.)]\s+(.*)$/,
  quote: /^\s*>\s?(.*)$/,
  task: /^\[( |x|X)\]\s+(.*)$/,
};

const startsBlock = (line: string): boolean =>
  RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.ul.test(line) || RE.ol.test(line) || RE.quote.test(line);

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = RE.fence.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) body.push(lines[i++] as string);
      i++; // closing fence (or end of a still-streaming block)
      blocks.push({ t: "code", lang: fence[1] ?? "", v: body.join("\n") });
      continue;
    }
    const h = RE.heading.exec(line);
    if (h) {
      blocks.push({ t: "h", level: Math.min(4, (h[1] as string).length) as 1 | 2 | 3 | 4, c: parseInline(h[2] as string) });
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (RE.ul.test(line)) {
      const items: Array<{ checked?: boolean; c: Inline[] }> = [];
      while (i < lines.length && RE.ul.test(lines[i] as string)) {
        const body = (RE.ul.exec(lines[i] as string) as RegExpExecArray)[1] as string;
        const task = RE.task.exec(body);
        items.push(task ? { checked: task[1] !== " ", c: parseInline(task[2] as string) } : { c: parseInline(body) });
        i++;
      }
      blocks.push({ t: "ul", items });
      continue;
    }
    if (RE.ol.test(line)) {
      const items: Array<{ c: Inline[] }> = [];
      while (i < lines.length && RE.ol.test(lines[i] as string)) {
        items.push({ c: parseInline((RE.ol.exec(lines[i] as string) as RegExpExecArray)[1] as string) });
        i++;
      }
      blocks.push({ t: "ol", items });
      continue;
    }
    if (RE.quote.test(line)) {
      const body: string[] = [];
      while (i < lines.length && RE.quote.test(lines[i] as string)) body.push((RE.quote.exec(lines[i] as string) as RegExpExecArray)[1] as string), i++;
      blocks.push({ t: "quote", c: parseInline(body.join("\n")) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !startsBlock(lines[i] as string)) para.push(lines[i++] as string);
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    else i++; // safety: never loop forever
  }
  return blocks;
}
