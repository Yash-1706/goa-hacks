import { memo } from "react";
import type { LatencySummary } from "@synapse/shared";
import { formatMs } from "@/lib/format";
import { STAGE_DEFS, evaluateStage, histogram, strictLimit, targetText, valuesFor, type StageDef, type TargetTone } from "@/lib/lab-latency";
import type { LatencyRowView } from "@/net/api-types";
import { Histogram } from "./Histogram";
import { ToneChip, toneWord } from "./Panel";

function Num({ ms, tone }: { ms: number | undefined; tone?: TargetTone }) {
  const judged = tone !== undefined && tone !== "none";
  return (
    <span className="lab-num">
      {judged ? <i className={`lab-num__dot lab-num__dot--${tone}`} aria-hidden /> : null}
      <span>{formatMs(ms)}</span>
      {judged ? <span className="sr-only"> ({toneWord(tone)})</span> : null}
    </span>
  );
}

function StageRow({ def, summary, rows }: { def: StageDef; summary: LatencySummary | null; rows: readonly LatencyRowView[] }) {
  const stats = summary?.stages[def.key];
  const verdict = evaluateStage(def, stats);
  const empty = !stats || stats.n === 0;
  const counts = histogram(valuesFor(rows, def.key));
  return (
    <tr className={`lab-row${empty ? " is-empty" : ""}`}>
      <th scope="row" className="lab-row__stage">
        <span className="lab-row__name">{def.label}</span>
        <span className="lab-row__span mono">{def.span}</span>
        <span className="lab-row__blurb">{empty ? def.empty : def.blurb}</span>
      </th>
      <td data-label="Samples" className="lab-row__n tnum">
        {stats?.n ?? 0}
      </td>
      <td data-label="p50">{empty ? <span className="lab-dash">–</span> : <Num ms={stats.p50} tone={verdict.p50} />}</td>
      <td data-label="p95">{empty ? <span className="lab-dash">–</span> : <Num ms={stats.p95} tone={verdict.p95} />}</td>
      <td data-label="Slowest">{empty ? <span className="lab-dash">–</span> : <Num ms={stats.max} />}</td>
      <td data-label="Distribution" className="lab-row__hist">
        <Histogram counts={counts} p50={stats?.p50} p95={stats?.p95} max={stats?.max} limit={strictLimit(def.target)} name={`Distribution of ${def.label.toLowerCase()}`} />
      </td>
      <td data-label="Target" className="lab-row__target">
        {def.target ? (
          <>
            <span className="lab-row__ttext tnum">{targetText(def.target)}</span>
            <span className="lab-row__tbasis">{def.target.basis === "prd" ? "PRD target" : "design budget"}</span>
            {!empty ? <ToneChip tone={verdict.overall} small /> : null}
          </>
        ) : (
          <span className="lab-row__tbasis">Reported, not gated</span>
        )}
      </td>
    </tr>
  );
}

function Group({ title, note }: { title: string; note: string }) {
  return (
    <tr className="lab-table__group">
      <th colSpan={7} scope="colgroup">
        {title} <span>{note}</span>
      </th>
    </tr>
  );
}

/** The stage table: n / p50 / p95 / max, a distribution per stage, the PRD target and its verdict. */
export const LatencyTable = memo(function LatencyTable({ summary, rows, busy }: { summary: LatencySummary | null; rows: readonly LatencyRowView[]; busy: boolean }) {
  const feel = STAGE_DEFS.filter((d) => d.feel);
  const inside = STAGE_DEFS.filter((d) => !d.feel);
  return (
    <div className={`lab-lt${busy ? " is-busy" : ""}`} aria-busy={busy}>
      <div className="lab-lt__scroll">
        <table className="lab-table">
          <caption className="sr-only">Latency by stage: samples, median, 95th percentile, slowest, distribution and target.</caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Samples</th>
              <th scope="col">p50</th>
              <th scope="col">p95</th>
              <th scope="col">Slowest</th>
              <th scope="col">
                Distribution <span className="lab-table__axis">10 ms → 5 s+</span>
              </th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            <Group title="What you feel" note="end to end, judged against the PRD targets" />
            {feel.map((d) => (
              <StageRow key={d.key} def={d} summary={summary} rows={rows} />
            ))}
            <Group title="Inside the pipeline" note="where the time goes" />
            {inside.map((d) => (
              <StageRow key={d.key} def={d} summary={summary} rows={rows} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="lab-lt__legend" aria-hidden>
        <span>
          <i className="lab-key lab-key--p50" /> p50
        </span>
        <span>
          <i className="lab-key lab-key--p95" /> p95
        </span>
        <span>
          <i className="lab-key lab-key--limit" /> target
        </span>
        <span>
          <i className="lab-key lab-key--over" /> slower than target
        </span>
        <span className="lab-lt__note">
          Numbers cover the server’s rolling window (up to 400 fragments); the bars show its latest {rows.length} {rows.length === 1 ? "row" : "rows"}.
        </span>
      </div>
    </div>
  );
});
