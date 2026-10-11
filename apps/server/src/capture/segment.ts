/* ============================================================================
 * Intent segmentation for one capture (V1 principle 2: one ramble can become many items).
 *
 * The engine turns one thread into one card, and its stitcher (rightly) treats short pauses as thinking. A captured transcript
 * arrives as one block, so it is cut here where a new intent starts; each segment then enters the engine as its own fragment,
 * and a segment that `startsThought` closes the thread before it. Continuations ("It throws on empty carts.") stay with their
 * thought; a correction ("Actually make it 7.") is always its own segment, because the engine applies a correction thread to
 * the card before it. Deterministic and local: no model call, nothing leaves the machine.
 * ========================================================================== */

export interface Segment {
  text: string;
  /** true: this segment begins a new thought (the thread before it is closed first) */
  startsThought: boolean;
}

/** imperative leads that start an intent of their own ("remind me", "email Dev", "file a bug") */
const ACTION =
  /^(remind me|set (a|an) (reminder|alarm|timer)|note to self|e-?mail|mail|message|text|ping|tell|ask|schedule|book|set up|file|log|open (a|an)|create (a|an)|add (a|an)|make (a|an) (ticket|issue|note|task)|draft|write (a|an) (email|note|message))\b/i;
/** the action's object is a pronoun: it refers to the thought before ("Tell her it moves to Friday") */
const PRONOUN_OBJECT = /^\S+(\s+(a|an))?\s+(her|him|them|it|this|that|those|these|everyone|everybody)\b/i;
const SHIFT_LEAD = /^(oh,?\s+(and|also)\b|and also\b|also\b|another thing\b|one more thing\b|separately\b|by the way\b|btw\b|oh,?\s+(by the way|btw)\b)/i;
const LEAD_IN = /^(oh,?\s*)?(and\s+)?(also,?\s+)?(then\s+)?/i;
/** a correction of the previous card (mirrors text.ts REPAIR_START plus the "make it 7" form) */
const CORRECTION = /^(actually|or no|no wait|no,? wait|wait no|i mean|scratch that|rather|no no|undo that|never ?mind|forget that|make it|change (it|that) to)\b/i;
/** an interjection that interrupts the flow ("Wait, was that my phone?"): isolated so it cannot pollute the thought before */
const INTERJECTION = /^(wait|hold on|hang on|hmm+|uh+|um+|oh no|hey|ugh)\b/i;

/** Sentence ends: . ! ? followed by space or the end. An ellipsis is a pause inside a thought, not an end. */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    let j = i;
    while (j + 1 < text.length && ".!?".includes(text[j + 1] as string)) j++;
    const isEllipsis = text.slice(i, j + 1).startsWith("..");
    const atBoundary = j + 1 >= text.length || /\s/.test(text[j + 1] as string);
    if (!isEllipsis && atBoundary) {
      out.push(text.slice(start, j + 1).trim());
      start = j + 1;
    }
    i = j;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

const startsAction = (s: string): boolean => {
  const core = s.replace(LEAD_IN, "");
  return ACTION.test(core) && !PRONOUN_OBJECT.test(core);
};

/**
 * Split a sentence before a joiner + <action> when the action is aimed at something new: " and email…", and the comma-joined
 * forms speech-to-text writes when there is no full stop (", oh, and email…", ", and also…", ", oh and…", ", plus…", ", also…").
 * "plus"/"also" only count after a comma, and only before an action ("eggs, plus some bread" is a list).
 */
function clauses(sentence: string): string[] {
  const out: string[] = [];
  let rest = sentence;
  for (;;) {
    const re = /,\s*(?:(?:oh|um+|uh+|so),?\s+)?(?:and\s+also|and|also|plus)\s+(?=\S)|\s+and\s+(?:also\s+)?(?=\S)/gi;
    let cut = -1;
    let next = 0;
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      const after = rest.slice(m.index + m[0].length);
      const before = rest.slice(0, m.index).trim().split(/\s+/).length; // "Oh, and email ..." is a lead-in, not two clauses
      if (before >= 2 && startsAction(after)) {
        cut = m.index;
        next = m.index + m[0].length;
        break;
      }
    }
    if (cut < 0) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(next);
  }
  out.push(rest.trim());
  return out.filter(Boolean);
}

export function segmentIntents(text: string): Segment[] {
  const parts = sentences(text.replace(/\s+/g, " ").trim()).flatMap(clauses);
  return parts.map((part, i) => ({
    text: part,
    startsThought: i === 0 || CORRECTION.test(part) || SHIFT_LEAD.test(part) || startsAction(part) || INTERJECTION.test(part),
  }));
}
