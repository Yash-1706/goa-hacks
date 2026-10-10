import type { ServerMessage } from "@synapse/shared";
import type { Clock } from "../clock";
import type { Config } from "../config";
import { redact } from "../gate/redact";
import { log } from "../log";
import type { MemoryStore } from "../memory/store";
import { LIMITS } from "../thresholds";
import type { LocalStt, LocalSttAuth } from "./local-stt";

/* ============================================================================
 * Wispr Flow API plumbing (TRD §5.5). Contract verified against api-docs.wisprflow.ai.
 *   mint a short-lived CLIENT token (the browser then streams audio straight to Wispr, so audio
 *   never touches this server), keep the connection warm, and assemble the personalization context
 *   (self-healing dictionary + the last few fragments).
 * Privacy rules: never send screenshot / content_text / content_html; conversation is capped at 6
 * redacted fragments; the API key never leaves this process.
 *
 * On-device engine: the same token message can point the browser at this machine instead (mode "local", see local-stt.ts):
 * WISPR_MODE=local, local-only mode while Wispr is configured, or (opt-in STT_FALLBACK) when Wispr cannot be reached.
 * ========================================================================== */

type TokenMsg = Extract<ServerMessage, { type: "wispr.token" }>;
type ContextMsg = Extract<ServerMessage, { type: "wispr.context" }>;

export class WisprService {
  private cache = new Map<string, { token: string; expiresAt: number; mintedAt: number }>();
  private warmTimer?: ReturnType<typeof setInterval>;
  lastWarm?: { at: number; ok: boolean; ms: number };

  constructor(
    private d: {
      cfg: Config;
      store: MemoryStore;
      clock: Clock;
      anyListening: () => boolean;
      /** the on-device engine, when this setup can use one (WISPR_MODE=local or client) */
      local?: { stt: LocalStt; auth: LocalSttAuth; isLocalOnly: () => boolean };
    },
  ) {}

  /** the speech engine in effect right now ("local" also while local-only mode overrides a configured Wispr) */
  get mode(): "client" | "proxy" | "mock" | "local" {
    return this.usesLocal() ? "local" : this.d.cfg.wispr.mode;
  }

  /** the browser is being pointed at the on-device engine: WISPR_MODE=local, or local-only mode with a Wispr setup */
  usesLocal(): boolean {
    const { cfg, local } = this.d;
    if (!local) return false;
    return cfg.wispr.mode === "local" || (cfg.wispr.mode === "client" && local.isLocalOnly());
  }

  /** the engine behind the on-server speech endpoints right now: Sarvam's cloud API only when it is configured AND local-only mode is off */
  sttProvider(): "whisper" | "sarvam" {
    const { cfg, local } = this.d;
    return cfg.stt.provider === "sarvam" && !local?.isLocalOnly() ? "sarvam" : "whisper";
  }

  /** the on-device endpoints may take audio: it is in use, or the opt-in fallback is on */
  localAllowed(): boolean {
    return Boolean(this.d.local) && (this.usesLocal() || (this.d.cfg.wispr.mode === "client" && this.d.cfg.stt.fallback));
  }

  /** a token for the on-device endpoints (relative URLs: the browser resolves them against the origin it loaded the app from) */
  private localToken(deviceId: string, note?: string): TokenMsg {
    const { cfg, clock, local } = this.d;
    const { token, expiresAt } = (local as NonNullable<typeof local>).auth.mint(deviceId, cfg.wispr.tokenTtlSecs * 1000, clock.now());
    return { type: "wispr.token", mode: "local", provider: this.sttProvider(), token, expiresAt, wsUrl: "/local-stt/client_ws", restUrl: "/local-stt/client_api", ...(note ? { note } : {}) };
  }

  private authHeader(): string {
    return `Bearer ${this.d.cfg.wispr.apiKey.replace(/^Bearer\s+/i, "")}`;
  }

  /** Client WebSocket / REST endpoints the browser should use. */
  endpoints(): { wsUrl: string; restUrl: string } {
    const base = this.d.cfg.wispr.base;
    return { wsUrl: `${base.replace(/^http/, "ws")}/client_ws`, restUrl: `${base}/client_api` };
  }

  /**
   * A client only asks for a token when its own copy is missing, near expiry or was REJECTED, so serving an
   * old cached one risks handing back the very token Wispr just refused. Reuse is limited to a short burst
   * window (two sockets starting together); `force` always mints a fresh token.
   */
  static readonly REUSE_WINDOW_MS = 20_000;

  async token(deviceId: string, force = false): Promise<TokenMsg> {
    const { cfg, clock } = this.d;
    if (cfg.wispr.mode === "mock") return { type: "wispr.token", mode: "mock" };
    if (this.usesLocal()) return this.localToken(deviceId);
    if (cfg.wispr.mode === "proxy") return { type: "wispr.token", mode: "proxy", error: "proxy mode is not implemented in this build; use WISPR_MODE=client" };

    const cached = this.cache.get(deviceId);
    const now = clock.now();
    if (!force && cached && now - cached.mintedAt < WisprService.REUSE_WINDOW_MS && cached.expiresAt - now > cfg.wispr.tokenTtlSecs * 1000 * 0.5) {
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
        return this.fallbackToken(deviceId, detail) ?? { type: "wispr.token", mode: "client", error: detail };
      }
      const j = (await res.json()) as { access_token: string; expires_in: number };
      const expiresAt = now + (j.expires_in ?? cfg.wispr.tokenTtlSecs) * 1000;
      this.cache.set(deviceId, { token: j.access_token, expiresAt, mintedAt: now });
      return { type: "wispr.token", mode: "client", token: j.access_token, expiresAt, ...this.endpoints() };
    } catch (err) {
      const msg = `Wispr token request failed: ${(err as Error).message}`;
      log.warn("wispr", msg);
      return this.fallbackToken(deviceId, msg) ?? { type: "wispr.token", mode: "client", error: msg };
    }
  }

  /** STT_FALLBACK: Wispr cannot be used, so the same token request is answered with the on-device engine (and says why) */
  private fallbackToken(deviceId: string, why: string): TokenMsg | null {
    if (!this.d.local || !this.d.cfg.stt.fallback) return null;
    log.warn("wispr", "using on-device speech instead of Wispr");
    return this.localToken(deviceId, `Wispr unavailable (${why}): on-device speech is active`);
  }

  /** Pre-allocates server resources on Wispr's side so the first utterance is not cold. */
  async warmup(): Promise<void> {
    const { cfg, clock } = this.d;
    if (cfg.wispr.mode !== "client" || this.usesLocal()) return; // local-only mode: not even a warm-up leaves the machine
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
