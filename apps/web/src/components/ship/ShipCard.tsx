import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bell, Bug, CalendarDays, Check, Code2, GitBranch, Lightbulb, Mail, MessageCircle, MoreHorizontal, NotebookPen } from "lucide-react";
import type { ArtifactNeed, ArtifactView, ThoughtView } from "@synapse/shared";
import { thingLabel } from "@/capture/summary";
import { cardLabel, destination, isMobile, preview, primaryAction, shippedText } from "@/lib/ship";
import { api } from "@/net/api";
import { socket } from "@/runtime";
import { toast } from "@/state/notices";
import { useProfile } from "@/state/profile";
import { useSettings } from "@/state/settings";

/* ============================================================================
 * The V1 card (phone and laptop): a type icon and plain label, the title, a line or two of content, where it goes, any
 * question it needs answered, and ONE primary action that hands off to the app people already use. No ids, no timings,
 * no autonomy levels on its face.
 * ========================================================================== */

const ICONS: Record<string, typeof Bug> = {
  github_issue: Bug,
  email_draft: Mail,
  reminder: Bell,
  calendar_event: CalendarDays,
  message_draft: MessageCircle,
  code_snippet: Code2,
  decision: GitBranch,
};

function copyText(a: ArtifactView | null, t: ThoughtView): string {
  const p = a?.payload;
  if (!p) return `${t.title}\n\n${t.intent}`;
  switch (p.kind) {
    case "github_issue":
      return `# ${p.title}\n\n${p.body_markdown}`;
    case "email_draft":
      return `Subject: ${p.subject}\n\n${p.body}`;
    case "message_draft":
      return p.body;
    case "note":
    case "journal":
      return `## ${t.title}\n\n${p.body}`;
    case "reminder":
      return `${p.what}${p.due_text ? ` (${p.due_text})` : ""}`;
    case "code_snippet":
      return p.code;
    default:
      return `## ${t.title}\n\n${t.intent}`;
  }
}

function Ask({ need, artifactId }: { need: ArtifactNeed; artifactId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (value: string): Promise<void> => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.answer(artifactId, need.field, value.trim());
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ship-ask" role="group" aria-label={need.question}>
      <p className="ship-ask__q">{need.question}</p>
      {need.options.length ? (
        <div className="ship-ask__opts">
          {need.options.map((o) => (
            <button key={o.value} type="button" className="chip-btn" disabled={busy} onClick={() => void send(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {need.allowFreeText ? (
        <form
          className="ship-ask__free"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={need.placeholder ?? "Type an answer"} aria-label={need.question} disabled={busy} />
          <button type="submit" className="btn" disabled={busy || !text.trim()}>
            Save
          </button>
        </form>
      ) : null}
      {error ? <p className="ship-ask__err">{error}</p> : null}
    </div>
  );
}

/** The editable text of each kind (one or two fields; everything else stays as drafted). */
const EDITABLE: Record<string, Array<{ key: string; label: string; long?: boolean }>> = {
  github_issue: [
    { key: "title", label: "Title" },
    { key: "body_markdown", label: "Body", long: true },
  ],
  email_draft: [
    { key: "subject", label: "Subject" },
    { key: "body", label: "Body", long: true },
  ],
  message_draft: [{ key: "body", label: "Message", long: true }],
  reminder: [{ key: "what", label: "Remind me to" }],
  calendar_event: [{ key: "title", label: "Title" }],
  note: [{ key: "body", label: "Note", long: true }],
  ticket: [
    { key: "title", label: "Title" },
    { key: "description", label: "Description", long: true },
  ],
};

/** "Why I made this" in plain words (the offline classifier's own phrasing is not for people). */
export function whyText(t: ThoughtView): string {
  const why = (t.why ?? "").trim();
  if (!why || /^local heuristic classified this as/i.test(why)) return `It sounded like ${t.category === "communication" ? "a message to someone" : t.category === "scheduling" ? "something with a time" : t.category === "bug" ? "a bug" : t.category === "action" ? "a task" : `a${/^[aeiou]/.test(t.category) ? "n" : ""} ${t.category.replace("_", " ")}`}.`;
  return why;
}

function Editor({ a, onDone }: { a: ArtifactView; onDone: () => void }) {
  const fields = EDITABLE[a.kind] ?? [];
  const payload = a.payload as unknown as Record<string, unknown>;
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, String(payload[f.key] ?? "")])));
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ship-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api.patchArtifact(a.id, form);
          onDone();
        } catch (err) {
          toast.warn((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f) => (
        <label key={f.key} className="ship-edit__field">
          <span>{f.label}</span>
          {f.long ? (
            <textarea className="input" rows={5} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          ) : (
            <input className="input" value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="ship-edit__row">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

function Why({ t }: { t: ThoughtView }) {
  return (
    <div className="ship-why">
      <h4>What I heard</h4>
      <ul>
        {t.fragments.map((f) => (
          <li key={f.id}>“{f.text}”</li>
        ))}
      </ul>
      <h4>Why I made this</h4>
      <p>{whyText(t)}</p>
      {t.salienceReasons.length ? <p className="ship-why__kept">Kept because: {t.salienceReasons.join(", ")}.</p> : null}
    </div>
  );
}

function Menu({ items }: { items: Array<{ label: string; run: () => void; href?: string } | false | null | undefined> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const list = items.filter((x): x is { label: string; run: () => void; href?: string } => Boolean(x));
  return (
    <div className="ship-menu" ref={ref}>
      <button type="button" className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div className="ship-menu__list" role="menu">
          {list.map((it) =>
            it.href ? (
              <a key={it.label} role="menuitem" className="ship-menu__item" href={it.href} onClick={() => setOpen(false)}>
                {it.label}
              </a>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className="ship-menu__item"
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ShipCard({ thought, compact = false }: { thought: ThoughtView; compact?: boolean }) {
  const a = thought.artifact && thought.artifact.kind !== "none" ? thought.artifact : null;
  const tz = useSettings((s) => s.config?.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const emailApp = useProfile((s) => s.profile?.emailApp) ?? "gmail";
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"edit" | "why" | null>(null);
  const label = a && a.kind !== "note" ? cardLabel(a) : thingLabel(thought);
  const Icon = (a && ICONS[a.kind]) ?? (thought.category === "idea" ? Lightbulb : NotebookPen);
  const dest = a ? destination(a, tz) : null;
  const text = a ? preview(a) : "";
  const action = a ? primaryAction(a, { mobile: isMobile(navigator.userAgent), emailApp }) : null;
  const done = a ? shippedText(a) : null;
  const need = a?.needs?.[0];

  const run = async (): Promise<void> => {
    if (!a || !action || action.disabled) return;
    setBusy(true);
    try {
      if (action.kind === "push") {
        await api.artifactAction(a.id, "push");
      } else {
        if (action.url.startsWith("mailto:")) window.location.href = action.url;
        else window.open(action.url, "_blank", "noopener,noreferrer");
        await api.shipped(a.id, action.via);
      }
    } catch (e) {
      toast.warn((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`ship${compact ? " ship--compact" : ""}`} data-kind={a?.kind ?? thought.category} data-status={a?.status ?? "saved"} aria-label={`${label}: ${thought.title}`}>
      <header className="ship__head">
        <span className="ship__icon" aria-hidden>
          <Icon size={15} />
        </span>
        <span className="ship__label">{label}</span>
        {dest ? <span className="ship__dest">{dest}</span> : null}
        {need ? <span className="ship__needs">Needs one answer</span> : null}
      </header>
      <h3 className="ship__title">{thought.title}</h3>
      {text && !compact ? <p className="ship__text">{text}</p> : null}
      {need && a ? <Ask need={need} artifactId={a.id} /> : null}
      {panel === "edit" && a ? <Editor a={a} onDone={() => setPanel(null)} /> : null}
      {panel === "why" ? <Why t={thought} /> : null}
      <footer className="ship__foot">
        {done ? (
          done.url ? (
            <a className="ship__done" href={done.url} target="_blank" rel="noopener noreferrer">
              <Check size={14} /> {done.text} <ArrowUpRight size={13} />
            </a>
          ) : (
            <span className="ship__done">
              <Check size={14} /> {done.text}
            </span>
          )
        ) : action ? (
          <button type="button" className="btn btn-primary ship__primary" disabled={busy || action.disabled} title={action.reason} onClick={() => void run()}>
            {action.label}
          </button>
        ) : (
          <span className="ship__saved">Saved</span>
        )}
        <span className="ship__tools">
          <Menu
            items={[
              a && EDITABLE[a.kind] && a.status !== "executed" ? { label: panel === "edit" ? "Close editor" : "Edit", run: () => setPanel(panel === "edit" ? null : "edit") } : null,
              { label: "Copy", run: () => void navigator.clipboard?.writeText(copyText(a, thought)).then(() => toast.success("Copied"), () => toast.warn("Copy failed")) },
              a?.links?.ics ? { label: "Download .ics", run: () => undefined, href: a.links.ics } : null,
              { label: panel === "why" ? "Hide why" : "Why?", run: () => setPanel(panel === "why" ? null : "why") },
              { label: "Forget", run: () => socket.send({ type: "card.action", thoughtId: thought.id, action: "forget" }) },
            ]}
          />
        </span>
      </footer>
    </article>
  );
}
