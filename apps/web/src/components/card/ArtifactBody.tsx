import { memo, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarClock, CheckCircle2, Download, ExternalLink, GitBranch, Lightbulb, Mail, MessageSquare, Quote, Repeat, Square, Hash } from "lucide-react";
import type { ArtifactView, Category, ThoughtView } from "@synapse/shared";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { Markdown } from "@/components/ui/Markdown";
import { Skeleton } from "@/components/ui/Skeleton";
import { StreamText } from "@/components/ui/StreamText";
import { artifactText, partialOf, str, strArr } from "@/lib/artifacts";
import { ARTIFACT_LABEL } from "@/lib/category";
import { downloadBlob } from "@/lib/download";
import { formatRange, stripCitations } from "@/lib/format";
import { api } from "@/net/api";
import { toast } from "@/state/notices";
import { useRecall } from "@/state/recall";

/* ============================================================================
 * One renderer per artifact kind. Every renderer tolerates a PARTIAL payload (the cortex streams it token
 * by token): missing primary fields show a shimmer while `streaming`, and nothing once the card is final.
 * ========================================================================== */

type Tint = "violet" | "cyan" | "ok" | "warn" | "danger" | "fuchsia";

function Pill({ children, tint, mono, title, icon }: { children: ReactNode; tint?: Tint; mono?: boolean; title?: string; icon?: ReactNode }) {
  return (
    <span className={`chip${tint ? ` chip-tint chip-${tint}` : ""}${mono ? " chip-mono" : ""}`} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

const PREDICTED: Partial<Record<Category, string>> = {
  bug: ARTIFACT_LABEL.github_issue,
  action: ARTIFACT_LABEL.ticket,
  communication: ARTIFACT_LABEL.email_draft,
  scheduling: ARTIFACT_LABEL.calendar_event,
  code: ARTIFACT_LABEL.code_snippet,
  decision: ARTIFACT_LABEL.decision,
  idea: ARTIFACT_LABEL.note,
  journal: ARTIFACT_LABEL.journal,
  recall_query: "recall",
};

function Placeholder({ category }: { category: Category }) {
  const label = PREDICTED[category];
  return (
    <div className="ab ab--pending" aria-live="polite">
      <div className="ab__hint">{label ? `Drafting ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label.toLowerCase()}…` : "Thinking…"}</div>
      <Skeleton lines={3} />
    </div>
  );
}

const PRIORITY_TINT: Record<string, Tint> = { urgent: "danger", high: "warn", medium: "cyan", low: "ok" };
const TYPE_TINT: Record<string, Tint> = { bug: "danger", story: "violet", spike: "fuchsia", task: "cyan" };

function labelTint(label: string): Tint {
  const tints: Tint[] = ["violet", "cyan", "ok", "warn", "fuchsia"];
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return tints[h % tints.length] as Tint;
}

// ---------------------------------------------------------------- renderers --

function TicketBody({ a, t, streaming }: { a: ArtifactView; t: ThoughtView; streaming: boolean }) {
  const p = partialOf(a, "ticket") ?? {};
  const criteria = strArr(p.acceptance_criteria);
  const desc = str(p.description);
  return (
    <div className="ab">
      <div className="ab__row">
        {p.issue_type ? <Pill tint={TYPE_TINT[p.issue_type] ?? "cyan"}>{p.issue_type}</Pill> : null}
        {p.priority ? <Pill tint={PRIORITY_TINT[p.priority] ?? "cyan"}>{p.priority} priority</Pill> : null}
        {p.component ? <Pill mono>{p.component}</Pill> : null}
        {strArr(p.labels).map((l) => (
          <Pill key={l} icon={<Hash size={11} />}>
            {l}
          </Pill>
        ))}
      </div>
      {str(p.title) && str(p.title) !== t.title ? <div className="ab__objtitle">{str(p.title)}</div> : null}
      {desc ? (
        <p className="ab__text">
          <StreamText text={desc} streaming={streaming && criteria.length === 0} />
        </p>
      ) : streaming ? (
        <Skeleton lines={2} />
      ) : null}
      {criteria.length ? (
        <div>
          <div className="ab__label">Acceptance criteria</div>
          <ul className="ab__checks">
            {criteria.map((c, i) => (
              <li key={i}>
                <Square size={14} aria-hidden />
                <span>
                  <StreamText text={c} streaming={streaming && i === criteria.length - 1} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : streaming && desc ? (
        <Skeleton lines={2} />
      ) : null}
    </div>
  );
}

function GithubIssueBody({ a, t, streaming }: { a: ArtifactView; t: ThoughtView; streaming: boolean }) {
  const p = partialOf(a, "github_issue") ?? {};
  const body = str(p.body_markdown);
  const hyp = strArr(p.hypotheses);
  const labels = strArr(p.labels);
  return (
    <div className="ab">
      <div className="ab__issue">
        <div className="ab__issuehead">
          <GitBranch size={15} aria-hidden />
          <span className="ab__issuetitle">{str(p.title) || t.title}</span>
          <span className="ab__issuenum mono">{a.externalRef ? a.externalRef : "draft"}</span>
        </div>
        {labels.length ? (
          <div className="ab__row" style={{ marginTop: "0.4rem" }}>
            {labels.map((l) => (
              <Pill key={l} tint={labelTint(l)}>
                {l}
              </Pill>
            ))}
          </div>
        ) : null}
        <div className="ab__doc">{body ? <Markdown source={body} /> : streaming ? <Skeleton lines={4} /> : <span className="ab__hint">No description yet.</span>}</div>
      </div>
      {hyp.length ? (
        <div>
          <div className="ab__label">Hypotheses to check</div>
          <ul className="ab__bullets">
            {hyp.map((h, i) => (
              <li key={i}>
                <Lightbulb size={13} aria-hidden style={{ color: "var(--c-idea)" }} />
                <span>
                  <StreamText text={h} streaming={streaming && i === hyp.length - 1} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EmailBody({ a, streaming }: { a: ArtifactView; streaming: boolean }) {
  const p = partialOf(a, "email_draft") ?? {};
  const to = strArr(p.to);
  const body = str(p.body);
  const real = a.id !== "preview";
  const open = async (): Promise<void> => {
    try {
      const { mailto } = await api.mailto(a.id);
      window.location.href = mailto;
    } catch (err) {
      toast.warn(`Could not build the mail link: ${(err as Error).message}`);
    }
  };
  return (
    <div className="ab">
      <div className="ab__mail">
        <div className="ab__mailhead">
          <div className="ab__mailrow">
            <span className="ab__mlabel">To</span>
            <span className="ab__mval">{to.length ? to.map((x) => <Pill key={x}>{x}</Pill>) : streaming ? <span className="shimmer" style={{ width: "6rem", height: "1rem", display: "inline-block" }} /> : <span className="ab__hint">no recipient yet</span>}</span>
          </div>
          <div className="ab__mailrow">
            <span className="ab__mlabel">Subject</span>
            <span className="ab__mval">
              <b>{str(p.subject) ? <StreamText text={str(p.subject)} streaming={streaming && !body} /> : streaming ? <span className="shimmer" style={{ width: "12rem", height: "1rem", display: "inline-block" }} /> : "–"}</b>
            </span>
          </div>
        </div>
        <div className="ab__mailbody">{body ? <StreamText text={body} streaming={streaming} /> : streaming ? <Skeleton lines={3} /> : null}</div>
      </div>
      <div className="ab__actions">
        <button type="button" className="btn btn-sm" disabled={!real || streaming} onClick={() => void open()} title="Opens your mail app with this draft. Synapse never sends email for you.">
          <Mail size={13} /> Open in mail app
        </button>
        <CopyButton text={() => artifactText(a)} disabled={streaming} />
        {p.tone ? <Pill title="Tone of the draft">{p.tone}</Pill> : null}
        <span className="ab__hint" style={{ marginLeft: "auto" }}>Draft only. You send it.</span>
      </div>
    </div>
  );
}

function MessageBody({ a, streaming }: { a: ArtifactView; streaming: boolean }) {
  const p = partialOf(a, "message_draft") ?? {};
  const body = str(p.body);
  return (
    <div className="ab">
      <div className="ab__row">
        <MessageSquare size={14} aria-hidden style={{ color: "var(--c-communication)" }} />
        <span className="ab__hint">
          To <b style={{ color: "var(--ink)" }}>{str(p.to) || "…"}</b>
        </span>
        {p.channel ? <Pill>{p.channel}</Pill> : null}
      </div>
      <div className="ab__bubble">{body ? <StreamText text={body} streaming={streaming} /> : streaming ? <Skeleton lines={2} /> : null}</div>
      <div className="ab__actions">
        <CopyButton text={() => artifactText(a)} disabled={streaming} />
        <span className="ab__hint" style={{ marginLeft: "auto" }}>Draft only. You send it.</span>
      </div>
    </div>
  );
}

function CalendarBody({ a, streaming }: { a: ArtifactView; streaming: boolean }) {
  const p = partialOf(a, "calendar_event") ?? {};
  const start = p.start_iso ? Date.parse(p.start_iso) : NaN;
  const end = p.end_iso ? Date.parse(p.end_iso) : NaN;
  const hasTime = Number.isFinite(start);
  const attendees = strArr(p.attendees);
  const real = a.id !== "preview";
  const download = async (): Promise<void> => {
    try {
      downloadBlob(await api.ics(a.id), `${a.code || "event"}.ics`);
    } catch (err) {
      toast.warn(`No calendar file yet: ${(err as Error).message}`);
    }
  };
  const d = hasTime ? new Date(start) : null;
  return (
    <div className="ab">
      <div className="ab__cal">
        <div className={`ab__calicon${hasTime ? "" : " ab__calicon--empty"}`} aria-hidden>
          {d ? (
            <>
              <span className="ab__calmon">{d.toLocaleString("en-GB", { month: "short" })}</span>
              <span className="ab__calday">{d.getDate()}</span>
            </>
          ) : (
            <CalendarClock size={22} />
          )}
        </div>
        <div className="ab__calinfo">
          <div className="ab__calwhen">{hasTime ? formatRange(start, Number.isFinite(end) ? end : undefined) : "Needs a time"}</div>
          <div className="ab__caltitle">{str(p.title) || (streaming ? "…" : "Untitled event")}</div>
          {!hasTime && p.time_expression ? <div className="ab__hint">You said “{p.time_expression}”. Say when and the card will fill it in.</div> : null}
          <div className="ab__row" style={{ marginTop: "0.35rem" }}>
            {p.is_reschedule ? <Pill tint="warn" icon={<Repeat size={11} />}>reschedule</Pill> : null}
            {attendees.map((x) => (
              <Pill key={x}>{x}</Pill>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn-sm" disabled={!real || !hasTime || streaming} onClick={() => void download()} title={hasTime ? "Download an .ics file for any calendar app" : "Needs a concrete time first"}>
          <Download size={13} /> .ics
        </button>
      </div>
    </div>
  );
}

function CodeSnippetBody({ a, streaming }: { a: ArtifactView; streaming: boolean }) {
  const p = partialOf(a, "code_snippet") ?? {};
  const code = str(p.code);
  const expl = str(p.explanation);
  return (
    <div className="ab">
      {str(p.approach) ? (
        <p className="ab__text" style={{ marginBottom: 0 }}>
          <StreamText text={str(p.approach)} streaming={streaming && !code} />
        </p>
      ) : null}
      {p.signature ? (
        <div className="ab__row">
          <Pill mono>{p.signature}</Pill>
        </div>
      ) : null}
      {code ? <CodeBlock code={code} language={str(p.language)} streaming={streaming && !expl} /> : streaming ? <Skeleton lines={4} height="0.8rem" /> : null}
      {expl ? (
        <p className="ab__text ab__expl">
          <StreamText text={expl} streaming={streaming} />
        </p>
      ) : null}
      {p.needs_enrichment && streaming ? <div className="ab__hint">Enriching with a fuller implementation…</div> : null}
    </div>
  );
}

function CodeCommentBody({ a, streaming }: { a: ArtifactView; streaming: boolean }) {
  const p = partialOf(a, "code_comment") ?? {};
  return (
    <div className="ab">
      {p.target ? (
        <div className="ab__row">
          <span className="ab__hint">On</span>
          <Pill mono>{p.target}</Pill>
        </div>
      ) : null}
      <div className="ab__comment mono">
        <span style={{ color: "var(--faint)" }}>{"// "}</span>
        {str(p.comment) ? <StreamText text={str(p.comment)} streaming={streaming} /> : streaming ? <span className="shimmer" style={{ display: "inline-block", width: "70%", height: "0.9rem" }} /> : null}
      </div>
      <div className="ab__actions">
        <CopyButton text={() => `// ${str(p.comment)}`} disabled={streaming} />
      </div>
    </div>
  );
}

function DecisionBody({ a, streaming }: { a: ArtifactView; streaming: boolean }) {
  const p = partialOf(a, "decision") ?? {};
  const rejected = strArr(p.rejected);
  const chosen = str(p.chosen);
  const decided = p.status === "decided";
  return (
    <div className="ab">
      {str(p.question) ? (
        <div className="ab__q">
          <StreamText text={str(p.question)} streaming={streaming && !chosen && !rejected.length} />
        </div>
      ) : streaming ? (
        <Skeleton lines={1} />
      ) : null}
      <div className="ab__options">
        {rejected.map((r, i) => (
          <div key={`${i}:${r}`} className="opt opt--rejected">
            <span className="opt__text">{r}</span>
            <span className="opt__tag">rejected</span>
          </div>
        ))}
        {rejected.length && chosen ? <ArrowRight size={16} className="opt__arrow" aria-hidden /> : null}
        {chosen ? (
          <div className="opt opt--chosen">
            <CheckCircle2 size={16} aria-hidden />
            <span className="opt__text">
              <StreamText text={chosen} streaming={streaming} />
            </span>
            <span className="opt__tag">{decided ? "decided" : "leaning"}</span>
          </div>
        ) : streaming ? (
          <div className="opt opt--ghost shimmer" />
        ) : (
          <div className="opt opt--open">
            <span className="opt__text">Not decided yet</span>
          </div>
        )}
      </div>
      {p.rationale ? (
        <p className="ab__text ab__expl">
          <StreamText text={p.rationale} streaming={streaming} />
        </p>
      ) : null}
    </div>
  );
}

function NoteBody({ a, streaming, kind }: { a: ArtifactView; streaming: boolean; kind: "note" | "journal" }) {
  const p = (kind === "note" ? partialOf(a, "note") : partialOf(a, "journal")) as { body?: string; tags?: string[] } | null;
  const body = str(p?.body);
  const tags = strArr(p?.tags);
  return (
    <div className="ab">
      {body ? (
        <p className={`ab__text${kind === "journal" ? " ab__journal" : ""}`}>
          <StreamText text={body} streaming={streaming} />
        </p>
      ) : streaming ? (
        <Skeleton lines={2} />
      ) : null}
      {tags.length ? (
        <div className="ab__row">
          {tags.map((t) => (
            <Pill key={t} icon={<Hash size={11} />}>
              {t}
            </Pill>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The recall card: what was asked (parsed), the sources found, and the streamed answer. */
function RecallBody({ a, t, streaming }: { a: ArtifactView; t: ThoughtView; streaming: boolean }) {
  const p = partialOf(a, "recall") ?? {};
  const q = useRecall((s) => s.queries[t.id]);
  const chips: ReactNode[] = [];
  if (p.topic_query) chips.push(<Pill key="topic" tint="violet">{p.topic_query}</Pill>);
  if (p.time_expression) chips.push(<Pill key="time" tint="warn">{p.time_expression}</Pill>);
  if (p.activity) chips.push(<Pill key="act" tint="ok">{p.activity}</Pill>);
  if (p.device) chips.push(<Pill key="dev" tint="cyan">{p.device}</Pill>);
  for (const ty of strArr(p.types)) chips.push(<Pill key={`ty-${ty}`}>{ty}</Pill>);
  for (const pe of strArr(p.persons)) chips.push(<Pill key={`pe-${pe}`} tint="fuchsia">{pe}</Pill>);
  const answer = q?.answer ? stripCitations(q.answer) : "";
  return (
    <div className="ab">
      {chips.length ? <div className="ab__row">{chips}</div> : streaming ? <Skeleton lines={1} /> : null}
      {q && q.sources.length ? (
        <ul className="ab__bullets">
          {q.sources.slice(0, 3).map((s) => (
            <li key={s.thoughtId}>
              <Quote size={12} aria-hidden style={{ color: "var(--c-recall_query)" }} />
              <span>
                <b className="mono" style={{ fontSize: "0.72rem", color: "var(--dim)" }}>
                  {s.code}
                </b>{" "}
                {s.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {answer ? (
        <p className="ab__text ab__answer">
          <StreamText text={answer} streaming={Boolean(q && !q.done)} />
        </p>
      ) : q && !q.done ? (
        <Skeleton lines={2} />
      ) : null}
      {q ? (
        <Link to="/app/ask" className="ab__hint" style={{ color: "var(--cyan)" }} onClick={() => useRecall.getState().setActive(q.id)}>
          Open in Recall <ExternalLink size={11} style={{ display: "inline" }} />
        </Link>
      ) : null}
    </div>
  );
}

/** What the card says when there is no artifact (an idea with no draft, a question, a recall in flight). */
function IntentOnly({ t }: { t: ThoughtView }) {
  return t.intent ? (
    <div className="ab">
      <p className="ab__text">{t.intent}</p>
    </div>
  ) : null;
}

export const ArtifactBody = memo(function ArtifactBody({ thought }: { thought: ThoughtView }) {
  const a = thought.artifact;
  const streaming = Boolean(thought.analyzing);

  if (!a || a.kind === "none") {
    if (streaming && thought.provisional) return <Placeholder category={thought.category} />;
    return <IntentOnly t={thought} />;
  }
  switch (a.kind) {
    case "ticket":
      return <TicketBody a={a} t={thought} streaming={streaming} />;
    case "github_issue":
      return <GithubIssueBody a={a} t={thought} streaming={streaming} />;
    case "email_draft":
      return <EmailBody a={a} streaming={streaming} />;
    case "message_draft":
      return <MessageBody a={a} streaming={streaming} />;
    case "calendar_event":
      return <CalendarBody a={a} streaming={streaming} />;
    case "code_snippet":
      return <CodeSnippetBody a={a} streaming={streaming} />;
    case "code_comment":
      return <CodeCommentBody a={a} streaming={streaming} />;
    case "decision":
      return <DecisionBody a={a} streaming={streaming} />;
    case "note":
      return <NoteBody a={a} streaming={streaming} kind="note" />;
    case "journal":
      return <NoteBody a={a} streaming={streaming} kind="journal" />;
    case "recall":
      return <RecallBody a={a} t={thought} streaming={streaming} />;
    default:
      return <IntentOnly t={thought} />;
  }
});

/**
 * Renders just an artifact (no thought around it): the Outbox, the graph detail panel. Builds the minimal
 * thought the renderers need.
 */
export function ArtifactPreview({ artifact, title = "" }: { artifact: ArtifactView; title?: string }) {
  const stub = useMemo<ThoughtView>(
    () => ({
      id: `artifact-${artifact.id}`,
      code: artifact.code,
      sessionId: "",
      deviceId: "",
      status: "final",
      provisional: false,
      tentative: false,
      source: "mock",
      category: "idea",
      confidence: 1,
      title,
      intent: "",
      why: "",
      fragments: [],
      references: [],
      repairs: [],
      openQuestions: [],
      entities: [],
      artifact,
      salience: 0,
      salienceReasons: [],
      promoted: false,
      expiresAt: null,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      version: 1,
      timing: {},
      analyzing: false,
    }),
    [artifact, title],
  );
  return <ArtifactBody thought={stub} />;
}
