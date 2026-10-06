import type { GraphEdge, GraphNode } from "@synapse/shared";
import type { MemoryStore } from "./store";
import type { ArtifactRec, EntityRec, SessionRec, ThoughtRec } from "./types";

/* Graph model for the visualization (TRD §8.3). Structural edges (in_session / mentions /
 * produced) are derived on the fly; semantic edges are stored in the edges table. */

export function sessionNode(s: SessionRec): GraphNode {
  return {
    id: s.id,
    kind: "session",
    label: s.label ?? `${s.code} · ${s.deviceKind}`,
    createdAt: s.startedAt,
    deviceKind: s.deviceKind,
    activity: s.activity,
    promoted: true,
  };
}

export function thoughtNode(t: ThoughtRec): GraphNode {
  return {
    id: t.id,
    kind: t.category === "decision" ? "decision" : "thought",
    label: t.title,
    category: t.category,
    sessionId: t.sessionId,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    promoted: t.promoted,
    salience: t.salience,
    deviceKind: t.deviceKind,
    activity: t.activity,
  };
}

export function entityNode(e: EntityRec): GraphNode {
  return {
    id: e.id,
    kind: "entity",
    label: e.name,
    entityType: e.type,
    createdAt: e.firstSeen,
    expiresAt: e.expiresAt,
    promoted: e.longTerm > 0,
    salience: e.salience,
  };
}

export function artifactNode(a: ArtifactRec, t: ThoughtRec | undefined): GraphNode {
  return {
    id: a.id,
    kind: "artifact",
    label: `${a.kind.replace("_", " ")} ${a.code}`,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    promoted: a.expiresAt === null,
    sessionId: t?.sessionId,
  };
}

const edge = (type: GraphEdge["type"], src: string, dst: string, weight = 1, label?: string): GraphEdge => ({
  id: `${type}:${src}>${dst}`,
  src,
  dst,
  type,
  weight,
  label,
});

/** Nodes + edges that describe one thought (used for live deltas). */
export function graphDeltaFor(store: MemoryStore, t: ThoughtRec): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  if (!store.isRecallable(t)) return { nodes, edges };
  const s = store.sessions.get(t.sessionId);
  if (s) nodes.push(sessionNode(s));
  nodes.push(thoughtNode(t));
  edges.push(edge("in_session", t.id, t.sessionId, 0.4));
  for (const id of t.entityIds) {
    const e = store.entities.get(id);
    if (!e) continue;
    nodes.push(entityNode(e));
    edges.push(edge("mentions", t.id, e.id, 0.6));
  }
  const a = t.artifactId ? store.artifacts.get(t.artifactId) : undefined;
  if (a && a.kind !== "none" && a.status !== "dismissed") {
    nodes.push(artifactNode(a, t));
    edges.push(edge("produced", t.id, a.id, 0.8));
  }
  for (const e of store.edgesOf(t.id)) {
    edges.push({ id: e.id, src: e.src, dst: e.dst, type: e.type, weight: e.weight });
  }
  return { nodes, edges };
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function graphSnapshot(store: MemoryStore, opts: { includeWorking?: boolean } = {}): GraphSnapshot {
  const includeWorking = opts.includeWorking ?? true;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const keep = new Set<string>();

  for (const t of store.thoughts.values()) {
    if (!store.isRecallable(t)) continue;
    if (!includeWorking && !t.promoted) continue;
    keep.add(t.id);
    const d = graphDeltaFor(store, t);
    for (const n of d.nodes) nodes.set(n.id, n);
    for (const e of d.edges) edges.set(e.id, e);
  }
  // semantic edges between kept nodes only (entity↔entity "related" included)
  for (const e of store.edges.values()) {
    if (nodes.has(e.src) && nodes.has(e.dst)) {
      edges.set(e.id, { id: e.id, src: e.src, dst: e.dst, type: e.type, weight: e.weight });
    }
  }
  // drop dangling edges
  const out = [...edges.values()].filter((e) => nodes.has(e.src) && nodes.has(e.dst));
  return { nodes: [...nodes.values()], edges: out };
}
