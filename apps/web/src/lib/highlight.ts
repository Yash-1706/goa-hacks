/* ============================================================================
 * A tiny, dependency-free syntax highlighter for the code snippet cards. It is a lexer, not a parser:
 * comments, strings, numbers, keywords and calls cover what a 10-line snippet needs to look right.
 * Output is a flat token list the React component renders as <span class="tk-…">; nothing is injected as HTML.
 * ========================================================================== */

export type TokenKind = "comment" | "string" | "number" | "keyword" | "type" | "call" | "punct" | "plain";
export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default defer del delete do elif else enum except export extends " +
    "False finally fn for from func function go if impl import in instanceof interface is lambda let loop match mod mut new None not null " +
    "of or package pass pub raise return self static struct super switch this throw trait True try type typeof undefined unsafe use var " +
    "void while with yield and nil true false select where val fun when then end begin"
  ).split(/\s+/),
);

const TYPES = new Set("string number boolean int float double long bool str list dict set tuple map Map Set Array Promise Record any unknown never void u8 u32 u64 i32 i64 usize String Vec Option Result".split(/\s+/));

const COMMENT_STYLE: Record<string, "slash" | "hash" | "dash" | "both"> = {
  python: "hash",
  py: "hash",
  ruby: "hash",
  rb: "hash",
  bash: "hash",
  sh: "hash",
  shell: "hash",
  yaml: "hash",
  yml: "hash",
  toml: "hash",
  sql: "dash",
  lua: "dash",
  haskell: "dash",
};

export function tokenize(code: string, language = ""): Token[] {
  const style = COMMENT_STYLE[language.toLowerCase()] ?? "slash";
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, text: string): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  while (i < code.length) {
    const ch = code[i] as string;
    const two = code.slice(i, i + 2);

    if ((style === "slash" && two === "//") || (style === "hash" && ch === "#") || (style === "dash" && two === "--")) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (style === "slash" && two === "/*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && !(code[j] === "\n" && ch !== "`")) {
        if (code[j] === "\\") j++;
        j++;
      }
      push("string", code.slice(i, Math.min(code.length, j + 1)));
      i = Math.min(code.length, j + 1);
      continue;
    }
    if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(code[i - 1] ?? "")) {
      const m = /^(0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/.exec(code.slice(i));
      if (m) {
        push("number", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i)) as RegExpExecArray;
      const word = m[0];
      const next = code[i + word.length];
      if (KEYWORDS.has(word)) push("keyword", word);
      else if (TYPES.has(word) || /^[A-Z][a-z0-9]+[A-Za-z0-9]*$/.test(word)) push("type", word);
      else if (next === "(") push("call", word);
      else push("plain", word);
      i += word.length;
      continue;
    }
    if (/[{}()[\];,.:<>=+\-*/%&|!?^~@]/.test(ch)) {
      push("punct", ch);
      i++;
      continue;
    }
    push("plain", ch);
    i++;
  }
  return out;
}
