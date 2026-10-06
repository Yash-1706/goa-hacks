import type { GraphEdge, GraphNode } from "@synapse/shared";
import { describe, expect, it } from "vitest";
import { GHOST_MS, GraphCache, PULSE_MS, type SyncInput } from "./graph-cache";

const T0 = 1_000_000;
const sess = (id: string, at: number, deviceKind: "desk" | "pocket" = "desk"): GraphNode => ({ id, kind: "session", label: `S-${id}`, createdAt: at, deviceKind, promoted: true });
const th = (id: string, sessionId: string, at: number, extra: Partial<GraphNode> = {}): GraphNode => ({ id, kind: "thought", label: `thought ${id}`, category: "idea", sessionId, createdAt: at, expiresAt: at + 72 * 3_600_000, promoted: false, salience: 0.4, ...extra });
const ent = (id: string, at: number): GraphNode => ({ id, kind: "entity", label: id, entityType: "technology", createdAt: at, expiresAt: null, promoted: true, salience: 0.5 });
const art = (id: string, at: number, sessionId: string): GraphNode => ({ id, kind: "artifact", label: `note ${id}`, createdAt: at, sessionId });
const ed = (type: GraphEdge["type"], src: string, dst: string, weight = 1): GraphEdge => ({ id: `${type}:${src}>${dst}`, src, dst, type, weight });

const rec = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));

function world() {
  const nodes = [sess("s1", T0), sess("s2", T0 + 100), th("t1", "s1", T0 + 10), th("t2", "s2", T0 + 110), ent("e1", T0 + 20), art("a1", T0 + 30, "s1")];
  const edges = [ed("in_session", "t1", "s1"), ed("in_session", "t2", "s2"), ed("mentions", "t1", "e1"), ed("mentions", "t2", "e1"), ed("produced", "t1", "a1"), ed("same_topic", "t2", "t1", 0.9)];
  return { nodes: rec(nodes), edges: rec(edges) };
}

const input = (w: ReturnType<typeof world>, over: Partial<SyncInput> = {}): SyncInput => ({ nodes: w.nodes, edges: w.edges, t: Infinity, perf: 1000, animate: true, ...over });
const ids = (xs: ReadonlyArray<{ id: string }>): string[] => xs.map((x) => x.id).sort();

describe("GraphCache: object identity", () => {
  it("keeps node and link objects stable across syncs (react-force-graph mutates them)", () => {
    const c = new GraphCache();
    const w = world();
    const r1 = c.sync(input(w));
    const t1 = c.node("t1");
    const link = r1.links.find((l) => l.type === "same_topic");
    expect(t1).toBeDefined();
    (t1 as { x?: number }).x = 123.5; // the engine writes positions into it
    const r2 = c.sync(input(w, { perf: 2000 }));
    expect(c.node("t1")).toBe(t1);
    expect((c.node("t1") as { x?: number }).x).toBe(123.5);
    expect(r2.links.find((l) => l.type === "same_topic")).toBe(link);
    // nothing changed: the SAME arrays come back, so the engine is not handed new data (no re-heat)
    expect(r2.changed).toBe(false);
    expect(r2.nodes).toBe(r1.nodes);
    expect(r2.links).toBe(r1.links);
  });

  it("patches a node in place when the store hands over new data (same object, new fields)", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w));
    const t1 = c.node("t1");
    const next = { ...w.nodes.t1, label: "renamed", salience: 1 } as GraphNode;
    const r = c.sync(input({ nodes: { ...w.nodes, t1: next }, edges: w.edges }, { perf: 2000 }));
    expect(c.node("t1")).toBe(t1);
    expect(t1?.label).toBe("renamed");
    expect(t1?.data).toBe(next);
    expect(r.changed).toBe(false); // a patch is not a structural change
  });

  it("flashes a node when it is promoted into long-term memory", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w));
    expect(c.node("t1")?.promotedAt).toBe(Number.NEGATIVE_INFINITY);
    c.sync(input({ nodes: { ...w.nodes, t1: { ...w.nodes.t1, promoted: true, expiresAt: null } as GraphNode }, edges: w.edges }, { perf: 4321 }));
    expect(c.node("t1")?.promotedAt).toBe(4321);
  });
});

describe("GraphCache: time filtering", () => {
  it("shows only what was created at or before t, and edges only when both ends exist", () => {
    const c = new GraphCache();
    const w = world();
    const r = c.sync(input(w, { t: T0 + 15 }));
    // s1 and t1 exist; s2/t2 are in the future; e1 (T0+20) and a1 (T0+30) not yet
    expect(ids(r.nodes)).toEqual(["s1", "t1"]);
    expect(ids(r.links)).toEqual(["in_session:t1>s1"]);
  });

  it("introduces entities and artifacts only together with a thought that mentions / produced them", () => {
    const c = new GraphCache();
    const w = world();
    // t = T0+40: s1, t1, e1 (created T0+20), a1 (T0+30) all exist, and their thought t1 is on screen
    const r = c.sync(input(w, { t: T0 + 40 }));
    expect(ids(r.nodes)).toEqual(["a1", "e1", "s1", "t1"]);
    expect(ids(r.links)).toEqual(["in_session:t1>s1", "mentions:t1>e1", "produced:t1>a1"]);
  });

  it("never shows an orphan entity whose thoughts are all in the future", () => {
    const c = new GraphCache();
    const nodes = rec([sess("s1", T0), th("t1", "s1", T0 + 500), ent("e1", T0 + 5)]); // entity first seen BEFORE its thought exists
    const edges = rec([ed("in_session", "t1", "s1"), ed("mentions", "t1", "e1")]);
    const early = c.sync({ nodes, edges, t: T0 + 100, perf: 1, animate: true });
    expect(ids(early.nodes)).toEqual(["s1"]);
    const later = c.sync({ nodes, edges, t: T0 + 600, perf: 2, animate: true });
    expect(ids(later.nodes)).toEqual(["e1", "s1", "t1"]);
  });

  it("scrubbing back removes nodes and links again, scrubbing forward restores the same objects", () => {
    const c = new GraphCache();
    const w = world();
    const full = c.sync(input(w));
    const t2 = c.node("t2");
    const back = c.sync(input(w, { t: T0 + 15, perf: 2000 }));
    expect(back.changed).toBe(true);
    expect(ids(back.hidden)).toContain("t2");
    expect(back.nodes).not.toContain(t2);
    const fwd = c.sync(input(w, { perf: 3000 }));
    expect(fwd.nodes).toContain(t2);
    expect(c.node("t2")).toBe(t2);
    expect(ids(fwd.nodes)).toEqual(ids(full.nodes));
    expect(ids(fwd.links)).toEqual(ids(full.links));
  });

  it("reports births and gives them a pop-in start time", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w, { t: T0 + 15, perf: 1000 }));
    const r = c.sync(input(w, { t: T0 + 115, perf: 5000 }));
    expect(ids(r.born)).toContain("t2");
    expect(c.node("t2")?.born).toBe(5000);
    // scrubbing is not "live": no lingering pulse
    expect(c.node("t2")?.pulseUntil).toBe(0);
  });
});

describe("GraphCache: live arrivals", () => {
  it("pulses nodes that arrive while live, and links fade in just after them", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w, { perf: 1000 }));
    const t3 = th("t3", "s1", T0 + 900);
    const w2 = { nodes: { ...w.nodes, t3 }, edges: { ...w.edges, "in_session:t3>s1": ed("in_session", "t3", "s1") } };
    const r = c.sync(input(w2, { perf: 7000 }));
    expect(r.changed).toBe(true);
    expect(ids(r.born)).toEqual(["t3"]);
    const n = c.node("t3");
    expect(n?.born).toBe(7000);
    expect(n?.pulseUntil).toBe(7000 + PULSE_MS);
    const link = r.links.find((l) => l.id === "in_session:t3>s1");
    expect(link?.born).toBeGreaterThan(7000);
  });

  it("seeds a new thought next to its session, not at the origin", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w, { perf: 1000 }));
    const s1 = c.node("s1") as { x: number; y: number };
    const t3 = th("t3", "s1", T0 + 900);
    c.sync(input({ nodes: { ...w.nodes, t3 }, edges: w.edges }, { perf: 2000 }));
    const n = c.node("t3") as { x: number; y: number };
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Math.hypot(n.x - s1.x, n.y - s1.y)).toBeLessThan(80);
  });

  it("does not pop or pulse anything on the first paint without the intro, and staggers it with the intro", () => {
    const w = world();
    const plain = new GraphCache();
    plain.sync(input(w));
    for (const n of plain.visibleNodes()) expect(n.born).toBe(Number.NEGATIVE_INFINITY);
    expect(plain.node("t1")?.pulseUntil).toBe(0);

    const intro = new GraphCache();
    intro.sync(input(w, { intro: true, perf: 100 }));
    const births = ["s1", "t1", "e1", "a1", "s2", "t2"].map((id) => intro.node(id)?.born as number);
    expect(births.every((b) => b >= 100)).toBe(true);
    expect(new Set(births).size).toBe(births.length); // a staggered bloom, chronological
    expect((intro.node("t1")?.born as number) < (intro.node("t2")?.born as number)).toBe(true);
  });

  it("skips every animation when motion is reduced", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w, { animate: false, intro: true }));
    for (const id of Object.keys(w.nodes)) expect(c.node(id)?.born).toBe(Number.NEGATIVE_INFINITY);
    const t3 = th("t3", "s1", T0 + 900);
    c.sync(input({ nodes: { ...w.nodes, t3 }, edges: w.edges }, { animate: false, perf: 9000 }));
    expect(c.node("t3")?.born).toBe(Number.NEGATIVE_INFINITY);
    expect(c.node("t3")?.pulseUntil).toBe(0);
  });
});

describe("GraphCache: reopening the screen", () => {
  it("replays the bloom in place: same objects, same positions, new chronological birth times", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w));
    const t1 = c.node("t1");
    (t1 as { x?: number }).x = 42.5;
    c.rewind(5000, true);
    expect(c.node("t1")).toBe(t1);
    expect((c.node("t1") as { x?: number }).x).toBe(42.5);
    const births = ["s1", "t1", "e1", "a1", "s2", "t2"].map((id) => c.node(id)?.born as number);
    expect(births.every((b) => b >= 5000)).toBe(true);
    expect(c.node("t1")?.born as number).toBeLessThan(c.node("t2")?.born as number);
    // links follow their later end
    for (const l of c.visibleLinks()) expect(l.born).toBeGreaterThanOrEqual(Math.max(l.source.born, l.target.born));
  });

  it("cancels a bloom that an earlier visit scheduled when motion is reduced", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w));
    c.rewind(5000, true);
    c.rewind(6000, false);
    for (const n of c.visibleNodes()) {
      expect(n.born).toBe(Number.NEGATIVE_INFINITY);
      expect(n.pulseUntil).toBe(0);
    }
    for (const l of c.visibleLinks()) expect(l.born).toBe(Number.NEGATIVE_INFINITY);
  });

  it("does nothing on an empty cache", () => {
    const c = new GraphCache();
    expect(() => c.rewind(1, true)).not.toThrow();
    expect(c.size).toBe(0);
  });
});

describe("GraphCache: deletions (forget)", () => {
  it("keeps a forgotten node on screen for its exit, then drops it with its links", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w, { perf: 1000 }));
    const { t2: _gone, ...rest } = w.nodes;
    void _gone;
    const edgesWithout = Object.fromEntries(Object.entries(w.edges).filter(([, e]) => e.src !== "t2" && e.dst !== "t2"));
    const r1 = c.sync({ nodes: rest, edges: edgesWithout, t: Infinity, perf: 2000, animate: true });
    expect(r1.changed).toBe(true);
    expect(ids(r1.nodes)).toContain("t2");
    expect(c.node("t2")?.dying).toBe(2000);
    expect(r1.nextGhostEnd).toBe(2000 + GHOST_MS);
    expect(r1.links.some((l) => l.source.id === "t2" || l.target.id === "t2")).toBe(true); // ghost links
    const r2 = c.sync({ nodes: rest, edges: edgesWithout, t: Infinity, perf: 2000 + GHOST_MS + 1, animate: true });
    expect(r2.changed).toBe(true);
    expect(ids(r2.nodes)).not.toContain("t2");
    expect(r2.links.some((l) => l.source.id === "t2" || l.target.id === "t2")).toBe(false);
    expect(c.has("t2")).toBe(false);
  });

  it("drops a node immediately when it was not on screen or motion is reduced", () => {
    const w = world();
    const calm = new GraphCache();
    calm.sync(input(w, { animate: false }));
    const { t2: _x, ...rest } = w.nodes;
    void _x;
    const r = calm.sync({ nodes: rest, edges: {}, t: Infinity, perf: 5, animate: false });
    expect(ids(r.nodes)).not.toContain("t2");
    expect(r.nextGhostEnd).toBeNull();

    const hiddenOne = new GraphCache();
    hiddenOne.sync(input(w, { t: T0 + 15 })); // t2 not visible yet
    const r2 = hiddenOne.sync({ nodes: rest, edges: {}, t: T0 + 15, perf: 5, animate: true });
    expect(hiddenOne.has("t2")).toBe(false);
    expect(r2.nextGhostEnd).toBeNull();
  });
});

describe("GraphCache: derived data", () => {
  it("knows which sessions an entity bridges, and tints artifacts like the thought that made them", () => {
    const c = new GraphCache();
    const w = world();
    w.nodes.t1 = { ...w.nodes.t1, category: "bug" } as GraphNode;
    c.sync(input(w));
    expect([...(c.node("e1")?.sessions ?? [])].sort()).toEqual(["s1", "s2"]);
    expect(c.node("a1")?.tint).toBe("bug");
    expect(c.node("a1")?.color).toBe("#fb7185");
  });

  it("gives sessions their stable colour and grows rings with their thoughts", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w));
    const a = c.node("s1")?.color;
    const b = c.node("s2")?.color;
    expect(a).not.toBe(b);
    // hide s2 with the scrubber: its colour must survive
    c.sync(input(w, { t: T0 + 15, perf: 2 }));
    c.sync(input(w, { perf: 3 }));
    expect(c.node("s1")?.color).toBe(a);
    expect(c.node("s2")?.color).toBe(b);
  });

  it("fans out parallel edges between the same two thoughts", () => {
    const c = new GraphCache();
    const w = world();
    const extra = ed("refines", "t2", "t1", 0.8);
    c.sync(input({ nodes: w.nodes, edges: { ...w.edges, [extra.id]: extra } }));
    const r = c.sync(input({ nodes: w.nodes, edges: { ...w.edges, [extra.id]: extra } }, { perf: 9 }));
    const a = r.links.find((l) => l.type === "same_topic");
    const b = r.links.find((l) => l.type === "refines");
    expect(a?.curv).not.toBe(b?.curv);
    expect(Math.sign(a?.curv ?? 0)).not.toBe(Math.sign(b?.curv ?? 0));
  });

  it("returns the one-hop neighbourhood of a node among visible links", () => {
    const c = new GraphCache();
    const w = world();
    c.sync(input(w));
    const hood = c.neighborhood("t1");
    expect([...hood.nodes].sort()).toEqual(["a1", "e1", "s1", "t1", "t2"]);
    expect(hood.links.has("same_topic:t2>t1")).toBe(true);
    expect(hood.links.has("in_session:t2>s2")).toBe(false);
  });

  it("ignores edges whose ends are unknown", () => {
    const c = new GraphCache();
    const w = world();
    const r = c.sync(input({ nodes: w.nodes, edges: { ...w.edges, bad: ed("mentions", "t1", "ghost") } }));
    expect(r.links.some((l) => l.id === "bad")).toBe(false);
  });

  it("starts positions from finite numbers, never NaN", () => {
    const c = new GraphCache();
    const r = c.sync(input(world()));
    for (const n of r.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
