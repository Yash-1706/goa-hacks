import type { ServerMessage } from "@synapse/shared";
import type { Clock } from "../clock";
import type { Config } from "../config";
import { redact } from "../gate/redact";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import { LIMITS } from "../thresholds";

/* ============================================================================
 * Wispr Flow API plumbing (TRD §5.5). Contract verified against api-docs.wisprflow.ai.
 *   mint a short-lived CLIENT token (the browser then streams audio straight to Wispr, so audio
 *   never touches this server), keep the connection warm, and assemble the personalization context
 *   (self-healing dictionary + the last few fragments).
 * Privacy rules: never send screenshot / content_text / content_html; conversation is capped at 6
 * redacted fragments; the API key never leaves this process.
 * ========================================================================== */

type TokenMsg = Extract<ServerMessage, { type: "wispr.token" }>;
type ContextMsg = Extract<ServerMessage, { type: "wispr.context" }>;

export class WisprService {
  private cache = new Map<string, { token: string; expiresAt: number }>();
  private warmTimer?: ReturnType<typeof setInterval>;
  lastWarm?: { at: number; ok: boolean; ms: number };

  constructor(
    private d: { cfg: Config; store: MemoryStore; clock: Clock; anyListening: () => boolean },
  ) {}

  get mode(): "client" | "proxy" | "mock" {
    return this.d.cfg.wispr.mode;
  }

  private authHeader(): string {
    return `Bearer ${this.d.cfg.wispr.apiKey.replace(/^Bearer\s+/i, "")}`;
  }

  /** Client WebSocket / REST endpoints the browser should use. */
  endpoints(): { wsUrl: string; restUrl: string } {
    const base = this.d.cfg.wispr.base;
    return { wsUrl: `${base.replace(/^http/, "ws")}/client_ws`, restUrl: `${base}/client_api` };
  }

  async token(deviceId: string): Promise<TokenMsg> {
    const { cfg, clock } = this.d;
    if (cfg.wispr.mode === "mock") return { type: "wispr.token", mode: "mock" };
    if (cfg.wispr.mode === "proxy") return { type: "wispr.token", mode: "proxy", error: "proxy mode is not implemented in this build; use WISPR_MODE=client" };

    const cached = this.cache.get(deviceId);
    const now = clock.now();
    if (cached && cached.expiresAt - now > cfg.wispr.tokenTtlSecs * 1000 * 0.5) {
      return { type: "wispr.token", mode: "client", token: cached.token, expiresAt: cached.expiresAt, ...this.endpoints() };
    }
    try {
      const res = await fetch(`${cfg.wispr.base}/generate_access_token`, {
        method: "POST",
        headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: deviceId, duration_secs: cfg.wispr.tokenTtlSecs, metadata: { app: "synapse" } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const detail = res.status === 401 ? "Wispr rejected the API key (401)" : `Wispr token request failed (${res.status})`;
        log.warn("wispr", detail);
        return { type: "wispr.token", mode: "client", error: detail };
      }
      const j = (await res.json()) as { access_token: string; expires_in: number };
      const expiresAt = now + (j.expires_in ?? cfg.wispr.tokenTtlSecs) * 1000;
      this.cache.set(deviceId, { token: j.access_token, expiresAt });
      return { type: "wispr.token", mode: "client", token: j.access_token, expiresAt, ...this.endpoints() };
    } catch (err) {
      const msg = `Wispr token request failed: ${(err as Error).message}`;
      log.warn("wispr", msg);
      return { type: "wispr.token", mode: "client", error: msg };
    }
  }

  /** Pre-allocates server resources on Wispr's side so the first utterance is not cold. */
  async warmup(): Promise<void> {
    const { cfg, clock } = this.d;
    if (cfg.wispr.mode !== "client") return;
    const t0 = performance.now();
    try {
      const res = await fetch(`${cfg.wispr.base}/warmup_dash`, { headers: { Authorization: this.authHeader() }, signal: AbortSignal.timeout(5000) });
      this.lastWarm = { at: clock.now(), ok: res.ok, ms: Math.round(performance.now() - t0) };
      if (!res.ok) log.warn("wispr", `warm-up returned ${res.status}`);
    } catch (err) {
      this.lastWarm = { at: clock.now(), ok: false, ms: Math.round(performance.now() - t0) };
      log.warn("wispr", `warm-up failed: ${(err as Error).message}`);
    }
  }

  startWarmLoop(): void {
    if (this.d.cfg.wispr.mode !== "client") return;
    void this.warmup();
    this.warmTimer = setInterval(() => {
      if (this.d.anyListening()) void this.warmup();
    }, this.d.cfg.wispr.warmupIntervalS * 1000);
    this.warmTimer.unref?.();
  }

  stop(): void {
    if (this.warmTimer) clearInterval(this.warmTimer);
  }

  /** Personalization context for a device's next Wispr sessions (dictionary + recent fragments). */
  context(deviceId: string, sessionId?: string): ContextMsg {
    const { cfg, store } = this.d;
    const names = [cfg.user.firstName, ...cfg.user.team.map((m) => m.name)];
    const dictionary = [...new Set([...names, ...store.topDictionary(LIMITS.dictionaryTop)])].slice(0, LIMITS.dictionaryTop);
    const recent = [...store.frags.values()]
      .filter((f) => f.deviceId === deviceId && (!sessionId || f.sessionId === sessionId))
      .sort((a, b) => b.tStart - a.tStart)
      .slice(0, LIMITS.wisprConversation)
      .reverse();
    const counters: Record<string, number> = {};
    const map: Array<{ placeholder: string; original: string; kind: string }> = [];
    return {
      type: "wispr.context",
      dictionary,
      conversation: recent.map((f) => ({ role: "user" as const, content: redact(f.text, counters, map).text })),
      language: cfg.wispr.languages,
    };
  }
}
