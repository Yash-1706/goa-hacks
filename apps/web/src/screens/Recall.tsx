import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarRange,
  Car,
  Clock,
  Footprints,
  Hash,
  History,
  Monitor,
  Network,
  Mic,
  Search,
  Smartphone,
  Sparkles,
  User,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { truncate, type Activity, type RecallConstraints, type RecallSource } from "@synapse/shared";
import { useTts } from "@/hooks/useTts";
import { categoryMeta } from "@/lib/category";
import { highlightId } from "@/lib/dom";
import { formatDayTime, placeLabel } from "@/lib/format";
import { newId } from "@/lib/ids";
import { citedCodes, parseAnswer, sourceDomId } from "@/lib/recall";
import { socket } from "@/runtime";
import { toast } from "@/state/notices";
import { useConnection } from "@/state/connection";
import { useRecall, type RecallQuery } from "@/state/recall";
import { useSettings } from "@/state/settings";

const spring = { type: "spring", stiffness: 380, damping: 34 } as const;

function placeIcon(activity?: Activity, device?: "desk" | "pocket"): LucideIcon {
  if (activity === "walking") return Footprints;
  if (activity === "vehicle") return Car;
  if (device === "pocket") return Smartphone;
  return Monitor;
}

/** What the question was understood as: topic, time, situation, device, kinds, people. */
const ConstraintChips = memo(function ConstraintChips({ c }: { c: RecallConstraints }) {
  const items: React.ReactNode[] = [];
  if (c.topic) {
    items.push(
      <span key="topic" className="chip chip-tint chip-violet" title="What it is about">
        <Hash size={12} /> <span>{c.topic}</span>
      </span>,
    );
  }
  if (c.timeRange) {
    items.push(
      <span key="time" className="chip chip-tint chip-warn" title={`${formatDayTime(c.timeRange.from)} → ${formatDayTime(c.timeRange.to)}`}>
        <CalendarRange size={12} /> <span>{c.timeRange.label}</span>
      </span>,
    );
  }
  if (c.activity) {
    const Icon = placeIcon(c.activity);
    items.push(
      <span key="act" className="chip chip-tint chip-ok" title="Where you were">
        <Icon size={12} /> <span>{placeLabel(c.activity)}</span>
      </span>,
    );
  }
  if (c.device) {
    const Icon = c.device === "pocket" ? Smartphone : Monitor;
    items.push(
      <span key="dev" className="chip chip-tint chip-cyan">
        <Icon size={12} /> <span>{c.device === "pocket" ? "on your phone" : "on your laptop"}</span>
      </span>,
    );
  }
  for (const ty of c.types) {
    const m = categoryMeta(ty);
    const Icon = m.icon;
    items.push(
      <span key={`ty-${ty}`} className="chip" style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 40%, transparent)` }}>
        <Icon size={12} /> <span>{m.label.toLowerCase()}s</span>
      </span>,
    );
  }
  for (const p of c.persons) {
    items.push(
      <span key={`pe-${p}`} className="chip chip-tint chip-fuchsia">
        <User size={12} /> <span>{p}</span>
      </span>,
    );
  }
  return (
    <div className="rc-constraints" aria-label="How the question was understood">
      <span className="eyebrow">Understood as</span>
      <div className="cchips">{items}</div>
    </div>
  );
});

const SourceCard = memo(function SourceCard({ s, index, cited, hot }: { s: RecallSource; index: number; cited: boolean; hot: boolean }) {
  const meta = categoryMeta(s.category);
  const Icon = placeIcon(s.activity, s.deviceKind);
  const Cat = meta.icon;
  return (
    <motion.li
      layout
      id={sourceDomId(s.code)}
      className={`rc-src${cited ? " rc-src--cited" : ""}${hot ? " rc-src--hot" : ""}`}
      style={{ ["--cat" as string]: meta.color }}
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...spring, delay: Math.min(index, 8) * 0.045 }}
    >
      <div className="rc-src__top">
        <span className="rc-src__code mono">{index + 1}</span>
        <span className="rc-src__cat" style={{ color: meta.color }}>
          <Cat size={12} aria-hidden /> {meta.label}
        </span>
        {s.viaGraph ? (
          <span className="chip chip-tint chip-violet" title="Not a direct match: pulled in through the knowledge graph (shares an entity or a semantic link with a top result)">
            <Network size={11} /> <span>via graph</span>
          </span>
        ) : null}
        <span className="rc-src__score tnum" title="Relevance: semantic + keyword + entity + recency">
          {Math.round(Math.min(1, s.score) * 100)}%
        </span>
      </div>
      <div className="rc-src__title">{s.title}</div>
      {s.snippet ? <p className="rc-src__snip">“{s.snippet}”</p> : null}
      <div className="rc-src__meta">
        <span className="rc-src__when tnum">
          <Clock size={12} aria-hidden /> {formatDayTime(s.when)}
        </span>
        <span>
          <Icon size={12} aria-hidden /> {placeLabel(s.activity, s.deviceKind)}
        </span>
        {s.deviceKind ? <span>{s.deviceKind === "pocket" ? "phone" : "laptop"}</span> : null}
      </div>
      <span className="bar rc-src__bar" aria-hidden>
        <i style={{ width: `${Math.round(Math.min(1, s.score) * 100)}%`, background: meta.color }} />
      </span>
    </motion.li>
  );
});

/** The streamed answer with clickable numbered citations (the model writes [T-12]; people see [1]). */
const Answer = memo(function Answer({ q, onCite }: { q: RecallQuery; onCite: (code: string) => void }) {
  const segs = useMemo(() => parseAnswer(q.answer), [q.answer]);
  // V1: citations are numbered like the sources below (1, 2, 3), never internal ids
  const num = useMemo(() => new Map(q.sources.map((s, i) => [s.code, i + 1])), [q.sources]);
  const streaming = !q.done;
  if (!q.answer && streaming) {
    return (
      <div className="rc-answer rc-answer--wait" aria-live="polite">
        <span className="rc-think" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        Reading the sources…
      </div>
    );
  }
  return (
    <div className={`rc-answer${q.notFound ? " rc-answer--none" : ""}`} aria-live="polite" aria-busy={streaming}>
      <p className={streaming ? "caret" : undefined}>
        {segs.map((seg, i) =>
          seg.t === "text" ? (
            <span key={i}>{seg.v}</span>
          ) : (
            <span key={i} className="rc-cites">
              {seg.codes.map((c) => (
                <button key={c} type="button" className="rc-cite mono" onClick={() => onCite(c)} title={`Jump to source ${num.get(c) ?? ""}`}>
                  {num.get(c) ?? "·"}
                </button>
              ))}
            </span>
          ),
        )}
      </p>
    </div>
  );
});

function QueryView({ q }: { q: RecallQuery }) {
  const [hot, setHot] = useState<string | null>(null);
  const cited = useMemo(() => new Set(citedCodes(q.answer)), [q.answer]);
  const cite = (code: string): void => {
    setHot(code);
    highlightId(sourceDomId(code));
    setTimeout(() => setHot((h) => (h === code ? null : h)), 1800);
  };
  return (
    <motion.div key={q.id} className="rc-result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="rc-qhead">
        <span className="rc-qicon" aria-hidden>
          {q.origin === "voice" ? <Mic size={15} /> : <Search size={15} />}
        </span>
        <h2 className="rc-qtext">“{q.text}”</h2>
        <span className="chip" title={q.origin === "voice" ? "You asked this out loud: Synapse recognised a question for memory" : "Typed"}>
          <span>{q.origin === "voice" ? "asked by voice" : "typed"}</span>
        </span>
      </div>

      {q.constraints ? <ConstraintChips c={q.constraints} /> : <div className="shimmer" style={{ height: "1.6rem", width: "60%" }} />}

      {q.relaxations.length ? (
        <div className="rc-relax" role="note">
          <Sparkles size={14} aria-hidden />
          <span>
            Nothing matched exactly, so I <b>{q.relaxations.join(", then ")}</b>.
          </span>
        </div>
      ) : null}

      <div className="rc-timing tnum">
        {q.sourcesMs === undefined ? <span>searching…</span> : <span>{q.sources.length} source{q.sources.length === 1 ? "" : "s"}</span>}
      </div>

      {q.error ? (
        <div className="rc-answer rc-answer--none">{q.error}</div>
      ) : q.sources.length || q.answer || q.done ? (
        <>
          <div className="section__title" style={{ marginTop: "1rem" }}>
            <Sparkles size={14} /> Answer
          </div>
          <Answer q={q} onCite={cite} />
        </>
      ) : (
        <div className="rc-answer rc-answer--wait">
          <span className="rc-think" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          Searching memory…
        </div>
      )}

      {q.sources.length ? (
        <>
          <div className="section__title" style={{ marginTop: "1.1rem" }}>
            <Hash size={14} /> Sources
          </div>
          <ul className="rc-sources" aria-label="Sources">
            {q.sources.map((s, i) => (
              <SourceCard key={s.thoughtId} s={s} index={i} cited={cited.has(s.code)} hot={hot === s.code} />
            ))}
          </ul>
        </>
      ) : q.done && !q.error ? (
        <div className="empty">
          <Search size={22} />
          Nothing in memory matches yet. Say something first, then ask about it.
        </div>
      ) : null}
    </motion.div>
  );
}

const TRY = ["What was that idea I had about caching last Tuesday while I was walking?", "What did Sarah say about OAuth?", "That bug from yesterday, the null pointer"];

/**
 * Recall (PRD §6.4): ask your memory the way you would ask yourself: vague, temporal, situational. Sources show
 * at once, the answer streams in with citations. Questions asked out loud show up here too.
 */
export default function Recall() {
  const queries = useRecall((s) => s.queries);
  const order = useRecall((s) => s.order);
  const activeId = useRecall((s) => s.activeId);
  const markSeen = useRecall((s) => s.markSeen);
  const setActive = useRecall((s) => s.setActive);
  const ttsOn = useSettings((s) => s.tts);
  const patch = useSettings((s) => s.patch);
  const status = useConnection((s) => s.status);
  const tts = useTts();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const active = activeId ? queries[activeId] : order[0] ? queries[order[0]] : undefined;
  useEffect(() => {
    markSeen();
  }, [active?.id, queries, markSeen]);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const ask = (raw: string): void => {
    const q = raw.trim();
    if (!q) return;
    if (!socket.isOpen) {
      toast.warn(status === "auth" ? "Pair this device first." : "Not connected to the Synapse server yet. Try again in a moment.");
      return;
    }
    const id = newId("q");
    useRecall.getState().start(id, q, "typed", Date.now());
    socket.send({ type: "recall.ask", queryId: id, text: q });
    setText("");
    setTimeout(() => {
      const cur = useRecall.getState().queries[id];
      if (cur && !cur.sources.length && !cur.done) useRecall.getState().fail(id, "The server did not answer in time. Is it still running?");
    }, 20_000);
  };

  return (
    <div className="page">
      <div className="page__inner rc">
        <header className="page__head">
          <div>
            <h1 className="page__title">
              <span className="grad-text">Ask</span>
            </h1>
            <p className="page__sub">Ask your memory the way you would ask yourself: vague, about a time, about where you were. Type it here, or ask it out loud from the Inbox mic.</p>
          </div>
          <button
            type="button"
            className="btn"
            role="switch"
            aria-checked={ttsOn}
            disabled={!tts.supported}
            onClick={() => patch({ tts: !ttsOn })}
            title={tts.supported ? `Read answers aloud with an on-device voice (${tts.voiceName})` : (tts.reason ?? "")}
          >
            {ttsOn && tts.supported ? <Volume2 size={14} /> : <VolumeX size={14} />} {ttsOn && tts.supported ? "Speaking answers" : "Answers as text"}
          </button>
        </header>

        <form
          className="rc-ask glass-strong"
          onSubmit={(e) => {
            e.preventDefault();
            ask(text);
          }}
        >
          <Search size={18} aria-hidden className="rc-ask__icon" />
          <label className="sr-only" htmlFor="recall-q">
            Ask your memory
          </label>
          <input
            id="recall-q"
            ref={input}
            className="rc-ask__input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What was that idea I had about caching last Tuesday while I was walking?"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
            Ask
          </button>
        </form>
        {!tts.supported ? (
          <p className="ab__hint rc-ttsnote">{tts.reason}</p>
        ) : null}

        <div className="rc-try">
          <span className="eyebrow">Try</span>
          {TRY.map((t) => (
            <button key={t} type="button" className="chip" onClick={() => (setText(t), input.current?.focus())}>
              {truncate(t, 54)}
            </button>
          ))}
        </div>

        {order.length > 1 ? (
          <div className="rc-history" aria-label="Earlier questions">
            <History size={14} aria-hidden />
            {order.slice(0, 8).map((id) => {
              const q = queries[id];
              if (!q) return null;
              return (
                <button key={id} type="button" className="chip" aria-pressed={active?.id === id} onClick={() => setActive(id)} data-active={active?.id === id}>
                  {q.origin === "voice" ? <Mic size={11} /> : null}
                  <span>{truncate(q.text || "…", 32)}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <AnimatePresence mode="wait" initial={false}>
          {active ? (
            <QueryView key={active.id} q={active} />
          ) : (
            <motion.div key="empty" className="rc-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="rc-empty__orb" aria-hidden>
                <Search size={28} />
              </div>
              <h2>Ask your memory.</h2>
              <p>
                Synapse understands <b>when</b> (&ldquo;last Tuesday&rdquo;), <b>where you were</b> (&ldquo;while I was walking&rdquo;), <b>what kind of thing</b> (an idea, a bug, a decision) and <b>who</b> (&ldquo;what Sarah said&rdquo;), then answers with sources you can click.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
