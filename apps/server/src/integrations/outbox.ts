import type { Artifact, ArtifactKind, ArtifactStatus, ArtifactOf } from "@synapse/shared";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import type { Config } from "../config";
import type { EmitFn } from "../ctx";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import type { ArtifactRec, ThoughtRec } from "../memory/types";
import type { AuditChain } from "../privacy/audit";
import { toIcs } from "./calendar";

/* ============================================================================
 * Outbox (PRD §6.8, TRD §12): drafted artifacts become real things — but only through here, and
 * only as far as the autonomy policy allows. Real GitHub / Jira when credentials exist, otherwise
 * clearly-labelled simulation. Nothing is ever sent to another human: email/message drafts are
 * handed to the user (mailto: / copy).
 * ========================================================================== */

/** every call to an external service is bounded: a hung GitHub/Jira must not hang the tap that triggered it */
const HTTP_TIMEOUT_MS = 10_000;

export const EXTERNAL_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["ticket", "github_issue", "calendar_event"]);

export interface PushResult {
  externalRef: string;
  url?: string;
  simulated: boolean;
  system: "github" | "jira" | "calendar" | "local";
}

export class Outbox {
  private simCounter = 0;

  constructor(
    private d: { cfg: Config; store: MemoryStore; clock: Clock; audit: AuditChain; emit: EmitFn; bus: Bus },
  ) {
    this.simCounter = Number(d.store.db.getSetting("sim_counter") ?? 0);
  }

  githubReady(): boolean {
    const g = this.d.cfg.integrations.github;
    return Boolean(g.token && /^[^/\s]+\/[^/\s]+$/.test(g.repo));
  }
  jiraReady(): boolean {
    const j = this.d.cfg.integrations.jira;
    return Boolean(j.baseUrl && j.email && j.token && j.projectKey);
  }

  isExternal(kind: ArtifactKind): boolean {
    return EXTERNAL_KINDS.has(kind);
  }

  /**
   * "Private, reversible, self-only": safe for autonomy level 3 to do without a tap.
   * GitHub issue in the configured sandbox repo (or its simulation) and a tentative hold on one's
   * own calendar qualify. Jira (assignees/watchers get notified) and anything with attendees do not.
   */
  isSelfOnly(a: ArtifactRec): boolean {
    if (a.kind === "github_issue") return true;
    if (a.kind === "calendar_event") {
      const p = a.payload as ArtifactOf<"calendar_event">;
      return p.attendees.length === 0 && Boolean(p.start_iso);
    }
    if (a.kind === "ticket") return !this.jiraReady(); // simulated Jira only
    return false;
  }

  /** Can this artifact be pushed right now (and if not, why)? */
  pushability(a: ArtifactRec): { ok: boolean; reason?: string } {
    if (!this.isExternal(a.kind)) return { ok: false, reason: "nothing to push: copy or open the draft" };
    if (a.status === "executed") return { ok: false, reason: "already pushed" };
    if (a.kind === "calendar_event" && !(a.payload as ArtifactOf<"calendar_event">).start_iso) return { ok: false, reason: "needs a time: say when" };
    return { ok: true };
  }

  async push(a: ArtifactRec): Promise<PushResult> {
    const gate = this.pushability(a);
    if (!gate.ok) throw new Error(gate.reason);
    const t = this.d.store.getThought(a.thoughtId);
    let res: PushResult;
    switch (a.kind) {
      case "github_issue":
        res = await this.pushGithub(a, t);
        break;
      case "ticket":
        res = await this.pushJira(a, t);
        break;
      case "calendar_event":
        res = this.pushCalendar(a);
        break;
      default:
        throw new Error(`cannot push ${a.kind}`);
    }
    a.status = "executed";
    a.externalRef = res.externalRef;
    a.externalUrl = res.url;
    a.simulated = res.simulated;
    this.d.store.saveArtifact(a);
    if (t && !t.promoted) this.d.store.promote(t, [...t.salienceReasons, `pushed to ${res.system}`]);
    this.d.audit.append("artifact_executed", `${a.kind}:${res.system}${res.simulated ? ":simulated" : ""}`, 1);
    this.d.bus.emit("artifact.status", { artifactId: a.id, thoughtId: a.thoughtId, status: "executed" });
    this.d.emit({ type: "artifact.upsert", thoughtId: a.thoughtId, artifact: this.d.store.artifactView(a) });
    this.d.emit({
      type: "notice",
      level: "success",
      text: `${res.simulated ? "(simulated) " : ""}${labelOf(a.kind)} created: ${res.externalRef}`,
      at: this.d.clock.now(),
    });
    return res;
  }

  async undo(a: ArtifactRec): Promise<void> {
    if (a.status !== "executed") return;
    const sys = a.externalRef ?? "";
    try {
      if (!a.simulated && a.kind === "github_issue" && this.githubReady()) await this.githubClose(a);
      if (a.kind === "calendar_event" && a.externalRef?.startsWith("cal:")) this.d.store.removeCalendar(a.externalRef.slice(4));
    } catch (err) {
      log.warn("outbox", `undo failed: ${(err as Error).message}`);
    }
    a.status = "undone";
    this.d.store.saveArtifact(a);
    this.d.audit.append("artifact_undone", `${a.kind}:${sys.slice(0, 24)}`, 1);
    this.d.bus.emit("artifact.status", { artifactId: a.id, thoughtId: a.thoughtId, status: "undone" });
    this.d.emit({ type: "artifact.upsert", thoughtId: a.thoughtId, artifact: this.d.store.artifactView(a) });
    this.d.emit({ type: "notice", level: "info", text: `${labelOf(a.kind)} undone.`, at: this.d.clock.now() });
  }

  setStatus(a: ArtifactRec, status: ArtifactStatus): void {
    a.status = status;
    this.d.store.saveArtifact(a);
    this.d.bus.emit("artifact.status", { artifactId: a.id, thoughtId: a.thoughtId, status });
    this.d.emit({ type: "artifact.upsert", thoughtId: a.thoughtId, artifact: this.d.store.artifactView(a) });
  }

  /** User accepted a card: it is kept (promoted to long-term memory). */
  accept(a: ArtifactRec): void {
    if (a.status !== "executed") this.setStatus(a, "accepted");
    const t = this.d.store.getThought(a.thoughtId);
    if (t && !t.promoted) this.d.store.promote(t, [...t.salienceReasons, "you accepted its card"]);
  }

  dismiss(a: ArtifactRec): void {
    this.setStatus(a, "dismissed");
  }

  edit(a: ArtifactRec, patch: Record<string, unknown>): void {
    if (a.status === "executed") throw new Error("already pushed: edit it where it lives");
    const next = { ...a.payload, ...patch, kind: a.kind } as Artifact;
    a.payload = next;
    this.d.store.saveArtifact(a);
    this.d.emit({ type: "artifact.upsert", thoughtId: a.thoughtId, artifact: this.d.store.artifactView(a) });
  }

  // -------------------------------------------------------------- exporting --

  mailto(a: ArtifactRec): string | null {
    if (a.kind === "email_draft") {
      const p = a.payload as ArtifactOf<"email_draft">;
      const to = p.to.filter((x) => /@/.test(x)).join(",");
      return `mailto:${encodeURIComponent(to).replace(/%2C/g, ",").replace(/%40/g, "@")}?subject=${encodeURIComponent(p.subject)}&body=${encodeURIComponent(p.body).slice(0, 1800)}`;
    }
    return null;
  }

  ics(a: ArtifactRec): string | null {
    if (a.kind !== "calendar_event") return null;
    const p = a.payload as ArtifactOf<"calendar_event">;
    const start = p.start_iso ? Date.parse(p.start_iso) : NaN;
    if (!Number.isFinite(start)) return null;
    const end = p.end_iso && Number.isFinite(Date.parse(p.end_iso)) ? Date.parse(p.end_iso) : start + 30 * 60_000;
    return toIcs({ id: a.id, title: p.title, start, end });
  }

  // ---------------------------------------------------------------- adapters --

  private nextSim(prefix: string): string {
    this.simCounter++;
    this.d.store.db.setSetting("sim_counter", String(this.simCounter));
    return `${prefix}-${100 + this.simCounter}`;
  }

  private async pushGithub(a: ArtifactRec, t: ThoughtRec | undefined): Promise<PushResult> {
    const p = a.payload as ArtifactOf<"github_issue">;
    if (!this.githubReady()) return { externalRef: this.nextSim("GH"), simulated: true, system: "github" };
    const { token, repo } = this.d.cfg.integrations.github;
    const body = `${p.body_markdown}\n\n---\n_Drafted by Synapse from a voice thought${t ? ` (${t.code})` : ""}._`;
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synapse-hackathon", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      body: JSON.stringify({ title: p.title, body, labels: p.labels }),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json()) as { number: number; html_url: string };
    return { externalRef: `${repo}#${j.number}`, url: j.html_url, simulated: false, system: "github" };
  }

  private async githubClose(a: ArtifactRec): Promise<void> {
    const { token, repo } = this.d.cfg.integrations.github;
    const m = a.externalRef?.match(/#(\d+)$/);
    if (!m) return;
    await fetch(`https://api.github.com/repos/${repo}/issues/${m[1]}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synapse-hackathon", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    });
  }

  private async pushJira(a: ArtifactRec, t: ThoughtRec | undefined): Promise<PushResult> {
    const p = a.payload as ArtifactOf<"ticket">;
    if (!this.jiraReady()) return { externalRef: this.nextSim("SYN"), simulated: true, system: "jira" };
    const j = this.d.cfg.integrations.jira;
    const adf = (text: string) => ({ type: "doc", version: 1, content: text.split(/\n{2,}/).map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })) });
    const desc = [p.description, p.acceptance_criteria.length ? `Acceptance criteria:\n${p.acceptance_criteria.map((c) => `- ${c}`).join("\n")}` : "", `Drafted by Synapse from a voice thought${t ? ` (${t.code})` : ""}.`].filter(Boolean).join("\n\n");
    const res = await fetch(`${j.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${j.email}:${j.token}`).toString("base64")}`, Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      body: JSON.stringify({
        fields: {
          project: { key: j.projectKey },
          summary: p.title,
          issuetype: { name: p.issue_type === "bug" ? "Bug" : p.issue_type === "story" ? "Story" : "Task" },
          description: adf(desc),
          labels: p.labels.map((l) => l.replace(/\s+/g, "-")),
        },
      }),
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const out = (await res.json()) as { key: string };
    return { externalRef: out.key, url: `${j.baseUrl}/browse/${out.key}`, simulated: false, system: "jira" };
  }

  private pushCalendar(a: ArtifactRec): PushResult {
    const p = a.payload as ArtifactOf<"calendar_event">;
    const start = Date.parse(p.start_iso as string);
    if (!Number.isFinite(start)) throw new Error("the event has no valid start time");
    const end = p.end_iso && Number.isFinite(Date.parse(p.end_iso)) ? Date.parse(p.end_iso) : start + 30 * 60_000;
    const rec = this.d.store.addCalendar(p.title, start, end, "voice");
    return { externalRef: `cal:${rec.id}`, simulated: false, system: "calendar" };
  }
}

function labelOf(kind: ArtifactKind): string {
  return { github_issue: "GitHub issue", ticket: "Ticket", calendar_event: "Calendar hold" }[kind as "github_issue"] ?? kind.replace("_", " ");
}
