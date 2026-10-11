// V1 phase 3 check, through the phone app (Pixel 7 emulation, fake mic): the demo ramble becomes a GitHub issue created with one
// tap, an email that asks "Who is the team?" once, and a reminder for tomorrow 18:00 with a calendar link and an .ics alarm;
// the aside is dropped; a second identical ramble asks nothing; "actually make it 7" moves the reminder.
// usage: SYNAPSE_PASSCODE=... node scripts/e2e/phase3.mjs <base-url> <wav-file> <fake-github-peek-url> [screenshot-dir]
import path from "node:path";
import { PIXEL_7, launch, login, report, waitFor } from "./lib.mjs";

const [base, wav, peek, shots = ""] = process.argv.slice(2);
const passcode = process.env.SYNAPSE_PASSCODE;
const TZ = process.env.TZ_PROFILE ?? "Asia/Kolkata";
const out = {};
const shot = async (page, name) => shots && (await page.screenshot({ path: path.join(shots, name), fullPage: true }));
const cookie = await login(base, passcode);
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, origin: new URL(base).origin, ...(init.headers ?? {}) } });

const browser = await launch({ fakeAudio: path.resolve(wav) });
const phone = await browser.newContext({ ...PIXEL_7, viewport: { width: 390, height: 844 }, permissions: ["microphone", "clipboard-read", "clipboard-write"] });
const p = await phone.newPage();
await p.goto(`${base}/capture`, { waitUntil: "domcontentloaded" });
await p.getByPlaceholder("Passcode").fill(passcode);
await p.getByRole("button", { name: "Sign in" }).click();
await p.getByRole("button", { name: "Start recording" }).waitFor({ timeout: 15_000 });

/** record the ramble on the fake mic; returns the new capture's row */
async function recordRamble(seconds = 13.5) {
  const before = new Set(await p.locator(".cap-row[data-client-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-client-id"))));
  await p.getByRole("button", { name: "Start recording" }).tap();
  await p.waitForTimeout(seconds * 1000);
  await p.getByRole("button", { name: "Stop recording" }).tap();
  const id = await waitFor(async () => (await p.locator(".cap-row[data-client-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-client-id")))).find((x) => x && !before.has(x)) ?? null, { what: "new capture row" });
  const row = p.locator(`.cap-row[data-client-id="${id}"]`);
  await row.locator(".ship").nth(2).waitFor({ timeout: 30_000 });
  return row;
}

// ---- first ramble
const row = await recordRamble();
out.kinds = await row.locator(".ship").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
out.asideDropped = out.kinds.length === 3;
await shot(p, "capture-cards-390.png");

// bug → Create issue (filed against the fake GitHub as the sandbox repo)
const bug = row.locator('.ship[data-kind="github_issue"]');
out.issueDestination = await bug.locator(".ship__dest").innerText();
await bug.getByRole("button", { name: "Create issue" }).tap();
await bug.locator(".ship__done").waitFor({ timeout: 15_000 });
out.issueDone = await bug.locator(".ship__done").innerText();
const filed = await (await fetch(peek)).json();
out.issueFiled = filed.issues.map((i) => ({ repo: i.repo, number: i.number, title: i.title, footer: i.body.includes("Captured by voice with Synapse"), internalIds: /\b[TA]-\d+\b/.test(i.body) }));

// email → one question ("the team"), then the links
const email = row.locator('.ship[data-kind="email_draft"]');
out.emailAsks = await email.locator(".ship-ask__q").innerText();
await email.getByRole("button", { name: "Open draft" }).isDisabled().then((d) => (out.emailBlockedBeforeAnswer = d));
await email.locator(".ship-ask input").fill("sarah@acme.io, dev@acme.io");
await shot(p, "capture-ask-390.png");
await email.getByRole("button", { name: "Save" }).tap();
await email.locator(".ship-ask").waitFor({ state: "detached", timeout: 10_000 });
out.emailEnabledAfterAnswer = !(await email.getByRole("button", { name: "Open draft" }).isDisabled());
const thoughts = await (await api("/api/thoughts?limit=50")).json();
const emailView = thoughts.find((t) => t.artifact?.kind === "email_draft" && t.artifact.links?.mailto);
const m = new URL(emailView.artifact.links.mailto);
const g = new URL(emailView.artifact.links.gmail);
out.mailto = { to: decodeURIComponent(m.pathname), subject: m.searchParams.get("subject"), body: m.searchParams.get("body") };
out.gmail = { to: g.searchParams.get("to"), su: g.searchParams.get("su"), bodyMatches: g.searchParams.get("body") === out.mailto.body };

// reminder → tomorrow 18:00 in the profile timezone, calendar link and .ics with an alarm
const rem = thoughts.find((t) => t.artifact?.kind === "reminder");
const tomorrow = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() + 86_400_000);
out.reminder = { what: rem.artifact.payload.what, dueAt: rem.artifact.route.dueAt, expected: `${tomorrow}T18:00:00` };
const cal = new URL(rem.artifact.links.calendar);
const startUtc = new Date(rem.artifact.route.dueAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
out.calendarDates = cal.searchParams.get("dates");
out.calendarOk = out.calendarDates.startsWith(`${startUtc}/`);
const ics = await (await api(rem.artifact.links.ics)).text();
out.icsHasAlarm = /BEGIN:VEVENT[\s\S]*BEGIN:VALARM[\s\S]*END:VALARM[\s\S]*END:VEVENT/.test(ics);
out.reminderShownAs = await row.locator('.ship[data-kind="reminder"] .ship__dest').innerText();

// ---- the same ramble again: nothing to ask
const row2 = await recordRamble();
out.secondRambleAsks = await row2.locator(".ship-ask").count();
await shot(p, "capture-second-ramble-390.png");

// ---- "actually make it 7"
await p.getByLabel("Type a capture").fill("Actually make it 7.");
await p.getByRole("button", { name: "Send" }).tap();
const moved = await waitFor(async () => {
  const ts = await (await api("/api/thoughts?limit=50")).json();
  const r = ts.filter((t) => t.artifact?.kind === "reminder").sort((a, b) => b.createdAt - a.createdAt)[0];
  return r?.artifact.route?.dueAt?.includes("T19:00") ? r.artifact.route.dueAt : null;
}, { what: "the reminder moved to 19:00" }).catch(() => null);
out.makeIt7 = moved;

await browser.close();
report(out);
const pass =
  out.asideDropped &&
  out.issueFiled.length === 1 && out.issueFiled[0].footer && !out.issueFiled[0].internalIds && /^Created #1/.test(out.issueDone) &&
  out.emailBlockedBeforeAnswer && out.emailEnabledAfterAnswer &&
  out.mailto.to === "sarah@acme.io,dev@acme.io" && out.gmail.to === "sarah@acme.io,dev@acme.io" && out.gmail.bodyMatches &&
  out.reminder.dueAt.startsWith(out.reminder.expected) && out.calendarOk && out.icsHasAlarm &&
  out.secondRambleAsks === 0 && Boolean(out.makeIt7);
process.exitCode = pass ? 0 : 1;
