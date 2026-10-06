import type { VNode } from "./graph-cache";

/* ============================================================================
 * Custom d3-force forces for the knowledge graph. d3-force-3d is not a direct dependency (it is inside
 * react-force-graph), so these are written against the tiny force protocol instead of importing it:
 * a function of alpha with an `initialize(nodes)` hook. Pure: tested with plain objects.
 * ========================================================================== */

export interface Force {
  (alpha: number): void;
  initialize: (nodes: VNode[]) => void;
}

/*
 * Every structural force scales with alpha, exactly like d3's own link and charge forces. That matters:
 * if one force kept a floor while the others cooled to zero it would slowly win and the layout would
 * collapse onto it. Cooled, the layout is frozen; only the drift force keeps it gently alive.
 */

const isThoughtLike = (k: VNode["kind"]): boolean => k === "thought" || k === "decision" || k === "artifact";

/**
 * Thoughts, decisions and artifacts orbit their session: a spring towards the session node that only
 * pulls when a member strays beyond its orbit (so the ring is never crowded) and gently pushes out of the
 * ring itself. This is what makes sessions read as clusters.
 */
export function sessionGravity(strength = 0.085): Force {
  let members: VNode[] = [];
  const sessions = new Map<string, VNode>();
  const count = new Map<string, number>();

  const force = ((alpha: number): void => {
    const a = alpha * strength;
    for (const m of members) {
      const s = m.sessionId ? sessions.get(m.sessionId) : undefined;
      if (!s || s === m || m.x === undefined || s.x === undefined || m.y === undefined || s.y === undefined) continue;
      const dx = s.x - m.x;
      const dy = s.y - m.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const orbit = s.r + 22 + 6.5 * Math.sqrt(count.get(s.id) ?? 1);
      const k = m.kind === "artifact" ? 0.45 : 1;
      let pull = 0;
      if (d > orbit) pull = (d - orbit) * a * k;
      else if (d < s.r + 8) pull = -(s.r + 8 - d) * a * 1.4;
      if (pull === 0) continue;
      m.vx = (m.vx ?? 0) + (dx / d) * pull;
      m.vy = (m.vy ?? 0) + (dy / d) * pull;
    }
  }) as Force;

  force.initialize = (nodes) => {
    members = nodes.filter((n) => isThoughtLike(n.kind) && n.sessionId);
    sessions.clear();
    count.clear();
    for (const n of nodes) if (n.kind === "session") sessions.set(n.id, n);
    for (const m of members) if (m.sessionId) count.set(m.sessionId, (count.get(m.sessionId) ?? 0) + 1);
  };
  return force;
}

/**
 * Entities mentioned from more than one session float to the middle of those sessions: they BRIDGE
 * them. (An entity of a single session is left to the link and charge forces.)
 */
export function bridgeForce(strength = 0.06): Force {
  let entities: VNode[] = [];
  const sessions = new Map<string, VNode>();

  const force = ((alpha: number): void => {
    const a = alpha * strength;
    for (const e of entities) {
      if (e.sessions.length < 2 || e.x === undefined || e.y === undefined) continue;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const id of e.sessions) {
        const s = sessions.get(id);
        if (!s || s.x === undefined || s.y === undefined) continue;
        cx += s.x;
        cy += s.y;
        n++;
      }
      if (n < 2) continue;
      e.vx = (e.vx ?? 0) + (cx / n - e.x) * a;
      e.vy = (e.vy ?? 0) + (cy / n - e.y) * a;
    }
  }) as Force;

  force.initialize = (nodes) => {
    entities = nodes.filter((n) => n.kind === "entity");
    sessions.clear();
    for (const n of nodes) if (n.kind === "session") sessions.set(n.id, n);
  };
  return force;
}

/** Keeps nodes from overlapping (grid-hashed, so it scales to a few hundred nodes at 60 fps). */
export function collideForce(padding = 3, strength = 0.7): Force {
  let nodes: VNode[] = [];
  const CELL = 64;
  const grid = new Map<number, VNode[]>();
  const key = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

  const force = ((_alpha: number): void => {
    grid.clear();
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined || n.dying != null) continue;
      const k = key(Math.floor(n.x / CELL), Math.floor(n.y / CELL));
      const cell = grid.get(k);
      if (cell) cell.push(n);
      else grid.set(k, [n]);
    }
    for (const a of nodes) {
      if (a.x === undefined || a.y === undefined || a.dying != null) continue;
      const cx = Math.floor(a.x / CELL);
      const cy = Math.floor(a.y / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = grid.get(key(gx, gy));
          if (!cell) continue;
          for (const b of cell) {
            const first = a.index !== undefined && b.index !== undefined ? a.index < b.index : a.id < b.id;
            if (!first) continue; // each pair once
            const bx = b.x as number;
            const by = b.y as number;
            let dx = bx - a.x;
            let dy = by - a.y;
            const min = a.r + b.r + padding;
            let d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            if (d2 === 0) {
              dx = (a.id < b.id ? 1 : -1) * 0.01;
              dy = 0.01;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            const push = ((min - d) / d) * strength * 0.5;
            const wa = (b.r * b.r) / (a.r * a.r + b.r * b.r);
            a.vx = (a.vx ?? 0) - dx * push * wa * 2;
            a.vy = (a.vy ?? 0) - dy * push * wa * 2;
            b.vx = (b.vx ?? 0) + dx * push * (1 - wa) * 2;
            b.vy = (b.vy ?? 0) + dy * push * (1 - wa) * 2;
          }
        }
      }
    }
  }) as Force;

  force.initialize = (n) => {
    nodes = n;
  };
  return force;
}

export interface DriftForce extends Force {
  enabled: boolean;
  /** hold the drift off for `ticks` ticks (after the layout changed, so it can settle first) */
  quiet: (ticks: number) => void;
}

/**
 * Idle motion: every node gets a tiny sinusoidal velocity impulse with its own phase and period. The
 * impulses are zero-mean, so the response to the engine's friction is a bounded wobble around where the
 * layout settled rather than a random walk; links and glow follow because it is real motion.
 */
export function driftForce(amplitude = 0.05): DriftForce {
  let nodes: VNode[] = [];
  let tick = 0;
  let quietUntil = 0;

  const force = ((_alpha: number): void => {
    tick++;
    if (!force.enabled || tick < quietUntil) return;
    const ramp = Math.min(1, (tick - quietUntil) / 90);
    for (const n of nodes) {
      if (n.dying != null || n.fx !== undefined) continue;
      const ph = n.phase * Math.PI * 2;
      const wx = 0.016 + n.phase * 0.02;
      const wy = 0.013 + (1 - n.phase) * 0.021;
      const g = (n.kind === "session" ? 0.4 : n.kind === "entity" ? 0.8 : 1) * amplitude * ramp;
      n.vx = (n.vx ?? 0) + Math.cos(wx * tick + ph) * g;
      n.vy = (n.vy ?? 0) + Math.sin(wy * tick + ph * 1.7) * g;
    }
  }) as DriftForce;

  force.enabled = true;
  force.quiet = (ticks) => {
    quietUntil = Math.max(quietUntil, tick + ticks);
  };
  force.initialize = (n) => {
    nodes = n;
  };
  return force;
}

export interface AspectGravity extends Force {
  /** width / height of the stage: the layout is flattened into an ellipse of this shape */
  setAspect: (aspect: number) => void;
  setStrength: (strength: number) => void;
}

/**
 * A force layout is round; a screen is not. A weak anisotropic pull towards the origin stretches the
 * constellation along the long side of the stage, so a wide projector or a tall phone is actually filled
 * instead of leaving bands of empty canvas. (Spring constants ∝ 1/aspect on x and ∝ aspect on y.)
 */
export function aspectGravity(initialStrength = 0.03): AspectGravity {
  let nodes: VNode[] = [];
  let aspect = 1.5;
  let strength = initialStrength;

  const force = ((alpha: number): void => {
    const a = alpha * strength;
    const kx = a / aspect;
    const ky = a * aspect;
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      n.vx = (n.vx ?? 0) - n.x * kx;
      n.vy = (n.vy ?? 0) - n.y * ky;
    }
  }) as AspectGravity;

  force.setStrength = (v) => {
    strength = Math.max(0, v);
  };
  force.setAspect = (v) => {
    aspect = Math.min(2.6, Math.max(0.45, Number.isFinite(v) && v > 0 ? v : 1));
  };
  force.initialize = (n) => {
    nodes = n;
  };
  return force;
}
