import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BrainGraphSnapshot, DisplaySettings } from "./types";
import { DEFAULT_DISPLAY_SETTINGS } from "./types";
import { DEFAULT_GROUP_RULES, resolveGroups } from "./groups";
import { buildGraphModel } from "./model";
import { parseGraphQuery } from "./query";
import { buildGraphView } from "./view";
import { buildSky, hashSeed } from "./cosmos";
import { FALLBACK_THEME } from "./theme";
import { GraphRenderer, type RenderInput } from "./renderer";

/**
 * The renderer, exercised against a recording 2D context.
 *
 * A canvas cannot be asserted on pixel by pixel here, but the two mistakes that
 * actually break this file are both visible in the *call sequence*:
 *
 * - `arc()` and `ellipse()` continue the current subpath. Batching hundreds of
 *   circles into one path only works if each one is preceded by its own `moveTo`;
 *   forget it on one pass and every shape in that batch is tied to the previous one
 *   by a stray line across the graph. That is pinned below as an invariant over the
 *   whole frame, not as a test of one pass.
 * - State left behind leaks into the next pass. A dash pattern or a shadow that
 *   outlives the edge it was set for turns an unrelated pass into a smear, so the
 *   frame has to end with both reset.
 *
 * The same harness doubles as a smoke test: a full frame with the cosmos layer, a
 * highlight, arrows and a local focus has to run without throwing.
 */

type Call = { name: string; args: unknown[] };

const GRADIENT = { addColorStop: () => {} };

/**
 * Records every call and property write. A Proxy rather than a hand-written double:
 * the renderer touches two dozen context members, and a stub that has to be extended
 * every time a pass is added is a test that gets deleted.
 */
function recordingContext(calls: Call[]): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property in state) return state[property];
        return (...args: unknown[]) => {
          calls.push({ name: property, args });
          if (property === "createRadialGradient" || property === "createLinearGradient") {
            return GRADIENT;
          }
          if (property === "getLineDash") return [];
          return undefined;
        };
      },
      set(_target, property: string, value: unknown) {
        state[property] = value;
        calls.push({ name: `set:${property}`, args: [value] });
        return true;
      },
    }
  ) as unknown as CanvasRenderingContext2D;
}

/** Path2D is a DOM class; the edge passes build them, so the tests need one too. */
function stubPath2D(pathCalls: Call[]): void {
  class FakePath {
    moveTo(...args: unknown[]) {
      pathCalls.push({ name: "moveTo", args });
    }
    lineTo(...args: unknown[]) {
      pathCalls.push({ name: "lineTo", args });
    }
    quadraticCurveTo(...args: unknown[]) {
      pathCalls.push({ name: "quadraticCurveTo", args });
    }
  }
  vi.stubGlobal("Path2D", FakePath);
}

/**
 * Ten nodes around one hub, with all three relationship tiers present, so a single
 * frame exercises every batch: nine slots of edges, the hub ring, the limb pass and
 * the highlighted neighbourhood.
 */
const HUB_EDGES = 9;

const snapshot: BrainGraphSnapshot = {
  nodes: Array.from({ length: HUB_EDGES + 1 }, (_, i) => ({
    id: `n${i}`,
    kind: i === 3 ? ("entity" as const) : ("memory" as const),
    label: `Node ${i}`,
    type: i === 3 ? "person" : "note",
    detail: null,
    tags: ["shared"],
    projectId: null,
    importance: 3,
    updatedAt: `2026-03-01T00:0${i}:00.000Z`,
  })),
  edges: Array.from({ length: HUB_EDGES }, (_, i) => ({
    id: `e${i}`,
    source: "n0",
    target: `n${i + 1}`,
    type: "references",
    kind: (["link", "derived", "derived"] as const)[i % 3],
    relation: (["explicit", "semantic", "tag"] as const)[i % 3],
    weight: [1, 0.5, 0.2][i % 3],
    reason: null,
  })),
  projects: [],
  tags: ["shared"],
  entityTypes: ["person"],
  memoryTypes: ["note"],
  edgeStats: { explicit: 3, semantic: 3, tag: 3, entity: 0, project: 0, dropped: 0, candidates: 9 },
  truncated: { nodes: false, edges: false },
  generatedAt: "2026-03-01T00:00:00.000Z",
};

const WIDTH = 800;
const HEIGHT = 600;

const model = buildGraphModel(snapshot);

/** Nodes on a ring around the centre, far enough apart that no edge is culled. */
function positions(count: number): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 1; i < count; i += 1) {
    const angle = ((i - 1) / (count - 1)) * Math.PI * 2;
    out[i * 2] = Math.cos(angle) * 220;
    out[i * 2 + 1] = Math.sin(angle) * 220;
  }
  return out;
}

function frame(overrides: Partial<RenderInput> = {}, display: Partial<DisplaySettings> = {}) {
  const settings = { ...DEFAULT_DISPLAY_SETTINGS, ...display };
  const view = buildGraphView(model, { query: parseGraphQuery(""), display: settings });
  const groups = resolveGroups(model, DEFAULT_GROUP_RULES, view.visibleDegree, FALLBACK_THEME.node);
  return {
    model,
    view,
    positions: positions(view.count),
    groups,
    display: settings,
    camera: { x: 0, y: 0, scale: 1 },
    theme: FALLBACK_THEME,
    hover: -1,
    selected: -1,
    focal: -1,
    highlightNodes: null,
    highlightEdges: null,
    moving: false,
    animLimit: view.count,
    sky: buildSky(hashSeed("brain-render")),
    flowPhase: 12,
    orbit: null,
    ambientPhase: -1,
    ...overrides,
  } satisfies RenderInput;
}

let calls: Call[] = [];
let pathCalls: Call[] = [];
let renderer: GraphRenderer;

beforeEach(() => {
  calls = [];
  pathCalls = [];
  stubPath2D(pathCalls);
  const context = recordingContext(calls);
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  renderer = new GraphRenderer(canvas);
  renderer.resize(WIDTH, HEIGHT, 1);
  // resize() paints nothing; drop its setTransform so assertions read the frame only.
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every arc/ellipse has to open its own subpath, or the batch draws a spider web. */
function assertSubpathsAreOpened(recorded: Call[]): void {
  const shapes = new Set(["arc", "ellipse"]);
  for (let i = 0; i < recorded.length; i += 1) {
    if (!shapes.has(recorded[i].name)) continue;
    const previous = recorded
      .slice(0, i)
      .reverse()
      .find((call) => !call.name.startsWith("set:"));
    expect(
      previous?.name,
      `${recorded[i].name} at ${i} continues the current subpath`
    ).toMatch(/^(moveTo|beginPath)$/);
  }
}

describe("GraphRenderer.draw", () => {
  it("paints a full cosmos frame — sky, curves, planets, hub rings — without throwing", () => {
    renderer.draw(frame({ hover: 0, focal: 0 }, { showArrows: true }));

    const names = calls.map((call) => call.name);
    // The sky: a wash, then clouds, then stars.
    expect(names.filter((name) => name === "createRadialGradient").length).toBeGreaterThan(1);
    expect(names).toContain("ellipse");
    expect(names).toContain("fillText");
    expect(names).toContain("strokeText");
  });

  it("opens a subpath for every batched circle and ring", () => {
    renderer.draw(frame({ hover: 0, selected: 1, focal: 0 }, { showArrows: true }));

    assertSubpathsAreOpened(calls);
  });

  it("draws edges as curves, not as segments", () => {
    renderer.draw(frame());

    const names = pathCalls.map((call) => call.name);
    expect(names).toContain("quadraticCurveTo");
    // A straight lineTo would mean the curve dial had no effect on the geometry.
    expect(names).not.toContain("lineTo");
  });

  it("still draws every edge when the curve dial is at zero", () => {
    renderer.draw(frame({}, { edgeCurve: 0 }));

    const curves = pathCalls.filter((call) => call.name === "quadraticCurveTo");
    expect(curves).toHaveLength(HUB_EDGES);
  });

  it("leaves no dash pattern or shadow behind at the end of a frame", () => {
    renderer.draw(frame({ hover: 0, focal: 0 }, { showArrows: true }));

    const dashes = calls.filter((call) => call.name === "setLineDash");
    expect(dashes.at(-1)?.args[0]).toEqual([]);
    const blurs = calls.filter((call) => call.name === "set:shadowBlur");
    expect(blurs.at(-1)?.args[0]).toBe(0);
    const alphas = calls.filter((call) => call.name === "set:globalAlpha");
    expect(alphas.at(-1)?.args[0]).toBe(1);
  });

  it("skips the sky entirely when the cosmos layer is off", () => {
    renderer.draw(frame({}, { cosmos: false }));

    // A single flat fillRect for the ground, and no gradient anywhere.
    expect(calls.filter((call) => call.name === "createRadialGradient")).toHaveLength(0);
    expect(calls.filter((call) => call.name === "fillRect")).toHaveLength(1);
  });

  it("glows and moves a light along a highlighted neighbourhood, but only on cue", () => {
    const highlightEdges = new Uint8Array(model.edges.length);
    const highlightNodes = new Uint8Array(model.nodes.length);
    highlightEdges[0] = 1;
    highlightEdges[1] = 1;
    highlightNodes[0] = 1;
    highlightNodes[1] = 1;
    const highlighted = { hover: 0, highlightNodes, highlightEdges };

    renderer.draw(frame({ ...highlighted, flowPhase: 40 }));
    const offsets = () =>
      calls.filter((call) => call.name === "set:lineDashOffset").map((call) => call.args[0]);
    expect(offsets()).toContain(-40);
    // The glow pass is what makes a hover read as lit rather than as recoloured.
    expect(calls.filter((call) => call.name === "set:shadowBlur").map((call) => call.args[0]))
      .toContain(9);

    // Reduced motion is the hook's job to signal, with -1; obeying it is this file's.
    calls.length = 0;
    renderer.draw(frame({ ...highlighted, flowPhase: -1 }));
    expect(offsets().filter((offset) => offset !== 0)).toHaveLength(0);
  });

  it("lights the node under the pointer even when it has no highlighted edges", () => {
    // Hover is how this graph is read, so the answer to "what am I pointing at" must
    // not depend on the neighbourhood masks having been computed yet.
    renderer.draw(frame({ hover: 0, highlightNodes: null, highlightEdges: null }));

    const blurs = calls.filter((call) => call.name === "set:shadowBlur").map((c) => c.args[0]);
    expect(blurs.some((blur) => typeof blur === "number" && blur > 0)).toBe(true);
    expect(blurs.at(-1)).toBe(0);
  });

  it("frames the canvas with a vignette, and drops it with the cosmos layer", () => {
    renderer.draw(frame());
    const withCosmos = calls.filter((call) => call.name === "createRadialGradient").length;

    calls.length = 0;
    renderer.draw(frame({}, { cosmos: false }));
    expect(calls.filter((call) => call.name === "createRadialGradient")).toHaveLength(0);
    // Ground wash, three nebula clouds, and the vignette over the finished frame.
    expect(withCosmos).toBeGreaterThanOrEqual(5);
  });

  it("draws one numbered ring per hop when the layout is orbital", () => {
    renderer.draw(frame({ orbit: { gap: 60, depth: 3 } }));

    const dashes = calls
      .filter((call) => call.name === "setLineDash")
      .map((call) => JSON.stringify(call.args[0]));
    expect(dashes).toContain("[2,7]");
    // The numerals are what make a ring mean "two hops" instead of just decorate.
    const texts = calls.filter((call) => call.name === "fillText").map((call) => call.args[0]);
    expect(texts).toContain("1");
    expect(texts).toContain("2");
    expect(texts).toContain("3");
  });

  it("draws no rings for the global graph", () => {
    renderer.draw(frame({ orbit: null }));

    const dashes = calls
      .filter((call) => call.name === "setLineDash")
      .map((call) => JSON.stringify(call.args[0]));
    expect(dashes).not.toContain("[2,7]");
  });

  it("points home when the pan has left every node off screen", () => {
    // The one way an endless canvas is worse than a bounded one: pan far enough and
    // an empty screen looks like an empty graph.
    renderer.draw(frame({ camera: { x: 100000, y: 100000, scale: 1 } }));
    // closePath belongs to the compass chevron alone.
    expect(calls.filter((call) => call.name === "closePath")).toHaveLength(1);

    calls.length = 0;
    renderer.draw(frame());
    expect(calls.filter((call) => call.name === "closePath")).toHaveLength(0);
  });

  it("blits a celestial body per node once sprites are available", () => {
    // Without a surface factory the renderer falls back to flat discs, which is what
    // every other test here exercises; with one, each node becomes a single drawImage.
    const surfaces = () => ({
      width: 128,
      height: 128,
      getContext: () =>
        new Proxy(
          {},
          {
            get: (_t, property: string) =>
              property === "createRadialGradient" || property === "createLinearGradient"
                ? () => ({ addColorStop: () => {} })
                : () => undefined,
            set: () => true,
          }
        ),
    });
    const context = recordingContext(calls);
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    const sprited = new GraphRenderer(canvas, surfaces as never);
    sprited.resize(WIDTH, HEIGHT, 1);
    calls.length = 0;

    sprited.draw(frame());

    const blits = calls.filter((call) => call.name === "drawImage");
    expect(blits.length).toBeGreaterThan(0);
    // The flat fallback's hub rings are gone: the ring is part of the giant's sprite.
    expect(calls.filter((call) => call.name === "ellipse")).toHaveLength(0);
  });

  it("paints nothing but the ground for an empty view", () => {
    const empty = buildGraphView(model, {
      query: parseGraphQuery("nothing-matches-this"),
      display: DEFAULT_DISPLAY_SETTINGS,
    });
    renderer.draw(frame({ view: empty, positions: new Float32Array(0), animLimit: 0 }));

    expect(pathCalls).toHaveLength(0);
  });
});
