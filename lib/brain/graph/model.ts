import type { BrainGraphSnapshot, GraphEdge, GraphModel, GraphNode } from "./types";

/**
 * Turns a wire snapshot into the indexed model the rest of the graph view reads.
 *
 * Built once per snapshot and then treated as immutable: filtering, grouping and
 * the simulation all derive from it without copying it. Everything that is read
 * per frame (adjacency, degree) is a typed array, so no frame allocates.
 */

const EMPTY_EDGE_STATS = {
  explicit: 0,
  semantic: 0,
  tag: 0,
  entity: 0,
  project: 0,
  dropped: 0,
  candidates: 0,
};

const EMPTY_MODEL: GraphModel = {
  nodes: [],
  edges: [],
  indexById: new Map(),
  offsets: new Int32Array(1),
  neighbours: new Int32Array(0),
  neighbourEdges: new Int32Array(0),
  degree: new Int32Array(0),
  maxDegree: 0,
  edgeWeight: new Float32Array(0),
  strength: new Float32Array(0),
  types: { entity: [], memory: [] },
  tags: [],
  projects: [],
  edgeStats: EMPTY_EDGE_STATS,
  invalidEdges: 0,
  truncated: { nodes: false, edges: false },
};

export function emptyGraphModel(): GraphModel {
  return EMPTY_MODEL;
}

export function buildGraphModel(snapshot: BrainGraphSnapshot | undefined): GraphModel {
  if (!snapshot || snapshot.nodes.length === 0) return EMPTY_MODEL;

  const projectNames = new Map(snapshot.projects.map((project) => [project.id, project.name]));

  const nodes: GraphNode[] = snapshot.nodes.map((node, index) => {
    const projectName = node.projectId ? projectNames.get(node.projectId) ?? null : null;
    return {
      id: node.id,
      index,
      kind: node.kind,
      label: node.label,
      type: node.type,
      detail: node.detail,
      tags: node.tags,
      projectId: node.projectId,
      projectName,
      importance: node.importance,
      updatedAt: node.updatedAt,
      searchText: [node.label, node.detail ?? "", node.tags.join(" "), projectName ?? ""]
        .join(" ")
        .toLowerCase(),
    };
  });

  const indexById = new Map<string, number>();
  for (const node of nodes) indexById.set(node.id, node.index);

  const edges: GraphEdge[] = [];
  /** Ids only — never a label or a body, which would put brain content in a log. */
  const invalid: string[] = [];
  for (const edge of snapshot.edges) {
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    // A dangling or self edge would draw a line to nowhere and add a force with no
    // opposite end; both are refused. Refusing them quietly is how "0 links" hides,
    // though, so the count is kept and the first few are named in development.
    if (source === undefined || target === undefined || source === target) {
      invalid.push(edge.id);
      continue;
    }
    edges.push({
      id: edge.id,
      type: edge.type,
      kind: edge.kind,
      relation: edge.relation,
      weight: edge.weight,
      reason: edge.reason,
      source,
      target,
    });
  }
  if (invalid.length > 0 && process.env.NODE_ENV !== "production") {
    console.warn(
      `[graph] ${invalid.length} edge(s) refused: endpoint missing from the node set, or self-referential. Edge ids: ${invalid
        .slice(0, 10)
        .join(", ")}${invalid.length > 10 ? ", …" : ""}`
    );
  }

  const count = nodes.length;
  const degree = new Int32Array(count);
  const edgeWeight = new Float32Array(edges.length);
  const strength = new Float32Array(count);
  for (let e = 0; e < edges.length; e += 1) {
    const edge = edges[e];
    degree[edge.source] += 1;
    degree[edge.target] += 1;
    // A weight outside 0..1 would distort every scale that reads it, so it is
    // clamped here rather than trusted from the wire.
    const weight = Number.isFinite(edge.weight) ? Math.min(1, Math.max(0, edge.weight)) : 0;
    edgeWeight[e] = weight;
    strength[edge.source] += weight;
    strength[edge.target] += weight;
  }

  // Prefix sum -> CSR offsets, then one fill pass with a moving cursor per row.
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i < count; i += 1) offsets[i + 1] = offsets[i] + degree[i];

  const neighbours = new Int32Array(edges.length * 2);
  const neighbourEdges = new Int32Array(edges.length * 2);
  const cursor = Int32Array.from(offsets.subarray(0, count));
  for (let e = 0; e < edges.length; e += 1) {
    const { source, target } = edges[e];
    const outSlot = cursor[source]++;
    neighbours[outSlot] = target;
    neighbourEdges[outSlot] = e;
    const inSlot = cursor[target]++;
    neighbours[inSlot] = source;
    neighbourEdges[inSlot] = e;
  }

  let maxDegree = 0;
  for (let i = 0; i < count; i += 1) if (degree[i] > maxDegree) maxDegree = degree[i];

  const entityTypes = new Set<string>();
  const memoryTypes = new Set<string>();
  for (const node of nodes) {
    (node.kind === "entity" ? entityTypes : memoryTypes).add(node.type);
  }

  return {
    nodes,
    edges,
    indexById,
    offsets,
    neighbours,
    neighbourEdges,
    degree,
    maxDegree,
    edgeWeight,
    strength,
    types: {
      entity: [...entityTypes].sort(),
      memory: [...memoryTypes].sort(),
    },
    tags: snapshot.tags,
    projects: snapshot.projects,
    edgeStats: snapshot.edgeStats ?? EMPTY_EDGE_STATS,
    invalidEdges: invalid.length,
    truncated: snapshot.truncated,
  };
}

/** Neighbour node indexes of one node, as a view — no copy. */
export function neighboursOf(model: GraphModel, index: number): Int32Array {
  if (index < 0 || index >= model.nodes.length) return new Int32Array(0);
  return model.neighbours.subarray(model.offsets[index], model.offsets[index + 1]);
}

/** Edge indexes touching one node, as a view — no copy. */
export function edgesOf(model: GraphModel, index: number): Int32Array {
  if (index < 0 || index >= model.nodes.length) return new Int32Array(0);
  return model.neighbourEdges.subarray(model.offsets[index], model.offsets[index + 1]);
}
