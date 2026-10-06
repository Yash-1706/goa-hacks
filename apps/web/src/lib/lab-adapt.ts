import { AUTONOMY_NAME } from "@/lib/artifacts";
import type { AdaptationRow, SettingsResponse } from "@/net/api-types";

/* ============================================================================
 * Proactivity adaptation (PRD PRO-7, TRD §9.4) and the autonomy ladder (PRD PRO-6, TRD §9.6).
 *
 * The server keeps one row per pattern: `kind:<suggestion kind>` holds the delivery bar (how valuable a suggestion must
 * be before Synapse interrupts), `recurring_n` holds how many repeats of a concern it takes to trigger a suggestion.
 * Dismissing raises the bar, accepting lowers it. The ranges and steps below mirror apps/server/src/proactive/engine.ts
 * (`bump`) and thresholds.ts (`LIMITS.deliveryThreshold`); the server does not expose them, so they are named here once.
 * ========================================================================== */

export const DELIVERY_DEFAULT = 0.5;
export const DELIVERY_MIN = 0.35;
export const DELIVERY_MAX = 0.95;
/** a dismissal raises the bar by this much … */
export const DELIVERY_UP = 0.1;
/** … an accept lowers it by this much */
export const DELIVERY_DOWN = 0.05;
export const RECURRING_MIN = 2;
export const RECURRING_MAX = 5;

const KIND_TITLE: Record<string, string> = {
  reschedule: "Reschedule suggestions",
  make_task: "“Make it a task” nudges",
  draft_ready: "“Draft ready” notices",
  snippet: "Reusable snippet offers",
  open_answer: "Answers to open questions",
  echo: "Memory echoes",
  contradiction: "Contradiction checks",
  calendar_hold: "Calendar hold offers",
};

export type Stance = "stricter" | "easier" | "default";

export interface AdaptView {
  key: string;
  kind: "delivery" | "recurring" | "other";
  title: string;
  /** what the number means */
  what: string;
  value: number;
  min: number;
  max: number;
  def: number;
  /** 0..1 along the min..max track */
  at: number;
  defAt: number;
  accepts: number;
  dismisses: number;
  stance: Stance;
  valueText: string;
  defText: string;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const track = (v: number, min: number, max: number): number => (max > min ? clamp01((v - min) / (max - min)) : 0);

function titleCase(s: string): string {
  const t = s.replace(/[_:-]+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
}

function stanceOf(value: number, def: number): Stance {
  if (Math.abs(value - def) < 1e-6) return "default";
  return value > def ? "stricter" : "easier";
}

export function describeAdaptation(row: AdaptationRow, recurringDefault: number): AdaptView {
  if (row.key === "recurring_n") {
    const value = Math.round(row.threshold);
    return {
      key: row.key,
      kind: "recurring",
      title: "Repeats needed for a recurring concern",
      what: "How many times you mention the same worry in the window before Synapse offers help.",
      value,
      min: RECURRING_MIN,
      max: RECURRING_MAX,
      def: recurringDefault,
      at: track(value, RECURRING_MIN, RECURRING_MAX),
      defAt: track(recurringDefault, RECURRING_MIN, RECURRING_MAX),
      accepts: row.accepts,
      dismisses: row.dismisses,
      stance: stanceOf(value, recurringDefault),
      valueText: `${value}×`,
      defText: `${recurringDefault}×`,
    };
  }
  const isDelivery = row.key.startsWith("kind:");
  const kind = isDelivery ? row.key.slice(5) : row.key;
  const max = isDelivery ? DELIVERY_MAX : Math.max(1, row.threshold);
  const min = isDelivery ? DELIVERY_MIN : 0;
  return {
    key: row.key,
    kind: isDelivery ? "delivery" : "other",
    title: KIND_TITLE[kind] ?? titleCase(kind),
    what: "How valuable a suggestion has to be before Synapse interrupts you with it.",
    value: row.threshold,
    min,
    max,
    def: DELIVERY_DEFAULT,
    at: track(row.threshold, min, max),
    defAt: track(DELIVERY_DEFAULT, min, max),
    accepts: row.accepts,
    dismisses: row.dismisses,
    stance: stanceOf(row.threshold, DELIVERY_DEFAULT),
    valueText: row.threshold.toFixed(2),
    defText: DELIVERY_DEFAULT.toFixed(2),
  };
}

/** recurring concern first, then the delivery bars alphabetically */
export function describeAdaptations(rows: readonly AdaptationRow[], recurringDefault: number): AdaptView[] {
  return rows
    .map((r) => describeAdaptation(r, recurringDefault))
    .sort((a, b) => (a.kind === "recurring" ? -1 : 0) - (b.kind === "recurring" ? -1 : 0) || a.title.localeCompare(b.title));
}

/** a plain sentence about what the feedback did to this row */
export function adaptSentence(v: AdaptView): string {
  const fb: string[] = [];
  if (v.dismisses) fb.push(`dismissed ${v.dismisses}×`);
  if (v.accepts) fb.push(`accepted ${v.accepts}×`);
  const said = fb.length ? `You ${fb.join(" and ")}. ` : "";
  if (v.stance === "stricter") return `${said}The bar moved from ${v.defText} to ${v.valueText}: Synapse now waits for a stronger signal.`;
  if (v.stance === "easier") return `${said}The bar moved from ${v.defText} to ${v.valueText}: Synapse now speaks up sooner.`;
  return `${said}Back at the default (${v.defText}).`;
}

export interface RecurringRule {
  /** "3 mentions in 10 min" */
  trigger: string;
  /** "at most one suggestion per 2 min" */
  gap: string;
}

export function recurringRule(r: SettingsResponse["recurring"]): RecurringRule {
  const mins = r.minGapS / 60;
  const gap = mins >= 1 ? `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min` : `${Math.round(r.minGapS)} s`;
  return { trigger: `${r.n} mentions in ${r.windowMin} min`, gap: `at most one suggestion per ${gap}` };
}

// ---------------------------------------------------------------- autonomy --

export interface AutonomyLevelDef {
  level: number;
  name: string;
  /** a few words */
  tagline: string;
  /** one or two sentences, plain language */
  detail: string;
  /** what happens without a tap, as a short list */
  allows: string[];
}

export const AUTONOMY_LEVELS: readonly AutonomyLevelDef[] = [
  {
    level: 0,
    name: AUTONOMY_NAME[0],
    tagline: "Store, tag, link",
    detail: "Synapse listens and remembers, and links related thoughts. It does not create anything for you.",
    allows: ["Store thoughts", "Tag and link them"],
  },
  {
    level: 1,
    name: AUTONOMY_NAME[1],
    tagline: "Drafts in the Outbox",
    detail: "Creates drafts of issues, emails, events and snippets in your Outbox. Nothing is prepared for sending.",
    allows: ["Everything in Observe", "Draft artifacts into the Outbox"],
  },
  {
    level: 2,
    name: AUTONOMY_NAME[2],
    tagline: "One tap commits",
    detail: "Prepares external actions (the issue payload, the calendar hold) so a single tap commits them.",
    allows: ["Everything in Draft", "Stage external actions for one-tap approval"],
  },
  {
    level: 3,
    name: AUTONOMY_NAME[3],
    tagline: "Only private, reversible, self-only",
    detail: "Acts without a tap, but only on private, reversible, self-only actions above 0.8 confidence: a GitHub issue in the sandbox repo, a tentative hold on your own calendar.",
    allows: ["Everything in Stage", "Sandbox GitHub issue", "Tentative hold on your own calendar"],
  },
];

export const AUTONOMY_NEVER = "Never automatic: sending email or messages, inviting others.";

export const clampLevel = (n: number): number => Math.max(0, Math.min(AUTONOMY_LEVELS.length - 1, Math.round(Number.isFinite(n) ? n : 0)));

export function autonomyDef(level: number): AutonomyLevelDef {
  return AUTONOMY_LEVELS[clampLevel(level)] as AutonomyLevelDef;
}

/** "L2 · Stage" */
export const autonomyLabel = (level: number): string => `L${clampLevel(level)} · ${autonomyDef(level).name}`;
