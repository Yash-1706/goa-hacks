import type { ArtifactStatus } from "@synapse/shared";
import { STATUS_HINT } from "@/lib/artifacts";
import { plural } from "@/lib/format";

/* ============================================================================
 * Outbox grouping (PRD INT-1). Six artifact statuses fold into five groups: dismissed and undone share a quiet one.
 * Pure helpers so the ordering, the counts and the headline copy are unit-tested.
 * ========================================================================== */

export type GroupId = "draft" | "staged" | "accepted" | "executed" | "dismissed";
export type OutboxFilter = "all" | GroupId;

export interface Groupable {
  id: string;
  status: ArtifactStatus;
  updatedAt: number;
}

export interface GroupDef {
  id: GroupId;
  label: string;
  statuses: readonly ArtifactStatus[];
  hint: string;
  emptyTitle: string;
  emptyBody: string;
  /** folded away behind a toggle in the "All" view */
  quiet: boolean;
}

export const GROUPS: readonly GroupDef[] = [
  {
    id: "draft",
    label: "Drafts",
    statuses: ["draft"],
    hint: STATUS_HINT.draft,
    emptyTitle: "No drafts waiting",
    emptyBody: "New ones appear the moment Synapse hears something actionable.",
    quiet: false,
  },
  {
    id: "staged",
    label: "Staged",
    statuses: ["staged"],
    hint: STATUS_HINT.staged,
    emptyTitle: "Nothing staged",
    emptyBody: "At autonomy L2 and above Synapse prepares external actions (an issue, a ticket, a calendar hold) so one tap commits them.",
    quiet: false,
  },
  {
    id: "accepted",
    label: "Kept",
    statuses: ["accepted"],
    hint: STATUS_HINT.accepted,
    emptyTitle: "Nothing kept yet",
    emptyBody: "Tap Keep on a draft to save it and promote its thought to long-term memory.",
    quiet: false,
  },
  {
    id: "executed",
    label: "Done",
    statuses: ["executed"],
    hint: STATUS_HINT.executed,
    emptyTitle: "Nothing pushed yet",
    emptyBody: "Push a staged issue, ticket or calendar hold. Without credentials the push is simulated and nothing leaves your machine.",
    quiet: false,
  },
  {
    id: "dismissed",
    label: "Dismissed",
    statuses: ["dismissed", "undone"],
    hint: "Dismissed drafts and undone pushes, out of the way. Their thoughts stay in memory until they expire.",
    emptyTitle: "Nothing dismissed",
    emptyBody: "Dismissed drafts and undone pushes land here.",
    quiet: true,
  },
];

const BY_STATUS = new Map<ArtifactStatus, GroupId>(GROUPS.flatMap((g) => g.statuses.map((s) => [s, g.id] as const)));

export const groupOf = (status: ArtifactStatus): GroupId => BY_STATUS.get(status) ?? "draft";

export const groupDef = (id: GroupId): GroupDef => GROUPS.find((g) => g.id === id) as GroupDef;

/** newest change first; the id breaks ties so the order is stable across renders */
export function byRecency<T extends Groupable>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function groupItems<T extends Groupable>(items: readonly T[]): Record<GroupId, T[]> {
  const out: Record<GroupId, T[]> = { draft: [], staged: [], accepted: [], executed: [], dismissed: [] };
  for (const it of items) out[groupOf(it.status)].push(it);
  for (const id of Object.keys(out) as GroupId[]) out[id].sort(byRecency);
  return out;
}

export type GroupCounts = Record<GroupId, number> & { all: number };

export function countGroups(items: readonly Groupable[]): GroupCounts {
  const out: GroupCounts = { all: items.length, draft: 0, staged: 0, accepted: 0, executed: 0, dismissed: 0 };
  for (const it of items) out[groupOf(it.status)]++;
  return out;
}

/** the groups a filter shows, in ladder order */
export function shownGroups(filter: OutboxFilter): GroupDef[] {
  return filter === "all" ? [...GROUPS] : GROUPS.filter((g) => g.id === filter);
}

/** things that still wait for a decision */
export const waitingCount = (c: Pick<GroupCounts, "draft" | "staged">): number => c.draft + c.staged;

export interface Headline {
  title: string;
  sub: string;
}

export function headline(c: GroupCounts): Headline {
  if (c.all === 0) return { title: "Nothing drafted yet", sub: "Synapse drafts the moment it hears something actionable." };
  const waiting = waitingCount(c);
  if (waiting > 0) {
    const parts = [c.draft ? plural(c.draft, "draft") : "", c.staged ? `${c.staged} staged` : ""].filter(Boolean);
    return { title: `${waiting} waiting for your call`, sub: `${parts.join(" and ")}. Nothing is sent to anyone until you say so.` };
  }
  const parts = [c.executed ? `${c.executed} done` : "", c.accepted ? `${c.accepted} kept` : "", c.dismissed ? `${c.dismissed} dismissed` : ""].filter(Boolean);
  return { title: "All caught up", sub: `${parts.join(", ")}.` };
}
