import { useState, type ReactNode } from "react";
import { Layers, Sparkles, Waves } from "lucide-react";
import { AboutStrip } from "@/components/AboutStrip";
import { CardsColumn } from "@/components/CardsColumn";
import { FragmentStream } from "@/components/FragmentStream";
import { KeyboardInput } from "@/components/KeyboardInput";
import { PausedBanner } from "@/components/PausedBanner";
import { SynapseRail } from "@/components/rail/SynapseRail";
import { useIsNarrow } from "@/hooks/useMedia";
import { plural } from "@/lib/format";
import { useStream } from "@/state/stream";
import { useSuggestions } from "@/state/suggestions";
import { useThoughts } from "@/state/thoughts";

function Column({ icon, title, meta, children, foot, className = "" }: { icon: ReactNode; title: string; meta?: ReactNode; children: ReactNode; foot?: ReactNode; className?: string }) {
  return (
    <section className={`col ${className}`} aria-label={title}>
      <header className="col__head">
        <span className="col__icon" aria-hidden>
          {icon}
        </span>
        <h2 className="col__title">{title}</h2>
        {meta ? <span className="col__meta tnum">{meta}</span> : null}
      </header>
      <div className="col__scroll">{children}</div>
      {foot ? <div className="col__foot">{foot}</div> : null}
    </section>
  );
}

type Tab = "cards" | "stream" | "rail";

/**
 * The demo surface. Three columns on a projector (live stream · living cards · Synapse rail);
 * on a phone or narrow window the same three panes become tabs.
 */
export default function Desk() {
  const narrow = useIsNarrow();
  const [tab, setTab] = useState<Tab>("cards");
  const cardCount = useThoughts((s) => s.order.length);
  const unseen = useSuggestions((s) => s.unseen);
  const asides = useStream((s) => s.asideCount);

  const stream = (
    <Column icon={<Waves size={15} />} title="Live stream" meta={asides ? `${asides} filtered` : undefined} foot={<KeyboardInput />}>
      <FragmentStream />
    </Column>
  );
  const cards = (
    <Column icon={<Layers size={15} />} title="Living cards" meta={cardCount ? plural(cardCount, "card") : undefined} className="col--cards">
      <CardsColumn />
    </Column>
  );
  const rail = (
    <Column icon={<Sparkles size={15} />} title="Synapse rail" className="col--rail">
      <SynapseRail />
    </Column>
  );

  if (narrow) {
    const tabs: Array<{ id: Tab; label: string; badge?: boolean }> = [
      { id: "cards", label: `Cards${cardCount ? ` · ${cardCount}` : ""}` },
      { id: "stream", label: "Stream" },
      { id: "rail", label: "Rail", badge: unseen > 0 && tab !== "rail" },
    ];
    return (
      <div className="desk desk--tabs">
        <h1 className="sr-only">Synapse Desk</h1>
        <PausedBanner />
        <AboutStrip />
        <div className="seg" role="tablist" aria-label="Desk panes">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="seg__btn" onClick={() => setTab(t.id)}>
              {t.label}
              {t.badge ? <span className="seg__dot" aria-label="new" /> : null}
            </button>
          ))}
        </div>
        <div className="desk__pane" role="tabpanel">
          {tab === "cards" ? cards : tab === "stream" ? stream : rail}
        </div>
      </div>
    );
  }

  return (
    <div className="desk-wrap">
      <h1 className="sr-only">Synapse Desk</h1>
      <PausedBanner />
      <div className="desk">
        {stream}
        {cards}
        {rail}
      </div>
    </div>
  );
}
