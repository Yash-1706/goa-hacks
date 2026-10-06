import type { CortexResult } from "@synapse/shared";
import { EXAMPLES, renderUserMessage } from "./prompts";
import type { CortexInput } from "./types";

/* ============================================================================
 * Compact ("lite") prompt contract for providers with a tight tokens-per-minute budget (Groq's free tier: 8,000/min).
 *
 * The full Claude prompt (SYSTEM_INSTRUCTIONS + 17 worked examples, about 8.5k tokens) can never be sent there: a single
 * request over the minute budget is rejected. This one keeps what decides the answer (the rules, the category precedence,
 * every artifact's fields, the privacy prohibitions) in table form, plus a few worked examples chosen from EXAMPLES so
 * their outputs are, by construction, valid CortexResults. The system part is static (no ids, no timestamps), so it can
 * be prefix-cached where the provider does that. Everything volatile goes in the user message.
 * ========================================================================== */

export const LITE_INSTRUCTIONS = `You are the cortex of Synapse, a private second brain. You get a short thread of fragments of one person's speech (transcribed, fragmentary: pauses, false starts, backtracking). Work out what they MEANT and answer with ONE JSON object and nothing else. You never talk to the user or ask questions.

Rules
1. Infer, do not command: decide whether the thought is a task, bug, draft, decision, idea, question, code sketch or noise.
2. Never invent names, dates, numbers, causes, recipients, URLs or facts. Unknown means null, left out, or a [bracketed placeholder] in a draft.
3. Abstain when unsure: noise, mumbles, device chatter and speech to another person are "aside"; a harmless remark is "journal". Hedges ("maybe", "probably", "not sure") cap confidence near 0.6; clear commitments get 0.85+.
4. Only what was said. Do not infer emotions, health, mental state or relationships, nothing about other people. Do not identify speakers.
5. Be terse: title under 70 characters, intent 1-2 sentences, why one short clause, compact artifact bodies.
6. [EMAIL_1], [SECRET_2], [PHONE_1], [PERSON_A] are redacted values: copy them verbatim when relevant, never guess what they hide.
7. Self-repair markers ("or no", "actually", "I mean", "scratch that", "rather"): the LAST committed option wins; record both in repairs. Pauses mean thinking, not a new topic. Hinglish is normal: answer in English.

Input tags: <now> (resolve relative times with it), <user> (the speaker is "I"; teammates name:role), <device>, <thread> (fragments in order: ONE thought unless clearly not), <previous_card> (your last answer for this thread: change only what the new fragments require), <last_card> (the latest OTHER thought, given for corrections), <candidates> (memory: T-n thought, E-n entity, O-n open loop), <recent>, <vocabulary> (preferred spellings).

Answer with one JSON object, these keys in this order, all required (use [] or null when empty):
thread_relation: "continue" | "new_thought" (the LAST fragment is a different topic) | "correction_of_previous" (revises or retracts <last_card>)
category: first match wins
 1 privacy: asks to pause, stop recording, go off the record or forget something. artifact none
 2 correction: "scratch that", "actually make it Friday", "no, the other one". Retraction: artifact none. Revision: return the FULL corrected card with <last_card>'s category and artifact kind, change applied
 3 recall_query: asks about their own past thoughts. artifact recall
 4 bug: broken, crashing, flaky, failing. github_issue
 5 communication: tell, email, message, reply to or follow up with someone. email_draft (formal or team-wide) or message_draft (quick chat to one person)
 6 scheduling: meetings, clashes, appointments, deadlines with times. calendar_event
 7 action: a task to do. ticket
 8 code: half-formed implementation idea. code_snippet
 9 decision: weighing or choosing between options. decision
 10 question: asks themselves something. artifact none; put the question in open_questions
 11 idea: proposal or insight, not a task. note
 12 journal: harmless remark. journal
 13 aside: noise, filler, speech to someone else, device chatter. none
confidence: 0..1
title, intent (the reconstructed meaning; resolve references; keep real uncertainty), why (one short clause)
references: [{mention, resolved_id (a candidate ref or null), label, confidence}] only for vague references ("that bug from yesterday") and only when a candidate genuinely fits
repairs: [{rejected, chosen}]
open_questions: [standalone questions the speaker asked themselves]
entities: [{name, type: person|project|component|technology|bug|event|place|topic|org, candidate_id: ref|null}]
salience_cues: any of explicit_remember ("note to self", "remember"), emphasis, deadline, commitment
concern_key: null, or "<type>:<noun>~<noun>" lowercase with sorted nouns for a recurring conflict or blocker, e.g. "calendar_conflict:dentist~standup~thursday"
artifact: by kind
 ticket {kind,title (imperative),description,issue_type: task|story|bug|spike,priority: low|medium|high|urgent,labels[],component|null,acceptance_criteria[2-4]}
 github_issue {kind,title,body_markdown (**Summary**, **Observed**, **Suspected cause**, **Next steps**),labels[],hypotheses[]}
 email_draft {kind,to[names or "team"],subject,body (speaker's voice),tone: casual|neutral|formal}
 message_draft {kind,to,channel: slack|whatsapp|sms|other,body}
 calendar_event {kind,title,start_iso|null,end_iso|null (ISO-8601 with offset, only when date and time resolve from <now>),time_expression|null,attendees[],is_reschedule}
 code_snippet {kind,language,approach,signature|null,code (under 25 lines),explanation,needs_enrichment}
 code_comment {kind,target|null,comment}
 decision {kind,question,chosen|null,rejected[],rationale|null,status: tentative|decided}
 note {kind,body,tags[1-3]}
 journal {kind,body}
 recall {kind,topic_query,time_expression|null,activity: walking|driving|desk|still|null,device: desk|pocket|null,types[],persons[]}
 none {kind}`;

/** indexes into EXAMPLES: a decision with a self-repair, a reference and an open question; a calendar clash; an aside */
export const LITE_EXAMPLE_INDEXES: readonly number[] = [1, 6, 15];

let cachedLite: string | undefined;

/** Static compact system prompt: instructions plus a few worked examples. Deterministic. */
export function liteSystemPrompt(): string {
  if (cachedLite) return cachedLite;
  const shots = LITE_EXAMPLE_INDEXES.map((i, n) => {
    const ex = EXAMPLES[i];
    if (!ex) throw new Error(`lite prompt example ${i} does not exist`);
    return `Example ${n + 1}\nINPUT:\n${renderUserMessage({ ...ex.input, vocabulary: [] })}\nOUTPUT:\n${JSON.stringify(ex.output)}`;
  }).join("\n\n");
  cachedLite = `${LITE_INSTRUCTIONS}\n\n${shots}\n\nReturn ONLY the JSON object.`;
  return cachedLite;
}

export const LITE_EXAMPLE_OUTPUTS: ReadonlyArray<CortexResult> = LITE_EXAMPLE_INDEXES.map((i) => (EXAMPLES[i] as (typeof EXAMPLES)[number]).output);

/* ------------------------------------------------------------ user message --- */

const clipStr = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
  const base = renderUserMessage(slim);
  const extra: string[] = [];
  const p = input.previous;
  if (p) extra.push(`<previous_card>${JSON.stringify({ category: p.category, confidence: p.confidence, title: clipStr(p.title, 100), intent: clipStr(p.intent, 200), artifact_kind: p.artifact.kind })}</previous_card>`);
  if (input.lastCard) extra.push(`<last_card ref="${input.lastCard.ref}">${JSON.stringify(clip(input.lastCard.result, 160))}</last_card>`);
  return extra.length ? base.replace("</thread>", `</thread>\n${extra.join("\n")}`) : base;
}
