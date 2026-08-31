import { describe, it, expect } from "vitest";
import {
  buildUndirectedGraph,
  buildDirectedGraph,
  computeDegrees,
  pageRank,
  connectedComponents,
  findBridges,
  labelPropagation,
  findOrphans,
  findWeaklyConnected,
  shortestPath,
  reachableNodes,
  type GraphEdge,
} from "./algorithms";

describe("graph construction", () => {
  it("builds an undirected graph with bidirectional edges", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "related", weight: 1.0 },
      { source: "B", target: "C", type: "related", weight: 0.8 },
    ];
    const graph = buildUndirectedGraph(edges);

    expect(graph.get("A")).toHaveLength(1);
    expect(graph.get("B")).toHaveLength(2); // A→B and B→C both touch B
    expect(graph.get("C")).toHaveLength(1);
    expect(graph.get("A")![0].target).toBe("B");
    expect(graph.get("B")![0].target).toBe("A");
    expect(graph.get("B")![1].target).toBe("C");
    expect(graph.get("C")![0].target).toBe("B");
  });

  it("drops self-loops in undirected graphs", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "A", type: "self", weight: 1.0 },
      { source: "A", target: "B", type: "related", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);

    expect(graph.get("A")).toHaveLength(1);
    expect(graph.get("A")![0].target).toBe("B");
  });

  it("builds a directed graph with one-way edges", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "points_to", weight: 1.0 },
      { source: "B", target: "C", type: "points_to", weight: 1.0 },
    ];
    const graph = buildDirectedGraph(edges);

    expect(graph.get("A")).toHaveLength(1);
    expect(graph.get("B")).toHaveLength(1);
    expect(graph.get("C")).toHaveLength(0); // C has no outgoing edges
    expect(graph.get("A")![0].target).toBe("B");
    expect(graph.get("B")![0].target).toBe("C");
  });
});

describe("degree and centrality", () => {
  it("computes degree and weighted degree for an undirected graph", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "A", target: "C", type: "r", weight: 0.5 },
      { source: "B", target: "C", type: "r", weight: 0.8 },
    ];
    const graph = buildUndirectedGraph(edges);
    const degrees = computeDegrees(graph);

    expect(degrees.get("A")!.degree).toBe(2);
    expect(degrees.get("A")!.weightedDegree).toBeCloseTo(1.5, 1);
    expect(degrees.get("B")!.degree).toBe(2);
    expect(degrees.get("C")!.degree).toBe(2);
  });

  it("returns zero degree for isolated nodes", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    graph.set("D", []); // Isolated node
    const degrees = computeDegrees(graph);

    expect(degrees.get("D")!.degree).toBe(0);
    expect(degrees.get("D")!.weightedDegree).toBe(0);
  });
});

describe("PageRank", () => {
  it("computes PageRank for a small directed graph", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "link", weight: 1.0 },
      { source: "B", target: "C", type: "link", weight: 1.0 },
      { source: "C", target: "A", type: "link", weight: 1.0 },
    ];
    const graph = buildDirectedGraph(edges);
    const ranks = pageRank(graph);

    // In a symmetric cycle, all nodes should have equal rank.
    expect(ranks.get("A")!.rank).toBeCloseTo(ranks.get("B")!.rank, 2);
    expect(ranks.get("B")!.rank).toBeCloseTo(ranks.get("C")!.rank, 2);
    // Ranks sum to 1.
    const sum = Array.from(ranks.values()).reduce((acc, r) => acc + r.rank, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("gives higher rank to nodes with more inbound links", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "C", type: "link", weight: 1.0 },
      { source: "B", target: "C", type: "link", weight: 1.0 },
      { source: "C", target: "D", type: "link", weight: 1.0 },
    ];
    const graph = buildDirectedGraph(edges);
    const ranks = pageRank(graph);

    // C has two inbound links (from A and B), D has one (from C).
    // But A and B are leaf nodes with rank that flows to C, then to D.
    // The assertion should compare C (hub) to A or B (leaves), not to D.
    expect(ranks.get("C")!.rank).toBeGreaterThan(ranks.get("A")!.rank);
    expect(ranks.get("C")!.rank).toBeGreaterThan(ranks.get("B")!.rank);
  });

  it("returns empty map for an empty graph", () => {
    const graph = buildDirectedGraph([]);
    const ranks = pageRank(graph);
    expect(ranks.size).toBe(0);
  });
});

describe("connected components", () => {
  it("finds one component in a fully connected graph", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const components = connectedComponents(graph);

    const componentA = components.get("A");
    expect(components.get("B")).toBe(componentA);
    expect(components.get("C")).toBe(componentA);
  });

  it("finds multiple components in a disconnected graph", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "C", target: "D", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const components = connectedComponents(graph);

    const componentA = components.get("A");
    const componentC = components.get("C");
    expect(components.get("B")).toBe(componentA);
    expect(components.get("D")).toBe(componentC);
    expect(componentA).not.toBe(componentC);
  });
});

describe("bridges", () => {
  it("finds a bridge that connects two clusters", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 }, // Bridge
      { source: "C", target: "D", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const bridges = findBridges(graph);

    expect(bridges.length).toBeGreaterThan(0);
    const hasBridge = bridges.some(
      (b) => (b.source === "B" && b.target === "C") || (b.source === "C" && b.target === "B")
    );
    expect(hasBridge).toBe(true);
  });

  it("finds no bridges in a cycle", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "A", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const bridges = findBridges(graph);

    expect(bridges).toHaveLength(0);
  });
});

describe("label propagation", () => {
  it("detects communities in a graph with two clusters", () => {
    const edges: GraphEdge[] = [
      // Cluster 1
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "A", type: "r", weight: 1.0 },
      // Cluster 2
      { source: "D", target: "E", type: "r", weight: 1.0 },
      { source: "E", target: "F", type: "r", weight: 1.0 },
      { source: "F", target: "D", type: "r", weight: 1.0 },
      // Weak bridge
      { source: "C", target: "D", type: "r", weight: 0.1 },
    ];
    const graph = buildUndirectedGraph(edges);
    const labels = labelPropagation(graph);

    // Nodes in the same cluster should share a label.
    const labelA = labels.get("A");
    const labelD = labels.get("D");
    expect(labels.get("B")).toBe(labelA);
    expect(labels.get("C")).toBe(labelA);
    expect(labels.get("E")).toBe(labelD);
    expect(labels.get("F")).toBe(labelD);
  });

  it("converges for a single-node graph", () => {
    const graph = buildUndirectedGraph([]);
    graph.set("A", []);
    const labels = labelPropagation(graph);

    expect(labels.get("A")).toBe("A");
  });

  it("is deterministic: repeated runs on the same graph agree exactly", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "A", type: "r", weight: 1.0 },
      { source: "C", target: "D", type: "r", weight: 0.1 },
      { source: "D", target: "E", type: "r", weight: 1.0 },
      { source: "E", target: "F", type: "r", weight: 1.0 },
      { source: "F", target: "D", type: "r", weight: 1.0 },
    ];

    const first = labelPropagation(buildUndirectedGraph(edges));
    for (let run = 0; run < 20; run += 1) {
      const again = labelPropagation(buildUndirectedGraph(edges));
      expect([...again.entries()].sort()).toEqual([...first.entries()].sort());
    }
  });

  it("is insensitive to the order the edges arrive in", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "A", type: "r", weight: 1.0 },
      { source: "D", target: "E", type: "r", weight: 1.0 },
      { source: "E", target: "F", type: "r", weight: 1.0 },
      { source: "F", target: "D", type: "r", weight: 1.0 },
    ];

    const forward = labelPropagation(buildUndirectedGraph(edges));
    const reversed = labelPropagation(buildUndirectedGraph([...edges].reverse()));

    // Same partition: two triangles, each sharing one label internally.
    const partitionOf = (labels: Map<string, string>) =>
      ["A", "B", "C", "D", "E", "F"].map((node) => labels.get(node) === labels.get("A"));

    expect(partitionOf(reversed)).toEqual(partitionOf(forward));
  });
});

describe("orphans and knowledge gaps", () => {
  it("finds orphan nodes with degree 0", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    graph.set("C", []); // Orphan
    const orphans = findOrphans(graph);

    expect(orphans).toContain("C");
    expect(orphans).not.toContain("A");
    expect(orphans).not.toContain("B");
  });

  it("finds weakly connected nodes with degree 1", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "D", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const weak = findWeaklyConnected(graph);

    // A and D each have degree 1.
    expect(weak).toContain("A");
    expect(weak).toContain("D");
    expect(weak).not.toContain("B");
    expect(weak).not.toContain("C");
  });
});

describe("shortest path", () => {
  it("finds the shortest path between two nodes", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "A", target: "D", type: "r", weight: 0.5 },
      { source: "D", target: "C", type: "r", weight: 0.5 },
    ];
    const graph = buildUndirectedGraph(edges);
    const result = shortestPath(graph, "A", "C", 5);

    expect(result.found).toBe(true);
    expect(result.path.length).toBeGreaterThan(0);
    expect(result.path[0].source).toBe("A");
    expect(result.path[result.path.length - 1].target).toBe("C");
  });

  it("returns not found when target is unreachable", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "C", target: "D", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const result = shortestPath(graph, "A", "D", 5);

    expect(result.found).toBe(false);
    expect(result.path).toHaveLength(0);
    expect(result.distance).toBe(Infinity);
  });

  it("returns empty path when source equals target", () => {
    const graph = buildUndirectedGraph([
      { source: "A", target: "B", type: "r", weight: 1.0 },
    ]);
    const result = shortestPath(graph, "A", "A", 5);

    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(0);
    expect(result.distance).toBe(0);
  });

  it("respects the maxDepth limit", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "D", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const result = shortestPath(graph, "A", "D", 2); // Only 2 hops allowed

    expect(result.found).toBe(false);
  });

  it("reports distance as a hop count for a path of explicit links", () => {
    const graph = buildUndirectedGraph([
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
    ]);

    expect(shortestPath(graph, "A", "C", 5).distance).toBe(2);
  });

  it("prefers the shorter route even when its evidence is weaker", () => {
    // Each hop costs at least 1, so two certainties cannot beat one direct link.
    const graph = buildUndirectedGraph([
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "A", target: "C", type: "similar", weight: 0.5 },
    ]);

    const result = shortestPath(graph, "A", "C", 5);
    expect(result.path).toHaveLength(1);
    expect(result.distance).toBe(1.5);
  });

  it("breaks a tie between equal-length routes on evidence", () => {
    const graph = buildUndirectedGraph([
      { source: "A", target: "X", type: "r", weight: 1.0 },
      { source: "X", target: "C", type: "r", weight: 1.0 },
      { source: "A", target: "Y", type: "similar", weight: 0.4 },
      { source: "Y", target: "C", type: "similar", weight: 0.4 },
    ]);

    const result = shortestPath(graph, "A", "C", 5);
    expect(result.path.map((hop) => hop.target)).toEqual(["X", "C"]);
    expect(result.distance).toBe(2);
  });
});

describe("reachable nodes", () => {
  it("finds all nodes within maxDepth hops", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
      { source: "B", target: "C", type: "r", weight: 1.0 },
      { source: "C", target: "D", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const reachable = reachableNodes(graph, "A", 2);

    expect(reachable.has("A")).toBe(true);
    expect(reachable.get("A")).toBe(0);
    expect(reachable.has("B")).toBe(true);
    expect(reachable.get("B")).toBe(1);
    expect(reachable.has("C")).toBe(true);
    expect(reachable.get("C")).toBe(2);
    expect(reachable.has("D")).toBe(false); // Beyond maxDepth
  });

  it("returns only the start node when maxDepth is 0", () => {
    const edges: GraphEdge[] = [
      { source: "A", target: "B", type: "r", weight: 1.0 },
    ];
    const graph = buildUndirectedGraph(edges);
    const reachable = reachableNodes(graph, "A", 0);

    expect(reachable.size).toBe(1);
    expect(reachable.has("A")).toBe(true);
    expect(reachable.has("B")).toBe(false);
  });
});
