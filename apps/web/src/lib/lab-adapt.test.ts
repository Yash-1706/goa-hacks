import { describe, expect, it } from "vitest";
import { AUTONOMY_NAME } from "./artifacts";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_NEVER,
  DELIVERY_DEFAULT,
  DELIVERY_MAX,
  DELIVERY_MIN,
  adaptSentence,
  autonomyDef,
  autonomyLabel,
  clampLevel,
  describeAdaptation,
  describeAdaptations,
  recurringRule,
} from "./lab-adapt";

describe("delivery thresholds", () => {
  it("places a raised bar on the 0.35..0.95 track and compares it with the 0.50 default", () => {
    const v = describeAdaptation({ key: "kind:reschedule", threshold: 0.7, accepts: 0, dismisses: 2 }, 3);
    expect(v.kind).toBe("delivery");
    expect(v.title).toBe("Reschedule suggestions");
    expect(v.valueText).toBe("0.70");
    expect(v.defText).toBe("0.50");
    expect(v.at).toBeCloseTo((0.7 - DELIVERY_MIN) / (DELIVERY_MAX - DELIVERY_MIN), 10);
    expect(v.defAt).toBeCloseTo((DELIVERY_DEFAULT - DELIVERY_MIN) / (DELIVERY_MAX - DELIVERY_MIN), 10);
    expect(v.stance).toBe("stricter");
    expect(v.accepts).toBe(0);
    expect(v.dismisses).toBe(2);
  });

  it("calls a lowered bar easier and the default untouched", () => {
    expect(describeAdaptation({ key: "kind:echo", threshold: 0.45, accepts: 1, dismisses: 0 }, 3).stance).toBe("easier");
    expect(describeAdaptation({ key: "kind:echo", threshold: 0.5, accepts: 1, dismisses: 1 }, 3).stance).toBe("default");
  });

  it("clamps the track position to the ends", () => {
    expect(describeAdaptation({ key: "kind:snippet", threshold: 2, accepts: 0, dismisses: 9 }, 3).at).toBe(1);
    expect(describeAdaptation({ key: "kind:snippet", threshold: 0, accepts: 9, dismisses: 0 }, 3).at).toBe(0);
  });

  it("titles every known suggestion kind and any unknown one", () => {
    const titles = ["reschedule", "make_task", "draft_ready", "snippet", "open_answer", "echo", "contradiction", "calendar_hold"].map((k) => describeAdaptation({ key: `kind:${k}`, threshold: 0.5, accepts: 0, dismisses: 0 }, 3).title);
    expect(new Set(titles).size).toBe(8);
    expect(titles.every((x) => x.length > 5)).toBe(true);
    expect(describeAdaptation({ key: "kind:some_new_kind", threshold: 0.5, accepts: 0, dismisses: 0 }, 3).title).toBe("Some new kind");
  });
});

describe("recurring-concern count", () => {
  it("is an integer count on a 2..5 track against the configured default", () => {
    const v = describeAdaptation({ key: "recurring_n", threshold: 4, accepts: 0, dismisses: 1 }, 3);
    expect(v.kind).toBe("recurring");
    expect(v.valueText).toBe("4×");
    expect(v.defText).toBe("3×");
    expect(v.at).toBeCloseTo(2 / 3, 10);
    expect(v.defAt).toBeCloseTo(1 / 3, 10);
    expect(v.stance).toBe("stricter");
    expect(describeAdaptation({ key: "recurring_n", threshold: 2, accepts: 2, dismisses: 0 }, 3).stance).toBe("easier");
  });

  it("rounds a stored fraction to a whole number of mentions", () => {
    expect(describeAdaptation({ key: "recurring_n", threshold: 3.6, accepts: 0, dismisses: 0 }, 3).valueText).toBe("4×");
  });
});

describe("ordering and sentences", () => {
  it("lists the recurring concern first, then the delivery bars alphabetically", () => {
    const rows = [
      { key: "kind:snippet", threshold: 0.5, accepts: 0, dismisses: 0 },
      { key: "kind:echo", threshold: 0.5, accepts: 0, dismisses: 0 },
      { key: "recurring_n", threshold: 3, accepts: 0, dismisses: 0 },
    ];
    expect(describeAdaptations(rows, 3).map((v) => v.key)).toEqual(["recurring_n", "kind:echo", "kind:snippet"]);
  });

  it("explains what the feedback did", () => {
    const stricter = describeAdaptation({ key: "kind:reschedule", threshold: 0.7, accepts: 0, dismisses: 2 }, 3);
    expect(adaptSentence(stricter)).toBe("You dismissed 2×. The bar moved from 0.50 to 0.70: Synapse now waits for a stronger signal.");
    const easier = describeAdaptation({ key: "kind:echo", threshold: 0.4, accepts: 2, dismisses: 0 }, 3);
    expect(adaptSentence(easier)).toBe("You accepted 2×. The bar moved from 0.50 to 0.40: Synapse now speaks up sooner.");
    const back = describeAdaptation({ key: "kind:echo", threshold: 0.5, accepts: 1, dismisses: 1 }, 3);
    expect(adaptSentence(back)).toBe("You dismissed 1× and accepted 1×. Back at the default (0.50).");
  });

  it("states the recurring-concern rule in words", () => {
    expect(recurringRule({ n: 3, windowMin: 10, minGapS: 120 })).toEqual({ trigger: "3 mentions in 10 min", gap: "at most one suggestion per 2 min" });
    expect(recurringRule({ n: 3, windowMin: 10, minGapS: 90 }).gap).toBe("at most one suggestion per 1.5 min");
    expect(recurringRule({ n: 2, windowMin: 5, minGapS: 30 }).gap).toBe("at most one suggestion per 30 s");
  });
});

describe("autonomy ladder", () => {
  it("has four levels named like the rest of the app", () => {
    expect(AUTONOMY_LEVELS.map((l) => l.level)).toEqual([0, 1, 2, 3]);
    expect(AUTONOMY_LEVELS.map((l) => l.name)).toEqual([...AUTONOMY_NAME]);
    for (const l of AUTONOMY_LEVELS) {
      expect(l.detail.length).toBeGreaterThan(30);
      expect(l.allows.length).toBeGreaterThan(0);
    }
  });

  it("describes L3 as private, reversible and self-only with the 0.8 confidence bar", () => {
    const l3 = autonomyDef(3).detail;
    expect(l3).toContain("private, reversible, self-only");
    expect(l3).toContain("0.8");
    expect(l3).toContain("sandbox");
    expect(AUTONOMY_NEVER).toContain("sending email or messages");
    expect(AUTONOMY_NEVER).toContain("inviting others");
  });

  it("clamps levels and labels them", () => {
    expect(clampLevel(7)).toBe(3);
    expect(clampLevel(-1)).toBe(0);
    expect(clampLevel(NaN)).toBe(0);
    expect(clampLevel(1.6)).toBe(2);
    expect(autonomyLabel(2)).toBe("L2 · Stage");
    expect(autonomyLabel(9)).toBe("L3 · Execute");
  });
});
