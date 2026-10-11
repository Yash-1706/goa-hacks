import { createHmac, randomBytes } from "node:crypto";
import type { Clock } from "../clock";
import { log } from "../log";
import { safeEqual } from "../memory/crypto";
import type { Db } from "../memory/db";

/* ============================================================================
 * Passcode auth for remote access (V1). The LAN keeps its pairing code; once a public URL is active (the cloudflared tunnel,
 * or PUBLIC_URL), every request reaches the server from loopback, so loopback stops meaning "this machine" and everything
 * except /api/health and the login needs a session.
 *
 *  - Session: an HttpOnly, SameSite=Lax cookie holding `v1.<issued>.<nonce>.<hmac>`, valid 90 days. The HMAC key is derived
 *    from a stored random secret AND the passcode, so changing SYNAPSE_PASSCODE ends every session.
 *  - Capture token: `syn_cap_<generation>_<hmac>`, a long-lived bearer accepted on POST /api/capture only (the iPhone
 *    Shortcut and Mac app). Rotating bumps the generation, which revokes the old token.
 *  - Login attempts are rate-limited per client address: 5 failures per 15 minutes, then 429 until the window passes.
 * ========================================================================== */

export const SESSION_COOKIE = "synapse_session";
const SESSION_TTL_MS = 90 * 24 * 3600_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;

export interface LoginResult {
  ok: boolean;
  status: number;
  setCookie?: string;
  retryAfterS?: number;
  error?: string;
}

export class Auth {
  private secret: Buffer;
  private fails = new Map<string, number[]>();
  private publicUrl: URL | null = null;

  constructor(
    private db: Db,
    private o: { passcode: string; publicUrl: string },
    private clock: Clock,
  ) {
    const saved = db.getSetting("auth_secret");
    this.secret = saved ? Buffer.from(saved, "base64") : randomBytes(32);
    if (!saved) db.setSetting("auth_secret", this.secret.toString("base64"));
    if (o.publicUrl) this.setPublicUrl(o.publicUrl);
  }

  /** a passcode is configured: sessions can be issued */
  get enabled(): boolean {
    return this.o.passcode.length > 0;
  }

  /** a public URL is active: loopback is no longer trusted and pairing codes are refused */
  get publicMode(): boolean {
    return this.publicUrl !== null;
  }

  /** exactly the active public URL's origin (the origin guard allows it and nothing else public) */
  get publicOrigin(): string | null {
    return this.publicUrl?.origin ?? null;
  }

  setPublicUrl(url: string | null): void {
    if (url === null || url === "") {
      this.publicUrl = null;
      return;
    }
    const u = new URL(url); // throws on garbage
    if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("a public URL must be https");
    this.publicUrl = u;
    log.info("auth", "public URL active: loopback is no longer trusted", { origin: u.origin });
  }

  // ------------------------------------------------------------------ session --

  login(passcode: string, ip: string, secure: boolean): LoginResult {
    if (!this.enabled) return { ok: false, status: 503, error: "SYNAPSE_PASSCODE is not set on the server" };
    const now = this.clock.now();
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) {
      const retryAfterS = Math.ceil((FAIL_WINDOW_MS - (now - (recent[0] as number))) / 1000);
      return { ok: false, status: 429, retryAfterS, error: "too many attempts" };
    }
    if (!safeEqual(this.digest("passcode", passcode), this.digest("passcode", this.o.passcode))) {
      recent.push(now);
      this.fails.set(ip, recent);
      log.warn("auth", "wrong passcode", { attempts: recent.length });
      return { ok: false, status: 401, error: "wrong passcode" };
    }
    this.fails.delete(ip);
    const issued = now.toString(36);
    const nonce = randomBytes(9).toString("base64url");
    const body = `v1.${issued}.${nonce}`;
    const value = `${body}.${this.sign("session", body)}`;
    return { ok: true, status: 200, setCookie: cookie(value, SESSION_TTL_MS / 1000, secure) };
  }

  logoutCookie(secure: boolean): string {
    return cookie("", 0, secure);
  }

  /** the Cookie header carries a valid, unexpired session */
  hasSession(cookieHeader: string | undefined): boolean {
    if (!this.enabled || !cookieHeader) return false;
    const value = readCookie(cookieHeader, SESSION_COOKIE);
    const m = value?.match(/^(v1\.([0-9a-z]+)\.[\w-]+)\.([\w-]+)$/);
    if (!m) return false;
    const [, body, issued, sig] = m as unknown as [string, string, string, string];
    if (!safeEqual(this.sign("session", body), sig)) return false;
    const age = this.clock.now() - parseInt(issued, 36);
    return age >= 0 && age < SESSION_TTL_MS;
  }

  // ------------------------------------------------------------ capture token --

  captureToken(): string {
    const gen = this.generation();
    return `syn_cap_${gen}_${this.sign("capture", String(gen))}`;
  }

  rotateCaptureToken(): void {
    this.db.setSetting("capture_token_gen", String(this.generation() + 1));
  }

  verifyCaptureToken(authorization: string | undefined): boolean {
    if (!this.enabled || !authorization) return false;
    const m = authorization.match(/^Bearer\s+syn_cap_(\d+)_([\w-]+)$/);
    if (!m) return false;
    return Number(m[1]) === this.generation() && safeEqual(this.sign("capture", m[1] as string), m[2] as string);
  }

  // ------------------------------------------------------------------ helpers --

  private generation(): number {
    return Number(this.db.getSetting("capture_token_gen") ?? "1") || 1;
  }

  /** keys are bound to the passcode: a new passcode invalidates every session and capture token */
  private sign(purpose: string, body: string): string {
    const key = createHmac("sha256", this.secret).update(`${purpose}|${this.o.passcode}`).digest();
    return createHmac("sha256", key).update(body).digest("base64url");
  }

  private digest(purpose: string, s: string): string {
    return createHmac("sha256", this.secret).update(`${purpose}|${s}`).digest("hex");
  }
}

function cookie(value: string, maxAgeS: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(maxAgeS)}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
