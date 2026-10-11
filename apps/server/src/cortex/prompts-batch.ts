import { daysLine } from "./prompts-lite";

/* ============================================================================
 * The capture prompt (V1.1): ONE call per capture on Groq's free tier. A whole ramble arrives as one transcript; the model
 * splits it into items and drafts every item at once. Written in the prompts-lite style: the rules, the artifact contract,
 * one worked example; about 1.3k tokens, so prompt + transcript + answer stay well inside an 8k tokens-per-minute budget.
 * ========================================================================== */

export const BATCH_INSTRUCTIONS = `You turn ONE spoken ramble into separate, finished items. Reply with JSON only: {"items":[...]}.

Split the transcript into one item per intent, in the order said. Each item:
 said: the exact words of the transcript it covers (copy them, keep the speaker's words)
 category: bug | communication | scheduling | action | code | decision | idea | question | journal | aside | correction
 title: short and specific, never the whole sentence ("NPE in cart-service discount code", "Call the landlord")
 intent: one clean sentence of what they meant
 confidence: 0..1
 artifact: by category (exactly one): bug→github_issue · communication→email_draft (formal or team-wide) or message_draft (quick, one person) · scheduling→calendar_event, or reminder for "remind me…" · action→ticket, or reminder for "remind me…" · code→code_snippet · decision→decision · idea→note · question/aside/correction→none
 repairs: [{rejected, chosen}] when they changed their mind inside the item
 entities: [{name, type: person|project|component|technology|bug|event|place|topic|org}]
 corrects: null, or the ref of an EARLIER card from <recent> that this item revises or retracts

Rules:
- One breath can hold several items: "the cart bug… oh, and email the team… remind me to…" is three items, even when joined by commas.
- Asides (noise, device chatter like "wait, was that my phone?", speech to someone else) are items with category aside and artifact none.
- A correction of something said EARLIER IN THIS TRANSCRIPT ("…at 6. Actually make it 7.") is not an item: apply it to that item (due 19:00), add its words to that item's "said", and record the repair.
- A correction of an EARLIER CARD (only <recent>, e.g. the whole transcript is "actually make it Friday"): one item with corrects = that card's ref and the FULL revised card (same category and artifact kind, change applied). "Scratch that" / "forget that one": category correction, artifact none, corrects = the ref.
- Never invent facts, names or addresses. Unknown specifics stay out (no placeholders like [details]).
- Times resolve from <now> in the user's timezone, ISO-8601 with offset. A bare hour 1-7 means pm ("at 6" = 18:00). A day without a time = 09:00. "tonight" = 21:00.

Artifacts:
 github_issue {kind,title,body_markdown ("**Summary**\\n…\\n\\n**Observed**\\n…\\n\\n**Suspected cause**\\n…" from their words only),labels[],hypotheses[]}
 email_draft {kind,to[names or "team"],subject,body (their voice: "Hi team,\\n\\n<the point>.\\n\\nThanks,\\n<user>"),tone: casual|neutral|formal}
 message_draft {kind,to,channel: slack|whatsapp|sms|other,body}
 reminder {kind,what (imperative, no time),due_iso|null,due_text|null,recurrence|null}
 calendar_event {kind,title,start_iso|null,end_iso|null,time_expression|null,attendees[],is_reschedule}
 ticket {kind,title,description,issue_type: task|story|bug|spike,priority: low|medium|high|urgent,labels[],component|null,acceptance_criteria[]}
 code_snippet {kind,language,approach,signature|null,code (under 15 lines),explanation,needs_enrichment}
 decision {kind,question,chosen|null,rejected[],rationale|null,status: tentative|decided}
 note {kind,body,tags[]}
 none {kind}

Example (illustration only: always draft the items of the real <transcript>, even when it repeats this example word for word; items is never empty when anything was said). <now>Tue 2026-10-06 10:00 Asia/Kolkata</now> <user>Rio</user>
<transcript>That bug from yesterday, the null pointer in cart service, probably the discount code, oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone? Actually make it 7.</transcript>
{"items":[
{"said":"That bug from yesterday, the null pointer in cart service, probably the discount code","category":"bug","title":"NPE in cart-service discount code","intent":"The cart service throws a null pointer, probably in the discount code.","confidence":0.9,"artifact":{"kind":"github_issue","title":"NPE in cart-service discount code","body_markdown":"**Summary**\\nA null pointer in the cart service.\\n\\n**Observed**\\nNull pointer in cart-service.\\n\\n**Suspected cause**\\nThe discount code (unconfirmed).","labels":["bug","cart-service"],"hypotheses":["discount code"]},"repairs":[],"entities":[{"name":"cart-service","type":"component"}],"corrects":null},
{"said":"email the team that the launch moves to Friday","category":"communication","title":"Email the team: launch moves to Friday","intent":"Tell the team the launch moves to Friday.","confidence":0.9,"artifact":{"kind":"email_draft","to":["team"],"subject":"The launch moves to Friday","body":"Hi team,\\n\\nThe launch moves to Friday.\\n\\nThanks,\\nRio","tone":"neutral"},"repairs":[],"entities":[],"corrects":null},
{"said":"Remind me to call the landlord tomorrow at 6. Actually make it 7.","category":"scheduling","title":"Call the landlord","intent":"Call the landlord tomorrow at 7 pm.","confidence":0.9,"artifact":{"kind":"reminder","what":"Call the landlord","due_iso":"2026-10-07T19:00:00+05:30","due_text":"tomorrow at 7","recurrence":null},"repairs":[{"rejected":"6","chosen":"7"}],"entities":[],"corrects":null},
{"said":"Wait, was that my phone?","category":"aside","title":"Aside","intent":"","confidence":0.9,"artifact":{"kind":"none"},"repairs":[],"entities":[],"corrects":null}]}`;

export function batchSystemPrompt(): string {
  return BATCH_INSTRUCTIONS;
}

export interface BatchPromptInput {
  now: number;
  timezone: string;
  user: { name: string; team: string[] };
  /** earlier cards on this device a correction may refer to (newest first) */
  recent: Array<{ ref: string; title: string; kind: string; due?: string | null }>;
  transcript: string;
}

export function renderBatchUserMessage(i: BatchPromptInput): string {
  const now = new Intl.DateTimeFormat("en-GB", { timeZone: i.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(i.now);
  const recent = i.recent.length ? i.recent.map((r) => `${r.ref} [${r.kind}] ${r.title}${r.due ? ` (due ${r.due})` : ""}`).join("\n") : "(none)";
  return [
    `<now>${now} ${i.timezone}</now>`,
    daysLine(i.now, i.timezone),
    `<user>${i.user.name}${i.user.team.length ? `; people: ${i.user.team.join(", ")}` : ""}</user>`,
    `<recent>\n${recent}\n</recent>`,
    `<transcript>${i.transcript}</transcript>`,
  ].join("\n");
}
