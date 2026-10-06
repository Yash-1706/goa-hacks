import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createApp, type AppCtx, type AppOptions } from "../app";
import { loadConfig, type Config } from "../config";

/** A throw-away in-memory app (mock cortex unless env says otherwise) for replays, benchmarks and evals. */
export async function ephemeralApp(env: Record<string, string> = {}, opts: AppOptions = {}): Promise<{ ctx: AppCtx; cfg: Config; stop: () => Promise<void> }> {
  const cfg = loadConfig({
    DATA_DIR: path.join(os.tmpdir(), `synapse-cli-${randomBytes(4).toString("hex")}`),
    REQUIRE_PAIRING: "0",
    PORT: "0",
    ...env,
  });
  const { ctx, stop } = await createApp(cfg, { dbFile: ":memory:", kek: randomBytes(32), quiet: true, ...opts });
  return { ctx, cfg, stop };
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function serverUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
