import { z } from "zod";

/* ============================================================================
 * Structured-output JSON schema builder.
 *
 * Why not just zodOutputFormat()? The SDK's transformer keeps only a whitelist of keywords and
 * rewrites everything else, including `enum` and `const`, into the field's *description*
 * (verified on @anthropic-ai/sdk 0.131: category became {"type":"string","description":"{enum:[...]}"}).
 * That leaves `category` and the artifact `kind` discriminator unconstrained at decode time.
 * The API documents `enum`, `const`, `anyOf` and `$ref` as supported, so we keep them, and
 * normalise only what is genuinely unsupported:
 *   oneOf → anyOf · type:[X,"null"] → anyOf · additionalProperties:false · $schema/default dropped.
 * ClaudeCortex falls back to the SDK's own schema if the API ever rejects this one.
 * ========================================================================== */

type Json = Record<string, unknown>;

const DROP = new Set(["$schema", "default", "examples", "$id", "id", "readOnly", "writeOnly", "deprecated"]);

function norm(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(norm);
  const src = node as Json;
  const out: Json = {};

  // type: ["string","null"] → anyOf [{type:string}, {type:null}] (the sibling keywords stay on the non-null branch)
  if (Array.isArray(src.type)) {
    const types = src.type as string[];
    const rest: Json = { ...src };
    delete rest.type;
    const branches = types.map((t) => (t === "null" ? { type: "null" } : (norm({ ...rest, type: t }) as Json)));
    const desc = typeof src.description === "string" ? { description: src.description } : {};
    return { anyOf: branches, ...desc };
  }

  for (const [k, v] of Object.entries(src)) {
    if (DROP.has(k)) continue;
    if (k === "oneOf") {
      out.anyOf = (v as unknown[]).map(norm);
      continue;
    }
    if (k === "properties") {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, norm(pv)]));
      continue;
    }
    if (k === "additionalProperties") continue; // re-added below
    out[k] = norm(v);
  }
  if (out.type === "object" || out.properties) {
    out.additionalProperties = false;
    // structured outputs want every property listed as required (optionality is expressed with null)
    if (out.properties) out.required = Object.keys(out.properties as Json);
  }
  return out;
}

export interface OutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export function buildOutputFormat(schema: z.ZodType): OutputFormat {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output", reused: "inline", unrepresentable: "throw" });
  return { type: "json_schema", schema: norm(raw) as Record<string, unknown> };
}

/** Structural audit used by tests and the boot log: lists anything the API is documented NOT to support. */
export function auditSchema(schema: unknown): string[] {
  const problems: string[] = [];
  const BAD = ["oneOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "$ref", "$defs"];
  const walk = (n: unknown, path: string): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
    const o = n as Json;
    for (const k of BAD) if (k in o && !(k === "minItems" && (o[k] === 0 || o[k] === 1))) problems.push(`${path}: unsupported keyword "${k}"`);
    if (Array.isArray(o.type)) problems.push(`${path}: type array`);
    if (o.type === "object") {
      if (o.additionalProperties !== false) problems.push(`${path}: object without additionalProperties:false`);
      const props = Object.keys((o.properties as Json | undefined) ?? {});
      const req = (o.required as string[] | undefined) ?? [];
      if (props.some((p) => !req.includes(p))) problems.push(`${path}: properties missing from required`);
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(schema, "$");
  return problems;
}
