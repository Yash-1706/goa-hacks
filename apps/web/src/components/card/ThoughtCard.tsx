import { memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Cpu,
  Hourglass,
  Info,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Undo2,
  Upload,
  X,
  Zap,
  ExternalLink,
  CircleSlash,
  TriangleAlert,
} from "lucide-react";
import type { ThoughtView } from "@synapse/shared";
import { ArtifactBody } from "@/components/card/ArtifactBody";
import { EntityChips, OpenQuestions, ReferenceChips, RepairRow } from "@/components/card/CardChips";
import { EditPanel } from "@/components/card/EditPanel";
import { TrailDrawer } from "@/components/card/TrailDrawer";
import { ConfidenceRing } from "@/components/ui/ConfidenceRing";
import { StreamText } from "@/components/ui/StreamText";
import { useNow } from "@/hooks/useNow";
import { ARTIFACT_LABEL, categoryMeta } from "@/lib/category";
import { STATUS_HINT, STATUS_LABEL, isEditable, pushLabel, pushability } from "@/lib/artifacts";
import { formatClock, formatCountdown, formatMs, latencyTone } from "@/lib/format";
import { socket } from "@/runtime";
import { useMetrics } from "@/state/metrics";
import { useThoughts, type RemoveReason } from "@/state/thoughts";

/** thoughts created before this page loaded are drawn in place; only new ones animate in */
const BOOT = Date.now();

const TOMB: Record<RemoveReason, string> = {
  retracted: "Retracted: you said scratch that",
  forgotten: "Forgotten",
  purged: "Forgotten by the pause",
  expired: "Expired from working memory",
  aside: "Filtered as an aside",
  merged: "Merged into another thought",
};

function LatencyBadge({ t }: { t: ThoughtView }) {
  const client = useMetrics((s) => s.byThought[t.id]);
  const tm = t.timing;
  const final = !t.analyzing && !t.provisional;
  const ms = final ? (client?.artifactMs ?? tm.fragToArtifactMs) : (client?.firstPaintMs ?? tm.fragToFirstPaintMs);
  if (ms === undefined) return null;
  const tone = final ? latencyTone(ms) : "good";
  const detail = [
    client?.artifactMs !== undefined ? `Wispr final → finished card: ${formatMs(client.artifactMs)} (measured in this browser)` : "",
    client?.firstPaintMs !== undefined ? `Wispr final → first paint: ${formatMs(client.firstPaintMs)} (measured in this browser)` : "",
    tm.fragToFirstPaintMs !== undefined ? `Server: first paint ${formatMs(tm.fragToFirstPaintMs)}` : "",
    tm.llmMs !== undefined ? `Model: ${formatMs(tm.llmMs)}` : "",
    tm.fragToArtifactMs !== undefined ? `Server: finished ${formatMs(tm.fragToArtifactMs)}` : "",
    tm.model ? `Model: ${tm.model}${tm.cachedTokens ? ` · ${tm.cachedTokens} cached tokens` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`lat lat--${tone}`} title={detail} aria-label={`${final ? "Card finished" : "First paint"} in ${formatMs(ms)}`}>
      <Zap size={11} aria-hidden />
      <span className="tnum">{formatMs(ms)}</span>
      {!final ? <span className="lat__k">first paint</span> : null}
    </span>
  );
}

function Badges({ t }: { t: ThoughtView }) {
  return (
    <>
      {t.provisional && t.analyzing && t.artifact ? (
        <span className="chip chip-tint chip-cyan" title="The model is writing this card right now; fields fill in as they arrive.">
          <Cpu size={11} /> <span>model drafting…</span>
        </span>
      ) : t.provisional ? (
        <span className="chip chip-tint chip-warn" title="Instant first draft from on-device triage. The model's result will replace it.">
          <Cpu size={11} /> <span>local draft</span>
        </span>
      ) : null}
      {!t.provisional && t.source === "mock" ? (
        <span className="chip" title="Produced by the deterministic mock cortex (no LLM key configured)">
          <span>mock</span>
        </span>
      ) : null}
      {!t.provisional && t.source === "local" ? (
        <span className="chip" title="Local heuristics only">
          <span>local</span>
        </span>
      ) : null}
      {t.tentative && !t.provisional ? (
        <span className="chip chip-tint chip-warn chip-dashed" title="Low confidence: Synapse is not sure about this one.">
          <span>tentative</span>
        </span>
      ) : null}
      {t.degraded ? (
        <span className="chip chip-tint chip-danger" title={`The live model was bypassed: ${t.degraded}`}>
          <TriangleAlert size={11} /> <span>{t.degraded}</span>
        </span>
      ) : null}
    </>
  );
}

function Retention({ t, now }: { t: ThoughtView; now: number }) {
  const [open, setOpen] = useState(false);
  if (t.promoted) {
    return (
      <span className="ret ret--kept" title={t.salienceReasons.length ? `Why kept: ${t.salienceReasons.join(", ")}` : "Kept in long-term memory"}>
        <Pin size={12} /> Remembered
        {t.salienceReasons.length ? <span className="ret__why"> · {t.salienceReasons.slice(0, 2).join(", ")}</span> : null}
      </span>
    );
  }
  if (t.expiresAt === null) return null;
  const left = t.expiresAt - now;
  return (
    <span className="ret" title="Working memory: forgotten automatically (the day key is destroyed) unless you keep it or it earns promotion.">
      <Hourglass size={12} /> forgets in <b className="tnum">{formatCountdown(left)}</b>
      <button type="button" className="ret__btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        why kept?
      </button>
      {open ? (
        <span className="ret__pop">
          {t.salienceReasons.length ? `Signals so far: ${t.salienceReasons.join(", ")}. ` : "No strong signal yet. "}
          Salience {t.salience.toFixed(2)}. Repeat it, name a person or component, or tap Keep to promote it.
        </span>
      ) : null}
    </span>
  );
}

export interface ThoughtCardProps {
  id: string;
  /** read-only, denser (Pocket, graph detail) */
  compact?: boolean;
}

export const ThoughtCard = memo(function ThoughtCard({ id, compact = false }: ThoughtCardProps) {
  const t = useThoughts((s) => s.byId[id]);
  const fadingReason = useThoughts((s) => s.fading[id]);
  const now = useNow(30_000);
  const [trail, setTrail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = t?.artifact?.status;
  useEffect(() => {
    setBusy(null);
  }, [status, t?.promoted]);
  useEffect(() => () => void (busyTimer.current && clearTimeout(busyTimer.current)), []);
  useEffect(() => {
    if (!confirmForget) return;
    const timer = setTimeout(() => setConfirmForget(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmForget]);

  if (!t) return null;
  const meta = categoryMeta(t.category);
  const Icon = meta.icon;
  const a = t.artifact;
  const real = a && a.id !== "preview" ? a : null;
  const analyzing = Boolean(t.analyzing);
  const finalLike = !analyzing && !t.provisional;
  const push = pushability(real);
  const editable = real && isEditable(real.kind) && real.status !== "executed" && real.status !== "dismissed";
  const artifactLabel = a && a.kind !== "none" ? ARTIFACT_LABEL[a.kind] : "";
  const decisionHasOptions = a?.kind === "decision" && Boolean((a.payload as { rejected?: string[] }).rejected?.length);

  const send = (action: "accept" | "dismiss" | "push" | "undo" | "forget" | "promote", extra: { patch?: Record<string, unknown> } = {}): void => {
    setBusy(action);
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setBusy(null), 2500);
    socket.send({ type: "card.action", thoughtId: t.id, artifactId: real?.id, action, ...extra });
  };

  return (
    <motion.article
      id={`card-${t.id}`}
      layout="position"
      className="tcard"
      style={{ ["--cat" as string]: meta.color }}
      data-analyzing={analyzing}
      data-provisional={t.provisional}
      data-tentative={t.tentative}
      data-fading={fadingReason ? "true" : undefined}
      data-kind={a?.kind}
      initial={t.createdAt > BOOT - 2000 ? { opacity: 0, y: -22, scale: 0.97 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, filter: "blur(6px)", transition: { duration: 0.28 } }}
      transition={{ type: "spring", stiffness: 340, damping: 32, mass: 0.9 }}
      aria-busy={analyzing}
      aria-label={`${meta.label}: ${t.title || "new thought"}`}
    >
      <span className="tcard__scan" aria-hidden />

      <header className="tcard__head">
        <div className="tcard__badge" aria-hidden>
          <Icon size={18} />
        </div>
        <div className="tcard__titles">
          <h3 className="tcard__title">
            {t.title ? <StreamText text={t.title} streaming={analyzing} /> : <span className="shimmer" style={{ display: "inline-block", width: "55%", height: "1.1rem" }} />}
          </h3>
          <div className="tcard__meta">
            <span className="mono tcard__code">{t.code}</span>
            <span>{meta.label}</span>
            {artifactLabel ? <span className="tcard__sep">{artifactLabel}</span> : null}
            <span className="tnum tcard__sep">{formatClock(t.createdAt)}</span>
            <LatencyBadge t={t} />
            <Badges t={t} />
          </div>
        </div>
        <ConfidenceRing value={t.confidence} thinking={analyzing && t.provisional} />
      </header>

      {t.intent && a && a.kind !== "none" && a.kind !== "recall" ? (
        <p className="tcard__intent" title="What Synapse understood you meant">
          <StreamText text={t.intent} streaming={false} />
        </p>
      ) : null}

      <div className="tcard__body">
        <ArtifactBody thought={t} />
      </div>

      <div className="tcard__notes">
        {t.references.length ? <ReferenceChips refs={t.references} /> : null}
        {t.repairs.length && !decisionHasOptions ? <RepairRow repairs={t.repairs} /> : null}
        {t.openQuestions.length ? <OpenQuestions questions={t.openQuestions} /> : null}
        {!compact && t.entities.length ? <EntityChips entities={t.entities} /> : null}
        {t.why && finalLike ? (
          <div className="tcard__why">
            <Info size={12} aria-hidden /> <span>{t.why}</span>
          </div>
        ) : null}
      </div>

      {!compact ? (
        <>
          <AnimatePresence initial={false}>
            {editing && real ? (
              <EditPanel
                key="edit"
                artifact={real}
                onCancel={() => setEditing(false)}
                onSave={(patch) => {
                  send("accept", { patch: undefined });
                  socket.send({ type: "card.action", thoughtId: t.id, artifactId: real.id, action: "edit", patch });
                  setEditing(false);
                }}
              />
            ) : null}
          </AnimatePresence>

          <footer className="tcard__foot">
            <div className="tcard__ret">
              <Retention t={t} now={now} />
              {real ? (
                <span className={`stat stat--${real.status}`} title={STATUS_HINT[real.status]}>
                  {STATUS_LABEL[real.status]}
                  {real.autonomyLevel ? <span className="stat__l"> L{real.autonomyLevel}</span> : null}
                </span>
              ) : null}
              {real?.externalRef ? (
                real.externalUrl ? (
                  <a className="chip chip-tint chip-cyan" href={real.externalUrl} target="_blank" rel="noopener noreferrer" title="Open the created item">
                    <ExternalLink size={11} /> <span>{real.externalRef}</span>
                  </a>
                ) : (
                  <span className="chip chip-tint chip-cyan chip-mono" title={real.simulated ? "No credentials configured: this was a simulated push (nothing left your machine)" : "Created"}>
                    {real.externalRef}
                  </span>
                )
              ) : null}
              {real?.simulated ? (
                <span className="chip chip-dashed" title="No integration credentials are configured, so the push was simulated.">
                  simulated
                </span>
              ) : null}
            </div>

            <div className="tcard__actions" role="group" aria-label="Card actions">
              {real && real.status !== "executed" && real.status !== "accepted" && real.status !== "dismissed" ? (
                <button type="button" className="btn btn-sm btn-ok" disabled={analyzing || busy !== null} onClick={() => send("accept")} title="Keep: promote this to long-term memory and mark the draft accepted">
                  <Check size={13} /> Keep
                </button>
              ) : null}
              {real && (real.status === "accepted" || real.status === "executed") ? (
                <span className="kept" title={STATUS_HINT[real.status]}>
                  <CheckCheck size={14} /> {real.status === "executed" ? "Done" : "Kept"}
                </span>
              ) : null}
              {real && push.ok ? (
                <button type="button" className="btn btn-sm btn-primary" disabled={analyzing || busy !== null} onClick={() => send("push")} title={`${pushLabel(real.kind)} (private, reversible; nothing is sent to another person)`}>
                  <Upload size={13} /> {pushLabel(real.kind)}
                </button>
              ) : real && real.kind === "calendar_event" && real.status !== "executed" && real.status !== "dismissed" && !push.ok ? (
                <span className="chip chip-dashed" title={push.reason}>
                  needs a time
                </span>
              ) : null}
              {editable ? (
                <button type="button" className="btn btn-sm btn-ghost" disabled={analyzing} onClick={() => setEditing((v) => !v)} aria-expanded={editing} title="Edit the draft">
                  <Pencil size={13} /> Edit
                </button>
              ) : null}
              {real && real.status === "executed" ? (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => send("undo")} title="Undo (closes the issue / removes the hold)">
                  <Undo2 size={13} /> Undo
                </button>
              ) : null}
              {real && real.status !== "dismissed" && real.status !== "executed" ? (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => send("dismiss")} title="Dismiss this draft (the thought stays in memory until it expires)">
                  <CircleSlash size={13} /> Dismiss
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy !== null}
                aria-pressed={t.promoted}
                onClick={() => (t.promoted ? undefined : send("promote"))}
                title={t.promoted ? "Pinned in long-term memory" : "Pin: keep this in long-term memory (skips the 72 h expiry)"}
              >
                {t.promoted ? <PinOff size={13} /> : <Pin size={13} />} {t.promoted ? "Pinned" : "Pin"}
              </button>
              {confirmForget ? (
                <span className="confirm" role="group" aria-label="Confirm forget">
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => send("forget")}>
                    <Trash2 size={13} /> Forget it
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmForget(false)}>
                    <X size={13} />
                  </button>
                </span>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmForget(true)} title="Forget: delete this thought and everything derived from it">
                  <Trash2 size={13} /> Forget
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost trailbtn" aria-expanded={trail} onClick={() => setTrail((v) => !v)} title="The reasoning trail: what was heard, resolved, rejected, and why it is kept">
                Trail <ChevronDown size={13} style={{ transform: trail ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
              </button>
            </div>
          </footer>

          <AnimatePresence initial={false}>{trail ? <TrailDrawer key="trail" thought={t} now={now} /> : null}</AnimatePresence>
        </>
      ) : null}

      <AnimatePresence>
        {fadingReason ? (
          <motion.div className="tcard__tomb" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-live="polite">
            <span className="tcard__tombtxt">{TOMB[fadingReason]}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
});
