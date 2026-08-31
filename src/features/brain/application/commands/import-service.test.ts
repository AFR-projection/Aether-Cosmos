import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import JSZip from "jszip";
import * as schema from "@/shared/infrastructure/db/schema";
import { memoryContentHash } from "@brain/application/jobs/enrich-service";
import {
  BRAIN_ARCHIVE_FORMAT,
  BRAIN_ARCHIVE_VERSION,
  buildArchiveMembers,
} from "./export-service";
import type { ParsedArchive } from "./import-service";

/**
 * §37 — `runImport`, the writing half of import.
 *
 * `import.test.ts` covers the pure half (parse / plan / preview) and deliberately has
 * no database in it. This file covers the half that writes, where the properties that
 * matter are different ones: every row carries the *target* brain's id and a freshly
 * minted primary key, authorship comes from the authenticated principal and never from
 * the archive, an edge whose endpoint failed to resolve is dropped rather than pointed
 * somewhere else, and the whole thing is one transaction so a failure two thirds of the
 * way through leaves nothing behind.
 *
 * The database is a recording fake that models commit and rollback: writes issued
 * inside a transaction are staged, and only merged into `committed` when the callback
 * resolves. That makes "nothing was written" an assertion about state rather than an
 * assertion about which error was thrown.
 *
 * Two regressions are pinned here as named cases, because both were live bugs:
 *  - BUG-1, the `importance` scale mismatch that dropped every memory of a real export;
 *  - BUG-2, archive `metadata` accepted by the record schemas and then discarded at
 *    write time for entities, relationships and links.
 */

type Insert = {
  table: string;
  rows: Record<string, unknown>[];
  conflict: "do-nothing" | null;
  txId: number | null;
};
type Select = { table: string; columns: string[]; where: unknown; txId: number | null };
type Rows = Record<string, unknown[][]>;

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

/* ── the recording fake ──────────────────────────────────────────────────── */

/** Every insert the service attempted, committed or not. */
const attempted: Insert[] = [];
/** Only the inserts whose transaction actually resolved. */
const committed: Insert[] = [];
const selects: Select[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();
let transactions = 0;
let rollbacks = 0;
/** Make the nth insert into `table` reject, to exercise mid-import failure. */
let failOn: { table: string; nth: number } | null = null;

function selectChain(columns: string[], txId: number | null) {
  const call: Select = { table: "", columns, where: null, txId };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T) {
      selects.push(call);
      const index = cursors.get(call.table) ?? 0;
      cursors.set(call.table, index + 1);
      return Promise.resolve(rows[call.table]?.[index] ?? []).then(resolve);
    },
  };
  return chain;
}

function insertChain(table: unknown, txId: number | null, staged: Insert[]) {
  const call: Insert = {
    table: getTableName(table as never),
    rows: [],
    conflict: null,
    txId,
  };
  const chain = {
    values(values: unknown) {
      call.rows = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
      return chain;
    },
    onConflictDoNothing() {
      call.conflict = "do-nothing";
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T, reject?: (reason: unknown) => T) {
      attempted.push(call);
      const nth = attempted.filter((other) => other.table === call.table).length;
      if (failOn && failOn.table === call.table && failOn.nth === nth) {
        return Promise.reject(new Error("write failed at the database")).then(resolve, reject);
      }
      staged.push(call);
      return Promise.resolve([]).then(resolve, reject);
    },
  };
  return chain;
}

function handleFor(txId: number | null, staged: Insert[]) {
  return {
    select: (projection?: Record<string, unknown>) =>
      selectChain(Object.keys(projection ?? {}), txId),
    insert: (table: unknown) => insertChain(table, txId, staged),
  };
}

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    // A write outside `db.transaction` is recorded with `txId: null`, so "everything
    // happened in one transaction" is checkable rather than assumed.
    select: (projection?: Record<string, unknown>) =>
      selectChain(Object.keys(projection ?? {}), null),
    insert: (table: unknown) => insertChain(table, null, committed),
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      transactions += 1;
      const txId = transactions;
      const staged: Insert[] = [];
      try {
        const result = await callback(handleFor(txId, staged));
        committed.push(...staged);
        return result;
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
  },
}));

const enqueueJob = vi.fn();
vi.mock("@/shared/infrastructure/queue", () => ({
  enqueueJob: (type: string, data: unknown) => enqueueJob(type, data),
}));

const { parseBrainArchive, previewImport, runImport } = await import("./import-service");

/* ── fixtures ────────────────────────────────────────────────────────────── */

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "88888888-8888-4888-8888-888888888888";
const AGENT = "33333333-3333-4333-8333-333333333333";

const MEMORY_TABLE = getTableName(schema.memories);
const VERSION_TABLE = getTableName(schema.memoryVersions);
const LINK_TABLE = getTableName(schema.memoryLinks);
const TAG_TABLE = getTableName(schema.memoryTags);
const TAG_MAP_TABLE = getTableName(schema.memoryTagMap);
const PROJECT_TABLE = getTableName(schema.brainProjects);
const ENTITY_TABLE = getTableName(schema.brainEntities);
const RELATIONSHIP_TABLE = getTableName(schema.brainRelationships);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function archive(overrides: Partial<ParsedArchive> = {}): ParsedArchive {
  return {
    sourceBrainName: "Their Brain",
    exportedAt: "2026-08-20T00:00:00.000Z",
    formatVersion: BRAIN_ARCHIVE_VERSION,
    memories: [],
    memoryVersions: [],
    memoryLinks: [],
    tags: [],
    projects: [],
    entities: [],
    relationships: [],
    warnings: [],
    ...overrides,
  } as ParsedArchive;
}

const mem = (over: Record<string, unknown> = {}) =>
  ({
    id: "m1",
    title: "Use Postgres",
    content: "Every memory row lives in Postgres.",
    ...over,
  }) as ParsedArchive["memories"][number];

/** Stand in for what the natural-key SELECT would find after the upsert. */
function resolveProjects(names: string[]) {
  rows[PROJECT_TABLE] = [names.map((name, i) => ({ id: `proj-${i + 1}`, name }))];
}
function resolveEntities(list: { name: string; type?: string }[]) {
  rows[ENTITY_TABLE] = [
    list.map((entity, i) => ({ id: `ent-${i + 1}`, name: entity.name, type: entity.type ?? "other" })),
  ];
}
function resolveTags(names: string[]) {
  rows[TAG_TABLE] = [names.map((name, i) => ({ id: `tag-${i + 1}`, name }))];
}

const run = (
  parsed: ParsedArchive,
  principal: { userId: string; agentId: string | null } = { userId: USER, agentId: null }
) => runImport({ brainId: BRAIN, principal, parsed });

const insertsInto = (table: string) => committed.filter((call) => call.table === table);
const rowsInto = (table: string) => insertsInto(table).flatMap((call) => call.rows);

/** Clear every recorder. Exposed as a function so a test can run two imports in a row. */
function reset(): void {
  attempted.length = 0;
  committed.length = 0;
  selects.length = 0;
  rows = {};
  cursors.clear();
  transactions = 0;
  rollbacks = 0;
  failOn = null;
  enqueueJob.mockReset();
  enqueueJob.mockResolvedValue({ id: "job-1" });
}

beforeEach(reset);

async function makeArchive(
  members: Record<string, unknown[]>,
  manifestOverrides: Record<string, unknown> = {}
): Promise<Uint8Array> {
  const zip = new JSZip();
  const jsonl = (records: unknown[]) =>
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");

  zip.file(
    "manifest.json",
    JSON.stringify({
      format: BRAIN_ARCHIVE_FORMAT,
      formatVersion: BRAIN_ARCHIVE_VERSION,
      exportedAt: "2026-08-20T00:00:00.000Z",
      brain: { id: "source-brain", name: "Their Brain" },
      ...manifestOverrides,
    })
  );
  for (const [path, records] of Object.entries(members)) zip.file(path, jsonl(records));
  return zip.generateAsync({ type: "uint8array" });
}

/** An entity keeps `parseBrainArchive` from throwing when every memory is rejected. */
const anEntity = { id: "e1", name: "Postgres", type: "technology" };

describe("BUG-1 — importance is a 0..1 real, never a 1..10 integer", () => {
  /**
   * `memories.importance` is `real` with default 0.5 and `POST /memories` validates
   * `z.number().min(0).max(1)`, so the archive scale is 0..1. An earlier
   * `z.number().int().min(1).max(10)` here rejected 0.5 — which is to say, it rejected
   * every memory a real export contains — and reported it only as a skipped record.
   */
  for (const importance of [0, 0.5, 0.82, 1]) {
    it(`accepts importance ${importance}`, async () => {
      const parsed = await parseBrainArchive(
        await makeArchive({ "memories.jsonl": [{ ...mem(), importance }] })
      );

      expect(parsed.warnings).toEqual([]);
      expect(parsed.memories).toHaveLength(1);
      expect(parsed.memories[0].importance).toBe(importance);
    });
  }

  for (const importance of [-0.1, 1.1, 5, 10]) {
    it(`rejects importance ${importance} as out of range`, async () => {
      const parsed = await parseBrainArchive(
        await makeArchive({
          "memories.jsonl": [{ ...mem(), importance }],
          "entities.jsonl": [anEntity],
        })
      );

      expect(parsed.memories).toEqual([]);
      expect(parsed.warnings.join(" ")).toMatch(/memories\.jsonl: skipped 1 invalid record/);
    });
  }

  it("writes the archive's importance through unchanged", async () => {
    await run(archive({ memories: [mem({ importance: 0.82 })] }));

    expect(rowsInto(MEMORY_TABLE)[0].importance).toBe(0.82);
  });

  it("defaults a missing importance to the column default, not to 5", async () => {
    await run(archive({ memories: [mem()] }));

    // 5 on a 0..1 scale is not "medium", it is ten times the maximum.
    expect(rowsInto(MEMORY_TABLE)[0].importance).toBe(0.5);
  });

  it("keeps importance 0 rather than treating it as absent", async () => {
    await run(archive({ memories: [mem({ importance: 0 })] }));

    expect(rowsInto(MEMORY_TABLE)[0].importance).toBe(0);
  });
});

describe("ownership comes from the authenticated target, never from the archive", () => {
  const fullArchive = () =>
    archive({
      memories: [mem({ projectId: "p1", tags: ["infra"] })],
      memoryVersions: [
        { memoryId: "m1", versionNumber: 1, title: "Use Postgres", content: "old body" },
      ] as ParsedArchive["memoryVersions"],
      memoryLinks: [
        { sourceMemoryId: "m1", targetType: "entity", targetEntityId: "e1" },
      ] as ParsedArchive["memoryLinks"],
      projects: [{ id: "p1", name: "Storage" }] as ParsedArchive["projects"],
      entities: [
        { id: "e1", name: "Postgres", type: "technology" },
        { id: "e2", name: "Supabase", type: "organization" },
      ] as ParsedArchive["entities"],
      relationships: [
        { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "hosted_by" },
      ] as ParsedArchive["relationships"],
      tags: ["infra"],
    });

  const resolveAll = () => {
    resolveProjects(["Storage"]);
    resolveEntities([
      { name: "Postgres", type: "technology" },
      { name: "Supabase", type: "organization" },
    ]);
    resolveTags(["infra"]);
  };

  it("stamps the target brain id on every row that carries one", async () => {
    resolveAll();

    await run(fullArchive());

    // memory_versions and memory_tag_map reach the brain through their memory, so
    // they have no brain_id column of their own; every other table does.
    for (const table of [MEMORY_TABLE, LINK_TABLE, TAG_TABLE, PROJECT_TABLE, ENTITY_TABLE, RELATIONSHIP_TABLE]) {
      const written = rowsInto(table);
      expect(written.length, table).toBeGreaterThan(0);
      for (const row of written) expect(row.brainId, table).toBe(BRAIN);
    }
  });

  it("ignores every ownership field the archive tries to assert", async () => {
    const parsed = await parseBrainArchive(
      await makeArchive({
        "memories.jsonl": [
          {
            ...mem(),
            brainId: OTHER_BRAIN,
            createdBy: OTHER_USER,
            createdByAgent: AGENT,
            deletedAt: null,
          },
        ],
      })
    );

    await run(parsed);

    const dump = JSON.stringify(committed);
    expect(dump).not.toContain(OTHER_BRAIN);
    expect(dump).not.toContain(OTHER_USER);
    expect(dump).not.toContain(AGENT);
  });

  it("re-mints every memory id instead of reusing the archive's", async () => {
    await run(archive({ memories: [mem({ id: "m1" }), mem({ id: "m2", title: "Supabase" })] }));

    const ids = rowsInto(MEMORY_TABLE).map((row) => row.id as string);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(ids).not.toContain("m1");
    expect(ids).not.toContain("m2");
  });

  it("attributes an import run by a user to that user", async () => {
    await run(
      archive({
        memories: [mem()],
        memoryLinks: [] as ParsedArchive["memoryLinks"],
      })
    );

    expect(rowsInto(MEMORY_TABLE)[0]).toMatchObject({ createdBy: USER, createdByAgent: null });
  });

  it("attributes an import run by an agent to the agent, not the owner", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    await run(
      archive({
        memories: [mem()],
        entities: [{ id: "e1", name: "Postgres", type: "technology" }] as ParsedArchive["entities"],
        memoryLinks: [
          { sourceMemoryId: "m1", targetType: "entity", targetEntityId: "e1" },
        ] as ParsedArchive["memoryLinks"],
      }),
      { userId: USER, agentId: AGENT }
    );

    expect(rowsInto(MEMORY_TABLE)[0]).toMatchObject({ createdBy: null, createdByAgent: AGENT });
    expect(rowsInto(LINK_TABLE)[0]).toMatchObject({ createdBy: null, createdByAgent: AGENT });
  });

  it("scopes every natural-key lookup to the target brain, inside the transaction", async () => {
    resolveAll();

    await run(fullArchive());

    expect(selects.map((call) => call.table)).toEqual([PROJECT_TABLE, ENTITY_TABLE, TAG_TABLE]);
    for (const call of selects) {
      const predicate = describeSql(call.where);
      expect(predicate, call.table).toContain(BRAIN);
      expect(predicate, call.table).not.toContain(OTHER_BRAIN);
      expect(call.txId, call.table).toBe(1);
    }
  });

  it("drops a link naming a real id that the archive itself never carried", async () => {
    // Remapping only knows archive-local ids, so a uuid borrowed from another brain
    // resolves to nothing and the edge is dropped rather than repointed.
    await run(
      archive({
        memories: [mem({ id: "m1" })],
        memoryLinks: [
          {
            sourceMemoryId: "m1",
            targetType: "memory",
            targetMemoryId: "44444444-4444-4444-8444-444444444444",
          },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    expect(insertsInto(LINK_TABLE)).toEqual([]);
  });
});

describe("memory rows", () => {
  it("fills every unstated field with the import default", async () => {
    await run(archive({ memories: [mem()] }));

    expect(rowsInto(MEMORY_TABLE)[0]).toMatchObject({
      type: "knowledge",
      title: "Use Postgres",
      content: "Every memory row lives in Postgres.",
      summary: null,
      importance: 0.5,
      confidence: 1,
      // An archive is a document, whatever the source brain called it.
      sourceType: "imported_document",
      sourceId: null,
      projectId: null,
      archivedAt: null,
    });
  });

  it("keeps every field the archive did state", async () => {
    await run(
      archive({
        memories: [
          mem({
            type: "decision",
            summary: "Postgres is the store.",
            importance: 0.9,
            confidence: 0.4,
            sourceType: "conversation",
            sourceId: "thread-7",
          }),
        ],
      })
    );

    expect(rowsInto(MEMORY_TABLE)[0]).toMatchObject({
      type: "decision",
      summary: "Postgres is the store.",
      importance: 0.9,
      confidence: 0.4,
      sourceType: "conversation",
      sourceId: "thread-7",
    });
  });

  it("writes the content hash so the enrichment sweep can re-derive locally", async () => {
    await run(
      archive({ memories: [mem({ type: "decision", summary: "Postgres is the store." })] })
    );

    const row = rowsInto(MEMORY_TABLE)[0];
    expect(row.contentHash).toBe(
      memoryContentHash({
        type: "decision",
        title: "Use Postgres",
        content: "Every memory row lives in Postgres.",
        summary: "Postgres is the store.",
      })
    );
    // Left unset so the column defaults to `pending`: the derived graph is re-derived
    // in this brain rather than trusted from the archive.
    expect(row).not.toHaveProperty("enrichedHash");
    expect(row).not.toHaveProperty("enrichmentStatus");
  });

  it("turns an archived timestamp into a date and leaves an absent one null", async () => {
    await run(
      archive({
        memories: [
          mem({ id: "m1", archivedAt: "2026-01-02T03:04:05.000Z" }),
          mem({ id: "m2", title: "Live" }),
        ],
      })
    );

    const [archived, live] = rowsInto(MEMORY_TABLE);
    expect(archived.archivedAt).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    expect(live.archivedAt).toBeNull();
  });

  it("merges provenance over the archive's own metadata", async () => {
    await run(archive({ memories: [mem({ metadata: { note: "keep", importedAt: "lie" } })] }));

    expect(rowsInto(MEMORY_TABLE)[0].metadata).toMatchObject({
      note: "keep",
      importedFrom: "Their Brain",
      archiveExportedAt: "2026-08-20T00:00:00.000Z",
    });
    // The archive must not be able to forge its own import stamp.
    expect((rowsInto(MEMORY_TABLE)[0].metadata as Record<string, unknown>).importedAt).not.toBe(
      "lie"
    );
  });

  it("repoints a project reference at the row this brain actually has", async () => {
    resolveProjects(["Storage"]);

    await run(
      archive({
        memories: [mem({ projectId: "p1" })],
        projects: [{ id: "p1", name: "Storage" }] as ParsedArchive["projects"],
      })
    );

    expect(rowsInto(MEMORY_TABLE)[0].projectId).toBe("proj-1");
  });

  it("leaves a memory unattached when its project could not be resolved", async () => {
    // The upsert raced or the name changed: better unattached than attached to
    // whatever row happened to answer.
    rows[PROJECT_TABLE] = [[]];

    await run(
      archive({
        memories: [mem({ projectId: "p1" })],
        projects: [{ id: "p1", name: "Storage" }] as ParsedArchive["projects"],
      })
    );

    expect(rowsInto(MEMORY_TABLE)[0].projectId).toBeNull();
  });

  it("does not deduplicate memories, so importing the same archive twice keeps both", async () => {
    // Merging on natural key is right for projects, entities and tags; it is wrong for
    // a memory, whose text is not an identity. This is a documented consequence, so it
    // is pinned rather than left to be discovered by a user.
    const parsed = archive({ memories: [mem()] });

    await run(parsed);
    await run(parsed);

    expect(insertsInto(MEMORY_TABLE)).toHaveLength(2);
    for (const call of insertsInto(MEMORY_TABLE)) expect(call.conflict).toBeNull();
  });
});

describe("projects merge on (brain_id, name)", () => {
  it("upserts by name and reports how many resolved", async () => {
    resolveProjects(["Storage", "Docs"]);

    const result = await run(
      archive({
        memories: [mem()],
        projects: [
          { id: "p1", name: "Storage", description: "  the store" },
          { id: "p2", name: "Docs", status: "archived" },
        ] as ParsedArchive["projects"],
      })
    );

    const written = rowsInto(PROJECT_TABLE);
    expect(written).toMatchObject([
      { brainId: BRAIN, name: "Storage", description: "  the store", status: "active" },
      { brainId: BRAIN, name: "Docs", description: null, status: "archived" },
    ]);
    expect(insertsInto(PROJECT_TABLE)[0].conflict).toBe("do-nothing");
    expect(result.written.projects).toBe(2);
  });

  it("counts only the projects it could resolve", async () => {
    resolveProjects(["Storage"]);

    const result = await run(
      archive({
        memories: [mem()],
        projects: [
          { id: "p1", name: "Storage" },
          { id: "p2", name: "Docs" },
        ] as ParsedArchive["projects"],
      })
    );

    expect(result.written.projects).toBe(1);
  });
});

describe("entities merge on (brain_id, name, type)", () => {
  it("upserts each node with the target brain and a defaulted type", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }, { name: "Kiro" }]);

    const result = await run(
      archive({
        memories: [mem()],
        entities: [
          { id: "e1", name: "Postgres", type: "technology", description: "The database" },
          { id: "e2", name: "Kiro" },
        ] as ParsedArchive["entities"],
      })
    );

    expect(rowsInto(ENTITY_TABLE)).toMatchObject([
      { brainId: BRAIN, name: "Postgres", type: "technology", description: "The database" },
      { brainId: BRAIN, name: "Kiro", type: "other", description: null },
    ]);
    expect(insertsInto(ENTITY_TABLE)[0].conflict).toBe("do-nothing");
    expect(result.written.entities).toBe(2);
  });

  it("treats the same name under two types as two nodes", async () => {
    resolveEntities([
      { name: "Supabase", type: "organization" },
      { name: "Supabase", type: "technology" },
    ]);

    const result = await run(
      archive({
        memories: [mem()],
        entities: [
          { id: "e1", name: "Supabase", type: "organization" },
          { id: "e2", name: "Supabase", type: "technology" },
        ] as ParsedArchive["entities"],
        relationships: [
          { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "same_name" },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(result.written.entities).toBe(2);
    expect(rowsInto(RELATIONSHIP_TABLE)).toMatchObject([
      { sourceEntityId: "ent-1", targetEntityId: "ent-2" },
    ]);
  });

  it("does not reuse a row that shares the name but not the type", async () => {
    // The natural key is (name, type); matching on name alone would fold a person
    // called "Supabase" into the company.
    resolveEntities([{ name: "Supabase", type: "organization" }]);

    const result = await run(
      archive({
        memories: [mem()],
        entities: [{ id: "e1", name: "Supabase", type: "person" }] as ParsedArchive["entities"],
      })
    );

    expect(result.written.entities).toBe(0);
  });

  it("drops a relationship whose endpoints collapse onto the same node", async () => {
    // Two archive ids for one natural key is legal; the self-edge it implies is not.
    resolveEntities([{ name: "Supabase", type: "organization" }]);

    const result = await run(
      archive({
        memories: [mem()],
        entities: [
          { id: "e1", name: "Supabase", type: "organization" },
          { id: "e2", name: "Supabase", type: "organization" },
        ] as ParsedArchive["entities"],
        relationships: [
          { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "duplicate_of" },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(insertsInto(RELATIONSHIP_TABLE)).toEqual([]);
    expect(result.written.relationships).toBe(0);
    // The preview counted it, because only the write knows the ids collided.
    expect(result.counts.relationships).toBe(1);
  });
});

describe("BUG-2 — archive metadata survives the write", () => {
  /**
   * `entityRecord`, `relationshipRecord` and `linkRecord` all accept `metadata`, and
   * `parseBrainArchive` keeps it. The write then replaced it wholesale with the
   * provenance block, so anything the source brain meant by it was gone — including the
   * `metadata` that `enrich-service` documents as human-owned and refuses to overwrite
   * ("enrichment owns provenance, humans own meaning"). Memories already merged the two;
   * these three now do the same.
   */
  const provenanceKeys = {
    importedFrom: "Their Brain",
    archiveExportedAt: "2026-08-20T00:00:00.000Z",
  };

  it("keeps curated entity metadata and adds provenance beside it", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    await run(
      archive({
        memories: [mem()],
        entities: [
          {
            id: "e1",
            name: "Postgres",
            type: "technology",
            metadata: { curated: true, owner: "platform" },
          },
        ] as ParsedArchive["entities"],
      })
    );

    expect(rowsInto(ENTITY_TABLE)[0].metadata).toMatchObject({
      curated: true,
      owner: "platform",
      ...provenanceKeys,
    });
  });

  it("keeps relationship metadata and adds provenance beside it", async () => {
    resolveEntities([
      { name: "Postgres", type: "technology" },
      { name: "Supabase", type: "organization" },
    ]);

    await run(
      archive({
        memories: [mem()],
        entities: [
          { id: "e1", name: "Postgres", type: "technology" },
          { id: "e2", name: "Supabase", type: "organization" },
        ] as ParsedArchive["entities"],
        relationships: [
          {
            sourceEntityId: "e1",
            targetEntityId: "e2",
            relationshipType: "hosted_by",
            metadata: { evidence: "docs/architecture.md" },
          },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(rowsInto(RELATIONSHIP_TABLE)[0].metadata).toMatchObject({
      evidence: "docs/architecture.md",
      ...provenanceKeys,
    });
  });

  it("keeps memory link metadata and adds provenance beside it", async () => {
    await run(
      archive({
        memories: [mem({ id: "m1" }), mem({ id: "m2", title: "Supabase" })],
        memoryLinks: [
          {
            sourceMemoryId: "m1",
            targetType: "memory",
            targetMemoryId: "m2",
            linkType: "supersedes",
            metadata: { note: "decision superseded in review" },
          },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    expect(rowsInto(LINK_TABLE)[0].metadata).toMatchObject({
      note: "decision superseded in review",
      ...provenanceKeys,
    });
  });

  it("still stamps provenance when the archive carried no metadata", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    await run(
      archive({
        memories: [mem()],
        entities: [{ id: "e1", name: "Postgres", type: "technology" }] as ParsedArchive["entities"],
      })
    );

    expect(rowsInto(ENTITY_TABLE)[0].metadata).toMatchObject(provenanceKeys);
    expect((rowsInto(ENTITY_TABLE)[0].metadata as Record<string, unknown>).importedAt).toEqual(
      expect.any(String)
    );
  });

  it("does not let archive metadata forge the provenance stamp", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    await run(
      archive({
        memories: [mem()],
        entities: [
          {
            id: "e1",
            name: "Postgres",
            type: "technology",
            metadata: { importedFrom: "Trusted Source", archiveExportedAt: "1999-01-01" },
          },
        ] as ParsedArchive["entities"],
      })
    );

    expect(rowsInto(ENTITY_TABLE)[0].metadata).toMatchObject(provenanceKeys);
  });
});

describe("BUG-2b — entity extraction provenance is not carried by the archive schema", () => {
  /**
   * Open, reported, deliberately unfixed: `exportGraph` writes whole `brain_entities`
   * rows, so an archive does carry `aliases`, `mentionCount`, `firstSeenAt`,
   * `lastSeenAt`, `extractedBy` and `extractionConfidence` — but `entityRecord` does not
   * list them, so zod strips them and the import cannot restore them.
   *
   * `mentionCount`, `firstSeenAt` and `lastSeenAt` are correct to drop: enrich-service
   * documents them as recomputed, never carried. `aliases`, `extractedBy` and
   * `extractionConfidence` are the real loss, because the enrichment upsert merges with
   * `coalesce(existing, excluded)` — an imported node whose `extracted_by` is null adopts
   * `deterministic-v1` on the first sweep, and a human-curated node is silently
   * re-labelled as machine-extracted.
   *
   * This pins today's behaviour so a fix has to come past this test on purpose.
   */
  it("strips extraction provenance at parse time", async () => {
    const parsed = await parseBrainArchive(
      await makeArchive({
        "memories.jsonl": [mem()],
        "entities.jsonl": [
          {
            id: "e1",
            name: "Postgres",
            type: "technology",
            aliases: ["pg", "postgresql"],
            mentionCount: 7,
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-06-01T00:00:00.000Z",
            extractedBy: "manual",
            extractionConfidence: 1,
          },
        ],
      })
    );

    const entity = parsed.entities[0] as Record<string, unknown>;
    expect(entity.name).toBe("Postgres");
    for (const field of [
      "aliases",
      "mentionCount",
      "firstSeenAt",
      "lastSeenAt",
      "extractedBy",
      "extractionConfidence",
    ]) {
      expect(entity[field], field).toBeUndefined();
    }
  });

  it("writes no extraction provenance columns, leaving them to the local sweep", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    await run(
      archive({
        memories: [mem()],
        entities: [{ id: "e1", name: "Postgres", type: "technology" }] as ParsedArchive["entities"],
      })
    );

    const row = rowsInto(ENTITY_TABLE)[0];
    expect(Object.keys(row).sort()).toEqual([
      "brainId",
      "description",
      "metadata",
      "name",
      "type",
    ]);
  });
});

describe("tags and tag assignments", () => {
  it("upserts the brain's own tag rows and attaches each memory to them", async () => {
    resolveTags(["infra", "db"]);

    const result = await run(
      archive({
        memories: [mem({ id: "m1", tags: ["Infra", "  infra  ", "db"] })],
        tags: ["infra"],
      })
    );

    expect(rowsInto(TAG_TABLE)).toMatchObject([
      { brainId: BRAIN, name: "infra" },
      { brainId: BRAIN, name: "db" },
    ]);
    expect(insertsInto(TAG_TABLE)[0].conflict).toBe("do-nothing");

    const memoryId = rowsInto(MEMORY_TABLE)[0].id;
    expect(rowsInto(TAG_MAP_TABLE)).toEqual([
      { memoryId, tagId: "tag-1" },
      { memoryId, tagId: "tag-2" },
    ]);
    expect(insertsInto(TAG_MAP_TABLE)[0].conflict).toBe("do-nothing");
    expect(result.written.tagAssignments).toBe(2);
  });

  it("skips an assignment whose tag row could not be resolved", async () => {
    resolveTags(["infra"]);

    const result = await run(archive({ memories: [mem({ tags: ["infra", "db"] })] }));

    expect(rowsInto(TAG_MAP_TABLE)).toHaveLength(1);
    expect(result.written.tagAssignments).toBe(1);
  });

  it("writes no tag statements at all when the archive has none", async () => {
    await run(archive({ memories: [mem()] }));

    expect(insertsInto(TAG_TABLE)).toEqual([]);
    expect(insertsInto(TAG_MAP_TABLE)).toEqual([]);
    expect(selects.map((call) => call.table)).not.toContain(TAG_TABLE);
  });
});

describe("memory versions", () => {
  const version = (over: Record<string, unknown> = {}) =>
    ({
      memoryId: "m1",
      versionNumber: 1,
      title: "Use Postgres",
      content: "old body",
      ...over,
    }) as ParsedArchive["memoryVersions"][number];

  it("repoints history at the new memory row and keeps the version numbers", async () => {
    const result = await run(
      archive({
        memories: [mem({ id: "m1" })],
        memoryVersions: [
          version({ versionNumber: 1 }),
          version({ versionNumber: 2, content: "newer body", changeReason: "clarified" }),
        ],
      })
    );

    const memoryId = rowsInto(MEMORY_TABLE)[0].id;
    expect(rowsInto(VERSION_TABLE)).toMatchObject([
      { memoryId, versionNumber: 1, content: "old body" },
      { memoryId, versionNumber: 2, content: "newer body", changeReason: "clarified" },
    ]);
    expect(result.written.memoryVersions).toBe(2);
    expect(insertsInto(VERSION_TABLE)[0].conflict).toBe("do-nothing");
  });

  it("does not reassign authorship of an edit made in another brain", async () => {
    await run(archive({ memories: [mem()], memoryVersions: [version()] }), {
      userId: USER,
      agentId: AGENT,
    });

    expect(rowsInto(VERSION_TABLE)[0]).toMatchObject({
      changedBy: null,
      changedByAgent: null,
    });
  });

  it("labels a version the archive gave no reason for", async () => {
    await run(archive({ memories: [mem()], memoryVersions: [version()] }));

    expect(rowsInto(VERSION_TABLE)[0].changeReason).toBe("Imported from .afrbrain archive");
  });

  it("drops history whose memory is not in the archive", async () => {
    const result = await run(
      archive({
        memories: [mem({ id: "m1" })],
        memoryVersions: [version(), version({ memoryId: "ghost" })],
      })
    );

    expect(rowsInto(VERSION_TABLE)).toHaveLength(1);
    expect(result.written.memoryVersions).toBe(1);
    expect(result.dropped.versionsWithoutMemory).toBe(1);
  });
});

describe("entity relationships", () => {
  const twoEntities = [
    { id: "e1", name: "Postgres", type: "technology" },
    { id: "e2", name: "Supabase", type: "organization" },
  ] as ParsedArchive["entities"];

  const resolveTwo = () =>
    resolveEntities([
      { name: "Postgres", type: "technology" },
      { name: "Supabase", type: "organization" },
    ]);

  it("remaps both endpoints and keeps the stated type and confidence", async () => {
    resolveTwo();

    const result = await run(
      archive({
        memories: [mem()],
        entities: twoEntities,
        relationships: [
          {
            sourceEntityId: "e1",
            targetEntityId: "e2",
            relationshipType: "hosted_by",
            confidence: 0.42,
          },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(rowsInto(RELATIONSHIP_TABLE)).toMatchObject([
      {
        brainId: BRAIN,
        sourceEntityId: "ent-1",
        targetEntityId: "ent-2",
        relationshipType: "hosted_by",
        confidence: 0.42,
      },
    ]);
    expect(insertsInto(RELATIONSHIP_TABLE)[0].conflict).toBe("do-nothing");
    expect(result.written.relationships).toBe(1);
  });

  it("defaults an unstated confidence to the column default", async () => {
    resolveTwo();

    await run(
      archive({
        memories: [mem()],
        entities: twoEntities,
        relationships: [
          { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "hosted_by" },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(rowsInto(RELATIONSHIP_TABLE)[0].confidence).toBe(0.9);
  });

  it("drops an edge whose endpoint did not resolve rather than repointing it", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    const result = await run(
      archive({
        memories: [mem()],
        entities: twoEntities,
        relationships: [
          { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "hosted_by" },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(insertsInto(RELATIONSHIP_TABLE)).toEqual([]);
    expect(result.written.relationships).toBe(0);
  });
});

describe("memory links", () => {
  it("writes a memory-to-memory link with only the memory end set", async () => {
    const result = await run(
      archive({
        memories: [mem({ id: "m1" }), mem({ id: "m2", title: "Supabase" })],
        memoryLinks: [
          {
            sourceMemoryId: "m1",
            targetType: "memory",
            targetMemoryId: "m2",
            linkType: "supersedes",
          },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    const [first, second] = rowsInto(MEMORY_TABLE).map((row) => row.id);
    expect(rowsInto(LINK_TABLE)).toMatchObject([
      {
        brainId: BRAIN,
        sourceMemoryId: first,
        targetType: "memory",
        targetMemoryId: second,
        targetEntityId: null,
        linkType: "supersedes",
      },
    ]);
    expect(insertsInto(LINK_TABLE)[0].conflict).toBe("do-nothing");
    expect(result.written.memoryLinks).toBe(1);
  });

  it("writes a memory-to-entity link with only the entity end set", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    await run(
      archive({
        memories: [mem({ id: "m1" })],
        entities: [{ id: "e1", name: "Postgres", type: "technology" }] as ParsedArchive["entities"],
        memoryLinks: [
          { sourceMemoryId: "m1", targetType: "entity", targetEntityId: "e1" },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    expect(rowsInto(LINK_TABLE)).toMatchObject([
      {
        targetType: "entity",
        targetMemoryId: null,
        targetEntityId: "ent-1",
        // Unstated link type falls back to the weakest claim, not to a guess.
        linkType: "relates_to",
      },
    ]);
  });

  it("drops a mention whose entity did not resolve", async () => {
    rows[ENTITY_TABLE] = [[]];

    const result = await run(
      archive({
        memories: [mem({ id: "m1" })],
        entities: [{ id: "e1", name: "Postgres", type: "technology" }] as ParsedArchive["entities"],
        memoryLinks: [
          { sourceMemoryId: "m1", targetType: "entity", targetEntityId: "e1" },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    expect(insertsInto(LINK_TABLE)).toEqual([]);
    expect(result.written.memoryLinks).toBe(0);
  });
});

/**
 * A single archive that touches every table the importer writes, so atomicity can be
 * asserted against a realistic write set rather than a single insert.
 */
function fullArchive(): ParsedArchive {
  resolveProjects(["Platform"]);
  resolveEntities([{ name: "Postgres", type: "technology" }, { name: "Supabase", type: "organization" }]);
  resolveTags(["deploy", "database"]);
  return archive({
    memories: [
      mem({ id: "m1", projectId: "p1", tags: ["deploy", "database"], importance: 0.82 }),
      mem({ id: "m2", title: "Supabase branching", tags: ["deploy"] }),
    ],
    memoryVersions: [
      { memoryId: "m1", versionNumber: 1, title: "Use Postgres", content: "Earlier wording." },
    ] as ParsedArchive["memoryVersions"],
    memoryLinks: [
      { sourceMemoryId: "m1", targetType: "memory", targetMemoryId: "m2", linkType: "relates_to" },
      { sourceMemoryId: "m2", targetType: "entity", targetEntityId: "e1" },
    ] as ParsedArchive["memoryLinks"],
    tags: ["deploy", "database"],
    projects: [{ id: "p1", name: "Platform" }] as ParsedArchive["projects"],
    entities: [
      { id: "e1", name: "Postgres", type: "technology" },
      { id: "e2", name: "Supabase", type: "organization" },
    ] as ParsedArchive["entities"],
    relationships: [
      { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "hosted_by" },
    ] as ParsedArchive["relationships"],
  });
}

describe("transaction atomicity", () => {
  it("performs every read and write inside exactly one transaction", async () => {
    await run(fullArchive());

    expect(transactions).toBe(1);
    expect(committed.length).toBeGreaterThan(0);
    // Nothing may leak outside the transaction: a `txId: null` write would be a row
    // that survives a rollback.
    expect(committed.filter((call) => call.txId !== 1)).toEqual([]);
    expect(selects.filter((call) => call.txId !== 1)).toEqual([]);

    // and it really did touch every table, so the assertion above is not vacuous
    const tables = new Set(committed.map((call) => call.table));
    expect(tables).toEqual(
      new Set([
        PROJECT_TABLE,
        ENTITY_TABLE,
        TAG_TABLE,
        MEMORY_TABLE,
        TAG_MAP_TABLE,
        VERSION_TABLE,
        RELATIONSHIP_TABLE,
        LINK_TABLE,
      ])
    );
  });

  it("commits nothing when the memory insert fails midway", async () => {
    const parsed = fullArchive();
    failOn = { table: MEMORY_TABLE, nth: 1 };

    await expect(run(parsed)).rejects.toThrow("write failed at the database");

    expect(rollbacks).toBe(1);
    expect(committed).toEqual([]);
    // the earlier writes were attempted, so this is a rollback and not an early return
    expect(attempted.map((call) => call.table)).toContain(PROJECT_TABLE);
    expect(attempted.map((call) => call.table)).toContain(ENTITY_TABLE);
  });

  it("leaves no dangling memories, tags or projects when the last insert fails", async () => {
    const parsed = fullArchive();
    failOn = { table: LINK_TABLE, nth: 1 };

    await expect(run(parsed)).rejects.toThrow("write failed at the database");

    expect(rollbacks).toBe(1);
    expect(committed).toEqual([]);
    for (const table of [MEMORY_TABLE, TAG_TABLE, TAG_MAP_TABLE, PROJECT_TABLE, ENTITY_TABLE, VERSION_TABLE]) {
      expect(insertsInto(table)).toEqual([]);
    }
  });

  it("propagates the underlying failure instead of reporting a partial success", async () => {
    const parsed = fullArchive();
    failOn = { table: VERSION_TABLE, nth: 1 };

    const outcome = await run(parsed).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ error })
    );

    expect(outcome).not.toHaveProperty("resolved");
    expect((outcome as { error: Error }).error).toBeInstanceOf(Error);
  });

  it("does not queue enrichment for a rolled back import", async () => {
    const parsed = fullArchive();
    failOn = { table: MEMORY_TABLE, nth: 1 };

    await expect(run(parsed)).rejects.toThrow();

    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("writes nothing at all during a preview", async () => {
    const parsed = fullArchive();

    previewImport(parsed);

    expect(attempted).toEqual([]);
    expect(committed).toEqual([]);
    expect(transactions).toBe(0);
  });
});

describe("chunking", () => {
  it("splits a large archive into bounded statements without losing rows", async () => {
    const many = Array.from({ length: 501 }, (_, i) => mem({ id: `m${i}`, title: `Memory ${i}` }));

    const result = await run(archive({ memories: many }));

    const calls = insertsInto(MEMORY_TABLE);
    expect(calls.map((call) => call.rows.length)).toEqual([500, 1]);
    expect(calls.every((call) => call.txId === 1)).toBe(true);
    expect(rowsInto(MEMORY_TABLE)).toHaveLength(501);
    expect(result.written.memories).toBe(501);
    // ids are minted per row, so a chunk boundary cannot duplicate one
    expect(new Set(rowsInto(MEMORY_TABLE).map((row) => row.id)).size).toBe(501);
  });

  it("chunks versions and links too", async () => {
    const many = Array.from({ length: 501 }, (_, i) => mem({ id: `m${i}` }));
    const versions = Array.from({ length: 501 }, (_, i) => ({
      memoryId: `m${i}`,
      versionNumber: 1,
      title: `Memory ${i}`,
      content: "Earlier wording.",
    })) as ParsedArchive["memoryVersions"];

    await run(archive({ memories: many, memoryVersions: versions }));

    expect(insertsInto(VERSION_TABLE).map((call) => call.rows.length)).toEqual([500, 1]);
  });
});

describe("determinism", () => {
  const stableRows = (table: string): Record<string, unknown>[] =>
    rowsInto(table).map((row) => {
      const { id, createdAt, metadata, ...rest } = row as Record<string, unknown>;
      void id;
      void createdAt;
      const { importedAt, ...meta } = (metadata ?? {}) as Record<string, unknown>;
      void importedAt;
      return { ...rest, metadata: meta };
    });

  it("produces the same write set twice for the same archive", async () => {
    const first = await run(fullArchive());
    const firstMemories = stableRows(MEMORY_TABLE);
    const firstLinks = stableRows(LINK_TABLE);
    const firstTables = committed.map((call) => call.table);

    reset();
    const second = await run(fullArchive());

    expect(second.written).toEqual(first.written);
    expect(second.counts).toEqual(first.counts);
    expect(committed.map((call) => call.table)).toEqual(firstTables);
    // Content is identical once the minted ids and the import clock are set aside.
    expect(stableRows(MEMORY_TABLE)).toEqual(firstMemories);
    expect(stableRows(LINK_TABLE).map((row) => row.linkType)).toEqual(
      firstLinks.map((row) => row.linkType)
    );
  });

  it("keeps row order stable, following archive order", async () => {
    const many = Array.from({ length: 5 }, (_, i) => mem({ id: `m${i}`, title: `Memory ${i}` }));

    await run(archive({ memories: many }));

    expect(rowsInto(MEMORY_TABLE).map((row) => row.title)).toEqual([
      "Memory 0",
      "Memory 1",
      "Memory 2",
      "Memory 3",
      "Memory 4",
    ]);
  });
});

describe("enrichment sweep", () => {
  it("queues exactly one bounded sweep after a successful import", async () => {
    await run(archive({ memories: [mem({ id: "m1" }), mem({ id: "m2", title: "Supabase" })] }));

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith("enrich_brain", { brainId: BRAIN, limit: 2 });
  });

  it("caps the sweep limit so a huge archive cannot flood the queue", async () => {
    const many = Array.from({ length: 240 }, (_, i) => mem({ id: `m${i}` }));

    await run(archive({ memories: many }));

    expect(enqueueJob).toHaveBeenCalledWith("enrich_brain", { brainId: BRAIN, limit: 200 });
  });

  it("does not queue a sweep when no memory was written", async () => {
    resolveEntities([{ name: "Postgres", type: "technology" }]);

    const result = await run(
      archive({
        memories: [],
        entities: [{ id: "e1", name: "Postgres", type: "technology" }] as ParsedArchive["entities"],
      })
    );

    expect(result.written.memories).toBe(0);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("queues only after the transaction has committed", async () => {
    let committedWhenQueued = -1;
    enqueueJob.mockImplementation(() => {
      committedWhenQueued = committed.length;
      return Promise.resolve({ id: "job-1" });
    });

    await run(fullArchive());

    expect(committedWhenQueued).toBe(committed.length);
    expect(committedWhenQueued).toBeGreaterThan(0);
  });

  it("still reports a successful import when the queue is unavailable", async () => {
    enqueueJob.mockRejectedValue(new Error("redis unavailable"));

    const result = await run(archive({ memories: [mem()] }));

    // Enrichment is a background chore; losing it must not undo a committed import.
    expect(result.written.memories).toBe(1);
    expect(rowsInto(MEMORY_TABLE)).toHaveLength(1);
  });
});

describe("an archive whose memories are all invalid does not look successful", () => {
  const brokenMemories = [
    { id: "m1", content: "A memory with no title at all." },
    { id: "m2", title: "Too important", content: "...", importance: 7 },
  ];

  it("reports the skipped records and imports zero memories", async () => {
    const bytes = await makeArchive({
      "memories.jsonl": brokenMemories,
      "entities.jsonl": [anEntity],
    });

    const parsed = await parseBrainArchive(bytes);

    expect(parsed.memories).toEqual([]);
    expect(parsed.warnings.some((warning) => warning.includes("memories.jsonl"))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes("skipped 2 invalid record(s)"))).toBe(
      true
    );
  });

  it("surfaces the loss in the preview the operator confirms against", async () => {
    const bytes = await makeArchive({
      "memories.jsonl": brokenMemories,
      "entities.jsonl": [anEntity],
      "memory_versions.jsonl": [
        { memoryId: "m1", versionNumber: 1, title: "Old", content: "Earlier wording." },
      ],
      "memory_links.jsonl": [{ sourceMemoryId: "m1", targetType: "entity", targetEntityId: "e1" }],
    });

    const preview = previewImport(await parseBrainArchive(bytes));

    // A preview claiming 0 memories, with warnings and a non-zero cascade, is the
    // honest signal. It is not an error, because an entities-only archive is legal.
    expect(preview.counts.memories).toBe(0);
    expect(preview.counts.entities).toBe(1);
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.dropped.versionsWithoutMemory).toBe(1);
    expect(preview.dropped.linksWithMissingEnd).toBe(1);
  });

  it("writes no memory rows and queues no sweep", async () => {
    const bytes = await makeArchive({
      "memories.jsonl": brokenMemories,
      "entities.jsonl": [anEntity],
    });
    resolveEntities([{ name: anEntity.name, type: anEntity.type }]);

    const result = await run(await parseBrainArchive(bytes));

    expect(insertsInto(MEMORY_TABLE)).toEqual([]);
    expect(result.written.memories).toBe(0);
    expect(result.written.entities).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("refuses the archive outright when nothing at all survived", async () => {
    const bytes = await makeArchive({ "memories.jsonl": brokenMemories });

    await expect(parseBrainArchive(bytes)).rejects.toThrow(
      /no memories or entities to import/i
    );
    expect(attempted).toEqual([]);
  });
});

/**
 * Export → import round trip.
 *
 * The archive is built by the real `buildArchiveMembers` from rows shaped like the
 * ones `collectBrainArchive` returns (full table rows, dates as `Date`), zipped the
 * same way `buildBrainArchive` zips them, then put through the real parser and the
 * real writer. This is the test that would have caught BUG-1: a scale mismatch shows
 * up here as total, silent memory loss.
 */
describe("export → import round trip", () => {
  const SOURCE_BRAIN = {
    id: "44444444-4444-4444-8444-444444444441",
    name: "Their Brain",
    description: "Exported before a migration",
  };
  const SRC_M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const SRC_M2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const SRC_E1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const SRC_E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const SRC_P1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const at = (iso: string) => new Date(iso);

  const sourceMemory = (over: Record<string, unknown>): Record<string, unknown> => ({
    brainId: SOURCE_BRAIN.id,
    type: "knowledge",
    summary: null,
    importance: 0.5,
    confidence: 0.9,
    sourceType: "user",
    sourceId: null,
    projectId: null,
    metadata: {},
    createdBy: OTHER_USER,
    createdByAgent: null,
    validityState: "active",
    enrichmentStatus: "done",
    enrichedHash: "0".repeat(64),
    contentHash: "0".repeat(64),
    accessCount: 12,
    lastAccessedAt: at("2026-08-19T08:00:00.000Z"),
    archivedAt: null,
    deletedAt: null,
    createdAt: at("2026-08-01T10:00:00.000Z"),
    updatedAt: at("2026-08-18T10:00:00.000Z"),
    tags: [] as string[],
    ...over,
  });

  function sourceData() {
    return {
      memories: [
        sourceMemory({
          id: SRC_M1,
          type: "decision",
          title: "Use Postgres for everything",
          content: "One datastore. Search, graph and queue all live in Postgres.",
          summary: "Single datastore decision.",
          importance: 0.82,
          projectId: SRC_P1,
          metadata: { decidedIn: "architecture review" },
          tags: ["deploy", "database"],
        }),
        sourceMemory({
          id: SRC_M2,
          title: "Supabase branching for previews",
          content: "Each preview deploy gets its own Supabase branch.",
          // 0 is the value an off-by-one range check is most likely to swallow.
          importance: 0,
          tags: ["deploy"],
        }),
      ],
      memoryVersions: [
        {
          id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
          memoryId: SRC_M1,
          versionNumber: 1,
          title: "Use Postgres",
          content: "One datastore.",
          summary: null,
          changeReason: "Initial capture",
          changedBy: OTHER_USER,
          changedByAgent: null,
          metadata: null,
          createdAt: at("2026-08-01T10:00:00.000Z"),
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
          memoryId: SRC_M1,
          versionNumber: 2,
          title: "Use Postgres for everything",
          content: "One datastore. Search, graph and queue all live in Postgres.",
          summary: "Single datastore decision.",
          changeReason: "Broadened after review",
          changedBy: OTHER_USER,
          changedByAgent: null,
          metadata: null,
          createdAt: at("2026-08-18T10:00:00.000Z"),
        },
      ],
      tags: [
        { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", brainId: SOURCE_BRAIN.id, name: "deploy" },
        { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2", brainId: SOURCE_BRAIN.id, name: "database" },
      ],
      projects: [
        {
          id: SRC_P1,
          brainId: SOURCE_BRAIN.id,
          name: "Platform",
          description: "Core infrastructure",
          status: "active",
          createdAt: at("2026-07-01T10:00:00.000Z"),
        },
      ],
      entities: [
        {
          id: SRC_E1,
          brainId: SOURCE_BRAIN.id,
          name: "Postgres",
          type: "technology",
          description: "The only datastore.",
          metadata: { curated: true, owner: "platform" },
          aliases: ["PostgreSQL"],
          mentionCount: 9,
          extractedBy: null,
          extractionConfidence: null,
          firstSeenAt: at("2026-07-01T10:00:00.000Z"),
          lastSeenAt: at("2026-08-18T10:00:00.000Z"),
        },
        {
          id: SRC_E2,
          brainId: SOURCE_BRAIN.id,
          name: "Supabase",
          type: "organization",
          description: null,
          metadata: null,
          aliases: [],
          mentionCount: 2,
          extractedBy: "deterministic-v1",
          extractionConfidence: 0.6,
          firstSeenAt: at("2026-08-02T10:00:00.000Z"),
          lastSeenAt: at("2026-08-18T10:00:00.000Z"),
        },
      ],
      relationships: [
        {
          id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
          brainId: SOURCE_BRAIN.id,
          sourceEntityId: SRC_E1,
          targetEntityId: SRC_E2,
          relationshipType: "hosted_by",
          confidence: 0.75,
          metadata: { evidence: "docs/architecture.md" },
          createdAt: at("2026-08-02T10:00:00.000Z"),
        },
      ],
      memoryLinks: [
        {
          id: "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          brainId: SOURCE_BRAIN.id,
          sourceMemoryId: SRC_M2,
          targetType: "memory",
          targetMemoryId: SRC_M1,
          targetEntityId: null,
          linkType: "relates_to",
          metadata: { note: "same decision thread" },
          createdBy: OTHER_USER,
          createdByAgent: null,
          createdAt: at("2026-08-18T10:00:00.000Z"),
        },
        {
          id: "99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          brainId: SOURCE_BRAIN.id,
          sourceMemoryId: SRC_M1,
          targetType: "entity",
          targetMemoryId: null,
          targetEntityId: SRC_E1,
          linkType: "mentions",
          metadata: null,
          createdBy: OTHER_USER,
          createdByAgent: null,
          createdAt: at("2026-08-18T10:00:00.000Z"),
        },
      ],
    };
  }

  /** Mirror `buildBrainArchive`'s zip step, then parse the bytes back. */
  async function exportThenParse() {
    const data = sourceData();
    const { manifest, members } = buildArchiveMembers(
      SOURCE_BRAIN,
      data as unknown as Parameters<typeof buildArchiveMembers>[1]
    );
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    for (const member of members) {
      const body = member.records.map((record) => JSON.stringify(record)).join("\n");
      zip.file(member.path, member.records.length > 0 ? `${body}\n` : body);
    }
    const bytes = await zip.generateAsync({ type: "uint8array" });
    return { data, manifest, parsed: await parseBrainArchive(bytes) };
  }

  /** Resolve the natural keys the way a fresh target brain would after the upserts. */
  function primeTarget() {
    resolveProjects(["Platform"]);
    resolveEntities([
      { name: "Postgres", type: "technology" },
      { name: "Supabase", type: "organization" },
    ]);
    resolveTags(["database", "deploy"]);
  }

  const idsByTitle = () =>
    new Map(rowsInto(MEMORY_TABLE).map((row) => [row.title as string, row.id as string]));

  it("parses a real archive without skipping a single record", async () => {
    const { parsed } = await exportThenParse();

    // The BUG-1 signature was exactly this list being empty with a warning attached.
    expect(parsed.warnings).toEqual([]);
    expect(parsed.memories).toHaveLength(2);
    expect(parsed.memoryVersions).toHaveLength(2);
    expect(parsed.memoryLinks).toHaveLength(2);
    expect(parsed.entities).toHaveLength(2);
    expect(parsed.relationships).toHaveLength(1);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.tags).toHaveLength(2);
    expect(parsed.sourceBrainName).toBe("Their Brain");
  });

  it("loses no memory and preserves importance exactly", async () => {
    const { data, parsed } = await exportThenParse();
    primeTarget();

    const result = await run(parsed);

    const written = rowsInto(MEMORY_TABLE);
    expect(written).toHaveLength(data.memories.length);
    expect(written.map((row) => row.title)).toEqual(data.memories.map((row) => row.title));
    expect(written.map((row) => row.importance)).toEqual([0.82, 0]);
    expect(result.written.memories).toBe(2);
  });

  it("keeps every version tied to its own memory", async () => {
    const { parsed } = await exportThenParse();
    primeTarget();

    await run(parsed);

    const decisionId = idsByTitle().get("Use Postgres for everything");
    const versions = rowsInto(VERSION_TABLE);
    expect(versions).toHaveLength(2);
    expect(versions.map((row) => row.memoryId)).toEqual([decisionId, decisionId]);
    expect(versions.map((row) => row.versionNumber)).toEqual([1, 2]);
    expect(versions.map((row) => row.title)).toEqual([
      "Use Postgres",
      "Use Postgres for everything",
    ]);
  });

  it("keeps every link pointing at the same endpoints it did in the source brain", async () => {
    const { parsed } = await exportThenParse();
    primeTarget();

    await run(parsed);

    const ids = idsByTitle();
    const links = rowsInto(LINK_TABLE);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      sourceMemoryId: ids.get("Supabase branching for previews"),
      targetType: "memory",
      targetMemoryId: ids.get("Use Postgres for everything"),
      targetEntityId: null,
      linkType: "relates_to",
    });
    expect(links[1]).toMatchObject({
      sourceMemoryId: ids.get("Use Postgres for everything"),
      targetType: "entity",
      targetMemoryId: null,
      // "Postgres"/technology, the first primed entity
      targetEntityId: "ent-1",
      linkType: "mentions",
    });
  });

  it("still has every entity, with curated metadata intact beside provenance", async () => {
    const { parsed } = await exportThenParse();
    primeTarget();

    const result = await run(parsed);

    const entities = rowsInto(ENTITY_TABLE);
    expect(entities.map((row) => row.name)).toEqual(["Postgres", "Supabase"]);
    expect(entities[0]).toMatchObject({
      type: "technology",
      description: "The only datastore.",
      metadata: {
        curated: true,
        owner: "platform",
        importedFrom: "Their Brain",
      },
    });
    expect(result.written.entities).toBe(2);
    expect(rowsInto(RELATIONSHIP_TABLE)).toMatchObject([
      { sourceEntityId: "ent-1", targetEntityId: "ent-2", relationshipType: "hosted_by", confidence: 0.75 },
    ]);
  });

  it("reports counts that agree with the manifest and with what was written", async () => {
    const { manifest, parsed } = await exportThenParse();
    primeTarget();

    const result = await run(parsed);

    expect(manifest.counts).toMatchObject({
      memories: 2,
      memory_versions: 2,
      memory_links: 2,
      tags: 2,
      projects: 1,
      entities: 2,
      relationships: 1,
    });
    expect(result.counts).toEqual({
      memories: 2,
      memoryVersions: 2,
      memoryLinks: 2,
      tags: 2,
      projects: 1,
      entities: 2,
      relationships: 1,
    });
    expect(result.written).toEqual({
      memories: 2,
      memoryVersions: 2,
      memoryLinks: 2,
      projects: 1,
      entities: 2,
      relationships: 1,
      // "deploy"+"database" on the decision, "deploy" on the other
      tagAssignments: 3,
    });
    expect(result.dropped).toEqual({
      versionsWithoutMemory: 0,
      linksWithMissingEnd: 0,
      relationshipsWithMissingEnd: 0,
      projectRefsCleared: 0,
    });
  });

  it("rebases the whole archive onto the target brain and importer", async () => {
    const { parsed } = await exportThenParse();
    primeTarget();

    await run(parsed);

    const serialized = JSON.stringify(committed);
    expect(serialized).not.toContain(SOURCE_BRAIN.id);
    expect(serialized).not.toContain(OTHER_USER);
    expect(serialized).not.toContain(SRC_M1);
    expect(serialized).not.toContain(SRC_E1);
    for (const row of rowsInto(MEMORY_TABLE)) {
      expect(row.brainId).toBe(BRAIN);
      expect(row.createdBy).toBe(USER);
      expect(row.id).toMatch(UUID_V4);
      expect(row.sourceType).not.toBe(undefined);
    }
    // Imported memories start unenriched locally: the derived graph is re-derived.
    expect(enqueueJob).toHaveBeenCalledWith("enrich_brain", { brainId: BRAIN, limit: 2 });
  });

  it("survives a second import of the same archive by merging, not duplicating", async () => {
    const first = await exportThenParse();
    primeTarget();
    await run(first.parsed);
    const firstMemories = rowsInto(MEMORY_TABLE).length;

    reset();
    const second = await exportThenParse();
    primeTarget();
    const result = await run(second.parsed);

    // Projects, entities and tags merge on their natural key (`do-nothing`); memories
    // are content, so a second import is a second copy by design.
    expect(rowsInto(MEMORY_TABLE)).toHaveLength(firstMemories);
    for (const table of [PROJECT_TABLE, ENTITY_TABLE, TAG_TABLE]) {
      expect(insertsInto(table).every((call) => call.conflict === "do-nothing")).toBe(true);
    }
    expect(result.written.entities).toBe(2);
    expect(result.written.projects).toBe(1);
  });
});

describe("fields an archive is not allowed to set", () => {
  it("writes a fixed column set for a memory, whatever the archive contains", async () => {
    const bytes = await makeArchive({
      "memories.jsonl": [
        {
          id: "m1",
          title: "Looks harmless",
          content: "...",
          // everything below is either derived, lifecycle, or ownership state
          deletedAt: "2020-01-01T00:00:00.000Z",
          accessCount: 9999,
          validityState: "superseded",
          enrichmentStatus: "done",
          enrichedHash: "f".repeat(64),
          contentHash: "f".repeat(64),
          searchVector: "'injected':1",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });

    await run(await parseBrainArchive(bytes));

    const row = rowsInto(MEMORY_TABLE)[0];
    expect(Object.keys(row).sort()).toEqual([
      "archivedAt",
      "brainId",
      "confidence",
      "contentHash",
      "content",
      "createdBy",
      "createdByAgent",
      "id",
      "importance",
      "metadata",
      "projectId",
      "sourceId",
      "sourceType",
      "summary",
      "title",
      "type",
    ].sort());
    // `contentHash` is recomputed locally, never adopted from the archive.
    expect(row.contentHash).not.toBe("f".repeat(64));
    expect(JSON.stringify(committed)).not.toContain("injected");
  });

  it("keeps a deleted-looking memory importable rather than resurrecting archive state", async () => {
    const bytes = await makeArchive({
      "memories.jsonl": [
        { id: "m1", title: "Archived note", content: "...", archivedAt: "2026-01-05T00:00:00.000Z" },
      ],
    });

    await run(await parseBrainArchive(bytes));

    // `archivedAt` is user intent about content and is honoured; `deletedAt` is not a
    // field the importer reads at all.
    expect(rowsInto(MEMORY_TABLE)[0].archivedAt).toEqual(new Date("2026-01-05T00:00:00.000Z"));
    expect(rowsInto(MEMORY_TABLE)[0]).not.toHaveProperty("deletedAt");
  });
});

// PLACEHOLDER_TESTS
