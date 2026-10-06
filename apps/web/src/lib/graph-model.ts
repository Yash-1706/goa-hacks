import type { Activity, ArtifactKind, Category, EdgeType, GraphEdge, GraphNode, GraphNodeKind } from "@synapse/shared";
import { ARTIFACT_KINDS } from "@synapse/shared";
import { isSemanticEdge } from "./graph-style";

/* ============================================================================
 * Graph model queries: adjacency, the "N sessions linked by M entities" numbers, and the lists the detail
 * panel shows. Pure functions over plain GraphNode / GraphEdge arrays.
 * ========================================================================== */

export type Adjacency = Map<string, Set<string>>;

export function buildAdjacency(edges: Iterable<Pick<GraphEdge, "src" | "dst">>): Adjacency {
  const adj: Adjacency = new Map();
  const add = (a: string, b: string): void => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const e of edges) {
    add(e.src, e.dst);
    add(e.dst, e.src);
  }
  return adj;
}

/** The node itself and everything within one hop. */
export function oneHop(id: string, adj: Adjacency): Set<string> {
  const out = new Set<string>([id]);
  const nb = adj.get(id);
  if (nb) for (const n of nb) out.add(n);
  return out;
}

/** Edge ids that touch `id`. */
export function edgesTouching(id: string, edges: Iterable<Pick<GraphEdge, "id" | "src" | "dst">>): Set<string> {
  const out = new Set<string>();
  for (const e of edges) if (e.src === id || e.dst === id) out.add(e.id);
  return out;
}

// ------------------------------------------------------------ artifact kind --

const ARTIFACT_BY_LABEL = new Map<string, ArtifactKind>(ARTIFACT_KINDS.map((k) => [k.replace(/_/g, " "), k]));

/** The server labels artifact nodes "email draft A-5": recover the kind from the label. */
export function artifactKindFromLabel(label: string): ArtifactKind | null {
  const m = /^(.*?)\s+[A-Z]+-\d+\s*$/.exec(label.trim());
  const head = (m ? (m[1] as string) : label).trim().toLowerCase();
  return ARTIFACT_BY_LABEL.get(head) ?? null;
}

// -------------------------------------------------------------------- stats --

export interface SessionInfo {
  id: string;
  label: string;
  createdAt: number;
  deviceKind?: "desk" | "pocket";
  activity?: Activity;
  /** thoughts + decisions in this session */
  thoughts: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  sessions: number;
  /** entities mentioned from thoughts of two or more sessions */
  bridgeEntities: number;
  /** sessions connected to at least one other session through a bridge entity or a cross-session semantic edge */
  linkedSessions: number;
  /** semantic edges between thoughts of different sessions */
  crossSemantic: number;
  kinds: Partial<Record<GraphNodeKind, number>>;
  categories: Array<[Category, number]>;
  edgeTypes: Partial<Record<EdgeType, number>>;
  sessionList: SessionInfo[];
  /** entity id → distinct session ids that mention it */
  entitySessions: Map<string, string[]>;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(a: string): string {
    let root = a;
    for (;;) {
      const p = this.parent.get(root);
      if (p === undefined) {
        this.parent.set(root, root);
        break;
      }
      if (p === root) break;
      root = p;
    }
    // path compression
    let cur = a;
    while (cur !== root) {
      const next = this.parent.get(cur) ?? root;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function computeStats(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphStats {
  const byId = new Map<string, GraphNode>();
  const kinds: GraphStats["kinds"] = {};
  const cats = new Map<Category, number>();
  const sessions = new Map<string, SessionInfo>();
  for (const n of nodes) {
    byId.set(n.id, n);
    kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    if ((n.kind === "thought" || n.kind === "decision") && n.category) cats.set(n.category, (cats.get(n.category) ?? 0) + 1);
    if (n.kind === "session") sessions.set(n.id, { id: n.id, label: n.label, createdAt: n.createdAt, deviceKind: n.deviceKind, activity: n.activity, thoughts: 0 });
  }
  for (const n of nodes) {
    if ((n.kind === "thought" || n.kind === "decision") && n.sessionId) {
      const s = sessions.get(n.sessionId);
      if (s) s.thoughts++;
    }
  }

  const edgeTypes: GraphStats["edgeTypes"] = {};
  const entitySessions = new Map<string, string[]>();
  const uf = new UnionFind();
  let crossSemantic = 0;
  const sessionOf = (id: string): string | undefined => {
    const n = byId.get(id);
    return n && (n.kind === "thought" || n.kind === "decision" || n.kind === "artifact") ? n.sessionId : undefined;
  };

  for (const e of edges) {
    edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1;
    if (e.type === "mentions") {
      const src = byId.get(e.src);
      const dst = byId.get(e.dst);
      const ent = src?.kind === "entity" ? src : dst?.kind === "entity" ? dst : undefined;
      const th = ent === src ? dst : src;
      const sid = th?.sessionId;
      if (ent && sid) {
        const list = entitySessions.get(ent.id) ?? [];
        if (!list.includes(sid)) list.push(sid);
        entitySessions.set(ent.id, list);
      }
    } else if (isSemanticEdge(e.type)) {
      const a = sessionOf(e.src);
      const b = sessionOf(e.dst);
      if (a && b && a !== b) {
        crossSemantic++;
        uf.union(a, b);
      }
    }
  }

  let bridgeEntities = 0;
  for (const list of entitySessions.values()) {
    if (list.length < 2) continue;
    bridgeEntities++;
    for (let i = 1; i < list.length; i++) uf.union(list[0] as string, list[i] as string);
  }

  // sessions in a component of 2+ (linked to another session by an entity or a semantic edge)
  const members = new Map<string, string[]>();
  for (const id of sessions.keys()) {
    const root = uf.find(id);
    const arr = members.get(root) ?? [];
    arr.push(id);
    members.set(root, arr);
  }
  let linkedSessions = 0;
  for (const arr of members.values()) if (arr.length >= 2) linkedSessions += arr.length;

  const sessionList = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    nodes: nodes.length,
    edges: edges.length,
    sessions: sessions.size,
    bridgeEntities,
    linkedSessions,
    crossSemantic,
    kinds,
    categories: [...cats.entries()].sort((a, b) => b[1] - a[1]),
    edgeTypes,
    sessionList,
    entitySessions,
  };
}

/** "5 sessions linked by 7 entities". Empty when nothing is linked yet. */
export function linkSummary(s: Pick<GraphStats, "linkedSessions" | "bridgeEntities" | "crossSemantic" | "sessions">): string {
  if (s.linkedSessions < 2) return s.sessions > 0 ? `${s.sessions} ${s.sessions === 1 ? "session" : "sessions"}, not linked yet` : "";
  const ent = `${s.bridgeEntities} ${s.bridgeEntities === 1 ? "entity" : "entities"}`;
  if (s.bridgeEntities === 0) return `${s.linkedSessions} sessions linked by ${s.crossSemantic} semantic ${s.crossSemantic === 1 ? "link" : "links"}`;
  return `${s.linkedSessions} sessions linked by ${ent}`;
}

// ------------------------------------------------------------------- lists --

export interface Neighbor {
  node: GraphNode;
  edge: GraphEdge;
  /** true when `focus` is the edge's source */
  outgoing: boolean;
}

/** Everything linked to `id`, with the connecting edge, for the detail panel. */
export function neighborsOf(id: string, nodes: ReadonlyMap<string, GraphNode>, edges: Iterable<GraphEdge>): Neighbor[] {
  const out: Neighbor[] = [];
  for (const e of edges) {
    if (e.src !== id && e.dst !== id) continue;
    const other = nodes.get(e.src === id ? e.dst : e.src);
    if (other) out.push({ node: other, edge: e, outgoing: e.src === id });
  }
  return out;
}

/** Thoughts and decisions of a session, oldest first. */
export function thoughtsOfSession(sessionId: string, nodes: Iterable<GraphNode>): GraphNode[] {
  const out: GraphNode[] = [];
  for (const n of nodes) if ((n.kind === "thought" || n.kind === "decision") && n.sessionId === sessionId) out.push(n);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Thoughts that mention an entity, oldest first. */
export function thoughtsMentioning(entityId: string, nodes: ReadonlyMap<string, GraphNode>, edges: Iterable<GraphEdge>): GraphNode[] {
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.type !== "mentions") continue;
    const otherId = e.src === entityId ? e.dst : e.dst === entityId ? e.src : null;
    if (!otherId || seen.has(otherId)) continue;
    const n = nodes.get(otherId);
    if (n && (n.kind === "thought" || n.kind === "decision")) {
      seen.add(otherId);
      out.push(n);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The thought an artifact was produced from. */
export function producerOf(artifactId: string, nodes: ReadonlyMap<string, GraphNode>, edges: Iterable<GraphEdge>): GraphNode | undefined {
  for (const e of edges) {
    if (e.type === "produced" && e.dst === artifactId) {
      const n = nodes.get(e.src);
      if (n) return n;
    }
  }
  return undefined;
}
