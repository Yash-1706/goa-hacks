import { useState } from "react";
import { KeyRound, Monitor, Smartphone, Unplug } from "lucide-react";
import { useFetch } from "@/hooks/useFetch";
import { ApiError, api } from "@/net/api";
import { toast } from "@/state/notices";
import { useConnection } from "@/state/connection";
import { useDevices } from "@/state/devices";

/** Host-only pairing: the 6-digit code a phone needs once, the devices connected now, and a way to revoke tokens. */
export function Pairing() {
  const code = useFetch((s) => api.pairing(s), []);
  const devices = useDevices((s) => s.devices);
  const selfId = useConnection((s) => s.deviceId);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const hostOnly = code.error && /host|403|forbidden/i.test(code.error);
  const revoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.revokePairings();
      toast.success("All device tokens revoked. Phones must enter the pairing code again.");
      setConfirm(false);
    } catch (err) {
      toast.warn(err instanceof ApiError ? err.message : `Could not revoke: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass panel" aria-labelledby="pv-pair-h">
      <div className="section__title" id="pv-pair-h" style={{ marginTop: 0 }}>
        <KeyRound size={15} /> Devices and pairing
      </div>
      <div className="pv-pair">
        <div>
          <div className="eyebrow">Pairing code</div>
          {code.data ? (
            <>
              <div className="pv-code mono tnum" aria-label={`Pairing code ${code.data.code.split("").join(" ")}`}>
                {code.data.code.split("").map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
              </div>
              <p className="ab__hint">
                {code.data.requirePairing ? "A phone on the venue Wi-Fi enters this once, then holds a token. Localhost never needs it." : "Pairing is switched off on this server (REQUIRE_PAIRING=0)."}
              </p>
            </>
          ) : hostOnly ? (
            <p className="ab__hint">The pairing code is only shown on the laptop that runs Synapse, so a stranger on the Wi-Fi cannot read it.</p>
          ) : code.loading ? (
            <span className="shimmer" style={{ display: "block", width: "12rem", height: "2.4rem" }} />
          ) : (
            <p className="ab__hint">Unavailable: {code.error}</p>
          )}
          {code.data ? (
            confirm ? (
              <span className="confirm" style={{ marginTop: "0.5rem", display: "inline-flex" }}>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void revoke()}>
                  <Unplug size={13} /> Revoke all paired devices
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn-sm" style={{ marginTop: "0.5rem" }} onClick={() => setConfirm(true)} title="Invalidates every device token (the code itself stays)">
                <Unplug size={13} /> Revoke paired devices…
              </button>
            )
          ) : null}
        </div>

        <div>
          <div className="eyebrow">Connected now</div>
          <ul className="pv-devs">
            {devices.map((d) => {
              const Icon = d.kind === "pocket" ? Smartphone : Monitor;
              return (
                <li key={d.deviceId}>
                  <Icon size={15} aria-hidden />
                  <b>{d.name}</b>
                  {d.deviceId === selfId ? <span className="chip chip-tint chip-cyan">this device</span> : null}
                  <span className={`dot ${d.speaking ? "dot-cyan dot-pulse" : d.listening ? "dot-ok" : ""}`} aria-hidden />
                  <span className="ab__hint">{d.speaking ? "speaking" : d.listening ? "listening" : "connected"}</span>
                </li>
              );
            })}
            {devices.length === 0 ? <li className="ab__hint">No devices reported yet.</li> : null}
          </ul>
          <p className="ab__hint" style={{ marginTop: "0.5rem" }}>
            <Smartphone size={11} style={{ display: "inline", verticalAlign: "-1px" }} /> On a phone: open <span className="mono">https://&lt;laptop-ip&gt;:5173/pocket</span> (start the web app with <span className="mono">HTTPS=1</span>).
          </p>
        </div>
      </div>
    </section>
  );
}
