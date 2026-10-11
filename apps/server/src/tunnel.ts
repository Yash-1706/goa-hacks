import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/* ============================================================================
 * Tunnels (V1 1d, V1.1): make this Mac reachable from a phone on 4G, at no cost. In order of preference:
 *   Tailscale Funnel  https://<mac>.<tailnet>.ts.net, stable; TLS ends on the Mac (the relay cannot decrypt)
 *   ngrok             the free plan's static domain, stable; TLS ends at ngrok's edge; a browser warning page once a week
 *   cloudflared       a quick tunnel at a random https://*.trycloudflare.com, NEW every start; TLS ends at Cloudflare's edge
 * The URL becomes the active public URL (origin guard + "loopback is not trusted").
 * ========================================================================== */

export type SpawnFn = (cmd: string, args: string[]) => Pick<ChildProcess, "stdout" | "stderr" | "kill" | "on" | "once"> & { pid?: number };
/** run a CLI to completion (never throws); `missing` when the command does not exist */
export type ExecFn = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string; stderr: string; missing?: boolean }>;

export const nodeExec: ExecFn = (cmd, args, timeoutMs = 20_000) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...((err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { missing: true } : {}) }),
    ),
  );

export type TunnelKind = "tailscale" | "ngrok" | "cloudflared";
/** the node capability Tailscale grants once Funnel is approved for this device */
export const FUNNEL_CAP = "https://tailscale.com/cap/funnel";
export type TunnelSetting = "off" | "auto" | TunnelKind;

/** TUNNEL in .env: 0/empty = off, 1/auto = the best available, or a provider by name */
export function parseTunnelSetting(v: string): TunnelSetting {
  const s = v.trim().toLowerCase();
  if (!s || s === "0" || s === "off" || s === "false" || s === "no") return "off";
  if (s.startsWith("tailscale") || s === "funnel") return "tailscale";
  if (s.startsWith("ngrok")) return "ngrok";
  if (s.startsWith("cloudflare")) return "cloudflared";
  return "auto";
}

/**
 * The providers to try, in order. Tailscale Funnel when tailscale is signed in with Funnel approved (a stable URL, TLS ends on
 * the Mac); ngrok when a free static domain is configured and ngrok is installed (stable URL, TLS ends at ngrok); a cloudflared
 * quick tunnel last (a NEW URL every start: the phone app must be re-added).
 */
export async function chooseTunnels(setting: Exclude<TunnelSetting, "off">, o: { exec: ExecFn; ngrokDomain: string }): Promise<TunnelKind[]> {
  if (setting !== "auto") return [setting];
  const out: TunnelKind[] = [];
  const ts = await o.exec("tailscale", ["status", "--json"], 8000);
  try {
    const j = JSON.parse(ts.stdout) as { BackendState?: string; Self?: { CapMap?: Record<string, unknown> } };
    // Funnel must be approved for this node: otherwise `tailscale funnel` stops and waits for a browser approval
    if (ts.ok && j.BackendState === "Running" && FUNNEL_CAP in (j.Self?.CapMap ?? {})) out.push("tailscale");
  } catch {
    /* not JSON: not usable */
  }
  if (o.ngrokDomain && (await o.exec("ngrok", ["version"], 8000)).ok) out.push("ngrok");
  out.push("cloudflared");
  return out;
}

export interface Tunnel {
  url: string;
  kind: TunnelKind;
  /** the URL changes on every start (cloudflared quick tunnels) */
  temporary: boolean;
  stop: () => void;
  /** a child process this server started (so a crashed server's orphan can be cleaned up next start) */
  pid?: number;
}

/** `tailscale funnel --bg <port>`: persistent, managed by tailscaled; the URL is the Mac's stable MagicDNS name. */
export async function startTailscaleFunnel(o: { port: number; exec: ExecFn }): Promise<Tunnel> {
  const r = await o.exec("tailscale", ["funnel", "--bg", String(o.port)], 20_000);
  const text = `${r.stdout}\n${r.stderr}`;
  if (/not enabled on your tailnet/i.test(text)) {
    throw new Error(`Tailscale Funnel is not enabled on your tailnet. Run \`tailscale funnel ${o.port}\` once in a terminal and approve it in the browser page it opens`);
  }
  if (!r.ok) throw new Error(`tailscale funnel failed${r.missing ? ": the tailscale CLI is not installed" : ""}`);
  const st = await o.exec("tailscale", ["status", "--json"], 8000);
  let dns = "";
  try {
    dns = ((JSON.parse(st.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
  } catch {
    /* fall through */
  }
  const fromFunnel = text.match(/https:\/\/[a-z0-9.-]+\.ts\.net/i)?.[0];
  const url = dns ? `https://${dns}` : fromFunnel;
  if (!url) throw new Error("tailscale funnel is running but its URL could not be read (tailscale funnel status)");
  // the funnel stays configured when this server stops (tailscaled serves 502 meanwhile): the URL never changes
  return { url: url.replace(/\/$/, ""), kind: "tailscale", temporary: false, stop: () => undefined };
}

/** `ngrok http --url=<static domain> <port>`: the free plan's one static domain (needs ngrok's own authtoken, set up once). */
export function startNgrok(o: { port: number; domain: string; spawn?: SpawnFn; timeoutMs?: number }): Promise<Tunnel> {
  const spawn = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }));
  const domain = o.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const child = spawn("ngrok", ["http", `--url=${domain}`, "--log=stdout", "--log-format=logfmt", String(o.port)]);
  const stop = (): void => void child.kill("SIGTERM");
  return new Promise<Tunnel>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        stop();
        reject(err);
      } else resolve({ url: `https://${domain}`, kind: "ngrok", temporary: false, stop, ...(child.pid ? { pid: child.pid } : {}) });
    };
    const timer = setTimeout(() => finish(new Error("ngrok did not report its tunnel in time")), o.timeoutMs ?? 30_000);
    child.once("error", (err: NodeJS.ErrnoException) => finish(new Error(err.code === "ENOENT" ? "ngrok is not installed: brew install ngrok" : `ngrok failed: ${err.message}`)));
    child.once("exit", (code: number | null) => finish(new Error(`ngrok exited (code ${code}) before its tunnel started`)));
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on("line", (line) => {
        if (/msg="started tunnel"/.test(line) || line.includes(`url=https://${domain}`)) finish(null);
        else if (/lvl=(eror|crit)/.test(line)) finish(new Error(`ngrok: ${(line.match(/err="([^"]+)"/)?.[1] ?? "error").slice(0, 200)}`));
      });
    }
  });
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTunnelUrl(line: string): string | null {
  return line.match(URL_RE)?.[0]?.toLowerCase() ?? null;
}


export function startTunnel(o: { port: number; spawn?: SpawnFn; timeoutMs?: number; onExit?: (code: number | null) => void }): Promise<Tunnel> {
  const spawn = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }));
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${o.port}`]);
  const stop = (): void => void child.kill("SIGTERM");
  return new Promise<Tunnel>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        stop();
        reject(err);
      } else resolve({ url: url as string, kind: "cloudflared", temporary: true, stop, ...(child.pid ? { pid: child.pid } : {}) });
    };
    const timer = setTimeout(() => finish(new Error("cloudflared did not report a URL in time (is the network up?)")), o.timeoutMs ?? 30_000);
    child.once("error", (err: NodeJS.ErrnoException) => finish(new Error(err.code === "ENOENT" ? "cloudflared is not installed: brew install cloudflared" : `cloudflared failed: ${err.message}`)));
    child.once("exit", (code: number | null) => {
      finish(new Error(`cloudflared exited (code ${code}) before reporting a URL`));
      o.onExit?.(code);
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on("line", (line) => {
        const url = parseTunnelUrl(line);
        if (url) finish(null, url);
      });
    }
  });
}
