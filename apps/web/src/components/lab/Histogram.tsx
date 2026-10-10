import { memo, useId, useState } from "react";
import {
  HIST_BUCKETS,
  axisPosition,
  boundaryPosition,
  bucketLabel,
  bucketRange,
  describeHistogram,
  edgeLabel,
  scaleBar,
} from "@/lib/lab-latency";

/* A small latency histogram on log-ish buckets (10 ms … 5 s+): one series, one colour, 4 px rounded tops on a square
 * baseline, a 2 px surface gap between bars, a solid hairline at the target and p50 / p95 markers under the axis.
 * Bars past the target turn amber. The hit area of a bar is its whole column (not just the painted pixels). */

const W = 192;
const H = 40;
const BW = W / HIST_BUCKETS;
const GAP = 2;
const BASE = 30;
const MAX_BAR = 27;

function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function marker(x: number): string {
  const cx = Math.min(W - 4, Math.max(4, x));
  return `M${cx},${BASE + 3} L${cx - 3.5},${BASE + 9} L${cx + 3.5},${BASE + 9} Z`;
}

export const Histogram = memo(function Histogram({
  counts,
  p50,
  p95,
  max,
  limit,
  name,
}: {
  counts: readonly number[];
  p50?: number;
  p95?: number;
  max?: number;
  /** the target line, in ms */
  limit?: number;
  /** what is plotted, for the accessible name */
  name: string;
}) {
  const gid = useId();
  const [hover, setHover] = useState<number | null>(null);
  const total = counts.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...counts);
  const limitX = limit !== undefined ? boundaryPosition(limit) * BW : undefined;
  const summaryOnly = total === 0 && (p50 !== undefined || p95 !== undefined);

  const read =
    hover !== null ? (
      <>
        <b>{bucketLabel(hover)}</b>
        <span className="tnum">
          {counts[hover]} {total ? `(${Math.round(((counts[hover] ?? 0) / total) * 100)}%)` : ""}
        </span>
      </>
    ) : summaryOnly ? (
      <span>summary only: no per-fragment rows</span>
    ) : (
      <>
        <span className="tnum">{total === 1 ? "1 fragment" : `${total} fragments`}</span>
        {limit !== undefined ? (
          <span className="lab-hist__key">
            <i aria-hidden /> target {edgeLabel(limit)}
          </span>
        ) : null}
      </>
    );

  return (
    <div className="lab-hist">
      <svg className="lab-hist__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${name}. ${total ? describeHistogram(counts) : "No per-fragment samples"}`} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4b393" />
            <stop offset="1" stopColor="#ff6a3d" />
          </linearGradient>
        </defs>
        <line className="lab-hist__base" x1="0" x2={W} y1={BASE + 0.5} y2={BASE + 0.5} />
        {limitX !== undefined ? <line className="lab-hist__limit" x1={limitX} x2={limitX} y1="1" y2={BASE} /> : null}
        {counts.map((c, i) => {
          if (c <= 0) return null;
          const h = scaleBar(c, peak) * MAX_BAR;
          const over = limit !== undefined && bucketRange(i).lo >= limit;
          return (
            <path
              key={i}
              d={topRounded(i * BW + GAP / 2, BASE - h, BW - GAP, h, 4)}
              className={`lab-hist__bar${over ? " lab-hist__bar--over" : ""}${hover === i ? " is-hover" : ""}`}
              fill={over ? undefined : `url(#${gid})`}
            />
          );
        })}
        {p50 !== undefined ? <path className="lab-hist__m lab-hist__m--p50" d={marker(axisPosition(p50) * BW)} /> : null}
        {p95 !== undefined ? <path className="lab-hist__m lab-hist__m--p95" d={marker(axisPosition(p95) * BW)} /> : null}
        {summaryOnly && max !== undefined ? <path className="lab-hist__m lab-hist__m--max" d={marker(axisPosition(max) * BW)} /> : null}
        {counts.map((_, i) => (
          <rect key={`hit-${i}`} x={i * BW} y="0" width={BW} height={H} fill="transparent" aria-hidden onPointerEnter={() => setHover(i)} />
        ))}
      </svg>
      <div className="lab-hist__read" aria-hidden>
        {read}
      </div>
    </div>
  );
});
