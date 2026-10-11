import { memo, useMemo } from "react";
import { AnimatePresence } from "motion/react";
import { Link } from "react-router-dom";
import { Battery, BatteryCharging, BatteryLow, Car, Compass, Footprints, Hand, Leaf, Monitor, Pause, Play, ShieldCheck, Smartphone, Square, Sun, TriangleAlert, WifiOff } from "lucide-react";
import type { Activity } from "@synapse/shared";
import { Orb, useOrbView } from "@/components/Orb";
import { ThoughtCard } from "@/components/card/ThoughtCard";
import { activityLabel } from "@/lib/format";
import { controller } from "@/runtime";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { usePrivacy } from "@/state/privacy";
import { useThoughts } from "@/state/thoughts";

const ACTIVITY_ICON: Record<Activity, typeof Hand> = { walking: Footprints, vehicle: Car, still: Hand, desk: Monitor, unknown: Compass };

const ActivityChip = memo(function ActivityChip() {
  const a = useAudioUi((s) => s.activity);
  const kind = useConnection((s) => s.deviceKind);
  const shown: Activity = a === "unknown" && kind === "desk" ? "desk" : a;
  const Icon = ACTIVITY_ICON[shown];
  return (
    <span className="pk-chip" title="Coarse activity from the motion sensors. Only this label ever leaves the phone; raw motion is never stored or sent.">
      <Icon size={16} aria-hidden />
      <span>{activityLabel(shown)}</span>
    </span>
  );
});

const BatteryChip = memo(function BatteryChip() {
  const b = useAudioUi((s) => s.battery);
  if (!b) {
    return (
      <span className="pk-chip pk-chip--dim" title="This browser does not report the battery level (Safari / iOS / Firefox). Use the Eco switch by hand.">
        <Battery size={16} aria-hidden />
        <span>no battery API</span>
      </span>
    );
  }
  const pct = Math.round(b.level * 100);
  const Icon = b.charging ? BatteryCharging : pct < 20 ? BatteryLow : Battery;
  return (
    <span className="pk-chip" style={{ color: pct < 20 && !b.charging ? "var(--danger)" : undefined }} title={`Battery ${pct}%${b.charging ? ", charging" : ""}`}>
      <Icon size={16} aria-hidden />
      <span className="tnum">{pct}%</span>
    </span>
  );
});

function WakeChip() {
  const on = useAudioUi((s) => s.wakeLock);
  return (
    <span className={`pk-chip${on ? "" : " pk-chip--dim"}`} title={on ? "Screen Wake Lock held: the screen stays on while listening (phones cannot capture audio with the screen off)." : "The screen may turn off when you are not listening."}>
      <Sun size={16} aria-hidden />
      <span>{on ? "screen on" : "screen may sleep"}</span>
    </span>
  );
}

function EcoToggle() {
  const mode = useAudioUi((s) => s.mode);
  const auto = useAudioUi((s) => s.autoEco);
  const eco = mode === "eco";
  return (
    <div className="pk-eco">
      <span className="pk-eco__icon" data-on={eco} aria-hidden>
        <Leaf size={18} />
      </span>
      <div className="pk-eco__text">
        <div className="pk-eco__t">
          Eco mode {auto ? <span className="chip chip-tint chip-ok">auto: low battery</span> : null}
        </div>
        <div className="pk-eco__d">{eco ? "Stricter voice detection, bigger audio bursts: less radio, less heat." : "Full responsiveness. Turn on to save battery."}</div>
      </div>
      <button type="button" role="switch" aria-checked={eco} aria-label="Eco mode" className="switch" onClick={() => controller.toggleEco()} />
    </div>
  );
}

/**
 * Pocket (phone-first): a giant breathing orb that is the start / pause / resume control, the last few cards
 * read-only, the activity, battery and Eco controls. Designed to be glanced at, not used.
 */
export default function Pocket() {
  const view = useOrbView();
  const connStatus = useConnection((s) => s.status);
  const paused = usePrivacy((s) => s.paused);
  const pauseLatency = usePrivacy((s) => s.pauseLatencyMs);
  const order = useThoughts((s) => s.order);
  const engine = useAudioUi((s) => s.engine);
  const running = useAudioUi((s) => s.state === "listening" || s.state === "hearing");
  const insecure = typeof window !== "undefined" && window.isSecureContext === false;
  const ids = useMemo(() => [...order].reverse().slice(0, 3), [order]);

  const big = paused || view.mode === "paused";
  const primary = big || view.mode === "off";
  return (
    <div className="pk">
      <h1 className="sr-only">Synapse Pocket</h1>
      <header className="pk-head">
        <span className="pk-brand">
          <Smartphone size={15} aria-hidden /> Synapse
        </span>
        <span className="pk-conn" data-ok={connStatus === "open"}>
          {connStatus === "open" ? <ShieldCheck size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />} {connStatus === "open" ? "connected" : connStatus === "auth" ? "pair needed" : "offline"}
        </span>
      </header>

      {insecure && engine !== "text" ? (
        <div className="pk-warn" role="alert">
          <TriangleAlert size={16} aria-hidden />
          <span>
            Phones need <b>HTTPS</b> to open the microphone. Start the web app with <span className="mono">HTTPS=1 pnpm dev:web</span> and open the <span className="mono">https://</span> address. Typed input works meanwhile.
          </span>
        </div>
      ) : null}

      <section className="pk-orb" aria-label="Listening control">
        <Orb size="min(64vw, 17.5rem)" big glyph />
        <div className="pk-orb__label" aria-live="polite">
          {view.label}
        </div>
        <div className="pk-orb__hint">{view.mode === "off" ? "Tap the orb to start. Audio is never stored." : big ? "Nothing is being captured." : view.action === "pause" ? "Tap to pause memory." : ""}</div>
        <div className="pk-chips">
          <ActivityChip />
          <BatteryChip />
          <WakeChip />
        </div>
      </section>

      <div className="pk-actions">
        <button
          type="button"
          className={`pk-pause${primary ? " pk-pause--resume" : ""}`}
          onClick={() => void (big ? controller.resume() : view.mode === "off" ? controller.start() : controller.pauseMemory())}
          disabled={view.mode === "starting"}
        >
          {primary ? <Play size={22} /> : <Pause size={22} />}
          <span>{big ? "Resume listening" : view.mode === "off" ? "Start listening" : "Pause memory"}</span>
        </button>
        {pauseLatency !== null && big ? <div className="pk-latency tnum">Mic released {pauseLatency} ms after the phrase.</div> : null}
        {running ? (
          <button type="button" className="btn btn-ghost btn-sm pk-end" onClick={() => void controller.stop()}>
            <Square size={11} fill="currentColor" /> End session and get a brief
          </button>
        ) : null}
      </div>

      <EcoToggle />

      <section className="pk-cards" aria-label="Latest cards">
        <div className="eyebrow pk-cards__t">Latest</div>
        <div className="pk-cards__list">
          <AnimatePresence initial={false} mode="popLayout">
            {ids.map((id) => (
              <ThoughtCard key={id} id={id} compact />
            ))}
          </AnimatePresence>
          {ids.length === 0 ? <p className="pk-cards__empty">What you say lands here as small cards. They are read-only: open the Desk to edit or push them.</p> : null}
        </div>
        <Link to="/app" className="btn btn-ghost btn-sm" style={{ justifySelf: "center" }}>
          Open the Desk
        </Link>
      </section>
    </div>
  );
}
