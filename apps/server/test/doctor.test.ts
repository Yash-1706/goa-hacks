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
    SYNAPSE_PASSCODE: "correct horse battery",
    ...env,
  },
  envFilePresent: true,
  nodeVersion: "v26.4.0",
  exec: macExec(),
  fetch: scriptedFetch(groqOk, ghOk, healthOk),
  modelCached: () => true,
  platform: "darwin",
  uid: 501,
  publicUrl: () => ({ url: TS_URL, kind: "tailscale", temporary: false }),
  ...o,
});

/** a Mac set up the V1.1 way: Tailscale signed in with Funnel approved, the launchd service running, no sleep on AC power */
const TS_URL = "https://mac.tail0000.ts.net";
function macExec(o: { funnel?: boolean; tailscale?: boolean; ngrok?: boolean; launchd?: "running" | "missing"; acSleep?: number } = {}): DoctorDeps["exec"] {
  const { funnel = true, tailscale = true, ngrok = false, launchd = "running", acSleep = 0 } = o;
  return async (cmd, args) => {
    if (cmd === "pnpm") return { ok: true, stdout: "10.28.2\n" };
    if (cmd === "cloudflared") return { ok: true, stdout: "cloudflared version 2026.9.3\n" };
    if (cmd === "tailscale" && tailscale)
      return { ok: true, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail0000.ts.net.", CapMap: funnel ? { "https://tailscale.com/cap/funnel": [] } : {} } }) };
    if (cmd === "ngrok" && ngrok) return { ok: true, stdout: "ngrok version 3.20.0" };
    if (cmd === "launchctl") return launchd === "running" && args.join(" ") === "print gui/501/com.synapse.server" ? { ok: true, stdout: "com.synapse.server = {\n\tstate = running\n\tpid = 4242\n}" } : { ok: false, stdout: "" };
    if (cmd === "pmset") return { ok: true, stdout: `Battery Power:\n sleep                1\nAC Power:\n displaysleep         10\n sleep                ${acSleep}\n` };
    return { ok: false, stdout: "" };
  };
}
const healthOk: Route = (url) => (url === `${TS_URL}/api/health` ? Response.json({ ok: true }) : undefined);

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
    for (const secret of [SARVAM_KEY, GROQ_KEY, GH_TOKEN, "correct horse battery"]) expect(out).not.toContain(secret);
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

describe("pnpm doctor: the passcode guards a public URL (V1.1)", () => {
  it("warns under 12 characters or digits only; a long passphrase passes", async () => {
    const pass = async (p: string) => (await runDoctor(deps({}, { SYNAPSE_PASSCODE: p }))).find((c) => c.name === "Passcode")!;
    expect((await pass("12345678")).status).toBe("warn");
    expect((await pass("123456789012345")).status).toBe("warn"); // long, but digits only
    expect((await pass("short words")).status).toBe("warn");
    expect(await pass("correct horse battery")).toMatchObject({ status: "ok" });
    expect(JSON.stringify(await pass("12345678"))).not.toContain("12345678");
  });
});

describe("pnpm doctor: the always-on Mac (V1.1)", () => {
  it("a fully set-up Mac: Funnel, reachable from outside, launchd running, no sleep on AC power", async () => {
    const c = byName(await runDoctor(deps()));
    expect(c["Tunnel"]).toMatchObject({ status: "ok" });
    expect(c["Tunnel"]?.detail).toMatch(/Tailscale Funnel.*stable/);
    expect(c["Reachable"]).toMatchObject({ status: "ok" });
    expect(c["Reachable"]?.detail).toContain(TS_URL);
    expect(c["Service"]?.detail).toMatch(/running/);
    expect(c["Sleep"]).toMatchObject({ status: "ok" });
  });

  it("Tunnel: Funnel not approved says how; nothing stable says the URL changes every restart; ngrok's static domain is stable", async () => {
    const notApproved = byName(await runDoctor(deps({ exec: macExec({ funnel: false }) })))["Tunnel"];
    expect(notApproved).toMatchObject({ status: "warn" });
    expect(notApproved?.fix).toMatch(/tailscale funnel 8787/);
    const none = byName(await runDoctor(deps({ exec: macExec({ tailscale: false }) })))["Tunnel"];
    expect(none?.status).toBe("warn");
    expect(none?.detail).toMatch(/cloudflared.*changes every/);
    const ngrok = byName(await runDoctor(deps({ exec: macExec({ tailscale: false, ngrok: true }) }, { NGROK_DOMAIN: "calm-otter.ngrok-free.app" })))["Tunnel"];
    expect(ngrok).toMatchObject({ status: "ok" });
    expect(ngrok?.detail).toMatch(/ngrok.*calm-otter/);
  });

  it("Reachable: no URL yet, or a URL that does not answer, warns with what to run", async () => {
    const none = byName(await runDoctor(deps({ publicUrl: () => null })))["Reachable"];
    expect(none).toMatchObject({ status: "warn" });
    expect(none?.fix).toMatch(/pnpm run (serve|service:install)/);
    const dead = byName(await runDoctor(deps({ fetch: scriptedFetch(groqOk, ghOk) })))["Reachable"];
    expect(dead).toMatchObject({ status: "warn" });
    expect(dead?.detail).toContain(TS_URL);
  });

  it("Service and Sleep: not installed and sleeping on AC power warn with the fix; neither is checked off macOS", async () => {
    const c = byName(await runDoctor(deps({ exec: macExec({ launchd: "missing", acSleep: 1 }) })));
    expect(c["Service"]).toMatchObject({ status: "warn", fix: "pnpm run service:install" });
    expect(c["Sleep"]).toMatchObject({ status: "warn" });
    expect(c["Sleep"]?.detail).toMatch(/1 min/);
    expect(c["Sleep"]?.fix).toMatch(/Prevent automatic sleeping/);
    const linux = byName(await runDoctor(deps({ platform: "linux" })));
    expect(linux["Service"]).toBeUndefined();
    expect(linux["Sleep"]).toBeUndefined();
  });
});
