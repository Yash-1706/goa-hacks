import type { ClientMessage, ServerMessage } from "@synapse/shared";

/* ============================================================================
 * Typed WebSocket client for the Synapse server (TRD §14).
 *  - hello / pairing: localhost is trusted; another device gets `auth.required` until it sends the
 *    6-digit pairing code, then receives a token in `welcome` (stored by the caller) for later hellos
 *  - auto-reconnect with exponential backoff + jitter (resets on a successful welcome)
 *  - ping every 10 s → RTT and a server−client clock offset (median of the last 5)
 *  - a small outbound queue for messages that must not be lost while offline (fragments, privacy, actions)
 * It knows nothing about stores: everything goes out through `hooks`, so it is unit-testable.
 * ========================================================================== */

export type WisprTokenMsg = Extract<ServerMessage, { type: "wispr.token" }>;
export type WelcomeMsg = Extract<ServerMessage, { type: "welcome" }>;

export type SocketStatus = "connecting" | "open" | "auth" | "closed";

export interface SocketHooks {
  onStatus: (status: SocketStatus, info?: { attempt?: number }) => void;
  /** auth.required: `wrongCode` is true when a pairing code was just rejected */
  onAuth: (reason: string, wrongCode: boolean) => void;
  onWelcome: (msg: WelcomeMsg) => void;
  /** the server closed us with 4000: another connection took this device id (another tab). Change identity here. */
  onReplaced?: () => void;
  onMessage: (msg: ServerMessage) => void;
  onClock: (s: { rttMs: number; offsetMs: number }) => void;
}

export interface SocketDeps {
  url: () => string;
  identity: () => { deviceId: string; kind: "desk" | "pocket"; name?: string; token?: string };
  hooks: SocketHooks;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export const PING_EVERY_MS = 10_000;
/** close code the server uses when a newer connection with the same device id replaces this one */
export const REPLACED_CODE = 4000;
const QUEUE_MAX = 60;
/** messages worth replaying after a reconnect; everything else is only meaningful "now" */
const QUEUEABLE: ReadonlySet<ClientMessage["type"]> = new Set([
  "fragment.final",
  "fragment.failed",
  "session.start",
  "session.end",
  "privacy.pause",
  "privacy.resume",
  "privacy.forget",
  "card.action",
  "suggestion.action",
  "recall.ask",
]);

/** Exponential backoff with jitter: 0.4 s, 0.8 s, 1.6 s … capped at 8 s. */
export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(8000, 400 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random));
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export class SynapseSocket {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private pairingCode: string | undefined;
  private codeInFlight = false;
  private queue: ClientMessage[] = [];
  private offsets: number[] = [];
  private tokenWaiters: Array<(m: WisprTokenMsg) => void> = [];
  private authed = false;
  status: SocketStatus = "closed";

  constructor(private d: SocketDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    try {
      ws?.close(1000, "client stopped");
    } catch {
      /* already closed */
    }
    this.setStatus("closed");
  }

  /** Reconnect right now (tab became visible, network came back, user pressed retry). */
  retryNow(): void {
    if (this.stopped || this.status === "open" || this.status === "auth") return;
    this.attempt = 0;
    if (this.reconnectTimer !== null) (this.d.clearTimeout ?? clearTimeout)(this.reconnectTimer as never);
    this.reconnectTimer = null;
    if (!this.ws || this.ws.readyState === 3) this.open();
  }

  get isOpen(): boolean {
    return this.authed && this.ws?.readyState === 1;
  }

  /** Send (or queue, for the message types that must survive a reconnect). Returns true when sent now. */
  send(msg: ClientMessage): boolean {
    if (this.isOpen) {
      try {
        this.ws?.send(JSON.stringify(msg));
        return true;
      } catch {
        /* fall through to queueing */
      }
    }
    if (QUEUEABLE.has(msg.type)) {
      this.queue.push(msg);
      if (this.queue.length > QUEUE_MAX) this.queue.shift();
    }
    return false;
  }

  /** The user typed the pairing code. */
  pair(code: string): void {
    this.pairingCode = code.trim();
    this.codeInFlight = true;
    if (this.ws?.readyState === 1) this.sendHello();
    else this.retryNow();
  }

  /**
   * Ask for a Wispr client token; resolves with the next wispr.token message. `force` makes the server mint a
   * FRESH token instead of re-serving its short cache (the engine sets it after Wispr rejected the previous one).
   */
  requestWisprToken(timeoutMs = 10_000, force?: boolean): Promise<WisprTokenMsg> {
    return new Promise((resolve, reject) => {
      const timer = (this.d.setTimeout ?? setTimeout)(() => {
        this.tokenWaiters = this.tokenWaiters.filter((w) => w !== done);
        reject(new Error("The server did not answer the Wispr token request in time"));
      }, timeoutMs);
      const done = (m: WisprTokenMsg): void => {
        (this.d.clearTimeout ?? clearTimeout)(timer as never);
        resolve(m);
      };
      this.tokenWaiters.push(done);
      if (!this.send({ type: "wispr.token.request", ...(force ? { force: true } : {}) })) {
        this.tokenWaiters = this.tokenWaiters.filter((w) => w !== done);
        (this.d.clearTimeout ?? clearTimeout)(timer as never);
        reject(new Error("Not connected to the Synapse server"));
      }
    });
  }

  // ------------------------------------------------------------- internals --

  private setStatus(s: SocketStatus): void {
    this.status = s;
    this.d.hooks.onStatus(s, { attempt: this.attempt });
  }

  private open(): void {
    if (this.stopped) return;
    const Impl = this.d.WebSocketImpl ?? WebSocket;
    this.authed = false;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new Impl(this.d.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendHello();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.onRaw(ev.data);
    };
    ws.onerror = () => {
      /* the close event that follows does the work */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      this.clearPing();
      this.rejectTokenWaiters();
      if (this.stopped) return;
      if (ev?.code === REPLACED_CODE) {
        // "replaced by a newer connection": reconnecting with the same id would kick the other tab right back.
        // Let the app give this tab its own identity, then come straight back (no backoff).
        this.d.hooks.onReplaced?.();
        this.attempt = 0;
        this.setStatus("closed");
        this.reconnectTimer = (this.d.setTimeout ?? setTimeout)(() => {
          this.reconnectTimer = null;
          this.open();
        }, 60);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private sendHello(): void {
    const id = this.d.identity();
    const hello: ClientMessage = {
      type: "hello",
      deviceId: id.deviceId,
      kind: id.kind,
      ...(id.name ? { name: id.name } : {}),
      ...(id.token ? { token: id.token } : {}),
      ...(this.pairingCode ? { pairingCode: this.pairingCode } : {}),
    };
    try {
      this.ws?.send(JSON.stringify(hello));
    } catch {
      /* closing */
    }
  }

  private onRaw(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data)) as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof (msg as { type?: unknown }).type !== "string") return;

    switch (msg.type) {
      case "welcome":
        this.authed = true;
        this.attempt = 0;
        this.codeInFlight = false;
        this.pairingCode = undefined; // the token replaces it
        this.setStatus("open");
        this.startPing();
        this.d.hooks.onWelcome(msg);
        this.d.hooks.onMessage(msg);
        this.flush();
        return;
      case "auth.required": {
        this.authed = false;
        const wrong = this.codeInFlight;
        this.codeInFlight = false;
        this.clearPing();
        this.setStatus("auth");
        this.d.hooks.onAuth(msg.reason, wrong);
        return;
      }
      case "pong": {
        const t = this.now();
        const rtt = Math.max(0, t - msg.t0);
        const offset = msg.tServer - (msg.t0 + rtt / 2);
        this.offsets.push(offset);
        if (this.offsets.length > 5) this.offsets.shift();
        this.d.hooks.onClock({ rttMs: rtt, offsetMs: median(this.offsets) });
        return;
      }
      case "wispr.token": {
        const waiters = this.tokenWaiters;
        this.tokenWaiters = [];
        for (const w of waiters) w(msg);
        this.d.hooks.onMessage(msg);
        return;
      }
      default:
        this.d.hooks.onMessage(msg);
    }
  }

  private flush(): void {
    const q = this.queue;
    this.queue = [];
    for (const m of q) {
      try {
        this.ws?.send(JSON.stringify(m));
      } catch {
        this.queue.push(m);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffMs(this.attempt, (this.d.random ?? Math.random)());
    this.attempt++;
    this.setStatus("closed");
    this.reconnectTimer = (this.d.setTimeout ?? setTimeout)(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    const ping = (): void => {
      if (this.isOpen) this.send({ type: "ping", t0: this.now() });
    };
    ping();
    this.pingTimer = (this.d.setInterval ?? setInterval)(ping, PING_EVERY_MS);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) (this.d.clearInterval ?? clearInterval)(this.pingTimer as never);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer !== null) (this.d.clearTimeout ?? clearTimeout)(this.reconnectTimer as never);
    this.reconnectTimer = null;
    this.rejectTokenWaiters();
  }

  private rejectTokenWaiters(): void {
    // waiters are promise resolvers with their own timeout; a closed socket just lets them time out
    this.tokenWaiters = [];
  }
}
