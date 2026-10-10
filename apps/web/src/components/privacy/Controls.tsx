import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, Eraser, Flame, HardDrive, Laptop } from "lucide-react";
import { downloadBlob } from "@/lib/download";
import { api } from "@/net/api";
import { toast } from "@/state/notices";
import { useSettings } from "@/state/settings";

/** Purge by window / everything, the local-only switch, and the full export. */
export function Controls({ localOnly, onChanged }: { localOnly: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const cfg = useSettings((s) => s.config);
  const setConfig = useSettings((s) => s.setConfig);

  const purge = async (label: string, body: { windowSecs?: number; all?: boolean }): Promise<void> => {
    setBusy(label);
    try {
      const { count } = await api.purge(body);
      toast[count ? "success" : "info"](count ? `Forgot ${count} item${count === 1 ? "" : "s"} (${label}).` : `Nothing to forget (${label}).`);
      onChanged();
    } catch (err) {
      toast.warn(`Purge failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
      setConfirmAll(false);
    }
  };

  const toggleLocal = async (): Promise<void> => {
    setBusy("local");
    try {
      const r = await api.setLocalOnly(!localOnly);
      // the server also broadcasts the new config (the speech engine switches with this setting): merge into what the store holds NOW, not into the copy captured when this view rendered
      const cur = useSettings.getState().config ?? cfg;
      if (cur) setConfig({ ...cur, localOnly: r.localOnly });
      toast.success(r.localOnly ? "Local-only is on: nothing is sent to the cloud. Models run offline and speech is transcribed on this machine." : "Local-only is off: the cloud cortex and Wispr may be used again.");
      onChanged();
    } catch (err) {
      toast.warn(`Could not change local-only: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const exportAll = async (): Promise<void> => {
    setBusy("export");
    try {
      downloadBlob(await api.exportAll(), "synapse-export.json");
      toast.success("Exported everything Synapse remembers, decrypted, as JSON.");
    } catch (err) {
      toast.warn(`Export failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="glass panel pv-controls" aria-labelledby="pv-ctl-h">
      <div className="section__title" id="pv-ctl-h" style={{ marginTop: 0 }}>
        <Eraser size={15} /> Your controls
      </div>

      <div className="pv-ctl">
        <div className="pv-ctl__row">
          <div>
            <div className="pv-ctl__t">Forget what I just said</div>
            <div className="pv-ctl__d">Deletes thoughts, drafts and everything derived from them. Cascades through the graph.</div>
          </div>
          <div className="pv-ctl__btns">
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void purge("last 30 s", { windowSecs: 30 })}>
              Last 30 s
            </button>
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void purge("last 5 min", { windowSecs: 300 })}>
              Last 5 min
            </button>
            <AnimatePresence mode="wait" initial={false}>
              {confirmAll ? (
                <motion.span key="c" className="confirm" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void purge("everything", { all: true })}>
                    <Flame size={13} /> Yes, forget everything
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmAll(false)}>
                    Cancel
                  </button>
                </motion.span>
              ) : (
                <motion.button key="a" type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => setConfirmAll(true)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  Everything…
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="pv-ctl__row">
          <div>
            <div className="pv-ctl__t">
              <Laptop size={14} aria-hidden style={{ display: "inline", verticalAlign: "-2px" }} /> Local-only mode
            </div>
            <div className="pv-ctl__d">Nothing leaves this machine: no cloud model calls, and spoken audio is transcribed here (on-device Whisper) instead of by Wispr. Synapse falls back to on-device heuristics: you still get classified fragments and notes, with less polish.</div>
          </div>
          <button type="button" role="switch" aria-checked={localOnly} aria-label="Local-only mode" className="switch" disabled={busy !== null} onClick={() => void toggleLocal()} />
        </div>

        <div className="pv-ctl__row">
          <div>
            <div className="pv-ctl__t">
              <HardDrive size={14} aria-hidden style={{ display: "inline", verticalAlign: "-2px" }} /> Export everything
            </div>
            <div className="pv-ctl__d">Every thought, entity, open loop and the audit trail, decrypted, in one JSON file. It is yours.</div>
          </div>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void exportAll()}>
            <Download size={13} /> Export JSON
          </button>
        </div>
      </div>
    </section>
  );
}
