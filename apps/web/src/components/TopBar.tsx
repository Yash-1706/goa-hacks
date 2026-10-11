import { memo, useEffect, useState } from "react";
import { statusPill } from "@/lib/inbox";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { usePrivacy } from "@/state/privacy";

/**
 * Top bar (V1): the name and ONE status pill (Listening / Paused / Offline / Not connected / Ready). Engine, model and
 * latency details live in Settings.
 */
export const TopBar = memo(function TopBar({ title = "Synapse" }: { title?: string }) {
  const paused = usePrivacy((s) => s.paused);
  const conn = useConnection((s) => s.status);
  const listening = useAudioUi((s) => s.state === "listening" || s.state === "hearing");
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  const pill = statusPill({ paused, conn, listening, online });
  const tone = pill === "Listening" ? "live" : pill === "Ready" ? "ok" : pill === "Paused" ? "warn" : "bad";
  return (
    <header className="topbar topbar--v1">
      <div className="topbar__brand">
        <span className="topbar__name">{title}</span>
      </div>
      <span className={`status-pill status-pill--${tone}`} role="status" aria-live="polite">
        <span className="status-pill__dot" aria-hidden />
        {pill}
      </span>
    </header>
  );
});
