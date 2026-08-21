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
 * edges into one path for the dim set and one for the highlighted set.
 *
 * World coordinates come straight from the simulation; this module converts to
 * screen space by hand rather than with ctx.setTransform, so radii and line widths
 * stay in device-independent pixels at every zoom level (thin edges stay thin).
 */

export type Camera = { x: number; y: number; scale: number };

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, scale: 1 };
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export type GraphTheme = {
  background: string;
  node: string;
  edge: string;
  edgeActive: string;
  label: string;
  accent: string;
};

/**
 * Deliberately dark in both themes: the graph is a viewport into the brain, and
 * subtle grey edges only read against a dark ground. Only the accent is taken
 * from the app tokens so highlights match the rest of the UI.
 */
export const FALLBACK_THEME: GraphTheme = {
  background: "#0d1117",
  node: "#9aa0b2",
  edge: "rgba(148, 163, 184, 0.38)",
  edgeActive: "#818cf8",
  label: "rgba(226, 232, 240, 0.92)",
  accent: "#818cf8",
};

export function readGraphTheme(element: HTMLElement | null): GraphTheme {
  if (!element || typeof window === "undefined") return FALLBACK_THEME;
  const accent = getComputedStyle(element).getPropertyValue("--accent").trim();
  if (!accent) return FALLBACK_THEME;
  return { ...FALLBACK_THEME, accent, edgeActive: accent };
}

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
};

const DIM_ALPHA = 0.20;
/** Above this many nodes on screen, labels are reserved for what is highlighted. */
const LABEL_NODE_BUDGET = 240;
/** While the layout moves, draw at most this many edges (strided, so evenly). */
const EDGE_BUDGET_MOVING = 3000;
/** Direction chevrons are a detail: only worth drawing on a settled, small graph. */
const ARROW_BUDGET = 900;
const LABEL_FONT = "500 11px ui-sans-serif, system-ui, -apple-system, sans-serif";

/**
 * Edge strength buckets. A shared tag and a link the user stored must not look
 * alike, so weight is drawn rather than merely stored: three buckets is the
 * coarsest split that still reads as three tiers, and keeping it to three means the
 * whole edge set is three stroke() calls whatever the graph size.
 */
const EDGE_WEAK_MAX = 0.3;
const EDGE_MEDIUM_MAX = 0.6;
const EDGE_BUCKET_ALPHA = [0.42, 0.7, 1];
const EDGE_BUCKET_WIDTH = [0.7, 1, 1.45];

function edgeBucket(weight: number): number {
  if (weight < EDGE_WEAK_MAX) return 0;
  if (weight < EDGE_MEDIUM_MAX) return 1;
  return 2;
}

/**
 * Size follows how strongly a node is connected, not just how often: degree still
 * counts, but a node held by weak shared-tag edges must not look like a node the
 * user linked by hand. `sqrt` keeps the growth gentle — a hub with twelve strong
 * edges ends up about twice the radius of a leaf, not twelve times its area.
 * Importance nudges memories, which is the only per-node signal the rows carry.
 */
export function nodeRadius(input: {
  model: GraphModel;
  view: GraphView;
  display: DisplaySettings;
  modelIndex: number;
}): number {
  const { model, view, display, modelIndex } = input;
  const degree = view.visibleDegree[modelIndex] ?? 0;
  const strength = view.visibleStrength[modelIndex] ?? 0;
  const node = model.nodes[modelIndex];
  const importance = node.kind === "memory" ? node.importance ?? 0.5 : 0.5;
  // Degree carries a third of the weight so that many weak relations still read as
  // a busier node than one weak relation does.
  const mass = degree * 0.35 + strength;
  return (2.4 + Math.sqrt(mass) * 1.5 + importance * 1.1) * display.nodeScale;
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
   * Per-frame scratch, grown but never shrunk. Screen coordinates are computed
   * once and reused by the edge, node and label passes; the bucket arrays sort
   * nodes by (colour, dimmed) with a counting sort so each colour is one fill().
   */
  private screen = new Float32Array(0);
  private slotOf = new Int32Array(0);
  private order = new Int32Array(0);
  private slotStart = new Int32Array(0);
  private slotCursor = new Int32Array(0);

  constructor(private readonly canvas: HTMLCanvasElement) {
    // alpha:false lets the compositor skip blending the canvas against the page.
    this.ctx = canvas.getContext("2d", { alpha: false });
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

  /** Projects the visible nodes into `this.screen` and returns how many there are. */
  private project(input: RenderInput): number {
    const { view, positions, camera } = input;
    const count = Math.min(view.count, positions.length >> 1);
    if (this.screen.length < count * 2) this.screen = new Float32Array(count * 2 + 512);
    const screen = this.screen;
    const halfWidth = this.viewWidth / 2;
    const halfHeight = this.viewHeight / 2;
    const scale = camera.scale;
    for (let i = 0; i < count; i += 1) {
      screen[i * 2] = (positions[i * 2] - camera.x) * scale + halfWidth;
      screen[i * 2 + 1] = (positions[i * 2 + 1] - camera.y) * scale + halfHeight;
    }
    return count;
  }

  draw(input: RenderInput): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.fillStyle = input.theme.background;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
    const projected = this.project(input);
    if (projected === 0) return;
    // Timelapse: clip the local index range once, here, so edges, labels and rings
    // appear together with their nodes instead of hanging in empty space.
    const count = input.display.animate
      ? Math.min(projected, Math.max(0, input.animLimit))
      : projected;
    if (count === 0) return;
    this.drawEdges(input, count);
    this.drawArrows(input, count);
    const drawn = this.drawNodes(input, count);
    this.drawLabels(input, count, drawn);
    this.drawRings(input, count);
  }

  /**
   * Three paths for the dim set — one per strength bucket — plus one for the
   * highlighted set, never one path per edge. Bucketing into Path2D objects keeps a
   * single walk over the edge list while still giving each tier its own alpha and
   * width. While the layout is still moving a stride thins the dim set instead of
   * dropping its tail, so the graph reads as a whole rather than as a half-drawn
   * corner.
   */
  private drawEdges(input: RenderInput, count: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { model, view, display, theme, camera, highlightEdges } = input;
    const edges = view.edgeIndexes;
    const total = edges.length;
    if (total === 0) return;
    const weights = view.linkWeights;
    const screen = this.screen;
    const localOf = view.localOf;
    const margin = 80;
    const maxX = this.viewWidth + margin;
    const maxY = this.viewHeight + margin;
    const stride =
      input.moving && total > EDGE_BUDGET_MOVING ? Math.ceil(total / EDGE_BUDGET_MOVING) : 1;

    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let e = 0; e < total; e += stride) {
      const modelEdge = edges[e];
      if (highlightEdges && highlightEdges[modelEdge]) continue;
      const edge = model.edges[modelEdge];
      const source = localOf[edge.source];
      const target = localOf[edge.target];
      if (source < 0 || target < 0 || source >= count || target >= count) continue;
      const x1 = screen[source * 2];
      const y1 = screen[source * 2 + 1];
      const x2 = screen[target * 2];
      const y2 = screen[target * 2 + 1];
      if (x1 < -margin && x2 < -margin) continue;
      if (y1 < -margin && y2 < -margin) continue;
      if (x1 > maxX && x2 > maxX) continue;
      if (y1 > maxY && y2 > maxY) continue;
      const path = paths[edgeBucket(weights[e] ?? 1)];
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    }

    const base = Math.max(0.4, 0.7 * display.linkScale * Math.min(1.6, camera.scale));
    const dim = highlightEdges ? 0.45 : 1;
    ctx.strokeStyle = theme.edge;
    for (let bucket = 0; bucket < paths.length; bucket += 1) {
      ctx.globalAlpha = EDGE_BUCKET_ALPHA[bucket] * dim;
      ctx.lineWidth = Math.max(0.4, base * EDGE_BUCKET_WIDTH[bucket]);
      ctx.stroke(paths[bucket]);
    }
    ctx.globalAlpha = 1;
    if (highlightEdges) this.drawActiveEdges(input, count, highlightEdges);
  }

  private drawActiveEdges(input: RenderInput, count: number, active: Uint8Array): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { model, view, display, theme } = input;
    const edges = view.edgeIndexes;
    const weights = view.linkWeights;
    const screen = this.screen;
    const localOf = view.localOf;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let e = 0; e < edges.length; e += 1) {
      const modelEdge = edges[e];
      if (!active[modelEdge]) continue;
      const edge = model.edges[modelEdge];
      const source = localOf[edge.source];
      const target = localOf[edge.target];
      if (source < 0 || target < 0 || source >= count || target >= count) continue;
      const path = paths[edgeBucket(weights[e] ?? 1)];
      path.moveTo(screen[source * 2], screen[source * 2 + 1]);
      path.lineTo(screen[target * 2], screen[target * 2 + 1]);
    }
    ctx.strokeStyle = theme.edgeActive;
    ctx.globalAlpha = 0.95;
    for (let bucket = 0; bucket < paths.length; bucket += 1) {
      // The highlighted set keeps its full opacity — the strength difference is
      // carried by width alone here, so a hovered neighbourhood stays legible.
      ctx.lineWidth = Math.max(0.9, 1.1 * display.linkScale * EDGE_BUCKET_WIDTH[bucket]);
      ctx.stroke(paths[bucket]);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Direction chevrons, stopping short of the target node so the arrow reads as
   * pointing *at* it. Skipped entirely while moving and on large graphs — the
   * detail is invisible at that density and costs two extra segments per edge.
   */
  private drawArrows(input: RenderInput, count: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { model, view, display, theme, camera, highlightEdges } = input;
    const edges = view.edgeIndexes;
    if (!display.showArrows || input.moving || edges.length > ARROW_BUDGET) return;
    const screen = this.screen;
    const localOf = view.localOf;
    const size = Math.max(3, 4.5 * Math.min(1.5, camera.scale));
    ctx.lineWidth = Math.max(0.6, 0.9 * display.linkScale);
    for (let pass = 0; pass < 2; pass += 1) {
      const wantActive = pass === 1;
      if (wantActive && !highlightEdges) break;
      ctx.strokeStyle = wantActive ? theme.edgeActive : theme.edge;
      ctx.globalAlpha = wantActive ? 0.95 : highlightEdges ? 0.4 : 0.85;
      ctx.beginPath();
      for (let e = 0; e < edges.length; e += 1) {
        const modelEdge = edges[e];
        const isActive = highlightEdges ? highlightEdges[modelEdge] === 1 : false;
        if (isActive !== wantActive) continue;
        const edge = model.edges[modelEdge];
        const source = localOf[edge.source];
        const target = localOf[edge.target];
        if (source < 0 || target < 0 || source >= count || target >= count) continue;
        const x1 = screen[source * 2];
        const y1 = screen[source * 2 + 1];
        const x2 = screen[target * 2];
        const y2 = screen[target * 2 + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length < 1) continue;
        const ux = dx / length;
        const uy = dy / length;
        const radius = this.screenRadius(input, edge.target);
        const tipX = x2 - ux * (radius + 1);
        const tipY = y2 - uy * (radius + 1);
        ctx.moveTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

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
   * Nodes, bucketed by (group colour, dimmed) with a counting sort so the whole
   * graph is one fill() per bucket — a few dozen draw calls instead of thousands.
   * Returns how many nodes survived culling, which the label budget then uses.
   */
  private drawNodes(input: RenderInput, count: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const { view, groups, highlightNodes } = input;
    const colors = groups.colors;
    const slots = colors.length * 2;
    if (this.slotOf.length < count) this.slotOf = new Int32Array(count + 512);
    if (this.order.length < count) this.order = new Int32Array(count + 512);
    if (this.slotStart.length < slots + 1) {
      this.slotStart = new Int32Array(slots + 1);
      this.slotCursor = new Int32Array(slots + 1);
    }
    const { slotOf, order, slotStart, slotCursor, screen } = this;
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

    for (let slot = 0; slot < slots; slot += 1) {
      const start = slotStart[slot];
      const end = slotStart[slot + 1];
      if (start === end) continue;
      ctx.fillStyle = colors[slot >> 1];
      ctx.globalAlpha = slot & 1 ? 1 : DIM_ALPHA;
      ctx.beginPath();
      for (let k = start; k < end; k += 1) {
        const i = order[k];
        const radius = this.screenRadius(input, view.nodesOf[i]);
        const x = screen[i * 2];
        const y = screen[i * 2 + 1];
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, TAU);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return drawn;
  }

  /**
   * Labels are the first thing to go: below a zoom threshold, while the layout is
   * moving, or past the node budget they are reserved for the highlighted set, so a
   * 4000-node graph never pays for 4000 text measurements per frame.
   */
  private drawLabels(input: RenderInput, count: number, drawn: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { display, view, model, theme, camera, highlightNodes, hover, selected } = input;
    if (!display.showLabels) return;
    const minScale = display.textFadeThreshold * 1.2;
    const labelAll = !input.moving && drawn <= LABEL_NODE_BUDGET && camera.scale >= minScale;
    if (!labelAll && !highlightNodes && hover < 0 && selected < 0 && input.focal < 0) return;
    const { slotOf, screen } = this;
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.label;
    for (let i = 0; i < count; i += 1) {
      const slot = slotOf[i];
      if (slot < 0) continue;
      const modelIndex = view.nodesOf[i];
      const bright = (slot & 1) === 1;
      const focused = modelIndex === hover || modelIndex === selected || modelIndex === input.focal;
      if (!bright && !focused) continue;
      if (!labelAll && !focused && !highlightNodes) continue;
      const radius = this.screenRadius(input, modelIndex);
      ctx.fillText(
        truncateLabel(model.nodes[modelIndex].label),
        screen[i * 2],
        screen[i * 2 + 1] + radius + 3
      );
    }
  }

  private drawRings(input: RenderInput, count: number): void {
    this.markFocal(input, count);
    this.strokeRing(input, count, input.hover, input.theme.label, 1.2, 3);
    this.strokeRing(input, count, input.selected, input.theme.accent, 2, 3);
  }

  /**
   * The local graph's centre. Obsidian paints the current note distinctly rather
   * than leaving it to be found by position, so it gets the accent fill, a halo and
   * a ring — visible even when a group colour would otherwise own the node.
   */
  private markFocal(input: RenderInput, count: number): void {
    const ctx = this.ctx;
    const modelIndex = input.focal;
    if (!ctx || modelIndex < 0 || modelIndex >= input.view.localOf.length) return;
    const local = input.view.localOf[modelIndex];
    if (local < 0 || local >= count) return;
    const x = this.screen[local * 2];
    const y = this.screen[local * 2 + 1];
    const radius = this.screenRadius(input, modelIndex);
    ctx.fillStyle = input.theme.accent;
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(x, y, radius + 7, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = input.theme.accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, TAU);
    ctx.stroke();
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
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(
      this.screen[local * 2],
      this.screen[local * 2 + 1],
      this.screenRadius(input, modelIndex) + padding,
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
