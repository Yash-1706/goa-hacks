import { useEffect, useState } from "react";

/** Re-render every `periodMs` with the current time (countdowns, "3m ago"). Pass 0 to freeze. */
export function useNow(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (periodMs <= 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}
