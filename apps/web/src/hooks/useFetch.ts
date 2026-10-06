import { useCallback, useEffect, useRef, useState } from "react";

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** refetch (keeps showing the previous data while loading) */
  reload: () => void;
  /** replace the data locally (optimistic updates) */
  setData: (updater: (prev: T | null) => T | null) => void;
}

/** Small fetch-on-mount hook: aborts on unmount, keeps stale data during reloads, never throws. */
export function useFetch<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[] = []): FetchState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    loadRef.current(ctl.signal).then(
      (d) => {
        if (ctl.signal.aborted) return;
        setDataState(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setData = useCallback((updater: (prev: T | null) => T | null) => setDataState((p) => updater(p)), []);
  return { data, error, loading, reload, setData };
}
