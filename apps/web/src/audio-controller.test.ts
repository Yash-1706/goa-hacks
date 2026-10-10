import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientConfig, ClientMessage } from "@synapse/shared";
import type { AudioEngine, AudioEngineFactory, AudioEngineOptions, AudioState } from "@/audio";
import { createTextEngine } from "@/audio";
import { LatencyTracker } from "@/lib/latency";
import { useAudioUi, useLevel } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { useNotices } from "@/state/notices";
import { usePrivacy } from "@/state/privacy";
import { useSettings } from "@/state/settings";
import { useStream } from "@/state/stream";
import { AudioController, micProblemText } from "./audio-controller";

// the real sensors read window / navigator: keep the controller tests deterministic
vi.mock("@/lib/sensors", () => ({
  preloadSensors: vi.fn(async () => undefined),
  startActivity: vi.fn(async () => () => undefined),
  startBattery: vi.fn(async () => () => undefined),
  acquireWakeLock: vi.fn(async () => ({ release: () => undefined, active: () => true })),
}));

function resetStores(): void {
  useAudioUi.setState(useAudioUi.getInitialState(), true);
  useLevel.setState(useLevel.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useNotices.setState(useNotices.getInitialState(), true);
  usePrivacy.setState(usePrivacy.getInitialState(), true);
  useSettings.setState(useSettings.getInitialState(), true);
  useStream.setState(useStream.getInitialState(), true);
}

const config = (wisprMode: ClientConfig["wisprMode"]): ClientConfig => ({
  wisprMode,
  languages: ["en"],
  llmMode: "mock",
  localOnly: false,
  autonomyLevel: 2,
  pauseWindowSecs: 30,
  ttlHours: 72,
  userFirstName: "Rio",
  timezone: "UTC",
  hackathonStart: 0,
  embeddings: "hash",
  threadCloseMs: 6000,
  dev: true,
  integrations: { github: false, jira: false },
});

/** A scriptable mic engine: what the real one reports, minus the browser. */
function fakeMic(behaviour: { failWith?: string; withInject?: boolean } = {}) {
  const made: Array<{ opts: AudioEngineOptions; engine: FakeMic }> = [];
  class FakeMic implements AudioEngine {
    state: AudioState = "off";
    get running(): boolean {
      return this.state === "listening" || this.state === "hearing";
    }
    start = vi.fn(async () => {
      this.set("starting");
      if (behaviour.failWith) {
        this.set("error", behaviour.failWith);
        return;
      }
      this.set("listening");
    });
    stop = vi.fn(async () => this.set("off"));
    pause = vi.fn(async (_via: string) => this.set("paused"));
    reconnectSpeech = vi.fn();
    injectText = behaviour.withInject === false ? undefined : vi.fn();
    constructor(readonly opts: AudioEngineOptions) {}
    set(s: AudioState, detail?: string): void {
      this.state = s;
      this.opts.onState(s, detail);
    }
  }
  const factory: AudioEngineFactory = (opts) => {
    const engine = new FakeMic(opts);
    made.push({ opts, engine });
    return engine as unknown as AudioEngine;
  };
  return { factory, made, last: () => made[made.length - 1]!.engine, lastOpts: () => made[made.length - 1]!.opts };
}

function setup(mode: ClientConfig["wisprMode"] = "mock", mic: AudioEngineFactory | null = null) {
  resetStores();
  useSettings.getState().setConfig(config(mode));
  useConnection.getState().set({ deviceId: "dev-1", deviceKind: "desk", status: "open" });
  const sent: ClientMessage[] = [];
  const noted: Array<[string, number]> = [];
  const tracker = new LatencyTracker({ send: () => true, now: () => 0, afterPaint: (cb) => cb() });
  vi.spyOn(tracker, "noteLocal").mockImplementation((id, at) => void noted.push([id, at]));
  const requestToken = vi.fn(async () => ({ mode: "client" as const, token: "jwt" }));
  const controller = new AudioController({
    send: (m) => (sent.push(m), true),
    requestToken,
    tracker: () => tracker,
    loadMic: async () => mic,
  });
  const types = (): string[] => sent.map((m) => m.type);
  const find = <T extends ClientMessage["type"]>(t: T): Array<Extract<ClientMessage, { type: T }>> => sent.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === t);
  return { controller, sent, types, find, noted, requestToken };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("starting and stopping", () => {
  it("mock mode: the typed-input engine runs, a session starts, and the orb says listening", async () => {
    const { controller, find } = setup("mock");
    await controller.start();
    const ui = useAudioUi.getState();
    expect(ui).toMatchObject({ state: "listening", engine: "text" });
    expect(ui.sessionId).toMatch(/^ses-/);
    expect(find("session.start")[0]).toMatchObject({ sessionId: ui.sessionId });
    expect(find("context.update").some((m) => m.listening === true)).toBe(true);
  });

  it("live mode: uses the mic engine from the factory and builds the options the contract asks for", async () => {
    const mic = fakeMic();
    const { controller, requestToken } = setup("client", mic.factory);
    await controller.start();
    expect(useAudioUi.getState()).toMatchObject({ state: "listening", engine: "mic", micAvailable: true });
    const o = mic.lastOpts();
    expect(o).toMatchObject({ deviceId: "dev-1", deviceKind: "desk" });
    expect(o.sessionId).toBe(useAudioUi.getState().sessionId);
    await expect(o.requestWisprToken()).resolves.toMatchObject({ token: "jwt" });
    expect(requestToken).toHaveBeenCalledOnce();
    expect(o.getMode()).toBe("normal");
    expect(o.getActivity()).toBe("desk");
    expect(o.getWisprContext()).toMatchObject({ dictionary: [], language: ["en"], userFirstName: "Rio" });
  });

  it("falls back to typed input when the mic engine is not available in this build", async () => {
    const { controller } = setup("client", null);
    await controller.start();
    expect(useAudioUi.getState()).toMatchObject({ state: "listening", engine: "text", micAvailable: false });
    expect(useNotices.getState().toasts.some((t) => /not available/.test(t.text))).toBe(true);
  });

  it("a mic that fails to open (permission denied) degrades to typed input and still opens ONE session", async () => {
    const mic = fakeMic({ failWith: "microphone permission denied" });
    const { controller, find } = setup("client", mic.factory);
    await controller.start();
    expect(useAudioUi.getState()).toMatchObject({ state: "listening", engine: "text", micAvailable: false });
    expect(find("session.start")).toHaveLength(1);
    expect(useNotices.getState().toasts.some((t) => /permission was denied/.test(t.text))).toBe(true);
  });

  it("stop() ends the session so the server can write the brief, and releases everything", async () => {
    const mic = fakeMic();
    const { controller, find } = setup("client", mic.factory);
    await controller.start();
    const sid = useAudioUi.getState().sessionId;
    await controller.stop();
    expect(mic.last().stop).toHaveBeenCalled();
    expect(find("session.end")[0]).toMatchObject({ sessionId: sid });
    expect(useAudioUi.getState()).toMatchObject({ state: "off", engine: null, sessionId: null });
    expect(find("context.update").some((m) => m.listening === false)).toBe(true);
  });

  it("start() while already running does nothing", async () => {
    const { controller, find } = setup("mock");
    await controller.start();
    await controller.start();
    expect(find("session.start")).toHaveLength(1);
  });
});

describe("the orb toggle", () => {
  it("off → start, listening → pause (privacy), paused → resume", async () => {
    const { controller, find } = setup("mock");
    await controller.toggle();
    expect(useAudioUi.getState().state).toBe("listening");
    await controller.toggle();
    expect(useAudioUi.getState().state).toBe("paused");
    expect(find("privacy.pause")[0]).toMatchObject({ via: "tap" });
    expect(usePrivacy.getState().paused).toBe(true);

    await controller.toggle(); // deliberate tap to resume
    expect(find("privacy.resume")).toHaveLength(1);
    expect(useAudioUi.getState().state).toBe("listening");
    expect(find("session.start")).toHaveLength(2); // a new listening session
    expect(find("session.start")[0]?.sessionId).not.toBe(find("session.start")[1]?.sessionId);
  });

  it("tap-pause releases the engine and tells every device", async () => {
    const mic = fakeMic();
    const { controller, find } = setup("client", mic.factory);
    await controller.start();
    await controller.toggle();
    expect(mic.last().pause).toHaveBeenCalledWith("tap");
    expect(find("privacy.pause")).toHaveLength(1);
    expect(find("context.update").some((m) => m.listening === false)).toBe(true);
    expect(useAudioUi.getState().wakeLock).toBe(false);
  });

  it("pauseMemory() works even when nothing is listening here", async () => {
    const { controller, find } = setup("mock");
    await controller.pauseMemory();
    expect(find("privacy.pause")).toHaveLength(1);
    expect(usePrivacy.getState().paused).toBe(true);
  });
});

describe("the local kill switch", () => {
  it("a voice pause from the engine: privacy.pause + the measured latency, both reported, shown in the store", async () => {
    const mic = fakeMic();
    const { controller, find } = setup("client", mic.factory);
    await controller.start();
    mic.last().set("paused", "voice");
    mic.lastOpts().onPause("voice", 412.6);
    expect(find("privacy.pause")[0]).toMatchObject({ via: "voice" });
    expect(find("metrics.client")[0]).toEqual({ type: "metrics.client", fragmentId: "pause", pauseLatencyMs: 413 });
    expect(usePrivacy.getState()).toMatchObject({ paused: true, pauseLatencyMs: 413 });
    expect(useNotices.getState().toasts.some((t) => /413 ms/.test(t.text))).toBe(true);
  });

  it("typed 'pause memory' goes through the same path (the text engine implements the local guard)", async () => {
    const { controller, find } = setup("mock");
    await controller.start();
    await controller.injectText("pause memory");
    expect(find("privacy.pause")[0]).toMatchObject({ via: "voice" });
    expect(find("fragment.final")).toHaveLength(0); // the phrase is never sent as a fragment
    expect(useAudioUi.getState().state).toBe("paused");
  });
});

describe("remote pause / resume", () => {
  it("another device pausing memory releases this mic; resuming only shows 'tap to resume'", async () => {
    const mic = fakeMic();
    const { controller } = setup("client", mic.factory);
    await controller.start();
    controller.onRemotePause();
    expect(mic.last().pause).toHaveBeenCalledWith("remote");

    controller.onRemoteResume();
    expect(mic.made).toHaveLength(1); // no new engine: the mic is NOT restarted automatically
    expect(useAudioUi.getState()).toMatchObject({ resumeHint: true, state: "off" });
    expect(mic.last().running).toBe(false);
  });

  it("does not double-pause an engine this device already paused", async () => {
    const mic = fakeMic();
    const { controller } = setup("client", mic.factory);
    await controller.start();
    await controller.toggle(); // local tap pause
    mic.last().pause.mockClear();
    controller.onRemotePause(); // the server echoes it back
    expect(mic.last().pause).not.toHaveBeenCalled();
  });

  it("a resume echo while this device is itself resuming does not flash the hint", async () => {
    const { controller } = setup("mock");
    await controller.start();
    controller.onRemoteResume();
    expect(useAudioUi.getState().resumeHint).toBe(false);
  });
});

describe("the speech engine switches (local-only mode, or Wispr unreachable)", () => {
  it("a listening mic reconnects to the new engine at once, and the user is told which one it is", async () => {
    const mic = fakeMic();
    const { controller } = setup("client", mic.factory);
    await controller.start();
    controller.onSpeechEngineChange("client", "local");
    expect(mic.last().reconnectSpeech).toHaveBeenCalledOnce();
    expect(useNotices.getState().toasts.some((t) => /transcribed on this machine/.test(t.text))).toBe(true);
    controller.onSpeechEngineChange("local", "client");
    expect(mic.last().reconnectSpeech).toHaveBeenCalledTimes(2);
    expect(useNotices.getState().toasts.some((t) => /Wispr Flow again/.test(t.text))).toBe(true);
    expect(mic.last().stop).not.toHaveBeenCalled(); // the microphone stays open: only the connection moves
    expect(mic.made).toHaveLength(1);
  });

  it("does nothing when nothing is listening, when paused, or with the typed-input engine", async () => {
    const mic = fakeMic();
    const idle = setup("client", mic.factory);
    idle.controller.onSpeechEngineChange("client", "local"); // never started
    expect(mic.made).toHaveLength(0);

    await idle.controller.start();
    await idle.controller.toggle(); // paused: the mic is released
    useNotices.getState().clear?.();
    const before = useNotices.getState().toasts.length;
    idle.controller.onSpeechEngineChange("client", "local");
    expect(mic.last().reconnectSpeech).not.toHaveBeenCalled();
    expect(useNotices.getState().toasts).toHaveLength(before);

    const typed = setup("mock");
    await typed.controller.start();
    expect(() => typed.controller.onSpeechEngineChange("mock", "local")).not.toThrow();
  });

  it("hands the engine the page origin, which is what resolves the on-device endpoints", async () => {
    vi.stubGlobal("location", { origin: "https://192.168.1.20:5173" });
    try {
      const mic = fakeMic();
      const { controller } = setup("local", mic.factory);
      await controller.start();
      expect(mic.lastOpts().origin).toBe("https://192.168.1.20:5173");
    } finally {
      vi.unstubAllGlobals();
    }
    const mic2 = fakeMic();
    const again = setup("local", mic2.factory);
    await again.controller.start();
    expect(mic2.lastOpts().origin).toBeUndefined(); // no page, no origin: nothing invented
  });

  it("'local' is a speech mode: the mic engine is used, not typed input", async () => {
    const mic = fakeMic();
    const { controller } = setup("local", mic.factory);
    await controller.start();
    expect(useAudioUi.getState()).toMatchObject({ state: "listening", engine: "mic" });
  });

  it("says once why Wispr was replaced when the server falls back to the on-device engine", async () => {
    const mic = fakeMic();
    const { controller, requestToken } = setup("client", mic.factory);
    const note = "Wispr unavailable (Wispr rejected the API key (401)): on-device speech is active";
    requestToken.mockResolvedValue({ mode: "local" as never, token: "lt1.a.b", wsUrl: "/local-stt/client_ws", restUrl: "/local-stt/client_api", note } as never);
    await controller.start();
    const o = mic.lastOpts();
    await o.requestWisprToken();
    await o.requestWisprToken({ force: true });
    expect(useNotices.getState().toasts.filter((t) => t.text === note)).toHaveLength(1);
  });
});

describe("engine callbacks wire to the socket and the stores", () => {
  it("fragments are sent, shown at once and registered for latency reporting", async () => {
    const mic = fakeMic();
    const { controller, find, noted } = setup("client", mic.factory);
    await controller.start();
    mic.lastOpts().onFragment({
      type: "fragment.final",
      fragmentId: "frag-1",
      sessionId: useAudioUi.getState().sessionId as string,
      text: "the null pointer",
      t: { speechStart: 1000, speechEnd: 2000, commitSent: 2000, wisprFinal: 2300 },
      durationMs: 1000,
      pauseBeforeMs: 500,
      rmsMean: 0.05,
      rmsMax: 0.1,
      whisper: true,
      transport: "wispr_ws",
    });
    expect(find("fragment.final")[0]).toMatchObject({ fragmentId: "frag-1", whisper: true });
    expect(noted).toEqual([["frag-1", 2300]]);
    expect(useStream.getState().pending[0]).toMatchObject({ id: "frag-1", text: "the null pointer", whisper: true });
  });

  it("speech state, levels, failures and stats", async () => {
    const mic = fakeMic();
    const { controller, find } = setup("client", mic.factory);
    await controller.start();
    const o = mic.lastOpts();
    o.onSpeaking(true, 123);
    expect(find("speech.state")[0]).toEqual({ type: "speech.state", speaking: true, at: 123 });
    expect(useAudioUi.getState().speaking).toBe(true);
    o.onLevel(0.4);
    expect(useLevel.getState().level).toBe(0.4);
    o.onLevel(7);
    expect(useLevel.getState().level).toBe(1);
    o.onFailed("frag-9", "wispr timeout");
    expect(find("fragment.failed")[0]).toEqual({ type: "fragment.failed", fragmentId: "frag-9", reason: "wispr timeout" });
    expect(useNotices.getState().toasts.some((t) => /could not be transcribed/.test(t.text))).toBe(true);

    useAudioUi.getState().set({ battery: { level: 0.64, charging: true } });
    o.onStats({ windowMs: 5000, cpuMs: 12, radioMs: 800, bytesUp: 4096, mode: "eco", framesSkipped: 3, framesTotal: 150 });
    expect(find("metrics.battery")[0]).toEqual({ type: "metrics.battery", mode: "eco", cpuMs: 12, radioMs: 800, bytesUp: 4096, windowMs: 5000, level: 0.64, charging: true });
  });

  it("passes the force flag of a re-mint request through to the server", async () => {
    const mic = fakeMic();
    const { controller, requestToken } = setup("client", mic.factory);
    await controller.start();
    await mic.lastOpts().requestWisprToken({ force: true });
    expect(requestToken).toHaveBeenLastCalledWith({ force: true });
    await mic.lastOpts().requestWisprToken();
    expect(requestToken).toHaveBeenLastCalledWith(undefined);
  });

  it("a token request that fails is reported to the engine as an error result, not a throw", async () => {
    const mic = fakeMic();
    const { controller, requestToken } = setup("client", mic.factory);
    await controller.start();
    requestToken.mockRejectedValueOnce(new Error("Not connected to the Synapse server"));
    await expect(mic.lastOpts().requestWisprToken()).resolves.toMatchObject({ mode: "client", error: "Not connected to the Synapse server" });
  });

  it("diagnostics are collected for the Lab (never text)", async () => {
    const mic = fakeMic();
    const { controller } = setup("client", mic.factory);
    await controller.start();
    mic.lastOpts().onDiagnostic?.({ kind: "calibrated", noiseFloor: 0.004 });
    mic.lastOpts().onDiagnostic?.({ kind: "latency", commitToFinalMs: 310, transport: "wispr_ws" });
    mic.lastOpts().onDiagnostic?.({ kind: "fallback", reason: "socket closed" });
    const ui = useAudioUi.getState();
    expect(ui.noiseFloor).toBe(0.004);
    expect(ui.lastFinalLatencyMs).toBe(310);
    expect(ui.diagnostics).toHaveLength(3);
    expect(ui.degraded).toMatch(/REST fallback/);
  });
});

describe("reconnecting", () => {
  it("re-announces a running session to the fresh server-side device record", async () => {
    const { controller, find } = setup("mock");
    await controller.start();
    const sid = useAudioUi.getState().sessionId;
    controller.onReconnected();
    expect(find("session.start")).toHaveLength(2);
    expect(find("session.start")[1]).toMatchObject({ sessionId: sid });
    expect(find("context.update").at(-1)).toMatchObject({ listening: true });
  });

  it("does nothing when nothing is listening", () => {
    const { controller, sent } = setup("mock");
    controller.onReconnected();
    expect(sent).toHaveLength(0);
  });

  it("releases the mic if memory was paused (elsewhere) while this device was offline", async () => {
    const mic = fakeMic();
    const { controller } = setup("client", mic.factory);
    await controller.start();
    usePrivacy.getState().paused_({ by: "phone-1", purgedCount: 0, at: 1 }); // the welcome snapshot said paused
    controller.onReconnected();
    expect(mic.last().pause).toHaveBeenCalledWith("remote");
  });
});

describe("Eco mode", () => {
  it("toggling tells the server; the engine reads the mode each utterance", async () => {
    const { controller, find } = setup("mock");
    controller.toggleEco();
    expect(useAudioUi.getState().mode).toBe("eco");
    expect(find("context.update").at(-1)).toMatchObject({ mode: "eco" });
    controller.toggleEco();
    expect(useAudioUi.getState().mode).toBe("normal");
  });

  it("an automatic low-battery switch is marked as automatic and can be turned off", () => {
    const { controller } = setup("mock");
    controller.setMode("eco", { auto: true });
    expect(useAudioUi.getState()).toMatchObject({ mode: "eco", autoEco: true });
    controller.setMode("normal");
    expect(useAudioUi.getState()).toMatchObject({ mode: "normal", autoEco: false });
  });
});

describe("typed input", () => {
  it("starts the typed engine on first use and sends the fragment through the real pipeline", async () => {
    const { controller, find } = setup("mock");
    expect(await controller.injectText("I need to email the team about the delay")).toBe(true);
    expect(useAudioUi.getState().engine).toBe("text");
    const f = find("fragment.final");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ text: "I need to email the team about the delay", transport: "mock", whisper: false });
  });

  it("multi-line input becomes several fragments with short pauses so it stitches like speech", async () => {
    const { controller, find } = setup("mock");
    await controller.injectText("That bug from yesterday...\nthe one with the null pointer...\nin the cart service");
    vi.advanceTimersByTime(3000);
    const f = find("fragment.final");
    expect(f.map((m) => m.text)).toEqual(["That bug from yesterday...", "the one with the null pointer...", "in the cart service"]);
    expect(f[1]?.pauseBeforeMs).toBe(1400);
    expect(f[2]?.pauseBeforeMs).toBe(1100);
  });

  it("the whisper flag is passed through", async () => {
    const { controller, find } = setup("mock");
    await controller.injectText("psst", { whisper: true });
    expect(find("fragment.final")[0]?.whisper).toBe(true);
  });

  it("refuses while memory is paused, with an explanation", async () => {
    const { controller, find } = setup("mock");
    usePrivacy.getState().localPause("tap", 1, "dev-1");
    expect(await controller.injectText("hello")).toBe(false);
    expect(find("fragment.final")).toHaveLength(0);
    expect(useNotices.getState().toasts.some((t) => /paused/.test(t.text))).toBe(true);
  });

  it("when the mic engine cannot inject text, a typed-input helper does it under the same session", async () => {
    const mic = fakeMic({ withInject: false });
    const { controller, find } = setup("client", mic.factory);
    await controller.start();
    await controller.injectText("typed while the mic runs");
    expect(find("fragment.final")[0]).toMatchObject({ text: "typed while the mic runs", sessionId: useAudioUi.getState().sessionId });
  });

  it("ignores empty input", async () => {
    const { controller } = setup("mock");
    expect(await controller.injectText("   \n  ")).toBe(false);
  });
});

describe("real text engine contract", () => {
  it("createTextEngine satisfies the AudioEngine contract the controller relies on", async () => {
    const states: AudioState[] = [];
    const e = createTextEngine({
      deviceId: "d",
      sessionId: "s",
      deviceKind: "desk",
      onFragment: () => undefined,
      onSpeaking: () => undefined,
      onState: (s) => states.push(s),
      onLevel: () => undefined,
      onFailed: () => undefined,
      onPause: () => undefined,
      onStats: () => undefined,
      requestWisprToken: async () => ({ mode: "mock" }),
      getWisprContext: () => ({ dictionary: [], conversation: [], language: [], userFirstName: "" }),
      getActivity: () => "desk",
      getMode: () => "normal",
    });
    await e.start();
    expect(e.running).toBe(true);
    await e.pause("tap");
    expect(states).toEqual(["listening", "paused"]);
  });
});

describe("micProblemText", () => {
  it("turns engine details into advice", () => {
    expect(micProblemText("microphone permission denied")).toMatch(/permission/);
    expect(micProblemText("microphone needs a secure page (HTTPS or localhost)")).toMatch(/HTTPS/);
    expect(micProblemText("no microphone found")).toMatch(/No microphone/);
    expect(micProblemText("microphone is busy or unavailable")).toMatch(/busy/);
    expect(micProblemText("voice detection failed to load: 404")).toMatch(/voice detection failed to load/);
    expect(micProblemText(undefined)).toMatch(/stopped/);
  });
});
