import { create } from "zustand";
import { tunnelHeaders } from "@/net/tunnel";

/* ============================================================================
 * Passcode sign-in (V1). On the LAN, loopback and paired devices are trusted as before; through the tunnel every device signs
 * in once with SYNAPSE_PASSCODE (a 90-day HttpOnly cookie the page never sees). "offline" means the server could not be
 * reached: the app still opens, so a phone can record into its queue with no network.
 * ========================================================================== */

export type AuthStatus = "checking" | "ok" | "needed" | "offline";

export interface AuthState {
  status: AuthStatus;
  passcodeSet: boolean;
  publicMode: boolean;
  error: string | null;
  busy: boolean;
  check: () => Promise<AuthStatus>;
  login: (passcode: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** an API call or upload answered 401: ask for the passcode */
  require: () => void;
}

export const useAuth = create<AuthState>()((set, get) => ({
  status: "checking",
  passcodeSet: false,
  publicMode: false,
  error: null,
  busy: false,

  check: async () => {
    try {
      const r = await fetch("/api/auth/status", { credentials: "same-origin", headers: tunnelHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { authenticated: boolean; passcodeSet: boolean; publicMode: boolean };
      const status: AuthStatus = j.authenticated ? "ok" : "needed";
      set({ status, passcodeSet: j.passcodeSet, publicMode: j.publicMode });
      return status;
    } catch {
      set({ status: "offline" });
      return "offline";
    }
  },

  login: async (passcode) => {
    set({ busy: true, error: null });
    try {
      const r = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...tunnelHeaders() }, body: JSON.stringify({ passcode }) });
      if (r.ok) {
        set({ status: "ok", busy: false });
        return true;
      }
      const reason =
        r.status === 429
          ? `Too many tries. Wait ${Math.ceil(Number(r.headers.get("retry-after") ?? "900") / 60)} minutes.`
          : r.status === 503
            ? "No passcode is set on the server. Add SYNAPSE_PASSCODE to .env and restart."
            : "That passcode is not right.";
      set({ busy: false, error: reason });
      return false;
    } catch {
      set({ busy: false, error: "Cannot reach your Synapse server. Check the network and try again." });
      return false;
    }
  },

  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: tunnelHeaders() }).catch(() => undefined);
    set({ status: get().passcodeSet ? "needed" : "ok" });
  },

  require: () => set({ status: "needed" }),
}));
