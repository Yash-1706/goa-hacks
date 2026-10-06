import type { Category, EdgeType, EntityType, GraphNode, GraphNodeKind } from "@synapse/shared";
import { CATEGORY_META, EDGE_STYLE } from "./category";
import { lifeLeft } from "./format";

/* ============================================================================
 * Knowledge-graph styling decisions. Pure: no canvas, no DOM. The renderer (components/graph/render.ts)
 * only turns these decisions into pixels, so the rules that matter (what fades, what is solid, how big,
 * which colour) are unit-tested here.
 * ========================================================================== */

export type NodeShape = "ring" | "dot" | "square" | "diamond" | "glyph" | "loop";

export function nodeShape(kind: GraphNodeKind): NodeShape {
  switch (kind) {
    case "session":
      return "ring";
    case "entity":
      return "square";
    case "decision":
      return "diamond";
    case "artifact":
      return "glyph";
    case "open_loop":
      return "loop";
    default:
      return "dot";
  }
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ------------------------------------------------------------------ colours --

/** HSL (h in degrees, s/l in percent) to "#rrggbb". */
export function hslToHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = clamp01(s / 100);
  const ll = clamp01(l / 100);
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hex = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${hex(f(hh + 1 / 3))}${hex(f(hh))}${hex(f(hh - 1 / 3))}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [148, 163, 184];
  return [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16)];
}

const alphaCache = new Map<string, string>();
/** "#rrggbb" + alpha → "rgba(r,g,b,a)". Alpha is quantised to 1/50 so the cache (and canvas stroke batching) stays small. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(clamp01(alpha) * 50) / 50;
  const key = `${hex}|${a}`;
  let out = alphaCache.get(key);
  if (!out) {
    const [r, g, b] = hexToRgb(hex);
    out = `rgba(${r},${g},${b},${a})`;
    alphaCache.set(key, out);
  }
  return out;
}

/** Evenly spread hues for any number of sessions (golden angle), starting at the brand violet. */
export function sessionColorAt(index: number): string {
  const hue = (268 + index * 137.508) % 360;
  const l = [67, 61, 71][index % 3] as number;
  const s = [84, 80, 76][(index + 1) % 3] as number;
  return hslToHex(hue, s, l);
}

/**
 * Stable colour per session: assigned once, in creation order, and never reassigned while the page lives,
 * so a session keeps its colour when others appear, disappear or the time scrubber hides it.
 */
export class SessionColors {
  private readonly map = new Map<string, string>();
  private next = 0;

  assign(sessions: ReadonlyArray<{ id: string; createdAt: number }>): void {
    const fresh = sessions.filter((s) => !this.map.has(s.id));
    if (!fresh.length) return;
    fresh.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    for (const s of fresh) this.map.set(s.id, sessionColorAt(this.next++));
  }

  get(id: string | undefined): string {
    return (id ? this.map.get(id) : undefined) ?? "#94a3b8";
  }

  has(id: string): boolean {
    return this.map.has(id);
  }
}

export const ENTITY_COLORS: Record<EntityType, string> = {
  person: "#f9a8d4",
  project: "#c4b5fd",
  component: "#7dd3fc",
  technology: "#5eead4",
  bug: "#fda4af",
  event: "#fcd34d",
  place: "#86efac",
  topic: "#cbd5e1",
  org: "#fdba74",
};

export const entityColor = (t: EntityType | undefined): string => (t ? ENTITY_COLORS[t] : undefined) ?? ENTITY_COLORS.topic;

export const categoryHex = (c: Category | undefined): string => (c ? CATEGORY_META[c]?.color : undefined) ?? CATEGORY_META.idea.color;

/** Base colour of a node (sessions are coloured by the caller through `SessionColors`). */
export function nodeColor(n: Pick<GraphNode, "kind" | "category" | "entityType">, sessionColor?: string, tint?: Category): string {
  switch (n.kind) {
    case "session":
      return sessionColor ?? "#94a3b8";
    case "entity":
      return entityColor(n.entityType);
    case "artifact":
      return categoryHex(tint);
    case "open_loop":
      return categoryHex("question");
    default:
      return categoryHex(n.category);
  }
}

// -------------------------------------------------------------------- sizes --

const sal = (n: Pick<GraphNode, "salience">): number => clamp01(n.salience ?? 0.3);

/**
 * Visual radius in graph units (what collisions and label offsets use). Sessions are big rings, entities
 * are rounded squares sized by salience (the value is their half-diagonal), thoughts are dots whose size
 * follows salience, artifacts are small.
 */
export function nodeRadius(n: Pick<GraphNode, "kind" | "salience">, o: { sessionThoughts?: number } = {}): number {
  switch (n.kind) {
    case "session":
      return 15 + Math.min(7, Math.sqrt(Math.max(0, o.sessionThoughts ?? 0)) * 1.5);
    case "entity":
      return entityHalfSide(n) * 1.25;
    case "decision":
      return 5.8 + 3.4 * sal(n);
    case "artifact":
      return 5.4;
    case "open_loop":
      return 5.4;
    default:
      return 4.2 + 3.8 * sal(n);
  }
}

/** Entities: half the side of the rounded square (so the square is 2× this). */
export function entityHalfSide(n: Pick<GraphNode, "salience">): number {
  return 5.2 + 6.4 * Math.sqrt(sal(n));
}

// ---------------------------------------------------------------------- TTL --

/** Lowest opacity a working-memory node fades to (so it never vanishes before the server forgets it). */
export const TTL_FLOOR = 0.22;

/** Solid: sessions, promoted nodes and anything without an expiry. */
export function isLongTerm(n: Pick<GraphNode, "kind" | "promoted" | "expiresAt">): boolean {
  return n.kind === "session" || n.promoted === true || n.expiresAt === null || n.expiresAt === undefined;
}

/** Fraction of working-memory life left (1 fresh → 0 about to be forgotten); null for long-term nodes. */
export function ttlFraction(n: Pick<GraphNode, "kind" | "promoted" | "expiresAt" | "createdAt">, now: number): number | null {
  if (isLongTerm(n)) return null;
  return lifeLeft(n.expiresAt, n.createdAt, now);
}

/** Opacity from remaining life: working memory fades from 1 towards TTL_FLOOR, long-term is solid. */
export function ttlOpacity(n: Pick<GraphNode, "kind" | "promoted" | "expiresAt" | "createdAt">, now: number): number {
  const life = ttlFraction(n, now);
  return life === null ? 1 : TTL_FLOOR + (1 - TTL_FLOOR) * life;
}

// -------------------------------------------------------------------- edges --

export interface EdgeVisual {
  color: string;
  /** px (the renderer divides by zoom) */
  width: number;
  dash: number[];
  semantic: boolean;
  label: string;
  /** particles flow along it */
  flow: boolean;
}

const FALLBACK_EDGE = { color: "rgba(148,163,184,0.3)", dash: [] as number[], label: "linked", semantic: false };

export function isSemanticEdge(type: EdgeType | string): boolean {
  return Boolean(EDGE_STYLE[type]?.semantic);
}

export function edgeVisual(type: EdgeType | string, weight = 1): EdgeVisual {
  const s = EDGE_STYLE[type] ?? FALLBACK_EDGE;
  const w = clamp01(weight);
  let width = 0.9;
  if (s.semantic) width = 1.5 + 1.3 * w;
  else if (type === "produced") width = 1.1;
  else if (type === "in_session") width = 0.9;
  return { color: s.color, width, dash: s.dash, semantic: s.semantic, label: s.label, flow: s.semantic };
}

/** "same topic · 99%" for the hover pill. Weighted semantic edges carry a similarity, the rest do not. */
export function edgeCaption(type: EdgeType | string, weight: number): string {
  const label = (EDGE_STYLE[type] ?? FALLBACK_EDGE).label;
  return isSemanticEdge(type) && weight > 0 && weight <= 1 ? `${label} · ${Math.round(weight * 100)}%` : label;
}

/** Semantic edges that point from a to b should flow a → b; contradicts has no direction worth animating. */
export function particleCount(type: EdgeType | string, weight: number): number {
  if (!isSemanticEdge(type)) return 0;
  return weight >= 0.8 ? 3 : weight >= 0.5 ? 2 : 1;
}

// ------------------------------------------------------------------ quality --

export interface Quality {
  level: "high" | "medium" | "low";
  /** soft halo sprites behind every node (otherwise only sessions / selected / hovered / new) */
  halos: boolean;
  /** real canvas shadowBlur for the few hero nodes (sessions, selection) */
  heroGlow: boolean;
  particles: boolean;
  /** idle drift force (the graph slowly breathes) */
  drift: boolean;
  /** TTL arcs around working-memory dots */
  arcs: boolean;
  /** how many labels may be placed per frame */
  maxLabels: number;
  /** collision force */
  collide: boolean;
}

/**
 * Rendering budget by graph size. 500 nodes must stay smooth, so the expensive effects fall away first:
 * per-node halos (cheap sprites, but 500 of them add up), then particles, then drift.
 * `degrade` (0..2) lowers the tier further when measured frames are slow.
 */
export function qualityFor(nodeCount: number, o: { reduced?: boolean; coarse?: boolean; degrade?: number } = {}): Quality {
  let tier = nodeCount <= 170 ? 0 : nodeCount <= 360 ? 1 : 2;
  if (o.coarse) tier += 1;
  tier = Math.min(2, tier + (o.degrade ?? 0));
  const reduced = Boolean(o.reduced);
  const level = tier === 0 ? "high" : tier === 1 ? "medium" : "low";
  return {
    level,
    halos: tier <= 1,
    heroGlow: tier <= 1,
    particles: !reduced && tier <= 1,
    drift: !reduced && tier <= 1,
    arcs: tier <= 1,
    maxLabels: tier === 0 ? 90 : tier === 1 ? 60 : 34,
    collide: nodeCount <= 700,
  };
}

// ---------------------------------------------------------------- animation --

export const easeOutCubic = (x: number): number => 1 - (1 - clamp01(x)) ** 3;

/** Overshooting ease for the pop-in (0 → 1.0 with a ~10% overshoot). */
export function easeOutBack(x0: number): number {
  const x = clamp01(x0);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

/** Pop-in scale for a node born `age` ms ago (age < 0 → not yet born). */
export function popScale(age: number, duration = 560): number {
  if (age <= 0) return 0;
  if (age >= duration) return 1;
  return easeOutBack(age / duration);
}

/** 1 → 0 over `duration` after `age` 0, for rings and sparks that fade as they expand. */
export function burstProgress(age: number, duration = 900): number {
  if (age < 0 || age >= duration) return -1;
  return age / duration;
}
