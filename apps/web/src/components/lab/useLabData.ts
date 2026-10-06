import { useEffect, useRef, useState } from "react";
import type { AudioStats } from "@/audio/types";
import { downloadBlob } from "@/lib/download";
import { ApiError, api, authHeaders } from "@/net/api";
import type { BatteryResponse, DictionaryResponse, HealthResponse, LatencyResponse, SettingsResponse } from "@/net/api-types";
import { useAudioUi } from "@/state/audio";
import { useMetrics } from "@/state/metrics";
import { usePolled, type Polled } from "./usePolled";

/* Data hooks of the Lab. Each endpoint is polled gently (and again when the tab becomes visible); the latency rows are also
 * refreshed whenever the live `metrics.update` summary moves, at most once per MIN_GAP_MS. */

/** the latency rows are re-fetched at most this often while fragments flow */
const MIN_GAP_MS = 2500;

export function useLatencyData(): Polled<LatencyResponse> {
  const polled = usePolled((s) => api.latency(s), 30_000);
  const stamp = useMetrics((s) => s.summary?.updatedAt ?? 0);
  const last = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refresh } = polled;

  useEffect(() => {
    if (!stamp || timer.current) return; // nothing new, or a refresh is already scheduled
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - last.current));
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      refresh();
    }, wait);
  }, [stamp, refresh]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return polled;
}

export const useHealthData = (): Polled<HealthResponse> => usePolled((s) => api.health(s), 10_000);
export const useSettingsData = (): Polled<SettingsResponse> => usePolled((s) => api.settings(s), 15_000);
export const useBatteryData = (): Polled<BatteryResponse> => usePolled((s) => api.battery(s), 6_000);
export const useDictionaryData = (): Polled<DictionaryResponse> => usePolled((s) => api.dictionary(s), 8_000);

/** the 5 s audio-stats windows of THIS device, collected while the Lab is open (newest last) */
export function useStatsHistory(limit = 60): AudioStats[] {
  const [list, setList] = useState<AudioStats[]>(() => {
    const s = useAudioUi.getState().stats;
    return s ? [s] : [];
  });
  useEffect(
    () =>
      useAudioUi.subscribe((state, prev) => {
        const s = state.stats;
        if (s && s !== prev.stats) setList((l) => [...l, s].slice(-limit));
      }),
    [limit],
  );
  return list;
}

/** GET /api/metrics/latency?format=csv with the device headers, saved through a Blob */
export async function exportLatencyCsv(): Promise<void> {
  const res = await fetch("/api/metrics/latency?format=csv", { headers: authHeaders() });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === "string") msg = j.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status);
  }
  const text = await res.text();
  const day = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), `synapse-latency-${day}.csv`);
}
