import type { CaptureResponse } from "@synapse/shared";

/* ============================================================================
 * The phone's offline capture queue (V1 phase 2).
 *
 * A clip is sealed with AES-GCM under a NON-EXTRACTABLE WebCrypto key the moment recording stops, kept in IndexedDB only
 * while it waits for the network, and deleted as soon as the server acknowledges it. This is the one place audio touches the
 * phone's storage, and only as ciphertext (the non-negotiable is "audio is never written to disk": a clip that cannot be
 * uploaded yet is the exception the offline queue needs, so it is never stored in the clear and never kept once sent).
 *
 * Every clip carries a clientId: the server processes a clientId once, so a retry after a lost response is harmless.
 * Upload when online; on a transient failure retry with backoff; flush on the `online` event and on app open.
 * ========================================================================== */

export type ClipStatus = "waiting" | "sending" | "sent" | "failed";

export interface StoredClip {
  clientId: string;
  capturedAt: number;
  kind: "audio" | "text";
  iv: Uint8Array;
  data: Uint8Array;
  attempts: number;
  nextAt: number;
  error?: string;
}

export interface ClipStore {
  all(): Promise<StoredClip[]>;
  put(c: StoredClip): Promise<void>;
  delete(clientId: string): Promise<void>;
}

export interface Cipher {
  seal(plain: Uint8Array): Promise<{ iv: Uint8Array; data: Uint8Array }>;
  open(iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}

export interface UploadRequest {
  clientId: string;
  capturedAt: number;
  audio?: Uint8Array;
  text?: string;
}

export type UploadOutcome = { kind: "ok"; result: CaptureResponse } | { kind: "retry"; error: string } | { kind: "auth" } | { kind: "reject"; error: string };

export interface QueueItem {
  clientId: string;
  capturedAt: number;
  kind: "audio" | "text";
  status: ClipStatus;
  attempts: number;
  error?: string;
  result?: CaptureResponse;
}

export interface QueueDeps {
  store: ClipStore;
  cipher: Cipher;
  upload: (req: UploadRequest) => Promise<UploadOutcome>;
  online: () => boolean;
  now: () => number;
  /** returns a cancel function */
  setTimer: (fn: () => void, ms: number) => () => void;
  onChange: (items: QueueItem[]) => void;
  /** the server answered 401: show the passcode screen, then call flush() */
  onAuthNeeded?: () => void;
}

const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000];
const KEEP_SENT = 20;

export function newClientId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return `clip-${Date.now().toString(36)}-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export class CaptureQueue {
  private items = new Map<string, QueueItem>();
  private flushing: Promise<void> | null = null;
  private again = false;
  private cancelTimer: (() => void) | null = null;

  constructor(private d: QueueDeps) {}

  /** App open: restore what was waiting (oldest first) and try to send it. */
  async init(): Promise<void> {
    for (const c of await this.d.store.all()) this.items.set(c.clientId, { clientId: c.clientId, capturedAt: c.capturedAt, kind: c.kind, status: "waiting", attempts: c.attempts, ...(c.error ? { error: c.error } : {}) });
    this.changed();
    await this.flush();
  }

  /** Seal and store a clip (the caller's audio buffer is zero-filled), then try to send it. */
  async add(input: { audio?: Uint8Array; text?: string; capturedAt?: number }): Promise<string> {
    const clientId = newClientId();
    const kind = input.audio ? "audio" : "text";
    const plain = input.audio ?? new TextEncoder().encode(input.text ?? "");
    const capturedAt = input.capturedAt ?? this.d.now();
    const { iv, data } = await this.d.cipher.seal(plain);
    plain.fill(0);
    await this.d.store.put({ clientId, capturedAt, kind, iv, data, attempts: 0, nextAt: 0 });
    this.items.set(clientId, { clientId, capturedAt, kind, status: "waiting", attempts: 0 });
    this.changed();
    void this.flush();
    return clientId;
  }

  async discard(clientId: string): Promise<void> {
    await this.d.store.delete(clientId);
    this.items.delete(clientId);
    this.changed();
  }

  list(): QueueItem[] {
    return [...this.items.values()].sort((a, b) => b.capturedAt - a.capturedAt);
  }

  /** Send every clip that is due. Concurrent calls share one pass (a clip is never uploaded twice at once). */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Resolves when no flush is running (tests). */
  async idle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  private async pass(): Promise<void> {
    const due = (await this.d.store.all()).filter((c) => c.nextAt <= this.d.now()).sort((a, b) => a.capturedAt - b.capturedAt);
    for (const clip of due) {
      if (!this.d.online()) break;
      const item = this.items.get(clip.clientId) ?? { clientId: clip.clientId, capturedAt: clip.capturedAt, kind: clip.kind, status: "waiting" as const, attempts: clip.attempts };
      this.items.set(clip.clientId, { ...item, status: "sending" });
      this.changed();

      const plain = await this.d.cipher.open(clip.iv, clip.data);
      let outcome: UploadOutcome;
      try {
        outcome = await this.d.upload({ clientId: clip.clientId, capturedAt: clip.capturedAt, ...(clip.kind === "audio" ? { audio: plain } : { text: new TextDecoder().decode(plain) }) });
      } catch (err) {
        outcome = { kind: "retry", error: (err as Error).message || "network" };
      } finally {
        plain.fill(0);
      }

      if (outcome.kind === "ok") {
        await this.d.store.delete(clip.clientId);
        this.items.set(clip.clientId, { ...item, status: "sent", attempts: clip.attempts + 1, result: outcome.result });
      } else if (outcome.kind === "reject") {
        await this.d.store.delete(clip.clientId); // the server will never take it: keep the reason, not the audio
        this.items.set(clip.clientId, { ...item, status: "failed", attempts: clip.attempts + 1, error: outcome.error });
      } else if (outcome.kind === "auth") {
        this.items.set(clip.clientId, { ...item, status: "waiting" });
        this.changed();
        this.d.onAuthNeeded?.();
        return; // nothing else will get through until the passcode is entered
      } else {
        const attempts = clip.attempts + 1;
        const nextAt = this.d.now() + (BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] as number);
        await this.d.store.put({ ...clip, attempts, nextAt, error: outcome.error });
        this.items.set(clip.clientId, { ...item, status: "waiting", attempts, error: outcome.error });
      }
      this.changed();
    }
    this.pruneSent();
    await this.armTimer();
  }

  private async armTimer(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const next = (await this.d.store.all()).reduce((m, c) => Math.min(m, c.nextAt), Infinity);
    if (Number.isFinite(next)) this.cancelTimer = this.d.setTimer(() => void this.flush(), Math.max(250, next - this.d.now()));
  }

  private pruneSent(): void {
    const sent = [...this.items.values()].filter((i) => i.status === "sent" || i.status === "failed").sort((a, b) => b.capturedAt - a.capturedAt);
    for (const old of sent.slice(KEEP_SENT)) this.items.delete(old.clientId);
  }

  private changed(): void {
    this.d.onChange(this.list());
  }
}

// ---------------------------------------------------------------------------- storage + crypto

/** AES-GCM with a non-extractable key: script can use it, nothing can read it out (not even this app). */
export function createAesGcmCipher(keys: { get: () => Promise<CryptoKey | undefined>; set: (k: CryptoKey) => Promise<void> }): Cipher {
  let key: Promise<CryptoKey> | null = null;
  const getKey = (): Promise<CryptoKey> =>
    (key ??= (async () => {
      const existing = await keys.get();
      if (existing) return existing;
      const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await keys.set(k);
      return k;
    })());
  return {
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(), plain as Uint8Array<ArrayBuffer>));
      return { iv, data };
    },
    async open(iv, data) {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, await getKey(), data as Uint8Array<ArrayBuffer>));
    },
  };
}

export function memoryClipStore(): ClipStore {
  const m = new Map<string, StoredClip>();
  return {
    all: async () => [...m.values()].map((c) => ({ ...c })),
    put: async (c) => void m.set(c.clientId, { ...c }),
    delete: async (id) => void m.delete(id),
  };
}

const DB = "synapse-capture";
const CLIPS = "clips";
const KEYS = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CLIPS, { keyPath: "clientId" });
      req.result.createObjectStore(KEYS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: Promise<IDBDatabase>, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db.then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** IndexedDB: sealed clips while they wait, and the non-extractable key (stored as a CryptoKey object, never as bytes). */
export function indexedDbBackend(): { store: ClipStore; keys: { get: () => Promise<CryptoKey | undefined>; set: (k: CryptoKey) => Promise<void> } } {
  const db = openDb();
  return {
    store: {
      all: () => tx<StoredClip[]>(db, CLIPS, "readonly", (s) => s.getAll()),
      put: (c) => tx<void>(db, CLIPS, "readwrite", (s) => s.put(c)),
      delete: (id) => tx<void>(db, CLIPS, "readwrite", (s) => s.delete(id)),
    },
    keys: {
      get: () => tx<CryptoKey | undefined>(db, KEYS, "readonly", (s) => s.get("clip-key")),
      set: (k) => tx<void>(db, KEYS, "readwrite", (s) => s.put(k, "clip-key")),
    },
  };
}
