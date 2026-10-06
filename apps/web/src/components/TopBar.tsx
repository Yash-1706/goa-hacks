import { memo } from "react";
import { Square } from "lucide-react";
import { Orb, useOrbView } from "@/components/Orb";
import { AsideChip, ConnectionChip, DeviceChips, LatencyChip, PrivacyShield } from "@/components/chips";
import { plural } from "@/lib/format";
import { controller } from "@/runtime";
import { useAudioUi } from "@/state/audio";
import { useThoughts } from "@/state/thoughts";

/**
 * Top bar (every screen but Pocket): the orb, what it is doing right now, and the live status chips:
 * connection, devices, privacy shield, latency, asides filtered.
 */
export const TopBar = memo(function TopBar({ title = "Synapse" }: { title?: string }) {
  const view = useOrbView();
  const thoughts = useThoughts((s) => s.order.length);
  const running = useAudioUi((s) => s.state === "listening" || s.state === "hearing");

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <div className="topbar__orbwrap">
          <Orb size={44} />
        </div>
        <div className="topbar__titles">
          <div className="topbar__title">
            <span className="grad-text">{title}</span>
          </div>
          <div className="topbar__status" aria-live="polite">
            <b>{view.label}</b>
            {thoughts > 0 ? <span> · {plural(thoughts, "thought")}</span> : null}
          </div>
        </div>
        {running ? (
          <button type="button" className="btn btn-sm hide-sm" onClick={() => void controller.stop()} title="End the session: Synapse writes a brief of what you said, and the mic is released">
            <Square size={11} fill="currentColor" /> End session
          </button>
        ) : null}
      </div>
      <div className="topbar__chips">
        <AsideChip />
        <LatencyChip />
        <DeviceChips />
        <PrivacyShield />
        <ConnectionChip />
      </div>
    </header>
  );
});
