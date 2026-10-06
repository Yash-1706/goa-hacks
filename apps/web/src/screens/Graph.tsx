import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Layers, LocateFixed, Maximize2, Mic, RefreshCw, Type, X, ZoomIn, ZoomOut } from "lucide-react";
import { DetailPanel } from "@/components/graph/DetailPanel";
import { GraphCanvas, type GraphCanvasHandle, type Insets } from "@/components/graph/GraphCanvas";
import { Legend } from "@/components/graph/Legend";
import { Timeline, type SessionMark } from "@/components/graph/Timeline";
import { usePlayback } from "@/components/graph/usePlayback";
import { graphCache, useGraphView } from "@/components/graph/view-store";
import { useElementSize } from "@/hooks/useElementSize";
import { useIsPhone } from "@/hooks/useMedia";
import { plural } from "@/lib/format";
import { type GraphStats, linkSummary } from "@/lib/graph-model";
import { buildTimeAxis } from "@/lib/graph-time";
import { api } from "@/net/api";
import { useConnection } from "@/state/connection";
import { useGraph } from "@/state/graph";

/* ============================================================================
 * /graph: the knowledge graph. Sessions, thoughts, entities, decisions and artifacts as a living
 * constellation: entities bridge the sessions that mention them, working memory fades toward expiry, and
 * a timeline scrubber replays how memory grew. Live `graph.delta` messages land in the store even while
 * this screen is closed, so opening it is instant; this component only fetches a fresh snapshot.
 * ========================================================================== */

type Load = "loading" | "ready" | "error";

const remPx = (): number => (typeof document === "undefined" ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

export default function Graph() {
  const [stageRef, size] = useElementSize<HTMLDivElement>();
  const canvas = useRef<GraphCanvasHandle>(null);
  const phone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const focusParam = params.get("focus");

  const loaded = useGraph((s) => s.loaded);
  const nodesRec = useGraph((s) => s.nodes);
  const nodeCount = useGraph((s) => Object.keys(s.nodes).length);
  const connected = useConnection((s) => s.status === "open");

  const selectedId = useGraphView((s) => s.selectedId);
  const hoverId = useGraphView((s) => s.hoverId);
  const autoFit = useGraphView((s) => s.autoFit);
  const alwaysLabels = useGraphView((s) => s.alwaysLabels);
  const legendOpen = useGraphView((s) => s.legendOpen);
  const live = useGraphView((s) => s.live);
  const playing = useGraphView((s) => s.playing);

  const [load, setLoad] = useState<Load>(loaded ? "ready" : "loading");
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [visible, setVisible] = useState(0);
  const [missing, setMissing] = useState<string | null>(null);

  // ---- fresh state on every visit ----------------------------------------------
  useEffect(() => {
    useGraphView.getState().reset();
    return () => useGraphView.getState().reset();
  }, []);

  // ---- snapshot ------------------------------------------------------------------
  const fetchGraph = useCallback((): (() => void) => {
    const ac = new AbortController();
    const rev0 = useGraph.getState().revision;
    setLoad((l) => (useGraph.getState().loaded ? "ready" : l === "error" ? "loading" : l));
    api
      .graph(ac.signal)
      .then((res) => {
        const st = useGraph.getState();
        // a live delta landed while the request was in flight: merge instead of replacing, or it would be lost
        if (st.loaded && st.revision !== rev0) st.applyDelta({ nodes: res.nodes, edges: res.edges, removedNodes: [], removedEdges: [] });
        else st.replace(res.nodes, res.edges);
        setLoad("ready");
      })
      .catch(() => {
        if (!ac.signal.aborted) setLoad(useGraph.getState().loaded ? "ready" : "error");
      });
    return () => ac.abort();
  }, []);
  useEffect(() => fetchGraph(), [fetchGraph]);

  // deltas are lost while the socket is down: when the link comes back, take a fresh snapshot (at most every few seconds)
  useEffect(() => {
    let prev = useConnection.getState().status;
    let last = 0;
    return useConnection.subscribe((s) => {
      const back = s.status === "open" && prev !== "open";
      prev = s.status;
      if (back && Date.now() - last > 4000) {
        last = Date.now();
        fetchGraph();
      }
    });
  }, [fetchGraph]);

  // ---- time axis ---------------------------------------------------------------------
  const times = useMemo(() => Object.values(nodesRec).map((n) => n.createdAt), [nodesRec]);
  const axis = useMemo(() => buildTimeAxis(times, Date.now()), [times]);
  usePlayback(axis);
  const sessionMarks = useMemo<SessionMark[]>(
    () =>
      Object.values(nodesRec)
        .filter((n) => n.kind === "session")
        .map((n) => ({ id: n.id, createdAt: n.createdAt, label: n.label, color: graphCache.colors.get(n.id) })),
    // colours are assigned by the canvas sync that produces `stats`
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodesRec, stats],
  );

  // ---- selection (pinned) + hover preview ----------------------------------------------
  const writeUrl = useCallback(
    (id: string | null): void => {
      const cur = new URLSearchParams(window.location.search);
      if ((cur.get("focus") ?? null) === id) return;
      if (id) cur.set("focus", id);
      else cur.delete("focus");
      setParams(cur, { replace: true });
    },
    [setParams],
  );

  /** glide the camera to a node and its neighbours (retries for a few frames: it may only just have appeared) */
  const focusSoon = useCallback((id: string): void => {
    let tries = 0;
    const attempt = (): void => {
      // frame it for the layout the selection is about to have: the panel is not open yet
      if (canvas.current?.focusNode(id, { insets: insetsForRef.current(true) })) return;
      if (++tries < 45) setTimeout(attempt, 33);
    };
    attempt();
  }, []);

  /** the node whose panel was just closed: no hover preview for it until the pointer has left it */
  const suppressPeek = useRef<string | null>(null);

  const select = useCallback(
    (id: string | null): void => {
      const view = useGraphView.getState();
      if (!id) suppressPeek.current = view.hoverId;
      if (id && !graphCache.node(id)?.visible && !view.live) view.goLive(); // it is outside the time window: show everything
      view.select(id);
      writeUrl(id);
      if (id) focusSoon(id);
    },
    [focusSoon, writeUrl],
  );

  // ?focus=<nodeId>: select + centre once the node exists (it may arrive with the snapshot or a live delta)
  useEffect(() => {
    if (!focusParam || !loaded) return;
    if (useGraphView.getState().selectedId === focusParam) {
      setMissing(null);
      return;
    }
    if (!useGraph.getState().nodes[focusParam]) {
      setMissing(focusParam);
      return;
    }
    setMissing(null);
    select(focusParam);
  }, [focusParam, loaded, nodeCount, select]);

  // hover preview: appears after a short intent delay, lingers while the pointer travels to the panel
  const [peekId, setPeekId] = useState<string | null>(null);
  const holding = useRef(false);
  const peekTimer = useRef(0);
  useEffect(() => {
    if (phone) return;
    window.clearTimeout(peekTimer.current);
    if (hoverId !== suppressPeek.current) suppressPeek.current = null;
    if (hoverId && hoverId === suppressPeek.current) return;
    if (hoverId) peekTimer.current = window.setTimeout(() => setPeekId(hoverId), peekId ? 70 : 150);
    else peekTimer.current = window.setTimeout(() => !holding.current && setPeekId(null), 280);
    return () => window.clearTimeout(peekTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverId, phone]);
  const hold = useCallback((on: boolean): void => {
    holding.current = on;
    if (!on) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = window.setTimeout(() => !useGraphView.getState().hoverId && setPeekId(null), 220);
    }
  }, []);

  const panelId = selectedId ?? (phone ? null : peekId);
  const pinned = Boolean(selectedId);
  const panelNode = panelId ? nodesRec[panelId] : undefined;

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && useGraphView.getState().selectedId) select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  // ---- camera insets: what the overlays cover ------------------------------------------------
  const insetsFor = useCallback(
    (panel: boolean): Insets => {
      if (phone) return { top: 56, left: 0, right: 0, bottom: 84 + (panel ? size.height * 0.56 + 6 : 0) };
      return { top: 58, left: 0, right: panel ? Math.min(27.5 * remPx(), size.width * 0.42) + 20 : 0, bottom: 88 };
    },
    [phone, size.height, size.width],
  );
  const insets = useMemo<Insets>(() => insetsFor(Boolean(panelNode) && pinned), [insetsFor, panelNode, pinned]);
  const insetsForRef = useRef(insetsFor);
  insetsForRef.current = insetsFor;

  const onStats = useCallback(
    (s: GraphStats, v: number): void => {
      setStats(s);
      setVisible(v);
      // the selected node left the picture (scrubbed away, forgotten): close its details
      const sel = useGraphView.getState().selectedId;
      if (sel && !graphCache.node(sel)?.visible) select(null);
    },
    [select],
  );

  const empty = loaded && nodeCount === 0;
  const showCanvas = nodeCount > 0 || load === "loading" || !loaded;
  const summary = stats ? linkSummary(stats) : "";

  return (
    <div className="gx" data-panel={Boolean(panelNode && pinned)} data-empty={empty} data-live={live}>
      <div className="gx-stage" ref={stageRef} aria-hidden={empty}>
        {showCanvas ? <GraphCanvas ref={canvas} width={size.width} height={size.height} insets={insets} onSelect={select} onStats={onStats} /> : null}
      </div>
      <div className="gx-vignette" aria-hidden />

      {/* top-left: counts and how the sessions are linked */}
      {nodeCount > 0 ? (
        <div className="gx-top gx-top--left">
          <div className="gx-stats glass" role="status" aria-live={playing ? "off" : "polite"}>
            <span className={`gx-stats__live${live && connected ? " is-live" : ""}`} aria-hidden title={live ? (connected ? "Live: new memories appear as they are made" : "Offline: showing what was last received") : "Replaying the past"} />
            <span className="gx-stats__main">
              <b className="tnum">{stats?.nodes ?? visible}</b> {(stats?.nodes ?? visible) === 1 ? "node" : "nodes"} <span className="gx-stats__sep">·</span> <b className="tnum">{stats?.edges ?? 0}</b> {stats?.edges === 1 ? "edge" : "edges"}
            </span>
            {summary ? (
              <span className="gx-stats__link" title={stats ? `${plural(stats.bridgeEntities, "entity", "entities")} appear in two or more sessions${stats.crossSemantic ? `, plus ${plural(stats.crossSemantic, "semantic link")} between sessions` : ""}` : undefined}>
                <Layers size={12} aria-hidden /> {summary}
              </span>
            ) : null}
          </div>
          {missing ? (
            <button type="button" className="gx-notice" onClick={() => setMissing(null)} title="Dismiss">
              <AlertTriangle size={13} aria-hidden /> That node is not in memory (expired or forgotten)
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* top-right: camera */}
      {nodeCount > 0 ? (
        <div className="gx-top gx-top--right">
          <div className="gx-tools glass" role="toolbar" aria-label="Graph view">
            <button type="button" className="icon-btn" onClick={() => canvas.current?.zoomBy(1.35)} aria-label="Zoom in" title="Zoom in (+)">
              <ZoomIn size={16} />
            </button>
            <button type="button" className="icon-btn" onClick={() => canvas.current?.zoomBy(1 / 1.35)} aria-label="Zoom out" title="Zoom out (-)">
              <ZoomOut size={16} />
            </button>
            <button type="button" className="icon-btn" aria-pressed={autoFit} onClick={() => canvas.current?.fit()} aria-label={autoFit ? "Fit to screen (following the graph)" : "Fit to screen"} title={autoFit ? "Following the graph as it grows" : "Fit everything (F)"}>
              {autoFit ? <LocateFixed size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" className="icon-btn" aria-pressed={alwaysLabels} onClick={() => useGraphView.getState().toggleLabels()} aria-label="Show all labels" title="Always show labels">
              <Type size={16} />
            </button>
            {phone ? (
              <button type="button" className="icon-btn" aria-pressed={legendOpen} onClick={() => useGraphView.getState().toggleLegend()} aria-label="Legend" title="Legend">
                <Layers size={16} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* legend: a card on the left (desktop) / a sheet from the toolbar (phone) */}
      {nodeCount > 0 ? <Legend stats={stats} onSelect={(id) => select(id)} /> : null}

      <DetailPanel nodeId={panelId} pinned={pinned} onClose={() => {
          if (pinned) select(null);
          else {
            suppressPeek.current = useGraphView.getState().hoverId;
            setPeekId(null);
          }
        }} onSelect={(id) => select(id)} onHold={hold} />

      {nodeCount > 0 ? <Timeline axis={axis} times={times} sessions={sessionMarks} visible={visible} total={nodeCount} /> : null}

      {empty ? <EmptyState /> : null}
      {!empty && nodeCount === 0 && load === "loading" ? <Loading /> : null}
      {!empty && nodeCount === 0 && load === "error" ? <LoadFailed onRetry={() => fetchGraph()} /> : null}

      <p className="sr-only" aria-live="polite">
        {panelNode && pinned ? `${panelNode.kind}: ${panelNode.label}` : ""}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- states --

/** A faint constellation that "wakes up" when the first thought arrives. */
function EmptyState() {
  return (
    <div className="gx-empty" role="status">
      <svg className="gx-empty__art" viewBox="0 0 320 200" aria-hidden>
        <defs>
          <linearGradient id="gx-eg" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        <g className="gx-empty__lines" stroke="url(#gx-eg)" strokeWidth="1" fill="none" strokeLinecap="round">
          <path d="M60 120 L112 70 L170 96 L226 52 M170 96 L206 150 L262 128 M112 70 L96 30 M60 120 L96 168 L206 150" />
        </g>
        {[
          [60, 120, 5],
          [112, 70, 7],
          [170, 96, 9],
          [226, 52, 5],
          [206, 150, 6],
          [262, 128, 4],
          [96, 30, 4],
          [96, 168, 5],
        ].map(([x, y, r], i) => (
          <g key={i} className="gx-empty__dot" style={{ animationDelay: `${i * 0.35}s` }}>
            <circle cx={x} cy={y} r={(r as number) * 2.6} fill="url(#gx-eg)" opacity="0.12" />
            <circle cx={x} cy={y} r={r} fill="url(#gx-eg)" />
          </g>
        ))}
        <circle cx="170" cy="96" r="22" fill="none" stroke="url(#gx-eg)" strokeWidth="1.6" strokeDasharray="5 4" opacity="0.8" className="gx-empty__ring" />
      </svg>
      <h2 className="gx-empty__title">Your memory graph is empty</h2>
      <p className="gx-empty__text">
        Think out loud and it grows here: each session becomes a ring, each thought a dot, and the people, components and ideas you mention link them together.
      </p>
      <p className="gx-empty__hint">
        <Mic size={14} aria-hidden /> Try saying <q>Null pointer in cart-service, tell Sarah</q>
      </p>
      <div className="gx-empty__actions">
        <Link to="/" className="btn btn-primary">
          Open the Desk
        </Link>
        <Link to="/pocket" className="btn">
          Open Pocket
        </Link>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="gx-empty" role="status" aria-label="Loading the knowledge graph">
      <span className="gx-loader" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <p className="gx-empty__text">Reading your memory…</p>
    </div>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="gx-empty" role="alert">
      <AlertTriangle size={28} aria-hidden />
      <h2 className="gx-empty__title">Could not load the graph</h2>
      <p className="gx-empty__text">The Synapse server did not answer. Your memory is safe; this view just cannot reach it right now.</p>
      <div className="gx-empty__actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden /> Try again
        </button>
      </div>
    </div>
  );
}
