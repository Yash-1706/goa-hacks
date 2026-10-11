// Shared helpers for the V1 end-to-end checks (Playwright + fetch against a running `pnpm start`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, devices } from "playwright";

/** Playwright's own Chromium if it is installed, else the newest one already in the cache (offline machines). */
export function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const own = chromium.executablePath();
  if (fs.existsSync(own)) return own;
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const d of dirs) {
    const p = path.join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    if (fs.existsSync(p)) return p;
  }
  return undefined; // let Playwright complain with its own install hint
}

export async function launch({ fakeAudio, headless = true } = {}) {
  const args = fakeAudio ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fakeAudio}`] : [];
  return chromium.launch({ headless, executablePath: chromiumPath(), args });
}

export const PIXEL_7 = devices["Pixel 7"];

/** POST /api/auth/login; returns the Cookie header value. */
export async function login(base, passcode) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin }, body: JSON.stringify({ passcode }) });
  if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
  return r.headers.get("set-cookie").split(";")[0];
}

/** The session cookie as a Playwright cookie for `base`. */
export function cookieFor(base, header) {
  const [name, value] = header.split("=");
  const u = new URL(base);
  return { name, value: header.slice(name.length + 1) || value, domain: u.hostname, path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "Lax" };
}

export async function waitFor(fn, { timeoutMs = 20_000, everyMs = 250, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export function report(obj) {
  console.log(JSON.stringify(obj, null, 2));
}
