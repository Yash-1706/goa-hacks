import { randomBytes } from "node:crypto";
import type { CaptureContext, CaptureResponse, CaptureSource, CaptureView, FragmentFinal, ServerMessage } from "@synapse/shared";
import type { Clock } from "../clock";
import type { DeviceRef } from "../ctx";
import type { CortexEngine } from "../cortex/engine";
import { log } from "../log";
import { KeyDestroyedError } from "../memory/crypto";
import type { Db } from "../memory/db";
import type { MemoryStore } from "../memory/store";
import type { LocalStt } from "../wispr/local-stt";
import { segmentIntents } from "./segment";
import { WavError, parseWav } from "./wav";

/* ============================================================================
 * POST /api/capture (V1): one endpoint for every client. Typed text, or a WAV that is transcribed in memory (Sarvam, or the
 * on-device engine in local-only mode), is cut into intents and fed through the same engine path as the microphone, one
 * fragment per intent. The response waits for the cards (bounded); they also stream to every device over the WebSocket.
 *
 * Privacy: the audio is parsed, transcribed and zero-filled in memory; it is never written anywhere. A capture record holds
 * ids and the routing context (sealed with the capture's day key, so it is shredded with working memory), never the
 * transcript: a retry rebuilds that from the fragments that still exist.
 * ========================================================================== */

export interface CaptureInput {
  text?: string;
  /** a WAV file's bytes; zero-filled by the service once transcribed */
  audio?: Uint8Array;
  context?: CaptureContext;
  clientId?: string;
  capturedAt?: number;
}

interface CaptureDetail {
  fragmentIds: string[];
  context: CaptureContext;
}

interface CaptureRow {
  id: string;
  client_id: string | null;
  source: string;
  session_id: string;
  key_id: string;
  detail_enc: Uint8Array;
  captured_at: number;
  created_at: number;
}

export interface CaptureDeps {
  db: Db;
  clock: Clock;
  store: MemoryStore;
  engine: Pick<CortexEngine, "handleFragment" | "finalizeDevice" | "idle">;
  isPaused: () => boolean;
  /** the speech engine for this capture: Sarvam, or on-device Whisper (always Whisper in local-only mode) */
  stt: () => { stt: LocalStt; provider: "sarvam" | "whisper" };
  emit: (m: ServerMessage) => void;
  /** how long the response waits for the cards (default 15 s); later cards still stream over the WebSocket */
  waitMs?: number;
  ttlHours: number;
}

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

const MAX_AUDIO_SECONDS = 5 * 60;
/** pause before a segment that starts a new thought: long enough that the stitcher never joins it to the thought before */
const NEW_THOUGHT_GAP_MS = 9000;
const CONTINUATION_GAP_MS = 600;

export class CaptureService {
  private inflight = new Map<string, Promise<CaptureResponse>>();
  private deviceLocks = new Map<string, Promise<unknown>>();

  constructor(private d: CaptureDeps) {}

  async capture(input: CaptureInput): Promise<CaptureResponse> {
    const { clientId } = input;
    if (clientId) {
      // still running: share its result (its row already exists, but its thoughts do not yet)
      const running = this.inflight.get(clientId);
      if (running) return running.then((r) => ({ ...r, duplicate: true }));
      const stored = this.byClientId(clientId);
      if (stored) return { ...stored, duplicate: true };
    }
    const job = this.run(input);
    if (clientId) {
      this.inflight.set(clientId, job);
      void job.finally(() => this.inflight.delete(clientId)).catch(() => undefined);
    }
    return job;
  }

  /** The context a thought was captured with (Phase 3 routes a GitHub issue to `context.repo`). */
  contextFor(thoughtId: string): CaptureContext | undefined {
    const t = this.d.store.getThought(thoughtId);
    if (!t) return undefined;
    const row = this.d.db.get<CaptureRow>("SELECT * FROM captures WHERE session_id = ?", t.sessionId);
    return row ? this.detail(row)?.context : undefined;
  }

  /** Recent captures, newest first. Thoughts that were forgotten since drop out of the list. */
  list(limit = 20): CaptureView[] {
    const rows = this.d.db.all<CaptureRow>("SELECT * FROM captures ORDER BY created_at DESC LIMIT ?", Math.max(1, Math.min(200, limit)));
    return rows.flatMap((row) => {
      const det = this.detail(row);
      return det ? [this.view(row, det)] : [];
    });
  }

  // ------------------------------------------------------------------ inside --

  private async run(input: CaptureInput): Promise<CaptureResponse> {
    const { clock, store } = this.d;
    const context: CaptureContext = input.context ?? { source: "web" };
    const captureId = `cap-${clock.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    if (this.d.isPaused()) {
      input.audio?.fill(0);
      return { captureId, transcript: "", thoughtIds: [], paused: true };
    }

    let transcript: string;
    let transport: FragmentFinal["transport"] = "typed";
    let language: string | undefined;
    if (input.audio) {
      let pcm: Float32Array;
      try {
        pcm = parseWav(input.audio, { maxSeconds: MAX_AUDIO_SECONDS });
      } catch (err) {
        throw new CaptureError(err instanceof WavError ? err.message : "unreadable audio", 400);
      } finally {
        input.audio.fill(0);
      }
      const { stt, provider } = this.d.stt();
      try {
        const r = await stt.transcribe(pcm);
        transcript = r.text;
        language = r.language;
      } catch (err) {
        log.warn("capture", "transcription failed", { provider, error: (err as Error).name });
        // 503, not 502: Cloudflare replaces an origin 502 with its own HTML page; 503 also tells a client queue to retry later
        throw new CaptureError(`speech to text failed (${provider})`, 503);
      } finally {
        pcm.fill(0);
      }
      transport = provider === "sarvam" ? "cloud_stt" : "local_stt";
    } else {
      transcript = (input.text ?? "").trim();
      if (!transcript) throw new CaptureError("nothing to capture: send text or audio", 400);
    }

    const segments = segmentIntents(transcript);
    const dev = deviceFor(context.source);
    const sessionId = `${captureId}-s`;
    const fragmentIds = segments.map((_, i) => `${captureId}-${i}`);
    const now = clock.now();
    const capturedAt = input.capturedAt ?? now;

    // sealed with the working key of the day: shredded together with the fragments it points at
    const keyId = store.vault.workingKeyId(now);
    const detail: CaptureDetail = { fragmentIds, context };
    this.d.db.run(
      "INSERT INTO captures(id, client_id, source, session_id, key_id, detail_enc, captured_at, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      captureId,
      input.clientId ?? null,
      context.source,
      sessionId,
      keyId,
      store.vault.sealJson(keyId, `capture|${captureId}`, detail),
      capturedAt,
      now,
      store.workingExpiry(now),
    );
    this.pruneExpired(now);

    let pending = false;
    if (segments.length) {
      await this.withDevice(dev.id, async () => {
        store.ensureSession(sessionId, dev.id, dev.kind, dev.activity);
        let cursor = clock.now();
        for (const [i, seg] of segments.entries()) {
          if (seg.startsThought && i > 0) await this.d.engine.finalizeDevice(dev.id);
          const gap = i === 0 ? 0 : seg.startsThought ? NEW_THOUGHT_GAP_MS : CONTINUATION_GAP_MS;
          const dur = Math.max(700, seg.text.split(/\s+/).length * 330);
          const start = cursor + gap;
          cursor = start + dur;
          await this.d.engine.handleFragment(dev, {
            type: "fragment.final",
            fragmentId: fragmentIds[i] as string,
            sessionId,
            text: seg.text,
            ...(language ? { detectedLanguage: language.slice(0, 16) } : {}),
            t: { speechStart: start, speechEnd: cursor, commitSent: cursor, wisprFinal: cursor },
            durationMs: dur,
            pauseBeforeMs: gap,
            rmsMean: 0.08,
            rmsMax: 0.2,
            whisper: false,
            activity: dev.activity,
            transport,
          });
        }
        pending = !(await this.settle(dev.id));
      });
    }

    const thoughtIds = this.thoughtsOf(fragmentIds);
    const view: CaptureView = { captureId, ...(input.clientId ? { clientId: input.clientId } : {}), source: context.source, createdAt: now, capturedAt, thoughtIds };
    this.d.emit({ type: "capture.done", capture: view });
    log.info("capture", "captured", { id: captureId, source: context.source, chars: transcript.length, segments: segments.length, thoughts: thoughtIds.length, transport });
    return { captureId, transcript, thoughtIds, ...(pending ? { pending: true } : {}) };
  }

  /** Close the capture's threads and wait for the analysis, at most `waitMs`. A correction reopens its target, hence the loop. */
  private async settle(deviceId: string): Promise<boolean> {
    const deadline = Date.now() + (this.d.waitMs ?? 15_000);
    for (let round = 0; round < 3; round++) {
      await this.d.engine.finalizeDevice(deviceId);
      const left = deadline - Date.now();
      if (left <= 0) return false;
      try {
        await this.d.engine.idle(left);
      } catch {
        return false;
      }
    }
    await this.d.engine.finalizeDevice(deviceId);
    return true;
  }

  /** Captures from one source run one at a time: segments of two captures must never interleave on one device's threads. */
  private async withDevice<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.deviceLocks.get(deviceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.deviceLocks.set(
      deviceId,
      next.catch(() => undefined),
    );
    return next;
  }

  private thoughtsOf(fragmentIds: string[]): string[] {
    const ids: string[] = [];
    for (const fid of fragmentIds) {
      const tid = this.d.store.frags.get(fid)?.thoughtId;
      const t = tid ? this.d.store.getThought(tid) : undefined;
      if (t && !t.retracted && !ids.includes(t.id)) ids.push(t.id);
    }
    return ids;
  }

  private byClientId(clientId: string): CaptureResponse | null {
    const row = this.d.db.get<CaptureRow>("SELECT * FROM captures WHERE client_id = ?", clientId);
    if (!row) return null;
    const det = this.detail(row);
    if (!det) return null;
    const transcript = det.fragmentIds
      .map((fid) => this.d.store.frags.get(fid)?.text)
      .filter(Boolean)
      .join(" ");
    return { captureId: row.id, transcript, thoughtIds: this.thoughtsOf(det.fragmentIds) };
  }

  private detail(row: CaptureRow): CaptureDetail | null {
    try {
      return this.d.store.vault.openJson<CaptureDetail>(row.key_id, `capture|${row.id}`, row.detail_enc);
    } catch (err) {
      if (err instanceof KeyDestroyedError) {
        this.d.db.run("DELETE FROM captures WHERE id = ?", row.id); // its day key is gone: so is everything it pointed at
        return null;
      }
      throw err;
    }
  }

  private view(row: CaptureRow, det: CaptureDetail): CaptureView {
    return {
      captureId: row.id,
      ...(row.client_id ? { clientId: row.client_id } : {}),
      source: row.source as CaptureSource,
      createdAt: row.created_at,
      capturedAt: row.captured_at,
      thoughtIds: this.thoughtsOf(det.fragmentIds),
    };
  }

  private pruneExpired(now: number): void {
    this.d.db.run("DELETE FROM captures WHERE expires_at IS NOT NULL AND expires_at < ?", now);
  }
}

/** One stable device per source: a correction ("actually make it 7") finds the card it corrects on the same device. */
export function deviceFor(source: CaptureSource): DeviceRef {
  const pocket = source === "android" || source === "ios";
  return { id: `capture-${source}`, kind: pocket ? "pocket" : "desk", activity: pocket ? "unknown" : "desk" };
}
