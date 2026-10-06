import { describe, expect, it } from "vitest";
import type { ArtifactStatus } from "@synapse/shared";
import { GROUPS, byRecency, countGroups, groupDef, groupItems, groupOf, headline, shownGroups, waitingCount } from "./outbox-groups";

const it_ = (id: string, status: ArtifactStatus, updatedAt: number) => ({ id, status, updatedAt });

describe("groupOf", () => {
  it("maps the six statuses onto five groups", () => {
    expect(groupOf("draft")).toBe("draft");
    expect(groupOf("staged")).toBe("staged");
    expect(groupOf("accepted")).toBe("accepted");
    expect(groupOf("executed")).toBe("executed");
    expect(groupOf("dismissed")).toBe("dismissed");
    expect(groupOf("undone")).toBe("dismissed");
  });

  it("covers every artifact status exactly once", () => {
    const all = GROUPS.flatMap((g) => g.statuses);
    expect([...all].sort()).toEqual(["accepted", "dismissed", "draft", "executed", "staged", "undone"]);
  });

  it("keeps the ladder order and folds only the quiet group", () => {
    expect(GROUPS.map((g) => g.id)).toEqual(["draft", "staged", "accepted", "executed", "dismissed"]);
    expect(GROUPS.filter((g) => g.quiet).map((g) => g.id)).toEqual(["dismissed"]);
    expect(groupDef("executed").label).toBe("Done");
  });

  it("has intentional empty-state copy for every group", () => {
    for (const g of GROUPS) {
      expect(g.emptyTitle.length).toBeGreaterThan(5);
      expect(g.emptyBody.length).toBeGreaterThan(20);
      expect(g.hint.length).toBeGreaterThan(10);
    }
  });
});

describe("groupItems", () => {
  const items = [it_("a", "draft", 10), it_("b", "draft", 30), it_("c", "executed", 20), it_("d", "undone", 5), it_("e", "dismissed", 50), it_("f", "staged", 1)];

  it("buckets by group and sorts each newest first", () => {
    const g = groupItems(items);
    expect(g.draft.map((x) => x.id)).toEqual(["b", "a"]);
    expect(g.staged.map((x) => x.id)).toEqual(["f"]);
    expect(g.accepted).toEqual([]);
    expect(g.executed.map((x) => x.id)).toEqual(["c"]);
    expect(g.dismissed.map((x) => x.id)).toEqual(["e", "d"]); // dismissed and undone share a group
  });

  it("breaks ties by id so the order is stable", () => {
    const tie = [it_("z", "draft", 5), it_("m", "draft", 5), it_("a", "draft", 5)];
    expect(groupItems(tie).draft.map((x) => x.id)).toEqual(["a", "m", "z"]);
    expect(byRecency(it_("a", "draft", 5), it_("a", "draft", 5))).toBe(0);
  });

  it("does not mutate the input", () => {
    const copy = items.map((x) => ({ ...x }));
    groupItems(items);
    expect(items).toEqual(copy);
  });
});

describe("counts and filters", () => {
  const items = [it_("a", "draft", 1), it_("b", "draft", 2), it_("c", "staged", 3), it_("d", "executed", 4), it_("e", "undone", 5)];

  it("counts per group and in total", () => {
    expect(countGroups(items)).toEqual({ all: 5, draft: 2, staged: 1, accepted: 0, executed: 1, dismissed: 1 });
    expect(countGroups([])).toEqual({ all: 0, draft: 0, staged: 0, accepted: 0, executed: 0, dismissed: 0 });
  });

  it("shows every group for All and one group for a status", () => {
    expect(shownGroups("all").map((g) => g.id)).toEqual(["draft", "staged", "accepted", "executed", "dismissed"]);
    expect(shownGroups("staged").map((g) => g.id)).toEqual(["staged"]);
  });

  it("counts what still waits for a decision", () => {
    expect(waitingCount(countGroups(items))).toBe(3);
  });
});

describe("headline", () => {
  it("is intentional when nothing exists yet", () => {
    expect(headline(countGroups([]))).toEqual({ title: "Nothing drafted yet", sub: "Synapse drafts the moment it hears something actionable." });
  });

  it("says how much waits for the user", () => {
    const h = headline(countGroups([it_("a", "draft", 1), it_("b", "staged", 2), it_("c", "staged", 3)]));
    expect(h.title).toBe("3 waiting for your call");
    expect(h.sub).toBe("1 draft and 2 staged. Nothing is sent to anyone until you say so.");
    expect(headline(countGroups([it_("a", "draft", 1)])).sub).toBe("1 draft. Nothing is sent to anyone until you say so.");
  });

  it("celebrates an empty queue", () => {
    const h = headline(countGroups([it_("a", "executed", 1), it_("b", "accepted", 2), it_("c", "dismissed", 3), it_("d", "undone", 4)]));
    expect(h.title).toBe("All caught up");
    expect(h.sub).toBe("1 done, 1 kept, 2 dismissed.");
  });
});
