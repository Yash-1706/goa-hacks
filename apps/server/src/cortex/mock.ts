import type { Artifact, Category, CortexResult, EntityType } from "@synapse/shared";
import type { Triager } from "../gate/triage";
import type { Embedder } from "../memory/embeddings";
import { chronoRange, startOfDay } from "../recall/time";
import { fold, normalizeText, quickTitle, textFeatures } from "../text";
import { localIso } from "./prompts";
import type { Candidate, CortexBackend, CortexInput, CortexOutput, CortexFragment } from "./types";

/** An explicit retraction ("scratch that"). Everything else that corrects a thought REVISES it. */
const RETRACT = /^(?:(?:ok(?:ay)?|so|yeah|no)[,.\s]+)?(?:scratch that|undo that|never ?mind(?: that| the last(?: one)?)?|forget (?:that|it)(?: one)?|delete that|cancel that|ignore that|take that back)\b/i;
const NEW_WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/** Apply a spoken revision ("actually make it Friday", "make it high priority") to the previous card's artifact. */
function reviseArtifact(old: Artifact | undefined, text: string, input: CortexInput): { artifact: Artifact | undefined; change: { from: string; to: string } | null } {
  if (!old) return { artifact: old, change: null };
  if (old.kind === "calendar_event") {
    const wd = text.match(NEW_WEEKDAY)?.[1];
    const oldStart = old.start_iso ? Date.parse(old.start_iso) : NaN;
    const ref = Number.isFinite(oldStart) ? oldStart : input.now;
    const r = chronoRange(text, ref, input.timezone, undefined, { future: true });
    if (!r && !wd) return { artifact: old, change: null };
    let start_iso = old.start_iso;
    let end_iso = old.end_iso;
    if (r && Number.isFinite(oldStart)) {
      // new day, same time of day and duration
      const timeOfDay = oldStart - startOfDay(oldStart, input.timezone);
      const start = startOfDay(r.from, input.timezone) + timeOfDay;
      const dur = old.end_iso && Number.isFinite(Date.parse(old.end_iso)) ? Date.parse(old.end_iso) - oldStart : 30 * 60_000;
      start_iso = localIso(start, input.timezone);
      end_iso = localIso(start + dur, input.timezone);
    }
    const to = wd ?? r?.matched ?? "";
    return {
      artifact: { ...old, start_iso, end_iso, time_expression: old.time_expression ? old.time_expression.replace(NEW_WEEKDAY, to) : to, is_reschedule: true },
      change: { from: old.time_expression ?? "", to },
    };
  }
  if (old.kind === "ticket") {
    const p = text.match(/\b(low|medium|high|urgent)\b/i)?.[1]?.toLowerCase() as "low" | "medium" | "high" | "urgent" | undefined;
    if (p && p !== old.priority) return { artifact: { ...old, priority: p }, change: { from: old.priority, to: p } };
  }
  return { artifact: old, change: null };
}

/* ============================================================================
 * Mock cortex (TRD §6.9a): deterministic, offline, no keys. Used when LLM_MODE=mock,
 * LOCAL_ONLY, and as the fallback when the live model is slow or unavailable.
 * Heuristics on top of the local triage classifier. Output is always schema-valid and is
 * labelled "mock" in the UI so nobody mistakes it for the real model.
 * ========================================================================== */

const LEAD_MARKERS = /^(?:uh+|um+|hmm+|er+|so|well|okay|ok|and|or|but|like|yeah|maybe|probably|actually|i think|i guess|then|also)[,.\s]+/i;

export function cleanClause(s: string): string {
  let out = normalizeText(s).replace(/\.{2,}|…/g, ", ");
  for (let i = 0; i < 4; i++) {
    const next = out.replace(LEAD_MARKERS, "");
    if (next === out) break;
    out = next;
  }
  return out.replace(/^[,\s]+|[,.?!:;\s]+$/g, "").replace(/\s+/g, " ");
}

const REPAIR_RE = /\b(?:or no|no,? wait|wait,? no|actually|i mean|rather|no no|nahi)\b[,.\s…]*|^no[,.]\s*/i;

export function extractRepairs(fragments: CortexFragment[]): Array<{ rejected: string; chosen: string }> {
  const out: Array<{ rejected: string; chosen: string }> = [];
  for (let i = 0; i < fragments.length; i++) {
    const text = (fragments[i] as CortexFragment).text;
    const m = REPAIR_RE.exec(text);
    if (!m) {
      const nb = text.match(/\bnot\s+(.{2,40}?)\s*(?:,|\.|—)?\s*(?:but|rather)\s+(.{2,40})/i);
      if (nb) out.push({ rejected: cleanClause(nb[1] ?? ""), chosen: cleanClause(nb[2] ?? "") });
      continue;
    }
    const before = cleanClause(text.slice(0, m.index));
    const afterRaw = text.slice(m.index + m[0].length);
    const chosen = cleanClause(afterRaw.split(/\.{2,}|…|[?!]/)[0] ?? afterRaw);
    const prev = i > 0 ? cleanClause((fragments[i - 1] as CortexFragment).text) : "";
    const rejected = before.split(/\s+/).length >= 1 && before ? before : prev;
    if (chosen && rejected && fold(chosen) !== fold(rejected)) out.push({ rejected: rejected.slice(0, 80), chosen: chosen.slice(0, 80) });
  }
  return out;
}

const TECH = /\b(JWT|OAuth2?|PKCE|OIDC|SAML|Redis|Postgres(?:QL)?|MySQL|Mongo(?:DB)?|Kafka|RabbitMQ|SQS|GraphQL|REST|gRPC|React|Vue|Svelte|Next\.js|Node(?:\.js)?|TypeScript|Python|Go|Rust|Docker|Kubernetes|Terraform|Fastify|Express|SQLite|Elasticsearch|Stripe|Auth0|AWS|GCP|Azure|CI|CD)\b/g;
const COMPONENT = /\b([a-z][a-z0-9]*(?:[- ](?:service|module|api|worker|queue|handler|endpoint|page|pipeline|job|server|client|library|lib)))\b/gi;
const ISSUE = /\b(null pointer(?: exception)?|npe|race condition|memory leak|crash(?:es|ing)?|time ?outs?|exception|stale data|duplicate[sd]?|wrong (?:\w+ )?(?:total|value|timezone|date)|500 error|404|deadlock|infinite loop|flaky(?: test)?)\b/i;
const WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const EVENT_NOUNS = /\b(standup|stand-up|sync|meeting|call|dentist|doctor|appointment|interview|demo|review|retro|planning|lunch|one on one|1:1|workshop)\b/gi;
const CUE_REMEMBER = /\b(note to self|remember (?:to|that)|don'?t forget|important|make sure (?:i|we)|remind me)\b/i;
const CUE_DEADLINE = /\b(by (?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|eod|end of (?:day|week))|due|deadline|before (?:friday|monday|the demo))\b|\bkal tak\b/i;
const CUE_COMMIT = /\b(i(?:'ll| will)|i'm going to|i need to|i have to|i should|i must|i gotta|need to|have to|hai$)\b/i;

function titleCase(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function distinct<T>(xs: T[], key: (x: T) => string = (x) => String(x)): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function findEntities(text: string, input: CortexInput): CortexResult["entities"] {
  const out: CortexResult["entities"] = [];
  const add = (name: string, type: EntityType): void => {
    const f = fold(name);
    if (!f || f.length < 2) return;
    const cand = input.candidates.find((c) => c.kind === "entity" && (fold(c.label) === f || fold(c.label).replace(/[\s-]/g, "") === f.replace(/[\s-]/g, "")));
    out.push({ name: cand?.label ?? name, type: cand?.entityType ?? type, candidate_id: cand?.ref ?? null });
  };
  for (const m of text.matchAll(TECH)) add(m[1] as string, "technology");
  for (const m of text.matchAll(COMPONENT)) add((m[1] as string).replace(/\s+/g, "-").toLowerCase(), "component");
  for (const member of input.user.team) if (new RegExp(`\\b${member.name}\\b`, "i").test(text)) add(member.name, "person");
  for (const c of input.candidates) {
    if (c.kind !== "entity") continue;
    if (new RegExp(`\\b${fold(c.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(fold(text))) add(c.label, c.entityType ?? "topic");
  }
  for (const v of input.vocabulary) if (v.length > 3 && new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) add(v, "topic");
  for (const m of text.matchAll(EVENT_NOUNS)) add(m[1] as string, "event");
  return distinct(out, (e) => e.name).slice(0, 6);
}

const REF_NOUN = "bug|issue|error|crash|problem|thing|idea|snippet|ticket|meeting|email|decision|approach|one|stuff|task|note|question|conflict|clash|plan|fix|call|doc|draft|message|thought|discussion";
const REF_CATEGORY: Array<[RegExp, Category]> = [
  [/^(bug|issue|error|crash|problem|fix)$/, "bug"],
  [/^(idea|thought)$/, "idea"],
  [/^(decision)$/, "decision"],
  [/^(email|message|draft)$/, "communication"],
  [/^(meeting|conflict|clash|call)$/, "scheduling"],
  [/^(snippet|approach)$/, "code"],
  [/^(task|ticket)$/, "action"],
];
const stemWord = (w: string): string => w.toLowerCase().replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");

function resolveReferences(text: string, input: CortexInput, category: Category): CortexResult["references"] {
  const out: CortexResult["references"] = [];
  const thoughts = input.candidates.filter((c) => (c.kind === "thought" || c.kind === "open_loop") && c.score >= 0.28);

  // "that bug from yesterday", "that caching idea", "the retry thing again", "that Safari crash"
  const demo = text.match(new RegExp(String.raw`\b(that|the|this)\s+((?:[A-Za-z][\w-]*\s+){0,3}?)(${REF_NOUN})\b(?:\s+(?:from|of|about|i|we|with|again|earlier)\b[^.?!…]{0,30})?`, "i"));
  if (demo && !/^(the|that|this)$/i.test(demo[2]?.trim() ?? "") ) {
    const mods = (demo[2] ?? "").trim().split(/\s+/).filter((w) => w.length > 2 && !/^(the|that|this|one|same|old|new|other|big|small|first|last)$/i.test(w)).map(stemWord);
    const noun = (demo[3] ?? "").toLowerCase();
    const wantCat = REF_CATEGORY.find(([re]) => re.test(noun))?.[1] ?? null;
    const scored = thoughts.map((c) => {
      const snippet = fold(c.snippet).split(" ").map(stemWord);
      const overlap = mods.length ? mods.filter((m) => snippet.some((w) => w === m || w.startsWith(m) || m.startsWith(w))).length / mods.length : 0;
      return { c, s: c.score + (wantCat && c.category === wantCat ? 0.2 : 0) + 0.25 * overlap };
    }).sort((a, b) => b.s - a.s);
    const best = scored[0]?.c;
    out.push({ mention: cleanClause(demo[0]), resolved_id: best?.ref ?? null, label: best?.label ?? "", confidence: best ? Math.min(0.9, 0.45 + (scored[0] as { s: number }).s * 0.6) : 0 });
  } else if (/\b(from|of) (yesterday|earlier|last (?:week|night)|this morning)\b/i.test(text) && thoughts[0]) {
    const c = thoughts[0];
    out.push({ mention: (text.match(/\b(?:from|of) (?:yesterday|earlier|last (?:week|night)|this morning)\b/i) ?? [""])[0], resolved_id: c.ref, label: c.label, confidence: Math.min(0.85, 0.4 + c.score) });
  }

  // "what did Sarah say", "what does Dev need again", "what's Sarah thinking"
  const said = text.match(/\bwhat(?:'s| is| did| does| do| was| were)\s+(\w+)\s+(?:say|said|saying|think|thinking|thought|suggest(?:ed)?|mention(?:ed)?|need(?:s|ed)?|want(?:s|ed)?|ask(?:ed)?|tell|told|recommend(?:ed)?|decide[ds]?)\b/i);
  if (said) {
    const who = (said[1] as string).toLowerCase();
    const known = input.user.team.some((m) => m.name.toLowerCase() === who) || input.candidates.some((e) => e.kind === "entity" && fold(e.label) === who);
    if (known) {
      const c = thoughts.filter((t) => fold(t.snippet).includes(who)).sort((a, b) => b.score - a.score)[0] ?? input.candidates.find((e) => e.kind === "entity" && fold(e.label) === who);
      out.push({ mention: said[0], resolved_id: c?.ref ?? null, label: c?.label ?? "", confidence: c ? 0.7 : 0 });
    }
  }
  if (category === "correction") {
    const last = input.lastCard ?? null;
    out.push({ mention: "that", resolved_id: last?.ref ?? null, label: (last?.result.title as string) ?? "", confidence: last ? 0.8 : 0 });
  }
  return out;
}

function artifactFor(category: Category, ctx: {
  text: string; title: string; intent: string; input: CortexInput; repairs: CortexResult["repairs"]; entities: CortexResult["entities"]; hedged: boolean; refs: CortexResult["references"];
}): Artifact {
  const { text, title, intent, input, repairs, entities, hedged } = ctx;
  const user = input.user.name;
  const person = entities.find((e) => e.type === "person");
  switch (category) {
    case "bug": {
      const issue = text.match(ISSUE)?.[1] ?? "unexpected behaviour";
      const comp = entities.find((e) => e.type === "component")?.name;
      const hyp = [...text.matchAll(/\b(?:probably|maybe|might be|could be|i think it'?s?|looks like)\s+(?:the\s+)?([^.,…?]{3,60})/gi)].map((m) => cleanClause(m[1] ?? ""));
      const ref = ctx.refs.find((r) => r.resolved_id);
      return {
        kind: "github_issue",
        title: titleCase(`${issue}${comp ? ` in ${comp}` : ""}`.slice(0, 90)),
        body_markdown: [
          "**Summary**", intent, "",
          "**Observed**", `${titleCase(issue)}${comp ? ` in ${comp}` : ""}.${ref ? ` Related earlier note: ${ref.resolved_id}.` : ""}`, "",
          "**Suspected cause**", hyp.length ? `${titleCase(hyp[0] as string)} (speaker's hypothesis, unconfirmed).` : "Unknown yet.", "",
          "**Next steps**", "- Reproduce the failure", "- Add a guard or fix at the suspected location", "- Add a regression test",
        ].join("\n"),
        labels: distinct(["bug", ...(comp ? [comp] : [])]),
        hypotheses: hyp.slice(0, 3),
      };
    }
    case "action":
      return {
        kind: "ticket", title, description: intent, issue_type: "task",
        priority: CUE_DEADLINE.test(text) ? "high" : "medium", labels: [], component: entities.find((e) => e.type === "component")?.name ?? null,
        acceptance_criteria: [`${title} is done`, "Verified and noted"],
      };
    case "communication": {
      const to = person?.name ?? (/\bteam\b/i.test(text) ? "team" : "team");
      const quick = /\b(ping|dm|tell|text|message|slack)\b/i.test(text) && !/\b(e-?mail|team|everyone|board)\b/i.test(text);
      const topic = cleanClause(text.match(/\babout\s+(.{3,60})/i)?.[1] ?? text.match(/\bthat\s+(.{3,60})/i)?.[1] ?? "");
      if (quick && person) {
        return { kind: "message_draft", to: person.name, channel: "slack", body: `Hey ${person.name}, ${topic ? topic : "quick update"} — [details].` };
      }
      return {
        kind: "email_draft", to: [to], subject: titleCase(topic ? `Update: ${topic}` : "Quick update").slice(0, 80),
        body: `Hi ${to === "team" ? "team" : to},\n\n${topic ? `Quick note about ${topic}.` : "Quick update."} [add details]\n\nThanks,\n${user}`, tone: "neutral",
      };
    }
    case "scheduling": {
      const r = chronoRange(text, input.now, input.timezone, undefined, { future: true });
      const wd = text.match(WEEKDAY)?.[1];
      const conflict = /\b(clash(?:es)?|conflict|overlap(?:s)?|double booked)\b/i.test(text);
      // a concrete instant only when a time of day was actually said ("Thursday at 3pm"); conflicts stay open
      const start = !conflict && r?.point ? r.point : null;
      return {
        kind: "calendar_event", title,
        start_iso: start ? localIso(start, input.timezone) : null,
        end_iso: start ? localIso(start + 30 * 60_000, input.timezone) : null,
        time_expression: r?.matched ?? wd ?? null, attendees: [], is_reschedule: conflict || /\b(reschedule|move|push)\b/i.test(text),
      };
    }
    case "code": {
      const t = text.toLowerCase();
      const pick =
        /memoiz|memo|iterative|recursi/.test(t) ? "memo" : /backoff|retry/.test(t) ? "retry" : /debounce/.test(t) ? "debounce" : /lru|cache/.test(t) ? "lru" : "skeleton";
      const code = {
        memo: "function solve(n: number): number {\n  const memo = new Map<number, number>([[0, 0], [1, 1]]);\n  for (let i = 2; i <= n; i++) {\n    memo.set(i, (memo.get(i - 1) as number) + (memo.get(i - 2) as number)); // replace with the real recurrence\n  }\n  return memo.get(n) as number;\n}",
        retry: "async function withRetry<T>(fn: () => Promise<T>, tries = 5, base = 200): Promise<T> {\n  for (let i = 0; ; i++) {\n    try { return await fn(); } catch (e) {\n      if (i >= tries - 1) throw e;\n      const delay = base * 2 ** i * (0.5 + Math.random() / 2); // exponential backoff + jitter\n      await new Promise((r) => setTimeout(r, delay));\n    }\n  }\n}",
        debounce: "function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {\n  let t: ReturnType<typeof setTimeout> | undefined;\n  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };\n}",
        lru: "class LRU<K, V> {\n  private m = new Map<K, V>();\n  constructor(private cap: number) {}\n  get(k: K) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }\n  set(k: K, v: V) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as K); }\n}",
        skeleton: "// TODO: implement the approach described above\nfunction solve(input: unknown) {\n  throw new Error(\"not implemented\");\n}",
      }[pick];
      return { kind: "code_snippet", language: "typescript", approach: repairs[0]?.chosen ?? title, signature: null, code, explanation: `${intent} (heuristic sketch: replace the placeholder logic).`, needs_enrichment: false };
    }
    case "decision": {
      const chosen = repairs.length ? (repairs[repairs.length - 1] as { chosen: string }).chosen : null;
      return { kind: "decision", question: titleCase(`Which option for ${entities.find((e) => e.type !== "person")?.name ?? "this"}?`).replace(/Which option for (JWT|OAuth2?)\?/i, "Which auth approach?"), chosen, rejected: repairs.map((r) => r.rejected), rationale: null, status: chosen && !hedged ? "decided" : "tentative" };
    }
    case "idea":
      return { kind: "note", body: intent, tags: distinct(entities.map((e) => fold(e.name).split(" ")[0] as string)).slice(0, 3) };
    case "journal":
      return { kind: "journal", body: titleCase(cleanClause(text)) + "." };
    case "recall_query": {
      const act = /\bwalk(?:ing)?\b/i.test(text) ? "walking" : /\bdriv(?:e|ing)|\bcar\b/i.test(text) ? "driving" : /\bdesk\b/i.test(text) ? "desk" : null;
      const range = chronoRange(text, input.now, input.timezone);
      const types = [/\bidea\b/i.test(text) && "idea", /\bbug\b/i.test(text) && "bug", /\b(decid\w+|decision)\b/i.test(text) && "decision"].filter(Boolean) as string[];
      let topic = text.replace(/\b(what|was|were|that|the|i|had|have|my|about|did|say|said|think|thought|mention(?:ed)?|remind me|find|show me|while|walking|driving|on|at|in|of|a|an|me|thing|idea)\b/gi, " ");
      if (range) topic = topic.replace(new RegExp(range.matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
      topic = topic.replace(/[?.,]/g, " ").replace(/\s+/g, " ").trim();
      return { kind: "recall", topic_query: topic || cleanClause(text), time_expression: range?.matched ?? null, activity: act, device: null, types, persons: entities.filter((e) => e.type === "person").map((e) => e.name) };
    }
    default:
      return { kind: "none" };
  }
}

function titleFor(category: Category, text: string, input: CortexInput, repairs: CortexResult["repairs"], entities: CortexResult["entities"]): string {
  const clean = cleanClause(text);
  switch (category) {
    case "bug": {
      const issue = text.match(ISSUE)?.[1];
      const comp = entities.find((e) => e.type === "component")?.name;
      return issue ? titleCase(`${issue}${comp ? ` in ${comp}` : ""}`).slice(0, 70) : quickTitle(clean, 9);
    }
    case "action": {
      const stripped = clean.replace(/^(i (need|have|gotta|should|must|want|really should) to|need to|have to|remind me to|todo|let me|let's|note to self,?)\s+/i, "");
      return quickTitle(stripped, 9);
    }
    case "communication": {
      const person = entities.find((e) => e.type === "person")?.name;
      const verb = /e-?mail/i.test(text) ? "Email" : "Message";
      const topic = cleanClause(text.match(/\babout\s+(.{3,50})/i)?.[1] ?? "");
      return `${verb} ${person ?? "the team"}${topic ? ` about ${topic}` : ""}`.slice(0, 70);
    }
    case "scheduling": {
      const wd = text.match(WEEKDAY)?.[1];
      const ev = distinct([...text.matchAll(EVENT_NOUNS)].map((m) => (m[1] as string).toLowerCase()));
      if (ev.length >= 2 && /clash|conflict|overlap|double booked/i.test(text)) return `${wd ? titleCase(wd.toLowerCase()) + ": " : ""}${ev[0]} vs ${ev[1]}`;
      return quickTitle(clean, 9);
    }
    case "code":
      return titleCase(repairs[0]?.chosen ?? quickTitle(clean, 7));
    case "decision": {
      if (repairs.length) {
        const r = repairs[repairs.length - 1] as { rejected: string; chosen: string };
        const topic = /\b(jwt|oauth|session|token|auth)/i.test(text) ? "Auth" : titleCase(entities.find((e) => e.type !== "person")?.name ?? "Decision");
        return `${topic}: ${r.chosen} over ${r.rejected}`.slice(0, 80);
      }
      return quickTitle(clean, 9);
    }
    case "question":
      return quickTitle(clean.replace(/^wait,?\s*/i, ""), 9);
    case "recall_query":
      return `Recall: ${quickTitle(clean.replace(/^(what|which)\s+(was|were|did)\s+/i, ""), 7)}`;
    case "aside":
      return "Aside";
    case "privacy":
      return "Privacy command";
    case "correction":
      return "Correction";
    default:
      return quickTitle(clean, 9);
  }
}

export class MockCortex implements CortexBackend {
  readonly name = "mock";
  constructor(
    private triager: Triager,
    private embedder: Embedder,
  ) {}

  async analyze(input: CortexInput): Promise<CortexOutput> {
    const t0 = performance.now();
    const text = input.fragments.map((f) => f.text).join(" ");
    const [emb] = await this.embedder.embed([text], "query");
    const tri = emb ? this.triager.classify(text, emb) : input.triage;
    const feat = textFeatures(text);
    let category = tri.label;
    // thread-level overrides the per-fragment classifier cannot see
    if (input.lastCard && (feat.startsWithRepairCue || tri.probs.correction > 0.25)) category = "correction";
    if (category === "decision" && !feat.hasRepairCue && !/\b(jwt|oauth|vs|or|instead|rather|go(?:ing)? with|decid)/i.test(text)) category = "idea";

    // a correction that is not an explicit retraction REVISES the previous card instead of deleting it
    if (category === "correction" && input.lastCard && !RETRACT.test(cleanClause(text))) {
      const revised = this.revise(input, text, t0);
      if (revised) return revised;
      category = "aside"; // a correction we cannot interpret must never be destructive
    }

    const repairs = category === "correction" ? [] : extractRepairs(input.fragments);
    const entities = findEntities(text, input);
    const references = resolveReferences(text, input, category);
    const title = titleFor(category, text, input, repairs, entities);
    const hedged = feat.hedged || feat.hasRepairCue;

    const intentBase = cleanClause(text.replace(/\b(uh+|um+|hmm+)\b[,.]?/gi, ""));
    const resolved = references.filter((r) => r.resolved_id);
    let intent = repairs.length
      ? `${titleCase(intentBase.split(/[.?…]/)[0] ?? intentBase)}. Chosen: ${(repairs[repairs.length - 1] as { chosen: string }).chosen} (not ${(repairs[repairs.length - 1] as { rejected: string }).rejected}).`
      : titleCase(intentBase);
    if (resolved.length) intent += ` (re: ${resolved.map((r) => r.label).join("; ")})`;
    intent = intent.slice(0, 280);

    const open_questions: string[] = [];
    const qm = text.match(/\b(what|who|why|how|when|which)\b[^?.…]*\?/gi);
    if (qm && category !== "recall_query") for (const q of qm) open_questions.push(titleCase(cleanClause(q)) + "?");

    let confidence = Math.max(0.35, Math.min(0.9, tri.confidence * 0.9 + (tri.topSim > 0.5 ? 0.1 : 0)));
    if (hedged) confidence = Math.min(confidence, 0.6);
    if (category === "aside") confidence = Math.max(confidence, 0.8);

    const artifact = artifactFor(category, { text, title, intent, input, repairs, entities, hedged, refs: references });
    const cues: CortexResult["salience_cues"] = [];
    if (CUE_REMEMBER.test(text)) cues.push("explicit_remember");
    if (CUE_DEADLINE.test(text)) cues.push("deadline");
    if (CUE_COMMIT.test(text) && ["action", "communication", "scheduling"].includes(category)) cues.push("commitment");

    let concern: string | null = null;
    if (category === "scheduling") {
      const wd = text.match(WEEKDAY)?.[1]?.toLowerCase();
      const ev = distinct([...text.matchAll(EVENT_NOUNS)].map((m) => (m[1] as string).toLowerCase().replace("stand-up", "standup"))).sort();
      if (ev.length >= 1 && /clash|conflict|overlap|double booked|can'?t make/i.test(text)) concern = `calendar_conflict:${[...ev, wd].filter(Boolean).sort().join("~")}`;
    }

    const result: CortexResult = {
      thread_relation: category === "correction" ? "correction_of_previous" : "continue",
      category,
      confidence,
      title,
      intent,
      why: repairs.length ? `Self-correction detected: '${(repairs[0] as { rejected: string }).rejected}' replaced by '${(repairs[0] as { chosen: string }).chosen}'.` : `Local heuristic classified this as ${category}.`,
      references,
      repairs,
      open_questions: open_questions.slice(0, 2),
      entities,
      salience_cues: cues,
      concern_key: concern,
      artifact,
    };
    return { result, source: "mock", model: "heuristic", ms: performance.now() - t0, redactions: 0 };
  }

  /** "Actually make it Friday": the previous thought, corrected. Never destructive. */
  private revise(input: CortexInput, text: string, t0: number): CortexOutput | null {
    const last = input.lastCard;
    if (!last) return null;
    const prev = last.result;
    const { artifact, change } = reviseArtifact(prev.artifact as Artifact | undefined, text, input);
    if (!change) return null; // nothing we understand to change: leave the thought untouched (treated as an aside)
    const prevTitle = (prev.title as string | undefined) ?? "Revised thought";
    const title = NEW_WEEKDAY.test(prevTitle) && change.to ? prevTitle.replace(NEW_WEEKDAY, change.to[0]!.toUpperCase() + change.to.slice(1)) : prevTitle;
    const result: CortexResult = {
      thread_relation: "correction_of_previous",
      category: prev.category,
      confidence: 0.75,
      title: title.slice(0, 80),
      intent: `${(prev.intent as string | undefined) ?? prevTitle} (revised: ${change.from ? `${change.from} → ` : ""}${change.to})`.slice(0, 280),
      why: `Revises ${last.ref}: "${cleanClause(text)}".`,
      references: [{ mention: "it", resolved_id: last.ref, label: prevTitle, confidence: 0.85 }],
      repairs: change.from ? [{ rejected: change.from, chosen: change.to }] : [],
      open_questions: [],
      entities: findEntities(`${prevTitle} ${text}`, input),
      salience_cues: [],
      concern_key: null,
      artifact: artifact ?? { kind: "none" },
    };
    return { result, source: "mock", model: "heuristic", ms: performance.now() - t0, redactions: 0 };
  }
}
