import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/* ============================================================================
 * cloudflared quick tunnel (V1 1d): `TUNNEL=1 pnpm start` makes this Mac reachable from a phone on 4G at a random
 * https://*.trycloudflare.com URL, which becomes the active public URL (origin guard + "loopback is not trusted").
 * A stable URL needs a named tunnel: set PUBLIC_URL instead (README).
 * ========================================================================== */

export type SpawnFn = (cmd: string, args: string[]) => Pick<ChildProcess, "stdout" | "stderr" | "kill" | "on" | "once">;

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTunnelUrl(line: string): string | null {
  return line.match(URL_RE)?.[0]?.toLowerCase() ?? null;
}

export interface Tunnel {
  url: string;
  stop: () => void;
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
      } else resolve({ url: url as string, stop });
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
