import { describe, it, expect, vi } from "vitest";
import type { GraphModel } from "./types";
import type { GraphView } from "./view";
import { EMPTY_VIEW } from "./view";
import {
  BODY_CLASSES,
  BodySprites,
  bodyClass,
  nodeMass,
  type SpriteSurface,
  type SurfaceFactory,
} from "./bodies";

/**
 * Celestial bodies.
 *
 * The classification is the part worth pinning: it decides whether a node is drawn as
 * a ringed giant or as a point of light, and the thresholds were chosen against real
 * graphs. A silent drift in them would restyle a whole brain — every note becoming a
 * planet reads as noise, every hub becoming a star throws away the hierarchy.
 *
 * The sprite cache is pinned for one reason: it must build each (colour, class) pair
 * exactly once. Rebuilding a 128px surface per node per frame would be invisible in a
 * screenshot and ruinous in a profile.
 */

/** A context complete enough to run the sprite painters, recording nothing. */
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  return new Proxy(
    {},
    {
      get: (_target, property: string) => {
        if (property === "createRadialGradient" || property === "createLinearGradient") {
          return () => gradient;
        }
        return () => undefined;
      },
      set: () => true,
    }
  ) as unknown as CanvasRenderingContext2D;
}

function fakeFactory(): { factory: SurfaceFactory; calls: () => number } {
  const spy = vi.fn((size: number): SpriteSurface => ({
    width: size,
    height: size,
    getContext: () => fakeContext(),
  }));
  return { factory: spy, calls: () => spy.mock.calls.length };
}

const model = {
  nodes: [
    { kind: "memory", importance: 1 },
    { kind: "entity", importance: null },
  ],
} as unknown as GraphModel;

function view(degree: number, strength: number): GraphView {
  return {
    ...EMPTY_VIEW,
    visibleDegree: new Int32Array([degree, degree]),
    visibleStrength: new Float32Array([strength, strength]),
  };
}

describe("nodeMass", () => {
  it("counts strength in full and degree at a third", () => {
    // Many weak relations should still read as busier than one strong one, without
    // pretending a shared tag is a link the user made.
    const oneStrong = nodeMass({ model, view: view(1, 1), modelIndex: 0 });
    const fourWeak = nodeMass({ model, view: view(4, 0.8), modelIndex: 0 });
    expect(fourWeak).toBeGreaterThan(oneStrong);
  });

  it("grows with both degree and strength", () => {
    const small = nodeMass({ model, view: view(2, 1), modelIndex: 0 });
    expect(nodeMass({ model, view: view(4, 1), modelIndex: 0 })).toBeGreaterThan(small);
    expect(nodeMass({ model, view: view(2, 3), modelIndex: 0 })).toBeGreaterThan(small);
  });

  it("treats an entity as middling importance rather than as zero", () => {
    // Entities carry no importance column, and reading that as 0 would shrink every
    // person and project in the graph below the notes that mention them.
    const entity = nodeMass({ model, view: view(3, 2), modelIndex: 1 });
    expect(entity).toBeGreaterThan(3 * 0.35 + 2);
  });

  it("survives a node index that is not in the view", () => {
    expect(nodeMass({ model, view: EMPTY_VIEW, modelIndex: 0 })).toBeGreaterThanOrEqual(0);
  });
});

describe("bodyClass", () => {
  it("splits the four kinds at the tuned thresholds", () => {
    expect(bodyClass(0)).toBe("star");
    expect(bodyClass(1.2)).toBe("star");
    expect(bodyClass(1.21)).toBe("moon");
    expect(bodyClass(3.19)).toBe("moon");
    expect(bodyClass(3.2)).toBe("planet");
    expect(bodyClass(6.49)).toBe("planet");
    expect(bodyClass(6.5)).toBe("giant");
    expect(bodyClass(400)).toBe("giant");
  });

  it("falls back to a star for a mass that is not a number", () => {
    // An unclassifiable node has to draw as *something*; the cheapest body is right.
    expect(bodyClass(Number.NaN)).toBe("star");
    expect(bodyClass(-1)).toBe("star");
  });
});

describe("BodySprites", () => {
  it("builds one surface per colour and class, and never again", () => {
    const { factory, calls } = fakeFactory();
    const sprites = new BodySprites(factory);

    for (let pass = 0; pass < 3; pass += 1) {
      for (const body of BODY_CLASSES) {
        expect(sprites.get("#f87171", body)).not.toBeNull();
      }
    }
    expect(calls()).toBe(BODY_CLASSES.length);

    // A second colour is a second set; a third pass over the first is still free.
    for (const body of BODY_CLASSES) sprites.get("#60a5fa", body);
    expect(calls()).toBe(BODY_CLASSES.length * 2);
  });

  it("returns null with no factory, so the caller can fall back to flat discs", () => {
    const sprites = new BodySprites(null);
    expect(sprites.get("#f87171", "planet")).toBeNull();
  });

  it("paints a body for any colour string it is handed", () => {
    // Group colours come from a colour input, but a malformed one must not throw in
    // the middle of a frame — it falls back to a neutral grey instead.
    const { factory } = fakeFactory();
    const sprites = new BodySprites(factory);
    for (const color of ["#fff", "#f87171", "rgb(1,2,3)", "not-a-colour", ""]) {
      expect(sprites.get(color, "giant")).not.toBeNull();
    }
  });
});
