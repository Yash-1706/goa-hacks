import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Activity, FragmentFinal, ServerMessage, SuggestionView, ThoughtView } from "@synapse/shared";
import { createApp, type AppCtx } from "../src/app";
import { FakeClock } from "../src/clock";
import { loadConfig } from "../src/config";
import { modelEmbedder } from "./helpers";

export interface TestApp {
  ctx: AppCtx;
  clock: FakeClock;
  sent: ServerMessage[];
  stop: () => Promise<void>;
  /** speak one utterance on a device; `gapMs` is the silence before it (client timeline) */
  say: (text: string, o?: SayOpts) => Promise<void>;
  /** finish the current thread(s) and let everything settle */
  settle: () => Promise<void>;
  thoughts: () => ThoughtView[];
  suggestions: () => SuggestionView[];
  last: <T extends ServerMessage["type"]>(type: T) => Extract<ServerMessage, { type: T }> | undefined;
}

export interface SayOpts {
  gapMs?: number;
  durationMs?: number;
  whisper?: boolean;
  device?: "desk" | "pocket";
  activity?: Activity;
  session?: string;
}

/** A fully wired app (in-memory DB, real MiniLM embeddings, mock cortex) on a controllable clock. */
export async function makeApp(env: Record<string, string> = {}, start = "2026-10-06T10:00:00+05:30", dbFile = ":memory:", kek: Buffer = randomBytes(32)): Promise<TestApp> {
  const clock = new FakeClock(Date.parse(start));
  const cfg = loadConfig({
    DATA_DIR: path.join(os.tmpdir(), `synapse-test-${randomBytes(4).toString("hex")}`),
    THREAD_CLOSE_MS: "30000", // never closes by timer inside a test (real timers + a loaded machine = flaky); settle() finalizes explicitly
    LLM_MODE: "mock",
    WISPR_MODE: "mock",
    REQUIRE_PAIRING: "0",
    SUGGESTION_MIN_GAP_S: "0",
    ...env,
  });
  const { ctx, stop } = await createApp(cfg, { dbFile, clock, embedder: await modelEmbedder(), kek, quiet: true });
  const sent: ServerMessage[] = [];
  const orig = ctx.hub.broadcast.bind(ctx.hub);
  ctx.hub.broadcast = (m: ServerMessage) => {
    sent.push(m);
    orig(m);
  };

  let vt = clock.now();
  let lastEnd = 0;
  let seq = 0;
  const say: TestApp["say"] = async (text, o = {}) => {
    const kind = o.device ?? "desk";
    const activity = o.activity ?? (kind === "pocket" ? "walking" : "desk");
    const gap = o.gapMs ?? 0;
    const dur = o.durationMs ?? Math.max(700, text.split(/\s+/).length * 330);
    const start = Math.max(vt, clock.now()) + gap;
    const end = start + dur;
    vt = end;
    const sessionId = o.session ?? `sess-${kind}`;
    const dev = { id: `dev-${kind}`, kind, activity };
    ctx.store.ensureSession(sessionId, dev.id, kind, activity);
    const msg: FragmentFinal = {
      type: "fragment.final",
      fragmentId: `f-${seq++}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      text,
      t: { speechStart: start, speechEnd: end, commitSent: end, wisprFinal: end + 200 },
      durationMs: dur,
      pauseBeforeMs: lastEnd ? Math.max(0, start - lastEnd) : 0,
      rmsMean: o.whisper ? 0.02 : 0.08,
      rmsMax: 0.2,
      whisper: Boolean(o.whisper),
      activity,
      transport: "replay",
    };
    lastEnd = end;
    await ctx.engine.handleFragment(dev, msg);
    await ctx.engine.idle();
  };

  return {
    ctx,
    clock,
    sent,
    stop,
    say,
    settle: async () => {
      await ctx.engine.finalizeAll();
    },
    thoughts: () => [...ctx.store.thoughts.values()].sort((a, b) => a.createdAt - b.createdAt).map((t) => ctx.engine.view(t)),
    suggestions: () => ctx.proactive.snapshot().suggestions,
    last: (type) => [...sent].reverse().find((m) => m.type === type) as never,
  };
}
