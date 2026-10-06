import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

// Load .env from the repo root (does not override variables already set).
const envFile = path.join(REPO_ROOT, ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* malformed .env: fall through to defaults */
  }
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    });
const str = (def: string) => z.string().optional().transform((v) => (v === undefined || v === "" ? def : v));

const EnvSchema = z.object({
  NODE_ENV: str("development"),
  PORT: num(8787),
  WEB_PORT: num(5173),
  DATA_DIR: str("./data"),
  TIMEZONE: str("Asia/Kolkata"),
  USER_FIRST_NAME: str("Rio"),
  USER_ROLE: str("backend engineer"),
  USER_TEAM: str("Sarah:PM,Dev:SRE"),
  HACKATHON_START: str("2026-10-06T09:00:00+05:30"),

  WISPR_MODE: str("mock"),
  WISPR_API_KEY: str(""),
  WISPR_BASE: str("https://platform-api.wisprflow.ai/api/v1/dash"),
  WISPR_LANGUAGES: str("en"),
  WISPR_TOKEN_TTL_SECS: num(900),
  WISPR_FINAL_TIMEOUT_MS: num(4000),
  WISPR_STANDBY_MAX_AGE_MS: num(45_000),
  WISPR_WARMUP_INTERVAL_S: num(120),

  LLM_MODE: str("mock"),
  ANTHROPIC_API_KEY: str(""),
  MODEL_FAST: str("claude-haiku-4-5"),
  MODEL_DEEP: str("claude-opus-5-5"),

  EMBEDDINGS: str("model"),
  EMBED_MODEL: str("Xenova/all-MiniLM-L6-v2"),
  MODEL_CACHE_DIR: str(""),

  SYNAPSE_PASSPHRASE: str(""),
  WORKING_MEMORY_TTL_HOURS: num(72),
  PROMOTE_THRESHOLD: num(0.6),
  PAUSE_PURGE_WINDOW_SECS: num(30),
  LOCAL_ONLY: bool(false),
  REQUIRE_PAIRING: bool(true),
  PSEUDONYMIZE_PERSONS: bool(false),
  CONSOLIDATE_INTERVAL_MIN: num(10),
  THREAD_CLOSE_MS: num(6000),

  AUTONOMY_LEVEL: num(2),
  RECURRING_N: num(3),
  RECURRING_WINDOW_MIN: num(10),
  SUGGESTION_MIN_GAP_S: num(120),

  GITHUB_TOKEN: str(""),
  GITHUB_REPO: str(""),
  JIRA_BASE_URL: str(""),
  JIRA_EMAIL: str(""),
  JIRA_API_TOKEN: str(""),
  JIRA_PROJECT_KEY: str(""),
});

export interface TeamMember {
  name: string;
  role: string;
}

export interface Config {
  env: string;
  dev: boolean;
  port: number;
  webPort: number;
  dataDir: string;
  timezone: string;
  user: { firstName: string; role: string; team: TeamMember[] };
  hackathonStart: number;
  wispr: {
    mode: "client" | "proxy" | "mock";
    apiKey: string;
    base: string;
    languages: string[];
    tokenTtlSecs: number;
    finalTimeoutMs: number;
    standbyMaxAgeMs: number;
    warmupIntervalS: number;
  };
  llm: {
    mode: "live" | "mock";
    hasKey: boolean;
    apiKey: string;
    fast: string;
    deep: string;
  };
  embeddings: { mode: "model" | "hash"; model: string; cacheDir: string };
  memory: {
    passphrase: string;
    ttlHours: number;
    promoteThreshold: number;
    pauseWindowSecs: number;
    consolidateIntervalMin: number;
    threadCloseMs: number;
  };
  privacy: { localOnly: boolean; requirePairing: boolean; pseudonymize: boolean };
  proactive: { autonomyLevel: number; recurringN: number; recurringWindowMin: number; minGapMs: number };
  integrations: {
    github: { token: string; repo: string };
    jira: { baseUrl: string; email: string; token: string; projectKey: string };
  };
}

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  const raw = EnvSchema.parse({ ...process.env, ...overrides });

  const wisprMode = (["client", "proxy", "mock"].includes(raw.WISPR_MODE) ? raw.WISPR_MODE : "mock") as Config["wispr"]["mode"];
  // client/proxy need a key to mint tokens or to proxy; without one we fall back to mock.
  const effectiveWispr = wisprMode !== "mock" && !raw.WISPR_API_KEY ? "mock" : wisprMode;

  const llmWanted = raw.LLM_MODE === "live" ? "live" : "mock";
  const effectiveLlm: "live" | "mock" = llmWanted === "live" && !raw.LOCAL_ONLY ? "live" : "mock";

  const team: TeamMember[] = raw.USER_TEAM.split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [name, role] = p.split(":");
      return { name: (name ?? "").trim(), role: (role ?? "").trim() };
    })
    .filter((m) => m.name);

  const start = Date.parse(raw.HACKATHON_START);
  const dataDir = path.isAbsolute(raw.DATA_DIR) ? raw.DATA_DIR : path.resolve(REPO_ROOT, raw.DATA_DIR);

  return {
    env: raw.NODE_ENV,
    dev: raw.NODE_ENV !== "production",
    port: raw.PORT,
    webPort: raw.WEB_PORT,
    dataDir,
    timezone: raw.TIMEZONE,
    user: { firstName: raw.USER_FIRST_NAME, role: raw.USER_ROLE, team },
    hackathonStart: Number.isFinite(start) ? start : Date.now() - 24 * 3600_000,
    wispr: {
      mode: effectiveWispr,
      apiKey: raw.WISPR_API_KEY,
      base: raw.WISPR_BASE.replace(/\/$/, ""),
      languages: raw.WISPR_LANGUAGES.split(",").map((s) => s.trim()).filter(Boolean),
      tokenTtlSecs: raw.WISPR_TOKEN_TTL_SECS,
      finalTimeoutMs: raw.WISPR_FINAL_TIMEOUT_MS,
      standbyMaxAgeMs: raw.WISPR_STANDBY_MAX_AGE_MS,
      warmupIntervalS: raw.WISPR_WARMUP_INTERVAL_S,
    },
    llm: {
      mode: effectiveLlm,
      hasKey: Boolean(raw.ANTHROPIC_API_KEY),
      apiKey: raw.ANTHROPIC_API_KEY,
      fast: raw.MODEL_FAST,
      deep: raw.MODEL_DEEP,
    },
    embeddings: {
      mode: raw.EMBEDDINGS === "hash" ? "hash" : "model",
      model: raw.EMBED_MODEL,
      // the (non-sensitive) model cache is independent of the user-data dir so tools and tests share one download
      cacheDir: raw.MODEL_CACHE_DIR ? path.resolve(REPO_ROOT, raw.MODEL_CACHE_DIR) : path.resolve(REPO_ROOT, "data"),
    },
    memory: {
      passphrase: raw.SYNAPSE_PASSPHRASE,
      ttlHours: raw.WORKING_MEMORY_TTL_HOURS,
      promoteThreshold: raw.PROMOTE_THRESHOLD,
      pauseWindowSecs: raw.PAUSE_PURGE_WINDOW_SECS,
      consolidateIntervalMin: raw.CONSOLIDATE_INTERVAL_MIN,
      threadCloseMs: raw.THREAD_CLOSE_MS,
    },
    privacy: {
      localOnly: raw.LOCAL_ONLY,
      requirePairing: raw.REQUIRE_PAIRING,
      pseudonymize: raw.PSEUDONYMIZE_PERSONS,
    },
    proactive: {
      autonomyLevel: Math.max(0, Math.min(3, Math.round(raw.AUTONOMY_LEVEL))),
      recurringN: Math.max(2, Math.round(raw.RECURRING_N)),
      recurringWindowMin: Math.max(1, raw.RECURRING_WINDOW_MIN),
      minGapMs: Math.max(0, raw.SUGGESTION_MIN_GAP_S) * 1000,
    },
    integrations: {
      github: { token: raw.GITHUB_TOKEN, repo: raw.GITHUB_REPO },
      jira: {
        baseUrl: raw.JIRA_BASE_URL.replace(/\/$/, ""),
        email: raw.JIRA_EMAIL,
        token: raw.JIRA_API_TOKEN,
        projectKey: raw.JIRA_PROJECT_KEY,
      },
    },
  };
}
