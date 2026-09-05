/**
 * The sky the graph sits in.
 *
 * A knowledge graph is a map of things that are far apart and connected anyway,
 * which is the one metaphor space already owns — so the ground is not a flat fill
 * but a deep-field wash with a parallax starfield over it. Panning then reads as
 * travelling rather than as scrolling a diagram.
 *
 * Three rules keep it a backdrop instead of a distraction:
 *
 * - Everything is derived from the brain id, so a brain always opens onto the same
 *   sky. Stars that re-scattered on every remount would be noise, not a place.
 * - Stars live in a tile that is wrapped across the viewport, so the field is
 *   endless without storing an endless number of them. Each plane wraps on its own
 *   period, so the three never line up into a visible lattice.
 * - Star alpha is quantised to three steps per plane and the stars are generated in
 *   that order, which lets the painter draw a whole plane in three fill() calls.
 *   Per-star alpha would mean per-star fill(), and eight hundred fill() calls a
 *   frame is how a backdrop starts costing more than the graph.
 */

/** Packed as [x, y, radius, alpha] per star. */
const STAR_STRIDE = 4;

/** Ceiling for a star, so the backdrop never competes with the nodes. */
export const MAX_STAR_ALPHA = 0.9;
/** Ceiling for a nebula: an atmosphere, not a lava lamp. */
export const MAX_NEBULA_ALPHA = 0.075;

export type StarField = {
  /** Share of the camera's motion this plane follows. Low is far away. */
  parallax: number;
  /** Wrap period in screen pixels. Distinct per plane on purpose. */
  tile: number;
  count: number;
  minRadius: number;
  maxRadius: number;
  /** Three brightness steps, dim to bright. Batching depends on there being few. */
  alphaSteps: readonly [number, number, number];
  /** Round stars are worth an arc; sub-pixel ones are not. */
  round: boolean;
};

/**
 * Three planes, far to near. Tiles are smaller than a typical viewport so a decent
 * share of each plane is on screen at any moment — a tile wider than the canvas hides
 * most of its own stars — and they are mutually indivisible, so the three grids never
 * line up into a lattice as the camera pans.
 */
export const STAR_FIELDS: readonly StarField[] = [
  { parallax: 0.15, tile: 900, count: 128, minRadius: 0.6, maxRadius: 1.05, alphaSteps: [0.26, 0.4, 0.58], round: false },
  { parallax: 0.34, tile: 1150, count: 84, minRadius: 0.85, maxRadius: 1.45, alphaSteps: [0.36, 0.54, 0.72], round: true },
  { parallax: 0.62, tile: 1450, count: 42, minRadius: 1.15, maxRadius: 2, alphaSteps: [0.48, 0.66, 0.86], round: true },
];

/** How the count is split across the three brightness steps: many dim, few bright. */
const STEP_SHARE = [0.55, 0.3, 0.15] as const;

export type SkyPlane = {
  parallax: number;
  tile: number;
  count: number;
  /** [x, y, radius, alpha] per star, generated dim-to-bright so alpha runs group. */
  stars: Float32Array;
  round: boolean;
};

/**
 * One faint cloud, positioned as a fraction of the viewport rather than of the
 * world: it is a wash on the lens, so it stays put while the stars stream past.
 * Anchoring it in world space would let a long pan leave the graph in flat black.
 */
export type Nebula = {
  fx: number;
  fy: number;
  /** Radius as a fraction of the viewport diagonal. */
  fr: number;
  alpha: number;
  /** Index into the theme's nebula tints. */
  tint: number;
};

export type Sky = {
  seed: number;
  planes: SkyPlane[];
  nebulae: Nebula[];
};

const NEBULA_COUNT = 3;

/** FNV-1a. Turns a brain id into the seed for its sky. */
export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, and the same sequence in every browser and in tests. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Positive modulo. JS `%` keeps the sign of the dividend, so the naive version hands
 * back a negative offset as soon as the camera pans left of the origin — which tears
 * a blank band across the sky exactly where the tiling should have wrapped.
 */
export function wrapOffset(value: number, tile: number): number {
  if (!Number.isFinite(value) || !(tile > 0)) return 0;
  return ((value % tile) + tile) % tile;
}

export function buildSky(seed: number): Sky {
  const planes = STAR_FIELDS.map((field, index) => {
    // A different stream per plane, or the three would be scaled copies of each other.
    const next = random(seed + index * 0x9e3779b9);
    const stars = new Float32Array(field.count * STAR_STRIDE);
    const span = field.maxRadius - field.minRadius;
    let cursor = 0;
    for (let step = 0; step < field.alphaSteps.length; step += 1) {
      const last = step === field.alphaSteps.length - 1;
      // The last step takes the remainder, so rounding never loses or invents a star.
      const many = last ? field.count - cursor : Math.round(field.count * STEP_SHARE[step]);
      const alpha = field.alphaSteps[step];
      // Brighter stars are the bigger ones: the two cues have to agree, or the field
      // reads as static rather than as depth.
      const floor = field.minRadius + (span * step) / field.alphaSteps.length;
      const ceiling = field.minRadius + (span * (step + 1)) / field.alphaSteps.length;
      for (let i = 0; i < many && cursor < field.count; i += 1, cursor += 1) {
        const at = cursor * STAR_STRIDE;
        stars[at] = next() * field.tile;
        stars[at + 1] = next() * field.tile;
        stars[at + 2] = floor + next() * (ceiling - floor);
        stars[at + 3] = alpha;
      }
    }
    return { parallax: field.parallax, tile: field.tile, count: field.count, stars, round: field.round };
  });

  const next = random(seed ^ 0x5bf03635);
  const nebulae: Nebula[] = [];
  for (let i = 0; i < NEBULA_COUNT; i += 1) {
    nebulae.push({
      fx: 0.12 + next() * 0.76,
      fy: 0.12 + next() * 0.76,
      fr: 0.34 + next() * 0.28,
      alpha: 0.028 + next() * (MAX_NEBULA_ALPHA - 0.028),
      tint: i,
    });
  }

  return { seed, planes, nebulae };
}

// ── painting ────────────────────────────────────────────────────────────────
//
// Colours arrive as plain values rather than as a theme object, so this module
// stays independent of ./theme.ts and can be reasoned about as pure drawing.

/** Camera shape, structural on purpose: no import from the renderer. */
type CameraLike = { x: number; y: number; scale: number };

/** RGB triplet. Alpha is applied here, so the caller never builds colour strings. */
export type Tint = readonly [number, number, number];

/**
 * The ground: a wide radial wash, lighter at the centre than at the corners. Never
 * a flat fill — a single tone across two thousand pixels is what makes a canvas look
 * like an empty div — and never pure black, which smears on OLED panels.
 */
export function paintDeepSpace(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  core: string,
  edge: string
): void {
  const gradient = ctx.createRadialGradient(
    width / 2,
    height * 0.42,
    0,
    width / 2,
    height * 0.42,
    Math.hypot(width, height) * 0.72
  );
  gradient.addColorStop(0, core);
  gradient.addColorStop(1, edge);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/** Faint clouds over the ground. One gradient each, filled to their own box only. */
export function paintNebula(
  ctx: CanvasRenderingContext2D,
  sky: Sky,
  width: number,
  height: number,
  tints: readonly Tint[],
  /** Seconds of ambient time, or -1 for a still frame. */
  phase = -1
): void {
  if (tints.length === 0) return;
  const diagonal = Math.hypot(width, height);
  for (let i = 0; i < sky.nebulae.length; i += 1) {
    const cloud = sky.nebulae[i];
    // A very slow drift, a couple of percent of the viewport. Enough that the sky is
    // never quite the same twice; far too slow to notice as motion.
    const driftX = phase >= 0 ? Math.sin(phase * 0.045 + i * 2.1) * 0.022 : 0;
    const driftY = phase >= 0 ? Math.cos(phase * 0.037 + i * 1.3) * 0.018 : 0;
    const x = (cloud.fx + driftX) * width;
    const y = (cloud.fy + driftY) * height;
    const radius = cloud.fr * diagonal;
    const [r, g, b] = tints[cloud.tint % tints.length];
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${cloud.alpha})`);
    gradient.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${cloud.alpha * 0.34})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

/**
 * The starfield. Each plane is wrapped across the viewport from its own tile and
 * drawn in three fill() calls — one per brightness step, which the generator already
 * laid out contiguously. Nine fill() calls for the whole sky, at any camera.
 *
 * Offsets follow `camera.x * scale`, not `camera.x`: the parallax is a screen-space
 * effect, so a pan at 4x zoom has to sweep the stars four times as fast to stay
 * attached to the graph moving underneath it.
 */
export function paintStars(
  ctx: CanvasRenderingContext2D,
  sky: Sky,
  camera: CameraLike,
  width: number,
  height: number,
  color: string,
  /** Seconds of ambient time, or -1 for a still frame. */
  phase = -1
): void {
  ctx.fillStyle = color;
  for (let plane = 0; plane < sky.planes.length; plane += 1) {
    const { tile, stars, count, round } = sky.planes[plane];
    const shiftX = wrapOffset(camera.x * camera.scale * sky.planes[plane].parallax, tile);
    const shiftY = wrapOffset(camera.y * camera.scale * sky.planes[plane].parallax, tile);
    // Only the nearest plane twinkles, and only when ambient time is running: it is
    // the smallest field, so per-star alpha there costs a few dozen fills rather than
    // a few hundred, and distant stars twinkling less is how the sky actually works.
    const twinkling = phase >= 0 && plane === sky.planes.length - 1;
    let index = 0;
    while (index < count) {
      const alpha = stars[index * STAR_STRIDE + 3];
      let end = index + 1;
      while (end < count && stars[end * STAR_STRIDE + 3] === alpha) end += 1;
      if (!twinkling) ctx.globalAlpha = alpha;
      if (!twinkling) ctx.beginPath();
      for (let i = index; i < end; i += 1) {
        const at = i * STAR_STRIDE;
        const radius = stars[at + 2];
        const originX = wrapOffset(stars[at] - shiftX, tile);
        const originY = wrapOffset(stars[at + 1] - shiftY, tile);
        if (twinkling) {
          ctx.globalAlpha = alpha * (0.55 + 0.45 * Math.sin(phase * 1.15 + i * 1.7));
          ctx.beginPath();
        }
        for (let y = originY; y < height + radius; y += tile) {
          for (let x = originX; x < width + radius; x += tile) {
            if (round) {
              ctx.moveTo(x + radius, y);
              ctx.arc(x, y, radius, 0, Math.PI * 2);
            } else {
              ctx.rect(x, y, radius, radius);
            }
          }
        }
        if (twinkling) ctx.fill();
      }
      if (!twinkling) ctx.fill();
      index = end;
    }
  }
  ctx.globalAlpha = 1;
}
