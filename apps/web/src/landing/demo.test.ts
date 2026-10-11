import { describe, expect, it } from "vitest";
import { ASIDE, ASIDE_START, DEMO_WORDS, FINAL_FRAME, LOOP_MS, frameAt } from "./demo";

const STEP = 10;
const samples = (): number[] => Array.from({ length: Math.ceil(LOOP_MS / STEP) }, (_, i) => i * STEP);

describe("demo timeline", () => {
  it("the aside is the tail of the ramble", () => {
    expect(DEMO_WORDS.slice(ASIDE_START).join(" ")).toBe(ASIDE);
  });

  it("starts with nothing shown", () => {
    expect(frameAt(0)).toEqual({ words: 0, asideFaded: false, cards: 0, done: false });
  });

  it("grows the word count monotonically up to every word", () => {
    let prev = 0;
    for (const ms of samples()) {
      const { words } = frameAt(ms);
      expect(words).toBeGreaterThanOrEqual(prev);
      expect(words).toBeLessThanOrEqual(DEMO_WORDS.length);
      prev = words;
    }
    expect(prev).toBe(DEMO_WORDS.length);
  });

  it("shows cards only after all words, staggered one at a time up to three", () => {
    let prevCards = 0;
    for (const ms of samples()) {
      const f = frameAt(ms);
      if (f.cards > 0) expect(f.words).toBe(DEMO_WORDS.length);
      expect(f.cards - prevCards).toBeLessThanOrEqual(1);
      expect(f.cards).toBeGreaterThanOrEqual(prevCards);
      prevCards = f.cards;
    }
    expect(prevCards).toBe(3);
  });

  it("fades the aside before or with the first card, and only after typing", () => {
    for (const ms of samples()) {
      const f = frameAt(ms);
      if (f.cards > 0) expect(f.asideFaded).toBe(true);
      if (f.asideFaded) expect(f.words).toBe(DEMO_WORDS.length);
    }
  });

  it("is done (the final state) on the last frame before the loop", () => {
    expect(frameAt(LOOP_MS - 1)).toEqual(FINAL_FRAME);
  });

  it("loops with period LOOP_MS and is deterministic", () => {
    for (const x of [0, 1, 599, 600, 3000, LOOP_MS / 2, LOOP_MS - 1]) {
      expect(frameAt(LOOP_MS + x)).toEqual(frameAt(x));
      expect(frameAt(3 * LOOP_MS + x)).toEqual(frameAt(x));
      expect(frameAt(x)).toEqual(frameAt(x));
    }
  });

  it("treats bad input as the start", () => {
    expect(frameAt(Number.NaN)).toEqual(frameAt(0));
    expect(frameAt(-1)).toEqual(frameAt(LOOP_MS - 1));
  });
});
