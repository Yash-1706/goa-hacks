import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { ChevronRight, Clock, Footprints, Car, Hourglass, Link2, Monitor, Pin, Smartphone, X, type LucideIcon } from "lucide-react";
import type { EntityType, GraphNode, ThoughtView } from "@synapse/shared";
import { ArtifactBody, ArtifactPreview } from "@/components/card/ArtifactBody";
import { ThoughtCard } from "@/components/card/ThoughtCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { useIsPhone } from "@/hooks/useMedia";
import { ARTIFACT_LABEL, categoryMeta } from "@/lib/category";
import { activityLabel, formatCountdown, formatDayTime, formatClock, plural } from "@/lib/format";
import { artifactKindFromLabel, neighborsOf, producerOf, thoughtsMentioning, thoughtsOfSession } from "@/lib/graph-model";
import { edgeVisual, categoryHex, entityColor, isLongTerm } from "@/lib/graph-style";
import { api } from "@/net/api";
import { useGraph } from "@/state/graph";
import { useThoughts } from "@/state/thoughts";
import { ENTITY_ICON } from "./icons";
import { graphCache, useGraphView } from "./view-store";

/* ============================================================================
 * Detail panel: what a node IS. Thought → the living card (read-only) plus how it connects; entity → who
 * mentions it, grouped by session; session → its device and thoughts; artifact → its preview. Every row
 * is a button that moves the selection, so you can walk the graph from the panel as well as the canvas.
 * Desktop: a glass panel on the right. Phone: a bottom sheet.
 * ========================================================================== */

interface PanelProps {
  nodeId: string | null;
  /** pinned by a click (otherwise it is a hover preview that goes away with the pointer) */
  pinned: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  /** the pointer is over the panel: keep a hover preview alive */
  onHold: (hold: boolean) => void;
}

const colorOf = (n: GraphNode): string => {
  switch (n.kind) {
    case "session":
      return graphCache.colors.get(n.id);
    case "entity":
      return entityColor(n.entityType);
    case "artifact":
      return graphCache.node(n.id)?.color ?? "#94a3b8";
    default:
      return categoryHex(n.category);
  }
};

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  session: "Session",
  thought: "Thought",
  decision: "Decision",
  entity: "Entity",
  artifact: "Artifact",
  open_loop: "Open loop",
};

// ------------------------------------------------------------- data hooks --

interface ThoughtState {
  status: "loading" | "ready" | "missing";
  view: ThoughtView | undefined;
  /** the card component can render it (it lives in the thoughts store) */
  inStore: boolean;
}

/**
 * The thoughts store keeps ~120 recent cards; for older nodes the thought is fetched once and upserted so
 * the real card component can render it. If the store trims it straight away the fetched view is kept for
 * a lightweight fallback.
 */
function useThoughtView(id: string | undefined): ThoughtState {
  const inStore = useThoughts((s) => (id ? Boolean(s.byId[id]) : false));
  const stored = useThoughts((s) => (id ? s.byId[id] : undefined));
  const [fetched, setFetched] = useState<{ id: string; status: "loading" | "ready" | "missing"; view?: ThoughtView } | null>(null);

  useEffect(() => {
    if (!id) return;
    if (useThoughts.getState().byId[id]) {
      setFetched({ id, status: "ready" });
      return;
    }
    const ac = new AbortController();
    setFetched({ id, status: "loading" });
    api
      .thought(id, ac.signal)
      .then((v) => {
        useThoughts.getState().upsert(v);
        setFetched({ id, status: "ready", view: v });
      })
      .catch(() => {
        if (!ac.signal.aborted) setFetched({ id, status: "missing" });
      });
    return () => ac.abort();
  }, [id]);

  if (!id) return { status: "missing", view: undefined, inStore: false };
  if (stored) return { status: "ready", view: stored, inStore };
  const mine = fetched && fetched.id === id ? fetched : null;
  return { status: mine?.status ?? "loading", view: mine?.view, inStore };
}

// -------------------------------------------------------------- small parts --

/** Pointing at a row rings its node on the canvas. */
const emphasize = (id: string | null) => ({
  onPointerEnter: () => useGraphView.getState().emphasize(id),
  onPointerLeave: () => useGraphView.getState().emphasize(null),
  onFocus: () => useGraphView.getState().emphasize(id),
  onBlur: () => useGraphView.getState().emphasize(null),
});

function Row({ id, color, title, meta, trailing, onClick, icon: Icon }: { id?: string; color: string; title: string; meta?: ReactNode; trailing?: ReactNode; onClick: () => void; icon?: LucideIcon }) {
  return (
    <button type="button" className="gx-row" onClick={onClick} style={{ ["--c" as string]: color }} {...emphasize(id ?? null)}>
      <span className="gx-row__dot" aria-hidden>
        {Icon ? <Icon size={11} /> : null}
      </span>
      <span className="gx-row__main">
        <span className="gx-row__title">{title}</span>
        {meta ? <span className="gx-row__meta">{meta}</span> : null}
      </span>
      {trailing}
      <ChevronRight size={14} className="gx-row__go" aria-hidden />
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="gx-sec">
      <h4 className="gx-sec__title">
        <span>{title}</span>
        {count !== undefined ? <span className="gx-sec__n tnum">{count}</span> : null}
      </h4>
      {children}
    </section>
  );
}

function Retention({ n }: { n: GraphNode }) {
  if (n.kind === "session") return null;
  if (isLongTerm(n)) {
    return (
      <span className="gx-ret gx-ret--kept" title="Long-term memory: it does not expire">
        <Pin size={10} /> kept
      </span>
    );
  }
  const left = (n.expiresAt ?? 0) - Date.now();
  return (
    <span className="gx-ret" title="Working memory: forgotten when the timer runs out unless it is promoted">
      <Hourglass size={10} /> {formatCountdown(left)}
    </span>
  );
}

function thoughtMeta(n: GraphNode): ReactNode {
  const meta = n.category ? categoryMeta(n.category) : null;
  return (
    <>
      {meta ? <span style={{ color: meta.color }}>{meta.label}</span> : null}
      <span className="tnum">{formatClock(n.createdAt)}</span>
    </>
  );
}

function SessionChip({ id, nodes, onSelect }: { id: string | undefined; nodes: Record<string, GraphNode>; onSelect: (id: string) => void }) {
  const s = id ? nodes[id] : undefined;
  if (!s) return null;
  const color = colorOf(s);
  const Icon = s.deviceKind === "pocket" ? Smartphone : Monitor;
  return (
    <button type="button" className="gx-chip" {...emphasize(s.id)} onClick={() => onSelect(s.id)} style={{ ["--c" as string]: color }} title="Select this session">
      <span className="gx-chip__sw" aria-hidden />
      <Icon size={12} aria-hidden />
      <span>{s.label}</span>
    </button>
  );
}

// ------------------------------------------------------------------- bodies --

function ThoughtBody({ node, onSelect }: { node: GraphNode; onSelect: (id: string) => void }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const t = useThoughtView(node.id);
  const map = useMemo(() => new Map(Object.entries(nodes)), [nodes]);
  const links = useMemo(() => neighborsOf(node.id, map, Object.values(edges)), [node.id, map, edges]);
  const entities = links.filter((l) => l.edge.type === "mentions" && l.node.kind === "entity");
  const related = links.filter((l) => l.edge.type !== "mentions" && l.edge.type !== "in_session" && l.edge.type !== "produced" && (l.node.kind === "thought" || l.node.kind === "decision"));
  const artifacts = links.filter((l) => l.edge.type === "produced" && l.node.kind === "artifact");

  return (
    <>
      {t.inStore ? (
        <ThoughtCard id={node.id} compact />
      ) : t.view ? (
        <ThoughtFallback view={t.view} />
      ) : t.status === "missing" ? (
        <p className="gx-note">This thought is no longer in working memory (it was forgotten or expired).</p>
      ) : (
        <div className="gx-skel">
          <Skeleton lines={4} />
        </div>
      )}

      <div className="gx-facts">
        <SessionChip id={node.sessionId} nodes={nodes} onSelect={onSelect} />
        <Retention n={node} />
        <span className="gx-fact tnum" title="When it was said">
          <Clock size={11} aria-hidden /> {formatDayTime(node.createdAt)}
        </span>
      </div>

      {entities.length ? (
        <Section title="Entities" count={entities.length}>
          <div className="gx-chips">
            {entities.map(({ node: e }) => {
              const Icon = ENTITY_ICON[(e.entityType ?? "topic") as EntityType];
              return (
                <button key={e.id} type="button" className="gx-chip" {...emphasize(e.id)} style={{ ["--c" as string]: entityColor(e.entityType) }} onClick={() => onSelect(e.id)} title={`${e.entityType ?? "entity"}: show where else it appears`}>
                  <Icon size={12} aria-hidden />
                  <span>{e.label}</span>
                </button>
              );
            })}
          </div>
        </Section>
      ) : null}

      {related.length ? (
        <Section title="Connected thoughts" count={related.length}>
          {related.map(({ node: o, edge, outgoing }) => {
            const vis = edgeVisual(edge.type, edge.weight);
            return (
              <Row
                key={edge.id}
                id={o.id}
                color={colorOf(o)}
                title={o.label}
                meta={
                  <>
                    <span className="gx-edge" style={{ ["--c" as string]: vis.color }}>
                      {outgoing ? "" : "← "}
                      {vis.label}
                      {outgoing ? " →" : ""}
                    </span>
                    <span className="tnum">{formatClock(o.createdAt)}</span>
                  </>
                }
                onClick={() => onSelect(o.id)}
              />
            );
          })}
        </Section>
      ) : null}

      {artifacts.length ? (
        <Section title="Produced">
          {artifacts.map(({ node: a }) => (
            <Row key={a.id} id={a.id} color={colorOf(a)} title={a.label} onClick={() => onSelect(a.id)} />
          ))}
        </Section>
      ) : null}
    </>
  );
}

/** When the card component cannot render it (the thoughts store trimmed it): the essentials from the fetched view. */
function ThoughtFallback({ view }: { view: ThoughtView }) {
  const meta = categoryMeta(view.category);
  const Icon = meta.icon;
  return (
    <article className="gx-fallback" style={{ ["--c" as string]: meta.color }}>
      <header>
        <span className="gx-fallback__badge">
          <Icon size={16} />
        </span>
        <div>
          <h3>{view.title || "Thought"}</h3>
          <p className="gx-fallback__meta">
            <span className="mono">{view.code}</span> · {meta.label}
          </p>
        </div>
      </header>
      {view.intent ? <p className="gx-fallback__intent">{view.intent}</p> : null}
      <ArtifactBody thought={view} />
    </article>
  );
}

function EntityBody({ node, onSelect }: { node: GraphNode; onSelect: (id: string) => void }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const map = useMemo(() => new Map(Object.entries(nodes)), [nodes]);
  const all = useMemo(() => Object.values(edges), [edges]);
  const thoughts = useMemo(() => thoughtsMentioning(node.id, map, all), [node.id, map, all]);
  const sessions = useMemo(() => {
    const by = new Map<string, GraphNode[]>();
    for (const t of thoughts) {
      const k = t.sessionId ?? "";
      by.set(k, [...(by.get(k) ?? []), t]);
    }
    return [...by.entries()];
  }, [thoughts]);
  const relatedEntities = useMemo(() => neighborsOf(node.id, map, all).filter((l) => l.edge.type === "related" && l.node.kind === "entity"), [node.id, map, all]);
  const Icon = ENTITY_ICON[(node.entityType ?? "topic") as EntityType];
  const color = entityColor(node.entityType);
  const bridge = sessions.length >= 2;

  return (
    <>
      <header className="gx-head" style={{ ["--c" as string]: color }}>
        <span className="gx-head__badge gx-head__badge--sq">
          <Icon size={20} />
        </span>
        <div className="gx-head__text">
          <h3 className="gx-head__title">{node.label}</h3>
          <p className="gx-head__sub">
            <span className="gx-pill">{node.entityType ?? "entity"}</span>
            <Retention n={node} />
            {bridge ? (
              <span className="gx-pill gx-pill--bridge" title="Mentioned in more than one session: it links them">
                <Link2 size={10} aria-hidden /> bridges {sessions.length} sessions
              </span>
            ) : null}
          </p>
        </div>
      </header>
      <p className="gx-lede">
        Mentioned in <b>{plural(thoughts.length, "thought")}</b> across <b>{plural(sessions.length, "session")}</b>. First heard {formatDayTime(node.createdAt)}.
      </p>
      {sessions.map(([sid, list]) => {
        const s = sid ? map.get(sid) : undefined;
        return (
          <Section key={sid || "none"} title={s ? s.label : "Thoughts"} count={list.length}>
            {list.map((t) => (
              <Row key={t.id} id={t.id} color={colorOf(t)} title={t.label} meta={thoughtMeta(t)} trailing={<Retention n={t} />} onClick={() => onSelect(t.id)} />
            ))}
          </Section>
        );
      })}
      {relatedEntities.length ? (
        <Section title="Often with" count={relatedEntities.length}>
          <div className="gx-chips">
            {relatedEntities.map(({ node: e }) => {
              const I = ENTITY_ICON[(e.entityType ?? "topic") as EntityType];
              return (
                <button key={e.id} type="button" className="gx-chip" {...emphasize(e.id)} style={{ ["--c" as string]: entityColor(e.entityType) }} onClick={() => onSelect(e.id)}>
                  <I size={12} aria-hidden />
                  <span>{e.label}</span>
                </button>
              );
            })}
          </div>
        </Section>
      ) : null}
    </>
  );
}

function SessionBody({ node, onSelect }: { node: GraphNode; onSelect: (id: string) => void }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const color = colorOf(node);
  const thoughts = useMemo(() => thoughtsOfSession(node.id, Object.values(nodes)), [node.id, nodes]);
  const entities = useMemo(() => {
    const ids = new Set(thoughts.map((t) => t.id));
    const seen = new Map<string, GraphNode>();
    for (const e of Object.values(edges)) {
      if (e.type !== "mentions") continue;
      const th = ids.has(e.src) ? e.src : ids.has(e.dst) ? e.dst : null;
      if (!th) continue;
      const ent = nodes[th === e.src ? e.dst : e.src];
      if (ent && ent.kind === "entity") seen.set(ent.id, ent);
    }
    return [...seen.values()].sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  }, [thoughts, edges, nodes]);
  const pocket = node.deviceKind === "pocket";
  const ActIcon = node.activity === "walking" ? Footprints : node.activity === "vehicle" ? Car : pocket ? Smartphone : Monitor;

  return (
    <>
      <header className="gx-head" style={{ ["--c" as string]: color }}>
        <span className={`gx-head__badge gx-head__badge--ring${pocket ? " is-pocket" : ""}`}>
          {pocket ? <Smartphone size={19} /> : <Monitor size={19} />}
        </span>
        <div className="gx-head__text">
          <h3 className="gx-head__title">{node.label}</h3>
          <p className="gx-head__sub">
            <span className="gx-pill">{pocket ? "Pocket (phone)" : "Desk (laptop)"}</span>
            <span className="gx-pill">
              <ActIcon size={10} aria-hidden /> {activityLabel(node.activity)}
            </span>
          </p>
        </div>
      </header>
      <p className="gx-lede">
        Started {formatDayTime(node.createdAt)}. <b>{plural(thoughts.length, "thought")}</b> and <b>{plural(entities.length, "entity", "entities")}</b> in this session.
      </p>
      {entities.length ? (
        <Section title="Entities">
          <div className="gx-chips">
            {entities.map((e) => {
              const I = ENTITY_ICON[(e.entityType ?? "topic") as EntityType];
              return (
                <button key={e.id} type="button" className="gx-chip" {...emphasize(e.id)} style={{ ["--c" as string]: entityColor(e.entityType) }} onClick={() => onSelect(e.id)}>
                  <I size={12} aria-hidden />
                  <span>{e.label}</span>
                </button>
              );
            })}
          </div>
        </Section>
      ) : null}
      <Section title="Thoughts" count={thoughts.length}>
        {thoughts.length ? (
          thoughts.map((t) => <Row key={t.id} id={t.id} color={colorOf(t)} title={t.label} meta={thoughtMeta(t)} trailing={<Retention n={t} />} onClick={() => onSelect(t.id)} />)
        ) : (
          <p className="gx-note">Nothing kept from this session yet.</p>
        )}
      </Section>
    </>
  );
}

function ArtifactBodyPanel({ node, onSelect }: { node: GraphNode; onSelect: (id: string) => void }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const producer = useMemo(() => producerOf(node.id, new Map(Object.entries(nodes)), Object.values(edges)), [node.id, nodes, edges]);
  const t = useThoughtView(producer?.id);
  const kind = artifactKindFromLabel(node.label);
  const kindLabel = kind ? ARTIFACT_LABEL[kind] || node.label : node.label;
  const color = colorOf(node);

  return (
    <>
      <header className="gx-head" style={{ ["--c" as string]: color }}>
        <span className="gx-head__badge">
          <Link2 size={18} />
        </span>
        <div className="gx-head__text">
          <h3 className="gx-head__title">{kindLabel}</h3>
          <p className="gx-head__sub">
            <span className="gx-pill mono">{node.label.split(" ").pop()}</span>
            <Retention n={node} />
          </p>
        </div>
      </header>
      {t.view?.artifact ? (
        <div className="gx-artifact">
          <ArtifactPreview artifact={t.view.artifact} title={t.view.title} />
        </div>
      ) : t.status === "missing" || !producer ? (
        <p className="gx-note">The thought behind this item is gone, so there is nothing to preview.</p>
      ) : (
        <div className="gx-skel">
          <Skeleton lines={4} />
        </div>
      )}
      {producer ? (
        <Section title="Made from">
          <Row id={producer.id} color={colorOf(producer)} title={producer.label} meta={thoughtMeta(producer)} onClick={() => onSelect(producer.id)} />
        </Section>
      ) : null}
    </>
  );
}

function PlainBody({ node }: { node: GraphNode }) {
  return (
    <header className="gx-head" style={{ ["--c" as string]: colorOf(node) }}>
      <span className="gx-head__badge">
        <Link2 size={18} />
      </span>
      <div className="gx-head__text">
        <h3 className="gx-head__title">{node.label}</h3>
        <p className="gx-head__sub">
          <span className="gx-pill">{KIND_LABEL[node.kind]}</span>
          <span className="gx-pill tnum">{formatDayTime(node.createdAt)}</span>
        </p>
      </div>
    </header>
  );
}

function Body({ node, onSelect }: { node: GraphNode; onSelect: (id: string) => void }) {
  switch (node.kind) {
    case "thought":
    case "decision":
      return <ThoughtBody node={node} onSelect={onSelect} />;
    case "entity":
      return <EntityBody node={node} onSelect={onSelect} />;
    case "session":
      return <SessionBody node={node} onSelect={onSelect} />;
    case "artifact":
      return <ArtifactBodyPanel node={node} onSelect={onSelect} />;
    default:
      return <PlainBody node={node} />;
  }
}

// -------------------------------------------------------------------- shell --

export const DetailPanel = memo(function DetailPanel({ nodeId, pinned, onClose, onSelect, onHold }: PanelProps) {
  const node = useGraph((s) => (nodeId ? s.nodes[nodeId] : undefined));
  const phone = useIsPhone();
  const open = Boolean(node);
  // the bottom sheet is dragged down by its grip / title bar (not its body, which scrolls)
  const drag = useDragControls();
  // whatever a row was pointing at stays pointed at only while the panel shows that node
  useEffect(() => {
    useGraphView.getState().emphasize(null);
  }, [nodeId]);

  return (
    <AnimatePresence>
      {open && node ? (
        <motion.aside
          key="panel"
          className="gx-panel glass-strong"
          data-pinned={pinned}
          aria-label={`${KIND_LABEL[node.kind]} details`}
          initial={phone ? { y: 36, opacity: 0 } : { x: 28, opacity: 0 }}
          animate={phone ? { y: 0, opacity: 1 } : { x: 0, opacity: 1 }}
          exit={phone ? { y: 36, opacity: 0, transition: { duration: 0.16 } } : { x: 28, opacity: 0, transition: { duration: 0.16 } }}
          transition={{ type: "spring", stiffness: 420, damping: 38 }}
          drag={phone ? "y" : false}
          dragControls={drag}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0.04, bottom: 0.6 }}
          dragSnapToOrigin
          onDragEnd={(_, info) => {
            if (info.offset.y > 90 || info.velocity.y > 700) onClose();
          }}
          onPointerEnter={() => onHold(true)}
          onPointerLeave={() => onHold(false)}
        >
          {phone ? <span className="gx-panel__grip" aria-hidden onPointerDown={(e) => drag.start(e)} /> : null}
          <header
            className="gx-panel__bar"
            onPointerDown={
              phone
                ? (e) => {
                    if (!(e.target as HTMLElement).closest("button")) drag.start(e);
                  }
                : undefined
            }
          >
            <span className="eyebrow">{pinned ? KIND_LABEL[node.kind] : `${KIND_LABEL[node.kind]} · preview`}</span>
            {!pinned ? <span className="gx-panel__hint">click to pin</span> : null}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details (Escape)" title="Close (Esc)">
              <X size={16} />
            </button>
          </header>
          <div className="gx-panel__body" key={node.id}>
            <Body node={node} onSelect={onSelect} />
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
});

