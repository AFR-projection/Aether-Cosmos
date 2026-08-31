import { describe, expect, it } from "vitest";
import {
  RELATE_DEFAULTS,
  relateMemories,
  type DerivedEdge,
  type RelateMemory,
} from "@brain/domain/graph/relate";

/**
 * The derivation is the reason the graph has edges at all: the two explicit
 * relationship tables are empty in a brain that never used the link API. These
 * tests pin the two properties that make it trustworthy — a pair with a real
 * signal gets an edge, and a pair with a coincidence does not — plus the shape of
 * the result: hubs, orphans and sparseness at scale.
 */

function memory(partial: Partial<RelateMemory> & { id: string }): RelateMemory {
  return {
    title: "",
    content: "",
    tags: [],
    projectId: null,
    entityIds: [],
    ...partial,
  };
}

/** Undirected lookup: the derivation orders endpoints canonically, not by input. */
function edgeBetween(edges: DerivedEdge[], a: string, b: string): DerivedEdge | undefined {
  return edges.find(
    (edge) =>
      (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a)
  );
}

function degreeOf(edges: DerivedEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

const FILLER = [
  memory({ id: "f1", title: "Rendang recipe", content: "beef coconut chili cook long" }),
  memory({ id: "f2", title: "Exercise schedule", content: "swim morning pool ticket monthly" }),
  memory({ id: "f3", title: "Reading list", content: "novel history maritime archipelago" }),
];

describe("relateMemories — signals that must create an edge", () => {
  it("links a pair that shares several distinctive terms", () => {
    const { edges } = relateMemories([
      memory({
        id: "a",
        title: "Production VPS infrastructure",
        content: "deploy ubuntu via ssh to production vps, nginx reverse proxy, docker compose",
      }),
      memory({
        id: "b",
        title: "Ubuntu deploy notes",
        content: "ssh to vps, run docker compose, check nginx before redeploying",
      }),
      ...FILLER,
    ]);

    const edge = edgeBetween(edges, "a", "b");
    expect(edge).toBeDefined();
    expect(edge?.relation).toBe("semantic");
    expect(edge?.reason).toMatch(/Shared terms:/);
    expect(edge?.weight).toBeGreaterThan(RELATE_DEFAULTS.minWeight);
  });

  it("links a pair that shares one rare tag, and labels it as a tag relation", () => {
    const { edges } = relateMemories([
      memory({ id: "a", title: "User identity", content: "nickname boss", tags: ["aldo"] }),
      memory({ id: "b", title: "Professional profile", content: "linkedin portfolio", tags: ["aldo"] }),
      ...FILLER,
    ]);

    const edge = edgeBetween(edges, "a", "b");
    expect(edge?.relation).toBe("tag");
    expect(edge?.reason).toContain("aldo");
  });

  it("ranks a shared entity above a shared tag", () => {
    const { edges } = relateMemories([
      memory({ id: "a", title: "Kickoff meeting", entityIds: ["e-nova"] }),
      memory({ id: "b", title: "Release notes", entityIds: ["e-nova"] }),
      memory({ id: "c", title: "Feature idea", tags: ["rare-tag"] }),
      memory({ id: "d", title: "Follow-up idea", tags: ["rare-tag"] }),
      ...FILLER,
    ]);

    const entityEdge = edgeBetween(edges, "a", "b");
    const tagEdge = edgeBetween(edges, "c", "d");
    expect(entityEdge?.relation).toBe("entity");
    expect(tagEdge?.relation).toBe("tag");
    expect(entityEdge!.weight).toBeGreaterThan(tagEdge!.weight);
  });
});

describe("relateMemories — coincidences that must not create an edge", () => {
  it("does not link two memories that share a single word", () => {
    const { edges } = relateMemories([
      memory({
        id: "a",
        title: "Telegram notification for gold price",
        content: "send alert when metal price crosses daily threshold",
      }),
      memory({
        id: "b",
        title: "Telegram photography community group",
        content: "discuss manual lens, print album, hunt twilight light",
      }),
      ...FILLER,
    ]);

    expect(edgeBetween(edges, "a", "b")).toBeUndefined();
  });

  it("does not link two memories on a tag that half the brain carries", () => {
    const common = Array.from({ length: 8 }, (_, index) =>
      memory({
        id: `c${index}`,
        title: `Note ${index}`,
        content: `note content number ${index} without any similarity ${"xyz".repeat(index + 1)}`,
        tags: ["notes"],
      })
    );
    const { edges } = relateMemories([...common, ...FILLER]);
    expect(edges).toHaveLength(0);
  });

  it("does not link two memories on a shared project alone", () => {
    const { edges } = relateMemories([
      memory({ id: "a", title: "Competitor research", content: "pricing package overseas rival", projectId: "p1" }),
      memory({ id: "b", title: "Icon design", content: "grid eight pixel thin line", projectId: "p1" }),
      ...FILLER,
    ]);

    expect(edgeBetween(edges, "a", "b")).toBeUndefined();
  });

  it("never derives an edge for a brain with a single memory", () => {
    expect(relateMemories([memory({ id: "only", title: "Alone" })])).toEqual({
      edges: [],
      candidates: 0,
    });
  });
});

describe("relateMemories — shape of the resulting network", () => {
  /** One memory tied to many, each by its own rare tag, plus one tied to nothing. */
  function hubBrain(spokes: number): RelateMemory[] {
    const hub = memory({
      id: "hub",
      title: "Knowledge hub",
      tags: Array.from({ length: spokes }, (_, index) => `theme-${index}`),
    });
    const leaves = Array.from({ length: spokes }, (_, index) =>
      memory({
        id: `spoke-${index}`,
        title: `Branch ${index}`,
        content: `unique description ${"q".repeat(index + 2)}`,
        tags: [`theme-${index}`],
      })
    );
    return [hub, ...leaves, memory({ id: "orphan", title: "Not connected", content: "alone" })];
  }

  it("lets a genuine hub exceed the per-node top-K, because the rule is a union", () => {
    const { edges } = relateMemories(hubBrain(10));
    const degree = degreeOf(edges);
    expect(degree.get("hub")).toBe(10);
    expect(degree.get("hub")!).toBeGreaterThan(RELATE_DEFAULTS.neighbours);
  });

  it("still caps a hub at the hard degree ceiling", () => {
    const { edges } = relateMemories(hubBrain(30));
    const degree = degreeOf(edges);
    expect(degree.get("hub")).toBe(RELATE_DEFAULTS.maxDegree);
  });

  it("leaves an unrelated memory out of every edge instead of inventing one", () => {
    const { edges } = relateMemories(hubBrain(10));
    expect(edges.some((edge) => edge.source === "orphan" || edge.target === "orphan")).toBe(false);
  });

  it("returns the same edges whatever order the memories arrive in", () => {
    const brain = hubBrain(8);
    const keyed = (edges: DerivedEdge[]) =>
      edges.map((edge) => `${edge.source}|${edge.target}|${edge.weight}`).sort();
    const forward = relateMemories(brain);
    const reversed = relateMemories([...brain].reverse());
    expect(keyed(reversed.edges)).toEqual(keyed(forward.edges));
  });
});

describe("relateMemories — scale", () => {
  /** `clusters` topics of `size` memories each, with no vocabulary in common. */
  function clustered(clusters: number, size: number): RelateMemory[] {
    const memories: RelateMemory[] = [];
    for (let topic = 0; topic < clusters; topic += 1) {
      for (let index = 0; index < size; index += 1) {
        memories.push(
          memory({
            id: `t${topic}-m${index}`,
            title: `Topik ${topic} bagian ${index}`,
            content: `istilah${topic}alpha istilah${topic}beta istilah${topic}gamma catatan${index}`,
            tags: [`topik-${topic}`],
          })
        );
      }
    }
    return memories;
  }

  it("stays sparse and bounded on a 1200-memory brain", () => {
    const memories = clustered(120, 10);
    const started = Date.now();
    const { edges, candidates } = relateMemories(memories);
    const elapsed = Date.now() - started;

    const degree = degreeOf(edges);
    const worst = Math.max(...degree.values());

    expect(edges.length).toBeLessThanOrEqual(RELATE_DEFAULTS.maxEdges);
    // A complete graph would be 719,400 edges; a per-cluster clique 5,400. The
    // top-K union has to land well under both while still connecting every cluster.
    expect(edges.length).toBeLessThan(memories.length * 4);
    expect(worst).toBeLessThanOrEqual(RELATE_DEFAULTS.maxDegree);
    expect(degree.size).toBe(memories.length);
    expect(candidates).toBeLessThan(50_000);
    expect(elapsed).toBeLessThan(4000);
  });

  it("never joins two clusters that share nothing", () => {
    const { edges } = relateMemories(clustered(40, 6));
    const topicOf = (id: string) => id.split("-")[0];
    expect(edges.every((edge) => topicOf(edge.source) === topicOf(edge.target))).toBe(true);
  });
});
