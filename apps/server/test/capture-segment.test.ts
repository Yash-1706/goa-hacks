import { describe, expect, it } from "vitest";
import { segmentIntents } from "../src/capture/segment";

/**
 * A transcript of one capture is one block of text; the engine turns one thread into one card. The segmenter cuts the block where
 * a new intent starts, so "one breath with a bug, an email and a reminder" becomes three threads (and an aside a fourth, which the
 * engine then drops). Continuations stay together; a correction is always its own segment, because the engine applies a
 * correction thread to the card before it.
 */

const pairs = (text: string) => segmentIntents(text).map((s) => [s.text, s.startsThought] as const);

describe("segmentIntents", () => {
  it("splits the demo ramble into bug, email, reminder and aside", () => {
    expect(
      pairs(
        "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?",
      ),
    ).toEqual([
      ["That bug from yesterday... the null pointer in cart service, probably the discount code.", true],
      ["Oh, and email the team that the launch moves to Friday.", true],
      ["Remind me to call the landlord tomorrow at 6.", true],
      ["Wait, was that my phone?", true],
    ]);
  });

  it("keeps a thought that spans sentences together", () => {
    expect(pairs("The checkout page fails. It throws on empty carts. Probably the new validation.")).toEqual([
      ["The checkout page fails.", true],
      ["It throws on empty carts.", false],
      ["Probably the new validation.", false],
    ]);
  });

  it("an action verb aimed at a pronoun continues the thought it refers to", () => {
    expect(pairs("Email Sarah about the launch. Tell her it moves to Friday.")).toEqual([
      ["Email Sarah about the launch.", true],
      ["Tell her it moves to Friday.", false],
    ]);
  });

  it("splits two intents joined by 'and' inside one sentence, but not a plain list", () => {
    expect(pairs("Remind me to buy milk and email Dev the quarterly report")).toEqual([
      ["Remind me to buy milk", true],
      ["email Dev the quarterly report", true],
    ]);
    expect(pairs("Remind me to call mom and dad on Sunday")).toEqual([["Remind me to call mom and dad on Sunday", true]]);
    expect(pairs("Remind me to email Sarah and tell her the date")).toEqual([["Remind me to email Sarah and tell her the date", true]]);
  });

  it("a correction is always its own segment", () => {
    expect(pairs("Remind me to call the landlord tomorrow at 6. Actually make it 7.")).toEqual([
      ["Remind me to call the landlord tomorrow at 6.", true],
      ["Actually make it 7.", true],
    ]);
    expect(pairs("Book the room for Thursday. Scratch that.")).toEqual([
      ["Book the room for Thursday.", true],
      ["Scratch that.", true],
    ]);
  });

  it("a topic shift lead starts a new thought", () => {
    expect(pairs("The deploy script is flaky. Also, we should rename the billing service.").map((p) => p[1])).toEqual([true, true]);
    expect(pairs("The deploy script is flaky. By the way the demo is at 3.").map((p) => p[1])).toEqual([true, true]);
  });

  it("nothing to segment", () => {
    expect(segmentIntents("   ")).toEqual([]);
    expect(pairs("just one idea without punctuation")).toEqual([["just one idea without punctuation", true]]);
  });
});

describe("segmentIntents: comma-joined intents (V1.1: what real Sarvam writes)", () => {
  const BUG = "That bug from yesterday, the null pointer in cart service, probably the discount code";
  it.each([", oh, and email", ", and also email", ", oh and email", ", plus email", ", also email"])("%s … starts its own thought, and the lead-in stays out of the bug", (join) => {
    const segs = segmentIntents(`${BUG}${join} the team that the launch moves to Friday.`);
    expect(segs.map((s) => s.startsThought)).toEqual([true, true]);
    expect(segs[0]!.text).toBe(BUG);
    expect(segs[1]!.text).toBe("email the team that the launch moves to Friday.");
  });
  it("a plain list joined by 'plus' or 'also' is not split", () => {
    expect(segmentIntents("Buy milk, eggs, plus some bread").length).toBe(1);
    expect(segmentIntents("The checkout is slow, also on mobile").length).toBe(1);
  });
});
