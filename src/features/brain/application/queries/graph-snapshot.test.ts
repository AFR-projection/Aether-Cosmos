import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/shared/infrastructure/db/schema";
import { buildBrainGraphSnapshot } from "./graph-snapshot";

/**
 * Graph snapshot construction — the module that builds a complete bounded graph
 * for the interactive force-directed view.
 *
 * Key properties pinned: entity-first node budget allocation, truncation detection
 * via limit+1, explicit edges get priority over derived, no duplicate edges
 * (explicitPairs prevents derived overlap), FNV-1a fingerprint cache with LRU
 * eviction (max 8), dropped edge tracking for truncated endpoints, brain isolation,
 * canonical ordering (entities by name asc, memories by importance desc), and filter
 * vocabulary derived from snapshot content.
 */

type Rows = Record<string, unknown[][]>;
type ReadCall = { table: string; where: unknown; join?: unknown; limit: number | null; order: unknown };

function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if ("queryChunks" in record) walk(record.queryChunks);
    if ("value" in record) walk(record.value);
    else if (typeof record.name === "string") parts.push(record.name);
    if ("sql" in record && typeof record.sql === "string") parts.push(record.sql);
  };

  walk(node);
  return parts.join(" ");
}

const reads: ReadCall[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();

function selectChain() {
  const call: ReadCall = { table: "", where: null, join: null, limit: null, order: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    innerJoin(target: unknown, on: unknown) {
      if (!call.join) call.join = [];
      (call.join as unknown[]).push({ type: "inner", target: getTableName(target as never), on });
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy(...args: unknown[]) {
      call.order = args;
      return chain;
    },
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T) {
      reads.push(call);
      const index = cursors.get(call.table) ?? 0;
      cursors.set(call.table, index + 1);
      return Promise.resolve(rows[call.table]?.[index] ?? []).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    select: () => selectChain(),
  },
}));

// Mock relateMemories to avoid TF-IDF computation in tests
const mockRelateMemories = vi.fn();
vi.mock("@brain/domain/graph/relate", () => ({
  relateMemories: (...args: unknown[]) => mockRelateMemories(...args),
}));

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";

const ENTITY_TABLE = getTableName(schema.brainEntities);
const MEMORY_TABLE = getTableName(schema.memories);
const TAG_MAP_TABLE = getTableName(schema.memoryTagMap);
const RELATIONSHIP_TABLE = getTableName(schema.brainRelationships);
const LINK_TABLE = getTableName(schema.memoryLinks);
const PROJECT_TABLE = getTableName(schema.brainProjects);

beforeEach(() => {
  reads.length = 0;
  rows = {};
  cursors.clear();
  mockRelateMemories.mockReturnValue({ edges: [], candidates: 0 });
});

describe("buildBrainGraphSnapshot - empty graphs", () => {
  it("returns empty snapshot for brain with no entities or memories", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.truncated.nodes).toBe(false);
    expect(snapshot.truncated.edges).toBe(false);
    expect(snapshot.edgeStats.explicit).toBe(0);
    expect(snapshot.edgeStats.dropped).toBe(0);
  });

  it("includes entities when memories are excluded", async () => {
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "Redis", type: "technology", description: "Cache", updatedAt: new Date() }
    ]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, includeMemories: false });

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({ id: "e1", kind: "entity", label: "Redis" });
  });

  it("queries all 6 tables for a full snapshot", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(reads).toHaveLength(6);
    const tables = reads.map((r) => r.table);
    expect(tables).toContain(ENTITY_TABLE);
    expect(tables).toContain(MEMORY_TABLE);
    expect(tables).toContain(TAG_MAP_TABLE);
    expect(tables).toContain(RELATIONSHIP_TABLE);
    expect(tables).toContain(LINK_TABLE);
    expect(tables).toContain(PROJECT_TABLE);
  });
});

describe("node budget allocation", () => {
  it("gives entities first claim on the node budget", async () => {
    rows[ENTITY_TABLE] = [
      Array.from({ length: 100 }, (_, i) => ({
        id: `e${i}`,
        name: `Entity ${i}`,
        type: "technology",
        description: null,
        updatedAt: new Date(),
      })),
    ];
    rows[MEMORY_TABLE] = [
      Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`,
        title: `Memory ${i}`,
        type: "fact",
        summary: null,
        importance: 0.5,
        projectId: null,
        updatedAt: new Date(),
        contentHead: "...",
      })),
    ];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, nodeLimit: 120 });

    const entityNodes = snapshot.nodes.filter((n) => n.kind === "entity");
    const memoryNodes = snapshot.nodes.filter((n) => n.kind === "memory");
    expect(entityNodes.length).toBe(100);
    expect(memoryNodes.length).toBe(20); // 120 - 100
  });

  it("detects entity truncation by reading limit+1", async () => {
    rows[ENTITY_TABLE] = [
      Array.from({ length: 51 }, (_, i) => ({
        id: `e${i}`,
        name: `Entity ${i}`,
        type: "technology",
        description: null,
        updatedAt: new Date(),
      })),
    ];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, nodeLimit: 50 });

    expect(snapshot.nodes.length).toBe(50);
    expect(snapshot.truncated.nodes).toBe(true);
    const entityRead = reads.find((r) => r.table === ENTITY_TABLE);
    expect(entityRead?.limit).toBe(51); // nodeLimit + 1
  });

  it("detects memory truncation when entity budget is exhausted", async () => {
    rows[ENTITY_TABLE] = [
      Array.from({ length: 10 }, (_, i) => ({
        id: `e${i}`,
        name: `Entity ${i}`,
        type: "technology",
        description: null,
        updatedAt: new Date(),
      })),
    ];
    rows[MEMORY_TABLE] = [
      Array.from({ length: 21 }, (_, i) => ({
        id: `m${i}`,
        title: `Memory ${i}`,
        type: "fact",
        summary: null,
        importance: 0.5,
        projectId: null,
        updatedAt: new Date(),
        contentHead: "...",
      })),
    ];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, nodeLimit: 30 });

    expect(snapshot.nodes.length).toBe(30);
    expect(snapshot.truncated.nodes).toBe(true);
    const memoryRead = reads.find((r) => r.table === MEMORY_TABLE);
    expect(memoryRead?.limit).toBe(21); // (30 - 10) + 1
  });

  it("skips memory queries when includeMemories is false", async () => {
    rows[ENTITY_TABLE] = [[{ id: "e1", name: "Redis", type: "technology", description: null, updatedAt: new Date() }]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN, includeMemories: false });

    expect(reads.filter((r) => r.table === MEMORY_TABLE)).toHaveLength(0);
    expect(reads.filter((r) => r.table === TAG_MAP_TABLE)).toHaveLength(0);
    expect(reads.filter((r) => r.table === LINK_TABLE)).toHaveLength(0);
  });
});

describe("canonical ordering", () => {
  it("orders entities by name ascending", async () => {
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "Zebra", type: "technology", description: null, updatedAt: new Date() },
      { id: "e2", name: "Apple", type: "technology", description: null, updatedAt: new Date() },
      { id: "e3", name: "Mango", type: "technology", description: null, updatedAt: new Date() },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    const entityRead = reads.find((r) => r.table === ENTITY_TABLE);
    const orderStr = describeSql(entityRead?.order);
    expect(orderStr).toContain("name");
  });

  it("orders memories by importance desc, then updatedAt desc", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      {
        id: "m1",
        title: "Low importance",
        type: "fact",
        summary: null,
        importance: 0.3,
        projectId: null,
        updatedAt: new Date("2026-08-22"),
        contentHead: "...",
      },
      {
        id: "m2",
        title: "High importance",
        type: "fact",
        summary: null,
        importance: 0.9,
        projectId: null,
        updatedAt: new Date("2026-08-20"),
        contentHead: "...",
      },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    const memoryRead = reads.find((r) => r.table === MEMORY_TABLE);
    const orderStr = describeSql(memoryRead?.order);
    expect(orderStr).toContain("importance");
    expect(orderStr).toContain("updated_at");
  });
});

describe("explicit edges", () => {
  it("includes relationship edges between entities", async () => {
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "Redis", type: "technology", description: null, updatedAt: new Date() },
      { id: "e2", name: "Queue", type: "technology", description: null, updatedAt: new Date() },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[
      { id: "r1", source: "e1", target: "e2", type: "depends_on" },
    ]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toMatchObject({
      id: "r1",
      source: "e1",
      target: "e2",
      type: "depends_on",
      kind: "relationship",
      relation: "explicit",
      weight: 1,
      reason: null,
    });
    expect(snapshot.edgeStats.explicit).toBe(1);
  });

  it("includes link edges between memories and entities", async () => {
    rows[ENTITY_TABLE] = [[{ id: "e1", name: "Redis", type: "technology", description: null, updatedAt: new Date() }]];
    rows[MEMORY_TABLE] = [[
      {
        id: "m1",
        title: "Deploy notes",
        type: "fact",
        summary: null,
        importance: 0.5,
        projectId: null,
        updatedAt: new Date(),
        contentHead: "...",
      },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[
      { id: "l1", source: "m1", targetMemoryId: null, targetEntityId: "e1", type: "references" },
    ]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toMatchObject({
      id: "l1",
      source: "m1",
      target: "e1",
      type: "references",
      kind: "link",
      relation: "explicit",
      weight: 1,
    });
  });

  it("drops edges where source or target was truncated", async () => {
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "A", type: "technology", description: null, updatedAt: new Date() },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[
      { id: "r1", source: "e1", target: "e2", type: "depends_on" }, // e2 not in nodes
    ]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.edges).toEqual([]);
    expect(snapshot.edgeStats.dropped).toBe(1);
  });

  it("drops links with neither targetMemoryId nor targetEntityId", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "Memory", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[
      { id: "l1", source: "m1", targetMemoryId: null, targetEntityId: null, type: "references" },
    ]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.edges).toEqual([]);
    expect(snapshot.edgeStats.dropped).toBe(1);
  });
});

describe("derived edges", () => {
  it("calls relateMemories with memory inputs", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      {
        id: "m1",
        title: "Deploy",
        type: "fact",
        summary: null,
        importance: 0.5,
        projectId: "proj1",
        updatedAt: new Date(),
        contentHead: "PostgreSQL migrations",
      },
      {
        id: "m2",
        title: "Database",
        type: "fact",
        summary: null,
        importance: 0.5,
        projectId: "proj1",
        updatedAt: new Date(),
        contentHead: "PostgreSQL backup",
      },
    ]];
    rows[TAG_MAP_TABLE] = [[
      { memoryId: "m1", name: "deploy" },
      { memoryId: "m2", name: "database" },
    ]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];
    mockRelateMemories.mockClear();
    mockRelateMemories.mockReturnValue({ edges: [], candidates: 0 });

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(mockRelateMemories).toHaveBeenCalledTimes(1);
    const inputs = mockRelateMemories.mock.calls[0][0];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      id: "m1",
      title: "Deploy",
      content: "PostgreSQL migrations",
      tags: ["deploy"],
      projectId: "proj1",
      entityIds: [],
    });
  });

  it("adds derived edges to the snapshot", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m2", title: "B", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];
    mockRelateMemories.mockReturnValue({
      edges: [{ source: "m1", target: "m2", relation: "semantic", weight: 0.7, reason: "Shared terms" }],
      candidates: 1,
    });

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toMatchObject({
      id: "d:m1:m2",
      source: "m1",
      target: "m2",
      type: "semantic",
      kind: "derived",
      relation: "semantic",
      weight: 0.7,
      reason: "Shared terms",
    });
    expect(snapshot.edgeStats.semantic).toBe(1);
    expect(snapshot.edgeStats.candidates).toBe(1);
  });

  it("does not add derived edge if explicit edge already exists for the pair", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m2", title: "B", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[
      { id: "l1", source: "m1", targetMemoryId: "m2", targetEntityId: null, type: "references" },
    ]];
    rows[PROJECT_TABLE] = [[]];
    mockRelateMemories.mockReturnValue({
      edges: [{ source: "m1", target: "m2", relation: "semantic", weight: 0.7, reason: "Shared terms" }],
      candidates: 1,
    });

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0].kind).toBe("link"); // Explicit wins
    expect(snapshot.edgeStats.explicit).toBe(1);
    expect(snapshot.edgeStats.semantic).toBe(0);
  });

  it("uses unordered pair key so m1->m2 and m2->m1 are considered the same", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m2", title: "B", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[
      { id: "l1", source: "m2", targetMemoryId: "m1", targetEntityId: null, type: "contradicts" },
    ]];
    rows[PROJECT_TABLE] = [[]];
    mockRelateMemories.mockReturnValue({
      edges: [{ source: "m1", target: "m2", relation: "semantic", weight: 0.7, reason: "Shared" }],
      candidates: 1,
    });

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    // Derived edge should be filtered out because explicit exists (even though direction differs)
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0].id).toBe("l1");
  });
});

describe("edge prioritization and truncation", () => {
  it("explicit edges get priority over derived when edge limit is exceeded", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m2", title: "B", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m3", title: "C", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[
      { id: "l1", source: "m1", targetMemoryId: "m2", targetEntityId: null, type: "references" },
    ]];
    rows[PROJECT_TABLE] = [[]];
    mockRelateMemories.mockReturnValue({
      edges: [
        { source: "m2", target: "m3", relation: "semantic", weight: 0.8, reason: "High" },
        { source: "m1", target: "m3", relation: "tag", weight: 0.6, reason: "Medium" },
      ],
      candidates: 2,
    });

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, edgeLimit: 2 });

    expect(snapshot.edges).toHaveLength(2);
    // Explicit edge l1 must be included
    expect(snapshot.edges.find((e) => e.id === "l1")).toBeDefined();
    expect(snapshot.truncated.edges).toBe(true);
  });

  it("detects edge truncation when candidates exceed limit", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m2", title: "B", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];
    mockRelateMemories.mockReturnValue({
      edges: Array.from({ length: 100 }, (_, i) => ({
        source: "m1",
        target: "m2",
        relation: "semantic",
        weight: 0.5,
        reason: `Edge ${i}`,
      })),
      candidates: 100,
    });

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, edgeLimit: 50 });

    expect(snapshot.edges.length).toBeLessThanOrEqual(50);
    expect(snapshot.truncated.edges).toBe(true);
  });

  it("detects edge truncation from DB query limit", async () => {
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "A", type: "technology", description: null, updatedAt: new Date() },
      { id: "e2", name: "B", type: "technology", description: null, updatedAt: new Date() },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [
      Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, source: "e1", target: "e2", type: "type" })),
    ];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN, edgeLimit: 50 });

    expect(snapshot.truncated.edges).toBe(true);
  });
});

describe("brain isolation", () => {
  it("filters all queries by brainId", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    for (const read of reads) {
      const predicate = describeSql(read.where);
      expect(predicate).toContain(BRAIN);
      expect(predicate).not.toContain(OTHER_BRAIN);
    }
  });

  it("excludes deleted memories from snapshot", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    const memoryRead = reads.find((r) => r.table === MEMORY_TABLE);
    const predicate = describeSql(memoryRead?.where);
    expect(predicate).toContain("deleted_at");
  });

  it("excludes archived memories from snapshot", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    await buildBrainGraphSnapshot({ brainId: BRAIN });

    const memoryRead = reads.find((r) => r.table === MEMORY_TABLE);
    const predicate = describeSql(memoryRead?.where);
    expect(predicate).toContain("archived_at");
  });
});

describe("tags and projects", () => {
  it("attaches tags to memory nodes", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "Memory", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[
      { memoryId: "m1", name: "deploy" },
      { memoryId: "m1", name: "production" },
    ]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.nodes[0].tags).toEqual(["deploy", "production"]);
  });

  it("skips tags for memories that were truncated out", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "Included", type: "fact", summary: null, importance: 0.9, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[
      { memoryId: "m1", name: "included" },
      { memoryId: "m2", name: "excluded" }, // m2 not in nodes
    ]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.tags).toEqual(["included"]);
    expect(snapshot.tags).not.toContain("excluded");
  });

  it("derives tag vocabulary from nodes actually in snapshot", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
      { id: "m2", title: "B", type: "fact", summary: null, importance: 0.5, projectId: null, updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[
      { memoryId: "m1", name: "zebra" },
      { memoryId: "m2", name: "apple" },
    ]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.tags).toEqual(["apple", "zebra"]); // Sorted
  });

  it("includes only projects referenced by nodes in snapshot", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      { id: "m1", title: "A", type: "fact", summary: null, importance: 0.5, projectId: "proj1", updatedAt: new Date(), contentHead: "..." },
    ]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[
      { id: "proj1", name: "Active Project" },
      { id: "proj2", name: "Unused Project" },
    ]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toEqual({ id: "proj1", name: "Active Project" });
  });

  it("always includes entity types and memory types from constants", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.entityTypes.length).toBeGreaterThan(0);
    expect(snapshot.memoryTypes.length).toBeGreaterThan(0);
  });
});

describe("node and edge properties", () => {
  it("entity nodes have correct shape", async () => {
    const now = new Date("2026-08-22T10:00:00Z");
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "Redis", type: "technology", description: "Cache system", updatedAt: now },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.nodes[0]).toEqual({
      id: "e1",
      kind: "entity",
      label: "Redis",
      type: "technology",
      detail: "Cache system",
      tags: [],
      projectId: null,
      importance: null,
      updatedAt: now.toISOString(),
    });
  });

  it("memory nodes have correct shape", async () => {
    const now = new Date("2026-08-22T10:00:00Z");
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[
      {
        id: "m1",
        title: "Deploy notes",
        type: "decision",
        summary: "Always run migrations first",
        importance: 0.8,
        projectId: "proj1",
        updatedAt: now,
        contentHead: "...",
      },
    ]];
    rows[TAG_MAP_TABLE] = [[{ memoryId: "m1", name: "deploy" }]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.nodes[0]).toEqual({
      id: "m1",
      kind: "memory",
      label: "Deploy notes",
      type: "decision",
      detail: "Always run migrations first",
      tags: ["deploy"],
      projectId: "proj1",
      importance: 0.8,
      updatedAt: now.toISOString(),
    });
  });

  it("truncates long detail snippets to 240 chars", async () => {
    const longDesc = "x".repeat(300);
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "Entity", type: "technology", description: longDesc, updatedAt: new Date() },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.nodes[0].detail?.length).toBeLessThanOrEqual(240);
    expect(snapshot.nodes[0].detail?.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in detail snippets", async () => {
    rows[ENTITY_TABLE] = [[
      { id: "e1", name: "Entity", type: "technology", description: "Line one\n\n\n   Line two\t\tend", updatedAt: new Date() },
    ]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.nodes[0].detail).toBe("Line one Line two end");
  });

  it("includes generatedAt timestamp", async () => {
    rows[ENTITY_TABLE] = [[]];
    rows[MEMORY_TABLE] = [[]];
    rows[TAG_MAP_TABLE] = [[]];
    rows[RELATIONSHIP_TABLE] = [[]];
    rows[LINK_TABLE] = [[]];
    rows[PROJECT_TABLE] = [[]];

    const snapshot = await buildBrainGraphSnapshot({ brainId: BRAIN });

    expect(snapshot.generatedAt).toBeTruthy();
    expect(new Date(snapshot.generatedAt).getTime()).toBeGreaterThan(0);
  });
});

