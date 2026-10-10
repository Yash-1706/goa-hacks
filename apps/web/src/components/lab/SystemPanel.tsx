import { memo, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, Cloud, Cpu, Database, GitBranch, KeyRound, Lock, Mic, Network, Server, TriangleAlert } from "lucide-react";
import { useNow } from "@/hooks/useNow";
import { formatCountdown, formatRange, plural } from "@/lib/format";
import { calendarWindow } from "@/lib/lab-diagnostics";
import { llmLabel } from "@/lib/llm-provider";
import type { HealthResponse, SettingsResponse } from "@/net/api-types";
import { useCalendar } from "@/state/devices";
import { useConnection } from "@/state/connection";
import { useSettings } from "@/state/settings";
import { Panel } from "./Panel";
import type { Polled } from "./usePolled";

/* System & modes: which services this run is really using (all from GET /api/health, GET /api/settings and the welcome
 * config), the memory counters, and the local calendar Synapse uses for conflicts. No keys, no tokens, no transcript text:
 * the key-encryption row shows only WHERE the master key lives, never the key. */

type Badge = "live" | "mock" | "info" | "ok" | "off" | "warn";

function B({ kind, children, title }: { kind: Badge; children: ReactNode; title?: string }) {
  return (
    <span className={`lab-badge lab-badge--${kind}`} title={title}>
      {children}
    </span>
  );
}

function Mode({ icon, label, badge, children }: { icon: ReactNode; label: string; badge: ReactNode; children?: ReactNode }) {
  return (
    <div className="lab-mode">
      <div className="lab-mode__ic" aria-hidden>
        {icon}
      </div>
      <div className="lab-mode__body">
        <div className="lab-mode__top">
          <span className="lab-mode__label">{label}</span>
          {badge}
        </div>
        {children ? <p className="lab-mode__note">{children}</p> : null}
      </div>
    </div>
  );
}

const WISPR_NOTE: Record<string, string> = {
  client: "Audio streams from this browser straight to Wispr with a short-lived token. It never reaches the Synapse server.",
  proxy: "The server relays audio to Wispr. It is held in memory only and never written to disk.",
  mock: "Typed or replayed transcripts: no Wispr key, and no audio leaves the browser.",
  local: "Whisper runs on the machine that runs the server. Audio goes from the browser to that machine only, is held in memory for one utterance and zeroed. Nothing leaves it.",
};

const KEK_NOTE: Record<string, string> = {
  keyring: "The master key lives in your OS keychain.",
  passphrase: "The master key is derived from your passphrase (scrypt).",
  file: "The master key sits in a local key file (the Privacy Center warns about this).",
};

export const SystemPanel = memo(function SystemPanel({ health, settings }: { health: Polled<HealthResponse>; settings: Polled<SettingsResponse> }) {
  const cfg = useSettings((s) => s.config);
  const status = useConnection((s) => s.status);
  const rtt = useConnection((s) => s.rttMs);
  const offset = useConnection((s) => s.clockOffsetMs);
  const events = useCalendar((s) => s.events);
  const now = useNow(1000);

  const h = health.data;
  const s = settings.data;
  const wispr = s?.wisprMode ?? cfg?.wisprMode;
  const llm = h?.modes.llm ?? (cfg ? (cfg.localOnly ? "local-only" : cfg.llmMode) : undefined);
  // the live provider: the welcome config knows it, and so does /api/health (llmProvider); Claude when neither says
  const llmName = llmLabel({ llmProvider: cfg?.llmProvider ?? (h?.llmProvider === "groq" ? "groq" : h?.llmProvider === "anthropic" ? "anthropic" : undefined), llmModel: cfg?.llmModel ?? h?.models.fast });
  const groqStats = h?.groq ?? null;
  const embeddings = h?.modes.embeddings ?? cfg?.embeddings;
  const kek = h?.modes.kek ?? s?.kekSource;
  const localOnly = s?.localOnly ?? cfg?.localOnly;
  const github = s?.integrations.github ?? cfg?.integrations.github;
  const jira = s?.integrations.jira ?? cfg?.integrations.jira;
  const uptime = h && health.at ? h.uptimeS + Math.max(0, now - health.at) / 1000 : null;
  const minute = Math.floor(now / 60_000); // re-evaluate "what is ahead" once a minute
  const cal = useMemo(() => calendarWindow(events, minute * 60_000, 6), [events, minute]);

  const mem = h?.memory;
  const memItems: Array<[string, number | undefined]> = [
    ["thoughts", mem?.thoughts],
    ["promoted", mem?.promoted],
    ["fragments", mem?.fragments],
    ["entities", mem?.entities],
    ["edges", mem?.edges],
    ["artifacts", mem?.artifacts],
  ];

  return (
    <Panel
      id="lab-system"
      icon={<Server size={16} />}
      title="System and modes"
      sub="What this run is really using. Everything here is read from the server; no keys, tokens or transcript text are ever shown."
      badge={
        h ? (
          <span className="lab-count" title="Time since the server started">
            <span className="dot dot-ok" aria-hidden /> up <b className="tnum">{uptime !== null ? formatCountdown(uptime * 1000) : "–"}</b>
          </span>
        ) : undefined
      }
      className="lab-panel--system"
    >
      {!h && !s && !cfg ? (
        <div className="lab-skel" aria-hidden>
          <span className="shimmer" style={{ height: "8rem" }} />
        </div>
      ) : (
        <div className="lab-system">
          <div className="lab-modes">
            <Mode
              icon={<Mic size={16} />}
              label="Transcription"
              badge={wispr ? <B kind={wispr === "mock" ? "mock" : wispr === "local" ? "ok" : "live"}>{wispr === "client" ? "Wispr · client" : wispr === "proxy" ? "Wispr · proxy" : wispr === "local" ? "on-device" : "mock"}</B> : <B kind="off">–</B>}
            >
              {wispr ? WISPR_NOTE[wispr] : "Waiting for the server."}
              {wispr === "local" && h?.stt ? (
                <>
                  {" "}
                  <span className="mono">{h.stt.model}</span>:{" "}
                  {h.stt.state === "ready" ? (
                    <>
                      ready{h.stt.loadMs !== null ? <> (loaded in <b className="tnum">{(h.stt.loadMs / 1000).toFixed(1)} s</b>)</> : null}
                      {h.stt.lastMs !== null && h.stt.lastAudioMs !== null ? <>, last utterance <b className="tnum">{(h.stt.lastAudioMs / 1000).toFixed(1)} s</b> of speech in <b className="tnum">{(h.stt.lastMs / 1000).toFixed(1)} s</b></> : null}
                    </>
                  ) : h.stt.state === "loading" ? (
                    "loading the model (the first time it is downloaded, about 40 MB)…"
                  ) : h.stt.state === "error" ? (
                    <>could not load{h.stt.error ? `: ${h.stt.error}` : ""}</>
                  ) : (
                    "loads on first use."
                  )}
                </>
              ) : null}
            </Mode>
            <Mode
              icon={<Cloud size={16} />}
              label="Cortex"
              badge={llm ? <B kind={llm === "live" ? "live" : llm === "local-only" ? "warn" : "mock"}>{llm === "live" ? `${llmName.provider} · live` : llm === "local-only" ? "local-only" : "mock"}</B> : <B kind="off">–</B>}
            >
              {llm === "live" ? (
                <>
                  Fast <span className="mono">{h?.models.fast ?? "–"}</span> on the hot path, deep <span className="mono">{h?.models.deep ?? "–"}</span> for briefs.
                  {groqStats ? (
                    <>
                      {" "}
                      Free tier: <b className="tnum">{groqStats.requestsToday}</b> requests today, <b className="tnum">{groqStats.remainingTokensLastSeen ?? "–"}</b> tokens left this minute.
                    </>
                  ) : null}
                </>
              ) : llm === "local-only" ? (
                "Cloud model calls are off: local heuristics only."
              ) : (
                <>
                  The real pipeline with a deterministic mock cortex. Configured models: <span className="mono">{h?.models.fast ?? "–"}</span> and <span className="mono">{h?.models.deep ?? "–"}</span>.
                </>
              )}
            </Mode>
            <Mode icon={<Cpu size={16} />} label="Embeddings" badge={embeddings ? <B kind={embeddings === "model" ? "ok" : "warn"}>{embeddings === "model" ? "on-device model" : "hash fallback"}</B> : <B kind="off">–</B>}>
              {embeddings === "hash" ? "The ONNX model is unavailable, so a hashing embedder is used. Recall quality drops." : <span className="mono">{h?.models.embed ?? "–"}</span>}
            </Mode>
            <Mode icon={<KeyRound size={16} />} label="Key encryption" badge={kek ? <B kind={kek === "file" ? "warn" : "ok"}>{kek}</B> : <B kind="off">–</B>}>
              {kek ? `${KEK_NOTE[kek] ?? "Master key source reported by the vault."} Data is AES-256-GCM at rest.` : "Waiting for the server."}
            </Mode>
            <Mode
              icon={<Lock size={16} />}
              label="Local-only mode"
              badge={localOnly === undefined ? <B kind="off">–</B> : localOnly ? <B kind="warn">on</B> : <B kind="off">off</B>}
            >
              {localOnly ? "No cloud model calls. " : "Cloud model calls are allowed, with redaction first. "}
              <Link to="/privacy">Privacy Center</Link>
            </Mode>
            <Mode
              icon={<GitBranch size={16} />}
              label="Integrations"
              badge={
                <span className="lab-badges">
                  <B kind={github ? "live" : "mock"} title={github ? "A GitHub token and repo are configured" : "No GitHub credentials: pushes are simulated"}>
                    GitHub · {github ? "live" : "simulated"}
                  </B>
                  <B kind={jira ? "live" : "mock"} title={jira ? "Jira credentials are configured" : "No Jira credentials: pushes are simulated"}>
                    Jira · {jira ? "live" : "simulated"}
                  </B>
                </span>
              }
            >
              {github || jira ? "A live integration creates real items. Email and messages are only ever drafted." : "Simulated pushes get a local reference; nothing leaves your machine. Email and messages are only ever drafted."}
            </Mode>
          </div>

          <div className="lab-side">
            <div className="lab-sub">
              <div className="lab-sub__head">
                <h3 className="lab-sub__title">
                  <Database size={14} aria-hidden /> Memory
                </h3>
                {h?.paused ? <B kind="warn">paused</B> : <B kind="ok">recording thoughts</B>}
              </div>
              <dl className="lab-memstats">
                {memItems.map(([k, v]) => (
                  <div key={k} className="lab-memstat">
                    <dd className="tnum">{v ?? "–"}</dd>
                    <dt>{k}</dt>
                  </div>
                ))}
              </dl>
              {s ? (
                <p className="lab-retention">
                  Working memory is forgotten after <b>{s.ttlHours} h</b>, a pause purges the last <b>{s.pauseWindowSecs} s</b>, a thought is promoted at salience <b>{s.promoteThreshold.toFixed(2)}</b>, name pseudonymising is <b>{s.pseudonymize ? "on" : "off"}</b>.
                </p>
              ) : null}
            </div>

            <div className="lab-sub">
              <div className="lab-sub__head">
                <h3 className="lab-sub__title">
                  <Network size={14} aria-hidden /> Server link
                </h3>
                <B kind={status === "open" ? "ok" : status === "auth" ? "warn" : "off"}>{status === "open" ? "connected" : status}</B>
              </div>
              <dl className="lab-kvs lab-kvs--tight">
                <div className="lab-kv">
                  <dt>Round trip</dt>
                  <dd className="tnum">{rtt !== null ? `${Math.round(rtt)} ms` : "–"}</dd>
                </div>
                <div className="lab-kv" title="Server clock minus this browser's clock: latencies measured across the two are corrected by it.">
                  <dt>Clock offset</dt>
                  <dd className="tnum">{offset !== null ? `${offset >= 0 ? "+" : "−"}${Math.abs(Math.round(offset))} ms` : "–"}</dd>
                </div>
                <div className="lab-kv">
                  <dt>Time zone</dt>
                  <dd>{cfg?.timezone ?? "–"}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="lab-cal lab-sub">
            <div className="lab-sub__head">
              <h3 className="lab-sub__title">
                <CalendarClock size={14} aria-hidden /> Local calendar
              </h3>
              <span className="lab-dim">{plural(cal.total, "event")} · used for clashes and reschedule slots</span>
            </div>
            {cal.events.length === 0 ? (
              <div className="empty lab-empty">
                <CalendarClock size={20} aria-hidden />
                <p>No events yet. Say “let’s schedule a design review Thursday at 3pm” and push the card to add one.</p>
              </div>
            ) : (
              <ul className="lab-events">
                {!cal.upcoming ? <li className="lab-events__note">Nothing ahead. The latest events:</li> : null}
                {cal.events.map((e) => {
                  const clash = cal.clashes.get(e.id);
                  return (
                    <li key={e.id} className={`lab-event${clash ? " is-clash" : ""}`}>
                      <span className="lab-event__when tnum">{formatRange(e.start, e.end)}</span>
                      <span className="lab-event__title">{e.title}</span>
                      <span className="chip lab-event__src">
                        <span>{e.source}</span>
                      </span>
                      {clash ? (
                        <span className="chip chip-tint chip-warn" title={`Overlaps ${clash.join(", ")}`}>
                          <TriangleAlert size={11} aria-hidden /> <span>clashes with {clash.join(", ")}</span>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
});
