import { motion } from "motion/react";
import { Pause, Play, ShieldCheck, ShieldOff } from "lucide-react";
import { useOrbView } from "@/components/Orb";
import { describePause, formatClock } from "@/lib/format";
import { controller } from "@/runtime";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { useDevices } from "@/state/devices";
import { usePrivacy } from "@/state/privacy";

/**
 * The big pause / resume control of the Privacy Center. Pause releases the microphone, purges the trailing
 * window and stops capture on EVERY device. Resume is a deliberate tap (there is no voice path back).
 */
export function KillSwitch() {
  const paused = usePrivacy((s) => s.paused);
  const pausedAt = usePrivacy((s) => s.pausedAt);
  const pausedBy = usePrivacy((s) => s.pausedBy);
  const pausedVia = usePrivacy((s) => s.pausedVia);
  const selfId = useConnection((s) => s.deviceId);
  const devices = useDevices((s) => s.devices);
  const purged = usePrivacy((s) => s.lastPurged);
  const latency = usePrivacy((s) => s.pauseLatencyMs);
  const engine = useAudioUi((s) => s.engine);
  const view = useOrbView();

  const via = describePause({ by: pausedBy, via: pausedVia, selfId, devices });
  const listening = !paused && (view.mode === "listening" || view.mode === "hearing");

  return (
    <div className="pv-hero glass-strong" data-paused={paused}>
      <div className="pv-hero__main">
        <motion.button
          type="button"
          className="pv-kill"
          data-paused={paused}
          whileTap={{ scale: 0.96 }}
          onClick={() => void (paused ? controller.resume() : controller.pauseMemory())}
          aria-label={paused ? "Resume listening" : "Pause memory on all devices"}
          title={paused ? "Resume listening (a deliberate tap: the mic comes back on)" : "Pause memory: releases the mic, forgets the last 30 s, stops every device"}
        >
          <span className="pv-kill__ring" aria-hidden />
          <span className="pv-kill__core">{paused ? <Play size={34} /> : <Pause size={34} />}</span>
        </motion.button>
        <div className="pv-hero__text">
          <div className="eyebrow">{paused ? "Memory is paused" : listening ? "Listening" : "Mic idle"}</div>
          <h2 className="pv-hero__title">
            {paused ? "Nothing is being captured." : listening ? "Your mic is open. Audio is never stored." : "Nothing is being captured right now."}
          </h2>
          <p className="pv-hero__sub">
            {paused ? (
              <>
                Paused {pausedAt ? `at ${formatClock(pausedAt)} ` : ""}
                {via}. The microphone is released on every device
                {purged && purged.count > 0 ? `, and the last ${purged.count} thought${purged.count === 1 ? "" : "s"} were forgotten` : ""}. Tap resume when you want Synapse back.
              </>
            ) : (
              <>
                Say <b>&ldquo;pause memory&rdquo;</b> (or &ldquo;off the record&rdquo;) or press the button: the mic is released within a second on every device, the trailing 30 seconds are purged, and only a tap can bring it back.
              </>
            )}
          </p>
          <div className="pv-hero__chips">
            {paused ? (
              <span className="chip chip-tint chip-danger">
                <ShieldOff size={12} /> <span>mic released</span>
              </span>
            ) : (
              <span className="chip chip-tint chip-ok">
                <ShieldCheck size={12} /> <span>{engine === "text" ? "typed input: no microphone in use" : "visible state, always"}</span>
              </span>
            )}
            {latency !== null ? (
              <span className="chip chip-tint chip-cyan" title="End of the pause phrase → microphone released, measured on this device">
                <span className="tnum">mic released {latency} ms</span> <span>after the phrase</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
