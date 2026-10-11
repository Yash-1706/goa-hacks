import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseTunnelSetting, type TunnelSetting } from "./tunnel";

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

  // On-device speech to text (Whisper via transformers.js, on the machine that runs this server): WISPR_MODE=local, local-only
  // mode while a Wispr setup is configured, and (STT_FALLBACK) when Wispr cannot be reached.
  STT_MODEL: str("Xenova/whisper-tiny.en"),
  STT_DTYPE: str("q8"),
  // 1: load the model when the server starts; 0: on first use; auto: at start when WISPR_MODE=local
  STT_PRELOAD: str("auto"),
  // 1: when Wispr rejects the key or cannot be reached, transcribe on this machine instead (the audio then reaches this server, in memory only)
  STT_FALLBACK: bool(false),
  // Sarvam AI speech to text: a CLOUD engine behind the same endpoints, good for Indian accents, Hindi and Hinglish. Opt in with
  // WISPR_MODE=sarvam or STT_PROVIDER=sarvam, and set SARVAM_API_KEY. Local-only mode always uses on-device Whisper instead.
  STT_PROVIDER: str("whisper"),
  SARVAM_API_KEY: str(""),
  SARVAM_BASE_URL: str("https://api.sarvam.ai"),
  SARVAM_STT_MODEL: str("saaras:v4"),
  // auto: en-IN (or the matching code) when WISPR_LANGUAGES names one language, otherwise detect; or force one, e.g. hi-IN, unknown
  SARVAM_LANGUAGE: str("auto"),

  LLM_MODE: str("mock"),
  // auto | anthropic | groq. auto: Anthropic when its key is set, else Groq when its key is set, else mock.
  LLM_PROVIDER: str("auto"),
  ANTHROPIC_API_KEY: str(""),
  MODEL_FAST: str("claude-haiku-4-5"),
  MODEL_DEEP: str("claude-opus-5-5"),

  GROQ_API_KEY: str(""),
  GROQ_BASE_URL: str("https://api.groq.com/openai/v1"),
  GROQ_MODEL_FAST: str("qwen/qwen3.8-27b"),
  GROQ_MODEL_DEEP: str("openai/gpt-oss-120b"),
  GROQ_OUTPUT_MODE: str("auto"),
  GROQ_TPM: num(7000),
  GROQ_MAX_WAIT_MS: num(2000),
  // V1.1: a whole capture (phone upload, capture box) may wait this long for the free tier's budget; the live mic keeps GROQ_MAX_WAIT_MS
  GROQ_CAPTURE_MAX_WAIT_MS: num(25000),
  GROQ_MAX_REQUESTS_PER_DAY: num(900),

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

  // --- V1 remote access: the passcode for phones and other clients, and the public URL they reach this server on
  SYNAPSE_PASSCODE: str(""),
  // set by `TUNNEL=1` automatically; set it yourself for a named tunnel or a reverse proxy (https://synapse.example.com)
  PUBLIC_URL: str(""),
  // V1.1: auto (or 1) = Tailscale Funnel, else ngrok's static domain, else a cloudflared quick tunnel; or name one; 0 = none
  TUNNEL: str("0"),
  // ngrok's free static domain (e.g. calm-otter-1234.ngrok-free.app), used when TUNNEL=ngrok or auto finds no Tailscale
  NGROK_DOMAIN: str(""),
  // serve the built web app (apps/web/dist) from this server: one origin for pages, API and WebSocket. auto = when the build exists
  SERVE_WEB: str("auto"),

  GITHUB_TOKEN: str(""),
  GITHUB_REPO: str(""),
  // V1: a throwaway repo for real issue tests; seeds the profile's default repo the first time
  GITHUB_SANDBOX_REPO: str(""),
  // the GitHub REST API (tests point it at a recording fake)
  GITHUB_API_URL: str("https://api.github.com"),
  JIRA_BASE_URL: str(""),
  JIRA_EMAIL: str(""),
  JIRA_API_TOKEN: str(""),
  JIRA_PROJECT_KEY: str(""),
});

/** Every environment variable the server reads (a test keeps .env.example in step with this list). */
export const ENV_KEYS: readonly string[] = Object.keys(EnvSchema.shape);

export type LlmProvider = "anthropic" | "groq";
export type GroqOutputMode = "auto" | "json_schema" | "json_object" | "text";

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
    mode: "client" | "proxy" | "mock" | "local";
    apiKey: string;
    base: string;
    languages: string[];
    tokenTtlSecs: number;
    finalTimeoutMs: number;
    standbyMaxAgeMs: number;
    warmupIntervalS: number;
  };
  /** on-device speech to text */
  stt: {
    model: string;
    dtype: string;
    preload: boolean;
    fallback: boolean;
    cacheDir: string;
    /** the engine behind the on-server speech endpoints when they are not in local-only mode: on-device Whisper, or Sarvam's cloud API */
    provider: "whisper" | "sarvam";
    sarvam: { apiKey: string; baseUrl: string; model: string; languageCode: string };
  };
  llm: {
    mode: "live" | "mock";
    /** the provider that serves the live paths; "mock" whenever `mode` is "mock" */
    provider: LlmProvider | "mock";
    /** a key exists for the effective provider */
    hasKey: boolean;
    /** the Anthropic key (the Groq key lives in `groq.apiKey`) */
    apiKey: string;
    /** model ids of the effective provider (Anthropic's MODEL_FAST/DEEP unless the provider is groq) */
    fast: string;
    deep: string;
    groq: {
      apiKey: string;
      baseUrl: string;
      fast: string;
      deep: string;
      outputMode: GroqOutputMode;
      /** tokens-per-minute budget the client paces itself to (the free tier allows 8,000) */
      tpm: number;
      /** longest a call may queue for the budget before it degrades to the local cortex */
      maxWaitMs: number;
      /** the capture path (one call per capture) waits longer: a phone upload has no live listener to keep up with */
      captureMaxWaitMs: number;
      /** local safety cap on requests per UTC day (the free tier allows 1,000); 0 = no cap */
      maxRequestsPerDay: number;
    };
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
  /** V1 remote access */
  remote: { passcode: string; publicUrl: string; tunnel: TunnelSetting; ngrokDomain: string; serveWeb: "auto" | "on" | "off"; webDist: string };
  proactive: { autonomyLevel: number; recurringN: number; recurringWindowMin: number; minGapMs: number };
  integrations: {
    github: { token: string; repo: string; sandboxRepo: string; apiBase: string };
    jira: { baseUrl: string; email: string; token: string; projectKey: string };
  };
}

const SARVAM_LANGUAGES = new Set(["hi", "bn", "kn", "ml", "mr", "od", "pa", "ta", "te", "en", "gu", "as", "ur", "ne", "kok", "ks", "sd", "sa", "sat", "mni", "brx", "mai", "doi"]);

/** the language_code Sarvam is asked for: forced by SARVAM_LANGUAGE, else the single language WISPR_LANGUAGES names (as an -IN code), else detection */
function sarvamLanguage(asked: string, languages: string[]): string {
  if (asked && asked.toLowerCase() !== "auto") return asked;
  const only = languages.length === 1 ? ((languages[0] as string).toLowerCase().split("-")[0] as string) : "";
  return SARVAM_LANGUAGES.has(only) ? only + "-IN" : "unknown";
}

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  const raw = EnvSchema.parse({ ...process.env, ...overrides });

  // WISPR_MODE=sarvam is the on-server speech endpoint ("local") with Sarvam's cloud API behind it
  const wisprAsked = raw.WISPR_MODE === "sarvam" ? "local" : raw.WISPR_MODE;
  const wisprMode = (["client", "proxy", "mock", "local"].includes(wisprAsked) ? wisprAsked : "mock") as Config["wispr"]["mode"];
  const sarvamReady = (raw.WISPR_MODE === "sarvam" || raw.STT_PROVIDER.toLowerCase() === "sarvam") && Boolean(raw.SARVAM_API_KEY);
  // client/proxy need a key to mint tokens or to proxy; without one we fall back to mock. "local" needs no key at all.
  const effectiveWispr = wisprMode === "client" || wisprMode === "proxy" ? (raw.WISPR_API_KEY ? wisprMode : "mock") : wisprMode;
  const preloadAsked = raw.STT_PRELOAD.toLowerCase();

  // LLM provider. LLM_MODE=mock and LOCAL_ONLY always win. An explicit LLM_PROVIDER=anthropic keeps the original
  // semantics (live even without a key: the call fails with an auth error and degrades). `auto` and `groq` need a key.
  const llmWanted = raw.LLM_MODE === "live" ? "live" : "mock";
  const asked = raw.LLM_PROVIDER.toLowerCase();
  let provider: LlmProvider | "mock" = "mock";
  if (llmWanted === "live" && !raw.LOCAL_ONLY) {
    if (asked === "anthropic") provider = "anthropic";
    else if (asked === "groq") provider = raw.GROQ_API_KEY ? "groq" : "mock";
    else provider = raw.ANTHROPIC_API_KEY ? "anthropic" : raw.GROQ_API_KEY ? "groq" : "mock";
  }
  const effectiveLlm: "live" | "mock" = provider === "mock" ? "mock" : "live";
  const groqMode = (["auto", "json_schema", "json_object", "text"].includes(raw.GROQ_OUTPUT_MODE) ? raw.GROQ_OUTPUT_MODE : "auto") as GroqOutputMode;

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
    stt: {
      model: raw.STT_MODEL,
      dtype: raw.STT_DTYPE,
      preload: ["1", "true", "yes", "on"].includes(preloadAsked) || (!["0", "false", "no", "off"].includes(preloadAsked) && effectiveWispr === "local"),
      fallback: raw.STT_FALLBACK,
      provider: sarvamReady ? "sarvam" : "whisper",
      sarvam: {
        apiKey: raw.SARVAM_API_KEY,
        baseUrl: raw.SARVAM_BASE_URL.endsWith("/") ? raw.SARVAM_BASE_URL.slice(0, -1) : raw.SARVAM_BASE_URL,
        model: raw.SARVAM_STT_MODEL,
        languageCode: sarvamLanguage(raw.SARVAM_LANGUAGE, raw.WISPR_LANGUAGES.split(",").map((s) => s.trim()).filter(Boolean)),
      },
      // the (non-sensitive) model cache is shared with the embeddings
      cacheDir: raw.MODEL_CACHE_DIR ? path.resolve(REPO_ROOT, raw.MODEL_CACHE_DIR) : path.resolve(REPO_ROOT, "data"),
    },
    llm: {
      mode: effectiveLlm,
      provider,
      hasKey: provider === "groq" ? Boolean(raw.GROQ_API_KEY) : Boolean(raw.ANTHROPIC_API_KEY),
      apiKey: raw.ANTHROPIC_API_KEY,
      fast: provider === "groq" ? raw.GROQ_MODEL_FAST : raw.MODEL_FAST,
      deep: provider === "groq" ? raw.GROQ_MODEL_DEEP : raw.MODEL_DEEP,
      groq: {
        apiKey: raw.GROQ_API_KEY,
        baseUrl: raw.GROQ_BASE_URL.replace(/\/$/, ""),
        fast: raw.GROQ_MODEL_FAST,
        deep: raw.GROQ_MODEL_DEEP,
        outputMode: groqMode,
        tpm: Math.max(500, raw.GROQ_TPM),
        maxWaitMs: Math.max(0, raw.GROQ_MAX_WAIT_MS),
        captureMaxWaitMs: Math.max(0, raw.GROQ_CAPTURE_MAX_WAIT_MS),
        maxRequestsPerDay: Math.max(0, Math.round(raw.GROQ_MAX_REQUESTS_PER_DAY)),
      },
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
    remote: {
      passcode: raw.SYNAPSE_PASSCODE,
      publicUrl: raw.PUBLIC_URL,
      tunnel: parseTunnelSetting(raw.TUNNEL),
      ngrokDomain: raw.NGROK_DOMAIN.trim(),
      serveWeb: ["1", "true", "on", "yes"].includes(raw.SERVE_WEB.toLowerCase()) ? "on" : ["0", "false", "off", "no"].includes(raw.SERVE_WEB.toLowerCase()) ? "off" : "auto",
      webDist: path.resolve(REPO_ROOT, "apps/web/dist"),
    },
    proactive: {
      autonomyLevel: Math.max(0, Math.min(3, Math.round(raw.AUTONOMY_LEVEL))),
      recurringN: Math.max(2, Math.round(raw.RECURRING_N)),
      recurringWindowMin: Math.max(1, raw.RECURRING_WINDOW_MIN),
      minGapMs: Math.max(0, raw.SUGGESTION_MIN_GAP_S) * 1000,
    },
    integrations: {
      github: { token: raw.GITHUB_TOKEN, repo: raw.GITHUB_REPO, sandboxRepo: raw.GITHUB_SANDBOX_REPO, apiBase: raw.GITHUB_API_URL.replace(/\/$/, "") },
      jira: {
        baseUrl: raw.JIRA_BASE_URL.replace(/\/$/, ""),
        email: raw.JIRA_EMAIL,
        token: raw.JIRA_API_TOKEN,
        projectKey: raw.JIRA_PROJECT_KEY,
      },
    },
  };
}
