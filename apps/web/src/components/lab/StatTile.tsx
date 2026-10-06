import type { ReactNode } from "react";
import { splitMs, type TargetTone } from "@/lib/lab-latency";
import { ToneChip } from "./Panel";
import { Trend } from "./Trend";

/** A KPI tile: label, one figure, a caption, a trend of the last fragments and the verdict. */
export function StatTile({
  label,
  ms,
  caption,
  targetText,
  tone,
  series,
  limit,
  icon,
  neutralLabel,
}: {
  label: string;
  ms: number | undefined;
  caption?: ReactNode;
  targetText?: string;
  tone: TargetTone;
  series: readonly number[];
  limit?: number;
  icon: ReactNode;
  /** reword the "no target" verdict for stages that are only reported */
  neutralLabel?: string;
}) {
  const { num, unit } = splitMs(ms);
  return (
    <div className="lab-tile glass">
      <div className="lab-tile__label">
        <span aria-hidden>{icon}</span>
        {label}
      </div>
      <div className="lab-tile__value">
        {num}
        {unit ? <small>{unit}</small> : null}
      </div>
      {caption ? <div className="lab-tile__caption">{caption}</div> : null}
      <div className="lab-tile__foot">
        <Trend values={series.slice(-24)} limit={limit} width={190} height={34} />
        <div className="lab-tile__verdict">
          <ToneChip tone={tone} small labels={neutralLabel ? { none: neutralLabel } : undefined} />
          {targetText ? <span className="lab-tile__target">{targetText}</span> : null}
        </div>
      </div>
    </div>
  );
}
