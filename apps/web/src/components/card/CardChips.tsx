import { ArrowRight, Box, Building2, Bug, CalendarDays, Cpu, FolderKanban, Hash, CircleHelp, Link2, MapPin, User, type LucideIcon } from "lucide-react";
import type { EntityRefView, EntityType, ReferenceView, RepairView } from "@synapse/shared";
import { highlightCard } from "@/lib/dom";

const ENTITY_ICON: Record<EntityType, LucideIcon> = {
  person: User,
  component: Box,
  technology: Cpu,
  project: FolderKanban,
  bug: Bug,
  event: CalendarDays,
  place: MapPin,
  topic: Hash,
  org: Building2,
};

/** "that bug → T-181" for resolved references, "Assuming you mean …" when the top two candidates were close. */
export function ReferenceChips({ refs }: { refs: ReferenceView[] }) {
  const shown = refs.filter((r) => r.resolvedId || r.assumed);
  if (!shown.length) return null;
  return (
    <div className="cchips" aria-label="Resolved references">
      {shown.map((r, i) => {
        const jump = (): void => {
          if (r.resolvedId) highlightCard(r.resolvedId);
        };
        if (r.assumed) {
          return (
            <button
              key={`${r.mention}:${i}`}
              type="button"
              className="chip chip-tint chip-warn"
              onClick={jump}
              title={`The top two candidates were close, so Synapse picked one.${r.alternativeLabel ? ` Other candidate: “${r.alternativeLabel}”.` : ""} Say “no, the other one” to correct it.`}
            >
              <CircleHelp size={12} />
              <span>
                Assuming you mean <b className="mono">{r.resolvedCode ?? "?"}</b>
                {r.label ? ` · ${r.label}` : ""}
              </span>
            </button>
          );
        }
        return (
          <button key={`${r.mention}:${i}`} type="button" className="chip chip-tint chip-violet" onClick={jump} title={`“${r.mention}” resolved to ${r.resolvedCode ?? "memory"}${r.label ? `: ${r.label}` : ""} (${Math.round(r.confidence * 100)}% sure)`}>
            <Link2 size={12} />
            <span>
              {r.mention} <ArrowRight size={10} style={{ display: "inline", verticalAlign: "-1px" }} /> <b className="mono">{r.resolvedCode ?? r.label}</b>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function EntityChips({ entities, max = 6 }: { entities: EntityRefView[]; max?: number }) {
  if (!entities.length) return null;
  const shown = entities.slice(0, max);
  return (
    <div className="cchips" aria-label="Entities mentioned">
      {shown.map((e) => {
        const Icon = ENTITY_ICON[e.type] ?? Hash;
        return (
          <span key={e.id} className="chip" title={`${e.type} · ${e.code}`}>
            <Icon size={12} />
            <span>{e.name}</span>
          </span>
        );
      })}
      {entities.length > shown.length ? <span className="chip">+{entities.length - shown.length}</span> : null}
    </div>
  );
}

/** ~~rejected~~ → chosen, with the strike drawing itself in. */
export function RepairRow({ repairs }: { repairs: RepairView[] }) {
  if (!repairs.length) return null;
  return (
    <div className="repairs" aria-label="Self-repairs">
      {repairs.map((r, i) => (
        <span key={`${r.rejected}>${r.chosen}:${i}`} className="repair">
          <span className="repair__old">{r.rejected}</span>
          <ArrowRight size={13} className="repair__arrow" aria-hidden />
          <span className="repair__new">{r.chosen}</span>
        </span>
      ))}
      <span className="repair__label">self-repair resolved</span>
    </div>
  );
}

export function OpenQuestions({ questions }: { questions: string[] }) {
  if (!questions.length) return null;
  return (
    <ul className="openq" aria-label="Open questions">
      {questions.map((q, i) => (
        <li key={`${i}:${q}`}>
          <CircleHelp size={14} aria-hidden />
          <span>{q}</span>
        </li>
      ))}
    </ul>
  );
}
