/**
 * Tolerant parser for a JSON document that is still streaming in. Used only to preview the card
 * while the model is generating; the final answer is always validated with zod.
 * Strategy: try the text as-is; otherwise close open strings/containers, trimming dangling
 * keys / commas / partial literals a few times until it parses.
 */
export function parsePartialJson(src: string): unknown | undefined {
  const s = src.trimStart();
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to repair */
  }
  let text = s;
  for (let attempt = 0; attempt < 6; attempt++) {
    const repaired = close(text);
    try {
      return JSON.parse(repaired);
    } catch {
      text = trimTail(text);
      if (!text) return undefined;
    }
  }
  return undefined;
}

function close(text: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = text;
  if (inStr) {
    if (esc) out = out.slice(0, -1); // dangling backslash
    out += '"';
  }
  // dangling `,` or a partial literal at the very end (a dangling `"key":` is dropped by trimTail)
  out = out.replace(/,\s*$/, "");
  out = out.replace(/\b(tru|fals|nul)$/, (m) => (m === "tru" ? "true" : m === "fals" ? "false" : "null"));
  return out + stack.reverse().join("");
}

/** Drop the last incomplete element: back up to the previous top-level comma, or the opener. */
function trimTail(text: string): string {
  let inStr = false;
  let esc = false;
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," ) cut = i;
  }
  if (cut > 0) return text.slice(0, cut);
  const brace = Math.max(text.lastIndexOf("{"), text.lastIndexOf("["));
  return brace > 0 ? text.slice(0, brace) : "";
}
