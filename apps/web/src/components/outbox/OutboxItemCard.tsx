import { memo, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen,
  BellRing,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  CircleDot,
  CircleSlash,
  Code2,
  ExternalLink,
  FileCode2,
  GitBranch,
  Inbox,
  Loader2,
  Mail,
  MessageSquare,
  PackageCheck,
  Pencil,
  PenLine,
  Quote,
  Rocket,
  Search,
  Ticket,
  Undo2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { ArtifactKind, ArtifactStatus, ArtifactView } from "@synapse/shared";
import { ArtifactPreview } from "@/components/card/ArtifactBody";
import { EditPanel } from "@/components/card/EditPanel";
import { errorText } from "@/components/lab/usePolled";
import { STATUS_HINT, STATUS_LABEL, artifactHeadline, isEditable, pushLabel, pushability } from "@/lib/artifacts";
import { ARTIFACT_LABEL } from "@/lib/category";
import { formatDayTime } from "@/lib/format";
import { KIND_TINT, distinctExcerpt, excerptOf, refLabel } from "@/lib/outbox-excerpt";
import { api } from "@/net/api";
import type { OutboxItem } from "@/net/api-types";
import { toast } from "@/state/notices";
import { useOutbox } from "@/state/outbox";

export const KIND_ICON: Record<ArtifactKind, LucideIcon> = {
  ticket: Ticket,
  github_issue: CircleDot,
  email_draft: Mail,
  message_draft: MessageSquare,
  calendar_event: CalendarClock,
  reminder: BellRing,
  code_snippet: Code2,
  code_comment: FileCode2,
  decision: GitBranch,
  note: PenLine,
  journal: BookOpen,
  recall: Search,
  none: Inbox,
};

export const STATUS_ICON: Record<ArtifactStatus, LucideIcon> = {
  draft: PenLine,
  staged: PackageCheck,
  accepted: CheckCheck,
  opened: ExternalLink,
  executed: Rocket,
  dismissed: CircleSlash,
  undone: Undo2,
};

type Action = "accept" | "dismiss" | "push" | "undo";
type Busy = Action | "save" | null;

const VERB: Record<Action, (kind: ArtifactKind) => string> = {
  accept: () => "keep this draft",
  dismiss: () => "dismiss this draft",
  push: (kind) => pushLabel(kind).toLowerCase(),
  undo: () => "undo this",
};

/** one Outbox item: kind, title, where it came from, its state and every action the cards on the Desk offer */
export const OutboxItemCard = memo(function OutboxItemCard({ item }: { item: OutboxItem }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [flash, setFlash] = useState(false);
  const previewId = useId();
  const last = useRef(item.updatedAt);

  // a brief glow when this item changed after it was first drawn (a live status change or an edit)
  useEffect(() => {
    if (item.updatedAt === last.current) return;
    last.current = item.updatedAt;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1700);
    return () => clearTimeout(t);
  }, [item.updatedAt]);

  const Icon = KIND_ICON[item.kind] ?? Inbox;
  const StatusIcon = STATUS_ICON[item.status];
  const headline = artifactHeadline(item);
  const excerpt = distinctExcerpt(headline, excerptOf(item));
  const status = item.status;
  const closed = status === "executed" || status === "dismissed";
  const pushOk = item.pushable.ok && pushability(item).ok; // the server verdict AND the client rules (a dismissed item is never pushable)
  const needsTime = item.kind === "calendar_event" && !closed && !pushOk;
  const canKeep = status !== "executed" && status !== "accepted" && status !== "dismissed";
  const canDismiss = !closed;
  const editable = isEditable(item.kind) && !closed;

  const patchStore = (view: ArtifactView): void => {
    useOutbox.getState().patch(item.thoughtId, view, { thoughtCode: item.thoughtCode, thoughtTitle: item.thoughtTitle });
  };

  const run = async (action: Action): Promise<void> => {
    setBusy(action);
    try {
      patchStore(await api.artifactAction(item.id, action));
    } catch (err) {
      toast.warn(`Could not ${VERB[action](item.kind)}: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy("save");
    try {
      patchStore(await api.patchArtifact(item.id, patch));
      toast.success("Saved your edits.");
      setEditing(false);
    } catch (err) {
      toast.warn(`Could not save the edit: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const spin = (a: Action) => (busy === a ? <Loader2 size={13} className="lab-spin" aria-hidden /> : null);
  const disabled = busy !== null;

  return (
    <article
      className={`ob-card${flash ? " is-flash" : ""}`}
      data-status={status}
      data-kind={item.kind}
      style={{ ["--k" as string]: KIND_TINT[item.kind] }}
      aria-label={`${ARTIFACT_LABEL[item.kind]}: ${headline}, ${STATUS_LABEL[status]}`}
      aria-busy={busy !== null}
    >
      <header className="ob-card__head">
        <div className="ob-card__badge" aria-hidden>
          <Icon size={18} />
        </div>
        <div className="ob-card__titles">
          <h3 className="ob-card__title">{headline}</h3>
          <div className="ob-card__meta">
            <span className="mono ob-code">{item.code}</span>
            <span>{ARTIFACT_LABEL[item.kind]}</span>
            <span className="tnum ob-sep" title={`Created ${formatDayTime(item.createdAt)}`}>
              {formatDayTime(item.updatedAt)}
            </span>
            {item.autonomyLevel > 0 ? (
              <span className="ob-sep" title="The autonomy level when this was drafted">
                L{item.autonomyLevel}
              </span>
            ) : null}
          </div>
        </div>
        <span className={`ob-status ob-status--${status}`} title={STATUS_HINT[status]}>
          <StatusIcon size={12} aria-hidden /> {STATUS_LABEL[status]}
        </span>
      </header>

      {excerpt ? <p className="ob-card__excerpt">{excerpt}</p> : null}

      {item.thoughtCode || item.externalRef || item.simulated || needsTime ? (
        <div className="ob-card__chips">
          {item.thoughtCode ? (
            <span className="ob-from" title="The thought this was drafted from">
              <Quote size={12} aria-hidden />
              <span className="mono ob-code">{item.thoughtCode}</span>
              {item.thoughtTitle ? <span className="ob-from__title">{item.thoughtTitle}</span> : null}
            </span>
          ) : null}
          {item.externalRef ? (
            item.externalUrl ? (
              <a className="chip chip-tint chip-cyan" href={item.externalUrl} target="_blank" rel="noopener noreferrer" title="Open the created item">
                <ExternalLink size={11} aria-hidden /> <span>{refLabel(item.externalRef)}</span>
              </a>
            ) : (
              <span className="chip chip-tint chip-cyan chip-mono" title={item.simulated ? "No credentials are configured: this was a simulated push and nothing left your machine" : "Created"}>
                <span>{refLabel(item.externalRef)}</span>
              </span>
            )
          ) : null}
          {item.simulated ? (
            <span className="chip chip-dashed" title="No integration credentials are configured, so the push was simulated.">
              <span>simulated</span>
            </span>
          ) : null}
          {needsTime ? (
            <span className="chip chip-dashed" title={item.pushable.reason ?? "needs a time: say when"}>
              <span>needs a time</span>
            </span>
          ) : null}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="preview"
            id={previewId}
            className="ob-card__preview"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
            style={{ overflow: "hidden" }}
          >
            <div className="ob-card__previewin">
              <ArtifactPreview artifact={item} title={item.thoughtTitle ?? ""} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {editing ? <EditPanel key="edit" artifact={item} onCancel={() => setEditing(false)} onSave={(p) => void save(p)} /> : null}
      </AnimatePresence>

      <footer className="ob-card__foot">
        <button type="button" className="btn btn-ghost btn-sm ob-preview" aria-expanded={open} aria-controls={open ? previewId : undefined} onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={13} aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .2s" }} /> {open ? "Hide preview" : "Preview"}
        </button>

        <div className="ob-card__actions" role="group" aria-label="Actions">
          {canKeep ? (
            <button type="button" className="btn btn-sm btn-ok" disabled={disabled} onClick={() => void run("accept")} title="Keep: promote this to long-term memory and mark the draft accepted">
              {spin("accept") ?? <Check size={13} aria-hidden />} Keep
            </button>
          ) : null}
          {status === "dismissed" ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => void run("accept")} title="Changed your mind: keep it after all">
              {spin("accept") ?? <Check size={13} aria-hidden />} Keep anyway
            </button>
          ) : null}
          {status === "accepted" || status === "executed" ? (
            <span className="ob-kept" title={STATUS_HINT[status]}>
              <CheckCheck size={14} aria-hidden /> {status === "executed" ? "Done" : "Kept"}
            </span>
          ) : null}
          {pushOk ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={disabled} onClick={() => void run("push")} title={`${pushLabel(item.kind)} (private and reversible; nothing is sent to another person)`}>
              {spin("push") ?? <Upload size={13} aria-hidden />} {pushLabel(item.kind)}
            </button>
          ) : null}
          {editable ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} aria-expanded={editing} onClick={() => setEditing((v) => !v)} title="Edit the draft">
              <Pencil size={13} aria-hidden /> Edit
            </button>
          ) : null}
          {status === "executed" ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => void run("undo")} title="Undo: closes the issue or removes the hold">
              {spin("undo") ?? <Undo2 size={13} aria-hidden />} Undo
            </button>
          ) : null}
          {canDismiss ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => void run("dismiss")} title="Dismiss this draft (the thought stays in memory until it expires)">
              {spin("dismiss") ?? <CircleSlash size={13} aria-hidden />} Dismiss
            </button>
          ) : null}
        </div>
      </footer>
    </article>
  );
});
