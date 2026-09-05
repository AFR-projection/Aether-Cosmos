import { describe, it, expect } from "vitest";
import type { BrainGraphSnapshot } from "./types";
import { DEFAULT_DISPLAY_SETTINGS, DEFAULT_FORCE_SETTINGS } from "./types";
import { buildGraphModel } from "./model";
import { parseGraphQuery } from "./query";
import { buildGraphView, buildLocalView } from "./view";
import { ForceSimulation } from "./simulation";

/**
 * The orbital local graph: hops recorded by the walk, rings produced by the physics.
 *
 * These are two halves of one claim — that the ring a node sits on is the number of
 * hops the panel says it is. If the BFS and the radial force ever disagree the
 * picture becomes a confident lie, which is worse than the plain force layout it
 * replaced, so both halves are pinned here together.
 *
 * The last test is the one that keeps this a *bias* rather than a layout: nodes on
 * the same ring must still spread out by bearing. A radial force that stacked a whole
 * hop at one angle would technically satisfy every other assertion below.
 */

/** Centre, six nodes one hop out, six more two hops out. */
const snapshot: BrainGraphSnapshot = {
  nodes: Array.from({ length: 13 }, (_, i) => ({
    id: `n${i}`,
    kind: "memory" as const,
    label: `Node ${i}`,
    type: "note",
    detail: null,
    tags: [],
    projectId: null,
    importance: 0.5,
    updatedAt: "2026-04-01T00:00:00.000Z",
  })),
  edges: [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      source: "n0",
      target: `n${i + 1}`,
      type: "references",
      kind: "link" as const,
      relation: "explicit" as const,
      weight: 1,
      reason: null,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
      source: `n${i + 1}`,
      target: `n${i + 7}`,
      type: "references",
      kind: "link" as const,
      relation: "explicit" as const,
      weight: 1,
      reason: null,
    })),
  ],
  projects: [],
  tags: [],
  entityTypes: [],
  memoryTypes: ["note"],
  edgeStats: { explicit: 12, semantic: 0, tag: 0, entity: 0, project: 0, dropped: 0, candidates: 0 },
  truncated: { nodes: false, edges: false },
  generatedAt: "2026-04-01T00:00:00.000Z",
};

const model = buildGraphModel(snapshot);
const options = { query: parseGraphQuery(""), display: DEFAULT_DISPLAY_SETTINGS };
const localView = () => buildLocalView(model, 0, 2, options);

/** Runs a layout to rest and returns each node's distance from the origin, by hop. */
function settle(orbitGap: number, withDepths = true) {
  const view = localView();
  const depths = new Int32Array(view.count);
  for (let local = 0; local < view.count; local += 1) {
    depths[local] = view.depthOf[view.nodesOf[local]];
  }
  const simulation = new ForceSimulation();
  simulation.settings = { ...DEFAULT_FORCE_SETTINGS, orbitGap };
  simulation.setGraph(view.count, view.links, null, view.linkWeights, withDepths ? depths : null);
  for (let i = 0; i < 700; i += 1) simulation.tick();
  return Array.from({ length: view.count }, (_, local) => ({
    depth: depths[local],
    distance: Math.hypot(
      simulation.positions[local * 2],
      simulation.positions[local * 2 + 1]
    ),
    angle: Math.atan2(simulation.positions[local * 2 + 1], simulation.positions[local * 2]),
  }));
}

describe("buildLocalView — hops", () => {
  it("records the centre as hop 0 and its neighbours as hop 1", () => {
    const view = localView();
    expect(view.depthOf[0]).toBe(0);
    for (let i = 1; i <= 6; i += 1) expect(view.depthOf[i]).toBe(1);
    for (let i = 7; i <= 12; i += 1) expect(view.depthOf[i]).toBe(2);
  });

  it("gives the global view no hops at all", () => {
    // Length 0 is the signal that switches the orbital layout off; a global graph has
    // no centre, and rings imposed on it would bury the cluster structure.
    expect(buildGraphView(model, options).depthOf).toHaveLength(0);
  });
});

describe("ForceSimulation — orbits", () => {
  const GAP = 170;

  it("settles each node onto the ring for its own hop", () => {
    const nodes = settle(GAP);

    for (const node of nodes) {
      if (node.depth <= 0) continue;
      // A third of the gap: firm enough to be unmistakably a ring, loose enough that
      // link and repulsion still have a say in where along it a node ends up.
      expect(Math.abs(node.distance - node.depth * GAP)).toBeLessThan(GAP * 0.34);
    }
  });

  it("holds the centre at the origin like a sun", () => {
    const centre = settle(GAP).find((node) => node.depth === 0)!;

    expect(centre.distance).toBeLessThan(24);
  });

  it("puts the second ring outside the first, with a gap between them", () => {
    const nodes = settle(GAP);
    const first = Math.max(...nodes.filter((n) => n.depth === 1).map((n) => n.distance));
    const second = Math.min(...nodes.filter((n) => n.depth === 2).map((n) => n.distance));

    expect(second).toBeGreaterThan(first);
  });

  it("leaves the bearing free, so a ring is not a stack", () => {
    const angles = settle(GAP)
      .filter((node) => node.depth === 1)
      .map((node) => node.angle)
      .sort((a, b) => a - b);

    // Six nodes spread around a circle should span most of it. A radial force that
    // ignored repulsion would satisfy every assertion above and fail this one.
    expect(angles[angles.length - 1] - angles[0]).toBeGreaterThan(2);
  });

  it("returns to the plain layout at gap 0, and without hops", () => {
    const flat = settle(0);
    const global = settle(GAP, false);
    const spread = (nodes: typeof flat) =>
      nodes.reduce((sum, node) => sum + node.distance, 0) / nodes.length;

    // Spacing of 0 and no hops at all disable the force through the same branch, so
    // the two layouts have to come out identical rather than merely similar.
    expect(global).toEqual(flat);
    // And orbits are not a no-op: the outer ring sits further out than the plain
    // centring force would ever leave it.
    expect(spread(settle(GAP))).toBeGreaterThan(spread(flat));
  });
});
