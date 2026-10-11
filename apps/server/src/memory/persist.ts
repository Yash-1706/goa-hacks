import type { Db } from "./db";
import type { Vault } from "./crypto";
import { sha256Hex } from "./crypto";
import type {
  ArtifactRec,
  CalendarRec,
  DictRec,
  EdgeRec,
  EntityRec,
  FragRec,
  OpenLoopRec,
  SessionRec,
  SuggestionRec,
  ThoughtRec,
} from "./types";
import type { Artifact, ReferenceView, RepairView, SalienceCue, SuggestionView, ThoughtTiming } from "@synapse/shared";

/* Row ↔ record mapping. Every user-content column is sealed with the row's key id. */

const aad = (table: string, id: string, col: string): string => `${table}|${id}|${col}`;

// -------------------------------------------------------------- fragments --

export function saveFragment(db: Db, v: Vault, f: FragRec): void {
  db.run(
    `INSERT INTO fragments(id, session_id, thought_id, device_id, t_start, t_end, pause_before_ms, duration_ms,
       rms_mean, whisper, lang, activity, transport, key_id, text_enc, emb_enc, expires_at, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET thought_id=excluded.thought_id, key_id=excluded.key_id,
       text_enc=excluded.text_enc, emb_enc=excluded.emb_enc, expires_at=excluded.expires_at`,
    f.id, f.sessionId, f.thoughtId, f.deviceId, f.tStart, f.tEnd, f.pauseBeforeMs, f.durationMs,
    f.rmsMean, f.whisper, f.lang ?? null, f.activity, f.transport, f.keyId,
    v.seal(f.keyId, aad("fragments", f.id, "text"), f.text),
    v.sealVector(f.keyId, aad("fragments", f.id, "emb"), f.emb),
    f.expiresAt, f.createdAt,
  );
}

export function loadFragments(db: Db, v: Vault): FragRec[] {
  const rows = db.all<Record<string, unknown>>("SELECT * FROM fragments ORDER BY t_start");
  const out: FragRec[] = [];
  for (const r of rows) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({
        id,
        sessionId: r.session_id as string,
        thoughtId: r.thought_id as string,
        deviceId: r.device_id as string,
        text: v.open(keyId, aad("fragments", id, "text"), r.text_enc as Uint8Array).toString("utf8"),
        tStart: r.t_start as number,
        tEnd: r.t_end as number,
        pauseBeforeMs: r.pause_before_ms as number,
        durationMs: r.duration_ms as number,
        rmsMean: r.rms_mean as number,
        whisper: Boolean(r.whisper),
        lang: (r.lang as string | null) ?? undefined,
        activity: r.activity as FragRec["activity"],
        transport: r.transport as FragRec["transport"],
        emb: v.openVector(keyId, aad("fragments", id, "emb"), r.emb_enc as Uint8Array),
        keyId,
        expiresAt: (r.expires_at as number | null) ?? null,
        createdAt: r.created_at as number,
      });
    } catch {
      db.run("DELETE FROM fragments WHERE id = ?", r.id as string); // unreadable (key destroyed) → gone
    }
  }
  return out;
}

// --------------------------------------------------------------- thoughts --

interface ThoughtDetail {
  why: string;
  references: ReferenceView[];
  repairs: RepairView[];
  openQuestions: string[];
  salienceCues: SalienceCue[];
  timing: ThoughtTiming;
  provisional: boolean;
  correctsThoughtId?: string;
  retracted?: boolean;
  fragmentIds: string[];
  artifactId: string | null;
}

export function saveThought(db: Db, v: Vault, t: ThoughtRec): void {
  const detail: ThoughtDetail = {
    why: t.why,
    references: t.references,
    repairs: t.repairs,
    openQuestions: t.openQuestions,
    salienceCues: t.salienceCues,
    timing: t.timing,
    provisional: t.provisional,
    correctsThoughtId: t.correctsThoughtId,
    retracted: t.retracted,
    fragmentIds: t.fragmentIds,
    artifactId: t.artifactId,
  };
  db.run(
    `INSERT INTO thoughts(id, code, session_id, device_id, device_kind, activity, status, category, confidence,
       salience, salience_reasons, promoted, tentative, source, key_id, title_enc, intent_enc, detail_enc, emb_enc,
       concern_hash, version, created_at, updated_at, expires_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, category=excluded.category, confidence=excluded.confidence,
       salience=excluded.salience, salience_reasons=excluded.salience_reasons, promoted=excluded.promoted,
       tentative=excluded.tentative, source=excluded.source, key_id=excluded.key_id, title_enc=excluded.title_enc,
       intent_enc=excluded.intent_enc, detail_enc=excluded.detail_enc, emb_enc=excluded.emb_enc,
       concern_hash=excluded.concern_hash, version=excluded.version, updated_at=excluded.updated_at,
       expires_at=excluded.expires_at, session_id=excluded.session_id`,
    t.id, t.code, t.sessionId, t.deviceId, t.deviceKind, t.activity, t.status, t.category, t.confidence,
    t.salience, JSON.stringify(t.salienceReasons), t.promoted, t.tentative, t.source, t.keyId,
    v.seal(t.keyId, aad("thoughts", t.id, "title"), t.title),
    v.seal(t.keyId, aad("thoughts", t.id, "intent"), t.intent),
    v.sealJson(t.keyId, aad("thoughts", t.id, "detail"), detail),
    v.sealVector(t.keyId, aad("thoughts", t.id, "emb"), t.emb),
    t.concernKey ? sha256Hex(t.concernKey).slice(0, 24) : null,
    t.version, t.createdAt, t.updatedAt, t.expiresAt,
  );
}

export function loadThoughts(db: Db, v: Vault): ThoughtRec[] {
  const rows = db.all<Record<string, unknown>>("SELECT * FROM thoughts ORDER BY created_at");
  const entityRows = db.all<{ thought_id: string; entity_id: string }>("SELECT thought_id, entity_id FROM thought_entities");
  const byThought = new Map<string, string[]>();
  for (const e of entityRows) {
    const arr = byThought.get(e.thought_id) ?? [];
    arr.push(e.entity_id);
    byThought.set(e.thought_id, arr);
  }
  const out: ThoughtRec[] = [];
  for (const r of rows) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      const detail = v.openJson<ThoughtDetail>(keyId, aad("thoughts", id, "detail"), r.detail_enc as Uint8Array);
      out.push({
        id,
        code: r.code as string,
        sessionId: r.session_id as string,
        deviceId: r.device_id as string,
        deviceKind: r.device_kind as "desk" | "pocket",
        activity: r.activity as ThoughtRec["activity"],
        status: r.status as "open" | "final",
        provisional: detail.provisional,
        tentative: Boolean(r.tentative),
        source: r.source as ThoughtRec["source"],
        category: r.category as ThoughtRec["category"],
        confidence: r.confidence as number,
        title: v.open(keyId, aad("thoughts", id, "title"), r.title_enc as Uint8Array).toString("utf8"),
        intent: v.open(keyId, aad("thoughts", id, "intent"), r.intent_enc as Uint8Array).toString("utf8"),
        why: detail.why,
        references: detail.references,
        repairs: detail.repairs,
        openQuestions: detail.openQuestions,
        fragmentIds: detail.fragmentIds,
        entityIds: byThought.get(id) ?? [],
        artifactId: detail.artifactId,
        salience: r.salience as number,
        salienceReasons: JSON.parse((r.salience_reasons as string) || "[]") as string[],
        salienceCues: detail.salienceCues,
        promoted: Boolean(r.promoted),
        concernKey: null, // only a hash is stored; recomputed on the next analysis
        emb: v.openVector(keyId, aad("thoughts", id, "emb"), r.emb_enc as Uint8Array),
        keyId,
        expiresAt: (r.expires_at as number | null) ?? null,
        createdAt: r.created_at as number,
        updatedAt: r.updated_at as number,
        version: (r.version as number) ?? 1,
        timing: detail.timing,
        correctsThoughtId: detail.correctsThoughtId,
        retracted: detail.retracted,
      });
    } catch {
      db.run("DELETE FROM thoughts WHERE id = ?", r.id as string);
      db.run("DELETE FROM thought_entities WHERE thought_id = ?", r.id as string);
    }
  }
  return out;
}

// --------------------------------------------------------------- entities --

export function saveEntity(db: Db, v: Vault, e: EntityRec): void {
  db.run(
    `INSERT INTO entities(id, code, type, key_id, name_enc, aliases_enc, emb_enc, salience, mention_count,
       first_seen, last_seen, long_term, expires_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET key_id=excluded.key_id, name_enc=excluded.name_enc, aliases_enc=excluded.aliases_enc,
       emb_enc=excluded.emb_enc, salience=excluded.salience, mention_count=excluded.mention_count,
       last_seen=excluded.last_seen, long_term=excluded.long_term, expires_at=excluded.expires_at, type=excluded.type`,
    e.id, e.code, e.type, e.keyId,
    v.seal(e.keyId, aad("entities", e.id, "name"), e.name),
    v.sealJson(e.keyId, aad("entities", e.id, "aliases"), e.aliases),
    v.sealVector(e.keyId, aad("entities", e.id, "emb"), e.emb),
    e.salience, e.mentionCount, e.firstSeen, e.lastSeen, e.longTerm, e.expiresAt,
  );
}

export function loadEntities(db: Db, v: Vault): EntityRec[] {
  const out: EntityRec[] = [];
  for (const r of db.all<Record<string, unknown>>("SELECT * FROM entities ORDER BY first_seen")) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({
        id,
        code: r.code as string,
        type: r.type as EntityRec["type"],
        name: v.open(keyId, aad("entities", id, "name"), r.name_enc as Uint8Array).toString("utf8"),
        aliases: v.openJson<string[]>(keyId, aad("entities", id, "aliases"), r.aliases_enc as Uint8Array),
        emb: v.openVector(keyId, aad("entities", id, "emb"), r.emb_enc as Uint8Array),
        salience: r.salience as number,
        mentionCount: r.mention_count as number,
        firstSeen: r.first_seen as number,
        lastSeen: r.last_seen as number,
        longTerm: ((r.long_term as number) ?? 0) as 0 | 1 | 2,
        expiresAt: (r.expires_at as number | null) ?? null,
        keyId,
      });
    } catch {
      db.run("DELETE FROM entities WHERE id = ?", r.id as string);
    }
  }
  return out;
}

// ------------------------------------------------------------------ edges --

export function saveEdge(db: Db, e: EdgeRec): void {
  db.run(
    `INSERT INTO edges(id, src, dst, type, weight, valid_from, valid_to, created_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(src, dst, type) DO UPDATE SET weight=excluded.weight, valid_from=excluded.valid_from, valid_to=excluded.valid_to`,
    e.id, e.src, e.dst, e.type, e.weight, e.validFrom, e.validTo, e.createdAt,
  );
}

export function loadEdges(db: Db): EdgeRec[] {
  return db
    .all<Record<string, unknown>>("SELECT * FROM edges")
    .map((r) => ({
      id: r.id as string,
      src: r.src as string,
      dst: r.dst as string,
      type: r.type as EdgeRec["type"],
      weight: r.weight as number,
      validFrom: (r.valid_from as number | null) ?? null,
      validTo: (r.valid_to as number | null) ?? null,
      createdAt: r.created_at as number,
    }));
}

// -------------------------------------------------------------- artifacts --

export function saveArtifact(db: Db, v: Vault, a: ArtifactRec): void {
  db.run(
    `INSERT INTO artifacts(id, code, thought_id, kind, status, autonomy_level, key_id, payload_enc,
       external_ref, external_url, simulated, created_at, updated_at, expires_at, route_enc)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status, autonomy_level=excluded.autonomy_level,
       key_id=excluded.key_id, payload_enc=excluded.payload_enc, external_ref=excluded.external_ref,
       external_url=excluded.external_url, simulated=excluded.simulated, updated_at=excluded.updated_at,
       expires_at=excluded.expires_at, route_enc=excluded.route_enc`,
    a.id, a.code, a.thoughtId, a.kind, a.status, a.autonomyLevel, a.keyId,
    v.sealJson(a.keyId, aad("artifacts", a.id, "payload"), a.payload),
    a.externalRef ?? null, a.externalUrl ?? null, a.simulated, a.createdAt, a.updatedAt, a.expiresAt,
    a.route ? v.sealJson(a.keyId, aad("artifacts", a.id, "route"), a.route) : null,
  );
}

export function loadArtifacts(db: Db, v: Vault): ArtifactRec[] {
  const out: ArtifactRec[] = [];
  for (const r of db.all<Record<string, unknown>>("SELECT * FROM artifacts ORDER BY created_at")) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({
        id,
        code: r.code as string,
        thoughtId: r.thought_id as string,
        kind: r.kind as ArtifactRec["kind"],
        status: r.status as ArtifactRec["status"],
        autonomyLevel: r.autonomy_level as number,
        payload: v.openJson<Artifact>(keyId, aad("artifacts", id, "payload"), r.payload_enc as Uint8Array),
        externalRef: (r.external_ref as string | null) ?? undefined,
        externalUrl: (r.external_url as string | null) ?? undefined,
        simulated: Boolean(r.simulated),
        createdAt: r.created_at as number,
        updatedAt: r.updated_at as number,
        expiresAt: (r.expires_at as number | null) ?? null,
        keyId,
        ...(r.route_enc ? { route: v.openJson<NonNullable<ArtifactRec["route"]>>(keyId, aad("artifacts", id, "route"), r.route_enc as Uint8Array) } : {}),
      });
    } catch {
      db.run("DELETE FROM artifacts WHERE id = ?", r.id as string);
    }
  }
  return out;
}

// ------------------------------------------------------------- open loops --

export function saveOpenLoop(db: Db, v: Vault, o: OpenLoopRec): void {
  db.run(
    `INSERT INTO open_loops(id, thought_id, key_id, question_enc, status, answer_thought_id, created_at, expires_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET key_id=excluded.key_id, question_enc=excluded.question_enc, status=excluded.status,
       answer_thought_id=excluded.answer_thought_id, expires_at=excluded.expires_at`,
    o.id, o.thoughtId, o.keyId, v.seal(o.keyId, aad("open_loops", o.id, "question"), o.question),
    o.status, o.answerThoughtId ?? null, o.createdAt, o.expiresAt,
  );
}

export function loadOpenLoops(db: Db, v: Vault): OpenLoopRec[] {
  const out: OpenLoopRec[] = [];
  for (const r of db.all<Record<string, unknown>>("SELECT * FROM open_loops ORDER BY created_at")) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({
        id,
        thoughtId: r.thought_id as string,
        question: v.open(keyId, aad("open_loops", id, "question"), r.question_enc as Uint8Array).toString("utf8"),
        status: r.status as OpenLoopRec["status"],
        answerThoughtId: (r.answer_thought_id as string | null) ?? undefined,
        createdAt: r.created_at as number,
        expiresAt: (r.expires_at as number | null) ?? null,
        keyId,
      });
    } catch {
      db.run("DELETE FROM open_loops WHERE id = ?", r.id as string);
    }
  }
  return out;
}

// ------------------------------------------------------------ suggestions --

export function saveSuggestion(db: Db, v: Vault, s: SuggestionRec): void {
  db.run(
    `INSERT INTO suggestions(id, kind, key_id, payload_enc, status, value, created_at, delivered_at, resolved_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET key_id=excluded.key_id, payload_enc=excluded.payload_enc, status=excluded.status,
       delivered_at=excluded.delivered_at, resolved_at=excluded.resolved_at`,
    s.view.id, s.view.kind, s.keyId, v.sealJson(s.keyId, aad("suggestions", s.view.id, "payload"), s.view),
    s.view.status, s.view.value, s.view.createdAt, s.view.deliveredAt ?? null,
    ["accepted", "dismissed", "expired"].includes(s.view.status) ? Date.now() : null,
  );
}

export function loadSuggestions(db: Db, v: Vault): SuggestionRec[] {
  const out: SuggestionRec[] = [];
  for (const r of db.all<Record<string, unknown>>("SELECT * FROM suggestions ORDER BY created_at")) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({ view: v.openJson<SuggestionView>(keyId, aad("suggestions", id, "payload"), r.payload_enc as Uint8Array), keyId });
    } catch {
      db.run("DELETE FROM suggestions WHERE id = ?", r.id as string);
    }
  }
  return out;
}

// -------------------------------------------------------------- dictionary --

export function saveDict(db: Db, v: Vault, d: DictRec): void {
  db.run(
    `INSERT INTO dictionary(id, key_id, term_enc, term_hash, kind, source, salience, last_seen) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET key_id=excluded.key_id, term_enc=excluded.term_enc, kind=excluded.kind,
       source=excluded.source, salience=excluded.salience, last_seen=excluded.last_seen`,
    d.id, d.keyId, v.seal(d.keyId, aad("dictionary", d.id, "term"), d.term), sha256Hex(d.term.toLowerCase()).slice(0, 24),
    d.kind, d.source, d.salience, d.lastSeen,
  );
}

export function loadDict(db: Db, v: Vault): DictRec[] {
  const out: DictRec[] = [];
  for (const r of db.all<Record<string, unknown>>("SELECT * FROM dictionary")) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({
        id,
        keyId,
        term: v.open(keyId, aad("dictionary", id, "term"), r.term_enc as Uint8Array).toString("utf8"),
        kind: r.kind as DictRec["kind"],
        source: r.source as string,
        salience: r.salience as number,
        lastSeen: r.last_seen as number,
      });
    } catch {
      db.run("DELETE FROM dictionary WHERE id = ?", r.id as string);
    }
  }
  return out;
}

// --------------------------------------------------------------- calendar --

export function saveCalendar(db: Db, v: Vault, c: CalendarRec): void {
  db.run(
    `INSERT INTO calendar_events(id, key_id, title_enc, start, "end", source) VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title_enc=excluded.title_enc, start=excluded.start, "end"=excluded."end"`,
    c.id, c.keyId, v.seal(c.keyId, aad("calendar_events", c.id, "title"), c.title), c.start, c.end, c.source,
  );
}

export function loadCalendar(db: Db, v: Vault): CalendarRec[] {
  const out: CalendarRec[] = [];
  for (const r of db.all<Record<string, unknown>>('SELECT id, key_id, title_enc, start, "end" AS end_ts, source FROM calendar_events ORDER BY start')) {
    try {
      const id = r.id as string;
      const keyId = r.key_id as string;
      out.push({
        id,
        keyId,
        title: v.open(keyId, aad("calendar_events", id, "title"), r.title_enc as Uint8Array).toString("utf8"),
        start: r.start as number,
        end: r.end_ts as number,
        source: r.source as CalendarRec["source"],
      });
    } catch {
      db.run("DELETE FROM calendar_events WHERE id = ?", r.id as string);
    }
  }
  return out;
}

// --------------------------------------------------------------- sessions --

export function saveSession(db: Db, v: Vault, s: SessionRec): void {
  db.run(
    `INSERT INTO sessions(id, code, device_id, device_kind, started_at, ended_at, activity, key_id, label_enc)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, activity=excluded.activity, key_id=excluded.key_id,
       label_enc=excluded.label_enc`,
    s.id, s.code, s.deviceId, s.deviceKind, s.startedAt, s.endedAt, s.activity, s.keyId,
    s.label ? v.seal(s.keyId, aad("sessions", s.id, "label"), s.label) : null,
  );
}

export function loadSessions(db: Db, v: Vault): SessionRec[] {
  const out: SessionRec[] = [];
  for (const r of db.all<Record<string, unknown>>("SELECT * FROM sessions ORDER BY started_at")) {
    const id = r.id as string;
    const keyId = r.key_id as string;
    let label: string | null = null;
    try {
      if (r.label_enc) label = v.open(keyId, aad("sessions", id, "label"), r.label_enc as Uint8Array).toString("utf8");
    } catch {
      label = null;
    }
    out.push({
      id,
      code: r.code as string,
      deviceId: r.device_id as string,
      deviceKind: r.device_kind as "desk" | "pocket",
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
      activity: r.activity as SessionRec["activity"],
      label,
      keyId,
    });
  }
  return out;
}
