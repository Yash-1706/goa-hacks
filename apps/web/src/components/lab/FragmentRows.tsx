import { memo, useId, useMemo, useState } from "react";
import { ChevronDown, TableProperties } from "lucide-react";
import { formatClockSeconds, formatMs } from "@/lib/format";
import { p95Limit, stageDef, toneAgainst, type StageKey } from "@/lib/lab-latency";
import type { LatencyRowView } from "@/net/api-types";
import { toneWord } from "./Panel";

/* The table twin of the charts above: the newest fragments with every stage the server measured for each. Collapsed by
 * default (the stage table and the trace carry the story); one click shows the numbers behind them. No transcript text:
 * a fragment is its id, its transport, the model that processed it and the stage timings. */

const SHOWN = 20;

const COLS: Array<{ key: StageKey; label: string; judged: boolean }> = [
  { key: "wispr", label: "Wispr", judged: false },
  { key: "firstPaint", label: "First paint", judged: true },
  { key: "cortex", label: "Model call", judged: false },
  { key: "artifact", label: "Finished card", judged: true },
  { key: "speechToArtifact", label: "Speech → card", judged: true },
];

function Cell({ ms, judged, stage }: { ms: number | undefined; judged: boolean; stage: StageKey }) {
  if (ms === undefined) return <span className="lab-dash">–</span>;
  const tone = judged ? toneAgainst(ms, p95Limit(stageDef(stage).target)) : "none";
  return (
    <span className="lab-num">
      {tone !== "none" ? <i className={`lab-num__dot lab-num__dot--${tone}`} aria-hidden /> : null}
      <span>{formatMs(ms)}</span>
      {tone !== "none" ? <span className="sr-only"> ({toneWord(tone)})</span> : null}
    </span>
  );
}

export const FragmentRows = memo(function FragmentRows({ rows }: { rows: readonly LatencyRowView[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const recent = useMemo(() => rows.slice(-SHOWN).reverse(), [rows]);

  return (
    <div className="lab-fr">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} disabled={recent.length === 0}>
        <TableProperties size={13} aria-hidden />
        {recent.length === 0 ? "No fragments to list yet" : `${open ? "Hide" : "Show"} the last ${recent.length} fragments as a table`}
        <ChevronDown size={13} aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
      </button>
      {open && recent.length > 0 ? (
        <div className="lab-fr__scroll" id={id}>
          <table className="lab-rtable">
            <caption className="sr-only">The newest fragments with the time each stage took, newest first.</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Fragment</th>
                <th scope="col">Processed by</th>
                {COLS.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.fragmentId}>
                  <td className="tnum">{formatClockSeconds(r.createdAt)}</td>
                  <td>
                    <span className="mono lab-fr__id" title={`${r.fragmentId} · ${r.transport} · ${r.deviceId}`}>
                      …{r.fragmentId.slice(-6)}
                    </span>
                    <span className="lab-cell-sub">{r.transport}</span>
                  </td>
                  <td>
                    {r.model ?? r.source ?? "–"}
                    {r.cachedTokens ? <span className="lab-cell-sub">{r.cachedTokens} cached tokens</span> : r.source ? <span className="lab-cell-sub">{r.source}</span> : null}
                  </td>
                  {COLS.map((c) => (
                    <td key={c.key} className="tnum">
                      <Cell ms={r.stages[c.key]} judged={c.judged} stage={c.key} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
});
