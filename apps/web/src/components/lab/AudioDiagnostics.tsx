import { memo, useMemo, type ReactNode } from "react";
import { Activity, AudioLines, BatteryCharging, CircleAlert, Footprints, Leaf, Mic, Plug, Radar, Zap } from "lucide-react";
import { activityLabel, formatClockSeconds, formatMs } from "@/lib/format";
import { describeDiagnostics, noiseFloorText } from "@/lib/lab-diagnostics";
import { useAudioUi } from "@/state/audio";
import { Panel } from "./Panel";

/* Audio diagnostics: what the capture pipeline reports through onDiagnostic, plus the live engine state. The audio side
 * guarantees that diagnostics never carry transcript text, audio or URLs. A text-only (typed) engine reports none. */

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="lab-fact" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  off: "Off",
  starting: "Starting",
  listening: "Listening",
  hearing: "Hearing speech",
  paused: "Paused (mic released)",
  error: "Error",
};

export const AudioDiagnostics = memo(function AudioDiagnostics() {
  const state = useAudioUi((s) => s.state);
  const detail = useAudioUi((s) => s.detail);
  const engine = useAudioUi((s) => s.engine);
  const mode = useAudioUi((s) => s.mode);
  const autoEco = useAudioUi((s) => s.autoEco);
  const standby = useAudioUi((s) => s.standby);
  const noiseFloor = useAudioUi((s) => s.noiseFloor);
  const finalMs = useAudioUi((s) => s.lastFinalLatencyMs);
  const wakeLock = useAudioUi((s) => s.wakeLock);
  const activity = useAudioUi((s) => s.activity);
  const battery = useAudioUi((s) => s.battery);
  const degraded = useAudioUi((s) => s.degraded);
  const diagnostics = useAudioUi((s) => s.diagnostics);
  const lines = useMemo(() => describeDiagnostics(diagnostics, 12), [diagnostics]);

  const running = state === "listening" || state === "hearing";
  const engineText = engine === "mic" ? "Microphone + Silero VAD" : engine === "text" ? "Typed input" : "Not started";
  const standbyText = standby === "ready" ? "Ready" : standby === "connecting" ? "Connecting" : standby === "down" ? "Down" : engine === "mic" ? "–" : "n/a";

  return (
    <Panel
      id="lab-audio"
      icon={<AudioLines size={16} />}
      title="Audio diagnostics"
      sub="Live from the capture pipeline on this device: VAD, the standby socket to Wispr, fallbacks and the calibrated noise floor."
      badge={
        <span className={`lab-count${running ? " is-on" : ""}`}>
          <i className={`dot ${running ? "dot-ok dot-pulse" : ""}`} aria-hidden /> {STATE_TEXT[state] ?? state}
        </span>
      }
      className="lab-panel--audio"
    >
      {degraded ? (
        <p className="lab-degraded" role="status">
          <CircleAlert size={14} aria-hidden /> Degraded: {degraded}
        </p>
      ) : null}

      <dl className="lab-facts">
        <Fact label="Engine">
          <Mic size={13} aria-hidden /> {engineText}
        </Fact>
        <Fact label="VAD mode" title="Eco raises the VAD threshold, batches packets in bigger groups and runs an energy pre-gate. It switches on by itself below 30 % battery when not charging.">
          {mode === "eco" ? (
            <span className="lab-eco">
              <Leaf size={13} aria-hidden /> Eco{autoEco ? " · low battery" : ""}
            </span>
          ) : (
            "Normal"
          )}
        </Fact>
        <Fact label="Standby socket" title="One pre-authenticated Wispr socket is kept ready while listening, so speech never waits for a handshake.">
          <i className={`dot ${standby === "ready" ? "dot-ok" : standby === "down" ? "dot-warn" : standby === "connecting" ? "dot-cyan dot-pulse" : ""}`} aria-hidden /> {standbyText}
        </Fact>
        <Fact label="Noise floor" title="Median frame energy of the first ~2 s of quiet. Whispers are flagged below about three times this level.">
          {noiseFloor !== null ? <span className="tnum">{noiseFloorText(noiseFloor)}</span> : <span className="lab-dim">not calibrated yet</span>}
        </Fact>
        <Fact label="Commit → final" title="Time from the end of the utterance being committed to Wispr until its final text came back (latest fragment).">
          <Zap size={13} aria-hidden /> <span className="tnum">{finalMs !== null ? formatMs(finalMs) : "–"}</span>
        </Fact>
        <Fact label="Wake lock">
          <Plug size={13} aria-hidden /> {wakeLock ? "Held" : <span className="lab-dim">not held</span>}
        </Fact>
        <Fact label="Activity" title="A coarse label from motion sensors (phones) or 'desk'. Only the label ever leaves the device.">
          <Footprints size={13} aria-hidden /> {activityLabel(activity)}
        </Fact>
        <Fact label="Battery">
          <BatteryCharging size={13} aria-hidden />{" "}
          {battery ? (
            <span className="tnum">
              {Math.round(battery.level * 100)} %{battery.charging ? " · charging" : ""}
            </span>
          ) : (
            <span className="lab-dim">not exposed</span>
          )}
        </Fact>
      </dl>

      {state === "error" && detail ? (
        <p className="lab-degraded" role="alert">
          <CircleAlert size={14} aria-hidden /> {detail}
        </p>
      ) : null}

      <div className="lab-sub">
        <div className="lab-sub__head">
          <h3 className="lab-sub__title">
            <Radar size={14} aria-hidden /> Recent events
          </h3>
          <span className="lab-dim">newest first · no audio, no text</span>
        </div>
        {lines.length === 0 ? (
          <div className="empty lab-empty">
            <Activity size={20} aria-hidden />
            <p>{engine === "text" ? "Typed input has no capture pipeline, so there is nothing to report." : "No events yet. Start listening and the standby socket, calibration and any fallbacks show up here."}</p>
          </div>
        ) : (
          <ol className="lab-events lab-diag">
            {lines.map((l, i) => (
              <li key={`${l.at}-${i}`} className={`lab-diag__row lab-diag__row--${l.tone}`}>
                <span className="lab-diag__time tnum">{formatClockSeconds(l.at)}</span>
                <span className="lab-diag__kind">{l.label}</span>
                <span className="lab-diag__text">{l.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
});
