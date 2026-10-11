import "./silence";
import qrcode from "qrcode-terminal";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { log } from "./log";
import { startTunnel, type Tunnel } from "./tunnel";

const cfg = loadConfig();
const { ctx, start, stop } = await createApp(cfg);
await start();

let tunnel: Tunnel | null = null;

function announce(url: string): void {
  qrcode.generate(url, { small: true }, (qr) => {
    console.log(`\n  Open on your phone (sign in with SYNAPSE_PASSCODE, then Add to Home screen):\n\n  ${url}/capture\n\n${qr.replace(/^/gm, "  ")}`);
  });
}

if (cfg.remote.tunnel || cfg.remote.publicUrl) {
  if (!ctx.auth.enabled) {
    console.error("\n  ✖ Not exposing this server: set SYNAPSE_PASSCODE in .env first (the URL is public).\n");
  } else if (!ctx.webServed) {
    console.error("\n  ✖ The web app is not built, so a phone would get no pages: use `TUNNEL=1 pnpm start` (it builds first).\n");
  } else if (cfg.remote.tunnel) {
    console.log("  Starting the cloudflared tunnel…");
    try {
      tunnel = await startTunnel({ port: cfg.port, onExit: (code) => log.warn("tunnel", "cloudflared exited", { code }) });
      ctx.auth.setPublicUrl(tunnel.url);
      announce(tunnel.url);
    } catch (err) {
      console.error(`\n  ✖ Tunnel: ${(err as Error).message}\n`);
    }
  } else announce(ctx.auth.publicOrigin as string);
}

let closing = false;
const shutdown = async (sig: string): Promise<void> => {
  if (closing) return;
  closing = true;
  log.info("server", `${sig}: shutting down`);
  tunnel?.stop();
  try {
    await stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (r) => log.error("server", `unhandled rejection: ${(r as Error)?.message ?? r}`));
