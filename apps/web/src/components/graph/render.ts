import type { ArtifactKind, Category } from "@synapse/shared";
import { GHOST_MS, type GraphCache, type VLink, type VNode } from "@/lib/graph-cache";
import { EDGE_STYLE } from "@/lib/category";
import { artifactKindFromLabel } from "@/lib/graph-model";
import {
  type Quality,
  burstProgress,
  easeOutCubic,
  edgeCaption,
  edgeVisual,
  entityHalfSide,
  hexToRgb,
  isLongTerm,
  particleCount,
  popScale,
  ttlFraction,
  ttlOpacity,
  withAlpha,
} from "@/lib/graph-style";

/* ============================================================================
 * Canvas painting for the knowledge graph. All the decisions (what is solid, how big, which colour) come
 * from lib/graph-style; this file only turns them into pixels. react-force-graph calls these functions
 * once per node / link per frame, so everything here avoids allocation and caches what it can (glow
 * sprites, text widths, colour strings).
 *
 * Node shapes: sessions = glowing rings (solid = desk, dashed + rotating = pocket, with a device glyph),
 * thoughts = dots, decisions = diamonds, entities = rounded squares, artifacts = small icons drawn here.
 * ========================================================================== */

const TAU = Math.PI * 2;
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = "232,234,240";

export interface FocusSets {
  id: string;
  /** a pinned selection dims the rest hard, a hover only softly */
  strength: "selected" | "hover";
  nodes: ReadonlySet<string>;
  links: ReadonlySet<string>;
}

/** Everything the painter reads each frame. GraphCanvas mutates this object in place (no React in the hot path). */
export interface RenderView {
  selectedId: string | null;
  hoverId: string | null;
  /** pointed at from the detail panel: ringed and named, but the rest of the graph does not react */
  emphasisId: string | null;
  hoverLink: VLink | null;
  focus: FocusSets | null;
  hiddenEdgeTypes: ReadonlySet<string>;
  categories: ReadonlySet<Category>;
  alwaysLabels: boolean;
  motion: boolean;
  quality: Quality;
  /** wall clock used for the TTL fade (epoch ms): "now" when live, the scrubbed time when replaying */
  wall: () => number;
}

interface Frame {
  perf: number;
  wall: number;
  scale: number;
}

interface LabelBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Pill {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
}

interface Candidate {
  vn: VNode;
  prio: number;
  text: string;
  bold: boolean;
  alpha: number;
}

// ----------------------------------------------------------------- sprites --

const glowSprites = new Map<string, HTMLCanvasElement>();

/** Soft radial halo, pre-rendered once per colour: drawing it is one textured quad instead of a gaussian blur. */
function glowSprite(color: string): HTMLCanvasElement {
  let c = glowSprites.get(color);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = 96;
    const g = c.getContext("2d");
    if (g) {
      const [r, gg, b] = hexToRgb(color);
      const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
      grad.addColorStop(0, `rgba(${r},${gg},${b},0.9)`);
      grad.addColorStop(0.16, `rgba(${r},${gg},${b},0.5)`);
      grad.addColorStop(0.42, `rgba(${r},${gg},${b},0.16)`);
      grad.addColorStop(0.75, `rgba(${r},${gg},${b},0.04)`);
      grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 96, 96);
    }
    glowSprites.set(color, c);
  }
  return c;
}

const discSprites = new Map<string, HTMLCanvasElement>();

/** The translucent inside of a session ring (a radial fill, pre-rendered once per colour). */
function disc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, alpha: number): void {
  let c = discSprites.get(color);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
      grad.addColorStop(0, withAlpha(color, 0.34));
      grad.addColorStop(1, withAlpha(color, 0.08));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(64, 64, 62, 0, TAU);
      g.fill();
    }
    discSprites.set(color, c);
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, x - radius, y - radius, radius * 2, radius * 2);
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, alpha: number): void {
  if (alpha <= 0.01 || radius <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ------------------------------------------------------------------ glyphs --

/** Small stroked icon for an artifact, centred on (x, y), `s` = half the icon size. */
function artifactGlyph(ctx: CanvasRenderingContext2D, kind: ArtifactKind | null, x: number, y: number, s: number): void {
  ctx.lineWidth = Math.max(0.5, s * 0.34);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  switch (kind) {
    case "ticket": // checkbox with a tick
      ctx.rect(x - s, y - s, s * 2, s * 2);
      ctx.moveTo(x - s * 0.45, y);
      ctx.lineTo(x - s * 0.1, y + s * 0.4);
      ctx.lineTo(x + s * 0.5, y - s * 0.4);
      break;
    case "github_issue": // ringed dot
      ctx.arc(x, y, s, 0, TAU);
      ctx.moveTo(x + s * 0.28, y);
      ctx.arc(x, y, s * 0.28, 0, TAU);
      break;
    case "email_draft": // envelope
      ctx.rect(x - s, y - s * 0.72, s * 2, s * 1.44);
      ctx.moveTo(x - s, y - s * 0.72);
      ctx.lineTo(x, y + s * 0.14);
      ctx.lineTo(x + s, y - s * 0.72);
      break;
    case "message_draft": // speech bubble
      ctx.rect(x - s, y - s * 0.8, s * 2, s * 1.35);
      ctx.moveTo(x - s * 0.35, y + s * 0.55);
      ctx.lineTo(x - s * 0.6, y + s * 1.05);
      ctx.lineTo(x + s * 0.1, y + s * 0.55);
      break;
    case "calendar_event": // calendar page
      ctx.rect(x - s, y - s * 0.8, s * 2, s * 1.8);
      ctx.moveTo(x - s, y - s * 0.2);
      ctx.lineTo(x + s, y - s * 0.2);
      ctx.moveTo(x - s * 0.5, y - s * 1.1);
      ctx.lineTo(x - s * 0.5, y - s * 0.55);
      ctx.moveTo(x + s * 0.5, y - s * 1.1);
      ctx.lineTo(x + s * 0.5, y - s * 0.55);
      break;
    case "code_snippet": // </>
      ctx.moveTo(x - s * 0.35, y - s * 0.75);
      ctx.lineTo(x - s * 1.05, y);
      ctx.lineTo(x - s * 0.35, y + s * 0.75);
      ctx.moveTo(x + s * 0.35, y - s * 0.75);
      ctx.lineTo(x + s * 1.05, y);
      ctx.lineTo(x + s * 0.35, y + s * 0.75);
      break;
    case "code_comment": // double slash
      ctx.moveTo(x - s * 0.15, y - s * 0.8);
      ctx.lineTo(x - s * 0.75, y + s * 0.8);
      ctx.moveTo(x + s * 0.75, y - s * 0.8);
      ctx.lineTo(x + s * 0.15, y + s * 0.8);
      break;
    case "decision": // fork
      ctx.moveTo(x - s * 0.8, y + s * 0.9);
      ctx.lineTo(x - s * 0.8, y);
      ctx.lineTo(x + s * 0.8, y);
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - s * 0.95);
      ctx.moveTo(x + s * 0.8, y);
      ctx.lineTo(x + s * 0.8, y + s * 0.9);
      break;
    case "journal": // book
      ctx.rect(x - s * 0.85, y - s, s * 1.7, s * 2);
      ctx.moveTo(x - s * 0.35, y - s);
      ctx.lineTo(x - s * 0.35, y + s);
      break;
    case "recall": // magnifier
      ctx.arc(x - s * 0.18, y - s * 0.18, s * 0.72, 0, TAU);
      ctx.moveTo(x + s * 0.36, y + s * 0.36);
      ctx.lineTo(x + s * 0.95, y + s * 0.95);
      break;
    case "note": // page with lines
      ctx.rect(x - s * 0.8, y - s, s * 1.6, s * 2);
      ctx.moveTo(x - s * 0.4, y - s * 0.35);
      ctx.lineTo(x + s * 0.4, y - s * 0.35);
      ctx.moveTo(x - s * 0.4, y + s * 0.25);
      ctx.lineTo(x + s * 0.4, y + s * 0.25);
      break;
    default:
      ctx.arc(x, y, s * 0.55, 0, TAU);
  }
  ctx.stroke();
}

function deviceGlyph(ctx: CanvasRenderingContext2D, pocket: boolean, x: number, y: number, s: number): void {
  ctx.lineWidth = Math.max(0.6, s * 0.17);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pocket) {
    roundedRect(ctx, x - s * 0.42, y - s * 0.78, s * 0.84, s * 1.56, s * 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - s * 0.12, y + s * 0.52);
    ctx.lineTo(x + s * 0.12, y + s * 0.52);
    ctx.stroke();
  } else {
    roundedRect(ctx, x - s * 0.78, y - s * 0.62, s * 1.56, s * 1.0, s * 0.14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.38);
    ctx.lineTo(x, y + s * 0.66);
    ctx.moveTo(x - s * 0.36, y + s * 0.68);
    ctx.lineTo(x + s * 0.36, y + s * 0.68);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- renderer --

const DASH_CACHE = new Map<string, number[]>();
function scaledDash(dash: readonly number[], scale: number): number[] | null {
  if (!dash.length) return null;
  const k = Math.round((1.15 / Math.max(0.05, scale)) * 8) / 8;
  const key = `${dash.join(",")}|${k}`;
  let d = DASH_CACHE.get(key);
  if (!d) {
    d = dash.map((v) => v * k);
    DASH_CACHE.set(key, d);
  }
  return d;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export class GraphRenderer {
  readonly view: RenderView;
  /** called when frames are consistently slow, so the owner can lower the quality tier */
  onSlow: (() => void) | null = null;

  private frame: Frame = { perf: 0, wall: 0, scale: 1 };
  private readonly widths = new Map<string, number>();
  private frameStart = 0;
  private lastFrameAt = 0;
  /** canvas text follows the page's root font size (bigger on a projector, in large-type mode) */
  private textScale = 1;
  private textScaleAt = -1e9;
  /** smoothed time spent recording one frame (ms) and smoothed gap between frames (ms) */
  private avgMs = 0;
  private avgGap = 0;
  private slowFrames = 0;
  private readonly artifactKinds = new Map<string, ArtifactKind | null>();
  private readonly dpr: () => number;

  constructor(
    private readonly cache: GraphCache,
    view: RenderView,
    dpr: () => number = () => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
  ) {
    this.view = view;
    this.dpr = dpr;
  }

  // ------------------------------------------------------------ accessors --

  nodeVal = (n: object): number => {
    const r = (n as VNode).r || 5;
    return (r / 4) ** 2;
  };

  linkVisible = (l: object): boolean => {
    const link = l as VLink;
    return !this.view.hiddenEdgeTypes.has(link.type) && this.frame.perf >= link.born - 1;
  };

  linkCurvature = (l: object): number => (l as VLink).curv;

  /** semantic links get a custom painter (dash scaled to zoom, glow); structural ones use the engine's batched strokes */
  linkMode = (l: object): string => ((l as VLink).semantic ? "replace" : "none");

  linkColor = (l: object): string => {
    const link = l as VLink;
    const a = this.linkAlpha(link);
    switch (link.type) {
      case "in_session":
        return withAlpha(link.target.kind === "session" ? link.target.color : link.source.color, 0.26 * a);
      case "produced":
        return withAlpha("#34d399", 0.45 * a);
      case "related":
        return withAlpha("#94a3b8", 0.3 * a);
      case "mentions":
        return withAlpha("#94a3b8", 0.36 * a);
      default:
        return withAlpha("#94a3b8", 0.3 * a);
    }
  };

  linkWidth = (l: object): number => {
    const link = l as VLink;
    const f = this.view.focus;
    const on = f ? f.links.has(link.id) : false;
    const base = link.type === "produced" ? 1.1 : 0.95;
    return on ? base * 1.7 : base;
  };

  linkDash = (l: object): number[] | null => {
    const link = l as VLink;
    return link.type === "related" ? scaledDash(edgeVisual("related").dash, this.frame.scale) : null;
  };

  /** particles flow along semantic links (off under reduced motion and on big graphs) */
  particles = (l: object): number => {
    const link = l as VLink;
    return this.view.quality.particles && this.view.motion ? particleCount(link.type, link.weight) : 0;
  };

  particleSpeed = (l: object): number => 0.0028 + 0.0034 * clamp01((l as VLink).weight);

  // ------------------------------------------------------------- dimming --

  private linkAlpha(l: VLink): number {
    const f = this.view.focus;
    let a = 1;
    if (f) a = f.links.has(l.id) ? 1.35 : f.strength === "selected" ? 0.14 : 0.45;
    const cats = this.view.categories;
    if (cats.size && (this.catDim(l.source) < 1 || this.catDim(l.target) < 1)) a = Math.min(a, 0.2);
    if (l.dying !== null) a *= 1 - clamp01((this.frame.perf - l.dying) / GHOST_MS);
    if (Number.isFinite(l.born)) a *= clamp01((this.frame.perf - l.born) / 700);
    return a;
  }

  private catDim(n: VNode): number {
    const cats = this.view.categories;
    if (!cats.size) return 1;
    if (n.kind === "thought" || n.kind === "decision") return n.data.category && cats.has(n.data.category) ? 1 : 0.14;
    if (n.kind === "artifact") return n.tint && cats.has(n.tint) ? 1 : 0.14;
    return 1;
  }

  private nodeDim(n: VNode): number {
    const f = this.view.focus;
    let d = 1;
    if (f && !f.nodes.has(n.id)) d = f.strength === "selected" ? 0.12 : 0.38;
    return Math.min(d, this.catDim(n));
  }

  // --------------------------------------------------------- frame passes --

  /** onRenderFramePre: stamp the frame, then paint the session "territories" behind everything. */
  beginFrame = (ctx: CanvasRenderingContext2D, scale: number): void => {
    this.frameStart = performance.now();
    if (this.frameStart - this.textScaleAt > 1500) {
      this.textScaleAt = this.frameStart;
      this.textScale = this.readTextScale();
    }
    // the gap between frames is what the viewer feels (it includes rasterising, which recording time does not)
    const gap = this.lastFrameAt ? this.frameStart - this.lastFrameAt : 0;
    this.lastFrameAt = this.frameStart;
    // (with autoPauseRedraw, i.e. reduced motion, frames are drawn on demand and the gaps mean nothing)
    if (this.view.motion && gap > 0 && gap < 250) this.avgGap = this.avgGap === 0 ? gap : this.avgGap * 0.94 + gap * 0.06;
    this.frame = { perf: this.frameStart, wall: this.view.wall(), scale };
    this.paintTerritories(ctx);
  };

  /** onRenderFramePost: selection halo, labels, relationship pills; also the slow-frame watchdog. */
  endFrame = (ctx: CanvasRenderingContext2D, scale: number): void => {
    ctx.save();
    this.paintFocusRings(ctx, scale);
    this.paintLabels(ctx, scale);
    ctx.restore();
    const ms = performance.now() - this.frameStart;
    this.avgMs = this.avgMs === 0 ? ms : this.avgMs * 0.92 + ms * 0.08;
    // sustained slowness (recording over 14 ms, or under ~40 fps): drop to the next cheaper tier
    if (this.avgMs > 14 || this.avgGap > 25) {
      if (++this.slowFrames > 100) {
        this.slowFrames = 0;
        this.avgMs = 0;
        this.avgGap = 0;
        this.onSlow?.();
      }
    } else this.slowFrames = Math.max(0, this.slowFrames - 2);
  };

  /** Soft coloured regions around each session's members. Additive, so where sessions overlap the blend glows: that is where entities bridge. */
  private paintTerritories(ctx: CanvasRenderingContext2D): void {
    const nodes = this.cache.visibleNodes();
    if (nodes.length === 0) return;
    const reach = new Map<string, number>();
    const sessions: VNode[] = [];
    for (const n of nodes) {
      if (n.kind === "session") {
        sessions.push(n);
        reach.set(n.id, 0);
      }
    }
    if (!sessions.length) return;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const n of nodes) {
      if (n.kind !== "thought" && n.kind !== "decision" && n.kind !== "artifact") continue;
      const s = n.sessionId ? byId.get(n.sessionId) : undefined;
      if (!s || n.x === undefined || s.x === undefined || n.y === undefined || s.y === undefined) continue;
      const d = Math.hypot(n.x - s.x, n.y - s.y);
      if (d > (reach.get(s.id) ?? 0)) reach.set(s.id, d);
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const f = this.view.focus;
    for (const s of sessions) {
      if (s.x === undefined || s.y === undefined || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const age = this.frame.perf - s.born;
      if (age <= 0) continue;
      const R = Math.max(64, (reach.get(s.id) ?? 0) + 44) * (this.view.motion ? 0.6 + 0.4 * easeOutCubic(age / 900) : 1);
      const dim = f ? (f.nodes.has(s.id) ? 1 : f.strength === "selected" ? 0.25 : 0.6) : 1;
      const [r, g, b] = hexToRgb(s.color);
      const grad = ctx.createRadialGradient(s.x, s.y, s.r * 0.6, s.x, s.y, R);
      grad.addColorStop(0, `rgba(${r},${g},${b},${0.2 * dim})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${0.075 * dim})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- nodes --

  paintNode = (node: object, ctx: CanvasRenderingContext2D, scale: number): void => {
    const vn = node as VNode;
    const x = vn.x;
    const y = vn.y;
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const f = this.frame;
    const age = f.perf - vn.born;
    if (age <= 0) return; // intro stagger: not born yet
    const motion = this.view.motion;
    let pop = motion ? popScale(age) : 1;
    let alpha = ttlOpacity(vn.data, f.wall) * this.nodeDim(vn);
    if (vn.dying !== null) {
      const k = clamp01((f.perf - vn.dying) / GHOST_MS);
      pop *= 1 - 0.55 * easeOutCubic(k);
      alpha *= 1 - k;
    }
    if (alpha < 0.01 || pop <= 0) return;

    ctx.save();
    switch (vn.kind) {
      case "session":
        this.drawSession(ctx, vn, x, y, pop, alpha);
        break;
      case "entity":
        this.drawEntity(ctx, vn, x, y, pop, alpha, scale);
        break;
      case "decision":
        this.drawDecision(ctx, vn, x, y, pop, alpha, scale);
        break;
      case "artifact":
        this.drawArtifact(ctx, vn, x, y, pop, alpha, scale);
        break;
      case "open_loop":
        this.drawLoop(ctx, vn, x, y, pop, alpha, scale);
        break;
      default:
        this.drawThought(ctx, vn, x, y, pop, alpha, scale);
    }
    this.drawEvents(ctx, vn, x, y, age, scale);
    ctx.restore();
  };

  private drawSession(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, pop: number, alpha: number): void {
    const q = this.view.quality;
    const t = this.frame.perf;
    // sessions breathe: a slow, out-of-phase swell of ring and halo
    const swell = this.view.motion && q.level !== "low" ? Math.sin(t * 0.0014 + vn.phase * TAU) : 0;
    const r = vn.r * pop * (1 + 0.022 * swell);
    const color = vn.color;
    const pocket = vn.data.deviceKind === "pocket";

    glow(ctx, x, y, r * 3.3, color, (0.5 + 0.08 * swell) * alpha);
    disc(ctx, x, y, r, color, alpha);
    // ring (real shadowBlur: there are few of these)
    if (q.heroGlow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * this.dpr();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    if (pocket) {
      ctx.setLineDash([r * 0.55, r * 0.34]);
      ctx.lineDashOffset = this.view.motion ? -(t * 0.014) : 0;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    // fine outer ring: a second, quieter orbit
    ctx.globalAlpha = alpha * 0.35;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(x, y, r + 4.2, 0, TAU);
    ctx.stroke();
    // device glyph
    ctx.globalAlpha = alpha * 0.92;
    ctx.strokeStyle = `rgba(${INK},0.95)`;
    deviceGlyph(ctx, pocket, x, y, r * 0.62);
  }

  private drawThought(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, pop: number, alpha: number, scale: number): void {
    const q = this.view.quality;
    const long = isLongTerm(vn.data);
    const r = vn.r * pop;
    const color = vn.color;
    const pulsing = vn.pulseUntil > this.frame.perf;

    if (q.halos || pulsing || long) glow(ctx, x, y, r * (long ? 3.7 : 2.7), color, (long ? 0.6 : 0.24) * alpha);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    if (r * scale < 2.4) return; // a speck on screen: no rim, core or arc
    // rim: bright for long-term memory, faint for working memory
    ctx.lineWidth = Math.max(0.6, 1 / Math.sqrt(scale));
    ctx.strokeStyle = long ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.22)";
    ctx.stroke();
    if (long) {
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.beginPath();
      ctx.arc(x, y, r * 0.3, 0, TAU);
      ctx.fill();
    } else if (q.arcs && scale > 0.55) {
      this.ttlArc(ctx, vn, x, y, r + 3.3, color, alpha);
    }
  }

  /** the arc that is left of a working-memory node's life */
  private ttlArc(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, radius: number, color: string, alpha: number): void {
    const life = ttlFraction(vn.data, this.frame.wall);
    if (life === null) return;
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.max(0.12, life) * TAU);
    ctx.stroke();
  }

  private drawDecision(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, pop: number, alpha: number, scale: number): void {
    const q = this.view.quality;
    const long = isLongTerm(vn.data);
    const d = vn.r * 1.3 * pop;
    const color = vn.color;
    if (q.halos || long || vn.pulseUntil > this.frame.perf) glow(ctx, x, y, d * (long ? 3.3 : 2.5), color, (long ? 0.6 : 0.25) * alpha);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = Math.max(0.7, 1.1 / Math.sqrt(scale));
    ctx.lineJoin = "round";
    ctx.strokeStyle = long ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.25)";
    ctx.stroke();
    if (long) {
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.beginPath();
      ctx.arc(x, y, d * 0.22, 0, TAU);
      ctx.fill();
    } else if (q.arcs && scale > 0.55) this.ttlArc(ctx, vn, x, y, d + 3, color, alpha);
  }

  private drawEntity(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, pop: number, alpha: number, scale: number): void {
    const q = this.view.quality;
    const half = entityHalfSide(vn.data) * pop;
    const color = vn.color;
    const bridge = vn.sessions.length >= 2;
    const t = this.frame.perf;
    const px = half * scale; // on-screen half size: fine detail only where it can be seen

    if (bridge) {
      // bridging entities are hubs: a violet-cyan halo and a slowly turning dashed ring
      glow(ctx, x, y, half * 4.4, "#6d8cff", 0.5 * alpha);
      if (px >= 4) glow(ctx, x, y, half * 3.1, "#2dd4bf", 0.32 * alpha);
    } else if (q.halos) glow(ctx, x, y, half * 2.9, color, 0.3 * alpha);

    const s = half * 2;
    ctx.globalAlpha = alpha;
    roundedRect(ctx, x - half, y - half, s, s, Math.max(2.4, half * 0.34));
    ctx.fillStyle = "rgba(11,13,18,0.86)";
    ctx.fill();
    ctx.fillStyle = withAlpha(color, 0.24);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.6 / Math.sqrt(scale)) + (bridge ? 0.5 : 0);
    ctx.strokeStyle = color;
    ctx.stroke();

    if (bridge && px >= 4) {
      ctx.globalAlpha = alpha * 0.85;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#c4b5fd";
      ctx.setLineDash([3.2, 3.2]);
      ctx.lineDashOffset = this.view.motion ? -(t * 0.01) : 0;
      roundedRect(ctx, x - half - 4, y - half - 4, s + 8, s + 8, Math.max(3.5, half * 0.42));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // monogram
    if (px >= 7.5) {
      ctx.globalAlpha = alpha * 0.95;
      ctx.fillStyle = color;
      ctx.font = `700 ${Math.max(6, half * 1.05)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((vn.label.trim()[0] ?? "?").toUpperCase(), x, y + half * 0.04);
    }
    // how many sessions it bridges
    if (bridge && px >= 8) {
      const bx = x + half * 0.95;
      const by = y - half * 0.95;
      const br = Math.max(4.2, 5.2 / Math.sqrt(scale));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#6d8cff";
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${br * 1.25}px ${FONT}`;
      ctx.fillText(String(vn.sessions.length), bx, by + br * 0.06);
    }
    if (!isLongTerm(vn.data) && q.arcs && scale > 0.55) this.ttlArc(ctx, vn, x, y, half * 1.5 + 3, color, alpha);
  }

  private artifactKind(vn: VNode): ArtifactKind | null {
    let k = this.artifactKinds.get(vn.label);
    if (k === undefined) {
      k = artifactKindFromLabel(vn.label);
      if (this.artifactKinds.size > 1500) this.artifactKinds.clear();
      this.artifactKinds.set(vn.label, k);
    }
    return k;
  }

  private drawArtifact(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, pop: number, alpha: number, scale: number): void {
    const r = vn.r * pop;
    const color = vn.color;
    const long = isLongTerm(vn.data);
    if (this.view.quality.halos && long) glow(ctx, x, y, r * 3, color, 0.3 * alpha);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(11,13,18,0.9)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.8, 1.15 / Math.sqrt(scale));
    ctx.globalAlpha = alpha * 0.85;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    artifactGlyph(ctx, this.artifactKind(vn), x, y, r * 0.5);
  }

  private drawLoop(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, pop: number, alpha: number, scale: number): void {
    const r = vn.r * pop;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = vn.color;
    ctx.lineWidth = Math.max(0.9, 1.3 / Math.sqrt(scale));
    ctx.setLineDash([2.4, 2.2]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = vn.color;
    ctx.font = `700 ${r * 1.4}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", x, y + r * 0.06);
  }

  /** burst on birth, pulse while new, flash on promotion, sonar on session activity */
  private drawEvents(ctx: CanvasRenderingContext2D, vn: VNode, x: number, y: number, age: number, scale: number): void {
    if (!this.view.motion) return;
    const t = this.frame.perf;
    const color = vn.color;
    const inv = 1 / Math.sqrt(scale);

    const burst = burstProgress(age, 950);
    if (burst >= 0) {
      const k = easeOutCubic(burst);
      ctx.globalAlpha = (1 - burst) * 0.85;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, (2.4 * (1 - burst) + 0.4) * inv);
      ctx.beginPath();
      ctx.arc(x, y, vn.r + k * 26 * inv, 0, TAU);
      ctx.stroke();
      // sparks fly outwards
      ctx.fillStyle = color;
      const n = vn.kind === "session" ? 12 : 8;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU + vn.phase * TAU;
        const dist = vn.r + k * (vn.kind === "session" ? 46 : 32) * inv * (0.7 + 0.5 * ((i * 7) % 5) / 5);
        ctx.globalAlpha = (1 - burst) * 0.9;
        ctx.beginPath();
        ctx.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, Math.max(0.5, (1 - burst) * 2.1 * inv), 0, TAU);
        ctx.fill();
      }
    }

    if (vn.pulseUntil > t) {
      const period = vn.kind === "session" ? 1100 : 1500;
      const p = ((t - Math.max(0, vn.born)) % period) / period;
      const fade = clamp01((vn.pulseUntil - t) / 900);
      ctx.globalAlpha = (1 - p) * 0.55 * fade;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, 1.6 * inv);
      ctx.beginPath();
      ctx.arc(x, y, vn.r + 3 + p * (vn.kind === "session" ? 30 : 20) * inv, 0, TAU);
      ctx.stroke();
    }

    const flash = burstProgress(t - vn.promotedAt, 1700);
    if (flash >= 0) {
      glow(ctx, x, y, vn.r * (3 + 5 * easeOutCubic(flash)), "#fbbf24", (1 - flash) * 0.85);
      ctx.globalAlpha = (1 - flash) * 0.95;
      ctx.strokeStyle = "#fde68a";
      ctx.lineWidth = Math.max(0.6, 1.8 * inv);
      ctx.beginPath();
      ctx.arc(x, y, vn.r + 2 + easeOutCubic(flash) * 22 * inv, 0, TAU);
      ctx.stroke();
    }
  }

  /** hit areas for hover / click: generous (11 px on screen at minimum) so dots and phone taps are easy to hit */
  paintPointer = (node: object, color: string, ctx: CanvasRenderingContext2D, scale: number): void => {
    const vn = node as VNode;
    if (vn.x === undefined || vn.y === undefined || vn.dying !== null) return;
    if (this.frame.perf - vn.born <= 0) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(vn.x, vn.y, Math.max(vn.r + 2.5, 11 / scale), 0, TAU);
    ctx.fill();
  };

  // --------------------------------------------------------------- links --

  paintLink = (link: object, ctx: CanvasRenderingContext2D, scale: number): void => {
    const l = link as VLink & { __controlPoints?: number[] | null };
    const a = l.source;
    const b = l.target;
    if (typeof a !== "object" || typeof b !== "object" || a.x === undefined || b.x === undefined || a.y === undefined || b.y === undefined) return;
    const vis = edgeVisual(l.type, l.weight);
    const alpha = Math.min(1, this.linkAlpha(l));
    if (alpha < 0.02) return;
    const hot = this.view.hoverLink === l || (this.view.focus ? this.view.focus.links.has(l.id) : false);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = vis.color;
    ctx.lineWidth = (vis.width * (hot ? 1.5 : 1)) / scale;
    const dash = scaledDash(vis.dash, scale);
    if (dash) ctx.setLineDash(dash);
    const cp = l.__controlPoints;
    const trace = (): void => {
      ctx.beginPath();
      ctx.moveTo(a.x as number, a.y as number);
      if (cp && cp.length === 2) ctx.quadraticCurveTo(cp[0] as number, cp[1] as number, b.x as number, b.y as number);
      else ctx.lineTo(b.x as number, b.y as number);
    };
    if (this.view.quality.heroGlow && (hot || this.cache.visibleLinks().length < 140)) {
      ctx.globalAlpha = (hot ? 0.28 : 0.1) * alpha;
      ctx.lineWidth = (vis.width * (hot ? 4.5 : 3.2)) / scale;
      ctx.setLineDash([]);
      trace();
      ctx.stroke();
      ctx.lineWidth = (vis.width * (hot ? 1.5 : 1)) / scale;
      if (dash) ctx.setLineDash(dash);
    }
    ctx.globalAlpha = (hot ? 1 : 0.78) * alpha;
    trace();
    ctx.stroke();
    ctx.restore();
  };

  /**
   * Hit area of a link on the hidden picking canvas. Only semantic links answer to the pointer (they
   * show a caption), so the thousand structural lines are skipped there: a big graph picks much faster.
   */
  paintLinkPointer = (link: object, color: string, ctx: CanvasRenderingContext2D, scale: number): void => {
    const l = link as VLink & { __controlPoints?: number[] | null };
    const a = l.source;
    const b = l.target;
    if (!l.semantic || this.view.hiddenEdgeTypes.has(l.type)) return;
    if (typeof a !== "object" || typeof b !== "object" || a.x === undefined || b.x === undefined || a.y === undefined || b.y === undefined) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 9 / scale;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    const cp = l.__controlPoints;
    if (cp && cp.length === 2) ctx.quadraticCurveTo(cp[0] as number, cp[1] as number, b.x, b.y);
    else ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  };

  paintParticle = (x: number, y: number, link: object, ctx: CanvasRenderingContext2D, scale: number): void => {
    const l = link as VLink;
    const alpha = Math.min(1, this.linkAlpha(l));
    if (alpha < 0.1) return;
    const color = EDGE_STYLE[l.type]?.color ?? "#a78bfa";
    const r = 5.2 / Math.pow(scale, 0.85);
    ctx.save();
    glow(ctx, x, y, r, color, 0.85 * alpha);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.35, 1.25 / Math.pow(scale, 0.85)), 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  // -------------------------------------------------------------- overlays --

  private paintFocusRings(ctx: CanvasRenderingContext2D, scale: number): void {
    const { selectedId, hoverId, emphasisId } = this.view;
    const t = this.frame.perf;
    const ring = (id: string, selected: boolean): void => {
      const vn = this.cache.node(id);
      if (!vn || !vn.visible || vn.x === undefined || vn.y === undefined) return;
      const half = vn.kind === "entity" ? entityHalfSide(vn.data) : vn.r;
      const r = (vn.kind === "decision" ? vn.r * 1.3 : half) + (selected ? 6.5 : 4.2);
      glow(ctx, vn.x, vn.y, r * 3, vn.color, selected ? 0.55 : 0.3);
      ctx.globalAlpha = selected ? 0.95 : 0.7;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(0.8, (selected ? 1.8 : 1.3) / Math.sqrt(scale));
      if (selected) {
        if (this.view.quality.heroGlow) {
          ctx.shadowColor = vn.color;
          ctx.shadowBlur = 16 * this.dpr();
        }
        ctx.setLineDash([r * 0.5, r * 0.28]);
        ctx.lineDashOffset = this.view.motion ? -(t * 0.016) : 0;
      }
      ctx.beginPath();
      ctx.arc(vn.x, vn.y, r, 0, TAU);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
    };
    if (emphasisId && emphasisId !== selectedId && emphasisId !== hoverId) ring(emphasisId, false);
    if (hoverId && hoverId !== selectedId) ring(hoverId, false);
    if (selectedId) ring(selectedId, true);
  }

  private readTextScale(): number {
    if (typeof document === "undefined") return 1;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
    return Math.min(1.7, Math.max(0.92, rem / 14.2));
  }

  private textWidth(ctx: CanvasRenderingContext2D, text: string, bold: boolean): number {
    const key = `${bold ? "b" : "n"}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      ctx.font = `${bold ? 650 : 560} 11px ${FONT}`;
      w = ctx.measureText(text).width;
      if (this.widths.size > 600) this.widths.clear();
      this.widths.set(key, w);
    }
    return w;
  }

  /**
   * Labels are placed greedily by importance with collision avoidance, in screen-constant size. Zoomed out
   * only sessions (and the selection / hover / new nodes) are named; zooming in names more.
   */
  private paintLabels(ctx: CanvasRenderingContext2D, scale: number): void {
    const view = this.view;
    const f = this.frame;
    const nodes = this.cache.visibleNodes();
    const tr = ctx.getTransform();
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const cands: Candidate[] = [];
    const focus = view.focus;
    // a sparse graph can name every thought at once; a dense one waits until you zoom in
    const dense = nodes.length > 70;
    const thoughtZoom = dense ? 1.15 : 0.8;
    const artifactZoom = dense ? 2 : 1.5;

    for (const vn of nodes) {
      if (vn.x === undefined || vn.y === undefined || vn.dying !== null) continue;
      if (f.perf - vn.born <= 0) continue;
      const sx = tr.a * vn.x + tr.c * vn.y + tr.e;
      const sy = tr.b * vn.x + tr.d * vn.y + tr.f;
      if (sx < -60 || sy < -30 || sx > W + 60 || sy > H + 30) continue;
      const selected = vn.id === view.selectedId;
      const hovered = vn.id === view.hoverId || vn.id === view.emphasisId;
      const near = focus ? focus.nodes.has(vn.id) : false;
      const fresh = vn.pulseUntil > f.perf;
      const dim = this.nodeDim(vn);
      let prio = 0;
      if (selected) prio = 100;
      else if (hovered) prio = 92;
      else if (near && focus) prio = 62 + (vn.kind === "session" ? 6 : vn.kind === "entity" ? 3 : 0);
      else if (fresh) prio = 58;
      else if (vn.kind === "session") prio = 50;
      else if (vn.kind === "entity") prio = scale >= 0.5 || view.alwaysLabels ? 36 + (vn.sessions.length >= 2 ? 10 : 0) + (vn.data.salience ?? 0.3) * 6 : 0;
      else if (vn.kind === "thought" || vn.kind === "decision") prio = scale >= thoughtZoom || view.alwaysLabels ? 18 + (vn.data.salience ?? 0.3) * 12 : 0;
      else if (vn.kind === "artifact") prio = scale >= artifactZoom || view.alwaysLabels ? 8 : 0;
      else prio = scale >= 1 ? 10 : 0;
      if (prio === 0) continue;
      if (dim < 0.2 && !selected && !hovered) continue;
      const text = vn.label.length > 38 ? `${vn.label.slice(0, 37).trimEnd()}…` : vn.label;
      if (!text) continue;
      cands.push({ vn, prio, text, bold: vn.kind === "session" || selected || hovered, alpha: Math.max(0.25, dim) });
    }
    if (!cands.length && !view.hoverLink && !focus) return;
    cands.sort((a, b) => b.prio - a.prio);

    const inv = 1 / scale;
    // relationship pills claim their spot first; node labels then steer around them
    const placed: LabelBox[] = [];
    const pills = this.collectPills(ctx, scale, placed);
    const hits = (b: LabelBox): boolean => {
      for (const p of placed) if (b.x1 < p.x2 && b.x2 > p.x1 && b.y1 < p.y2 && b.y2 > p.y1) return true;
      return false;
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let shown = 0;
    for (const c of cands) {
      if (shown >= view.quality.maxLabels && c.prio < 90) break;
      const vn = c.vn;
      const x = vn.x as number;
      const y = vn.y as number;
      const ts = this.textScale;
      const w = (this.textWidth(ctx, c.text, c.bold) + 8) * inv * ts;
      const h = 14 * inv * ts;
      const ext = vn.kind === "entity" ? entityHalfSide(vn.data) * 1.05 : vn.kind === "decision" ? vn.r * 1.3 : vn.r;
      const below: LabelBox = { x1: x - w / 2, x2: x + w / 2, y1: y + ext + 5 * inv, y2: y + ext + 5 * inv + h };
      const above: LabelBox = { x1: x - w / 2, x2: x + w / 2, y1: y - ext - 5 * inv - h, y2: y - ext - 5 * inv };
      let box = below;
      if (hits(below)) {
        if (c.prio >= 90 || !hits(above)) box = above;
        else continue;
      }
      placed.push(box);
      shown++;
      ctx.font = `${c.bold ? 650 : 560} ${11 * inv * ts}px ${FONT}`;
      ctx.globalAlpha = c.alpha;
      ctx.lineJoin = "round";
      ctx.lineWidth = 3.6 * inv;
      ctx.strokeStyle = "rgba(8,10,16,0.9)";
      ctx.strokeText(c.text, x, box.y1 + 1 * inv);
      ctx.fillStyle = c.prio >= 90 ? "#ffffff" : vn.kind === "session" ? withAlpha(vn.color, 1) : `rgba(${INK},${c.prio >= 40 ? 0.95 : 0.82})`;
      ctx.fillText(c.text, x, box.y1 + 1 * inv);
    }

    this.drawPills(ctx, pills, inv * this.textScale);
  }

  /**
   * "same topic · 99%" pills at the middle of the semantic links around the focus (and the hovered link).
   * Their boxes are added to `placed` so labels avoid them; pills that would sit on top of another pill
   * are nudged along the link instead of stacking.
   */
  private collectPills(ctx: CanvasRenderingContext2D, scale: number, placed: LabelBox[]): Pill[] {
    const view = this.view;
    const links: VLink[] = [];
    if (view.hoverLink) links.push(view.hoverLink);
    const focus = view.focus;
    if (focus && focus.strength === "selected") {
      for (const l of this.cache.visibleLinks()) {
        if (l.semantic && focus.links.has(l.id) && l !== view.hoverLink && !view.hiddenEdgeTypes.has(l.type)) links.push(l);
        if (links.length >= 10) break;
      }
    }
    const out: Pill[] = [];
    if (!links.length) return out;
    const inv = (1 / scale) * this.textScale;
    ctx.font = `600 ${10.5 * inv}px ${FONT}`;
    const h = 17 * inv;
    for (const l of links) {
      const l2 = l as VLink & { __controlPoints?: number[] | null };
      const a = l.source;
      const b = l.target;
      if (a.x === undefined || b.x === undefined || a.y === undefined || b.y === undefined) continue;
      const cp = l2.__controlPoints && l2.__controlPoints.length === 2 ? l2.__controlPoints : null;
      const text = edgeCaption(l.type, l.weight);
      const w = ctx.measureText(text).width + 14 * inv;
      // try the middle of the link, then slide along it until the pill is free
      let box: LabelBox | null = null;
      let mx = 0;
      let my = 0;
      for (const f of [0.5, 0.36, 0.64, 0.24, 0.76]) {
        const g = 1 - f;
        mx = cp ? g * g * a.x + 2 * g * f * (cp[0] as number) + f * f * b.x : a.x + (b.x - a.x) * f;
        my = cp ? g * g * a.y + 2 * g * f * (cp[1] as number) + f * f * b.y : a.y + (b.y - a.y) * f;
        const cand: LabelBox = { x1: mx - w / 2, x2: mx + w / 2, y1: my - h / 2, y2: my + h / 2 };
        if (!placed.some((p) => cand.x1 < p.x2 && cand.x2 > p.x1 && cand.y1 < p.y2 && cand.y2 > p.y1)) {
          box = cand;
          break;
        }
      }
      if (!box) box = { x1: mx - w / 2, x2: mx + w / 2, y1: my - h / 2, y2: my + h / 2 };
      placed.push(box);
      out.push({ x: mx, y: my, w, h, text, color: edgeVisual(l.type, l.weight).color });
    }
    return out;
  }

  private drawPills(ctx: CanvasRenderingContext2D, pills: readonly Pill[], inv: number): void {
    if (!pills.length) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${10.5 * inv}px ${FONT}`;
    for (const p of pills) {
      ctx.globalAlpha = 1;
      roundedRect(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, p.h / 2);
      ctx.fillStyle = "rgba(11,13,18,0.93)";
      ctx.fill();
      ctx.lineWidth = 1.1 * inv;
      ctx.strokeStyle = p.color;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(p.text, p.x, p.y + 0.5 * inv);
    }
  }
}
