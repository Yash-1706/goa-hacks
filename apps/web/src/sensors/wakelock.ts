/* ============================================================================
 * Screen Wake Lock for Pocket mode (TRD §4.1, §11.4): hold the screen awake only while a session is active, and
 * re-acquire when the page becomes visible again (the browser drops the lock whenever the tab is hidden).
 * Never throws; a no-op where the API is unsupported or the request is refused (low battery saver, hidden page, ...).
 * ========================================================================== */

export interface WakeLockHandle {
  /** stop holding the lock and stop re-acquiring */
  release(): Promise<void>;
  /** true while a sentinel is held right now */
  readonly active: boolean;
}

interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
  removeEventListener(type: "release", fn: () => void): void;
}

export interface WakeLockDeps {
  navigator?: { wakeLock?: { request(type: "screen"): Promise<SentinelLike> } } | null;
  document?: {
    visibilityState: string;
    addEventListener(type: "visibilitychange", fn: () => void): void;
    removeEventListener(type: "visibilitychange", fn: () => void): void;
  } | null;
}

export function holdWakeLock(deps: WakeLockDeps = {}): WakeLockHandle {
  const g = globalThis as unknown as { navigator?: WakeLockDeps["navigator"]; document?: WakeLockDeps["document"] };
  const nav = deps.navigator === undefined ? (g.navigator ?? null) : deps.navigator;
  const doc = deps.document === undefined ? (g.document ?? null) : deps.document;

  let wanted = true;
  let sentinel: SentinelLike | null = null;
  let pending = false;

  const onReleased = () => {
    // the system took it back (tab hidden, battery saver): forget it, re-acquire when visible
    sentinel = null;
  };

  const acquire = async (): Promise<void> => {
    if (!wanted || sentinel || pending) return;
    pending = true;
    try {
      // property access itself can throw (e.g. a sandboxed iframe), so it lives inside the try
      const api = nav?.wakeLock;
      if (!api || typeof api.request !== "function") return;
      if (doc && doc.visibilityState !== "visible") return; // would be refused anyway
      const s = await api.request("screen");
      if (!wanted) {
        await s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener("release", onReleased);
    } catch {
      /* not allowed right now: we try again on the next visibilitychange */
    } finally {
      pending = false;
    }
  };

  const onVisibility = () => {
    if (doc && doc.visibilityState === "visible") void acquire();
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  void acquire();

  return {
    get active(): boolean {
      return sentinel !== null && sentinel.released !== true;
    },
    async release(): Promise<void> {
      wanted = false;
      doc?.removeEventListener("visibilitychange", onVisibility);
      const s = sentinel;
      sentinel = null;
      if (s) {
        s.removeEventListener("release", onReleased);
        try {
          await s.release();
        } catch {
          /* already released */
        }
      }
    },
  };
}
