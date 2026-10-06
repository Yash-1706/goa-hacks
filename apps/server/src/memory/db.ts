import "../silence";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Param = string | number | bigint | null | Uint8Array | boolean | undefined;

function clean(params: Param[]): Array<string | number | bigint | null | Uint8Array> {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

/** Thin synchronous wrapper over node:sqlite (swap-able for better-sqlite3). */
export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly file: string) {
    this.raw = new DatabaseSync(file);
    // secure_delete: freed pages are zeroed, so "forget" really removes data.
    this.raw.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=OFF;",
    );
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt(sql).run(...clean(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...clean(params)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...clean(params)) as T[];
  }

  /** Transaction with nesting via savepoints. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp${this.depth}`;
    this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(outer ? "COMMIT" : `RELEASE ${name}`);
      return out;
    } catch (err) {
      this.depth--;
      this.raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  /** Atomic counter used for human-friendly display codes (T-12, E-3, ...). */
  nextCode(prefix: string): string {
    const row = this.get<{ value: number }>("SELECT value FROM counters WHERE name = ?", prefix);
    const n = (row?.value ?? 0) + 1;
    this.run(
      "INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      prefix,
      n,
    );
    return `${prefix}-${n}`;
  }

  getSetting(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
  }

  setSetting(key: string, value: string): void {
    this.run(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }

  private migrate(): void {
    const v = (this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v >= 1) return;
    this.raw.exec(SCHEMA_V1);
    this.raw.exec("PRAGMA user_version = 1");
  }
}

/**
 * Convention: every `*_enc` column is an AES-256-GCM blob (see crypto.ts).
 * Plaintext columns are metadata only (ids, timestamps, category, counters).
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, wrapped BLOB NOT NULL,
  created_at INTEGER NOT NULL, destroyed_at INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, kind TEXT, name TEXT, token_hash TEXT, created_at INTEGER, last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, code TEXT, device_id TEXT, device_kind TEXT, started_at INTEGER, ended_at INTEGER,
  activity TEXT, key_id TEXT, label_enc BLOB
);

CREATE TABLE IF NOT EXISTS fragments (
  id TEXT PRIMARY KEY, session_id TEXT, thought_id TEXT, device_id TEXT,
  t_start INTEGER, t_end INTEGER, pause_before_ms INTEGER, duration_ms INTEGER,
  rms_mean REAL, whisper INTEGER, lang TEXT, activity TEXT, transport TEXT,
  key_id TEXT NOT NULL, text_enc BLOB NOT NULL, emb_enc BLOB,
  expires_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, session_id TEXT, device_id TEXT, device_kind TEXT, activity TEXT,
  status TEXT, category TEXT, confidence REAL, salience REAL, salience_reasons TEXT,
  promoted INTEGER DEFAULT 0, tentative INTEGER DEFAULT 0, source TEXT,
  key_id TEXT NOT NULL, title_enc BLOB, intent_enc BLOB, detail_enc BLOB, emb_enc BLOB,
  concern_hash TEXT, version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, type TEXT, key_id TEXT NOT NULL,
  name_enc BLOB NOT NULL, aliases_enc BLOB, emb_enc BLOB,
  salience REAL DEFAULT 0, mention_count INTEGER DEFAULT 0,
  first_seen INTEGER, last_seen INTEGER, long_term INTEGER DEFAULT 0, expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS thought_entities (
  thought_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (thought_id, entity_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, weight REAL DEFAULT 1,
  valid_from INTEGER, valid_to INTEGER, created_at INTEGER, UNIQUE (src, dst, type)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, thought_id TEXT, kind TEXT, status TEXT, autonomy_level INTEGER,
  key_id TEXT NOT NULL, payload_enc BLOB NOT NULL, external_ref TEXT, external_url TEXT, simulated INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER, expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY, thought_id TEXT, key_id TEXT NOT NULL, question_enc BLOB NOT NULL, status TEXT,
  answer_thought_id TEXT, created_at INTEGER, expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY, kind TEXT, key_id TEXT NOT NULL, payload_enc BLOB NOT NULL, status TEXT,
  value REAL, created_at INTEGER, delivered_at INTEGER, resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS pattern_state (
  key TEXT PRIMARY KEY, threshold REAL, accepts INTEGER DEFAULT 0, dismisses INTEGER DEFAULT 0, cooldown_until INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dictionary (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL, term_enc BLOB NOT NULL, term_hash TEXT UNIQUE,
  kind TEXT, source TEXT, salience REAL, last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL, title_enc BLOB NOT NULL, start INTEGER, "end" INTEGER, source TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL, ref TEXT, count INTEGER,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS latency (
  fragment_id TEXT PRIMARY KEY, device_id TEXT, created_at INTEGER,
  speech_end INTEGER, commit_sent INTEGER, wispr_final INTEGER, server_recv INTEGER,
  first_paint INTEGER, llm_done INTEGER, artifact_render INTEGER,
  wispr_ms REAL, first_paint_ms REAL, artifact_ms REAL, speech_to_artifact_ms REAL, cortex_ms REAL,
  model TEXT, cached_tokens INTEGER, transport TEXT
);

CREATE TABLE IF NOT EXISTS battery (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, ts INTEGER, mode TEXT,
  cpu_ms REAL, radio_ms REAL, bytes_up INTEGER, window_ms INTEGER, level REAL, charging INTEGER
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_expires ON thoughts(expires_at);
CREATE INDEX IF NOT EXISTS idx_frag_thought ON fragments(thought_id);
CREATE INDEX IF NOT EXISTS idx_frag_expires ON fragments(expires_at);
CREATE INDEX IF NOT EXISTS idx_art_thought ON artifacts(thought_id);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_latency_created ON latency(created_at);
`;
