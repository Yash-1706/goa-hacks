import { AnimatePresence, motion } from "motion/react";
import { Play, ShieldOff } from "lucide-react";
import { describePause, formatClock, plural } from "@/lib/format";
import { controller } from "@/runtime";
import { useConnection } from "@/state/connection";
import { useDevices } from "@/state/devices";
import { usePrivacy } from "@/state/privacy";

/**
 * The privacy moment of the demo: when memory is paused the Desk says so loudly. Mic released (with the
 * measured latency), what was forgotten, and the deliberate tap that is the only way back.
 */
export function PausedBanner() {
  const paused = usePrivacy((s) => s.paused);
  const at = usePrivacy((s) => s.pausedAt);
  const by = usePrivacy((s) => s.pausedBy);
  const via = usePrivacy((s) => s.pausedVia);
  const purged = usePrivacy((s) => s.lastPurged);
  const latency = usePrivacy((s) => s.pauseLatencyMs);
  const selfId = useConnection((s) => s.deviceId);
  const devices = useDevices((s) => s.devices);
  const how = describePause({ by, via, selfId, devices });

  return (
    <AnimatePresence initial={false}>
      {paused ? (
        <motion.div
          key="paused"
          className="paused-banner"
          role="status"
          aria-live="assertive"
          initial={{ opacity: 0, height: 0, y: -12 }}
          animate={{ opacity: 1, height: "auto", y: 0 }}
          exit={{ opacity: 0, height: 0, y: -12 }}
          transition={{ type: "spring", stiffness: 380, damping: 36 }}
        >
          <div className="paused-banner__in">
            <span className="paused-banner__icon" aria-hidden>
              <ShieldOff size={20} />
            </span>
            <div className="paused-banner__text">
              <b>Memory paused{at ? ` at ${formatClock(at)}` : ""}.</b> Nothing is being captured or remembered{how ? ` (paused ${how})` : ""}. The microphone is released on every device.
            </div>
            <div className="paused-banner__chips">
              {latency !== null ? (
                <span className="chip chip-tint chip-cyan tnum" title="End of the pause phrase → microphone released">
                  mic released {latency} ms after you said it
                </span>
              ) : null}
              {purged && purged.count > 0 ? <span className="chip chip-tint chip-danger tnum">{plural(purged.count, "recent thought")} forgotten</span> : null}
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void controller.resume()}>
              <Play size={13} /> Resume listening
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
