import type { CaptureView } from "@synapse/shared";
import { useAuth } from "@/state/auth";
import { useCaptures } from "@/state/captures";
import { CaptureQueue, createAesGcmCipher, indexedDbBackend, memoryClipStore } from "./queue";
import { captureSource, uploadCapture } from "./upload";

/* ============================================================================
 * The capture queue singleton: one per page, restored and flushed on app open, flushed again on `online` and after a
 * sign-in. Falls back to an in-memory store where IndexedDB is unavailable (a private window): clips then survive only
 * while the page is open.
 * ========================================================================== */

let queue: CaptureQueue | null = null;

function backend() {
  try {
    if (typeof indexedDB !== "undefined") return indexedDbBackend();
  } catch {
    /* blocked storage */
  }
  const keys: { k?: CryptoKey } = {};
  return { store: memoryClipStore(), keys: { get: async () => keys.k, set: async (k: CryptoKey) => void (keys.k = k) } };
}

export function captureQueue(): CaptureQueue {
  if (queue) return queue;
  const { store, keys } = backend();
  const source = captureSource(navigator.userAgent);
  queue = new CaptureQueue({
    store,
    cipher: createAesGcmCipher(keys),
    upload: (req) => uploadCapture(req, { source }),
    online: () => navigator.onLine,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    onChange: (items) => useCaptures.getState().setQueue(items),
    onAuthNeeded: () => useAuth.getState().require(),
  });
  void queue.init();
  window.addEventListener("online", () => void queue?.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void queue?.flush();
  });
  return queue;
}

/** The server's recent captures (all devices), for "Your last captures". */
export async function loadRecentCaptures(): Promise<void> {
  try {
    const r = await fetch("/api/captures?limit=20", { credentials: "same-origin" });
    if (r.ok) useCaptures.getState().hydrate((await r.json()) as CaptureView[]);
  } catch {
    /* offline: the local queue still shows what this phone recorded */
  }
}
