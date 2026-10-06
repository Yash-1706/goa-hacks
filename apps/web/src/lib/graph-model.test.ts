import type { GraphEdge, GraphNode } from "@synapse/shared";
import { describe, expect, it } from "vitest";
import {
  artifactKindFromLabel,
  buildAdjacency,
  computeStats,
  edgesTouching,
  linkSummary,
  neighborsOf,
  oneHop,
  producerOf,
  thoughtsMentioning,
  thoughtsOfSession,
} from "./graph-model";

let n = 0;
const session = (id: string, createdAt: number, deviceKind: "desk" | "pocket" = "desk"): GraphNode => ({ id, kind: "session", label: `S-${id}`, createdAt, deviceKind, promoted: true });
const thought = (id: string, sessionId: string, createdAt: number, category: GraphNode["category"] = "idea"): GraphNode => ({ id, kind: "thought", label: `thought ${id}`, category, sessionId, createdAt });
const entity = (id: string, createdAt = 1): GraphNode => ({ id, kind: "entity", label: id, entityType: "technology", createdAt });
const edge = (type: GraphEdge["type"], src: string, dst: string, weight = 1): GraphEdge => ({ id: `${type}:${src}>${dst}:${n++}`, src, dst, type, weight });

describe("adjacency", () => {
  const edges = [edge("in_session", "t1", "s1"), edge("mentions", "t1", "e1"), edge("mentions", "t2", "e1")];
  it("is symmetric and gives one-hop neighbourhoods", () => {
    const adj = buildAdjacency(edges);
    expect([...(adj.get("e1") as Set<string>)].sort()).toEqual(["t1", "t2"]);
    expect([...oneHop("t1", adj)].sort()).toEqual(["e1", "s1", "t1"]);
    expect([...oneHop("lonely", adj)]).toEqual(["lonely"]);
  });
  it("lists the edges that touch a node", () => {
    expect(edgesTouching("e1", edges).size).toBe(2);
    expect(edgesTouching("zzz", edges).size).toBe(0);
  });
});

describe("artifact kinds from labels", () => {
  it("recovers the kind the server put into the label", () => {
    expect(artifactKindFromLabel("email draft A-5")).toBe("email_draft");
    expect(artifactKindFromLabel("github issue A-12")).toBe("github_issue");
    expect(artifactKindFromLabel("calendar event A-15")).toBe("calendar_event");
    expect(artifactKindFromLabel("code snippet A-6")).toBe("code_snippet");
    expect(artifactKindFromLabel("decision A-3")).toBe("decision");
    expect(artifactKindFromLabel("note A-10")).toBe("note");
    expect(artifactKindFromLabel("mystery A-1")).toBeNull();
    expect(artifactKindFromLabel("")).toBeNull();
  });
});

describe("cross-session stats", () => {
  // three sessions: s1 and s2 share the entity "oauth"; s3 is isolated; s2 and s3 never meet
  const nodes: GraphNode[] = [
    session("s1", 10),
    session("s2", 20, "pocket"),
    session("s3", 30),
    thought("t1", "s1", 11, "bug"),
    thought("t2", "s2", 21, "bug"),
    thought("t3", "s3", 31, "idea"),
    thought("t4", "s1", 12, "idea"),
    entity("oauth"),
    entity("solo"),
  ];
  const edges: GraphEdge[] = [
    edge("in_session", "t1", "s1"),
    edge("in_session", "t2", "s2"),
    edge("in_session", "t3", "s3"),
    edge("mentions", "t1", "oauth"),
    edge("mentions", "t2", "oauth"),
    edge("mentions", "t4", "solo"),
  ];

  it("counts sessions linked by shared entities", () => {
    const s = computeStats(nodes, edges);
    expect(s.sessions).toBe(3);
    expect(s.bridgeEntities).toBe(1);
    expect(s.linkedSessions).toBe(2);
    expect(s.crossSemantic).toBe(0);
    expect(s.nodes).toBe(9);
    expect(s.edges).toBe(6);
    expect(s.kinds.thought).toBe(4);
    expect(s.kinds.entity).toBe(2);
    expect(s.entitySessions.get("oauth")?.sort()).toEqual(["s1", "s2"]);
    expect(s.entitySessions.get("solo")).toEqual(["s1"]);
    expect(linkSummary(s)).toBe("2 sessions linked by 1 entity");
  });

  it("also links sessions through cross-session semantic edges", () => {
    const s = computeStats(nodes, [...edges, edge("same_topic", "t3", "t1", 0.9)]);
    expect(s.crossSemantic).toBe(1);
    expect(s.linkedSessions).toBe(3);
    expect(linkSummary(s)).toBe("3 sessions linked by 1 entity");
  });

  it("does not count semantic edges inside one session as links between sessions", () => {
    const s = computeStats(nodes, [edge("same_topic", "t1", "t4", 0.9)]);
    expect(s.crossSemantic).toBe(0);
    expect(s.linkedSessions).toBe(0);
    expect(linkSummary(s)).toBe("3 sessions, not linked yet");
  });

  it("describes a graph linked only by semantic edges", () => {
    const s = computeStats(nodes, [edge("answers", "t1", "t2", 0.7)]);
    expect(s.bridgeEntities).toBe(0);
    expect(s.linkedSessions).toBe(2);
    expect(linkSummary(s)).toBe("2 sessions linked by 1 semantic link");
  });

  it("tallies categories and thoughts per session, oldest session first", () => {
    const s = computeStats(nodes, edges);
    expect(s.categories[0]).toEqual(["bug", 2]);
    expect(s.categories.find(([c]) => c === "idea")?.[1]).toBe(2);
    expect(s.sessionList.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s.sessionList[0]?.thoughts).toBe(2);
    expect(s.sessionList[1]?.deviceKind).toBe("pocket");
  });

  it("is empty-safe", () => {
    const s = computeStats([], []);
    expect(s.sessions).toBe(0);
    expect(linkSummary(s)).toBe("");
  });
});

describe("detail panel lists", () => {
  const nodes: GraphNode[] = [
    session("s1", 1),
    thought("t2", "s1", 20),
    thought("t1", "s1", 10),
    { id: "d1", kind: "decision", label: "decide", category: "decision", sessionId: "s1", createdAt: 30 },
    entity("e1"),
    { id: "a1", kind: "artifact", label: "note A-1", createdAt: 11, sessionId: "s1" },
  ];
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const edges: GraphEdge[] = [edge("mentions", "t1", "e1"), edge("mentions", "d1", "e1"), edge("mentions", "t1", "e1"), edge("produced", "t1", "a1"), edge("same_topic", "t2", "t1", 0.8)];

  it("lists a session's thoughts and decisions oldest first", () => {
    expect(thoughtsOfSession("s1", nodes).map((x) => x.id)).toEqual(["t1", "t2", "d1"]);
    expect(thoughtsOfSession("nope", nodes)).toEqual([]);
  });

  it("lists the thoughts mentioning an entity once each", () => {
    expect(thoughtsMentioning("e1", byId, edges).map((x) => x.id)).toEqual(["t1", "d1"]);
  });

  it("finds an artifact's producer and a node's neighbours with direction", () => {
    expect(producerOf("a1", byId, edges)?.id).toBe("t1");
    expect(producerOf("zzz", byId, edges)).toBeUndefined();
    const nb = neighborsOf("t1", byId, edges);
    const sem = nb.find((x) => x.edge.type === "same_topic");
    expect(sem?.node.id).toBe("t2");
    expect(sem?.outgoing).toBe(false);
    expect(nb.find((x) => x.edge.type === "produced")?.outgoing).toBe(true);
  });
});
