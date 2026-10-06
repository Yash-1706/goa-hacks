import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Download, Loader2, RefreshCw, Timer } from "lucide-react";
import { AdaptationPanel } from "@/components/lab/AdaptationPanel";
import { AudioDiagnostics } from "@/components/lab/AudioDiagnostics";
import { AutonomyPanel } from "@/components/lab/AutonomyPanel";
import { BatteryLab } from "@/components/lab/BatteryLab";
import { DictionaryPanel } from "@/components/lab/DictionaryPanel";
import { FragmentRows } from "@/components/lab/FragmentRows";
import { JumpNav } from "@/components/lab/JumpNav";
import { LabHero } from "@/components/lab/LabHero";
import { LatencyTable } from "@/components/lab/LatencyTable";
import { Panel } from "@/components/lab/Panel";
import { SystemPanel } from "@/components/lab/SystemPanel";
import { exportLatencyCsv, useBatteryData, useDictionaryData, useHealthData, useLatencyData, useSettingsData } from "@/components/lab/useLabData";
import { errorText } from "@/components/lab/usePolled";
import { freshestSummary } from "@/lib/lab-latency";
import { useMetrics } from "@/state/metrics";
import { toast } from "@/state/notices";

const NO_ROWS: never[] = [];

/**
 * The Lab: every number Synapse can show about itself. Latency per stage against the PRD targets (live from
 * metrics.update, rows refreshed alongside), the modelled battery budget, the autonomy dial, the self-healing dictionary,
 * the proactivity tuning, the system modes and the audio pipeline diagnostics.
 */
export default function Lab() {
  const latency = useLatencyData();
  const settings = useSettingsData();
  const health = useHealthData();
  const battery = useBatteryData();
  const dictionary = useDictionaryData();
  const live = useMetrics((s) => s.summary);
  const [exporting, setExporting] = useState(false);
  const { hash } = useLocation();

  const summary = useMemo(() => freshestSummary(live, latency.data?.summary), [live, latency.data?.summary]);
  const rows = latency.data?.rows ?? NO_ROWS;
  const busy = latency.refreshing || settings.refreshing || health.refreshing || battery.refreshing || dictionary.refreshing;

  // /lab#lab-autonomy (linked from the Outbox) scrolls to that panel and flashes it once
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    const t = setTimeout(() => {
      el.scrollIntoView({ block: "start" });
      el.classList.add("lab-flash");
      setTimeout(() => el.classList.remove("lab-flash"), 1900);
    }, 140);
    return () => clearTimeout(t);
  }, [hash]);

  const refreshAll = (): void => {
    latency.refresh();
    settings.refresh();
    health.refresh();
    battery.refresh();
    dictionary.refresh();
  };

  const onExport = async (): Promise<void> => {
    setExporting(true);
    try {
      await exportLatencyCsv();
      toast.success("Saved the per-fragment latency CSV.");
    } catch (err) {
      toast.warn(`Could not export the latency CSV: ${errorText(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page lab">
      <div className="page__inner">
        <header className="page__head lab__head">
          <div>
            <div className="eyebrow">Lab · live instrumentation</div>
            <h1 className="page__title">Measured, not claimed</h1>
            <p className="page__sub">Latency per stage from this session, a transparent battery model, the dictionary Synapse teaches itself and the dials that decide when it speaks up.</p>
          </div>
          <div className="lab__actions">
            <button type="button" className="btn btn-sm" onClick={refreshAll} aria-busy={busy} title="Fetch every panel again">
              {busy ? <Loader2 size={13} className="lab-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Refresh
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void onExport()} disabled={exporting} title="Every fragment with every stage, as CSV (GET /api/metrics/latency?format=csv)">
              {exporting ? <Loader2 size={13} className="lab-spin" aria-hidden /> : <Download size={13} aria-hidden />} Export CSV
            </button>
          </div>
        </header>

        <JumpNav />

        <LabHero summary={summary} rows={rows} />

        <div className="lab__stack">
          <Panel
            id="lab-latency"
            icon={<Timer size={16} />}
            title="Latency by stage"
            sub="From the moment Wispr hands over the text to a finished card on screen, and every hop in between. Green is within the target, amber up to 25% over, red beyond."
            className="lab-panel--wide"
          >
            {latency.error && !latency.data ? (
              <p className="lab-error" role="alert">
                Could not load the latency rows: {latency.error}
              </p>
            ) : null}
            <LatencyTable summary={summary} rows={rows} busy={latency.refreshing} />
            <FragmentRows rows={rows} />
          </Panel>

          <BatteryLab battery={battery} />
          <AutonomyPanel settings={settings} />

          <div className="lab__duo">
            <DictionaryPanel dictionary={dictionary} />
            <AdaptationPanel settings={settings} />
          </div>

          <div className="lab__duo lab__duo--system">
            <SystemPanel health={health} settings={settings} />
            <AudioDiagnostics />
          </div>
        </div>
      </div>
    </div>
  );
}
