import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { VLink, VNode } from "@/lib/graph-cache";
import { type AspectGravity, type DriftForce, aspectGravity, bridgeForce, collideForce, driftForce, sessionGravity } from "@/lib/graph-forces";
import { chargeFor, linkDistanceFor, linkStrengthFor } from "@/lib/graph-layout";
import { type GraphStats, computeStats } from "@/lib/graph-model";
import { type Quality, qualityFor } from "@/lib/graph-style";
import { useMedia, useReducedMotion } from "@/hooks/useMedia";
import { useGraph } from "@/state/graph";
import { GraphRenderer, type RenderView } from "./render";
import { graphCache, useGraphView } from "./view-store";

/* ============================================================================
 * The force-directed canvas. It owns the engine (react-force-graph-2d), the stable object cache wiring
 * (store → GraphCache → graphData), the custom forces, the camera (fit / focus / follow) and the
 * pointer + keyboard interaction. Everything painted comes from ./render.
 *
 * Rules that keep it fast and keep the layout alive:
 *  - node / link OBJECTS are cached; only their membership in graphData changes (see lib/graph-cache)
 *  - every callback handed to react-force-graph has a stable identity (react-kapsule re-applies a prop
 *    whenever its identity changes, and re-applying `linkDirectionalParticles` resets the particles)
 *  - hover / selection / filters live in a mutable view object read by the painter, not in React props
 * ========================================================================== */

type FG = ForceGraphMethods<NodeObject<VNode>, LinkObject<VNode, VLink>>;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface GraphCanvasHandle {
  /** fit everything into the visible area and keep following the graph as it grows */
  fit: (ms?: number) => void;
  /**
   * Frame a node together with its one-hop neighbourhood; false when it is not on screen. `insets` are the
   * overlays that will be there once the selection is shown (the detail panel is not open yet at this point).
   */
  focusNode: (id: string, opts?: { ms?: number; insets?: Insets }) => boolean;
  zoomBy: (factor: number) => void;
}

interface Props {
  width: number;
  height: number;
  /** parts of the canvas covered by overlays (detail panel, timeline): the camera frames the rest */
  insets: Insets;
  onSelect: (id: string | null) => void;
  onStats: (stats: GraphStats, visible: number) => void;
}

interface Chain<T> {
  strength: (fn: (d: T) => number) => unknown;
  distance?: (fn: (d: T) => number) => unknown;
  distanceMax?: (d: number) => unknown;
  theta?: (t: number) => unknown;
}

const replaceMode = (): string => "replace";
const noLabel = (): string => "";
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

function sameQuality(a: Quality, b: Quality): boolean {
  return a.level === b.level && a.particles === b.particles && a.drift === b.drift && a.halos === b.halos;
}

function configureForces(fg: FG, drift: DriftForce, gravity: AspectGravity): void {
  const charge = fg.d3Force("charge") as unknown as Chain<VNode> | undefined;
  if (charge) {
    charge.strength((n) => chargeFor(n.kind));
    charge.distanceMax?.(420);
    charge.theta?.(0.92);
  }
  const link = fg.d3Force("link") as unknown as Chain<VLink> | undefined;
  if (link) {
    link.distance?.((l) => linkDistanceFor(l.type));
    link.strength((l) => linkStrengthFor(l.type, l.weight));
  }
  fg.d3Force("session", sessionGravity());
  fg.d3Force("bridge", bridgeForce());
  fg.d3Force("collide", collideForce());
  fg.d3Force("aspect", gravity);
  fg.d3Force("drift", drift);
}

/** "now" for the TTL fade: the real clock when live, the scrubbed time when replaying the past. */
function wallClock(): number {
  const s = useGraphView.getState();
  return s.live ? Date.now() : Math.min(s.t, Date.now());
}

const GraphCanvasImpl = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas({ width, height, insets, onSelect, onStats }, ref) {
  const reduced = useReducedMotion();
  const coarse = useMedia("(pointer: coarse)");
  const motion = !reduced;

  const cache = graphCache;
  const fgRef = useRef<FG | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);

  // latest props / flags, readable from stable callbacks
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const coarseRef = useRef(coarse);
  coarseRef.current = coarse;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const [quality, setQuality] = useState<Quality>(() => qualityFor(0, { reduced, coarse }));
  const qualityRef = useRef(quality);
  const degrade = useRef(0);

  const driftRef = useRef<DriftForce | null>(null);
  if (!driftRef.current) driftRef.current = driftForce(0.05);
  const gravityRef = useRef<AspectGravity | null>(null);
  if (!gravityRef.current) gravityRef.current = aspectGravity();
  /** the camera is where the last selection put it (so deselecting can glide back to the overview) */
  const focusedByUs = useRef(false);
  const prevSelected = useRef<string | null>(null);

  // ---- renderer (once) ---------------------------------------------------
  const rendererRef = useRef<GraphRenderer | null>(null);
  if (!rendererRef.current) {
    const view: RenderView = {
      selectedId: null,
      hoverId: null,
      emphasisId: null,
      hoverLink: null,
      focus: null,
      hiddenEdgeTypes: new Set(),
      categories: new Set(),
      alwaysLabels: false,
      motion,
      quality,
      wall: wallClock,
    };
    rendererRef.current = new GraphRenderer(cache, view);
  }
  const renderer = rendererRef.current;
  renderer.view.motion = motion;

  const [graphData, setGraphData] = useState<{ nodes: VNode[]; links: VLink[] }>({ nodes: [], links: [] });
  const warm = useRef(true);
  const firstSync = useRef(true);
  const intro = useRef(false);
  const rafRef = useRef(0);
  const schedTimer = useRef(0);
  const ghostTimer = useRef(0);
  const fitTimer = useRef(0);
  const hoverTimer = useRef(0);
  const syncRef = useRef<() => void>(() => undefined);

  // ---- camera ------------------------------------------------------------
  /** centre of the area the overlays leave free, in canvas pixels */
  const visibleCenter = useCallback((over?: Insets): { x: number; y: number } => {
    const { width: w, height: h } = sizeRef.current;
    const i = over ?? insetsRef.current;
    return { x: (i.left + (w - i.right)) / 2, y: (i.top + (h - i.bottom)) / 2 };
  }, []);

  const repaint = useCallback((): void => {
    // with autoPauseRedraw (reduced motion) the canvas only redraws on a view change: nudge it
    if (motionRef.current) return;
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom());
  }, []);

  const fit = useCallback((ms: number): void => {
    const fg = fgRef.current;
    if (!fg || cache.visibleNodes().length === 0) return;
    const bbox = fg.getGraphBbox();
    if (!bbox) return;
    const { width: w, height: h } = sizeRef.current;
    const i = insetsRef.current;
    const pad = w < 560 ? 26 : 56;
    const bw = Math.max(40, bbox.x[1] - bbox.x[0]);
    const bh = Math.max(40, bbox.y[1] - bbox.y[0]);
    const k = clamp(Math.min(Math.max(120, w - i.left - i.right - pad * 2) / bw, Math.max(120, h - i.top - i.bottom - pad * 2) / bh), 0.12, 1.7);
    const vc = visibleCenter();
    const cx = (bbox.x[0] + bbox.x[1]) / 2 - (vc.x - w / 2) / k;
    const cy = (bbox.y[0] + bbox.y[1]) / 2 - (vc.y - h / 2) / k;
    fg.centerAt(cx, cy, ms);
    fg.zoom(k, ms);
  }, [cache, visibleCenter]);

  /**
   * Fit soon after the layout changed, unless the user took the camera. Throttled: while a fit is pending
   * further requests are absorbed, so a replay (a change every few frames) re-frames about twice a second.
   */
  const requestFit = useCallback(
    (delay: number, ms: number, followUp?: { delay: number; ms: number }): void => {
      if (fitTimer.current) return;
      fitTimer.current = window.setTimeout(() => {
        fitTimer.current = 0;
        const v = useGraphView.getState();
        if (v.autoFit && !v.selectedId) fit(motionRef.current ? ms : 0);
        if (followUp) requestFit(followUp.delay, followUp.ms);
      }, delay);
    },
    [fit],
  );

  /** Frame a node together with its one-hop neighbourhood, so the relationships around it are readable. */
  const focusNode = useCallback(
    (id: string, opts: { ms?: number; insets?: Insets } = {}): boolean => {
      const fg = fgRef.current;
      const vn = cache.node(id);
      if (!fg || !vn || !vn.visible || vn.x === undefined || vn.y === undefined) return false;
      let x0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const nid of cache.neighborhood(id).nodes) {
        const n = cache.node(nid);
        if (!n || !n.visible || n.x === undefined || n.y === undefined) continue;
        const r = n.r + 10;
        x0 = Math.min(x0, n.x - r);
        x1 = Math.max(x1, n.x + r);
        y0 = Math.min(y0, n.y - r);
        y1 = Math.max(y1, n.y + r);
      }
      const { width: w, height: h } = sizeRef.current;
      const i = opts.insets ?? insetsRef.current;
      const pad = w < 560 ? 34 : 84;
      const k = clamp(Math.min(Math.max(120, w - i.left - i.right - pad * 2) / Math.max(60, x1 - x0), Math.max(120, h - i.top - i.bottom - pad * 2) / Math.max(60, y1 - y0)), 0.4, 2.6);
      const vc = visibleCenter(opts.insets);
      const ms = motionRef.current ? (opts.ms ?? 750) : 0;
      fg.centerAt((x0 + x1) / 2 - (vc.x - w / 2) / k, (y0 + y1) / 2 - (vc.y - h / 2) / k, ms);
      fg.zoom(k, ms);
      focusedByUs.current = true;
      useGraphView.getState().setAutoFit(false);
      return true;
    },
    [cache, visibleCenter],
  );

  useImperativeHandle(
    ref,
    () => ({
      fit: (ms = 650) => {
        focusedByUs.current = false;
        useGraphView.getState().setAutoFit(true);
        fit(motionRef.current ? ms : 0);
      },
      focusNode,
      zoomBy: (factor: number) => {
        const fg = fgRef.current;
        if (!fg) return;
        useGraphView.getState().setAutoFit(false);
        fg.zoom(clamp(fg.zoom() * factor, 0.12, 8), motionRef.current ? 260 : 0);
      },
    }),
    [fit, focusNode],
  );

  // ---- focus (selection / hover dimming) -----------------------------------
  const recomputeFocus = useCallback((): void => {
    const v = renderer.view;
    const id = v.selectedId ?? v.hoverId;
    const vn = id ? cache.node(id) : undefined;
    if (!id || !vn || !vn.visible) {
      v.focus = null;
    } else {
      const h = cache.neighborhood(id);
      v.focus = { id, strength: v.selectedId ? "selected" : "hover", nodes: h.nodes, links: h.links };
    }
  }, [cache, renderer]);

  // ---- store → cache → engine ------------------------------------------------
  syncRef.current = (): void => {
    const g = useGraph.getState();
    const v = useGraphView.getState();
    const perf = performance.now();
    const res = cache.sync({ nodes: g.nodes, edges: g.edges, t: v.live ? Number.POSITIVE_INFINITY : v.t, perf, animate: motionRef.current, intro: intro.current });
    if (res.changed || firstSync.current) {
      firstSync.current = false;
      if (res.nodes.length) intro.current = false;
      const q = qualityFor(res.nodes.length, { reduced: !motionRef.current, coarse: coarseRef.current, degrade: degrade.current });
      if (!sameQuality(q, qualityRef.current)) {
        qualityRef.current = q;
        renderer.view.quality = q;
        setQuality(q);
      }
      setGraphData({ nodes: res.nodes, links: res.links });
      onStatsRef.current(
        computeStats(
          res.nodes.map((n) => n.data),
          res.links.map((l) => l.data),
        ),
        res.nodes.length,
      );
      driftRef.current?.quiet(150);
      if (res.nodes.length) {
        // first data: frame it at once (it was pre-warmed), then again once the layout has settled
        if (warm.current) requestFit(160, 0, { delay: 1700, ms: 800 });
        else requestFit(v.playing ? 700 : 1500, 750);
      }
    }
    if (res.nextGhostEnd !== null) {
      window.clearTimeout(ghostTimer.current);
      ghostTimer.current = window.setTimeout(schedule, Math.max(30, res.nextGhostEnd - performance.now() + 40));
    }
    recomputeFocus();
  };

  const schedule = useCallback((): void => {
    if (rafRef.current || schedTimer.current) return;
    const run = (): void => {
      cancelAnimationFrame(rafRef.current);
      window.clearTimeout(schedTimer.current);
      rafRef.current = 0;
      schedTimer.current = 0;
      syncRef.current();
    };
    rafRef.current = requestAnimationFrame(run);
    // a hidden tab runs no animation frames: the timer keeps the data in step, so the graph is current when it is shown again
    schedTimer.current = window.setTimeout(run, 150);
  }, []);

  useEffect(() => {
    // reopened with a laid-out graph: replay the bloom in place; first ever open: bloom while it lays out
    if (cache.size > 0) {
      cache.rewind(performance.now(), motionRef.current);
      warm.current = false;
      intro.current = false;
    } else intro.current = true;
    firstSync.current = true;
    schedule();
    const un1 = useGraph.subscribe((s, p) => {
      if (s.revision !== p.revision) schedule();
    });
    const un2 = useGraphView.subscribe((s, p) => {
      if (s.live !== p.live || s.t !== p.t) schedule();
    });
    return () => {
      un1();
      un2();
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      window.clearTimeout(schedTimer.current);
      schedTimer.current = 0;
      window.clearTimeout(ghostTimer.current);
      window.clearTimeout(fitTimer.current);
      window.clearTimeout(hoverTimer.current);
      fitTimer.current = 0;
    };
  }, [cache, schedule]);

  // dev-only handle for poking the graph from the console / browser tests (like window.__synapse)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const dev = window as unknown as { __graph?: unknown };
    dev.__graph = {
      cache,
      renderer,
      view: useGraphView,
      store: useGraph,
      gravity: gravityRef.current,
      drift: driftRef.current,
      fg: () => fgRef.current,
      /** screen position (page CSS px) of a node by id or label substring */
      where: (q: string) => {
        const fg = fgRef.current;
        const el = wrapRef.current;
        const vn = cache.node(q) ?? cache.visibleNodes().find((n) => n.label.toLowerCase().includes(q.toLowerCase()));
        if (!fg || !el || !vn || vn.x === undefined || vn.y === undefined) return null;
        const p = fg.graph2ScreenCoords(vn.x, vn.y);
        const r = el.getBoundingClientRect();
        return { id: vn.id, kind: vn.kind, label: vn.label, x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) };
      },
    };
    return () => {
      delete dev.__graph;
    };
  }, [cache, renderer]);

  // after the first data has been handed over, stop warming up (live updates must not block the main thread)
  useEffect(() => {
    if (graphData.nodes.length > 0) warm.current = false;
  }, [graphData]);

  // ---- engine configuration ---------------------------------------------------
  const sized = width > 0 && height > 0;
  useEffect(() => {
    const fg = fgRef.current;
    if (fg && driftRef.current && gravityRef.current) configureForces(fg, driftRef.current, gravityRef.current);
  }, [sized]);

  // the layout takes the shape of the stage: wide on a projector, tall on a phone
  useEffect(() => {
    // the shape of the area the graph is framed in: the stage minus the HUD bars and the fit padding
    const pad = width < 560 ? 26 : 56;
    gravityRef.current?.setAspect((width - pad * 2) / Math.max(160, height - 146 - pad * 2));
  }, [width, height]);

  useEffect(() => {
    if (driftRef.current) driftRef.current.enabled = quality.drift && motion;
  }, [quality.drift, motion]);

  // the canvas appeared or was resized: re-frame (when the camera is still following)
  useEffect(() => {
    if (sized && cache.visibleNodes().length) requestFit(120, 0);
  }, [sized, width, height, cache, requestFit]);

  useEffect(() => {
    renderer.onSlow = () => {
      if (degrade.current >= 2) return;
      degrade.current++;
      const q = qualityFor(cache.visibleNodes().length, { reduced: !motionRef.current, coarse: coarseRef.current, degrade: degrade.current });
      qualityRef.current = q;
      renderer.view.quality = q;
      setQuality(q);
    };
    return () => {
      renderer.onSlow = null;
    };
  }, [cache, renderer]);

  // ---- view state → painter ----------------------------------------------------
  const selectedId = useGraphView((s) => s.selectedId);
  const hiddenEdgeTypes = useGraphView((s) => s.hiddenEdgeTypes);
  const categories = useGraphView((s) => s.categories);
  const alwaysLabels = useGraphView((s) => s.alwaysLabels);
  useEffect(() => {
    renderer.view.selectedId = selectedId;
    recomputeFocus();
    repaint();
    if (prevSelected.current && !selectedId && focusedByUs.current) {
      // closing the details glides the camera back to the overview (unless the user moved it themselves)
      focusedByUs.current = false;
      useGraphView.getState().setAutoFit(true);
      fit(motionRef.current ? 700 : 0);
    }
    prevSelected.current = selectedId;
  }, [selectedId, renderer, recomputeFocus, repaint, fit]);
  useEffect(() => {
    renderer.view.hiddenEdgeTypes = hiddenEdgeTypes;
    renderer.view.categories = categories;
    renderer.view.alwaysLabels = alwaysLabels;
    repaint();
  }, [hiddenEdgeTypes, categories, alwaysLabels, renderer, repaint]);
  useEffect(() => {
    renderer.view.quality = quality;
    repaint();
  }, [quality, renderer, repaint]);

  // a row in the detail panel points at a node: ring it on the canvas
  useEffect(
    () =>
      useGraphView.subscribe((s, p) => {
        if (s.emphasisId === p.emphasisId) return;
        renderer.view.emphasisId = s.emphasisId;
        repaint();
      }),
    [renderer, repaint],
  );

  // ---- the user takes the camera (wheel, drag, pinch): stop auto-following ----------------------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let down: { x: number; y: number } | null = null;
    const manual = (): void => {
      focusedByUs.current = false;
      useGraphView.getState().setAutoFit(false);
    };
    const onDown = (e: PointerEvent): void => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent): void => {
      if (down && e.buttons && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
        down = null;
        manual();
      }
    };
    const onUp = (): void => {
      down = null;
    };
    el.addEventListener("pointerdown", onDown, { passive: true });
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    el.addEventListener("pointercancel", onUp, { passive: true });
    el.addEventListener("wheel", manual, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", manual);
    };
  }, []);

  // ---- pointer ----------------------------------------------------------------------
  const onNodeClick = useCallback((node: object): void => {
    const vn = node as VNode;
    if (vn.dying !== null) return;
    onSelectRef.current(vn.id);
  }, []);
  const onBackgroundClick = useCallback((): void => onSelectRef.current(null), []);
  const onNodeHover = useCallback(
    (node: object | null): void => {
      // a finger has no hover: the engine would leave the last tapped node "hovered" and dimmed
      if (coarseRef.current) return;
      const vn = node as VNode | null;
      const id = vn && vn.dying === null ? vn.id : null;
      renderer.view.hoverId = id;
      // the ring and label answer at once; the whole-graph dimming waits a beat so sweeping the pointer across the graph does not flicker it
      window.clearTimeout(hoverTimer.current);
      if (id) hoverTimer.current = window.setTimeout(recomputeFocus, 110);
      else recomputeFocus();
      useGraphView.getState().hover(id);
      repaint();
    },
    [renderer, recomputeFocus, repaint],
  );
  const onLinkHover = useCallback(
    (link: object | null): void => {
      const l = link as VLink | null;
      renderer.view.hoverLink = l && l.semantic ? l : null;
      repaint();
    },
    [renderer, repaint],
  );
  const onEngineStop = useCallback((): void => {
    // only reached when the engine really cools down (reduced motion / big graphs)
    const v = useGraphView.getState();
    if (v.autoFit && !v.selectedId) fit(0);
  }, [fit]);

  // ---- keyboard: ← → walk through the nodes in the order they were created ----------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const sel = useGraphView.getState().selectedId;
      const step = (dir: 1 | -1): void => {
        const list = cache
          .visibleNodes()
          .filter((n) => n.dying === null)
          .sort((a, b) => a.data.createdAt - b.data.createdAt);
        if (!list.length) return;
        const cur = list.findIndex((n) => n.id === sel);
        const next = list[(cur + dir + list.length) % list.length] as VNode;
        onSelectRef.current(next.id);
      };
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          step(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          step(-1);
          break;
        case "Escape":
          if (!sel) return;
          onSelectRef.current(null);
          break;
        case "f":
        case "F":
          useGraphView.getState().setAutoFit(true);
          fit(motionRef.current ? 650 : 0);
          break;
        case "+":
        case "=":
          fgRef.current?.zoom(clamp((fgRef.current?.zoom() ?? 1) * 1.3, 0.12, 8), 220);
          break;
        case "-":
        case "_":
          fgRef.current?.zoom(clamp((fgRef.current?.zoom() ?? 1) / 1.3, 0.12, 8), 220);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [cache, fit],
  );

  const particlesOn = quality.particles && motion;

  return (
    <div ref={wrapRef} className="gx-canvas" tabIndex={0} role="application" aria-label="Knowledge graph. Arrow keys move between nodes, Escape closes the details, F fits the view, plus and minus zoom." onKeyDown={onKeyDown}>
      {sized ? (
        <ForceGraph2D<VNode, VLink>
          ref={fgRef}
          width={width}
          height={height}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeVal={renderer.nodeVal}
          nodeLabel={noLabel}
          nodeCanvasObjectMode={replaceMode}
          nodeCanvasObject={renderer.paintNode}
          nodePointerAreaPaint={renderer.paintPointer}
          linkLabel={noLabel}
          linkPointerAreaPaint={renderer.paintLinkPointer}
          linkVisibility={renderer.linkVisible}
          linkColor={renderer.linkColor}
          linkWidth={renderer.linkWidth}
          linkLineDash={renderer.linkDash}
          linkCurvature={renderer.linkCurvature}
          linkCanvasObjectMode={renderer.linkMode}
          linkCanvasObject={renderer.paintLink}
          linkDirectionalParticles={particlesOn ? renderer.particles : 0}
          linkDirectionalParticleSpeed={renderer.particleSpeed}
          linkDirectionalParticleWidth={3}
          linkDirectionalParticleCanvasObject={renderer.paintParticle}
          onRenderFramePre={renderer.beginFrame}
          onRenderFramePost={renderer.endFrame}
          autoPauseRedraw={!motion}
          d3AlphaDecay={0.03}
          d3VelocityDecay={0.4}
          warmupTicks={warm.current ? 60 : 0}
          cooldownTicks={Number.POSITIVE_INFINITY}
          cooldownTime={quality.drift && motion ? Number.POSITIVE_INFINITY : 9000}
          minZoom={0.12}
          maxZoom={8}
          enableNodeDrag
          onNodeClick={onNodeClick}
          onNodeHover={onNodeHover}
          onLinkHover={onLinkHover}
          onBackgroundClick={onBackgroundClick}
          onEngineStop={onEngineStop}
        />
      ) : null}
    </div>
  );
});

export const GraphCanvas = memo(GraphCanvasImpl);
