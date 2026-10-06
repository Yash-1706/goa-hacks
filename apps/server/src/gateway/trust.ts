import { createHmac, randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "../config";
import type { Db } from "../memory/db";
import { safeEqual } from "../memory/crypto";

/* ============================================================================
 * Device trust (TRD §10.5). Localhost is trusted. Any other device (a phone on the venue Wi-Fi)
 * must enter the 6-digit pairing code once, then holds an HMAC device token.
 * ========================================================================== */

export const isLoopback = (ip: string | undefined): boolean =>
  !ip || ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" || ip === "localhost";

export class Trust {
  readonly pairingCode: string;
  private secret: Buffer;

  constructor(
    db: Db,
    private cfg: Config,
  ) {
    const saved = db.getSetting("pair_secret");
    this.secret = saved ? Buffer.from(saved, "base64") : randomBytes(32);
    if (!saved) db.setSetting("pair_secret", this.secret.toString("base64"));
    this.pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  }

  /** Client address. Behind the Vite dev proxy every request is loopback, so trust x-forwarded-for from loopback only. */
  clientIp(req: Pick<IncomingMessage, "socket" | "headers">): string {
    const remote = req.socket.remoteAddress;
    if (isLoopback(remote)) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return remote ?? "";
  }

  tokenFor(deviceId: string): string {
    return createHmac("sha256", this.secret).update(deviceId).digest("hex");
  }

  verifyToken(deviceId: string, token: string | undefined): boolean {
    return Boolean(token) && safeEqual(this.tokenFor(deviceId), token as string);
  }

  /** Revoke every issued device token. */
  rotate(db: Db): void {
    this.secret = randomBytes(32);
    db.setSetting("pair_secret", this.secret.toString("base64"));
  }

  check(ip: string, deviceId: string, token?: string, code?: string): { ok: boolean; token?: string; reason?: string } {
    if (!this.cfg.privacy.requirePairing) return { ok: true };
    if (isLoopback(ip)) return { ok: true };
    if (this.verifyToken(deviceId, token)) return { ok: true };
    if (code && safeEqual(code.trim(), this.pairingCode)) return { ok: true, token: this.tokenFor(deviceId) };
    return { ok: false, reason: code ? "wrong pairing code" : "pairing code required" };
  }
}
