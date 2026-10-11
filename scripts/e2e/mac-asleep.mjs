// V1.1 "Mac asleep": an emulated Pixel 7 on the public URL captures while the Mac's server is DOWN (the tunnel answers with its
// own error page), sees "Saved on your phone. It will sync when your Mac is awake.", and once the server is back the capture
// is uploaded exactly once. The server is stopped and started by the shell commands in STOP_CMD / START_CMD.
// usage: SYNAPSE_PASSCODE=... STOP_CMD="..." START_CMD="..." node scripts/e2e/mac-asleep.mjs <base-url>
import { execSync } from "node:child_process";
import { PIXEL_7, cookieFor, launch, login, report, waitFor } from "./lib.mjs";

const [base] = process.argv.slice(2);
const cookie = await login(base, process.env.SYNAPSE_PASSCODE);
const out = { steps: [] };
const step = (name, ok, detail = {}) => out.steps.push({ name, ok: Boolean(ok), ...detail });

const browser = await launch();
const ctx = await browser.newContext({ ...PIXEL_7, viewport: { width: 390, height: 844 } });
await ctx.addCookies([cookieFor(base, cookie)]);
const phone = await ctx.newPage();
await phone.goto(`${base}/capture`, { waitUntil: "networkidle" });
step("phone app open on the public URL", await phone.locator(".cap-btn").count());

execSync(process.env.STOP_CMD, { stdio: "ignore" });
await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.status !== 200, { timeoutMs: 30_000, what: "server down" });
step("server stopped (Mac asleep)", true);

const text = `Mac asleep check ${Date.now().toString(36)}: remind me to water the plants tomorrow at 8 am.`;
await phone.locator(".cap__type input").fill(text);
await phone.getByRole("button", { name: "Send", exact: true }).click();
const row = phone.locator(".cap-row").first();
await waitFor(async () => /sync when your Mac is awake/.test((await row.innerText().catch(() => "")) ?? ""), { timeoutMs: 30_000, what: "the asleep message" }).catch(() => undefined);
const asleepText = (await row.innerText().catch(() => "")).split("\n").find((l) => /Saved on your phone|Waiting/.test(l)) ?? null;
step("phone says it will sync when the Mac is awake", asleepText && /sync when your Mac is awake/.test(asleepText), { shown: asleepText });

execSync(process.env.START_CMD, { stdio: "ignore" });
await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.status === 200, { timeoutMs: 120_000, everyMs: 1000, what: "server back" });
step("server back", true);
// the queue retries on its own backoff; opening the app (as a person would) also flushes it
const sent = async () => (await row.getAttribute("data-status")) === "sent";
let synced = await waitFor(sent, { timeoutMs: 75_000, everyMs: 1000, what: "sent" }).then(() => "on its own", () => null);
if (!synced) {
  await phone.reload({ waitUntil: "networkidle" });
  synced = await waitFor(async () => (await phone.locator(".cap-row").first().getAttribute("data-status")) === "sent", { timeoutMs: 45_000, everyMs: 1000, what: "sent after reopen" }).then(() => "after reopening the app", () => null);
}
step("the capture synced", synced, { how: synced });

const clientId = await phone.locator(".cap-row").first().getAttribute("data-client-id");
const list = await (await fetch(`${base}/api/captures?limit=50`, { headers: { cookie } })).json();
const copies = list.filter((c) => c.clientId === clientId).length;
step("uploaded exactly once", copies === 1, { copies });

await browser.close();
out.ok = out.steps.every((s) => s.ok);
report(out);
process.exitCode = out.ok ? 0 : 1;
