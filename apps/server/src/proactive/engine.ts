import { z } from "zod";
import type {
  ArtifactOf,
  BriefView,
  EchoView,
  SourceRef,
  SuggestionKind,
  SuggestionStatus,
  SuggestionView,
} from "@synapse/shared";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { EmitFn, Hub, ProactiveApi } from "../ctx";
import { computeSalience } from "../cortex/salience";
import { conflicts, findSlots, fmtSlot, listEvents, view as calView } from "../integrations/calendar";
import type { Outbox } from "../integrations/outbox";
import type { DeepLlm } from "../llm/deep";
import { log } from "../log";
import { dot, type Embedder } from "../memory/embeddings";
import type { MemoryStore } from "../memory/store";
import type { ThoughtRec } from "../memory/types";
import type { AuditChain } from "../privacy/audit";
import type { PrivacyService } from "../privacy/service";
import { newId } from "../ids";
import type { RecallEngine } from "../recall/engine";
import { parseQuery } from "../recall/engine";
import { entitiesInText } from "../recall/search";
import { fold } from "../text";
import { LIMITS, T } from "../thresholds";

/* ============================================================================
 * Prefrontal (PRD §6.5, TRD §9): acts BEFORE the user asks, without being annoying.
 *
 * Detectors (listen to the bus):
 *   recurring concern   same worry N× in M minutes          → "reschedule?" with concrete free slots
 *   open-question       "what did Sarah say?"                → answered quietly from memory
 *   person + task       "tell Dev about the URL"              → draft is ready
 *   repeated pattern    same code idea twice                  → one reusable snippet
 *   memory echo         a past thought resurfaces             → related thought, with when/where
 *   contradiction       decision differs from an earlier one → "revisit?"
 *
 * Delivery is interruption-aware (Horvitz): suggestions wait in a queue and surface ONLY when every
 * device has been silent for a moment, ranked by value, rate-limited, expired when stale, and the
 * thresholds adapt to accept/dismiss feedback.
 * ========================================================================== */

interface Queued {
  view: SuggestionView;
  key: string;
  snoozeUntil?: number;
}

const BriefSchema = z.object({
  headline: z.string(),
  tasks: z.array(z.object({ title: z.string(), thought_code: z.string() })),
  decisions: z.array(z.object({ title: z.string(), chosen: z.string().nullable(), rejected: z.array(z.string()), thought_code: z.string() })),
  snippets: z.array(z.object({ title: z.string(), language: z.string(), thought_code: z.string() })),
  open_loops: z.array(z.string()),
  notable_quotes: z.array(z.string()),
});

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export class ProactiveEngine implements ProactiveApi {
  private queue: Queued[] = [];
  private echoes: EchoView[] = [];
  private echoQueue: EchoView[] = [];
  private lastDelivered = 0;
  private lastEcho = 0;
  private cooldown = new Map<string, number>();
  private busy = new Set<string>();
  private concernEmbs = new Map<string, Float32Array>();
  private timer?: ReturnType<typeof setInterval>;
  private unsub: Array<() => void> = [];
  private asideBaseline = new Map<string, number>();

  constructor(
    private d: {
      cfg: Config;
      clock: Clock;
      bus: Bus;
      store: MemoryStore;
      embedder: Embedder;
      hub: Hub;
      emit: EmitFn;
      recall: RecallEngine;
      deep: DeepLlm;
      outbox: Outbox;
      privacy: PrivacyService;
      audit: AuditChain;
      asides: { count: number };
    },
  ) {
    // restore suggestions that were still open when the process stopped
    for (const rec of d.store.suggestions.values()) {
      if (rec.view.status === "queued" || rec.view.status === "delivered") this.queue.push({ view: rec.view, key: `restored:${rec.view.id}` });
    }
  }

  // ------------------------------------------------------------------- life --

  start(): void {
    const { bus } = this.d;
    this.unsub.push(
      bus.on("thought.updated", ({ thoughtId }) => void this.run(thoughtId, "updated")),
      bus.on("thought.finalized", ({ thoughtId }) => void this.run(thoughtId, "finalized")),
      bus.on("session.started", ({ sessionId }) => this.asideBaseline.set(sessionId, this.d.asides.count)),
      bus.on("session.ended", ({ sessionId }) => void this.brief(sessionId).catch((e) => log.warn("proactive", `brief failed: ${(e as Error).message}`))),
    );
    this.timer = setInterval(() => this.tick(), 300);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  snapshot(): { suggestions: SuggestionView[]; echoes: EchoView[] } {
    const live = this.queue.filter((q) => q.view.status === "delivered" || q.view.status === "later").map((q) => q.view);
    return { suggestions: live, echoes: this.echoes.slice(-10) };
  }

  // -------------------------------------------------------------- detectors --

  private async run(thoughtId: string, phase: "updated" | "finalized"): Promise<void> {
    const t = this.d.store.getThought(thoughtId);
    if (!t || t.provisional || this.d.privacy.isPaused()) return;
    const guard = `${phase}:${thoughtId}`;
    if (this.busy.has(guard)) return;
    this.busy.add(guard);
    try {
      if (phase === "updated") {
        await this.recurring(t);
        await this.openQuestions(t);
        await this.personTask(t);
        await this.contradiction(t);
      } else {
        await this.echo(t);
        await this.pattern(t);
        await this.retryOpenLoops(t);
      }
    } catch (err) {
      log.warn("proactive", `detector failed: ${(err as Error).message}`);
    } finally {
      this.busy.delete(guard);
    }
  }

  private src(t: ThoughtRec): SourceRef {
    return { thoughtId: t.id, code: t.code, title: t.title, when: t.createdAt, activity: t.activity, deviceKind: t.deviceKind };
  }

  private when(ms: number): string {
    const tz = this.d.cfg.timezone;
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(ms);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
    const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(this.d.clock.now()) === new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(ms);
    return today ? `today ${time}` : `${day} ${time}`;
  }

  private place(t: ThoughtRec): string {
    return t.activity === "walking" ? "on a walk" : t.activity === "vehicle" ? "while travelling" : t.deviceKind === "pocket" ? "on your phone" : "at your desk";
  }

  // ---- 1. recurring concern ------------------------------------------------

  private async concernEmb(key: string): Promise<Float32Array> {
    let e = this.concernEmbs.get(key);
    if (!e) {
      [e] = await this.d.embedder.embed([key.replace(/[_:~]/g, " ")], "passage") as [Float32Array];
      this.concernEmbs.set(key, e);
    }
    return e;
  }

  private recurringN(): number {
    const p = this.pattern0("recurring_n");
    return p ? Math.round(p.threshold) : this.d.cfg.proactive.recurringN;
  }

  private async recurring(t: ThoughtRec): Promise<void> {
    if (!t.concernKey) return;
    const { clock, store, embedder, cfg } = this.d;
    const now = clock.now();
    const winMs = cfg.proactive.recurringWindowMin * 60_000;
    const kEmb = await this.concernEmb(t.concernKey);
    const related: ThoughtRec[] = [];
    for (const o of store.thoughts.values()) {
      if (!o.concernKey || o.provisional || now - o.createdAt > winMs) continue;
      if (o.concernKey === t.concernKey) related.push(o);
      else if (embedder.calibrate(dot(kEmb, await this.concernEmb(o.concernKey))) >= T.concernSame) related.push(o);
    }
    const n = related.length;
    if (n < this.recurringN()) return;
    const canonical = [...related].sort((a, b) => a.createdAt - b.createdAt)[0]!.concernKey as string;
    const cdKey = `concern:${canonical}`;
    if (this.onCooldown(cdKey) || this.queue.some((q) => q.key === cdKey && ["queued", "delivered", "later"].includes(q.view.status))) return;

    const first = [...related].sort((a, b) => a.createdAt - b.createdAt)[0] as ThoughtRec;
    const minutes = Math.max(1, Math.round((now - first.createdAt) / 60_000));
    const human = this.humanizeConcern(canonical);
    const why = `You've mentioned ${human} ${n} times in the last ${minutes} minute${minutes > 1 ? "s" : ""}.`;
    const type = canonical.split(":")[0];

    if (type === "calendar_conflict") {
      const nouns = (canonical.split(":")[1] ?? "").split("~").filter(Boolean);
      const events = listEvents(store);
      const hit = conflicts(events).find(([a, b]) => nouns.some((x) => fold(a.title).includes(x)) && nouns.some((x) => fold(b.title).includes(x))) ?? conflicts(events)[0];
      let move = hit?.[0];
      let stay = hit?.[1];
      if (hit) {
        const freq = (title: string) => events.filter((e) => fold(e.title) === fold(title)).length;
        if (freq(hit[0].title) < freq(hit[1].title)) [move, stay] = [hit[0], hit[1]];
        else if (freq(hit[1].title) < freq(hit[0].title)) [move, stay] = [hit[1], hit[0]];
      }
      const minutesNeeded = move ? Math.max(15, Math.round((move.end - move.start) / 60_000)) : 30;
      const slots = findSlots(store, cfg, now, { count: 3, minutes: minutesNeeded, avoid: hit ? [{ start: hit[0].start, end: hit[0].end }] : [] });
      const body = move
        ? `“${move.title}” (${fmtSlot(move.start, cfg.timezone, now)}) clashes with “${stay?.title}”. Free slots: ${slots.map((s) => s.label).join(" · ") || "none in the next 3 days"}.`
        : `I couldn't find the clash in your calendar. Free slots: ${slots.map((s) => s.label).join(" · ")}.`;
      this.enqueue({
        kind: "reschedule",
        key: cdKey,
        title: move ? `Move “${move.title}”?` : "Sort out the calendar clash?",
        body,
        why,
        value: 0.9,
        sources: related.map((r) => this.src(r)),
        acceptLabel: slots.length ? `Hold ${slots[0]!.label}` : "Okay",
        payload: { move: move ? { id: move.id, title: move.title, start: move.start, end: move.end } : null, stay: stay ? { title: stay.title } : null, slots, concernKey: canonical },
      });
      return;
    }
    const latest = [...related].sort((a, b) => b.createdAt - a.createdAt)[0] as ThoughtRec;
    this.enqueue({
      kind: "make_task",
      key: cdKey,
      title: `Make “${human}” a task?`,
      body: `It keeps coming up. I can turn “${latest.title}” into a ticket.`,
      why,
      value: 0.75,
      sources: related.map((r) => this.src(r)),
      acceptLabel: "Create ticket",
      payload: { thoughtId: latest.id, concernKey: canonical },
    });
  }

  private humanizeConcern(key: string): string {
    const [type, rest] = key.split(":");
    const parts = (rest ?? "").split("~").filter(Boolean);
    const day = parts.find((p) => WEEKDAYS.includes(p));
    const nouns = parts.filter((p) => p !== day);
    if (type === "calendar_conflict") return `the ${day ? day[0]!.toUpperCase() + day.slice(1) + " " : ""}${nouns.join(" / ") || "calendar"} conflict`;
    return `“${parts.join(" ") || type}”`;
  }

  // ---- 2. open questions ---------------------------------------------------

  private async openQuestions(t: ThoughtRec): Promise<void> {
    for (const loop of this.d.store.loopsOf(t.id)) {
      if (loop.status === "open") await this.tryAnswer(loop.id, t);
    }
  }

  private async retryOpenLoops(newThought: ThoughtRec): Promise<void> {
    const open = [...this.d.store.openLoops.values()].filter((o) => o.status === "open" && o.thoughtId !== newThought.id).slice(-5);
    for (const loop of open) {
      const asker = this.d.store.getThought(loop.thoughtId);
      if (asker) await this.tryAnswer(loop.id, asker, newThought);
    }
  }

  private async tryAnswer(loopId: string, asker: ThoughtRec, onlyFrom?: ThoughtRec): Promise<void> {
    const { store, cfg, clock } = this.d;
    const loop = store.openLoops.get(loopId);
    if (!loop || loop.status !== "open") return;
    const persons = [...new Set([...entitiesInText(store, loop.question).filter((e) => e.type === "person").map((e) => e.name), ...cfg.user.team.filter((m) => new RegExp(`\\b${m.name}\\b`, "i").test(loop.question)).map((m) => m.name)])];
    // "what did Sarah say?" is underspecified on its own: the topic lives in the thought it came from
    const context = `${loop.question} ${asker.title} ${asker.intent}`.replace(/\s+/g, " ").slice(0, 400);
    const parsed = parseQuery(context, { now: clock.now(), timezone: cfg.timezone, hackathonStart: cfg.hackathonStart, persons });
    const res = await this.d.recall.search(parsed, { exclude: new Set([asker.id]), limit: 4 });
    const best = onlyFrom ? res.hits.find((h) => h.thought.id === onlyFrom.id) : res.hits[0];
    if (!best || best.score < T.recallOpenAnswer) return;
    const t = best.thought;
    // a question about a person must be answered by something that involves that person
    const mentions = (p: string) => fold(`${t.title} ${t.intent}`).includes(fold(p)) || t.entityIds.some((id) => fold(store.entities.get(id)?.name ?? "").includes(fold(p)));
    if (persons.length && !persons.some(mentions)) return;

    loop.status = "answered";
    loop.answerThoughtId = t.id;
    store.saveOpenLoop(loop);
    store.upsertEdge(t.id, asker.id, "answers", Math.min(1, best.score));
    const who = persons[0] ?? "Earlier";
    this.enqueue({
      kind: "open_answer",
      key: `answer:${loop.id}`,
      title: `${who}: ${t.title}`,
      body: `${t.intent} — ${this.when(t.createdAt)}, ${this.place(t)}.`,
      why: `You asked “${loop.question}”. Found in ${t.code}.`,
      value: Math.min(1, 0.6 + 0.4 * best.score),
      sources: [this.src(t)],
      acceptLabel: "Got it",
      payload: { loopId: loop.id, answerThoughtId: t.id, askerThoughtId: asker.id },
    });
  }

  // ---- 3. person + task → draft ready --------------------------------------

  private async personTask(t: ThoughtRec): Promise<void> {
    if (t.category !== "communication" || !t.artifactId) return;
    const art = this.d.store.artifacts.get(t.artifactId);
    if (!art || (art.kind !== "email_draft" && art.kind !== "message_draft") || art.status === "dismissed") return;
    const key = `draft:${t.id}`;
    if (this.queue.some((q) => q.key === key)) return;
    const person = t.entityIds.map((id) => this.d.store.entities.get(id)).find((e) => e?.type === "person")?.name ?? (art.kind === "email_draft" ? (art.payload as ArtifactOf<"email_draft">).to[0] : (art.payload as ArtifactOf<"message_draft">).to) ?? "them";
    const body = art.kind === "email_draft" ? (art.payload as ArtifactOf<"email_draft">).body : (art.payload as ArtifactOf<"message_draft">).body;
    this.enqueue({
      kind: "draft_ready",
      key,
      title: `Draft to ${person} is ready`,
      body: body.replace(/\s+/g, " ").slice(0, 170),
      why: `You mentioned ${person} and something to send. Nothing is sent until you do it.`,
      value: 0.7,
      sources: [this.src(t)],
      acceptLabel: "Keep draft",
      payload: { artifactId: art.id, kind: art.kind },
    });
  }

  // ---- 4. contradiction ----------------------------------------------------

  private async contradiction(t: ThoughtRec): Promise<void> {
    if (t.category !== "decision" || !t.artifactId) return;
    const { store, embedder } = this.d;
    const art = store.artifacts.get(t.artifactId);
    if (!art || art.kind !== "decision") return;
    const now = (art.payload as ArtifactOf<"decision">).chosen;
    if (!now) return;
    for (const o of store.thoughts.values()) {
      if (o.id === t.id || o.category !== "decision" || o.provisional || t.createdAt - o.createdAt < 10 * 60_000 || !o.artifactId) continue;
      const oa = store.artifacts.get(o.artifactId);
      if (!oa || oa.kind !== "decision") continue;
      const before = (oa.payload as ArtifactOf<"decision">).chosen;
      if (!before || fold(before) === fold(now)) continue;
      if (embedder.calibrate(dot(t.emb, o.emb)) < T.decisionTopic) continue;
      const key = `contradiction:${o.id}:${t.id}`;
      if (this.queue.some((q) => q.key === key)) return;
      this.enqueue({
        kind: "contradiction",
        key,
        title: `Decision changed: ${before} → ${now}`,
        body: `${this.when(o.createdAt)} you chose ${before}. Now you're leaning ${now}. Revisit?`,
        why: `Two decisions on the same topic disagree (${o.code} vs ${t.code}).`,
        value: 0.8,
        sources: [this.src(o), this.src(t)],
        acceptLabel: "New one wins",
        payload: { oldThoughtId: o.id, newThoughtId: t.id },
      });
      return;
    }
  }

  // ---- 5. memory echo ------------------------------------------------------

  private async echo(t: ThoughtRec): Promise<void> {
    const { store, embedder, clock } = this.d;
    if (!store.isRecallable(t) || t.category === "journal" || t.category === "question") return;
    const now = clock.now();
    if (now - this.lastEcho < 90_000 && this.echoQueue.length === 0 && this.lastEcho) return;
    const hits = store.thoughtVec.search(t.emb, 8, (id) => {
      const o = store.thoughts.get(id);
      return Boolean(o && o.id !== t.id && o.sessionId !== t.sessionId && !o.provisional && store.isRecallable(o) && now - o.createdAt > 5 * 60_000);
    });
    for (const h of hits) {
      const o = store.thoughts.get(h.id) as ThoughtRec;
      const sim = embedder.calibrate(h.score);
      const shared = o.entityIds.some((e) => t.entityIds.includes(e));
      if (!(sim >= T.echo || (sim >= T.echoWithEntity && shared))) continue;
      const key = `${t.id}:${o.id}`;
      if (this.echoes.some((e) => `${e.thoughtId}:${e.source.thoughtId}` === key) || this.echoQueue.some((e) => `${e.thoughtId}:${e.source.thoughtId}` === key)) return;
      this.echoQueue.push({
        id: newId(),
        thoughtId: t.id,
        because: `Related to what you said ${this.when(o.createdAt)}, ${this.place(o)}: “${o.title}”`,
        source: this.src(o),
        similarity: Math.round(sim * 100) / 100,
        createdAt: now,
      });
      return;
    }
  }

  // ---- 6. repeated pattern → reusable snippet ------------------------------

  private async pattern(t: ThoughtRec): Promise<void> {
    if (t.category !== "code" || !t.artifactId) return;
    const { store, embedder } = this.d;
    const art = store.artifacts.get(t.artifactId);
    if (!art || art.kind !== "code_snippet") return;
    const cluster = [...store.thoughts.values()].filter((o) => o.id !== t.id && o.category === "code" && !o.provisional && embedder.calibrate(dot(t.emb, o.emb)) >= T.patternCluster);
    if (cluster.length < 1) return;
    const key = `pattern:${[t.id, ...cluster.map((c) => c.id)].sort()[0]}`;
    if (this.queue.some((q) => q.key === key) || this.onCooldown(key)) return;
    const p = art.payload as ArtifactOf<"code_snippet">;
    this.enqueue({
      kind: "snippet",
      key,
      title: `Reusable snippet: ${p.approach.slice(0, 60)}`,
      body: `You've described this ${cluster.length + 1}× in different words. I kept one reusable version.`,
      why: `${cluster.length + 1} similar code ideas (${[t, ...cluster].map((x) => x.code).join(", ")}).`,
      value: 0.65,
      sources: [t, ...cluster].slice(0, 4).map((x) => this.src(x)),
      acceptLabel: "Save snippet",
      payload: { thoughtId: t.id, artifactId: art.id, language: p.language, code: p.code, explanation: p.explanation },
    });
  }

  // --------------------------------------------------------------- delivery --

  private enqueue(o: {
    kind: SuggestionKind;
    key: string;
    title: string;
    body: string;
    why: string;
    value: number;
    sources: SourceRef[];
    acceptLabel: string;
    payload?: Record<string, unknown>;
  }): void {
    const now = this.d.clock.now();
    const view: SuggestionView = {
      id: newId(),
      kind: o.kind,
      title: o.title,
      body: o.body,
      why: o.why,
      value: o.value,
      status: "queued",
      createdAt: now,
      sources: o.sources,
      payload: o.payload,
      acceptLabel: o.acceptLabel,
    };
    this.queue.push({ view, key: o.key });
    this.d.store.saveSuggestion(view);
    log.info("proactive", "queued", { kind: o.kind, value: o.value.toFixed(2) });
  }

  private onCooldown(key: string): boolean {
    return (this.cooldown.get(key) ?? 0) > this.d.clock.now();
  }

  private threshold(kind: SuggestionKind): number {
    return this.pattern0(`kind:${kind}`)?.threshold ?? LIMITS.deliveryThreshold;
  }

  private tick(): void {
    const { clock, hub, privacy } = this.d;
    if (privacy.isPaused()) return;
    const now = clock.now();
    for (const q of this.queue) {
      const ttl = q.view.kind === "open_answer" ? LIMITS.suggestionExpireMs * 2 : LIMITS.suggestionExpireMs;
      if (q.view.status === "queued" && now - q.view.createdAt > ttl) this.setStatus(q, "expired");
    }
    this.queue = this.queue.filter((q) => q.view.status !== "expired" || now - q.view.createdAt < 3_600_000);
    this.echoQueue = this.echoQueue.filter((e) => now - e.createdAt < LIMITS.echoExpireMs);

    if (hub.quietForMs() < LIMITS.quietMs) return; // never interrupt a thought

    // actionable suggestions: best value first
    const ready = this.queue
      .filter((q) => (q.view.status === "queued" || q.view.status === "later") && (!q.snoozeUntil || q.snoozeUntil <= now) && q.view.value >= this.threshold(q.view.kind))
      .sort((a, b) => b.view.value - a.view.value);
    for (const q of ready) {
      const gap = q.view.kind === "open_answer" ? 4000 : this.d.cfg.proactive.minGapMs;
      if (now - this.lastDelivered < gap) continue;
      q.view.status = "delivered";
      q.view.deliveredAt = now;
      this.lastDelivered = now;
      this.d.store.saveSuggestion(q.view);
      this.cooldown.set(q.key, now + LIMITS.cooldownAfterDeliveryMs);
      this.d.emit({ type: "suggestion.push", suggestion: q.view });
      this.d.audit.append("suggestion_delivered", q.view.kind, 1);
      return;
    }
    // echoes are lightweight and have their own pace
    const echo = this.echoQueue[0];
    if (echo && now - this.lastEcho > 90_000 && now - this.lastDelivered > 6_000) {
      this.echoQueue.shift();
      this.lastEcho = now;
      this.echoes.push(echo);
      if (this.echoes.length > 20) this.echoes.shift();
      this.d.emit({ type: "echo.push", echo });
    }
  }

  private setStatus(q: Queued, status: SuggestionStatus): void {
    q.view.status = status;
    this.d.store.saveSuggestion(q.view);
    this.d.emit({ type: "suggestion.update", id: q.view.id, status });
  }

  // ------------------------------------------------------------- user action --

  private pattern0(key: string): { threshold: number; accepts: number; dismisses: number } | undefined {
    return this.d.store.db.get<{ threshold: number; accepts: number; dismisses: number }>("SELECT threshold, accepts, dismisses FROM pattern_state WHERE key = ?", key);
  }

  private bump(key: string, accept: boolean, def: number, lo: number, hi: number, step: { up: number; down: number }): void {
    const cur = this.pattern0(key) ?? { threshold: def, accepts: 0, dismisses: 0 };
    const threshold = Math.max(lo, Math.min(hi, cur.threshold + (accept ? -step.down : step.up)));
    this.d.store.db.run(
      "INSERT INTO pattern_state(key, threshold, accepts, dismisses, cooldown_until) VALUES(?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET threshold=excluded.threshold, accepts=excluded.accepts, dismisses=excluded.dismisses",
      key,
      threshold,
      cur.accepts + (accept ? 1 : 0),
      cur.dismisses + (accept ? 0 : 1),
    );
  }

  /** Feedback adaptation (PRO-7): dismissing raises the bar, accepting lowers it. */
  adaptation(): Array<{ key: string; threshold: number; accepts: number; dismisses: number }> {
    return this.d.store.db.all<{ key: string; threshold: number; accepts: number; dismisses: number }>("SELECT key, threshold, accepts, dismisses FROM pattern_state ORDER BY key");
  }

  async action(id: string, action: "accept" | "dismiss" | "later"): Promise<void> {
    const q = this.queue.find((x) => x.view.id === id);
    if (!q) return;
    const { clock, store } = this.d;
    const now = clock.now();
    const kind = q.view.kind;
    if (action === "later") {
      q.snoozeUntil = now + 5 * 60_000;
      this.setStatus(q, "later");
      return;
    }
    if (action === "dismiss") {
      this.setStatus(q, "dismissed");
      this.bump(`kind:${kind}`, false, LIMITS.deliveryThreshold, 0.35, 0.95, { up: 0.1, down: 0.05 });
      if (kind === "reschedule" || kind === "make_task") this.bump("recurring_n", false, this.d.cfg.proactive.recurringN, 2, 5, { up: 1, down: 1 });
      this.cooldown.set(q.key, now + LIMITS.cooldownAfterDismissMs);
      this.d.audit.append("suggestion_dismissed", kind, 1);
      this.d.bus.emit("suggestion.resolved", { id, kind, action: "dismiss" });
      return;
    }
    try {
      await this.accept(q);
    } catch (err) {
      this.d.emit({ type: "notice", level: "warn", text: (err as Error).message, at: now });
      return;
    }
    this.setStatus(q, "accepted");
    this.bump(`kind:${kind}`, true, LIMITS.deliveryThreshold, 0.35, 0.95, { up: 0.1, down: 0.05 });
    if (kind === "reschedule" || kind === "make_task") this.bump("recurring_n", true, this.d.cfg.proactive.recurringN, 2, 5, { up: 1, down: 1 });
    this.d.audit.append("suggestion_accepted", kind, 1);
    this.d.bus.emit("suggestion.resolved", { id, kind, action: "accept" });
    void store;
  }

  private async accept(q: Queued): Promise<void> {
    const { store, clock, outbox, cfg } = this.d;
    const p = (q.view.payload ?? {}) as Record<string, unknown>;
    const now = clock.now();
    switch (q.view.kind) {
      case "reschedule": {
        const slots = (p.slots as Array<{ start: number; end: number; label: string }> | undefined) ?? [];
        const pick = slots[Number(p.pick ?? 0)] ?? slots[0];
        if (!pick) throw new Error("No free slot to hold.");
        const move = p.move as { title: string } | null;
        const rec = store.addCalendar(`${move?.title ?? "Resolve clash"} (proposed)`, pick.start, pick.end, "voice");
        this.d.emit({ type: "calendar.update", events: listEvents(store).map(calView) });
        this.d.emit({ type: "notice", level: "success", text: `Held ${fmtSlot(rec.start, cfg.timezone, now)} for “${move?.title ?? "the clash"}” (tentative, on your calendar only).`, at: now });
        this.d.audit.append("calendar_hold", "voice", 1);
        return;
      }
      case "make_task": {
        const t = store.getThought(String(p.thoughtId));
        if (!t) throw new Error("That thought is gone.");
        const a = store.createArtifact(t, { kind: "ticket", title: t.title, description: t.intent, issue_type: "task", priority: "medium", labels: [], component: null, acceptance_criteria: [] }, 1);
        a.status = "staged";
        store.saveArtifact(a);
        this.d.emit({ type: "artifact.upsert", thoughtId: t.id, artifact: store.artifactView(a) });
        this.d.emit({ type: "thought.upsert", thought: { ...store.toView(t) } });
        return;
      }
      case "draft_ready": {
        const a = store.artifacts.get(String(p.artifactId));
        if (a) outbox.accept(a);
        return;
      }
      case "snippet": {
        const t = store.getThought(String(p.thoughtId));
        const a = store.artifacts.get(String(p.artifactId));
        if (a) outbox.accept(a);
        if (t) for (const o of q.view.sources) {
          const other = store.getThought(o.thoughtId);
          if (other && !other.promoted) store.promote(other, [...other.salienceReasons, "reusable snippet"]);
        }
        return;
      }
      case "open_answer": {
        const t = store.getThought(String(p.answerThoughtId));
        if (t) {
          const sal = computeSalience(store, this.d.embedder, t, { revisited: true });
          if (!t.promoted && sal.score >= cfg.memory.promoteThreshold) store.promote(t, sal.reasons);
        }
        return;
      }
      case "contradiction": {
        const oldT = store.getThought(String(p.oldThoughtId));
        const newT = store.getThought(String(p.newThoughtId));
        if (oldT && newT) {
          store.upsertEdge(newT.id, oldT.id, "contradicts", 1);
          store.upsertEdge(newT.id, oldT.id, "supersedes", 1, now);
          this.d.emit({ type: "graph.delta", nodes: [], edges: [{ id: `supersedes:${newT.id}>${oldT.id}`, src: newT.id, dst: oldT.id, type: "supersedes", weight: 1 }], removedNodes: [], removedEdges: [] });
        }
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ brief --

  /** Session brief (PRD CTX-10): tasks, decisions, snippets, open loops, what was filtered. */
  async brief(sessionId: string): Promise<BriefView | null> {
    const { store, clock, deep } = this.d;
    const thoughts = [...store.thoughts.values()].filter((t) => t.sessionId === sessionId && store.isRecallable(t) && !t.provisional).sort((a, b) => a.createdAt - b.createdAt);
    if (!thoughts.length) return null;
    const filtered = Math.max(0, this.d.asides.count - (this.asideBaseline.get(sessionId) ?? this.d.asides.count));

    const local: BriefView = {
      id: newId(),
      sessionId,
      headline: `${thoughts.length} thought${thoughts.length > 1 ? "s" : ""} captured${filtered ? `, ${filtered} aside${filtered > 1 ? "s" : ""} filtered` : ""}`,
      tasks: thoughts.filter((t) => ["action", "bug", "communication", "scheduling"].includes(t.category)).map((t) => ({ title: t.title, thoughtCode: t.code })),
      decisions: thoughts
        .filter((t) => t.category === "decision")
        .map((t) => {
          const a = t.artifactId ? store.artifacts.get(t.artifactId) : undefined;
          const p = a?.kind === "decision" ? (a.payload as ArtifactOf<"decision">) : undefined;
          return { title: t.title, chosen: p?.chosen ?? null, rejected: p?.rejected ?? [], thoughtCode: t.code };
        }),
      snippets: thoughts
        .filter((t) => t.category === "code")
        .map((t) => {
          const a = t.artifactId ? store.artifacts.get(t.artifactId) : undefined;
          return { title: t.title, language: a?.kind === "code_snippet" ? (a.payload as ArtifactOf<"code_snippet">).language : "text", thoughtCode: t.code };
        }),
      openLoops: [...store.openLoops.values()].filter((o) => o.status === "open" && thoughts.some((t) => t.id === o.thoughtId)).map((o) => o.question),
      filteredCount: filtered,
      notableQuotes: [],
      createdAt: clock.now(),
    };

    let out = local;
    if (deep.available) {
      const lines = thoughts.map((t) => `[${t.code}] ${t.category}: ${t.title} — ${t.intent}`).join("\n");
      const res = await deep.json({
        system:
          "You write a session brief for a private voice second-brain. Input is the structured thoughts captured in one session. " +
          "Return a punchy one-line headline (max 90 chars), the concrete tasks (verbs first), decisions with chosen and rejected options, reusable code snippets, unanswered questions, and up to 2 short notable quotes taken VERBATIM from the thoughts. " +
          "Only use what is in the input; thought_code must be the [T-n] code of the source thought. Do not infer emotions or anything about people.",
        user: `Thoughts:\n${lines}\n\nFiltered asides: ${filtered}`,
        schema: BriefSchema,
        maxTokens: 900,
      });
      if (res) {
        out = {
          ...local,
          headline: res.headline,
          tasks: res.tasks.map((x) => ({ title: x.title, thoughtCode: x.thought_code })),
          decisions: res.decisions.map((x) => ({ title: x.title, chosen: x.chosen, rejected: x.rejected, thoughtCode: x.thought_code })),
          snippets: res.snippets.map((x) => ({ title: x.title, language: x.language, thoughtCode: x.thought_code })),
          openLoops: res.open_loops,
          notableQuotes: res.notable_quotes,
        };
      }
    }
    this.d.emit({ type: "brief.ready", brief: out });
    return out;
  }
}
