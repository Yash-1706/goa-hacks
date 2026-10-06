import type { Activity, ClientMessage, FragmentFinal } from "@synapse/shared";
import {
  createTextEngine,
  loadMicEngine,
  type AudioDiagnostic,
  type AudioEngine,
  type AudioEngineFactory,
  type AudioEngineOptions,
  type AudioState,
  type AudioStats,
  type WisprContext,
  type WisprTokenInfo,
} from "@/audio";
import type { LatencyTracker } from "@/lib/latency";
import { newId } from "@/lib/ids";
import { acquireWakeLock, preloadSensors, startActivity, startBattery, type Stop, type WakeHandle } from "@/lib/sensors";
import { useAudioUi, useLevel } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { toast } from "@/state/notices";
import { usePrivacy } from "@/state/privacy";
import { useSettings } from "@/state/settings";
import { useStream } from "@/state/stream";

/* ============================================================================
 * Audio integration. The UI owns the WebSocket; the audio engine never talks to it. This controller
 * builds the AudioEngineOptions, wires every callback to the socket / stores, and owns the lifecycle:
 *
 *   Orb tap (a user gesture) → start(): mic engine when Wispr is live, typed-input engine otherwise
 *   (mock mode, no mic engine, mic permission denied, VAD load failure) so the app is ALWAYS usable.
 *   Pause (tap / voice / remote): the mic is released, the server is told, resume is a deliberate tap.
 *   End session: session.end → the server writes the session brief.
 *
 * Browsers grant getUserMedia / AudioContext / iOS motion permission only to calls made inside the tap, so
 * everything the tap needs (mic engine module, sensor modules) is PRELOADED and start() reaches
 * engine.start() without awaiting anything first.
 * ========================================================================== */

export interface ControllerDeps {
  send: (msg: ClientMessage) => boolean;
  requestToken: (opts?: { force?: boolean }) => Promise<WisprTokenInfo>;
  tracker: () => LatencyTracker | null;
  now?: () => number;
  loadMic?: () => Promise<AudioEngineFactory | null>;
  textFactory?: AudioEngineFactory;
}

const ECO_ON_BELOW = 0.3;
const ECO_OFF_ABOVE = 0.4;
const DEGRADE_CLEAR_MS = 15_000;

/** Why the mic is not working, in words a person can act on (details come from the engine, see audio/engine.ts). */
export function micProblemText(detail: string | undefined): string {
  const d = detail ?? "";
  const insecure = typeof window !== "undefined" && window.isSecureContext === false;
  if (insecure || /secure page|https/i.test(d)) return "Phones need HTTPS for the microphone (run HTTPS=1 pnpm dev:web and open the https address).";
  if (/permission/i.test(d)) return "Microphone permission was denied. Allow it in the browser's site settings to talk.";
  if (/no microphone/i.test(d)) return "No microphone was found.";
  if (/busy|unavailable/i.test(d)) return "The microphone is busy or unavailable (another app may be using it).";
  return d ? `The microphone engine stopped: ${d}.` : "The microphone engine stopped.";
}

export class AudioController {
  private engine: AudioEngine | null = null;
  /** typed-input helper when the main engine cannot inject text */
  private helper: AudioEngine | null = null;
  private sessionId: string | null = null;
  private sessionOpen = false;
  private busy = false;
  private degrading = false;
  private stops: Stop[] = [];
  private wake: WakeHandle | null = null;
  private wakePoll: ReturnType<typeof setInterval> | null = null;
  private userSetMode = false;
  /** undefined = not loaded yet, null = no mic engine in this build */
  private micFactory: AudioEngineFactory | null | undefined;
  private env: { level: number; from: number; until: number; timer: ReturnType<typeof setTimeout> | undefined } = { level: 0, from: 0, until: 0, timer: undefined };
  private degradeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBatterySent = { level: -1, charging: false };
  private batteryStop: Stop | null = null;

  constructor(private d: ControllerDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Load the mic engine and sensor modules ahead of the first tap (keeps the tap's user activation intact). */
  preload(): void {
    void (this.d.loadMic ?? loadMicEngine)().then(
      (f) => {
        this.micFactory = f;
      },
      () => {
        this.micFactory = null;
      },
    );
    void preloadSensors();
  }

  get running(): boolean {
    return Boolean(this.engine?.running);
  }

  // ----------------------------------------------------------------- orb tap --

  /** The Orb: start when off, pause memory while listening, resume when paused. */
  async toggle(): Promise<void> {
    const privacy = usePrivacy.getState();
    const ui = useAudioUi.getState();
    if (privacy.paused || ui.state === "paused") return this.resume();
    if (ui.state === "starting") return;
    if (ui.state === "listening" || ui.state === "hearing") return this.pauseByTap();
    return this.start();
  }

  // ------------------------------------------------------------------- start --

  async start(opts: { typedOnly?: boolean } = {}): Promise<void> {
    if (this.busy || this.engine?.running) return;
    this.busy = true;
    const ui = useAudioUi.getState();
    try {
      // ---- until engine.start() is CALLED nothing below awaits (the tap's user activation must survive) ----
      const previous = this.engine;
      this.engine = null;
      if (previous && previous.state !== "off") void previous.stop().catch(() => undefined);
      if (this.helper) void this.helper.stop().catch(() => undefined);
      this.helper = null;

      const cfg = useSettings.getState().config;
      const sessionId = newId("ses");
      this.sessionId = sessionId;
      this.sessionOpen = false;
      const wantMic = !opts.typedOnly && cfg !== null && cfg.wisprMode !== "mock";

      // iOS asks for the motion permission on a tap: request it first, while the gesture is fresh
      const motion = useConnection.getState().deviceKind === "pocket" ? this.startSensors() : null;

      let factory: AudioEngineFactory | null = null;
      if (wantMic) factory = this.micFactory !== undefined ? this.micFactory : await (this.d.loadMic ?? loadMicEngine)();
      if (wantMic && !factory) {
        ui.set({ micAvailable: false });
        toast.info("The microphone engine is not available in this build, so typed input is active.");
      }
      const kind: "mic" | "text" = factory ? "mic" : "text";
      const engine = (factory ?? this.d.textFactory ?? createTextEngine)(this.options(sessionId));
      this.engine = engine;
      // plain synchronous store write (no await, so the tap's user activation is untouched), BEFORE start():
      // the text engine reports "listening" synchronously from inside start() and must not be overwritten
      ui.set({ engine: kind, sessionId, resumeHint: false, degraded: null, detail: undefined, ...(kind === "mic" ? { state: "starting" as const } : {}) });
      const started = engine.start(); // <- getUserMedia / AudioContext happen synchronously inside this call
      await started;
      void motion;

      // The mic engine reports failures as state "error" (permission denied, no HTTPS, VAD failed to load)
      // rather than by throwing: switch to typed input so the app stays usable.
      if (kind === "mic" && (engine.state as AudioState) === "error") {
        await this.degradeToTyped(useAudioUi.getState().detail);
        return;
      }
      if (kind === "mic") ui.set({ micAvailable: true });
      await this.beginSession(sessionId);
    } catch (err) {
      toast.warn(`Could not start listening: ${(err as Error).message}`);
      ui.set({ state: "error", detail: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  /** The mic engine failed: continue the same session with typed input. */
  private async degradeToTyped(detail: string | undefined): Promise<void> {
    if (this.degrading) return;
    this.degrading = true;
    try {
      const ui = useAudioUi.getState();
      toast.warn(`${micProblemText(detail)} Typed input is active.`, 9000);
      const sessionId = this.sessionId ?? newId("ses");
      this.sessionId = sessionId;
      void this.engine?.stop().catch(() => undefined);
      const text = (this.d.textFactory ?? createTextEngine)(this.options(sessionId));
      this.engine = text;
      ui.set({ micAvailable: false, engine: "text", degraded: "Microphone unavailable: typed input", detail: undefined });
      await text.start();
      if (!this.sessionOpen) await this.beginSession(sessionId);
    } finally {
      this.degrading = false;
    }
  }

  private async beginSession(sessionId: string): Promise<void> {
    const ui = useAudioUi.getState();
    this.sessionOpen = true;
    this.d.send({ type: "session.start", sessionId, activity: ui.activity === "unknown" ? undefined : ui.activity });
    this.d.send({ type: "context.update", listening: true, mode: ui.mode });
    if (useConnection.getState().deviceKind !== "pocket") void this.startSensors();
    void this.holdWake();
  }

  // -------------------------------------------------------------------- stop --

  /** End the session (the server writes the brief). The mic is released. */
  async stop(): Promise<void> {
    const sid = this.sessionId;
    const e = this.engine;
    this.engine = null;
    this.helper?.stop().catch(() => undefined);
    this.helper = null;
    this.releaseResources();
    this.endSpeech();
    if (e && e.state !== "off") await e.stop().catch(() => undefined);
    if (sid && this.sessionOpen) this.d.send({ type: "session.end", sessionId: sid });
    this.d.send({ type: "context.update", listening: false });
    this.sessionId = null;
    this.sessionOpen = false;
    useAudioUi.getState().set({ state: "off", detail: undefined, sessionId: null, speaking: false, engine: null, resumeHint: false });
    useLevel.getState().set(0);
  }

  // ------------------------------------------------------------------- pause --

  /** Orb / Pause button: privacy pause (also forgets the trailing window, like the voice command). */
  async pauseByTap(): Promise<void> {
    const e = this.engine;
    if (!e) return;
    try {
      await e.pause("tap");
    } catch (err) {
      toast.warn(`Pause could not release the microphone cleanly: ${(err as Error).message}`);
    }
    await this.helper?.pause("tap").catch(() => undefined);
    this.afterLocalPause("tap");
  }

  /** Pause memory for every device even when nothing is listening here (the Privacy Center button). */
  async pauseMemory(): Promise<void> {
    const e = this.engine;
    if (e && e.state !== "paused" && e.state !== "off") return this.pauseByTap();
    usePrivacy.getState().localPause("tap", this.now(), useConnection.getState().deviceId);
    this.d.send({ type: "privacy.pause", via: "tap" });
  }

  private afterLocalPause(via: "tap" | "voice" | "kws"): void {
    this.endSpeech();
    this.releaseResources();
    usePrivacy.getState().localPause(via, this.now(), useConnection.getState().deviceId);
    this.d.send({ type: "privacy.pause", via });
    this.d.send({ type: "context.update", listening: false });
  }

  /** The server paused memory (any device, voice, or its own semantic backstop): release this mic too. */
  onRemotePause(): void {
    const e = this.engine;
    void this.helper?.pause("remote").catch(() => undefined);
    if (!e || e.state === "paused" || e.state === "off") return; // nothing running here, or we paused it ourselves
    void e.pause("remote").catch(() => undefined);
    this.endSpeech();
    this.releaseResources();
    this.d.send({ type: "context.update", listening: false });
  }

  /** The server resumed. Resuming the MIC is a deliberate tap (PRV-3): just tell the user to tap. */
  onRemoteResume(): void {
    const ui = useAudioUi.getState();
    this.helper = null;
    if (this.busy || this.engine?.running || ui.state === "starting") return; // this device is resuming itself
    ui.set({ resumeHint: true, ...(ui.state === "paused" ? { state: "off" as const } : {}) });
  }

  /** Orb tap while paused. */
  async resume(): Promise<void> {
    if (usePrivacy.getState().paused) this.d.send({ type: "privacy.resume" });
    const ui = useAudioUi.getState();
    ui.set({ resumeHint: false });
    await this.start();
  }

  // ------------------------------------------------------------- typed input --

  /**
   * Feed typed text as if it had been spoken (no-mic mode, demos, dev). Multi-line input becomes several
   * fragments with short pauses between them, so a typed ramble stitches like a spoken one.
   */
  async injectText(raw: string, o: { whisper?: boolean } = {}): Promise<boolean> {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    if (usePrivacy.getState().paused) {
      toast.info("Memory is paused. Tap the orb to resume before talking to it.");
      return false;
    }
    if (!this.engine || !this.engine.running) await this.start({ typedOnly: true });
    let target: AudioEngine | null = this.engine;
    if (!target || !target.running || !target.injectText) target = await this.ensureHelper();
    if (!target?.injectText) return false;
    const pauses = [1400, 1100, 1700, 1200];
    lines.forEach((line, i) => {
      // typed lines arrive 650 ms apart: give each a short duration so their timestamps never overlap (the stitcher reads them)
      const send = (): void => target?.injectText?.(line, { whisper: o.whisper, ...(lines.length > 1 ? { durationMs: 520 } : {}), pauseBeforeMs: i === 0 ? undefined : (pauses[(i - 1) % pauses.length] as number) });
      if (i === 0) send();
      else setTimeout(send, i * 650);
    });
    return true;
  }

  private async ensureHelper(): Promise<AudioEngine | null> {
    if (this.helper?.running) return this.helper;
    const sessionId = this.sessionId ?? newId("ses");
    this.sessionId = sessionId;
    const o = this.options(sessionId);
    this.helper = (this.d.textFactory ?? createTextEngine)({ ...o, onState: () => undefined, onLevel: () => undefined });
    await this.helper.start();
    return this.helper;
  }

  // -------------------------------------------------------------------- mode --

  setMode(mode: "normal" | "eco", o: { auto?: boolean } = {}): void {
    const ui = useAudioUi.getState();
    if (ui.mode === mode && ui.autoEco === (Boolean(o.auto) && mode === "eco")) return;
    if (!o.auto) this.userSetMode = true;
    ui.set({ mode, autoEco: Boolean(o.auto) && mode === "eco" });
    this.d.send({ type: "context.update", mode });
    if (o.auto && mode === "eco") toast.info("Battery is low: Eco mode saves power (stricter voice detection, bigger audio bursts).");
  }

  toggleEco(): void {
    this.setMode(useAudioUi.getState().mode === "eco" ? "normal" : "eco");
  }

  // ----------------------------------------------------------------- sensors --

  /** Motion-based activity (only while a session is live: it costs battery). Resolves once the sensor is running. */
  private startSensors(): Promise<void> {
    this.stopSensors();
    return startActivity((a: Activity) => {
      useAudioUi.getState().set({ activity: a });
      this.d.send({ type: "context.update", activity: a });
    }).then((stop) => {
      if (stop) this.stops.push(stop);
    });
  }

  /** Battery level for the Pocket screen, the device chips and the low-battery Eco rule. Runs for the whole app life. */
  initBattery(): void {
    if (this.batteryStop) return;
    this.batteryStop = () => undefined;
    void startBattery((b) => {
      useAudioUi.getState().set({ battery: b });
      this.sendBattery(b);
      this.applyAutoEco(b);
    }).then((stop) => {
      this.batteryStop = stop ?? (() => undefined);
    });
  }

  private sendBattery(b: { level: number; charging: boolean }): void {
    const last = this.lastBatterySent;
    if (Math.abs(b.level - last.level) < 0.01 && b.charging === last.charging) return;
    this.lastBatterySent = { ...b };
    this.d.send({ type: "context.update", battery: { level: b.level, charging: b.charging } });
  }

  private applyAutoEco(b: { level: number; charging: boolean }): void {
    if (!useSettings.getState().autoEco || this.userSetMode) return;
    const ui = useAudioUi.getState();
    if (ui.mode === "normal" && b.level < ECO_ON_BELOW && !b.charging) this.setMode("eco", { auto: true });
    else if (ui.mode === "eco" && ui.autoEco && (b.charging || b.level > ECO_OFF_ABOVE)) this.setMode("normal", { auto: true });
  }

  private stopSensors(): void {
    for (const s of this.stops.splice(0)) {
      try {
        s();
      } catch {
        /* sensor already gone */
      }
    }
  }

  private async holdWake(): Promise<void> {
    if (this.wake) return;
    const handle = await acquireWakeLock();
    if (!handle) return;
    if (!this.sessionOpen) {
      handle.release();
      return;
    }
    this.wake = handle;
    const sync = (): void => useAudioUi.getState().set({ wakeLock: handle.active() });
    setTimeout(sync, 400);
    this.wakePoll = setInterval(sync, 2000);
  }

  private releaseResources(): void {
    this.stopSensors();
    if (this.wakePoll) clearInterval(this.wakePoll);
    this.wakePoll = null;
    try {
      this.wake?.release();
    } catch {
      /* ignore */
    }
    this.wake = null;
    useAudioUi.getState().set({ wakeLock: false });
    useLevel.getState().set(0);
  }

  /**
   * The socket came back (and the stores were re-hydrated from the welcome snapshot). The server forgot this
   * device's live state: re-announce the running session, or honour a pause that happened while we were offline.
   */
  onReconnected(): void {
    if (usePrivacy.getState().paused) {
      this.onRemotePause();
      return;
    }
    if (this.sessionId && this.sessionOpen && this.engine?.running) {
      const ui = useAudioUi.getState();
      this.d.send({ type: "session.start", sessionId: this.sessionId, activity: ui.activity === "unknown" ? undefined : ui.activity });
      this.d.send({ type: "context.update", listening: true, mode: ui.mode, ...(ui.battery ? { battery: { level: ui.battery.level, charging: ui.battery.charging } } : {}) });
    }
  }

  /** Page is going away: tell the server the session is over (best effort). */
  onPageHide(): void {
    if (this.sessionId && this.sessionOpen && this.engine?.running) this.d.send({ type: "session.end", sessionId: this.sessionId });
  }

  // ----------------------------------------------------------- engine plumbing --

  private endSpeech(): void {
    const ui = useAudioUi.getState();
    if (ui.speaking) {
      ui.set({ speaking: false });
      this.d.send({ type: "speech.state", speaking: false, at: this.now() });
    }
  }

  /** The text engine has no mic: give the orb a little breath of "hearing" when a typed fragment lands. */
  private kickEnvelope(): void {
    const level = useLevel.getState();
    const ui = useAudioUi.getState();
    if (ui.engine === "mic") return;
    this.env.level = 0.85;
    this.env.from = this.now();
    this.env.until = this.env.from + 900;
    if (this.env.timer) clearTimeout(this.env.timer);
    if (ui.state === "listening") ui.set({ state: "hearing" });
    const step = (): void => {
      const t = this.now();
      if (t >= this.env.until) {
        level.set(0);
        const u = useAudioUi.getState();
        if (u.state === "hearing" && u.engine !== "mic") u.set({ state: "listening" });
        return;
      }
      const k = 1 - (t - this.env.from) / (this.env.until - this.env.from);
      level.set(this.env.level * k * k);
      this.env.timer = setTimeout(step, 50);
    };
    step();
  }

  private noteDegraded(reason: string): void {
    useAudioUi.getState().set({ degraded: reason });
    if (this.degradeTimer) clearTimeout(this.degradeTimer);
    this.degradeTimer = setTimeout(() => {
      this.degradeTimer = null;
      if (useAudioUi.getState().engine === "mic") useAudioUi.getState().set({ degraded: null });
    }, DEGRADE_CLEAR_MS);
  }

  private wisprContext(): WisprContext {
    const ui = useAudioUi.getState();
    const cfg = useSettings.getState().config;
    const c = ui.wisprContext;
    return {
      dictionary: c?.dictionary ?? [],
      conversation: c?.conversation ?? [],
      language: c?.language ?? cfg?.languages ?? [],
      userFirstName: cfg?.userFirstName ?? "",
    };
  }

  /** Everything the engine needs, wired to the socket and the stores. */
  options(sessionId: string): AudioEngineOptions {
    const conn = useConnection.getState();
    return {
      deviceId: conn.deviceId,
      sessionId,
      deviceKind: conn.deviceKind,

      onFragment: (msg: FragmentFinal) => {
        this.d.tracker()?.noteLocal(msg.fragmentId, msg.t.wisprFinal ?? this.now());
        useStream.getState().addPending({
          id: msg.fragmentId,
          text: msg.text,
          whisper: msg.whisper,
          pauseBeforeMs: msg.pauseBeforeMs,
          tStart: msg.t.speechStart,
          tEnd: msg.t.speechEnd,
          sentAt: this.now(),
        });
        this.d.send(msg);
      },

      onSpeaking: (speaking: boolean, at: number) => {
        useAudioUi.getState().set({ speaking });
        this.d.send({ type: "speech.state", speaking, at });
        if (speaking && useAudioUi.getState().engine !== "mic") this.kickEnvelope();
      },

      onState: (state: AudioState, detail?: string) => {
        const ui = useAudioUi.getState();
        ui.set({ state, detail });
        if (state === "paused" || state === "off") {
          ui.set({ speaking: false });
          useLevel.getState().set(0);
        }
        if (state === "error") {
          this.releaseResources();
          // while start() is running it handles the fallback itself; later failures degrade here
          if (!this.busy && ui.engine === "mic") void this.degradeToTyped(detail);
          else if (ui.engine !== "mic") toast.warn(detail ? `Audio problem: ${detail}` : "Audio problem.", 8000);
        }
      },

      onLevel: (rms: number) => useLevel.getState().set(Math.max(0, Math.min(1, rms))),

      onFailed: (fragmentId: string, reason: string) => {
        toast.warn(`A fragment could not be transcribed (${reason}).`);
        this.d.send({ type: "fragment.failed", fragmentId, reason: reason.slice(0, 190) });
      },

      onPause: (via: "voice" | "kws", latencyMs: number) => {
        const ms = Math.max(0, Math.round(latencyMs));
        usePrivacy.getState().setPauseLatency(ms);
        this.afterLocalPause(via);
        this.d.send({ type: "metrics.client", fragmentId: "pause", pauseLatencyMs: ms });
        toast.success(`Memory paused. The mic was released ${ms} ms after you said it.`, 6500);
      },

      onStats: (s: AudioStats) => {
        useAudioUi.getState().set({ stats: s });
        const b = useAudioUi.getState().battery;
        this.d.send({
          type: "metrics.battery",
          mode: s.mode,
          cpuMs: Math.max(0, s.cpuMs),
          radioMs: Math.max(0, s.radioMs),
          bytesUp: Math.max(0, s.bytesUp),
          windowMs: Math.max(1, s.windowMs),
          ...(b ? { level: b.level, charging: b.charging } : {}),
        });
      },

      requestWisprToken: async (opts?: { force?: boolean }): Promise<WisprTokenInfo> => {
        try {
          return await this.d.requestToken(opts);
        } catch (err) {
          const mode = useSettings.getState().config?.wisprMode ?? "mock";
          this.noteDegraded("Wispr token unavailable");
          return { mode, error: (err as Error).message };
        }
      },

      getWisprContext: () => this.wisprContext(),
      getActivity: () => {
        const a = useAudioUi.getState().activity;
        if (a !== "unknown") return a;
        return useConnection.getState().deviceKind === "desk" ? "desk" : "unknown";
      },
      getMode: () => useAudioUi.getState().mode,

      onDiagnostic: (d: AudioDiagnostic) => {
        useAudioUi.getState().addDiagnostic(d, this.now());
        if (d.kind === "fallback") this.noteDegraded(`Wispr REST fallback: ${d.reason}`);
        else if (d.kind === "standby" && d.state === "down" && !d.assumed) this.noteDegraded("Wispr connection is down");
        else if (d.kind === "mode") useAudioUi.getState().set({ mode: d.mode });
      },
    };
  }
}
