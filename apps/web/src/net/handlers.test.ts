import { describe, expect, it, vi } from "vitest";
import type { ArtifactView, ClientMessage, FragmentView, RecallConstraints, ServerMessage, StateSnapshot, SuggestionView, ThoughtView } from "@synapse/shared";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { useCalendar, useDevices } from "@/state/devices";
import { useGraph } from "@/state/graph";
import { useMetrics } from "@/state/metrics";
import { useNotices } from "@/state/notices";
import { useOutbox } from "@/state/outbox";
import { usePrivacy } from "@/state/privacy";
import { useRecall } from "@/state/recall";
import { useSettings } from "@/state/settings";
import { useStream } from "@/state/stream";
import { useSuggestions } from "@/state/suggestions";
import { useThoughts } from "@/state/thoughts";
import { REMOVAL_ANIMATION_MS, RESOLVED_SUGGESTION_MS, createHandlers } from "./handlers";

function resetStores(): void {
  useAudioUi.setState(useAudioUi.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useCalendar.setState(useCalendar.getInitialState(), true);
  useDevices.setState(useDevices.getInitialState(), true);
  useGraph.setState(useGraph.getInitialState(), true);
  useMetrics.setState(useMetrics.getInitialState(), true);
  useNotices.setState(useNotices.getInitialState(), true);
  useOutbox.setState(useOutbox.getInitialState(), true);
  usePrivacy.setState(usePrivacy.getInitialState(), true);
  useRecall.setState(useRecall.getInitialState(), true);
  useSettings.setState(useSettings.getInitialState(), true);
  useStream.setState(useStream.getInitialState(), true);
  useSuggestions.setState(useSuggestions.getInitialState(), true);
  useThoughts.setState(useThoughts.getInitialState(), true);
}

const frag = (id: string, text: string, tStart = 1000, over: Partial<FragmentView> = {}): FragmentView => ({
  id,
  thoughtId: "t1",
  sessionId: "s",
  deviceId: "d",
  text,
  tStart,
  tEnd: tStart + 800,
  pauseBeforeMs: 0,
  durationMs: 800,
  whisper: false,
  activity: "desk",
  transport: "mock",
  ...over,
});

const thought = (id: string, over: Partial<ThoughtView> = {}): ThoughtView =>
  ({
    id,
    code: `T-${id}`,
    sessionId: "s",
    deviceId: "d",
    status: "open",
    provisional: true,
    tentative: false,
    source: "local",
    category: "bug",
    confidence: 0.4,
    title: "Null pointer",
    intent: "",
    why: "",
    fragments: [frag("f1", "hello")],
    references: [],
    repairs: [],
    openQuestions: [],
    entities: [],
    artifact: null,
    salience: 0,
    salienceReasons: [],
    promoted: false,
    expiresAt: null,
    createdAt: 100,
    updatedAt: 100,
    version: 1,
    timing: {},
    analyzing: true,
    ...over,
  }) as ThoughtView;

const artifact = (over: Partial<ArtifactView> = {}): ArtifactView => ({
  id: "a1",
  code: "A-1",
  kind: "github_issue",
  status: "draft",
  autonomyLevel: 1,
  payload: { kind: "github_issue", title: "t", body_markdown: "b", labels: [], hypotheses: [] },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  paused: false,
  devices: [{ deviceId: "dev-1", kind: "desk", name: "Desk", connected: true, listening: false, speaking: false }],
  thoughts: [thought("b", { createdAt: 200, analyzing: false, provisional: false }), thought("a", { createdAt: 100, analyzing: false, provisional: false })],
  suggestions: [],
  echoes: [],
  asideCount: 7,
  metrics: { n: 3, stages: { artifact: { n: 3, p50: 820, p95: 1200, max: 1300 } }, updatedAt: 5 },
  calendar: [{ id: "c1", title: "Standup", start: 1, end: 2, source: "seed" }],
  ...over,
});

function setup() {
  resetStores();
  const sent: ClientMessage[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const deps = {
    send: vi.fn((m: ClientMessage) => (sent.push(m), true)),
    now: () => 5_000,
    schedule: vi.fn((fn: () => void, ms: number) => scheduled.push({ fn, ms })),
    afterPaint: (cb: () => void) => cb(),
    onRemotePause: vi.fn(),
    onRemoteResume: vi.fn(),
  };
  const h = createHandlers(deps);
  const run = (msg: ServerMessage): void => h.handle(msg);
  const flush = (): void => {
    for (const s of scheduled.splice(0)) s.fn();
  };
  return { h, run, sent, scheduled, deps, flush };
}

describe("welcome", () => {
  it("hydrates every store from the snapshot", () => {
    const { run } = setup();
    run({
      type: "welcome",
      deviceId: "dev-1",
      serverTime: 5_000,
      config: { wisprMode: "mock", languages: ["en"], llmMode: "mock", localOnly: false, autonomyLevel: 2, pauseWindowSecs: 30, ttlHours: 72, userFirstName: "Rio", timezone: "Asia/Kolkata", hackathonStart: 0, embeddings: "model", threadCloseMs: 6000, dev: true, integrations: { github: false, jira: false } },
      state: snapshot({ paused: true, pausedAt: 4_000, pausedBy: "voice" }),
    });
    expect(useThoughts.getState().order).toEqual(["a", "b"]);
    expect(useStream.getState().asideCount).toBe(7);
    expect(usePrivacy.getState()).toMatchObject({ paused: true, pausedBy: "voice", pausedAt: 4_000 });
    expect(useDevices.getState().devices).toHaveLength(1);
    expect(useMetrics.getState().summary?.stages.artifact?.p50).toBe(820);
    expect(useCalendar.getState().events[0]?.title).toBe("Standup");
    expect(useSettings.getState().config?.userFirstName).toBe("Rio");
    expect(useConnection.getState()).toMatchObject({ deviceId: "dev-1", welcomeAt: 5_000 });
  });

  it("a reconnect replaces the thought list (no stale cards)", () => {
    const { run } = setup();
    useThoughts.getState().upsert(thought("stale"));
    run({ type: "welcome", deviceId: "d", serverTime: 1, config: {} as never, state: snapshot() });
    expect(useThoughts.getState().byId.stale).toBeUndefined();
  });
});

describe("thoughts", () => {
  it("ack then upsert: ack map is filled, the pending fragment line is absorbed, thoughts stay ordered", () => {
    const { run } = setup();
    useStream.getState().addPending({ id: "f1", text: "hello", whisper: false, pauseBeforeMs: 0, tStart: 1000, tEnd: 1800, sentAt: 4_900 });
    run({ type: "fragment.ack", fragmentId: "f1", thoughtId: "t1" });
    run({ type: "thought.upsert", thought: thought("t1", { createdAt: 300 }) });
    run({ type: "thought.upsert", thought: thought("t0", { createdAt: 100, fragments: [frag("fx", "older")] }) });
    const s = useThoughts.getState();
    expect(s.ack.f1).toBe("t1");
    expect(s.lastFragment.t1).toBe("f1");
    expect(s.order).toEqual(["t0", "t1"]);
    expect(useStream.getState().pending).toHaveLength(0);
  });

  it("an upsert for a known thought morphs it in place", () => {
    const { run } = setup();
    run({ type: "thought.upsert", thought: thought("t1", { title: "Nul" }) });
    run({ type: "thought.upsert", thought: thought("t1", { title: "Null pointer in cart", provisional: false, analyzing: false }) });
    expect(useThoughts.getState().order).toEqual(["t1"]);
    expect(useThoughts.getState().byId.t1?.title).toBe("Null pointer in cart");
  });

  it("a retraction fades first and is deleted after the exit animation; an aside vanishes at once", () => {
    const { run, scheduled, flush } = setup();
    run({ type: "thought.upsert", thought: thought("t1") });
    run({ type: "thought.upsert", thought: thought("t2") });
    run({ type: "thought.remove", id: "t1", reason: "retracted" });
    expect(useThoughts.getState().fading.t1).toBe("retracted");
    expect(useThoughts.getState().byId.t1).toBeDefined();
    expect(scheduled[0]?.ms).toBe(REMOVAL_ANIMATION_MS);
    flush();
    expect(useThoughts.getState().byId.t1).toBeUndefined();
    expect(useThoughts.getState().order).toEqual(["t2"]);

    run({ type: "thought.remove", id: "t2", reason: "aside" });
    expect(useThoughts.getState().byId.t2).toBeUndefined();
    expect(scheduled).toHaveLength(0);
  });

  it("artifact.upsert updates the card's artifact and patches a loaded outbox", () => {
    const { run } = setup();
    run({ type: "thought.upsert", thought: thought("t1") });
    useOutbox.getState().setItems([]);
    run({ type: "artifact.upsert", thoughtId: "t1", artifact: artifact({ status: "staged" }) });
    expect(useThoughts.getState().byId.t1?.artifact?.status).toBe("staged");
    expect(useOutbox.getState().items).toHaveLength(1);
    expect(useOutbox.getState().items[0]).toMatchObject({ thoughtCode: "T-t1", pushable: { ok: true } });
    run({ type: "artifact.upsert", thoughtId: "t1", artifact: artifact({ status: "executed" }) });
    expect(useOutbox.getState().items).toHaveLength(1);
    expect(useOutbox.getState().items[0]?.pushable.ok).toBe(false);
  });
});

describe("filtered asides", () => {
  it("bumps the counter and dissolves a local fragment into a ghost", () => {
    const { run } = setup();
    useStream.getState().addPending({ id: "f9", text: "wait, was that my phone?", whisper: false, pauseBeforeMs: 0, tStart: 1, tEnd: 2, sentAt: 4_900 });
    const before = useStream.getState().asideBump;
    run({ type: "fragment.filtered", fragmentId: "f9", reason: "aside", asideCount: 8 });
    const s = useStream.getState();
    expect(s.asideCount).toBe(8);
    expect(s.asideBump).toBe(before + 1);
    expect(s.pending).toHaveLength(0);
    expect(s.ghosts.map((g) => g.text)).toEqual(["wait, was that my phone?"]);
  });

  it("a filtered fragment from another device only bumps the counter", () => {
    const { run } = setup();
    run({ type: "fragment.filtered", fragmentId: "elsewhere", reason: "noise", asideCount: 1 });
    expect(useStream.getState().ghosts).toHaveLength(0);
    expect(useStream.getState().asideCount).toBe(1);
  });

  it("a provisional card that turns out to be an aside dissolves into a ghost, for local fragments only", () => {
    const { run } = setup();
    useStream.getState().addPending({ id: "f1", text: "was that my phone", whisper: false, pauseBeforeMs: 0, tStart: 1, tEnd: 2, sentAt: 4_900 });
    run({ type: "thought.upsert", thought: thought("t1", { fragments: [frag("f1", "was that my phone"), frag("remote-1", "from another device")] }) });
    expect(useStream.getState().pending).toHaveLength(0);
    run({ type: "thought.remove", id: "t1", reason: "aside" });
    run({ type: "fragment.filtered", fragmentId: "f1", reason: "aside", asideCount: 1 });
    expect(useThoughts.getState().byId.t1).toBeUndefined();
    expect(useStream.getState().ghosts.map((g) => g.text)).toEqual(["was that my phone"]);
    expect(useStream.getState().asideCount).toBe(1);
  });

  it("paused rejections leave no ghost text", () => {
    const { run } = setup();
    useStream.getState().addPending({ id: "f1", text: "secret", whisper: false, pauseBeforeMs: 0, tStart: 1, tEnd: 2, sentAt: 4_900 });
    run({ type: "fragment.filtered", fragmentId: "f1", reason: "paused", asideCount: 0 });
    expect(useStream.getState().ghosts).toHaveLength(0);
  });
});

describe("suggestions, echoes, briefs", () => {
  const sug = (over: Partial<SuggestionView> = {}): SuggestionView => ({
    id: "s1",
    kind: "reschedule",
    title: "Move standup?",
    body: "…",
    why: "You mentioned it 3 times.",
    value: 0.9,
    status: "delivered",
    createdAt: 1,
    sources: [],
    acceptLabel: "Hold Thu 10:30",
    payload: { slots: [{ start: 1, end: 2, label: "Thu 10:30" }] },
    ...over,
  });

  it("pushes, lights the orb pulse timestamp, and removes a resolved one after a moment", () => {
    const { run, flush, scheduled } = setup();
    run({ type: "suggestion.push", suggestion: sug() });
    expect(useSuggestions.getState().items).toHaveLength(1);
    expect(useSuggestions.getState().lastPushAt).toBe(5_000);
    expect(useSuggestions.getState().unseen).toBe(1);
    run({ type: "suggestion.update", id: "s1", status: "accepted" });
    expect(useSuggestions.getState().items[0]?.status).toBe("accepted");
    expect(scheduled[0]?.ms).toBe(RESOLVED_SUGGESTION_MS);
    flush();
    expect(useSuggestions.getState().items).toHaveLength(0);
  });

  it("keeps a repeated push idempotent and the slot pick is remembered per suggestion", () => {
    const { run } = setup();
    run({ type: "suggestion.push", suggestion: sug() });
    run({ type: "suggestion.push", suggestion: sug({ title: "Move standup? (updated)" }) });
    expect(useSuggestions.getState().items).toHaveLength(1);
    useSuggestions.getState().setPick("s1", 2);
    expect(useSuggestions.getState().picks.s1).toBe(2);
    run({ type: "suggestion.update", id: "s1", status: "dismissed" });
    useSuggestions.getState().finish("s1");
    expect(useSuggestions.getState().picks.s1).toBeUndefined();
  });

  it("echoes and briefs go on the rail", () => {
    const { run } = setup();
    run({ type: "echo.push", echo: { id: "e1", thoughtId: "t", because: "Related…", source: { thoughtId: "x", code: "T-1", title: "x", when: 1 }, similarity: 0.8, createdAt: 1 } });
    run({ type: "brief.ready", brief: { id: "b1", sessionId: "s", headline: "3 thoughts", tasks: [], decisions: [], snippets: [], openLoops: [], filteredCount: 2, notableQuotes: [], createdAt: 1 } });
    expect(useSuggestions.getState().echoes).toHaveLength(1);
    expect(useSuggestions.getState().briefs[0]?.headline).toBe("3 thoughts");
  });
});

describe("recall", () => {
  const constraints = (): RecallConstraints => ({ topic: "caching", types: [], persons: [] });

  it("a spoken question appears by itself, takes over the screen and badges the nav", () => {
    const { run } = setup();
    run({ type: "recall.sources", queryId: "voice-thought-1", queryText: "what was that caching idea", constraints: constraints(), sources: [], relaxations: ["dropped “while walking”"], ms: 12 });
    const s = useRecall.getState();
    expect(s.activeId).toBe("voice-thought-1");
    expect(s.unseenVoice).toBe(1);
    expect(s.queries["voice-thought-1"]).toMatchObject({ origin: "voice", sourcesMs: 12, relaxations: ["dropped “while walking”"] });
    s.markSeen();
    expect(useRecall.getState().unseenVoice).toBe(0);
  });

  it("a typed question stays typed; deltas accumulate; done fixes the final answer and citations", () => {
    const { run } = setup();
    useRecall.getState().start("q1", "caching?", "typed", 1);
    run({ type: "recall.sources", queryId: "q1", queryText: "caching?", constraints: constraints(), sources: [], relaxations: [], ms: 5 });
    run({ type: "recall.delta", queryId: "q1", text: "You had an idea " });
    run({ type: "recall.delta", queryId: "q1", text: "about caching [T-12]." });
    expect(useRecall.getState().queries.q1?.answer).toBe("You had an idea about caching [T-12].");
    expect(useRecall.getState().queries.q1?.done).toBe(false);
    run({ type: "recall.done", queryId: "q1", answer: "You had an idea about caching [T-12].", citations: ["T-12"], notFound: false, ms: 900 });
    expect(useRecall.getState().queries.q1).toMatchObject({ done: true, citations: ["T-12"], totalMs: 900, origin: "typed" });
    expect(useRecall.getState().unseenVoice).toBe(0);
  });

  it("a delta for an unknown query does not crash", () => {
    const { run } = setup();
    run({ type: "recall.delta", queryId: "ghost", text: "hi" });
    expect(useRecall.getState().queries.ghost?.answer).toBe("hi");
  });
});

describe("privacy", () => {
  it("paused: updates the store and tells the audio controller to release the mic", () => {
    const { run, deps } = setup();
    run({ type: "privacy.paused", by: "dev-1", purgedCount: 2, at: 4_000 });
    expect(usePrivacy.getState()).toMatchObject({ paused: true, pausedBy: "dev-1", lastPurged: { count: 2, at: 4_000 } });
    expect(deps.onRemotePause).toHaveBeenCalledOnce();
  });

  it("resumed: clears the pause but does NOT start the mic (resume is a deliberate tap)", () => {
    const { run, deps } = setup();
    run({ type: "privacy.paused", by: "x", purgedCount: 0, at: 1 });
    run({ type: "privacy.resumed", by: "x", at: 2 });
    expect(usePrivacy.getState().paused).toBe(false);
    expect(deps.onRemoteResume).toHaveBeenCalledOnce();
    expect(useAudioUi.getState().state).toBe("off");
  });

  it("state.update carries the pause flag and the device list", () => {
    const { run } = setup();
    run({ type: "state.update", paused: true, pausedAt: 9, pausedBy: "tap", devices: [{ deviceId: "p", kind: "pocket", name: "Phone", connected: true, listening: true, speaking: true }] });
    expect(usePrivacy.getState()).toMatchObject({ paused: true, pausedBy: "tap" });
    expect(useDevices.getState().devices[0]?.speaking).toBe(true);
  });

  it("forgot is remembered for the Privacy Center", () => {
    const { run } = setup();
    run({ type: "privacy.forgot", scope: "window", count: 4, at: 7 });
    expect(usePrivacy.getState().lastForgot).toEqual({ scope: "window", count: 4, query: undefined, at: 7 });
  });
});

describe("graph, metrics, notices, wispr context", () => {
  it("graph.delta adds nodes, drops removed ones and the edges that touched them", () => {
    const { run } = setup();
    const n = (id: string) => ({ id, kind: "thought" as const, label: id, createdAt: 1 });
    run({ type: "graph.delta", nodes: [n("a"), n("b")], edges: [{ id: "e1", src: "a", dst: "b", type: "same_topic", weight: 1 }], removedNodes: [], removedEdges: [] });
    expect(Object.keys(useGraph.getState().nodes)).toEqual(["a", "b"]);
    expect(useGraph.getState().fresh).toEqual(["a", "b"]);
    run({ type: "graph.delta", nodes: [], edges: [], removedNodes: ["a"], removedEdges: [] });
    expect(Object.keys(useGraph.getState().nodes)).toEqual(["b"]);
    expect(Object.keys(useGraph.getState().edges)).toEqual([]);
  });

  it("graph.delta never keeps an edge whose endpoint is missing", () => {
    const { run } = setup();
    run({ type: "graph.delta", nodes: [{ id: "a", kind: "thought", label: "a", createdAt: 1 }], edges: [{ id: "dangling", src: "a", dst: "zzz", type: "mentions", weight: 1 }], removedNodes: [], removedEdges: [] });
    expect(useGraph.getState().edges.dangling).toBeUndefined();
  });

  it("metrics.update replaces the summary", () => {
    const { run } = setup();
    run({ type: "metrics.update", summary: { n: 9, stages: {}, updatedAt: 1 } });
    expect(useMetrics.getState().summary?.n).toBe(9);
  });

  it("notices and server errors become toasts (duplicates collapse)", () => {
    const { run } = setup();
    run({ type: "notice", level: "success", text: "Memory resumed.", at: 1 });
    run({ type: "notice", level: "success", text: "Memory resumed.", at: 2 });
    run({ type: "error", code: "handler_failed", message: "fragment.final" });
    const toasts = useNotices.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1]?.level).toBe("warn");
    expect(toasts[1]?.text).toContain("fragment.final");
  });

  it("wispr.context is kept for the audio engine", () => {
    const { run } = setup();
    run({ type: "wispr.context", dictionary: ["OAuth2"], conversation: [{ role: "user", content: "hi" }], language: ["en"] });
    expect(useAudioUi.getState().wisprContext?.dictionary).toEqual(["OAuth2"]);
  });

  it("messages handled by the socket itself are ignored here", () => {
    const { run } = setup();
    expect(() => {
      run({ type: "pong", t0: 1, tServer: 2 });
      run({ type: "auth.required", reason: "x" });
      run({ type: "wispr.token", mode: "mock" });
    }).not.toThrow();
  });
});

describe("latency reporting through the handlers", () => {
  it("reports first paint and artifact render for a locally spoken fragment", () => {
    const { run, sent, h } = setup();
    h.tracker.noteLocal("f1", 4_800);
    run({ type: "fragment.ack", fragmentId: "f1", thoughtId: "t1" });
    run({ type: "thought.upsert", thought: thought("t1") });
    run({ type: "thought.upsert", thought: thought("t1", { analyzing: false, provisional: false }) });
    expect(sent).toEqual([
      { type: "metrics.client", fragmentId: "f1", firstPaint: 5_000 },
      { type: "metrics.client", fragmentId: "f1", artifactRender: 5_000 },
    ]);
    expect(useMetrics.getState().byThought.t1).toMatchObject({ firstPaintMs: 200, artifactMs: 200 });
    expect(useMetrics.getState().samples).toHaveLength(1);
  });
});
