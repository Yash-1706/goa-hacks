import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { useAuth } from "@/state/auth";

/**
 * Passcode sign-in (V1): shown when the server needs a session (always through the tunnel). One passphrase, typed once per
 * device; the session lasts 90 days and lives in an HttpOnly cookie the page never sees.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn?: () => void }) {
  const login = useAuth((s) => s.login);
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);
  const [passcode, setPasscode] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (error) {
      setPasscode("");
      input.current?.focus();
    }
  }, [error]);

  return (
    <div className="pair" role="dialog" aria-modal="true" aria-labelledby="login-title">
      <form
        className="pair__card glass-strong"
        onSubmit={async (e) => {
          e.preventDefault();
          if (passcode && (await login(passcode))) onSignedIn?.();
        }}
      >
        <div style={{ display: "grid", placeItems: "center" }}>
          <img src="/icon.svg" alt="" width={56} height={56} style={{ borderRadius: 16 }} />
        </div>
        <h1 id="login-title" style={{ margin: "1rem 0 0.3rem", fontSize: "1.35rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
          Sign in to Synapse
        </h1>
        <p style={{ margin: "0 0 1rem", color: "var(--dim)", fontSize: "0.9rem" }}>Enter the passcode you set on your Mac (SYNAPSE_PASSCODE). You stay signed in for 90 days.</p>
        <label className="sr-only" htmlFor="passcode">
          Passcode
        </label>
        <input
          id="passcode"
          ref={input}
          className="input"
          type="password"
          autoComplete="current-password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          style={{ width: "100%" }}
        />
        {error ? (
          <p role="alert" style={{ margin: "0.6rem 0 0", color: "var(--danger)", fontSize: "0.85rem" }}>
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={!passcode || busy} style={{ width: "100%", marginTop: "0.9rem", justifyContent: "center" }}>
          <KeyRound size={16} /> {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
