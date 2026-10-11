import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactOf } from "@synapse/shared";
import { makeApp, type TestApp } from "./app-helper";

/** V1 phase 3e: the same decision spoken across fragments (or across a long pause) updates ONE card, never two. */

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe("one decision, one card", () => {
  it("a decision continued after a long pause joins the earlier card and is re-read as a whole", async () => {
    app = await makeApp({}, "2026-10-04T10:00:00+05:30");
    await app.say("Hmm, the auth module needs a decision", { session: "b" });
    await app.say("JWT with a short expiry or OAuth2 with PKCE", { session: "b", gapMs: 2200 });
    await app.settle();
    await app.say("I'm leaning towards JWT because it's simpler", { session: "b", gapMs: 12_000 });
    await app.settle();
    const decisions = app.thoughts().filter((t) => t.category === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.fragments).toHaveLength(3);
    expect(decisions[0]!.artifact?.payload).toMatchObject({ kind: "decision", question: "Which auth approach?", chosen: "JWT", rejected: ["OAuth2"] } satisfies Partial<ArtifactOf<"decision">>);
  });

  it("a different decision in the same session stays its own card", async () => {
    app = await makeApp({}, "2026-10-04T10:00:00+05:30");
    await app.say("JWT with a short expiry or OAuth2 with PKCE for the auth module", { session: "b" });
    await app.settle();
    await app.say("Postgres or Mongo for the analytics store, I'm going with Postgres", { session: "b", gapMs: 12_000 });
    await app.settle();
    expect(app.thoughts().filter((t) => t.category === "decision")).toHaveLength(2);
  });
});
