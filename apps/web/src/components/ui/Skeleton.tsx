const WIDTHS = [96, 82, 90, 64, 76];

/** Shimmering placeholder lines for the fields the model has not produced yet. */
export function Skeleton({ lines = 3, height = "0.85rem", gap = "0.5rem" }: { lines?: number; height?: string; gap?: string }) {
  return (
    <div aria-hidden style={{ display: "grid", gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="shimmer" style={{ height, width: `${WIDTHS[i % WIDTHS.length]}%` }} />
      ))}
    </div>
  );
}
