import { memo, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Cpu, FlaskConical, Info, Leaf, Radio, Smartphone, Upload } from "lucide-react";
import type { AudioStats } from "@/audio/types";
import { formatBytes } from "@/lib/format";
import {
  REDUCTION_TARGET,
  compare,
  compareReport,
  energyOf,
  formatUnits,
  formatWindow,
  naiveUsage,
  ratesOf,
  reductionText,
  reductionTone,
  skipPct,
  sumUsage,
  targetShare,
  type Comparison,
  type EnergyModel,
} from "@/lib/lab-energy";
import type { BatteryResponse, BatteryRow } from "@/net/api-types";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { useDevices } from "@/state/devices";
import { Panel, ToneChip } from "./Panel";
import { Trend } from "./Trend";
import { useStatsHistory } from "./useLabData";
import type { Polled } from "./usePolled";

/* Battery Lab (PRD DEV-4). Everything on this panel is a MODEL in relative units, never joules. The comparison, the
 * per-device table and the live counters all use the same formula and the same naive baseline (lib/lab-energy.ts). */

const pct = (n: number, d = 0): string => `${n.toFixed(d)} %`;

function ModelBadge() {
  return (
    <span className="lab-model" title="Modelled, not measured: relative units from a fixed formula, so two runs are comparable but they are not joules.">
      <FlaskConical size={12} aria-hidden /> MODEL · not measured
    </span>
  );
}

// ------------------------------------------------------------- comparison --

function Bars({ c }: { c: Comparison | null }) {
  const share = c ? c.share * 100 : 0;
  const mark = targetShare() * 100;
  return (
    <div
      className="lab-cmp__bars"
      role="img"
      aria-label={c ? `Synapse uses ${Math.round(share)} percent of the modelled energy of naive streaming; the target is at most ${100 - REDUCTION_TARGET} percent` : "No data yet"}
    >
      <div className="lab-cmp__row">
        <span className="lab-cmp__name">Synapse (VAD-gated)</span>
        <span className="lab-meter">
          <span className="lab-meter__fill" style={{ width: `${Math.max(c ? 1.2 : 0, share)}%` }} />
        </span>
        <span className="lab-cmp__val tnum">{c ? formatUnits(c.energy) : "–"}</span>
      </div>
      <div className="lab-cmp__row">
        <span className="lab-cmp__name">Naive streaming</span>
        <span className="lab-meter lab-meter--naive">
          <span className="lab-meter__fill" style={{ width: c ? "100%" : "0%" }} />
          <span className="lab-meter__target" style={{ left: `${mark}%` }}>
            <i>{REDUCTION_TARGET} % reduction target</i>
          </span>
        </span>
        <span className="lab-cmp__val tnum">{c ? formatUnits(c.naive) : "–"}</span>
      </div>
    </div>
  );
}

function ComparisonCard({ overall, session, live, model, rows }: { overall: Comparison | null; session: Comparison | null; live: Comparison | null; model: EnergyModel | undefined; rows: number }) {
  const c = overall ?? session ?? live;
  const source = overall ? `all devices · ${rows} ${rows === 1 ? "row" : "rows"} in the server report` : session ? "this device · since you opened the Lab" : live ? "this device · latest 5 s window" : "";
  const tone = c ? reductionTone(c.savedPct) : "none";
  const naive = model ? naiveUsage(60_000) : null;
  const headline = c ? reductionText(c.energy, c.naive) : null;

  return (
    <div className="lab-cmp">
      <div className="lab-cmp__hero">
        <div className="lab-cmp__eyebrow">Modelled energy vs. streaming all the time</div>
        <div className="lab-cmp__big">
          {headline ? (
            <>
              <span className="lab-cmp__num">
                {headline.sign}
                {headline.value}
              </span>
              <span className="lab-cmp__pct">%</span>
            </>
          ) : (
            <span className="lab-cmp__num lab-cmp__num--none">–</span>
          )}
        </div>
        <div className="lab-cmp__verdict">
          <ToneChip tone={tone} labels={{ good: "On target", ok: "Close", bad: "Below target", none: "Waiting for data" }} />
          <span className="lab-cmp__target">target ≥ {REDUCTION_TARGET} % less</span>
        </div>
        {source ? <div className="lab-cmp__source">{source}</div> : null}
      </div>
      <div className="lab-cmp__chart">
        <Bars c={c} />
        {!c && naive && model ? (
          <p className="lab-cmp__empty">
            <b>Waiting for a microphone session.</b> Open <Link to="/pocket">Pocket</Link> on a phone or tap the mic on <Link to="/">Desk</Link> and talk: the radio only wakes while you speak. Streaming all the time would send{" "}
            {formatBytes(naive.bytesUp)} a minute with the radio on 100 % of the time (about {formatUnits(energyOf(naive, model))} model units).
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ live device --

function LevelIcon({ level, charging }: { level: number; charging: boolean }) {
  if (charging) return <BatteryCharging size={15} aria-hidden />;
  if (level < 0.2) return <BatteryLow size={15} aria-hidden />;
  if (level < 0.6) return <BatteryMedium size={15} aria-hidden />;
  return <BatteryFull size={15} aria-hidden />;
}

function Kv({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="lab-kv" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LiveDevice({ session, history }: { session: Comparison | null; history: readonly AudioStats[] }) {
  const stats = useAudioUi((s) => s.stats);
  const engine = useAudioUi((s) => s.engine);
  const state = useAudioUi((s) => s.state);
  const mode = useAudioUi((s) => s.mode);
  const autoEco = useAudioUi((s) => s.autoEco);
  const battery = useAudioUi((s) => s.battery);
  const wakeLock = useAudioUi((s) => s.wakeLock);

  // the figures average the last minute (12 windows of 5 s): a single window is too jumpy to read
  const recent = useMemo(() => history.slice(-12), [history]);
  const usage = useMemo(() => (recent.length ? sumUsage(recent) : null), [recent]);
  const rates = usage ? ratesOf(usage) : null;
  const skipped = recent.length ? skipPct(recent.reduce((a, w) => a + w.framesSkipped, 0), recent.reduce((a, w) => a + w.framesTotal, 0)) : null;
  const spanS = usage ? Math.round(usage.windowMs / 1000) : 0;
  const span = spanS >= 55 ? "the last minute" : `the last ${spanS} s`;
  const radioSeries = useMemo(() => history.map((h) => ratesOf(h).radioPct), [history]);
  const level = battery ? Math.round(battery.level * 100) : null;
  const engineText = engine === "mic" ? "Microphone + on-device VAD" : engine === "text" ? "Typed input (no microphone)" : "Not started";
  const running = state === "listening" || state === "hearing";

  return (
    <div className="lab-live glass">
      <div className="lab-sub__head">
        <h3 className="lab-sub__title">
          <Smartphone size={14} aria-hidden /> This device, live
        </h3>
        <span className={`lab-live__state${running ? " is-on" : ""}`}>
          <i className={`dot ${running ? "dot-ok dot-pulse" : ""}`} aria-hidden /> {state}
        </span>
      </div>

      <dl className="lab-kvs">
        <Kv label="Capture">{engineText}</Kv>
        <Kv label="Power mode" title="Eco: stricter VAD threshold, bigger packet batches and an energy pre-gate. Switches on by itself below 30 % battery when not charging.">
          {mode === "eco" ? (
            <span className="lab-eco">
              <Leaf size={13} aria-hidden /> Eco{autoEco ? " · low battery" : ""}
            </span>
          ) : (
            "Normal"
          )}
        </Kv>
        <Kv label="Battery">
          {battery && level !== null ? (
            <span className="lab-batt">
              <LevelIcon level={battery.level} charging={battery.charging} />
              <b className="tnum">{level} %</b>
              {battery.charging ? <span>charging</span> : null}
            </span>
          ) : (
            <span className="lab-dim">not exposed by this browser</span>
          )}
        </Kv>
        <Kv label="Screen wake lock">{wakeLock ? "Held while the session runs" : <span className="lab-dim">not held</span>}</Kv>
      </dl>

      {stats && rates ? (
        <>
          <p className="lab-live__span">Averages over {span}</p>
          <div className="lab-live__grid">
            <div className="lab-stat" title="Share of the last window with a streaming socket open, including a 2 s tail. Silence keeps it at zero.">
              <Radio size={14} aria-hidden />
              <b className="tnum">{pct(rates.radioPct, rates.radioPct < 10 ? 1 : 0)}</b>
              <span>radio on</span>
            </div>
            <div className="lab-stat" title="CPU time spent in the VAD and packetizing, per minute of wall clock.">
              <Cpu size={14} aria-hidden />
              <b className="tnum">{Math.round(rates.cpuMsPerMin)}</b>
              <span>CPU ms / min</span>
            </div>
            <div className="lab-stat" title="Audio payload sent upstream (base64), per minute.">
              <Upload size={14} aria-hidden />
              <b className="tnum">{formatBytes(rates.bytesPerMin)}</b>
              <span>per minute</span>
            </div>
            <div className="lab-stat" title="Frames the energy pre-gate kept away from the VAD (eco mode).">
              <Leaf size={14} aria-hidden />
              <b className="tnum">{skipped === null ? "–" : pct(skipped)}</b>
              <span>frames skipped</span>
            </div>
          </div>
          <div className="lab-live__trend">
            <span className="lab-live__trendlabel">{history.length === 1 ? "Radio on, latest 5 s window" : `Radio on, last ${history.length} windows of 5 s`}</span>
            <Trend values={radioSeries} width={150} height={28} />
          </div>
          {session ? (
            <p className="lab-live__saved">
              Since the Lab opened: <b className="tnum">{session.savedPct}%</b> less modelled energy than streaming all the time.
            </p>
          ) : null}
        </>
      ) : (
        <p className="lab-live__empty">
          <Info size={14} aria-hidden />
          {engine === "text" ? "Typed input uses no microphone, so there are no capture windows to measure." : "No capture windows yet. The mic engine reports one every 5 s while it runs."}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ model --

function ModelCard({ model }: { model: EnergyModel | undefined }) {
  const minute = naiveUsage(60_000);
  return (
    <div className="lab-model-card glass">
      <div className="lab-sub__head">
        <h3 className="lab-sub__title">
          <FlaskConical size={14} aria-hidden /> The model
        </h3>
        <ModelBadge />
      </div>
      {model ? (
        <>
          <p className="lab-formula mono">
            E = cpu_ms × <b>{model.cpuMsCost}</b> + radio_ms × <b>{model.radioMsCost}</b> + bytes × <b>{model.byteCost}</b>
          </p>
          <p className="lab-model-card__p">
            Relative units: the radio is modelled as 6× as expensive per millisecond as the CPU, because keeping a socket streaming is what drains a phone. The constants come from the server, so the numbers here and in the report always agree.
          </p>
          <div className="lab-model-card__base">
            <div className="lab-sub__label">Naive baseline</div>
            <p>
              Streams 16 kHz × 16-bit audio all the time: <b>{formatBytes(minute.bytesUp)}</b> a minute as base64, radio on <b>100 %</b>, plus 5 % CPU for capture. That is about <b>{formatUnits(energyOf(minute, model))}</b> units a minute.
            </p>
          </div>
        </>
      ) : (
        <div className="shimmer" style={{ height: "5rem" }} aria-hidden />
      )}
      <p className="lab-model-card__note">Honest limits: a PWA cannot capture with the screen off on iOS, and real draw depends on the radio, the brightness and the battery. Use this to compare modes, not to promise hours.</p>
    </div>
  );
}

// ------------------------------------------------------------------ table --

function DeviceTable({ rows }: { rows: readonly BatteryRow[] }) {
  const selfId = useConnection((s) => s.deviceId);
  const devices = useDevices((s) => s.devices);
  const names = useMemo(() => new Map(devices.map((d) => [d.deviceId, d.name])), [devices]);
  const sorted = useMemo(() => [...rows].sort((a, b) => Number(b.deviceId === selfId) - Number(a.deviceId === selfId) || b.windowMs - a.windowMs), [rows, selfId]);

  return (
    <div className="lab-bt__scroll">
      <table className="lab-table lab-table--battery">
        <caption className="sr-only">Modelled energy per device and power mode, compared with naive always-on streaming.</caption>
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col">Mode</th>
            <th scope="col">Observed</th>
            <th scope="col">Radio on</th>
            <th scope="col">CPU</th>
            <th scope="col">Upload</th>
            <th scope="col">Energy · model</th>
            <th scope="col">vs. naive</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const rate = ratesOf(r);
            const share = r.naiveEnergy > 0 ? Math.min(1, r.energy / r.naiveEnergy) : 0;
            const tone = reductionTone(r.savedPct);
            const name = names.get(r.deviceId) ?? `${r.deviceId.slice(0, 18)}${r.deviceId.length > 18 ? "…" : ""}`;
            return (
              <tr key={`${r.deviceId}|${r.mode}`} className="lab-row">
                <th scope="row" className="lab-row__stage">
                  <span className="lab-row__name">
                    {name}
                    {r.deviceId === selfId ? <span className="chip chip-tint chip-cyan lab-self">this device</span> : null}
                  </span>
                  {typeof r.lastLevel === "number" ? <span className="lab-row__span">battery {Math.round(r.lastLevel * 100)} %</span> : null}
                </th>
                <td data-label="Mode">
                  {r.mode === "eco" ? (
                    <span className="chip chip-tint chip-ok">
                      <Leaf size={11} aria-hidden /> <span>eco</span>
                    </span>
                  ) : (
                    <span className="chip">
                      <span>{r.mode}</span>
                    </span>
                  )}
                </td>
                <td data-label="Observed" className="tnum">
                  {formatWindow(r.windowMs)}
                </td>
                <td data-label="Radio on" className="tnum">
                  {pct(r.radioActivePct, r.radioActivePct < 10 ? 1 : 0)}
                </td>
                <td data-label="CPU" className="tnum">
                  {Math.round(rate.cpuMsPerMin)} ms/min
                </td>
                <td data-label="Upload" className="tnum">
                  {formatBytes(rate.bytesPerMin)}/min
                  <span className="lab-cell-sub">{formatBytes(r.bytesUp)} in total</span>
                </td>
                <td data-label="Energy · model">
                  <span className="lab-mini">
                    <span className="lab-meter lab-meter--sm">
                      <span className="lab-meter__fill" style={{ width: `${Math.max(1.5, share * 100)}%` }} />
                    </span>
                    <span className="tnum lab-mini__txt">
                      {formatUnits(r.energy)} <span className="lab-dim">of {formatUnits(r.naiveEnergy)}</span>
                    </span>
                  </span>
                </td>
                <td data-label="vs. naive">
                  <ToneChip tone={tone} small labels={{ good: `${r.savedPct} % less`, ok: `${r.savedPct} % less`, bad: `${r.savedPct} % less` }} title={`Target: at least ${REDUCTION_TARGET} % less than naive streaming`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ panel --

export const BatteryLab = memo(function BatteryLab({ battery }: { battery: Polled<BatteryResponse> }) {
  const { data, error, loading } = battery;
  const stats = useAudioUi((s) => s.stats);
  const history = useStatsHistory(60);
  const model = data?.model;
  const rows = data?.report ?? [];

  const overall = useMemo(() => compareReport(rows), [rows]);
  const session = useMemo(() => (model && history.length ? compare(sumUsage(history), model) : null), [model, history]);
  const live = useMemo(() => (model && stats ? compare(stats, model) : null), [model, stats]);

  return (
    <Panel
      id="lab-battery"
      icon={<BatteryCharging size={16} />}
      title="Battery Lab"
      sub="What the capture pipeline costs, against streaming audio all the time. The radio only wakes while you speak."
      badge={<ModelBadge />}
      className="lab-panel--wide"
    >
      {loading && !data ? (
        <div className="lab-skel" aria-hidden>
          <span className="shimmer" style={{ height: "7rem" }} />
          <span className="shimmer" style={{ height: "9rem" }} />
        </div>
      ) : (
        <>
          {error && !data ? (
            <p className="lab-error" role="alert">
              Could not load the battery report: {error}
            </p>
          ) : null}
          <ComparisonCard overall={overall} session={session} live={live} model={model} rows={rows.length} />
          <div className="lab-battery__grid">
            <LiveDevice session={session} history={history} />
            <ModelCard model={model} />
          </div>
          <div className="lab-sub">
            <div className="lab-sub__head">
              <h3 className="lab-sub__title">
                <Radio size={14} aria-hidden /> Per device and power mode
              </h3>
              <span className="lab-dim">from the server report · refreshes every few seconds</span>
            </div>
            {rows.length > 0 ? (
              <DeviceTable rows={rows} />
            ) : (
              <div className="empty lab-empty">
                <Smartphone size={22} aria-hidden />
                <p>No device has reported yet. Every device sends a capture window every 5 s while its microphone is on.</p>
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
});
