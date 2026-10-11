import {
  ACTIONABLE_CATEGORIES,
  type Artifact,
  type CortexResult,
  type FragmentFinal,
  type ReferenceView,
  type ServerMessage,
  type ThoughtView,
} from "@synapse/shared";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { Autonomy, Controls, DeviceRef, EmitFn, Hub } from "../ctx";
import type { ControlIntents } from "../gate/intent";
import type { Triage, Triager } from "../gate/triage";
import { log, safe } from "../log";
import { centroid, dot, type Embedder } from "../memory/embeddings";
import { graphDeltaFor } from "../memory/graph";
import type { MemoryStore } from "../memory/store";
import type { EntityRec, FragRec, ThoughtRec } from "../memory/types";
import type { Metrics } from "../metrics/latency";
import { fold, normalizeText, quickTitle, textFeatures, type TextFeatures } from "../text";
import { LIMITS, T } from "../thresholds";
import { computeSalience } from "./salience";
import { ambiguity, buildCandidates, recentThoughts } from "./resolver";
import type { Candidate, CortexBackend, CortexInput, CortexOutput } from "./types";

/* ============================================================================
 * Cortex engine (TRD §6): the per-fragment pipeline.
 *
 *   fragment.final → embed → control intents → triage → noise skip → stitch into a thread
 *   → persist → PROVISIONAL card on the wire (first paint)
 *   → coalesced model call (streamed; card morphs as tokens arrive) → apply:
 *       split / merge / correction handling · entities · graph edges · artifact · salience
 *   → thread closes after silence → finalize (promote or expire) → detectors fire
 * ========================================================================== */

export interface EngineDeps {
  cfg: Config;
  clock: Clock;
  bus: Bus;
  store: MemoryStore;
  embedder: Embedder;
  triager: Triager;
  intents: ControlIntents;
  backend: CortexBackend;
  emit: EmitFn;
  hub: Hub;
  metrics: Metrics;
  autonomy: Autonomy;
  controls: Controls;
  /** shared counter of fragments filtered as asides/noise (never stored) */
  asides: { count: number };
  /** recall engine hook for recall_query thoughts */
  onRecallQuery?: (t: ThoughtRec, dev: DeviceRef) => void;
  /** jargon the user is known to use */
  vocabulary: () => string[];
  /** the people the cortex knows (V1: from the profile; USER_TEAM otherwise) */
  team?: () => Config["user"]["team"];
}

interface Thread {
  thoughtId: string;
  dev: DeviceRef;
  sessionId: string;
  fragIds: string[];
  embs: Float32Array[];
  centroid: Float32Array;
  lastSpeechEnd: number;
  lastRecvAt: number;
  lastFragmentId: string;
  closed: boolean;
  closedAt: number;
  inflight: boolean;
  dirty: boolean;
  finalizeWhenIdle: boolean;
  timer?: ReturnType<typeof setTimeout>;
  lastResult?: CortexResult;
  llmStartWall?: number;
  /** creation order: a correction only ever waits for an older thread, so two threads can never wait for each other */
  seq: number;
  /** this thread's analysis loop while `inflight` (a correction waits for its target's) */
  run?: Promise<void>;
}

const WORKING_WORDS = 300;
const RETRACTION = /\b(scratch that|undo that|never ?mind (that|the last)|forget that one|delete that|take that back|ignore that)\b/i;
const RETRACTION_ALL = new RegExp(RETRACTION.source, "gi");
const RETRACTION_FILLER = /\b(ok(?:ay)?|so|yeah|yes|no|please|just|sorry|oops|um+|uh+|hmm+)\b/gi;

/** "Scratch that." alone: it needs no card to act on, so it never waits for one. "Scratch that, make it Friday" is a revision. */
function isPureRetraction(text: string): boolean {
  if (!RETRACTION.test(text)) return false;
  return text.replace(RETRACTION_ALL, " ").replace(RETRACTION_FILLER, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).length <= 1;
}

const codeSeq = (code: string): number => Number(code.replace(/^\D+/, "")) || 0;

export class CortexEngine {
  private open = new Map<string, Thread>();
  private recentClosed = new Map<string, Thread>();
  private byThought = new Map<string, Thread>();
  private queues = new Map<string, Promise<void>>();
  /** every analysis loop that is running, including one whose thread was dropped halfway (a correction merged into its target) */
  private runs = new Set<Promise<void>>();
  private seq = 0;
  private shuttingDown = false;
  /** V1.1: offline drafts waiting for the model (the re-draft queue) */
  private improving = new Set<string>();

  constructor(private d: EngineDeps) {}

  // ----------------------------------------------------------------- public --

  /** Entry point for every transcribed fragment. Per-device FIFO so order is preserved. */
  handleFragment(dev: DeviceRef, msg: FragmentFinal): Promise<void> {
    const prev = this.queues.get(dev.id) ?? Promise.resolve();
    const next = prev.then(() => this.process(dev, msg)).catch((err) => log.error("engine", `fragment failed: ${(err as Error).message}`));
    this.queues.set(dev.id, next);
    return next;
  }

  isAnalyzing(thoughtId: string): boolean {
    return Boolean(this.byThought.get(thoughtId)?.inflight);
  }

  /** Resolve once every queued fragment is processed and no analysis is running (tests, seeding, replays). A model call may also queue for the provider's token budget (Groq's free tier), which the default allows for. */
  async idle(timeoutMs = this.patienceMs()): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      await Promise.allSettled([...this.queues.values()]);
      // `runs`, not only the registered threads: a merged correction leaves `byThought` while it is still writing the revised card
      const busy = this.runs.size > 0 || [...this.byThought.values()].some((th) => th.inflight || th.dirty);
      if (!busy) return;
      if (Date.now() - t0 > timeoutMs) throw new Error("engine did not become idle in time");
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Finalize every open thread now (end of a seeded or replayed session). */
  async finalizeAll(): Promise<void> {
    await this.idle();
    for (const th of [...this.open.values()]) if (!th.closed) await this.close(th, true);
    await this.idle();
  }

  view(t: ThoughtRec): ThoughtView {
    return { ...this.d.store.toView(t), analyzing: this.isAnalyzing(t.id), improving: this.improving.has(t.id) };
  }

  /** Show (or clear) "improving…" on a card waiting for the model to re-draft it. */
  setImproving(thoughtId: string, on: boolean): void {
    if (on === this.improving.has(thoughtId)) return;
    if (on) this.improving.add(thoughtId);
    else this.improving.delete(thoughtId);
    const t = this.d.store.getThought(thoughtId);
    if (t) this.d.emit({ type: "thought.upsert", thought: this.view(t) });
  }

  /** Draft an existing thought again with what was said (the re-draft queue): the result is applied in place, never as a new card. */
  async reanalyze(thoughtId: string): Promise<void> {
    const t = this.d.store.getThought(thoughtId);
    if (!t) return;
    const existing = this.byThought.get(thoughtId);
    if (existing?.inflight) return;
    const th =
      existing ??
      this.adoptThread(t, { dev: { id: t.deviceId, kind: t.deviceKind, activity: t.activity }, lastSpeechEnd: t.updatedAt, lastRecvAt: t.updatedAt, lastFragmentId: "" } as unknown as Thread);
    th.lastResult = undefined;
    th.inflight = true;
    try {
      await this.analyzeOnce(th);
    } finally {
      th.inflight = false;
    }
  }

  /** Close every open thread (session end / shutdown). */
  async finalizeDevice(deviceId: string): Promise<void> {
    const th = this.open.get(deviceId);
    if (th && !th.closed) await this.close(th, true);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const th of this.byThought.values()) if (th.timer) clearTimeout(th.timer);
    await Promise.allSettled([...this.queues.values()]);
  }

  /** Drop all in-flight state for thoughts that were deleted (purge / forget / TTL). */
  forgetThoughts(ids: Iterable<string>): void {
    for (const id of ids) {
      const th = this.byThought.get(id);
      if (!th) continue;
      if (th.timer) clearTimeout(th.timer);
      th.closed = true;
      this.byThought.delete(id);
      if (this.open.get(th.dev.id) === th) this.open.delete(th.dev.id);
      if (this.recentClosed.get(th.dev.id) === th) this.recentClosed.delete(th.dev.id);
    }
  }

  /** Forget every open thread of every device (used by pause). */
  closeAllWithoutAnalysis(): void {
    for (const th of this.byThought.values()) if (th.timer) clearTimeout(th.timer);
    this.open.clear();
    this.recentClosed.clear();
    this.byThought.clear();
  }

  // ----------------------------------------------------------- fragment path --

  private async process(dev: DeviceRef, msg: FragmentFinal): Promise<void> {
    const { store, clock, embedder, triager, intents, hub, metrics } = this.d;
    const recvWall = clock.now();
    const p0 = performance.now();

    if (this.d.controls.isPaused()) {
      this.d.emit({ type: "fragment.filtered", fragmentId: msg.fragmentId, reason: "paused", asideCount: this.d.asides.count });
      return;
    }
    if (store.frags.has(msg.fragmentId)) return;

    const text = normalizeText(msg.text);
    const feat = textFeatures(text);
    if (!feat.wordCount) return;

    metrics.server(msg.fragmentId, dev.id, {
      transport: msg.transport,
      speechEnd: msg.t.speechEnd,
      commitSent: msg.t.commitSent,
      wisprFinal: msg.t.wisprFinal,
      serverRecv: recvWall,
      offset: hub.clockOffset(dev.id),
    });

    // 1. embed, then control intents (pause / forget) BEFORE anything is stored
    const [emb] = await embedder.embed([text], "passage");
    if (!emb) return;
    const tEmbed = performance.now();
    const control = intents.detect(text, emb);
    if (control) {
      await this.d.controls.handle(control, dev, control.kind === "pause" && control.via === "semantic" ? "semantic" : "voice");
      return;
    }

    // 2. local triage + noise skip (asides are counted, never stored)
    const tri = triager.classify(text, emb, feat);
    const tTriage = performance.now();
    const existing = this.open.get(dev.id);
    const noise = feat.disfluentOnly || (tri.pNoise >= T.noiseSkip && feat.contentWordCount <= 3);
    if (noise) {
      if (!feat.disfluentOnly) {
        this.d.asides.count++;
        this.d.emit({ type: "fragment.filtered", fragmentId: msg.fragmentId, reason: "aside", asideCount: this.d.asides.count });
      }
      if (existing && !existing.closed) {
        existing.lastSpeechEnd = Math.max(existing.lastSpeechEnd, msg.t.speechEnd);
        this.resetTimer(existing); // the speaker is still thinking: keep the thread open
      }
      return;
    }

    // 3. stitch into an open (or just-closed) thread, or start a new one
    const thread = this.pickThread(dev, msg, emb, feat, tri) ?? this.newThread(dev, msg, text, emb, tri);
    const thought = store.getThought(thread.thoughtId) as ThoughtRec;

    // 4. persist the fragment (encrypted) and update the thread
    const frag = store.addFragment(
      {
        id: msg.fragmentId,
        sessionId: msg.sessionId,
        thoughtId: thought.id,
        deviceId: dev.id,
        text,
        tStart: msg.t.speechStart,
        tEnd: msg.t.speechEnd,
        pauseBeforeMs: msg.pauseBeforeMs,
        durationMs: msg.durationMs,
        rmsMean: msg.rmsMean,
        whisper: msg.whisper,
        lang: msg.detectedLanguage,
        activity: msg.activity ?? dev.activity,
        transport: msg.transport,
        emb,
      },
      thought,
    );
    thread.fragIds.push(frag.id);
    thread.embs.push(emb);
    thread.centroid = centroid(thread.embs);
    thread.lastSpeechEnd = msg.t.speechEnd;
    thread.lastRecvAt = recvWall;
    thread.lastFragmentId = frag.id;

    // 5. provisional card from local triage → FIRST PAINT
    if (thought.provisional) {
      const joined = this.joinedText(thought);
      thought.title = quickTitle(joined);
      thought.intent = joined.slice(0, 280);
      thought.category = tri.label;
      thought.confidence = Math.min(0.5, tri.confidence * 0.6);
      thought.source = "local";
    }
    const firstPaintEmit = clock.now();
    thought.timing = {
      ...thought.timing,
      serverRecv: thought.timing.serverRecv ?? recvWall,
      embedMs: Math.round(tEmbed - p0),
      triageMs: Math.round(tTriage - tEmbed),
      firstPaintEmit,
      fragToFirstPaintMs: Math.round(performance.now() - p0),
      wisprMs: msg.t.commitSent !== undefined && msg.t.wisprFinal !== undefined ? msg.t.wisprFinal - msg.t.commitSent : thought.timing.wisprMs,
    };
    store.saveThought(thought);
    this.d.emit({ type: "fragment.ack", fragmentId: frag.id, thoughtId: thought.id });
    this.d.emit({ type: "thought.upsert", thought: { ...this.view(thought), analyzing: true } });
    metrics.server(frag.id, dev.id, { firstPaintEmit });
    this.d.bus.emit("fragment.added", { thoughtId: thought.id, fragmentId: frag.id, deviceId: dev.id });
    log.debug("engine", "fragment", { id: frag.id, text: safe(text), cls: tri.label, thread: thought.code, ms: Math.round(performance.now() - p0) });

    // 6. kick off (coalesced) analysis and (re)arm the silence timer
    this.resetTimer(thread);
    this.schedule(thread);
  }

  private joinedText(t: ThoughtRec): string {
    return this.d.store
      .fragmentsOf(t)
      .map((f) => f.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .split(" ")
      .slice(0, WORKING_WORDS)
      .join(" ");
  }

  // ----------------------------------------------------------------- stitching --

  private gapMs(thread: Thread, msg: FragmentFinal): number {
    const g = msg.t.speechStart - thread.lastSpeechEnd;
    if (Number.isFinite(g) && g >= 0 && g < 3_600_000) return g;
    return Math.max(0, this.d.clock.now() - thread.lastRecvAt); // clocks disagree: fall back to arrival times
  }

  /**
   * Continue score (TRD §6.4, recalibrated): pauses are thinking, not topic changes.
   * A self-repair INSIDE a thought ("maybe JWT... or no, OAuth2") continues it. A retraction or a
   * correction of a FINISHED thought ("scratch that", "actually make it Friday") never joins it:
   * it becomes its own thread that the model applies to its target.
   */
  private stitchScore(thread: Thread, msg: FragmentFinal, emb: Float32Array, feat: TextFeatures, tri: Triage): number {
    if (RETRACTION.test(msg.text)) return -1;
    const gap = this.gapMs(thread, msg);
    const base = gap < 1500 ? 0.55 : gap < 4000 ? 0.4 : gap < 8000 ? 0.2 : 0;
    const sim = Math.max(0, this.d.embedder.calibrate(dot(emb, thread.centroid)));
    const lastText = this.d.store.frags.get(thread.lastFragmentId)?.text ?? "";
    const prevIncomplete = textFeatures(lastText).incomplete;
    let s = base + 0.3 * sim;
    if (prevIncomplete) s += 0.15;
    if (feat.startsWithConnector) s += 0.1;
    if (feat.startsWithRepairCue && !thread.closed) s += 0.3;
    if (tri.probs.aside >= 0.6) s -= 0.3;
    return s;
  }

  private pickThread(dev: DeviceRef, msg: FragmentFinal, emb: Float32Array, feat: TextFeatures, tri: Triage): Thread | null {
    const options: Array<{ thread: Thread; min: number }> = [];
    const open = this.open.get(dev.id);
    if (open && !open.closed && open.sessionId === msg.sessionId) options.push({ thread: open, min: T.stitchContinue + 0.05 });
    const rc = this.recentClosed.get(dev.id);
    if (rc && rc.sessionId === msg.sessionId && this.d.clock.now() - rc.closedAt < 20_000 && this.d.store.getThought(rc.thoughtId)) {
      options.push({ thread: rc, min: 0.7 });
    }
    let best: { thread: Thread; score: number } | null = null;
    for (const o of options) {
      const score = this.stitchScore(o.thread, msg, emb, feat, tri);
      if (score >= o.min && (!best || score > best.score)) best = { thread: o.thread, score };
    }
    if (!best) {
      // a new topic closes the previous thread right away (it will be finalized)
      if (open && !open.closed) void this.close(open, true);
      return null;
    }
    const th = best.thread;
    if (th.closed) this.reopen(th);
    return th;
  }

  private newThread(dev: DeviceRef, msg: FragmentFinal, text: string, emb: Float32Array, tri: Triage): Thread {
    const { store } = this.d;
    const session = store.ensureSession(msg.sessionId, dev.id, dev.kind, msg.activity ?? dev.activity);
    const thought = store.createThought({
      sessionId: session.id,
      deviceId: dev.id,
      deviceKind: dev.kind,
      activity: msg.activity ?? dev.activity,
      category: tri.label,
      title: quickTitle(text),
      intent: text.slice(0, 280),
      emb,
      source: "local",
      confidence: Math.min(0.5, tri.confidence * 0.6),
    });
    const th: Thread = {
      thoughtId: thought.id,
      seq: ++this.seq,
      dev,
      sessionId: session.id,
      fragIds: [],
      embs: [],
      centroid: emb,
      lastSpeechEnd: msg.t.speechEnd,
      lastRecvAt: this.d.clock.now(),
      lastFragmentId: msg.fragmentId,
      closed: false,
      closedAt: 0,
      inflight: false,
      dirty: false,
      finalizeWhenIdle: false,
    };
    this.open.set(dev.id, th);
    this.byThought.set(thought.id, th);
    return th;
  }

  private reopen(th: Thread): void {
    th.closed = false;
    th.finalizeWhenIdle = false;
    this.open.set(th.dev.id, th);
    if (this.recentClosed.get(th.dev.id) === th) this.recentClosed.delete(th.dev.id);
    const t = this.d.store.getThought(th.thoughtId);
    if (t) {
      t.status = "open";
      // a reopened working thought gets a fresh retention clock
      if (!t.promoted) t.expiresAt = this.d.store.workingExpiry(this.d.clock.now());
    }
  }

  // ------------------------------------------------------------------ timers --

  private resetTimer(th: Thread): void {
    if (th.timer) clearTimeout(th.timer);
    if (this.shuttingDown) return;
    th.timer = setTimeout(() => void this.close(th, false), this.d.cfg.memory.threadCloseMs);
  }

  private async close(th: Thread, immediate: boolean): Promise<void> {
    if (th.closed) return;
    if (th.timer) clearTimeout(th.timer);
    if (th.inflight && !immediate) {
      th.finalizeWhenIdle = true;
      return;
    }
    if (th.inflight && immediate) {
      th.finalizeWhenIdle = true;
      th.closed = true;
      th.closedAt = this.d.clock.now();
      if (this.open.get(th.dev.id) === th) this.open.delete(th.dev.id);
      this.recentClosed.set(th.dev.id, th);
      return;
    }
    await this.finalize(th);
  }

  // ---------------------------------------------------------------- analysis --

  private schedule(th: Thread): void {
    if (th.inflight) {
      th.dirty = true;
      return;
    }
    const p = this.run(th); // sets `inflight` before its first await
    th.run = p;
    this.runs.add(p);
    const done = (): void => void this.runs.delete(p);
    p.then(done, (err: Error) => {
      done();
      log.error("engine", `analysis loop failed: ${err.message}`);
    });
  }

  private async run(th: Thread): Promise<void> {
    th.inflight = true;
    try {
      do {
        th.dirty = false;
        if (!this.d.store.getThought(th.thoughtId)) break;
        await this.awaitTarget(th);
        await this.analyzeOnce(th);
      } while (th.dirty && !this.shuttingDown);
    } catch (err) {
      log.error("engine", `analysis failed: ${(err as Error).message}`);
    } finally {
      th.inflight = false;
    }
    if (th.finalizeWhenIdle && this.d.store.getThought(th.thoughtId)) {
      th.finalizeWhenIdle = false;
      await this.finalize(th);
    }
  }

  /** Does this thread read as a correction of something said before: a revision ("actually make it Friday") or a retraction? */
  private readsAsCorrection(frags: FragRec[], tri: Triage, text: string): boolean {
    return frags.some((f) => textFeatures(f.text).startsWithRepairCue) || tri.probs.correction > 0.25 || /\b(scratch that|undo that|never mind|forget that one)\b/i.test(text);
  }

  /** How long to wait on a model call that may itself be queueing (Groq's free-tier token budget). */
  private patienceMs(): number {
    return 20_000 + (this.d.cfg.llm.provider === "groq" ? this.d.cfg.llm.groq.maxWaitMs : 0);
  }

  /**
   * A revision needs the card it revises. If that thought is still being analysed (a slow model, a queued call), wait for it:
   * otherwise the model is shown no card to change, and the original's late result then overwrites the revision. A plain
   * retraction needs no card, so it never waits; the late result finds its thought deleted and is discarded.
   */
  private async awaitTarget(th: Thread): Promise<void> {
    const { store, clock, triager } = this.d;
    const t = store.getThought(th.thoughtId);
    if (!t) return;
    const frags = store.fragmentsOf(t);
    if (!frags.length) return;
    const text = frags.map((f) => f.text).join(" ");
    if (!this.readsAsCorrection(frags, triager.classify(text, th.centroid, textFeatures(text)), text) || isPureRetraction(text)) return;
    const deadline = Date.now() + this.patienceMs();
    for (;;) {
      const prev = this.lastOtherThought(th, clock.now());
      const target = prev ? this.byThought.get(prev.id) : undefined;
      if (!target?.inflight || !target.run || target.seq >= th.seq) return; // only ever wait for an OLDER thread: no cycles
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([target.run.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, left)))]);
      clearTimeout(timer);
    }
  }

  private async analyzeOnce(th: Thread): Promise<void> {
    const { store, clock, embedder, triager } = this.d;
    const t = store.getThought(th.thoughtId);
    if (!t) return;
    const frags = store.fragmentsOf(t);
    if (!frags.length) return;
    const text = frags.map((f) => f.text).join(" ");
    const now = clock.now();
    const feat = textFeatures(text);
    const tri = triager.classify(text, th.centroid, feat);
    const exclude = new Set([t.id]);

    const candidates = buildCandidates(store, embedder, { text, emb: th.centroid, now, timezone: this.d.cfg.timezone, exclude, deviceKind: th.dev.kind });
    const recent = recentThoughts(store, th.dev.id, now, exclude);

    // a correction needs the thing it corrects
    let lastCard: CortexInput["lastCard"] = null;
    if (this.readsAsCorrection(frags, tri, text)) {
      const prev = this.lastOtherThought(th, now);
      if (prev) {
        const art = prev.artifactId ? store.artifacts.get(prev.artifactId) : undefined;
        lastCard = { ref: prev.code, result: { category: prev.category, title: prev.title, intent: prev.intent, artifact: art?.payload } };
      }
    }

    const input: CortexInput = {
      now,
      timezone: this.d.cfg.timezone,
      user: { name: this.d.cfg.user.firstName, role: this.d.cfg.user.role, team: this.d.team?.() ?? this.d.cfg.user.team },
      device: { kind: th.dev.kind, activity: th.dev.activity },
      threadRef: t.code,
      fragments: frags.map((f, i) => ({
        id: f.id,
        dtMs: i === 0 ? 0 : Math.max(0, f.tStart - (frags[i - 1] as FragRec).tEnd),
        text: f.text,
        whisper: f.whisper,
        pauseBeforeMs: f.pauseBeforeMs,
      })),
      previous: th.lastResult ?? null,
      lastCard,
      candidates,
      recent,
      triage: tri,
      vocabulary: this.d.vocabulary(),
    };

    th.llmStartWall = clock.now();
    t.timing = { ...t.timing, llmStart: th.llmStartWall };
    const out = await this.d.backend.analyze(input, (partial) => this.emitPartial(th, partial));
    if (!store.getThought(th.thoughtId)) return; // deleted while the model was thinking (purge / pause)
    await this.apply(th, t, out, candidates);
  }

  private lastOtherThought(th: Thread, now: number): ThoughtRec | undefined {
    return [...this.d.store.thoughts.values()]
      // provisional thoughts count: "scratch that" often arrives while the previous card is still being analysed
      .filter((x) => x.id !== th.thoughtId && x.deviceId === th.dev.id && !x.retracted && this.d.store.isRecallable(x) && now - x.createdAt < 10 * 60_000)
      // one capture creates several thoughts within the same millisecond: the creation sequence (T-n) breaks the tie
      .sort((a, b) => b.createdAt - a.createdAt || codeSeq(b.code) - codeSeq(a.code))[0];
  }

  /** Streamed preview: the card "types in" while the model is still generating. */
  private emitPartial(th: Thread, partial: Partial<CortexResult>): void {
    const t = this.d.store.getThought(th.thoughtId);
    if (!t) return;
    const view = this.view(t);
    view.analyzing = true;
    if (typeof partial.category === "string") view.category = partial.category;
    if (typeof partial.title === "string" && partial.title) view.title = partial.title;
    if (typeof partial.intent === "string" && partial.intent) view.intent = partial.intent;
    if (typeof partial.confidence === "number") view.confidence = Math.max(0, Math.min(1, partial.confidence));
    const art = partial.artifact as { kind?: string } | undefined;
    if (t.provisional && art?.kind && art.kind !== "none") {
      view.artifact = {
        id: "preview",
        code: "…",
        kind: art.kind as Artifact["kind"],
        status: "draft",
        autonomyLevel: 0,
        payload: art as Artifact, // partial while streaming
        createdAt: this.d.clock.now(),
        updatedAt: this.d.clock.now(),
      };
    }
    this.d.emit({ type: "thought.upsert", thought: view });
  }

  // ------------------------------------------------------------------- apply --

  private sanitize(r0: CortexResult, candidates: Candidate[]): CortexResult {
    const r = r0;
    const known = new Set(candidates.map((c) => c.ref));
    // a capture draft names the card it corrects by code ("T-3"): that is a real thought even if retrieval did not surface it
    for (const r of r0.references ?? []) if (r.resolved_id && this.d.store.thoughtByCode(r.resolved_id)) known.add(r.resolved_id);
    const confidence = Number.isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
    const out: CortexResult = {
      ...r,
      confidence,
      title: normalizeText(r.title).slice(0, 80) || quickTitle(r.intent),
      intent: normalizeText(r.intent).slice(0, 400),
      why: normalizeText(r.why ?? "").slice(0, 160),
      references: (r.references ?? []).map((x) => ({ ...x, resolved_id: x.resolved_id && known.has(x.resolved_id) ? x.resolved_id : null, confidence: Math.max(0, Math.min(1, x.confidence ?? 0)) })),
      entities: (r.entities ?? []).slice(0, 8),
      open_questions: (r.open_questions ?? []).slice(0, 3),
    };
    // abstention: never let a shaky guess become a confident action
    if (confidence < LIMITS.abstainConfidence && ACTIONABLE_CATEGORIES.includes(out.category) && !["note", "journal", "none", "recall"].includes(out.artifact.kind)) {
      out.artifact = { kind: "note", body: out.intent, tags: [] };
    }
    if (out.category === "aside" || out.category === "privacy") out.artifact = { kind: "none" };
    return out;
  }

  private async apply(th: Thread, t: ThoughtRec, out: CortexOutput, candidates: Candidate[]): Promise<void> {
    const { store, clock, embedder } = this.d;
    const r = this.sanitize(out.result, candidates);
    const llmDone = clock.now();

    // ---- control-flow results
    if (r.category === "privacy") {
      const dev = th.dev;
      this.dropThread(th, t, "aside");
      if (r.confidence >= 0.8) await this.d.controls.handle({ kind: "pause", via: "semantic", score: r.confidence }, dev, "semantic");
      return;
    }
    if (r.category === "aside") {
      // never delete earlier content because of a trailing aside: peel the aside off first
      if (th.fragIds.length > 1 && (await this.splitLast(th, t))) return;
      this.dropThread(th, t, "aside");
      this.d.asides.count++;
      this.d.emit({ type: "fragment.filtered", fragmentId: th.lastFragmentId, reason: "aside", asideCount: this.d.asides.count });
      return;
    }
    if (r.thread_relation === "correction_of_previous" || r.category === "correction") {
      await this.applyCorrection(th, t, r, candidates, out);
      return;
    }
    if (r.thread_relation === "new_thought" && th.fragIds.length > 1) {
      if (await this.splitLast(th, t)) return;
    }
    // the same decision, continued after a pause: one card, re-read as a whole (never a second "Which auth approach?")
    if (r.category === "decision") {
      const earlier = this.sameDecision(th, t, r);
      if (earlier) {
        this.mergeInto(th, t, earlier);
        return;
      }
    }

    // ---- fold the result into the thought
    const refViews: ReferenceView[] = r.references.map((x) => {
      const cand = x.resolved_id ? candidates.find((c) => c.ref === x.resolved_id) : undefined;
      const amb = ambiguity(candidates, x.resolved_id);
      return {
        mention: x.mention,
        resolvedId: cand?.id ?? null,
        resolvedCode: cand?.ref ?? null,
        label: x.label || cand?.label || "",
        confidence: x.confidence,
        assumed: amb.assumed,
        alternativeLabel: amb.alternative?.label,
      };
    });

    t.category = r.category;
    t.confidence = r.confidence;
    t.title = r.title;
    t.intent = r.intent;
    t.why = r.why;
    t.references = refViews;
    t.repairs = r.repairs;
    t.openQuestions = r.open_questions;
    t.salienceCues = r.salience_cues;
    t.concernKey = r.concern_key;
    t.tentative = r.confidence < 0.7;
    t.provisional = false;
    t.source = out.source === "llm" ? "llm" : "mock";
    t.redactions = out.redactions;
    t.degraded = out.degraded;
    t.version += 1;
    // the gist is what the thought MEANS: a display-only "…" (clipped title) must not leak into the embedding
    [t.emb] = await embedder.embed([`${t.title.replace(/…$/, "")}. ${t.intent}`], "passage") as [Float32Array];
    th.lastResult = r;

    // entities → knowledge graph + self-healing dictionary
    await this.applyEntities(t, r, candidates);
    this.linkReferences(t, refViews);
    for (const q of r.open_questions) {
      if (![...store.loopsOf(t.id)].some((o) => fold(o.question) === fold(q))) store.createOpenLoop(t, q);
    }

    // artifact
    await this.applyArtifact(t, r.artifact);

    // recall queries are ephemeral: short retention, never promoted. A thought that merely STARTED as one (the first
    // fragment sounded like a question, the thread then became a decision) must get its normal retention back,
    // otherwise it would silently expire half an hour later.
    if (!t.promoted) {
      if (r.category === "recall_query") store.setRetention(t, Math.min(t.expiresAt ?? Infinity, clock.now() + 30 * 60_000));
      else store.setRetention(t, Math.max(t.expiresAt ?? 0, store.workingExpiry(t.createdAt)));
    }

    // interim salience (final value computed at finalize)
    const sal = computeSalience(store, embedder, t);
    t.salience = Math.min(1, sal.score);
    t.salienceReasons = sal.reasons;

    const artifactEmit = clock.now();
    const lastRecv = th.lastRecvAt;
    t.timing = {
      ...t.timing,
      llmStart: th.llmStartWall,
      llmDone,
      artifactEmit,
      llmMs: Math.round(out.ms),
      fragToArtifactMs: artifactEmit - lastRecv,
      model: out.model,
      inputTokens: out.usage?.inputTokens,
      outputTokens: out.usage?.outputTokens,
      cachedTokens: out.usage?.cacheReadTokens,
    };
    store.saveThought(t);

    const view = this.view(t);
    this.d.emit({ type: "thought.upsert", thought: { ...view, analyzing: th.dirty } });
    if (t.artifactId) {
      const a = store.artifacts.get(t.artifactId);
      if (a) this.d.emit({ type: "artifact.upsert", thoughtId: t.id, artifact: store.artifactView(a) });
    }
    this.d.metrics.server(th.lastFragmentId, th.dev.id, {
      llmStart: th.llmStartWall,
      llmDone,
      llmFirstFieldMs: out.firstFieldMs,
      artifactEmit,
      model: out.model,
      inputTokens: out.usage?.inputTokens,
      outputTokens: out.usage?.outputTokens,
      cachedTokens: out.usage?.cacheReadTokens,
      source: out.source,
    });
    this.emitGraph(t);
    this.d.bus.emit("thought.updated", { thoughtId: t.id });
    if (r.category === "recall_query") this.d.onRecallQuery?.(t, th.dev);
  }

  private dropThread(th: Thread, t: ThoughtRec, reason: "aside" | "merged" | "retracted"): void {
    if (th.timer) clearTimeout(th.timer);
    th.closed = true;
    this.byThought.delete(th.thoughtId);
    if (this.open.get(th.dev.id) === th) this.open.delete(th.dev.id);
    if (this.recentClosed.get(th.dev.id) === th) this.recentClosed.delete(th.dev.id);
    this.d.store.deleteThought(t.id);
    this.d.emit({ type: "thought.remove", id: t.id, reason });
    this.d.emit({ type: "graph.delta", nodes: [], edges: [], removedNodes: [t.id], removedEdges: [] });
  }

  private async applyEntities(t: ThoughtRec, r: CortexResult, candidates: Candidate[]): Promise<void> {
    const { store } = this.d;
    const ents: EntityRec[] = [];
    const rawText = this.joinedText(t);
    for (const e of r.entities) {
      const hint = e.candidate_id ? candidates.find((c) => c.ref === e.candidate_id && c.kind === "entity")?.id : undefined;
      const rec = await store.upsertEntity(e.name, e.type, hint);
      if (!rec || ents.some((x) => x.id === rec.id)) continue;
      ents.push(rec);
      // self-healing dictionary: names, components, jargon, and mis-hearings the model corrected
      const kind = e.type === "person" ? "person" : e.type === "component" ? "component" : e.type === "technology" ? "technology" : e.type === "project" ? "project" : "jargon";
      if (["person", "component", "technology", "project", "org"].includes(e.type) || rec.mentionCount >= 2) {
        store.upsertDict(rec.name, kind, `learned from ${t.code}`, 0.5 + Math.min(0.4, 0.1 * rec.mentionCount));
      }
      const heard = this.misheard(rec.name, rawText);
      if (heard) store.upsertDict(rec.name, kind, `corrected "${heard}" → "${rec.name}" in ${t.code}`, 0.8);
    }
    store.linkEntities(t, ents);
    // entity co-occurrence edges
    for (let i = 0; i < ents.length; i++)
      for (let j = i + 1; j < ents.length; j++) store.upsertEdge((ents[i] as EntityRec).id, (ents[j] as EntityRec).id, "related", 1);
  }

  /** If the canonical name never appears verbatim but a near-miss does, that near-miss is a mis-hearing worth teaching Wispr. */
  private misheard(name: string, raw: string): string | null {
    const target = fold(name).replace(/[\s-]+/g, "");
    if (target.length < 5) return null;
    const folded = fold(raw);
    if (folded.replace(/[\s-]+/g, " ").includes(fold(name).replace(/-/g, " "))) return null;
    const ws = folded.split(" ");
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const cand = ws.slice(i, i + n).join(" ");
        const squashed = cand.replace(/\s+/g, "");
        if (squashed.length < 4 || squashed === target) continue;
        if (distance(squashed, target) <= Math.max(1, Math.floor(target.length / 5)) && squashed[0] === target[0]) return cand;
      }
    }
    return null;
  }

  private linkReferences(t: ThoughtRec, refs: ReferenceView[]): void {
    for (const r of refs) {
      if (!r.resolvedId || r.confidence < 0.5) continue;
      const target = this.d.store.thoughts.get(r.resolvedId);
      if (!target || target.id === t.id) continue;
      this.d.store.upsertEdge(t.id, target.id, target.category === t.category ? "refines" : "follows_up", r.confidence);
    }
  }

  private async applyArtifact(t: ThoughtRec, payload: Artifact): Promise<void> {
    const { store } = this.d;
    const existing = t.artifactId ? store.artifacts.get(t.artifactId) : undefined;
    if (payload.kind === "none") {
      if (existing && existing.status === "draft") {
        store.deleteArtifact(existing.id);
      }
      return;
    }
    if (existing && existing.kind === payload.kind) {
      if (existing.status === "executed") return; // already pushed out: never rewrite history
      existing.payload = payload;
      store.saveArtifact(existing);
      await this.d.autonomy.onArtifact(t, existing);
      return;
    }
    if (existing && existing.status !== "executed") store.deleteArtifact(existing.id);
    const a = store.createArtifact(t, payload, this.d.cfg.proactive.autonomyLevel);
    await this.d.autonomy.onArtifact(t, a);
  }

  private emitGraph(t: ThoughtRec): void {
    const { nodes, edges } = graphDeltaFor(this.d.store, t);
    if (nodes.length) this.d.emit({ type: "graph.delta", nodes, edges, removedNodes: [], removedEdges: [] });
  }

  // ------------------------------------------------------- split / correction --

  /** The model says the LAST fragment is a different thought: peel it into its own thread. */
  private async splitLast(th: Thread, t: ThoughtRec): Promise<boolean> {
    const { store } = this.d;
    const frags = store.fragmentsOf(t);
    const last = frags[frags.length - 1];
    if (!last || last.splitDone || frags.length < 2) return false;
    last.splitDone = true;

    const nt = store.createThought({
      sessionId: t.sessionId,
      deviceId: t.deviceId,
      deviceKind: t.deviceKind,
      activity: t.activity,
      category: "idea",
      title: quickTitle(last.text),
      intent: last.text,
      emb: last.emb,
      source: "local",
    });
    store.moveFragment(last, nt);
    const nthread: Thread = {
      thoughtId: nt.id,
      seq: ++this.seq,
      dev: th.dev,
      sessionId: th.sessionId,
      fragIds: [last.id],
      embs: [last.emb],
      centroid: last.emb,
      lastSpeechEnd: last.tEnd,
      lastRecvAt: th.lastRecvAt,
      lastFragmentId: last.id,
      closed: false,
      closedAt: 0,
      inflight: false,
      dirty: false,
      finalizeWhenIdle: false,
    };
    this.byThought.set(nt.id, nthread);
    this.open.set(th.dev.id, nthread);

    // the old thread keeps the earlier fragments and closes
    th.fragIds = th.fragIds.filter((id) => id !== last.id);
    th.embs = frags.slice(0, -1).map((f) => f.emb);
    th.centroid = centroid(th.embs);
    th.lastFragmentId = (frags[frags.length - 2] as FragRec).id;
    th.lastResult = undefined;
    th.closed = true;
    th.closedAt = this.d.clock.now();
    if (th.timer) clearTimeout(th.timer);
    this.recentClosed.set(th.dev.id, th);

    store.saveThought(t);
    store.saveThought(nt);
    this.d.emit({ type: "thought.upsert", thought: { ...this.view(t), analyzing: true } });
    this.d.emit({ type: "thought.upsert", thought: { ...this.view(nt), analyzing: true } });
    // re-analyse both; the old thread then finalizes
    th.finalizeWhenIdle = true;
    th.dirty = true;
    this.resetTimer(nthread);
    this.schedule(nthread);
    return true;
  }

  /** "scratch that" / "actually make it Friday": retract or revise the thought being corrected. */
  private async applyCorrection(th: Thread, t: ThoughtRec, r: CortexResult, candidates: Candidate[], out: CortexOutput): Promise<void> {
    const { store, clock } = this.d;
    const refCode = r.references.find((x) => x.resolved_id)?.resolved_id ?? null;
    const byRef = refCode ? candidates.find((c) => c.ref === refCode) : undefined;
    const fromLast = this.lastOtherThought(th, clock.now());
    const target = (byRef && store.getThought(byRef.id)) || (refCode ? store.thoughtByCode(refCode) : undefined) || fromLast;
    if (!target || target.id === t.id) {
      this.dropThread(th, t, "aside"); // nothing to correct: treat as noise
      return;
    }

    // Only an explicit `correction` verdict retracts. A revision comes back as the FULL corrected card in the
    // target's own category (even when that card has no artifact, e.g. a question), and must never delete it.
    const retraction = r.category === "correction";
    if (retraction) {
      const title = target.title;
      const report = store.deleteThought(target.id);
      this.forgetThoughts([target.id]);
      this.d.emit({ type: "thought.remove", id: target.id, reason: "retracted" });
      this.d.emit({ type: "graph.delta", nodes: [], edges: [], removedNodes: [target.id], removedEdges: [] });
      store.audit("retracted", target.code, report ? report.fragments : 0);
      log.info("engine", "retracted by voice", { thought: target.code, title: safe(title) });
      this.dropThread(th, t, "retracted");
      return;
    }

    // revision: the correction's fragments join the corrected thought, which takes the revised card
    for (const f of store.fragmentsOf(t)) store.moveFragment(f, target);
    const tgtThread = this.byThought.get(target.id) ?? this.adoptThread(target, th);
    tgtThread.lastFragmentId = th.lastFragmentId;
    tgtThread.lastRecvAt = th.lastRecvAt;
    tgtThread.lastSpeechEnd = th.lastSpeechEnd;
    tgtThread.embs.push(...th.embs);
    tgtThread.centroid = centroid(tgtThread.embs);
    target.correctsThoughtId = undefined;
    this.dropThread(th, t, "merged");
    if (tgtThread.closed) this.reopen(tgtThread);
    this.open.set(tgtThread.dev.id, tgtThread);
    tgtThread.lastResult = undefined;
    // apply the revised card directly (the model returned the full corrected result)
    const revised: CortexResult = { ...r, thread_relation: "continue", category: r.category === "correction" ? target.category : r.category };
    tgtThread.llmStartWall = th.llmStartWall;
    await this.apply(tgtThread, target, { ...out, result: revised }, candidates);
    this.resetTimer(tgtThread);
  }

  /** A recent decision of this session on the same topic (same question, or a close embedding), if any. */
  private sameDecision(th: Thread, t: ThoughtRec, r: CortexResult): ThoughtRec | undefined {
    const { store, clock, embedder } = this.d;
    const question = r.artifact.kind === "decision" ? fold(r.artifact.question) : "";
    const generic = !question || /^which option for this/.test(question);
    return [...store.thoughts.values()]
      .filter((x) => x.id !== t.id && x.sessionId === th.sessionId && x.deviceId === th.dev.id && x.category === "decision" && !x.retracted && clock.now() - x.createdAt < 30 * 60_000)
      .filter((x) => {
        const art = x.artifactId ? store.artifacts.get(x.artifactId) : undefined;
        if (art?.status === "executed" || art?.status === "dismissed") return false;
        const q = art?.payload.kind === "decision" ? fold(art.payload.question) : "";
        if (!generic && q && q === question) return true;
        // the same options or component named again ("JWT") is the same decision
        const names = new Set(x.entityIds.map((id) => store.entities.get(id)).filter((e) => e && e.type !== "person").map((e) => fold(e!.name)));
        if (r.entities.some((e) => e.type !== "person" && names.has(fold(e.name)))) return true;
        return embedder.calibrate(dot(th.centroid, x.emb)) >= T.decisionTopic;
      })
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Move this thread's fragments into an earlier thought and analyse that thought again with everything said. */
  private mergeInto(th: Thread, t: ThoughtRec, target: ThoughtRec): void {
    const { store } = this.d;
    for (const f of store.fragmentsOf(t)) store.moveFragment(f, target);
    const tgt = this.byThought.get(target.id) ?? this.adoptThread(target, th);
    tgt.fragIds.push(...th.fragIds);
    tgt.embs.push(...th.embs);
    tgt.centroid = centroid(tgt.embs);
    tgt.lastFragmentId = th.lastFragmentId;
    tgt.lastRecvAt = th.lastRecvAt;
    tgt.lastSpeechEnd = th.lastSpeechEnd;
    tgt.lastResult = undefined;
    this.dropThread(th, t, "merged");
    if (tgt.closed) this.reopen(tgt);
    this.open.set(tgt.dev.id, tgt);
    this.resetTimer(tgt);
    this.schedule(tgt);
  }

  private adoptThread(target: ThoughtRec, from: Thread): Thread {
    const frags = this.d.store.fragmentsOf(target);
    const th: Thread = {
      thoughtId: target.id,
      seq: ++this.seq,
      dev: from.dev,
      sessionId: target.sessionId,
      fragIds: frags.map((f) => f.id),
      embs: frags.map((f) => f.emb),
      centroid: frags.length ? centroid(frags.map((f) => f.emb)) : target.emb,
      lastSpeechEnd: from.lastSpeechEnd,
      lastRecvAt: from.lastRecvAt,
      lastFragmentId: frags[frags.length - 1]?.id ?? from.lastFragmentId,
      closed: true,
      closedAt: this.d.clock.now(),
      inflight: false,
      dirty: false,
      finalizeWhenIdle: false,
    };
    this.byThought.set(target.id, th);
    return th;
  }

  // ---------------------------------------------------------------- finalize --

  private async finalize(th: Thread): Promise<void> {
    const { store, embedder, clock } = this.d;
    if (th.timer) clearTimeout(th.timer);
    th.closed = true;
    th.closedAt = clock.now();
    if (this.open.get(th.dev.id) === th) this.open.delete(th.dev.id);
    this.recentClosed.set(th.dev.id, th);
    // a finished thread is only needed briefly (late continuation, a correction); then drop its buffers
    const evict = setTimeout(() => {
      if (!th.closed || th.inflight) return;
      if (this.byThought.get(th.thoughtId) === th) this.byThought.delete(th.thoughtId);
      if (this.recentClosed.get(th.dev.id) === th) this.recentClosed.delete(th.dev.id);
    }, 120_000);
    evict.unref?.();
    const t = store.getThought(th.thoughtId);
    if (!t) return;

    t.status = "final";
    t.provisional = false;
    const sal = computeSalience(store, embedder, t);
    t.salience = Math.min(1, sal.score);
    t.salienceReasons = sal.reasons;
    const accepted = t.artifactId ? ["accepted", "executed"].includes(store.artifacts.get(t.artifactId)?.status ?? "") : false;
    if (!t.promoted && store.isRecallable(t) && t.category !== "recall_query" && (sal.score >= this.d.cfg.memory.promoteThreshold || accepted)) {
      store.promote(t, accepted ? [...sal.reasons, "you accepted its card"] : sal.reasons);
    }
    this.linkNeighbours(t);
    store.saveThought(t);
    this.d.emit({ type: "thought.upsert", thought: { ...this.view(t), analyzing: false } });
    this.emitGraph(t);
    this.d.bus.emit("thought.finalized", { thoughtId: t.id });
  }

  /** Cheap live linking of related thoughts from OTHER sessions (consolidation refines this later). */
  private linkNeighbours(t: ThoughtRec): void {
    const { store, embedder } = this.d;
    if (!store.isRecallable(t)) return;
    const hits = store.thoughtVec.search(t.emb, 6, (id) => {
      const o = store.thoughts.get(id);
      return Boolean(o && o.id !== t.id && o.sessionId !== t.sessionId && store.isRecallable(o) && !o.provisional);
    });
    let n = 0;
    for (const h of hits) {
      const sim = embedder.calibrate(h.score);
      if (sim < 0.55 || n >= 2) continue;
      store.upsertEdge(t.id, h.id, "same_topic", sim);
      n++;
    }
  }
}

/** Levenshtein for short strings (mis-hearing detection). */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      (dp[i] as number[])[j] = Math.min((dp[i - 1] as number[])[j]! + 1, (dp[i] as number[])[j - 1]! + 1, (dp[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return (dp[a.length] as number[])[b.length] as number;
}

export type { ServerMessage };
