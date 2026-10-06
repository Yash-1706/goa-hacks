import { memo, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Brain, Gauge as GaugeIcon, Mic, MicOff, Timer, Zap } from "lucide-react";
import type { LatencySummary } from "@synapse/shared";
import { useNow } from "@/hooks/useNow";
import { formatAgo, plural } from "@/lib/format";
import { edgeLabel, evaluateStage, modelMix, splitMs, stageDef, targetText, traceSeries, type StageKey, type TargetTone } from "@/lib/lab-latency";
import type { LatencyRowView } from "@/net/api-types";
import { Gauge } from "./Gauge";
import { LatencyTrace } from "./LatencyTrace";
import { ToneChip } from "./Panel";
import { StatTile } from "./StatTile";

function Fig({ label, ms, tone, target, hero = false }: { label: string; ms: number | undefined; tone?: TargetTone; target?: string; hero?: boolean }) {
  const { num, unit } = splitMs(ms);
  return (
    <div className={`lab-fig${hero ? " lab-fig--hero" : ""}`}>
      <div className="lab-fig__label">{label}</div>
      <div className="lab-fig__value">
        {num}
        {unit ? <small>{unit}</small> : null}
      </div>
      {tone !== undefined || target ? (
        <div className="lab-fig__verdict">
          {tone !== undefined ? <ToneChip tone={tone} small /> : null}
          {target ? <span>{target}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** how long ago the live summary last moved, in this browser's clock */
function useSeenAgo(value: unknown): string {
  const [seen, setSeen] = useState(() => Date.now());
  useEffect(() => setSeen(Date.now()), [value]);
  const now = useNow(1000);
  return now - seen < 3000 ? "just now" : formatAgo(seen, now);
}

export const LabHero = memo(function LabHero({ summary, rows }: { summary: LatencySummary | null; rows: readonly LatencyRowView[] }) {
  const ago = useSeenAgo(summary);
  const def = stageDef("artifact");
  const s = summary?.stages.artifact;
  const verdict = evaluateStage(def, s);
  const has = Boolean(s && s.n > 0);
  const t = def.target;

  const tile = (stage: StageKey, label: string, icon: ReactNode, pick: "p50" | "p95", caption: (n: number, other: number) => ReactNode) => {
    const d = stageDef(stage);
    const st = summary?.stages[stage];
    const series = traceSeries(rows, stage, 24).map((p) => p.value);
    return (
      <StatTile
        key={stage}
        label={label}
        icon={icon}
        ms={st && st.n > 0 ? st[pick] : undefined}
        caption={st && st.n > 0 ? caption(st.n, pick === "p50" ? st.p95 : st.p50) : <span>{d.empty}</span>}
        tone={evaluateStage(d, st).overall}
        targetText={targetText(d.target)}
        series={series}
        limit={d.target?.p95 ?? d.target?.p50}
      />
    );
  };

  const cortex = summary?.stages.cortex;
  const mix = modelMix(rows);
  const top = mix.models[0];
  const cortexCaption = !cortex || cortex.n === 0 ? <span>{stageDef("cortex").empty}</span> : (
    <span title="Model used for the fragments in view, and how many live calls reused cached prompt tokens">
      {top ? top.model : "model"}
      {mix.live > 0 ? ` · cache ${mix.cacheHits}/${mix.live}` : top?.model === "heuristic" ? " · mock cortex" : ""}
    </span>
  );

  return (
    <section className="lab-hero" aria-label="Latency headline">
      <div className="lab-hero__main glass-strong">
        <div className="lab-hero__top">
          <div className="lab-hero__eyebrow">
            <Zap size={14} aria-hidden /> Fragment → finished card
          </div>
          <div className="lab-hero__live" title="The headline numbers refresh with every metrics.update from the server (about once a second while fragments flow).">
            <span className="dot dot-ok dot-pulse" aria-hidden /> live · {ago}
          </div>
        </div>

        {has && s ? (
          <>
            <div className="lab-hero__figs">
              <Fig hero label="Median · p50" ms={s.p50} tone={verdict.p50} target={t?.p50 !== undefined ? `target ≤ ${edgeLabel(t.p50)}` : undefined} />
              <Fig label="95th percentile · p95" ms={s.p95} tone={verdict.p95} target={t?.p95 !== undefined ? `target ≤ ${edgeLabel(t.p95)}` : undefined} />
              <Fig label="Slowest" ms={s.max} />
            </div>
            <Gauge p50={s.p50} p95={s.p95} target50={t?.p50} target95={t?.p95} tone50={verdict.p50} tone95={verdict.p95} label="Fragment to finished card" />
            <p className="lab-hero__note">
              {plural(s.n, "fragment")} measured · from the Wispr final text to a finished card on screen. {def.blurb}
            </p>
          </>
        ) : (
          <div className="lab-hero__empty">
            <GaugeIcon size={26} aria-hidden />
            <p>
              <b>No fragments measured yet.</b> Speak or type a thought on <Link to="/">Desk</Link> and the first numbers land here within a second.
            </p>
          </div>
        )}

        <LatencyTrace rows={rows} />
      </div>

      <div className="lab-hero__tiles">
        {tile("firstPaint", "First paint", <Timer size={14} />, "p50", (n, p95) => (
          <span className="tnum">
            p95 {splitMs(p95).num} {splitMs(p95).unit} · n={n}
          </span>
        ))}
        {tile("speechToArtifact", "Speech → card", <Mic size={14} />, "p50", (n, p95) => (
          <span className="tnum">
            p95 {splitMs(p95).num} {splitMs(p95).unit} · n={n}
          </span>
        ))}
        {tile("pause", "Pause → mic off", <MicOff size={14} />, "p95", (n, p50) => (
          <span className="tnum">
            p50 {splitMs(p50).num} {splitMs(p50).unit} · n={n}
          </span>
        ))}
        <StatTile
          label="Model call"
          icon={<Brain size={14} />}
          ms={cortex && cortex.n > 0 ? cortex.p50 : undefined}
          caption={cortexCaption}
          tone="none"
          neutralLabel="Reported"
          targetText="not gated"
          series={traceSeries(rows, "cortex", 24).map((p) => p.value)}
        />
      </div>
    </section>
  );
});
