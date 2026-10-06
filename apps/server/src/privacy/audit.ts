import { createHash } from "node:crypto";
import type { Clock } from "../clock";
import type { Db } from "../memory/db";

/* ============================================================================
 * Tamper-evident audit trail (PRD PRV-8, TRD §10.9).
 * Lifecycle events only (captured / promoted / sent_to_llm / expired / purged / paused ...),
 * NEVER content. Hash-chained: hash = SHA-256(prev_hash | ts | event | ref | count).
 * Editing or deleting any past row breaks every later hash.
 * ========================================================================== */

export interface AuditRow {
  seq: number;
  ts: number;
  event: string;
  ref: string | null;
  count: number | null;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

const link = (prev: string, ts: number, event: string, ref: string | null, count: number | null): string =>
  createHash("sha256").update(`${prev}|${ts}|${event}|${ref ?? ""}|${count ?? ""}`).digest("hex");

export class AuditChain {
  private last: string;
  constructor(
    private db: Db,
    private clock: Clock,
  ) {
    this.last = db.get<{ hash: string }>("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1")?.hash ?? GENESIS;
  }

  append(event: string, ref: string | null = null, count: number | null = null): void {
    const ts = this.clock.now();
    const hash = link(this.last, ts, event, ref, count);
    this.db.run("INSERT INTO audit(ts, event, ref, count, prev_hash, hash) VALUES(?,?,?,?,?,?)", ts, event, ref, count, this.last, hash);
    this.last = hash;
  }

  list(limit = 200): AuditRow[] {
    return this.db
      .all<{ seq: number; ts: number; event: string; ref: string | null; count: number | null; prev_hash: string; hash: string }>(
        "SELECT * FROM audit ORDER BY seq DESC LIMIT ?",
        limit,
      )
      .map((r) => ({ seq: r.seq, ts: r.ts, event: r.event, ref: r.ref, count: r.count, prevHash: r.prev_hash, hash: r.hash }));
  }

  /** Recompute the whole chain. `brokenAt` is the first sequence number that fails. */
  verify(): { ok: boolean; count: number; brokenAt?: number } {
    const rows = this.db.all<{ seq: number; ts: number; event: string; ref: string | null; count: number | null; prev_hash: string; hash: string }>(
      "SELECT * FROM audit ORDER BY seq ASC",
    );
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev || link(prev, r.ts, r.event, r.ref, r.count) !== r.hash) return { ok: false, count: rows.length, brokenAt: r.seq };
      prev = r.hash;
    }
    return { ok: true, count: rows.length };
  }
}
