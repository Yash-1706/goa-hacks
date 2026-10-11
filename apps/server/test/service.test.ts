import { describe, expect, it } from "vitest";
import { buildPlist, parseLaunchctlPrint, protectedFolder, SERVICE_LABEL, servicePath } from "../src/cli/service-lib";

/**
 * V1.1: `pnpm run service:install` keeps Synapse running as a launchd agent: started at login, restarted within seconds of a
 * crash, logs in ~/Library/Logs/synapse/. The plist and the status parsing are pure and tested here; launchctl itself is
 * exercised by the live restart check (docs/V1_REPORT.md).
 */

const input = {
  node: "/opt/homebrew/bin/node",
  serverDir: "/Users/x/synapse & co/apps/server",
  logDir: "/Users/x/Library/Logs/synapse",
  home: "/Users/x",
  env: { TUNNEL: "auto", NODE_ENV: "production" },
};

describe("launchd service", () => {
  it("the plist: runs the server with node + tsx, starts at login, restarts on exit, logs to ~/Library/Logs/synapse", () => {
    const xml = buildPlist(input);
    expect(xml).toContain(`<key>Label</key>\n  <string>${SERVICE_LABEL}</string>`);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/); // back within 10 s of a crash
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>\n    <string>--import</string>\n    <string>tsx</string>");
    expect(xml).toContain("<string>src/index.ts</string>");
    expect(xml).toContain("<string>/Users/x/synapse &amp; co/apps/server</string>"); // XML-escaped
    expect(xml).toContain("<string>/Users/x/Library/Logs/synapse/server.log</string>");
    expect(xml).toMatch(/<key>TUNNEL<\/key>\s*<string>auto<\/string>/);
    expect(xml).toMatch(/<key>HOME<\/key>\s*<string>\/Users\/x<\/string>/);
  });

  it("PATH reaches node, Homebrew (cloudflared, ngrok) and /usr/local/bin (the tailscale CLI)", () => {
    const p = servicePath("/opt/homebrew/bin/node").split(":");
    expect(p[0]).toBe("/opt/homebrew/bin");
    expect(p).toEqual(expect.arrayContaining(["/usr/local/bin", "/usr/bin", "/bin"]));
    expect(new Set(p).size).toBe(p.length);
  });

  it("no secret ever goes into the plist (the server reads .env itself)", () => {
    expect(() => buildPlist({ ...input, env: { GROQ_API_KEY: "gsk_x" } })).toThrow(/secret/);
    expect(() => buildPlist({ ...input, env: { SYNAPSE_PASSCODE: "x" } })).toThrow(/secret/);
  });

  it("reads state, pid and the last exit from `launchctl print`", () => {
    const out = `gui/501/com.synapse.server = {\n\tactive count = 1\n\tpath = /Users/x/Library/LaunchAgents/com.synapse.server.plist\n\tstate = running\n\n\tprogram = /opt/homebrew/bin/node\n\tpid = 4242\n\tlast exit code = 0\n\truns = 3\n}`;
    expect(parseLaunchctlPrint(out)).toEqual({ state: "running", pid: 4242, lastExit: "0", runs: 3 });
    expect(parseLaunchctlPrint("gui/501/com.synapse.server = {\n\tstate = not running\n\tlast exit code = (never exited)\n}")).toEqual({ state: "not running", lastExit: "(never exited)" });
  });

  it("a repo in Desktop, Documents or Downloads is flagged: macOS asks before a background process may read it", () => {
    expect(protectedFolder("/Users/x/Desktop/goa-hacks", "/Users/x")).toBe("Desktop");
    expect(protectedFolder("/Users/x/Documents/code/synapse", "/Users/x")).toBe("Documents");
    expect(protectedFolder("/Users/x/Downloads/synapse", "/Users/x")).toBe("Downloads");
    expect(protectedFolder("/Users/x/code/synapse", "/Users/x")).toBeNull();
    expect(protectedFolder("/Users/x/Desktopish/synapse", "/Users/x")).toBeNull();
  });
});
