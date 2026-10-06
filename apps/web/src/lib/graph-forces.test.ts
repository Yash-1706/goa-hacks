import { describe, expect, it } from "vitest";
import type { VNode } from "./graph-cache";
import { aspectGravity, bridgeForce, collideForce, driftForce, sessionGravity } from "./graph-forces";

let i = 0;
function vn(over: Partial<VNode> & Pick<VNode, "kind">): VNode {
  const id = over.id ?? `n${i++}`;
  return {
    id,
    data: { id, kind: over.kind, label: id, createdAt: 0 },
    r: over.kind === "session" ? 18 : 6,
    color: "#fff",
    tint: undefined,
    label: id,
    sessionId: undefined,
    sessions: [],
    phase: 0.3,
    visible: true,
    born: -Infinity,
    pulseUntil: 0,
    promotedAt: -Infinity,
    dying: null,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ...over,
  } as VNode;
}

function run(force: { (a: number): void; initialize: (n: VNode[]) => void }, nodes: VNode[], ticks: number, alpha = 0.3): void {
  force.initialize(nodes);
  for (let k = 0; k < ticks; k++) {
    force(alpha);
    // the engine integrates velocity with friction
    for (const n of nodes) {
      n.x = (n.x ?? 0) + (n.vx = (n.vx ?? 0) * 0.6);
      n.y = (n.y ?? 0) + (n.vy = (n.vy ?? 0) * 0.6);
    }
  }
}

describe("sessionGravity", () => {
  it("pulls a far thought towards its session but leaves the session itself alone", () => {
    const s = vn({ id: "s", kind: "session", x: 0, y: 0 });
    const t = vn({ id: "t", kind: "thought", sessionId: "s", x: 300, y: 0 });
    run(sessionGravity(), [s, t], 80);
    expect(Math.abs(s.x as number)).toBeLessThan(1e-6);
    expect(t.x as number).toBeLessThan(120);
    expect(t.x as number).toBeGreaterThan(s.r); // it orbits, it does not collapse onto the ring
  });

  it("does not drag thoughts that are already within their orbit", () => {
    const s = vn({ id: "s", kind: "session", x: 0, y: 0 });
    const t = vn({ id: "t", kind: "thought", sessionId: "s", x: 45, y: 0 });
    run(sessionGravity(), [s, t], 20);
    expect(t.x as number).toBeGreaterThan(35);
  });

  it("pushes a thought sitting on the ring back out", () => {
    const s = vn({ id: "s", kind: "session", x: 0, y: 0 });
    const t = vn({ id: "t", kind: "thought", sessionId: "s", x: 6, y: 0 });
    run(sessionGravity(), [s, t], 30);
    expect(t.x as number).toBeGreaterThan(14);
  });

  it("ignores thoughts of unknown sessions, and does nothing once the engine has cooled", () => {
    const stray = vn({ id: "x", kind: "thought", sessionId: "missing", x: 500, y: 0 });
    run(sessionGravity(), [stray], 10);
    expect(stray.x).toBe(500);
    const s = vn({ id: "s", kind: "session", x: 0, y: 0 });
    const t = vn({ id: "t", kind: "thought", sessionId: "s", x: 300, y: 0 });
    run(sessionGravity(), [s, t], 60, 0); // alpha 0: the layout is frozen, no force may keep winning
    expect(t.x).toBe(300);
  });
});

describe("bridgeForce", () => {
  it("draws an entity mentioned from two sessions towards the middle of them", () => {
    const a = vn({ id: "a", kind: "session", x: -200, y: 0 });
    const b = vn({ id: "b", kind: "session", x: 200, y: 100 });
    const e = vn({ id: "e", kind: "entity", sessions: ["a", "b"], x: 0, y: -300 });
    run(bridgeForce(), [a, b, e], 120);
    expect(Math.abs(e.x as number)).toBeLessThan(25);
    expect(Math.abs((e.y as number) - 50)).toBeLessThan(25);
  });

  it("leaves single-session entities to the other forces", () => {
    const a = vn({ id: "a", kind: "session", x: -200, y: 0 });
    const e = vn({ id: "e", kind: "entity", sessions: ["a"], x: 0, y: -300 });
    run(bridgeForce(), [a, e], 30);
    expect(e.x).toBe(0);
    expect(e.y).toBe(-300);
  });
});

describe("collideForce", () => {
  it("separates overlapping nodes", () => {
    const a = vn({ id: "a", kind: "thought", x: 0, y: 0, index: 0 });
    const b = vn({ id: "b", kind: "thought", x: 2, y: 0, index: 1 });
    run(collideForce(), [a, b], 40);
    const d = Math.hypot((a.x as number) - (b.x as number), (a.y as number) - (b.y as number));
    expect(d).toBeGreaterThan(a.r + b.r);
  });

  it("separates exactly coincident nodes without NaN", () => {
    const a = vn({ id: "a", kind: "thought", x: 5, y: 5, index: 0 });
    const b = vn({ id: "b", kind: "thought", x: 5, y: 5, index: 1 });
    run(collideForce(), [a, b], 40);
    expect(Number.isFinite(a.x as number) && Number.isFinite(b.y as number)).toBe(true);
    expect(Math.hypot((a.x as number) - (b.x as number), (a.y as number) - (b.y as number))).toBeGreaterThan(8);
  });

  it("lets the lighter node move more than the heavy one", () => {
    const big = vn({ id: "big", kind: "session", x: 0, y: 0, index: 0 });
    const small = vn({ id: "small", kind: "thought", x: 10, y: 0, index: 1 });
    run(collideForce(), [big, small], 1);
    expect(Math.abs(small.vx as number)).toBeGreaterThan(Math.abs(big.vx as number));
  });

  it("leaves distant nodes alone and ignores dying ones", () => {
    const a = vn({ id: "a", kind: "thought", x: 0, y: 0, index: 0 });
    const b = vn({ id: "b", kind: "thought", x: 500, y: 0, index: 1 });
    const g = vn({ id: "g", kind: "thought", x: 1, y: 0, index: 2, dying: 5 });
    run(collideForce(), [a, b, g], 5);
    expect(a.x).toBe(0);
    expect(b.x).toBe(500);
  });

  it("works with a few hundred nodes quickly", () => {
    const nodes = Array.from({ length: 600 }, (_, k) => vn({ id: `m${k}`, kind: "thought", x: (k % 30) * 9, y: Math.floor(k / 30) * 9, index: k }));
    const f = collideForce();
    f.initialize(nodes);
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) f(0.3);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe("driftForce", () => {
  it("waits while quiet, then ramps in", () => {
    const n = vn({ id: "n", kind: "thought" });
    const f = driftForce(0.05);
    f.initialize([n]);
    f.quiet(30);
    for (let k = 0; k < 25; k++) f(0.1);
    expect(n.vx).toBe(0);
    for (let k = 0; k < 200; k++) f(0.1);
    expect(n.vx).not.toBe(0);
  });

  it("stays a bounded wobble around where the node settled (no random walk)", () => {
    const nodes = Array.from({ length: 20 }, (_, k) => vn({ id: `d${k}`, kind: "thought", phase: k / 20, x: k * 30, y: 0 }));
    const f = driftForce(0.05);
    let maxDev = 0;
    f.initialize(nodes);
    for (let k = 0; k < 6000; k++) {
      f(0);
      for (const n of nodes) {
        n.x = (n.x ?? 0) + (n.vx = (n.vx ?? 0) * 0.6);
        n.y = (n.y ?? 0) + (n.vy = (n.vy ?? 0) * 0.6);
      }
      if (k > 600) for (const [idx, n] of nodes.entries()) maxDev = Math.max(maxDev, Math.hypot((n.x as number) - idx * 30, n.y as number));
    }
    expect(maxDev).toBeLessThan(25);
    expect(maxDev).toBeGreaterThan(0.2); // and it does move
  });

  it("can be switched off, and never touches pinned or dying nodes", () => {
    const pinned = vn({ id: "p", kind: "thought", fx: 3 });
    const ghost = vn({ id: "g", kind: "thought", dying: 1 });
    const free = vn({ id: "f", kind: "thought" });
    const f = driftForce(0.05);
    f.initialize([pinned, ghost, free]);
    for (let k = 0; k < 200; k++) f(0);
    expect(pinned.vx).toBe(0);
    expect(ghost.vx).toBe(0);
    expect(free.vx).not.toBe(0);
    f.enabled = false;
    const before = free.vx;
    f(0);
    expect(free.vx).toBe(before);
  });
});

describe("aspectGravity", () => {
  const settle = (aspect: number): { w: number; h: number } => {
    // a ring of nodes that repel each other lightly: after the gravity has acted the cloud is an ellipse
    const nodes = Array.from({ length: 24 }, (_, k) => vn({ id: `g${k}`, kind: "thought", x: Math.cos(k) * 200, y: Math.sin(k) * 200 }));
    const f = aspectGravity(0.02);
    f.setAspect(aspect);
    run(f, nodes, 200, 0.3);
    const xs = nodes.map((n) => Math.abs(n.x as number));
    const ys = nodes.map((n) => Math.abs(n.y as number));
    return { w: Math.max(...xs), h: Math.max(...ys) };
  };

  it("pulls harder along the short side so the cloud takes the shape of the stage", () => {
    const wide = settle(2);
    expect(wide.w).toBeGreaterThan(wide.h * 1.2);
    const tall = settle(0.55);
    expect(tall.h).toBeGreaterThan(tall.w * 1.2);
    const square = settle(1);
    expect(Math.abs(square.w - square.h) / Math.max(square.w, square.h)).toBeLessThan(0.15);
  });

  it("freezes with the rest of the layout once cooled (a force with a floor would slowly flatten everything)", () => {
    const n = vn({ id: "a", kind: "thought", x: 400, y: 400 });
    const f = aspectGravity();
    run(f, [n], 200, 0);
    expect(n.x).toBe(400);
    expect(n.y).toBe(400);
  });

  it("tolerates a nonsense aspect and a runtime strength change", () => {
    const n = vn({ id: "a", kind: "thought", x: 400, y: 400 });
    const f = aspectGravity();
    f.setAspect(Number.NaN);
    f.setStrength(0.05);
    run(f, [n], 50, 0.3);
    expect(n.x as number).toBeLessThan(400);
    expect(n.y as number).toBeLessThan(400);
    f.setStrength(-5); // clamped: no negative gravity
    const m = vn({ id: "b", kind: "thought", x: 100, y: 100 });
    run(f, [m], 5, 0.3);
    expect(m.x).toBe(100);
  });
});
