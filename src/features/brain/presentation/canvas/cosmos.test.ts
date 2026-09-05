import { describe, it, expect } from "vitest";
import {
  MAX_NEBULA_ALPHA,
  MAX_STAR_ALPHA,
  STAR_FIELDS,
  buildSky,
  hashSeed,
  wrapOffset,
} from "./cosmos";

/**
 * The sky behind the graph.
 *
 * Two things make this worth testing at all. The sky must be *deterministic*: it is
 * generated from the brain id, so the same brain opens onto the same stars every
 * time, and a field rebuilt from Math.random would quietly re-scatter itself on
 * every remount. And it must stay *restrained* — MASTER.md rules out decoration for
 * its own sake, so the alpha ceilings are pinned here rather than left as a habit a
 * later edit could drift past.
 *
 * `wrapOffset` gets its own block because JS `%` keeps the sign of the dividend: the
 * naive version returns a negative offset the moment the camera pans left of the
 * origin, which tears a blank band across the sky.
 */

const STAR_STRIDE = 4;

describe("hashSeed", () => {
  it("is stable for the same text", () => {
    expect(hashSeed("brain-1")).toBe(hashSeed("brain-1"));
  });

  it("separates ids that differ by one character", () => {
    expect(hashSeed("brain-1")).not.toBe(hashSeed("brain-2"));
  });

  it("is always a non-negative integer, including for the empty string", () => {
    for (const text of ["", "a", "22222222-2222-4222-8222-222222222222"]) {
      const seed = hashSeed(text);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("wrapOffset", () => {
  it("keeps a negative camera offset inside the tile", () => {
    // Panning left of the origin is the common case this exists for.
    expect(wrapOffset(-1, 512)).toBe(511);
    expect(wrapOffset(-513, 512)).toBe(511);
  });

  it("returns zero on exact multiples, in both directions", () => {
    expect(wrapOffset(0, 512)).toBe(0);
    expect(wrapOffset(512, 512)).toBe(0);
    expect(wrapOffset(-1024, 512)).toBe(0);
  });

  it("never leaves the tile, however far the camera has travelled", () => {
    for (const value of [-99999.5, -7.25, 0, 3.5, 123456.75]) {
      const wrapped = wrapOffset(value, 640);
      expect(wrapped).toBeGreaterThanOrEqual(0);
      expect(wrapped).toBeLessThan(640);
    }
  });
});

describe("buildSky", () => {
  it("gives the same brain the same sky every time", () => {
    const a = buildSky(hashSeed("brain-1"));
    const b = buildSky(hashSeed("brain-1"));
    for (let plane = 0; plane < a.planes.length; plane += 1) {
      expect(Array.from(a.planes[plane].stars)).toEqual(Array.from(b.planes[plane].stars));
    }
    expect(a.nebulae).toEqual(b.nebulae);
  });

  it("gives a different brain a different sky", () => {
    const a = buildSky(hashSeed("brain-1"));
    const b = buildSky(hashSeed("brain-2"));
    expect(Array.from(a.planes[0].stars)).not.toEqual(Array.from(b.planes[0].stars));
  });

  it("builds one plane per configured field, far to near", () => {
    const sky = buildSky(1);
    expect(sky.planes).toHaveLength(STAR_FIELDS.length);
    for (let i = 1; i < sky.planes.length; i += 1) {
      // Ascending parallax is what makes the near plane sweep past the far one.
      expect(sky.planes[i].parallax).toBeGreaterThan(sky.planes[i - 1].parallax);
    }
  });

  it("thins out and brightens towards the front, the way depth reads", () => {
    const sky = buildSky(1);
    const near = sky.planes[sky.planes.length - 1];
    const far = sky.planes[0];
    expect(near.count).toBeLessThan(far.count);
    // Each plane repeats on its own period, so the three grids never line up into
    // a visible lattice as the camera pans.
    const tiles = new Set(sky.planes.map((plane) => plane.tile));
    expect(tiles.size).toBe(sky.planes.length);
  });

  it("keeps every star inside its own tile", () => {
    // A star outside the tile is a star the wrap never brings back on screen.
    const sky = buildSky(hashSeed("brain-7"));
    for (const plane of sky.planes) {
      expect(plane.stars).toHaveLength(plane.count * STAR_STRIDE);
      for (let i = 0; i < plane.count; i += 1) {
        expect(plane.stars[i * STAR_STRIDE]).toBeGreaterThanOrEqual(0);
        expect(plane.stars[i * STAR_STRIDE]).toBeLessThan(plane.tile);
        expect(plane.stars[i * STAR_STRIDE + 1]).toBeGreaterThanOrEqual(0);
        expect(plane.stars[i * STAR_STRIDE + 1]).toBeLessThan(plane.tile);
      }
    }
  });

  it("keeps stars small and dim enough to stay a backdrop", () => {
    const sky = buildSky(hashSeed("brain-7"));
    for (let index = 0; index < sky.planes.length; index += 1) {
      const plane = sky.planes[index];
      const field = STAR_FIELDS[index];
      for (let i = 0; i < plane.count; i += 1) {
        const radius = plane.stars[i * STAR_STRIDE + 2];
        const alpha = plane.stars[i * STAR_STRIDE + 3];
        expect(radius).toBeGreaterThanOrEqual(field.minRadius);
        expect(radius).toBeLessThanOrEqual(field.maxRadius);
        expect(alpha).toBeGreaterThan(0);
        // Anything brighter competes with the nodes, which are the actual content.
        expect(alpha).toBeLessThanOrEqual(MAX_STAR_ALPHA);
      }
    }
  });

  it("keeps the nebula to a faint atmosphere rather than a lava lamp", () => {
    const sky = buildSky(hashSeed("brain-7"));
    expect(sky.nebulae.length).toBeGreaterThan(0);
    expect(sky.nebulae.length).toBeLessThanOrEqual(4);
    for (const cloud of sky.nebulae) {
      expect(cloud.alpha).toBeGreaterThan(0);
      expect(cloud.alpha).toBeLessThanOrEqual(MAX_NEBULA_ALPHA);
      // Anchored to the viewport as a wash, so it never drifts off during a pan.
      expect(cloud.fx).toBeGreaterThanOrEqual(0);
      expect(cloud.fx).toBeLessThanOrEqual(1);
      expect(cloud.fy).toBeGreaterThanOrEqual(0);
      expect(cloud.fy).toBeLessThanOrEqual(1);
      expect(cloud.fr).toBeGreaterThan(0);
      expect(cloud.tint).toBeGreaterThanOrEqual(0);
    }
  });
});
