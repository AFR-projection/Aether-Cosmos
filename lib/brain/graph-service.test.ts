import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { BrainEntityNotFoundError, BrainValidationError } from "./errors";

/**
 * The knowledge graph of one brain: entities are its nodes, relationships its edges.
 *
 * Every function here is handed a brainId the route has already authorized, and the
 * property that makes the graph trustworthy is that none of them ever stop carrying
 * it — a node is read, patched and deleted by (id, brain_id), and an edge is only
 * inserted after *both* of its endpoints have been re-read inside that same brain.
 * That is what keeps "no dangling graph edges" and "a node from brain A never shows
 * up in brain B" true for the graph as well as for memories.
 *
 * The database is a recording fake: the assertions are about which predicates the
 * service insists on and which rows it refuses to write, not about how Postgres
 * answers them.
 */

type Rows = Record<string, unknown[][]>;
type WriteCall = {
  verb: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  conflict?: string[];
  where?: unknown;
};
type ReadCall = { table: string; columns: string[]; limit: number | null; where: unknown };

/** Flatten a Drizzle predicate into a searchable string (columns hold circular refs). */
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
  };

  walk(node);
  return parts.join(" ");
}

/**
 * Reads are answered per table in call order: `upsertRelationship` reads
 * `brain_entities` twice (source, then target) and the difference between those two
 * answers is the whole cross-brain test.
 */
const reads: ReadCall[] = [];
const writes: WriteCall[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();

function selectChain(columns: string[]) {
  const call: ReadCall = { table: "", columns, limit: null, where: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    leftJoin: () => chain,
    innerJoin: () => chain,
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy: () => chain,
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

vi.mock("@/lib/db", () => ({
  db: {
    select: (projection?: Record<string, unknown>) => selectChain(Object.keys(projection ?? {})),
    insert(table: unknown) {
      const call: WriteCall = { verb: "insert", table: getTableName(table as never) };
      const chain = {
        values(values: Record<string, unknown>) {
          call.values = values;
          return chain;
        },
        onConflictDoUpdate(config: { target: unknown; set: Record<string, unknown> }) {
          call.conflict = (config.target as Array<{ name: string }>).map((column) => column.name);
          call.set = config.set;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__insert?.[0] ?? [{ id: "row-1", ...call.values }]);
        },
      };
      return chain;
    },
    update(table: unknown) {
      const call: WriteCall = { verb: "update", table: getTableName(table as never) };
      const chain = {
        set(patch: Record<string, unknown>) {
          call.values = patch;
          return chain;
        },
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__update?.[0] ?? [{ id: "row-1", ...call.values }]);
        },
      };
      return chain;
    },
    delete(table: unknown) {
      const call: WriteCall = { verb: "delete", table: getTableName(table as never) };
      const chain = {
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__delete?.[0] ?? []);
        },
      };
      return chain;
    },
  },
}));

const {
  listEntities,
  requireEntity,
  upsertEntity,
  updateEntity,
  deleteEntity,
  listRelationships,
  upsertRelationship,
  deleteRelationship,
  exportGraph,
} = await import("./graph-service");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const ENTITY_A = "22222222-2222-4222-8222-222222222222";
const ENTITY_B = "33333333-3333-4333-8333-333333333333";
const RELATIONSHIP = "44444444-4444-4444-8444-444444444444";

const ENTITY_TABLE = getTableName(schema.brainEntities);
const REL_TABLE = getTableName(schema.brainRelationships);

const entityRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTITY_A,
  brainId: BRAIN,
  name: "nginx",
  type: "technology",
  description: null,
  metadata: null,
  ...overrides,
});

/** The nth read of a table, in the order the service issued them. */
const readOf = (table: string, index = 0): ReadCall | undefined =>
  reads.filter((call) => call.table === table)[index];

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  rows = {};
  cursors.clear();
});

describe("listEntities", () => {
  it("reads only this brain's nodes, with a bounded default page", async () => {
    rows[ENTITY_TABLE] = [[entityRow(), entityRow({ id: ENTITY_B, name: "postgres" })]];

    const entities = await listEntities({ brainId: BRAIN });

    expect(entities).toHaveLength(2);
    const read = readOf(ENTITY_TABLE)!;
    expect(describeSql(read.where)).toContain(BRAIN);
    expect(read.limit).toBe(50);
  });

  it("narrows by entity type without widening the brain filter", async () => {
    await listEntities({ brainId: BRAIN, type: "person" });

    const predicate = describeSql(readOf(ENTITY_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("person");
  });

  it("matches a typed wildcard literally instead of as 'match everything'", async () => {
    // `%` and `_` from a search box must not become ILIKE metacharacters, or a search
    // for "50%_off" quietly returns the whole brain.
    await listEntities({ brainId: BRAIN, search: "50%_off" });

    const predicate = describeSql(readOf(ENTITY_TABLE)!.where);
    expect(predicate).toContain("ILIKE");
    expect(predicate).toContain("%50\\%\\_off%");
  });

  it("ignores a whitespace-only search rather than filtering on it", async () => {
    await listEntities({ brainId: BRAIN, search: "   " });

    expect(describeSql(readOf(ENTITY_TABLE)!.where)).not.toContain("ILIKE");
  });

  it("clamps a caller-supplied page size to the server maximum", async () => {
    await listEntities({ brainId: BRAIN, limit: 10_000 });
    expect(readOf(ENTITY_TABLE)!.limit).toBe(100);
  });
});

describe("requireEntity", () => {
  it("looks a node up by id AND brain, one row at a time", async () => {
    rows[ENTITY_TABLE] = [[entityRow()]];

    const entity = await requireEntity(BRAIN, ENTITY_A);

    expect(entity.name).toBe("nginx");
    const read = readOf(ENTITY_TABLE)!;
    const predicate = describeSql(read.where);
    expect(predicate).toContain(ENTITY_A);
    expect(predicate).toContain(BRAIN);
    expect(read.limit).toBe(1);
  });

  it("reports a node in someone else's brain as simply not found", async () => {
    // The brain filter makes "belongs to another tenant" and "does not exist"
    // indistinguishable, so the 404 is not an existence oracle.
    rows[ENTITY_TABLE] = [[]];

    const error = await requireEntity(BRAIN, ENTITY_A).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainEntityNotFoundError);
    expect((error as BrainEntityNotFoundError).status).toBe(404);
    expect((error as BrainEntityNotFoundError).code).toBe("BRAIN_ENTITY_NOT_FOUND");
  });
});

describe("upsertEntity — one node per concept, inside one brain", () => {
  it("writes the node with the brain attached and server defaults", async () => {
    await upsertEntity({ brainId: BRAIN, name: "  nginx  " });

    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe(ENTITY_TABLE);
    expect(writes[0].values).toEqual({
      brainId: BRAIN,
      name: "nginx",
      type: "other",
      description: null,
      metadata: null,
    });
  });

  it("upserts on (brain, name, type), so re-extraction cannot duplicate a node", async () => {
    // Extraction re-sees the same names constantly; the conflict target is what turns
    // that into one node rather than a pile of near-duplicates — and it is scoped by
    // brain, so two tenants can each own a node called "nginx".
    await upsertEntity({ brainId: BRAIN, name: "nginx", type: "technology" });

    expect(writes[0].conflict).toEqual(["brain_id", "name", "type"]);
    expect(writes[0].set).toMatchObject({ description: null, metadata: null });
    expect((writes[0].set as { updatedAt: Date }).updatedAt).toBeInstanceOf(Date);
  });

  it("keeps the type and metadata it was given", async () => {
    await upsertEntity({
      brainId: BRAIN,
      name: "Alice",
      type: "person",
      description: "  reviewer  ",
      metadata: { via: "enrichment" },
    });

    expect(writes[0].values).toMatchObject({
      type: "person",
      description: "reviewer",
      metadata: { via: "enrichment" },
    });
  });

  it("refuses a blank name and writes nothing at all", async () => {
    const error = await upsertEntity({ brainId: BRAIN, name: "   " }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as BrainValidationError).message).toBe("Entity name is required");
    expect(writes).toEqual([]);
  });

  it("stores an all-whitespace description as null, not as a blank string", async () => {
    await upsertEntity({ brainId: BRAIN, name: "nginx", description: "   " });
    expect(writes[0].values!.description).toBeNull();
  });
});

describe("updateEntity", () => {
  it("verifies the node is in this brain before it patches anything", async () => {
    rows[ENTITY_TABLE] = [[]];

    const error = await updateEntity({
      brainId: BRAIN,
      entityId: ENTITY_A,
      data: { name: "nginx" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainEntityNotFoundError);
    expect(writes).toEqual([]);
  });

  it("patches only the supplied fields, still filtered by id and brain", async () => {
    rows[ENTITY_TABLE] = [[entityRow()]];
    rows.__update = [[entityRow({ name: "nginx-ingress" })]];

    const updated = await updateEntity({
      brainId: BRAIN,
      entityId: ENTITY_A,
      data: { name: "  nginx-ingress  " },
    });

    expect(updated.name).toBe("nginx-ingress");
    expect(writes).toHaveLength(1);
    expect(writes[0].verb).toBe("update");
    expect(Object.keys(writes[0].values!).sort()).toEqual(["name", "updatedAt"]);
    expect(writes[0].values!.name).toBe("nginx-ingress");
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(ENTITY_A);
    expect(predicate).toContain(BRAIN);
  });

  it("clears description and metadata when they are explicitly null", async () => {
    rows[ENTITY_TABLE] = [[entityRow()]];

    await updateEntity({
      brainId: BRAIN,
      entityId: ENTITY_A,
      data: { description: null, metadata: null },
    });

    expect(writes[0].values).toMatchObject({ description: null, metadata: null });
  });
});

describe("updateEntity — refusals", () => {
  beforeEach(() => {
    rows[ENTITY_TABLE] = [[entityRow()]];
  });

  it("refuses an empty patch instead of writing a bare updated_at", async () => {
    const error = await updateEntity({ brainId: BRAIN, entityId: ENTITY_A, data: {} }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as BrainValidationError).message).toBe("No fields to update");
    expect(writes).toEqual([]);
  });

  it("refuses to rename a node to whitespace", async () => {
    const error = await updateEntity({
      brainId: BRAIN,
      entityId: ENTITY_A,
      data: { name: "  " },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as BrainValidationError).message).toBe("Entity name cannot be empty");
    expect(writes).toEqual([]);
  });

  it("reports a row that vanished between the check and the write as not found", async () => {
    // The read and the update are two statements; a concurrent delete lands in between
    // and must surface as a 404 rather than as `undefined` returned to the route.
    rows.__update = [[]];

    await expect(
      updateEntity({ brainId: BRAIN, entityId: ENTITY_A, data: { type: "project" } })
    ).rejects.toBeInstanceOf(BrainEntityNotFoundError);
    expect(writes).toHaveLength(1);
  });
});

describe("deleteEntity", () => {
  it("deletes by id and brain, and reports that a row went", async () => {
    rows.__delete = [[{ id: ENTITY_A }]];

    const removed = await deleteEntity(BRAIN, ENTITY_A);

    expect(removed).toBe(true);
    expect(writes[0].verb).toBe("delete");
    expect(writes[0].table).toBe(ENTITY_TABLE);
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(ENTITY_A);
    expect(predicate).toContain(BRAIN);
  });

  it("returns false for a node this brain does not have", async () => {
    // The brain in the predicate is what makes this a miss rather than a cross-tenant
    // delete, and the caller learns nothing beyond "nothing of yours was removed".
    rows.__delete = [[]];

    expect(await deleteEntity(BRAIN, ENTITY_A)).toBe(false);
  });
});

describe("listRelationships", () => {
  const joinedRow = {
    relationship: {
      id: RELATIONSHIP,
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "depends_on",
      confidence: 0.9,
    },
    sourceName: "nginx",
    targetName: "postgres",
  };

  it("returns each edge with both endpoint names resolved", async () => {
    // The graph views render `A → depends_on → B`, so the names travel with the edge
    // rather than the UI issuing a lookup per node.
    rows[REL_TABLE] = [[joinedRow]];

    const edges = await listRelationships({ brainId: BRAIN });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: RELATIONSHIP,
      relationshipType: "depends_on",
      sourceName: "nginx",
      targetName: "postgres",
    });
    const read = readOf(REL_TABLE)!;
    expect(describeSql(read.where)).toContain(BRAIN);
    expect(read.limit).toBe(100);
  });

  it("matches an entity filter on both ends of the edge", async () => {
    await listRelationships({ brainId: BRAIN, entityId: ENTITY_A });

    const predicate = describeSql(readOf(REL_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    // Once as source, once as target: an edge into the node counts as much as one out.
    expect(predicate.split(ENTITY_A).length - 1).toBe(2);
  });

  it("clamps the edge page size to the server maximum", async () => {
    await listRelationships({ brainId: BRAIN, limit: 5_000 });
    expect(readOf(REL_TABLE)!.limit).toBe(100);
  });
});

describe("upsertRelationship only writes an edge whose ends it has verified", () => {
  it("re-reads both endpoints inside the brain before inserting", async () => {
    rows[ENTITY_TABLE] = [[entityRow()], [entityRow({ id: ENTITY_B, name: "postgres" })]];

    await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "depends_on",
    });

    expect(reads.filter((call) => call.table === ENTITY_TABLE)).toHaveLength(2);
    expect(describeSql(readOf(ENTITY_TABLE, 0)!.where)).toContain(BRAIN);
    expect(describeSql(readOf(ENTITY_TABLE, 1)!.where)).toContain(BRAIN);
    expect(writes).toHaveLength(1);
  });

  it("refuses an edge to a node in another brain, and writes nothing", async () => {
    // The target exists — just not here. Because the lookup folds in the brain, it
    // comes back empty and the edge is never created: no cross-brain edge exists.
    rows[ENTITY_TABLE] = [[entityRow()], []];

    const error = await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "depends_on",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainEntityNotFoundError);
    expect(writes).toEqual([]);
  });

  it("refuses an edge from a node this brain does not have", async () => {
    rows[ENTITY_TABLE] = [[], [entityRow({ id: ENTITY_B })]];

    await expect(
      upsertRelationship({
        brainId: BRAIN,
        sourceEntityId: ENTITY_A,
        targetEntityId: ENTITY_B,
        relationshipType: "depends_on",
      })
    ).rejects.toBeInstanceOf(BrainEntityNotFoundError);
    expect(writes).toEqual([]);
  });
});

describe("the edge upsertRelationship writes", () => {
  beforeEach(() => {
    rows[ENTITY_TABLE] = [[entityRow()], [entityRow({ id: ENTITY_B, name: "postgres" })]];
  });

  it("carries the brain, the verb and a default confidence", async () => {
    await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "  depends_on  ",
    });

    expect(writes[0].table).toBe(REL_TABLE);
    expect(writes[0].values).toEqual({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "depends_on",
      confidence: 0.9,
      metadata: null,
    });
  });

  it("keeps the confidence and evidence it was given", async () => {
    // Every edge is explainable: the metadata is where the extractor records why it
    // exists, and a lower confidence must survive the upsert rather than be rounded up.
    await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "mentions",
      confidence: 0.42,
      metadata: { extractedBy: "deterministic-v1" },
    });

    expect(writes[0].values).toMatchObject({
      confidence: 0.42,
      metadata: { extractedBy: "deterministic-v1" },
    });
    expect(writes[0].set).toMatchObject({
      confidence: 0.42,
      metadata: { extractedBy: "deterministic-v1" },
    });
  });

  it("upserts on (source, target, type), so re-extraction sharpens one edge", async () => {
    await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "depends_on",
    });

    expect(writes[0].conflict).toEqual([
      "source_entity_id",
      "target_entity_id",
      "relationship_type",
    ]);
  });
});

describe("upsertRelationship — refusals that never reach the database", () => {
  it("refuses a blank relationship type before reading anything", async () => {
    const error = await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "   ",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as BrainValidationError).message).toBe("relationshipType is required");
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("refuses a self-edge, so a node cannot inflate its own degree", async () => {
    // A → A would count as a link in every degree, centrality and PageRank number
    // without adding a single fact.
    const error = await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_A,
      relationshipType: "depends_on",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as BrainValidationError).message).toBe("An entity cannot be related to itself");
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("deleteRelationship", () => {
  it("deletes by edge id and brain", async () => {
    rows.__delete = [[{ id: RELATIONSHIP }]];

    expect(await deleteRelationship(BRAIN, RELATIONSHIP)).toBe(true);
    expect(writes[0].table).toBe(REL_TABLE);
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(RELATIONSHIP);
    expect(predicate).toContain(BRAIN);
  });

  it("returns false for an edge id that belongs to another brain", async () => {
    rows.__delete = [[]];
    expect(await deleteRelationship(BRAIN, RELATIONSHIP)).toBe(false);
  });
});

describe("exportGraph", () => {
  it("exports the nodes and edges of exactly one brain", async () => {
    rows[ENTITY_TABLE] = [[entityRow(), entityRow({ id: ENTITY_B })]];
    rows[REL_TABLE] = [[{ id: RELATIONSHIP, brainId: BRAIN }]];

    const graph = await exportGraph(BRAIN);

    expect(graph.entities).toHaveLength(2);
    expect(graph.relationships).toHaveLength(1);
    expect(describeSql(readOf(ENTITY_TABLE)!.where)).toContain(BRAIN);
    expect(describeSql(readOf(REL_TABLE)!.where)).toContain(BRAIN);
  });

  it("does not cap the export: a backup that silently stops at a page is not a backup", async () => {
    await exportGraph(BRAIN);

    expect(readOf(ENTITY_TABLE)!.limit).toBeNull();
    expect(readOf(REL_TABLE)!.limit).toBeNull();
  });
});

describe("the brain id is folded into every statement, on every path", () => {
  it("names this brain in each read and write, and never another one", async () => {
    // Asserted as a sweep rather than per function: a graph helper added later that
    // forgets its brain filter fails here by omission, without anyone remembering to
    // write a test for it.
    rows[ENTITY_TABLE] = [
      [entityRow()],
      [entityRow()],
      [entityRow({ id: ENTITY_B })],
      [entityRow()],
      [entityRow()],
      [entityRow()],
    ];
    rows[REL_TABLE] = [[], []];

    await listEntities({ brainId: BRAIN, search: "nginx" });
    await requireEntity(BRAIN, ENTITY_A);
    await upsertEntity({ brainId: BRAIN, name: "nginx" });
    await updateEntity({ brainId: BRAIN, entityId: ENTITY_A, data: { type: "technology" } });
    await deleteEntity(BRAIN, ENTITY_A);
    await listRelationships({ brainId: BRAIN, entityId: ENTITY_A });
    await upsertRelationship({
      brainId: BRAIN,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      relationshipType: "depends_on",
    });
    await deleteRelationship(BRAIN, RELATIONSHIP);
    await exportGraph(BRAIN);

    for (const read of reads) {
      const predicate = describeSql(read.where);
      expect(predicate, `read of ${read.table}`).toContain(BRAIN);
      expect(predicate, `read of ${read.table}`).not.toContain(OTHER_BRAIN);
    }
    for (const write of writes) {
      // An insert carries the brain in its values; an update/delete in its predicate.
      const evidence = `${describeSql(write.where)} ${JSON.stringify(write.values ?? {})}`;
      expect(evidence, `${write.verb} into ${write.table}`).toContain(BRAIN);
      expect(evidence, `${write.verb} into ${write.table}`).not.toContain(OTHER_BRAIN);
    }
    expect(reads.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
  });
});

