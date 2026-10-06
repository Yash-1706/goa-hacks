import { useCallback, useEffect, useRef } from "react";
import { errorText } from "@/components/lab/usePolled";
import { api } from "@/net/api";
import { useConnection } from "@/state/connection";
import { useOutbox } from "@/state/outbox";

/**
 * Loads GET /api/outbox into the shared store (the live artifact.upsert messages keep it fresh afterwards).
 * Stale-while-revalidate: when the store already holds items they stay on screen while the fetch runs, and the fetch
 * runs again whenever the websocket (re)connects, so nothing that happened while it was down is missed.
 */
export function useOutboxLoader(): () => void {
  const status = useConnection((s) => s.status);
  const first = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const st = useOutbox.getState();
    if (!st.loaded) st.setLoading(true);
    try {
      useOutbox.getState().setItems(await api.outbox());
    } catch (err) {
      useOutbox.getState().setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (status === "open") void load();
  }, [status, load]);

  return useCallback(() => void load(), [load]);
}
