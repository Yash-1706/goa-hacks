import { create } from "zustand";
import type { GraphEdge, GraphNode } from "@synapse/shared";

/* ============================================================================
 * Knowledge graph: nodes/edges by id. Loaded from GET /api/graph on the Graph screen and then kept
 * live by graph.delta messages (also while the screen is closed, so reopening is instant).
 * ========================================================================== */

export interface GraphDelta {
  nodes: GraphNode[];
  edges: GraphEdge[];
  removedNodes: string[];
  removedEdges: string[];
}

export interface GraphState {
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  loaded: boolean;
  /** increments on every change so heavy consumers (the force graph) can cheaply detect updates */
  revision: number;
  /** ids added by the last delta (the graph pulses them) */
  fresh: string[];
  replace: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  applyDelta: (d: GraphDelta) => void;
}

export const useGraph = create<GraphState>()((set) => ({
  nodes: {},
  edges: {},
  loaded: false,
  revision: 0,
  fresh: [],

  replace: (nodes, edges) =>
    set((s) => ({
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      edges: Object.fromEntries(edges.map((e) => [e.id, e])),
      loaded: true,
      revision: s.revision + 1,
      fresh: [],
    })),

  applyDelta: (d) =>
    set((s) => {
      const nodes = { ...s.nodes };
      const edges = { ...s.edges };
      const fresh: string[] = [];
      for (const n of d.nodes) {
        if (!nodes[n.id]) fresh.push(n.id);
        nodes[n.id] = n;
      }
      for (const e of d.edges) edges[e.id] = e;
      const gone = new Set(d.removedNodes);
      for (const id of gone) delete nodes[id];
      for (const id of d.removedEdges) delete edges[id];
      if (gone.size) for (const [id, e] of Object.entries(edges)) if (gone.has(e.src) || gone.has(e.dst)) delete edges[id];
      // keep edges honest: both ends must exist
      for (const [id, e] of Object.entries(edges)) if (!nodes[e.src] || !nodes[e.dst]) delete edges[id];
      return { nodes, edges, revision: s.revision + 1, fresh };
    }),
}));
