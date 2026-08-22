/**
 * Graph intelligence algorithms over Brain memories and entities.
 *
 * All algorithms work on adjacency lists built from memory_links + brain_relationships,
 * plus derived edges when requested. They are deterministic, auditable, and operate
 * over the explicit graph structure — no LLM inference, no random walks.
 *
 * Core primitives:
 *  - Degree, weighted degree, centrality measures
 *  - PageRank for importance propagation
 *  - Connected components and bridges (articulation points)
 *  - Community detection via label propagation
 *  - Bounded shortest path with explainable hops
 *  - Orphan and knowledge-gap detection
 *
 * Every algorithm respects brain isolation: a graph built for brainId X cannot see
 * nodes or edges from brain Y, enforced by the caller (the graph loader filters on
 * brain_id before building the adjacency list).
 */

export type GraphNodeId = string;

/**
 * One directed edge in the graph. `weight` ∈ [0,1]: explicit edges are 1.0, derived
 * edges are scored by their evidence strength.
 */
export type GraphEdge = {
  source: GraphNodeId;
  target: GraphNodeId;
  type: string;
  weight: number;
};

/**
 * Adjacency list representation: node → list of outgoing edges. Undirected graphs
 * are represented by adding both (A→B) and (B→A).
 */
export type AdjacencyList = Map<GraphNodeId, GraphEdge[]>;

// ── construction ────────────────────────────────────────────────────────────

/**
 * Build an undirected adjacency list from edges. Each edge (A→B, weight w) produces
 * two entries: A→B and B→A, both carrying the same weight. Self-loops are dropped.
 */
export function buildUndirectedGraph(edges: GraphEdge[]): AdjacencyList {
  const graph: AdjacencyList = new Map();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!graph.has(edge.source)) graph.set(edge.source, []);
    if (!graph.has(edge.target)) graph.set(edge.target, []);
    graph.get(edge.source)!.push(edge);
    graph.get(edge.target)!.push({ ...edge, source: edge.target, target: edge.source });
  }
  return graph;
}

/**
 * Build a directed adjacency list from edges. Each edge (A→B, weight w) produces
 * one entry: A→B. Self-loops are dropped.
 */
export function buildDirectedGraph(edges: GraphEdge[]): AdjacencyList {
  const graph: AdjacencyList = new Map();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!graph.has(edge.source)) graph.set(edge.source, []);
    if (!graph.has(edge.target)) graph.set(edge.target, []);
    graph.get(edge.source)!.push(edge);
  }
  return graph;
}

// ── degree and centrality ──────────────────────────────────────────────────

export type NodeDegree = {
  nodeId: GraphNodeId;
  /** Number of edges touching this node (undirected), or outgoing edges (directed). */
  degree: number;
  /** Sum of edge weights. */
  weightedDegree: number;
};

/**
 * Compute degree and weighted degree for every node in the graph. For an undirected
 * graph, degree = number of neighbors; for a directed graph, degree = out-degree.
 */
export function computeDegrees(graph: AdjacencyList): Map<GraphNodeId, NodeDegree> {
  const degrees = new Map<GraphNodeId, NodeDegree>();
  for (const [nodeId, edges] of graph) {
    const degree = edges.length;
    const weightedDegree = edges.reduce((sum, edge) => sum + edge.weight, 0);
    degrees.set(nodeId, { nodeId, degree, weightedDegree });
  }
  // Nodes with no outgoing edges still exist in the graph as isolated nodes.
  return degrees;
}

// ── PageRank ───────────────────────────────────────────────────────────────

export type PageRankResult = {
  nodeId: GraphNodeId;
  rank: number;
};

/**
 * PageRank over a directed graph. Iterates until convergence or max iterations.
 * Returns normalized ranks summing to 1.0.
 *
 * @param graph - Directed adjacency list
 * @param dampingFactor - Probability of following an edge (default 0.85)
 * @param maxIterations - Stop after this many iterations (default 50)
 * @param tolerance - Convergence threshold (default 1e-6)
 */
export function pageRank(
  graph: AdjacencyList,
  dampingFactor = 0.85,
  maxIterations = 50,
  tolerance = 1e-6
): Map<GraphNodeId, PageRankResult> {
  const nodes = Array.from(graph.keys());
  const n = nodes.length;
  if (n === 0) return new Map();

  // Initialize: each node starts with rank 1/n.
  const ranks = new Map<GraphNodeId, number>();
  for (const node of nodes) ranks.set(node, 1 / n);

  // Build reverse index: who points to me?
  const inbound = new Map<GraphNodeId, GraphNodeId[]>();
  for (const node of nodes) inbound.set(node, []);
  for (const [source, edges] of graph) {
    for (const edge of edges) {
      inbound.get(edge.target)!.push(source);
    }
  }

  const teleport = (1 - dampingFactor) / n;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const newRanks = new Map<GraphNodeId, number>();
    let delta = 0;

    for (const node of nodes) {
      let sum = 0;
      for (const source of inbound.get(node)!) {
        const sourceDegree = graph.get(source)!.length;
        sum += ranks.get(source)! / sourceDegree;
      }
      const newRank = teleport + dampingFactor * sum;
      newRanks.set(node, newRank);
      delta += Math.abs(newRank - ranks.get(node)!);
    }

    for (const [node, rank] of newRanks) ranks.set(node, rank);

    if (delta < tolerance) break;
  }

  const results = new Map<GraphNodeId, PageRankResult>();
  for (const [nodeId, rank] of ranks) {
    results.set(nodeId, { nodeId, rank });
  }
  return results;
}

// ── connected components ───────────────────────────────────────────────────

/**
 * Find connected components in an undirected graph via BFS. Returns a map from
 * node id to component id (an arbitrary representative node from that component).
 */
export function connectedComponents(graph: AdjacencyList): Map<GraphNodeId, GraphNodeId> {
  const components = new Map<GraphNodeId, GraphNodeId>();
  const visited = new Set<GraphNodeId>();

  for (const start of graph.keys()) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    components.set(start, start);

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const edge of graph.get(node) ?? []) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          components.set(edge.target, start);
          queue.push(edge.target);
        }
      }
    }
  }

  return components;
}

// ── bridges (articulation edges) ───────────────────────────────────────────

/**
 * A bridge is an edge whose removal increases the number of connected components.
 * Returns edges (source, target) that are bridges in the undirected graph.
 */
export function findBridges(graph: AdjacencyList): Array<{ source: GraphNodeId; target: GraphNodeId }> {
  const nodes = Array.from(graph.keys());
  const bridges: Array<{ source: GraphNodeId; target: GraphNodeId }> = [];
  const visited = new Set<GraphNodeId>();
  const disc = new Map<GraphNodeId, number>();
  const low = new Map<GraphNodeId, number>();
  const parent = new Map<GraphNodeId, GraphNodeId | null>();
  let time = 0;

  function dfs(u: GraphNodeId) {
    visited.add(u);
    disc.set(u, time);
    low.set(u, time);
    time += 1;

    for (const edge of graph.get(u) ?? []) {
      const v = edge.target;
      if (!visited.has(v)) {
        parent.set(v, u);
        dfs(v);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));

        // Bridge condition: no back edge from v's subtree to u's ancestors.
        if (low.get(v)! > disc.get(u)!) {
          bridges.push({ source: u, target: v });
        }
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  }

  for (const node of nodes) {
    if (!visited.has(node)) {
      parent.set(node, null);
      dfs(node);
    }
  }

  return bridges;
}

// ── label propagation (community detection) ────────────────────────────────

/**
 * Detect communities via label propagation. Each node starts with a unique label,
 * then iteratively adopts the most common label among its neighbors (weighted by
 * edge weight). Stops when stable or after maxIterations.
 *
 * Returns a map from node id to community label (an arbitrary node id from that
 * community). Nodes in the same community share the same label.
 *
 * **Deterministic.** Classic label propagation shuffles the visit order randomly,
 * which would make the same brain produce different communities on every call —
 * unacceptable when a relationship has to be explainable and auditable. Instead the
 * nodes are visited in sorted order, rotated by the iteration index: the order
 * still varies between sweeps (so no single node permanently dictates its
 * neighbours) but it is a pure function of the input. Vote ties break towards the
 * smallest label for the same reason.
 */
export function labelPropagation(
  graph: AdjacencyList,
  maxIterations = 20
): Map<GraphNodeId, GraphNodeId> {
  const nodes = Array.from(graph.keys()).sort();
  const labels = new Map<GraphNodeId, GraphNodeId>();

  // Initialize: each node is its own community.
  for (const node of nodes) labels.set(node, node);

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let changed = false;
    // Deterministic rotation instead of a random shuffle.
    const offset = nodes.length === 0 ? 0 : iter % nodes.length;
    const order = [...nodes.slice(offset), ...nodes.slice(0, offset)];

    for (const node of order) {
      const neighbors = graph.get(node) ?? [];
      if (neighbors.length === 0) continue;

      // Count weighted votes from neighbors.
      const votes = new Map<GraphNodeId, number>();
      for (const edge of neighbors) {
        const label = labels.get(edge.target)!;
        votes.set(label, (votes.get(label) ?? 0) + edge.weight);
      }

      // Highest vote wins; equal votes go to the smallest label so the outcome
      // cannot depend on Map insertion order.
      let maxVote = 0;
      let bestLabel = labels.get(node)!;
      for (const [label, vote] of votes) {
        if (vote > maxVote || (vote === maxVote && label < bestLabel)) {
          maxVote = vote;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

// ── orphans and knowledge gaps ─────────────────────────────────────────────

/**
 * Find orphan nodes: nodes with degree 0 (no edges at all). These represent
 * isolated knowledge that has not been connected to the rest of the graph.
 */
export function findOrphans(graph: AdjacencyList): GraphNodeId[] {
  const orphans: GraphNodeId[] = [];
  for (const [nodeId, edges] of graph) {
    if (edges.length === 0) orphans.push(nodeId);
  }
  return orphans;
}

/**
 * Find weakly connected nodes: nodes with degree 1 (only one edge). These are
 * potential knowledge gaps — concepts that are barely integrated.
 */
export function findWeaklyConnected(graph: AdjacencyList): GraphNodeId[] {
  const weak: GraphNodeId[] = [];
  for (const [nodeId, edges] of graph) {
    if (edges.length === 1) weak.push(nodeId);
  }
  return weak;
}

// ── shortest path with explainable hops ────────────────────────────────────

export type PathHop = {
  source: GraphNodeId;
  target: GraphNodeId;
  relationshipType: string;
  weight: number;
};

export type PathResult = {
  found: boolean;
  /** Array of hops from source to target. Empty if not found. */
  path: PathHop[];
  /**
   * Total path cost, lower is better: 1 per hop plus (1 - weight) per hop as an
   * uncertainty penalty. For a path made only of explicit links (weight 1.0) this is
   * exactly the number of hops. Infinity when no path was found.
   */
  distance: number;
};

/**
 * Find the shortest path from source to target using Dijkstra's algorithm, with
 * a maximum depth limit. Returns the path as a sequence of explainable hops.
 *
 * @param graph - Adjacency list (directed or undirected)
 * @param source - Starting node id
 * @param target - Target node id
 * @param maxDepth - Maximum number of hops (default 5)
 */
export function shortestPath(
  graph: AdjacencyList,
  source: GraphNodeId,
  target: GraphNodeId,
  maxDepth = 5
): PathResult {
  if (source === target) {
    return { found: true, path: [], distance: 0 };
  }

  if (!graph.has(source) || !graph.has(target)) {
    return { found: false, path: [], distance: Infinity };
  }

  // Priority queue: [distance, nodeId, depth, pathSoFar]
  const queue: Array<[number, GraphNodeId, number, PathHop[]]> = [[0, source, 0, []]];
  const visited = new Set<GraphNodeId>();

  while (queue.length > 0) {
    // Sort by distance (Dijkstra's greedy choice).
    queue.sort((a, b) => a[0] - b[0]);
    const [dist, node, depth, pathSoFar] = queue.shift()!;

    if (node === target) {
      return { found: true, path: pathSoFar, distance: dist };
    }

    if (visited.has(node) || depth >= maxDepth) continue;
    visited.add(node);

    for (const edge of graph.get(node) ?? []) {
      if (visited.has(edge.target)) continue;
      // Every hop costs 1, plus an uncertainty penalty of (1 - weight). The base of 1
      // is what makes a shorter chain win: with cost (1 - weight) alone, a path of
      // explicit links cost 0 per hop, so a five-hop detour tied with a direct link
      // and `distance` was always 0. Now an explicit link (weight 1.0) costs exactly
      // 1, so `distance` reads as a hop count, and among routes of the same length
      // the better-evidenced one is preferred.
      const edgeCost = 1 + (1 - edge.weight);
      const newPath = [...pathSoFar, {
        source: node,
        target: edge.target,
        relationshipType: edge.type,
        weight: edge.weight,
      }];
      queue.push([dist + edgeCost, edge.target, depth + 1, newPath]);
    }
  }

  return { found: false, path: [], distance: Infinity };
}

// ── multi-hop traversal (BFS with depth limit) ─────────────────────────────

/**
 * Find all nodes reachable from a starting node within maxDepth hops (BFS).
 * Returns a map from node id to distance (number of hops from start).
 */
export function reachableNodes(
  graph: AdjacencyList,
  start: GraphNodeId,
  maxDepth = 3
): Map<GraphNodeId, number> {
  const reachable = new Map<GraphNodeId, number>();
  const queue: Array<[GraphNodeId, number]> = [[start, 0]];
  reachable.set(start, 0);

  while (queue.length > 0) {
    const [node, depth] = queue.shift()!;
    if (depth >= maxDepth) continue;

    for (const edge of graph.get(node) ?? []) {
      if (!reachable.has(edge.target)) {
        reachable.set(edge.target, depth + 1);
        queue.push([edge.target, depth + 1]);
      }
    }
  }

  return reachable;
}