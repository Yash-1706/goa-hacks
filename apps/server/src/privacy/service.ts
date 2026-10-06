import { LIMITS } from "../thresholds";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { Controls, DeviceRef, EmitFn, Hub } from "../ctx";
import type { CortexEngine } from "../cortex/engine";
import type { ControlIntent } from "../gate/intent";
import { log } from "../log";
import type { Embedder } from "../memory/embeddings";
import type { MemoryStore } from "../memory/store";
import { searchThoughts } from "../recall/search";
import type { AuditChain } from "./audit";

/* ============================================================================
 * Guardian (PRD §6.6, TRD §10.2): the privacy control plane.
 *   pause   — stops capture on EVERY device, purges the trailing window, stays paused until a
 *             deliberate tap (a voice resume would contradict a released microphone)
 *   forget  — by window ("the last five minutes"), by meaning ("what I said about Sarah"),
 *             or the last thought ("forget that")
 *   purge / export / ledger — manual controls from the Privacy Center
 * ========================================================================== */

export class PrivacyService implements Controls {
  private paused = false;
  private pausedAt: number | undefined;
  private pausedBy: string | undefined;
  private engine!: CortexEngine;
  localOnly: boolean;

  constructor(
    private d: {
      cfg: Config;
      clock: Clock;
      bus: Bus;
      store: MemoryStore;
      embedder: Embedder;
      audit: AuditChain;
      hub: Hub;
      emit: EmitFn;
    },
  ) {
    this.localOnly = d.cfg.privacy.localOnly || d.store.db.getSetting("local_only") === "1";
    this.paused = d.store.db.getSetting("paused") === "1";
    if (this.paused) {
      this.pausedAt = Number(d.store.db.getSetting("paused_at") ?? 0) || undefined;
      this.pausedBy = d.store.db.getSetting("paused_by") ?? "restart";
    }
  }

  attachEngine(engine: CortexEngine): void {
    this.engine = engine;
  }

  isPaused(): boolean {
    return this.paused;
  }

  snapshot(): { paused: boolean; pausedAt?: number; pausedBy?: string } {
    return { paused: this.paused, pausedAt: this.pausedAt, pausedBy: this.pausedBy };
  }

  async handle(intent: ControlIntent, dev: DeviceRef, via: "voice" | "semantic"): Promise<void> {
    if (intent.kind === "pause") {
      await this.pause(dev.id, via === "semantic" ? "semantic" : "voice");
      return;
    }
    await this.forget(intent.scope, { windowSecs: intent.windowSecs, query: intent.query, deviceId: dev.id });
  }

  // ------------------------------------------------------------------ pause --

  async pause(by: string, via: string, purgeWindowSecs = this.d.cfg.memory.pauseWindowSecs): Promise<{ purged: number }> {
    if (this.paused) return { purged: 0 };
    const { store, clock } = this.d;
    const now = clock.now();
    this.paused = true;
    this.pausedAt = now;
    this.pausedBy = by;
    store.db.setSetting("paused", "1");
    store.db.setSetting("paused_at", String(now));
    store.db.setSetting("paused_by", by);

    // Everything in flight is dropped first so nothing can be written after the pause.
    this.engine?.closeAllWithoutAnalysis();
    const removed = purgeWindowSecs > 0 ? store.purgeSince(now - purgeWindowSecs * 1000) : [];
    this.announceRemoved(removed, "purged");
    this.d.audit.append("paused", `${via}:${by}`, removed.length);

    this.d.emit({ type: "privacy.paused", by, purgedCount: removed.length, at: now });
    this.d.emit({ type: "notice", level: "info", text: removed.length ? `Memory paused. ${removed.length} recent thought${removed.length > 1 ? "s" : ""} forgotten.` : "Memory paused.", at: now });
    this.broadcastState();
    this.d.bus.emit("privacy.paused", { by, at: now });
    log.info("privacy", "paused", { by, via, purged: removed.length });
    return { purged: removed.length };
  }

  resume(by: string): void {
    if (!this.paused) return;
    const now = this.d.clock.now();
    this.paused = false;
    this.pausedAt = undefined;
    this.pausedBy = undefined;
    this.d.store.db.setSetting("paused", "0");
    this.d.audit.append("resumed", by, null);
    this.d.emit({ type: "privacy.resumed", by, at: now });
    this.d.emit({ type: "notice", level: "success", text: "Memory resumed.", at: now });
    this.broadcastState();
    this.d.bus.emit("privacy.resumed", { by, at: now });
  }

  // ----------------------------------------------------------------- forget --

  async forget(scope: "last" | "window" | "query", o: { windowSecs?: number; query?: string; deviceId?: string }): Promise<{ count: number }> {
    const { store, clock, embedder } = this.d;
    const now = clock.now();
    let removed: string[] = [];

    if (scope === "window") {
      removed = store.purgeSince(now - (o.windowSecs ?? 300) * 1000);
    } else if (scope === "last") {
      // the thought being spoken about right now, else the most recent one
      const recent = [...store.thoughts.values()]
        .filter((t) => store.isRecallable(t) || t.category === "aside")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (recent && now - recent.updatedAt < 15 * 60_000 && store.deleteThought(recent.id)) removed = [recent.id];
    } else if (scope === "query" && o.query) {
      const [qEmb] = await embedder.embed([o.query], "query");
      if (qEmb) {
        const hits = searchThoughts(store, embedder, { query: o.query, qEmb, now, limit: 8, minScore: 0.4, persons: undefined });
        for (const h of hits.slice(0, 8)) if (store.deleteThought(h.thought.id)) removed.push(h.thought.id);
      }
    }

    this.engine?.forgetThoughts(removed);
    this.announceRemoved(removed, "forgotten");
    this.d.audit.append("purged", `forget:${scope}`, removed.length);
    this.d.emit({ type: "privacy.forgot", scope, count: removed.length, query: o.query, at: now });
    this.d.emit({
      type: "notice",
      level: removed.length ? "success" : "info",
      text: removed.length ? `Forgot ${removed.length} thought${removed.length > 1 ? "s" : ""}${o.query ? ` about "${o.query}"` : ""}.` : "Nothing to forget.",
      at: now,
    });
    return { count: removed.length };
  }

  /** Delete specific thoughts (Privacy Center "delete" button / card "forget"). */
  deleteThoughts(ids: string[]): number {
    const removed = ids.filter((id) => this.d.store.deleteThought(id));
    this.engine?.forgetThoughts(removed);
    this.announceRemoved(removed, "forgotten");
    this.d.audit.append("deleted", "ledger", removed.length);
    this.d.emit({ type: "privacy.forgot", scope: "ledger", count: removed.length, at: this.d.clock.now() });
    return removed.length;
  }

  /** Wipe everything (Privacy Center "delete all my memory"). Day keys are destroyed too. */
  wipeAll(): number {
    const { store, clock } = this.d;
    const ids = [...store.thoughts.keys()];
    for (const id of ids) store.deleteThought(id);
    this.engine?.closeAllWithoutAnalysis();
    this.announceRemoved(ids, "forgotten");
    for (const k of store.vault.listKeys()) if (k.scope === "day" && !k.destroyedAt) store.vault.destroyKey(k.id, clock.now());
    this.d.audit.append("deleted", "wipe-all", ids.length);
    this.d.emit({ type: "privacy.forgot", scope: "ledger", count: ids.length, at: clock.now() });
    return ids.length;
  }

  setLocalOnly(on: boolean): void {
    this.localOnly = on;
    this.d.store.db.setSetting("local_only", on ? "1" : "0");
    this.d.audit.append(on ? "local_only_on" : "local_only_off", null, null);
  }

  // ---------------------------------------------------------------- helpers --

  private announceRemoved(ids: string[], reason: "purged" | "forgotten"): void {
    for (const id of ids) this.d.emit({ type: "thought.remove", id, reason });
    if (ids.length) this.d.emit({ type: "graph.delta", nodes: [], edges: [], removedNodes: ids, removedEdges: [] });
  }

  private broadcastState(): void {
    this.d.emit({ type: "state.update", paused: this.paused, pausedAt: this.pausedAt, pausedBy: this.pausedBy, devices: this.d.hub.devices() });
  }

  /** Everything Synapse stores about the user, decrypted, as JSON (Privacy Center "export"). */
  exportAll(): Record<string, unknown> {
    const { store } = this.d;
    this.d.audit.append("exported", null, store.thoughts.size);
    return {
      exportedAt: this.d.clock.now(),
      note: "Audio is never stored. This is everything Synapse remembers, decrypted for you.",
      thoughts: [...store.thoughts.values()].map((t) => ({ ...store.toView(t) })),
      entities: [...store.entities.values()].map((e) => ({ code: e.code, name: e.name, type: e.type, aliases: e.aliases, mentions: e.mentionCount, longTerm: e.longTerm })),
      openLoops: [...store.openLoops.values()].map((o) => ({ question: o.question, status: o.status, createdAt: o.createdAt })),
      dictionary: [...store.dict.values()].map((d) => ({ term: d.term, kind: d.kind, source: d.source })),
      audit: this.d.audit.list(1000),
      retention: { workingMemoryHours: this.d.cfg.memory.ttlHours, quietMs: LIMITS.quietMs },
    };
  }
}
