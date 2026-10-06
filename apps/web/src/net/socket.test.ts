import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@synapse/shared";
import { PING_EVERY_MS, SynapseSocket, backoffMs, median, type SocketHooks, type WelcomeMsg } from "./socket";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.drop();
  }
  // ---- test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const welcome = (over: Partial<WelcomeMsg> = {}): WelcomeMsg => ({
  type: "welcome",
  deviceId: "dev-1",
  serverTime: 1,
  config: {} as WelcomeMsg["config"],
  state: {} as WelcomeMsg["state"],
  ...over,
});

function make(over: { token?: string } = {}) {
  const hooks = {
    onStatus: vi.fn(),
    onAuth: vi.fn(),
    onWelcome: vi.fn(),
    onMessage: vi.fn(),
    onClock: vi.fn(),
    onReplaced: vi.fn(),
  } satisfies SocketHooks;
  let nowMs = 1_000_000;
  const socket = new SynapseSocket({
    url: () => "ws://test/ws",
    identity: () => ({ deviceId: "dev-1", kind: "desk", token: over.token }),
    hooks,
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    now: () => nowMs,
    random: () => 0.5,
  });
  return {
    socket,
    hooks,
    advanceClock: (ms: number) => (nowMs += ms),
    ws: () => FakeWS.instances[FakeWS.instances.length - 1] as FakeWS,
  };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoff and median", () => {
  it("grows exponentially, caps at 8 s and jitters ±20 %", () => {
    expect(backoffMs(0, 0.5)).toBe(400);
    expect(backoffMs(1, 0.5)).toBe(800);
    expect(backoffMs(2, 0.5)).toBe(1600);
    expect(backoffMs(10, 0.5)).toBe(8000);
    expect(backoffMs(0, 0)).toBe(320);
    expect(backoffMs(0, 1)).toBe(480);
  });
  it("median of odd and even samples", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("hello and welcome", () => {
  it("sends hello (with the stored token) as soon as the socket opens, and is 'open' only after welcome", () => {
    const t = make({ token: "tok-123" });
    t.socket.start();
    expect(t.ws().url).toBe("ws://test/ws");
    expect(t.hooks.onStatus).toHaveBeenLastCalledWith("connecting", { attempt: 0 });
    t.ws().open();
    expect(t.ws().messages[0]).toEqual({ type: "hello", deviceId: "dev-1", kind: "desk", token: "tok-123" });
    expect(t.socket.status).toBe("connecting");
    t.ws().receive(welcome());
    expect(t.socket.status).toBe("open");
    expect(t.hooks.onWelcome).toHaveBeenCalledOnce();
    expect(t.hooks.onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "welcome" }));
  });

  it("start() twice does not open two sockets", () => {
    const t = make();
    t.socket.start();
    t.socket.start();
    expect(FakeWS.instances).toHaveLength(1);
  });
});

describe("ping and clock sync", () => {
  it("pings immediately and every 10 s, and computes RTT and the server−client offset", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    const pings = () => t.ws().messages.filter((m) => m.type === "ping");
    expect(pings()).toHaveLength(1);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(pings()).toHaveLength(2);

    // client sent t0 = 1_000_000, 40 ms round trip, server clock is 500 ms ahead
    t.advanceClock(40);
    t.ws().receive({ type: "pong", t0: 1_000_000, tServer: 1_000_000 + 20 + 500 } satisfies ServerMessage);
    expect(t.hooks.onClock).toHaveBeenCalledWith({ rttMs: 40, offsetMs: 500 });
  });

  it("stops pinging when the connection drops", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    const first = t.ws();
    first.drop();
    vi.advanceTimersByTime(PING_EVERY_MS * 3);
    expect(first.messages.filter((m) => m.type === "ping")).toHaveLength(1);
  });
});

describe("pairing flow", () => {
  it("auth.required → status 'auth' → pair(code) re-sends hello with the code on the same socket → welcome with a token", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive({ type: "auth.required", reason: "pairing code required" });
    expect(t.socket.status).toBe("auth");
    expect(t.hooks.onAuth).toHaveBeenLastCalledWith("pairing code required", false);
    expect(FakeWS.instances).toHaveLength(1); // no reconnect loop while waiting for a code

    t.socket.pair(" 123456 ");
    expect(t.ws().messages[1]).toMatchObject({ type: "hello", pairingCode: "123456" });

    // wrong code
    t.ws().receive({ type: "auth.required", reason: "wrong pairing code" });
    expect(t.hooks.onAuth).toHaveBeenLastCalledWith("wrong pairing code", true);

    // right code
    t.socket.pair("654321");
    t.ws().receive(welcome({ token: "issued-token" }));
    expect(t.socket.status).toBe("open");
    expect(t.hooks.onWelcome).toHaveBeenCalledWith(expect.objectContaining({ token: "issued-token" }));
  });

  it("does not keep the pairing code after a successful welcome", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.socket.pair("111111");
    t.ws().receive(welcome({ token: "tok" }));
    t.ws().drop();
    vi.advanceTimersByTime(10_000);
    t.ws().open();
    expect(t.ws().messages[0]).not.toHaveProperty("pairingCode");
  });
});

describe("reconnect", () => {
  it("reconnects with backoff after a drop, re-sends hello, and resets the attempt counter on welcome", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    t.ws().drop();
    expect(t.socket.status).toBe("closed");
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(399);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeWS.instances).toHaveLength(2);
    t.ws().open();
    expect(t.ws().messages[0]).toMatchObject({ type: "hello" });
    t.ws().receive(welcome());
    expect(t.hooks.onStatus).toHaveBeenLastCalledWith("open", { attempt: 0 });

    // second drop starts from the shortest delay again
    t.ws().drop();
    vi.advanceTimersByTime(401);
    expect(FakeWS.instances).toHaveLength(3);
  });

  it("stop() closes for good", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    t.socket.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(t.socket.status).toBe("closed");
  });

  it("retryNow() skips the wait", () => {
    const t = make();
    t.socket.start();
    t.ws().drop();
    t.socket.retryNow();
    expect(FakeWS.instances).toHaveLength(2);
  });
});

describe("replaced by a newer connection (another tab with the same device id)", () => {
  it("does not fight for the id: it lets the app change identity, then reconnects at once", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    const first = t.ws();
    first.readyState = 3;
    first.onclose?.({ code: 4000, reason: "replaced by a newer connection" } as CloseEvent);
    expect(t.hooks.onReplaced).toHaveBeenCalledOnce();
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(61);
    expect(FakeWS.instances).toHaveLength(2); // straight back, no backoff
    t.ws().open();
    expect(t.ws().messages[0]).toMatchObject({ type: "hello" });
  });

  it("ordinary drops still back off", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    t.ws().onclose?.({ code: 1006 } as CloseEvent);
    expect(t.hooks.onReplaced).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(FakeWS.instances).toHaveLength(1);
  });
});

describe("sending", () => {
  it("sends when open, drops time-sensitive messages when closed, queues the ones that must survive", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    // not authed yet
    expect(t.socket.send({ type: "speech.state", speaking: true, at: 1 })).toBe(false);
    t.ws().receive(welcome());
    expect(t.socket.send({ type: "speech.state", speaking: true, at: 2 })).toBe(true);

    t.ws().drop();
    expect(t.socket.send({ type: "speech.state", speaking: false, at: 3 })).toBe(false); // dropped
    expect(
      t.socket.send({
        type: "fragment.final",
        fragmentId: "f-1",
        sessionId: "s-1",
        text: "hello",
        t: { speechStart: 1, speechEnd: 2 },
        durationMs: 1,
        pauseBeforeMs: 0,
        rmsMean: 0.1,
        rmsMax: 0.2,
        whisper: false,
        transport: "mock",
      }),
    ).toBe(false); // queued

    vi.advanceTimersByTime(500);
    t.ws().open();
    t.ws().receive(welcome());
    const types = t.ws().messages.map((m) => m.type);
    expect(types).toContain("fragment.final");
    expect(types).not.toContain("speech.state");
  });

  it("keeps only the most recent 60 queued messages", () => {
    const t = make();
    t.socket.start();
    for (let i = 0; i < 80; i++) t.socket.send({ type: "privacy.forget", scope: "last" });
    t.ws().open();
    t.ws().receive(welcome());
    expect(t.ws().messages.filter((m) => m.type === "privacy.forget")).toHaveLength(60);
  });
});

describe("wispr token requests", () => {
  it("resolves with the next wispr.token message", async () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    const p = t.socket.requestWisprToken();
    expect(t.ws().messages.some((m) => m.type === "wispr.token.request")).toBe(true);
    t.ws().receive({ type: "wispr.token", mode: "client", token: "jwt", expiresAt: 5 });
    await expect(p).resolves.toMatchObject({ mode: "client", token: "jwt" });
  });

  it("forwards the force flag (and sends no force key on a plain request)", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    void t.socket.requestWisprToken(1000, true).catch(() => undefined);
    void t.socket.requestWisprToken().catch(() => undefined);
    const reqs = t.ws().messages.filter((m) => m.type === "wispr.token.request");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toEqual({ type: "wispr.token.request", force: true });
    expect(reqs[1]).toEqual({ type: "wispr.token.request" });
    expect(Object.keys(reqs[1] as object)).not.toContain("force");
    vi.advanceTimersByTime(11_000); // let the dangling waiters time out
  });

  it("rejects after the timeout and when there is no connection", async () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().receive(welcome());
    const slow = t.socket.requestWisprToken(1000);
    const caught = slow.catch((e: Error) => e.message);
    vi.advanceTimersByTime(1001);
    await expect(caught).resolves.toMatch(/did not answer/);

    t.ws().drop();
    await expect(t.socket.requestWisprToken()).rejects.toThrow(/Not connected/);
  });
});

describe("robustness", () => {
  it("ignores garbage frames", () => {
    const t = make();
    t.socket.start();
    t.ws().open();
    t.ws().onmessage?.({ data: "not json" } as MessageEvent);
    t.ws().onmessage?.({ data: JSON.stringify({ nope: 1 }) } as MessageEvent);
    expect(t.hooks.onMessage).not.toHaveBeenCalled();
  });
});
