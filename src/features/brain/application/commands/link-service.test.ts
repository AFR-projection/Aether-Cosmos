import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/shared/infrastructure/db/schema";
import {
  BrainEntityNotFoundError,
  BrainValidationError,
  MemoryNotFoundError,
} from "@brain/domain/errors";

/**
 * Memory links — the edges backlinks, the graph views and `brain_related` are all
 * built from. One property decides whether any of that can be trusted: an edge is
 * only written after *both* of its endpoints have been re-read inside the brain the
 * caller is authorized for, so there is no way to end up with a cross-brain edge or
 * an edge into a deleted memory (§88, "no dangling graph edges").
 *
 * The database is a recording fake: what matters here is which rows the service
 * refuses to write and which predicates it insists on, not how Postgres answers.
 */

type Rows = Record<string, unknown[][]>;
type WriteCall = {
  verb: "insert" | "delete";
  table: string;
  values?: Record<string, unknown>;
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
 * Reads are answered per table, in call order — `linkMemory` reads `memories` twice
 * (source, then target) and the difference between those two answers is the whole
 * cross-brain test.
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

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    select: (projection?: Record<string, unknown>) => selectChain(Object.keys(projection ?? {})),
    selectDistinct: (projection?: Record<string, unknown>) =>
      selectChain(Object.keys(projection ?? {})),
    insert(table: unknown) {
      const call: WriteCall = { verb: "insert", table: getTableName(table as never) };
      const chain = {
        values(values: Record<string, unknown>) {
          call.values = values;
          return chain;
        },
        onConflictDoUpdate(config: { target: unknown }) {
          call.conflict = (config.target as Array<{ name: string }>).map((column) => column.name);
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__insert?.[0] ?? [{ id: "link-1", ...call.values }]);
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
  linkMemory,
  unlinkMemory,
  listOutgoingLinks,
  listBacklinks,
  getMemoryLinks,
  listLinkedEntityNames,
  countMemoryLinks,
  exportMemoryLinks,
  normalizeLinkType,
  MEMORY_LINK_MAX,
} = await import("./link-service");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const MEMORIES = getTableName(schema.memories);
const ENTITIES = getTableName(schema.brainEntities);
const LINKS = getTableName(schema.memoryLinks);

const principal = { userId: "user-1", agentId: "agent-1" };

/** Both endpoint lookups succeed — the shape every happy-path write starts from. */
function bothEndpointsLive(): void {
  rows = { [MEMORIES]: [[{ id: SOURCE }], [{ id: TARGET }]], [ENTITIES]: [[{ id: ENTITY }]] };
}

const CREATED_AT = new Date("2026-03-01T12:00:00.000Z");

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  cursors.clear();
  rows = {};
});

describe("normalizeLinkType", () => {
  it("defaults to relates_to when a caller says nothing", () => {
    expect(normalizeLinkType(undefined)).toBe("relates_to");
  });

  it("lowercases and joins words, so one verb cannot arrive as three", () => {
    expect(normalizeLinkType("  Supersedes  ")).toBe("supersedes");
    expect(normalizeLinkType("Depends On")).toBe("depends_on");
  });

  it("rejects anything that is not a bare verb", () => {
    // These end up in MCP output and in graph legends; free text there means an edge
    // label that no consumer can group on.
    for (const bad of ["", "-leading", "has spaces!", "café", "a".repeat(65)]) {
      expect(() => normalizeLinkType(bad)).toThrow(BrainValidationError);
    }
  });

  it("keeps hyphens and digits, which real vocabularies use", () => {
    expect(normalizeLinkType("part-of-2")).toBe("part-of-2");
  });
});

describe("linkMemory only writes an edge whose ends it has verified", () => {
  it("re-reads the source inside the brain, and refuses a foreign one", async () => {
    // The source id arrives from the wire. Reading it back with brainId folded into
    // the predicate is what turns "a memory id" into "a memory in *this* brain".
    rows = { [MEMORIES]: [[]] };

    await expect(
      linkMemory({ brainId: BRAIN, sourceMemoryId: SOURCE, target: { targetType: "memory", targetMemoryId: TARGET }, principal })
    ).rejects.toBeInstanceOf(MemoryNotFoundError);

    const [sourceRead] = reads;
    expect(describeSql(sourceRead.where)).toContain(BRAIN);
    expect(describeSql(sourceRead.where)).toContain(SOURCE);
    // deleted_at IS NULL — a soft-deleted memory is not a valid endpoint either.
    expect(describeSql(sourceRead.where)).toContain("deleted_at");
    expect(writes).toEqual([]);
  });

  it("refuses a target that lives in another brain, and writes nothing", async () => {
    // The dangerous case: caller is authorized for BRAIN, target belongs elsewhere.
    // Scoping the second read the same way makes it arrive as "no row".
    rows = { [MEMORIES]: [[{ id: SOURCE }], []] };

    await expect(
      linkMemory({ brainId: BRAIN, sourceMemoryId: SOURCE, target: { targetType: "memory", targetMemoryId: TARGET }, principal })
    ).rejects.toBeInstanceOf(MemoryNotFoundError);

    expect(reads).toHaveLength(2);
    expect(describeSql(reads[1].where)).toContain(BRAIN);
    expect(describeSql(reads[1].where)).toContain(TARGET);
    expect(writes).toEqual([]);
  });

  it("refuses to link a memory to itself before it reads anything else", async () => {
    rows = { [MEMORIES]: [[{ id: SOURCE }]] };

    await expect(
      linkMemory({ brainId: BRAIN, sourceMemoryId: SOURCE, target: { targetType: "memory", targetMemoryId: SOURCE }, principal })
    ).rejects.toBeInstanceOf(BrainValidationError);

    expect(reads).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it("refuses an entity from another brain", async () => {
    rows = { [MEMORIES]: [[{ id: SOURCE }]], [ENTITIES]: [[]] };

    await expect(
      linkMemory({ brainId: BRAIN, sourceMemoryId: SOURCE, target: { targetType: "entity", targetEntityId: ENTITY }, principal })
    ).rejects.toBeInstanceOf(BrainEntityNotFoundError);

    const entityRead = reads.find((read) => read.table === ENTITIES)!;
    expect(describeSql(entityRead.where)).toContain(BRAIN);
    expect(describeSql(entityRead.where)).toContain(ENTITY);
    expect(writes).toEqual([]);
  });

  it("rejects a bad verb before touching the database at all", async () => {
    await expect(
      linkMemory({
        brainId: BRAIN,
        sourceMemoryId: SOURCE,
        target: { targetType: "memory", targetMemoryId: TARGET },
        linkType: "IS THE SAME AS!",
        principal,
      })
    ).rejects.toBeInstanceOf(BrainValidationError);

    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("the row linkMemory writes", () => {
  it("carries the brain, the normalized verb and exactly one target column", async () => {
    bothEndpointsLive();

    await linkMemory({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      target: { targetType: "memory", targetMemoryId: TARGET },
      linkType: "Supersedes",
      principal,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe(LINKS);
    expect(writes[0].values).toEqual({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      targetType: "memory",
      targetMemoryId: TARGET,
      // An entity id on a memory link would be a second, unverified endpoint.
      targetEntityId: null,
      linkType: "supersedes",
      metadata: null,
      createdBy: "user-1",
      createdByAgent: "agent-1",
    });
  });

  it("writes the id the brain-scoped read returned, not the one passed in", async () => {
    // Same value in practice; the point is that the write is fed from the verified
    // read, so a future change to the lookup cannot leave the write trusting input.
    rows = { [MEMORIES]: [[{ id: SOURCE }], [{ id: TARGET }]] };

    await linkMemory({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      target: { targetType: "memory", targetMemoryId: TARGET },
      principal,
    });

    expect(writes[0].values).toMatchObject({ sourceMemoryId: SOURCE, targetMemoryId: TARGET });
  });

  it("anchors an entity link on the entity's id and leaves the memory column null", async () => {
    bothEndpointsLive();

    await linkMemory({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      target: { targetType: "entity", targetEntityId: ENTITY },
      metadata: { via: "enrichment" },
      principal,
    });

    expect(writes[0].values).toMatchObject({
      targetType: "entity",
      targetEntityId: ENTITY,
      targetMemoryId: null,
      linkType: "relates_to",
      metadata: { via: "enrichment" },
    });
  });

  it("upserts on the endpoint that is actually set, so re-linking cannot duplicate", async () => {
    // Two partial unique indexes exist — one per target kind. Naming the wrong one
    // would make the insert conflict on nothing and add a second identical edge.
    bothEndpointsLive();

    await linkMemory({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      target: { targetType: "memory", targetMemoryId: TARGET },
      principal,
    });
    expect(writes[0].conflict).toEqual(["source_memory_id", "target_memory_id", "link_type"]);

    writes.length = 0;
    cursors.clear();
    bothEndpointsLive();

    await linkMemory({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      target: { targetType: "entity", targetEntityId: ENTITY },
      principal,
    });
    expect(writes[0].conflict).toEqual(["source_memory_id", "target_entity_id", "link_type"]);
  });

  it("records an agentless write as a user write, not as an anonymous one", async () => {
    bothEndpointsLive();

    await linkMemory({
      brainId: BRAIN,
      sourceMemoryId: SOURCE,
      target: { targetType: "memory", targetMemoryId: TARGET },
      principal: { userId: "user-1", agentId: null },
    });

    expect(writes[0].values).toMatchObject({ createdBy: "user-1", createdByAgent: null });
  });
});

/** One joined row as the outgoing query returns it, with the far end filled in. */
function outgoingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK,
    linkType: "supersedes",
    targetType: "memory",
    createdAt: CREATED_AT,
    memoryId: TARGET,
    memoryTitle: "Deploy target (old)",
    memoryType: "fact",
    memoryDeletedAt: null,
    entityId: null,
    entityName: null,
    entityType: null,
    ...overrides,
  };
}

describe("reading links back", () => {
  it("resolves an outgoing memory link to the far end's label and type", async () => {
    rows = { [LINKS]: [[outgoingRow()]] };

    const links = await listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE });

    expect(links).toEqual([
      {
        id: LINK,
        linkType: "supersedes",
        direction: "outgoing",
        targetType: "memory",
        nodeId: TARGET,
        label: "Deploy target (old)",
        nodeType: "fact",
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("hides an edge into a soft-deleted memory instead of rendering a dead end", async () => {
    // The row stays — restoring the memory restores the edge — but a UI or an agent
    // must never be handed a link it cannot follow.
    rows = { [LINKS]: [[outgoingRow({ memoryDeletedAt: new Date() })]] };

    await expect(listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE })).resolves.toEqual([]);
  });

  it("drops an edge whose far end no longer joins, rather than emitting a null node", async () => {
    rows = {
      [LINKS]: [
        [
          outgoingRow({ memoryId: null, memoryTitle: null, memoryType: null }),
          outgoingRow({ targetType: "entity", memoryId: null, entityId: null }),
        ],
      ],
    };

    await expect(listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE })).resolves.toEqual([]);
  });

  it("resolves an entity link, falling back to a placeholder name", async () => {
    rows = {
      [LINKS]: [
        [
          outgoingRow({
            targetType: "entity",
            memoryId: null,
            entityId: ENTITY,
            entityName: null,
            entityType: "technology",
          }),
        ],
      ],
    };

    const [link] = await listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE });
    expect(link).toMatchObject({ targetType: "entity", nodeId: ENTITY, label: "Unnamed" });
  });

  it("labels an untitled memory rather than returning an empty string", async () => {
    rows = { [LINKS]: [[outgoingRow({ memoryTitle: null })]] };

    const [link] = await listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE });
    expect(link.label).toBe("Untitled");
  });

  it("scopes the outgoing read to the brain and the source memory", async () => {
    rows = { [LINKS]: [[]] };

    await listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE });

    const predicate = describeSql(reads[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(SOURCE);
  });

  it("caps how many edges one memory can report, whatever the caller asks for", async () => {
    // A memory with hundreds of edges is a modelling problem, not a page to render.
    rows = { [LINKS]: [[]] };

    await listOutgoingLinks({ brainId: BRAIN, memoryId: SOURCE, limit: 10_000 });

    expect(reads[0].limit).toBe(MEMORY_LINK_MAX);
  });
});

describe("backlinks come from the database, because the referrer never announces itself", () => {
  it("reports who points at this memory, marked as incoming", async () => {
    rows = {
      [LINKS]: [
        [
          {
            id: LINK,
            linkType: "mentions",
            createdAt: CREATED_AT,
            memoryId: SOURCE,
            memoryTitle: "Runbook",
            memoryType: "procedure",
          },
        ],
      ],
    };

    const links = await listBacklinks({ brainId: BRAIN, memoryId: TARGET });

    expect(links).toEqual([
      {
        id: LINK,
        linkType: "mentions",
        direction: "incoming",
        targetType: "memory",
        nodeId: SOURCE,
        label: "Runbook",
        nodeType: "procedure",
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("asks for links whose target is this memory, inside this brain, from live sources", async () => {
    rows = { [LINKS]: [[]] };

    await listBacklinks({ brainId: BRAIN, memoryId: TARGET });

    const predicate = describeSql(reads[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(TARGET);
    // A deleted referrer would otherwise show up as a phantom reference.
    expect(predicate).toContain("deleted_at");
  });

  it("returns both directions in one call, without mixing them up", async () => {
    rows = {
      [LINKS]: [
        [outgoingRow()],
        [
          {
            id: "link-2",
            linkType: "mentions",
            createdAt: CREATED_AT,
            memoryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            memoryTitle: "Runbook",
            memoryType: "procedure",
          },
        ],
      ],
    };

    const { relatedTo, referencedBy } = await getMemoryLinks({ brainId: BRAIN, memoryId: SOURCE });

    expect(relatedTo.map((link) => link.direction)).toEqual(["outgoing"]);
    expect(referencedBy.map((link) => link.direction)).toEqual(["incoming"]);
  });
});

describe("the small aggregates the rest of the app leans on", () => {
  it("names the entities a set of memories is about", async () => {
    rows = { [LINKS]: [[{ name: "nginx" }, { name: "BullMQ" }]] };

    await expect(
      listLinkedEntityNames({ brainId: BRAIN, memoryIds: [SOURCE, TARGET] })
    ).resolves.toEqual(["nginx", "BullMQ"]);
    expect(describeSql(reads[0].where)).toContain(BRAIN);
  });

  it("asks nothing at all for an empty memory list", async () => {
    // recall() calls this with whatever it selected, which is sometimes nothing.
    await expect(listLinkedEntityNames({ brainId: BRAIN, memoryIds: [] })).resolves.toEqual([]);
    expect(reads).toEqual([]);
  });

  it("bounds the entity name list too", async () => {
    rows = { [LINKS]: [[]] };

    await listLinkedEntityNames({ brainId: BRAIN, memoryIds: [SOURCE], limit: 500 });

    expect(reads[0].limit).toBe(25);
  });

  it("counts zero for a brain with no links, instead of returning undefined", async () => {
    await expect(countMemoryLinks(BRAIN)).resolves.toBe(0);
  });

  it("counts inside one brain only", async () => {
    rows = { [LINKS]: [[{ total: 7 }]] };

    await expect(countMemoryLinks(BRAIN)).resolves.toBe(7);
    expect(describeSql(reads[0].where)).toContain(BRAIN);
  });

  it("exports one brain's links, not the table", async () => {
    rows = { [LINKS]: [[{ id: LINK }]] };

    await expect(exportMemoryLinks(BRAIN)).resolves.toEqual([{ id: LINK }]);
    expect(describeSql(reads[0].where)).toContain(BRAIN);
    expect(reads[0].limit).toBeNull();
  });
});

describe("unlinkMemory", () => {
  it("deletes by id and brain, so a foreign link id matches nothing", async () => {
    rows = { __delete: [[{ id: LINK }]] };

    await expect(unlinkMemory({ brainId: BRAIN, linkId: LINK })).resolves.toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0].verb).toBe("delete");
    expect(writes[0].table).toBe(LINKS);
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(LINK);
    expect(predicate).toContain(BRAIN);
  });

  it("reports a miss rather than a success when nothing was deleted", async () => {
    await expect(unlinkMemory({ brainId: BRAIN, linkId: LINK })).resolves.toBe(false);
  });
});
