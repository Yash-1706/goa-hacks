import type { Artifact, ArtifactLinks, ArtifactNeed, ArtifactOf, ArtifactRoute, CaptureContext, LearnedFact, Profile, ProfilePerson, ProfileRepo } from "@synapse/shared";
import { localIso } from "../cortex/prompts";
import { spokenTime } from "../cortex/reminder";
import { startOfDay } from "../recall/time";

/* ============================================================================
 * Routing (V1 phase 3c): where a card goes when it ships, and the one question it asks when a fact is missing.
 * Pure functions of the artifact, the capture's context, the profile and earlier answers: everything here is testable
 * without a server, and nothing leaves the machine.
 *
 *   GitHub issue: answered > capture context > repo or alias in the speech > learned alias > the only repo > the default
 *                 repo > ask "Which repo?" (top 3 by similarity)
 *   Email:        address > answered > learned > profile person (one: use it; several: "Which Dev?"; no address: "Dev's
 *                 email?") ; "the team" without a learned group asks for the recipients once
 *   Reminder:     answered > the time in the speech > ask "When?"
 * ========================================================================== */

/** answers stored on the artifact (sealed with it) */
export interface StoredRoute {
  repo?: string;
  /** lowercased recipient key → addresses */
  to?: Record<string, string[]>;
  dueAt?: string;
}

export interface RouteInput {
  artifact: Artifact;
  stored: StoredRoute;
  context?: CaptureContext;
  /** the thought's own words (fragments joined) */
  text: string;
  /** entity names of the thought (components, projects): what a repo answer is learned against */
  keywords: string[];
  profile: Profile;
  now: number;
  tz: string;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const GROUP = /^(?:the\s+)?(team|everyone|everybody|all|squad|crew|group)$/i;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FOOTER = "_Captured by voice with Synapse._";

const norm = (s: string): string => s.toLowerCase().replace(/[-_./]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string): string[] => norm(s).split(" ").filter((w) => w.length > 2);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, phrase: string): boolean => Boolean(phrase.trim()) && new RegExp(`\\b${escapeRe(norm(phrase))}\\b`).test(norm(text));

function repoNames(r: ProfileRepo): string[] {
  const name = r.fullName.split("/")[1] ?? r.fullName;
  return [r.fullName, name, ...r.aliases];
}

function resolveRepo(i: RouteInput): { repo?: string; need?: ArtifactNeed } {
  const { profile, text } = i;
  if (i.stored.repo) return { repo: i.stored.repo };
  if (i.context?.repo) return { repo: i.context.repo };
  const named = profile.repos.filter((r) => repoNames(r).some((n) => mentions(text, n)));
  if (named.length === 1) return { repo: named[0]!.fullName };
  const learned = profile.learned.filter((f) => f.kind === "repo_alias" && mentions(text, f.key)).at(-1);
  if (learned) return { repo: learned.value };
  if (profile.repos.length === 1) return { repo: profile.repos[0]!.fullName };
  const def = profile.repos.find((r) => r.isDefault);
  if (def && !named.length) return { repo: def.fullName };
  const said = new Set(words(text));
  const score = (r: ProfileRepo): number => [...repoNames(r), ...(r.topics ?? []), r.description ?? ""].flatMap(words).filter((w) => said.has(w)).length;
  const ranked = (named.length ? named : profile.repos).map((r, idx) => ({ r, s: score(r), idx })).sort((a, b) => b.s - a.s || a.idx - b.idx);
  return {
    need: {
      field: "repo",
      question: "Which repo?",
      options: ranked.slice(0, 3).map(({ r }) => ({ label: r.fullName, value: r.fullName })),
      allowFreeText: true,
      placeholder: "owner/repo",
    },
  };
}

function peopleNamed(profile: Profile, key: string): ProfilePerson[] {
  const k = key.toLowerCase();
  return profile.people.filter((p) => {
    const first = p.name.split(/\s+/)[0]!.toLowerCase();
    return p.name.toLowerCase() === k || first === k || p.aliases.some((a) => a.toLowerCase() === k);
  });
}

function resolveRecipients(i: RouteInput, names: string[]): { to?: string[]; needs: ArtifactNeed[] } {
  const out: string[] = [];
  const needs: ArtifactNeed[] = [];
  const withEmail = i.profile.people.filter((p) => p.email);
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (EMAIL_RE.test(name)) {
      out.push(name);
      continue;
    }
    const groupMatch = name.match(GROUP);
    const key = (groupMatch ? groupMatch[1]! : name).toLowerCase();
    const answered = i.stored.to?.[key];
    if (answered?.length) {
      out.push(...answered);
      continue;
    }
    const learned = i.profile.learned.filter((f) => (f.kind === "group_emails" || f.kind === "person_email") && f.key === key).at(-1);
    if (learned) {
      out.push(...learned.value.split(",").filter(Boolean));
      continue;
    }
    if (groupMatch) {
      needs.push({
        field: `to:${key}`,
        question: `Who is “the ${key}”?`,
        options: withEmail.slice(0, 4).map((p) => ({ label: p.name, value: p.email as string })),
        allowFreeText: true,
        placeholder: "name@example.com, other@example.com",
      });
      continue;
    }
    const matches = peopleNamed(i.profile, key);
    const reachable = matches.filter((p) => p.email);
    const display = name[0]!.toUpperCase() + name.slice(1);
    if (reachable.length === 1 && matches.length === 1) {
      out.push(reachable[0]!.email as string);
    } else if (reachable.length > 1) {
      needs.push({ field: `to:${key}`, question: `Which ${display}?`, options: reachable.map((p) => ({ label: `${p.name} (${p.email})`, value: p.email as string })), allowFreeText: true, placeholder: "name@example.com" });
    } else {
      const similar = withEmail.filter((p) => p.name.toLowerCase().startsWith(key.slice(0, 2))).slice(0, 3);
      needs.push({ field: `to:${key}`, question: `${display}'s email?`, options: similar.map((p) => ({ label: `${p.name} (${p.email})`, value: p.email as string })), allowFreeText: true, placeholder: "name@example.com" });
    }
  }
  return { ...(needs.length ? {} : { to: [...new Set(out)] }), needs };
}

/** "When?" choices in the user's timezone: tonight 9 pm (tomorrow's when that has passed), tomorrow 9 am, Saturday 10 am. */
export function whenOptions(now: number, tz: string): Array<{ label: string; value: string }> {
  const today = startOfDay(now, tz);
  const tonight = today + 21 * HOUR > now ? today + 21 * HOUR : today + DAY + 21 * HOUR;
  const dow = new Date(today + 12 * HOUR).getUTCDay(); // local weekday at noon, 0 = Sunday
  const toSat = (6 - dow + 7) % 7 || (today + 10 * HOUR > now ? 0 : 7);
  return [
    { label: tonight - today < DAY ? "Tonight 9 pm" : "Tomorrow 9 pm", value: localIso(tonight, tz) },
    { label: "Tomorrow 9 am", value: localIso(today + DAY + 9 * HOUR, tz) },
    { label: "This weekend", value: localIso(today + toSat * DAY + 10 * HOUR, tz) },
  ];
}

function dueOf(a: Artifact): string | null {
  if (a.kind === "reminder") return a.due_iso;
  if (a.kind === "calendar_event") return a.start_iso;
  return null;
}

export function resolveRoute(i: RouteInput): { route: ArtifactRoute; needs: ArtifactNeed[] } {
  const a = i.artifact;
  if (a.kind === "github_issue") {
    const r = resolveRepo(i);
    return { route: r.repo ? { repo: r.repo } : {}, needs: r.need ? [r.need] : [] };
  }
  if (a.kind === "email_draft") {
    const r = resolveRecipients(i, a.to);
    return { route: r.to ? { to: r.to } : {}, needs: r.needs };
  }
  if (a.kind === "reminder" || a.kind === "calendar_event") {
    const due = i.stored.dueAt ?? dueOf(a);
    if (due) return { route: { dueAt: due }, needs: [] };
    return { route: {}, needs: [{ field: "due", question: "When?", options: whenOptions(i.now, i.tz), allowFreeText: true, placeholder: "Friday 5pm" }] };
  }
  return { route: {}, needs: [] };
}

export class AnswerError extends Error {}

/** Apply one answer: the new stored route, and the facts to remember so the same question is never asked twice. */
export function applyAnswer(o: { artifact: Artifact; stored: StoredRoute; field: string; value: string; profile: Profile; keywords: string[]; now: number; tz: string }): { stored: StoredRoute; learned: LearnedFact[] } {
  const value = o.value.trim();
  if (o.field === "repo") {
    if (!REPO_RE.test(value)) throw new AnswerError("a repo is owner/name, like acme/shop");
    const keys = o.keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 2);
    return { stored: { ...o.stored, repo: value }, learned: keys.map((key) => ({ kind: "repo_alias", key, value, at: o.now })) };
  }
  if (o.field.startsWith("to:")) {
    const key = o.field.slice(3).toLowerCase();
    const emails = value.split(/[,;\s]+/).filter(Boolean);
    if (!emails.length || !emails.every((e) => EMAIL_RE.test(e))) throw new AnswerError("that does not look like an email address");
    const group = GROUP.test(key);
    return {
      stored: { ...o.stored, to: { ...o.stored.to, [key]: emails } },
      learned: [{ kind: group ? "group_emails" : "person_email", key, value: emails.join(","), at: o.now }],
    };
  }
  if (o.field === "due") {
    let iso: string | null = Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : null;
    if (!iso) {
      const t = spokenTime(value, o.now, o.tz);
      iso = t ? localIso(t.at, o.tz) : null;
    }
    if (!iso) throw new AnswerError("that is not a time I understand: try “Friday 5pm”");
    return { stored: { ...o.stored, dueAt: iso }, learned: [] };
  }
  throw new AnswerError(`unknown question "${o.field}"`);
}

const enc = encodeURIComponent;
const utcStamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The issue body as filed: the draft plus the footer (also used by the real API call). */
export function issueBody(p: ArtifactOf<"github_issue">): string {
  return `${p.body_markdown.trim()}\n\n---\n${FOOTER}`;
}

/** Prefilled handoffs. Only built once the destination is known (no half-addressed email, no issue without a repo). */
export function buildLinks(o: { artifact: Artifact; route: ArtifactRoute; artifactId: string; tz: string; emailApp: "gmail" | "mailto" }): ArtifactLinks {
  const a = o.artifact;
  if (a.kind === "github_issue" && o.route.repo) {
    const body = issueBody(a).slice(0, 6000); // GitHub's new-issue URL has a length limit
    return { newIssue: `https://github.com/${o.route.repo}/issues/new?title=${enc(a.title)}&body=${enc(body)}${a.labels.length ? `&labels=${enc(a.labels.join(","))}` : ""}` };
  }
  if (a.kind === "email_draft" && o.route.to?.length) {
    const to = o.route.to.join(",");
    return {
      mailto: `mailto:${to.split(",").map(enc).join(",")}?subject=${enc(a.subject)}&body=${enc(a.body)}`,
      gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(a.subject)}&body=${enc(a.body)}`,
    };
  }
  if ((a.kind === "reminder" || a.kind === "calendar_event") && o.route.dueAt) {
    const start = Date.parse(o.route.dueAt);
    const end = a.kind === "calendar_event" && a.end_iso && Date.parse(a.end_iso) > start ? Date.parse(a.end_iso) : start + 15 * 60_000;
    const text = a.kind === "reminder" ? a.what : a.title;
    return {
      calendar: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(text)}&dates=${utcStamp(start)}/${utcStamp(end)}&details=${enc("Reminder from Synapse")}&ctz=${enc(o.tz)}`,
      ics: `/api/artifacts/${enc(o.artifactId)}/export?format=ics`,
    };
  }
  if (a.kind === "message_draft") return { whatsapp: `https://wa.me/?text=${enc(a.body)}` };
  return {};
}
