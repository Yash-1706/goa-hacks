import { useEffect, useState } from "react";

/** Track a CSS media query (e.g. "(max-width: 1100px)"). */
export function useMedia(query: string): boolean {
  const get = (): boolean => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export const useIsNarrow = (): boolean => useMedia("(max-width: 1100px)");
export const useIsPhone = (): boolean => useMedia("(max-width: 760px)");
export const useReducedMotion = (): boolean => useMedia("(prefers-reduced-motion: reduce)");
