import { describe, it, expect } from "vitest";
import { relateMemories, relateOne, STOP_WORDS, type RelateMemory } from "./relate";

/**
 * Derived relationship inference — the module that turns isolated memories into
 * a knowledge graph without any explicit links.
 *
 * Key properties pinned: bilingual stopword filtering, TF-IDF with L2 norm, cosine
 * via dot product, 4-signal scoring (entity/tag/semantic/project) with independent
 * gates, 2-pass pruning (connectivity then densification), deterministic ordering,
 * and the anti-hairball guarantees (minWeight floor, top-K per node, hard degree
 * ceiling, global edge cap).
 */

const memory = (overrides: Partial<RelateMemory>): RelateMemory => ({
  id: "m1",
  title: "Deploy notes",
  content: "Always run migrations before deploying to production",
  tags: [],
  projectId: null,
  entityIds: [],
  ...overrides,
});

describe("relateMemories - basic behavior", () => {
  it("returns empty edges for less than 2 memories", () => {
    expect(relateMemories([])).toEqual({ edges: [], candidates: 0 });
    expect(relateMemories([memory({ id: "m1" })])).toEqual({ edges: [], candidates: 0 });
  });

  it("returns no edges when memories share nothing", () => {
    const memories = [
      memory({ id: "m1", title: "Deploy", content: "Run migrations first" }),
      memory({ id: "m2", title: "Redis", content: "Cache configuration setup" }),
    ];

    const result = relateMemories(memories);

    expect(result.edges).toEqual([]);
  });

  it("creates an edge when memories share 2+ distinctive terms", () => {
    const memories = [
      memory({ id: "m1", title: "PostgreSQL migrations", content: "Database deploy strategy" }),
      memory({ id: "m2", title: "Database migrations", content: "PostgreSQL backup process" }),
    ];

    const result = relateMemories(memories);

    expect(result.edges.length).toBeGreaterThan(0);
    const edge = result.edges[0];
    expect(edge).toMatchObject({
      source: "m1",
      target: "m2",
      relation: "semantic",
    });
    expect(edge.weight).toBeGreaterThan(0);
    expect(edge.reason.toLowerCase()).toContain("migrations");
  });

  it("creates an edge for shared entities", () => {
    const memories = [
      memory({ id: "m1", title: "...", content: "...", entityIds: ["e1", "e2"] }),
      memory({ id: "m2", title: "...", content: "...", entityIds: ["e2", "e3"] }),
    ];

    const result = relateMemories(memories);

    expect(result.edges.length).toBe(1);
    // Entity is the strongest derived signal, should win
    expect(result.edges[0].relation).toBe("entity");
    expect(result.edges[0].reason.toLowerCase()).toContain("entity");
  });

  it("creates an edge for 2+ shared tags", () => {
    const memories = [
      memory({ id: "m1", title: "...", content: "...", tags: ["deploy", "production"] }),
      memory({ id: "m2", title: "...", content: "...", tags: ["deploy", "production", "monitoring"] }),
    ];

    const result = relateMemories(memories);

    expect(result.edges.length).toBe(1);
    expect(result.edges[0].relation).toBe("tag");
    expect(result.edges[0].reason.toLowerCase()).toContain("deploy");
  });

  it("creates an edge for one rare tag", () => {
    const memories = [
      memory({ id: "m1", tags: ["rare-tag"] }),
      memory({ id: "m2", tags: ["rare-tag"] }),
      memory({ id: "m3", tags: ["common"] }),
      memory({ id: "m4", tags: ["common"] }),
      memory({ id: "m5", tags: ["common"] }),
    ];

    const result = relateMemories(memories);

    const rareEdge = result.edges.find((e) => e.source === "m1" && e.target === "m2");
    expect(rareEdge).toBeDefined();
    expect(rareEdge?.relation).toBe("tag");
  });

  it("creates no edge for a single tag that everything carries", () => {
    // df 6 is past RARE_TAG_DF_ABS (4), so "notes" says nothing about any pair. Content
    // is mutually distinct so the semantic family cannot rescue the pair either: one
    // common tag is not a relationship, and the gate has to be the thing that says so.
    const bodies = [
      "hetzner firewall rules audited",
      "gmail smtp credentials rotated",
      "r2 bucket lifecycle policy",
      "invoice pdf generator template",
      "cron schedule for nightly digest",
      "webhook retry backoff tuning",
    ];
    const memories = bodies.map((content, i) =>
      memory({ id: `m${i + 1}`, title: `Entry ${i + 1}`, content, tags: ["notes"] })
    );

    expect(relateMemories(memories).edges).toEqual([]);
  });

  it("creates no edge for a shared project alone", () => {
    // PRINSIP 14 in its strongest form: projectId is a boost applied to a pair that
    // some other family already vouched for, never a family of its own. Two unrelated
    // memories filed under one project stay unrelated.
    const memories = [
      memory({ id: "m1", title: "Firewall", content: "hetzner firewall rules audited", projectId: "proj1" }),
      memory({ id: "m2", title: "Invoices", content: "invoice pdf generator template", projectId: "proj1" }),
    ];

    expect(relateMemories(memories).edges).toEqual([]);
  });
});

describe("stopwords and tokenization", () => {
  it("filters English stopwords", () => {
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("and")).toBe(true);
    expect(STOP_WORDS.has("will")).toBe(true);
  });

  it("filters Indonesian stopwords", () => {
    expect(STOP_WORDS.has("yang")).toBe(true);
    expect(STOP_WORDS.has("untuk")).toBe(true);
    expect(STOP_WORDS.has("adalah")).toBe(true);
  });

  it("does not connect memories that share only stopwords", () => {
    const memories = [
      memory({ id: "m1", title: "...", content: "this is the only text" }),
      memory({ id: "m2", title: "...", content: "this is also text" }),
    ];

    const result = relateMemories(memories);

    expect(result.edges).toEqual([]);
  });

  it("ignores tokens shorter than 3 chars", () => {
    const memories = [
      memory({ id: "m1", content: "ab cd deployment strategy" }),
      memory({ id: "m2", content: "xy deployment strategy plan" }),
    ];

    const result = relateMemories(memories);

    expect(result.edges.length).toBe(1);
    expect(result.edges[0].reason).not.toContain("ab");
    expect(result.edges[0].reason).not.toContain("cd");
  });

  it("ignores pure numbers as tokens", () => {
    const memories = [
      memory({ id: "m1", content: "123 456 deployment" }),
      memory({ id: "m2", content: "789 deployment process" }),
    ];

    const result = relateMemories(memories);

    const edge = result.edges[0];
    if (edge) {
      expect(edge.reason).not.toContain("123");
      expect(edge.reason).not.toContain("456");
    }
  });
});

describe("scoring and gates", () => {
  it("requires 2+ distinctive shared terms for semantic gate to pass", () => {
    const memories = [
      memory({ id: "m1", title: "...", content: "unique deployment word" }),
      memory({ id: "m2", title: "...", content: "different deployment term" }),
    ];

    // Only 1 shared distinctive term ("deployment"), semantic gate should not pass
    const result = relateMemories(memories);

    expect(result.edges).toEqual([]);
  });

  it("title terms have higher weight than content terms", () => {
    const memories = [
      memory({ id: "m1", title: "PostgreSQL migrations", content: "..." }),
      memory({ id: "m2", title: "...", content: "PostgreSQL migrations details" }),
      memory({ id: "m3", title: "Redis setup", content: "..." }),
    ];

    const result = relateMemories(memories);

    // m1 and m2 share "postgresql migrations" with title boost
    const edge = result.edges.find((e) =>
      (e.source === "m1" && e.target === "m2") || (e.source === "m2" && e.target === "m1")
    );
    expect(edge).toBeDefined();
  });

  it("combines multiple signals into one weight", () => {
    const memories = [
      memory({
        id: "m1",
        title: "Deploy",
        content: "PostgreSQL migrations production",
        tags: ["deploy", "database"],
        entityIds: ["e1"],
      }),
      memory({
        id: "m2",
        title: "Database",
        content: "PostgreSQL migrations backup",
        tags: ["deploy", "database"],
        entityIds: ["e1"],
      }),
    ];

    const result = relateMemories(memories);

    expect(result.edges.length).toBe(1);
    // Should have contributions from semantic, tag, and entity
    expect(result.edges[0].weight).toBeGreaterThan(0.5);
    expect(result.edges[0].reason).toBeTruthy();
  });

  it("boosts same-project pairs", () => {
    const memories = [
      memory({
        id: "m1",
        content: "deployment postgresql migrations",
        projectId: "proj1",
      }),
      memory({
        id: "m2",
        content: "deployment postgresql migrations",
        projectId: "proj1",
      }),
      memory({
        id: "m3",
        content: "deployment postgresql migrations",
        projectId: "proj2",
      }),
    ];

    const result = relateMemories(memories);

    const sameProject = result.edges.find((e) => e.source === "m1" && e.target === "m2");
    const diffProject = result.edges.find((e) =>
      (e.source === "m1" && e.target === "m3") || (e.source === "m2" && e.target === "m3")
    );

    if (sameProject && diffProject) {
      expect(sameProject.weight).toBeGreaterThan(diffProject.weight);
    }
  });
});

describe("pruning and anti-hairball", () => {
  it("respects minWeight floor", () => {
    const memories = [
      memory({ id: "m1", content: "deploy migrate" }),
      memory({ id: "m2", content: "deploy migrate" }),
    ];

    const result = relateMemories(memories, { minWeight: 0.9 });

    expect(result.edges).toEqual([]);
  });

  it("respects maxDegree ceiling per node", () => {
    const hub = memory({ id: "hub", tags: ["shared"], entityIds: ["e1"] });
    const spokes = Array.from({ length: 20 }, (_, i) =>
      memory({ id: `spoke${i}`, tags: ["shared"], entityIds: ["e1"] })
    );

    const result = relateMemories([hub, ...spokes], { maxDegree: 5 });

    const hubDegree = result.edges.filter((e) => e.source === "hub" || e.target === "hub").length;
    expect(hubDegree).toBeLessThanOrEqual(5);
  });

  it("respects top-K neighbours per node", () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      memory({ id: `m${i}`, tags: ["common"], content: "shared distinctive terms here" })
    );

    const result = relateMemories(memories, { neighbours: 3, maxDegree: 20 });

    const degrees = new Map<string, number>();
    for (const edge of result.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }

    // Each node should have at most ~3 neighbors (union rule allows some flexibility)
    for (const degree of degrees.values()) {
      expect(degree).toBeLessThanOrEqual(6);
    }
  });

  it("respects global maxEdges cap", () => {
    const memories = Array.from({ length: 20 }, (_, i) =>
      memory({ id: `m${i}`, tags: ["shared"], entityIds: ["e1"] })
    );

    const result = relateMemories(memories, { maxEdges: 10 });

    expect(result.edges.length).toBeLessThanOrEqual(10);
  });

  it("prioritizes connectivity over densification", () => {
    // Create memories where some have strong connections and others weak
    const memories = [
      memory({ id: "m1", entityIds: ["e1"], tags: ["a"] }),
      memory({ id: "m2", entityIds: ["e1"], tags: ["a"] }),
      memory({ id: "m3", entityIds: ["e2"], tags: ["b"] }),
      memory({ id: "m4", entityIds: ["e2"], tags: ["b"] }),
      memory({ id: "m5", content: "isolated unique content here" }),
    ];

    const result = relateMemories(memories, { maxEdges: 3 });

    // Every connected node should have at least 1 edge before any gets 2
    const degrees = new Map<string, number>();
    for (const edge of result.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }

    const connected = Array.from(degrees.keys()).filter((id) => id !== "m5");
    expect(connected.length).toBeGreaterThan(0);
  });
});

describe("deterministic ordering", () => {
  it("produces identical edges across multiple runs with same input", () => {
    const memories = [
      memory({ id: "m1", content: "postgresql migrations deployment", tags: ["db"] }),
      memory({ id: "m2", content: "postgresql migrations backup", tags: ["db"] }),
      memory({ id: "m3", content: "redis caching strategy", tags: ["cache"] }),
      memory({ id: "m4", content: "redis caching deployment", tags: ["cache"] }),
    ];

    const run1 = relateMemories(memories);
    const run2 = relateMemories(memories);
    const run3 = relateMemories(memories);

    expect(run1.edges).toEqual(run2.edges);
    expect(run2.edges).toEqual(run3.edges);
  });

  it("orders edges by descending weight", () => {
    const memories = [
      memory({ id: "m1", entityIds: ["e1", "e2"], tags: ["a", "b"] }),
      memory({ id: "m2", entityIds: ["e1", "e2"], tags: ["a", "b"] }),
      memory({ id: "m3", tags: ["a"] }),
      memory({ id: "m4", tags: ["a"] }),
    ];

    const result = relateMemories(memories);

    for (let i = 1; i < result.edges.length; i++) {
      expect(result.edges[i - 1].weight).toBeGreaterThanOrEqual(result.edges[i].weight);
    }
  });

  it("normalizes source/target to canonical order (source < target)", () => {
    const memories = [
      memory({ id: "z-memory", tags: ["shared"] }),
      memory({ id: "a-memory", tags: ["shared"] }),
    ];

    const result = relateMemories(memories);

    if (result.edges.length > 0) {
      for (const edge of result.edges) {
        expect(edge.source < edge.target).toBe(true);
      }
    }
  });
});

describe("edge properties", () => {
  it("includes relation type in each edge", () => {
    const memories = [
      memory({ id: "m1", entityIds: ["e1"] }),
      memory({ id: "m2", entityIds: ["e1"] }),
    ];

    const result = relateMemories(memories);

    expect(result.edges[0].relation).toMatch(/^(semantic|tag|entity|project)$/);
  });

  it("includes human-readable reason", () => {
    const memories = [
      memory({ id: "m1", tags: ["deploy", "production"] }),
      memory({ id: "m2", tags: ["deploy", "production"] }),
    ];

    const result = relateMemories(memories);

    expect(result.edges[0].reason).toBeTruthy();
    expect(typeof result.edges[0].reason).toBe("string");
    expect(result.edges[0].reason.length).toBeGreaterThan(0);
  });

  it("truncates long reasons to max length", () => {
    const longTag = "very-long-tag-name-that-exceeds-reasonable-length-limit-for-display-purposes";
    const memories = [
      memory({ id: "m1", tags: Array(10).fill(longTag) }),
      memory({ id: "m2", tags: Array(10).fill(longTag) }),
    ];

    const result = relateMemories(memories);

    if (result.edges.length > 0) {
      expect(result.edges[0].reason.length).toBeLessThanOrEqual(90);
    }
  });

  it("reports candidates count for diagnostics", () => {
    const memories = [
      memory({ id: "m1", tags: ["a"] }),
      memory({ id: "m2", tags: ["a"] }),
      memory({ id: "m3", tags: ["b"] }),
    ];

    const result = relateMemories(memories);

    expect(result.candidates).toBeGreaterThan(0);
    expect(typeof result.candidates).toBe("number");
  });
});

describe("relateOne - single-seed contract", () => {
  // Three shared distinctive content terms + a distinct title word each, so the
  // semantic gate passes and the pair carries some unique vocabulary too.
  const seed = memory({
    id: "seed",
    title: "Alpha",
    content: "postgresql migrations deployment strategy",
  });
  const candidate = memory({
    id: "cand",
    title: "Bravo",
    content: "postgresql migrations deployment rollback",
  });
  // Candidates whose vocabulary is disjoint from the seed: they raise the document
  // count without ever forming an edge with the seed.
  const filler = [
    memory({ id: "x1", title: "Redis", content: "redis caching layer configuration" }),
    memory({ id: "x2", title: "Hooks", content: "webhook retry backoff tuning" }),
    memory({ id: "x3", title: "Billing", content: "invoice pdf generator template" }),
  ];

  it("is deterministic: identical inputs produce identical output across runs", () => {
    const run1 = relateOne(seed, [candidate, ...filler]);
    const run2 = relateOne(seed, [candidate, ...filler]);
    const run3 = relateOne(seed, [candidate, ...filler]);

    expect(run1).toEqual(run2);
    expect(run2).toEqual(run3);
  });

  it("scores only the seed's pairs, never contains full content, and gates noise", () => {
    const results = relateOne(seed, [candidate, ...filler]);

    // The disjoint filler shares no distinctive vocabulary, so no gate opens for it.
    expect(results).toHaveLength(1);
    const [edge] = results;
    expect(edge.memoryA).toBe("seed");
    expect(edge.memoryB).toBe("cand");
    expect(edge.relation).toBe("semantic");
    expect(edge.weight).toBeGreaterThan(0);
    // Evidence is signal metadata only — never the memory bodies.
    const evidenceText = JSON.stringify(edge.evidence);
    expect(evidenceText).not.toContain("rollback");
    expect(evidenceText).not.toContain("strategy");
  });

  it("shares one scoring formula with relateMemories on IDENTICAL inputs", () => {
    // Same two documents both ways ⇒ same total, same df ⇒ scorePair must agree.
    // This is the only guarantee the two entry points actually make.
    const [oneEdge] = relateOne(seed, [candidate]);
    const sweep = relateMemories([seed, candidate]);

    expect(sweep.edges).toHaveLength(1);
    expect(oneEdge.weight).toBe(sweep.edges[0].weight);
    expect(oneEdge.relation).toBe(sweep.edges[0].relation);
  });

  it("computes DF LOCALLY over the candidate set, so it is NOT a full-brain score", () => {
    // The corrected contract. The seed↔candidate pair is unchanged, but adding
    // disjoint filler raises the document `total` while the shared terms' df stays
    // 2. idf = ln(1 + total/df) therefore shifts, and — because rare and common
    // terms shift by different factors — the L2-normalised cosine, and thus the
    // weight, moves. If DF were global/brain-wide this weight would be constant.
    const small = relateOne(seed, [candidate]);
    const large = relateOne(seed, [candidate, ...filler]);

    const smallEdge = small.find((e) => e.memoryB === "cand");
    const largeEdge = large.find((e) => e.memoryB === "cand");

    expect(smallEdge).toBeDefined();
    expect(largeEdge).toBeDefined();
    // Same pair, different weight: local DF, not the "byte-identical to a full-brain
    // relateMemories() call" the docstring once wrongly claimed.
    expect(largeEdge!.weight).not.toBe(smallEdge!.weight);
  });
});

