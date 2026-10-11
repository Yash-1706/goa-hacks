import "../silence";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, loadConfig } from "../config";
import { formatChecks, runDoctor } from "./doctor-lib";

/** `pnpm doctor`: prints a ✅ / ⚠️ / ❌ checklist with a one-line fix each, and exits 1 when something must be fixed. */

const cfg = loadConfig(); // importing config also loads .env into process.env
const exec = (cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? "") })));

const checks = await runDoctor({
  env: process.env,
  envFilePresent: fs.existsSync(path.join(REPO_ROOT, ".env")),
  nodeVersion: process.version,
  exec,
  fetch,
  modelCached: (model) => fs.existsSync(path.join(cfg.embeddings.cacheDir, "models", ...model.split("/"))),
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  publicUrl: () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "public-url.txt"), "utf8")) as { url: string; kind: string; temporary: boolean };
    } catch {
      return null;
    }
  },
});
console.log(`\nSynapse doctor\n\n${formatChecks(checks)}\n`);
process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0; // not process.exit(): on macOS a piped stdout is asynchronous and would be cut off
