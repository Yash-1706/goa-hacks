import { useId, useMemo } from "react";

/* A 2 px trend line with a ~10 % wash, a ringed end marker (r 3.5 + a 2 px surface ring) and, when there is a target,
 * one solid hairline at it. Used by the KPI tiles; the numbers themselves live in the tile, so it is decorative. */

export function Trend({ values, width = 96, height = 30, limit }: { values: readonly number[]; width?: number; height?: number; limit?: number }) {
  const gid = useId();
  const g = useMemo(() => {
    if (values.length < 2) return null;
    const pad = 5;
    const top = Math.max(limit ? limit * 1.2 : 0, ...values, 1);
    const step = (width - pad * 2) / (values.length - 1);
    const y = (v: number): number => height - pad - (Math.min(Math.max(v, 0), top) / top) * (height - pad * 2);
    const pts = values.map((v, i) => [pad + i * step, y(v)] as const);
    const line = pts.map(([x, py], i) => `${i ? "L" : "M"}${x.toFixed(1)},${py.toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1] as readonly [number, number];
    return { line, area: `${line} L${last[0].toFixed(1)},${height} L${pad},${height} Z`, ly: limit ? y(limit) : null, last };
  }, [values, width, height, limit]);

  if (!g) return <span className="lab-trend lab-trend--empty" style={{ width, height }} aria-hidden />;
  return (
    <svg className="lab-trend" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id={`${gid}-s`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#ff6a3d" />
          <stop offset="1" stopColor="#f4b393" />
        </linearGradient>
        <linearGradient id={`${gid}-a`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f4b393" stopOpacity="0.16" />
          <stop offset="1" stopColor="#f4b393" stopOpacity="0" />
        </linearGradient>
      </defs>
      {g.ly !== null ? <line className="lab-trend__limit" x1="0" x2={width} y1={g.ly} y2={g.ly} /> : null}
      <path d={g.area} fill={`url(#${gid}-a)`} />
      <path className="lab-trend__line" d={g.line} stroke={`url(#${gid}-s)`} />
      <circle className="lab-trend__dot" cx={g.last[0]} cy={g.last[1]} r="3.5" />
    </svg>
  );
}
