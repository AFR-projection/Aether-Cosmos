import type { GraphEdgeRelation } from "./types";

/**
 * How one edge is shaped and tiered, as arithmetic the draw loop can trust.
 *
 * The renderer walks every visible edge on every frame, so nothing here allocates
 * and nothing here reads colour: tiering answers *which batch* an edge belongs to
 * (one Path2D per batch, a fixed number of stroke() calls whatever the graph size)
 * and the geometry answers *where the curve goes*. Colour for each tier lives in
 * @brain/presentation/canvas/theme.ts, which keeps this module free of the theme and
 * the theme free of geometry.
 *
 * Curves rather than segments, because a graph of straight centre-to-centre lines
 * reads as a diagram: two relationships between the same pair collapse into one
 * stroke, and every line stabs through the circles at both ends. A quadratic with a
 * perpendicular control point fixes both for the cost of `quadraticCurveTo` instead
 * of `lineTo`, and at `curve: 0` the control point lands on the midpoint — which is
 * exactly the straight segment again, so the flat look stays one slider away.
 */

/**
 * The three tiers the panel filters on. Shared tags, shared entities and a shared
 * project are one tier: they all mean "these two sit in the same surroundings", and
 * three separate colours would spend the palette on a distinction nobody reads.
 */
export type EdgeTier = "explicit" | "semantic" | "context";

export const EDGE_TIERS = ["explicit", "semantic", "context"] as const;

/** Must agree with `tierVisible` in ./view.ts, or a legend swatch would lie. */
export function edgeTier(relation: GraphEdgeRelation): EdgeTier {
  switch (relation) {
    case "explicit":
      return "explicit";
    case "semantic":
      return "semantic";
    default:
      return "context";
  }
}

/**
 * Weight buckets. A shared tag and a link the user stored must not look alike, so
 * strength is drawn rather than merely stored. Three is the coarsest split that
 * still reads as three tiers.
 */
export const EDGE_WEAK_MAX = 0.3;
export const EDGE_MEDIUM_MAX = 0.6;
export const EDGE_BUCKETS = 3;
export const EDGE_SLOTS = EDGE_TIERS.length * EDGE_BUCKETS;

export function edgeBucket(weight: number): number {
  // Written as two upward tests so a NaN weight lands in the last bucket rather
  // than escaping the range: an unpainted edge is worse than a bold one.
  if (weight < EDGE_WEAK_MAX) return 0;
  if (weight < EDGE_MEDIUM_MAX) return 1;
  return EDGE_BUCKETS - 1;
}

/** Batch index for an edge: tier picks the colour, bucket picks alpha and width. */
export function edgeSlot(relation: GraphEdgeRelation, weight: number): number {
  return EDGE_TIERS.indexOf(edgeTier(relation)) * EDGE_BUCKETS + edgeBucket(weight);
}

/** Per-bucket paint, indexed by `edgeBucket`. */
export const EDGE_BUCKET_ALPHA = [0.42, 0.7, 1] as const;
export const EDGE_BUCKET_WIDTH = [0.7, 1, 1.45] as const;

/**
 * Per-tier paint. Context edges are by far the most numerous, so they are the
 * quietest: the tier that would otherwise turn the canvas into a mesh is the one
 * that recedes, and a link the user stored by hand is the one that carries.
 */
export const EDGE_TIER_ALPHA: Record<EdgeTier, number> = {
  explicit: 1,
  semantic: 0.82,
  context: 0.62,
};

export const EDGE_TIER_WIDTH: Record<EdgeTier, number> = {
  explicit: 1.15,
  semantic: 1,
  context: 0.8,
};

/**
 * Dash patterns, in device-independent pixels. Shape carries the tier as well as
 * colour does, so the three kinds of relationship stay apart for anyone who cannot
 * separate indigo from violet — and stay apart in a screenshot printed in grey.
 */
export const EDGE_TIER_DASH: Record<EdgeTier, readonly number[] | null> = {
  explicit: null,
  semantic: [5, 4],
  context: [1.5, 4],
};

/** How far a bow may travel from the chord, in screen pixels. */
export const MAX_BOW = 48;
/** Bow at `curve: 1`, as a fraction of the edge's own length. */
const BOW_RATIO = 0.18;
/** Below this many pixels an edge is a dot; curving it would only wobble. */
const MIN_LENGTH = 1;

/**
 * Which way an edge bows. Derived from the edge's own index, so it is the same on
 * every frame (a sign that flickered would make the graph twitch) and differs
 * between neighbouring edges (two relationships between the same pair have to
 * separate instead of stacking). Integer hash, no allocation, no Math.random.
 */
export function curveSign(seed: number): 1 | -1 {
  let hash = (seed | 0) ^ 0x9e3779b9;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  hash ^= hash >>> 15;
  return (hash & 1) === 0 ? 1 : -1;
}

/** A quadratic: the two docking points plus the control point that bends it. */
export type EdgeGeometry = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
};

/**
 * Screen-space geometry for one edge, or null when there is nothing worth drawing.
 *
 * Endpoints are pulled back to each node's rim along the curve's own tangent — for
 * a quadratic that is the direction of the control point, so the line meets the
 * circle head-on however hard it bows. The clearance test up front is what
 * guarantees the two docking points can never cross: together they retreat by less
 * than the full chord, so the line always still points from source to target.
 *
 * `out` exists for the draw loop, which calls this once per edge per frame and hands
 * the result straight to a Path2D: a fresh object per edge would be thousands of
 * short-lived allocations a second. Callers that keep the result (the tests) simply
 * omit it and get their own object.
 */
export function edgeGeometry(
  input: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** Screen radius of each endpoint, so the line stops at the planet's edge. */
    r1: number;
    r2: number;
    /** Breathing room between the rim and the line. */
    gap?: number;
    /** The edge's index: only used to pick which way it bows. */
    seed: number;
    /** 0..1 from the panel. 0 reproduces the straight segment exactly. */
    curve: number;
  },
  out?: EdgeGeometry
): EdgeGeometry | null {
  const { x1, y1, x2, y2, r1, r2, seed, curve } = input;
  const gap = input.gap ?? 1.5;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (!(length > MIN_LENGTH)) return null;
  const clearance = r1 + r2 + gap * 2;
  if (length <= clearance) return null;

  const bow = curve > 0 ? Math.min(MAX_BOW, curve * BOW_RATIO * length) * curveSign(seed) : 0;
  // Perpendicular to (dx, dy) is (-dy, dx); at bow 0 this is the plain midpoint,
  // and a quadratic through its own midpoint is the straight segment.
  const cx = (x1 + x2) / 2 - (dy / length) * bow;
  const cy = (y1 + y2) / 2 + (dx / length) * bow;

  const sourceReach = Math.hypot(cx - x1, cy - y1);
  const targetReach = Math.hypot(cx - x2, cy - y2);
  if (sourceReach === 0 || targetReach === 0) return null;
  const sourceStep = (r1 + gap) / sourceReach;
  const targetStep = (r2 + gap) / targetReach;

  const result = out ?? { x1: 0, y1: 0, x2: 0, y2: 0, cx: 0, cy: 0 };
  result.x1 = x1 + (cx - x1) * sourceStep;
  result.y1 = y1 + (cy - y1) * sourceStep;
  result.x2 = x2 + (cx - x2) * targetStep;
  result.y2 = y2 + (cy - y2) * targetStep;
  result.cx = cx;
  result.cy = cy;
  return result;
}
