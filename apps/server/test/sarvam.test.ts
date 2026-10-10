import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { LocalStt } from "../src/wispr/local-stt";
import { SarvamError, SarvamStt, cleanKeyterms, wav16k } from "../src/wispr/sarvam";
import { startFakeSarvam, type FakeSarvam } from "./fake-sarvam";

/**
 * Sarvam's cloud speech API as the engine behind the Wispr-compatible endpoints. A faithful fake of POST /speech-to-text
 * (multipart, the api-subscription-key header, the real response and error shapes) records what really left: the model, the
 * language, the hint terms, and the WAV itself. The properties that matter: the right request, errors that never carry the key
 * or any content, long utterances in pieces, and every call reported to the ledger.
 */

const KEY = "sk\u005ftest_sarvam_key_not_real";
let fake: FakeSarvam;
beforeAll(async () => {
  fake = await startFakeSarvam({ key: KEY });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => fake.reset({ kind: "ok", transcript: "remind me to email the team", language_code: "en-IN" }));

const tone = (secs: number, amp = 0.3): Float32Array => Float32Array.from({ length: Math.round(secs * 16000) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / 16000));
const backend = (o: Partial<ConstructorParameters<typeof SarvamStt>[0]> = {}): SarvamStt =>
  new SarvamStt({ apiKey: KEY, baseUrl: fake.url, model: "saaras:v4", languageCode: "en-IN", ...o });

describe("the pieces", () => {
  it("wav16k writes a 16 kHz mono 16-bit WAV with the samples in order, clipped to range", () => {
    const wav = wav16k(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]));
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(14);
    expect(wav.length).toBe(44 + 14);
    const s = (i: number): number => v.getInt16(44 + i * 2, true);
    expect([s(0), s(1), s(2), s(3), s(4), s(5), s(6)]).toEqual([0, 16384, -16383, 32767, -32767, 32767, -32767]); // Math.round rounds -16383.5 toward +infinity
  });

  it("cleanKeyterms keeps what the API accepts: trimmed, unique (any case), at most 50, each at most 64 characters", () => {
    const many = Array.from({ length: 80 }, (_, i) => `term-${i}`);
    expect(cleanKeyterms(["  Sarah ", "sarah", "", "OAuth2", "x".repeat(65), ...many])).toHaveLength(50);
    expect(cleanKeyterms(["  Sarah ", "sarah", "", "OAuth2", "x".repeat(65)])).toEqual(["Sarah", "OAuth2"]);
    expect(cleanKeyterms(["x".repeat(64)])).toHaveLength(1);
  });
});

describe("the request", () => {
  it("is a multipart POST with the key in the header, the model, the language, the hint terms and a 16 kHz WAV of exactly what was said", async () => {
    const b = backend({ keyterms: () => ["Rio", "Sarah", "cart-service", "OAuth2"] });
    const sent: Array<{ model: string; audioMs: number }> = [];
    const heard = await backend({ keyterms: () => ["Rio", "Sarah", "cart-service", "OAuth2"], onSend: (i) => sent.push(i) }).transcribe(tone(1.5));
    void b;
    expect(heard).toEqual({ text: "remind me to email the team", language: "en-IN" });

    expect(fake.requests).toHaveLength(1);
    const r = fake.requests[0]!;
    expect(r.key).toBe(KEY);
    expect(r.fields).toMatchObject({ model: "saaras:v4", language_code: "en-IN" });
    expect(JSON.parse(r.fields.keyterms as string)).toEqual(["Rio", "Sarah", "cart-service", "OAuth2"]);
    expect(r.wav).toMatchObject({ rate: 16000, channels: 1, bits: 16, samples: 24_000, filename: "utterance.wav" });
    expect(r.wav!.first[1]).not.toBe(0); // real audio, not silence
    expect(sent).toEqual([{ model: "saaras:v4", audioMs: 1500 }]); // the ledger is told, with the length and never the content
  });

  it("hint terms go only to the v4 model, and no field when there are none", async () => {
    await backend({ model: "saaras:v3", keyterms: () => ["Sarah"] }).transcribe(tone(1));
    expect(fake.requests[0]!.fields.keyterms).toBeUndefined();
    expect(fake.requests[0]!.fields.model).toBe("saaras:v3");
    fake.reset();
    await backend({ keyterms: () => [] }).transcribe(tone(1));
    expect(fake.requests[0]!.fields.keyterms).toBeUndefined();
  });

  it("an utterance longer than 28 s goes in pieces (the endpoint is meant for under 30 s), joined in order, each one reported", async () => {
    fake.reset({ kind: "ok", transcript: "part one", language_code: "en-IN" }, { kind: "ok", transcript: "part two", language_code: "en-IN" }, { kind: "ok", transcript: "part three", language_code: "hi-IN" });
    const sent: number[] = [];
    const out = await backend({ onSend: (i) => sent.push(i.audioMs) }).transcribe(tone(70));
    expect(out.text).toBe("part one part two part three");
    expect(out.language).toBe("en-IN"); // the first piece decides
    expect(fake.requests.map((r) => r.wav!.samples)).toEqual([28 * 16000, 28 * 16000, 14 * 16000]);
    expect(sent).toEqual([28_000, 28_000, 14_000]);
  });

  it("an empty or missing transcript is empty text, not an error", async () => {
    fake.reset({ kind: "ok", transcript: "", language_code: "en-IN" });
    expect((await backend().transcribe(tone(1))).text).toBe("");
  });
});

describe("errors never carry the key or any content", () => {
  it("a wrong key is a 403 with Sarvam's code, and nothing else", async () => {
    const err = await backend({ apiKey: "sk_wrong_key_value_123" }).transcribe(tone(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SarvamError);
    expect(err).toMatchObject({ status: 403, code: "invalid_api_key_error", message: "Sarvam HTTP 403 invalid_api_key_error" });
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain("sk_wrong_key_value_123");
  });

  it("a quota or rate limit (429), a server error and a body that is not JSON each become a SarvamError with the status", async () => {
    fake.reset({ kind: "status", status: 429, code: "insufficient_quota_error", message: "Quota exceeded for user content 'secret words'" }, { kind: "status", status: 503, code: "gateway_timeout_error" }, { kind: "garbage", text: "<html>bad gateway</html>" });
    const e429 = await backend().transcribe(tone(1)).catch((e: unknown) => e);
    expect(e429).toMatchObject({ status: 429, code: "insufficient_quota_error" });
    expect((e429 as Error).message).not.toContain("secret words"); // Sarvam's free-text message is never copied
    expect(await backend().transcribe(tone(1)).catch((e: unknown) => e)).toMatchObject({ status: 503, code: "gateway_timeout_error" });
    await expect(backend().transcribe(tone(1))).rejects.toBeTruthy(); // a 200 with a body that is not JSON
  });

  it("a hung call fails after the timeout instead of holding the answer forever", async () => {
    fake.reset({ kind: "slow", delayMs: 1500, transcript: "too late" });
    await expect(backend({ timeoutMs: 100 }).transcribe(tone(1))).rejects.toBeTruthy();
  });
});

describe("as an engine (LocalStt) behind the endpoints", () => {
  const engine = (b: SarvamStt): LocalStt => new LocalStt({ model: "sarvam:saaras:v4", dtype: "api", cacheDir: os.tmpdir(), languages: ["en"], loader: async () => b });

  it("passes the detected language through, applies the same silence and clean-up guards, and never calls Sarvam for silence", async () => {
    fake.reset({ kind: "ok", transcript: "[BLANK_AUDIO] namaste team", language_code: "hi-IN" });
    const s = engine(backend());
    expect(await s.transcribe(new Float32Array(16000))).toMatchObject({ text: "" });
    expect(await s.transcribe(tone(0.1))).toMatchObject({ text: "" });
    expect(fake.requests).toHaveLength(0);
    expect(await s.transcribe(tone(1))).toMatchObject({ text: "namaste team", language: "hi-IN" });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("configuration", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ LLM_MODE: "mock", WISPR_API_KEY: "", SARVAM_API_KEY: "", STT_PROVIDER: "", WISPR_LANGUAGES: "en", ...env });

  it("WISPR_MODE=sarvam is the on-server speech endpoint with Sarvam behind it, but only with a key", () => {
    expect(cfg({ WISPR_MODE: "sarvam", SARVAM_API_KEY: KEY })).toMatchObject({ wispr: { mode: "local" }, stt: { provider: "sarvam", sarvam: { model: "saaras:v4", baseUrl: "https://api.sarvam.ai", languageCode: "en-IN" } } });
    expect(cfg({ WISPR_MODE: "sarvam" })).toMatchObject({ wispr: { mode: "local" }, stt: { provider: "whisper" } }); // no key: Whisper, still a voice path
    expect(cfg({ WISPR_MODE: "local", STT_PROVIDER: "sarvam", SARVAM_API_KEY: KEY }).stt.provider).toBe("sarvam");
    expect(cfg({ WISPR_MODE: "local", SARVAM_API_KEY: KEY }).stt.provider).toBe("whisper"); // a key alone does not send audio anywhere
    expect(cfg({ WISPR_MODE: "mock", SARVAM_API_KEY: KEY }).wispr.mode).toBe("mock");
  });

  it("the language Sarvam is asked for: forced, or derived from WISPR_LANGUAGES (one language → its -IN code, otherwise detection)", () => {
    const lang = (env: Record<string, string>): string => cfg({ WISPR_MODE: "sarvam", SARVAM_API_KEY: KEY, ...env }).stt.sarvam.languageCode;
    expect(lang({})).toBe("en-IN");
    expect(lang({ WISPR_LANGUAGES: "hi" })).toBe("hi-IN");
    expect(lang({ WISPR_LANGUAGES: "en,hi" })).toBe("unknown");
    expect(lang({ WISPR_LANGUAGES: "fr" })).toBe("unknown"); // not one Sarvam serves
    expect(lang({ SARVAM_LANGUAGE: "ta-IN" })).toBe("ta-IN");
    expect(lang({ SARVAM_LANGUAGE: "unknown" })).toBe("unknown");
    expect(cfg({ WISPR_MODE: "sarvam", SARVAM_API_KEY: KEY, SARVAM_BASE_URL: "https://example.test/" }).stt.sarvam.baseUrl).toBe("https://example.test");
  });
});
