import { beforeEach, describe, expect, it } from "vitest";
import type { ThoughtView } from "@synapse/shared";
import { useNotices } from "./notices";
import { useStream, PENDING_TTL_MS, GHOST_TTL_MS } from "./stream";
import { MAX_THOUGHTS, anyAnalyzing, selectNewestFirst, useThoughts } from "./thoughts";

const th = (id: string, createdAt: number, over: Partial<ThoughtView> = {}): ThoughtView =>
  ({
    id,
    code: `T-${id}`,
    sessionId: "s",
    deviceId: "d",
    status: "open",
    provisional: false,
    tentative: false,
    source: "mock",
    category: "idea",
    confidence: 0.5,
    title: id,
    intent: "",
    why: "",
    fragments: [],
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

beforeEach(() => {
  useThoughts.setState(useThoughts.getInitialState(), true);
  useNotices.setState(useNotices.getInitialState(), true);
  useStream.setState(useStream.getInitialState(), true);
});

describe("thoughts store", () => {
  it("keeps thoughts ordered by creation time no matter the arrival order", () => {
    const s = useThoughts.getState();
    s.upsert(th("c", 300));
    s.upsert(th("a", 100));
    s.upsert(th("b", 200));
    expect(useThoughts.getState().order).toEqual(["a", "b", "c"]);
    expect(selectNewestFirst(useThoughts.getState())).toEqual(["c", "b", "a"]);
  });

  it("an update with the same creation time does not move the card", () => {
    const s = useThoughts.getState();
    s.upsert(th("a", 100));
    s.upsert(th("b", 200));
    s.upsert(th("a", 100, { title: "renamed" }));
    expect(useThoughts.getState().order).toEqual(["a", "b"]);
    expect(useThoughts.getState().byId.a?.title).toBe("renamed");
  });

  it("drops the oldest thoughts beyond the cap", () => {
    for (let i = 0; i < MAX_THOUGHTS + 10; i++) useThoughts.getState().upsert(th(`t${i}`, i));
    const s = useThoughts.getState();
    expect(s.order).toHaveLength(MAX_THOUGHTS);
    expect(s.byId.t0).toBeUndefined();
    expect(s.byId[`t${MAX_THOUGHTS + 9}`]).toBeDefined();
  });

  it("animated removals keep the card until finished; others are immediate; unknown ids are a no-op", () => {
    const s = useThoughts.getState();
    s.upsert(th("a", 1));
    s.upsert(th("b", 2));
    expect(s.remove("a", "purged")).toBe(true);
    expect(useThoughts.getState().byId.a).toBeDefined();
    useThoughts.getState().finishRemoval("a");
    expect(useThoughts.getState().byId.a).toBeUndefined();
    expect(useThoughts.getState().fading.a).toBeUndefined();
    expect(useThoughts.getState().remove("b", "merged")).toBe(false);
    expect(useThoughts.getState().byId.b).toBeUndefined();
    expect(useThoughts.getState().remove("nope", "retracted")).toBe(false);
  });

  it("anyAnalyzing drives the orb's thinking ring", () => {
    useThoughts.getState().upsert(th("a", 1, { analyzing: false }));
    expect(anyAnalyzing(useThoughts.getState().byId)).toBe(false);
    useThoughts.getState().upsert(th("b", 2, { analyzing: true }));
    expect(anyAnalyzing(useThoughts.getState().byId)).toBe(true);
  });

  it("setArtifact on a missing thought is harmless", () => {
    expect(() => useThoughts.getState().setArtifact("ghost", {} as never)).not.toThrow();
  });
});

describe("notices store", () => {
  it("collapses identical toasts within 1.5 s but not later ones", () => {
    const n = useNotices.getState();
    const a = n.push("info", "Memory resumed.", { now: 1000 });
    const b = n.push("info", "Memory resumed.", { now: 1500 });
    expect(b).toBe(a);
    n.push("info", "Memory resumed.", { now: 4000 });
    expect(useNotices.getState().toasts).toHaveLength(2);
  });

  it("warnings linger longer than info and at most four are shown", () => {
    const n = useNotices.getState();
    n.push("warn", "careful", { now: 1 });
    expect(useNotices.getState().toasts[0]?.ttl).toBeGreaterThan(5000);
    for (let i = 0; i < 8; i++) n.push("info", `msg ${i}`, { now: 10_000 + i * 2000 });
    expect(useNotices.getState().toasts).toHaveLength(4);
    useNotices.getState().dismiss(useNotices.getState().toasts[0]!.id);
    expect(useNotices.getState().toasts).toHaveLength(3);
  });
});

describe("stream store", () => {
  it("prunes pending fragments that never got acked and expired ghosts", () => {
    const s = useStream.getState();
    s.addPending({ id: "old", text: "x", whisper: false, pauseBeforeMs: 0, tStart: 0, tEnd: 1, sentAt: 0 });
    s.addPending({ id: "new", text: "y", whisper: false, pauseBeforeMs: 0, tStart: 0, tEnd: 1, sentAt: PENDING_TTL_MS });
    s.prune(PENDING_TTL_MS + 100);
    expect(useStream.getState().pending.map((p) => p.id)).toEqual(["new"]);
    useStream.getState().filtered("new", 1, "aside", 5_000);
    expect(useStream.getState().ghosts).toHaveLength(1);
    useStream.getState().prune(5_000 + GHOST_TTL_MS + 1);
    expect(useStream.getState().ghosts).toHaveLength(0);
  });

  it("absorb only touches the listed ids and keeps at most 20 pending lines", () => {
    const s = useStream.getState();
    for (let i = 0; i < 25; i++) s.addPending({ id: `p${i}`, text: "x", whisper: false, pauseBeforeMs: 0, tStart: i, tEnd: i + 1, sentAt: 0 });
    expect(useStream.getState().pending).toHaveLength(20);
    useStream.getState().absorb(["p24", "p23", "not-there"]);
    expect(useStream.getState().pending.some((p) => p.id === "p24")).toBe(false);
    expect(useStream.getState().pending).toHaveLength(18);
  });
});
