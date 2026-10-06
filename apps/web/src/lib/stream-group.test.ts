import { describe, expect, it } from "vitest";
import type { FragmentView, ThoughtView } from "@synapse/shared";
import { buildStream, countFragments, MIN_VISIBLE_GAP_MS, type PendingFragment } from "./stream-group";

const frag = (id: string, text: string, tStart: number, over: Partial<FragmentView> = {}): FragmentView => ({
  id,
  thoughtId: "t",
  sessionId: "s",
  deviceId: "d",
  text,
  tStart,
  tEnd: tStart + 1000,
  pauseBeforeMs: 0,
  durationMs: 1000,
  whisper: false,
  activity: "desk",
  transport: "mock",
  ...over,
});

const thought = (id: string, createdAt: number, fragments: FragmentView[], over: Partial<ThoughtView> = {}): ThoughtView =>
  ({
    id,
    code: `T-${id}`,
    sessionId: "s",
    deviceId: "d",
    status: "open",
    provisional: false,
    tentative: false,
    source: "mock",
    category: "bug",
    confidence: 0.8,
    title: `title ${id}`,
    intent: "",
    why: "",
    fragments,
    references: [],
    repairs: [],
    openQuestions: [],
    entities: [],
    artifact: null,
    salience: 0,
    salienceReasons: [],
    promoted: false,
    expiresAt: null,
    createdAt,
    updatedAt: createdAt,
    version: 1,
    timing: {},
    ...over,
  }) as ThoughtView;

const pending = (id: string, text: string, tStart: number, over: Partial<PendingFragment> = {}): PendingFragment => ({
  id,
  text,
  whisper: false,
  pauseBeforeMs: 0,
  tStart,
  tEnd: tStart + 800,
  sentAt: tStart,
  ...over,
});

describe("buildStream", () => {
  it("makes one group per thought, newest first", () => {
    const groups = buildStream({
      thoughts: [thought("a", 100, [frag("f1", "one", 100)]), thought("b", 200, [frag("f2", "two", 200)])],
      pending: [],
    });
    expect(groups.map((g) => g.key)).toEqual(["b", "a"]);
    expect(groups[0]?.code).toBe("T-b");
  });

  it("stitches fragments of a thought together in speaking order with their pause gaps", () => {
    const groups = buildStream({
      thoughts: [
        thought("a", 100, [
          frag("f2", "the one with the null pointer...", 3600, { pauseBeforeMs: 1600 }),
          frag("f1", "That bug from yesterday...", 1000),
          frag("f3", "in the cart service", 6200, { pauseBeforeMs: 1100, whisper: true }),
        ]),
      ],
      pending: [],
    });
    const g = groups[0]!;
    expect(g.fragments.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(g.fragments.map((f) => f.gapBeforeMs)).toEqual([0, 1600, 1100]);
    expect(g.fragments[2]?.whisper).toBe(true);
    expect(countFragments(groups)).toBe(3);
  });

  it("falls back to timestamps for the gap when pauseBeforeMs is missing", () => {
    const groups = buildStream({ thoughts: [thought("a", 1, [frag("f1", "a", 1000), frag("f2", "b", 4000)])], pending: [] });
    expect(groups[0]?.fragments[1]?.gapBeforeMs).toBe(2000); // 4000 - (1000 + 1000)
  });

  it("shows locally spoken fragments immediately as a pending group on top", () => {
    const groups = buildStream({
      thoughts: [thought("a", 100, [frag("f1", "old", 100)])],
      pending: [pending("p1", "just said", 500), pending("p2", "and more", 1700, { pauseBeforeMs: 400 })],
    });
    expect(groups[0]?.key).toBe("pending");
    expect(groups[0]?.fragments.map((f) => f.text)).toEqual(["just said", "and more"]);
    expect(groups[0]?.fragments.every((f) => f.pending)).toBe(true);
    expect(groups[0]?.fragments[1]?.gapBeforeMs).toBe(400);
  });

  it("absorbs a pending fragment into its thought group once the thought carries it (no duplicate line)", () => {
    const groups = buildStream({
      thoughts: [thought("a", 100, [frag("f1", "hello", 100), frag("p1", "world", 1500)])],
      pending: [pending("p1", "world", 1500)],
    });
    expect(groups.map((g) => g.key)).toEqual(["a"]);
    expect(groups[0]?.fragments).toHaveLength(2);
    expect(groups[0]?.fragments[1]?.pending).toBe(false);
  });

  it("marks analysing and provisional groups, and keeps the removal animation reason", () => {
    const groups = buildStream({
      thoughts: [thought("a", 100, [frag("f1", "x", 100)], { analyzing: true, provisional: true, title: "" })],
      pending: [],
      fading: { a: "retracted" },
    });
    expect(groups[0]?.analyzing).toBe(true);
    expect(groups[0]?.title).toBeUndefined();
    expect(groups[0]?.fading).toBe("retracted");
  });

  it("skips thoughts without fragments and honours the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => thought(`t${i}`, i, [frag(`f${i}`, "x", i)]));
    expect(buildStream({ thoughts: [...many, thought("empty", 99, [])], pending: [], limit: 10 })).toHaveLength(10);
    expect(buildStream({ thoughts: [thought("empty", 99, [])], pending: [] })).toHaveLength(0);
  });

  it("exposes the visible-gap threshold the UI uses", () => {
    expect(MIN_VISIBLE_GAP_MS).toBeGreaterThan(0);
  });
});
