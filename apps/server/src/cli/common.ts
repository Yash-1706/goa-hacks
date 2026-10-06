import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createApp, type AppCtx, type AppOptions } from "../app";
import { loadConfig, type Config } from "../config";
import { GroqClient } from "../llm/groq-client";

/** The provider and model a `--live` run would call, or null when none is configured (no key, or LOCAL_ONLY is on). */
export function liveProvider(): { provider: "anthropic" | "groq"; model: string; label: string } | null {
  const cfg = loadConfig({ LLM_MODE: "live" });
  if (cfg.llm.provider === "mock") return null;
  return { provider: cfg.llm.provider, model: cfg.llm.fast, label: `${cfg.llm.provider}/${cfg.llm.fast}` };
}

/**
 * A deterministic sample of at most `n` items, taking one category after another in turn: the golden corpora are grouped by
 * category, so a plain slice would only ever see the first few. Returns every item when n is undefined or not smaller.
 */
export function spreadBy<T>(items: T[], n: number | undefined, category: (item: T) => string): T[] {
  if (n === undefined || items.length <= n) return items;
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const key = category(it);
    const g = groups.get(key) ?? [];
    g.push(it);
    groups.set(key, g);
  }
  const out: T[] = [];
  for (let round = 0; out.length < n; round++) {
    let any = false;
    for (const g of groups.values()) {
      const it = g[round];
      if (it === undefined) continue;
      out.push(it);
      any = true;
      if (out.length >= n) break;
    }
    if (!any) break;
  }
  return out;
}

/**
 * ONE Groq client for a whole live run. The token budget and the day's request count belong to the API key, so every app a run
 * builds must share the pacing state: a fresh client per app starts with a full bucket, ignores what the previous app spent and
 * walks into the server's 429 (measured: 31 of 58 answers in a first eval fell back for exactly that reason).
 */
export function sharedGroqClient(provider: "anthropic" | "groq" | undefined, budget?: number): GroqClient | undefined {
  if (provider !== "groq") return undefined;
  const g = loadConfig({ LLM_MODE: "live", ...liveEnv("groq", budget) }).llm.groq;
  return new GroqClient({ apiKey: g.apiKey, baseUrl: g.baseUrl, tpm: g.tpm, maxWaitMs: g.maxWaitMs, maxRequestsPerDay: g.maxRequestsPerDay });
}

/**
 * A measurement must see the model's answers, not the fallback's. When the shared client sits out a cool-down (a 429's
 * retry-after, a dead connection, a timeout), the script waits for it to end instead of racing through the fragments that
 * follow: the local pipeline is so much faster than a model call that a 4 s window would otherwise swallow twenty of them
 * (measured). A bad key (the auth window) is not waited out: that should fail loudly.
 */
export function patience(groq: GroqClient | undefined): () => Promise<void> {
  return async () => {
    if (!groq) return;
    for (let i = 0; i < 400 && (groq.disabledReason === "rate_limit" || groq.disabledReason === "network"); i++) await new Promise((r) => setTimeout(r, 250));
  };
}

/** Plain positive integer from a CLI flag, or undefined. */
export function intFlag(v: string | true | undefined): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Environment for the ephemeral app of a live run. Groq's free tier is paced by the client: an interactive session
 * degrades a call to the local cortex after waiting 2 s for the token budget, but a measurement must see the model's answer,
 * so a run waits as long as it takes (--budget N also caps the requests it may send).
 */
export function liveEnv(provider: "anthropic" | "groq" | undefined, budget?: number): Record<string, string> {
  if (provider !== "groq") return {};
  return { GROQ_MAX_WAIT_MS: "300000", ...(budget ? { GROQ_MAX_REQUESTS_PER_DAY: String(budget) } : {}) };
}

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
