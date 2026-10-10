/* ============================================================================
 * wispr-check (core): run ONE real utterance through the real WisprStreamer and turn what happens into a checklist of the
 * assumptions listed in src/audio/README.md ("Unverified assumptions"). It is the first thing to run when a Wispr key
 * arrives: every line says what was observed, not what was hoped.
 *
 * Pure of I/O policy: the caller supplies the token source, the audio and (optionally) the socket/fetch implementations,
 * so the same code is exercised in CI against scripts/fake-wispr.mjs and by hand against the real service.
 * Nothing here logs audio; transcripts are printed only because the check speaks a synthetic sentence.
 * ========================================================================== */
import { realClock, type Clock } from "../src/audio/clock";
import type { AudioDiagnostic, WisprContext, WisprTokenInfo } from "../src/audio/types";
import { WisprStreamer, type WisprTranscript, type WsFactory } from "../src/audio/wispr";

export type Verdict = "pass" | "fail" | "unknown" | "info";

export interface CheckItem {
  id: string;
  title: string;
  verdict: Verdict;
  detail: string;
}

export interface CheckReport {
  items: CheckItem[];
  transcript?: WisprTranscript;
  failedReason?: string;
  diagnostics: AudioDiagnostic[];
  packets: number;
  /** no item failed */
  ok: boolean;
}

export interface CheckOptions {
  getToken(opts?: { force?: boolean }): Promise<WisprTokenInfo>;
  /** 16 kHz mono int16 speech */
  pcm: Int16Array;
  /** the sentence that was spoken (for a similarity score); omit when the audio is not speech */
  expect?: string;
  /** 1 = real time (default), 2 = twice as fast, 0 = as fast as possible */
  pace?: number;
  packetFormat?: "pcm16" | "wav";
  /** skip the WebSocket entirely and test the REST fallback */
  forceRest?: boolean;
  /** also send 1.5 s of silence and check how Wispr answers */
  silence?: boolean;
  /** keep an authenticated socket idle for this long before speaking (tests the server's idle timeout) */
  idleSecs?: number;
  language?: string[];
  /** where the on-device engine's relative endpoints resolve (the server's own HTTP origin); Wispr's absolute URLs ignore it */
  origin?: string;
  createSocket?: WsFactory;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  log?: (line: string) => void;
  /** how long to wait for the final text after the commit (default 8000) */
  finalTimeoutMs?: number;
}

const FRAME = 512; // 32 ms at 16 kHz: one packet
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CONTEXT: WisprContext = {
  dictionary: ["Synapse", "Sarah", "OAuth2", "cart-service"],
  conversation: [],
  language: [],
  userFirstName: "Rio",
};

function rmsOf(f: Int16Array): number {
  let s = 0;
  for (const v of f) s += (v / 32768) ** 2;
  return Math.sqrt(s / Math.max(1, f.length));
}

/** split into 512-sample frames (the last one zero-padded); every frame is a fresh buffer because the streamer takes ownership */
export function toFrames(pcm: Int16Array): Array<{ pcm: Int16Array; rms: number }> {
  const out: Array<{ pcm: Int16Array; rms: number }> = [];
  for (let i = 0; i < pcm.length; i += FRAME) {
    const f = new Int16Array(FRAME);
    f.set(pcm.subarray(i, Math.min(pcm.length, i + FRAME)));
    out.push({ pcm: f, rms: rmsOf(f) });
  }
  return out;
}

/** word-overlap similarity (0..1) between what was said and what came back, ignoring case and punctuation */
export function similarity(a: string, b: string): number {
  const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

interface Outcome {
  transcript?: WisprTranscript;
  failed?: string;
  packets: number;
  /** wall time from the first frame to the final text */
  totalMs: number;
}

export async function runWisprCheck(o: CheckOptions): Promise<CheckReport> {
  const log = o.log ?? (() => undefined);
  const clock = o.clock ?? realClock;
  const pace = o.pace ?? 1;
  const diagnostics: AudioDiagnostic[] = [];
  const items: CheckItem[] = [];
  const add = (id: string, title: string, verdict: Verdict, detail: string): void => {
    items.push({ id, title, verdict, detail });
  };

  let tokenInfo: WisprTokenInfo | undefined;
  const getToken: CheckOptions["getToken"] = async (opts) => {
    tokenInfo = await o.getToken(opts);
    return tokenInfo;
  };

  const idle = Math.max(0, o.idleSecs ?? 0);
  const streamer = new WisprStreamer({
    deviceId: "wispr-check",
    sessionId: `check-${Date.now().toString(36)}`,
    getToken,
    getContext: () => ({ ...CONTEXT, language: o.language ?? [] }),
    ...(o.origin ? { origin: o.origin } : {}),
    clock,
    ...(o.forceRest
      ? {
          createSocket: () => {
            throw new Error("WebSocket disabled for the REST check");
          },
        }
      : o.createSocket
        ? { createSocket: o.createSocket }
        : {}),
    ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}),
    packetFormat: o.packetFormat ?? "pcm16",
    finalTimeoutMs: o.finalTimeoutMs ?? 8000,
    // an idle test must not let the streamer recycle the socket on its own
    standbyMaxAgeMs: idle ? (idle + 120) * 1000 : 45_000,
    emit: (d) => {
      diagnostics.push(d);
      if (d.kind === "standby") log(`  · standby ${d.state}${d.assumed ? " (assumed)" : ""}${d.detail ? `: ${d.detail}` : ""}`);
      else if (d.kind === "fallback") log(`  · fallback to REST: ${d.reason}`);
      else if (d.kind === "latency") log(`  · commit → final ${Math.round(d.commitToFinalMs)} ms over ${d.transport}`);
      else if (d.kind === "anomaly") log(`  · anomaly: ${d.detail}`);
    },
  });

  const fail = (msg: string): CheckReport => {
    streamer.stop();
    add("run", "the check itself", "fail", msg);
    return { items, diagnostics, packets: 0, ok: false };
  };

  // ---- 1. token + standby socket
  /** the server pointed the browser at the on-device engine instead of Wispr */
  let local = false;
  let ackSeen: "yes" | "assumed" | "no" = "no";
  let standbyError = "";
  const standbyEvents = (): AudioDiagnostic[] => diagnostics.filter((d) => d.kind === "standby");
  if (o.forceRest) {
    streamer.start(); // sockets cannot be created, so the utterance is collected and goes out over REST
  } else {
    log("connecting the standby socket ...");
    streamer.start();
    const t0 = clock.now();
    while (clock.now() - t0 < 12_000 && !streamer.standbyReady) {
      await sleep(40);
      const down = standbyEvents().find((d) => d.kind === "standby" && d.state === "down" && !d.assumed);
      if (down && down.kind === "standby") {
        standbyError = down.detail ?? "closed";
        break;
      }
    }
    const ready = standbyEvents().filter((d) => d.kind === "standby" && d.state === "ready");
    ackSeen = !streamer.standbyReady ? "no" : ready.some((d) => d.kind === "standby" && !d.assumed) ? "yes" : "assumed";
    if (!tokenInfo) return fail("no token was requested: the Synapse server did not hand out a speech token");
    const tok = tokenInfo;
    if ((tok.mode !== "client" && tok.mode !== "local") || !tok.token) return fail(`token mode is "${tok.mode}"${tok.error ? ` (${tok.error})` : ""}: set WISPR_MODE=client and WISPR_API_KEY on the server (or WISPR_MODE=local for on-device speech)`);
    local = tok.mode === "local";
    add("token", local ? "server hands out a short-lived on-device token" : "server mints a short-lived client token", "pass", `ttl ${tok.expiresAt ? Math.round((tok.expiresAt - clock.now()) / 1000) : "?"} s, ${local ? `endpoint ${tok.wsUrl ?? "?"}${tok.note ? ` (${tok.note})` : ""}` : `wsUrl host ${hostOf(tok.wsUrl)}`}`);
    if (ackSeen === "yes") add("A1+A5", 'client_ws accepts auth (token also in the auth message) and answers {"status":"auth"}', "pass", "the explicit auth acknowledgement arrived");
    else if (ackSeen === "assumed") add("A1+A5", 'client_ws accepts auth and answers {"status":"auth"}', "unknown", "the socket stayed open but Wispr never sent an auth acknowledgement: it was only ASSUMED ready after the 3 s timeout (harmless, but the streamer is relying on a guess)");
    else add("A1+A5", "client_ws accepts auth", "fail", standbyError ? `the socket was rejected or closed: ${standbyError}. Check that the JWT is also sent in auth.access_token, and the key is approved` : "the standby socket never became ready within 12 s");
    if (ackSeen === "no") {
      streamer.stop();
      return { items, diagnostics, packets: 0, ok: false };
    }
  }

  // ---- 2. idle timeout
  if (idle && !o.forceRest) {
    log(`keeping the authenticated socket idle for ${idle} s ...`);
    const t0 = clock.now();
    let droppedAt = -1;
    while (clock.now() - t0 < idle * 1000) {
      await sleep(250);
      if (standbyEvents().some((d) => d.kind === "standby" && d.state === "down" && !d.assumed)) {
        droppedAt = Math.round((clock.now() - t0) / 1000);
        break;
      }
    }
    if (droppedAt < 0) add("A2", `an authenticated but silent socket survives ${idle} s`, "pass", `still open after ${idle} s: the default recycle (WISPR_STANDBY_MAX_AGE_MS 45000) is safe`);
    else add("A2", "idle timeout of an authenticated socket", "fail", `Wispr closed it after ~${droppedAt} s: set WISPR_STANDBY_MAX_AGE_MS to ${Math.max(5000, (droppedAt - 5) * 1000)} or lower`);
  }

  // ---- 3. one real utterance
  const speak = async (pcm: Int16Array, label: string): Promise<Outcome> => {
    const frames = toFrames(pcm);
    const t0 = clock.now();
    return new Promise<Outcome>((resolve) => {
      let done = false;
      let handle: ReturnType<WisprStreamer["claim"]> | undefined;
      let sent = 0; // read before the commit: the handle forgets its buffers once the utterance settles
      const finish = (r: Omit<Outcome, "packets" | "totalMs">): void => {
        if (done) return;
        done = true;
        resolve({ ...r, packets: sent, totalMs: clock.now() - t0 });
      };
      handle = streamer.claim({
        fragmentId: `check-${label}`,
        packetsPerAppend: 4,
        onTranscript: (t) => finish({ transcript: t }),
        onFailed: (r) => finish({ failed: r }),
      });
      const guard = setTimeout(() => finish({ failed: "no answer within the check's own timeout" }), (o.finalTimeoutMs ?? 8000) + 15_000);
      guard.unref?.();
      const h = handle;
      void (async () => {
        const pre = Math.min(10, frames.length);
        h.pushPreroll(frames.slice(0, pre));
        for (let i = pre; i < frames.length; i++) {
          const f = frames[i] as { pcm: Int16Array; rms: number };
          h.push(f.pcm, f.rms);
          if (pace > 0) await sleep(32 / pace);
        }
        sent = h.packetCount;
        log(`  · committing ${sent} packets (${((sent * FRAME) / 16000).toFixed(1)} s of audio)`);
        h.commit();
      })();
    });
  };

  log("speaking one utterance ...");
  const main = await speak(o.pcm, "speech");
  const tr = main.transcript;
  local = (tokenInfo as WisprTokenInfo | undefined)?.mode === "local"; // also right for the REST-only check, which never inspected the token above
  const who = local ? "the on-device engine" : "Wispr";
  /** the answer came over REST (forced, a fallback after the socket failed, or Wispr's own REST label): the on-device engine reports one transport for both */
  const overRest = o.forceRest === true || tr?.transport === "wispr_rest" || diagnostics.some((d) => d.kind === "fallback");
  if (main.failed || !tr) {
    add("A3", `${who} accepts ${o.packetFormat === "wav" ? "per-packet WAV" : "raw int16 PCM packets"} and returns text`, "fail", `${main.failed ?? "no transcript"}.${o.packetFormat === "wav" ? "" : " If Wispr rejected the packets, rerun with --packets wav (per-packet RIFF header) and set WISPR_PACKET_FORMAT=wav"}`);
  } else {
    const latency = Math.round(tr.tFinal - tr.tCommitSent);
    const fell = diagnostics.find((d) => d.kind === "fallback");
    const wsRescued = !o.forceRest && overRest;
    const what = o.forceRest ? "REST accepts a 16 kHz mono WAV and returns text" : `${who} accepts ${o.packetFormat === "wav" ? "per-packet WAV" : "raw int16 PCM packets"} and returns text`;
    if (wsRescued) add("A3", what, "fail", `the WebSocket path FAILED (${fell && fell.kind === "fallback" ? fell.reason : "no final text"}); only the REST fallback produced text.${o.packetFormat === "wav" ? "" : " If Wispr rejected the packets, rerun with --packets wav (per-packet RIFF header) and set WISPR_PACKET_FORMAT=wav"}`);
    else add("A3", what, tr.text.trim() ? "pass" : "unknown", tr.text.trim() ? `${overRest ? "over REST" : "over the WebSocket"}, ${main.packets} packets` : "an empty transcript came back for speech: the audio may be too quiet or the voice unintelligible");
    add("A4", "commit → final latency", "info", `${latency} ms over ${overRest ? "REST" : "the WebSocket"}${local ? " (Whisper on this machine: the encoder always reads a 30 s window, so expect 0.6 to 1.5 s whatever the length)" : tr.transport === "wispr_ws" ? " (the pre-authenticated standby removes connect+auth from this path)" : ""}`);
    if (o.forceRest) add("REST", "REST fallback works", (tr.transport === "wispr_rest" || tr.transport === "local_stt") && tr.text.trim() ? "pass" : "fail", `transport ${tr.transport}`);
    if (o.expect && tr.text.trim()) {
      const sim = similarity(o.expect, tr.text);
      add("heard", "what was heard", sim >= 0.6 ? "pass" : "unknown", `"${tr.text.trim()}" (word overlap with what was spoken: ${Math.round(sim * 100)} %)`);
    } else if (tr.text.trim()) add("heard", "what was heard", "info", `"${tr.text.trim()}"`);
    if (tr.detectedLanguage) add("lang", "language detection", "info", tr.detectedLanguage);
  }
  const finals = diagnostics.filter((d) => d.kind === "anomaly");
  add("A6", "exactly one final per commit, none before it", finals.length ? "fail" : tr ? "pass" : "unknown", finals.length ? finals.map((d) => (d.kind === "anomaly" ? d.detail : "")).join("; ") : "no protocol anomaly was reported by the streamer");

  // ---- 4. silence
  if (o.silence) {
    log("sending 1.5 s of silence ...");
    const quiet = await speak(new Int16Array(24_000), "silence");
    if (quiet.failed) add("A6b", "silence returns an empty transcript (or nothing)", "unknown", `the request ended with: ${quiet.failed}`);
    else add("A6b", "silence returns an empty transcript", quiet.transcript && !quiet.transcript.text.trim() ? "pass" : "info", quiet.transcript ? `Wispr answered with ${quiet.transcript.text.trim() ? `"${quiet.transcript.text.trim()}"` : "an empty text"}` : "no answer");
  }

  // ---- 5. things that cannot be checked from Node
  if (local) add("A7", "browser origin rules", "info", "the on-device endpoints are served from the same origin as the page (through the Vite proxy), so CORS is not involved; the server still refuses an origin that is not local or on a private network");
  else add("A7", "browser CORS / Origin rules for client_ws and the REST fallback", "unknown", "Node has no CORS. Confirm in the browser: Lab → Audio diagnostics shows no 'fallback' events during a real mic run");
  add("A10", "whispered speech is segmented and transcribed", "unknown", "needs a real voice in a real room (say a whispered sentence on the Desk)");

  streamer.stop();
  const ok = !items.some((i) => i.verdict === "fail");
  return { items, ...(tr ? { transcript: tr } : {}), ...(main.failed ? { failedReason: main.failed } : {}), diagnostics, packets: main.packets, ok };
}

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).host : "?";
  } catch {
    return "?";
  }
}

/** a plain-text rendering of a report (what the CLI prints) */
export function renderReport(r: CheckReport): string {
  const icon: Record<Verdict, string> = { pass: "PASS   ", fail: "FAIL   ", unknown: "UNKNOWN", info: "INFO   " };
  const lines = r.items.map((i) => `${icon[i.verdict]} ${i.id.padEnd(6)} ${i.title}\n          ${i.detail}`);
  const fails = r.items.filter((i) => i.verdict === "fail").length;
  const unknown = r.items.filter((i) => i.verdict === "unknown").length;
  lines.push("", r.ok ? `RESULT: no failures${unknown ? `, ${unknown} item(s) need a human or a browser` : ""}.` : `RESULT: ${fails} failure(s). Fix those first (details above), then rerun.`);
  return lines.join("\n");
}
