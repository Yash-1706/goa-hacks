import { memo } from "react";

const R = 13;
const C = 2 * Math.PI * R;

const colorOf = (v: number): string => (v >= 0.75 ? "#34d399" : v >= 0.55 ? "#fbbf24" : "#fb7185");

/** Confidence as a ring (0–100). While the model is still thinking it spins as a dashed arc instead. */
export const ConfidenceRing = memo(function ConfidenceRing({ value, size = 36, thinking = false }: { value: number; size?: number; thinking?: boolean }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const color = thinking ? "#22d3ee" : colorOf(v);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 34 34"
      role="img"
      aria-label={thinking ? "confidence pending" : `confidence ${Math.round(v * 100)} percent`}
      style={{ flex: "none", overflow: "visible" }}
    >
      <title>{thinking ? "The model is still working on this" : `Confidence ${Math.round(v * 100)}%${v < 0.55 ? " (tentative: Synapse is not sure)" : ""}`}</title>
      <circle cx="17" cy="17" r={R} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
      {thinking ? (
        <circle cx="17" cy="17" r={R} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray="14 68" style={{ transformOrigin: "17px 17px", animation: "orb-spin 1s linear infinite" }} />
      ) : (
        <circle
          cx="17"
          cy="17"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - v)}
          transform="rotate(-90 17 17)"
          style={{ transition: "stroke-dashoffset 0.7s cubic-bezier(0.22,1,0.36,1), stroke 0.4s", filter: `drop-shadow(0 0 3px ${color}88)` }}
        />
      )}
      {thinking ? null : (
        <text x="17" y="17.6" textAnchor="middle" dominantBaseline="middle" fontSize="9.5" fontWeight="700" fill="#e8eaf0" style={{ fontVariantNumeric: "tabular-nums" }}>
          {Math.round(v * 100)}
        </text>
      )}
    </svg>
  );
});
