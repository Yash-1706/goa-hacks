// V1 phase 2 check: the phone app on an emulated Pixel 7 with a fake microphone playing a WAV.
// Sign in → record → stop → cards on the phone AND in a desktop tab; offline recording waits, then uploads exactly once;
// manifest + service worker. usage: SYNAPSE_PASSCODE=... node scripts/e2e/phase2.mjs <base-url> <wav-file> [screenshot-dir]
import fs from "node:fs";
import path from "node:path";
import { PIXEL_7, cookieFor, launch, login, report, waitFor } from "./lib.mjs";

const [base, wav, shots = ""] = process.argv.slice(2);
const passcode = process.env.SYNAPSE_PASSCODE;
if (!base || !wav || !passcode) {
  console.error("usage: SYNAPSE_PASSCODE=... node scripts/e2e/phase2.mjs <base-url> <wav-file> [screenshot-dir]");
  process.exit(2);
}
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, name), fullPage: false });
};
const out = {};
const browser = await launch({ fakeAudio: path.resolve(wav) });

// ---- the phone
const phone = await browser.newContext({ ...PIXEL_7, viewport: { width: 390, height: 844 }, permissions: ["microphone"] });
const p = await phone.newPage();
await p.goto(`${base}/capture`, { waitUntil: "domcontentloaded" });
await p.getByRole("dialog", { name: "Sign in to Synapse" }).waitFor({ timeout: 15_000 });
await shot(p, "capture-login-390.png");
await p.getByPlaceholder("Passcode").fill(passcode);
await p.getByRole("button", { name: "Sign in" }).click();
const recordBtn = p.getByRole("button", { name: "Start recording" });
await recordBtn.waitFor({ timeout: 15_000 });
out.signedIn = true;
await shot(p, "capture-idle-390.png");

// the service worker registers on the production build
out.serviceWorker = await p.evaluate(async () => {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 10_000))]);
  return reg ? Boolean(reg.active) : false;
});

// record the ramble (the fake mic loops the WAV; ~13 s of speech)
await recordBtn.tap();
await p.getByRole("button", { name: "Stop recording" }).waitFor();
await p.waitForTimeout(3000);
await shot(p, "capture-recording-390.png");
await p.waitForTimeout(10_500);
const tStop = Date.now();
const before = new Set(await p.locator(".cap-row[data-client-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-client-id"))));
await p.getByRole("button", { name: "Stop recording" }).tap();
// follow THIS clip's row (older rows from earlier captures also say "Made …")
const firstId = await waitFor(async () => {
  const ids = await p.locator(".cap-row[data-client-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-client-id")));
  return ids.find((id) => id && !before.has(id)) ?? null;
}, { what: "the new clip's row" });
const row = p.locator(`.cap-row[data-client-id="${firstId}"]`);
await row.locator(".cap-row__made").waitFor({ timeout: 30_000 });
out.secondsFromStopToCards = Math.round((Date.now() - tStop) / 100) / 10;
out.phoneLine = await row.locator(".cap-row__made").innerText();
await shot(p, "capture-made-390.png");

// ---- the laptop shows the same cards
const cookie = await login(base, passcode);
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await desk.addCookies([cookieFor(base, cookie)]);
const d = await desk.newPage();
await d.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
const titles = await row.locator(".ship__title").allInnerTexts();
out.deskSeesCards = await waitFor(async () => {
  const text = await d.locator("body").innerText();
  return titles.slice(0, 3).every((t) => text.includes(t)) || null;
}, { what: "the phone's cards on the laptop" }).catch(() => false);

// ---- offline: the clip waits on the phone, then uploads exactly once
await phone.setOffline(true);
await p.getByRole("button", { name: "Start recording" }).tap();
await p.waitForTimeout(3000);
await p.getByRole("button", { name: "Stop recording" }).tap();
const waiting = p.locator('.cap-row[data-status="waiting"]').first();
await waiting.waitFor({ timeout: 15_000 });
const clientId = await waiting.getAttribute("data-client-id");
out.offlineShowsWaiting = (await waiting.innerText()).includes("Waiting for network");
await shot(p, "capture-offline-390.png");
const capturesFor = async () => (await (await fetch(`${base}/api/captures?limit=100`, { headers: { cookie } })).json()).filter((c) => c.clientId === clientId).length;
out.serverCapturesWhileOffline = await capturesFor();
await phone.setOffline(false);
await p.locator(`.cap-row[data-client-id="${clientId}"][data-status="sent"]`).waitFor({ timeout: 30_000 });
await p.waitForTimeout(1500);
out.serverCapturesAfterOnline = await capturesFor();

// ---- manifest
const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
out.manifest = {
  start_url: manifest.start_url,
  shortcut: manifest.shortcuts?.[0]?.url,
  share_target: manifest.share_target ? { action: manifest.share_target.action, method: manifest.share_target.method, files: manifest.share_target.params?.files?.[0]?.name } : null,
  display: manifest.display,
  icons: manifest.icons?.length,
};

await browser.close();
report(out);
const pass =
  out.signedIn &&
  out.serviceWorker &&
  out.deskSeesCards &&
  out.offlineShowsWaiting &&
  out.serverCapturesWhileOffline === 0 &&
  out.serverCapturesAfterOnline === 1 &&
  out.manifest.start_url === "/capture" &&
  out.manifest.shortcut === "/capture?autostart=1" &&
  out.manifest.share_target?.action === "/capture/share";
process.exitCode = pass ? 0 : 1;
if (shots) fs.writeFileSync(path.join(shots, "phase2-result.json"), JSON.stringify(out, null, 2));
