import { edgeLabel, gaugeMax, gaugePos, gaugeTicks, type TargetTone } from "@/lib/lab-latency";
import { formatMs } from "@/lib/format";

/* The "target" gauge: one 0..max axis with the p50 → p95 spread as a range bar, a marker for each percentile (coloured by
 * its own verdict) and a tick at each target. No coloured zones: the p50 and the p95 have different limits, so a shared
 * zone wash would contradict one of the two verdicts. The verdict also ships as an icon + word chip next to the figures. */

const tick = (ms: number): string => (ms === 0 ? "0" : ms < 1000 ? `${ms / 1000} s` : edgeLabel(ms));

export function Gauge({
  p50,
  p95,
  target50,
  target95,
  tone50,
  tone95,
  label,
}: {
  p50?: number;
  p95?: number;
  target50?: number;
  target95?: number;
  tone50: TargetTone;
  tone95: TargetTone;
  label: string;
}) {
  const max = gaugeMax(p50, p95, (target95 ?? target50 ?? 0) * 1.15);
  const pos = (v: number): number => gaugePos(v, max) * 100;
  const has50 = p50 !== undefined;
  const has95 = p95 !== undefined;
  const desc = [
    has50 ? `p50 ${formatMs(p50)}` : "",
    has95 ? `p95 ${formatMs(p95)}` : "",
    target50 !== undefined ? `p50 target ${formatMs(target50)}` : "",
    target95 !== undefined ? `p95 target ${formatMs(target95)}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="lab-gauge" role="img" aria-label={`${label}: ${desc || "no samples yet"}; scale 0 to ${formatMs(max)}`}>
      <div className="lab-gauge__ticks" aria-hidden>
        {target50 !== undefined ? (
          <span className="lab-gauge__target lab-gauge__target--l" style={{ left: `${pos(target50)}%` }}>
            <b>p50</b> ≤ {edgeLabel(target50)}
          </span>
        ) : null}
        {target95 !== undefined ? (
          <span className="lab-gauge__target lab-gauge__target--r" style={{ left: `${pos(target95)}%` }}>
            <b>p95</b> ≤ {edgeLabel(target95)}
          </span>
        ) : null}
      </div>
      <div className="lab-gauge__track" aria-hidden>
        {has50 ? <span className="lab-gauge__fill" style={{ width: `${pos(p50)}%` }} /> : null}
        {has50 && has95 ? <span className="lab-gauge__range" style={{ left: `${pos(p50)}%`, width: `${Math.max(0, pos(p95) - pos(p50))}%` }} /> : null}
        {target50 !== undefined ? <span className="lab-gauge__line" style={{ left: `${pos(target50)}%` }} /> : null}
        {target95 !== undefined ? <span className="lab-gauge__line" style={{ left: `${pos(target95)}%` }} /> : null}
        {has50 ? <span className={`lab-gauge__dot lab-gauge__dot--${tone50}`} style={{ left: `${pos(p50)}%` }} /> : null}
        {has95 ? <span className={`lab-gauge__dot lab-gauge__dot--${tone95} lab-gauge__dot--p95`} style={{ left: `${pos(p95)}%` }} /> : null}
      </div>
      <div className="lab-gauge__caps" aria-hidden>
        {has50 ? (
          <span className="lab-gauge__cap lab-gauge__cap--l" style={{ left: `${pos(p50)}%` }}>
            p50
          </span>
        ) : null}
        {has95 ? (
          <span className="lab-gauge__cap lab-gauge__cap--r" style={{ left: `${pos(p95)}%` }}>
            p95
          </span>
        ) : null}
      </div>
      <div className="lab-gauge__axis" aria-hidden>
        {gaugeTicks(max).map((t) => (
          <span key={t} style={{ left: `${pos(t)}%` }}>
            {tick(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
