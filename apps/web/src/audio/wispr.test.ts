import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, FakeWs, flush } from "./test-utils";
import type { AudioDiagnostic, WisprContext, WisprTokenInfo } from "./types";
import {
  MAX_CONVERSATION_MESSAGES,
  MAX_DICTIONARY_TERMS,
  WisprStreamer,
  buildAuthMessage,
  buildContextPayload,
  buildWsUrl,
  contextSignature,
  scrub,
  toTokenState,
  type ClaimOptions,
  type UtteranceHandle,
  type WisprStreamerConfig,
  type WisprTranscript,
} from "./wispr";

const WS_URL = "wss://wispr.test/api/v1/dash/client_ws";
const REST_URL = "https://wispr.test/api/v1/dash/client_api";

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const frame = (v: number): Int16Array => new Int16Array(512).fill(v);

interface Harness {
  clock: FakeClock;
  streamer: WisprStreamer;
  getToken: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  ctx: WisprContext;
  diags: AudioDiagnostic[];
  radio: boolean[];
  bytes: number[];
  transcripts: WisprTranscript[];
  failures: string[];
  claim(over?: Partial<ClaimOptions>): UtteranceHandle;
  /** start the streamer and bring the first standby socket up */
  standbyUp(): Promise<FakeWs>;
}

function harness(over: Partial<WisprStreamerConfig> = {}, tokenOver: Partial<WisprTokenInfo> = {}): Harness {
  FakeWs.reset();
  const clock = new FakeClock();
  let n = 0;
  const getToken = vi.fn(async (): Promise<WisprTokenInfo> => {
    n++;
    return {
      mode: "client",
      token: `jwt-${n}`,
      expiresAt: clock.now() + 900_000,
      wsUrl: WS_URL,
      restUrl: REST_URL,
      ...tokenOver,
    };
  });
  const ctx: WisprContext = {
    dictionary: ["OAuth2", "cart-service", "Sarah"],
    conversation: [],
    language: ["en"],
    userFirstName: "Rio",
  };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "rest text", detected_language: "en" }), { status: 200 }));
  const diags: AudioDiagnostic[] = [];
  const radio: boolean[] = [];
  const bytes: number[] = [];
  const transcripts: WisprTranscript[] = [];
  const failures: string[] = [];
  const streamer = new WisprStreamer({
    deviceId: "dev-1",
    sessionId: "sess-1",
    getToken,
    getContext: () => ctx,
    clock,
    createSocket: (url) => new FakeWs(url),
    fetch: fetchMock as unknown as typeof fetch,
    emit: (d) => diags.push(d),
    onRadio: (a) => radio.push(a),
    onBytes: (c) => bytes.push(c),
    ...over,
  });
  const h: Harness = {
    clock,
    streamer,
    getToken,
    fetchMock,
    ctx,
    diags,
    radio,
    bytes,
    transcripts,
    failures,
    claim: (o = {}) =>
      streamer.claim({
        fragmentId: "frag-1",
        packetsPerAppend: 4,
        onTranscript: (t) => transcripts.push(t),
        onFailed: (r) => failures.push(r),
        ...o,
      }),
    standbyUp: async () => {
      streamer.start();
      await flush();
      const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
      ws.open();
      ws.serverSend({ status: "auth" });
      await flush();
      return ws;
    },
  };
  return h;
}

/** open + ack the newest socket (the next standby) */
async function bringUpLatest(): Promise<FakeWs> {
  await flush();
  const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
  ws.open();
  ws.serverSend({ status: "auth" });
  await flush();
  return ws;
}

beforeEach(() => FakeWs.reset());

/* ======================================================================== wire builders */

describe("wire builders", () => {
  const base: WisprContext = { dictionary: ["a"], conversation: [], language: ["en"], userFirstName: "Rio" };

  it("builds the documented client_ws URL", () => {
    expect(buildWsUrl(WS_URL, "abc.def.ghi")).toBe(`${WS_URL}?client_key=Bearer%20abc.def.ghi`);
    expect(buildWsUrl(`${WS_URL}?x=1`, "t")).toBe(`${WS_URL}?x=1&client_key=Bearer%20t`);
    // anything that is not URL-safe is escaped
    expect(buildWsUrl(WS_URL, "a b&c")).toBe(`${WS_URL}?client_key=Bearer%20a%20b%26c`);
  });

  it("auth message: shape per TRD §5.5, language omitted for auto-detect", () => {
    const msg = buildAuthMessage("JWT", base, "dev-1", "sess-1");
    expect(msg).toMatchObject({
      type: "auth",
      access_token: "JWT",
      language: ["en"],
      context: {
        app: { name: "Synapse", type: "ai" },
        user_identifier: "dev-1",
        user_first_name: "Rio",
        user_last_name: "",
        conversation: { id: "sess-1", participants: [], messages: [] },
      },
    });
    const auto = buildAuthMessage("JWT", { ...base, language: [] }, "dev-1", "sess-1");
    expect("language" in auto).toBe(false);
  });

  it("NEVER sends screenshot / content_text / content_html (always null) and an empty textbox", () => {
    const ctx = buildContextPayload(base, "dev-1", "sess-1");
    const json = JSON.parse(JSON.stringify(ctx)) as Record<string, unknown>;
    expect(json.screenshot).toBeNull();
    expect(json.content_text).toBeNull();
    expect(json.content_html).toBeNull();
    expect(json.textbox_contents).toEqual({ before_text: "", selected_text: "", after_text: "" });
    // the exact key set: nothing else can sneak in
    expect(Object.keys(json).sort()).toEqual(
      [
        "app",
        "content_html",
        "content_text",
        "conversation",
        "dictionary_context",
        "screenshot",
        "textbox_contents",
        "user_first_name",
        "user_identifier",
        "user_last_name",
      ].sort(),
    );
  });

  it("caps the dictionary at 150 distinct non-empty terms and the conversation at the last 6 messages", () => {
    const dictionary = ["", "  ", "dup", "dup", "x".repeat(200)];
    for (let i = 0; i < 400; i++) dictionary.push(`term-${i}`);
    const conversation = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `msg ${i}` }));
    const ctx = buildContextPayload({ ...base, dictionary, conversation }, "d", "s");
    expect(ctx.dictionary_context).toHaveLength(MAX_DICTIONARY_TERMS);
    expect(MAX_DICTIONARY_TERMS).toBe(150);
    expect(ctx.dictionary_context[0]).toBe("dup");
    expect(new Set(ctx.dictionary_context).size).toBe(ctx.dictionary_context.length);
    expect(ctx.dictionary_context.every((t) => t.length > 0 && t.length <= 80)).toBe(true);
    expect(ctx.conversation.messages).toHaveLength(MAX_CONVERSATION_MESSAGES);
    expect(ctx.conversation.messages.map((m) => m.content)).toEqual(["msg 4", "msg 5", "msg 6", "msg 7", "msg 8", "msg 9"]);
    expect(ctx.conversation.messages.every((m) => m.role === "user")).toBe(true);
  });

  it("context signature changes with content and is stable otherwise", () => {
    const a = contextSignature(base);
    expect(contextSignature({ ...base })).toBe(a);
    expect(contextSignature({ ...base, dictionary: ["a", "b"] })).not.toBe(a);
    expect(contextSignature({ ...base, conversation: [{ role: "user", content: "hi" }] })).not.toBe(a);
    expect(contextSignature({ ...base, language: [] })).not.toBe(a);
  });
});

describe("toTokenState", () => {
  const now = 1_000_000;
  const good: WisprTokenInfo = { mode: "client", token: "t", wsUrl: WS_URL, restUrl: REST_URL, expiresAt: now + 900_000 };

  it("refreshes when < 20 % of the lifetime is left", () => {
    const s = toTokenState(good, now);
    expect(s.refreshAt).toBe(now + 720_000);
    expect(s.expiresAt).toBe(now + 900_000);
    expect(toTokenState({ ...good, expiresAt: now + 100_000 }, now).refreshAt).toBe(now + 80_000);
  });

  it("treats a nonsense expiry (clock skew) as the default 900 s from receipt", () => {
    expect(toTokenState({ ...good, expiresAt: now - 60_000 }, now).refreshAt).toBe(now + 720_000);
    expect(toTokenState({ ...good, expiresAt: now + 48 * 3_600_000 }, now).refreshAt).toBe(now + 720_000);
    const { expiresAt: _drop, ...noExp } = good;
    expect(toTokenState(noExp, now).refreshAt).toBe(now + 720_000);
  });

  it("refuses mock / proxy / error / incomplete responses", () => {
    expect(() => toTokenState({ mode: "mock" }, now)).toThrow(/no Wispr key/);
    expect(() => toTokenState({ mode: "proxy" }, now)).toThrow(/proxy mode not supported/);
    expect(() => toTokenState({ ...good, error: "boom" }, now)).toThrow(/boom/);
    expect(() => toTokenState({ mode: "client", token: "t" }, now)).toThrow(/incomplete/);
  });
});

/* ======================================================================== standby socket */

describe("standby socket", () => {
  it("connects with the JWT in client_key, authenticates, and is ready only after {status:'auth'}", async () => {
    const h = harness();
    h.streamer.start();
    await flush();
    expect(h.getToken).toHaveBeenCalledTimes(1);
    expect(FakeWs.instances).toHaveLength(1);
    const ws = FakeWs.instances[0]!;
    expect(ws.url).toBe(`${WS_URL}?client_key=Bearer%20jwt-1`);
    expect(ws.sent).toHaveLength(0); // nothing before the socket is open
    ws.open();
    expect(ws.messages).toHaveLength(1);
    const auth = ws.messages[0]!;
    expect(auth.type).toBe("auth");
    expect(auth.access_token).toBe("jwt-1");
    expect(auth.language).toEqual(["en"]);
    expect(auth.context.app).toEqual({ name: "Synapse", type: "ai" });
    expect(auth.context.user_identifier).toBe("dev-1");
    expect(auth.context.conversation.id).toBe("sess-1");
    expect(h.streamer.standbyReady).toBe(false);
    ws.serverSend({ status: "auth" });
    expect(h.streamer.standbyReady).toBe(true);
    expect(h.diags.filter((d) => d.kind === "standby").map((d) => (d as { state: string }).state)).toEqual(["connecting", "ready"]);
  });

  it("an idle standby sends no audio at all", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    h.clock.advance(30_000);
    expect(ws.messages.map((m) => m.type)).toEqual(["auth"]);
    expect(h.bytes).toHaveLength(0);
    expect(h.radio).toHaveLength(0);
  });

  it("claiming the standby reuses it (no new auth) and immediately opens the next one", async () => {
    const h = harness();
    const first = await h.standbyUp();
    const u = h.claim();
    expect(u.state).toBe("streaming");
    await flush();
    expect(FakeWs.instances).toHaveLength(2); // the next standby is already connecting
    const second = FakeWs.instances[1]!;
    expect(first.messages.filter((m) => m.type === "auth")).toHaveLength(1);
    expect(h.streamer.standbyReady).toBe(false); // new one not authenticated yet
    second.open();
    second.serverSend({ status: "auth" });
    expect(h.streamer.standbyReady).toBe(true);
    // a second claim uses socket #2 and opens #3
    h.claim({ fragmentId: "frag-2" });
    await flush();
    expect(FakeWs.instances).toHaveLength(3);
    expect(first.isClosed).toBe(false);
  });

  it("without a ready standby the claim is cold: audio is buffered and flushed in order once the socket is ready", async () => {
    const h = harness();
    h.streamer.start();
    await flush();
    const ws = FakeWs.instances[0]!; // still connecting
    const u = h.claim();
    const pre = Array.from({ length: 5 }, (_, i) => ({ pcm: frame(i + 1), rms: 0.01 * (i + 1) }));
    u.pushPreroll(pre);
    u.push(frame(9), 0.09);
    expect(ws.sent).toHaveLength(0);
    ws.open();
    expect(ws.messages.map((m) => m.type)).toEqual(["auth"]);
    ws.serverSend({ status: "auth" });
    // everything buffered goes out at once as ONE append, starting at position 0
    const appends = ws.ofType("append");
    expect(appends).toHaveLength(1);
    expect(appends[0]!.position).toBe(0);
    expect(appends[0]!.audio_packets.packets).toHaveLength(6);
    expect(appends[0]!.audio_packets.volumes).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.09]);
  });

  it("recycles the standby after standbyMaxAge (make-before-break) and claims the fresh one", async () => {
    const h = harness({ standbyMaxAgeMs: 45_000 });
    const first = await h.standbyUp();
    h.clock.advance(44_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(1);
    h.clock.advance(1_001);
    await flush();
    expect(FakeWs.instances).toHaveLength(2); // replacement connecting
    expect(first.isClosed).toBe(false); // old one still serves until the new one is ready
    const second = await bringUpLatest();
    expect(first.isClosed).toBe(true);
    expect(first.closeCalls[0]!.code).toBe(1000);
    h.claim();
    await flush();
    expect(second.messages.filter((m) => m.type === "auth")).toHaveLength(1);
    expect(second.isClosed).toBe(false);
  });

  it("recycles when the token is < 20 % from expiry, fetching a fresh one", async () => {
    const h = harness({ standbyMaxAgeMs: 10 * 3_600_000 });
    const first = await h.standbyUp();
    expect(first.url).toContain("jwt-1");
    h.clock.advance(719_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(1);
    h.clock.advance(2_000);
    await flush();
    expect(h.getToken).toHaveBeenCalledTimes(2);
    expect(FakeWs.instances).toHaveLength(2);
    expect(FakeWs.instances[1]!.url).toContain("jwt-2");
    await bringUpLatest();
    expect(first.isClosed).toBe(true);
  });

  it("recycles when the context changed (only once the standby is old enough, and via checkFreshness)", async () => {
    const h = harness({ standbyMaxAgeMs: 10 * 3_600_000, contextRecycleMinAgeMs: 10_000 });
    const first = await h.standbyUp();
    h.ctx.dictionary = [...h.ctx.dictionary, "brand-new-term"];
    h.clock.advance(5_000);
    h.streamer.checkFreshness();
    await flush();
    expect(FakeWs.instances).toHaveLength(1); // too young: no churn
    h.clock.advance(6_000);
    h.streamer.checkFreshness();
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
    const second = FakeWs.instances[1]!;
    second.open();
    expect(second.messages[0]!.context.dictionary_context).toContain("brand-new-term");
    second.serverSend({ status: "auth" });
    expect(first.isClosed).toBe(true);
    // unchanged context: no further churn
    h.clock.advance(20_000);
    h.streamer.checkFreshness();
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
  });

  it("never hands speech to a standby that is past its maximum age", async () => {
    const h = harness({ standbyMaxAgeMs: 45_000 });
    const first = await h.standbyUp();
    // time passes but the replacement socket never comes up (network trouble): the old standby is now too old to trust
    h.clock.advance(46_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(2); // the replacement exists but is not open
    const replacement = FakeWs.instances[1]!;
    const u = h.claim();
    expect(first.isClosed).toBe(true); // refused + closed
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    expect(first.ofType("append")).toHaveLength(0); // no audio ever went to the stale socket
    expect(first.ofType("commit")).toHaveLength(0);
    // the utterance waits on the replacement; it never comes up, so the final timeout hands it to REST
    h.clock.advance(4_001);
    await flush();
    expect(replacement.ofType("append")).toHaveLength(0);
    expect(h.diags.some((d) => d.kind === "fallback")).toBe(true);
    expect(h.transcripts[0]).toMatchObject({ transport: "wispr_rest" });
  });

  it("uses the assumed-ready path when the documented {status:'auth'} ack never arrives", async () => {
    const h = harness({ authAckTimeoutMs: 3000 });
    h.streamer.start();
    await flush();
    const ws = FakeWs.instances[0]!;
    ws.open();
    h.clock.advance(2_900);
    expect(h.streamer.standbyReady).toBe(false);
    h.clock.advance(200);
    expect(h.streamer.standbyReady).toBe(true);
    expect(h.diags).toContainEqual({ kind: "standby", state: "ready", assumed: true });
  });

  it("an error while authenticating drops the token and retries with backoff", async () => {
    const h = harness({ retryBaseMs: 1000, retryMaxMs: 15_000 });
    h.streamer.start();
    await flush();
    const ws1 = FakeWs.instances[0]!;
    ws1.open();
    ws1.serverSend({ status: "error", code: "401" });
    expect(ws1.isClosed).toBe(true);
    expect(h.streamer.debug.failures).toBe(1);
    await flush();
    expect(FakeWs.instances).toHaveLength(1);
    h.clock.advance(999);
    await flush();
    expect(FakeWs.instances).toHaveLength(1);
    h.clock.advance(2);
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
    expect(h.getToken).toHaveBeenCalledTimes(2); // token was invalidated -> a fresh one
    expect(h.getToken.mock.calls[0]).toEqual([]); // the first mint is an ordinary request
    expect(h.getToken.mock.calls[1]).toEqual([{ force: true }]); // after a rejection the server is told to mint a FRESH token
    expect(FakeWs.instances[1]!.url).toContain("jwt-2");
    // second failure: 2 s backoff, third: 4 s
    FakeWs.instances[1]!.open();
    FakeWs.instances[1]!.serverSend({ status: "error" });
    h.clock.advance(1_999);
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
    h.clock.advance(2);
    await flush();
    expect(FakeWs.instances).toHaveLength(3);
    FakeWs.instances[2]!.open();
    FakeWs.instances[2]!.serverSend({ status: "error" });
    h.clock.advance(3_999);
    await flush();
    expect(FakeWs.instances).toHaveLength(3);
    h.clock.advance(2);
    await flush();
    expect(FakeWs.instances).toHaveLength(4);
    // success resets the backoff
    await bringUpLatest();
    expect(h.streamer.debug.failures).toBe(0);
  });

  it("a socket that never opens is abandoned after the connect timeout", async () => {
    const h = harness({ connectTimeoutMs: 8000, retryBaseMs: 1000 });
    h.streamer.start();
    await flush();
    const ws = FakeWs.instances[0]!;
    h.clock.advance(8_001);
    expect(ws.isClosed).toBe(true);
    expect(h.diags.some((d) => d.kind === "standby" && d.state === "down")).toBe(true);
  });

  it("reopens at once when the server closes a long-lived idle standby, but backs off after a young death", async () => {
    const h = harness({ retryBaseMs: 1000, standbyMaxAgeMs: 10 * 3_600_000 });
    const first = await h.standbyUp();
    h.clock.advance(20_000);
    first.serverClose(1000);
    await flush();
    expect(FakeWs.instances).toHaveLength(2); // immediate reconnect
    const second = await bringUpLatest();
    h.clock.advance(1_000);
    second.serverClose(1011); // died young
    await flush();
    expect(FakeWs.instances).toHaveLength(2); // waits for the backoff
    h.clock.advance(1_001);
    await flush();
    expect(FakeWs.instances).toHaveLength(3);
  });

  it("dedupes concurrent token requests", async () => {
    const h = harness();
    h.streamer.start();
    h.claim(); // cold claim -> a second conn would normally also want a token
    await flush();
    expect(h.getToken).toHaveBeenCalledTimes(1);
  });

  it("stop() closes every socket without a commit, aborts utterances and refuses further claims", async () => {
    const h = harness();
    const first = await h.standbyUp();
    const u = h.claim();
    await flush();
    const second = FakeWs.instances[1]!;
    const pcm = frame(7);
    u.pushPreroll([{ pcm, rms: 0.1 }]);
    h.streamer.stop();
    expect(first.isClosed).toBe(true);
    expect(second.isClosed).toBe(true);
    expect(first.ofType("commit")).toHaveLength(0);
    expect(second.ofType("commit")).toHaveLength(0);
    expect(u.state).toBe("settled");
    expect(pcm.every((s) => s === 0)).toBe(true);
    expect(h.transcripts).toHaveLength(0);
    expect(h.failures).toHaveLength(0);
    const count = FakeWs.instances.length;
    const dead = h.claim({ fragmentId: "late" });
    dead.push(frame(1), 0.1);
    dead.commit();
    await flush();
    expect(dead.state).toBe("settled");
    expect(FakeWs.instances).toHaveLength(count); // nothing was opened
    expect(h.fetchMock).not.toHaveBeenCalled(); // and nothing went to REST
    h.clock.advance(120_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(count);
  });
});

/* ======================================================================== streaming an utterance */

describe("utterance streaming", () => {
  it("append positions are cumulative packet indexes, packet_duration is constant, commit carries total_packets", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    const pre = Array.from({ length: 16 }, (_, i) => ({ pcm: frame(i), rms: 0.01 }));
    u.pushPreroll(pre);
    // pre-roll leaves immediately (CAP-1)
    expect(ws.ofType("append")).toHaveLength(1);
    expect(ws.ofType("append")[0]!.position).toBe(0);
    expect(ws.ofType("append")[0]!.audio_packets.packets).toHaveLength(16);
    for (let i = 0; i < 3; i++) u.push(frame(100 + i), 0.05);
    expect(ws.ofType("append")).toHaveLength(1); // below the 4-packet cadence
    u.push(frame(103), 0.05);
    expect(ws.ofType("append")).toHaveLength(2);
    expect(ws.ofType("append")[1]!.position).toBe(16);
    for (let i = 0; i < 4; i++) u.push(frame(200 + i), 0.05);
    expect(ws.ofType("append")[2]!.position).toBe(20);
    u.push(frame(300), 0.05);
    u.push(frame(301), 0.05);
    expect(u.packetCount).toBe(26);
    u.commit();
    const types = ws.messages.map((m) => m.type);
    expect(types).toEqual(["auth", "append", "append", "append", "append", "commit"]);
    const last = ws.ofType("append")[3]!;
    expect(last.position).toBe(24); // the 2 leftover packets are flushed before the commit
    expect(last.audio_packets.packets).toHaveLength(2);
    expect(ws.ofType("commit")[0]).toEqual({ type: "commit", total_packets: 26 });
    for (const a of ws.ofType("append")) {
      expect(a.audio_packets.packet_duration).toBe(0.032);
      expect(a.audio_packets.audio_encoding).toBe("wav");
      expect(a.audio_packets.byte_encoding).toBe("base64");
      expect(a.audio_packets.volumes).toHaveLength(a.audio_packets.packets.length);
    }
    // positions + lengths tile [0, total) with no gaps or overlaps
    let expectedPos = 0;
    for (const a of ws.ofType("append")) {
      expect(a.position).toBe(expectedPos);
      expectedPos += a.audio_packets.packets.length;
    }
    expect(expectedPos).toBe(26);
  });

  it("each packet is ONE frame of raw int16 LE PCM (1024 bytes, no RIFF header) in order", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    const f = new Int16Array(512);
    for (let i = 0; i < 512; i++) f[i] = i - 256;
    u.pushPreroll([{ pcm: f.slice(), rms: 0.02 }]);
    const packet = b64decode(ws.ofType("append")[0]!.audio_packets.packets[0] as string);
    expect(packet.byteLength).toBe(1024);
    expect(String.fromCharCode(...packet.slice(0, 4))).not.toBe("RIFF");
    const dv = new DataView(packet.buffer);
    for (let i = 0; i < 512; i++) expect(dv.getInt16(i * 2, true)).toBe(f[i]);
  });

  it("packetFormat 'wav' wraps every packet in a RIFF header (escape hatch for the unverified assumption)", async () => {
    const h = harness({ packetFormat: "wav" });
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(5), rms: 0.02 }]);
    const packet = b64decode(ws.ofType("append")[0]!.audio_packets.packets[0] as string);
    expect(packet.byteLength).toBe(44 + 1024);
    expect(String.fromCharCode(...packet.slice(0, 4))).toBe("RIFF");
  });

  it("eco batching: packetsPerAppend 8", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim({ packetsPerAppend: 8 });
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    for (let i = 0; i < 7; i++) u.push(frame(i), 0.1);
    expect(ws.ofType("append")).toHaveLength(1); // 1 pre-roll + 7 = 8 packets queued... first flush was the pre-roll
    u.push(frame(9), 0.1);
    u.push(frame(9), 0.1);
    expect(ws.ofType("append").map((a) => a.position)).toEqual([0, 1]);
    expect(ws.ofType("append")[1]!.audio_packets.packets).toHaveLength(8);
  });

  it("final text -> transcript; partials are ignored; the socket is closed and the PCM zero-filled", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    const buffers = [frame(11), frame(12), frame(13)];
    u.pushPreroll(buffers.map((pcm) => ({ pcm, rms: 0.1 })));
    h.clock.advance(480);
    u.commit();
    const commitAt = h.clock.now();
    h.clock.advance(300);
    ws.serverSend({ status: "info", message: { event: "commit_received" } });
    ws.serverSend({ status: "text", position: 1, final: false, body: { text: "partial words", detected_language: "en" } });
    expect(h.transcripts).toHaveLength(0);
    expect(u.state).toBe("committed");
    expect(buffers[0]!.some((s) => s !== 0)).toBe(true); // audio still retained until the final
    ws.serverSend({ status: "text", position: 3, final: true, body: { text: " Email the team about the delay. ", detected_language: "en" } });
    expect(h.transcripts).toHaveLength(1);
    const t = h.transcripts[0]!;
    expect(t.text).toBe(" Email the team about the delay. "); // trimming is the fragment builder's job
    expect(t.detectedLanguage).toBe("en");
    expect(t.transport).toBe("wispr_ws");
    expect(t.tCommitSent).toBe(commitAt);
    expect(t.tFinal).toBe(commitAt + 300);
    expect(ws.isClosed).toBe(true);
    expect(buffers.every((b) => b.every((s) => s === 0))).toBe(true);
    expect(u.state).toBe("settled");
    expect(h.diags).toContainEqual({ kind: "latency", commitToFinalMs: 300, transport: "wispr_ws" });
    // no timeout fallback afterwards
    h.clock.advance(10_000);
    await flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.transcripts).toHaveLength(1);
  });

  it("a final that arrives before our commit is ignored (protocol anomaly)", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    ws.serverSend({ status: "text", position: 1, final: true, body: { text: "too early" } });
    expect(h.transcripts).toHaveLength(0);
    expect(h.diags.some((d) => d.kind === "anomaly")).toBe(true);
    expect(u.state).toBe("streaming");
  });

  it("an empty final is delivered as an empty transcript (the caller drops it)", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    ws.serverSend({ status: "text", final: true, body: { text: "" } });
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]!.text).toBe("");
  });

  it("two overlapping utterances never cross-talk", async () => {
    const h = harness();
    const ws1 = await h.standbyUp();
    const u1 = h.claim({ fragmentId: "A" });
    const ws2 = await bringUpLatest();
    const u2 = h.claim({ fragmentId: "B" });
    u1.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u2.pushPreroll([{ pcm: frame(2), rms: 0.1 }]);
    u1.commit();
    u2.commit();
    ws2.serverSend({ status: "text", final: true, body: { text: "second" } });
    ws1.serverSend({ status: "text", final: true, body: { text: "first" } });
    expect(h.transcripts.map((t) => t.text)).toEqual(["second", "first"]);
    expect(ws1.ofType("commit")).toHaveLength(1);
    expect(ws2.ofType("commit")).toHaveLength(1);
  });

  it("accounts bytes and radio time: radio on at the first append, off when the utterance settles", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    expect(h.radio).toEqual([]);
    u.pushPreroll(Array.from({ length: 4 }, () => ({ pcm: frame(1), rms: 0.1 })));
    expect(h.radio).toEqual([true]);
    expect(h.bytes).toEqual([4 * 1368]);
    u.commit();
    ws.serverSend({ status: "text", final: true, body: { text: "ok" } });
    expect(h.radio).toEqual([true, false]);
  });
});

/* ======================================================================== abort */

describe("abort (VAD misfire / pause)", () => {
  it("closes the socket WITHOUT commit, zero-fills, emits nothing, and a next standby exists", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    const pcm = frame(33);
    u.pushPreroll([{ pcm, rms: 0.1 }]);
    u.push(frame(1), 0.1);
    u.abort("misfire");
    expect(ws.ofType("commit")).toHaveLength(0);
    expect(ws.isClosed).toBe(true);
    expect(pcm.every((s) => s === 0)).toBe(true);
    expect(u.state).toBe("settled");
    expect(h.transcripts).toHaveLength(0);
    expect(h.failures).toHaveLength(0);
    expect(h.radio).toEqual([true, false]);
    // late events from the dead socket are harmless
    ws.serverSend({ status: "text", final: true, body: { text: "ghost" } });
    h.clock.advance(10_000);
    await flush();
    expect(h.transcripts).toHaveLength(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(FakeWs.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("push / commit after abort are inert", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    u.abort();
    u.push(frame(1), 0.1);
    u.commit();
    expect(ws.ofType("commit")).toHaveLength(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("commit with zero packets is an abort, not an empty request", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    u.commit();
    expect(ws.ofType("commit")).toHaveLength(0);
    expect(u.state).toBe("settled");
  });
});

/* ======================================================================== REST fallback */

describe("failure path -> REST fallback -> onFailed", () => {
  async function committed(h: Harness, frames = 3) {
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll(Array.from({ length: frames }, (_, i) => ({ pcm: frame(i + 1), rms: 0.1 })));
    u.commit();
    return { ws, u };
  }

  it("no final within the timeout -> the retained PCM is POSTed as a 44-byte-header WAV with the bearer JWT", async () => {
    const h = harness({ finalTimeoutMs: 4000 });
    const { ws, u } = await committed(h);
    h.clock.advance(3_999);
    await flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    const commitAt = h.clock.now();
    h.clock.advance(2);
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REST_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-1");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as { audio: string; language?: string[]; context: Record<string, unknown> };
    expect(body.language).toEqual(["en"]);
    expect(body.context.screenshot).toBeNull();
    expect(body.context.content_text).toBeNull();
    expect(body.context.content_html).toBeNull();
    const wav = b64decode(body.audio);
    expect(wav.byteLength).toBe(44 + 3 * 1024);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    const dv = new DataView(wav.buffer);
    expect(dv.getUint32(24, true)).toBe(16000);
    expect(dv.getUint32(40, true)).toBe(3 * 1024);
    expect(dv.getInt16(44, true)).toBe(1); // first sample of the first frame
    expect(dv.getInt16(44 + 1024, true)).toBe(2); // frames in order
    // result
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]).toMatchObject({ text: "rest text", transport: "wispr_rest", detectedLanguage: "en" });
    expect(h.transcripts[0]!.tCommitSent).toBeGreaterThanOrEqual(commitAt);
    expect(h.diags).toContainEqual({ kind: "fallback", reason: "no final within timeout" });
    expect(u.state).toBe("settled");
    expect(ws.isClosed).toBe(true);
    // a late WS final changes nothing
    ws.serverSend({ status: "text", final: true, body: { text: "late" } });
    expect(h.transcripts).toHaveLength(1);
  });

  it("omits `language` in the REST body when auto-detecting", async () => {
    const h = harness();
    h.ctx.language = [];
    await committed(h);
    h.clock.advance(4_001);
    await flush();
    const init = h.fetchMock.mock.calls[0]![1] as RequestInit;
    expect("language" in JSON.parse(init.body as string)).toBe(false);
  });

  it("REST failing too -> onFailed with a reason, no transcript, buffers released", async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    const { u } = await committed(h);
    h.clock.advance(4_001);
    await flush();
    expect(h.transcripts).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatch(/rest fallback failed.*500/);
    expect(u.state).toBe("settled");
    expect(h.radio).toEqual([true, false]);
  });

  it("a network error in REST -> onFailed", async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    await committed(h);
    h.clock.advance(4_001);
    await flush();
    expect(h.failures).toHaveLength(1);
    expect(h.transcripts).toHaveLength(0);
  });

  it("REST requests that hang are cut off after restTimeoutMs", async () => {
    const h = harness({ restTimeoutMs: 10_000 });
    h.fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    await committed(h);
    h.clock.advance(4_001);
    await flush();
    expect(h.failures).toHaveLength(0);
    h.clock.advance(10_001);
    await flush();
    expect(h.failures).toHaveLength(1);
  });

  it("a 401 from REST refreshes the token once and retries", async () => {
    const h = harness();
    h.fetchMock
      .mockImplementationOnce(async () => new Response("expired", { status: 401 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ text: "second try", detected_language: "en" }), { status: 200 }));
    await committed(h);
    h.clock.advance(4_001);
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.getToken).toHaveBeenCalledTimes(2); // the cached token, then one fresh token after the 401
    expect(h.getToken.mock.calls[1]).toEqual([{ force: true }]); // ...requested as forced, never the rejected one again
    expect((h.fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-1" });
    expect((h.fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-2" });
    expect(h.transcripts[0]!.text).toBe("second try");
  });

  it("{status:'error'} after the commit goes to REST immediately (no waiting for the timeout)", async () => {
    const h = harness();
    const { ws } = await committed(h);
    ws.serverSend({ status: "error", code: "overloaded" });
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.transcripts[0]).toMatchObject({ transport: "wispr_rest" });
    expect(h.diags.some((d) => d.kind === "fallback" && d.reason.includes("wispr error"))).toBe(true);
  });

  it("a close before the final goes to REST immediately", async () => {
    const h = harness();
    const { ws } = await committed(h);
    ws.serverClose(1006);
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.transcripts[0]).toMatchObject({ transport: "wispr_rest" });
  });

  it("a socket lost mid-utterance keeps collecting PCM and goes straight to REST at the commit (no WS commit)", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    ws.serverClose(1006);
    u.push(frame(2), 0.1);
    u.push(frame(3), 0.1);
    u.push(frame(4), 0.1);
    u.push(frame(5), 0.1);
    u.commit();
    await flush();
    expect(ws.ofType("commit")).toHaveLength(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((h.fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { audio: string };
    expect(b64decode(body.audio).byteLength).toBe(44 + 5 * 1024); // ALL five frames, including those after the drop
    expect(h.transcripts[0]).toMatchObject({ transport: "wispr_rest" });
  });

  it("a send() that throws degrades to REST instead of losing the utterance", async () => {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    ws.throwOnSend = true;
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.transcripts[0]).toMatchObject({ transport: "wispr_rest" });
  });

  it("if the WS final shows up while REST is still in flight, the first result wins and REST is cancelled", async () => {
    const h = harness();
    let aborted = false;
    h.fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const { ws } = await committed(h);
    h.clock.advance(4_001);
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    ws.serverSend({ status: "text", final: true, body: { text: "from ws", detected_language: "en" } });
    await flush();
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]).toMatchObject({ text: "from ws", transport: "wispr_ws" });
    expect(aborted).toBe(true);
    expect(h.failures).toHaveLength(0);
  });

  it("commit before the socket is authenticated: the commit goes out as soon as it is ready", async () => {
    const h = harness();
    h.streamer.start();
    await flush();
    const ws = FakeWs.instances[0]!;
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    h.clock.advance(1_000);
    ws.open();
    ws.serverSend({ status: "auth" });
    expect(ws.messages.map((m) => m.type)).toEqual(["auth", "append", "commit"]);
    expect(ws.ofType("commit")[0]!.total_packets).toBe(1);
    h.clock.advance(1_000);
    ws.serverSend({ status: "text", final: true, body: { text: "made it" } });
    expect(h.transcripts[0]).toMatchObject({ text: "made it", transport: "wispr_ws" });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("no Wispr connection at all (token endpoint down): REST is attempted and fails -> onFailed", async () => {
    const h = harness();
    h.getToken.mockImplementation(async () => {
      throw new Error("server unreachable");
    });
    h.streamer.start();
    await flush();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    await flush();
    expect(h.failures).toHaveLength(1);
    expect(h.fetchMock).not.toHaveBeenCalled(); // no token, no REST call
    expect(h.transcripts).toHaveLength(0);
  });
});

/* ======================================================================== secrets */

describe("the JWT and the WebSocket URL never leave the module", () => {
  it("scrub() removes URLs, bearer values and JWT-shaped strings", () => {
    expect(scrub("The URL 'wss://platform-api.wisprflow.ai/x?client_key=Bearer%20abc.def' is invalid")).toBe("The URL '[url] is invalid");
    expect(scrub("failed with Authorization: Bearer abc123.def-456_ghi")).toBe("failed with Authorization: Bearer [redacted]");
    expect(scrub("token \u0065yJhbGciOiJub25lIn0.\u0065yJzdWIiOiJ4In0.c2ln leaked")).toBe("token [token] leaked");
    expect(scrub("plain message")).toBe("plain message");
  });

  it("a WebSocket constructor error that quotes the URL (JWT inside) is scrubbed from the diagnostics", async () => {
    const h = harness({
      createSocket: (url) => {
        throw new SyntaxError(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`);
      },
    });
    h.streamer.start();
    await flush();
    const down = h.diags.filter((d) => d.kind === "standby" && d.state === "down");
    expect(down.length).toBeGreaterThan(0);
    const all = JSON.stringify(h.diags);
    expect(all).not.toContain("jwt-1");
    expect(all).not.toContain("client_key");
    expect(all).not.toMatch(/wss?:\/\//);
  });

  it("a token-endpoint error that carries a JWT is scrubbed before it reaches the failure reason", async () => {
    const h = harness();
    h.getToken.mockImplementation(async () => {
      throw new Error("upstream said: Bearer \u0065yJhbGciOiJub25lIn0.\u0065yJzdWIiOiJ4In0.c2ln is expired");
    });
    h.streamer.start();
    await flush();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    await flush();
    expect(h.failures).toHaveLength(1);
    const text = JSON.stringify([h.failures, h.diags]);
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("c2ln");
  });
});

describe("Wispr error descriptions (diagnostics only)", () => {
  async function failWith(payload: Record<string, unknown>) {
    const h = harness();
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    u.commit();
    ws.serverSend({ status: "error", ...payload });
    await flush();
    return h.diags.find((d) => d.kind === "fallback") as { reason: string } | undefined;
  }

  it("includes the code and Wispr's own short message so a first run with a real key is debuggable", async () => {
    const d = await failWith({ code: 4001, message: "Invalid audio format" });
    expect(d?.reason).toBe("wispr error 4001 - Invalid audio format");
  });

  it("falls back to `error` / `detail` fields, and to a bare description", async () => {
    expect((await failWith({ error: "rate limited" }))?.reason).toBe("wispr error - rate limited");
    expect((await failWith({ detail: "bad token" }))?.reason).toBe("wispr error - bad token");
    expect((await failWith({}))?.reason).toBe("wispr error");
  });

  it("scrubs URLs and tokens out of Wispr's message and truncates it", async () => {
    const d = await failWith({ message: `see wss://x.test/ws?client_key=Bearer%20\u0065yJhbGciOiJub25lIn0.\u0065yJzdWIiOiJ4In0.c2ln ${"x".repeat(300)}` });
    expect(d?.reason).not.toMatch(/eyJ|wss?:\/\/|client_key/);
    expect(d!.reason.length).toBeLessThanOrEqual(140);
  });
});

/* ======================================================================== kick() */

describe("kick() (network is back / tab visible again)", () => {
  it("reconnects the standby right away instead of waiting for the backoff timer", async () => {
    const h = harness({ retryBaseMs: 1000 });
    h.streamer.start();
    await flush();
    const ws1 = FakeWs.instances[0]!;
    ws1.open();
    ws1.serverSend({ status: "error", code: "x" }); // auth rejected -> backoff 1 s
    await flush();
    expect(h.streamer.debug.failures).toBe(1);
    expect(FakeWs.instances).toHaveLength(1);
    h.streamer.kick();
    await flush();
    expect(FakeWs.instances).toHaveLength(2); // no clock advance needed
    expect(h.streamer.debug.failures).toBe(0);
    // the cancelled backoff timer does not produce a third socket later
    h.clock.advance(5_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
  });

  it("leaves a healthy, fresh standby alone", async () => {
    const h = harness();
    await h.standbyUp();
    h.streamer.kick();
    await flush();
    expect(FakeWs.instances).toHaveLength(1);
  });

  it("abandons a standby attempt that is stuck connecting and tries again", async () => {
    const h = harness();
    h.streamer.start();
    await flush();
    const stuck = FakeWs.instances[0]!; // never opens (network was down)
    h.streamer.kick();
    await flush();
    expect(stuck.isClosed).toBe(true);
    expect(FakeWs.instances).toHaveLength(2);
    expect(h.streamer.debug.opening).toBe(true);
  });

  it("does not touch the socket of an utterance in flight", async () => {
    const h = harness();
    const ws0 = await h.standbyUp();
    const u = h.claim();
    await bringUpLatest();
    u.pushPreroll([{ pcm: frame(1), rms: 0.1 }]);
    h.streamer.kick();
    await flush();
    expect(ws0.isClosed).toBe(false);
    expect(u.state).toBe("streaming");
  });

  it("is a no-op when the streamer is stopped", async () => {
    const h = harness();
    h.streamer.start();
    await flush();
    h.streamer.stop();
    const n = FakeWs.instances.length;
    h.streamer.kick();
    await flush();
    expect(FakeWs.instances).toHaveLength(n);
  });
});

/* ======================================================================== the on-device engine (mode "local") */

describe("the on-device engine: the same protocol, a different address", () => {
  const ORIGIN = "http://localhost:5173";
  const LOCAL: Partial<WisprTokenInfo> = { mode: "local", wsUrl: "/local-stt/client_ws", restUrl: "/local-stt/client_api" };

  it("resolves the server's relative endpoints against the page origin: ws for http, wss for https, absolute Wispr URLs untouched", () => {
    const now = 1_000_000;
    const base: WisprTokenInfo = { mode: "local", token: "lt1.a.b", wsUrl: "/local-stt/client_ws", restUrl: "/local-stt/client_api", expiresAt: now + 900_000 };
    const http = toTokenState(base, now, "http://localhost:5173");
    expect(http).toMatchObject({ wsUrl: "ws://localhost:5173/local-stt/client_ws", restUrl: "http://localhost:5173/local-stt/client_api", local: true });
    const https = toTokenState(base, now, "https://192.168.1.20:5173");
    expect(https).toMatchObject({ wsUrl: "wss://192.168.1.20:5173/local-stt/client_ws", restUrl: "https://192.168.1.20:5173/local-stt/client_api" });
    // Wispr's own URLs pass through, and are not "local"
    expect(toTokenState({ mode: "client", token: "t", wsUrl: WS_URL, restUrl: REST_URL }, now, ORIGIN)).toMatchObject({ wsUrl: WS_URL, restUrl: REST_URL, local: false });
    // a relative endpoint with nothing to resolve it against is an error, not a guess
    expect(() => toTokenState(base, now)).toThrow(/page origin/);
    expect(() => toTokenState({ ...base, error: "on-device speech is off" }, now, ORIGIN)).toThrow(/on-device speech is off/);
  });

  it("connects to the resolved address with the token the server issued, and the transcript says local_stt", async () => {
    const h = harness({ origin: ORIGIN }, LOCAL);
    const ws = await h.standbyUp();
    expect(ws.url).toBe(`ws://localhost:5173/local-stt/client_ws?client_key=Bearer%20jwt-1`);
    expect(ws.ofType("auth")[0]!.access_token).toBe("jwt-1"); // repeated in the auth message, like Wispr's

    const u = h.claim();
    u.pushPreroll(Array.from({ length: 3 }, (_, i) => ({ pcm: frame(i + 1), rms: 0.1 })));
    u.commit();
    ws.serverSend({ status: "info", message: { event: "commit_received" } });
    ws.serverSend({ status: "text", position: 3, final: true, body: { text: "remind me to email the team", detected_language: "en" } });
    await flush();
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]).toMatchObject({ text: "remind me to email the team", transport: "local_stt", detectedLanguage: "en" });
    expect(h.diags).toContainEqual(expect.objectContaining({ kind: "latency", transport: "local_stt" }));
  });

  it("the REST fallback goes to the on-device REST route, with the same bearer token, and is labelled local_stt too", async () => {
    const h = harness({ origin: ORIGIN, finalTimeoutMs: 4000 }, LOCAL);
    const ws = await h.standbyUp();
    const u = h.claim();
    u.pushPreroll(Array.from({ length: 3 }, (_, i) => ({ pcm: frame(i + 1), rms: 0.1 })));
    u.commit();
    ws.serverSend({ status: "error", message: "on-device speech failed" });
    await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:5173/local-stt/client_api");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    await flush();
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]).toMatchObject({ text: "rest text", transport: "local_stt" });
  });

  it("reconnect(): the engine was switched, so what is being streamed is aborted, every socket closed, and the next one is the NEW engine's", async () => {
    const h = harness({ origin: ORIGIN }); // starts on Wispr
    const wisprWs = await h.standbyUp();
    expect(wisprWs.url.startsWith(WS_URL)).toBe(true);
    const u = h.claim();
    u.pushPreroll(Array.from({ length: 5 }, (_, i) => ({ pcm: frame(i + 1), rms: 0.1 })));
    expect(wisprWs.ofType("append")).toHaveLength(1);

    // the user turns local-only on: the server now hands out the on-device engine
    h.getToken.mockImplementation(async () => ({ mode: "local", token: "lt1.local", expiresAt: h.clock.now() + 900_000, wsUrl: "/local-stt/client_ws", restUrl: "/local-stt/client_api" }) as WisprTokenInfo);
    h.streamer.reconnect();
    await flush();

    // nothing more goes to Wispr: not the rest of this utterance, not a commit
    const appendsBefore = wisprWs.ofType("append").length;
    u.push(frame(9), 0.1);
    u.push(frame(9), 0.1);
    u.push(frame(9), 0.1);
    u.push(frame(9), 0.1);
    expect(wisprWs.ofType("append")).toHaveLength(appendsBefore);
    expect(wisprWs.ofType("commit")).toHaveLength(0);
    expect(wisprWs.closeCalls.length).toBeGreaterThan(0);
    expect(u.state).toBe("settled");
    expect(h.transcripts).toHaveLength(0);
    expect(h.failures).toHaveLength(0); // aborted on purpose: no "failed" red tick either

    // the replacement was asked for with force (a fresh token), and it is the on-device socket
    expect(h.getToken).toHaveBeenLastCalledWith({ force: true });
    const next = FakeWs.instances[FakeWs.instances.length - 1]!;
    expect(next).not.toBe(wisprWs);
    expect(next.url).toBe("ws://localhost:5173/local-stt/client_ws?client_key=Bearer%20lt1.local");
    next.open();
    next.serverSend({ status: "auth" });
    await flush();
    expect(h.streamer.standbyReady).toBe(true);
  });

  it("reconnect() on a streamer that is not running does nothing", async () => {
    const h = harness({ origin: ORIGIN });
    h.streamer.reconnect();
    await flush();
    expect(FakeWs.instances).toHaveLength(0);
    expect(h.getToken).not.toHaveBeenCalled();
  });
});
