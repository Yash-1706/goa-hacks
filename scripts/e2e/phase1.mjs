// V1 phase 1 check: audio upload over the (tunnel or local) URL, cards appear live in a second tab, no cookie → 401.
// usage: node scripts/e2e/phase1.mjs <base-url> <wav-file>    (SYNAPSE_PASSCODE in the environment)
import fs from "node:fs";
import { cookieFor, launch, login, report, waitFor } from "./lib.mjs";

const [base, wavPath] = process.argv.slice(2);
const passcode = process.env.SYNAPSE_PASSCODE;
if (!base || !wavPath || !passcode) {
  console.error("usage: SYNAPSE_PASSCODE=... node scripts/e2e/phase1.mjs <base-url> <wav-file>");
  process.exit(2);
}
const origin = new URL(base).origin;
const cookie = await login(base, passcode);

// a desktop tab, signed in, watching the Desk
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([cookieFor(base, cookie)]);
const page = await ctx.newPage();
await page.goto(base + "/app", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500); // let the WebSocket connect

const clientId = `e2e-${Date.now().toString(36)}`;
const upload = () => {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(wavPath)], { type: "audio/wav" }), "ramble.wav");
  form.append("context", JSON.stringify({ source: "cli" }));
  form.append("clientId", clientId);
  return fetch(`${base}/api/capture`, { method: "POST", headers: { origin, cookie }, body: form });
};

// the "no cookie" probe reads, never writes: an upload without a session would be ACCEPTED on localhost (trusted), and
// that second capture is what looked like a double upload in the first live check
const denied = await fetch(`${base}/api/state`, { headers: { origin } });
const t0 = Date.now();
const res = await upload();
const body = await res.json();
const ms = Date.now() - t0;
const thoughts = await Promise.all(body.thoughtIds.map((id) => fetch(`${base}/api/thoughts/${id}`, { headers: { cookie, origin } }).then((r) => r.json())));
const cards = thoughts.map((t) => ({ category: t.category, artifact: t.artifact?.kind ?? null, source: t.source, title: t.title }));

// every card is visible in the other tab without a reload
const seen = await waitFor(
  async () => {
    const text = await page.locator("body").innerText();
    return thoughts.every((t) => text.includes(t.title)) ? true : null;
  },
  { what: "cards in the desktop tab", timeoutMs: 15_000 },
).catch(() => false);

await page.screenshot({ path: process.env.SHOT ?? "/dev/null" }).catch(() => undefined);
await browser.close();
report({ base, noCookieStatus: denied.status, status: res.status, ms, transcript: body.transcript, pending: body.pending ?? false, cards, liveInSecondTab: seen });
process.exitCode = denied.status === 401 && res.status === 200 && cards.length >= 3 && seen ? 0 : 1;
