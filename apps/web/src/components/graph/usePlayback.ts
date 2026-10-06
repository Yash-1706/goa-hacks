import { useEffect, useRef } from "react";
import { type TimeAxis, advancePlayback, axisToTime, playbackDuration, timeToAxis } from "@/lib/graph-time";
import { useGraphView } from "./view-store";

/**
 * Drives the replay time `t` while `playing`: the thumb advances along the (log-compressed) track at a
 * constant pace, the canvas follows through the view store, and reaching the end hands over to live.
 * Mounted by the screen, so leaving the screen stops the replay.
 */
export function usePlayback(axis: TimeAxis): void {
  const playing = useGraphView((s) => s.playing);
  const axisRef = useRef(axis);
  axisRef.current = axis;

  useEffect(() => {
    if (!playing) return;
    const view = useGraphView.getState();
    // resume from where the thumb is; from the end (or live) start over from an empty graph
    let u = view.live ? 1 : timeToAxis(axisRef.current, view.t);
    if (u >= 0.995) u = 0;
    useGraphView.setState({ live: false, t: axisToTime(axisRef.current, u) });
    const duration = playbackDuration(axisRef.current.events);
    let last = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const step = advancePlayback(u, Math.min(80, now - last), duration);
      last = now;
      u = step.u;
      if (step.done) {
        useGraphView.setState({ playing: false, live: true });
        return;
      }
      useGraphView.setState({ t: axisToTime(axisRef.current, u) });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}
