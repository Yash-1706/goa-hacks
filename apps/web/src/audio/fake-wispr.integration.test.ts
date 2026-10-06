/* ============================================================================
 * Integration: the real WisprStreamer / MicEngine over REAL WebSockets and HTTP against scripts/fake-wispr.mjs.
 * Node's global WebSocket + fetch are the same APIs the browser uses, so this exercises the actual wire framing, the
 * handshake and close semantics that the fake-socket unit tests cannot.
 * ========================================================================== */
import { afterEach, describe, expect, it } from "vitest";
import { CANNED_TEXTS, startFakeWispr, type FakeWisprServer } from "../../scripts/fake-wispr.mjs";
import { realClock } from "./clock";
import { createMicEngineFactory } from "./engine";
import { FakeAudioContext, FakeStream } from "./test-utils";
import { ScriptedVad, frameWithRms } from "./test-vad";
import type { AudioEngineOptions, AudioState, WisprContext, WisprTokenInfo } from "./types";
import { WisprStreamer, type WisprTranscript } from "./wispr";
import type { FragmentFinal } from "@synapse/shared";
import { FragmentFinalSchema } from "@synapse/shared";

let server: FakeWisprServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function waitFor(cond: () => boolean, ms = 4000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ctx: WisprContext = {
  dictionary: ["OAuth2", "cart-service", "Sarah"],
  conversation: [{ role: "user", content: "earlier fragment" }],
  language: ["en"],
  userFirstName: "Rio",
};

const tokenFor = (s: FakeWisprServer): WisprTokenInfo => ({
  mode: "client",
  token: "fake.jwt.token",
  expiresAt: Date.now() + 900_000,
  wsUrl: s.wsUrl,
  restUrl: s.restUrl,
});

function streamerFor(s: FakeWisprServer, over: Partial<ConstructorParameters<typeof WisprStreamer>[0]> = {}) {
  return new WisprStreamer({
    deviceId: "dev-int",
    sessionId: "sess-int",
    getToken: async () => tokenFor(s),
    getContext: () => ctx,
    clock: realClock,
    ...over,
  });
}

const frame = (v: number): Int16Array => new Int16Array(512).fill(v);

/** stream `n` packets (16 pre-roll + the rest) through one claimed utterance and commit */
function runUtterance(streamer: WisprStreamer, n: number, handlers: { onTranscript(t: WisprTranscript): void; onFailed(r: string): void }) {
  const u = streamer.claim({ fragmentId: "frag-int", packetsPerAppend: 4, ...handlers });
  const pre = Math.min(16, n);
  u.pushPreroll(Array.from({ length: pre }, (_, i) => ({ pcm: frame(i + 1), rms: 0.02 })));
  for (let i = pre; i < n; i++) u.push(frame(i + 1), 0.05);
  u.commit();
  return u;
}

describe("WisprStreamer against the fake Wispr server (real sockets)", () => {
  it("auth handshake, standby reuse, cumulative appends, commit, final text: zero protocol violations", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, finalDelayMs: 30, partials: true });
    const streamer = streamerFor(server);
    streamer.start();
    await waitFor(() => streamer.standbyReady, 4000, "standby ready");
    expect(server.stats.auths).toBe(1); // authenticated BEFORE any speech
    expect(server.stats.lastAuth).toEqual({
      hasAccessToken: true,
      language: ["en"],
      dictionaryTerms: 3,
      conversationMessages: 1,
      appType: "ai",
    });

    const got: WisprTranscript[] = [];
    const failed: string[] = [];
    runUtterance(streamer, 44, { onTranscript: (t) => got.push(t), onFailed: (r) => failed.push(r) });
    await waitFor(() => got.length === 1, 4000, "final text");

    expect(failed).toEqual([]);
    expect(got[0]!.transport).toBe("wispr_ws");
    expect(got[0]!.text).toBe(CANNED_TEXTS[0]);
    expect(got[0]!.tFinal).toBeGreaterThanOrEqual(got[0]!.tCommitSent);
    expect(server.stats.violations).toEqual([]);
    expect(server.stats.commits).toBe(1);
    expect(server.stats.lastTotalPackets).toBe(44);
    expect(server.stats.packets).toBe(44);
    expect(server.stats.lastPacketDuration).toBe(0.032);
    expect([...server.stats.packetBytes]).toEqual([1024]); // raw int16 LE frames, no RIFF header
    // claiming opened the NEXT standby straight away
    await waitFor(() => server!.stats.auths === 2 && streamer.standbyReady, 4000, "next standby");
    streamer.stop();
    await waitFor(() => server!.stats.openConnections === 0, 4000, "sockets closed");
  });

  it("per-packet WAV format is accepted by the wire layer when selected (escape hatch)", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, finalDelayMs: 20 });
    const streamer = streamerFor(server, { packetFormat: "wav" });
    streamer.start();
    await waitFor(() => streamer.standbyReady);
    const got: WisprTranscript[] = [];
    runUtterance(streamer, 8, { onTranscript: (t) => got.push(t), onFailed: () => undefined });
    await waitFor(() => got.length === 1);
    expect([...server.stats.packetBytes]).toEqual([1068]);
    expect(server.stats.violations).toEqual([]);
    streamer.stop();
  });

  it("a large pre-roll + long utterance (multi-KB frames, extended WS length encodings) arrives intact", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, finalDelayMs: 20 });
    const streamer = streamerFor(server, { maxPacketsPerAppend: 32 });
    streamer.start();
    await waitFor(() => streamer.standbyReady);
    const got: WisprTranscript[] = [];
    const u = streamer.claim({ fragmentId: "long", packetsPerAppend: 4, onTranscript: (t) => got.push(t), onFailed: () => undefined });
    // a backlog of 200 packets queued before the flush: split into <= 32-packet appends (~44 KB frames)
    u.pushPreroll(Array.from({ length: 200 }, (_, i) => ({ pcm: frame(i), rms: 0.01 })));
    u.commit();
    await waitFor(() => got.length === 1);
    expect(server.stats.packets).toBe(200);
    expect(server.stats.violations).toEqual([]);
    streamer.stop();
  });

  it("abort (VAD misfire) closes the socket without a commit and the server sees none", async () => {
    server = await startFakeWispr({ port: 0, quiet: true });
    const streamer = streamerFor(server);
    streamer.start();
    await waitFor(() => streamer.standbyReady);
    const got: WisprTranscript[] = [];
    const u = streamer.claim({ fragmentId: "x", packetsPerAppend: 4, onTranscript: (t) => got.push(t), onFailed: () => undefined });
    u.pushPreroll(Array.from({ length: 6 }, (_, i) => ({ pcm: frame(i), rms: 0.01 })));
    await waitFor(() => server!.stats.packets === 6);
    u.abort("misfire");
    await waitFor(() => server!.stats.openConnections === 1, 4000, "only the next standby remains");
    expect(server.stats.commits).toBe(0);
    expect(got).toEqual([]);
    streamer.stop();
  });

  it("server error on commit -> REST fallback with a proper 44-byte-header WAV", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, failMode: "error", finalDelayMs: 10 });
    const streamer = streamerFor(server);
    streamer.start();
    await waitFor(() => streamer.standbyReady);
    const got: WisprTranscript[] = [];
    const failed: string[] = [];
    runUtterance(streamer, 12, { onTranscript: (t) => got.push(t), onFailed: (r) => failed.push(r) });
    await waitFor(() => got.length + failed.length === 1);
    expect(failed).toEqual([]);
    expect(got[0]!.transport).toBe("wispr_rest");
    expect(server.stats.restCalls).toBe(1);
    expect(server.stats.violations).toEqual([]); // the fake checked: RIFF header, 16 kHz, data length, null context fields
    streamer.stop();
  });

  it("socket dropped before the final -> REST fallback", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, failMode: "drop" });
    const streamer = streamerFor(server);
    streamer.start();
    await waitFor(() => streamer.standbyReady);
    const got: WisprTranscript[] = [];
    runUtterance(streamer, 10, { onTranscript: (t) => got.push(t), onFailed: () => undefined });
    await waitFor(() => got.length === 1);
    expect(got[0]!.transport).toBe("wispr_rest");
    expect(server.stats.violations).toEqual([]);
    streamer.stop();
  });

  it("no final within the timeout -> REST fallback; REST failing too -> onFailed", async () => {
    server = await startFakeWispr({ port: 0, quiet: true, failMode: "silent" });
    const streamer = streamerFor(server, { finalTimeoutMs: 200 });
    streamer.start();
    await waitFor(() => streamer.standbyReady);
    const got: WisprTranscript[] = [];
    const failed: string[] = [];
    runUtterance(streamer, 10, { onTranscript: (t) => got.push(t), onFailed: (r) => failed.push(r) });
    await waitFor(() => got.length === 1, 4000, "REST result after the timeout");
    expect(got[0]!.transport).toBe("wispr_rest");

    // now make REST fail as well
    server.setFailMode("rest-error");
    await waitFor(() => streamer.standbyReady, 4000, "standby");
    runUtterance(streamer, 10, { onTranscript: (t) => got.push(t), onFailed: (r) => failed.push(r) });
    await waitFor(() => failed.length === 1, 4000, "onFailed");
    expect(failed[0]).toMatch(/rest fallback failed/);
    expect(got).toHaveLength(1);
    streamer.stop();
  });

  it("the strict fake really does catch protocol violations (so 'no violations' above is meaningful)", async () => {
    server = await startFakeWispr({ port: 0, quiet: true });
    const ws = new WebSocket(`${server.wsUrl}?client_key=Bearer%20x`);
    const msgs: Array<Record<string, unknown>> = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)) as Record<string, unknown>);
    await waitFor(() => ws.readyState === 1);
    ws.send(
      JSON.stringify({
        type: "auth",
        access_token: "x",
        context: {
          app: { name: "Synapse", type: "ai" },
          dictionary_context: [],
          textbox_contents: { before_text: "", selected_text: "", after_text: "" },
          screenshot: "data:image/png;base64,AAAA", // forbidden
          content_text: null,
          content_html: null,
          conversation: { id: "s", participants: [], messages: [] },
        },
      }),
    );
    ws.send(JSON.stringify({ type: "append", position: 5, audio_packets: { packets: ["AAAA"], volumes: [0], packet_duration: 0.032, audio_encoding: "wav", byte_encoding: "base64" } }));
    ws.send(JSON.stringify({ type: "append", position: 1, audio_packets: { packets: ["AAAA"], volumes: [0], packet_duration: 0.05, audio_encoding: "wav", byte_encoding: "base64" } }));
    ws.send(JSON.stringify({ type: "commit", total_packets: 99 }));
    await waitFor(() => server!.stats.commits === 1);
    const v = server.stats.violations.join(" | ");
    expect(v).toMatch(/screenshot must be null/);
    expect(v).toMatch(/append position 5/);
    expect(v).toMatch(/packet_duration changed/);
    expect(v).toMatch(/total_packets 99/);
    ws.close();
  });
});

/* ============================================================================ the whole engine over real sockets */

describe("MicEngine (scripted VAD) over the fake Wispr server", () => {
  it("speech -> pre-roll + stream -> commit -> final -> schema-valid fragment; pause phrase -> mic released, sockets closed", async () => {
    server = await startFakeWispr({
      port: 0,
      quiet: true,
      finalDelayMs: 40,
      texts: ["Email the team about the delay.", "Pause memory."],
    });
    const stream = new FakeStream();
    const audioCtx = new FakeAudioContext();
    let vad!: ScriptedVad;
    const fragments: FragmentFinal[] = [];
    const states: AudioState[] = [];
    const pauses: Array<[string, number]> = [];
    const diags: string[] = [];
    let readyStandbys = 0; // counts {kind:"standby", state:"ready"} diagnostics: a socket that is authenticated and idle
    const opts: AudioEngineOptions = {
      deviceId: "dev-e2e",
      sessionId: "sess-e2e",
      deviceKind: "desk",
      onFragment: (f) => fragments.push(f),
      onSpeaking: () => undefined,
      onState: (s) => states.push(s),
      onLevel: () => undefined,
      onFailed: (id, r) => diags.push(`failed ${id} ${r}`),
      onPause: (via, ms) => pauses.push([via, ms]),
      onStats: () => undefined,
      requestWisprToken: async () => tokenFor(server!),
      getWisprContext: () => ctx,
      getActivity: () => "desk",
      getMode: () => "normal",
      onDiagnostic: (d) => {
        if (d.kind === "standby" && d.state === "ready") readyStandbys++;
      },
    };
    const engine = createMicEngineFactory({
      getUserMedia: async () => stream as unknown as MediaStream,
      createAudioContext: () => audioCtx as unknown as AudioContext,
      createVad: async (cfg, h) => (vad = new ScriptedVad(cfg, h)),
      document: null,
    })(opts);

    await engine.start();
    await waitFor(() => readyStandbys >= 1, 4000, "first standby ready");

    const speak = async (n: number, rms: number) => {
      for (let i = 0; i < n; i++) await vad.feed(frameWithRms(rms), 0.9);
    };
    const hush = async (n: number) => {
      for (let i = 0; i < n; i++) await vad.feed(frameWithRms(0.002), 0.02);
    };

    await hush(10);
    await speak(20, 0.08);
    await hush(15); // redemption -> speech end -> commit
    await waitFor(() => fragments.length === 1, 4000, "first fragment");
    expect(fragments[0]!.text).toBe("Email the team about the delay.");
    expect(FragmentFinalSchema.safeParse(fragments[0]).success).toBe(true);
    expect(fragments[0]!.transport).toBe("wispr_ws");
    expect(server.stats.violations).toEqual([]);
    expect(server.stats.commits).toBe(1);
    // pre-roll was included: 10 silent (ring) + 20 voiced + 15 tail = 45 packets
    expect(server.stats.lastTotalPackets).toBe(45);

    // second utterance is the pause phrase
    await waitFor(() => readyStandbys >= 2, 4000, "next standby ready");
    await hush(5);
    await speak(10, 0.01);
    await hush(15);
    await waitFor(() => pauses.length === 1, 4000, "pause");
    expect(pauses[0]![0]).toBe("voice");
    expect(stream.track.stopped).toBe(true);
    expect(vad.destroyed).toBe(true);
    expect(engine.state).toBe("paused");
    expect(fragments).toHaveLength(1); // the phrase never became a fragment
    await waitFor(() => server!.stats.openConnections === 0, 4000, "every socket closed");
    expect(server.stats.violations).toEqual([]);
    expect(diags).toEqual([]);
    expect(states[states.length - 1]).toBe("paused");
  });
});
