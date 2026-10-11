/**
 * The landing page's demo timeline: a pure function of elapsed time, so the animation is deterministic and testable.
 * Phases: a short lead-in, the ramble typing out word by word, the aside striking out, three cards appearing
 * one after another, then a hold on the finished state before the loop restarts.
 */

export const RAMBLE =
  "That bug from yesterday… the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?";

export const ASIDE = "Wait, was that my phone?";

export const DEMO_WORDS: string[] = RAMBLE.split(" ");

/** Index of the first word of the aside: words from here on are struck out once `asideFaded` is true. */
export const ASIDE_START: number = DEMO_WORDS.length - ASIDE.split(" ").length;

export const CARD_COUNT = 3;

const LEAD_IN_MS = 600;
const WORD_MS = 170;
const TYPE_END_MS = LEAD_IN_MS + DEMO_WORDS.length * WORD_MS;
const ASIDE_FADE_MS = TYPE_END_MS + 500;
const FIRST_CARD_MS = ASIDE_FADE_MS + 400;
const CARD_STAGGER_MS = 450;
const DONE_MS = FIRST_CARD_MS + (CARD_COUNT - 1) * CARD_STAGGER_MS + 400;
const HOLD_MS = 4000;

/** One full cycle; `frameAt` repeats with this period. */
export const LOOP_MS = DONE_MS + HOLD_MS;

export interface DemoFrame {
  /** How many of DEMO_WORDS are visible. */
  words: number;
  /** The aside is struck out. */
  asideFaded: boolean;
  /** How many of the three cards are visible (0..3). */
  cards: number;
  /** Everything is shown and settled: the hold before the loop restarts. */
  done: boolean;
}

/** The final, fully revealed state (also what reduced-motion users see). */
export const FINAL_FRAME: DemoFrame = { words: DEMO_WORDS.length, asideFaded: true, cards: CARD_COUNT, done: true };

export function frameAt(ms: number): DemoFrame {
  const safe = Number.isFinite(ms) ? Math.floor(ms) : 0;
  const t = ((safe % LOOP_MS) + LOOP_MS) % LOOP_MS;

  const words = Math.min(DEMO_WORDS.length, Math.max(0, Math.floor((t - LEAD_IN_MS) / WORD_MS)));
  const cards = t < FIRST_CARD_MS ? 0 : Math.min(CARD_COUNT, Math.floor((t - FIRST_CARD_MS) / CARD_STAGGER_MS) + 1);

  return { words, asideFaded: t >= ASIDE_FADE_MS, cards, done: t >= DONE_MS };
}
