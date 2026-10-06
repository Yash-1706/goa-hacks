/* ============================================================================
 * Wispr Flow streamer: standby socket pool + one WebSocket session per utterance (+ REST fallback).
 *
 * Wire contract (TRD §5.3-§5.5, api-docs.wisprflow.ai):
 *   wss://platform-api.wisprflow.ai/api/v1/dash/client_ws?client_key=Bearer%20<JWT>
 *   -> {type:"auth", access_token, language?, context}      <- {status:"auth"}
 *   -> {type:"append", position, audio_packets:{packets, volumes, packet_duration, audio_encoding, byte_encoding}}
 *   -> {type:"commit", total_packets}
 *   <- {status:"info", message:{event}} | {status:"text", position, final, body:{text, detected_language}} | {status:"error"}
 *
 * Design (TRD §5.4):
 *  - One session per utterance. The socket is closed after the final text.
 *  - Exactly one pre-authenticated STANDBY socket while listening; claiming it opens the next one immediately, so speech
 *    onset does not pay connect + auth. Standbys are recycled when older than standbyMaxAgeMs, when the token is < 20 % from
 *    expiry, or (make-before-break, never blocking speech) when the context changed.
 *  - The PCM of an utterance is retained in memory ONLY until the final text arrives, the REST fallback completes, or the
 *    utterance is aborted; then every buffer is zero-filled. Audio is never written anywhere else.
 *  - Failure path: {status:"error"}, a close before the final, or no final within finalTimeoutMs -> POST the retained PCM
 *    (44-byte-header WAV) to the client REST endpoint. If that fails too -> onFailed.
 *  - Nothing in here logs or emits transcript text, audio or URLs (the WS URL contains the JWT).
 *  - Everything that touches the outside world (WebSocket, fetch, time) is injected.
 * ========================================================================== */
import type { Clock, TimerId } from "./clock";
import {
  PACKET_DURATION_S,
  bytesToBase64,
  concatInt16,
  encodePacket,
  wrapWav,
  zeroFill,
} from "./pcm";
import type { AudioDiagnostic, WisprContext, WisprTokenInfo } from "./types";

export { buildFragmentFinal, makeFragmentId } from "./fragment";

/* ------------------------------------------------------------------ wire types */

export const MAX_DICTIONARY_TERMS = 150;
export const MAX_CONVERSATION_MESSAGES = 6;
const MAX_TERM_CHARS = 80;
const MAX_MESSAGE_CHARS = 1000;

export interface WisprContextPayload {
  app: { name: string; type: string };
  dictionary_context: string[];
  user_identifier: string;
  user_first_name: string;
  user_last_name: string;
  textbox_contents: { before_text: string; selected_text: string; after_text: string };
  /** ALWAYS null (CAP-9). The literal type makes any other value a compile error. */
  screenshot: null;
  /** ALWAYS null (CAP-9) */
  content_text: null;
  /** ALWAYS null (CAP-9) */
  content_html: null;
  conversation: { id: string; participants: string[]; messages: Array<{ role: "user"; content: string }> };
}

export interface WisprAuthMessage {
  type: "auth";
  access_token: string;
  /** omitted for auto-detect */
  language?: string[];
  context: WisprContextPayload;
}

export interface WisprAppendMessage {
  type: "append";
  /** cumulative packet index of the first packet in this message */
  position: number;
  audio_packets: {
    packets: string[];
    volumes: number[];
    packet_duration: number;
    audio_encoding: "wav";
    byte_encoding: "base64";
  };
}

export interface WisprCommitMessage {
  type: "commit";
  total_packets: number;
}

export interface WisprRestBody {
  audio: string;
  language?: string[];
  context: WisprContextPayload;
}

/** `context` as sent in both the WS auth message and the REST body */
export function buildContextPayload(ctx: WisprContext, deviceId: string, sessionId: string): WisprContextPayload {
  const seen = new Set<string>();
  const dictionary: string[] = [];
  for (const raw of ctx.dictionary) {
    if (typeof raw !== "string") continue;
    const term = raw.trim();
    if (!term || term.length > MAX_TERM_CHARS || seen.has(term)) continue;
    seen.add(term);
    dictionary.push(term);
    if (dictionary.length >= MAX_DICTIONARY_TERMS) break;
  }
  const messages = ctx.conversation
    .filter((m) => typeof m?.content === "string" && m.content.trim().length > 0)
    .slice(-MAX_CONVERSATION_MESSAGES)
    .map((m) => ({ role: "user" as const, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
  return {
    app: { name: "Synapse", type: "ai" },
    dictionary_context: dictionary,
    user_identifier: deviceId,
    user_first_name: ctx.userFirstName ?? "",
    user_last_name: "",
    textbox_contents: { before_text: "", selected_text: "", after_text: "" },
    screenshot: null,
    content_text: null,
    content_html: null,
    conversation: { id: sessionId, participants: [], messages },
  };
}

export function buildAuthMessage(token: string, ctx: WisprContext, deviceId: string, sessionId: string): WisprAuthMessage {
  const msg: WisprAuthMessage = {
    type: "auth",
    access_token: token,
    context: buildContextPayload(ctx, deviceId, sessionId),
  };
  if (ctx.language.length > 0) msg.language = [...ctx.language];
  return msg;
}

export function buildAppendMessage(position: number, packets: string[], volumes: number[]): WisprAppendMessage {
  return {
    type: "append",
    position,
    audio_packets: {
      packets,
      volumes: volumes.map((v) => Math.round(v * 1e5) / 1e5),
      packet_duration: PACKET_DURATION_S,
      audio_encoding: "wav",
      byte_encoding: "base64",
    },
  };
}

export function buildCommitMessage(totalPackets: number): WisprCommitMessage {
  return { type: "commit", total_packets: totalPackets };
}

/** `${wsUrl}?client_key=Bearer%20<JWT>` */
export function buildWsUrl(wsUrl: string, token: string): string {
  const sep = wsUrl.includes("?") ? "&" : "?";
  return `${wsUrl}${sep}client_key=${encodeURIComponent(`Bearer ${token}`)}`;
}

/** cheap stable hash of everything in the context that ends up in the auth message (FNV-1a, 32 bit) */
export function contextSignature(ctx: WisprContext): number {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f; // field separator
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(ctx.userFirstName ?? "");
  mix(ctx.language.join(","));
  for (const t of ctx.dictionary) mix(t);
  mix("|");
  for (const m of ctx.conversation.slice(-MAX_CONVERSATION_MESSAGES)) mix(m.content);
  return h >>> 0;
}

/* ------------------------------------------------------------------ injected dependencies */

/** the subset of the WebSocket API the streamer uses (so tests can fake it) */
export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WsFactory = (url: string) => WsLike;

const WS_OPEN = 1;

const defaultSocketFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export interface WisprTranscript {
  /** possibly empty (Wispr heard nothing); the caller drops empty transcripts */
  text: string;
  detectedLanguage?: string;
  transport: "wispr_ws" | "wispr_rest";
  /** when the commit (WS) or the request (REST) went out */
  tCommitSent: number;
  /** when the final text arrived */
  tFinal: number;
}

export interface ClaimOptions {
  fragmentId: string;
  /** 4 normally, 8 in eco mode */
  packetsPerAppend: number;
  onTranscript(t: WisprTranscript): void;
  /** WS and REST both failed */
  onFailed(reason: string): void;
}

/** one utterance's session. Frames are pushed in order; the session owns (and finally zero-fills) every buffer it is given. */
export interface UtteranceHandle {
  readonly fragmentId: string;
  readonly state: "streaming" | "committed" | "settled";
  /** packets accepted so far */
  readonly packetCount: number;
  /** pre-roll: queue these frames and flush them at once (does not need a ready socket; sent when it is) */
  pushPreroll(frames: ReadonlyArray<{ pcm: Int16Array; rms: number }>): void;
  /** one 512-sample frame = one packet; takes ownership of `pcm` */
  push(pcm: Int16Array, rms: number): void;
  /** speech ended: flush, then send the commit (or go straight to REST when the socket is gone) */
  commit(): void;
  /** VAD misfire / pause / stop: close WITHOUT commit, zero-fill, no callbacks */
  abort(reason?: string): void;
}

export interface StreamerLike {
  start(): void;
  stop(): void;
  claim(opts: ClaimOptions): UtteranceHandle;
  /** cheap maintenance hook: recycle the standby if its token/age/context went stale */
  checkFreshness(): void;
  /** network is back / tab visible again: reconnect the standby now instead of waiting for the backoff */
  kick?(): void;
  primeToken(info: WisprTokenInfo): void;
  readonly standbyReady: boolean;
}

export interface WisprStreamerConfig {
  deviceId: string;
  sessionId: string;
  /** ask the server for a client token (opts.requestWisprToken) */
  getToken(opts?: { force?: boolean }): Promise<WisprTokenInfo>;
  getContext(): WisprContext;
  clock: Clock;
  createSocket?: WsFactory;
  fetch?: typeof fetch;
  /** WISPR_FINAL_TIMEOUT_MS (default 4000) */
  finalTimeoutMs?: number;
  /** WISPR_STANDBY_MAX_AGE_MS (default 45000) */
  standbyMaxAgeMs?: number;
  /** no {"status":"auth"} within this long after sending auth -> assume the socket is usable (default 3000) */
  authAckTimeoutMs?: number;
  /** socket did not open within this long (default 8000) */
  connectTimeoutMs?: number;
  /** REST fallback request timeout (default 10000) */
  restTimeoutMs?: number;
  /** a standby younger than this is not recycled merely because the context changed (default 10000) */
  contextRecycleMinAgeMs?: number;
  /** per-packet encoding: raw int16 LE (default) or per-packet WAV */
  packetFormat?: "pcm16" | "wav";
  /** upper bound of packets in one append message (default 32) */
  maxPacketsPerAppend?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  emit?(d: AudioDiagnostic): void;
  /** radio accounting for the Battery Lab: true when an utterance starts streaming, false when it settles */
  onRadio?(active: boolean): void;
  /** base64 characters of audio sent */
  onBytes?(chars: number): void;
}

/** thrown when Wispr cannot be used (no key, proxy mode, server error) */
export class WisprUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WisprUnavailableError";
  }
}

/* ------------------------------------------------------------------ tokens */

const DEFAULT_TOKEN_TTL_MS = 900_000;
const MAX_REFRESH_AFTER_MS = 720_000;

interface TokenState {
  token: string;
  wsUrl: string;
  restUrl?: string;
  expiresAt: number;
  /** after this the token is < 20 % from expiry and should be replaced */
  refreshAt: number;
}

/**
 * Normalise a server token message. `expiresAt` is the SERVER's clock, so it is sanity-checked against ours: anything
 * outside (5 s, 2 h) is treated as clock skew and replaced by the default 900 s lifetime counted from receipt.
 */
export function toTokenState(info: WisprTokenInfo, now: number): TokenState {
  if (info.mode === "proxy") throw new WisprUnavailableError("proxy mode not supported in this build");
  if (info.mode !== "client") throw new WisprUnavailableError("no Wispr key");
  if (info.error) throw new WisprUnavailableError(info.error);
  if (!info.token || !info.wsUrl) throw new WisprUnavailableError("token response incomplete");
  let ttl = typeof info.expiresAt === "number" ? info.expiresAt - now : DEFAULT_TOKEN_TTL_MS;
  if (!(ttl > 5_000 && ttl < 2 * 3_600_000)) ttl = DEFAULT_TOKEN_TTL_MS;
  const state: TokenState = {
    token: info.token,
    wsUrl: info.wsUrl,
    expiresAt: now + ttl,
    refreshAt: now + Math.min(ttl * 0.8, MAX_REFRESH_AFTER_MS),
  };
  if (info.restUrl) state.restUrl = info.restUrl;
  return state;
}

/* ------------------------------------------------------------------ connection */

type ConnState = "connecting" | "authing" | "ready" | "closed";

interface Conn {
  readonly id: number;
  ws: WsLike | null;
  state: ConnState;
  readonly createdAt: number;
  readyAt: number;
  ctxSig: number;
  tokenRefreshAt: number;
  owner: Utterance | null;
  connectTimer: TimerId | null;
  ackTimer: TimerId | null;
  recycleTimer: TimerId | null;
}

/* ------------------------------------------------------------------ streamer */

export class WisprStreamer implements StreamerLike {
  private readonly clock: Clock;
  private readonly finalTimeoutMs: number;
  private readonly standbyMaxAgeMs: number;
  private readonly authAckTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly restTimeoutMs: number;
  private readonly contextMinAgeMs: number;
  private readonly packetFormat: "pcm16" | "wav";
  private readonly maxPerAppend: number;
  private readonly retryBase: number;
  private readonly retryMax: number;
  private readonly createSocket: WsFactory;
  private readonly fetchFn: typeof fetch;

  private active = false;
  private seq = 0;
  private standby: Conn | null = null;
  private opening: Conn | null = null;
  private readonly conns = new Set<Conn>();
  private readonly sessions = new Set<Utterance>();
  private failures = 0;
  private retryTimer: TimerId | null = null;
  private token: TokenState | null = null;
  private tokenInFlight: Promise<TokenState> | null = null;
  /** set when a token was rejected: the next token request must be a forced (fresh) one */
  private forceNextToken = false;

  constructor(private readonly cfg: WisprStreamerConfig) {
    this.clock = cfg.clock;
    this.finalTimeoutMs = cfg.finalTimeoutMs ?? 4000;
    this.standbyMaxAgeMs = cfg.standbyMaxAgeMs ?? 45_000;
    this.authAckTimeoutMs = cfg.authAckTimeoutMs ?? 3000;
    this.connectTimeoutMs = cfg.connectTimeoutMs ?? 8000;
    this.restTimeoutMs = cfg.restTimeoutMs ?? 10_000;
    this.contextMinAgeMs = cfg.contextRecycleMinAgeMs ?? 10_000;
    this.packetFormat = cfg.packetFormat ?? "pcm16";
    this.maxPerAppend = Math.max(1, cfg.maxPacketsPerAppend ?? 32);
    this.retryBase = cfg.retryBaseMs ?? 1000;
    this.retryMax = cfg.retryMaxMs ?? 15_000;
    this.createSocket = cfg.createSocket ?? defaultSocketFactory;
    this.fetchFn = cfg.fetch ?? ((input, init) => fetch(input, init));
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** begin keeping a pre-authenticated standby socket */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.ensureStandby();
  }

  /** close everything WITHOUT commit; every in-flight utterance is aborted and zero-filled */
  stop(): void {
    this.active = false;
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const s of [...this.sessions]) s.abort("streamer stopped");
    for (const c of [...this.conns]) this.closeConn(c, "stopped");
    this.standby = null;
    this.opening = null;
    this.failures = 0;
  }

  /** seed the token cache with the response the engine already fetched */
  primeToken(info: WisprTokenInfo): void {
    try {
      this.token = toTokenState(info, this.clock.now());
    } catch {
      /* not a usable client token: ignore, getToken() will be asked later */
    }
  }

  get standbyReady(): boolean {
    return this.standby !== null && this.standby.state === "ready";
  }

  /** test / debug introspection (no secrets) */
  get debug(): { standby: boolean; opening: boolean; sessions: number; sockets: number; failures: number } {
    return {
      standby: this.standby !== null,
      opening: this.opening !== null,
      sessions: this.sessions.size,
      sockets: this.conns.size,
      failures: this.failures,
    };
  }

  /* ---------------------------------------------------------------- claim (speech onset) */

  claim(opts: ClaimOptions): UtteranceHandle {
    if (!this.active) {
      // stopped (paused / stopped engine): nothing may be streamed anywhere, hand back an inert handle
      const dead = new Utterance(this.host(), null, opts);
      dead.abort("streamer stopped");
      return dead;
    }
    let conn: Conn;
    const standby = this.standby;
    if (standby && this.isUsable(standby)) {
      conn = standby;
      this.standby = null;
      this.clearTimer(conn, "recycleTimer");
    } else {
      if (standby) {
        // stale: do not trust it with speech
        this.standby = null;
        this.closeConn(standby, "stale");
      }
      if (this.opening) {
        conn = this.opening;
        this.opening = null;
      } else {
        conn = this.newConn(); // cold: connect + auth now; audio is buffered until the socket is ready
      }
    }
    const u = new Utterance(this.host(), conn, opts);
    conn.owner = u;
    this.sessions.add(u);
    // keep exactly one standby while listening: open the next one right away
    this.ensureStandby();
    return u;
  }

  /** recycle a standby whose token / age / context went stale (make-before-break; never blocks speech) */
  checkFreshness(): void {
    if (!this.active) return;
    const c = this.standby;
    if (!c || this.opening) return;
    const now = this.clock.now();
    if (now >= c.tokenRefreshAt) return this.recycle(c, "token");
    if (now - c.createdAt >= this.standbyMaxAgeMs) return this.recycle(c, "age");
    if (now - c.createdAt >= this.contextMinAgeMs && contextSignature(this.cfg.getContext()) !== c.ctxSig) {
      this.recycle(c, "context");
    }
  }

  /**
   * The network came back or the tab became visible: do not wait for the backoff timer. A stuck (still connecting)
   * attempt is abandoned and retried right away; a healthy, fresh standby is left alone.
   */
  kick(): void {
    if (!this.active) return;
    const s = this.standby;
    if (s && s.state === "ready" && !this.isStale(s)) return;
    const o = this.opening;
    if (o && (o.state === "connecting" || o.state === "authing") && o.owner === null) {
      this.closeConn(o, "kick");
      this.opening = null;
    }
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failures = 0;
    this.ensureStandby();
  }

  /* ---------------------------------------------------------------- standby management */

  private ensureStandby(): void {
    if (!this.active || this.opening || this.retryTimer !== null) return;
    const s = this.standby;
    if (s && s.state === "ready" && !this.isStale(s)) return;
    this.opening = this.newConn();
    this.emit({ kind: "standby", state: "connecting" });
  }

  /** older than standbyMaxAgeMs, or its token is < 20 % from expiry */
  private isStale(c: Conn): boolean {
    const now = this.clock.now();
    return now - c.createdAt >= this.standbyMaxAgeMs || now >= c.tokenRefreshAt;
  }

  private recycle(c: Conn, reason: string): void {
    if (this.standby !== c || this.opening) return;
    this.opening = this.newConn();
    this.emit({ kind: "standby", state: "connecting", detail: `recycle: ${reason}` });
  }

  private isUsable(c: Conn): boolean {
    return (
      c.state === "ready" &&
      c.ws !== null &&
      c.ws.readyState === WS_OPEN &&
      this.clock.now() - c.createdAt <= this.standbyMaxAgeMs
    );
  }

  private onStandbyReady(c: Conn, assumed: boolean): void {
    if (this.opening === c) this.opening = null;
    const old = this.standby;
    this.standby = c;
    if (old && old !== c) this.closeConn(old, "replaced");
    this.failures = 0;
    const now = this.clock.now();
    const delay = Math.max(0, Math.min(c.createdAt + this.standbyMaxAgeMs, c.tokenRefreshAt) - now);
    c.recycleTimer = this.clock.setTimeout(() => {
      c.recycleTimer = null;
      this.recycle(c, "age/token");
    }, delay);
    this.emit(assumed ? { kind: "standby", state: "ready", assumed: true } : { kind: "standby", state: "ready" });
  }

  private scheduleRetry(): void {
    if (!this.active || this.retryTimer !== null) return;
    const delay = this.failures <= 0 ? 0 : Math.min(this.retryMax, this.retryBase * 2 ** (this.failures - 1));
    if (delay === 0) {
      this.ensureStandby();
      return;
    }
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.ensureStandby();
    }, delay);
  }

  /* ---------------------------------------------------------------- connections */

  private newConn(): Conn {
    const c: Conn = {
      id: ++this.seq,
      ws: null,
      state: "connecting",
      createdAt: this.clock.now(),
      readyAt: 0,
      ctxSig: 0,
      tokenRefreshAt: Number.POSITIVE_INFINITY,
      owner: null,
      connectTimer: null,
      ackTimer: null,
      recycleTimer: null,
    };
    this.conns.add(c);
    void this.connect(c);
    return c;
  }

  private async connect(c: Conn): Promise<void> {
    let tok: TokenState;
    try {
      tok = await this.getTokenState();
    } catch (e) {
      if (c.state !== "closed") this.connFailed(c, `token: ${errMsg(e)}`, true);
      return;
    }
    if (c.state === "closed") return;
    try {
      const ctx = this.cfg.getContext(); // one snapshot: the signature must describe what is actually sent
      c.ctxSig = contextSignature(ctx);
      c.tokenRefreshAt = tok.refreshAt;
      const ws = this.createSocket(buildWsUrl(tok.wsUrl, tok.token));
      c.ws = ws;
      c.connectTimer = this.clock.setTimeout(() => {
        c.connectTimer = null;
        if (c.state === "connecting") this.connFailed(c, "connect timeout", true);
      }, this.connectTimeoutMs);
      ws.onopen = () => {
        if (c.state !== "connecting") return;
        this.clearTimer(c, "connectTimer");
        try {
          ws.send(JSON.stringify(buildAuthMessage(tok.token, ctx, this.cfg.deviceId, this.cfg.sessionId)));
        } catch (e) {
          this.connFailed(c, `auth send: ${errMsg(e)}`, true);
          return;
        }
        c.state = "authing";
        // The documented ack is {"status":"auth"}. If it never shows up (unverified assumption), do not wedge: treat
        // the authenticated socket as usable after authAckTimeoutMs. An error or a close still wins.
        c.ackTimer = this.clock.setTimeout(() => {
          c.ackTimer = null;
          this.markReady(c, true);
        }, this.authAckTimeoutMs);
      };
      ws.onmessage = (ev) => this.onMessage(c, ev.data);
      ws.onclose = (ev) => this.onSocketClosed(c, ev.code);
      ws.onerror = () => {
        /* a close event follows; nothing to do */
      };
    } catch (e) {
      this.connFailed(c, `socket: ${errMsg(e)}`, true);
    }
  }

  private onMessage(c: Conn, data: unknown): void {
    if (c.state === "closed" || typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.status) {
      case "auth":
        this.markReady(c, false);
        return;
      case "info":
        // session_started / chunk_received / commit_received: informational only
        return;
      case "text":
        if (c.owner) c.owner.onText(msg);
        return;
      case "error": {
        const reason = describeWsError(msg);
        if (c.owner) {
          c.owner.onWsError(reason);
        } else {
          // an error while authing / idle: the token may be bad, ask for a fresh one next time
          this.connFailed(c, reason, true);
        }
        return;
      }
      default:
        return;
    }
  }

  private markReady(c: Conn, assumed: boolean): void {
    if (c.state !== "authing") return;
    c.state = "ready";
    c.readyAt = this.clock.now();
    this.clearTimer(c, "ackTimer");
    if (c.owner) c.owner.onConnReady();
    else this.onStandbyReady(c, assumed);
  }

  private onSocketClosed(c: Conn, code: number | undefined): void {
    if (c.state === "closed") return; // we closed it
    const wasReady = c.state === "ready";
    const lived = this.clock.now() - c.createdAt;
    const owner = c.owner;
    this.teardown(c);
    if (owner) {
      owner.onConnLost(`socket closed${code !== undefined ? ` (${code})` : ""}`);
      return;
    }
    this.emit({ kind: "standby", state: "down", detail: `closed${code !== undefined ? ` (${code})` : ""}` });
    // a standby that was fine for a while just aged out server-side: reopen at once. One that died young is a failure.
    if (!wasReady || lived < 5000) this.failures++;
    else this.failures = 0;
    this.scheduleRetry();
  }

  private connFailed(c: Conn, reason: string, invalidateToken: boolean): void {
    const owner = c.owner;
    if (invalidateToken) this.invalidateToken();
    this.closeConn(c, "failed");
    if (owner) {
      owner.onConnLost(reason);
      return;
    }
    this.failures++;
    this.emit({ kind: "standby", state: "down", detail: reason });
    this.scheduleRetry();
  }

  /** drop bookkeeping + timers (does not touch the socket) */
  private teardown(c: Conn): void {
    c.state = "closed";
    this.clearTimer(c, "connectTimer");
    this.clearTimer(c, "ackTimer");
    this.clearTimer(c, "recycleTimer");
    this.conns.delete(c);
    if (this.standby === c) this.standby = null;
    if (this.opening === c) this.opening = null;
  }

  /** close a socket on our side (1000), idempotent */
  closeConn(c: Conn, reason: string): void {
    if (c.state === "closed") return;
    const ws = c.ws;
    this.teardown(c);
    if (ws) {
      try {
        ws.close(1000, reason);
      } catch {
        /* already closing */
      }
    }
  }

  private clearTimer(c: Conn, key: "connectTimer" | "ackTimer" | "recycleTimer"): void {
    const t = c[key];
    if (t !== null) {
      this.clock.clearTimeout(t);
      c[key] = null;
    }
  }

  /* ---------------------------------------------------------------- token cache */

  /**
   * The cached token was REJECTED (or looks bad): drop it and make the next request ask the server for a FRESH one
   * (`force`), because the server may otherwise hand back the very token Wispr just refused.
   */
  private invalidateToken(): void {
    this.token = null;
    this.forceNextToken = true;
  }

  private async getTokenState(): Promise<TokenState> {
    const now = this.clock.now();
    const cached = this.token;
    if (cached && now < cached.refreshAt) return cached;
    if (this.tokenInFlight) return this.tokenInFlight;
    const p = (async () => {
      try {
        const force = this.forceNextToken;
        const info = await (force ? this.cfg.getToken({ force: true }) : this.cfg.getToken());
        const st = toTokenState(info, this.clock.now());
        this.token = st;
        this.forceNextToken = false;
        return st;
      } catch (e) {
        // a refresh failed: a token that has not actually expired is still better than nothing
        const old = this.token;
        if (old && this.clock.now() < old.expiresAt) return old;
        this.token = null;
        throw e;
      }
    })();
    this.tokenInFlight = p;
    try {
      return await p;
    } finally {
      if (this.tokenInFlight === p) this.tokenInFlight = null;
    }
  }

  /* ---------------------------------------------------------------- REST fallback */

  /** POST the retained PCM as a WAV to the client REST endpoint */
  async restTranscribe(packets: readonly Int16Array[], signal: AbortSignal): Promise<{ text: string; lang?: string }> {
    // snapshot the audio synchronously: the caller may zero-fill its buffers while we await the network
    const pcm = concatInt16(packets);
    const wav = wrapWav(pcm);
    const audio = bytesToBase64(wav);
    zeroFill(pcm, wav);

    let tok = await this.getTokenState();
    for (let attempt = 0; ; attempt++) {
      if (!tok.restUrl) throw new WisprUnavailableError("no REST endpoint");
      const ctx = this.cfg.getContext();
      const body: WisprRestBody = {
        audio,
        context: buildContextPayload(ctx, this.cfg.deviceId, this.cfg.sessionId),
      };
      if (ctx.language.length > 0) body.language = [...ctx.language];
      const res = await this.fetchFn(tok.restUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        this.invalidateToken(); // stale token: mint a FRESH one and retry once
        tok = await this.getTokenState();
        continue;
      }
      if (!res.ok) throw new Error(`REST HTTP ${res.status}`);
      const json: unknown = await res.json();
      const rec = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
      const out: { text: string; lang?: string } = { text: typeof rec.text === "string" ? rec.text : "" };
      if (typeof rec.detected_language === "string") out.lang = rec.detected_language;
      return out;
    }
  }

  /* ---------------------------------------------------------------- misc */

  emit(d: AudioDiagnostic): void {
    try {
      this.cfg.emit?.(d);
    } catch {
      /* diagnostics must never break audio */
    }
  }

  private host(): UtteranceHost {
    return {
      clock: this.clock,
      finalTimeoutMs: this.finalTimeoutMs,
      restTimeoutMs: this.restTimeoutMs,
      maxPerAppend: this.maxPerAppend,
      packetFormat: this.packetFormat,
      emit: (d) => this.emit(d),
      onRadio: (a) => this.cfg.onRadio?.(a),
      onBytes: (n) => this.cfg.onBytes?.(n),
      closeConn: (c, why) => this.closeConn(c, why),
      sessionDone: (u) => this.sessions.delete(u),
      rest: (packets, signal) => this.restTranscribe(packets, signal),
    };
  }
}

/* ------------------------------------------------------------------ one utterance */

interface UtteranceHost {
  clock: Clock;
  finalTimeoutMs: number;
  restTimeoutMs: number;
  maxPerAppend: number;
  packetFormat: "pcm16" | "wav";
  emit(d: AudioDiagnostic): void;
  onRadio(active: boolean): void;
  onBytes(chars: number): void;
  closeConn(c: Conn, why: string): void;
  sessionDone(u: Utterance): void;
  rest(packets: readonly Int16Array[], signal: AbortSignal): Promise<{ text: string; lang?: string }>;
}

class Utterance implements UtteranceHandle {
  readonly fragmentId: string;
  state: "streaming" | "committed" | "settled" = "streaming";

  private packets: Int16Array[] = [];
  private volumes: number[] = [];
  private sent = 0;
  private wsBroken = false;
  private commitSent = false;
  private commitSentAt = 0;
  private finalTimer: TimerId | null = null;
  private restStarted = false;
  private restAbort: AbortController | null = null;
  private radioOn = false;

  constructor(
    private readonly host: UtteranceHost,
    private conn: Conn | null,
    private readonly opts: ClaimOptions,
  ) {
    this.fragmentId = opts.fragmentId;
  }

  get packetCount(): number {
    return this.packets.length;
  }

  /* ---- input from the capture core ---- */

  pushPreroll(frames: ReadonlyArray<{ pcm: Int16Array; rms: number }>): void {
    if (this.state !== "streaming") return;
    for (const f of frames) {
      this.packets.push(f.pcm);
      this.volumes.push(f.rms);
    }
    this.sendPending(); // CAP-1: the first packets go out immediately (when the standby was ready)
  }

  push(pcm: Int16Array, rms: number): void {
    if (this.state !== "streaming") return;
    this.packets.push(pcm);
    this.volumes.push(rms);
    if (this.packets.length - this.sent >= this.opts.packetsPerAppend) this.sendPending();
  }

  commit(): void {
    if (this.state !== "streaming") return;
    if (this.packets.length === 0) {
      this.abort("empty utterance");
      return;
    }
    this.state = "committed";
    this.finalTimer = this.host.clock.setTimeout(() => this.onFinalTimeout(), this.host.finalTimeoutMs);
    if (this.wsBroken || !this.conn) {
      this.startRest("websocket unavailable");
      return;
    }
    if (this.conn.state === "ready") this.sendCommit();
    // otherwise the commit goes out from onConnReady()
  }

  abort(_reason?: string): void {
    if (this.state === "settled") return;
    this.finish();
  }

  /* ---- events from the connection ---- */

  onConnReady(): void {
    if (this.state === "settled") return;
    this.sendPending();
    if (this.state === "committed" && !this.commitSent) this.sendCommit();
  }

  onConnLost(reason: string): void {
    if (this.state === "settled") return;
    this.wsBroken = true;
    this.conn = null;
    if (this.state === "committed") this.startRest(reason);
    // while still streaming we keep collecting PCM; commit() will go straight to REST
  }

  onWsError(reason: string): void {
    if (this.state === "settled") return;
    this.wsBroken = true;
    const c = this.conn;
    this.conn = null;
    if (c) this.host.closeConn(c, "error");
    if (this.state === "committed") this.startRest(reason);
  }

  onText(msg: Record<string, unknown>): void {
    if (this.state === "settled") return;
    if (msg.final !== true) return; // partials are informational only
    if (!this.commitSent) {
      this.host.emit({ kind: "anomaly", detail: "final text before commit ignored" });
      return;
    }
    const body = msg.body && typeof msg.body === "object" ? (msg.body as Record<string, unknown>) : {};
    const text = typeof body.text === "string" ? body.text : "";
    const lang = typeof body.detected_language === "string" ? body.detected_language : undefined;
    this.settleOk(text, lang, "wispr_ws", this.commitSentAt, this.host.clock.now());
  }

  /* ---- sending ---- */

  private ready(): boolean {
    return !this.wsBroken && this.conn !== null && this.conn.state === "ready" && this.conn.ws !== null;
  }

  private trySend(obj: unknown): boolean {
    const ws = this.conn?.ws;
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this.host.emit({ kind: "anomaly", detail: `send failed: ${errMsg(e)}` });
      this.wsBroken = true;
      const c = this.conn;
      this.conn = null;
      if (c) this.host.closeConn(c, "send failed");
      return false;
    }
  }

  private sendPending(): void {
    if (this.state === "settled" || !this.ready()) return;
    while (this.sent < this.packets.length) {
      const n = Math.min(this.packets.length - this.sent, this.host.maxPerAppend);
      const encoded: string[] = new Array<string>(n);
      let chars = 0;
      for (let i = 0; i < n; i++) {
        const b64 = encodePacket(this.packets[this.sent + i] as Int16Array, this.host.packetFormat);
        encoded[i] = b64;
        chars += b64.length;
      }
      const msg = buildAppendMessage(this.sent, encoded, this.volumes.slice(this.sent, this.sent + n));
      if (!this.trySend(msg)) return;
      this.sent += n;
      this.host.onBytes(chars);
      if (!this.radioOn) {
        this.radioOn = true;
        this.host.onRadio(true);
      }
    }
  }

  private sendCommit(): void {
    this.sendPending();
    if (this.wsBroken || !this.ready()) {
      if (this.state === "committed") this.startRest("websocket unavailable");
      return;
    }
    if (!this.trySend(buildCommitMessage(this.packets.length))) {
      if (this.state === "committed") this.startRest("commit send failed");
      return;
    }
    this.commitSent = true;
    this.commitSentAt = this.host.clock.now();
  }

  /* ---- fallback ---- */

  private onFinalTimeout(): void {
    this.finalTimer = null;
    if (this.state === "settled" || this.restStarted) return;
    this.startRest("no final within timeout");
  }

  private startRest(reason: string): void {
    if (this.state === "settled" || this.restStarted) return;
    this.restStarted = true;
    if (this.finalTimer !== null) {
      this.host.clock.clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
    this.host.emit({ kind: "fallback", reason });
    void this.runRest();
  }

  private async runRest(): Promise<void> {
    const ctrl = new AbortController();
    this.restAbort = ctrl;
    const timeout = this.host.clock.setTimeout(() => ctrl.abort(), this.host.restTimeoutMs);
    if (!this.radioOn) {
      this.radioOn = true;
      this.host.onRadio(true);
    }
    const sentAt = this.host.clock.now();
    try {
      const res = await this.host.rest(this.packets, ctrl.signal);
      if (this.state === "settled") return;
      this.settleOk(res.text, res.lang, "wispr_rest", sentAt, this.host.clock.now());
    } catch (e) {
      if (this.state === "settled") return;
      this.settleFail(`rest fallback failed: ${errMsg(e)}`);
    } finally {
      this.host.clock.clearTimeout(timeout);
      if (this.restAbort === ctrl) this.restAbort = null;
    }
  }

  /* ---- settling ---- */

  private settleOk(text: string, lang: string | undefined, transport: "wispr_ws" | "wispr_rest", tCommit: number, tFinal: number): void {
    if (this.state === "settled") return;
    this.finish();
    this.host.emit({ kind: "latency", commitToFinalMs: Math.max(0, tFinal - tCommit), transport });
    const t: WisprTranscript = { text, transport, tCommitSent: tCommit, tFinal };
    if (lang) t.detectedLanguage = lang;
    try {
      this.opts.onTranscript(t);
    } catch (e) {
      this.host.emit({ kind: "anomaly", detail: `onTranscript threw: ${errMsg(e)}` });
    }
  }

  private settleFail(reason: string): void {
    if (this.state === "settled") return;
    this.finish();
    try {
      this.opts.onFailed(reason);
    } catch (e) {
      this.host.emit({ kind: "anomaly", detail: `onFailed threw: ${errMsg(e)}` });
    }
  }

  /** common exit: close the socket, stop timers/requests, zero-fill and release every buffer */
  private finish(): void {
    this.state = "settled";
    if (this.finalTimer !== null) {
      this.host.clock.clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
    this.restAbort?.abort();
    this.restAbort = null;
    if (this.radioOn) {
      this.radioOn = false;
      this.host.onRadio(false);
    }
    const c = this.conn;
    this.conn = null;
    if (c) this.host.closeConn(c, "done");
    zeroFill(...this.packets);
    this.packets = [];
    this.volumes = [];
    this.host.sessionDone(this);
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Strip anything that could carry the JWT or the WebSocket URL (which contains it) from a string before it leaves this
 * module as a diagnostic / failure reason. Browsers put the full URL into WebSocket construction errors.
 */
export function scrub(s: string): string {
  return s
    .replace(/\b(?:wss?|https?):\/\/\S+/gi, "[url]")
    .replace(/Bearer(?:\s|%20)+[\w.~+/=%-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[token]");
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" ? "timeout/aborted" : scrub(e.message).slice(0, 120);
  return scrub(String(e)).slice(0, 120);
}

/**
 * A short description of a {status:"error"} message for the diagnostics (never shown as a transcript). Includes Wispr's own
 * short error text when it sent one, scrubbed of URLs / tokens, so a first run with a real key is debuggable.
 */
function describeWsError(msg: Record<string, unknown>): string {
  const code = typeof msg.code === "string" || typeof msg.code === "number" ? String(msg.code).slice(0, 40) : "";
  const raw = [msg.message, msg.error, msg.detail].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const text = raw ? scrub(raw.trim()).slice(0, 100) : "";
  return ["wispr error", code, text ? `- ${text}` : ""].filter(Boolean).join(" ");
}
