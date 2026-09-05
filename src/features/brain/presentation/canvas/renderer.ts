import { paintDeepSpace, paintNebula, paintStars, type Sky } from "./cosmos";
import {
  BODY_CLASSES,
  BODY_EXTENT,
  BodySprites,
  DETAIL_RADIUS,
  bodyClass,
  domSurfaceFactory,
  nodeMass,
  type SpriteSurface,
  type SurfaceFactory,
} from "./bodies";
import {
  EDGE_BUCKETS,
  EDGE_BUCKET_ALPHA,
  EDGE_BUCKET_WIDTH,
  EDGE_SLOTS,
  EDGE_TIERS,
  EDGE_TIER_ALPHA,
  EDGE_TIER_DASH,
  EDGE_TIER_WIDTH,
  edgeGeometry,
  edgeSlot,
  edgeTier,
  type EdgeGeometry,
} from "./edge-style";
import type { GraphTheme } from "./theme";
import type { DisplaySettings, GraphModel } from "./types";
import type { GraphView } from "./view";
import type { ResolvedGroups } from "./groups";

/**
 * Canvas renderer.
 *
 * One <canvas> for the whole graph: at a few thousand nodes a DOM element (or an
 * SVG <circle>) per node is what makes a graph view unusable — layout, style and
 * hit-testing all scale with the element count. Here the cost is per *colour*
 * instead: nodes are batched into one path per group and filled in a single call,
 * edges into one path per (tier, strength) pair — nine paths, whatever the size of
 * the graph.
 *
 * World coordinates come straight from the simulation; this module converts to
 * screen space by hand rather than with ctx.setTransform, so radii and line widths
 * stay in device-independent pixels at every zoom level (thin edges stay thin).
 *
 * The passes run back to front, the way a scene is painted: sky, edges, arrows,
 * planets, labels, rings. Everything that is atmosphere rather than data is gated on
 * a budget and on the layout having settled — a graph that is still moving spends
 * its frame on the graph.
 */

export type Camera = { x: number; y: number; scale: number };

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, scale: 1 };
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export type RenderInput = {
  model: GraphModel;
  view: GraphView;
  /** Simulation output, in local (view) index space. */
  positions: Float32Array;
  groups: ResolvedGroups;
  display: DisplaySettings;
  camera: Camera;
  theme: GraphTheme;
  /** Model node indexes, or -1. */
  hover: number;
  selected: number;
  /**
   * The local graph's centre, as a model node index, or -1. It is painted in the
   * accent colour with a halo so "the note this graph is about" is never in doubt.
   */
  focal: number;
  /**
   * Model-indexed masks for the hover/selection highlight. Null means "nothing is
   * highlighted", which is the common case and skips the dimming pass entirely.
   */
  highlightNodes: Uint8Array | null;
  highlightEdges: Uint8Array | null;
  /** True while the layout is still cooling — turns on the level-of-detail cuts. */
  moving: boolean;
  /** When animate is on, only local indexes < animLimit are drawn or hit-tested. */
  animLimit: number;
  /**
   * The brain's own starfield, or null when the cosmos layer is switched off. Built
   * once per brain (see ./cosmos.ts), never per frame.
   */
  sky: Sky | null;
  /**
   * Dash phase for the light travelling along a highlighted edge, in pixels. The
   * hook owns the clock: it holds this at 0 when nothing is highlighted and when the
   * reader asked for reduced motion, so the renderer needs no opinion about either.
   */
  flowPhase: number;
  /**
   * Ring spacing and how many rings, when the local graph is laid out orbitally.
   * Null in the global graph. The renderer draws the same rings the physics is
   * pulling towards, so the two can only ever agree.
   */
  orbit: { gap: number; depth: number } | null;
  /**
   * Seconds of ambient time, or -1 for a still frame. Drives the twinkle on stars and
   * the drift of the nebula — the slow layer that keeps the sky from looking like a
   * screenshot. The hook owns the clock and holds it at -1 under reduced motion.
   */
  ambientPhase: number;
};

/**
 * How far the rest of the graph recedes while a neighbourhood is highlighted. Dark
 * enough to be clearly secondary, light enough that the shape of the graph around
 * the focus is still legible — on a near-black ground the two are close together.
 */
const DIM_ALPHA = 0.4;
/** Above this many nodes on screen, labels are reserved for what is highlighted. */
const LABEL_NODE_BUDGET = 240;
/** While the layout moves, draw at most this many edges (strided, so evenly). */
const EDGE_BUDGET_MOVING = 3000;
/** Direction chevrons are a detail: only worth drawing on a settled, small graph. */
const ARROW_BUDGET = 900;
/**
 * Atmosphere, limb light and hub rings are three extra passes over the node set.
 * Past this many nodes on screen they stop being legible as shading and start being
 * a cost, so above the budget a node is a flat disc again.
 */
const PLANET_BUDGET = 700;
/** shadowBlur is the most expensive thing here. Only for a small highlighted set. */
const GLOW_BUDGET = 500;
/** Visible neighbours a node needs before it earns a ring. */
const HUB_DEGREE = 8;
const LABEL_FONT = "500 11px ui-sans-serif, system-ui, -apple-system, sans-serif";
/** Hop numerals on the orbit rings. Digits only, so no translation is involved. */
const ORBIT_FONT = "500 10px ui-sans-serif, system-ui, -apple-system, sans-serif";
/** Inset of the off-screen pointer from the canvas edge. */
const COMPASS_INSET = 26;

/**
 * Size follows how strongly a node is connected, not just how often — see `nodeMass`
 * in ./bodies.ts, which is the same number that decides *what kind of body* the node
 * is drawn as, so size and kind can never disagree. `sqrt` keeps the growth gentle: a
 * hub with twelve strong edges ends up about twice the radius of a leaf, not twelve
 * times its area.
 */
export function nodeRadius(input: {
  model: GraphModel;
  view: GraphView;
  display: DisplaySettings;
  modelIndex: number;
}): number {
  const { model, view, display, modelIndex } = input;
  return radiusForMass(nodeMass({ model, view, modelIndex }), display);
}

function radiusForMass(mass: number, display: DisplaySettings): number {
  return (2.4 + Math.sqrt(Math.max(0, mass)) * 1.6) * display.nodeScale;
}

const TAU = Math.PI * 2;

/** Camera that frames the whole current layout, with a little breathing room. */
export function fitCamera(
  positions: Float32Array,
  count: number,
  width: number,
  height: number
): Camera {
  if (count === 0 || width === 0 || height === 0) return DEFAULT_CAMERA;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return DEFAULT_CAMERA;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.min((width * 0.86) / spanX, (height * 0.86) / spanY))
  );
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
}

function truncateLabel(label: string): string {
  return label.length > 30 ? `${label.slice(0, 29)}…` : label;
}

/** Pan by a screen-space delta. Pure, so the interaction hook stays testable. */
export function panCamera(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return {
    x: camera.x - dxScreen / camera.scale,
    y: camera.y - dyScreen / camera.scale,
    scale: camera.scale,
  };
}

/**
 * Zoom about a screen point: the world point under the cursor stays under the
 * cursor, which is the difference between a zoom that feels like a map and one
 * that feels like a slider.
 */
export function zoomCamera(
  camera: Camera,
  screenX: number,
  screenY: number,
  factor: number,
  width: number,
  height: number
): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
  if (scale === camera.scale) return camera;
  const offsetX = screenX - width / 2;
  const offsetY = screenY - height / 2;
  const worldX = offsetX / camera.scale + camera.x;
  const worldY = offsetY / camera.scale + camera.y;
  return { x: worldX - offsetX / scale, y: worldY - offsetY / scale, scale };
}

export class GraphRenderer {
  private ctx: CanvasRenderingContext2D | null;
  private viewWidth = 0;
  private viewHeight = 0;

  /**
   * Per-frame scratch, grown but never shrunk. Screen coordinates and radii are
   * computed once and reused by the edge, node and label passes; the bucket arrays
   * sort nodes by (colour, dimmed) with a counting sort so each colour is one fill().
   */
  private screen = new Float32Array(0);
  private radii = new Float32Array(0);
  private slotOf = new Int32Array(0);
  private order = new Int32Array(0);
  private slotStart = new Int32Array(0);
  private slotCursor = new Int32Array(0);
  /**
   * One reused geometry record for the edge passes. Each edge's curve is handed
   * straight to a Path2D and never kept, so a fresh object per edge would be pure
   * garbage — thousands of allocations a second on a busy graph.
   */
  private curve: EdgeGeometry = { x1: 0, y1: 0, x2: 0, y2: 0, cx: 0, cy: 0 };
  /** Screen-space mean of the drawn nodes, for the off-screen pointer. */
  private centroidX = 0;
  private centroidY = 0;
  /** Body class per local index, resolved alongside the radii. */
  private bodyOf = new Int8Array(0);
  private sprites: BodySprites;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /**
     * Where sprite surfaces come from. Defaults to the document; a caller with no DOM
     * (a test, the offline PNG preview) supplies its own or gets flat discs.
     */
    surfaces: SurfaceFactory | null = domSurfaceFactory()
  ) {
    // alpha:false lets the compositor skip blending the canvas against the page.
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.sprites = new BodySprites(surfaces);
  }

  /** `width`/`height` in CSS pixels; the backing store is scaled by `dpr`. */
  resize(width: number, height: number, dpr: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    const ratio = Math.min(Math.max(dpr, 1), 3);
    const nextWidth = Math.max(1, Math.round(width * ratio));
    const nextHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== nextWidth) this.canvas.width = nextWidth;
    if (this.canvas.height !== nextHeight) this.canvas.height = nextHeight;
    // Resetting the backing store clears the transform, so set it every time.
    this.ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** CSS-pixel size of the canvas, for camera fitting and hit tests. */
  get width(): number {
    return this.viewWidth;
  }

  get height(): number {
    return this.viewHeight;
  }

  /** Empty graph: paint the ground so the panel does not show a transparent hole. */
  clear(background: string): void {
    if (!this.ctx) return;
    this.ctx.fillStyle = background;
    this.ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
  }

  /**
   * The sky. A flat fill when the cosmos layer is off, so the plain view stays one
   * toggle away and costs a single fillRect.
   */
  private paintGround(input: RenderInput): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { theme, sky, display } = input;
    if (!sky || !display.cosmos) {
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
      return;
    }
    paintDeepSpace(ctx, this.viewWidth, this.viewHeight, theme.backgroundCore, theme.background);
    paintNebula(ctx, sky, this.viewWidth, this.viewHeight, theme.nebula, input.ambientPhase);
    paintStars(
      ctx,
      sky,
      input.camera,
      this.viewWidth,
      this.viewHeight,
      theme.star,
      input.ambientPhase
    );
  }

  toScreen(worldX: number, worldY: number, camera: Camera): { x: number; y: number } {
    return {
      x: (worldX - camera.x) * camera.scale + this.viewWidth / 2,
      y: (worldY - camera.y) * camera.scale + this.viewHeight / 2,
    };
  }

  toWorld(screenX: number, screenY: number, camera: Camera): { x: number; y: number } {
    return {
      x: (screenX - this.viewWidth / 2) / camera.scale + camera.x,
      y: (screenY - this.viewHeight / 2) / camera.scale + camera.y,
    };
  }

  /**
   * Projects the visible nodes into `this.screen` and their radii into `this.radii`,
   * and returns how many there are. Radii are computed here rather than per pass:
   * the edge loop needs them twice per edge to dock on a rim, which would otherwise
   * mean recomputing the same node's size a dozen times a frame.
   */
  private project(input: RenderInput): number {
    const { view, positions, camera } = input;
    const count = Math.min(view.count, positions.length >> 1);
    if (this.screen.length < count * 2) this.screen = new Float32Array(count * 2 + 512);
    if (this.radii.length < count) this.radii = new Float32Array(count + 512);
    if (this.bodyOf.length < count) this.bodyOf = new Int8Array(count + 512);
    const screen = this.screen;
    const radii = this.radii;
    const bodyOf = this.bodyOf;
    const halfWidth = this.viewWidth / 2;
    const halfHeight = this.viewHeight / 2;
    const scale = camera.scale;
    const zoom = Math.min(2.6, Math.max(0.5, Math.sqrt(scale)));
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < count; i += 1) {
      const x = (positions[i * 2] - camera.x) * scale + halfWidth;
      const y = (positions[i * 2 + 1] - camera.y) * scale + halfHeight;
      screen[i * 2] = x;
      screen[i * 2 + 1] = y;
      // Mass is computed once here and answers both questions: how big, and what kind.
      const mass = nodeMass({ model: input.model, view, modelIndex: view.nodesOf[i] });
      const base = radiusForMass(mass, input.display);
      radii[i] = Math.min(52, Math.max(1.1, base * zoom));
      bodyOf[i] = BODY_CLASSES.indexOf(bodyClass(mass));
      sumX += x;
      sumY += y;
    }
    this.centroidX = count > 0 ? sumX / count : halfWidth;
    this.centroidY = count > 0 ? sumY / count : halfHeight;
    return count;
  }

  draw(input: RenderInput): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.paintGround(input);
    const projected = this.project(input);
    if (projected === 0) return;
    // Timelapse: clip the local index range once, here, so edges, labels and rings
    // appear together with their nodes instead of hanging in empty space.
    const count = input.display.animate
      ? Math.min(projected, Math.max(0, input.animLimit))
      : projected;
    if (count === 0) return;
    this.drawOrbits(input);
    this.drawEdges(input, count);
    this.drawArrows(input, count);
    const drawn = this.drawNodes(input, count);
    this.drawLabels(input, count, drawn);
    this.drawRings(input, count);
    this.drawCompass(input, drawn);
  }

  /**
   * The orbits themselves: one faint ring per hop, centred on the origin the sun is
   * held at. Drawn behind everything, and numbered — a ring with a "2" on it turns
   * the depth slider into something the canvas explains rather than something the
   * panel asserts. Six rings at most, so this is six arcs however large the graph is.
   */
  private drawOrbits(input: RenderInput): void {
    const ctx = this.ctx;
    const orbit = input.orbit;
    if (!ctx || !orbit || orbit.gap <= 0 || orbit.depth <= 0) return;
    const { camera, theme } = input;
    const centre = this.toScreen(0, 0, camera);
    ctx.strokeStyle = theme.edgeTiers.context;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    for (let hop = 1; hop <= orbit.depth; hop += 1) {
      const radius = orbit.gap * hop * camera.scale;
      if (radius < 6) continue;
      ctx.moveTo(centre.x + radius, centre.y);
      ctx.arc(centre.x, centre.y, radius, 0, TAU);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = ORBIT_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.label;
    ctx.globalAlpha = 0.42;
    for (let hop = 1; hop <= orbit.depth; hop += 1) {
      const radius = orbit.gap * hop * camera.scale;
      // Only where there is room for the numeral and it is actually on screen.
      if (radius < 28) continue;
      const y = centre.y - radius;
      if (y < 8 || y > this.viewHeight - 8 || centre.x < 8 || centre.x > this.viewWidth - 8) {
        continue;
      }
      ctx.fillText(String(hop), centre.x, y);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Screen radius of a node, in device-independent pixels. Zoom is applied as a
   * square root so a node grows with the camera without swallowing the viewport.
   */
  private screenRadius(input: RenderInput, modelIndex: number): number {
    const base = nodeRadius({
      model: input.model,
      view: input.view,
      display: input.display,
      modelIndex,
    });
    const zoom = Math.min(2.6, Math.max(0.5, Math.sqrt(input.camera.scale)));
    return Math.min(52, Math.max(1.1, base * zoom));
  }

  /**
   * Nine paths for the dim set — one per (tier, strength) pair — plus the same nine
   * shapes again for the highlighted set, never one path per edge. Tier picks the
   * colour and the dash, strength picks the alpha and the width, and a single walk
   * over the edge list sorts every edge into its bucket.
   *
   * Each edge is a quadratic that bows off the chord and docks on both rims, so two
   * relationships between the same pair no longer collapse into one stroke and no
   * line cuts across the node it points at. While the layout is still moving a
   * stride thins the dim set instead of dropping its tail, so the graph reads as a
   * whole rather than as a half-drawn corner.
   */
  private drawEdges(input: RenderInput, count: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { model, view, display, theme, camera, highlightEdges } = input;
    const edges = view.edgeIndexes;
    const total = edges.length;
    if (total === 0) return;
    const weights = view.linkWeights;
    const localOf = view.localOf;
    const stride =
      input.moving && total > EDGE_BUDGET_MOVING ? Math.ceil(total / EDGE_BUDGET_MOVING) : 1;

    const paths: Path2D[] = [];
    for (let slot = 0; slot < EDGE_SLOTS; slot += 1) paths.push(new Path2D());
    for (let e = 0; e < total; e += stride) {
      const modelEdge = edges[e];
      if (highlightEdges && highlightEdges[modelEdge]) continue;
      const edge = model.edges[modelEdge];
      const source = localOf[edge.source];
      const target = localOf[edge.target];
      if (source < 0 || target < 0 || source >= count || target >= count) continue;
      const geometry = this.edgeCurve(input, source, target, modelEdge);
      if (!geometry) continue;
      const path = paths[edgeSlot(edge.relation, weights[e] ?? 1)];
      path.moveTo(geometry.x1, geometry.y1);
      path.quadraticCurveTo(geometry.cx, geometry.cy, geometry.x2, geometry.y2);
    }

    const base = Math.max(0.4, 0.7 * display.linkScale * Math.min(1.6, camera.scale));
    const dim = highlightEdges ? 0.52 : 1;
    for (let slot = 0; slot < EDGE_SLOTS; slot += 1) {
      const tier = EDGE_TIERS[Math.floor(slot / EDGE_BUCKETS)];
      const bucket = slot % EDGE_BUCKETS;
      ctx.strokeStyle = theme.edgeTiers[tier];
      ctx.globalAlpha = EDGE_BUCKET_ALPHA[bucket] * EDGE_TIER_ALPHA[tier] * dim;
      ctx.lineWidth = Math.max(0.4, base * EDGE_BUCKET_WIDTH[bucket] * EDGE_TIER_WIDTH[tier]);
      this.applyDash(EDGE_TIER_DASH[tier], ctx.lineWidth);
      ctx.stroke(paths[slot]);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (highlightEdges) this.drawActiveEdges(input, count, highlightEdges);
  }

  /**
   * Screen geometry for one edge, or null when it is off-screen or too short to be
   * worth a stroke. The cull is a cheap box test on both endpoints: an edge whose
   * ends are both past the same side of the viewport cannot cross it.
   */
  private edgeCurve(
    input: RenderInput,
    source: number,
    target: number,
    modelEdge: number
  ): EdgeGeometry | null {
    const screen = this.screen;
    const x1 = screen[source * 2];
    const y1 = screen[source * 2 + 1];
    const x2 = screen[target * 2];
    const y2 = screen[target * 2 + 1];
    const margin = 80;
    const maxX = this.viewWidth + margin;
    const maxY = this.viewHeight + margin;
    if (x1 < -margin && x2 < -margin) return null;
    if (y1 < -margin && y2 < -margin) return null;
    if (x1 > maxX && x2 > maxX) return null;
    if (y1 > maxY && y2 > maxY) return null;
    return edgeGeometry(
      {
        x1,
        y1,
        x2,
        y2,
        r1: this.radii[source] ?? 0,
        r2: this.radii[target] ?? 0,
        seed: modelEdge,
        curve: input.display.edgeCurve,
      },
      this.curve
    );
  }

  /**
   * Dashes are scaled by the line width so a thick edge does not turn into a row of
   * bricks, and a null pattern resets the context — leaving a dash set would leak
   * into the next pass.
   */
  private applyDash(pattern: readonly number[] | null, width: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!pattern) {
      ctx.setLineDash([]);
      return;
    }
    const scale = Math.max(1, width);
    ctx.setLineDash(pattern.map((part) => part * scale));
  }

  /**
   * The hovered neighbourhood. Three passes over a set that is one node's worth of
   * edges: a wide soft glow, the line itself, then a light travelling along it.
   *
   * The glow is a real `shadowBlur`, which is the most expensive call in this file —
   * hence the budget. The travelling light is a dash whose offset the hook advances,
   * so a stationary `flowPhase` (reduced motion, or nothing highlighted) paints the
   * same frame forever and costs nothing extra.
   */
  private drawActiveEdges(input: RenderInput, count: number, active: Uint8Array): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { model, view, display, theme } = input;
    const edges = view.edgeIndexes;
    const weights = view.linkWeights;
    const localOf = view.localOf;
    const paths: Path2D[] = [];
    for (let slot = 0; slot < EDGE_SLOTS; slot += 1) paths.push(new Path2D());
    let drawn = 0;
    for (let e = 0; e < edges.length; e += 1) {
      const modelEdge = edges[e];
      if (!active[modelEdge]) continue;
      const edge = model.edges[modelEdge];
      const source = localOf[edge.source];
      const target = localOf[edge.target];
      if (source < 0 || target < 0 || source >= count || target >= count) continue;
      const geometry = this.edgeCurve(input, source, target, modelEdge);
      if (!geometry) continue;
      const path = paths[edgeSlot(edge.relation, weights[e] ?? 1)];
      path.moveTo(geometry.x1, geometry.y1);
      path.quadraticCurveTo(geometry.cx, geometry.cy, geometry.x2, geometry.y2);
      drawn += 1;
    }
    if (drawn === 0) return;

    const glowing = display.cosmos && drawn <= GLOW_BUDGET;
    // Pass 0 is the glow, 1 is the line, 2 is the travelling light. A negative phase
    // is the hook saying "still frame" — reduced motion, or nothing to travel along.
    const lastPass = display.cosmos && input.flowPhase >= 0 ? 3 : 2;
    for (let pass = glowing ? 0 : 1; pass < lastPass; pass += 1) {
      for (let slot = 0; slot < EDGE_SLOTS; slot += 1) {
        const tier = EDGE_TIERS[Math.floor(slot / EDGE_BUCKETS)];
        const bucket = slot % EDGE_BUCKETS;
        const color = theme.edgeTiers[tier];
        // The highlighted set keeps its full opacity — strength is carried by width
        // alone here, so a hovered neighbourhood stays legible at every tier.
        const width = Math.max(0.9, 1.1 * display.linkScale * EDGE_BUCKET_WIDTH[bucket]);
        ctx.strokeStyle = color;
        if (pass === 0) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 9;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = width * 1.6;
          this.applyDash(null, width);
        } else if (pass === 1) {
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 0.95;
          ctx.lineWidth = width;
          this.applyDash(EDGE_TIER_DASH[tier], width);
        } else {
          // The packet: a short bright dash with a long gap, slid along the curve.
          // Given a glow it reads as light traveling; without one it is a white tick.
          ctx.strokeStyle = theme.star;
          if (glowing) {
            ctx.shadowColor = theme.star;
            ctx.shadowBlur = 6;
          }
          ctx.globalAlpha = 0.66;
          ctx.lineWidth = Math.max(1.1, width * 0.9);
          ctx.setLineDash([width * 2, 30]);
          ctx.lineDashOffset = -input.flowPhase;
        }
        ctx.stroke(paths[slot]);
      }
    }
    ctx.lineDashOffset = 0;
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  /**
   * Direction chevrons, sitting on the rim the edge already docks against and
   * pointing along the curve's tangent there — for a quadratic that is the direction
   * away from the control point, so a chevron on a bowed edge still lines up with
   * the stroke it belongs to. Batched per tier, and skipped entirely while moving or
   * on a large graph: the detail is invisible at that density.
   */
  private drawArrows(input: RenderInput, count: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { model, view, display, theme, camera, highlightEdges } = input;
    const edges = view.edgeIndexes;
    if (!display.showArrows || input.moving || edges.length > ARROW_BUDGET) return;
    const localOf = view.localOf;
    const size = Math.max(3, 4.5 * Math.min(1.5, camera.scale));
    // One path per tier, plus a last one for the highlighted set.
    const paths: Path2D[] = [];
    for (let slot = 0; slot <= EDGE_TIERS.length; slot += 1) paths.push(new Path2D());

    for (let e = 0; e < edges.length; e += 1) {
      const modelEdge = edges[e];
      const edge = model.edges[modelEdge];
      const source = localOf[edge.source];
      const target = localOf[edge.target];
      if (source < 0 || target < 0 || source >= count || target >= count) continue;
      const geometry = this.edgeCurve(input, source, target, modelEdge);
      if (!geometry) continue;
      const dx = geometry.x2 - geometry.cx;
      const dy = geometry.y2 - geometry.cy;
      const length = Math.hypot(dx, dy);
      if (length < 0.5) continue;
      const ux = dx / length;
      const uy = dy / length;
      const active = highlightEdges ? highlightEdges[modelEdge] === 1 : false;
      const path = paths[active ? EDGE_TIERS.length : EDGE_TIERS.indexOf(edgeTier(edge.relation))];
      const tipX = geometry.x2;
      const tipY = geometry.y2;
      path.moveTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
      path.lineTo(tipX, tipY);
      path.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
    }

    ctx.lineWidth = Math.max(0.6, 0.9 * display.linkScale);
    for (let slot = 0; slot < paths.length; slot += 1) {
      const active = slot === EDGE_TIERS.length;
      if (active && !highlightEdges) break;
      const tier = active ? null : EDGE_TIERS[slot];
      ctx.strokeStyle = tier ? theme.edgeTiers[tier] : theme.edgeActive;
      ctx.globalAlpha = tier ? (highlightEdges ? 0.35 : 0.8) * EDGE_TIER_ALPHA[tier] : 0.95;
      ctx.stroke(paths[slot]);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Nodes, bucketed by (group colour, dimmed) with a counting sort so the whole
   * graph is one fill() per bucket — a few dozen draw calls instead of thousands.
   * Returns how many nodes survived culling, which the label budget then uses.
   *
   * On a settled graph inside the planet budget each bucket gets three more batched
   * passes: an atmosphere just outside the rim, an off-centre highlight that makes
   * the disc read as a lit sphere, and a ring on the hubs. All three are shape, not
   * gradient — a radial gradient per node would be one paint object per node, which
   * is exactly the per-node cost this renderer exists to avoid.
   */
  private drawNodes(input: RenderInput, count: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const { view, groups, display, highlightNodes } = input;
    const colors = groups.colors;
    const slots = colors.length * 2;
    if (this.slotOf.length < count) this.slotOf = new Int32Array(count + 512);
    if (this.order.length < count) this.order = new Int32Array(count + 512);
    if (this.slotStart.length < slots + 1) {
      this.slotStart = new Int32Array(slots + 1);
      this.slotCursor = new Int32Array(slots + 1);
    }
    const { slotOf, order, slotStart, slotCursor, screen, radii } = this;
    slotStart.fill(0, 0, slots + 1);
    const margin = 32;
    const maxX = this.viewWidth + margin;
    const maxY = this.viewHeight + margin;
    let drawn = 0;

    for (let i = 0; i < count; i += 1) {
      const x = screen[i * 2];
      const y = screen[i * 2 + 1];
      if (!(x > -margin && x < maxX && y > -margin && y < maxY)) {
        slotOf[i] = -1;
        continue;
      }
      const modelIndex = view.nodesOf[i];
      const bright = !highlightNodes || highlightNodes[modelIndex] === 1 ? 1 : 0;
      const slot = groups.groupOf[modelIndex] * 2 + bright;
      slotOf[i] = slot;
      slotStart[slot + 1] += 1;
      drawn += 1;
    }
    for (let slot = 0; slot < slots; slot += 1) slotStart[slot + 1] += slotStart[slot];
    slotCursor.set(slotStart.subarray(0, slots + 1));
    for (let i = 0; i < count; i += 1) {
      const slot = slotOf[i];
      if (slot >= 0) order[slotCursor[slot]++] = i;
    }

    const planets = display.cosmos && !input.moving && drawn <= PLANET_BUDGET;
    for (let slot = 0; slot < slots; slot += 1) {
      const start = slotStart[slot];
      const end = slotStart[slot + 1];
      if (start === end) continue;
      const color = colors[slot >> 1];
      const baseAlpha = slot & 1 ? 1 : DIM_ALPHA;
      const bodies = planets ? this.spritesFor(color) : null;
      if (bodies) {
        this.drawBodies(input, start, end, bodies, baseAlpha);
        continue;
      }

      if (planets) {
        // Atmosphere: the same discs, a little wider, at a low alpha. The width
        // follows how connected the node is, so a hub carries a visibly deeper
        // envelope than a leaf — size and glow then say the same thing twice, which
        // is what lets a hub be found at a glance without reading a single label.
        ctx.fillStyle = color;
        ctx.globalAlpha = baseAlpha * 0.17;
        ctx.beginPath();
        for (let k = start; k < end; k += 1) {
          const i = order[k];
          const degree = view.visibleDegree[view.nodesOf[i]] ?? 0;
          const envelope = 1 + Math.min(1, degree / HUB_DEGREE / 2.4);
          const radius = radii[i] + Math.max(1.5, radii[i] * 0.34) * envelope;
          ctx.moveTo(screen[i * 2] + radius, screen[i * 2 + 1]);
          ctx.arc(screen[i * 2], screen[i * 2 + 1], radius, 0, TAU);
        }
        ctx.fill();
      }

      ctx.fillStyle = color;
      ctx.globalAlpha = baseAlpha;
      ctx.beginPath();
      for (let k = start; k < end; k += 1) {
        const i = order[k];
        const radius = radii[i];
        ctx.moveTo(screen[i * 2] + radius, screen[i * 2 + 1]);
        ctx.arc(screen[i * 2], screen[i * 2 + 1], radius, 0, TAU);
      }
      ctx.fill();

      if (planets) this.drawLimb(input, start, end, baseAlpha);
      if (planets) this.drawHubRings(input, start, end, color, baseAlpha);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    return drawn;
  }

  /** The four class sprites for one colour, or null when sprites are unavailable. */
  private spritesFor(color: string): (SpriteSurface | null)[] | null {
    const star = this.sprites.get(color, "star");
    if (!star) return null;
    return BODY_CLASSES.map((body) => this.sprites.get(color, body));
  }

  /**
   * One blit per node. This is where the graph stops being a bubble chart: a giant
   * arrives with bands and a ring system, a planet with an atmosphere and a lit limb,
   * a star as a point of light with spikes — all pre-rendered, so the per-node cost is
   * a single drawImage rather than the four paint objects that shading would need.
   *
   * Anything smaller than a few pixels is drawn as a star whatever its class: at that
   * size a shaded ball is grey mush, and a distant thing being a point of light is
   * both cheaper and truer.
   */
  private drawBodies(
    input: RenderInput,
    start: number,
    end: number,
    bodies: (SpriteSurface | null)[],
    baseAlpha: number
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { screen, radii, order, bodyOf } = this;
    const phase = input.ambientPhase;
    ctx.globalAlpha = baseAlpha;
    for (let k = start; k < end; k += 1) {
      const i = order[k];
      const radius = radii[i];
      const small = radius < DETAIL_RADIUS;
      const sprite = bodies[small ? 0 : bodyOf[i]] ?? bodies[0];
      if (!sprite) continue;
      // Stars breathe. Only stars: a planet whose specular highlight pulsed would
      // read as a flickering light source rather than as a lit body.
      if (phase >= 0 && (small || bodyOf[i] === 0)) {
        ctx.globalAlpha = baseAlpha * (0.72 + 0.28 * Math.sin(phase * 1.6 + i * 2.399));
      } else {
        ctx.globalAlpha = baseAlpha;
      }
      const half = radius * BODY_EXTENT;
      ctx.drawImage(
        sprite as unknown as CanvasImageSource,
        screen[i * 2] - half,
        screen[i * 2 + 1] - half,
        half * 2,
        half * 2
      );
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The lit side. One smaller disc per node, offset towards a light that is always
   * up and to the left — a single agreed direction across the whole graph is what
   * makes a field of circles read as a field of spheres. Offsets are chosen so the
   * highlight never spills past the rim it belongs to.
   */
  private drawLimb(input: RenderInput, start: number, end: number, baseAlpha: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { screen, radii, order } = this;
    ctx.fillStyle = input.theme.star;
    ctx.globalAlpha = baseAlpha * 0.16;
    ctx.beginPath();
    for (let k = start; k < end; k += 1) {
      const i = order[k];
      const radius = radii[i];
      // Below a few pixels there is no sphere to shade, only a brighter dot.
      if (radius < 3) continue;
      const inner = radius * 0.62;
      const x = screen[i * 2] - radius * 0.2;
      const y = screen[i * 2 + 1] - radius * 0.24;
      ctx.moveTo(x + inner, y);
      ctx.arc(x, y, inner, 0, TAU);
    }
    ctx.fill();
  }

  /**
   * A flattened ring on the hubs. Purely a reading aid dressed as a planet: the
   * nodes that hold a neighbourhood together are the ones worth spotting from across
   * the canvas, and size alone stops separating them once a graph gets busy. The tilt
   * comes from the node index, so a cluster of hubs does not look stamped.
   */
  private drawHubRings(
    input: RenderInput,
    start: number,
    end: number,
    color: string,
    baseAlpha: number
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { screen, radii, order } = this;
    const { view } = input;
    ctx.strokeStyle = color;
    ctx.globalAlpha = baseAlpha * 0.44;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    let any = false;
    for (let k = start; k < end; k += 1) {
      const i = order[k];
      const modelIndex = view.nodesOf[i];
      if ((view.visibleDegree[modelIndex] ?? 0) < HUB_DEGREE) continue;
      const radius = radii[i];
      if (radius < 4) continue;
      const tilt = ((modelIndex % 7) - 3) * 0.24;
      const x = screen[i * 2];
      const y = screen[i * 2 + 1];
      const spread = radius * 1.9;
      // ellipse(), like arc(), joins from the current point — without a moveTo onto
      // its own starting point every ring would be tied to the previous one by a
      // stray line across the canvas.
      ctx.moveTo(x + spread * Math.cos(tilt), y + spread * Math.sin(tilt));
      ctx.ellipse(x, y, spread, radius * 0.52, tilt, 0, TAU);
      any = true;
    }
    if (any) ctx.stroke();
  }

  /**
   * Labels are the first thing to go: below a zoom threshold, while the layout is
   * moving, or past the node budget they are reserved for the highlighted set, so a
   * 4000-node graph never pays for 4000 text measurements per frame.
   *
   * Each one is stroked in the ground colour before it is filled. Over a starfield
   * that is the difference between a readable label and a label with a star sitting
   * in the middle of a letter — and it is two calls per label, inside a budget that
   * is already capped at a couple of hundred.
   */
  private drawLabels(input: RenderInput, count: number, drawn: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { display, view, model, theme, camera, highlightNodes, hover, selected } = input;
    if (!display.showLabels) return;
    const minScale = display.textFadeThreshold * 1.2;
    const labelAll = !input.moving && drawn <= LABEL_NODE_BUDGET && camera.scale >= minScale;
    if (!labelAll && !highlightNodes && hover < 0 && selected < 0 && input.focal < 0) return;
    const { slotOf, screen, radii } = this;
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    for (let i = 0; i < count; i += 1) {
      const slot = slotOf[i];
      if (slot < 0) continue;
      const modelIndex = view.nodesOf[i];
      const bright = (slot & 1) === 1;
      const focused = modelIndex === hover || modelIndex === selected || modelIndex === input.focal;
      if (!bright && !focused) continue;
      if (!labelAll && !focused && !highlightNodes) continue;
      const label = truncateLabel(model.nodes[modelIndex].label);
      const x = screen[i * 2];
      // Clear of the atmosphere, not just of the disc: with the cosmos layer on, a
      // label at the old offset sits inside the halo and loses its contrast.
      const y = screen[i * 2 + 1] + radii[i] + (display.cosmos ? 6 : 3);
      if (display.cosmos) {
        ctx.strokeStyle = theme.labelHalo;
        ctx.strokeText(label, x, y);
      }
      ctx.fillStyle = theme.label;
      ctx.fillText(label, x, y);
    }
  }

  private drawRings(input: RenderInput, count: number): void {
    this.markFocal(input, count);
    // The node under the pointer lights up in its own group colour rather than in a
    // generic white: hovering is how this graph is read, and the answer to "what am I
    // pointing at" should be the brightest thing on the canvas.
    this.glowNode(input, count, input.hover, 15);
    if (input.selected !== input.hover) this.glowNode(input, count, input.selected, 19);
    this.strokeRing(input, count, input.hover, input.theme.label, 1.2, 3);
    this.strokeRing(input, count, input.selected, input.theme.accent, 2, 3);
    this.drawVignette(input);
  }

  /**
   * Lights one node from outside. A stroked rim with a shadow, not a filled disc:
   * the glow spills outward and the node keeps its own colour, its limb and its
   * label. Two nodes at most per frame, so the expensive blur is affordable here.
   */
  private glowNode(input: RenderInput, count: number, modelIndex: number, blur: number): void {
    const ctx = this.ctx;
    if (!ctx || !input.display.cosmos || modelIndex < 0) return;
    const localOf = input.view.localOf;
    if (modelIndex >= localOf.length) return;
    const local = localOf[modelIndex];
    if (local < 0 || local >= count) return;
    const color = input.groups.colors[input.groups.groupOf[modelIndex]] ?? input.theme.accent;
    const radius = this.radii[local] ?? this.screenRadius(input, modelIndex);
    const x = this.screen[local * 2];
    const y = this.screen[local * 2 + 1];
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(x, y, radius + Math.max(4, radius * 0.9), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, radius + 1.2, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  /**
   * A corner falloff over the finished frame. The graph is a window onto something
   * larger, and a hard-edged rectangle of stars reads as a texture; darkening the
   * corners by a few percent is what turns it back into a view out of something.
   */
  private drawVignette(input: RenderInput): void {
    const ctx = this.ctx;
    if (!ctx || !input.display.cosmos) return;
    const x = this.viewWidth / 2;
    const y = this.viewHeight / 2;
    const outer = Math.hypot(this.viewWidth, this.viewHeight) / 2;
    const gradient = ctx.createRadialGradient(x, y, outer * 0.58, x, y, outer);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
    gradient.addColorStop(1, input.theme.vignette);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
  }

  /**
   * Which way home. On a canvas with no edges you can pan until every node is behind
   * you, and then the graph looks empty rather than off-screen — the one way an
   * endless space is genuinely worse than a bounded one. A chevron at the rim points
   * at the layout's centre whenever nothing at all is on screen; Fit (or the 0 key)
   * is what acts on it, so this stays a hint and not a hidden control.
   */
  private drawCompass(input: RenderInput, drawn: number): void {
    const ctx = this.ctx;
    if (!ctx || drawn > 0) return;
    const halfWidth = this.viewWidth / 2;
    const halfHeight = this.viewHeight / 2;
    let dx = this.centroidX - halfWidth;
    let dy = this.centroidY - halfHeight;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    dx /= length;
    dy /= length;
    // Walk out from the centre until the rim, so the chevron sits on the edge the
    // graph actually lies beyond rather than in a fixed corner.
    const limitX = Math.max(1, halfWidth - COMPASS_INSET);
    const limitY = Math.max(1, halfHeight - COMPASS_INSET);
    const reach = Math.min(
      Math.abs(dx) > 1e-6 ? limitX / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-6 ? limitY / Math.abs(dy) : Infinity
    );
    const x = halfWidth + dx * reach;
    const y = halfHeight + dy * reach;
    const size = 9;

    ctx.setLineDash([]);
    ctx.fillStyle = input.theme.accent;
    if (input.display.cosmos) {
      ctx.shadowColor = input.theme.accent;
      ctx.shadowBlur = 12;
    }
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x + dx * size, y + dy * size);
    ctx.lineTo(x - dx * size - dy * size * 0.62, y - dy * size + dx * size * 0.62);
    ctx.lineTo(x - dx * size + dy * size * 0.62, y - dy * size - dx * size * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  /**
   * The local graph's centre. Obsidian paints the current note distinctly rather
   * than leaving it to be found by position, so it gets an accent halo behind it and
   * a lit ring around it — visible even when a group colour would otherwise own the
   * node. Both sit *outside* the body: the node keeps whatever planet it is, which is
   * information the old solid accent disc used to paint over.
   */
  private markFocal(input: RenderInput, count: number): void {
    const ctx = this.ctx;
    const modelIndex = input.focal;
    if (!ctx || modelIndex < 0 || modelIndex >= input.view.localOf.length) return;
    const local = input.view.localOf[modelIndex];
    if (local < 0 || local >= count) return;
    const x = this.screen[local * 2];
    const y = this.screen[local * 2 + 1];
    const radius = this.radii[local] ?? this.screenRadius(input, modelIndex);
    ctx.setLineDash([]);
    ctx.strokeStyle = input.theme.accent;
    if (input.display.cosmos) {
      ctx.shadowColor = input.theme.accent;
      ctx.shadowBlur = 14;
    }
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  private strokeRing(
    input: RenderInput,
    count: number,
    modelIndex: number,
    color: string,
    lineWidth: number,
    padding: number
  ): void {
    const ctx = this.ctx;
    const localOf = input.view.localOf;
    if (!ctx || modelIndex < 0 || modelIndex >= localOf.length) return;
    const local = localOf[modelIndex];
    if (local < 0 || local >= count) return;
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(
      this.screen[local * 2],
      this.screen[local * 2 + 1],
      (this.radii[local] ?? this.screenRadius(input, modelIndex)) + padding,
      0,
      TAU
    );
    ctx.stroke();
  }

  /**
   * Nearest node under the pointer, as a *model* index, or -1. Recomputed from
   * `positions` rather than the last frame's scratch so a hit test right after a
   * camera change (wheel, drag) is never one frame stale.
   */
  hitTest(input: RenderInput, screenX: number, screenY: number): number {
    const { view, positions, camera } = input;
    // A node that the timelapse has not revealed yet cannot be hovered or clicked.
    const revealed = input.display.animate
      ? Math.min(view.count, Math.max(0, input.animLimit))
      : view.count;
    const count = Math.min(revealed, positions.length >> 1);
    const halfWidth = this.viewWidth / 2;
    const halfHeight = this.viewHeight / 2;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i += 1) {
      const dx = (positions[i * 2] - camera.x) * camera.scale + halfWidth - screenX;
      const dy = (positions[i * 2 + 1] - camera.y) * camera.scale + halfHeight - screenY;
      const distance = dx * dx + dy * dy;
      if (distance >= bestDistance) continue;
      const modelIndex = view.nodesOf[i];
      const reach = this.screenRadius(input, modelIndex) + 6;
      if (distance > reach * reach) continue;
      bestDistance = distance;
      best = modelIndex;
    }
    return best;
  }
}
