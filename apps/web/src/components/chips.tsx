import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Battery,
  BatteryCharging,
  BatteryLow,
  EyeOff,
  Footprints,
  Car,
  Keyboard,
  Leaf,
  Monitor,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import type { DeviceInfo } from "@synapse/shared";
import { formatMs, latencyTone } from "@/lib/format";
import { llmLabel } from "@/lib/llm-provider";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { useDevices } from "@/state/devices";
import { useMetrics } from "@/state/metrics";
import { usePrivacy } from "@/state/privacy";
import { useSettings } from "@/state/settings";
import { useStream } from "@/state/stream";

export const ConnectionChip = memo(function ConnectionChip() {
  const status = useConnection((s) => s.status);
  const rtt = useConnection((s) => s.rttMs);
  const attempt = useConnection((s) => s.reconnectAttempt);
  const cfg = useSettings((s) => s.config);

  const live = status === "open";
  const cls = live ? "tchip tchip--ok" : status === "auth" ? "tchip tchip--warn" : "tchip tchip--paused";
  const text = live ? "Connected" : status === "auth" ? "Pairing needed" : status === "connecting" ? "Connecting…" : `Offline${attempt > 0 ? ` · retry ${attempt}` : ""}`;
  const mock = cfg && (cfg.wisprMode === "mock" || cfg.llmMode === "mock");
  const llm = llmLabel(cfg);
  const llmLive = cfg?.llmMode === "live";
  const title = cfg
    ? `Server link ${live ? "up" : "down"}${rtt !== null && live ? ` · ${Math.round(rtt)} ms round trip` : ""}\nTranscription: ${cfg.wisprMode}\nCortex: ${cfg.llmMode}${llmLive ? ` (${llm.full})` : ""}${cfg.localOnly ? "\nLocal-only mode is ON" : ""}`
    : "Not connected yet";
  const mocked = cfg ? [cfg.wisprMode === "mock" ? "Wispr" : "", cfg.llmMode === "mock" ? llm.provider : ""].filter(Boolean).join(" / ") : "";

  return (
    <span className="inline-flex items-center gap-2">
      <span className={cls} title={title}>
        {live ? <Wifi size={14} /> : <WifiOff size={14} />}
        <span>{text}</span>
        {live && rtt !== null ? <span className="tnum hide-md" style={{ color: "var(--faint)" }}>{Math.round(rtt)} ms</span> : null}
      </span>
      {mock ? (
        <span className="tchip hide-sm" title={`Running without live services: typed input and/or the deterministic mock cortex. Everything on screen is real server output, just not from ${mocked}.`}>
          <b>mock</b>
          <span className="hide-md">{[cfg.wisprMode === "mock" ? "wispr" : "", cfg.llmMode === "mock" ? "llm" : ""].filter(Boolean).join(" + ")}</span>
        </span>
      ) : null}
      {llmLive ? (
        <span className="tchip hide-sm" title={`Live cortex: ${llm.full}. Text is redacted before it leaves this machine.`}>
          <b>live</b>
          <span className="hide-md">
            {llm.provider.toLowerCase()}
            {llm.shortModel ? ` ${llm.shortModel}` : ""}
          </span>
        </span>
      ) : null}
    </span>
  );
});

function ActivityIcon({ a }: { a: DeviceInfo["activity"] }) {
  if (a === "walking") return <Footprints size={13} aria-label="walking" />;
  if (a === "vehicle") return <Car size={13} aria-label="in a vehicle" />;
  return null;
}

function BatteryBit({ b }: { b: NonNullable<DeviceInfo["battery"]> }) {
  const pct = Math.round(b.level * 100);
  const Icon = b.charging ? BatteryCharging : pct < 20 ? BatteryLow : Battery;
  return (
    <span className="inline-flex items-center gap-1 tnum" title={`Battery ${pct}%${b.charging ? " (charging)" : ""}`} style={{ color: pct < 20 && !b.charging ? "var(--danger)" : undefined }}>
      <Icon size={13} />
      {pct}%
    </span>
  );
}

export const DeviceChips = memo(function DeviceChips() {
  const devices = useDevices((s) => s.devices);
  const selfId = useConnection((s) => s.deviceId);
  const shown = devices.slice(0, 3);
  if (!devices.length) return null;
  return (
    <span className="inline-flex items-center gap-2 hide-sm">
      {shown.map((d) => {
        const Icon = d.kind === "pocket" ? Smartphone : Monitor;
        const dot = d.speaking ? "dot dot-cyan dot-pulse" : d.listening ? "dot dot-ok" : "dot";
        const state = d.speaking ? "speaking" : d.listening ? "listening" : "idle";
        return (
          <span key={d.deviceId} className="tchip" title={`${d.name}${d.deviceId === selfId ? " (this device)" : ""} · ${state}${d.mode === "eco" ? " · Eco mode" : ""}`}>
            <Icon size={14} />
            <b className="hide-md">{d.name}</b>
            <span className={dot} aria-hidden />
            <span className="sr-only">{state}</span>
            <ActivityIcon a={d.activity} />
            {d.mode === "eco" ? <Leaf size={13} style={{ color: "var(--ok)" }} aria-label="eco mode" /> : null}
            {d.battery ? <BatteryBit b={d.battery} /> : null}
          </span>
        );
      })}
      {devices.length > shown.length ? <span className="tchip">+{devices.length - shown.length}</span> : null}
    </span>
  );
});

export const PrivacyShield = memo(function PrivacyShield() {
  const paused = usePrivacy((s) => s.paused);
  const state = useAudioUi((s) => s.state);
  const engine = useAudioUi((s) => s.engine);
  const wispr = useSettings((s) => s.config?.wisprMode);

  let cls = "tchip";
  let Icon = ShieldCheck;
  let main = "Mic off";
  let sub = "audio never stored";
  if (paused || state === "paused") {
    cls = "tchip tchip--paused";
    Icon = ShieldOff;
    main = "Paused";
    sub = "mic released";
  } else if (state === "listening" || state === "hearing") {
    cls = "tchip tchip--ok";
    if (engine === "text" || wispr === "mock") {
      Icon = Keyboard;
      main = "Typed input";
      sub = "no microphone";
    } else {
      main = "Listening";
      sub = "audio never stored";
    }
  }
  return (
    <Link to="/privacy" className={cls} title="Privacy Center: what is stored, what leaves this device, and how to forget it. Audio is never stored.">
      <Icon size={15} />
      <b>{main}</b>
      <span className="hide-md" style={{ color: "var(--dim)" }}>
        {sub}
      </span>
    </Link>
  );
});

export const AsideChip = memo(function AsideChip() {
  const n = useStream((s) => s.asideCount);
  const bump = useStream((s) => s.asideBump);
  if (n <= 0) return null;
  return (
    <span key={bump} className="tchip tchip--bump hide-sm" title="Fragments that were not for Synapse (side remarks, filler, speech to other people). They are counted and then dropped: never stored.">
      <EyeOff size={14} />
      <b className="tnum">{n}</b>
      <span>{n === 1 ? "aside" : "asides"} filtered</span>
    </span>
  );
});

/** Tiny SVG sparkline: newest on the right, dashed amber line at the 1 s target. */
export function Sparkline({ values, width = 78, height = 24, target = 1000, max }: { values: number[]; width?: number; height?: number; target?: number; max?: number }) {
  const geometry = useMemo(() => {
    if (values.length < 2) return null;
    const top = Math.max(max ?? 0, target * 1.25, ...values) || 1;
    const step = width / (values.length - 1);
    const pts = values.map((v, i) => [i * step, height - 2 - (Math.min(v, top) / top) * (height - 4)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `${line} L${width},${height} L0,${height} Z`;
    const ty = height - 2 - (target / top) * (height - 4);
    return { line, area, ty, last: pts[pts.length - 1] as readonly [number, number] };
  }, [values, width, height, target, max]);
  if (!geometry) return <span style={{ width, height }} className="inline-block" aria-hidden />;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id="spark-g" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <line className="target" x1="0" x2={width} y1={geometry.ty} y2={geometry.ty} />
      <path className="area" d={geometry.area} fill="url(#spark-g)" />
      <path className="line" d={geometry.line} stroke="url(#spark-g)" />
      <circle cx={geometry.last[0]} cy={geometry.last[1]} r="2.2" fill="#22d3ee" />
    </svg>
  );
}

export const LatencyChip = memo(function LatencyChip() {
  const samples = useMetrics((s) => s.samples);
  const summary = useMetrics((s) => s.summary);
  const series = useMemo(() => samples.map((x) => x.artifactMs).filter((v): v is number => typeof v === "number"), [samples]);
  const server = summary?.stages.artifact;
  const last = series.length ? (series[series.length - 1] as number) : undefined;
  const headline = last ?? server?.p50;
  const tone = headline !== undefined ? latencyTone(headline) : undefined;
  const color = tone === "good" ? "var(--ok)" : tone === "ok" ? "var(--warn)" : tone === "bad" ? "var(--danger)" : undefined;
  const title = [
    "Fragment → finished card (Wispr final to render).",
    last !== undefined ? `Last: ${formatMs(last)}` : "",
    server ? `Server window: p50 ${formatMs(server.p50)}, p95 ${formatMs(server.p95)} (n=${server.n})` : "",
    "Target: under 1 s.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Link to="/lab" className="tchip hide-sm" title={title}>
      <Zap size={14} style={{ color: color ?? "var(--faint)" }} />
      <Sparkline values={series.slice(-24)} />
      <b className="tnum" style={{ color }}>
        {headline !== undefined ? formatMs(headline) : "–"}
      </b>
      {last === undefined && server ? <span className="hide-md">p50</span> : null}
    </Link>
  );
});
