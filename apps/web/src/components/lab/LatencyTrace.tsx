import { memo, useMemo, useState, type KeyboardEvent } from "react";
import { formatClock, formatMs } from "@/lib/format";
import { edgeLabel, p95Limit, stageDef, toneAgainst, traceMax, traceSeries, type StageKey } from "@/lib/lab-latency";
import type { LatencyRowView } from "@/net/api-types";
import { ToneChip } from "./Panel";
import { Segmented } from "./Segmented";

/* The last 48 fragments as thin columns, newest on the right. One series, one colour per verdict (green within the limit,
 * amber up to 25 % over, rose beyond: status colours, so they ship with a legend and the verdict chip in the read-out).
 * The hover / arrow-key read-out is the tooltip; every value is also in the stage table above and in the rows view. */

const SLOTS = 48;
const STAGES: Array<{ id: StageKey; label: string }> = [
  { id: "firstPaint", label: "First paint" },
  { id: "artifact", label: "Finished card" },
  { id: "speechToArtifact", label: "Speech → card" },
];

export const LatencyTrace = memo(function LatencyTrace({ rows }: { rows: readonly LatencyRowView[] }) {
  const [stage, setStage] = useState<StageKey>("artifact");
  const [cursor, setCursor] = useState<number | null>(null);
  const def = stageDef(stage);
  const target = def.target;
  const limit = p95Limit(target);

  const series = useMemo(() => traceSeries(rows, stage, SLOTS), [rows, stage]);
  const max = useMemo(() => traceMax(series.map((p) => p.value), limit), [series, limit]);
  const pct = (v: number): number => Math.min(100, (v / max) * 100);
  const active = cursor !== null && cursor < series.length ? cursor : null;
  const shown = active !== null ? series[active] : series[series.length - 1];

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (series.length === 0) return;
    const last = series.length - 1;
    if (e.key === "ArrowLeft") setCursor(Math.max(0, (active ?? last + 1) - 1));
    else if (e.key === "ArrowRight") setCursor(active === null || active >= last ? null : active + 1);
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End" || e.key === "Escape") setCursor(null);
    else return;
    e.preventDefault();
  };

  return (
    <div className="lab-trace">
      <div className="lab-trace__head">
        <h3 className="lab-trace__title">Last fragments</h3>
        <Segmented
          label="Stage to trace"
          value={stage}
          options={STAGES}
          onChange={(s) => {
            setStage(s);
            setCursor(null);
          }}
        />
      </div>

      <div className="lab-trace__read" aria-live="off">
        {shown ? (
          <>
            <span className="lab-trace__tag">{active !== null ? "Fragment" : "Latest"}</span>
            <b className="tnum">{formatMs(shown.value)}</b>
            <span className="lab-trace__meta">
              {shown.transport}
              {shown.model ? ` · ${shown.model}` : shown.source ? ` · ${shown.source}` : ""} · {formatClock(shown.at)}
            </span>
            {limit !== undefined ? <ToneChip small tone={toneAgainst(shown.value, limit)} /> : null}
          </>
        ) : (
          <span className="lab-trace__meta">{def.empty}</span>
        )}
      </div>

      {series.length === 0 ? (
        <div className="lab-trace__idle" aria-hidden />
      ) : (
        <>
          <div
            className="lab-trace__chart"
            role="group"
            tabIndex={0}
            aria-label={`${def.label} for the last ${series.length} fragments, newest on the right. Use the left and right arrow keys to inspect one.`}
            onKeyDown={onKey}
            onPointerLeave={() => setCursor(null)}
          >
            <div className="lab-trace__lines" aria-hidden>
              {target?.p50 !== undefined && target.p50 <= max ? (
                <span className="lab-trace__line lab-trace__line--p50" style={{ bottom: `${pct(target.p50)}%` }}>
                  <i>p50 {edgeLabel(target.p50)}</i>
                </span>
              ) : null}
              {target?.p95 !== undefined && target.p95 <= max ? (
                <span className="lab-trace__line" style={{ bottom: `${pct(target.p95)}%` }}>
                  <i>p95 {edgeLabel(target.p95)}</i>
                </span>
              ) : null}
            </div>
            <div className="lab-trace__bars">
              {Array.from({ length: Math.max(0, SLOTS - series.length) }, (_, i) => (
                <span key={`e${i}`} className="lab-trace__slot" aria-hidden />
              ))}
              {series.map((p, i) => {
                const tone = limit !== undefined ? toneAgainst(p.value, limit) : "none";
                return (
                  <span
                    key={p.id}
                    className={`lab-trace__bar lab-trace__bar--${tone}${active === i ? " is-active" : ""}${p.value > max ? " is-clipped" : ""}`}
                    style={{ height: `${Math.max(2.5, pct(p.value))}%` }}
                    onPointerEnter={() => setCursor(i)}
                    aria-hidden
                  />
                );
              })}
            </div>
          </div>

          <div className="lab-trace__legend" aria-hidden>
            <span>
              <i className="lab-trace__key lab-trace__key--good" /> within target
            </span>
            <span>
              <i className="lab-trace__key lab-trace__key--ok" /> up to 25% over
            </span>
            <span>
              <i className="lab-trace__key lab-trace__key--bad" /> over
            </span>
            <span className="lab-trace__legend-note">{`${series.length} of the last ${rows.length} rows`}</span>
          </div>
        </>
      )}
    </div>
  );
});
