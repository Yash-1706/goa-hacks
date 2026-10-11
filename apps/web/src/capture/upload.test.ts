import { describe, expect, it } from "vitest";
import { captureSource, uploadCapture } from "./upload";

/** POST /api/capture from the phone: what each answer means for the queue. */

const respond = (status: number, body: unknown, type = "application/json"): typeof fetch =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } })) as typeof fetch;

describe("uploadCapture", () => {
  it("sends the clip as multipart with its clientId, capturedAt and context", async () => {
    let seen: FormData | undefined;
    let url = "";
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      seen = init.body as FormData;
      return Response.json({ captureId: "cap-1", transcript: "hi", thoughtIds: ["t1"] });
    }) as typeof fetch;
    const out = await uploadCapture({ clientId: "clip-1", capturedAt: 42, audio: new Uint8Array([1, 2, 3]) }, { fetch: f, source: "android" });
    expect(out).toEqual({ kind: "ok", result: { captureId: "cap-1", transcript: "hi", thoughtIds: ["t1"] } });
    expect(url).toBe("/api/capture");
    expect(seen?.get("clientId")).toBe("clip-1");
    expect(seen?.get("capturedAt")).toBe("42");
    expect(JSON.parse(String(seen?.get("context")))).toEqual({ source: "android" });
    expect((seen?.get("audio") as File).type).toBe("audio/wav");
    expect((seen?.get("audio") as File).size).toBe(3);
  });

  it("text goes as a text field", async () => {
    let seen: FormData | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      seen = init.body as FormData;
      return Response.json({ captureId: "c", transcript: "x", thoughtIds: [] });
    }) as typeof fetch;
    await uploadCapture({ clientId: "clip-2", capturedAt: 1, text: "note to self" }, { fetch: f, source: "web" });
    expect(seen?.get("text")).toBe("note to self");
    expect(seen?.get("audio")).toBeNull();
  });

  it("maps answers: 401 signs in, 400/413 are final, 503/530/429 and network errors retry", async () => {
    const req = { clientId: "c", capturedAt: 1, audio: new Uint8Array(4) };
    expect(await uploadCapture(req, { fetch: respond(401, { error: "sign in with the passcode" }), source: "web" })).toEqual({ kind: "auth" });
    expect(await uploadCapture(req, { fetch: respond(400, { error: "unsupported WAV encoding" }), source: "web" })).toEqual({ kind: "reject", error: "unsupported WAV encoding" });
    expect(await uploadCapture(req, { fetch: respond(413, { error: "audio too large" }), source: "web" })).toMatchObject({ kind: "reject" });
    expect(await uploadCapture(req, { fetch: respond(503, { error: "speech to text failed (sarvam)" }), source: "web" })).toEqual({ kind: "retry", error: "speech to text failed (sarvam)" });
    expect(await uploadCapture(req, { fetch: respond(530, "<html>cloudflare</html>", "text/html"), source: "web" })).toEqual({ kind: "retry", error: "HTTP 530" });
    expect(await uploadCapture(req, { fetch: respond(429, {}), source: "web" })).toMatchObject({ kind: "retry" });
    expect(await uploadCapture(req, { fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch, source: "web" })).toEqual({ kind: "retry", error: "network" });
  });

  it("names the source from the device", () => {
    expect(captureSource("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/131 Mobile")).toBe("android");
    expect(captureSource("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(captureSource("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("web");
  });
});
