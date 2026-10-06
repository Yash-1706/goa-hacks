import { describe, expect, it } from "vitest";
import { centroid, chargeFor, curvatureFor, hash01, linkDistanceFor, linkStrengthFor, scatterNear, seedSession } from "./graph-layout";

describe("hash01", () => {
  it("is deterministic, in [0,1) and salt-sensitive", () => {
    expect(hash01("abc")).toBe(hash01("abc"));
    expect(hash01("abc", 1)).not.toBe(hash01("abc", 2));
    const xs = Array.from({ length: 200 }, (_, i) => hash01(`node-${i}`));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    // roughly uniform: both halves are well populated
    expect(xs.filter((x) => x < 0.5).length).toBeGreaterThan(60);
    expect(xs.filter((x) => x >= 0.5).length).toBeGreaterThan(60);
  });
});

describe("seeding", () => {
  it("puts the first session near the centre and spreads later ones around it", () => {
    const first = seedSession([], "s1", 6);
    expect(Math.hypot(first.x, first.y)).toBeLessThan(120);
    const placed = [first];
    for (let i = 2; i <= 6; i++) placed.push(seedSession(placed, `s${i}`, 6));
    // nobody lands on top of anybody
    let min = Infinity;
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) min = Math.min(min, Math.hypot((placed[i] as { x: number }).x - (placed[j] as { x: number }).x, (placed[i] as { y: number }).y - (placed[j] as { y: number }).y));
    expect(min).toBeGreaterThan(80);
  });

  it("is reproducible", () => {
    const a = seedSession([{ x: 0, y: 0 }, { x: 200, y: 10 }], "same", 3);
    const b = seedSession([{ x: 0, y: 0 }, { x: 200, y: 10 }], "same", 3);
    expect(a).toEqual(b);
  });

  it("scatters around a base point inside the ring", () => {
    for (let i = 0; i < 50; i++) {
      const p = scatterNear({ x: 100, y: -50 }, `t${i}`, 20, 40);
      const d = Math.hypot(p.x - 100, p.y + 50);
      expect(d).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(d).toBeLessThanOrEqual(40 + 1e-9);
    }
  });

  it("finds the centroid", () => {
    expect(centroid([])).toEqual({ x: 0, y: 0 });
    expect(centroid([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toEqual({ x: 5, y: 10 });
  });
});

describe("force tuning", () => {
  it("sessions repel hardest, entities next, thoughts less, artifacts least", () => {
    expect(chargeFor("session")).toBeLessThan(chargeFor("entity"));
    expect(chargeFor("entity")).toBeLessThan(chargeFor("thought"));
    expect(chargeFor("thought")).toBeLessThan(chargeFor("artifact"));
    expect(chargeFor("decision")).toBe(chargeFor("thought"));
  });

  it("keeps thoughts tight to their session while entities and semantic links stay loose", () => {
    expect(linkStrengthFor("in_session")).toBeGreaterThan(linkStrengthFor("mentions") * 4);
    expect(linkStrengthFor("produced")).toBeGreaterThan(linkStrengthFor("in_session"));
    expect(linkStrengthFor("same_topic", 1)).toBeLessThan(linkStrengthFor("in_session"));
    expect(linkStrengthFor("same_topic", 1)).toBeGreaterThan(linkStrengthFor("same_topic", 0));
    expect(linkDistanceFor("produced")).toBeLessThan(linkDistanceFor("in_session"));
    expect(linkDistanceFor("in_session")).toBeLessThan(linkDistanceFor("mentions"));
    expect(linkDistanceFor("same_topic")).toBeGreaterThanOrEqual(linkDistanceFor("mentions"));
  });

  it("fans out parallel edges symmetrically and bows lone semantic edges slightly", () => {
    expect(curvatureFor(0, 1, false)).toBe(0);
    expect(curvatureFor(0, 1, true)).toBeGreaterThan(0);
    const two = [curvatureFor(0, 2, true), curvatureFor(1, 2, true)];
    expect(two[0]).toBeLessThan(0);
    expect(two[1]).toBeGreaterThan(0);
    const three = [0, 1, 2].map((i) => curvatureFor(i, 3, false));
    expect(three[1]).toBeCloseTo(0, 9);
    expect(three[0]).toBeCloseTo(-(three[2] as number), 9);
  });
});
