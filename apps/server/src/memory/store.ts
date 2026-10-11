import type {
  ArtifactView,
  Category,
  EntityRefView,
  EntityType,
  FragmentView,
  LedgerItem,
  SuggestionView,
  ThoughtView,
} from "@synapse/shared";
import type { Clock } from "../clock";
import { newId } from "../ids";
import { log } from "../log";
import { fold } from "../text";
import { T } from "../thresholds";
import type { Db } from "./db";
import type { Vault } from "./crypto";
import { dayKeyId } from "./crypto";
import { dot, type Embedder } from "./embeddings";
import * as P from "./persist";
import type {
  ArtifactRec,
  CalendarRec,
  DeleteReport,
  DictRec,
  EdgeRec,
  EntityRec,
  FragRec,
  OpenLoopRec,
  SessionRec,
  SuggestionRec,
  ThoughtRec,
} from "./types";
import { LexIndex, VecIndex } from "./vindex";

/** Categories whose thoughts must never surface in retrieval (they are control or ephemeral). */
export const NON_RECALLABLE: ReadonlySet<Category> = new Set<Category>(["recall_query", "privacy", "correction", "aside"]);

export interface SweepReport {
  thoughts: number;
  fragments: number;
  keysDestroyed: string[];
  sessions: number;
}

export type AuditFn = (event: string, ref: string | null, count: number | null) => void;

export class MemoryStore {
  sessions = new Map<string, SessionRec>();
  frags = new Map<string, FragRec>();
  thoughts = new Map<string, ThoughtRec>();
  entities = new Map<string, EntityRec>();
  edges = new Map<string, EdgeRec>();
  private edgeKeys = new Map<string, string>();
  artifacts = new Map<string, ArtifactRec>();
  openLoops = new Map<string, OpenLoopRec>();
  suggestions = new Map<string, SuggestionRec>();
  dict = new Map<string, DictRec>();
  calendar = new Map<string, CalendarRec>();

  thoughtVec: VecIndex;
  fragVec: VecIndex;
  entityVec: VecIndex;
  lex = new LexIndex();

  audit: AuditFn = () => {};
  ttlMs: number;

  constructor(
    readonly db: Db,
    readonly vault: Vault,
    readonly embedder: Embedder,
    readonly clock: Clock,
    ttlHours: number,
  ) {
    this.ttlMs = ttlHours * 3600_000;
    this.thoughtVec = new VecIndex(embedder.dim);
    this.fragVec = new VecIndex(embedder.dim);
    this.entityVec = new VecIndex(embedder.dim);
  }

  // ------------------------------------------------------------------ boot --

  async init(): Promise<void> {
    const t0 = performance.now();
    for (const s of P.loadSessions(this.db, this.vault)) this.sessions.set(s.id, s);
    for (const f of P.loadFragments(this.db, this.vault)) this.frags.set(f.id, f);
    for (const e of P.loadEntities(this.db, this.vault)) this.entities.set(e.id, e);
    for (const t of P.loadThoughts(this.db, this.vault)) this.thoughts.set(t.id, t);
    for (const e of P.loadEdges(this.db)) this.putEdge(e);
    for (const a of P.loadArtifacts(this.db, this.vault)) this.artifacts.set(a.id, a);
    for (const o of P.loadOpenLoops(this.db, this.vault)) this.openLoops.set(o.id, o);
    for (const s of P.loadSuggestions(this.db, this.vault)) this.suggestions.set(s.view.id, s);
    for (const d of P.loadDict(this.db, this.vault)) this.dict.set(d.term.toLowerCase(), d);
    for (const c of P.loadCalendar(this.db, this.vault)) this.calendar.set(c.id, c);

    // embedding model changed since the data was written → re-embed everything
    const stored = this.db.getSetting("embed_name");
    if (stored && stored !== this.embedder.name && (this.thoughts.size || this.frags.size || this.entities.size)) {
      log.warn("store", `embedding model changed (${stored} → ${this.embedder.name}); re-embedding`);
      await this.reembedAll();
    }
    this.db.setSetting("embed_name", this.embedder.name);

    for (const t of this.thoughts.values()) this.reindexThought(t);
    for (const e of this.entities.values()) this.entityVec.upsert(e.id, e.emb);
    log.info("store", "memory loaded", {
      thoughts: this.thoughts.size,
      fragments: this.frags.size,
      entities: this.entities.size,
      ms: Math.round(performance.now() - t0),
    });
  }

  /**
   * After a restart nothing is in flight any more, so a thought that was still open (or still showing its first-paint
   * card) when the process stopped would stay "analyzing" forever and never be summarised or recalled. It is as final as
   * it is going to get.
   */
  recoverUnfinished(): number {
    let n = 0;
    for (const t of this.thoughts.values()) {
      if (t.status === "final" && !t.provisional) continue;
      t.status = "final";
      t.provisional = false;
      this.saveThought(t);
      n++;
    }
    if (n) log.info("store", "finalized thoughts that were still open at shutdown", { thoughts: n });
    return n;
  }

  private async reembedAll(): Promise<void> {
    const frs = [...this.frags.values()];
    for (let i = 0; i < frs.length; i += 32) {
      const batch = frs.slice(i, i + 32);
      const embs = await this.embedder.embed(batch.map((f) => f.text), "passage");
      batch.forEach((f, j) => {
        f.emb = embs[j] as Float32Array;
        P.saveFragment(this.db, this.vault, f);
      });
    }
    const ths = [...this.thoughts.values()];
    for (let i = 0; i < ths.length; i += 32) {
      const batch = ths.slice(i, i + 32);
      const embs = await this.embedder.embed(batch.map((t) => `${t.title}. ${t.intent}`), "passage");
      batch.forEach((t, j) => {
        t.emb = embs[j] as Float32Array;
        P.saveThought(this.db, this.vault, t);
      });
    }
    const ens = [...this.entities.values()];
    const eembs = await this.embedder.embed(ens.map((e) => fold(e.name)), "passage");
    ens.forEach((e, j) => {
      e.emb = eembs[j] as Float32Array;
      P.saveEntity(this.db, this.vault, e);
    });
  }

  // -------------------------------------------------------------- sessions --

  ensureSession(id: string, deviceId: string, deviceKind: "desk" | "pocket", activity: SessionRec["activity"]): SessionRec {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const s: SessionRec = {
      id,
      code: this.db.nextCode("S"),
      deviceId,
      deviceKind,
      startedAt: this.clock.now(),
      endedAt: null,
      activity,
      label: null,
      keyId: "ltm",
    };
    this.sessions.set(id, s);
    P.saveSession(this.db, this.vault, s);
    return s;
  }

  endSession(id: string): SessionRec | undefined {
    const s = this.sessions.get(id);
    if (!s || s.endedAt) return s;
    s.endedAt = this.clock.now();
    P.saveSession(this.db, this.vault, s);
    return s;
  }

  setSessionLabel(id: string, label: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.label = label;
    P.saveSession(this.db, this.vault, s);
  }

  // ------------------------------------------------------------- thoughts --

  workingExpiry(now: number): number {
    return now + this.ttlMs;
  }

  createThought(init: {
    sessionId: string;
    deviceId: string;
    deviceKind: "desk" | "pocket";
    activity: ThoughtRec["activity"];
    category: Category;
    title: string;
    intent: string;
    emb: Float32Array;
    source: ThoughtRec["source"];
    confidence?: number;
  }): ThoughtRec {
    const now = this.clock.now();
    const t: ThoughtRec = {
      id: newId(),
      code: this.db.nextCode("T"),
      sessionId: init.sessionId,
      deviceId: init.deviceId,
      deviceKind: init.deviceKind,
      activity: init.activity,
      status: "open",
      provisional: true,
      tentative: false,
      source: init.source,
      category: init.category,
      confidence: init.confidence ?? 0.4,
      title: init.title,
      intent: init.intent,
      why: "",
      references: [],
      repairs: [],
      openQuestions: [],
      fragmentIds: [],
      entityIds: [],
      artifactId: null,
      salience: 0,
      salienceReasons: [],
      salienceCues: [],
      promoted: false,
      concernKey: null,
      emb: init.emb,
      keyId: this.vault.workingKeyId(now),
      expiresAt: this.workingExpiry(now),
      createdAt: now,
      updatedAt: now,
      version: 1,
      timing: {},
    };
    this.thoughts.set(t.id, t);
    this.saveThought(t);
    return t;
  }

  /** Persist + reindex a thought after the caller mutated it. */
  saveThought(t: ThoughtRec): void {
    t.updatedAt = this.clock.now();
    P.saveThought(this.db, this.vault, t);
    this.reindexThought(t);
  }

  getThought(id: string): ThoughtRec | undefined {
    return this.thoughts.get(id);
  }

  isRecallable(t: ThoughtRec): boolean {
    return !NON_RECALLABLE.has(t.category) && !t.retracted;
  }

  reindexThought(t: ThoughtRec): void {
    if (!this.isRecallable(t)) {
      this.thoughtVec.remove(t.id);
      this.lex.remove(t.id);
      for (const fid of t.fragmentIds) this.fragVec.remove(fid);
      return;
    }
    this.thoughtVec.upsert(t.id, t.emb);
    const ftext = t.fragmentIds.map((id) => this.frags.get(id)?.text ?? "").join(" ");
    const ents = t.entityIds.map((id) => this.entities.get(id)?.name ?? "").join(" ");
    this.lex.upsert(t.id, t.title, `${t.intent} ${ftext} ${ents}`);
    for (const fid of t.fragmentIds) {
      const f = this.frags.get(fid);
      if (f) this.fragVec.upsert(fid, f.emb);
    }
  }

  // ------------------------------------------------------------ fragments --

  addFragment(
    init: Omit<FragRec, "keyId" | "expiresAt" | "createdAt">,
    thought: ThoughtRec,
  ): FragRec {
    const now = this.clock.now();
    const f: FragRec = { ...init, keyId: thought.keyId, expiresAt: thought.expiresAt, createdAt: now };
    this.frags.set(f.id, f);
    if (!thought.fragmentIds.includes(f.id)) thought.fragmentIds.push(f.id);
    P.saveFragment(this.db, this.vault, f);
    return f;
  }

  /** Move a fragment between thoughts (thread split/merge). */
  moveFragment(f: FragRec, to: ThoughtRec): void {
    const from = this.thoughts.get(f.thoughtId);
    if (from) from.fragmentIds = from.fragmentIds.filter((id) => id !== f.id);
    f.thoughtId = to.id;
    f.keyId = to.keyId;
    f.expiresAt = to.expiresAt;
    if (!to.fragmentIds.includes(f.id)) to.fragmentIds.push(f.id);
    to.fragmentIds.sort((a, b) => (this.frags.get(a)?.tStart ?? 0) - (this.frags.get(b)?.tStart ?? 0));
    P.saveFragment(this.db, this.vault, f);
  }

  fragmentsOf(t: ThoughtRec): FragRec[] {
    return t.fragmentIds.map((id) => this.frags.get(id)).filter((f): f is FragRec => Boolean(f));
  }

  // -------------------------------------------------------------- entities --

  /** Resolve (or create) an entity. Matching: exact/alias → person first name → separator-less → embedding. */
  async upsertEntity(name: string, type: EntityType, hintId?: string | null): Promise<EntityRec | null> {
    const clean = name.trim().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 80) return null;
    const folded = fold(clean);
    if (!folded) return null;
    const squashed = folded.replace(/[\s'-]+/g, "");

    if (hintId) {
      const byHint = this.entities.get(hintId);
      if (byHint) return this.addAlias(byHint, clean);
    }
    let best: EntityRec | undefined;
    for (const e of this.entities.values()) {
      const names = [e.name, ...e.aliases].map(fold);
      if (names.includes(folded)) {
        best = e;
        break;
      }
      if (names.some((n) => n.replace(/[\s'-]+/g, "") === squashed)) {
        best = e;
        break;
      }
      if (type === "person" && e.type === "person") {
        const first = (n: string) => n.split(" ")[0];
        if (names.some((n) => first(n) === first(folded) && (n === first(n) || folded === first(folded)))) {
          best = e;
          break;
        }
      }
    }
    if (best) return this.addAlias(best, clean);

    const [emb] = await this.embedder.embed([folded], "passage");
    if (!emb) return null;
    let nearest: { e: EntityRec; s: number } | undefined;
    for (const e of this.entities.values()) {
      if (e.type !== type) continue;
      const s = this.embedder.calibrate(dot(emb, e.emb));
      if (s >= T.entityMerge && (!nearest || s > nearest.s)) nearest = { e, s };
    }
    if (nearest) return this.addAlias(nearest.e, clean);

    const now = this.clock.now();
    const rec: EntityRec = {
      id: newId(),
      code: this.db.nextCode("E"),
      type,
      name: clean,
      aliases: [],
      emb,
      salience: 0.2,
      mentionCount: 0,
      firstSeen: now,
      lastSeen: now,
      longTerm: 0,
      expiresAt: this.workingExpiry(now),
      keyId: this.vault.workingKeyId(now),
    };
    this.entities.set(rec.id, rec);
    P.saveEntity(this.db, this.vault, rec);
    this.entityVec.upsert(rec.id, rec.emb);
    return rec;
  }

  private addAlias(e: EntityRec, alias: string): EntityRec {
    if (fold(alias) !== fold(e.name) && !e.aliases.some((a) => fold(a) === fold(alias))) {
      e.aliases.push(alias);
      P.saveEntity(this.db, this.vault, e);
    }
    return e;
  }

  /** Replace a thought's entity links; keeps counts honest (no inflation on re-analysis). */
  linkEntities(t: ThoughtRec, ents: EntityRec[]): void {
    const now = this.clock.now();
    const next = new Set(ents.map((e) => e.id));
    const prev = new Set(t.entityIds);
    for (const id of prev) {
      if (next.has(id)) continue;
      this.db.run("DELETE FROM thought_entities WHERE thought_id = ? AND entity_id = ?", t.id, id);
      const e = this.entities.get(id);
      if (e) {
        e.mentionCount = Math.max(0, e.mentionCount - 1);
        P.saveEntity(this.db, this.vault, e);
      }
    }
    for (const e of ents) {
      if (!prev.has(e.id)) {
        this.db.run("INSERT OR IGNORE INTO thought_entities(thought_id, entity_id) VALUES(?,?)", t.id, e.id);
        e.mentionCount += 1;
      }
      e.lastSeen = now;
      e.salience = Math.min(1, 0.2 + 0.15 * e.mentionCount);
      const distinct = this.thoughtsOfEntity(e.id).length + (prev.has(e.id) ? 0 : 1);
      if (e.longTerm === 0 && (distinct >= 2 || t.promoted)) this.setEntityLongTerm(e);
      P.saveEntity(this.db, this.vault, e);
    }
    t.entityIds = ents.map((e) => e.id);
  }

  saveEntity(e: EntityRec): void {
    P.saveEntity(this.db, this.vault, e);
  }

  /** Remove an entity and everything that points at it (links, edges, vector, dictionary is untouched). */
  removeEntity(id: string): void {
    this.entities.delete(id);
    this.entityVec.remove(id);
    this.db.run("DELETE FROM thought_entities WHERE entity_id = ?", id);
    this.db.run("DELETE FROM entities WHERE id = ?", id);
    this.removeEdgesTouching(id);
  }

  /** Seed/pinned entities (teammates) are never garbage collected and never expire. */
  pinEntity(e: EntityRec): void {
    e.longTerm = 2;
    e.expiresAt = null;
    e.keyId = "ltm";
    P.saveEntity(this.db, this.vault, e);
  }

  private setEntityLongTerm(e: EntityRec): void {
    e.longTerm = 1;
    e.expiresAt = null;
    e.keyId = "ltm";
    P.saveEntity(this.db, this.vault, e);
  }

  thoughtsOfEntity(entityId: string): ThoughtRec[] {
    const out: ThoughtRec[] = [];
    for (const t of this.thoughts.values()) if (t.entityIds.includes(entityId)) out.push(t);
    return out;
  }

  // ----------------------------------------------------------------- edges --

  private putEdge(e: EdgeRec): void {
    this.edges.set(e.id, e);
    this.edgeKeys.set(`${e.src}|${e.dst}|${e.type}`, e.id);
  }

  upsertEdge(src: string, dst: string, type: EdgeRec["type"], weight = 1, validFrom: number | null = null): EdgeRec {
    const key = `${src}|${dst}|${type}`;
    const existing = this.edgeKeys.get(key);
    if (existing) {
      const e = this.edges.get(existing) as EdgeRec;
      e.weight = Math.max(e.weight, weight);
      P.saveEdge(this.db, e);
      return e;
    }
    const e: EdgeRec = { id: newId(), src, dst, type, weight, validFrom, validTo: null, createdAt: this.clock.now() };
    this.putEdge(e);
    P.saveEdge(this.db, e);
    return e;
  }

  edgesOf(id: string): EdgeRec[] {
    const out: EdgeRec[] = [];
    for (const e of this.edges.values()) if (e.src === id || e.dst === id) out.push(e);
    return out;
  }

  private removeEdgesTouching(id: string): number {
    let n = 0;
    for (const e of [...this.edges.values()]) {
      if (e.src !== id && e.dst !== id) continue;
      this.edges.delete(e.id);
      this.edgeKeys.delete(`${e.src}|${e.dst}|${e.type}`);
      this.db.run("DELETE FROM edges WHERE id = ?", e.id);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------- artifacts --

  createArtifact(t: ThoughtRec, payload: ArtifactRec["payload"], autonomyLevel: number): ArtifactRec {
    const now = this.clock.now();
    const a: ArtifactRec = {
      id: newId(),
      code: this.db.nextCode("A"),
      thoughtId: t.id,
      kind: payload.kind,
      status: "draft",
      autonomyLevel,
      payload,
      simulated: false,
      createdAt: now,
      updatedAt: now,
      expiresAt: t.expiresAt,
      keyId: t.keyId,
    };
    this.artifacts.set(a.id, a);
    t.artifactId = a.id;
    P.saveArtifact(this.db, this.vault, a);
    return a;
  }

  saveArtifact(a: ArtifactRec): void {
    a.updatedAt = this.clock.now();
    P.saveArtifact(this.db, this.vault, a);
  }

  deleteArtifact(id: string): void {
    const a = this.artifacts.get(id);
    if (!a) return;
    this.artifacts.delete(id);
    this.db.run("DELETE FROM artifacts WHERE id = ?", id);
    const t = this.thoughts.get(a.thoughtId);
    if (t && t.artifactId === id) t.artifactId = null;
  }

  // ----------------------------------------------------------- open loops --

  createOpenLoop(t: ThoughtRec, question: string): OpenLoopRec {
    const now = this.clock.now();
    const o: OpenLoopRec = {
      id: newId(),
      thoughtId: t.id,
      question,
      status: "open",
      createdAt: now,
      expiresAt: t.expiresAt,
      keyId: t.keyId,
    };
    this.openLoops.set(o.id, o);
    P.saveOpenLoop(this.db, this.vault, o);
    return o;
  }

  saveOpenLoop(o: OpenLoopRec): void {
    P.saveOpenLoop(this.db, this.vault, o);
  }

  loopsOf(thoughtId: string): OpenLoopRec[] {
    return [...this.openLoops.values()].filter((o) => o.thoughtId === thoughtId);
  }

  // ----------------------------------------------------------- suggestions --

  saveSuggestion(view: SuggestionView): SuggestionRec {
    let rec = this.suggestions.get(view.id);
    if (!rec) {
      rec = { view, keyId: this.vault.workingKeyId(this.clock.now()) };
      this.suggestions.set(view.id, rec);
    } else {
      rec.view = view;
    }
    P.saveSuggestion(this.db, this.vault, rec);
    return rec;
  }

  // ------------------------------------------------------------ dictionary --

  upsertDict(term: string, kind: DictRec["kind"], source: string, salience: number): DictRec | null {
    const t = term.trim();
    if (t.length < 2 || t.length > 60) return null;
    const key = t.toLowerCase();
    const now = this.clock.now();
    let d = this.dict.get(key);
    if (d) {
      d.salience = Math.max(d.salience, salience);
      d.lastSeen = now;
      // a correction is the most informative origin a term can have: it replaces "learned from ..." (and is never
      // overwritten by a later plain mention, nor by a seed/team entry)
      if (source.startsWith("corrected") || (/^learned/.test(d.source) && /^(team|seed)$/.test(source))) d.source = source;
    } else {
      d = { id: newId(), keyId: "ltm", term: t, kind, source, salience, lastSeen: now };
      this.dict.set(key, d);
    }
    P.saveDict(this.db, this.vault, d);
    return d;
  }

  /** Terms handed to Wispr `dictionary_context`, best first. */
  topDictionary(n: number): string[] {
    const now = this.clock.now();
    return [...this.dict.values()]
      .map((d) => ({ d, score: 0.6 * d.salience + 0.4 * Math.exp(-(now - d.lastSeen) / (7 * 86400_000)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((x) => x.d.term);
  }

  // -------------------------------------------------------------- calendar --

  addCalendar(title: string, start: number, end: number, source: CalendarRec["source"]): CalendarRec {
    const c: CalendarRec = { id: newId(), title, start, end, source, keyId: "ltm" };
    this.calendar.set(c.id, c);
    P.saveCalendar(this.db, this.vault, c);
    return c;
  }

  removeCalendar(id: string): void {
    this.calendar.delete(id);
    this.db.run("DELETE FROM calendar_events WHERE id = ?", id);
  }

  /** Change a working thought's retention, and that of everything that hangs off it. No-op once promoted. */
  setRetention(t: ThoughtRec, expiresAt: number): void {
    if (t.promoted || t.expiresAt === expiresAt) return;
    t.expiresAt = expiresAt;
    this.saveThought(t);
    for (const f of this.fragmentsOf(t)) {
      f.expiresAt = expiresAt;
      P.saveFragment(this.db, this.vault, f);
    }
    const a = t.artifactId ? this.artifacts.get(t.artifactId) : undefined;
    if (a) {
      a.expiresAt = expiresAt;
      P.saveArtifact(this.db, this.vault, a);
    }
    for (const o of this.loopsOf(t.id)) {
      o.expiresAt = expiresAt;
      P.saveOpenLoop(this.db, this.vault, o);
    }
  }

  // ------------------------------------------------------------- promotion --

  /** Move a thought (and everything that hangs off it) from working to long-term memory. */
  promote(t: ThoughtRec, reasons: string[]): void {
    if (t.promoted) return;
    t.promoted = true;
    t.keyId = "ltm";
    t.expiresAt = null;
    if (reasons.length) t.salienceReasons = reasons;
    this.saveThought(t);
    for (const f of this.fragmentsOf(t)) {
      f.keyId = "ltm";
      f.expiresAt = null;
      P.saveFragment(this.db, this.vault, f);
    }
    const a = t.artifactId ? this.artifacts.get(t.artifactId) : undefined;
    if (a) {
      a.keyId = "ltm";
      a.expiresAt = null;
      P.saveArtifact(this.db, this.vault, a);
    }
    for (const o of this.loopsOf(t.id)) {
      o.keyId = "ltm";
      o.expiresAt = null;
      P.saveOpenLoop(this.db, this.vault, o);
    }
    for (const id of t.entityIds) {
      const e = this.entities.get(id);
      if (e && e.longTerm === 0) this.setEntityLongTerm(e);
    }
    this.audit("promoted", t.code, 1);
  }

  // -------------------------------------------------------------- deletion --

  /** The single cascade deletion path (PRD PRV-11): TTL, purge, forget and the UI all end up here. */
  deleteThought(id: string): DeleteReport | null {
    const t = this.thoughts.get(id);
    if (!t) return null;
    const report: DeleteReport = {
      thoughtId: id, fragments: 0, artifacts: 0, openLoops: 0, entities: 0, edges: 0, suggestions: 0, dictionary: 0, externalLeft: [],
    };
    this.db.tx(() => {
      for (const fid of [...t.fragmentIds]) {
        if (this.frags.delete(fid)) report.fragments++;
        this.db.run("DELETE FROM fragments WHERE id = ?", fid);
        this.fragVec.remove(fid);
      }
      // fragments that point at the thought but were not in its list (defensive)
      for (const f of [...this.frags.values()]) {
        if (f.thoughtId !== id) continue;
        this.frags.delete(f.id);
        this.db.run("DELETE FROM fragments WHERE id = ?", f.id);
        this.fragVec.remove(f.id);
        report.fragments++;
      }
      for (const a of [...this.artifacts.values()].filter((x) => x.thoughtId === id)) {
        if (a.externalRef) report.externalLeft.push({ ref: a.externalRef, url: a.externalUrl });
        this.artifacts.delete(a.id);
        this.db.run("DELETE FROM artifacts WHERE id = ?", a.id);
        report.artifacts++;
      }
      for (const o of this.loopsOf(id)) {
        this.openLoops.delete(o.id);
        this.db.run("DELETE FROM open_loops WHERE id = ?", o.id);
        report.openLoops++;
      }
      report.edges += this.removeEdgesTouching(id);

      // entity garbage collection: entities nobody references any more disappear with their dictionary terms
      this.db.run("DELETE FROM thought_entities WHERE thought_id = ?", id);
      for (const eid of t.entityIds) {
        const e = this.entities.get(eid);
        if (!e) continue;
        e.mentionCount = Math.max(0, e.mentionCount - 1);
        const stillUsed = [...this.thoughts.values()].some((x) => x.id !== id && x.entityIds.includes(eid));
        if (!stillUsed && e.longTerm < 2) {
          this.entities.delete(eid);
          this.entityVec.remove(eid);
          this.db.run("DELETE FROM entities WHERE id = ?", eid);
          report.edges += this.removeEdgesTouching(eid);
          report.entities++;
          const dk = e.name.toLowerCase();
          const d = this.dict.get(dk);
          if (d && d.source !== "seed" && d.source !== "team") {
            this.dict.delete(dk);
            this.db.run("DELETE FROM dictionary WHERE id = ?", d.id);
            report.dictionary++;
          }
        } else {
          P.saveEntity(this.db, this.vault, e);
        }
      }

      // suggestions: drop the reference; remove suggestions left without any source
      for (const rec of [...this.suggestions.values()]) {
        const before = rec.view.sources.length;
        if (!before || !rec.view.sources.some((s) => s.thoughtId === id)) continue;
        rec.view.sources = rec.view.sources.filter((s) => s.thoughtId !== id);
        if (rec.view.sources.length === 0) {
          this.suggestions.delete(rec.view.id);
          this.db.run("DELETE FROM suggestions WHERE id = ?", rec.view.id);
          report.suggestions++;
        } else {
          P.saveSuggestion(this.db, this.vault, rec);
        }
      }

      this.thoughts.delete(id);
      this.db.run("DELETE FROM thoughts WHERE id = ?", id);
      this.db.run("DELETE FROM thought_entities WHERE thought_id = ?", id);
      this.thoughtVec.remove(id);
      this.lex.remove(id);
    });
    return report;
  }

  /** Delete every thought that has a fragment received at or after `since` (optionally one device). */
  purgeSince(since: number, deviceId?: string): string[] {
    const hit = new Set<string>();
    for (const f of this.frags.values()) {
      if (f.createdAt >= since && (!deviceId || f.deviceId === deviceId)) hit.add(f.thoughtId);
    }
    for (const t of this.thoughts.values()) {
      if (t.createdAt >= since && (!deviceId || t.deviceId === deviceId)) hit.add(t.id);
    }
    const removed: string[] = [];
    for (const id of hit) if (this.deleteThought(id)) removed.push(id);
    return removed;
  }

  // ----------------------------------------------------------------- sweep --

  /** TTL sweep + crypto-shredding of day keys that no longer protect anything. */
  sweep(now = this.clock.now()): SweepReport {
    const report: SweepReport = { thoughts: 0, fragments: 0, keysDestroyed: [], sessions: 0 };
    for (const t of [...this.thoughts.values()]) {
      if (t.promoted || t.expiresAt === null || t.expiresAt > now) continue;
      const r = this.deleteThought(t.id);
      if (r) {
        report.thoughts++;
        report.fragments += r.fragments;
        this.onExpired?.(t.id);
      }
    }
    for (const f of [...this.frags.values()]) {
      if (f.expiresAt !== null && f.expiresAt <= now && !this.thoughts.has(f.thoughtId)) {
        this.frags.delete(f.id);
        this.db.run("DELETE FROM fragments WHERE id = ?", f.id);
        this.fragVec.remove(f.id);
        report.fragments++;
      }
    }
    for (const o of [...this.openLoops.values()]) {
      if (o.expiresAt !== null && o.expiresAt <= now) {
        this.openLoops.delete(o.id);
        this.db.run("DELETE FROM open_loops WHERE id = ?", o.id);
      }
    }
    for (const rec of [...this.suggestions.values()]) {
      const old = now - rec.view.createdAt > 24 * 3600_000;
      if (old && rec.view.status !== "queued" && rec.view.status !== "delivered") {
        this.suggestions.delete(rec.view.id);
        this.db.run("DELETE FROM suggestions WHERE id = ?", rec.view.id);
      }
    }
    for (const e of [...this.entities.values()]) {
      if (e.expiresAt !== null && e.expiresAt <= now && e.longTerm === 0 && !this.thoughtsOfEntity(e.id).length) {
        this.entities.delete(e.id);
        this.entityVec.remove(e.id);
        this.db.run("DELETE FROM entities WHERE id = ?", e.id);
        this.removeEdgesTouching(e.id);
      }
    }
    const withThoughts = new Set([...this.thoughts.values()].map((t) => t.sessionId));
    for (const s of [...this.sessions.values()]) {
      if (s.endedAt && !withThoughts.has(s.id)) {
        this.sessions.delete(s.id);
        this.db.run("DELETE FROM sessions WHERE id = ?", s.id);
        report.sessions++;
      }
    }
    // crypto-shred day keys with no remaining rows once their data is past TTL
    for (const k of this.vault.listKeys()) {
      if (k.scope !== "day" || k.destroyedAt) continue;
      const day = Date.parse(`${k.id.slice(4)}T00:00:00Z`);
      if (!Number.isFinite(day) || day + 24 * 3600_000 + this.ttlMs > now) continue;
      if (this.keyInUse(k.id)) continue;
      if (this.vault.destroyKey(k.id, now)) report.keysDestroyed.push(k.id);
    }
    if (report.thoughts) this.audit("expired", null, report.thoughts);
    if (report.keysDestroyed.length) this.audit("key_destroyed", null, report.keysDestroyed.length);
    return report;
  }

  onExpired?: (thoughtId: string) => void;

  private keyInUse(keyId: string): boolean {
    const tables = ["thoughts", "fragments", "entities", "artifacts", "open_loops", "suggestions", "dictionary", "calendar_events", "sessions"];
    return tables.some((tb) => Boolean(this.db.get(`SELECT 1 AS x FROM ${tb} WHERE key_id = ? LIMIT 1`, keyId)));
  }

  // ----------------------------------------------------------------- views --

  fragmentView(f: FragRec): FragmentView {
    return {
      id: f.id,
      thoughtId: f.thoughtId,
      sessionId: f.sessionId,
      deviceId: f.deviceId,
      text: f.text,
      tStart: f.tStart,
      tEnd: f.tEnd,
      pauseBeforeMs: f.pauseBeforeMs,
      durationMs: f.durationMs,
      whisper: f.whisper,
      lang: f.lang,
      activity: f.activity,
      transport: f.transport,
    };
  }

  /** V1: routing adds route / needs / links to every view (set by the app; absent in bare tests) */
  decorateArtifact: ((a: ArtifactRec) => Partial<ArtifactView>) | null = null;

  artifactView(a: ArtifactRec): ArtifactView {
    return {
      ...this.baseView(a),
      ...(this.decorateArtifact?.(a) ?? {}),
    };
  }

  private baseView(a: ArtifactRec): ArtifactView {
    return {
      id: a.id,
      code: a.code,
      kind: a.kind,
      status: a.status,
      autonomyLevel: a.autonomyLevel,
      payload: a.payload,
      externalRef: a.externalRef,
      externalUrl: a.externalUrl,
      simulated: a.simulated || undefined,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  entityRefView(e: EntityRec): EntityRefView {
    return { id: e.id, code: e.code, name: e.name, type: e.type };
  }

  toView(t: ThoughtRec): ThoughtView {
    const art = t.artifactId ? this.artifacts.get(t.artifactId) : undefined;
    return {
      id: t.id,
      code: t.code,
      sessionId: t.sessionId,
      deviceId: t.deviceId,
      status: t.status,
      provisional: t.provisional,
      tentative: t.tentative,
      source: t.source,
      category: t.category,
      confidence: t.confidence,
      title: t.title,
      intent: t.intent,
      why: t.why,
      fragments: this.fragmentsOf(t).map((f) => this.fragmentView(f)),
      references: t.references,
      repairs: t.repairs,
      openQuestions: t.openQuestions,
      entities: t.entityIds.map((id) => this.entities.get(id)).filter((e): e is EntityRec => Boolean(e)).map((e) => this.entityRefView(e)),
      artifact: art ? this.artifactView(art) : null,
      salience: t.salience,
      salienceReasons: t.salienceReasons,
      promoted: t.promoted,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      version: t.version,
      timing: t.timing,
      correctsThoughtId: t.correctsThoughtId,
      retracted: t.retracted,
      redactions: t.redactions,
      degraded: t.degraded,
    };
  }

  /** Newest `limit` thoughts (oldest first), skipping control/ephemeral categories. */
  recentViews(limit: number): ThoughtView[] {
    return [...this.thoughts.values()]
      .filter((t) => t.category !== "privacy" && !t.retracted)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit)
      .map((t) => this.toView(t));
  }

  ledger(): LedgerItem[] {
    const items: LedgerItem[] = [];
    for (const t of this.thoughts.values()) {
      items.push({
        id: t.id,
        code: t.code,
        kind: "thought",
        title: t.title,
        category: t.category,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        promoted: t.promoted,
        whyKept: t.promoted ? t.salienceReasons : ["working memory (expires automatically)"],
        sessionId: t.sessionId,
      });
    }
    for (const e of this.entities.values()) {
      items.push({
        id: e.id,
        code: e.code,
        kind: "entity",
        title: `${e.name} (${e.type})`,
        createdAt: e.firstSeen,
        expiresAt: e.expiresAt,
        promoted: e.longTerm > 0,
        whyKept: [`mentioned ${e.mentionCount}×`],
      });
    }
    for (const o of this.openLoops.values()) {
      items.push({
        id: o.id,
        code: "open loop",
        kind: "open_loop",
        title: o.question,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
        promoted: false,
        whyKept: [o.status],
      });
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  stats(): { thoughts: number; promoted: number; fragments: number; entities: number; edges: number; artifacts: number } {
    let promoted = 0;
    for (const t of this.thoughts.values()) if (t.promoted) promoted++;
    return {
      thoughts: this.thoughts.size,
      promoted,
      fragments: this.frags.size,
      entities: this.entities.size,
      edges: this.edges.size,
      artifacts: this.artifacts.size,
    };
  }

  /** Working-memory day key for "now" (exported for tests). */
  currentDayKey(): string {
    return dayKeyId(this.clock.now());
  }
}
