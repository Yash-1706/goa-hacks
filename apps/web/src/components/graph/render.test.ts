import type { GraphEdge, GraphNode } from "@synapse/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphCache } from "@/lib/graph-cache";
import { qualityFor } from "@/lib/graph-style";
import { GraphRenderer, type RenderView } from "./render";

/* The painter is canvas code, but its decisions (what is hidden, dimmed, animated) and its robustness
 * (no throw for any node kind in any state) are testable with a recording stand-in for the 2D context. */

interface Call {
  op: string;
  args: unknown[];
}

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[]; sets: Record<string, unknown> } {
  const calls: Call[] = [];
  const sets: Record<string, unknown> = {};
  const store: Record<string, unknown> = {};
  const canvas = { width: 1200, height: 800 };
  const ctx = new Proxy(store, {
    get(t, p: string) {
      if (p === "canvas") return canvas;
      if (p === "measureText") return (s: string) => ({ width: s.length * 6 });
      if (p === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 600, f: 400 });
      if (p === "createRadialGradient") return () => ({ addColorStop: () => undefined });
      if (p in t) return t[p];
      return (...args: unknown[]) => {
        calls.push({ op: p, args });
      };
    },
    set(t, p: string, v) {
      t[p] = v;
      sets[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, sets };
}

const T0 = 1_700_000_000_000;
const H = 3_600_000;
const nodes: GraphNode[] = [
  { id: "s1", kind: "session", label: "S-1 · desk", createdAt: T0, deviceKind: "desk", activity: "desk", promoted: true },
  { id: "s2", kind: "session", label: "S-2 · pocket", createdAt: T0 + 10, deviceKind: "pocket", activity: "walking", promoted: true },
  { id: "t1", kind: "thought", label: "Null pointer in cart-service", category: "bug", sessionId: "s1", createdAt: T0 + 20, expiresAt: T0 + 20 + 72 * H, promoted: false, salience: 0.4 },
  { id: "t2", kind: "thought", label: "Email the team", category: "communication", sessionId: "s2", createdAt: T0 + 30, expiresAt: null, promoted: true, salience: 0.8 },
  { id: "d1", kind: "decision", label: "Auth: OAuth2 over JWT", category: "decision", sessionId: "s1", createdAt: T0 + 40, expiresAt: T0 + 40 + 72 * H, promoted: false },
  { id: "e1", kind: "entity", label: "OAuth2", entityType: "technology", createdAt: T0 + 50, expiresAt: null, promoted: true, salience: 0.9 },
  { id: "e2", kind: "entity", label: "Sarah", entityType: "person", createdAt: T0 + 55, expiresAt: T0 + 55 + 72 * H, promoted: false, salience: 0.3 },
  { id: "a1", kind: "artifact", label: "github issue A-1", createdAt: T0 + 60, sessionId: "s1", expiresAt: null, promoted: true },
  { id: "a2", kind: "artifact", label: "email draft A-2", createdAt: T0 + 61, sessionId: "s2", expiresAt: null, promoted: true },
  { id: "a3", kind: "artifact", label: "something odd A-3", createdAt: T0 + 62, sessionId: "s2", expiresAt: null, promoted: true },
  { id: "o1", kind: "open_loop", label: "What did Sarah say?", createdAt: T0 + 70, sessionId: "s1", expiresAt: T0 + 70 + 72 * H, promoted: false },
];
const ed = (type: GraphEdge["type"], src: string, dst: string, weight = 1): GraphEdge => ({ id: `${type}:${src}>${dst}`, src, dst, type, weight });
const edges: GraphEdge[] = [
  ed("in_session", "t1", "s1"),
  ed("in_session", "t2", "s2"),
  ed("in_session", "d1", "s1"),
  ed("mentions", "t1", "e1"),
  ed("mentions", "t2", "e1"),
  ed("mentions", "d1", "e2"),
  ed("produced", "t1", "a1"),
  ed("produced", "t2", "a2"),
  ed("produced", "t2", "a3"),
  ed("same_topic", "t2", "t1", 0.9),
  ed("refines", "t2", "t1", 0.7),
  ed("answers", "d1", "o1", 0.6),
  ed("mentions", "t1", "o1"),
  ed("related", "e1", "e2"),
];

function setup(over: Partial<RenderView> = {}) {
  const cache = new GraphCache();
  const res = cache.sync({ nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: Object.fromEntries(edges.map((e) => [e.id, e])), t: Infinity, perf: 1000, animate: true });
  // give everything a position (the engine does this in the browser)
  res.nodes.forEach((n, i) => {
    n.x = (i % 4) * 90 - 120;
    n.y = Math.floor(i / 4) * 80 - 90;
  });
  const view: RenderView = {
    selectedId: null,
    hoverId: null,
    emphasisId: null,
    hoverLink: null,
    focus: null,
    hiddenEdgeTypes: new Set(),
    categories: new Set(),
    alwaysLabels: false,
    motion: true,
    quality: qualityFor(res.nodes.length),
    wall: () => T0 + 5 * H,
    ...over,
  };
  const renderer = new GraphRenderer(cache, view, () => 2);
  return { cache, view, renderer, res };
}

const saved = { document: (globalThis as { document?: unknown }).document, gcs: (globalThis as { getComputedStyle?: unknown }).getComputedStyle };
beforeAll(() => {
  const sprite = () => ({ width: 0, height: 0, getContext: () => fakeCtx().ctx });
  (globalThis as { document?: unknown }).document = { createElement: sprite, documentElement: {} };
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({ fontSize: "14.2px" });
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = saved.document;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = saved.gcs;
});

function frame(renderer: GraphRenderer, ctx: CanvasRenderingContext2D, scale: number, res: { nodes: readonly unknown[]; links: readonly unknown[] }): void {
  renderer.beginFrame(ctx, scale);
  for (const l of res.links) if ((l as { semantic: boolean }).semantic) renderer.paintLink(l as object, ctx, scale);
  for (const n of res.nodes) renderer.paintNode(n as object, ctx, scale);
  renderer.endFrame(ctx, scale);
}

describe("GraphRenderer link accessors", () => {
  it("hands only semantic links to the custom painter", () => {
    const { renderer, res } = setup();
    for (const l of res.links) expect(renderer.linkMode(l)).toBe(l.semantic ? "replace" : "none");
    expect(res.links.some((l) => l.semantic)).toBe(true);
  });

  it("hides link types the legend switched off", () => {
    const { renderer, view, res } = setup();
    const mentions = res.links.find((l) => l.type === "mentions");
    expect(renderer.linkVisible(mentions as object)).toBe(true);
    view.hiddenEdgeTypes = new Set(["mentions"]);
    expect(renderer.linkVisible(mentions as object)).toBe(false);
  });

  it("dims links outside the selection and keeps the ones around it", () => {
    const { renderer, view, cache, res } = setup();
    const near = res.links.find((l) => l.type === "mentions" && l.source.id === "t1" && l.target.id === "e1");
    const far = res.links.find((l) => l.type === "mentions" && l.source.id === "d1");
    const h = cache.neighborhood("t1");
    view.focus = { id: "t1", strength: "selected", nodes: h.nodes, links: h.links };
    const alpha = (s: string): number => Number(/,([\d.]+)\)$/.exec(s)?.[1]);
    renderer.beginFrame(fakeCtx().ctx, 1);
    const colorNear = renderer.linkColor(near as object);
    const colorFar = renderer.linkColor(far as object);
    expect(alpha(colorNear)).toBeGreaterThan(alpha(colorFar) * 3);
    expect(renderer.linkWidth(near as object)).toBeGreaterThan(renderer.linkWidth(far as object));
  });

  it("sends particles along semantic links only, and not under reduced motion or on huge graphs", () => {
    const { renderer, view, res } = setup();
    const sem = res.links.find((l) => l.type === "same_topic") as object;
    const plain = res.links.find((l) => l.type === "mentions") as object;
    expect(renderer.particles(sem)).toBeGreaterThan(0);
    expect(renderer.particles(plain)).toBe(0);
    view.motion = false;
    expect(renderer.particles(sem)).toBe(0);
    view.motion = true;
    view.quality = qualityFor(900);
    expect(renderer.particles(sem)).toBe(0);
  });

  it("flows faster along stronger links", () => {
    const { renderer, res } = setup();
    const strong = res.links.find((l) => l.type === "same_topic") as object;
    const weak = res.links.find((l) => l.type === "answers") as object;
    expect(renderer.particleSpeed(strong)).toBeGreaterThan(renderer.particleSpeed(weak));
  });

  it("sizes nodes for the engine so zoom-to-fit includes rings and squares", () => {
    const { renderer, res } = setup();
    const session = res.nodes.find((n) => n.kind === "session");
    const dot = res.nodes.find((n) => n.kind === "thought");
    expect(renderer.nodeVal(session as object)).toBeGreaterThan(renderer.nodeVal(dot as object));
  });
});

describe("GraphRenderer painting", () => {
  it.each([
    ["high quality, full motion", { quality: qualityFor(40), motion: true }],
    ["low quality", { quality: qualityFor(900), motion: true }],
    ["reduced motion", { quality: qualityFor(40, { reduced: true }), motion: false }],
  ])("paints every node kind without throwing (%s)", (_name, over) => {
    const { renderer, res } = setup(over);
    const { ctx, calls } = fakeCtx();
    for (const scale of [0.3, 0.8, 1.5, 4]) {
      calls.length = 0;
      frame(renderer, ctx, scale, res);
      expect(calls.length).toBeGreaterThan(res.nodes.length); // it drew something for each node
    }
  });

  it("keeps the ctx state balanced: every save is restored", () => {
    const { renderer, res } = setup();
    const { ctx, calls } = fakeCtx();
    frame(renderer, ctx, 1, res);
    const saves = calls.filter((c) => c.op === "save").length;
    const restores = calls.filter((c) => c.op === "restore").length;
    expect(saves).toBe(restores);
  });

  it("paints selection, hover, focus, pills and ghosts", () => {
    const { renderer, view, cache, res } = setup();
    const h = cache.neighborhood("t1");
    view.selectedId = "t1";
    view.hoverId = "e1";
    view.hoverLink = res.links.find((l) => l.semantic) ?? null;
    view.focus = { id: "t1", strength: "selected", nodes: h.nodes, links: h.links };
    view.alwaysLabels = true;
    cache.node("o1")!.dying = 1000;
    const { ctx, calls } = fakeCtx();
    frame(renderer, ctx, 1.2, res);
    expect(calls.some((c) => c.op === "fillText")).toBe(true); // labels / captions
    expect(calls.some((c) => c.op === "strokeText")).toBe(true); // label outlines
  });

  it("names the sessions when zoomed out, and more once zoomed in", () => {
    const { renderer, res } = setup();
    const labelsAt = (scale: number): string[] => {
      const { ctx, calls } = fakeCtx();
      frame(renderer, ctx, scale, res);
      return calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    };
    const far = labelsAt(0.3);
    expect(far).toContain("S-1 · desk");
    expect(far).not.toContain("Null pointer in cart-service");
    const near = labelsAt(2.5);
    expect(near).toContain("S-1 · desk");
    expect(near).toContain("Null pointer in cart-service");
    expect(near.length).toBeGreaterThan(far.length);
  });

  it("waits until you zoom in to name thoughts when the graph is dense", () => {
    const many: GraphNode[] = Array.from({ length: 80 }, (_, i) => ({ id: "x" + i, kind: "thought" as const, label: "Dense thought " + i, category: "idea" as const, sessionId: "s1", createdAt: T0 + 100 + i, expiresAt: null, promoted: true, salience: 0.5 }));
    const cache = new GraphCache();
    const all = [...nodes, ...many];
    const res = cache.sync({ nodes: Object.fromEntries(all.map((n) => [n.id, n])), edges: Object.fromEntries([...edges, ...many.map((n) => ed("in_session", n.id, "s1"))].map((e) => [e.id, e])), t: Infinity, perf: 1000, animate: true });
    res.nodes.forEach((n, i) => {
      n.x = (i % 12) * 70 - 400;
      n.y = Math.floor(i / 12) * 70 - 300;
    });
    const view: RenderView = { selectedId: null, hoverId: null, emphasisId: null, hoverLink: null, focus: null, hiddenEdgeTypes: new Set(), categories: new Set(), alwaysLabels: false, motion: true, quality: qualityFor(res.nodes.length), wall: () => T0, };
    const renderer = new GraphRenderer(cache, view, () => 1);
    const thoughtLabels = (scale: number): number => {
      const { ctx, calls } = fakeCtx();
      frame(renderer, ctx, scale, res);
      return calls.filter((c) => c.op === "fillText" && String(c.args[0]).startsWith("Dense thought")).length;
    };
    expect(res.nodes.length).toBeGreaterThan(70);
    expect(thoughtLabels(1)).toBe(0);
    expect(thoughtLabels(1.6)).toBeGreaterThan(0);
    view.alwaysLabels = true;
    expect(thoughtLabels(1)).toBeGreaterThan(0);
  });

  it("skips nodes that are not born yet (the intro bloom) and tolerates a missing position", () => {
    const { renderer, res } = setup();
    const { ctx, calls } = fakeCtx();
    renderer.beginFrame(ctx, 1);
    const n = res.nodes.find((x) => x.kind === "thought")!;
    n.born = performance.now() + 60_000;
    calls.length = 0;
    renderer.paintNode(n, ctx, 1);
    expect(calls.length).toBe(0);
    n.born = Number.NEGATIVE_INFINITY;
    n.x = undefined;
    renderer.paintNode(n, ctx, 1);
    expect(calls.length).toBe(0);
  });

  it("answers the pointer only where something can be hovered", () => {
    const { renderer, res } = setup();
    const { ctx, calls } = fakeCtx();
    const sem = res.links.find((l) => l.semantic)!;
    const plain = res.links.find((l) => l.type === "mentions")!;
    renderer.beginFrame(ctx, 1);
    calls.length = 0;
    renderer.paintLinkPointer(plain, "#010203", ctx, 1);
    expect(calls.length).toBe(0);
    renderer.paintLinkPointer(sem, "#010203", ctx, 1);
    expect(calls.some((c) => c.op === "stroke")).toBe(true);
    calls.length = 0;
    renderer.paintPointer(res.nodes[0]!, "#040506", ctx, 1);
    expect(calls.some((c) => c.op === "arc")).toBe(true);
  });

  it("reports sustained slow frames so the owner can drop a quality tier", () => {
    const { renderer, res } = setup();
    let slow = 0;
    renderer.onSlow = () => slow++;
    const { ctx } = fakeCtx();
    const realNow = performance.now.bind(performance);
    let clock = 0;
    performance.now = () => (clock += 40); // 40 ms between every reading: 25 fps
    try {
      for (let i = 0; i < 150; i++) frame(renderer, ctx, 1, res);
    } finally {
      performance.now = realNow;
    }
    expect(slow).toBeGreaterThanOrEqual(1);
  });
});
