import { FragmentFinalSchema, type FragmentFinal } from "@synapse/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_KEY_DETAIL, PROXY_UNSUPPORTED_DETAIL, createMicEngineFactory, micErrorDetail } from "./engine";
import { FakeAudioContext, FakeClock, FakeEventTarget, FakeStream, FakeWs, flush } from "./test-utils";
import { ScriptedVad, frameWithRms } from "./test-vad";
import type {
  AudioDiagnostic,
  AudioEngineOptions,
  AudioState,
  AudioStats,
  AudioTuning,
  WisprContext,
  WisprTokenInfo,
} from "./types";

const WS_URL = "wss://wispr.test/api/v1/dash/client_ws";
const REST_URL = "https://wispr.test/api/v1/dash/client_api";

interface Events {
  fragments: FragmentFinal[];
  speaking: Array<[boolean, number]>;
  states: Array<[AudioState, string | undefined]>;
  levels: number[];
  failed: Array<[string, string]>;
  pauses: Array<["voice" | "kws", number]>;
  stats: AudioStats[];
  diags: AudioDiagnostic[];
  /** ordered log of the privacy-relevant steps */
  log: string[];
  /** world state captured at the moment onPause fires */
  atPause: Array<{ tracksStopped: boolean; vadDestroyed: boolean; openSockets: number; state: AudioState }>;
}

interface BootOpts {
  token?: () => Promise<WisprTokenInfo>;
  mode?: "normal" | "eco";
  tuning?: AudioTuning;
  gumError?: Error;
  /** getUserMedia resolves only when the test calls resolveGum() */
  deferGum?: boolean;
  callbacks?: Partial<AudioEngineOptions>;
  /** page-level event sources (document: visibilitychange, window: online) */
  doc?: FakeEventTarget;
  win?: FakeEventTarget;
}

const clientToken = (clock: FakeClock): WisprTokenInfo => ({
  mode: "client",
  token: "jwt-1",
  expiresAt: clock.now() + 900_000,
  wsUrl: WS_URL,
  restUrl: REST_URL,
});

function boot(o: BootOpts = {}) {
  FakeWs.reset();
  const clock = new FakeClock();
  const ev: Events = { fragments: [], speaking: [], states: [], levels: [], failed: [], pauses: [], stats: [], diags: [], log: [], atPause: [] };
  const stream = new FakeStream(ev.log);
  const ctx = new FakeAudioContext();
  let vad: ScriptedVad | undefined;
  let mode: "normal" | "eco" = o.mode ?? "normal";
  let resolveGum: (() => void) | undefined;
  const requestWisprToken = vi.fn(o.token ?? (async () => clientToken(clock)));
  const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => {
    if (o.gumError) throw o.gumError;
    if (o.deferGum) await new Promise<void>((r) => (resolveGum = r));
    return stream as unknown as MediaStream;
  });
  const createAudioContext = vi.fn(() => ctx as unknown as AudioContext);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "rest text", detected_language: "en" }), { status: 200 }));
  const wisprCtx: WisprContext = { dictionary: ["OAuth2"], conversation: [], language: ["en"], userFirstName: "Rio" };

  const opts: AudioEngineOptions = {
    deviceId: "dev-1",
    sessionId: "sess-1",
    deviceKind: "desk",
    onFragment: (f) => ev.fragments.push(f),
    onSpeaking: (s, at) => ev.speaking.push([s, at]),
    onState: (s, d) => {
      ev.states.push([s, d]);
      ev.log.push(`state:${s}`);
    },
    onLevel: (l) => ev.levels.push(l),
    onFailed: (id, r) => ev.failed.push([id, r]),
    onPause: (via, ms) => {
      ev.log.push("onPause");
      ev.pauses.push([via, ms]);
      ev.atPause.push({
        tracksStopped: stream.track.stopped,
        vadDestroyed: vad?.destroyed ?? false,
        openSockets: FakeWs.instances.filter((w) => !w.isClosed).length,
        state: engine.state,
      });
    },
    onStats: (s) => ev.stats.push(s),
    requestWisprToken,
    getWisprContext: () => wisprCtx,
    getActivity: () => "desk",
    getMode: () => mode,
    onDiagnostic: (d) => ev.diags.push(d),
    ...(o.tuning ? { tuning: o.tuning } : {}),
    ...o.callbacks,
  };
  const engine = createMicEngineFactory({
    clock,
    getUserMedia,
    createAudioContext,
    createVad: async (cfg, handlers) => {
      const v = new ScriptedVad(cfg, handlers);
      const origDestroy = v.destroy.bind(v);
      v.destroy = async () => {
        ev.log.push("vad.destroy");
        return origDestroy();
      };
      vad = v;
      return v;
    },
    createSocket: (url) => new FakeWs(url),
    fetch: fetchMock as unknown as typeof fetch,
    document: (o.doc ?? null) as unknown as Document | null,
    window: (o.win ?? null) as unknown as Window | null,
  })(opts);

  return {
    clock,
    engine,
    ev,
    stream,
    ctx,
    requestWisprToken,
    getUserMedia,
    createAudioContext,
    fetchMock,
    wisprCtx,
    get vad(): ScriptedVad {
      if (!vad) throw new Error("VAD was never created");
      return vad;
    },
    hasVad: () => vad !== undefined,
    setMode: (m: "normal" | "eco") => {
      mode = m;
    },
    resolveGum: () => resolveGum?.(),
  };
}
type H = ReturnType<typeof boot>;

/** start the engine and bring the first standby socket up */
async function startReady(h: H): Promise<FakeWs> {
  await h.engine.start();
  await flush();
  const ws = FakeWs.instances[0]!;
  ws.open();
  ws.serverSend({ status: "auth" });
  await flush();
  return ws;
}

/** the newest socket is the next standby: open + authenticate it */
async function upLatest(): Promise<FakeWs> {
  await flush();
  const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
  ws.open();
  ws.serverSend({ status: "auth" });
  await flush();
  return ws;
}

async function speak(h: H, ms: number, rms = 0.08): Promise<void> {
  for (let i = 0; i < Math.round(ms / 32); i++) {
    h.clock.advance(32);
    await h.vad.feed(frameWithRms(rms), 0.9);
  }
}

async function quiet(h: H, ms: number, rms = 0.002): Promise<void> {
  for (let i = 0; i < Math.round(ms / 32); i++) {
    h.clock.advance(32);
    await h.vad.feed(frameWithRms(rms), 0.02);
  }
}

const finalFor = (ws: FakeWs, text: string, lang = "en") =>
  ws.serverSend({ status: "text", position: 1, final: true, body: { text, detected_language: lang } });

beforeEach(() => FakeWs.reset());

/* ============================================================================ lifecycle */

describe("start()", () => {
  it("opens the mic synchronously inside the user gesture with the voice constraints, then listens", async () => {
    const h = boot();
    const p = h.engine.start();
    // BEFORE any await: iOS/Safari only honour getUserMedia + AudioContext.resume inside the gesture
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.getUserMedia.mock.calls[0]![0]).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(h.createAudioContext).toHaveBeenCalledTimes(1);
    expect(h.ctx.resumeCalls).toBe(1);
    await p;
    expect(h.ev.states.map((s) => s[0])).toEqual(["starting", "listening"]);
    expect(h.engine.running).toBe(true);
    expect(h.engine.state).toBe("listening");
  });

  it("configures the VAD for whispers and low latency (TRD §5.2)", async () => {
    const h = boot();
    await h.engine.start();
    expect(h.vad.cfg).toMatchObject({
      positiveSpeechThreshold: 0.35,
      negativeSpeechThreshold: 0.2,
      redemptionMs: 480,
      preSpeechPadMs: 320,
      minSpeechMs: 160,
      assetPath: "/vad/",
    });
    expect(h.vad.cfg.stream).toBe(h.stream);
    expect(h.vad.started).toBe(true);
  });

  it("honours tuning overrides (AGC off, redemption, asset path, wispr timeouts)", async () => {
    const h = boot({ tuning: { autoGainControl: false, redemptionMs: 700, vadAssetPath: "/assets/vad/", positiveSpeechThreshold: 0.4 } });
    await h.engine.start();
    expect((h.getUserMedia.mock.calls[0]![0].audio as MediaTrackConstraints).autoGainControl).toBe(false);
    expect(h.vad.cfg).toMatchObject({ redemptionMs: 700, assetPath: "/assets/vad/", positiveSpeechThreshold: 0.4 });
  });

  it("is idempotent while running", async () => {
    const h = boot();
    await h.engine.start();
    await h.engine.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("asks for a Wispr token and brings up a standby socket authenticated with it", async () => {
    const h = boot();
    await h.engine.start();
    await flush();
    expect(h.requestWisprToken).toHaveBeenCalledTimes(1);
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0]!.url).toBe(`${WS_URL}?client_key=Bearer%20jwt-1`);
  });

  it("start() never rejects: a denied microphone is reported as state 'error' and everything is released", async () => {
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const h = boot({ gumError: err });
    await expect(h.engine.start()).resolves.toBeUndefined();
    expect(h.engine.state).toBe("error");
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["error", "microphone permission denied"]);
    expect(h.ctx.closed).toBe(true);
    expect(h.hasVad()).toBe(false);
    expect(h.engine.running).toBe(false);
  });

  it("maps the usual getUserMedia failures to readable details", () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(micErrorDetail(named("NotAllowedError"))).toBe("microphone permission denied");
    expect(micErrorDetail(named("NotFoundError"))).toBe("no microphone found");
    expect(micErrorDetail(named("NotReadableError"))).toMatch(/busy/);
    expect(micErrorDetail(named("OverconstrainedError"))).toMatch(/settings/);
    expect(micErrorDetail(named("NotSupportedError"))).toMatch(/HTTPS/);
    expect(micErrorDetail(new Error("x"))).toBe("microphone error: Error");
    expect(micErrorDetail(undefined)).toBe("microphone error");
  });

  it("a VAD that fails to load puts the engine in 'error' and gives the microphone back", async () => {
    FakeWs.reset();
    const stream = new FakeStream();
    const ctx = new FakeAudioContext();
    const states: Array<[AudioState, string | undefined]> = [];
    const engine = createMicEngineFactory({
      clock: new FakeClock(),
      getUserMedia: async () => stream as unknown as MediaStream,
      createAudioContext: () => ctx as unknown as AudioContext,
      createVad: async () => {
        throw new Error("404 silero_vad_v5.onnx");
      },
      document: null,
    })({
      deviceId: "dev-1",
      sessionId: "s",
      deviceKind: "desk",
      onFragment: () => undefined,
      onSpeaking: () => undefined,
      onState: (s, d) => states.push([s, d]),
      onLevel: () => undefined,
      onFailed: () => undefined,
      onPause: () => undefined,
      onStats: () => undefined,
      requestWisprToken: async () => ({ mode: "mock" }),
      getWisprContext: () => ({ dictionary: [], conversation: [], language: [], userFirstName: "" }),
      getActivity: () => "desk",
      getMode: () => "normal",
    });
    await engine.start();
    expect(engine.state).toBe("error");
    expect(states[states.length - 1]![1]).toMatch(/voice detection failed to load.*404/);
    expect(stream.track.stopped).toBe(true);
    expect(ctx.closed).toBe(true);
  });

  it("stop() racing a pending getUserMedia gives the late microphone straight back", async () => {
    const h = boot({ deferGum: true });
    const p = h.engine.start();
    await flush();
    await h.engine.stop();
    expect(h.engine.state).toBe("off");
    h.resolveGum();
    await p;
    await flush();
    expect(h.stream.track.stopped).toBe(true);
    expect(h.hasVad()).toBe(false);
    expect(h.ctx.closed).toBe(true);
    expect(h.engine.state).toBe("off");
  });

  it("can be restarted after a pause (the deliberate resume tap)", async () => {
    const h = boot();
    await h.engine.start();
    await h.engine.pause("tap");
    expect(h.engine.state).toBe("paused");
    await h.engine.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.engine.state).toBe("listening");
  });
});

describe("stop()", () => {
  it("releases everything: tracks, VAD, sockets, timers, AudioContext", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 6_000); // let the stats timer run
    await h.engine.stop();
    expect(h.engine.state).toBe("off");
    expect(h.engine.running).toBe(false);
    expect(h.stream.track.stopped).toBe(true);
    expect(h.vad.destroyed).toBe(true);
    expect(h.ctx.closed).toBe(true);
    expect(ws0.isClosed).toBe(true);
    expect(FakeWs.instances.every((w) => w.isClosed)).toBe(true);
    expect(FakeWs.instances.every((w) => w.ofType("commit").length === 0)).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.stream.track.listenerCount()).toBe(0);
    await h.engine.stop(); // idempotent
    expect(h.ev.states.filter((s) => s[0] === "off")).toHaveLength(1);
  });

  it("is a no-op for the kill-switch state accounting: no onPause for a plain stop", async () => {
    const h = boot();
    await h.engine.start();
    await h.engine.stop();
    expect(h.ev.pauses).toHaveLength(0);
  });
});

describe("pause(via)", () => {
  it("tap / remote: mic released, state 'paused', and NO onPause callback (the UI already knows)", async () => {
    for (const via of ["tap", "remote"] as const) {
      const h = boot();
      await startReady(h);
      await h.engine.pause(via);
      expect(h.engine.state).toBe("paused");
      expect(h.ev.states[h.ev.states.length - 1]).toEqual(["paused", via]);
      expect(h.stream.track.stopped).toBe(true);
      expect(h.vad.destroyed).toBe(true);
      expect(FakeWs.instances.every((w) => w.isClosed)).toBe(true);
      expect(h.ev.pauses).toHaveLength(0);
      expect(h.clock.pendingTimers).toBe(0);
    }
  });

  it("kws: reports onPause('kws', latency) after the mic is released", async () => {
    const h = boot();
    await startReady(h);
    await h.engine.pause("kws");
    expect(h.ev.pauses).toHaveLength(1);
    expect(h.ev.pauses[0]![0]).toBe("kws");
    expect(h.ev.pauses[0]![1]).toBeGreaterThanOrEqual(1);
    expect(h.ev.atPause[0]).toMatchObject({ tracksStopped: true, state: "paused" });
  });

  it("works from 'off' too (a remote pause for a device that is not listening)", async () => {
    const h = boot();
    await h.engine.pause("remote");
    expect(h.engine.state).toBe("paused");
  });
});

/* ============================================================================ capturing speech */

describe("an utterance end to end", () => {
  it("streams the pre-roll at once, commits at the VAD end, and emits a schema-valid fragment", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 2200); // calibration window
    expect(h.ev.diags.some((d) => d.kind === "calibrated")).toBe(true);

    const S = h.clock.now();
    await speak(h, 640); // 20 voiced frames
    // CAP-1: the first packets left immediately, pre-roll included (15 silent frames + the first voiced one)
    const firstAppend = ws0.ofType("append")[0]!;
    expect(firstAppend.position).toBe(0);
    expect(firstAppend.audio_packets.packets).toHaveLength(16);
    expect(firstAppend.audio_packets.volumes.slice(0, 15).every((v: number) => Math.abs(v - 0.002) < 1e-4)).toBe(true);
    expect(firstAppend.audio_packets.volumes[15]).toBeCloseTo(0.08, 4);
    expect(h.engine.state).toBe("hearing");
    expect(ws0.ofType("commit")).toHaveLength(0);

    const E = h.clock.now();
    await quiet(h, 480); // 15 silent frames = the redemption window -> VAD speech end
    expect(h.engine.state).toBe("listening");
    expect(ws0.ofType("commit")).toHaveLength(1);
    const commitAt = h.clock.now();
    const total = ws0.ofType("commit")[0]!.total_packets as number;
    const sent = ws0.ofType("append").reduce((n, a) => n + (a.audio_packets.packets.length as number), 0);
    expect(total).toBe(sent); // every packet that was appended is accounted for in the commit
    expect(total).toBe(16 + 19 + 15); // pre-roll + remaining voiced + redemption tail

    h.clock.advance(300);
    finalFor(ws0, "Email the team about the delay");
    expect(h.ev.fragments).toHaveLength(1);
    const f = h.ev.fragments[0]!;
    expect(FragmentFinalSchema.safeParse(f).success).toBe(true);
    expect(f).toMatchObject({
      type: "fragment.final",
      sessionId: "sess-1",
      text: "Email the team about the delay",
      detectedLanguage: "en",
      durationMs: 640,
      pauseBeforeMs: 0,
      whisper: false,
      transport: "wispr_ws",
      activity: "desk",
    });
    expect(f.fragmentId).toMatch(/^dev-1-[0-9a-z]+-0$/);
    expect(f.t.speechStart).toBe(S);
    expect(f.t.speechEnd).toBe(E); // END OF THE LAST VOICED FRAME, not the VAD event
    expect(f.t.commitSent).toBe(commitAt);
    expect(f.t.commitSent! - f.t.speechEnd).toBe(480); // the redemption wait is visible in the latency chain
    expect(f.t.wisprFinal).toBe(commitAt + 300);
    expect(f.rmsMean).toBeCloseTo(0.08, 4);
    expect(f.rmsMax).toBeCloseTo(0.08, 4);
    // VAD boundaries for the server's speech-aware delivery timing
    expect(h.ev.speaking).toEqual([
      [true, S],
      [false, E],
    ]);
    expect(h.ev.states.map((s) => s[0])).toEqual(["starting", "listening", "hearing", "listening"]);
    expect(h.ev.failed).toHaveLength(0);
    // the next standby was opened the moment the first one was claimed
    expect(FakeWs.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("append cadence is every 4 packets (normal mode) with cumulative positions and constant packet_duration", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 640);
    await speak(h, 960); // 30 voiced frames
    await quiet(h, 480);
    const appends = ws0.ofType("append");
    let pos = 0;
    for (const a of appends) {
      expect(a.position).toBe(pos);
      expect(a.audio_packets.packet_duration).toBe(0.032);
      pos += a.audio_packets.packets.length as number;
    }
    expect(appends.slice(1, -1).every((a) => a.audio_packets.packets.length === 4)).toBe(true);
    expect(ws0.ofType("commit")[0]!.total_packets).toBe(pos);
  });

  it("back-to-back utterances: pauseBeforeMs is the real silence between them", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 2200);
    await speak(h, 640);
    const E1 = h.clock.now();
    await quiet(h, 480);
    h.clock.advance(250);
    finalFor(ws0, "first thought");
    const ws1 = await upLatest();
    await quiet(h, 1000);
    const S2 = h.clock.now();
    await speak(h, 480);
    await quiet(h, 480);
    finalFor(ws1, "second thought");
    expect(h.ev.fragments.map((f) => f.text)).toEqual(["first thought", "second thought"]);
    const f2 = h.ev.fragments[1]!;
    expect(f2.pauseBeforeMs).toBe(S2 - E1);
    expect(f2.pauseBeforeMs).toBeGreaterThan(1400);
    expect(f2.fragmentId).not.toBe(h.ev.fragments[0]!.fragmentId);
    expect(f2.t.speechStart).toBeGreaterThan(h.ev.fragments[0]!.t.speechEnd);
  });

  it("a VAD misfire aborts the session WITHOUT commit and emits nothing", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 1000);
    await speak(h, 64); // 2 voiced frames < minSpeech (5 frames)
    expect(h.engine.state).toBe("hearing");
    expect(ws0.ofType("append")).toHaveLength(1); // the pre-roll had already gone out
    await quiet(h, 480);
    expect(h.engine.state).toBe("listening");
    expect(ws0.ofType("commit")).toHaveLength(0);
    expect(ws0.isClosed).toBe(true);
    expect(h.ev.fragments).toHaveLength(0);
    expect(h.ev.failed).toHaveLength(0);
    expect(h.ev.speaking.map((s) => s[0])).toEqual([true, false]);
    // a fresh standby exists for the next utterance
    expect(FakeWs.instances.filter((w) => !w.isClosed)).toHaveLength(1);
    h.clock.advance(10_000);
    await flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("flags whispers: mean voiced RMS below max(noiseFloor x 3, 0.012)", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 2200); // noise floor ~0.002
    await speak(h, 480, 0.006);
    await quiet(h, 480);
    finalFor(ws0, "this is a whisper");
    const ws1 = await upLatest();
    await quiet(h, 800);
    await speak(h, 480, 0.08);
    await quiet(h, 480);
    finalFor(ws1, "this is not");
    expect(h.ev.fragments.map((f) => f.whisper)).toEqual([true, false]);
    expect(h.ev.fragments[0]!.rmsMean).toBeCloseTo(0.006, 4);
  });

  it("the whisper threshold follows a noisier room (floor x 3)", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await quiet(h, 2200, 0.01); // noisy room: floor 0.01 -> threshold 0.03
    await speak(h, 480, 0.025);
    await quiet(h, 480, 0.01);
    finalFor(ws0, "quiet but audible");
    expect(h.ev.fragments[0]!.whisper).toBe(true);
  });

  it("an empty Wispr final produces no fragment and no failure", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await speak(h, 480);
    await quiet(h, 480);
    finalFor(ws0, "   ");
    expect(h.ev.fragments).toHaveLength(0);
    expect(h.ev.failed).toHaveLength(0);
  });

  it("Wispr down for an utterance: REST fallback result is reported with transport wispr_rest", async () => {
    const h = boot();
    await startReady(h);
    await speak(h, 480);
    await quiet(h, 480);
    h.clock.advance(4_001);
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.ev.fragments).toHaveLength(1);
    expect(h.ev.fragments[0]).toMatchObject({ text: "rest text", transport: "wispr_rest" });
    expect(h.ev.diags.some((d) => d.kind === "fallback")).toBe(true);
  });

  it("both Wispr and REST failing -> onFailed(fragmentId, reason), no fragment", async () => {
    const h = boot();
    h.fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    await startReady(h);
    await speak(h, 480);
    await quiet(h, 480);
    h.clock.advance(4_001);
    await flush();
    expect(h.ev.fragments).toHaveLength(0);
    expect(h.ev.failed).toHaveLength(1);
    expect(h.ev.failed[0]![0]).toMatch(/^dev-1-/);
    expect(h.ev.failed[0]![1]).toMatch(/rest fallback failed/);
  });

  it("splits an utterance that never ends (stuck VAD / constant noise) at maxUtteranceMs", async () => {
    const h = boot({ tuning: { maxUtteranceMs: 2000 } });
    const ws0 = await startReady(h);
    await speak(h, 3000);
    // first part committed at ~2 s, a second utterance carries on
    expect(ws0.ofType("commit")).toHaveLength(1);
    expect(h.ev.diags.some((d) => d.kind === "anomaly")).toBe(true);
    const ws1 = await upLatest();
    await speak(h, 1500);
    await quiet(h, 480);
    expect(ws1.ofType("commit")).toHaveLength(1);
    finalFor(ws0, "part one");
    finalFor(ws1, "part two");
    expect(h.ev.fragments.map((f) => f.text)).toEqual(["part one", "part two"]);
    expect(h.ev.fragments[1]!.pauseBeforeMs).toBe(0);
    expect(h.ev.fragments[0]!.durationMs).toBeLessThanOrEqual(2100);
    // no phantom "silence" events from the split
    expect(h.ev.speaking.filter((s) => !s[0])).toHaveLength(1);
  });
});

/* ============================================================================ levels, stats, eco */

describe("levels", () => {
  it("calls onLevel ~15x per second with a normalised 0..1 value that tracks loudness", async () => {
    const h = boot();
    await startReady(h);
    await quiet(h, 3000);
    const quietLevels = h.ev.levels.slice();
    h.ev.levels.length = 0;
    await speak(h, 10_000, 0.08);
    const perSecond = h.ev.levels.length / 10;
    expect(perSecond).toBeGreaterThan(14);
    expect(perSecond).toBeLessThan(17);
    expect(h.ev.levels.every((l) => l >= 0 && l <= 1)).toBe(true);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(quietLevels.slice(-20))).toBeLessThan(0.1);
    expect(avg(h.ev.levels.slice(-20))).toBeGreaterThan(0.6);
  });

  it("stops reporting levels once paused", async () => {
    const h = boot();
    await startReady(h);
    await quiet(h, 500);
    await h.engine.pause("tap");
    const n = h.ev.levels.length;
    await quiet(h, 500);
    expect(h.ev.levels.length).toBe(n);
  });
});

describe("stats (Battery Lab)", () => {
  it("reports every 5 s: frames, cpu, radio time (with 2 s tail) and bytes", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    h.vad.modelCostMs = 2;
    await quiet(h, 1000);
    await speak(h, 960); // ~1 s streaming
    await quiet(h, 480);
    finalFor(ws0, "something said");
    await quiet(h, 4000);
    expect(h.ev.stats.length).toBeGreaterThanOrEqual(1);
    const s = h.ev.stats[0]!;
    expect(s.windowMs).toBe(5000);
    expect(s.mode).toBe("normal");
    expect(s.framesTotal).toBeGreaterThan(100);
    expect(s.framesSkipped).toBe(0);
    expect(s.cpuMs).toBeGreaterThan(s.framesTotal * 1.9);
    expect(s.radioMs).toBeGreaterThan(1500);
    expect(s.radioMs).toBeLessThan(5000);
    expect(s.bytesUp).toBeGreaterThan(30 * 1368);
    // bytes are base64 characters of audio only
    const sentChars = FakeWs.instances.flatMap((w) => w.ofType("append")).reduce(
      (n, a) => n + (a.audio_packets.packets as string[]).reduce((m, p) => m + p.length, 0),
      0,
    );
    const total = h.ev.stats.reduce((n, x) => n + x.bytesUp, 0);
    expect(total).toBeLessThanOrEqual(sentChars);
  });

  it("silence produces zero network audio and zero radio time", async () => {
    const h = boot();
    await startReady(h);
    await quiet(h, 12_000);
    const total = h.ev.stats.reduce((n, x) => ({ b: n.b + x.bytesUp, r: n.r + x.radioMs }), { b: 0, r: 0 });
    expect(total).toEqual({ b: 0, r: 0 });
    expect(FakeWs.instances.flatMap((w) => w.ofType("append"))).toHaveLength(0);
  });
});

describe("eco mode", () => {
  it("raises the VAD threshold by 0.10, batches 8 packets per append, and skips VAD on every 2nd quiet frame after 3 s", async () => {
    const h = boot({ mode: "eco" });
    const ws0 = await startReady(h);
    expect(h.vad.cfg.positiveSpeechThreshold).toBeCloseTo(0.45, 6);
    await quiet(h, 2200); // calibrate
    const skippedBefore = h.vad.skipped;
    await quiet(h, 10_000);
    const skipped = h.vad.skipped - skippedBefore;
    // 10 s = 312 frames; the first 3 s run at full duty, then half of the remaining ~219 are skipped
    expect(skipped).toBeGreaterThan(90);
    expect(skipped).toBeLessThan(125);
    // energy rises -> full duty immediately: the first loud frame goes to the model
    const before = h.vad.skipped;
    await speak(h, 960);
    expect(h.vad.skipped).toBe(before);
    expect(h.engine.state).toBe("hearing");
    await quiet(h, 480);
    const sizes = ws0.ofType("append").map((a) => a.audio_packets.packets.length as number);
    expect(sizes[0]).toBe(16); // pre-roll
    expect(sizes.slice(1, -1).every((n) => n === 8)).toBe(true);
    // stats carry the skipped frames and the mode
    await quiet(h, 5000);
    const withSkips = h.ev.stats.filter((s) => s.framesSkipped > 0);
    expect(withSkips.length).toBeGreaterThan(0);
    expect(withSkips.every((s) => s.mode === "eco")).toBe(true);
    expect(h.ev.stats.reduce((n, s) => n + s.framesSkipped, 0)).toBeLessThanOrEqual(h.vad.skipped);
    expect(h.ev.diags.filter((d) => d.kind === "mode")).toEqual([{ kind: "mode", mode: "eco" }]); // reported once, at start
  });

  it("re-reads the mode at utterance boundaries and retunes the live VAD", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    expect(h.vad.thresholds.pos).toBeCloseTo(0.35, 6);
    h.setMode("eco");
    await speak(h, 480);
    await quiet(h, 480); // utterance end -> boundary
    expect(h.vad.thresholds.pos).toBeCloseTo(0.45, 6);
    expect(h.vad.thresholds.neg).toBeCloseTo(0.2, 6);
    expect(h.ev.diags).toContainEqual({ kind: "mode", mode: "eco" });
    finalFor(ws0, "one");
    h.setMode("normal");
    const ws1 = await upLatest();
    await speak(h, 480);
    await quiet(h, 480);
    expect(h.vad.thresholds.pos).toBeCloseTo(0.35, 6);
    finalFor(ws1, "two");
    expect(h.ev.fragments).toHaveLength(2);
  });

  it("the mode is also re-read on the 5 s maintenance tick (no utterances needed)", async () => {
    const h = boot();
    await startReady(h);
    h.setMode("eco");
    await quiet(h, 5200);
    expect(h.vad.thresholds.pos).toBeCloseTo(0.45, 6);
  });
});

/* ============================================================================ the kill switch */

describe("local kill switch", () => {
  async function sayPauseMemory(h: H) {
    const ws0 = await startReady(h);
    await quiet(h, 2200);
    // utterance 1: a normal thought
    await speak(h, 640);
    await quiet(h, 480);
    h.clock.advance(250);
    finalFor(ws0, "Email the team about the delay");
    const ws1 = await upLatest();
    // utterance 2: the pause phrase
    await quiet(h, 600);
    await speak(h, 480, 0.012); // whispered
    const E2 = h.clock.now();
    await quiet(h, 480);
    expect(ws1.ofType("commit")).toHaveLength(1);
    const ws2 = await upLatest();
    // utterance 3 starts while the phrase is still being transcribed
    await speak(h, 160, 0.05);
    const ws3 = await upLatest();
    expect(h.engine.state).toBe("hearing");
    h.clock.advance(300);
    return { ws0, ws1, ws2, ws3, E2 };
  }

  it("releases the mic FIRST, then VAD + sockets + buffers; reports onPause only afterwards; never emits the phrase", async () => {
    const h = boot();
    const { ws0, ws1, ws2, ws3, E2 } = await sayPauseMemory(h);
    expect(h.ev.fragments).toHaveLength(1);
    const logBefore = h.ev.log.length;
    const releaseTime = h.clock.now();

    finalFor(ws1, "Pause memory.");

    // ---- ordering: tracks stop first ----
    expect(h.ev.log.slice(logBefore)).toEqual(["track.stop", "vad.destroy", "state:paused", "onPause"]);
    // ---- the world at the moment onPause fired ----
    expect(h.ev.atPause).toEqual([{ tracksStopped: true, vadDestroyed: true, openSockets: 0, state: "paused" }]);
    // ---- result ----
    expect(h.ev.pauses).toEqual([["voice", releaseTime - E2]]);
    expect(h.ev.pauses[0]![1]).toBe(480 + 160 + 300); // redemption + the speech that continued + wispr latency
    expect(h.ev.fragments).toHaveLength(1); // the pause phrase is NOT a fragment
    expect(h.ev.fragments.every((f) => !/pause/i.test(f.text))).toBe(true);
    expect(h.engine.state).toBe("paused");
    expect(h.engine.running).toBe(false);
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["paused", "voice"]);
    // every socket is closed; the in-flight utterance 3 and the standby never saw a commit
    for (const w of [ws0, ws1, ws2, ws3]) expect(w.isClosed).toBe(true);
    expect(ws2.ofType("commit")).toHaveLength(0);
    expect(ws3.ofType("commit")).toHaveLength(0);
    expect(FakeWs.instances.every((w) => w.isClosed)).toBe(true);
    await flush();
    expect(h.ctx.closed).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.stream.track.stopped).toBe(true);
  });

  it("is airtight afterwards: late frames, late finals and timers do nothing", async () => {
    const h = boot();
    const { ws2 } = await sayPauseMemory(h);
    finalFor(FakeWs.instances[1]!, "Pause memory.");
    const sockets = FakeWs.instances.length;
    const events = JSON.stringify([h.ev.fragments, h.ev.speaking, h.ev.levels.length, h.ev.failed, h.ev.pauses]);
    // the dying utterance 3 gets a final and the audio worklet keeps delivering frames for a moment
    finalFor(ws2, "something I said after");
    await speak(h, 800);
    await quiet(h, 800);
    h.clock.advance(120_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(sockets); // nothing reopened
    expect(JSON.stringify([h.ev.fragments, h.ev.speaking, h.ev.levels.length, h.ev.failed, h.ev.pauses])).toBe(events);
    expect(h.fetchMock).not.toHaveBeenCalled(); // nothing escaped to REST
  });

  it("matches meaning-equivalent phrases, not ordinary sentences", async () => {
    for (const [text, pauses] of [
      ["Stop listening.", true],
      ["off the record please", true],
      ["go private", true],
      ["memory band karo", true],
      ["we should pause recording the metrics for a few days", false],
      ["remember to stop the listener service", false],
    ] as const) {
      const h = boot();
      const ws0 = await startReady(h);
      await speak(h, 480);
      await quiet(h, 480);
      finalFor(ws0, text);
      expect(h.ev.pauses.length, text).toBe(pauses ? 1 : 0);
      expect(h.ev.fragments.length, text).toBe(pauses ? 0 : 1);
      expect(h.stream.track.stopped, text).toBe(pauses);
    }
  });

  it("works on typed input too (injectText), through the same real kill switch", async () => {
    const h = boot();
    await startReady(h);
    h.engine.injectText?.("pause memory");
    expect(h.engine.state).toBe("paused");
    expect(h.stream.track.stopped).toBe(true);
    expect(h.vad.destroyed).toBe(true);
    expect(h.ev.pauses).toHaveLength(1);
    expect(h.ev.pauses[0]![0]).toBe("voice");
    expect(h.ev.pauses[0]![1]).toBeGreaterThanOrEqual(1);
    expect(h.ev.fragments).toHaveLength(0);
    expect(FakeWs.instances.every((w) => w.isClosed)).toBe(true);
  });

  it("pause latency counts from the end of the phrase, so it is honest about the redemption wait", async () => {
    const h = boot();
    const ws0 = await startReady(h);
    await speak(h, 320, 0.01);
    const E = h.clock.now();
    await quiet(h, 480);
    h.clock.advance(120);
    finalFor(ws0, "pause memory");
    expect(h.ev.pauses[0]![1]).toBe(h.clock.now() - E);
    expect(h.ev.pauses[0]![1]).toBe(600);
  });
});

/* ============================================================================ no key / token flows */

describe("without a usable Wispr token", () => {
  it("mode 'mock': still captures (levels, speaking, hearing) but streams nothing and reports the typed-input detail", async () => {
    const h = boot({ token: async () => ({ mode: "mock" }) });
    await h.engine.start();
    await flush();
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", NO_KEY_DETAIL]);
    expect(h.engine.running).toBe(true);
    await quiet(h, 1000);
    await speak(h, 640);
    expect(h.engine.state).toBe("hearing");
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["hearing", NO_KEY_DETAIL]);
    await quiet(h, 480);
    expect(h.ev.speaking.map((s) => s[0])).toEqual([true, false]);
    expect(h.ev.levels.length).toBeGreaterThan(10);
    expect(FakeWs.instances).toHaveLength(0); // audio is streamed nowhere
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.ev.fragments).toHaveLength(0);
    h.clock.advance(60_000);
    await flush();
    expect(h.requestWisprToken).toHaveBeenCalledTimes(1); // a deliberate "mock" is not retried
  });

  it("a token error is treated the same way, then retried until it works", async () => {
    let calls = 0;
    const h = boot({
      token: async () => {
        calls++;
        if (calls === 1) throw new Error("server unreachable");
        return clientToken(h.clock);
      },
    });
    await h.engine.start();
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", NO_KEY_DETAIL]);
    expect(FakeWs.instances).toHaveLength(0);
    h.clock.advance(10_000);
    await flush();
    expect(calls).toBe(2);
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", undefined]); // typed-only notice cleared
    expect(FakeWs.instances).toHaveLength(1);
    FakeWs.instances[0]!.open();
    FakeWs.instances[0]!.serverSend({ status: "auth" });
    await quiet(h, 500);
    await speak(h, 480);
    await quiet(h, 480);
    expect(FakeWs.instances[0]!.ofType("commit")).toHaveLength(1);
  });

  it("an error object from the server (mode client + error) counts as a failure too", async () => {
    const h = boot({ token: async () => ({ mode: "client", error: "wispr key rejected" }) });
    await h.engine.start();
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", NO_KEY_DETAIL]);
  });

  it("a token request that never answers times out instead of hanging start()", async () => {
    const h = boot({ token: () => new Promise<WisprTokenInfo>(() => undefined) });
    const p = h.engine.start();
    await flush();
    h.clock.advance(8_001);
    await p;
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", NO_KEY_DETAIL]);
  });

  it("proxy mode is refused: state 'error', and the microphone is released", async () => {
    const h = boot({ token: async () => ({ mode: "proxy" }) });
    await h.engine.start();
    expect(h.engine.state).toBe("error");
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["error", PROXY_UNSUPPORTED_DETAIL]);
    expect(h.stream.track.stopped).toBe(true);
    expect(h.vad.destroyed).toBe(true);
    await flush(); // the AudioContext closes asynchronously; the microphone itself was released synchronously
    expect(h.ctx.closed).toBe(true);
    expect(FakeWs.instances).toHaveLength(0);
  });
});

/* ============================================================================ injectText */

describe("injectText (dev / no-mic fallback)", () => {
  it("behaves like the text engine: onSpeaking pair + a schema-valid fragment with transport 'mock'", async () => {
    const h = boot({ token: async () => ({ mode: "mock" }) });
    await h.engine.start();
    h.engine.injectText?.("Remind me to call Dev at five");
    expect(h.ev.speaking.map((s) => s[0])).toEqual([true, false]);
    expect(h.ev.fragments).toHaveLength(1);
    const f = h.ev.fragments[0]!;
    expect(FragmentFinalSchema.safeParse(f).success).toBe(true);
    expect(f).toMatchObject({
      text: "Remind me to call Dev at five",
      sessionId: "sess-1",
      transport: "mock",
      whisper: false,
      pauseBeforeMs: 0,
      activity: "desk",
    });
    expect(f.fragmentId).toMatch(/^dev-1-/);
    expect(f.durationMs).toBeGreaterThanOrEqual(600);
    h.clock.advance(5000);
    h.engine.injectText?.("second one", { whisper: true });
    expect(h.ev.fragments[1]).toMatchObject({ whisper: true, rmsMean: 0.02 });
    expect(h.ev.fragments[1]!.pauseBeforeMs).toBeGreaterThan(3000);
    expect(new Set(h.ev.fragments.map((x) => x.fragmentId)).size).toBe(2);
  });

  it("is ignored while paused or off", async () => {
    const h = boot();
    h.engine.injectText?.("nobody is listening");
    expect(h.ev.fragments).toHaveLength(0);
    await h.engine.start();
    await h.engine.pause("tap");
    h.engine.injectText?.("still nobody");
    expect(h.ev.fragments).toHaveLength(0);
  });

  it("also works when the mic failed (error state)", async () => {
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const h = boot({ gumError: err });
    await h.engine.start();
    expect(h.engine.state).toBe("error");
    h.engine.injectText?.("typed anyway");
    expect(h.ev.fragments).toHaveLength(1);
  });
});

/* ============================================================================ robustness */

describe("robustness", () => {
  it("the microphone disappearing (track 'ended') is an error and releases everything", async () => {
    const h = boot();
    await startReady(h);
    h.stream.track.fire("ended");
    await flush();
    expect(h.engine.state).toBe("error");
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["error", "microphone disconnected"]);
    expect(h.vad.destroyed).toBe(true);
    expect(FakeWs.instances.every((w) => w.isClosed)).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("a system mute is surfaced as a detail and cleared on unmute", async () => {
    const h = boot();
    await h.engine.start();
    h.stream.track.fire("mute");
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", "microphone muted by the system"]);
    h.stream.track.fire("unmute");
    expect(h.ev.states[h.ev.states.length - 1]).toEqual(["listening", undefined]);
  });

  it("a suspended AudioContext is woken up again", async () => {
    const h = boot();
    await h.engine.start();
    const before = h.ctx.resumeCalls;
    h.ctx.state = "suspended";
    h.ctx.fire("statechange");
    expect(h.ctx.resumeCalls).toBe(before + 1);
  });

  it("UI callbacks that throw never break the audio pipeline", async () => {
    const h = boot({
      callbacks: {
        onLevel: () => {
          throw new Error("ui bug");
        },
        onSpeaking: () => {
          throw new Error("ui bug");
        },
        onStats: () => {
          throw new Error("ui bug");
        },
      },
    });
    const ws0 = await startReady(h);
    await quiet(h, 6000);
    await speak(h, 480);
    await quiet(h, 480);
    finalFor(ws0, "still works");
    expect(h.ev.fragments).toHaveLength(1);
    expect(h.engine.running).toBe(true);
  });

  it("recalibrate() restarts the noise-floor measurement", async () => {
    const h = boot();
    await startReady(h);
    await quiet(h, 2400);
    expect(h.ev.diags.filter((d) => d.kind === "calibrated")).toHaveLength(1);
    h.engine.recalibrate?.();
    await quiet(h, 2400, 0.004);
    const cal = h.ev.diags.filter((d) => d.kind === "calibrated");
    expect(cal).toHaveLength(2);
    expect((cal[1] as { noiseFloor: number }).noiseFloor).toBeCloseTo(0.004, 4);
  });

  it("never logs: the audio sources contain no console calls (transcripts and audio must not leak)", () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const stripped = Object.entries(sources)
      // index.ts is the lead's glue file (it only warns that the engine failed to load)
      .filter(([name]) => !name.endsWith(".test.ts") && !name.includes("test-utils") && !name.includes("test-vad") && name !== "./index.ts")
      .map(([name, src]) => [name, stripComments(src)] as const);
    expect(stripped.length).toBeGreaterThan(8);
    for (const [name, src] of stripped) expect(src, name).not.toMatch(/\bconsole\s*\./);
  });
});

/** crude comment stripper (block comments, whole-line comments, trailing " // ..." that is not part of a URL) */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

describe("page events", () => {
  it("'online' reconnects the Wispr standby at once (venue Wi-Fi blips), not after the backoff", async () => {
    const win = new FakeEventTarget();
    const h = boot({ win });
    const ws0 = await startReady(h);
    h.clock.advance(1000);
    ws0.serverClose(1011); // died young -> the streamer backs off
    await flush();
    expect(FakeWs.instances).toHaveLength(1);
    win.fire("online");
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
  });

  it("the tab becoming visible wakes a suspended AudioContext and reconnects a down standby; hidden does nothing", async () => {
    const doc = new FakeEventTarget();
    const h = boot({ doc });
    const ws0 = await startReady(h);
    h.clock.advance(1000);
    ws0.serverClose(1011);
    await flush();
    const resumes = h.ctx.resumeCalls;
    h.ctx.state = "suspended";
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await flush();
    expect(h.ctx.resumeCalls).toBe(resumes);
    expect(FakeWs.instances).toHaveLength(1);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await flush();
    expect(h.ctx.resumeCalls).toBe(resumes + 1);
    expect(FakeWs.instances).toHaveLength(2);
  });

  it("listeners are removed on stop / pause / kill switch", async () => {
    for (const how of ["stop", "pause", "kill"] as const) {
      const doc = new FakeEventTarget();
      const win = new FakeEventTarget();
      const h = boot({ doc, win });
      const ws0 = await startReady(h);
      expect(doc.count("visibilitychange")).toBe(1);
      expect(win.count("online")).toBe(1);
      if (how === "stop") await h.engine.stop();
      else if (how === "pause") await h.engine.pause("tap");
      else {
        await speak(h, 480);
        await quiet(h, 480);
        finalFor(ws0, "pause memory");
      }
      expect(doc.count()).toBe(0);
      expect(win.count()).toBe(0);
    }
  });
});
