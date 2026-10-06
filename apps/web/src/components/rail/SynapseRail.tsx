import { memo, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BookmarkCheck,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleHelp,
  Clock,
  Code2,
  FileText,
  GitCompareArrows,
  Lightbulb,
  ListChecks,
  ListPlus,
  Mic,
  Quote,
  Sparkles,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import type { BriefView, EchoView, SuggestionKind, SuggestionView } from "@synapse/shared";
import { highlightCard } from "@/lib/dom";
import { formatAgo, formatWeekdayTime, plural, placeLabel } from "@/lib/format";
import { socket } from "@/runtime";
import { useSuggestions, visibleSuggestions } from "@/state/suggestions";
import { useThoughts } from "@/state/thoughts";

const spring = { type: "spring", stiffness: 380, damping: 34, mass: 0.9 } as const;

const KIND_ICON: Record<SuggestionKind, LucideIcon> = {
  reschedule: CalendarClock,
  make_task: ListPlus,
  draft_ready: FileText,
  snippet: Code2,
  open_answer: Lightbulb,
  echo: Waves,
  contradiction: GitCompareArrows,
  calendar_hold: CalendarPlus,
};

const KIND_LABEL: Record<SuggestionKind, string> = {
  reschedule: "Reschedule",
  make_task: "Make it a task",
  draft_ready: "Draft ready",
  snippet: "Reusable snippet",
  open_answer: "From memory",
  echo: "Echo",
  contradiction: "Revisit?",
  calendar_hold: "Calendar hold",
};

interface Slot {
  start: number;
  end: number;
  label: string;
}

function slotsOf(s: SuggestionView): Slot[] {
  const raw = s.payload?.slots;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Slot => Boolean(x) && typeof (x as Slot).label === "string" && typeof (x as Slot).start === "number");
}

/** A proactive suggestion: always says WHY, shows where it came from, and asks (never acts on its own). */
const SuggestionCard = memo(function SuggestionCard({ s }: { s: SuggestionView }) {
  const pick = useSuggestions((st) => st.picks[s.id] ?? 0);
  const setPick = useSuggestions((st) => st.setPick);
  const byId = useThoughts((st) => st.byId);
  const Icon = KIND_ICON[s.kind] ?? Sparkles;
  const slots = slotsOf(s);
  const resolved = s.status === "accepted" ? "Done" : s.status === "dismissed" ? "Dismissed" : s.status === "later" ? "Snoozed" : null;
  const acceptLabel = s.kind === "reschedule" && slots[pick] ? `Hold ${slots[pick]?.label}` : s.acceptLabel;

  const act = (action: "accept" | "dismiss" | "later"): void => {
    // `pick` rides along for reschedules; a server that predates slot picking holds the first slot
    const msg = { type: "suggestion.action", id: s.id, action, ...(action === "accept" && slots.length ? { pick } : {}) } as const;
    socket.send(msg);
  };

  return (
    <motion.article
      layout
      className="sug"
      data-kind={s.kind}
      initial={{ opacity: 0, y: -16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.97, transition: { duration: 0.22 } }}
      transition={spring}
      aria-label={`Suggestion: ${s.title}`}
    >
      <header className="sug__head">
        <span className="sug__icon" aria-hidden>
          <Icon size={17} />
        </span>
        <div className="sug__titles">
          <div className="sug__kind">{KIND_LABEL[s.kind]}</div>
          <h3 className="sug__title">{s.title}</h3>
        </div>
      </header>

      <p className="sug__body">{s.body}</p>

      <div className="why" role="note">
        <Sparkles size={12} aria-hidden />
        <span>
          <b>Why: </b>
          {s.why}
        </span>
      </div>

      {slots.length ? (
        <div className="slots" role="radiogroup" aria-label="Free slots">
          {slots.map((sl, i) => (
            <button key={`${sl.start}`} type="button" role="radio" aria-checked={pick === i} className={`slot${pick === i ? " slot--on" : ""}`} onClick={() => setPick(s.id, i)} title={`${sl.label} is free in your calendar`}>
              <Clock size={12} aria-hidden /> {sl.label}
            </button>
          ))}
        </div>
      ) : null}

      {s.sources.length ? (
        <div className="cchips" aria-label="Where this came from">
          {s.sources.slice(0, 4).map((src) => (
            <button
              key={src.thoughtId}
              type="button"
              className="chip"
              onClick={() => highlightCard(src.thoughtId)}
              disabled={!byId[src.thoughtId]}
              title={`${src.title}\n${formatWeekdayTime(src.when)}, ${placeLabel(src.activity, src.deviceKind)}`}
            >
              <Quote size={11} />
              <span>
                <b className="mono">{src.code}</b> {formatAgo(src.when)}
                {src.activity === "walking" || src.deviceKind === "pocket" ? ` · ${placeLabel(src.activity, src.deviceKind)}` : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="sug__actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => act("accept")} disabled={Boolean(resolved)}>
          <Check size={13} /> {acceptLabel}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => act("dismiss")} disabled={Boolean(resolved)} title="Not now: Synapse will wait longer before suggesting this again">
          Not now
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => act("later")} disabled={Boolean(resolved)} title="Ask again in a few minutes">
          Later
        </button>
      </div>

      <AnimatePresence>
        {resolved ? (
          <motion.div className="sug__done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-live="polite">
            <Check size={16} /> {resolved}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
});

/** "Related to what you said Mon 11:20, on a walk: …" with a soft ripple. */
const EchoCard = memo(function EchoCard({ e }: { e: EchoView }) {
  const dismiss = useSuggestions((st) => st.dismissEcho);
  const exists = useThoughts((st) => Boolean(st.byId[e.source.thoughtId]));
  const idx = e.because.indexOf(": ");
  const intro = idx > 0 ? e.because.slice(0, idx) : "Related to something you said earlier";
  const quote = idx > 0 ? e.because.slice(idx + 2) : e.because;
  return (
    <motion.article
      layout
      className="echo"
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      transition={spring}
      aria-label="Memory echo"
    >
      <span className="echo__ripple" aria-hidden>
        <i />
        <i />
        <Waves size={15} />
      </span>
      <div className="echo__body">
        <div className="echo__intro">{intro}</div>
        <div className="echo__quote">{quote}</div>
        <div className="cchips" style={{ marginTop: "0.4rem" }}>
          <button type="button" className="chip" disabled={!exists} onClick={() => highlightCard(e.source.thoughtId)}>
            <b className="mono">{e.source.code}</b>
            <span>{formatWeekdayTime(e.source.when)}</span>
          </button>
          <span className="chip" title="How close in meaning">
            {Math.round(e.similarity * 100)}% similar
          </span>
        </div>
      </div>
      <button type="button" className="icon-btn" aria-label="Dismiss echo" onClick={() => dismiss(e.id)} style={{ width: "1.6rem", height: "1.6rem" }}>
        <X size={14} />
      </button>
    </motion.article>
  );
});

function BriefSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="brief__sec">
      <div className="brief__label">
        <Icon size={13} aria-hidden /> {title}
      </div>
      {children}
    </div>
  );
}

/** The session brief (CTX-10): what you said, in tasks / decisions / snippets / open loops. */
const BriefCard = memo(function BriefCard({ b }: { b: BriefView }) {
  const dismiss = useSuggestions((st) => st.dismissBrief);
  const byId = useThoughts((st) => st.byId);
  const jump = (code: string): void => {
    const t = Object.values(byId).find((x) => x.code === code);
    if (t) highlightCard(t.id);
  };
  const empty = !b.tasks.length && !b.decisions.length && !b.snippets.length && !b.openLoops.length;
  return (
    <motion.article
      layout
      className="brief"
      initial={{ opacity: 0, y: -16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      transition={spring}
      aria-label="Session brief"
    >
      <header className="brief__head">
        <span className="sug__icon" aria-hidden>
          <BookmarkCheck size={17} />
        </span>
        <div className="sug__titles">
          <div className="sug__kind">Session brief</div>
          <h3 className="sug__title">{b.headline}</h3>
        </div>
        <button type="button" className="icon-btn" aria-label="Dismiss brief" onClick={() => dismiss(b.id)}>
          <X size={15} />
        </button>
      </header>

      {b.tasks.length ? (
        <BriefSection icon={ListChecks} title={`${plural(b.tasks.length, "task")}`}>
          <ul className="brief__list">
            {b.tasks.map((t, i) => (
              <li key={i}>
                <button type="button" className="brief__link" onClick={() => jump(t.thoughtCode)}>
                  <b className="mono">{t.thoughtCode}</b> {t.title}
                </button>
              </li>
            ))}
          </ul>
        </BriefSection>
      ) : null}

      {b.decisions.length ? (
        <BriefSection icon={Check} title={plural(b.decisions.length, "decision")}>
          <ul className="brief__list">
            {b.decisions.map((d, i) => (
              <li key={i}>
                <button type="button" className="brief__link" onClick={() => jump(d.thoughtCode)}>
                  <b className="mono">{d.thoughtCode}</b> {d.title}
                </button>
                {d.chosen ? (
                  <div className="brief__dec">
                    {d.rejected.map((r) => (
                      <span key={r} className="brief__rej">
                        {r}
                      </span>
                    ))}
                    {d.rejected.length ? " → " : ""}
                    <b>{d.chosen}</b>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </BriefSection>
      ) : null}

      {b.snippets.length ? (
        <BriefSection icon={Code2} title={plural(b.snippets.length, "snippet")}>
          <ul className="brief__list">
            {b.snippets.map((s, i) => (
              <li key={i}>
                <button type="button" className="brief__link" onClick={() => jump(s.thoughtCode)}>
                  <b className="mono">{s.thoughtCode}</b> {s.title} <span className="chip chip-mono">{s.language}</span>
                </button>
              </li>
            ))}
          </ul>
        </BriefSection>
      ) : null}

      {b.openLoops.length ? (
        <BriefSection icon={CircleHelp} title={`${plural(b.openLoops.length, "open loop")}`}>
          <ul className="brief__list">
            {b.openLoops.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </BriefSection>
      ) : null}

      {empty ? <p className="ab__hint">Nothing actionable came out of this session.</p> : null}

      {b.notableQuotes.length ? (
        <div className="brief__quotes">
          {b.notableQuotes.slice(0, 2).map((q, i) => (
            <div key={i}>
              <Quote size={11} aria-hidden /> {q}
            </div>
          ))}
        </div>
      ) : null}

      <footer className="brief__foot tnum">
        <Mic size={12} aria-hidden /> {b.filteredCount > 0 ? `${plural(b.filteredCount, "aside")} filtered and forgotten · ` : ""}
        {formatAgo(b.createdAt)}
      </footer>
    </motion.article>
  );
});

/** briefs and suggestions need a decision and come first; echoes are context and follow (each group newest first) */
type RailItem = { key: string; at: number; rank: 0 | 1; node: React.ReactNode };

/** The Synapse rail: quiet proactive items. Newest first, one chronological stream of brief / suggestions / echoes. */
export const SynapseRail = memo(function SynapseRail() {
  const items = useSuggestions((s) => s.items);
  const echoes = useSuggestions((s) => s.echoes);
  const briefs = useSuggestions((s) => s.briefs);
  const markSeen = useSuggestions((s) => s.markSeen);
  // echoes are light: show the newest few, keep the rail quiet
  const [allEchoes, setAllEchoes] = useState(false);
  const echoCap = 3;
  const hiddenEchoes = allEchoes ? 0 : Math.max(0, echoes.length - echoCap);

  const entries = useMemo<RailItem[]>(() => {
    const out: RailItem[] = [];
    for (const b of briefs) out.push({ key: `b-${b.id}`, at: b.createdAt, rank: 0, node: <BriefCard b={b} /> });
    for (const s of visibleSuggestions(items)) out.push({ key: `s-${s.id}`, at: s.deliveredAt ?? s.createdAt, rank: 0, node: <SuggestionCard s={s} /> });
    for (const e of allEchoes ? echoes : echoes.slice(0, echoCap)) out.push({ key: `e-${e.id}`, at: e.createdAt, rank: 1, node: <EchoCard e={e} /> });
    return out.sort((a, b) => a.rank - b.rank || b.at - a.at);
  }, [items, echoes, briefs, allEchoes]);

  useEffect(() => {
    markSeen();
  }, [entries.length, markSeen]);

  return (
    <div className="rail">
      <AnimatePresence initial={false} mode="popLayout">
        {entries.map((e) => (
          <div key={e.key}>{e.node}</div>
        ))}
      </AnimatePresence>
      {echoes.length > echoCap ? (
        <button type="button" className="btn btn-ghost btn-sm rail__more" onClick={() => setAllEchoes((v) => !v)} aria-expanded={allEchoes}>
          {allEchoes ? "Show fewer echoes" : `Show ${hiddenEchoes} earlier echo${hiddenEchoes === 1 ? "" : "es"}`}
        </button>
      ) : null}
      {entries.length === 0 ? (
        <div className="rail__empty">
          <Sparkles size={22} aria-hidden />
          <p className="rail__emptyh">Nothing to interrupt you with.</p>
          <p>Synapse speaks up at natural pauses, never mid-sentence, and always says why. Suggestions, memory echoes and your session brief land here.</p>
        </div>
      ) : null}
    </div>
  );
});
