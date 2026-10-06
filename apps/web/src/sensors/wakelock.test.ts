import { describe, expect, it } from "vitest";
import { flush } from "../audio/test-utils";
import { holdWakeLock, type WakeLockDeps } from "./wakelock";

class FakeSentinel {
  released = false;
  releaseCalls = 0;
  private fns = new Set<() => void>();
  async release(): Promise<void> {
    this.releaseCalls++;
    if (this.released) return;
    this.released = true;
    for (const f of [...this.fns]) f();
  }
  addEventListener(_t: "release", fn: () => void): void {
    this.fns.add(fn);
  }
  removeEventListener(_t: "release", fn: () => void): void {
    this.fns.delete(fn);
  }
  /** the system revokes the lock (tab hidden) */
  systemRelease(): void {
    this.released = true;
    for (const f of [...this.fns]) f();
  }
}

function env(over: { reject?: boolean; visible?: boolean; delay?: boolean } = {}) {
  const sentinels: FakeSentinel[] = [];
  let requests = 0;
  let resolvers: Array<() => void> = [];
  const doc = {
    visibilityState: over.visible === false ? "hidden" : "visible",
    fns: new Set<() => void>(),
    addEventListener(_t: "visibilitychange", fn: () => void) {
      this.fns.add(fn);
    },
    removeEventListener(_t: "visibilitychange", fn: () => void) {
      this.fns.delete(fn);
    },
    fire() {
      for (const f of [...this.fns]) f();
    },
  };
  const state = { reject: over.reject ?? false };
  const nav = {
    wakeLock: {
      request: async (_t: "screen") => {
        requests++;
        if (state.reject) throw new Error("NotAllowedError");
        if (over.delay) await new Promise<void>((r) => resolvers.push(r));
        const s = new FakeSentinel();
        sentinels.push(s);
        return s;
      },
    },
  };
  const deps: WakeLockDeps = { navigator: nav, document: doc };
  return {
    deps,
    doc,
    sentinels,
    state,
    get requests() {
      return requests;
    },
    resolveAll: () => {
      const r = resolvers;
      resolvers = [];
      r.forEach((f) => f());
    },
  };
}

describe("holdWakeLock", () => {
  it("acquires the screen lock and reports it active", async () => {
    const e = env();
    const h = holdWakeLock(e.deps);
    expect(h.active).toBe(false); // the request is async
    await flush();
    expect(h.active).toBe(true);
    expect(e.requests).toBe(1);
  });

  it("re-acquires after the system drops it and the page becomes visible again", async () => {
    const e = env();
    const h = holdWakeLock(e.deps);
    await flush();
    e.sentinels[0]!.systemRelease(); // tab hidden: the browser revokes the lock
    expect(h.active).toBe(false);
    e.doc.visibilityState = "hidden";
    e.doc.fire();
    await flush();
    expect(e.requests).toBe(1); // no pointless request while hidden
    e.doc.visibilityState = "visible";
    e.doc.fire();
    await flush();
    expect(e.requests).toBe(2);
    expect(h.active).toBe(true);
    // a visibilitychange while we still hold it does not stack requests
    e.doc.fire();
    await flush();
    expect(e.requests).toBe(2);
  });

  it("release() gives the lock back, stops listening, and never re-acquires", async () => {
    const e = env();
    const h = holdWakeLock(e.deps);
    await flush();
    await h.release();
    expect(h.active).toBe(false);
    expect(e.sentinels[0]!.released).toBe(true);
    expect(e.doc.fns.size).toBe(0);
    e.doc.fire();
    await flush();
    expect(e.requests).toBe(1);
    await h.release(); // idempotent
    expect(e.sentinels[0]!.releaseCalls).toBe(1);
  });

  it("a refused request does not throw and is retried on the next visibilitychange", async () => {
    const e = env({ reject: true });
    const h = holdWakeLock(e.deps);
    await flush();
    expect(h.active).toBe(false);
    e.state.reject = false;
    e.doc.fire();
    await flush();
    expect(h.active).toBe(true);
    expect(e.requests).toBe(2);
  });

  it("does not request while the page is hidden, and gets the lock when it shows", async () => {
    const e = env({ visible: false });
    const h = holdWakeLock(e.deps);
    await flush();
    expect(e.requests).toBe(0);
    e.doc.visibilityState = "visible";
    e.doc.fire();
    await flush();
    expect(h.active).toBe(true);
  });

  it("release() while a request is still pending releases the late sentinel", async () => {
    const e = env({ delay: true });
    const h = holdWakeLock(e.deps);
    await flush();
    const rel = h.release();
    e.resolveAll();
    await rel;
    await flush();
    expect(h.active).toBe(false);
    expect(e.sentinels).toHaveLength(1);
    expect(e.sentinels[0]!.released).toBe(true);
  });

  it("is a harmless no-op where the API is unsupported (Safari < 16.4, Firefox < 126, insecure origins)", async () => {
    for (const deps of [{ navigator: {} }, { navigator: null }, { navigator: { wakeLock: undefined }, document: null }] as WakeLockDeps[]) {
      const h = holdWakeLock(deps);
      await flush();
      expect(h.active).toBe(false);
      await expect(h.release()).resolves.toBeUndefined();
    }
  });
});
