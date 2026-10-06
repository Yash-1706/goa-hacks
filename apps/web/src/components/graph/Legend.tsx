import { memo, type ReactNode } from "react";
import { ChevronDown, Layers, Monitor, RotateCcw, Smartphone, X } from "lucide-react";
import type { Category, EdgeType } from "@synapse/shared";
import { CATEGORY_META, EDGE_STYLE } from "@/lib/category";
import type { GraphStats } from "@/lib/graph-model";
import { entityColor } from "@/lib/graph-style";
import { graphCache, useGraphView } from "./view-store";

/* ============================================================================
 * Legend: what the shapes, colours and lines mean. The category and edge entries are real controls (toggle
 * buttons): pick a category to light only those thoughts, or hide an edge type. Keyboard accessible.
 * ========================================================================== */

const SEMANTIC_ORDER: EdgeType[] = ["refines", "same_topic", "answers", "follows_up", "contradicts", "supersedes"];
const STRUCTURAL_ORDER: EdgeType[] = ["mentions", "in_session", "produced", "related"];

const EDGE_HINT: Record<string, string> = {
  mentions: "a thought names an entity",
  in_session: "belongs to a session",
  produced: "thought → what it made",
  related: "entities that co-occur",
  refines: "adds detail to an earlier thought",
  same_topic: "semantically close, across sessions too",
  answers: "settles an open question",
  follows_up: "continues an earlier thought",
  contradicts: "disagrees with an earlier thought",
  supersedes: "replaces a decision",
};

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg className="gx-sw" width="26" height="22" viewBox="0 0 26 22" aria-hidden>
      {children}
    </svg>
  );
}

function EdgeSample({ type }: { type: EdgeType }) {
  const s = EDGE_STYLE[type];
  return (
    <svg className="gx-sw" width="30" height="12" viewBox="0 0 30 12" aria-hidden>
      <line x1="2" y1="6" x2="28" y2="6" stroke={s?.color ?? "#94a3b8"} strokeWidth={s?.semantic ? 2.2 : 1.4} strokeDasharray={s?.dash.length ? s.dash.map((d) => d * 1.1).join(" ") : undefined} strokeLinecap="round" />
    </svg>
  );
}

export const Legend = memo(function Legend({ stats, onSelect }: { stats: GraphStats | null; onSelect: (id: string) => void }) {
  const open = useGraphView((s) => s.legendOpen);
  const categories = useGraphView((s) => s.categories);
  const hidden = useGraphView((s) => s.hiddenEdgeTypes);
  const { toggleLegend, toggleCategory, toggleEdgeType, clearFilters } = useGraphView.getState();
  const filtered = categories.size > 0 || hidden.size > 0;

  const edgeCount = (t: EdgeType): number => stats?.edgeTypes[t] ?? 0;
  const semantic = SEMANTIC_ORDER.filter((t) => edgeCount(t) > 0);
  const structural = STRUCTURAL_ORDER.filter((t) => edgeCount(t) > 0 || t === "mentions" || t === "in_session");
  const sessions = stats?.sessionList ?? [];

  return (
    <aside className="gx-legend glass-strong" data-open={open} aria-label="Legend">
      <button type="button" className="gx-legend__head" onClick={() => toggleLegend()} aria-expanded={open} aria-controls="gx-legend-body" aria-label="Legend">
        <Layers size={15} aria-hidden />
        <span>Legend</span>
        {filtered ? <span className="gx-legend__dot" title="A filter is active" /> : null}
        <ChevronDown size={14} className="gx-legend__chev" aria-hidden />
      </button>

      <div id="gx-legend-body" className="gx-legend__body" hidden={!open}>
        <div className="gx-legend__scroll">
          <button type="button" className="icon-btn gx-legend__x" onClick={() => toggleLegend(false)} aria-label="Close the legend" title="Close">
            <X size={16} />
          </button>
          <section>
            <h4 className="gx-sec__title">Nodes</h4>
            <ul className="gx-key">
              <li>
                <Swatch>
                  <circle cx="13" cy="11" r="8" fill="rgba(139,92,246,.16)" stroke="#8b5cf6" strokeWidth="2.2" />
                </Swatch>
                <span>
                  <b>Session</b> a conversation. Colour per session.
                </span>
              </li>
              <li>
                <Swatch>
                  <circle cx="7" cy="11" r="5" fill="none" stroke="#a78bfa" strokeWidth="1.8" />
                  <circle cx="19" cy="11" r="5" fill="none" stroke="#22d3ee" strokeWidth="1.8" strokeDasharray="3 2.2" />
                </Swatch>
                <span>
                  <b>Solid ring</b> desk, <b>dashed</b> pocket (phone).
                </span>
              </li>
              <li>
                <Swatch>
                  <circle cx="13" cy="11" r="5" fill="#fb7185" />
                  <circle cx="13" cy="11" r="8" fill="none" stroke="#a78bfa" strokeWidth="1.4" opacity=".7" />
                </Swatch>
                <span>
                  <b>Thought</b> a dot, coloured by category.
                </span>
              </li>
              <li>
                <Swatch>
                  <path d="M13 3 L21 11 L13 19 L5 11 Z" fill="#e879f9" />
                </Swatch>
                <span>
                  <b>Decision</b> a diamond.
                </span>
              </li>
              <li>
                <Swatch>
                  <rect x="5" y="3" width="16" height="16" rx="4.5" fill="rgba(125,211,252,.24)" stroke={entityColor("component")} strokeWidth="1.6" />
                  <rect x="2.5" y="0.5" width="21" height="21" rx="6" fill="none" stroke="#c4b5fd" strokeWidth="1" strokeDasharray="2.6 2.6" />
                </Swatch>
                <span>
                  <b>Entity</b> a person, component or topic. Sized by salience. A dashed halo bridges sessions.
                </span>
              </li>
              <li>
                <Swatch>
                  <circle cx="13" cy="11" r="7" fill="#0b0d12" stroke="#34d399" strokeWidth="1.4" />
                  <path d="M10.2 8.6 L7.6 11 L10.2 13.4 M15.8 8.6 L18.4 11 L15.8 13.4" fill="none" stroke="#34d399" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </Swatch>
                <span>
                  <b>Artifact</b> an icon for the ticket, email or snippet a thought made.
                </span>
              </li>
            </ul>
          </section>

          <section>
            <h4 className="gx-sec__title">Memory</h4>
            <div className="gx-ttl" aria-hidden>
              <span className="gx-ttl__bar" />
              <span className="gx-ttl__ends">
                <span>about to be forgotten</span>
                <span>fresh / kept</span>
              </span>
            </div>
            <ul className="gx-key">
              <li>
                <Swatch>
                  <circle cx="13" cy="11" r="4.6" fill="#38bdf8" opacity=".42" />
                  <path d="M13 3.6 A7.4 7.4 0 0 1 20.4 11" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" opacity=".7" />
                </Swatch>
                <span>
                  <b>Working memory</b> fades toward its expiry; the arc is the life left.
                </span>
              </li>
              <li>
                <Swatch>
                  <circle cx="13" cy="11" r="8.6" fill="#38bdf8" opacity=".25" />
                  <circle cx="13" cy="11" r="4.6" fill="#38bdf8" stroke="rgba(255,255,255,.75)" strokeWidth="1" />
                  <circle cx="13" cy="11" r="1.5" fill="#fff" />
                </Swatch>
                <span>
                  <b>Remembered</b> solid and glowing: promoted to long-term.
                </span>
              </li>
            </ul>
          </section>

          {stats && stats.categories.length ? (
            <section>
              <h4 className="gx-sec__title">
                Categories <span className="gx-sec__hint">tap to focus</span>
              </h4>
              <div className="gx-cats">
                {stats.categories.map(([c, n]) => (
                  <CategoryButton key={c} category={c} count={n} pressed={categories.has(c)} dimmed={categories.size > 0 && !categories.has(c)} onToggle={() => toggleCategory(c)} />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h4 className="gx-sec__title">
              Links <span className="gx-sec__hint">tap to hide</span>
            </h4>
            <ul className="gx-edges">
              {[...structural, ...semantic].map((t) => {
                const off = hidden.has(t);
                return (
                  <li key={t}>
                    <button type="button" className="gx-edgebtn" aria-pressed={!off} aria-label={`${EDGE_STYLE[t]?.label ?? t} links, ${edgeCount(t)}. ${EDGE_HINT[t] ?? ""}. Press to ${off ? "show" : "hide"}.`} onClick={() => toggleEdgeType(t)} title={EDGE_HINT[t]}>
                      <EdgeSample type={t} />
                      <span className="gx-edgebtn__label">{EDGE_STYLE[t]?.label ?? t}</span>
                      <span className="gx-edgebtn__n tnum">{edgeCount(t)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!semantic.length ? <p className="gx-note gx-note--tight">Dashed, coloured links appear when thoughts relate (same topic, answers, refines, contradicts).</p> : null}
          </section>

          {sessions.length ? (
            <section>
              <h4 className="gx-sec__title">Sessions</h4>
              <ul className="gx-sessions">
                {sessions.slice(0, 14).map((s) => {
                  const color = graphCache.colors.get(s.id);
                  const Icon = s.deviceKind === "pocket" ? Smartphone : Monitor;
                  return (
                    <li key={s.id}>
                      <button type="button" className="gx-sesbtn" onClick={() => onSelect(s.id)} style={{ ["--c" as string]: color }} title="Select this session">
                        <span className={`gx-sesbtn__ring${s.deviceKind === "pocket" ? " is-pocket" : ""}`} aria-hidden />
                        <Icon size={12} aria-hidden />
                        <span className="gx-sesbtn__label">{s.label}</span>
                        <span className="gx-sesbtn__n tnum">{s.thoughts}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {sessions.length > 14 ? <p className="gx-note gx-note--tight">+{sessions.length - 14} more sessions</p> : null}
            </section>
          ) : null}

          {filtered ? (
            <button type="button" className="btn btn-sm gx-legend__reset" onClick={clearFilters}>
              <RotateCcw size={12} aria-hidden /> Clear filters
            </button>
          ) : null}

          <section>
            <h4 className="gx-sec__title">Moving around</h4>
            <ul className="gx-tips">
              <li>
                <kbd>hover</kbd> previews a node, <kbd>click</kbd> pins it and lights its neighbours
              </li>
              <li>
                <kbd>drag</kbd> pans, <kbd>scroll</kbd> or pinch zooms, <kbd>F</kbd> fits everything
              </li>
              <li>
                <kbd>←</kbd> <kbd>→</kbd> step through nodes, <kbd>Esc</kbd> closes the panel
              </li>
              <li>
                The timeline replays how memory grew; its right end is <b>Live</b>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </aside>
  );
});

function CategoryButton({ category, count, pressed, dimmed, onToggle }: { category: Category; count: number; pressed: boolean; dimmed: boolean; onToggle: () => void }) {
  const meta = CATEGORY_META[category];
  return (
    <button type="button" className="gx-cat" aria-pressed={pressed} data-dim={dimmed} aria-label={`${meta.label}, ${count} ${count === 1 ? "thought" : "thoughts"}. ${meta.gloss}. Press to focus on this category.`} onClick={onToggle} style={{ ["--c" as string]: meta.color }} title={meta.gloss}>
      <span className="gx-cat__dot" aria-hidden />
      <span>{meta.label}</span>
      <span className="gx-cat__n tnum">{count}</span>
    </button>
  );
}
