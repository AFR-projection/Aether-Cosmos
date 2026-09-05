import type { DisplaySettings, GraphModel } from "./types";
import type { GraphView } from "./view";

/**
 * Celestial bodies: what kind of thing a node is, and the sprite that draws it.
 *
 * A field of identical discs at different sizes does not read as space, it reads as a
 * bubble chart. A brain has a natural hierarchy — a memory that ties a dozen others
 * together is not the same kind of object as a note nobody has linked yet — so the
 * hierarchy is drawn as different *bodies*: ringed giants, planets, moons, and stars
 * for the many small things at the edge of the graph.
 *
 * Every body is pre-rendered once per (colour, class) into an offscreen sprite and
 * then blitted per node. That is the whole trick behind the shading: a radial
 * gradient, a terminator, a specular highlight and a rim light per node would be a
 * paint object per node per frame — the exact cost this renderer refuses to pay —
 * but pre-rendered it is a single drawImage, which is cheaper than the four batched
 * arc passes it replaces and looks like a sphere instead of a circle.
 *
 * Sprites are built lazily and cached: a real graph uses a handful of group colours,
 * so the cache settles at a dozen or two 128px surfaces and never grows again.
 */

export type BodyClass = "star" | "moon" | "planet" | "giant";

export const BODY_CLASSES: readonly BodyClass[] = ["star", "moon", "planet", "giant"];

/**
 * How much of the graph hangs off this node. Degree counts for a third, so many weak
 * relations still read as busier than one strong one, and importance nudges memories.
 * The same number drives both the radius and the body class, so size and kind can
 * never disagree.
 */
export function nodeMass(input: {
  model: GraphModel;
  view: GraphView;
  modelIndex: number;
}): number {
  const { model, view, modelIndex } = input;
  const degree = view.visibleDegree[modelIndex] ?? 0;
  const strength = view.visibleStrength[modelIndex] ?? 0;
  const node = model.nodes[modelIndex];
  const importance = node?.kind === "memory" ? node.importance ?? 0.5 : 0.5;
  return degree * 0.35 + strength + importance * 0.4;
}

/**
 * Thresholds chosen against real graphs rather than round numbers: an unlinked note
 * lands under 1.2, a note with a couple of relations under 3.6, an entity holding a
 * cluster under 9, and the handful of things everything hangs off above it.
 */
export function bodyClass(mass: number): BodyClass {
  if (!(mass > 1.2)) return "star";
  if (mass < 3.2) return "moon";
  if (mass < 6.5) return "planet";
  return "giant";
}

/**
 * Below this on-screen radius a body is too small to shade: whatever class it is, it
 * is a distant point of light, and drawing a ringed giant into four pixels is mush.
 */
export const DETAIL_RADIUS = 3.4;

/** Sprite resolution. Bodies are never drawn near this size, so it is plenty. */
export const SPRITE_SIZE = 128;
/**
 * How far a sprite reaches past the body's own radius, for atmosphere, rings and
 * spikes. The draw box is `radius * BODY_EXTENT`, so the body itself occupies the
 * middle of the sprite and never clips its own glow.
 */
export const BODY_EXTENT = 2.15;

/** Light comes from up and to the left, for every body in the graph. */
const LIGHT_X = -0.56;
const LIGHT_Y = -0.63;

type Rgb = readonly [number, number, number];

const FALLBACK_RGB: Rgb = [154, 164, 190];

function parseColor(color: string): Rgb {
  const hex = color.trim();
  if (hex.startsWith("#")) {
    const body = hex.length === 4
      ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
      : hex.slice(1, 7);
    const value = Number.parseInt(body, 16);
    if (Number.isFinite(value) && body.length === 6) {
      return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }
  }
  return FALLBACK_RGB;
}

/** Towards white for t > 0, towards black for t < 0. */
function shade(rgb: Rgb, t: number): Rgb {
  const target = t >= 0 ? 255 : 0;
  const amount = Math.abs(t);
  return [
    Math.round(rgb[0] + (target - rgb[0]) * amount),
    Math.round(rgb[1] + (target - rgb[1]) * amount),
    Math.round(rgb[2] + (target - rgb[2]) * amount),
  ];
}

function css(rgb: Rgb, alpha = 1): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * Anything `drawImage` accepts. Structural rather than `HTMLCanvasElement` so the
 * same code paints sprites in a browser, in a test, and in the offline preview script
 * that renders frames to PNG with @napi-rs/canvas.
 */
export type SpriteSurface = {
  width: number;
  height: number;
  getContext(id: "2d"): unknown;
};

export type SurfaceFactory = (size: number) => SpriteSurface | null;

/** The browser's own factory, or null where there is no document to build one. */
export function domSurfaceFactory(): SurfaceFactory | null {
  if (typeof document === "undefined") return null;
  return (size: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    return canvas as unknown as SpriteSurface;
  };
}

const TAU = Math.PI * 2;

/** Sphere shading: gradient towards the light, terminator away from it. */
function paintSphere(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: Rgb) {
  const gradient = ctx.createRadialGradient(
    cx + LIGHT_X * r * 0.42,
    cy + LIGHT_Y * r * 0.42,
    r * 0.06,
    cx,
    cy,
    r
  );
  gradient.addColorStop(0, css(shade(rgb, 0.52)));
  gradient.addColorStop(0.42, css(rgb));
  gradient.addColorStop(0.86, css(shade(rgb, -0.46)));
  gradient.addColorStop(1, css(shade(rgb, -0.66)));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
}

/** The specular dot, where the light hits square on. */
function paintSpecular(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const x = cx + LIGHT_X * r * 0.44;
  const y = cy + LIGHT_Y * r * 0.44;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r * 0.34);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.34, 0, TAU);
  ctx.fill();
}

/**
 * The rim light on the dark limb — light scattered around the far edge. This is the
 * cue that actually turns a shaded circle into a ball; without it a sphere reads as a
 * flat disc with a gradient on it.
 */
function paintRim(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: Rgb) {
  const away = Math.atan2(-LIGHT_Y, -LIGHT_X);
  ctx.strokeStyle = css(shade(rgb, 0.72), 0.5);
  ctx.lineWidth = Math.max(0.8, r * 0.08);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.965, away - 1.15, away + 1.15);
  ctx.stroke();
}

/** Atmosphere: a soft shell just outside the body. */
function paintAtmosphere(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rgb: Rgb,
  strength: number
) {
  const outer = r * 1.62;
  const gradient = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, outer);
  gradient.addColorStop(0, css(shade(rgb, 0.2), 0.34 * strength));
  gradient.addColorStop(0.45, css(rgb, 0.14 * strength));
  gradient.addColorStop(1, css(rgb, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, TAU);
  ctx.fill();
}

/** Cloud bands, clipped to the body. Only giants get them. */
function paintBands(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: Rgb) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.99, 0, TAU);
  ctx.clip();
  const bands = [-0.52, -0.16, 0.2, 0.56];
  for (let i = 0; i < bands.length; i += 1) {
    ctx.fillStyle = css(shade(rgb, i % 2 === 0 ? -0.3 : 0.26), 0.22);
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * bands[i], r * 1.04, r * 0.115, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Half a ring system. `front` is the arc that passes in front of the body. */
function paintRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rgb: Rgb,
  front: boolean
) {
  const tilt = -0.34;
  const rx = r * 1.92;
  const ry = r * 0.5;
  const from = front ? 0 : Math.PI;
  const to = front ? Math.PI : TAU;
  const bright = css(shade(rgb, 0.55), front ? 0.6 : 0.36);
  const faint = css(shade(rgb, 0.3), front ? 0.34 : 0.2);
  ctx.lineWidth = Math.max(0.7, r * 0.2);
  ctx.strokeStyle = bright;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, tilt, from, to);
  ctx.stroke();
  // A second, thinner band inside the first: the gap is what reads as a ring system
  // rather than as a hoop.
  ctx.lineWidth = Math.max(0.5, r * 0.1);
  ctx.strokeStyle = faint;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.74, ry * 0.74, tilt, from, to);
  ctx.stroke();
}

/**
 * A star: a core that blows out to white, a halo, and four diffraction spikes. Drawn
 * for the many small nodes at the edge of a graph, where a shaded ball would be four
 * grey pixels and a point of light is both cheaper and more honest.
 */
function paintStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: Rgb) {
  // A tight, hot core with a short halo. A wide soft glow would read as a smudge at
  // the size these are actually drawn, and there are hundreds of them on screen.
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.35);
  halo.addColorStop(0, "rgba(255, 255, 255, 0.98)");
  halo.addColorStop(0.16, css(shade(rgb, 0.72), 0.9));
  halo.addColorStop(0.42, css(shade(rgb, 0.15), 0.42));
  halo.addColorStop(1, css(rgb, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.35, 0, TAU);
  ctx.fill();

  // Spikes: two crossed slivers, long and thin, fading to nothing at the tips.
  const reach = r * 2.05;
  const waist = Math.max(0.5, r * 0.13);
  for (let axis = 0; axis < 2; axis += 1) {
    const gradient = ctx.createLinearGradient(
      axis === 0 ? cx - reach : cx,
      axis === 0 ? cy : cy - reach,
      axis === 0 ? cx + reach : cx,
      axis === 0 ? cy : cy + reach
    );
    gradient.addColorStop(0, css(shade(rgb, 0.6), 0));
    gradient.addColorStop(0.42, css(shade(rgb, 0.75), 0.42));
    gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.7)");
    gradient.addColorStop(0.58, css(shade(rgb, 0.75), 0.42));
    gradient.addColorStop(1, css(shade(rgb, 0.6), 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    if (axis === 0) {
      ctx.moveTo(cx - reach, cy);
      ctx.lineTo(cx, cy - waist);
      ctx.lineTo(cx + reach, cy);
      ctx.lineTo(cx, cy + waist);
    } else {
      ctx.moveTo(cx, cy - reach);
      ctx.lineTo(cx + waist, cy);
      ctx.lineTo(cx, cy + reach);
      ctx.lineTo(cx - waist, cy);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Lazily built, permanently cached sprites, keyed by colour and class. A graph uses a
 * handful of group colours, so this settles at a dozen or two surfaces on the first
 * few frames and never allocates again.
 */
export class BodySprites {
  private cache = new Map<string, SpriteSurface>();

  constructor(private readonly factory: SurfaceFactory | null) {}

  /** Null when there is no surface factory — the caller then draws flat discs. */
  get(color: string, body: BodyClass): SpriteSurface | null {
    if (!this.factory) return null;
    const key = `${body}|${color}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const surface = this.factory(SPRITE_SIZE);
    if (!surface) return null;
    const ctx = surface.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    this.paint(ctx, color, body);
    this.cache.set(key, surface);
    return surface;
  }

  private paint(ctx: CanvasRenderingContext2D, color: string, body: BodyClass): void {
    const rgb = parseColor(color);
    const centre = SPRITE_SIZE / 2;
    // The body's own radius inside the sprite. Everything past it — atmosphere,
    // rings, spikes — lives in the margin BODY_EXTENT reserves.
    const r = centre / BODY_EXTENT;
    ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

    if (body === "star") {
      paintStar(ctx, centre, centre, r, rgb);
      return;
    }
    if (body === "giant") paintRing(ctx, centre, centre, r, rgb, false);
    paintAtmosphere(ctx, centre, centre, r, rgb, body === "moon" ? 0.45 : 1);
    paintSphere(ctx, centre, centre, r, rgb);
    if (body === "giant") paintBands(ctx, centre, centre, r, rgb);
    paintRim(ctx, centre, centre, r, rgb);
    paintSpecular(ctx, centre, centre, r);
    if (body === "giant") paintRing(ctx, centre, centre, r, rgb, true);
  }
}
