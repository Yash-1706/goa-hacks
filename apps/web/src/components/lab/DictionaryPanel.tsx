import { memo, useMemo, useState } from "react";
import { ArrowRight, BookMarked, Radio, Search, Sparkles, WandSparkles } from "lucide-react";
import type { DictionaryTerm } from "@synapse/shared";
import { useNow } from "@/hooks/useNow";
import { formatAgo } from "@/lib/format";
import { KIND_META, KIND_ORDER, countTerms, filterTerms, parseDictSource, primedSet, sortTerms, type DictFilter } from "@/lib/lab-dictionary";
import type { DictionaryResponse } from "@/net/api-types";
import { useAudioUi } from "@/state/audio";
import { Panel } from "./Panel";
import { Segmented, type SegOption } from "./Segmented";
import type { Polled } from "./usePolled";

/* The self-healing dictionary (PRD MEM-5, TRD §10.7): every term Synapse has learned, where it came from, and the
 * repaired mis-hearings (`corrected "card service" → "cart-service"`) pulled out and styled on their own. */

const PAGE = 12;

function KindTag({ kind }: { kind: DictionaryTerm["kind"] }) {
  const m = KIND_META[kind];
  return (
    <span className="lab-kind" style={{ ["--k" as string]: m.tint }} title={m.gloss}>
      <i aria-hidden /> {m.label}
    </span>
  );
}

function Salience({ value }: { value: number }) {
  return (
    <span className="lab-sal" title={`Salience ${value.toFixed(2)}: how strongly Synapse wants Wispr to know this term`}>
      <span className="bar">
        <i style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
      </span>
      <span className="tnum">{value.toFixed(2)}</span>
    </span>
  );
}

function Source({ term }: { term: DictionaryTerm }) {
  const s = parseDictSource(term.source);
  switch (s.type) {
    case "learned":
      return (
        <span>
          learned from <span className="chip chip-mono lab-code">{s.thought}</span>
        </span>
      );
    case "team":
      return <span>from your team list</span>;
    case "seed":
      return <span>from the seed data</span>;
    case "corrected":
      return (
        <span>
          repaired{s.thought ? " in " : ""}
          {s.thought ? <span className="chip chip-mono lab-code">{s.thought}</span> : null}
        </span>
      );
    default:
      return <span>{s.text || "unknown source"}</span>;
  }
}

function Primed({ on }: { on: boolean }) {
  return on ? (
    <span className="lab-primed" title="In the dictionary_context this browser sends to Wispr right now">
      <Radio size={11} aria-hidden /> primed
    </span>
  ) : null;
}

function Healed({ term, now, primed }: { term: DictionaryTerm; now: number; primed: boolean }) {
  const s = parseDictSource(term.source);
  if (s.type !== "corrected") return null;
  return (
    <li className="lab-heal">
      <div className="lab-heal__badge">
        <WandSparkles size={13} aria-hidden /> Healed
      </div>
      <div className="lab-heal__body">
        <div className="lab-heal__fix">
          <span className="lab-heal__heard" title="What Wispr heard">
            {s.heard}
          </span>
          <ArrowRight size={15} aria-hidden className="lab-heal__arrow" />
          <span className="lab-heal__term" title="What you meant">
            {term.term}
          </span>
          <KindTag kind={term.kind} />
          <Primed on={primed} />
        </div>
        <div className="lab-heal__meta">
          <Source term={term} />
          <span aria-hidden>·</span>
          <span>seen {formatAgo(term.lastSeen, now)}</span>
          <Salience value={term.salience} />
        </div>
      </div>
    </li>
  );
}

function Row({ term, now, primed }: { term: DictionaryTerm; now: number; primed: boolean }) {
  return (
    <li className="lab-term" style={{ ["--k" as string]: KIND_META[term.kind].tint }}>
      <div className="lab-term__top">
        <span className={`lab-term__name${term.kind === "component" ? " mono" : ""}`}>{term.term}</span>
        <KindTag kind={term.kind} />
        <Primed on={primed} />
      </div>
      <div className="lab-term__meta">
        <Source term={term} />
        <span aria-hidden>·</span>
        <span>{formatAgo(term.lastSeen, now)}</span>
      </div>
      <Salience value={term.salience} />
    </li>
  );
}

export const DictionaryPanel = memo(function DictionaryPanel({ dictionary }: { dictionary: Polled<DictionaryResponse> }) {
  const { data, error, loading } = dictionary;
  const primedTerms = useAudioUi((s) => s.wisprContext?.dictionary);
  const now = useNow(30_000);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DictFilter>("all");
  const [all, setAll] = useState(false);

  const terms = useMemo(() => sortTerms(data ?? []), [data]);
  const counts = useMemo(() => countTerms(terms), [terms]);
  const primed = useMemo(() => primedSet(primedTerms), [primedTerms]);
  const shown = useMemo(() => filterTerms(terms, { filter, query }), [terms, filter, query]);
  const healed = shown.filter((t) => parseDictSource(t.source).type === "corrected");
  const plain = shown.filter((t) => parseDictSource(t.source).type !== "corrected");
  const visible = all ? plain : plain.slice(0, PAGE);
  const primedCount = terms.filter((t) => primed.has(t.term.toLowerCase())).length;

  const options: Array<SegOption<DictFilter>> = [
    { id: "all", label: "All", count: counts.total },
    ...KIND_ORDER.filter((k) => counts.byKind[k] > 0 || filter === k).map((k) => ({ id: k as DictFilter, label: KIND_META[k].plural, count: counts.byKind[k] })),
    { id: "healed", label: "Healed", count: counts.healed, icon: <WandSparkles size={12} aria-hidden /> },
  ];

  return (
    <Panel
      id="lab-dictionary"
      icon={<BookMarked size={16} />}
      title="Self-healing dictionary"
      sub={
        <>
          Names, components and jargon Synapse learns from what you say. The best go to Wispr as <span className="mono">dictionary_context</span>, so they are spelled right next time.
        </>
      }
      badge={
        <span className="lab-count" title={primedTerms ? `${primedCount} of these are in this browser's current Wispr context` : undefined}>
          <b className="tnum">{counts.total}</b> terms{primedTerms ? <span className="lab-dim"> · {primedCount} primed</span> : null}
        </span>
      }
      className="lab-panel--dict"
    >
      <div className="lab-dict__bar">
        <label className="lab-search">
          <Search size={15} aria-hidden />
          <span className="sr-only">Search the dictionary</span>
          <input className="input" type="search" placeholder="Search terms or sources…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <Segmented label="Filter by kind" options={options} value={filter} onChange={setFilter} className="lab-seg--scroll" />
      </div>

      {loading && !data ? (
        <div className="lab-skel" aria-hidden>
          <span className="shimmer" style={{ height: "3.4rem" }} />
          <span className="shimmer" style={{ height: "3.4rem" }} />
        </div>
      ) : error && !data ? (
        <p className="lab-error" role="alert">
          Could not load the dictionary: {error}
        </p>
      ) : terms.length === 0 ? (
        <div className="empty lab-empty">
          <Sparkles size={22} aria-hidden />
          <p>Nothing learned yet. As you talk, Synapse adds the names, components and jargon it hears, and primes Wispr with the best 150.</p>
        </div>
      ) : (
        <>
          {counts.healed === 0 && filter !== "healed" && !query ? (
            <p className="lab-dict__hint">
              <WandSparkles size={13} aria-hidden />
              <span>
                When Synapse repairs a mis-hearing (say, <i>“card service”</i> → <b>cart-service</b>), it shows up here and Wispr gets the right spelling next time.
              </span>
            </p>
          ) : null}

          {healed.length > 0 ? (
            <div className="lab-dict__sec">
              <div className="lab-sub__label">Repaired mis-hearings · {healed.length}</div>
              <ul className="lab-heals">
                {healed.map((t) => (
                  <Healed key={t.term} term={t} now={now} primed={primed.has(t.term.toLowerCase())} />
                ))}
              </ul>
            </div>
          ) : null}

          {plain.length > 0 ? (
            <div className="lab-dict__sec">
              {healed.length > 0 ? <div className="lab-sub__label">Learned terms · {plain.length}</div> : null}
              <ul className="lab-terms">
                {visible.map((t) => (
                  <Row key={t.term} term={t} now={now} primed={primed.has(t.term.toLowerCase())} />
                ))}
              </ul>
              {plain.length > PAGE ? (
                <button type="button" className="btn btn-ghost btn-sm lab-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                  {all ? "Show fewer" : `Show all ${plain.length}`}
                </button>
              ) : null}
            </div>
          ) : null}

          {shown.length === 0 ? (
            <div className="empty lab-empty">
              <Search size={20} aria-hidden />
              <p>
                {query ? <>No term matches “{query}”.</> : filter === "healed" ? <>No repaired mis-hearings yet.</> : <>No terms of this kind yet.</>}
              </p>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
});
