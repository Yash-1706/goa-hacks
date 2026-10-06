import { describe, expect, it } from "vitest";
import { citedCodes, parseAnswer, pickLocalVoice, sourceDomId } from "./recall";

describe("parseAnswer", () => {
  it("splits text and citations", () => {
    expect(parseAnswer("You chose OAuth2 [T-12] on Monday.")).toEqual([
      { t: "text", v: "You chose OAuth2 " },
      { t: "cite", codes: ["T-12"] },
      { t: "text", v: " on Monday." },
    ]);
  });

  it("supports grouped citations", () => {
    expect(parseAnswer("See [T-3, T-9].")).toEqual([
      { t: "text", v: "See " },
      { t: "cite", codes: ["T-3", "T-9"] },
      { t: "text", v: "." },
    ]);
  });

  it("hides a citation that is still being streamed", () => {
    expect(parseAnswer("as noted [T-1")).toEqual([{ t: "text", v: "as noted " }]);
    expect(parseAnswer("as noted [")).toEqual([{ t: "text", v: "as noted " }]);
    expect(parseAnswer("as noted [T-12]")).toEqual([
      { t: "text", v: "as noted " },
      { t: "cite", codes: ["T-12"] },
    ]);
  });

  it("returns nothing for empty text and leaves non-citation brackets alone", () => {
    expect(parseAnswer("")).toEqual([]);
    expect(parseAnswer("array[0] is fine")).toEqual([{ t: "text", v: "array[0] is fine" }]);
  });
});

describe("citedCodes / sourceDomId", () => {
  it("lists each cited source once, in order", () => {
    expect(citedCodes("[T-2] then [T-1, T-2] then [T-7]")).toEqual(["T-2", "T-1", "T-7"]);
    expect(citedCodes("nothing")).toEqual([]);
    expect(sourceDomId("T-12")).toBe("src-T-12");
  });
});

describe("pickLocalVoice", () => {
  const v = (name: string, lang: string, localService: boolean, def = false) => ({ name, lang, localService, default: def });
  it("never picks a cloud-backed voice", () => {
    expect(pickLocalVoice([v("cloud", "en-US", false, true)])).toBeNull();
    expect(pickLocalVoice([])).toBeNull();
  });
  it("prefers a local voice in the user's language, default first", () => {
    const voices = [v("de", "de-DE", true), v("en-a", "en-GB", true), v("en-b", "en-US", true, true), v("cloud", "en-US", false)];
    expect(pickLocalVoice(voices, "en")?.name).toBe("en-b");
    expect(pickLocalVoice(voices, "de")?.name).toBe("de");
  });
  it("falls back to any local voice", () => {
    expect(pickLocalVoice([v("hi", "hi-IN", true)], "en")?.name).toBe("hi");
  });
});
