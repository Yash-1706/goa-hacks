import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { chooseTunnels, hasFunnel, parseTunnelSetting, startNgrok, startTailscaleFunnel, type ExecFn, type SpawnFn } from "../src/tunnel";

/**
 * V1.1: a permanent free URL. Tailscale Funnel first (stable https://<mac>.<tailnet>.ts.net, TLS ends on the Mac), then ngrok's
 * free static domain, then a cloudflared quick tunnel (temporary URL) as the last resort.
 */

const tsStatus = (dns = "sayeds-macbook-air.tail0000.ts.net.") => JSON.stringify({ BackendState: "Running", Self: { DNSName: dns, CapMap: { "https://tailscale.com/cap/funnel": [] } } });

function execRig(o: { tailscale?: "running" | "stopped" | "missing" | "no-funnel"; funnel?: "ok" | "not-enabled"; ngrok?: boolean } = {}): { exec: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "tailscale") {
      if (o.tailscale === "missing") return { ok: false, stdout: "", stderr: "not found", missing: true };
      if (args[0] === "status" && o.tailscale === "no-funnel") return { ok: true, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "m.tail0000.ts.net.", CapMap: {} } }), stderr: "" };
      if (args[0] === "status") return o.tailscale === "stopped" ? { ok: true, stdout: JSON.stringify({ BackendState: "Stopped", Self: {} }), stderr: "" } : { ok: true, stdout: tsStatus(), stderr: "" };
      if (args[0] === "funnel") return o.funnel === "not-enabled" ? { ok: false, stdout: "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/funnel?node=abc", stderr: "" } : { ok: true, stdout: "Available on the internet:\nhttps://sayeds-macbook-air.tail0000.ts.net/\n|-- / proxy http://127.0.0.1:8787\nFunnel started and running in the background.", stderr: "" };
    }
    if (cmd === "ngrok") return o.ngrok ? { ok: true, stdout: "ngrok version 3.20.0", stderr: "" } : { ok: false, stdout: "", stderr: "", missing: true };
    if (cmd === "cloudflared") return { ok: true, stdout: "cloudflared version 2026.9.3", stderr: "" };
    return { ok: false, stdout: "", stderr: "", missing: true };
  };
  return { exec, calls };
}

describe("which tunnel", () => {
  it("parses TUNNEL: off, auto (1), or a provider", () => {
    expect(parseTunnelSetting("")).toBe("off");
    expect(parseTunnelSetting("0")).toBe("off");
    expect(parseTunnelSetting("1")).toBe("auto");
    expect(parseTunnelSetting("auto")).toBe("auto");
    expect(parseTunnelSetting("Tailscale")).toBe("tailscale");
    expect(parseTunnelSetting("ngrok")).toBe("ngrok");
    expect(parseTunnelSetting("cloudflared")).toBe("cloudflared");
    expect(parseTunnelSetting("cloudflare")).toBe("cloudflared");
  });

  it("auto: Tailscale when it is running, ngrok when a static domain is set, cloudflared last", async () => {
    expect(await chooseTunnels("auto", { exec: execRig().exec, ngrokDomain: "" })).toEqual(["tailscale", "cloudflared"]);
    expect(await chooseTunnels("auto", { exec: execRig({ tailscale: "stopped", ngrok: true }).exec, ngrokDomain: "calm-otter.ngrok-free.app" })).toEqual(["ngrok", "cloudflared"]);
    expect(await chooseTunnels("auto", { exec: execRig({ tailscale: "missing" }).exec, ngrokDomain: "x.ngrok-free.app" })).toEqual(["cloudflared"]); // ngrok not installed
    expect(await chooseTunnels("ngrok", { exec: execRig().exec, ngrokDomain: "" })).toEqual(["ngrok"]);
    // signed in but Funnel never approved: skipped in auto (`tailscale funnel` would wait for a browser approval)
    expect(await chooseTunnels("auto", { exec: execRig({ tailscale: "no-funnel" }).exec, ngrokDomain: "" })).toEqual(["cloudflared"]);
    // what Tailscale 1.102 really reports once Funnel is approved: plain "funnel" + "funnel-ports?ports=…" keys
    expect(hasFunnel({ funnel: null, https: null, "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null })).toBe(true);
    expect(hasFunnel({ "https://tailscale.com/cap/funnel": [] })).toBe(true);
    expect(hasFunnel({ "https://tailscale.com/cap/ssh": [], "https://tailscale.com/cap/is-owner": [] })).toBe(false);
    expect(hasFunnel(undefined)).toBe(false);
  });
});

describe("Tailscale Funnel", () => {
  it("runs `tailscale funnel --bg <port>` and returns the stable ts.net URL", async () => {
    const r = execRig();
    const t = await startTailscaleFunnel({ port: 8787, exec: r.exec });
    expect(t.url).toBe("https://sayeds-macbook-air.tail0000.ts.net");
    expect(t.temporary).toBe(false);
    expect(r.calls).toContain("tailscale funnel --bg 8787");
  });
  it("Funnel not approved: a clear error that says how (the approval link is not echoed into logs)", async () => {
    await expect(startTailscaleFunnel({ port: 8787, exec: execRig({ funnel: "not-enabled" }).exec })).rejects.toThrow(/not enabled on your tailnet.*tailscale funnel 8787/s);
  });
});

describe("ngrok static domain", () => {
  const spawnRig = (lines: string[]) => {
    const calls: string[][] = [];
    const spawn: SpawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid: number };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      child.kill = () => true;
      setTimeout(() => lines.forEach((l) => child.stdout.write(l + "\n")), 5);
      return child as never;
    };
    return { spawn, calls };
  };
  it("serves the free static domain and resolves once ngrok reports the tunnel", async () => {
    const r = spawnRig(['t=2026-10-11 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:8787 url=https://calm-otter.ngrok-free.app']);
    const t = await startNgrok({ port: 8787, domain: "calm-otter.ngrok-free.app", spawn: r.spawn, timeoutMs: 1000 });
    expect(t.url).toBe("https://calm-otter.ngrok-free.app");
    expect(r.calls[0]).toEqual(["ngrok", "http", "--url=calm-otter.ngrok-free.app", "--log=stdout", "--log-format=logfmt", "8787"]);
  });
  it("an auth problem is reported plainly", async () => {
    const r = spawnRig(['t=2026 lvl=eror msg="session closing" err="authentication failed: Usage of ngrok requires a verified account and authtoken."']);
    await expect(startNgrok({ port: 8787, domain: "x.ngrok-free.app", spawn: r.spawn, timeoutMs: 1000 })).rejects.toThrow(/authtoken/);
  });
});
