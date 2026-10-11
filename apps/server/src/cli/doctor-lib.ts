import { SarvamError, SarvamStt } from "../wispr/sarvam";
import { STT_SAMPLE_RATE } from "../wispr/local-stt";

/* ============================================================================
 * `pnpm doctor`: one command that says what is missing and how to fix it. Every check is a pure function of its
 * dependencies (environment, a fetch, a process runner), so each state is testable without a network or a key.
 * No key value is ever printed: a check reports whether a key works, never what it is.
 * ========================================================================== */

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** one line the user can act on */
  fix?: string;
}

export interface DoctorDeps {
  /** process environment merged with .env */
  env: Record<string, string | undefined>;
  envFilePresent: boolean;
  nodeVersion: string;
  exec: (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;
  fetch: typeof fetch;
  /** is the embedding model already in the local cache */
  modelCached: (model: string) => boolean;
}

const TIMEOUT_MS = 8000;
const MIN_NODE: [number, number] = [22, 12];

const ok = (name: string, detail: string): Check => ({ name, status: "ok", detail });
const warn = (name: string, detail: string, fix: string): Check => ({ name, status: "warn", detail, fix });
const fail = (name: string, detail: string, fix: string): Check => ({ name, status: "fail", detail, fix });

function checkNode(version: string): Check {
  const [maj = 0, min = 0] = version.replace(/^v/, "").split(".").map(Number);
  const good = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  return good ? ok("Node", version) : fail("Node", `${version} is too old`, `install Node ${MIN_NODE.join(".")} or newer (brew install node)`);
}

async function checkPnpm(d: DoctorDeps): Promise<Check> {
  const r = await d.exec("pnpm", ["-v"]);
  const v = r.stdout.trim();
  if (!r.ok || !v) return fail("pnpm", "not found", "corepack enable && corepack prepare pnpm@10 --activate");
  return v.startsWith("10.") ? ok("pnpm", v) : fail("pnpm", `${v} (this repo pins pnpm 10)`, "corepack prepare pnpm@10 --activate");
}

function checkEnvFile(d: DoctorDeps): Check {
  return d.envFilePresent ? ok(".env", "present") : warn(".env", "missing: the app runs in mock mode", "cp .env.example .env, then add your keys");
}

async function checkSarvam(d: DoctorDeps): Promise<Check> {
  const key = d.env.SARVAM_API_KEY;
  if (!key) return warn("Sarvam", "no SARVAM_API_KEY: phone audio cannot be transcribed", "add SARVAM_API_KEY to .env (dashboard.sarvam.ai)");
  const stt = new SarvamStt({
    apiKey: key,
    baseUrl: d.env.SARVAM_BASE_URL || "https://api.sarvam.ai",
    model: d.env.SARVAM_STT_MODEL || "saaras:v4",
    languageCode: "unknown",
    timeoutMs: TIMEOUT_MS,
    fetchImpl: d.fetch,
  });
  const silence = new Float32Array(STT_SAMPLE_RATE); // one second of silence: the cheapest real request there is
  try {
    await stt.transcribe(silence);
    return ok("Sarvam", "key accepted (1 s of silence transcribed)");
  } catch (err) {
    if (err instanceof SarvamError) {
      if (err.status === 401 || err.status === 403) return fail("Sarvam", `key rejected (HTTP ${err.status})`, "check SARVAM_API_KEY in .env");
      return warn("Sarvam", `HTTP ${err.status}${err.code ? ` ${err.code}` : ""}`, "check your Sarvam quota and plan");
    }
    return warn("Sarvam", "could not reach api.sarvam.ai", "check the network, then run pnpm doctor again");
  } finally {
    silence.fill(0);
  }
}

async function checkGroq(d: DoctorDeps): Promise<Check> {
  const key = d.env.GROQ_API_KEY;
  if (!key) return warn("Groq", "no GROQ_API_KEY: cards come from the offline cortex", "add GROQ_API_KEY to .env (free key at console.groq.com/keys)");
  const base = (d.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  try {
    const res = await d.fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return ok("Groq", "key accepted");
    if (res.status === 401 || res.status === 403) return fail("Groq", `key rejected (HTTP ${res.status})`, "check GROQ_API_KEY in .env");
    return warn("Groq", `HTTP ${res.status}`, "try again in a minute");
  } catch {
    return warn("Groq", "could not reach api.groq.com", "check the network, then run pnpm doctor again");
  }
}

async function checkEmbeddings(d: DoctorDeps): Promise<Check> {
  if (d.env.EMBEDDINGS === "hash") return ok("Embedding model", "EMBEDDINGS=hash (lexical fallback, no model needed)");
  const model = d.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
  if (d.modelCached(model)) return ok("Embedding model", `${model} cached`);
  try {
    const res = await d.fetch(`https://huggingface.co/${model}/resolve/main/config.json`, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return warn("Embedding model", `${model} not cached yet; it downloads on first start`, "pnpm --filter @synapse/server warm-models");
  } catch {
    /* fall through */
  }
  return fail("Embedding model", `${model} is not cached and huggingface.co is unreachable`, "connect to the internet once and run pnpm --filter @synapse/server warm-models");
}

async function checkGithub(d: DoctorDeps): Promise<Check> {
  let token = d.env.GITHUB_TOKEN;
  let via = "GITHUB_TOKEN";
  if (!token) {
    const gh = await d.exec("gh", ["auth", "token"]).catch(() => ({ ok: false, stdout: "" }));
    if (gh.ok && gh.stdout.trim()) {
      token = gh.stdout.trim();
      via = "gh auth token";
    }
  }
  if (!token) return warn("GitHub", "no token: issues open as prefilled links instead", "gh auth login (or set GITHUB_TOKEN in .env)");
  try {
    const res = await d.fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "synapse-doctor" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as { login?: string };
      return ok("GitHub", `@${j.login ?? "?"} (token from ${via})`);
    }
    return fail("GitHub", `token from ${via} rejected (HTTP ${res.status})`, via === "gh auth token" ? "gh auth refresh" : "replace GITHUB_TOKEN in .env");
  } catch {
    return warn("GitHub", "could not reach api.github.com", "check the network, then run pnpm doctor again");
  }
}

async function checkCloudflared(d: DoctorDeps): Promise<Check> {
  const r = await d.exec("cloudflared", ["--version"]).catch(() => ({ ok: false, stdout: "" }));
  const v = r.stdout.match(/\d{4}\.\d+\.\d+/)?.[0];
  return r.ok ? ok("cloudflared", v ?? "installed") : warn("cloudflared", "not installed: the phone cannot reach this Mac over 4G", "brew install cloudflared");
}

function checkPasscode(d: DoctorDeps): Check {
  const p = d.env.SYNAPSE_PASSCODE ?? "";
  if (!p) return warn("Passcode", "SYNAPSE_PASSCODE is not set: the tunnel will refuse to start", "add SYNAPSE_PASSCODE=<a passphrase you can type on your phone> to .env");
  if (p.length < 6) return warn("Passcode", "SYNAPSE_PASSCODE is shorter than 6 characters", "use a longer passphrase: the URL is public");
  return ok("Passcode", "set");
}

export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const head = [checkNode(d.nodeVersion), await checkPnpm(d), checkEnvFile(d)];
  const rest = await Promise.all([checkSarvam(d), checkGroq(d), checkEmbeddings(d), checkGithub(d), checkCloudflared(d)]);
  return [...head, ...rest, checkPasscode(d)];
}

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${ICON[c.status]} ${c.name.padEnd(width)}  ${c.detail}${c.fix ? `\n   ${" ".repeat(width)}  → ${c.fix}` : ""}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : warns ? `Ready, with ${warns} warning(s): the missing parts run on mocks.` : "All good.");
  return lines.join("\n");
}
