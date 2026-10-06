import type { Autonomy } from "../ctx";
import type { Config } from "../config";
import { EXTERNAL_KINDS, type Outbox } from "../integrations/outbox";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import type { ArtifactRec, ThoughtRec } from "../memory/types";
import type { AuditChain } from "../privacy/audit";
import { LIMITS } from "../thresholds";

/* ============================================================================
 * Autonomy ladder (PRD PRO-6, TRD §9.6). The ONLY place that decides what Synapse may do
 * without a human tap:
 *   L0 observe  store, tag, link
 *   L1 draft    create local drafts in the outbox
 *   L2 stage    prepare external actions (one tap or a spoken "yes" commits)   ← default
 *   L3 execute  ONLY private + reversible + self-only actions, confidence ≥ 0.8, not tentative
 *   never       sending email/messages, inviting people, anything outside the sandbox
 * ========================================================================== */

export class AutonomyPolicy implements Autonomy {
  /** runtime override (settable from the UI); falls back to config */
  level: number;

  constructor(
    private d: { cfg: Config; store: MemoryStore; outbox: Outbox; audit: AuditChain },
  ) {
    const saved = d.store.db.getSetting("autonomy_level");
    this.level = saved !== undefined ? Number(saved) : d.cfg.proactive.autonomyLevel;
  }

  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(3, Math.round(level)));
    this.d.store.db.setSetting("autonomy_level", String(this.level));
    this.d.audit.append("autonomy_level", String(this.level), null);
  }

  /** What may happen to this artifact at the current level (pure; exercised by tests). */
  decide(a: Pick<ArtifactRec, "kind" | "status">, t: Pick<ThoughtRec, "confidence" | "tentative">, selfOnly: boolean): "none" | "draft" | "stage" | "execute" {
    if (a.status === "executed" || a.status === "accepted" || a.status === "dismissed") return "none";
    const external = EXTERNAL_KINDS.has(a.kind);
    if (this.level >= 3 && external && selfOnly && t.confidence >= LIMITS.autonomyConfidence && !t.tentative) return "execute";
    if (this.level >= 2 && external) return "stage";
    return "draft";
  }

  async onArtifact(t: ThoughtRec, a: ArtifactRec): Promise<void> {
    a.autonomyLevel = this.level;
    const verdict = this.decide(a, t, this.d.outbox.isSelfOnly(a));
    if (verdict === "none") return;
    a.status = verdict === "draft" ? "draft" : "staged";
    this.d.store.saveArtifact(a);
    if (verdict !== "execute") return;
    try {
      await this.d.outbox.push(a);
      this.d.audit.append("auto_executed", a.kind, 1);
      log.info("autonomy", "executed autonomously (L3)", { kind: a.kind, thought: t.code });
    } catch (err) {
      log.warn("autonomy", `auto-execute failed, left staged: ${(err as Error).message}`);
    }
  }
}
