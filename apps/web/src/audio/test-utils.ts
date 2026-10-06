/* ============================================================================
 * Test doubles for the audio pipeline. Imported only by *.test.ts files.
 * No Node-only APIs here: the web app's tsconfig has no @types/node.
 * ========================================================================== */
import type { Clock, TimerId } from "./clock";
import type { WsLike } from "./wispr";

/** Deterministic clock: time only moves when the test says so. Timers fire in order inside advance(). */
export class FakeClock implements Clock {
  private t: number;
  private burned = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  /** monotonic; also advances when a test calls burn() to simulate CPU work */
  perf(): number {
    return this.t + this.burned;
  }

  /** simulate `ms` of CPU time passing inside a callback (advances perf() only) */
  burn(ms: number): void {
    this.burned += ms;
  }

  setTimeout(fn: () => void, ms: number): TimerId {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id: TimerId): void {
    this.timers.delete(id as number);
  }

  setInterval(fn: () => void, ms: number): TimerId {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.timers.set(id, { at: this.t + every, fn, every });
    return id;
  }

  clearInterval(id: TimerId): void {
    this.timers.delete(id as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** move time forward, firing due timers in chronological order */
  advance(ms: number): void {
    const target = this.t + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers) {
        if (tm.at <= target && (tm.at < nextAt || (tm.at === nextAt && id < nextId))) {
          nextId = id;
          nextAt = tm.at;
        }
      }
      if (nextId < 0) break;
      const tm = this.timers.get(nextId)!;
      this.t = Math.max(this.t, tm.at);
      if (tm.every !== undefined) tm.at += tm.every;
      else this.timers.delete(nextId);
      tm.fn();
    }
    this.t = target;
  }
}

const setImmediateFn = (globalThis as unknown as { setImmediate?: (fn: () => void) => unknown }).setImmediate;

/**
 * Let pending promise continuations (and I/O-ish microtask chains such as Response.json()) run.
 * Uses setImmediate when it exists (Node) because setTimeout(0) has a ~15 ms floor on Windows.
 */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => (setImmediateFn ? setImmediateFn(() => r()) : setTimeout(r, 0)));
  }
}

/** WebSocket stand-in. The test plays the server: open(), serverSend(), serverClose(). */
export class FakeWs implements WsLike {
  static instances: FakeWs[] = [];
  static reset(): void {
    FakeWs.instances = [];
  }

  readyState = 0;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  throwOnSend = false;

  constructor(readonly url: string) {
    FakeWs.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1 || this.throwOnSend) throw new Error("FakeWs: send on a socket that is not open");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    // real sockets fire onclose asynchronously
    queueMicrotask(() => this.onclose?.({ code: code ?? 1005, reason }));
  }

  /* ---- server side ---- */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(obj: unknown): void {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }

  serverClose(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  serverError(): void {
    this.onerror?.({});
  }

  /* ---- inspection ---- */
  get messages(): Array<Record<string, any>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, any>);
  }

  ofType(type: string): Array<Record<string, any>> {
    return this.messages.filter((m) => m.type === type);
  }

  get isClosed(): boolean {
    return this.readyState === 3;
  }
}

/* ---------------------------------------------------------------- microphone / audio context doubles */

type Listener = () => void;

export class FakeTrack {
  stopped = false;
  readyState: "live" | "ended" = "live";
  private readonly listeners = new Map<string, Set<Listener>>();
  /** global ordering log shared with the test (optional) */
  constructor(private readonly log?: string[]) {}

  stop(): void {
    if (!this.stopped) this.log?.push("track.stop"); // log only the first (effective) stop
    this.stopped = true;
    this.readyState = "ended";
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  /** simulate a MediaStreamTrack event ("ended", "mute", "unmute") */
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

export class FakeStream {
  readonly track: FakeTrack;
  constructor(log?: string[]) {
    this.track = new FakeTrack(log);
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
}

export class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  closed = false;
  resumeCalls = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.state !== "closed") this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

/** a window / document stand-in: addEventListener + a visibilityState the test can flip */
export class FakeEventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  private readonly fns = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    let s = this.fns.get(type);
    if (!s) this.fns.set(type, (s = new Set()));
    s.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.fns.get(type)?.delete(fn);
  }

  fire(type: string): void {
    for (const f of [...(this.fns.get(type) ?? [])]) f();
  }

  count(type?: string): number {
    if (type) return this.fns.get(type)?.size ?? 0;
    let n = 0;
    for (const s of this.fns.values()) n += s.size;
    return n;
  }
}
