import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ServerMessage } from "@synapse/shared";
import type { SttBackend } from "../src/wispr/local-stt";
import { wav16k } from "../src/wispr/sarvam";
import { makeApp, type TestApp } from "./app-helper";
import { startFakeSarvam, type FakeSarvam } from "./fake-sarvam";

/**
 * POST /api/capture's engine: one capture (typed text, or a WAV transcribed by Sarvam) goes through the real pipeline and comes
 * back with the cards it made. The demo ramble is the acceptance check: one block in, separate bug, email and reminder thoughts
 * out, the aside dropped.
 */

const RAMBLE =
  "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?";
const SARVAM_KEY = "sk_test_sarvam_key_not_real";

let sarvam: FakeSarvam;
beforeAll(async () => {
  sarvam = await startFakeSarvam({ key: SARVAM_KEY });
});
afterAll(async () => {
  await sarvam.close();
});

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const speech = (seconds = 2): Uint8Array => wav16k(Float32Array.from({ length: 16000 * seconds }, (_, i) => Math.sin(i / 7) * 0.3));

describe("capture service", () => {
  it("one block with a bug, an email, a reminder and an aside becomes three thoughts; the aside is dropped", async () => {
    app = await makeApp();
    const asidesBefore = app.ctx.asides.count;
    const res = await app.ctx.capture.capture({ text: RAMBLE, context: { source: "web" } });
    expect(res.transcript).toBe(RAMBLE);
    expect(res.pending).toBeUndefined();
    const made = res.thoughtIds.map((id) => app!.ctx.store.getThought(id)!);
    expect(made.map((t) => t.category)).toEqual(["bug", "communication", "scheduling"]);
    expect(made.map((t) => (t.artifactId ? app!.ctx.store.artifacts.get(t.artifactId)?.kind : null)).slice(0, 2)).toEqual(["github_issue", "email_draft"]);
    expect(app.ctx.asides.count).toBe(asidesBefore + 1);
    expect(made.every((t) => t.status === "final")).toBe(true);
    // the capture is announced to every device
    const done = app.sent.filter((m): m is Extract<ServerMessage, { type: "capture.done" }> => m.type === "capture.done");
    expect(done).toHaveLength(1);
    expect(done[0]?.capture).toMatchObject({ captureId: res.captureId, source: "web", thoughtIds: res.thoughtIds });
  });

  it("the same clientId is processed once, even when the retries race each other", async () => {
    app = await makeApp();
    const req = { text: "Remind me to water the plants tonight at 9.", clientId: "clip-0001-abcdef", context: { source: "android" as const } };
    const [a, b] = await Promise.all([app.ctx.capture.capture(req), app.ctx.capture.capture(req)]);
    const c = await app.ctx.capture.capture(req);
    expect(b.captureId).toBe(a.captureId);
    expect(c).toMatchObject({ captureId: a.captureId, thoughtIds: a.thoughtIds, transcript: req.text, duplicate: true });
    expect(app.ctx.capture.list().filter((x) => x.clientId === req.clientId)).toHaveLength(1);
    expect(app.ctx.store.frags.size).toBe(1);
  });

  it("a retry after the thought was forgotten returns the capture without the forgotten text", async () => {
    app = await makeApp();
    const req = { text: "Email Dev that the staging keys rotate on Monday.", clientId: "clip-forget-0001" };
    const first = await app.ctx.capture.capture(req);
    app.ctx.privacy.deleteThoughts(first.thoughtIds);
    const again = await app.ctx.capture.capture(req);
    expect(again).toMatchObject({ captureId: first.captureId, duplicate: true, transcript: "", thoughtIds: [] });
  });

  it("audio goes to Sarvam as 16 kHz WAV, the ledger records the call by length only, and the transcript runs the pipeline", async () => {
    sarvam.reset({ kind: "ok", transcript: "Remind me to call the landlord tomorrow at 6.", language_code: "en-IN" });
    app = await makeApp({ SARVAM_API_KEY: SARVAM_KEY, SARVAM_BASE_URL: sarvam.url });
    const res = await app.ctx.capture.capture({ audio: speech(2), context: { source: "android" } });
    expect(res.transcript).toBe("Remind me to call the landlord tomorrow at 6.");
    expect(res.thoughtIds).toHaveLength(1);
    expect(sarvam.requests.at(-1)?.wav).toMatchObject({ rate: 16000, channels: 1, samples: 32000 });
    const ledger = app.ctx.audit.list(50).filter((r) => r.event === "sent_to_stt");
    expect(ledger.at(-1)).toMatchObject({ ref: "sarvam:saaras:v4", count: 2000 });
    const frag = app.ctx.store.frags.values().next().value!;
    expect(frag.transport).toBe("cloud_stt");
    expect(app.ctx.store.getThought(res.thoughtIds[0]!)?.deviceKind).toBe("pocket");
  });

  it("a speech-to-text failure is a retryable 503 (never 502: Cloudflare would replace it with its own page)", async () => {
    sarvam.reset({ kind: "status", status: 500, code: "internal_server_error" });
    app = await makeApp({ SARVAM_API_KEY: SARVAM_KEY, SARVAM_BASE_URL: sarvam.url });
    await expect(app.ctx.capture.capture({ audio: speech(1) })).rejects.toMatchObject({ status: 503 });
    expect(app.ctx.store.frags.size).toBe(0);
  });

  it("local-only mode never sends audio to Sarvam: the on-device engine transcribes it", async () => {
    const whisper: SttBackend = { transcribe: async () => "note to self buy more coffee filters" };
    app = await makeApp({ SARVAM_API_KEY: SARVAM_KEY, SARVAM_BASE_URL: sarvam.url }, undefined, undefined, undefined, { sttBackend: whisper });
    app.ctx.privacy.setLocalOnly(true);
    const before = sarvam.requests.length;
    const res = await app.ctx.capture.capture({ audio: speech(2) });
    expect(sarvam.requests.length).toBe(before);
    expect(res.transcript).toMatch(/coffee filters/i);
    expect(app.ctx.store.frags.values().next().value?.transport).toBe("local_stt");
  });

  it("while memory is paused a capture is discarded unheard (no speech-to-text call, nothing stored)", async () => {
    app = await makeApp({ SARVAM_API_KEY: SARVAM_KEY, SARVAM_BASE_URL: sarvam.url });
    await app.ctx.privacy.pause("test", "tap");
    const before = sarvam.requests.length;
    const res = await app.ctx.capture.capture({ audio: speech(1) });
    expect(res).toMatchObject({ paused: true, thoughtIds: [], transcript: "" });
    expect(sarvam.requests.length).toBe(before);
    expect(app.ctx.store.frags.size).toBe(0);
  });

  it("a spoken control intent still works when it arrives as a capture", async () => {
    app = await makeApp();
    const res = await app.ctx.capture.capture({ text: "Pause memory." });
    expect(app.ctx.privacy.isPaused()).toBe(true);
    expect(res.thoughtIds).toEqual([]);
  });

  it("keeps the capture's context for routing, and a correction in a later capture revises the earlier card", async () => {
    app = await makeApp();
    const first = await app.ctx.capture.capture({ text: "The checkout page throws a null pointer on empty carts.", context: { source: "mac", repo: "acme/shop", app: "Code" } });
    expect(app.ctx.capture.contextFor(first.thoughtIds[0]!)).toMatchObject({ source: "mac", repo: "acme/shop" });
    expect(app.ctx.capture.contextFor("nope")).toBeUndefined();

    const r = await app.ctx.capture.capture({ text: "Schedule the design review on Thursday at 3pm.", context: { source: "android" } });
    const fix = await app.ctx.capture.capture({ text: "Actually make it Friday.", context: { source: "android" } });
    expect(fix.thoughtIds).toEqual(r.thoughtIds); // the correction joined the card it corrects
    const art = app.ctx.store.artifacts.get(app.ctx.store.getThought(r.thoughtIds[0]!)!.artifactId!)!;
    expect(JSON.stringify(art.payload)).toMatch(/Fri/);
  });

  it("rejects an empty capture and an unreadable WAV", async () => {
    app = await makeApp();
    await expect(app.ctx.capture.capture({ text: "   " })).rejects.toThrow(/nothing to capture/);
    await expect(app.ctx.capture.capture({ audio: new TextEncoder().encode("not audio") })).rejects.toThrow(/WAV/);
  });
});
