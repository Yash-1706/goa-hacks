import { memo, useMemo } from "react";
import { Pause, Play } from "lucide-react";
import { formatDayTime } from "@/lib/format";
import { SLIDER_MAX, type TimeAxis, axisToTime, isLiveSlider, tickBins, timeToAxis } from "@/lib/graph-time";
import { useGraphView } from "./view-store";

/* ============================================================================
 * Timeline scrubber: filters the graph to createdAt <= t. The slider is a log-compressed time axis (see
 * lib/graph-time), the thumb at the right end means LIVE, and the play button replays the memory growing.
 * ========================================================================== */

export interface SessionMark {
  id: string;
  createdAt: number;
  color: string;
  label: string;
}

interface TimelineProps {
  axis: TimeAxis;
  /** creation time of every node (for the activity ticks) */
  times: readonly number[];
  sessions: readonly SessionMark[];
  visible: number;
  total: number;
}

export const Timeline = memo(function Timeline({ axis, times, sessions, visible, total }: TimelineProps) {
  const live = useGraphView((s) => s.live);
  const t = useGraphView((s) => s.t);
  const playing = useGraphView((s) => s.playing);
  const { goLive, scrubTo, play, pause } = useGraphView.getState();

  const u = live ? 1 : timeToAxis(axis, t);
  const value = Math.round(u * SLIDER_MAX);
  const bins = useMemo(() => tickBins(axis, times, 96), [axis, times]);
  const marks = useMemo(() => sessions.map((s) => ({ ...s, u: timeToAxis(axis, s.createdAt) })), [axis, sessions]);

  const atStart = !live && u <= 0.001;
  const label = live ? "Live" : atStart ? "Before the first thought" : formatDayTime(t);
  const valueText = live ? `Live, ${visible} nodes` : `${label}, ${visible} of ${total} nodes`;

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value);
    if (isLiveSlider(v)) goLive();
    else scrubTo(axisToTime(axis, v / SLIDER_MAX));
  };

  return (
    <div className="gx-timeline glass-strong" role="group" aria-label="Memory timeline">
      <button
        type="button"
        className="gx-play"
        onClick={() => (playing ? pause() : play())}
        aria-pressed={playing}
        aria-label={playing ? "Pause the replay" : "Replay how memory grew"}
        title={playing ? "Pause" : "Replay how memory grew"}
        disabled={total === 0}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>

      <div className="gx-track" style={{ ["--p" as string]: `${(u * 100).toFixed(2)}%` }}>
        <div className="gx-ticks" aria-hidden>
          {bins.map((b, i) => (
            <i key={i} style={{ height: `${b > 0 ? 24 + b * 76 : 10}%`, opacity: b > 0 ? 0.3 + b * 0.55 : 0.14 }} />
          ))}
        </div>
        <div className="gx-marks" aria-hidden>
          {marks.map((m) => (
            <i key={m.id} style={{ left: `${(m.u * 100).toFixed(2)}%`, background: m.color, boxShadow: `0 0 8px ${m.color}` }} title={m.label} />
          ))}
        </div>
        <input
          type="range"
          className="gx-range"
          min={0}
          max={SLIDER_MAX}
          step={1}
          value={value}
          onChange={onChange}
          disabled={total === 0}
          aria-label="Timeline. Drag to see the graph as it was, the right end is live."
          aria-valuetext={valueText}
        />
      </div>

      <div className="gx-time" aria-hidden>
        <span className="gx-time__label tnum">{label}</span>
        <span className="gx-time__sub tnum">
          {visible}
          {!live && visible !== total ? ` / ${total}` : ""} nodes
        </span>
      </div>

      <button type="button" className="gx-live" onClick={goLive} aria-pressed={live} disabled={total === 0} title="Jump to now: new memories appear as they are made">
        <span className="gx-live__dot" aria-hidden />
        Live
      </button>
    </div>
  );
});
