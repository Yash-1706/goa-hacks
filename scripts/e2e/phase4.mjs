// V1 phase 4 check: screenshots of Inbox (empty and with cards), Ask, every Settings tab, every first-run step and /capture
// at 1440×900 and 390×844, plus the rule that no default screen shows internal ids (T-12, A-3), millisecond timings or
// autonomy labels. usage: SYNAPSE_PASSCODE=... node scripts/e2e/phase4.mjs <base-url> <screenshot-dir>
import fs from "node:fs";
import path from "node:path";
import { cookieFor, launch, login, report, waitFor } from "./lib.mjs";

const [base, dir] = process.argv.slice(2);
const passcode = process.env.SYNAPSE_PASSCODE;
fs.mkdirSync(dir, { recursive: true });
const cookie = await login(base, passcode);
const origin = new URL(base).origin;
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, origin, "content-type": "application/json", ...(init.headers ?? {}) } });
const setOnboarded = async (on) => {
  const p = await (await api("/api/profile")).json();
  await api("/api/profile", { method: "PUT", body: JSON.stringify({ ...p, onboarded: on }) });
};

const FORBIDDEN = [
  ["internal id", /\b[TA]-\d+\b/],
  ["millisecond timing", /\b\d+(?:\.\d+)?\s?ms\b/],
  ["autonomy label", /\b(?:Staged|Draft|Execute|Observe|Stage) L[0-3]\b|\bL[0-3]\b/],
  ["mock chip", /\bmock\b/i],
];
const violations = [];
const shots = [];

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([cookieFor(base, cookie)]);
const page = await ctx.newPage();
page.on("pageerror", (e) => violations.push({ screen: "page error", what: e.message.slice(0, 120) }));

async function both(name, { check = false, full = true } = {}) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
    const file = `${name}-${w}.png`;
    await page.screenshot({ path: path.join(dir, file), fullPage: full });
    shots.push(file);
    // horizontal overflow is a layout bug at any width
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) violations.push({ screen: `${name}@${w}`, what: `horizontal overflow ${overflow}px` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  if (check) {
    const text = await page.locator("body").innerText();
    for (const [what, re] of FORBIDDEN) {
      const m = text.match(re);
      if (m) violations.push({ screen: name, what, sample: m[0] });
    }
  }
}

// ---- Inbox, empty
await setOnboarded(true);
await page.goto(`${base}/app`, { waitUntil: "networkidle" });
await page.getByText("Ramble. Synapse turns it into things you can ship.").waitFor();
await both("inbox-empty", { check: true });

// ---- first-run, every step
await setOnboarded(false);
await page.reload({ waitUntil: "networkidle" });
const dialog = page.getByRole("dialog");
await dialog.waitFor();
for (let i = 1; i <= 5; i++) {
  if (i === 5) {
    await dialog.getByRole("button", { name: "Send" }).click();
    await dialog.locator(".ship").waitFor({ timeout: 20_000 });
  }
  await both(`firstrun-${i}`, { full: false });
  await dialog.getByRole("button", { name: i === 1 ? "Get started" : i === 5 ? "Done" : "Next" }).click();
}
await dialog.waitFor({ state: "detached" });

// ---- Inbox with cards: the demo ramble through the capture box
await page.getByLabel("Type, or hold your Wispr Flow key and talk").fill(
  "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?",
);
await page.keyboard.press("Enter");
await page.getByRole("heading", { name: /Needs you/ }).waitFor({ timeout: 20_000 });
await waitFor(async () => (await page.locator(".inbox .ship").count()) >= 4 || null, { what: "cards in the Inbox" });
await page.waitForTimeout(5000); // the session summary appears once the capture has gone quiet
const summary = await page.locator(".inbox-line").innerText().catch(() => null);
await both("inbox-cards", { check: true });
// Why? on a card
await page.locator(".inbox .ship").first().getByRole("button", { name: "More" }).click();
await page.getByRole("menuitem", { name: "Why?" }).click();
await page.locator(".ship-why").first().waitFor();
await both("inbox-why", { full: false });
const whyText = await page.locator(".ship-why").first().innerText();
if (/local heuristic/i.test(whyText)) violations.push({ screen: "why", what: "classifier phrasing" });

// ---- Ask
await page.goto(`${base}/app/ask`, { waitUntil: "networkidle" });
await page.getByPlaceholder(/What was that idea/).fill("what was that cart bug?");
await page.keyboard.press("Enter");
await page.locator(".rc-answer:not(.rc-answer--wait)").waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
await both("ask", { check: true });
const askText = await page.locator(".rc-answer").first().innerText();

// ---- Settings, every tab (the default one is checked)
for (const tab of ["profile", "voice", "model", "privacy", "memory", "outbox", "developer"]) {
  await page.goto(`${base}/app/settings/${tab}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await both(`settings-${tab}`, { check: tab === "profile", full: tab !== "memory" });
}

// ---- the phone app
await page.goto(`${base}/capture`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await both("capture", { check: true });

await browser.close();
report({ screenshots: shots.length, summary, askAnswer: askText.slice(0, 200), violations });
fs.writeFileSync(path.join(dir, "phase4-result.json"), JSON.stringify({ screenshots: shots, summary, violations }, null, 2));
process.exitCode = violations.length ? 1 : 0;
