import type { EdgeType, GraphNodeKind } from "@synapse/shared";

/* ============================================================================
 * Layout helpers. Pure and deterministic (no Math.random): the same graph always seeds the same way, so
 * a reload looks like the same constellation instead of a fresh explosion.
 * ========================================================================== */

/** Deterministic hash of a string to [0, 1). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface Pt {
  x: number;
  y: number;
}

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function centroid(points: readonly Pt[]): Pt {
  if (!points.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/**
 * Where to drop a new session: on a ring around the existing constellation, in the largest angular gap
 * between the sessions already placed, so sessions start evenly spread and never on top of each other.
 */
export function seedSession(placed: readonly Pt[], id: string, total: number): Pt {
  const ring = 150 + 38 * Math.sqrt(Math.max(1, total));
  if (placed.length === 0) {
    const a = hash01(id, 1) * Math.PI * 2;
    return { x: Math.cos(a) * ring * 0.25, y: Math.sin(a) * ring * 0.25 };
  }
  const c = centroid(placed);
  const angles = placed.map((p) => Math.atan2(p.y - c.y, p.x - c.x)).sort((a, b) => a - b);
  let bestGap = -1;
  let bestMid = 0;
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i] as number;
    const b = i + 1 < angles.length ? (angles[i + 1] as number) : (angles[0] as number) + Math.PI * 2;
    const gap = b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = a + gap / 2;
    }
  }
  const wobble = (hash01(id, 2) - 0.5) * 0.35;
  const r = ring * (0.9 + hash01(id, 3) * 0.25);
  return { x: c.x + Math.cos(bestMid + wobble) * r, y: c.y + Math.sin(bestMid + wobble) * r };
}

/** A point on a jittered ring around `base`, in a stable direction for this id. */
export function scatterNear(base: Pt, id: string, minR: number, maxR: number): Pt {
  const a = hash01(id, 4) * Math.PI * 2;
  const r = minR + hash01(id, 5) * (maxR - minR);
  return { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r };
}

// -------------------------------------------------------------- force tuning --

/** Repulsion by node kind (negative = push apart). Sessions repel hard so clusters keep their territory. */
export function chargeFor(kind: GraphNodeKind): number {
  switch (kind) {
    case "session":
      return -460;
    case "entity":
      return -150;
    case "decision":
    case "thought":
      return -62;
    case "open_loop":
      return -40;
    default:
      return -20;
  }
}

/** Rest length of a link. Artifacts hug their thought, entities float out between sessions. */
export function linkDistanceFor(type: EdgeType | string): number {
  switch (type) {
    case "in_session":
      return 54;
    case "produced":
      return 22;
    case "mentions":
      return 104;
    case "related":
      return 120;
    default:
      return 128; // semantic edges: long and loose, they connect clusters without collapsing them
  }
}

/** Spring stiffness of a link. Mentions and semantic links are weak so entities and sessions can float. */
export function linkStrengthFor(type: EdgeType | string, weight = 1): number {
  switch (type) {
    case "in_session":
      return 0.6;
    case "produced":
      return 0.9;
    case "mentions":
      return 0.075;
    case "related":
      return 0.025;
    default:
      return 0.03 + 0.03 * Math.max(0, Math.min(1, weight));
  }
}

/**
 * Curvature per link so parallel edges (e.g. refines + same_topic between the same two thoughts) fan out
 * instead of drawing on top of each other. `index` is the edge's rank among the edges of its node pair.
 */
export function curvatureFor(index: number, count: number, semantic: boolean): number {
  if (count <= 1) return semantic ? 0.1 : 0;
  const centered = index - (count - 1) / 2;
  return centered * 0.26 + (semantic ? 0.04 : 0);
}
