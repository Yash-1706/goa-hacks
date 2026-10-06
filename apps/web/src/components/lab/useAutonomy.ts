import { useEffect } from "react";
import { api } from "@/net/api";
import { useSettings } from "@/state/settings";

/** Keep the app-wide server config (`useSettings.config`) in step with the autonomy level the server really has. */
export function syncAutonomyConfig(level: number): void {
  const st = useSettings.getState();
  if (st.config && st.config.autonomyLevel !== level) st.setConfig({ ...st.config, autonomyLevel: level });
}

/**
 * The current autonomy level for read-only displays (the Outbox banner). `useSettings.config` comes from the websocket
 * welcome and goes stale when the level is changed elsewhere, so this also reads GET /api/settings once in the background.
 */
export function useAutonomyLevel(): number | null {
  const level = useSettings((s) => s.config?.autonomyLevel);
  useEffect(() => {
    const ac = new AbortController();
    api
      .settings(ac.signal)
      .then((s) => syncAutonomyConfig(s.autonomyLevel))
      .catch(() => undefined);
    return () => ac.abort();
  }, []);
  return level ?? null;
}
