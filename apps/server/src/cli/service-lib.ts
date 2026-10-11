import path from "node:path";

/* ============================================================================
 * `pnpm run service:*` (V1.1): Synapse as a launchd user agent, so the Mac is an always-on server. Started at login, restarted
 * within seconds when it exits, logs in ~/Library/Logs/synapse/. Pure parts here (tested); the launchctl calls in service.ts.
 * ========================================================================== */

export const SERVICE_LABEL = "com.synapse.server";

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SECRET = /KEY|TOKEN|SECRET|PASSCODE|PASSWORD/i;

/** node's own directory first, then Homebrew (cloudflared, ngrok) and /usr/local/bin (where the Tailscale app links its CLI) */
export function servicePath(node: string): string {
  return [...new Set([path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

export interface PlistInput {
  /** a stable node path (the Homebrew symlink, not the versioned Cellar path, so a `brew upgrade` does not break the agent) */
  node: string;
  serverDir: string;
  logDir: string;
  home: string;
  /** non-secret settings only: keys stay in .env, which the server reads itself */
  env: Record<string, string>;
}

export function buildPlist(i: PlistInput): string {
  const bad = Object.keys(i.env).find((k) => SECRET.test(k));
  if (bad) throw new Error(`refusing to put a secret (${bad}) in the launchd plist: it belongs in .env`);
  const env = { ...i.env, PATH: servicePath(i.node), HOME: i.home };
  const args = [i.node, "--import", "tsx", "--disable-warning=ExperimentalWarning", "src/index.ts"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(i.serverDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(path.join(i.logDir, "server.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(i.logDir, "server.err.log"))}</string>
</dict>
</plist>
`;
}

export interface ServiceState {
  state?: string;
  pid?: number;
  lastExit?: string;
  runs?: number;
}

/** the few fields of `launchctl print gui/<uid>/<label>` that matter */
export function parseLaunchctlPrint(out: string): ServiceState {
  const field = (name: string): string | undefined => out.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1]?.trim();
  const s: ServiceState = {};
  const state = field("state");
  const pid = field("pid");
  const lastExit = field("last exit code");
  const runs = field("runs");
  if (state) s.state = state;
  if (pid) s.pid = Number(pid);
  if (lastExit) s.lastExit = lastExit;
  if (runs) s.runs = Number(runs);
  return s;
}

/**
 * macOS privacy protection (TCC): a process launchd starts must be allowed before it can read ~/Desktop, ~/Documents or
 * ~/Downloads. Until someone clicks Allow on the "node would like to access files in your … folder" prompt, the server blocks.
 */
export function protectedFolder(repoRoot: string, home: string): string | null {
  for (const f of ["Desktop", "Documents", "Downloads"]) {
    const dir = path.join(home, f);
    if (repoRoot === dir || repoRoot.startsWith(dir + path.sep)) return f;
  }
  return null;
}
