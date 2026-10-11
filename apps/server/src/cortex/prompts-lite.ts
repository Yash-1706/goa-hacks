import type { CortexResult } from "@synapse/shared";
import { EXAMPLES, renderUserMessage } from "./prompts";
import type { CortexInput } from "./types";

/* ============================================================================
 * Compact ("lite") prompt contract for providers with a tight tokens-per-minute budget (Groq's free tier: 8,000/min).
 *
 * The full Claude prompt (SYSTEM_INSTRUCTIONS + 17 worked examples, about 8.5k tokens) can never be sent there: a single
 * request over the minute budget is rejected, and every call is charged its prompt against that budget. This one keeps what
 * decides the answer (the rules, the category precedence, every artifact's fields, the privacy prohibitions) in table form,
 * plus a few worked examples chosen from EXAMPLES so their outputs are, by construction, valid CortexResults. The system part
 * is static (no ids, no timestamps), so it can be prefix-cached where the provider does that. Everything volatile goes in
 * the user message.
 * ========================================================================== */

export const LITE_INSTRUCTIONS = `You are the cortex of Synapse, a private second brain. You get a short thread of fragments of one person's speech (fragmentary: pauses, false starts, backtracking). Work out what they MEANT and answer with ONE JSON object only. Never talk to the user.

Rules
- Infer, don't command: they think out loud; you decide what, if anything, should exist.
- Never invent names, dates, numbers, causes, recipients or facts. Unknown: null, left out, or a [bracketed placeholder] in a draft.
- Abstain when unsure: noise, mumbles, device chatter and speech to another person are "aside"; a harmless remark is "journal". Hedges ("maybe", "probably") cap confidence near 0.6; clear commitments get 0.85+.
- Only what was said: do not infer emotions, health, mental state or relationships, nothing about other people, do not identify speakers.
- Terse: title under 70 chars, intent 1-2 sentences, why one clause, compact artifacts.
- [EMAIL_1], [SECRET_2], [PERSON_A] are redacted values: copy them verbatim, never guess them.
- Self-repairs ("or no", "actually", "I mean", "scratch that"): the LAST committed option wins; log both in repairs. Pauses are thinking, not a new topic. Hinglish is fine: answer in English.

Input: <thread> fragments (ONE thought unless clearly not), the speaker is "I", <now> and <days> (the coming dates by weekday) resolve relative times; <previous_card> is your last answer for this thread (change only what new fragments require); <last_card> is the latest OTHER thought (for corrections); <candidates> are memory refs (T- thought, E- entity, O- open loop).

Answer: a JSON object with exactly these keys in this order ([] or null when empty):
thread_relation: continue | new_thought (the LAST fragment is a different topic) | correction_of_previous (revises or retracts <last_card>)
category (first match wins; the artifact is always the one in brackets):
 privacy: asks to pause, stop recording, go off the record or forget [none]
 correction: ONLY a retraction ("scratch that", "forget that one") [none]. A revision ("actually make it Friday", "no, the other one") is NOT category correction: set thread_relation correction_of_previous and return the FULL corrected card with <last_card>'s own category and artifact kind, change applied
 recall_query: asks to retrieve something THEY said or noted earlier, usually with a time or place cue ("what was that idea I had last Tuesday while walking?") [recall]
 bug: something broken, crashing, flaky or failing, even when only referred to vaguely ("that bug from yesterday") [github_issue]
 communication: tell, email, message, reply to or follow up with someone [email_draft if formal or team-wide, else message_draft]
 scheduling: meetings, clashes, appointments, timed deadlines [calendar_event]; "remind me to … <time>" [reminder]
 action: a task to do [ticket]; "remind me to …" [reminder] (but "remind me to email X" is communication)
 code: HOW to implement something: an algorithm, data structure or pattern, even when the approach changes mid-sentence ("maybe recursive... no, iterative with memoization") [code_snippet]
 decision: choosing between options, tools or designs ("JWT or OAuth2?") [decision]
 question: a bare question to themselves about a fact or a name, no time or place cue ("what was the name of that retry library?"); also put it in open_questions [none]
 idea: proposal or insight, not a task [note]
 journal: harmless remark [journal]
 aside: noise, filler, device chatter ("was that my phone?"), or speech to someone else ("sure, give me two minutes") [none]
confidence: 0..1
title; intent (reconstructed meaning, references resolved, real uncertainty kept); why (one short clause)
references: [{mention, resolved_id (candidate ref or null), label, confidence}] for vague references, only when a candidate genuinely fits
repairs: [{rejected, chosen}] whenever they switch options mid-speech ("maybe X... or no, Y")
open_questions: [standalone questions the speaker asked themselves]
entities: [{name, type: person|project|component|technology|bug|event|place|topic|org, candidate_id: ref|null}]
salience_cues: any of explicit_remember ("note to self"), emphasis, deadline, commitment
concern_key: null, or "<type>:<noun>~<noun>" (lowercase, nouns sorted) for a recurring conflict or blocker, e.g. "calendar_conflict:dentist~standup~thursday"
artifact kinds:
 ticket {kind,title (imperative),description,issue_type: task|story|bug|spike,priority: low|medium|high|urgent,labels[],component|null,acceptance_criteria[2-4]}
 github_issue {kind,title,body_markdown (**Summary** **Observed** **Suspected cause** **Next steps**),labels[],hypotheses[]}
 email_draft {kind,to[names or "team"],subject,body (speaker's voice),tone: casual|neutral|formal}
 message_draft {kind,to,channel: slack|whatsapp|sms|other,body}
 calendar_event {kind,title,start_iso|null,end_iso|null (ISO-8601 with offset, only when date and time resolve from <now>),time_expression|null,attendees[],is_reschedule}
 reminder {kind,what (short imperative, no time),due_iso|null (ISO-8601 with offset; a bare hour 1-7 means pm),due_text|null,recurrence|null}
 code_snippet {kind,language,approach,signature|null,code (under 15 lines),explanation,needs_enrichment}
 code_comment {kind,target|null,comment}
 decision {kind,question,chosen|null,rejected[],rationale|null,status: tentative|decided}
 note {kind,body,tags[1-3]}
 journal {kind,body}
 recall {kind,topic_query,time_expression|null,activity: walking|driving|desk|still|null,device: desk|pocket|null,types[],persons[]}
 none {kind}`;

/** indexes into EXAMPLES: a bug with a vague reference resolved against memory (S1), and an aside (speech to someone else) */
export const LITE_EXAMPLE_INDEXES: readonly number[] = [0, 15];

let cachedLite: string | undefined;

/** Static compact system prompt: instructions plus a few worked examples. Deterministic. */
export function liteSystemPrompt(): string {
  if (cachedLite) return cachedLite;
  let header = "";
  const shots = LITE_EXAMPLE_INDEXES.map((i, n) => {
    const ex = EXAMPLES[i];
    if (!ex) throw new Error(`lite prompt example ${i} does not exist`);
    // the examples share one <now> and one <user>: print them once
    const [now, user, ...rest] = renderUserMessage({ ...ex.input, vocabulary: [] }).split("\n");
    header = `${now}\n${user}`;
    return `Example ${n + 1}\nINPUT:\n${rest.join("\n")}\nOUTPUT:\n${JSON.stringify(ex.output)}`;
  }).join("\n\n");
  cachedLite = `${LITE_INSTRUCTIONS}\n\nExamples (all with this header):\n${header}\n\n${shots}\n\nReturn ONLY the JSON object, compact, on one line.`;
  return cachedLite;
}

export const LITE_EXAMPLE_OUTPUTS: ReadonlyArray<CortexResult> = LITE_EXAMPLE_INDEXES.map((i) => (EXAMPLES[i] as (typeof EXAMPLES)[number]).output);

/* ------------------------------------------------------------ user message --- */

const clipStr = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `<days>`: today and the next seven dates with their weekday, in the user's time zone ("Tue 2026-10-06 (today), Wed 2026-10-07, ..."). */
export function daysLine(now: number, tz: string): string {
  const [y, m, d] = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number) as [number, number, number];
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
  // calendar arithmetic on the local date (noon UTC stands for the day), so a daylight-saving change cannot skip or repeat a date
  const days = Array.from({ length: 8 }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d + i, 12));
    return `${wd.format(day)} ${day.toISOString().slice(0, 10)}${i === 0 ? " (today)" : ""}`;
  });
  return `<days>${days.join(", ")}</days>`;
}

function clip<T>(value: T, n: number): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return clipStr(v, n);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * The volatile part of the prompt, trimmed for a small budget: at most 5 candidates (160-char snippets), 3 recent thoughts,
 * 20 vocabulary terms, the previous card reduced to what keeps it stable, and the correction target clipped. The input is
 * expected to be redacted already.
 */
export function renderLiteUserMessage(input: CortexInput): string {
  const slim: CortexInput = {
    ...input,
    previous: null,
    lastCard: null,
    candidates: input.candidates.slice(0, 5).map((c) => ({ ...c, label: clipStr(c.label, 80), snippet: clipStr(c.snippet, 160) })),
    recent: input.recent.slice(0, 3).map((r) => ({ ...r, title: clipStr(r.title, 80) })),
    vocabulary: input.vocabulary.slice(0, 20),
  };
  // a small model is unreliable at "next Monday" arithmetic: hand it the calendar instead
  const base = renderUserMessage(slim).replace("\n", `\n${daysLine(input.now, input.timezone)}\n`);
  const extra: string[] = [];
  const p = input.previous;
  if (p) extra.push(`<previous_card>${JSON.stringify({ category: p.category, confidence: p.confidence, title: clipStr(p.title, 100), intent: clipStr(p.intent, 200), artifact_kind: p.artifact.kind })}</previous_card>`);
  if (input.lastCard) extra.push(`<last_card ref="${input.lastCard.ref}">${JSON.stringify(clip(input.lastCard.result, 160))}</last_card>`);
  return extra.length ? base.replace("</thread>", `</thread>\n${extra.join("\n")}`) : base;
}
