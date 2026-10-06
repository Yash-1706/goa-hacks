import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { log } from "../log";

/* ============================================================================
 * Encryption at rest (TRD §10.3)
 *  - Field-level AES-256-GCM, random 96-bit IV, AAD = `${table}|${id}|${column}`.
 *  - Blob layout: [0]=version(1) | iv(12) | tag(16) | ciphertext
 *  - KEK (master key): passphrase (scrypt) → OS credential store → keyfile.
 *  - DEKs: `ltm` (long term) and `day:YYYY-MM-DD` (working memory), wrapped with the KEK.
 *  - Crypto-shredding: destroying a day key makes every row sealed with it unreadable.
 * ========================================================================== */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const WRAPPED_LEN = 1 + IV_LEN + TAG_LEN + 32;

export class KeyDestroyedError extends Error {
  constructor(public keyId: string) {
    super(`key ${keyId} has been destroyed`);
  }
}

export type KekSource = "passphrase" | "keyring" | "keyfile" | "provided";

function aesSeal(key: Buffer, aad: string, data: Uint8Array): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
}

function aesOpen(key: Buffer, aad: string, blob: Uint8Array): Buffer {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (b.length < 1 + IV_LEN + TAG_LEN || b[0] !== VERSION) throw new Error("malformed ciphertext");
  const iv = b.subarray(1, 1 + IV_LEN);
  const tag = b.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = b.subarray(1 + IV_LEN + TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function dayKeyId(ts: number): string {
  return `day:${new Date(ts).toISOString().slice(0, 10)}`;
}

export class Vault {
  private deks = new Map<string, Buffer>();
  private constructor(
    private db: Db,
    private kek: Buffer,
    readonly kekSource: KekSource,
  ) {}

  /** Production entry: derive/obtain the KEK from passphrase, OS keyring, or keyfile. */
  static async open(db: Db, opts: { dataDir: string; passphrase?: string; now?: () => number }): Promise<Vault> {
    const { kek, source } = await acquireKek(db, opts.dataDir, opts.passphrase);
    const v = new Vault(db, kek, source);
    v.verifyKek(); // must run before any DEK is unwrapped so a wrong key gives a clear error
    v.ensureKey("ltm", "ltm", opts.now?.() ?? Date.now());
    return v;
  }

  /** Tests: supply a KEK directly. */
  static withKek(db: Db, kek: Buffer, now = Date.now()): Vault {
    const v = new Vault(db, kek, "provided");
    v.verifyKek();
    v.ensureKey("ltm", "ltm", now);
    return v;
  }

  private verifyKek(): void {
    const probe = this.db.getSetting("kek_check");
    if (!probe) {
      this.db.setSetting("kek_check", aesSeal(this.kek, "kek|check", Buffer.from("synapse")).toString("base64"));
      return;
    }
    try {
      aesOpen(this.kek, "kek|check", Buffer.from(probe, "base64"));
    } catch {
      throw new Error("Master key does not match this database (wrong passphrase or keyfile).");
    }
  }

  /** Create the DEK if missing. Returns false if it was destroyed. */
  ensureKey(id: string, scope: "ltm" | "day", now: number): boolean {
    if (this.deks.has(id)) return true;
    const row = this.db.get<{ wrapped: Uint8Array; destroyed_at: number | null }>(
      "SELECT wrapped, destroyed_at FROM keys WHERE id = ?",
      id,
    );
    if (row) {
      if (row.destroyed_at) return false;
      this.deks.set(id, aesOpen(this.kek, `key|${id}`, row.wrapped));
      return true;
    }
    const dek = randomBytes(32);
    this.db.run(
      "INSERT INTO keys(id, scope, wrapped, created_at, destroyed_at) VALUES(?,?,?,?,NULL)",
      id,
      scope,
      aesSeal(this.kek, `key|${id}`, dek),
      now,
    );
    this.deks.set(id, dek);
    return true;
  }

  private dek(id: string): Buffer {
    const cached = this.deks.get(id);
    if (cached) return cached;
    const row = this.db.get<{ wrapped: Uint8Array; destroyed_at: number | null }>(
      "SELECT wrapped, destroyed_at FROM keys WHERE id = ?",
      id,
    );
    if (!row || row.destroyed_at) throw new KeyDestroyedError(id);
    const k = aesOpen(this.kek, `key|${id}`, row.wrapped);
    this.deks.set(id, k);
    return k;
  }

  /** Key id for new working-memory data created at `ts`. Creates the day key on first use. */
  workingKeyId(ts: number): string {
    const id = dayKeyId(ts);
    this.ensureKey(id, "day", ts);
    return id;
  }

  seal(keyId: string, aad: string, data: string | Uint8Array): Buffer {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    return aesSeal(this.dek(keyId), aad, bytes);
  }

  open(keyId: string, aad: string, blob: Uint8Array): Buffer {
    return aesOpen(this.dek(keyId), aad, blob);
  }

  sealJson(keyId: string, aad: string, value: unknown): Buffer {
    return this.seal(keyId, aad, JSON.stringify(value));
  }

  openJson<T>(keyId: string, aad: string, blob: Uint8Array): T {
    return JSON.parse(this.open(keyId, aad, blob).toString("utf8")) as T;
  }

  sealVector(keyId: string, aad: string, v: Float32Array): Buffer {
    return this.seal(keyId, aad, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }

  openVector(keyId: string, aad: string, blob: Uint8Array): Float32Array {
    const buf = this.open(keyId, aad, blob);
    // copy into an aligned buffer
    const out = new Float32Array(buf.byteLength / 4);
    new Uint8Array(out.buffer).set(buf);
    return out;
  }

  /** Crypto-shred: after this, rows sealed with `id` can never be decrypted again. */
  destroyKey(id: string, now: number): boolean {
    if (id === "ltm") throw new Error("refusing to destroy the long-term key");
    const cached = this.deks.get(id);
    if (cached) cached.fill(0);
    this.deks.delete(id);
    const r = this.db.run(
      "UPDATE keys SET wrapped = ?, destroyed_at = ? WHERE id = ? AND destroyed_at IS NULL",
      Buffer.alloc(WRAPPED_LEN),
      now,
      id,
    );
    return r.changes > 0;
  }

  isDestroyed(id: string): boolean {
    const row = this.db.get<{ destroyed_at: number | null }>("SELECT destroyed_at FROM keys WHERE id = ?", id);
    return Boolean(row?.destroyed_at);
  }

  listKeys(): Array<{ id: string; scope: string; createdAt: number; destroyedAt: number | null }> {
    return this.db
      .all<{ id: string; scope: string; created_at: number; destroyed_at: number | null }>(
        "SELECT id, scope, created_at, destroyed_at FROM keys ORDER BY created_at",
      )
      .map((r) => ({ id: r.id, scope: r.scope, createdAt: r.created_at, destroyedAt: r.destroyed_at }));
  }
}

async function acquireKek(
  db: Db,
  dataDir: string,
  passphrase?: string,
): Promise<{ kek: Buffer; source: KekSource }> {
  if (passphrase) {
    let saltB64 = db.getSetting("kek_salt");
    if (!saltB64) {
      saltB64 = randomBytes(16).toString("base64");
      db.setSetting("kek_salt", saltB64);
    }
    const kek = scryptSync(passphrase, Buffer.from(saltB64, "base64"), 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
    return { kek, source: "passphrase" };
  }

  // Optional: OS credential store (Windows Credential Manager / Keychain / libsecret).
  try {
    const mod = (await import("@napi-rs/keyring")) as {
      Entry: new (service: string, user: string) => { getPassword(): string | null; setPassword(p: string): void };
    };
    const entry = new mod.Entry("synapse", "master-key");
    let b64 = entry.getPassword();
    if (!b64) {
      b64 = randomBytes(32).toString("base64");
      entry.setPassword(b64);
    }
    const kek = Buffer.from(b64, "base64");
    if (kek.length === 32) return { kek, source: "keyring" };
  } catch {
    /* keyring unavailable: fall through to keyfile */
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "master.key");
  if (fs.existsSync(file)) {
    const kek = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (kek.length === 32) return { kek, source: "keyfile" };
  }
  const kek = randomBytes(32);
  fs.writeFileSync(file, kek.toString("base64"), { mode: 0o600 });
  log.warn("vault", "master key stored in a keyfile (set SYNAPSE_PASSPHRASE or install the OS keyring for stronger protection)");
  return { kek, source: "keyfile" };
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
