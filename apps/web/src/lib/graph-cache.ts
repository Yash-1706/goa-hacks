import type { Category, EdgeType, GraphEdge, GraphNode, GraphNodeKind } from "@synapse/shared";
import { centroid, curvatureFor, hash01, scatterNear, seedSession, type Pt } from "./graph-layout";
import { SessionColors, isLongTerm, isSemanticEdge, nodeColor, nodeRadius } from "./graph-style";

/* ============================================================================
 * Stable object cache between the zustand graph store and react-force-graph.
 *
 * react-force-graph MUTATES the objects it is given (x / y / vx / vy / index, and it swaps link
 * source/target ids for node references). Rebuilding them on every store update or scrubber step would
 * throw the layout away, so every node and link lives here exactly once, keyed by id, and a sync only
 * adds, hides, patches or removes. Pure (no DOM, no React): `performance.now()` values are passed in.
 * ========================================================================== */

export interface VNode {
  id: string;
  kind: GraphNodeKind;
  data: GraphNode;
  // mutated by d3-force / force-graph
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
  index?: number;
  // derived style (recomputed when `data` changes)
  r: number;
  color: string;
  /** artifacts take the colour of the thought that produced them */
  tint: Category | undefined;
  label: string;
  /** owning session of a thought / decision / artifact */
  sessionId: string | undefined;
  /** entities: distinct sessions whose thoughts mention it (2+ = it bridges them) */
  sessions: readonly string[];
  /** 0..1, stable per node: desynchronises breathing and sparks */
  phase: number;
  // lifecycle
  visible: boolean;
  /** performance.now() when it appeared (drives the pop-in). -Infinity = there from the start. */
  born: number;
  /** keeps pulsing until this performance.now() (live arrivals) */
  pulseUntil: number;
  /** performance.now() of the last promotion into long-term memory (the node flashes) */
  promotedAt: number;
  /** a deleted node plays its exit until `dying + GHOST_MS`, then it is dropped */
  dying: number | null;
}

export interface VLink {
  id: string;
  data: GraphEdge;
  type: EdgeType;
  source: VNode;
  target: VNode;
  weight: number;
  semantic: boolean;
  /** quadratic-curve bend so parallel edges fan out */
  curv: number;
  visible: boolean;
  born: number;
  dying: number | null;
  index?: number;
}

export const GHOST_MS = 900;
export const PULSE_MS = 4200;
export const SESSION_PULSE_MS = 1800;
/** edges fade in this long after their later end appears */
export const LINK_DELAY_MS = 140;

export interface SyncInput {
  nodes: Readonly<Record<string, GraphNode>>;
  edges: Readonly<Record<string, GraphEdge>>;
  /** show everything created at or before this time (epoch ms); Infinity = live */
  t: number;
  perf: number;
  /** animate arrivals and exits (false under prefers-reduced-motion) */
  animate: boolean;
  /** first paint: stagger the pop-in so the constellation blooms (ignored when !animate) */
  intro?: boolean;
}

export interface SyncResult {
  /** the visible node / link sets changed: hand fresh arrays to the force engine */
  changed: boolean;
  nodes: VNode[];
  links: VLink[];
  born: VNode[];
  /** hidden by the time filter this sync */
  hidden: VNode[];
  /** performance.now() at which a deleted node's exit ends (schedule another sync), or null */
  nextGhostEnd: number | null;
}

/** Draw order: sessions at the back, entities on top. */
const RANK: Record<GraphNodeKind, number> = { session: 0, artifact: 1, thought: 2, decision: 2, open_loop: 2, entity: 3 };

const isThoughtLike = (k: GraphNodeKind): boolean => k === "thought" || k === "decision";
/** nodes that only exist visually while a thought they belong to is on screen */
const isAnchored = (k: GraphNodeKind): boolean => k === "entity" || k === "artifact" || k === "open_loop";

export class GraphCache {
  readonly colors = new SessionColors();
  private readonly nodeMap = new Map<string, VNode>();
  private readonly linkMap = new Map<string, VLink>();
  private outNodes: VNode[] = [];
  private outLinks: VLink[] = [];
  private primed = false;

  get size(): number {
    return this.outNodes.length;
  }

  node(id: string): VNode | undefined {
    return this.nodeMap.get(id);
  }

  /** every node ever cached, visible or not (the camera can still look up its last position) */
  has(id: string): boolean {
    return this.nodeMap.has(id);
  }

  visibleNodes(): readonly VNode[] {
    return this.outNodes;
  }

  visibleLinks(): readonly VLink[] {
    return this.outLinks;
  }

  /** The node, its one-hop neighbours and the links among them that touch it (for focus dimming). */
  neighborhood(id: string): { nodes: Set<string>; links: Set<string> } {
    const nodes = new Set<string>([id]);
    const links = new Set<string>();
    for (const l of this.outLinks) {
      if (l.source.id === id) {
        nodes.add(l.target.id);
        links.add(l.id);
      } else if (l.target.id === id) {
        nodes.add(l.source.id);
        links.add(l.id);
      }
    }
    return { nodes, links };
  }

  /**
   * Replay the opening bloom on nodes that already have positions (the screen was reopened, so the
   * constellation is still laid out, it just pops back in chronologically).
   */
  rewind(perf: number, animate: boolean): void {
    if (!animate) {
      // reduced motion: whatever bloom an earlier visit scheduled is cancelled, everything is simply there
      for (const n of this.outNodes) {
        n.born = Number.NEGATIVE_INFINITY;
        n.pulseUntil = 0;
      }
      for (const l of this.outLinks) l.born = Number.NEGATIVE_INFINITY;
      return;
    }
    if (this.outNodes.length === 0) return;
    const chrono = [...this.outNodes].sort((a, b) => a.data.createdAt - b.data.createdAt);
    const step = Math.min(18, 1400 / chrono.length);
    chrono.forEach((n, i) => {
      n.born = perf + i * step;
      n.pulseUntil = 0;
    });
    for (const l of this.outLinks) l.born = Math.max(l.source.born, l.target.born) + LINK_DELAY_MS;
  }

  sync(input: SyncInput): SyncResult {
    const { nodes: store, edges: edgeStore, t, perf, animate } = input;
    const live = !Number.isFinite(t);
    const storeNodes = Object.values(store);
    const storeEdges = Object.values(edgeStore);
    let changed = false;
    const born: VNode[] = [];
    const hidden: VNode[] = [];
    let nextGhostEnd: number | null = null;

    // 1. colours: sessions get theirs in creation order, once
    this.colors.assign(storeNodes.filter((n) => n.kind === "session"));

    // 2. upsert nodes (sessions first so children can be seeded next to them)
    const seen = new Set<string>();
    for (const n of storeNodes) {
      seen.add(n.id);
      const existing = this.nodeMap.get(n.id);
      if (!existing) this.nodeMap.set(n.id, this.create(n));
      else if (existing.data !== n) this.patch(existing, n, perf);
      else if (existing.kind === "session") existing.color = this.colors.get(n.id);
      if (existing?.dying != null) {
        // it came back (same id re-created): cancel the exit
        existing.dying = null;
      }
    }

    // 3. deletions: play an exit when it was on screen, otherwise just forget it
    for (const [id, vn] of this.nodeMap) {
      if (seen.has(id)) continue;
      if (vn.dying == null) {
        if (vn.visible && animate && this.primed) {
          vn.dying = perf;
          changed = true;
        } else {
          this.nodeMap.delete(id);
          if (vn.visible) changed = true;
        }
      }
      if (vn.dying != null) {
        const end = vn.dying + GHOST_MS;
        if (perf >= end) {
          this.nodeMap.delete(id);
          changed = true;
        } else nextGhostEnd = nextGhostEnd === null ? end : Math.min(nextGhostEnd, end);
      }
    }

    // 4. which nodes are on screen at time t: created already, and entities / artifacts only while a
    //    thought they belong to is on screen too (never an orphan hub)
    const timeVisible = (vn: VNode): boolean => vn.data.createdAt <= t;
    const anchored = new Set<string>();
    for (const e of storeEdges) {
      const a = this.nodeMap.get(e.src);
      const b = this.nodeMap.get(e.dst);
      if (!a || !b || a.dying != null || b.dying != null) continue;
      if (isThoughtLike(a.kind) && isAnchored(b.kind) && timeVisible(a) && timeVisible(b)) anchored.add(b.id);
      else if (isThoughtLike(b.kind) && isAnchored(a.kind) && timeVisible(a) && timeVisible(b)) anchored.add(a.id);
    }

    const order = [...this.nodeMap.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.data.createdAt - b.data.createdAt);
    const placedSessions: Pt[] = order.filter((v) => v.kind === "session" && v.visible && Number.isFinite(v.x)).map((v) => ({ x: v.x as number, y: v.y as number }));
    const sessionTotal = order.reduce((n, v) => n + (v.kind === "session" ? 1 : 0), 0);
    const mentionsOf = new Map<string, string[]>(); // entity / artifact id → thought ids (for seeding)
    for (const e of storeEdges) {
      if (e.type !== "mentions" && e.type !== "produced") continue;
      const a = this.nodeMap.get(e.src);
      const b = this.nodeMap.get(e.dst);
      if (!a || !b) continue;
      const anchor = isAnchored(b.kind) ? b : isAnchored(a.kind) ? a : null;
      const thought = anchor === b ? a : b;
      if (!anchor || !isThoughtLike(thought.kind)) continue;
      const list = mentionsOf.get(anchor.id) ?? [];
      list.push(thought.id);
      mentionsOf.set(anchor.id, list);
    }

    const intro = Boolean(input.intro) && animate && !this.primed;
    for (const vn of order) {
      if (vn.dying != null) continue;
      const now = timeVisible(vn) && (!isAnchored(vn.kind) || anchored.has(vn.id));
      if (now && !vn.visible) {
        vn.visible = true;
        changed = true;
        born.push(vn);
        vn.born = !animate || !this.primed ? Number.NEGATIVE_INFINITY : perf;
        vn.pulseUntil = live && this.primed && animate ? perf + PULSE_MS : 0;
        if (live && this.primed && animate && vn.kind !== "session" && vn.sessionId) {
          // a new thought makes its session ring ripple
          const s = this.nodeMap.get(vn.sessionId);
          if (s) s.pulseUntil = Math.max(s.pulseUntil, perf + SESSION_PULSE_MS);
        }
        if (!Number.isFinite(vn.x) || !Number.isFinite(vn.y)) this.seed(vn, placedSessions, sessionTotal, mentionsOf);
        if (vn.kind === "session") placedSessions.push({ x: vn.x as number, y: vn.y as number });
      } else if (!now && vn.visible) {
        vn.visible = false;
        changed = true;
        hidden.push(vn);
      }
    }
    if (intro && born.length) {
      // the constellation blooms in chronological order
      const chrono = [...born].sort((a, b) => a.data.createdAt - b.data.createdAt);
      const step = Math.min(18, 1400 / chrono.length);
      chrono.forEach((vn, i) => (vn.born = perf + i * step));
    }

    // 5. links: visible when both ends are
    const edgeSeen = new Set<string>();
    for (const e of storeEdges) {
      const a = this.nodeMap.get(e.src);
      const b = this.nodeMap.get(e.dst);
      if (!a || !b) continue;
      edgeSeen.add(e.id);
      let vl = this.linkMap.get(e.id);
      if (!vl) {
        vl = { id: e.id, data: e, type: e.type, source: a, target: b, weight: e.weight, semantic: isSemanticEdge(e.type), curv: 0, visible: false, born: Number.NEGATIVE_INFINITY, dying: null };
        this.linkMap.set(e.id, vl);
      } else if (vl.data !== e) {
        vl.data = e;
        vl.type = e.type;
        vl.weight = e.weight;
        vl.semantic = isSemanticEdge(e.type);
      }
      // endpoints may have been re-created under the same id
      vl.source = a;
      vl.target = b;
      vl.dying = null;
      const now = a.visible && b.visible && a.dying == null && b.dying == null;
      if (now && !vl.visible) {
        vl.visible = true;
        changed = true;
        const later = Math.max(a.born, b.born);
        if (!animate) vl.born = Number.NEGATIVE_INFINITY;
        else if (Number.isFinite(later) && later >= perf - 600) vl.born = later + LINK_DELAY_MS; // follows the node(s) that just appeared
        else if (!this.primed) vl.born = Number.NEGATIVE_INFINITY;
        else vl.born = perf; // a new edge between nodes that were already there: fade it in
      } else if (!now && vl.visible) {
        vl.visible = false;
        changed = true;
      }
    }
    for (const [id, vl] of this.linkMap) {
      if (edgeSeen.has(id)) continue;
      const ghostEnd = vl.source.dying != null ? vl.source.dying + GHOST_MS : vl.target.dying != null ? vl.target.dying + GHOST_MS : null;
      if (vl.visible && ghostEnd !== null && perf < ghostEnd) {
        vl.dying = vl.source.dying ?? vl.target.dying;
        continue;
      }
      this.linkMap.delete(id);
      if (vl.visible) changed = true;
    }

    // 6. output arrays (new identities only when something changed)
    if (changed || !this.primed) {
      this.outNodes = order.filter((v) => v.visible);
      this.outLinks = [...this.linkMap.values()].filter((l) => l.visible && this.nodeMap.get(l.source.id) === l.source && this.nodeMap.get(l.target.id) === l.target);
      this.refreshDerived();
    }
    this.primed = true;
    return { changed, nodes: this.outNodes, links: this.outLinks, born, hidden, nextGhostEnd };
  }

  // ------------------------------------------------------------------------

  private create(n: GraphNode): VNode {
    const vn: VNode = {
      id: n.id,
      kind: n.kind,
      data: n,
      r: nodeRadius(n),
      color: nodeColor(n, n.kind === "session" ? this.colors.get(n.id) : undefined),
      tint: undefined,
      label: n.label,
      sessionId: n.kind === "session" ? n.id : n.sessionId,
      sessions: [],
      phase: hash01(n.id, 9),
      visible: false,
      born: Number.NEGATIVE_INFINITY,
      pulseUntil: 0,
      promotedAt: Number.NEGATIVE_INFINITY,
      dying: null,
    };
    return vn;
  }

  private patch(vn: VNode, n: GraphNode, perf: number): void {
    const wasLong = isLongTerm(vn.data);
    vn.data = n;
    vn.label = n.label;
    vn.sessionId = n.kind === "session" ? n.id : n.sessionId;
    vn.r = nodeRadius(n);
    vn.color = nodeColor(n, n.kind === "session" ? this.colors.get(n.id) : undefined, vn.tint);
    if (vn.visible && !wasLong && isLongTerm(n)) vn.promotedAt = perf;
  }

  private seed(vn: VNode, placedSessions: readonly Pt[], sessionTotal: number, mentionsOf: ReadonlyMap<string, string[]>): void {
    let p: Pt;
    if (vn.kind === "session") {
      p = seedSession(placedSessions, vn.id, sessionTotal);
    } else if (isAnchored(vn.kind)) {
      const around = (mentionsOf.get(vn.id) ?? [])
        .map((id) => this.nodeMap.get(id))
        .filter((v): v is VNode => Boolean(v) && Number.isFinite(v?.x) && Number.isFinite(v?.y))
        .map((v) => ({ x: v.x as number, y: v.y as number }));
      p = around.length ? scatterNear(centroid(around), vn.id, vn.kind === "artifact" ? 14 : 18, vn.kind === "artifact" ? 22 : 46) : scatterNear({ x: 0, y: 0 }, vn.id, 40, 120);
    } else {
      const s = vn.sessionId ? this.nodeMap.get(vn.sessionId) : undefined;
      const base = s && Number.isFinite(s.x) && Number.isFinite(s.y) ? { x: s.x as number, y: s.y as number } : placedSessions.length ? centroid(placedSessions) : { x: 0, y: 0 };
      p = scatterNear(base, vn.id, 34, 64);
    }
    vn.x = p.x;
    vn.y = p.y;
    vn.vx = 0;
    vn.vy = 0;
  }

  /** Per-sync derived data: entity session lists, artifact tints, session sizes, link curvature. */
  private refreshDerived(): void {
    const sessionsOfEntity = new Map<string, string[]>();
    const thoughtsInSession = new Map<string, number>();
    const tintOf = new Map<string, Category | undefined>();
    for (const n of this.outNodes) if (isThoughtLike(n.kind) && n.sessionId) thoughtsInSession.set(n.sessionId, (thoughtsInSession.get(n.sessionId) ?? 0) + 1);

    const pairs = new Map<string, VLink[]>();
    for (const l of this.outLinks) {
      const a = l.source;
      const b = l.target;
      if (l.type === "mentions") {
        const ent = a.kind === "entity" ? a : b.kind === "entity" ? b : null;
        const th = ent === a ? b : a;
        if (ent && th.sessionId) {
          const list = sessionsOfEntity.get(ent.id) ?? [];
          if (!list.includes(th.sessionId)) list.push(th.sessionId);
          sessionsOfEntity.set(ent.id, list);
        }
      } else if (l.type === "produced") {
        const art = a.kind === "artifact" ? a : b.kind === "artifact" ? b : null;
        const th = art === a ? b : a;
        if (art && th.data.category) tintOf.set(art.id, th.data.category);
      }
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const list = pairs.get(key) ?? [];
      list.push(l);
      pairs.set(key, list);
    }

    for (const n of this.outNodes) {
      if (n.kind === "entity") n.sessions = sessionsOfEntity.get(n.id) ?? [];
      if (n.kind === "session") n.r = nodeRadius(n.data, { sessionThoughts: thoughtsInSession.get(n.id) ?? 0 });
      if (n.kind === "artifact") {
        const tint = tintOf.get(n.id);
        if (tint !== n.tint) {
          n.tint = tint;
          n.color = nodeColor(n.data, undefined, tint);
        }
      }
    }
    for (const list of pairs.values()) {
      list.sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : x.id < y.id ? -1 : 1));
      list.forEach((l, i) => {
        const dir = l.source.id < l.target.id ? 1 : -1;
        l.curv = curvatureFor(i, list.length, l.semantic) * dir;
      });
    }
  }
}
