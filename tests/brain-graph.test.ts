import { describe, expect, it, vi } from "vitest";
import type { BrainGraphSnapshot as ServerSnapshot } from "@brain/application/queries/graph-snapshot";
import { DEFAULT_GROUP_RULES, resolveGroups } from "@brain/presentation/canvas/groups";
import { buildGraphModel, edgesOf, emptyGraphModel, neighboursOf } from "@brain/presentation/canvas/model";
import { describeQuery, matchesQuery, parseGraphQuery } from "@brain/presentation/canvas/query";
import { DEFAULT_CAMERA, fitCamera, panCamera, zoomCamera } from "@brain/presentation/canvas/renderer";
import { ALPHA_MIN, ForceSimulation } from "@brain/presentation/canvas/simulation";
import {
  DEFAULT_DISPLAY_SETTINGS,
  type BrainGraphSnapshot,
  type DisplaySettings,
} from "@brain/presentation/canvas/types";
import { buildGraphView, buildLocalView } from "@brain/presentation/canvas/view";

/**
 * Unit tests for the graph pipeline: model -> query -> view -> groups, plus the
 * simulation and the camera maths. Everything here is pure, so no DOM and no DB.
 */

/** Compile-time proof that the client wire types still mirror the server module. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const WIRE_TYPES_MATCH: Exact<ServerSnapshot, BrainGraphSnapshot> = true;

const snapshot: BrainGraphSnapshot = {
  nodes: [
    {
      id: "e1",
      kind: "entity",
      label: "Ada Lovelace",
      type: "person",
      detail: "Wrote the first algorithm.",
      tags: [],
      projectId: "p1",
      importance: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "e2",
      kind: "entity",
      label: "Apollo",
      type: "project",
      detail: null,
      tags: [],
      projectId: "p1",
      importance: null,
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      id: "e3",
      kind: "entity",
      label: "Rust",
      type: "technology",
      detail: null,
      tags: [],
      projectId: null,
      importance: null,
      updatedAt: "2026-01-04T00:00:00.000Z",
    },
    {
      id: "e4",
      kind: "entity",
      label: "Olive Orphan",
      type: "person",
      detail: null,
      tags: [],
      projectId: null,
      importance: null,
      updatedAt: "2026-01-05T00:00:00.000Z",
    },
    {
      id: "m1",
      kind: "memory",
      label: "Launch meeting",
      type: "note",
      detail: "Ada agreed to lead the launch.",
      tags: ["release"],
      projectId: "p1",
      importance: 4,
      updatedAt: "2026-01-06T00:00:00.000Z",
    },
  ],
  edges: [
    {
      id: "r1",
      source: "e1",
      target: "e2",
      type: "works_on",
      kind: "relationship",
      relation: "explicit",
      weight: 1,
      reason: null,
    },
    {
      id: "r2",
      source: "e2",
      target: "e3",
      type: "uses",
      kind: "relationship",
      relation: "explicit",
      weight: 0.8,
      reason: null,
    },
    {
      id: "l1",
      source: "m1",
      target: "e1",
      type: "mentions",
      kind: "link",
      relation: "explicit",
      weight: 1,
      reason: null,
    },
  ],
  projects: [{ id: "p1", name: "Apollo Programme" }],
  tags: ["release"],
  entityTypes: ["person", "project", "technology"],
  memoryTypes: ["note"],
  edgeStats: {
    explicit: 3,
    semantic: 0,
    tag: 0,
    entity: 0,
    project: 0,
    dropped: 0,
    candidates: 0,
  },
  truncated: { nodes: false, edges: false },
  generatedAt: "2026-01-07T00:00:00.000Z",
};

const model = buildGraphModel(snapshot);
const index = (id: string) => model.indexById.get(id) as number;

function view(display: Partial<DisplaySettings> = {}, query = "") {
  return buildGraphView(model, {
    query: parseGraphQuery(query),
    display: { ...DEFAULT_DISPLAY_SETTINGS, ...display },
  });
}

/**
 * A second graph, built for the weighted three-tier edge model: one stored link,
 * one semantic edge and one shared-tag edge, chained t1—t2—t3—t4 so switching a
 * tier off both removes an edge and cuts a BFS path.
 */
const tieredSnapshot: BrainGraphSnapshot = {
  nodes: ["t1", "t2", "t3", "t4"].map((id, position) => ({
    id,
    kind: "memory" as const,
    label: `Note ${id}`,
    type: "note",
    detail: null,
    tags: ["shared"],
    projectId: null,
    importance: 3,
    updatedAt: `2026-02-0${position + 1}T00:00:00.000Z`,
  })),
  edges: [
    {
      id: "x1",
      source: "t1",
      target: "t2",
      type: "references",
      kind: "link",
      relation: "explicit",
      weight: 1,
      reason: null,
    },
    {
      id: "x2",
      source: "t2",
      target: "t3",
      type: "semantic",
      kind: "derived",
      relation: "semantic",
      weight: 0.5,
      reason: "Shared wording: launch, orbit",
    },
    {
      id: "x3",
      source: "t3",
      target: "t4",
      type: "tag",
      kind: "derived",
      relation: "tag",
      weight: 0.2,
      reason: "Both tagged shared",
    },
  ],
  projects: [],
  tags: ["shared"],
  entityTypes: [],
  memoryTypes: ["note"],
  edgeStats: {
    explicit: 1,
    semantic: 1,
    tag: 1,
    entity: 0,
    project: 0,
    dropped: 0,
    candidates: 6,
  },
  truncated: { nodes: false, edges: false },
  generatedAt: "2026-02-05T00:00:00.000Z",
};

const tiered = buildGraphModel(tieredSnapshot);
const tieredIndex = (id: string) => tiered.indexById.get(id) as number;

function tieredView(display: Partial<DisplaySettings> = {}, query = "") {
  return buildGraphView(tiered, {
    query: parseGraphQuery(query),
    display: { ...DEFAULT_DISPLAY_SETTINGS, ...display },
  });
}

function tieredLocalView(
  focal: string,
  depth: number,
  display: Partial<DisplaySettings> = {},
  query = ""
) {
  return buildLocalView(tiered, tieredIndex(focal), depth, {
    query: parseGraphQuery(query),
    display: { ...DEFAULT_DISPLAY_SETTINGS, ...display },
  });
}

/** Model node indexes on screen, as ids, so failures read as names not numbers. */
function visibleIds(subject: ReturnType<typeof tieredView>): string[] {
  return Array.from(subject.nodesOf, (modelIndex) => tiered.nodes[modelIndex].id).sort();
}

/** Edge ids on screen, in model order. */
function visibleEdgeIds(subject: ReturnType<typeof tieredView>): string[] {
  return Array.from(subject.edgeIndexes, (edgeIndex) => tiered.edges[edgeIndex].id);
}

describe("graph wire types", () => {
  it("mirror the server snapshot exactly", () => {
    expect(WIRE_TYPES_MATCH).toBe(true);
  });
});

describe("parseGraphQuery", () => {
  it("treats an empty query as matching everything", () => {
    const query = parseGraphQuery("   ");
    expect(query.matchesEverything).toBe(true);
    expect(query.terms).toHaveLength(0);
  });

  it("parses fields, negation and quoted phrases", () => {
    const query = parseGraphQuery('type:person -tag:draft "launch meeting"');
    expect(query.terms).toEqual([
      { field: "type", value: "person", negate: false },
      { field: "tag", value: "draft", negate: true },
      { field: "text", value: "launch meeting", negate: false },
    ]);
  });

  it("ignores a half-typed field so the graph stays stable while typing", () => {
    expect(parseGraphQuery("type:").terms).toHaveLength(0);
    expect(parseGraphQuery("type:").matchesEverything).toBe(true);
  });

  it("keeps an unknown prefix as plain text", () => {
    expect(parseGraphQuery("colour:red").terms).toEqual([
      { field: "text", value: "colour:red", negate: false },
    ]);
  });

  it("describes a query for the sidebar", () => {
    expect(describeQuery(parseGraphQuery(""))).toBe("every node");
    expect(describeQuery(parseGraphQuery("type:person -ada"))).toBe("type:person · not “ada”");
  });
});

describe("matchesQuery", () => {
  const ada = model.nodes[index("e1")];
  const memory = model.nodes[index("m1")];

  it("matches by type, kind, tag and project name", () => {
    expect(matchesQuery(parseGraphQuery("type:person"), ada, 2)).toBe(true);
    expect(matchesQuery(parseGraphQuery("kind:memory"), ada, 2)).toBe(false);
    expect(matchesQuery(parseGraphQuery("tag:release"), memory, 1)).toBe(true);
    expect(matchesQuery(parseGraphQuery("project:apollo"), ada, 2)).toBe(true);
  });

  it("searches label, detail and tags case-insensitively", () => {
    expect(matchesQuery(parseGraphQuery("ALGORITHM"), ada, 2)).toBe(true);
    expect(matchesQuery(parseGraphQuery("nonsense"), ada, 2)).toBe(false);
  });

  it("ANDs terms and honours negation", () => {
    expect(matchesQuery(parseGraphQuery("type:person -ada"), ada, 2)).toBe(false);
    expect(matchesQuery(parseGraphQuery("type:person ada"), ada, 2)).toBe(true);
  });

  it("reads is:orphan from the degree it is given, not from the node", () => {
    expect(matchesQuery(parseGraphQuery("is:orphan"), ada, 0)).toBe(true);
    expect(matchesQuery(parseGraphQuery("is:orphan"), ada, 1)).toBe(false);
    expect(matchesQuery(parseGraphQuery("is:linked"), ada, 1)).toBe(true);
  });
});

describe("buildGraphModel", () => {
  it("indexes nodes and rewrites edges to indexes", () => {
    expect(model.nodes).toHaveLength(5);
    expect(model.nodes[index("e1")].index).toBe(index("e1"));
    expect(model.edges[0].source).toBe(index("e1"));
    expect(model.edges[0].target).toBe(index("e2"));
  });

  it("resolves project names and precomputes search text", () => {
    expect(model.nodes[index("e1")].projectName).toBe("Apollo Programme");
    expect(model.nodes[index("e3")].projectName).toBeNull();
    expect(model.nodes[index("m1")].searchText).toContain("release");
  });

  it("builds symmetric CSR adjacency with parallel edge indexes", () => {
    const ada = index("e1");
    const neighbours = Array.from(neighboursOf(model, ada));
    expect(new Set(neighbours)).toEqual(new Set([index("e2"), index("m1")]));

    const edges = edgesOf(model, ada);
    expect(edges).toHaveLength(neighbours.length);
    for (let k = 0; k < neighbours.length; k += 1) {
      const edge = model.edges[edges[k]];
      expect([edge.source, edge.target]).toContain(ada);
      expect([edge.source, edge.target]).toContain(neighbours[k]);
    }
  });

  it("reports degree, max degree and the filter vocabulary", () => {
    expect(model.degree[index("e2")]).toBe(2);
    expect(model.degree[index("e4")]).toBe(0);
    expect(model.maxDegree).toBe(2);
    expect(model.types.entity).toEqual(["person", "project", "technology"]);
    expect(model.types.memory).toEqual(["note"]);
  });

  it("returns an empty model for a missing snapshot", () => {
    const empty = buildGraphModel(undefined);
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
    expect(emptyGraphModel().maxDegree).toBe(0);
  });

  it("carries edge weight through and sums it into node strength", () => {
    expect(Array.from(model.edgeWeight)).toEqual([1, expect.closeTo(0.8, 5), 1]);
    // e2 sits on r1 (1) and r2 (0.8); e1 on r1 (1) and l1 (1).
    expect(model.strength[index("e2")]).toBeCloseTo(1.8, 5);
    expect(model.strength[index("e1")]).toBeCloseTo(2, 5);
    expect(model.strength[index("e4")]).toBe(0);
  });

  it("keeps the server's per-tier stats and reports nothing refused", () => {
    expect(model.edgeStats.explicit).toBe(3);
    expect(model.edgeStats.dropped).toBe(0);
    expect(model.invalidEdges).toBe(0);
  });

  it("refuses dangling and self edges, counts them and warns in development", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = buildGraphModel({
      ...snapshot,
      edges: [
        ...snapshot.edges,
        {
          id: "bad-dangling",
          source: "e1",
          target: "ghost",
          type: "mentions",
          kind: "link",
          relation: "explicit",
          weight: 1,
          reason: null,
        },
        {
          id: "bad-self",
          source: "e1",
          target: "e1",
          type: "mentions",
          kind: "link",
          relation: "explicit",
          weight: 1,
          reason: null,
        },
      ],
    });
    expect(broken.edges).toHaveLength(3);
    expect(broken.invalidEdges).toBe(2);
    // Root cause has to be findable, so the ids are named — and only the ids, never
    // a label or a body, which would put brain content into a log.
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("bad-dangling");
    expect(message).toContain("bad-self");
    expect(message).not.toContain("Ada Lovelace");
    warn.mockRestore();
  });

  it("clamps a weight the wire should never have sent", () => {
    const odd = buildGraphModel({
      ...snapshot,
      edges: [
        { ...snapshot.edges[0], weight: 4 },
        { ...snapshot.edges[1], weight: -1 },
        { ...snapshot.edges[2], weight: Number.NaN },
      ],
    });
    expect(Array.from(odd.edgeWeight)).toEqual([1, 0, 0]);
  });
});

describe("buildGraphView", () => {
  it("shows everything by default", () => {
    const all = view();
    expect(all.count).toBe(5);
    expect(all.edgeIndexes).toHaveLength(3);
    expect(all.links).toHaveLength(6);
    expect(all.hiddenCount).toBe(0);
  });

  it("maps links into the dense local index space", () => {
    const all = view();
    for (let l = 0; l < all.edgeIndexes.length; l += 1) {
      const edge = model.edges[all.edgeIndexes[l]];
      expect(all.links[l * 2]).toBe(all.localOf[edge.source]);
      expect(all.links[l * 2 + 1]).toBe(all.localOf[edge.target]);
      expect(all.nodesOf[all.links[l * 2]]).toBe(edge.source);
    }
  });

  it("drops edges whose endpoint is hidden by a kind toggle", () => {
    const entitiesOnly = view({ showMemories: false });
    expect(entitiesOnly.count).toBe(4);
    expect(entitiesOnly.localOf[index("m1")]).toBe(-1);
    expect(entitiesOnly.edgeIndexes).toHaveLength(2);
    expect(entitiesOnly.visibleDegree[index("e1")]).toBe(1);
    expect(entitiesOnly.hiddenCount).toBe(1);
  });

  it("hides orphans on request, including nodes orphaned by the filter", () => {
    expect(view({ showOrphans: false }).count).toBe(4);
    const noMemoriesNoOrphans = view({ showMemories: false, showOrphans: false });
    // e4 has no edge at all; nothing else loses its last edge here.
    expect(noMemoriesNoOrphans.count).toBe(3);
    expect(noMemoriesNoOrphans.localOf[index("e4")]).toBe(-1);
  });

  it("counts is:orphan against the degree left after the kind toggles", () => {
    // With memories hidden, the note's only neighbour keeps its entity edge, so
    // the sole orphan is e4.
    const orphans = view({ showMemories: false }, "is:orphan");
    expect(Array.from(orphans.nodesOf)).toEqual([index("e4")]);
  });

  it("keeps a filtered subgraph's edges consistent", () => {
    const people = view({}, "type:person");
    expect(people.count).toBe(2);
    expect(people.edgeIndexes).toHaveLength(0);
    expect(people.visibleDegree[index("e1")]).toBe(0);
  });

  it("publishes weight per visible edge and summed strength per node", () => {
    const all = view();
    expect(Array.from(all.linkWeights)).toEqual([1, expect.closeTo(0.8, 5), 1]);
    expect(all.visibleStrength[index("e2")]).toBeCloseTo(1.8, 5);
    expect(all.visibleStrength[index("e4")]).toBe(0);
    expect(Array.from(all.edgeVisible)).toEqual([1, 1, 1]);
  });

  it("clears edgeVisible and strength for an edge whose endpoint is hidden", () => {
    const entitiesOnly = view({ showMemories: false });
    // l1 is the memory edge, last in model order; the two entity edges survive.
    expect(Array.from(entitiesOnly.edgeVisible)).toEqual([1, 1, 0]);
    expect(entitiesOnly.visibleStrength[index("e1")]).toBeCloseTo(1, 5);
    expect(entitiesOnly.visibleStrength[index("m1")]).toBe(0);
  });
});

describe("edge tier filtering", () => {
  it("draws every tier by default, the weakest edge included", () => {
    const all = tieredView();
    expect(visibleEdgeIds(all)).toEqual(["x1", "x2", "x3"]);
    expect(Array.from(all.linkWeights)).toEqual([
      1,
      expect.closeTo(0.5, 5),
      expect.closeTo(0.2, 5),
    ]);
    expect(all.visibleStrength[tieredIndex("t2")]).toBeCloseTo(1.5, 5);
    expect(all.visibleStrength[tieredIndex("t4")]).toBeCloseTo(0.2, 5);
  });

  it("hides one tier's edges without removing its nodes", () => {
    const noSemantic = tieredView({ showSemanticEdges: false });
    expect(visibleEdgeIds(noSemantic)).toEqual(["x1", "x3"]);
    expect(visibleIds(noSemantic)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(noSemantic.edgeVisible[1]).toBe(0);
    expect(noSemantic.visibleDegree[tieredIndex("t2")]).toBe(1);
    expect(noSemantic.visibleStrength[tieredIndex("t2")]).toBeCloseTo(1, 5);
  });

  it("turns a node whose only edge is switched off into a visible orphan", () => {
    const noExplicit = tieredView({ showExplicitEdges: false });
    // t1 hangs off x1 alone, so hiding the stored-link tier isolates it — and an
    // isolated node is what the user should see, not a node that vanished.
    expect(noExplicit.visibleDegree[tieredIndex("t1")]).toBe(0);
    expect(visibleIds(noExplicit)).toContain("t1");
    // Only "hide orphans" may remove it, and then it is the user's own doing.
    expect(visibleIds(tieredView({ showExplicitEdges: false, showOrphans: false }))).toEqual([
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("keeps every node when all three tiers are off", () => {
    const nothing = tieredView({
      showExplicitEdges: false,
      showSemanticEdges: false,
      showContextEdges: false,
    });
    expect(nothing.edgeIndexes).toHaveLength(0);
    expect(nothing.count).toBe(4);
    expect(Array.from(nothing.edgeVisible)).toEqual([0, 0, 0]);
  });
  it("draws a valid edge whenever both of its ends are on screen", () => {
    // The invariant behind "a filter must not delete every edge": no combination of
    // node-level settings may leave two visible nodes with their edge missing.
    for (const display of [{}, { showOrphans: false }, { showLabels: false }]) {
      const subject = tieredView(display);
      for (let e = 0; e < tiered.edges.length; e += 1) {
        const edge = tiered.edges[e];
        const bothVisible = subject.localOf[edge.source] >= 0 && subject.localOf[edge.target] >= 0;
        expect(subject.edgeVisible[e] === 1).toBe(bothVisible);
      }
    }
  });
});

describe("buildLocalView", () => {
  const options = { query: parseGraphQuery(""), display: DEFAULT_DISPLAY_SETTINGS };

  it("walks the shared model outwards one hop at a time", () => {
    expect(visibleIds(tieredLocalView("t1", 1))).toEqual(["t1", "t2"]);
    expect(visibleEdgeIds(tieredLocalView("t1", 1))).toEqual(["x1"]);
    expect(visibleIds(tieredLocalView("t1", 2))).toEqual(["t1", "t2", "t3"]);
    expect(visibleIds(tieredLocalView("t1", 6))).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("carries the same weights as the global view", () => {
    const local = tieredLocalView("t1", 2);
    expect(Array.from(local.linkWeights)).toEqual([1, expect.closeTo(0.5, 5)]);
    expect(local.visibleStrength[tieredIndex("t2")]).toBeCloseTo(1.5, 5);
  });

  it("refuses to hop through a switched-off tier", () => {
    // t3 is reachable from t1 only across the semantic edge, so with that tier off
    // depth 2 has to stop at t2: the BFS may not travel a line the canvas is not
    // drawing, or "2 hops" would mean something other than what is on screen.
    const local = tieredLocalView("t1", 2, { showSemanticEdges: false });
    expect(visibleIds(local)).toEqual(["t1", "t2"]);
    expect(visibleEdgeIds(local)).toEqual(["x1"]);
  });

  it("exempts the focal node from the text query but not from a hide", () => {
    const local = tieredLocalView("t1", 2, {}, "t2");
    expect(visibleIds(local)).toEqual(["t1", "t2"]);
    // t3 was in scope and filtered out; the tally is against the BFS scope only.
    expect(local.hiddenCount).toBe(1);
    expect(buildLocalView(tiered, tieredIndex("t1"), 2, { ...options, hidden: new Set(["t1"]) }).count).toBe(0);
  });

  it("treats a hidden node as a wall rather than a stepping stone", () => {
    const walled = buildLocalView(tiered, tieredIndex("t1"), 3, {
      ...options,
      hidden: new Set(["t2"]),
    });
    expect(visibleIds(walled)).toEqual(["t1"]);
  });

  it("returns an empty view for a focal index outside the model", () => {
    expect(buildLocalView(tiered, -1, 2, options).count).toBe(0);
    expect(buildLocalView(tiered, 99, 2, options).count).toBe(0);
  });
});

describe("resolveGroups", () => {
  const full = view();

  it("paints nodes by the first matching rule", () => {
    const resolved = resolveGroups(model, DEFAULT_GROUP_RULES, full.visibleDegree, "#888888");
    const personSlot = DEFAULT_GROUP_RULES.findIndex((rule) => rule.query === "type:person") + 1;
    const memorySlot = DEFAULT_GROUP_RULES.findIndex((rule) => rule.query === "kind:memory") + 1;
    expect(resolved.groupOf[index("e1")]).toBe(personSlot);
    expect(resolved.groupOf[index("m1")]).toBe(memorySlot);
    expect(resolved.colors[0]).toBe("#888888");
    expect(resolved.colors[personSlot]).toBe("#f87171");
  });

  it("counts each group and leaves unmatched nodes ungrouped", () => {
    const resolved = resolveGroups(
      model,
      [{ id: "a", query: "type:person", color: "#f87171" }],
      full.visibleDegree,
      "#888888"
    );
    expect(resolved.counts).toEqual([2]);
    expect(resolved.groupOf[index("e3")]).toBe(0);
  });

  it("gives an earlier rule priority when two rules overlap", () => {
    const resolved = resolveGroups(
      model,
      [
        { id: "a", query: "is:linked", color: "#60a5fa" },
        { id: "b", query: "type:person", color: "#f87171" },
      ],
      full.visibleDegree,
      "#888888"
    );
    expect(resolved.groupOf[index("e1")]).toBe(1);
    expect(resolved.groupOf[index("e4")]).toBe(2);
    expect(resolved.counts).toEqual([4, 1]);
  });

  it("skips an empty group query instead of claiming every node", () => {
    const resolved = resolveGroups(
      model,
      [{ id: "a", query: "  ", color: "#f87171" }],
      full.visibleDegree,
      "#888888"
    );
    expect(resolved.counts).toEqual([0]);
    expect(Array.from(resolved.groupOf)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("camera maths", () => {
  it("pans in world units scaled by zoom", () => {
    const camera = { x: 0, y: 0, scale: 2 };
    expect(panCamera(camera, 20, -10)).toEqual({ x: -10, y: 5, scale: 2 });
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const width = 800;
    const height = 600;
    const camera = { x: 12, y: -30, scale: 1 };
    const screenX = 240;
    const screenY = 130;
    const before = {
      x: (screenX - width / 2) / camera.scale + camera.x,
      y: (screenY - height / 2) / camera.scale + camera.y,
    };
    const zoomed = zoomCamera(camera, screenX, screenY, 1.7, width, height);
    const after = {
      x: (screenX - width / 2) / zoomed.scale + zoomed.x,
      y: (screenY - height / 2) / zoomed.scale + zoomed.y,
    };
    expect(zoomed.scale).toBeCloseTo(1.7, 6);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("clamps zoom and returns the same camera at the limit", () => {
    const camera = { x: 0, y: 0, scale: 8 };
    expect(zoomCamera(camera, 100, 100, 4, 400, 400)).toBe(camera);
    expect(zoomCamera({ x: 0, y: 0, scale: 0.05 }, 100, 100, 0.1, 400, 400).scale).toBe(0.05);
  });

  it("frames the layout it is given", () => {
    const positions = new Float32Array([-100, -50, 100, 50]);
    const camera = fitCamera(positions, 2, 400, 200);
    expect(camera.x).toBeCloseTo(0, 6);
    expect(camera.y).toBeCloseTo(0, 6);
    expect(camera.scale).toBeCloseTo(Math.min((400 * 0.86) / 200, (200 * 0.86) / 100), 6);
  });

  it("falls back to the default camera when there is nothing to frame", () => {
    expect(fitCamera(new Float32Array(0), 0, 400, 200)).toBe(DEFAULT_CAMERA);
    expect(fitCamera(new Float32Array([NaN, NaN]), 1, 400, 200)).toBe(DEFAULT_CAMERA);
  });
});

describe("ForceSimulation", () => {
  const links = view().links.slice();
  const count = view().count;

  function run(ticks: number): ForceSimulation {
    const simulation = new ForceSimulation();
    simulation.setGraph(count, links.slice());
    for (let t = 0; t < ticks; t += 1) simulation.tick();
    return simulation;
  }

  it("seeds every node at a finite position", () => {
    const simulation = run(0);
    expect(simulation.positions).toHaveLength(count * 2);
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it("is deterministic for the same graph", () => {
    expect(Array.from(run(60).positions)).toEqual(Array.from(run(60).positions));
  });

  it("honours a seed and spirals only the unknown nodes", () => {
    const seed = new Float32Array(count * 2).fill(NaN);
    seed[0] = 42;
    seed[1] = -17;
    const simulation = new ForceSimulation();
    simulation.setGraph(count, links.slice(), seed);
    expect(simulation.positions[0]).toBeCloseTo(42, 5);
    expect(simulation.positions[1]).toBeCloseTo(-17, 5);
    expect(simulation.positions[2]).not.toBeNaN();
  });

  it("cools to a settled layout and stops", () => {
    const simulation = new ForceSimulation();
    simulation.setGraph(count, links.slice());
    let ticks = 0;
    while (!simulation.settled && ticks < 2000) {
      simulation.tick();
      ticks += 1;
    }
    expect(simulation.settled).toBe(true);
    expect(simulation.alpha).toBeLessThanOrEqual(ALPHA_MIN);
    expect(ticks).toBeLessThan(2000);
  });

  it("reheats only upwards", () => {
    const simulation = run(400);
    const cooled = simulation.alpha;
    simulation.reheat(0.5);
    expect(simulation.alpha).toBe(0.5);
    simulation.reheat(cooled);
    expect(simulation.alpha).toBe(0.5);
  });

  it("holds a pinned node still and lets go on release", () => {
    const simulation = run(20);
    simulation.pin(1, 250, -125);
    for (let t = 0; t < 30; t += 1) simulation.tick();
    expect(simulation.positions[2]).toBeCloseTo(250, 5);
    expect(simulation.positions[3]).toBeCloseTo(-125, 5);
    simulation.release(1);
    for (let t = 0; t < 60; t += 1) simulation.tick();
    expect(simulation.positions[2]).not.toBeCloseTo(250, 3);
  });

  it("ignores pin and release outside the node range", () => {
    const simulation = run(5);
    expect(() => {
      simulation.pin(-1, 0, 0);
      simulation.pin(count + 10, 0, 0);
      simulation.release(count + 10);
    }).not.toThrow();
  });

  it("keeps positions finite for a graph with no links", () => {
    const simulation = new ForceSimulation();
    simulation.setGraph(3, new Int32Array(0));
    for (let t = 0; t < 120; t += 1) simulation.tick();
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it("settles a weak link farther out than a strong one", () => {
    // The weight the renderer draws is the weight the physics feels, so a 0.2 tag
    // edge has to hold its pair looser than a stored link does.
    const restDistance = (weight: number) => {
      const simulation = new ForceSimulation();
      simulation.setGraph(2, new Int32Array([0, 1]), null, new Float32Array([weight]));
      for (let t = 0; t < 600; t += 1) simulation.tick();
      const [ax, ay, bx, by] = simulation.positions;
      return Math.hypot(bx - ax, by - ay);
    };
    expect(restDistance(0.2)).toBeGreaterThan(restDistance(1));
  });

  it("ignores a weights array shorter than the link count", () => {
    const simulation = new ForceSimulation();
    simulation.setGraph(3, new Int32Array([0, 1, 1, 2]), null, new Float32Array([0.5]));
    for (let t = 0; t < 120; t += 1) simulation.tick();
    for (const value of simulation.positions) expect(Number.isFinite(value)).toBe(true);
  });
});
