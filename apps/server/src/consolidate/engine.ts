import { z } from "zod";
import type { GraphEdge } from "@synapse/shared";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { EmitFn } from "../ctx";
import { graphDeltaFor } from "../memory/graph";
import { dot, type Embedder } from "../memory/embeddings";
import type { DeepLlm } from "../llm/deep";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import type { EntityRec, ThoughtRec } from "../memory/types";
import type { AuditChain } from "../privacy/audit";
import { fold } from "../text";
import { T } from "../thresholds";

/* ============================================================================
 * Sleep cycle (PRD MEM-4, TRD §8.7): like human consolidation, memory is tidied while idle.
 *   1. expire working memory (crypto-shred spent day keys)
 *   2. merge duplicate entities ("cart service" ≈ "cart-service")
 *   3. link new thoughts to related thoughts from OTHER sessions (same_topic) and, when the DEEP
 *      model is available, label HOW they relate (refines / contradicts / follows_up) with a reason
 *   4. give finished sessions a short label
 *   5. dictionary hygiene (stale jargon fades; the dictionary feeds Wispr)
 * Everything works without the model; the model only sharpens relation labels.
 * ========================================================================== */

export interface ConsolidationReport {
  expired: number;
  merged: number;
  linked: number;
  labelled: number;
  sessionsLabelled: number;
  dictionaryPruned: number;
  ms: number;
}

const RelationSchema = z.object({
  pairs: z.array(
    z.object({
      a: z.string(),
      b: z.string(),
      relation: z.enum(["refines", "contradicts", "follows_up", "same_topic", "unrelated"]),
      why: z.string(),
    }),
  ),
});

export class Consolidator {
  private timer?: ReturnType<typeof setInterval>;
  private lastRun = 0;
  private running = false;
  /** thoughts already linked (so a re-run is cheap) */
  private linked = new Set<string>();
  last?: ConsolidationReport;

  constructor(
    private d: { cfg: Config; clock: Clock; store: MemoryStore; embedder: Embedder; deep: DeepLlm; emit: EmitFn; audit: AuditChain; isPaused: () => boolean },
  ) {}

  start(): void {
    const every = Math.max(1, this.d.cfg.memory.consolidateIntervalMin) * 60_000;
    this.timer = setInterval(() => void this.run().catch((e) => log.warn("consolidate", `failed: ${(e as Error).message}`)), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<ConsolidationReport> {
    if (this.running) return this.last ?? { expired: 0, merged: 0, linked: 0, labelled: 0, sessionsLabelled: 0, dictionaryPruned: 0, ms: 0 };
    this.running = true;
    const t0 = performance.now();
    try {
      const { store, clock } = this.d;
      const expired = store.sweep(clock.now()).thoughts;
      const merged = this.mergeEntities();
      const { linked, labelled } = await this.linkThoughts();
      const sessionsLabelled = this.labelSessions();
      const dictionaryPruned = this.pruneDictionary();
      this.lastRun = clock.now();
      const report: ConsolidationReport = { expired, merged, linked, labelled, sessionsLabelled, dictionaryPruned, ms: Math.round(performance.now() - t0) };
      this.last = report;
      this.d.audit.append("consolidated", null, merged + linked + sessionsLabelled);
      if (merged + linked + sessionsLabelled > 0) log.info("consolidate", "sleep cycle", { ...report });
      return report;
    } finally {
      this.running = false;
    }
  }

  // ----------------------------------------------------------- entity merge --

  private mergeEntities(): number {
    const { store, embedder } = this.d;
    const ents = [...store.entities.values()];
    let merged = 0;
    const dead = new Set<string>();
    for (let i = 0; i < ents.length; i++) {
      const a = ents[i] as EntityRec;
      if (dead.has(a.id)) continue;
      for (let j = i + 1; j < ents.length; j++) {
        const b = ents[j] as EntityRec;
        if (dead.has(b.id) || a.type !== b.type) continue;
        const names = (e: EntityRec) => [e.name, ...e.aliases].map((n) => fold(n).replace(/[\s-]+/g, ""));
        const same = names(a).some((n) => names(b).includes(n)) || embedder.calibrate(dot(a.emb, b.emb)) >= 0.93;
        if (!same) continue;
        const [keep, drop] = a.longTerm >= b.longTerm && a.mentionCount >= b.mentionCount ? [a, b] : [b, a];
        this.mergeInto(keep, drop);
        dead.add(drop.id);
        merged++;
        if (drop === a) break;
      }
    }
    return merged;
  }

  private mergeInto(keep: EntityRec, drop: EntityRec): void {
    const { store } = this.d;
    for (const alias of [drop.name, ...drop.aliases]) {
      if (fold(alias) !== fold(keep.name) && !keep.aliases.some((x) => fold(x) === fold(alias))) keep.aliases.push(alias);
    }
    keep.mentionCount += drop.mentionCount;
    keep.firstSeen = Math.min(keep.firstSeen, drop.firstSeen);
    keep.lastSeen = Math.max(keep.lastSeen, drop.lastSeen);
    keep.salience = Math.max(keep.salience, drop.salience);
    if (drop.longTerm > keep.longTerm) keep.longTerm = drop.longTerm;
    for (const t of store.thoughtsOfEntity(drop.id)) {
      t.entityIds = [...new Set(t.entityIds.map((id) => (id === drop.id ? keep.id : id)))];
      store.db.run("DELETE FROM thought_entities WHERE thought_id = ? AND entity_id = ?", t.id, drop.id);
      store.db.run("INSERT OR IGNORE INTO thought_entities(thought_id, entity_id) VALUES(?,?)", t.id, keep.id);
      store.saveThought(t);
    }
    for (const e of store.edgesOf(drop.id)) {
      const src = e.src === drop.id ? keep.id : e.src;
      const dst = e.dst === drop.id ? keep.id : e.dst;
      if (src !== dst) store.upsertEdge(src, dst, e.type, e.weight);
    }
    store.removeEntity(drop.id);
    store.saveEntity(keep); // aliases / counts changed
  }

  // ------------------------------------------------------- cross-session link --

  private async linkThoughts(): Promise<{ linked: number; labelled: number }> {
    const { store, embedder } = this.d;
    const fresh = [...store.thoughts.values()].filter((t) => !t.provisional && t.status === "final" && store.isRecallable(t) && !this.linked.has(t.id));
    const pairs: Array<{ a: ThoughtRec; b: ThoughtRec; sim: number }> = [];
    for (const t of fresh) {
      this.linked.add(t.id);
      const hits = store.thoughtVec.search(t.emb, 6, (id) => {
        const o = store.thoughts.get(id);
        return Boolean(o && o.id !== t.id && o.sessionId !== t.sessionId && !o.provisional && store.isRecallable(o));
      });
      let n = 0;
      for (const h of hits) {
        const sim = embedder.calibrate(h.score);
        if (sim < T.link || n >= 3) continue;
        const o = store.thoughts.get(h.id) as ThoughtRec;
        pairs.push({ a: t, b: o, sim });
        n++;
      }
    }
    let linked = 0;
    const newEdges: GraphEdge[] = [];
    for (const p of pairs) {
      const e = store.upsertEdge(p.a.id, p.b.id, "same_topic", p.sim);
      newEdges.push({ id: e.id, src: e.src, dst: e.dst, type: e.type, weight: e.weight });
      linked++;
    }

    // optional: let the DEEP model say HOW they relate (best pairs only)
    let labelled = 0;
    if (pairs.length && this.d.deep.available) {
      const best = [...pairs].sort((x, y) => y.sim - x.sim).slice(0, 8);
      const res = await this.d.deep.json({
        system:
          "You label how two of a person's spoken thoughts relate. For each pair choose: refines (B adds detail to or improves A), contradicts (they disagree), follows_up (B is a later step on A), same_topic (just related), unrelated. Give a one-line reason using only the text provided.",
        user: best.map((p) => `A [${p.a.code}] ${p.a.title}: ${p.a.intent}\nB [${p.b.code}] ${p.b.title}: ${p.b.intent}`).join("\n---\n"),
        schema: RelationSchema,
        maxTokens: 2500,
      });
      if (res) {
        for (const r of res.pairs) {
          const a = best.find((p) => p.a.code === r.a && p.b.code === r.b) ?? best.find((p) => p.a.code === r.b && p.b.code === r.a);
          if (!a || r.relation === "same_topic") continue;
          if (r.relation === "unrelated") {
            store.db.run("DELETE FROM edges WHERE src = ? AND dst = ? AND type = 'same_topic'", a.a.id, a.b.id);
            continue;
          }
          const e = store.upsertEdge(a.a.id, a.b.id, r.relation, a.sim);
          newEdges.push({ id: e.id, src: e.src, dst: e.dst, type: e.type, weight: e.weight, label: r.why });
          labelled++;
        }
      }
    }
    if (newEdges.length) {
      const nodes = new Map<string, ReturnType<typeof graphDeltaFor>["nodes"][number]>();
      for (const p of pairs) for (const t of [p.a, p.b]) for (const n of graphDeltaFor(store, t).nodes) nodes.set(n.id, n);
      this.d.emit({ type: "graph.delta", nodes: [...nodes.values()], edges: newEdges, removedNodes: [], removedEdges: [] });
    }
    return { linked, labelled };
  }

  // ------------------------------------------------------------ labels / dict --

  private labelSessions(): number {
    const { store } = this.d;
    let n = 0;
    for (const s of store.sessions.values()) {
      if (s.label) continue;
      const ts = [...store.thoughts.values()].filter((t) => t.sessionId === s.id && store.isRecallable(t));
      if (!ts.length || (!s.endedAt && this.d.clock.now() - s.startedAt < 10 * 60_000)) continue;
      const counts = new Map<string, number>();
      for (const t of ts) for (const id of t.entityIds) {
        const e = store.entities.get(id);
        if (e && e.type !== "person") counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
      const cats = new Map<string, number>();
      for (const t of ts) cats.set(t.category, (cats.get(t.category) ?? 0) + 1);
      const topCat = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "thoughts";
      const where = s.activity === "walking" ? "Walk" : s.activity === "vehicle" ? "Commute" : s.deviceKind === "pocket" ? "Phone" : "Desk";
      store.setSessionLabel(s.id, `${where}: ${top.length ? top.join(", ") : topCat}`);
      n++;
    }
    return n;
  }

  private pruneDictionary(): number {
    const { store, clock } = this.d;
    let n = 0;
    for (const [key, d] of [...store.dict.entries()]) {
      if (d.source === "team" || d.source === "seed") continue;
      const stale = clock.now() - d.lastSeen > 30 * 86400_000 && d.salience < 0.5;
      if (stale) {
        store.dict.delete(key);
        store.db.run("DELETE FROM dictionary WHERE id = ?", d.id);
        n++;
      }
    }
    return n;
  }
}
