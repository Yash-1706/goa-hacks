import { Fragment } from "react";
import { motion } from "motion/react";
import { ArrowRight, Cpu, Eye, EyeOff, Hourglass, Link2, Mic, ShieldCheck } from "lucide-react";
import type { FragmentTransport, ThoughtView } from "@synapse/shared";
import { formatClockSeconds, formatCountdown, formatGap, formatMs, placeLabel } from "@/lib/format";
import { MIN_VISIBLE_GAP_MS } from "@/lib/stream-group";

const TRANSPORT: Record<FragmentTransport, string> = {
  wispr_ws: "Wispr",
  wispr_rest: "Wispr REST",
  wispr_proxy: "Wispr (proxy)",
  local_stt: "local STT",
  cloud_stt: "Sarvam (cloud STT)",
  mock: "typed / mock",
  replay: "replay",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="trail__sec">
      <div className="trail__label">{label}</div>
      <div className="trail__val">{children}</div>
    </div>
  );
}

function TimingBars({ t }: { t: ThoughtView["timing"] }) {
  const items: Array<[string, number | undefined, string]> = [
    ["Wispr (commit → final)", t.wisprMs, "#818cf8"],
    ["Embed", t.embedMs, "#38bdf8"],
    ["Local triage", t.triageMs, "#22d3ee"],
    ["Fragment → first paint", t.fragToFirstPaintMs, "#34d399"],
    ["Model call", t.llmMs, "#a78bfa"],
    ["Fragment → artifact", t.fragToArtifactMs, "#e879f9"],
  ];
  const known = items.filter((i): i is [string, number, string] => typeof i[1] === "number");
  if (!known.length) return <span className="ab__hint">No timing recorded for this card.</span>;
  const max = Math.max(1000, ...known.map((i) => i[1]));
  return (
    <div className="trail__bars">
      {known.map(([label, ms, color]) => (
        <div key={label} className="trail__bar">
          <span className="trail__barlabel">{label}</span>
          <span className="bar">
            <i style={{ width: `${Math.max(2, Math.min(100, (ms / max) * 100))}%`, background: color }} />
          </span>
          <span className="tnum trail__barval">{formatMs(ms)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The reasoning trail (CTX-9): exactly what was heard (with pauses and whispers), what was resolved, what
 * was rejected, why the card is kept, and which model produced it.
 */
export function TrailDrawer({ thought: t, now }: { thought: ThoughtView; now: number }) {
  const frags = [...t.fragments].sort((a, b) => a.tStart - b.tStart);
  const unresolved = t.references.filter((r) => !r.resolvedId);
  const resolved = t.references.filter((r) => r.resolvedId);
  const tm = t.timing;
  const tokens = tm.inputTokens !== undefined ? `${tm.inputTokens.toLocaleString()} in / ${(tm.outputTokens ?? 0).toLocaleString()} out${tm.cachedTokens ? ` · ${tm.cachedTokens.toLocaleString()} cached` : ""}` : null;

  return (
    <motion.div
      className="trail"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 40 }}
      style={{ overflow: "hidden" }}
    >
      <div className="trail__inner">
        <Row label={`Heard · ${frags.length} fragment${frags.length === 1 ? "" : "s"}`}>
          <div className="trail__frags">
            {frags.map((f, i) => {
              const prev = frags[i - 1];
              const gap = i === 0 ? 0 : f.pauseBeforeMs > 0 ? f.pauseBeforeMs : Math.max(0, f.tStart - (prev?.tEnd ?? f.tStart));
              return (
                <Fragment key={f.id}>
                  {gap >= MIN_VISIBLE_GAP_MS ? <div className="trail__gap tnum">⋯ {formatGap(gap)}</div> : null}
                  <div className={`trail__frag${f.whisper ? " trail__frag--whisper" : ""}`}>
                    <span className="trail__time mono tnum">{formatClockSeconds(f.tStart)}</span>
                    <span className="trail__text">{f.text}</span>
                    <span className="trail__meta">
                      {f.whisper ? (
                        <span className="chip chip-mono" title="Detected as a whisper (low volume)">
                          <EyeOff size={10} /> whisper
                        </span>
                      ) : null}
                      <span className="chip chip-mono" title={`Transcribed via ${TRANSPORT[f.transport] ?? f.transport}`}>
                        <Mic size={10} /> {TRANSPORT[f.transport] ?? f.transport}
                      </span>
                      <span className="chip chip-mono">{placeLabel(f.activity)}</span>
                      {f.lang ? <span className="chip chip-mono">{f.lang}</span> : null}
                    </span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </Row>

        {t.intent ? (
          <Row label="Reconstructed as">
            <span className="trail__intent">{t.intent}</span>
          </Row>
        ) : null}

        {resolved.length || unresolved.length ? (
          <Row label="References">
            <div className="trail__list">
              {resolved.map((r, i) => (
                <div key={`r${i}`} className="trail__ref">
                  <Link2 size={13} aria-hidden style={{ color: "var(--violet)" }} />
                  <span>“{r.mention}”</span>
                  <ArrowRight size={12} aria-hidden />
                  <b className="mono">{r.resolvedCode}</b>
                  <span className="trail__refl">{r.label}</span>
                  <span className="tnum trail__conf">{Math.round(r.confidence * 100)}%</span>
                  {r.assumed ? <span className="chip chip-tint chip-warn">assumed</span> : null}
                </div>
              ))}
              {unresolved.map((r, i) => (
                <div key={`u${i}`} className="trail__ref trail__ref--none">
                  <Eye size={13} aria-hidden />
                  <span>“{r.mention}”</span>
                  <span className="trail__refl">no matching memory found</span>
                </div>
              ))}
            </div>
          </Row>
        ) : null}

        {t.repairs.length ? (
          <Row label="Self-repairs">
            <div className="trail__list">
              {t.repairs.map((r, i) => (
                <div key={i} className="trail__ref">
                  <span style={{ textDecoration: "line-through", color: "var(--danger)" }}>{r.rejected}</span>
                  <ArrowRight size={12} aria-hidden />
                  <b>{r.chosen}</b>
                </div>
              ))}
            </div>
          </Row>
        ) : null}

        <Row label="Memory">
          <div className="trail__mem">
            <div className="trail__barline">
              <span className="bar" style={{ width: "9rem" }} title="Salience: how strongly this earns long-term memory">
                <i style={{ width: `${Math.round(Math.min(1, t.salience) * 100)}%` }} />
              </span>
              <span className="tnum" style={{ color: "var(--dim)" }}>
                salience {t.salience.toFixed(2)}
              </span>
              {t.promoted ? (
                <span className="chip chip-tint chip-ok">
                  <ShieldCheck size={11} /> remembered
                </span>
              ) : t.expiresAt ? (
                <span className="chip chip-tint chip-warn">
                  <Hourglass size={11} /> forgets in {formatCountdown(t.expiresAt - now)}
                </span>
              ) : null}
            </div>
            {t.salienceReasons.length ? (
              <div className="cchips">
                {t.salienceReasons.map((r) => (
                  <span key={r} className="chip">
                    {r}
                  </span>
                ))}
              </div>
            ) : (
              <span className="ab__hint">Nothing has made this worth keeping yet. It will be forgotten automatically.</span>
            )}
          </div>
        </Row>

        <Row label="Model">
          <div className="trail__list">
            <div className="trail__ref">
              <Cpu size={13} aria-hidden />
              <b>{t.source === "llm" ? tm.model ?? "claude" : t.source === "mock" ? "mock cortex (deterministic, no LLM)" : "local triage only"}</b>
              <span className="chip chip-mono">v{t.version}</span>
              {tokens ? <span className="trail__refl tnum">{tokens}</span> : null}
            </div>
            {typeof t.redactions === "number" ? (
              <div className="trail__ref">
                <ShieldCheck size={13} aria-hidden style={{ color: "var(--ok)" }} />
                <span>
                  <b className="tnum">{t.redactions}</b> value{t.redactions === 1 ? "" : "s"} masked before the cloud call
                </span>
              </div>
            ) : null}
            {t.degraded ? (
              <div className="trail__ref" style={{ color: "#fcd34d" }}>
                Live model bypassed: {t.degraded}
              </div>
            ) : null}
          </div>
        </Row>

        <Row label="Latency">
          <TimingBars t={tm} />
        </Row>
      </div>
    </motion.div>
  );
}
