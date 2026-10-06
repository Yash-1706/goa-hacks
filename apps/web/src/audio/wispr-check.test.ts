/* ============================================================================
 * The `pnpm wispr:check` library against scripts/fake-wispr.mjs (real sockets, real HTTP): the checklist is only worth
 * trusting if it reports PASS when the wire is right and a useful FAIL when it is not.
 * ========================================================================== */
import { afterEach, describe, expect, it } from "vitest";
import { startFakeWispr, type FakeWisprServer } from "../../scripts/fake-wispr.mjs";
import { renderReport, runWisprCheck, similarity, toFrames } from "../../scripts/wispr-check-lib";
import { readWavPcm16k } from "../../scripts/wispr-check";
import type { WisprTokenInfo } from "./types";

let server: FakeWisprServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const tokenFor = (s: FakeWisprServer): WisprTokenInfo => ({ mode: "client", token: "fake.jwt.token", expiresAt: Date.now() + 900_000, wsUrl: s.wsUrl, restUrl: s.restUrl });

/** ~1.3 s of a voice-like signal */
function speechLike(): Int16Array {
  const out = new Int16Array(20_480);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(7000 * Math.sin((2 * Math.PI * 180 * i) / 16000) * (0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / 16000)));
  return out;
}

const verdictOf = (r: Awaited<ReturnType<typeof runWisprCheck>>, id: string): string | undefined => r.items.find((i) => i.id === id)?.verdict;

describe("runWisprCheck against the fake Wispr", () => {
  it("PASSes a healthy service: auth acknowledged, raw PCM accepted, one final, latency reported", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, finalDelayMs: 120, texts: ["Hello Synapse remind me to email the team"] });
    const r = await runWisprCheck({ getToken: async () => tokenFor(server!), pcm: speechLike(), expect: "Hello Synapse remind me to email the team", pace: 0, finalTimeoutMs: 3000 });
    expect(r.ok).toBe(true);
    expect(r.transcript?.transport).toBe("wispr_ws");
    expect(r.transcript?.text).toContain("Hello Synapse");
    expect(verdictOf(r, "token")).toBe("pass");
    expect(verdictOf(r, "A1+A5")).toBe("pass");
    expect(verdictOf(r, "A3")).toBe("pass");
    expect(verdictOf(r, "A6")).toBe("pass");
    expect(verdictOf(r, "heard")).toBe("pass");
    const latency = r.items.find((i) => i.id === "A4")!;
    expect(latency.verdict).toBe("info");
    expect(latency.detail).toMatch(/\d+ ms over the WebSocket/);
    expect(server.stats.violations).toEqual([]); // the strict fake saw nothing wrong on the wire
    expect(verdictOf(r, "A7")).toBe("unknown"); // CORS cannot be judged from Node, and the report says so
    expect(renderReport(r)).toMatch(/RESULT: no failures/);
  });

  it("FAILs with an actionable hint when Wispr rejects the packets", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, failMode: "error" });
    const r = await runWisprCheck({ getToken: async () => tokenFor(server!), pcm: speechLike(), pace: 0, finalTimeoutMs: 600 });
    expect(r.ok).toBe(false);
    const a3 = r.items.find((i) => i.id === "A3")!;
    expect(a3.verdict).toBe("fail");
    expect(a3.detail).toMatch(/--packets wav/);
    expect(a3.detail).toMatch(/WebSocket path FAILED/);
    expect(a3.detail).toMatch(/WISPR_PACKET_FORMAT=wav/);
    expect(renderReport(r)).toMatch(/RESULT: 1 failure/);
  });

  it("tests the REST fallback on its own", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, texts: ["Rest path works"] });
    const r = await runWisprCheck({ getToken: async () => tokenFor(server!), pcm: speechLike(), forceRest: true, pace: 0, finalTimeoutMs: 400 });
    expect(r.transcript?.transport).toBe("wispr_rest");
    expect(r.transcript?.text).toContain("Rest path works");
    expect(verdictOf(r, "REST")).toBe("pass");
    expect(verdictOf(r, "A7")).toBe("unknown"); // browser CORS still cannot be judged from Node
    expect(r.ok).toBe(true);
  });

  it("refuses to run against a server that is in mock mode, and says what to set", async () => {
    const r = await runWisprCheck({ getToken: async () => ({ mode: "mock" }), pcm: speechLike(), pace: 0 });
    expect(r.ok).toBe(false);
    const run = r.items.find((i) => i.id === "run")!;
    expect(run.detail).toMatch(/WISPR_MODE=client and WISPR_API_KEY/);
  });

  it("reports an authenticated socket that survives an idle period (A2) and silence handling (A6b)", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, texts: ["x"] });
    const r = await runWisprCheck({ getToken: async () => tokenFor(server!), pcm: speechLike(), pace: 0, idleSecs: 1, silence: true, finalTimeoutMs: 1500 });
    expect(verdictOf(r, "A2")).toBe("pass");
    expect(r.items.some((i) => i.id === "A6b")).toBe(true);
  });
});

describe("helpers", () => {
  it("toFrames pads the last frame and never shares buffers (the streamer takes ownership of each)", () => {
    const f = toFrames(new Int16Array(1100).fill(1000));
    expect(f).toHaveLength(3);
    expect(f.every((x) => x.pcm.length === 512)).toBe(true);
    expect(f[2]!.pcm[1099 - 1024]).toBe(1000);
    expect(f[2]!.pcm[100]).toBe(0);
    expect(f[0]!.pcm.buffer).not.toBe(f[1]!.pcm.buffer);
    expect(f[0]!.rms).toBeGreaterThan(0.02);
  });

  it("similarity ignores case and punctuation", () => {
    expect(similarity("Hello, Synapse!", "hello synapse")).toBe(1);
    expect(similarity("email the team", "call the dentist")).toBeCloseTo(1 / 3, 2);
    expect(similarity("", "x")).toBe(0);
  });

  it("readWavPcm16k converts stereo 8 kHz to 16 kHz mono", () => {
    const frames = 800; // 0.1 s at 8 kHz
    const data = Buffer.alloc(frames * 2 * 2);
    for (let i = 0; i < frames; i++) {
      data.writeInt16LE(1000, i * 4);
      data.writeInt16LE(3000, i * 4 + 2);
    }
    const hdr = Buffer.alloc(44);
    hdr.write("RIFF", 0, "latin1");
    hdr.writeUInt32LE(36 + data.length, 4);
    hdr.write("WAVEfmt ", 8, "latin1");
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(2, 22); // stereo
    hdr.writeUInt32LE(8000, 24);
    hdr.writeUInt32LE(8000 * 4, 28);
    hdr.writeUInt16LE(4, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write("data", 36, "latin1");
    hdr.writeUInt32LE(data.length, 40);
    const pcm = readWavPcm16k(Buffer.concat([hdr, data]));
    expect(pcm.length).toBe(1600); // 0.1 s at 16 kHz
    expect(pcm[10]).toBe(2000); // (1000 + 3000) / 2
    expect(() => readWavPcm16k(Buffer.from("not a wav"))).toThrow(/not a WAV/);
  });
});
