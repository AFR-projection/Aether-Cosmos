import { describe, it, expect } from "vitest";
import type { GraphEdgeRelation } from "./types";
import {
  EDGE_BUCKETS,
  EDGE_SLOTS,
  EDGE_TIERS,
  MAX_BOW,
  curveSign,
  edgeBucket,
  edgeGeometry,
  edgeSlot,
  edgeTier,
} from "./edge-style";

/**
 * Edge geometry and tiering.
 *
 * The renderer draws thousands of edges per frame, so every decision it makes per
 * edge lives here as pure arithmetic instead of inside the draw loop where it could
 * not be checked. Four claims are worth pinning:
 *
 * - Tiering must agree with the filter in @brain/presentation/canvas/view.ts. If
 *   `edgeTier` and `tierVisible` ever disagree, a switched-on tier would paint in a
 *   colour whose legend swatch is switched off.
 * - Curvature must be reversible: `curve: 0` has to reproduce the straight line
 *   exactly, because that is the fallback for anyone who wants the old look back.
 * - The bow direction must be stable per edge, or the graph would twitch on every
 *   repaint, and it must not be stable *across* edges, or two relationships between
 *   the same pair would still land on top of each other.
 * - Trimmed endpoints must never cross. A line drawn backwards through two nodes
 *   is the one failure here that looks like a rendering bug rather than a style.
 */

const ALL_RELATIONS: GraphEdgeRelation[] = [
  "explicit",
  "semantic",
  "tag",
  "entity",
  "project",
];

/** Straight-line distance, so the assertions below read as geometry. */
const dist = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(bx - ax, by - ay);

describe("edgeTier", () => {
  it("maps every relation the model can produce", () => {
    for (const relation of ALL_RELATIONS) {
      expect(EDGE_TIERS).toContain(edgeTier(relation));
    }
  });

  it("folds shared tag, entity and project into one context tier", () => {
    // Same grouping as the single "context" checkbox in the panel: three ways of
    // saying "these two sit in the same surroundings" are one idea, one colour.
    expect(edgeTier("tag")).toBe("context");
    expect(edgeTier("entity")).toBe("context");
    expect(edgeTier("project")).toBe("context");
  });

  it("keeps stored links and wording similarity apart", () => {
    expect(edgeTier("explicit")).toBe("explicit");
    expect(edgeTier("semantic")).toBe("semantic");
  });
});

describe("edgeBucket", () => {
  it("splits weight into three tiers at 0.3 and 0.6", () => {
    expect(edgeBucket(0)).toBe(0);
    expect(edgeBucket(0.29)).toBe(0);
    expect(edgeBucket(0.3)).toBe(1);
    expect(edgeBucket(0.59)).toBe(1);
    expect(edgeBucket(0.6)).toBe(2);
    // Explicit rows are stored as 1: a link the user made is a certainty.
    expect(edgeBucket(1)).toBe(2);
  });

  it("never leaves the bucket range, whatever it is handed", () => {
    for (const weight of [-5, Number.NaN, 42]) {
      const bucket = edgeBucket(weight);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(EDGE_BUCKETS);
    }
  });
});

describe("edgeSlot", () => {
  it("gives every tier/weight pair its own batch, and no more than that", () => {
    // One Path2D per slot is what keeps the whole edge set at a fixed number of
    // stroke() calls; a slot outside the range would silently drop those edges.
    const seen = new Set<number>();
    for (const relation of ALL_RELATIONS) {
      for (const weight of [0.1, 0.45, 0.9]) {
        const slot = edgeSlot(relation, weight);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(EDGE_SLOTS);
        seen.add(slot);
      }
    }
    expect(EDGE_SLOTS).toBe(EDGE_TIERS.length * EDGE_BUCKETS);
    // Three tiers x three weights, reached through five relations.
    expect(seen.size).toBe(EDGE_SLOTS);
  });
});

describe("curveSign", () => {
  it("is stable for the same edge, so the graph does not twitch between frames", () => {
    for (const seed of [0, 1, 7, 512, 99999]) {
      expect(curveSign(seed)).toBe(curveSign(seed));
    }
  });

  it("bows both ways across a run of edges", () => {
    // Two relationships between the same pair only separate if their bows differ.
    const signs = new Set<number>();
    for (let seed = 0; seed < 64; seed += 1) signs.add(curveSign(seed));
    expect(signs).toEqual(new Set([-1, 1]));
  });

  it("only ever returns a unit sign", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      expect(Math.abs(curveSign(seed))).toBe(1);
    }
  });
});

describe("edgeGeometry — curvature", () => {
  const straight = { x1: 0, y1: 0, x2: 200, y2: 0, r1: 0, r2: 0, gap: 0 };

  it("puts the control point on the midpoint at curve 0", () => {
    // A quadratic whose control is the midpoint *is* the straight segment, so the
    // renderer needs one code path and the old flat look stays reachable.
    const geometry = edgeGeometry({ ...straight, seed: 3, curve: 0 })!;
    expect(geometry.cx).toBeCloseTo(100, 6);
    expect(geometry.cy).toBeCloseTo(0, 6);
  });

  it("offsets the control point perpendicular to the chord", () => {
    const geometry = edgeGeometry({ ...straight, seed: 3, curve: 1 })!;
    // Perpendicular to a horizontal chord means the bow is purely vertical.
    expect(geometry.cx).toBeCloseTo(100, 6);
    expect(Math.abs(geometry.cy)).toBeGreaterThan(1);
  });

  it("bows further as the dial goes up", () => {
    const gentle = edgeGeometry({ ...straight, seed: 3, curve: 0.25 })!;
    const strong = edgeGeometry({ ...straight, seed: 3, curve: 1 })!;
    expect(Math.abs(strong.cy)).toBeGreaterThan(Math.abs(gentle.cy));
  });

  it("mirrors the bow for the two signs, and nothing else", () => {
    const seeds = [0, 1, 2, 3, 4, 5, 6, 7];
    const ups = seeds
      .map((seed) => edgeGeometry({ ...straight, seed, curve: 1 })!.cy)
      .filter((cy) => cy > 0);
    const downs = seeds
      .map((seed) => edgeGeometry({ ...straight, seed, curve: 1 })!.cy)
      .filter((cy) => cy < 0);
    expect(ups.length).toBeGreaterThan(0);
    expect(downs.length).toBeGreaterThan(0);
    expect(ups[0]).toBeCloseTo(-downs[0]!, 6);
  });

  it("caps the bow so a long edge does not turn into an arc", () => {
    const geometry = edgeGeometry({
      x1: 0,
      y1: 0,
      x2: 40000,
      y2: 0,
      r1: 0,
      r2: 0,
      gap: 0,
      seed: 3,
      curve: 1,
    })!;
    expect(Math.abs(geometry.cy)).toBeLessThanOrEqual(MAX_BOW + 0.001);
  });

  it("rotates with the chord instead of always bowing vertically", () => {
    // A vertical chord must bow horizontally; the offset is perpendicular, not "up".
    const geometry = edgeGeometry({
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 200,
      r1: 0,
      r2: 0,
      gap: 0,
      seed: 3,
      curve: 1,
    })!;
    expect(Math.abs(geometry.cx)).toBeGreaterThan(1);
    expect(geometry.cy).toBeCloseTo(100, 6);
  });
});

describe("edgeGeometry — docking at the rim", () => {
  it("starts and ends outside the node it belongs to", () => {
    // Centre-to-centre lines stab into the circles; with a glow on the edge that
    // reads as a scratch across the node rather than as a connection to it.
    const geometry = edgeGeometry({
      x1: 0,
      y1: 0,
      x2: 300,
      y2: 0,
      r1: 20,
      r2: 8,
      gap: 2,
      seed: 1,
      curve: 0,
    })!;
    expect(dist(0, 0, geometry.x1, geometry.y1)).toBeCloseTo(22, 6);
    expect(dist(300, 0, geometry.x2, geometry.y2)).toBeCloseTo(10, 6);
  });

  it("leaves the endpoints in order however lopsided the radii are", () => {
    const geometry = edgeGeometry({
      x1: 0,
      y1: 0,
      x2: 40,
      y2: 0,
      r1: 30,
      r2: 1,
      gap: 1,
      seed: 5,
      curve: 0.5,
    });
    // A crossed pair would draw the line backwards through both nodes.
    if (geometry) expect(geometry.x1).toBeLessThan(geometry.x2);
  });

  it("refuses an edge between two nodes that already touch", () => {
    // Nothing to say: the circles overlap, and a stub of a line inside them is noise.
    expect(
      edgeGeometry({ x1: 0, y1: 0, x2: 12, y2: 0, r1: 10, r2: 10, seed: 1, curve: 0.4 })
    ).toBeNull();
  });

  it("refuses a zero-length edge instead of dividing by it", () => {
    expect(
      edgeGeometry({ x1: 50, y1: 50, x2: 50, y2: 50, r1: 0, r2: 0, seed: 1, curve: 0.4 })
    ).toBeNull();
  });
});
