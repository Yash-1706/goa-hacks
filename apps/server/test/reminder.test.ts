import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactOf } from "@synapse/shared";
import { makeApp, type TestApp } from "./app-helper";

/**
 * V1 phase 3: the offline cortex makes the four V1 outputs well. "Remind me …" becomes a reminder (what + when, never the
 * sentence echoed as a title), "actually make it 7" moves it, and the bug and email drafts read like a person wrote them
 * (no internal ids, no "[add details]").
 */

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const NOW = "2026-10-06T10:00:00+05:30"; // a Tuesday morning in Asia/Kolkata

async function captured(text: string, source: "android" | "web" = "android") {
  const res = await app!.ctx.capture.capture({ text, context: { source } });
  return res.thoughtIds.map((id) => {
    const t = app!.ctx.store.getThought(id)!;
    return { t, a: t.artifactId ? app!.ctx.store.artifacts.get(t.artifactId)! : undefined };
  });
}

describe("reminders (offline cortex)", () => {
  it("'remind me to call the landlord tomorrow at 6' → a reminder for 18:00 tomorrow, titled by what to do", async () => {
    app = await makeApp({}, NOW);
    const [r] = await captured("Remind me to call the landlord tomorrow at 6.");
    expect(r!.a?.kind).toBe("reminder");
    const p = r!.a!.payload as ArtifactOf<"reminder">;
    expect(p.what).toBe("Call the landlord");
    expect(p.due_iso).toBe("2026-10-07T18:00:00+05:30");
    expect(p.due_text).toMatch(/tomorrow at 6/i);
    expect(r!.t.title).toBe("Call the landlord");
  });

  it("'actually make it 7' moves the same reminder to 19:00", async () => {
    app = await makeApp({}, NOW);
    const [r] = await captured("Remind me to call the landlord tomorrow at 6.");
    const [fix] = await captured("Actually make it 7.");
    expect(fix!.t.id).toBe(r!.t.id);
    expect((fix!.a!.payload as ArtifactOf<"reminder">).due_iso).toBe("2026-10-07T19:00:00+05:30");
  });

  it("the whole demo ramble in one capture, then 'actually make it 7' in the next", async () => {
    app = await makeApp({}, NOW);
    const made = await captured(
      "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?",
    );
    expect(made.map((m) => m.a?.kind)).toEqual(["github_issue", "email_draft", "reminder"]);
    const [fix] = await captured("Actually make it 7.");
    expect(fix!.t.id).toBe(made[2]!.t.id);
    expect((fix!.a!.payload as ArtifactOf<"reminder">).due_iso).toBe("2026-10-07T19:00:00+05:30");
  });

  it("a time later today, a recurrence, and no time at all", async () => {
    app = await makeApp({}, NOW);
    const [water] = await captured("Remind me to drink water at 4");
    expect((water!.a!.payload as ArtifactOf<"reminder">).due_iso).toBe("2026-10-06T16:00:00+05:30");
    const [sheet] = await captured("Remind me every Monday to submit the timesheet");
    expect((sheet!.a!.payload as ArtifactOf<"reminder">).recurrence).toBe("every Monday");
    expect((sheet!.a!.payload as ArtifactOf<"reminder">).what).toBe("Submit the timesheet");
    const [passport] = await captured("Remind me to renew the passport");
    expect(passport!.a!.payload).toMatchObject({ kind: "reminder", what: "Renew the passport", due_iso: null });
  });

  it("'remind me to email the team' is still an email", async () => {
    app = await makeApp({}, NOW);
    const [e] = await captured("Remind me to email the team about the delay");
    expect(e!.a?.kind).toBe("email_draft");
  });
});

describe("drafts a person would send (offline cortex)", () => {
  it("the bug issue carries no internal ids and no '(re: …)' tail", async () => {
    app = await makeApp({}, NOW);
    await captured("The checkout page throws a null pointer in the cart service.");
    const [bug] = await captured("That bug from yesterday... the null pointer in cart service, probably the discount code.");
    const p = bug!.a!.payload as ArtifactOf<"github_issue">;
    expect(p.body_markdown).not.toMatch(/\b[TA]-\d+\b/);
    expect(p.body_markdown).not.toMatch(/\(re: /);
    expect(p.body_markdown).toMatch(/\*\*Suspected cause\*\*\nDiscount code/);
  });

  it("the email says the thing, without placeholders, and its title is not the sentence", async () => {
    app = await makeApp({}, NOW);
    const [e] = await captured("Oh, and email the team that the launch moves to Friday.");
    const p = e!.a!.payload as ArtifactOf<"email_draft">;
    expect(p.to).toEqual(["team"]);
    expect(p.subject).toBe("The launch moves to Friday");
    expect(p.body).toBe("Hi team,\n\nThe launch moves to Friday.\n\nThanks,\nRio");
    expect(e!.t.title).toBe("Email the team: the launch moves to Friday");
  });
});
