import { memo, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ShieldCheck } from "lucide-react";
import { Orb, useOrbView } from "@/components/Orb";
import { ThoughtCard } from "@/components/card/ThoughtCard";
import { useThoughts } from "@/state/thoughts";

/** Shown while there are no cards: an intentional empty state that is also the start button. */
export function EmptyHero() {
  const view = useOrbView();
  const paused = view.mode === "paused";
  const listening = view.mode === "listening" || view.mode === "hearing";
  const title = paused ? "Paused." : "Think out loud.";
  const sub = paused
    ? "The microphone is released. Tap the orb when you want Synapse back."
    : listening
      ? "Synapse is listening."
      : view.mode === "starting"
        ? "Warming up…"
        : view.mode === "degraded" || view.mode === "error"
          ? view.label
          : "Tap the orb. Synapse listens for fragments, not commands.";
  return (
    <div className="orb-hero hero" role="status">
      <Orb size="clamp(110px, 20vh, 190px)" big />
      <div>
        <div className="orb-hero__title">{title}</div>
        <div className="orb-hero__sub">{sub}</div>
        <div className="orb-hero__fine">
          <ShieldCheck size={13} aria-hidden /> Audio is never stored · draft-first · forgets by default
        </div>
      </div>
    </div>
  );
}

/** The living cards: newest on top, morphing in place as fragments and model tokens arrive. */
const PAGE = 40;

export const CardsColumn = memo(function CardsColumn() {
  const order = useThoughts((s) => s.order);
  const [limit, setLimit] = useState(PAGE);
  const ids = useMemo(() => [...order].reverse(), [order]);
  const shown = ids.slice(0, limit);
  return (
    <div className="cards">
      {ids.length === 0 ? <EmptyHero /> : null}
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((id) => (
          <ThoughtCard key={id} id={id} />
        ))}
      </AnimatePresence>
      {ids.length > limit ? (
        <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "center" }} onClick={() => setLimit((n) => n + PAGE)}>
          Show {Math.min(PAGE, ids.length - limit)} older cards ({ids.length - limit} hidden)
        </button>
      ) : null}
    </div>
  );
});
