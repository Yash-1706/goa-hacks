import { describe, expect, it } from "vitest";
import type { CaptureResponse } from "@synapse/shared";
import { CaptureQueue, createAesGcmCipher, memoryClipStore, type QueueItem, type UploadOutcome, type UploadRequest } from "./queue";

/**
 * The phone's offline queue: a recording is sealed (AES-GCM, non-extractable key) into IndexedDB the moment it stops, uploaded
 * when there is network, retried with backoff on a transient failure, and deleted from the phone once the server has it.
 * Every clip carries a clientId, so a retry after a lost response is processed once by the server.
 */

const ok = (clientId: string): UploadOutcome => ({ kind: "ok", result: { captureId: `cap-${clientId}`, transcript: "t", thoughtIds: ["a", "b"] } satisfies CaptureResponse });

function rig(o: { online?: boolean; outcomes?: UploadOutcome[] } = {}) {
  const store = memoryClipStore();
  const keys: { k?: CryptoKey } = {};
  const cipher = createAesGcmCipher({ get: async () => keys.k, set: async (k) => void (keys.k = k) });
  const net = { online: o.online ?? true };
  const clock = { t: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
  const uploads: UploadRequest[] = [];
  const outcomes = [...(o.outcomes ?? [])];
  let views: QueueItem[] = [];
  let authNeeded = 0;
  const queue = new CaptureQueue({
    store,
    cipher,
    online: () => net.online,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { at: clock.t + ms, fn, dead: false };
      timers.push(t);
      return () => void (t.dead = true);
    },
    upload: async (req) => {
      uploads.push({ ...req, ...(req.audio ? { audio: req.audio.slice() } : {}) });
      return outcomes.shift() ?? ok(req.clientId);
    },
    onChange: (items) => void (views = items),
    onAuthNeeded: () => void authNeeded++,
  });
  const tick = async (ms: number) => {
    clock.t += ms;
    for (const t of timers.filter((x) => !x.dead && x.at <= clock.t)) {
      t.dead = true;
      t.fn();
    }
    await queue.idle();
  };
  return { queue, store, cipher, net, uploads, tick, views: () => views, authNeeded: () => authNeeded, clock };
}

const clip = (n = 64) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);

describe("capture queue", () => {
  it("offline: the clip waits sealed on the phone; back online it uploads exactly once and leaves the phone", async () => {
    const r = rig({ online: false });
    const audio = clip();
    const plain = audio.slice();
    const id = await r.queue.add({ audio, capturedAt: 999 });
    await r.queue.idle();
    expect(r.uploads).toHaveLength(0);
    expect(r.views()).toMatchObject([{ clientId: id, status: "waiting", kind: "audio" }]);
    expect(audio.every((b) => b === 0)).toBe(true); // the caller's buffer is wiped once sealed
    const stored = (await r.store.all())[0]!;
    expect(stored.data.length).toBeGreaterThan(plain.length); // ciphertext + GCM tag, never the WAV itself
    expect(Buffer.from(stored.data).includes(Buffer.from(plain.slice(0, 16)))).toBe(false);

    r.net.online = true;
    await Promise.all([r.queue.flush(), r.queue.flush(), r.queue.flush()]); // an online event, app open and a timer at once
    await r.queue.idle();
    expect(r.uploads).toHaveLength(1);
    expect(r.uploads[0]).toMatchObject({ clientId: id, capturedAt: 999 });
    expect(Array.from(r.uploads[0]!.audio!)).toEqual(Array.from(plain));
    expect(r.views()[0]).toMatchObject({ status: "sent", result: { thoughtIds: ["a", "b"] } });
    expect(await r.store.all()).toHaveLength(0);
  });

  it("a transient failure retries with backoff; the same clientId goes up again", async () => {
    const r = rig({ outcomes: [{ kind: "retry", error: "HTTP 503" }, { kind: "retry", error: "network" }] });
    const id = await r.queue.add({ audio: clip() });
    await r.queue.idle();
    expect(r.views()[0]).toMatchObject({ status: "waiting", attempts: 1, error: "HTTP 503" });
    await r.tick(1000);
    expect(r.uploads).toHaveLength(1); // not before its backoff
    await r.tick(1500);
    expect(r.uploads).toHaveLength(2);
    await r.tick(5000);
    expect(r.uploads.map((u) => u.clientId)).toEqual([id, id, id]);
    expect(r.views()[0]?.status).toBe("sent");
  });

  it("a request the server rejects (400) is not retried and leaves the phone", async () => {
    const r = rig({ outcomes: [{ kind: "reject", error: "unsupported WAV encoding" }] });
    await r.queue.add({ audio: clip() });
    await r.queue.idle();
    await r.tick(120_000);
    expect(r.uploads).toHaveLength(1);
    expect(r.views()[0]).toMatchObject({ status: "failed", error: "unsupported WAV encoding" });
    expect(await r.store.all()).toHaveLength(0);
  });

  it("a signed-out upload keeps the clip and asks for the passcode; signing in sends it", async () => {
    const r = rig({ outcomes: [{ kind: "auth" }] });
    await r.queue.add({ audio: clip() });
    await r.queue.idle();
    expect(r.authNeeded()).toBe(1);
    expect(r.views()[0]?.status).toBe("waiting");
    expect(await r.store.all()).toHaveLength(1);
    await r.queue.flush(); // after the login
    await r.queue.idle();
    expect(r.views()[0]?.status).toBe("sent");
  });

  it("reopening the app restores the waiting clips and sends them, oldest first", async () => {
    const r = rig({ online: false });
    const a = await r.queue.add({ audio: clip(), capturedAt: 10 });
    const b = await r.queue.add({ text: "Remind me to call the bank", capturedAt: 5 });
    await r.queue.idle();
    const reopened = new CaptureQueue({
      store: r.store,
      cipher: r.cipher,
      online: () => true,
      now: () => r.clock.t,
      setTimer: () => () => undefined,
      upload: async (req) => {
        r.uploads.push(req);
        return ok(req.clientId);
      },
      onChange: () => undefined,
    });
    await reopened.init();
    await reopened.idle();
    expect(r.uploads.map((u) => u.clientId)).toEqual([b, a]);
    expect(r.uploads[0]?.text).toBe("Remind me to call the bank");
    expect(await r.store.all()).toHaveLength(0);
  });

  it("a discarded clip is gone from the phone and never uploads", async () => {
    const r = rig({ online: false });
    const id = await r.queue.add({ audio: clip() });
    await r.queue.discard(id);
    r.net.online = true;
    await r.queue.flush();
    await r.queue.idle();
    expect(r.uploads).toHaveLength(0);
    expect(r.views()).toHaveLength(0);
  });
});

describe("capture queue: a clip that cannot be opened (review 7)", () => {
  it("is marked failed and removed; the clips behind it still go up", async () => {
    const store = memoryClipStore();
    const uploads: string[] = [];
    let views: QueueItem[] = [];
    const real = createAesGcmCipher((() => {
      const k: { k?: CryptoKey } = {};
      return { get: async () => k.k, set: async (x: CryptoKey) => void (k.k = x) };
    })());
    let broken = true;
    const cipher = { seal: real.seal, open: async (iv: Uint8Array, data: Uint8Array) => (broken ? ((broken = false), Promise.reject(new Error("OperationError"))) : real.open(iv, data)) };
    const net = { on: false };
    const q = new CaptureQueue({
      store,
      cipher,
      online: () => net.on,
      now: () => 1000,
      setTimer: () => () => undefined,
      upload: async (r) => (uploads.push(r.clientId), ok(r.clientId)),
      onChange: (items) => void (views = items),
    });
    const first = await q.add({ audio: clip(), capturedAt: 1 });
    const second = await q.add({ audio: clip(), capturedAt: 2 });
    net.on = true;
    await q.flush();
    await q.idle();
    expect(views.find((v) => v.clientId === first)).toMatchObject({ status: "failed" });
    expect(uploads).toEqual([second]);
    expect(await store.all()).toHaveLength(0);
  });
});
