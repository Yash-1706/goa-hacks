import "./silence";
import fs from "node:fs";
import path from "node:path";
import qrcode from "qrcode-terminal";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { log } from "./log";
import { chooseTunnels, nodeExec, startNgrok, startTailscaleFunnel, startTunnel, type Tunnel, type TunnelKind } from "./tunnel";

const cfg = loadConfig();
const { ctx, start, stop } = await createApp(cfg);
await start();

let tunnel: Tunnel | null = null;
const urlFile = path.join(cfg.dataDir, "public-url.txt");
const pidFile = path.join(cfg.dataDir, "tunnel.pid");
fs.rmSync(urlFile, { force: true }); // a URL from an earlier run is not this run's URL

function announce(url: string, kind: TunnelKind | "PUBLIC_URL", temporary: boolean): void {
  // the landing page, Settings and `pnpm run service:status` read this (a URL, never a secret)
  fs.writeFileSync(urlFile, JSON.stringify({ url, kind, temporary, at: new Date().toISOString() }) + "\n");
  qrcode.generate(`${url}/capture`, { small: true }, (qr) => {
    console.log(`\n  Public URL (${kind}${temporary ? ", TEMPORARY" : ""}): ${url}\n  Phone: open ${url}/capture, sign in with SYNAPSE_PASSCODE, then Add to Home screen.\n\n${qr.replace(/^/gm, "  ")}`);
    if (temporary) console.log("  ⚠ This URL changes every time Synapse starts: the phone app has to be re-added after each restart.\n    For a permanent free URL use Tailscale Funnel (TUNNEL=tailscale) or ngrok's static domain (TUNNEL=ngrok).\n");
  });
}

/** a tunnel process a crashed run left behind (cloudflared / ngrok) is ended before a new one starts */
function killOrphan(): void {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid > 0) process.kill(pid, "SIGTERM");
  } catch {
    /* none, or already gone */
  }
  fs.rmSync(pidFile, { force: true });
}

async function openTunnel(): Promise<void> {
  if (cfg.remote.tunnel === "off") return;
  killOrphan();
  const order = await chooseTunnels(cfg.remote.tunnel, { exec: nodeExec, ngrokDomain: cfg.remote.ngrokDomain });
  for (const kind of order) {
    console.log(`  Starting the ${kind} tunnel…`);
    try {
      tunnel =
        kind === "tailscale"
          ? await startTailscaleFunnel({ port: cfg.port, exec: nodeExec })
          : kind === "ngrok"
            ? await startNgrok({ port: cfg.port, domain: cfg.remote.ngrokDomain })
            : await startTunnel({ port: cfg.port, onExit: (code) => log.warn("tunnel", "cloudflared exited", { code }) });
      if (tunnel.pid) fs.writeFileSync(pidFile, String(tunnel.pid));
      ctx.auth.setPublicUrl(tunnel.url);
      ctx.hub.broadcast({ type: "config.update", config: ctx.clientConfig() }); // the first-run QR code shows it
      announce(tunnel.url, tunnel.kind, tunnel.temporary);
      return;
    } catch (err) {
      console.error(`  ✖ ${kind}: ${(err as Error).message}`);
    }
  }
  console.error("\n  ✖ No tunnel could be started: the phone cannot reach this Mac. Run pnpm run doctor.\n");
}

if (cfg.remote.tunnel !== "off" || cfg.remote.publicUrl) {
  if (!ctx.auth.enabled) {
    console.error("\n  ✖ Not exposing this server: set SYNAPSE_PASSCODE in .env first (the URL is public).\n");
  } else if (!ctx.webServed) {
    console.error("\n  ✖ The web app is not built, so a phone would get no pages: use `pnpm run serve` (it builds first).\n");
  } else if (cfg.remote.tunnel !== "off") {
    await openTunnel();
  } else announce(ctx.auth.publicOrigin as string, "PUBLIC_URL", false);
}

let closing = false;
const shutdown = async (sig: string): Promise<void> => {
  if (closing) return;
  closing = true;
  log.info("server", `${sig}: shutting down`);
  tunnel?.stop();
  fs.rmSync(pidFile, { force: true });
  try {
    await stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (r) => log.error("server", `unhandled rejection: ${(r as Error)?.message ?? r}`));
