import type { GraphNode } from "@synapse/shared";
import { describe, expect, it } from "vitest";
import {
  ENTITY_COLORS,
  SessionColors,
  TTL_FLOOR,
  edgeCaption,
  edgeVisual,
  entityColor,
  hexToRgb,
  hslToHex,
  isLongTerm,
  isSemanticEdge,
  nodeColor,
  nodeRadius,
  nodeShape,
  particleCount,
  popScale,
  qualityFor,
  sessionColorAt,
  ttlFraction,
  ttlOpacity,
  withAlpha,
} from "./graph-style";

const H = 3_600_000;
const node = (over: Partial<GraphNode> = {}): GraphNode => ({ id: "n", kind: "thought", label: "x", createdAt: 0, ...over });

describe("colour helpers", () => {
  it("converts HSL to hex and back to rgb", () => {
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 50)).toBe("#00ff00");
    expect(hslToHex(240, 100, 50)).toBe("#0000ff");
    expect(hexToRgb("#8b5cf6")).toEqual([139, 92, 246]);
    expect(hexToRgb("garbage")).toEqual([148, 163, 184]);
  });

  it("wraps hue and clamps saturation / lightness", () => {
    expect(hslToHex(360, 100, 50)).toBe(hslToHex(0, 100, 50));
    expect(hslToHex(-120, 100, 50)).toBe(hslToHex(240, 100, 50));
    expect(hslToHex(10, 500, 200)).toBe("#ffffff");
  });

  it("builds rgba strings with quantised alpha", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
    expect(withAlpha("#ff0000", 0.501)).toBe("rgba(255,0,0,0.5)");
    expect(withAlpha("#ff0000", 4)).toBe("rgba(255,0,0,1)");
    expect(withAlpha("#ff0000", -1)).toBe("rgba(255,0,0,0)");
  });
});

describe("session colours", () => {
  it("gives distinct colours to many sessions", () => {
    const colours = new Set(Array.from({ length: 12 }, (_, i) => sessionColorAt(i)));
    expect(colours.size).toBe(12);
  });

  it("assigns in creation order and never changes a colour afterwards", () => {
    const c = new SessionColors();
    c.assign([
      { id: "b", createdAt: 200 },
      { id: "a", createdAt: 100 },
    ]);
    const a = c.get("a");
    const b = c.get("b");
    expect(a).toBe(sessionColorAt(0));
    expect(b).toBe(sessionColorAt(1));
    // a new, EARLIER session arriving later must not recolour the others
    c.assign([
      { id: "z", createdAt: 1 },
      { id: "a", createdAt: 100 },
      { id: "b", createdAt: 200 },
    ]);
    expect(c.get("a")).toBe(a);
    expect(c.get("b")).toBe(b);
    expect(c.get("z")).toBe(sessionColorAt(2));
    expect(c.get(undefined)).toBe("#94a3b8");
    expect(c.has("nope")).toBe(false);
  });
});

describe("node styling by kind", () => {
  it("maps kinds to shapes: ring, dot, square, diamond, glyph", () => {
    expect(nodeShape("session")).toBe("ring");
    expect(nodeShape("thought")).toBe("dot");
    expect(nodeShape("entity")).toBe("square");
    expect(nodeShape("decision")).toBe("diamond");
    expect(nodeShape("artifact")).toBe("glyph");
    expect(nodeShape("open_loop")).toBe("loop");
  });

  it("colours thoughts by category, entities by type, sessions by their own colour", () => {
    expect(nodeColor({ kind: "thought", category: "bug" })).toBe("#fb7185");
    expect(nodeColor({ kind: "decision", category: "decision" })).toBe("#e879f9");
    expect(nodeColor({ kind: "entity", entityType: "person" })).toBe(ENTITY_COLORS.person);
    expect(nodeColor({ kind: "session" }, "#123456")).toBe("#123456");
    expect(nodeColor({ kind: "artifact" }, undefined, "code")).toBe("#34d399");
    expect(entityColor(undefined)).toBe(ENTITY_COLORS.topic);
  });

  it("sizes: sessions are the largest, entities grow with salience, artifacts are small", () => {
    const session = nodeRadius({ kind: "session" }, { sessionThoughts: 4 });
    const bigEntity = nodeRadius({ kind: "entity", salience: 1 });
    const smallEntity = nodeRadius({ kind: "entity", salience: 0.2 });
    const dot = nodeRadius({ kind: "thought", salience: 0.5 });
    const artifact = nodeRadius({ kind: "artifact" });
    expect(session).toBeGreaterThan(bigEntity);
    expect(bigEntity).toBeGreaterThan(smallEntity);
    expect(smallEntity).toBeGreaterThan(dot);
    expect(dot).toBeGreaterThan(artifact);
    // sessions with more thoughts are a little bigger, but bounded
    expect(nodeRadius({ kind: "session" }, { sessionThoughts: 40 })).toBeGreaterThan(nodeRadius({ kind: "session" }, { sessionThoughts: 0 }));
    expect(nodeRadius({ kind: "session" }, { sessionThoughts: 10_000 })).toBeLessThanOrEqual(22);
    // salience drives dot size
    expect(nodeRadius({ kind: "thought", salience: 1 })).toBeGreaterThan(nodeRadius({ kind: "thought", salience: 0 }));
  });
});

describe("working-memory fade (TTL)", () => {
  const created = 1_000_000;
  const wm = (over: Partial<GraphNode> = {}) => node({ createdAt: created, expiresAt: created + 72 * H, promoted: false, ...over });

  it("is solid for promoted nodes, sessions and nodes without an expiry", () => {
    expect(isLongTerm(wm({ promoted: true }))).toBe(true);
    expect(isLongTerm(node({ kind: "session", expiresAt: created + H }))).toBe(true);
    expect(isLongTerm(node({ expiresAt: null }))).toBe(true);
    expect(isLongTerm(node({ expiresAt: undefined }))).toBe(true);
    expect(isLongTerm(wm())).toBe(false);
    const late = created + 70 * H;
    expect(ttlOpacity(wm({ promoted: true }), late)).toBe(1);
    expect(ttlOpacity(node({ expiresAt: null }), late)).toBe(1);
    expect(ttlFraction(wm({ promoted: true }), late)).toBeNull();
  });

  it("fades working memory from 1 towards the floor as it nears expiry", () => {
    const n = wm();
    expect(ttlOpacity(n, created)).toBeCloseTo(1, 6);
    const half = ttlOpacity(n, created + 36 * H);
    const late = ttlOpacity(n, created + 70 * H);
    expect(half).toBeCloseTo(TTL_FLOOR + (1 - TTL_FLOOR) * 0.5, 6);
    expect(late).toBeLessThan(half);
    expect(ttlOpacity(n, created + 72 * H)).toBeCloseTo(TTL_FLOOR, 6);
    expect(ttlOpacity(n, created + 500 * H)).toBeCloseTo(TTL_FLOOR, 6); // overdue never goes invisible
    expect(ttlFraction(n, created + 18 * H)).toBeCloseTo(0.75, 6);
  });

  it("never goes below the floor or above 1, whatever the clock says", () => {
    const n = wm();
    for (const now of [created - 10 * H, created, created + 30 * H, created + 200 * H]) {
      const o = ttlOpacity(n, now);
      expect(o).toBeGreaterThanOrEqual(TTL_FLOOR);
      expect(o).toBeLessThanOrEqual(1);
    }
  });
});

describe("edge styling", () => {
  it("separates semantic edges (dashed, coloured, flowing) from structural ones", () => {
    for (const t of ["refines", "same_topic", "answers", "follows_up", "contradicts", "supersedes"]) {
      const v = edgeVisual(t, 0.8);
      expect(v.semantic).toBe(true);
      expect(v.flow).toBe(true);
      expect(v.dash.length).toBeGreaterThan(0);
      expect(isSemanticEdge(t)).toBe(true);
    }
    for (const t of ["mentions", "in_session", "produced", "related"]) {
      expect(edgeVisual(t).semantic).toBe(false);
      expect(edgeVisual(t).flow).toBe(false);
      expect(isSemanticEdge(t)).toBe(false);
    }
    expect(edgeVisual("mentions").dash).toEqual([]);
    expect(edgeVisual("same_topic").color).toBe("#a78bfa");
    expect(edgeVisual("contradicts").color).toBe("#fb7185");
  });

  it("draws stronger semantic links thicker and falls back for unknown types", () => {
    expect(edgeVisual("same_topic", 1).width).toBeGreaterThan(edgeVisual("same_topic", 0.1).width);
    expect(edgeVisual("mentions").width).toBeLessThan(edgeVisual("same_topic", 0).width);
    const unknown = edgeVisual("something_new");
    expect(unknown.semantic).toBe(false);
    expect(unknown.label).toBe("linked");
  });

  it("captions semantic edges with their similarity", () => {
    expect(edgeCaption("same_topic", 0.9876)).toBe("same topic · 99%");
    expect(edgeCaption("answers", 0.5)).toBe("answers · 50%");
    expect(edgeCaption("mentions", 0.6)).toBe("mentions");
    expect(edgeCaption("same_topic", 0)).toBe("same topic");
  });

  it("sends more particles along stronger semantic links and none along structural ones", () => {
    expect(particleCount("same_topic", 0.95)).toBe(3);
    expect(particleCount("same_topic", 0.6)).toBe(2);
    expect(particleCount("same_topic", 0.2)).toBe(1);
    expect(particleCount("mentions", 1)).toBe(0);
  });
});

describe("rendering budget", () => {
  it("keeps every effect for small graphs and sheds them for large ones", () => {
    const small = qualityFor(60);
    expect(small.level).toBe("high");
    expect(small.halos && small.heroGlow && small.particles && small.drift && small.arcs).toBe(true);
    const mid = qualityFor(300);
    expect(mid.level).toBe("medium");
    const big = qualityFor(500);
    expect(big.level).toBe("low");
    expect(big.halos).toBe(false);
    expect(big.particles).toBe(false);
    expect(big.drift).toBe(false);
    expect(big.maxLabels).toBeLessThan(small.maxLabels);
  });

  it("drops particles and drift under reduced motion, and a tier on touch / slow frames", () => {
    const r = qualityFor(40, { reduced: true });
    expect(r.particles).toBe(false);
    expect(r.drift).toBe(false);
    expect(r.halos).toBe(true);
    expect(qualityFor(40, { coarse: true }).level).toBe("medium");
    expect(qualityFor(40, { degrade: 1 }).level).toBe("medium");
    expect(qualityFor(40, { degrade: 5, coarse: true }).level).toBe("low");
  });
});

describe("pop-in", () => {
  it("is invisible before birth, overshoots, then settles at exactly 1", () => {
    expect(popScale(-5)).toBe(0);
    expect(popScale(0)).toBe(0);
    expect(popScale(10_000)).toBe(1);
    const samples = Array.from({ length: 56 }, (_, i) => popScale(i * 10));
    expect(Math.max(...samples)).toBeGreaterThan(1);
    expect(samples[0]).toBeLessThan(0.2);
  });
});
