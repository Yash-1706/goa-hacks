import type { ArtifactView } from "@synapse/shared";
import type { Clock } from "../clock";
import type { EmitFn } from "../ctx";
import type { CaptureService } from "../capture/service";
import { localIso } from "../cortex/prompts";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import type { ArtifactRec } from "../memory/types";
import type { GithubAccount } from "../profile/github";
import type { ProfileService } from "../profile/service";
import { applyAnswer, buildLinks, resolveRoute, type RouteInput } from "./router";

/* ============================================================================
 * Routing on live artifacts: every artifact view carries its resolved destination, the questions it still needs answered
 * and its prefilled handoff links; an answer is stored with the artifact (sealed with its key) and learned in the profile.
 * ========================================================================== */

export class RoutingService {
  constructor(
    private d: {
      store: MemoryStore;
      profile: ProfileService;
      capture: Pick<CaptureService, "contextFor">;
      github: Pick<GithubAccount, "token">;
      clock: Clock;
      emit: EmitFn;
    },
  ) {}

  private input(a: ArtifactRec): RouteInput {
    const { store, profile, capture, clock } = this.d;
    const t = store.getThought(a.thoughtId);
    const p = profile.get();
    const entityNames = (t?.entityIds ?? [])
      .map((id) => store.entities.get(id))
      .filter((e) => e && (e.type === "component" || e.type === "project"))
      .map((e) => e!.name);
    const labels = a.payload.kind === "github_issue" ? a.payload.labels.filter((l) => l.toLowerCase() !== "bug") : [];
    return {
      artifact: a.payload,
      stored: a.route ?? {},
      ...(t && capture.contextFor(t.id) ? { context: capture.contextFor(t.id) } : {}),
      text: t ? store.fragmentsOf(t).map((f) => f.text).join(" ") : "",
      keywords: [...new Set([...entityNames, ...labels])],
      profile: p,
      now: clock.now(),
      tz: p.timezone,
    };
  }

  /** route, needs, links and whether "Create issue" files it for real */
  view(a: ArtifactRec): Partial<ArtifactView> {
    try {
      const i = this.input(a);
      const { route, needs } = resolveRoute(i);
      const links = needs.length ? {} : buildLinks({ artifact: a.payload, route, artifactId: a.id, tz: i.tz, emailApp: i.profile.emailApp });
      return {
        route,
        needs,
        links,
        ...(a.kind === "github_issue" ? { canCreate: Boolean(this.d.github.token()) } : {}),
      };
    } catch (err) {
      log.warn("routing", "could not route an artifact", { id: a.id, error: (err as Error).name });
      return {};
    }
  }

  repoFor(a: ArtifactRec): string | null {
    return resolveRoute(this.input(a)).route.repo ?? null;
  }

  /** Answer one question: stored on the artifact, learned in the profile, the card re-rendered everywhere. */
  answer(a: ArtifactRec, field: string, value: string): ArtifactRec {
    if (a.status === "executed") throw new Error("already shipped");
    const i = this.input(a);
    const res = applyAnswer({ artifact: a.payload, stored: i.stored, field, value, profile: i.profile, keywords: i.keywords, now: i.now, tz: i.tz });
    a.route = res.stored;
    // a time answer also lands in the artifact itself, so exports and the calendar hold agree with the card
    if (field === "due" && res.stored.dueAt) {
      const start = Date.parse(res.stored.dueAt);
      if (a.payload.kind === "reminder") a.payload = { ...a.payload, due_iso: res.stored.dueAt };
      if (a.payload.kind === "calendar_event") a.payload = { ...a.payload, start_iso: res.stored.dueAt, end_iso: localIso(start + 30 * 60_000, i.tz) };
    }
    this.d.store.saveArtifact(a);
    this.d.profile.learn(res.learned);
    this.d.emit({ type: "artifact.upsert", thoughtId: a.thoughtId, artifact: this.d.store.artifactView(a) });
    return a;
  }
}
