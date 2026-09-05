/**
 * Shared types for the interactive graph view.
 *
 * The wire types below mirror @brain/application/queries/graph-snapshot.ts by hand instead of
 * importing it: that module pulls in the Drizzle schema and the Postgres driver,
 * which must never reach a client bundle (same reason @brain/domain/ui-constants.ts
 * exists). tests/brain-graph.test.ts pins the two shapes together so they cannot
 * drift silently.
 */

export type GraphNodeKind = "entity" | "memory";
export type GraphEdgeKind = "relationship" | "link" | "derived";
export type GraphEdgeRelation = "explicit" | "semantic" | "tag" | "entity" | "project";

export type GraphSnapshotNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  type: string;
  detail: string | null;
  tags: string[];
  projectId: string | null;
  importance: number | null;
  updatedAt: string;
};

export type GraphSnapshotEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  kind: GraphEdgeKind;
  relation: GraphEdgeRelation;
  weight: number;
  reason: string | null;
};

export type GraphEdgeStats = {
  explicit: number;
  semantic: number;
  tag: number;
  entity: number;
  project: number;
  dropped: number;
  candidates: number;
};

export type BrainGraphSnapshot = {
  nodes: GraphSnapshotNode[];
  edges: GraphSnapshotEdge[];
  projects: { id: string; name: string }[];
  tags: string[];
  entityTypes: string[];
  memoryTypes: string[];
  edgeStats: GraphEdgeStats;
  truncated: { nodes: boolean; edges: boolean };
  generatedAt: string;
};

// ── the indexed model everything else reads ──────────────────────────────────

export type GraphNode = {
  id: string;
  /** Position in `GraphModel.nodes`; also the row used by every typed array. */
  index: number;
  kind: GraphNodeKind;
  label: string;
  type: string;
  detail: string | null;
  tags: string[];
  projectId: string | null;
  projectName: string | null;
  importance: number | null;
  updatedAt: string;
  /** Lowercased label + detail + tags, precomputed once for the text filter. */
  searchText: string;
};

export type GraphEdge = {
  id: string;
  type: string;
  kind: GraphEdgeKind;
  /** Which tier produced this edge; drives styling, filtering and the legend. */
  relation: GraphEdgeRelation;
  /** 0..1 strength. Explicit rows are 1 — a link the user stored is a certainty. */
  weight: number;
  /** One short line explaining a derived edge. Null for explicit rows. */
  reason: string | null;
  /** Node indexes, not ids: the simulation and the renderer both work in indexes. */
  source: number;
  target: number;
};

/**
 * Adjacency is stored CSR-style (compressed sparse row) rather than as a
 * Map<id, string[]>: hover highlighting walks the neighbours of one node on every
 * pointer move, and a flat Int32Array walk costs nothing next to allocating arrays.
 */
export type GraphModel = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexById: Map<string, number>;
  /** Neighbour node indexes of node i live at [offsets[i], offsets[i + 1]). */
  offsets: Int32Array;
  neighbours: Int32Array;
  /** Edge index parallel to `neighbours`, so an edge can be highlighted too. */
  neighbourEdges: Int32Array;
  degree: Int32Array;
  maxDegree: number;
  /** Edge weight by edge index, for the renderer and the physics per frame. */
  edgeWeight: Float32Array;
  /** Summed weight of a node's edges. Hub size follows strength, not just count. */
  strength: Float32Array;
  /** Vocabulary present in this graph, for the sidebar. */
  types: { entity: string[]; memory: string[] };
  tags: string[];
  projects: { id: string; name: string }[];
  /** Per-tier counts and the dropped-edge tally, straight from the snapshot. */
  edgeStats: GraphEdgeStats;
  /** Edges the client itself refused: dangling or self-referential. */
  invalidEdges: number;
  truncated: { nodes: boolean; edges: boolean };
};

// ── settings ────────────────────────────────────────────────────────────────

/**
 * The four physics knobs, all normalized 0..1 except distance so the sidebar can
 * present plain sliders and the mapping to force constants stays in one place
 * (@brain/presentation/canvas/simulation.ts).
 */
export type ForceSettings = {
  center: number;
  repel: number;
  link: number;
  linkDistance: number;
  /**
   * Distance between orbits, in world units. The local graph lays its neighbours out
   * on concentric rings — one per hop from the centre — so the depth slider becomes
   * something you can see rather than a number you have to trust. 0 switches it off
   * and returns the plain force layout. Ignored by the global graph, which has no
   * centre to orbit.
   */
  orbitGap: number;
};

export const DEFAULT_FORCE_SETTINGS: ForceSettings = {
  center: 0.18,
  repel: 0.62,
  link: 0.38,
  linkDistance: 140,
  orbitGap: 170,
};

export type DisplaySettings = {
  showEntities: boolean;
  showMemories: boolean;
  /** Nodes with no visible edge. Hiding them is the fastest way to calm a big graph. */
  showOrphans: boolean;
  showLabels: boolean;
  showArrows: boolean;
  /**
   * Edge tiers, so the graph can be read one relationship kind at a time. These
   * hide *edges*, never nodes: a memory whose only edge is switched off becomes an
   * orphan on screen, which is the honest picture of that filter.
   */
  showExplicitEdges: boolean;
  showSemanticEdges: boolean;
  /** Shared tags, shared entities, shared project. */
  showContextEdges: boolean;
  /** Multipliers, 0.3..3. */
  nodeScale: number;
  linkScale: number;
  /**
   * How far an edge bows away from the straight line between its two nodes, 0..1.
   * At 0 the graph is the flat diagram it used to be — which is the point of having
   * the dial rather than a fixed curve. Above 0 two relationships between the same
   * pair stop collapsing into one stroke.
   */
  edgeCurve: number;
  /**
   * The deep-field layer: starfield, nebula, planet shading, edge glow and the
   * travelling light on a highlighted edge. One switch, because they are one idea —
   * and switching it off returns the cheapest possible canvas for a slow machine.
   */
  cosmos: boolean;
  /** 0..1: zoom level below which labels fade out. 0 = always show, 1 = never show. */
  textFadeThreshold: number;
  /** Timelapse animation: reveal nodes in updatedAt order. */
  animate: boolean;
};

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  showEntities: true,
  showMemories: true,
  showOrphans: true,
  showLabels: true,
  showArrows: false,
  showExplicitEdges: true,
  showSemanticEdges: true,
  showContextEdges: true,
  nodeScale: 1,
  linkScale: 1,
  edgeCurve: 0.35,
  cosmos: true,
  textFadeThreshold: 0.6,
  animate: false,
};

/** One coloured group: nodes matching `query` are painted `color`. */
export type GroupRule = {
  id: string;
  query: string;
  color: string;
};
