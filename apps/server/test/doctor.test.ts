import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatChecks, runDoctor, type DoctorDeps } from "../src/cli/doctor-lib";
import { startFakeSarvam, type FakeSarvam } from "./fake-sarvam";

/**
 * `pnpm doctor`: every check, each state it can report, and the rule that no key value ever appears in its output.
 * Sarvam runs against the faithful fake (real HTTP, real multipart); Groq and GitHub get a scripted fetch.
 */

const SARVAM_KEY = "sk_test_sarvam_key_not_real";
const GROQ_KEY = "gsk_doctor_test_key_000000000000";
const GH_TOKEN = "ghp_doctor_test_token_0000000000";

let sarvam: FakeSarvam;
beforeAll(async () => {
  sarvam = await startFakeSarvam({ key: SARVAM_KEY });
});
afterAll(async () => {
  await sarvam.close();
});

type Route = (url: string, init?: RequestInit) => Response | undefined;
const scriptedFetch = (...routes: Route[]): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(sarvam.url)) return fetch(input, init); // the fake Sarvam is a real server
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;

const groqOk: Route = (url, init) =>
  url.endsWith("/models") ? (new Headers(init?.headers).get("authorization") === `Bearer ${GROQ_KEY}` ? Response.json({ data: [{ id: "qwen/qwen3.8-27b" }] }) : Response.json({ error: { message: "Invalid API Key" } }, { status: 401 })) : undefined;
const ghOk: Route = (url, init) =>
  url === "https://api.github.com/user" ? (new Headers(init?.headers).get("authorization") === `Bearer ${GH_TOKEN}` ? Response.json({ login: "octo-sayed" }) : Response.json({ message: "Bad credentials" }, { status: 401 })) : undefined;

const deps = (o: Partial<DoctorDeps> = {}, env: Record<string, string> = {}): DoctorDeps => ({
  env: {
    SARVAM_API_KEY: SARVAM_KEY,
    SARVAM_BASE_URL: sarvam.url,
    GROQ_API_KEY: GROQ_KEY,
    GITHUB_TOKEN: GH_TOKEN,
    SYNAPSE_PASSCODE: "correct horse",
    ...env,
  },
  envFilePresent: true,
  nodeVersion: "v26.4.0",
  exec: async (cmd) => (cmd === "pnpm" ? { ok: true, stdout: "10.28.2\n" } : cmd === "cloudflared" ? { ok: true, stdout: "cloudflared version 2026.9.3\n" } : { ok: false, stdout: "" }),
  fetch: scriptedFetch(groqOk, ghOk),
  modelCached: () => true,
  ...o,
});

const byName = (checks: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(checks.map((c) => [c.name, c]));

describe("pnpm doctor", () => {
  it("everything configured: every check passes, and the output never contains a key", async () => {
    sarvam.reset({ kind: "ok", transcript: "", language_code: "en-IN" });
    const checks = await runDoctor(deps());
    expect(checks.filter((c) => c.status !== "ok").map((c) => c.name)).toEqual([]);
    const c = byName(checks);
    expect(c["GitHub"]?.detail).toContain("@octo-sayed");
    // the Sarvam check really sent one second of 16 kHz audio through SarvamStt
    expect(sarvam.requests.at(-1)?.wav).toMatchObject({ rate: 16000, channels: 1, samples: 16000 });
    const out = formatChecks(checks);
    for (const secret of [SARVAM_KEY, GROQ_KEY, GH_TOKEN, "correct horse"]) expect(out).not.toContain(secret);
    expect(out).toContain("✅");
  });

  it("an old Node or the wrong pnpm major fails with a fix", async () => {
    const c = byName(await runDoctor(deps({ nodeVersion: "v22.11.0", exec: async (cmd) => ({ ok: cmd === "pnpm", stdout: "9.15.0" }) })));
    expect(c["Node"]?.status).toBe("fail");
    expect(c["Node"]?.fix).toMatch(/22\.12/);
    expect(c["pnpm"]?.status).toBe("fail");
    expect(c["Node"]?.status).toBe("fail");
    expect(c["cloudflared"]?.status).toBe("warn");
    expect(c["cloudflared"]?.fix).toBe("brew install cloudflared");
  });

  it("no .env and no keys: warnings that say what each missing piece is for, never failures", async () => {
    const checks = await runDoctor(deps({ envFilePresent: false }, { SARVAM_API_KEY: "", GROQ_API_KEY: "", SYNAPSE_PASSCODE: "", GITHUB_TOKEN: "" }));
    const c = byName(checks);
    expect(c[".env"]?.status).toBe("warn");
    expect(c[".env"]?.fix).toContain("cp .env.example .env");
    expect(c["Sarvam"]?.status).toBe("warn");
    expect(c["Groq"]?.status).toBe("warn");
    expect(c["Passcode"]?.status).toBe("warn");
    expect(c["GitHub"]?.status).toBe("warn"); // no GITHUB_TOKEN and gh says nothing
    expect(checks.some((x) => x.status === "fail")).toBe(false);
  });

  it("a rejected Sarvam key is a failure (and a quota problem only a warning)", async () => {
    const bad = byName(await runDoctor(deps({}, { SARVAM_API_KEY: "sk_wrong" })));
    expect(bad["Sarvam"]?.status).toBe("fail");
    expect(bad["Sarvam"]?.detail).toMatch(/403|rejected/);
    sarvam.reset({ kind: "status", status: 429, code: "insufficient_quota_error" });
    const quota = byName(await runDoctor(deps()));
    expect(quota["Sarvam"]?.status).toBe("warn");
  });

  it("a rejected Groq key fails; an unreachable Groq only warns", async () => {
    const bad = byName(await runDoctor(deps({}, { GROQ_API_KEY: "gsk_wrong" })));
    expect(bad["Groq"]?.status).toBe("fail");
    const down = byName(await runDoctor(deps({ fetch: scriptedFetch(ghOk) })));
    expect(down["Groq"]?.status).toBe("warn");
  });

  it("GitHub: falls back to `gh auth token`, and a token GitHub refuses fails", async () => {
    const viaGh = byName(
      await runDoctor(
        deps({ exec: async (cmd, args) => (cmd === "gh" && args.join(" ") === "auth token" ? { ok: true, stdout: `${GH_TOKEN}\n` } : { ok: true, stdout: cmd === "pnpm" ? "10.1.0" : "x" }) }, { GITHUB_TOKEN: "" }),
      ),
    );
    expect(viaGh["GitHub"]?.status).toBe("ok");
    expect(viaGh["GitHub"]?.detail).toContain("gh auth token");
    const refused = byName(await runDoctor(deps({}, { GITHUB_TOKEN: "ghp_revoked" })));
    expect(refused["GitHub"]?.status).toBe("fail");
  });

  it("embedding model: cached passes; not cached but reachable warns with the warm-up command", async () => {
    const reachable: Route = (url) => (url.startsWith("https://huggingface.co/") ? new Response("{}", { status: 200 }) : undefined);
    const c = byName(await runDoctor(deps({ modelCached: () => false, fetch: scriptedFetch(groqOk, ghOk, reachable) })));
    expect(c["Embedding model"]?.status).toBe("warn");
    expect(c["Embedding model"]?.fix).toContain("warm-models");
    const offline = byName(await runDoctor(deps({ modelCached: () => false })));
    expect(offline["Embedding model"]?.status).toBe("fail");
  });

  it("EMBEDDINGS=hash needs no model at all", async () => {
    const c = byName(await runDoctor(deps({ modelCached: () => false }, { EMBEDDINGS: "hash" })));
    expect(c["Embedding model"]?.status).toBe("ok");
  });
});
