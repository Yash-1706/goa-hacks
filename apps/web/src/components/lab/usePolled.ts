import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* A tiny stale-while-revalidate fetcher for the Lab and the Outbox: the previous data stays on screen while a refetch runs
 * (no skeleton flash), a slow request is aborted by a newer one, and polling pauses while the tab is hidden. */

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** no data yet: the first request is in flight */
  loading: boolean;
  /** a refetch is in flight (the old data is still shown) */
  refreshing: boolean;
  /** when the current data arrived (epoch ms) */
  at: number | null;
  refresh: () => void;
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "The request failed";
}

export function usePolled<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs = 0): Polled<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; at: number | null }>({ data: null, error: null, at: null });
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const ctl = useRef<AbortController | null>(null);

  const run = useCallback(async (): Promise<void> => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setRefreshing(true);
    try {
      const data = await loadRef.current(c.signal);
      if (c.signal.aborted) return;
      setState({ data, error: null, at: Date.now() });
    } catch (err) {
      if (c.signal.aborted) return;
      setState((s) => ({ ...s, error: errorText(err) }));
    } finally {
      if (ctl.current === c) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void run();
    const visible = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";
    const onVisible = (): void => {
      if (visible()) void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = intervalMs > 0 ? setInterval(() => visible() && void run(), intervalMs) : null;
    return () => {
      ctl.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
      if (id !== null) clearInterval(id);
    };
  }, [run, intervalMs]);

  const refresh = useCallback(() => void run(), [run]);

  // a stable object while nothing changed, so memoised panels that receive it do not re-render for nothing
  return useMemo(() => ({ ...state, loading: state.data === null && state.error === null, refreshing, refresh }), [state, refreshing, refresh]);
}
