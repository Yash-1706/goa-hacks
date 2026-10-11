import "../silence";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, loadConfig } from "../config";
import { buildPlist, parseLaunchctlPrint, protectedFolder, SERVICE_LABEL } from "./service-lib";

/**
 * `pnpm run service:install | service:uninstall | service:status`: Synapse as a launchd user agent (no sudo). install builds the
 * web app, writes ~/Library/LaunchAgents/com.synapse.server.plist and (re)loads it; status shows the state, the public URL and
 * the last 20 log lines. The logs hold IDs and lengths only (never what was said).
 */

const cfg = loadConfig();
const uid = process.getuid?.() ?? 0;
const domain = `gui/${uid}`;
const target = `${domain}/${SERVICE_LABEL}`;
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const logDir = path.join(os.homedir(), "Library", "Logs", "synapse");
const serverDir = path.join(REPO_ROOT, "apps", "server");
const urlFile = path.join(cfg.dataDir, "public-url.txt");
const guarded = protectedFolder(REPO_ROOT, os.homedir());
const TCC_HINT = guarded
  ? `macOS has to allow background access to your ${guarded} folder once: click Allow on the "node would like to access files in your ${guarded} folder" prompt
   (or System Settings → Privacy & Security → Files and Folders → node → ${guarded} Folder), or move this repo out of ~/${guarded}.`
  : "";

const run = (cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })));

const readUrl = (): { url: string; kind: string; temporary: boolean; at: string } | null => {
  try {
    return JSON.parse(fs.readFileSync(urlFile, "utf8")) as { url: string; kind: string; temporary: boolean; at: string };
  } catch {
    return null;
  }
};

/** the PATH symlink for node (e.g. /opt/homebrew/bin/node), not the versioned Cellar path a `brew upgrade` removes */
function stableNode(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, "node");
    if (dir && fs.existsSync(p)) return p;
  }
  return process.execPath;
}

async function status(): Promise<number> {
  const r = await run("launchctl", ["print", target]);
  if (!r.ok) {
    console.log("Synapse service: not installed (pnpm run service:install)");
  } else {
    const s = parseLaunchctlPrint(r.stdout);
    console.log(`Synapse service: ${s.state ?? "loaded"}${s.pid ? ` (pid ${s.pid})` : ""}${s.runs ? `, started ${s.runs}×` : ""}${s.lastExit ? `, last exit ${s.lastExit}` : ""}`);
  }
  const u = readUrl();
  if (r.ok && !u && TCC_HINT) console.log(`No URL yet. If the logs below are empty: ${TCC_HINT}`);
  console.log(u ? `Public URL: ${u.url} (${u.kind}${u.temporary ? ", TEMPORARY: changes on restart" : ""}; since ${u.at})` : "Public URL: none yet");
  for (const f of ["server.log", "server.err.log"]) {
    const p = path.join(logDir, f);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").trimEnd().split("\n").slice(-20);
    console.log(`\n--- ${p} (last ${lines.length} lines) ---\n${lines.join("\n")}`);
  }
  return r.ok ? 0 : 1;
}

async function install(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("service:install is for macOS (launchd). On Linux, run `pnpm run serve` under systemd or tmux.");
    return 1;
  }
  if (!cfg.remote.passcode) {
    console.error("✖ Set SYNAPSE_PASSCODE in .env first: the service exposes Synapse on a public URL.");
    return 1;
  }
  console.log("Building the web app…");
  execFileSync("pnpm", ["--filter", "@synapse/web", "build"], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const tunnel = cfg.remote.tunnel === "off" && !cfg.remote.publicUrl ? "auto" : (process.env.TUNNEL ?? "auto");
  fs.writeFileSync(plistPath, buildPlist({ node: stableNode(), serverDir, logDir, home: os.homedir(), env: { TUNNEL: tunnel, NODE_ENV: "production" } }));
  if (TCC_HINT) console.log(`⚠ This repo is in ~/${guarded}. ${TCC_HINT}`);
  await run("launchctl", ["bootout", target]); // a previous install: replaced, not duplicated
  const before = readUrl()?.at;
  const boot = await run("launchctl", ["bootstrap", domain, plistPath]);
  if (!boot.ok) {
    console.error(`✖ launchctl bootstrap failed: ${boot.stderr.trim()}`);
    return 1;
  }
  console.log(`Installed ${plistPath}\nLogs: ${logDir}/server.log\nWaiting for the public URL…`);
  for (let i = 0; i < 60; i++) {
    const u = readUrl();
    if (u && u.at !== before) {
      console.log(`\n✅ Synapse is running as a service: ${u.url}${u.temporary ? "\n⚠ This is a temporary cloudflared URL: it changes on every restart. See pnpm run doctor for a stable one." : ""}`);
      console.log(`   Phone: open ${u.url}/capture and Add to Home screen.`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`⚠ The service started but published no URL within 60 s: pnpm run service:status shows the logs.${TCC_HINT ? `\n  Most likely: ${TCC_HINT}` : ""}`);
  return 1;
}

async function uninstall(): Promise<number> {
  const r = await run("launchctl", ["bootout", target]);
  fs.rmSync(plistPath, { force: true });
  console.log(r.ok ? "Synapse service stopped and removed." : "Synapse service was not loaded; plist removed if present.");
  if (readUrl()?.kind === "tailscale") console.log("Tailscale Funnel still forwards to this port (it serves 502 while Synapse is off). Remove it with: tailscale funnel reset");
  console.log(`Logs kept in ${logDir}`);
  return 0;
}

const cmd = process.argv[2];
const code = cmd === "install" ? await install() : cmd === "uninstall" ? await uninstall() : cmd === "status" ? await status() : (console.error("usage: service install | uninstall | status"), 2);
process.exitCode = code; // not process.exit(): a piped stdout on macOS is asynchronous
