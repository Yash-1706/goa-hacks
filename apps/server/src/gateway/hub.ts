import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  ClientMessageSchema,
  type ClientConfig,
  type ClientMessage,
  type DeviceInfo,
  type ServerMessage,
  type StateSnapshot,
} from "@synapse/shared";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { DeviceRef, Hub, ProactiveApi, RecallApi } from "../ctx";
import type { CortexEngine } from "../cortex/engine";
import { listEvents, view as calView } from "../integrations/calendar";
import type { Outbox } from "../integrations/outbox";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import type { BatteryLog, Metrics } from "../metrics/latency";
import type { PrivacyService } from "../privacy/service";
import type { AuditChain } from "../privacy/audit";
import type { WisprService } from "../wispr/service";
import type { Auth } from "./auth";
import { isAllowedOrigin, type Trust } from "./trust";

/* ============================================================================
 * Realtime gateway (TRD §14): one WebSocket per device. Messages are validated with zod at the
 * boundary and dispatched to services. The hub also owns the notion of "quiet": suggestions are
 * only delivered when every device has been silent for a moment.
 * ========================================================================== */

export interface HubServices {
  cfg: Config;
  clock: Clock;
  bus: Bus;
  store: MemoryStore;
  engine: CortexEngine;
  privacy: PrivacyService;
  metrics: Metrics;
  battery: BatteryLog;
  wispr: WisprService;
  outbox: Outbox;
  audit: AuditChain;
  trust: Trust;
  auth: Auth;
  asides: { count: number };
  recall: () => RecallApi | undefined;
  proactive: () => ProactiveApi | undefined;
  clientConfig: () => ClientConfig;
}

interface Conn {
  socket: WebSocket;
  ip: string;
  authed: boolean;
  info: DeviceInfo;
  offsets: number[];
  lastSpeechEnd: number;
  badMessages: number;
  /** signed in with a passcode session: re-checked so "Log out all devices" closes the socket too */
  cookie?: string;
}

const MAX_MESSAGE = 512 * 1024;

export class WsHub implements Hub {
  private conns = new Map<string, Conn>();
  private pending = new Set<WebSocket>();
  private lastStateAt = 0;

  constructor(private s: HubServices) {}

  // ------------------------------------------------------------------ Hub API --

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c.authed && c.socket.readyState === 1) c.socket.send(data);
  }

  sendTo(deviceId: string, msg: ServerMessage): void {
    const c = this.conns.get(deviceId);
    if (c && c.socket.readyState === 1) c.socket.send(JSON.stringify(msg));
  }

  devices(): DeviceInfo[] {
    return [...this.conns.values()].filter((c) => c.authed).map((c) => ({ ...c.info }));
  }

  anySpeaking(): boolean {
    return [...this.conns.values()].some((c) => c.info.speaking);
  }

  anyListening(): boolean {
    return [...this.conns.values()].some((c) => c.info.listening);
  }

  quietForMs(): number {
    const live = [...this.conns.values()].filter((c) => c.authed);
    if (!live.length) return Infinity;
    if (live.some((c) => c.info.speaking)) return 0;
    const lastEnd = Math.max(...live.map((c) => c.lastSpeechEnd));
    return lastEnd ? this.s.clock.now() - lastEnd : Infinity;
  }

  clockOffset(deviceId: string): number | undefined {
    const c = this.conns.get(deviceId);
    return c && c.offsets.length ? Math.min(...c.offsets) : undefined;
  }

  // ------------------------------------------------------------------ wiring --

  async register(app: FastifyInstance): Promise<void> {
    await app.register(websocket, { options: { maxPayload: MAX_MESSAGE } });
    app.get("/ws", { websocket: true }, (socket, req) => {
      if (!isAllowedOrigin(req.headers.origin, this.s.auth.publicOrigin)) {
        socket.close(1008, "origin not allowed");
        return;
      }
      const ip = this.s.trust.clientIp(req.raw);
      // a passcode session on the upgrade request authenticates the device (the only way in while a tunnel is up)
      const session = this.s.auth.hasSession(req.headers.cookie);
      const sessionCookie = session ? req.headers.cookie : undefined;
      this.pending.add(socket);
      let conn: Conn | undefined;
      socket.on("message", (raw: Buffer) => {
        void this.onMessage(socket, ip, sessionCookie, raw, () => conn, (c) => (conn = c));
      });
      socket.on("close", () => {
        this.pending.delete(socket);
        if (conn && this.conns.get(conn.info.deviceId)?.socket === socket) {
          this.conns.delete(conn.info.deviceId);
          conn.info.connected = false;
          conn.info.listening = false;
          conn.info.speaking = false;
          this.pushState();
          // a closed socket ends the device's live thread (the session itself stays resumable)
          void this.s.engine.finalizeDevice(conn.info.deviceId);
        }
      });
      socket.on("error", (e: Error) => log.debug("hub", `socket error: ${e.message}`));
    });
  }

  private async onMessage(socket: WebSocket, ip: string, sessionCookie: string | undefined, raw: Buffer, get: () => Conn | undefined, set: (c: Conn) => void): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    const conn = get();
    if (!parsed.success) {
      if (conn && ++conn.badMessages > 20) socket.close(1008, "too many invalid messages");
      log.debug("hub", "invalid message", { issues: parsed.error.issues.length });
      return;
    }
    const msg = parsed.data;
    if (msg.type === "hello") {
      this.onHello(socket, ip, sessionCookie, msg, set);
      return;
    }
    if (!conn || !conn.authed) return;
    try {
      await this.dispatch(conn, msg);
    } catch (err) {
      log.error("hub", `handler ${msg.type} failed: ${(err as Error).message}`);
      this.sendTo(conn.info.deviceId, { type: "error", code: "handler_failed", message: msg.type });
    }
  }

  // ------------------------------------------------------------------- hello --

  private onHello(socket: WebSocket, ip: string, sessionCookie: string | undefined, msg: Extract<ClientMessage, { type: "hello" }>, set: (c: Conn) => void): void {
    const verdict: { ok: boolean; token?: string; reason?: string } = sessionCookie
      ? { ok: true }
      : this.s.auth.publicMode
        ? { ok: false, reason: "sign in with the passcode" }
        : this.s.trust.check(ip, msg.deviceId, msg.token, msg.pairingCode);
    if (!verdict.ok) {
      socket.send(JSON.stringify({ type: "auth.required", reason: verdict.reason ?? "pairing required" } satisfies ServerMessage));
      return;
    }
    const old = this.conns.get(msg.deviceId);
    if (old && old.socket !== socket) old.socket.close(4000, "replaced by a newer connection");

    const info: DeviceInfo = {
      deviceId: msg.deviceId,
      kind: msg.kind,
      name: msg.name ?? (msg.kind === "pocket" ? "Phone" : "Desk"),
      connected: true,
      listening: false,
      speaking: false,
      activity: msg.kind === "desk" ? "desk" : "unknown",
      mode: "normal",
    };
    const conn: Conn = { socket, ip, authed: true, info, offsets: [], lastSpeechEnd: 0, badMessages: 0, ...(sessionCookie ? { cookie: sessionCookie } : {}) };
    this.conns.set(msg.deviceId, conn);
    this.pending.delete(socket);
    set(conn);

    const welcome: ServerMessage = {
      type: "welcome",
      deviceId: msg.deviceId,
      serverTime: this.s.clock.now(),
      config: this.s.clientConfig(),
      state: this.snapshot(),
      token: verdict.token,
    };
    socket.send(JSON.stringify(welcome));
    this.pushState();
    log.info("hub", "device connected", { id: msg.deviceId, kind: msg.kind });
  }

  snapshot(): StateSnapshot {
    const p = this.s.privacy.snapshot();
    const proactive = this.s.proactive()?.snapshot() ?? { suggestions: [], echoes: [] };
    return {
      paused: p.paused,
      pausedAt: p.pausedAt,
      pausedBy: p.pausedBy,
      devices: this.devices(),
      thoughts: this.s.store.recentViews(120).map((v) => ({ ...v, analyzing: this.s.engine.isAnalyzing(v.id) })),
      suggestions: proactive.suggestions,
      echoes: proactive.echoes,
      asideCount: this.s.asides.count,
      metrics: this.s.metrics.summary(),
      calendar: listEvents(this.s.store).map(calView),
    };
  }

  /** Broadcast the device list + pause state (throttled). */
  pushState(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStateAt < 120) return;
    this.lastStateAt = now;
    const p = this.s.privacy.snapshot();
    this.broadcast({ type: "state.update", paused: p.paused, pausedAt: p.pausedAt, pausedBy: p.pausedBy, devices: this.devices() });
  }

  // ---------------------------------------------------------------- dispatch --

  private ref(c: Conn): DeviceRef {
    return { id: c.info.deviceId, kind: c.info.kind, activity: c.info.activity ?? "unknown" };
  }

  private async dispatch(c: Conn, msg: Exclude<ClientMessage, { type: "hello" }>): Promise<void> {
    const { store, privacy, outbox, engine } = this.s;
    const id = c.info.deviceId;
    switch (msg.type) {
      case "ping": {
        const now = this.s.clock.now();
        c.offsets.push(now - msg.t0); // includes one-way latency; the minimum over the window is the best estimate
        if (c.offsets.length > 12) c.offsets.shift();
        this.sendTo(id, { type: "pong", t0: msg.t0, tServer: now });
        return;
      }
      case "session.start": {
        c.info.sessionId = msg.sessionId;
        if (msg.activity) c.info.activity = msg.activity;
        store.ensureSession(msg.sessionId, id, c.info.kind, c.info.activity ?? "unknown");
        c.info.listening = true;
        this.s.bus.emit("session.started", { sessionId: msg.sessionId, deviceId: id });
        this.sendTo(id, this.s.wispr.context(id, msg.sessionId));
        this.pushState();
        return;
      }
      case "session.end": {
        c.info.listening = false;
        c.info.speaking = false;
        await engine.finalizeDevice(id);
        store.endSession(msg.sessionId);
        this.s.bus.emit("session.ended", { sessionId: msg.sessionId, deviceId: id });
        this.pushState();
        return;
      }
      case "speech.state": {
        c.info.speaking = msg.speaking;
        if (!msg.speaking) c.lastSpeechEnd = this.s.clock.now();
        this.s.bus.emit("speech.state", { deviceId: id, speaking: msg.speaking, at: msg.at });
        this.pushState();
        return;
      }
      case "fragment.final": {
        c.lastSpeechEnd = this.s.clock.now();
        void engine.handleFragment(this.ref(c), msg);
        // keep Wispr's personalization fresh (cheap, debounced by the client's own request rate)
        this.sendTo(id, this.s.wispr.context(id, msg.sessionId));
        return;
      }
      case "fragment.failed":
        log.warn("hub", "fragment failed on device", { id, reason: msg.reason });
        return;
      case "privacy.pause":
        await privacy.pause(id, msg.via, msg.purgeWindowSecs);
        return;
      case "privacy.resume":
        privacy.resume(id);
        return;
      case "privacy.forget":
        await privacy.forget(msg.scope, { windowSecs: msg.windowSecs, query: msg.query, deviceId: id });
        return;
      case "card.action":
        await this.onCardAction(msg);
        return;
      case "suggestion.action":
        await this.s.proactive()?.action(msg.id, msg.action, msg.pick);
        return;
      case "recall.ask":
        await this.s.recall()?.ask(msg.queryId, msg.text, this.ref(c));
        return;
      case "context.update": {
        if (msg.activity) c.info.activity = msg.activity;
        if (msg.battery) c.info.battery = msg.battery;
        if (msg.mode) c.info.mode = msg.mode;
        if (msg.listening !== undefined) c.info.listening = msg.listening;
        this.pushState();
        return;
      }
      case "metrics.client":
        if (msg.pauseLatencyMs !== undefined) this.s.metrics.recordPause(msg.pauseLatencyMs);
        else this.s.metrics.client(msg.fragmentId, { firstPaint: msg.firstPaint, artifactRender: msg.artifactRender });
        return;
      case "metrics.battery":
        this.s.battery.add({ deviceId: id, ts: this.s.clock.now(), mode: msg.mode, cpuMs: msg.cpuMs, radioMs: msg.radioMs, bytesUp: msg.bytesUp, windowMs: msg.windowMs, level: msg.level, charging: msg.charging });
        return;
      case "wispr.token.request": {
        this.sendTo(id, await this.s.wispr.token(id, msg.force === true));
        this.sendTo(id, this.s.wispr.context(id, c.info.sessionId));
        return;
      }
    }
    void outbox;
  }

  private async onCardAction(msg: Extract<ClientMessage, { type: "card.action" }>): Promise<void> {
    const { store, outbox, privacy, clock } = this.s;
    const thought = msg.thoughtId ? store.getThought(msg.thoughtId) : undefined;
    const art = msg.artifactId ? store.artifacts.get(msg.artifactId) : thought?.artifactId ? store.artifacts.get(thought.artifactId) : undefined;
    const warn = (text: string) => this.broadcast({ type: "notice", level: "warn", text, at: clock.now() });
    try {
      switch (msg.action) {
        case "accept":
          if (art) outbox.accept(art);
          else if (thought && !thought.promoted) store.promote(thought, [...thought.salienceReasons, "you kept it"]);
          if (thought) this.broadcast({ type: "thought.upsert", thought: this.s.engine.view(thought) });
          return;
        case "dismiss":
          if (art) outbox.dismiss(art);
          return;
        case "edit":
          if (art && msg.patch) outbox.edit(art, msg.patch);
          return;
        case "push":
          if (art) await outbox.push(art);
          return;
        case "undo":
          if (art) await outbox.undo(art);
          return;
        case "forget":
          if (thought) privacy.deleteThoughts([thought.id]);
          return;
        case "promote":
          if (thought && !thought.promoted) {
            store.promote(thought, [...thought.salienceReasons, "you pinned it"]);
            this.broadcast({ type: "thought.upsert", thought: this.s.engine.view(thought) });
          }
          return;
      }
    } catch (err) {
      warn((err as Error).message);
    }
  }

  /** Close the sockets whose passcode session was revoked (called after "Log out all devices" and periodically). */
  recheckSessions(): void {
    for (const c of this.conns.values()) if (c.cookie && !this.s.auth.hasSession(c.cookie)) c.socket.close(4001, "signed out");
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.socket.close(1001, "server shutting down");
    for (const s of this.pending) s.close(1001, "server shutting down");
  }
}
