import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Mic, Pause, TriangleAlert } from "lucide-react";
import { deriveOrb, type OrbView } from "@/lib/orb";
import { controller } from "@/runtime";
import { useAudioUi, useLevel } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { usePrivacy } from "@/state/privacy";
import { useSuggestions } from "@/state/suggestions";
import { anyAnalyzing, useThoughts } from "@/state/thoughts";

/** true for a few seconds after a suggestion / echo / brief arrived: the orb pulses softly */
function useSuggestingPulse(): boolean {
  const last = useSuggestions((s) => s.lastPushAt);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!last) return;
    setOn(true);
    const id = setTimeout(() => setOn(false), 9000);
    return () => clearTimeout(id);
  }, [last]);
  return on;
}

/** Everything the orb needs, as one derived view (also used by Pocket and the top bar for captions). */
export function useOrbView(): OrbView {
  const audioState = useAudioUi((s) => s.state);
  const engine = useAudioUi((s) => s.engine);
  const speaking = useAudioUi((s) => s.speaking);
  const resumeHint = useAudioUi((s) => s.resumeHint);
  const degraded = useAudioUi((s) => s.degraded);
  const detail = useAudioUi((s) => s.detail);
  const serverPaused = usePrivacy((s) => s.paused);
  const conn = useConnection((s) => s.status);
  const analyzing = useThoughts((s) => anyAnalyzing(s.byId));
  const suggesting = useSuggestingPulse();
  return useMemo(
    () =>
      deriveOrb({
        audioState,
        serverPaused,
        conn,
        analyzing,
        suggesting,
        engine,
        resumeHint,
        speaking,
        detail,
        degraded: degraded ?? undefined,
      }),
    [audioState, serverPaused, conn, analyzing, suggesting, engine, resumeHint, speaking, detail, degraded],
  );
}

export interface OrbProps {
  /** CSS length, e.g. 56 (px) or "min(70vw, 300px)" */
  size?: number | string;
  big?: boolean;
  className?: string;
  /** show the mic / pause glyph inside (off, paused, error) */
  glyph?: boolean;
  /** override what a tap does */
  onActivate?: () => void;
  /** hide the glyph at small sizes etc. */
  title?: string;
}

/**
 * The Orb: the hero of the product and the one control for listening. Tap = start / pause / resume.
 * Scale and glow follow the microphone level through the --lvl CSS variable, updated straight on the DOM
 * (no React re-render at 15 Hz).
 */
export const Orb = memo(function Orb({ size = 56, big = false, className, glyph = true, onActivate, title }: OrbProps) {
  const view = useOrbView();
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = (lvl: number): void => node.style.setProperty("--lvl", lvl.toFixed(3));
    apply(useLevel.getState().level);
    return useLevel.subscribe((s) => apply(s.level));
  }, []);

  const Glyph = view.mode === "paused" ? Pause : view.mode === "error" ? TriangleAlert : view.mode === "off" ? Mic : null;
  const style = { "--size": typeof size === "number" ? `${size}px` : size } as CSSProperties;
  const label = `${view.label}. ${view.actionLabel}.`;

  return (
    <button
      ref={ref}
      type="button"
      className={`orb ${className ?? ""}`}
      style={style}
      data-mode={view.mode}
      data-analyzing={view.analyzing}
      data-suggesting={view.suggesting}
      data-big={big}
      aria-label={label}
      aria-pressed={view.mode === "listening" || view.mode === "hearing"}
      title={title ?? label}
      onClick={() => (onActivate ? onActivate() : void controller.toggle())}
    >
      <span className="orb__halo" aria-hidden />
      <span className="orb__ripple" aria-hidden />
      <span className="orb__ripple" aria-hidden />
      <span className="orb__spinner" aria-hidden />
      <span className="orb__ring" aria-hidden />
      <span className="orb__breath" aria-hidden>
        <span className="orb__core" />
      </span>
      {glyph && Glyph ? (
        <span className="orb__glyph" aria-hidden>
          <Glyph size={big ? 44 : typeof size === "number" ? Math.round(size * 0.36) : 20} strokeWidth={2} />
        </span>
      ) : null}
    </button>
  );
});
