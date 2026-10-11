// The 2-minute demo (docs/DEMO_V1.md), played by Playwright with video: an emulated Pixel 7 records the ramble from a
// synthetic voice (ending "actually make it 7"), a desktop browser runs the laptop beats. Gmail and Google Calendar are
// intercepted (their prefilled URLs are checked, nothing is opened or sent). Run against fakes unless keys are set.
// usage: SYNAPSE_PASSCODE=... node scripts/e2e/rehearse.mjs <base-url> <wav> <fake-github-peek-url|-> <video-dir>
import fs from "node:fs";
import path from "node:path";
import { PIXEL_7, cookieFor, launch, login, report, waitFor } from "./lib.mjs";

const [base, wav, peek, videoDir] = process.argv.slice(2);
const passcode = process.env.SYNAPSE_PASSCODE;
const TZ = process.env.TZ_PROFILE ?? "Asia/Kolkata";
fs.mkdirSync(videoDir, { recursive: true });
const tmpVideo = path.join(videoDir, ".rehearsal-tmp");
fs.mkdirSync(tmpVideo, { recursive: true });
const beats = [];
const flaky = [];
const t0 = Date.now();
const beat = (name, ok, detail = {}) => beats.push({ at: `${((Date.now() - t0) / 1000).toFixed(1)}s`, name, ok: Boolean(ok), ...detail });

const cookie = await login(base, passcode);
const origin = new URL(base).origin;
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, origin, "content-type": "application/json", ...(init.headers ?? {}) } });
const profile = await (await api("/api/profile")).json();
await api("/api/profile", { method: "PUT", body: JSON.stringify({ ...profile, onboarded: true }) });

const browser = await launch({ fakeAudio: path.resolve(wav) });
const phoneCtx = await browser.newContext({ ...PIXEL_7, viewport: { width: 390, height: 844 }, permissions: ["microphone"], recordVideo: { dir: tmpVideo, size: { width: 390, height: 844 } } });
const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: tmpVideo, size: { width: 1440, height: 900 } } });
await deskCtx.addCookies([cookieFor(base, cookie)]);
// handoffs: check the prefilled URL, never load Gmail or Calendar
const opened = [];
for (const host of ["https://mail.google.com/**", "https://calendar.google.com/**"]) {
  await deskCtx.route(host, (route) => {
    opened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>handoff</title><p>Intercepted by the rehearsal.</p>" });
  });
}

const phone = await phoneCtx.newPage();
const desk = await deskCtx.newPage();
await desk.goto(`${base}/app`, { waitUntil: "networkidle" });

// 0:00 phone: sign in (already done on a real phone), open the app
await phone.goto(`${base}/capture`, { waitUntil: "domcontentloaded" });
await phone.getByPlaceholder("Passcode").fill(passcode);
await phone.getByRole("button", { name: "Sign in" }).click();
await phone.getByRole("button", { name: "Start recording" }).waitFor({ timeout: 20_000 });

// 0:10 tap, ramble, tap
await phone.getByRole("button", { name: "Start recording" }).tap();
await phone.waitForTimeout(15_500);
const stopAt = Date.now();
await phone.getByRole("button", { name: "Stop recording" }).tap();

// 0:30 the phone shows 3 things, the reminder at 7
const row = phone.locator(".cap-row[data-client-id]").first();
await row.locator(".ship").nth(2).waitFor({ timeout: 30_000 });
const made = await row.locator(".cap-row__made").innerText();
const reminderWhen = await waitFor(async () => {
  const t = await row.locator('.ship[data-kind="reminder"] .ship__dest').innerText();
  return /7:00\s?pm/i.test(t) ? t : null;
}, { what: "the reminder at 7", timeoutMs: 15_000 }).catch(() => null);
beat("phone: 3 cards, aside dropped, reminder at 7", /Made 3 things/.test(made) && reminderWhen, { made, reminderWhen, secondsFromStop: Math.round((Date.now() - stopAt) / 100) / 10 });

// 0:40 the laptop already has them
const deskCards = await waitFor(async () => ((await desk.locator(".inbox .ship").count()) >= 3 ? desk.locator(".inbox .ship").count() : null), { what: "laptop cards" }).catch(() => 0);
await desk.waitForTimeout(4500);
const summary = await desk.locator(".inbox-line").innerText().catch(() => "");
beat("laptop: the same cards, session summary", deskCards >= 3, { cards: deskCards, summary });

// 0:50 Create issue
const issueCard = desk.locator('.inbox .ship[data-kind="github_issue"]').first();
await issueCard.getByRole("button", { name: "Create issue" }).click();
const created = await issueCard.locator(".ship__done").innerText({ timeout: 15_000 }).catch(() => "");
let filed = null;
if (peek && peek !== "-") filed = (await (await fetch(peek)).json()).issues.at(-1) ?? null;
beat("Create issue → Created #n", /Created #\d+/.test(created), { created, repo: filed?.repo, title: filed?.title });

// 1:10 Open draft (answer "the team" first if asked)
const emailCard = desk.locator('.inbox .ship[data-kind="email_draft"]').first();
if (await emailCard.locator(".ship-ask").count()) {
  await emailCard.locator(".ship-ask input").fill("sarah@acme.io, dev@acme.io");
  await emailCard.getByRole("button", { name: "Save" }).click();
  await emailCard.locator(".ship-ask").waitFor({ state: "detached", timeout: 10_000 });
  beat("email asked once: who is the team", true);
}
const [gmail] = await Promise.all([deskCtx.waitForEvent("page", { timeout: 10_000 }), emailCard.getByRole("button", { name: "Open draft" }).click()]);
await gmail.waitForLoadState().catch(() => undefined);
const g = new URL(gmail.url());
beat("Open draft → Gmail prefilled", g.host === "mail.google.com" && g.searchParams.get("to") === "sarah@acme.io,dev@acme.io", { to: g.searchParams.get("to"), subject: g.searchParams.get("su") });
await gmail.close();
// V1.1: an opened draft waits as "Opened in Gmail" until one tap on Done (Synapse cannot see whether it was sent)
await emailCard.locator(".ship__done", { hasText: "Opened" }).waitFor({ timeout: 10_000 });
await emailCard.getByRole("button", { name: "Done", exact: true }).click();
beat("Opened in Gmail → tap Done", true);

// 1:25 Add to calendar
const remCard = desk.locator('.inbox .ship[data-kind="reminder"]').first();
const [cal] = await Promise.all([deskCtx.waitForEvent("page", { timeout: 10_000 }), remCard.getByRole("button", { name: "Add to calendar" }).click()]);
await cal.waitForLoadState().catch(() => undefined);
const c = new URL(cal.url());
const tomorrow = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() + 86_400_000);
const expectedStart = new Date(`${tomorrow}T19:00:00+05:30`).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
beat("Add to calendar → tomorrow 19:00", c.host === "calendar.google.com" && (c.searchParams.get("dates") ?? "").startsWith(expectedStart), { text: c.searchParams.get("text"), dates: c.searchParams.get("dates") });
await cal.close();
await remCard.locator(".ship__done", { hasText: "Opened" }).waitFor({ timeout: 10_000 });
await remCard.getByRole("button", { name: "Done", exact: true }).click();
await desk.waitForTimeout(1200);
const done = await desk.locator(".inbox-sec", { hasText: "Done" }).locator(".ship").count().catch(() => 0);
beat("shipped cards move to Done", done >= 3, { done });

// 1:40 Ask
await desk.getByRole("link", { name: "Ask" }).click();
await desk.getByPlaceholder(/What was that idea/).fill("what was that cart bug?");
await desk.keyboard.press("Enter");
await desk.locator(".rc-answer:not(.rc-answer--wait)").waitFor({ timeout: 30_000 });
await desk.waitForTimeout(1500);
const answer = await desk.locator(".rc-answer").first().innerText();
beat("Ask → cited answer", /cart/i.test(answer) && (await desk.locator(".rc-cite").count()) > 0, { answer: answer.replace(/\s+/g, " ").slice(0, 160) });
await desk.waitForTimeout(1500);

// videos: close the contexts, keep the two files under stable names
const deskVideo = desk.video();
const phoneVideo = phone.video();
await phoneCtx.close();
await deskCtx.close();
await browser.close();
const out = { desk: path.join(videoDir, "demo-rehearsal.webm"), phone: path.join(videoDir, "demo-rehearsal-phone.webm") };
fs.renameSync(await deskVideo.path(), out.desk);
fs.renameSync(await phoneVideo.path(), out.phone);
fs.rmSync(tmpVideo, { recursive: true, force: true });
for (const b of beats) if (!b.ok) flaky.push(b.name);
report({ seconds: Math.round((Date.now() - t0) / 1000), beats, failed: flaky, videos: out });
process.exitCode = flaky.length ? 1 : 0;
