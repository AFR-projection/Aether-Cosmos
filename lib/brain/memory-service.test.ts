import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { BrainValidationError, MemoryNotFoundError } from "./errors";
import { memoryContentHash } from "./enrich/enrich-service";

/**
 * Core memory CRUD, search, versioning and tagging.
 *
 * Key properties pinned here: `createMemory` normalizes tags and requests
 * enrichment; `updateMemory` snapshots a version only when versioned columns change,
 * re-enriches only when the hash changes, and serializes concurrent writes with FOR
 * UPDATE; `listMemories` uses keyset pagination with the (created_at, id) tuple;
 * `searchMemories` delegates tsquery assembly to Postgres via the FTS helpers;
 * `tagsForMemories` fetches all tags in one query; and `getMemoryVersions` joins
 * through `memories` so a brain the caller does not own cannot be used to read
 * version history belonging to somebody else.
 */

type Rows = Record<string, unknown[][]>;
type WriteCall = {
  verb: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, unknown>;
  conflict?: unknown;
  set?: Record<string, unknown>;
  where?: unknown;
  returning?: boolean;
  inTransaction: boolean;
};
type ReadCall = {
  table: string;
  where: unknown;
  join?: unknown;
  limit: number | null;
  order: unknown;
  forUpdate?: boolean;
};

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
    // Capture table references in SQL fragments
    if ("sql" in record && typeof record.sql === "string") parts.push(record.sql);
  };

  walk(node);
  return parts.join(" ");
}

const reads: ReadCall[] = [];
const writes: WriteCall[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();
let txDepth = 0;
let transactions = 0;

function readOf(table: string, index = 0): ReadCall | undefined {
  return reads.filter((r) => r.table === table)[index];
}

function writeOf(verb: string, table: string, index = 0): WriteCall | undefined {
  return writes.filter((w) => w.verb === verb && w.table === table)[index];
}

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
    for(mode: string) {
      if (mode === "update") call.forUpdate = true;
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

function settle(call: WriteCall, fallback: unknown[]): Promise<unknown[]> {
  writes.push(call);
  return Promise.resolve(fallback);
}

function insertChain(table: unknown) {
  const call: WriteCall = {
    verb: "insert",
    table: getTableName(table as never),
    inTransaction: txDepth > 0,
  };
  const chain = {
    values(values: unknown) {
      call.values = Array.isArray(values) ? { __array: values } : (values as Record<string, unknown>);
      return chain;
    },
    onConflictDoNothing() {
      call.conflict = "do-nothing";
      return chain;
    },
    returning: () => {
      call.returning = true;
      return settle(call, rows[`__insert:${call.table}`]?.[0] ?? [{ id: "m1", ...call.values }]);
    },
    then<T>(resolve: (value: unknown[]) => T, reject?: (reason: unknown) => T) {
      return settle(call, []).then(resolve, reject);
    },
  };
  return chain;
}

function updateChain(table: unknown) {
  const call: WriteCall = {
    verb: "update",
    table: getTableName(table as never),
    inTransaction: txDepth > 0,
  };
  const chain = {
    set(patch: Record<string, unknown>) {
      call.set = patch;
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    returning: () => {
      call.returning = true;
      return settle(call, rows.__update?.[0] ?? [{ id: "m1", ...call.set }]);
    },
    then<T>(resolve: (value: unknown[]) => T, reject?: (reason: unknown) => T) {
      return settle(call, []).then(resolve, reject);
    },
  };
  return chain;
}

function deleteChain(table: unknown) {
  const call: WriteCall = {
    verb: "delete",
    table: getTableName(table as never),
    inTransaction: txDepth > 0,
  };
  const chain = {
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    // PHASE 2: the derived-edge cleanup counts what it removed, so a delete has to
    // be able to report rows the way the real driver does.
    returning: () => {
      call.returning = true;
      return settle(call, rows[`__delete:${call.table}`]?.[0] ?? []);
    },
    then<T>(resolve: (value: unknown[]) => T, reject?: (reason: unknown) => T) {
      return settle(call, []).then(resolve, reject);
    },
  };
  return chain;
}

const handle = {
  select: () => selectChain(),
  insert: insertChain,
  update: updateChain,
  delete: deleteChain,
};

vi.mock("@/lib/db", () => ({
  db: {
    ...handle,
    async transaction<T>(callback: (tx: typeof handle) => Promise<T>): Promise<T> {
      transactions += 1;
      txDepth += 1;
      try {
        return await callback(handle);
      } finally {
        txDepth -= 1;
      }
    },
  },
}));

const enqueueJob = vi.fn();
enqueueJob.mockResolvedValue({ id: "job-1" });
vi.mock("@/lib/queue", () => ({
  enqueueJob: (type: string, data: unknown) => enqueueJob(type, data),
}));

const {
  createMemory,
  listMemories,
  getMemory,
  requireMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
  getMemoryVersions,
  restoreMemoryVersion,
  listBrainTags,
  exportMemories,
} = await import("./memory-service");

const USER = "11111111-1111-4111-8111-111111111111";
const BRAIN = "22222222-2222-4222-8222-222222222222";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const AGENT = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

const MEMORY_TABLE = getTableName(schema.memories);
const TAG_TABLE = getTableName(schema.memoryTags);
const TAG_MAP_TABLE = getTableName(schema.memoryTagMap);
const VERSION_TABLE = getTableName(schema.memoryVersions);

const memoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  brainId: BRAIN,
  type: "fact",
  title: "Deploy notes",
  content: "Always run migrations first",
  summary: null,
  importance: 0.5,
  confidence: 0.9,
  sourceType: "user",
  sourceId: null,
  createdBy: USER,
  createdByAgent: null,
  projectId: null,
  metadata: null,
  version: 1,
  contentHash: "abc123",
  enrichmentStatus: "pending",
  enrichmentError: null,
  enrichedHash: null,
  createdAt: new Date("2026-08-20T10:00:00Z"),
  updatedAt: new Date("2026-08-20T10:00:00Z"),
  lastAccessedAt: null,
  archivedAt: null,
  deletedAt: null,
  searchVector: null,
  supersededById: null,
  ...overrides,
});

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  rows = {};
  cursors.clear();
  txDepth = 0;
  transactions = 0;
  enqueueJob.mockClear();
  vi.clearAllTimers();
});

describe("createMemory", () => {
  it("writes the memory with trimmed title and requests enrichment", async () => {
    rows[`__insert:${MEMORY_TABLE}`] = [[memoryRow()]];

    const created = await createMemory({
      brainId: BRAIN,
      principal: { userId: USER, agentId: null },
      data: { title: "  Deploy notes  ", content: "Always run migrations first" },
    });

    expect(created.title).toBe("Deploy notes");
    expect(transactions).toBe(1);
    const insert = writeOf("insert", MEMORY_TABLE)!;
    expect(insert.values).toMatchObject({
      brainId: BRAIN,
      type: "fact",
      title: "Deploy notes",
      content: "Always run migrations first",
      importance: 0.5,
      confidence: 0.9,
      sourceType: "user",
      createdBy: USER,
      createdByAgent: null,
    });
    expect(insert.inTransaction).toBe(true);
    expect(enqueueJob).toHaveBeenCalledWith("enrich_memory", { brainId: BRAIN, memoryId: "m1" });
  });

  it("normalizes tags and upserts them inside the transaction", async () => {
    rows[`__insert:${MEMORY_TABLE}`] = [[memoryRow()]];
    rows[TAG_TABLE] = [[{ id: "t1" }]];

    const created = await createMemory({
      brainId: BRAIN,
      principal: { userId: USER, agentId: null },
      data: { title: "Deploy", content: "...", tags: ["  Deploy ", "deploy", ""] },
    });

    expect(created.tags).toEqual(["deploy"]);
    expect(transactions).toBe(1);
    const tagInsert = writeOf("insert", TAG_TABLE)!;
    expect(tagInsert.inTransaction).toBe(true);
    expect(tagInsert.conflict).toBe("do-nothing");
    const tagMapInsert = writeOf("insert", TAG_MAP_TABLE)!;
    expect(tagMapInsert.inTransaction).toBe(true);
  });

  it("defaults type to 'fact' and sourceType to 'agent' when created by an agent", async () => {
    rows[`__insert:${MEMORY_TABLE}`] = [[memoryRow({ createdByAgent: AGENT })]];

    await createMemory({
      brainId: BRAIN,
      principal: { userId: USER, agentId: AGENT },
      data: { title: "Agent memory", content: "..." },
    });

    const insert = writeOf("insert", MEMORY_TABLE)!;
    expect(insert.values).toMatchObject({
      type: "fact",
      sourceType: "agent",
      createdByAgent: AGENT,
      createdBy: null,
    });
  });
});

describe("listMemories", () => {
  it("filters by brain and non-deleted, ordered newest first", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];

    const { memories } = await listMemories({ brainId: BRAIN });

    expect(memories).toHaveLength(1);
    const read = readOf(MEMORY_TABLE)!;
    const predicate = describeSql(read.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("deleted_at");
    expect(predicate).not.toContain(OTHER_BRAIN);
    expect(describeSql(read.order)).toContain("created_at");
  });

  it("reads one extra row to detect hasMore, and encodes a cursor from the last visible row", async () => {
    rows[MEMORY_TABLE] = [
      [memoryRow({ id: "m1" }), memoryRow({ id: "m2" }), memoryRow({ id: "m3" })],
      [],
    ];

    const { memories, nextCursor } = await listMemories({ brainId: BRAIN, limit: 2 });

    expect(memories).toHaveLength(2);
    expect(memories[1].id).toBe("m2");
    expect(readOf(MEMORY_TABLE)!.limit).toBe(3);
    expect(nextCursor).toBeTruthy();
  });

  it("returns null cursor when the page is not full", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];

    const { nextCursor } = await listMemories({ brainId: BRAIN, limit: 20 });

    expect(nextCursor).toBeNull();
  });

  it("applies the keyset predicate when a cursor is provided", async () => {
    const cursor = Buffer.from("2026-08-20T10:00:00.000Z|11111111-1111-4111-8111-111111111111", "utf8").toString("base64url");
    rows[MEMORY_TABLE] = [[], []];

    await listMemories({ brainId: BRAIN, cursor });

    const predicate = describeSql(readOf(MEMORY_TABLE)!.where);
    expect(predicate).toContain("created_at");
    expect(predicate).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("filters archived when requested, live otherwise", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await listMemories({ brainId: BRAIN, archived: true });
    const archived = describeSql(readOf(MEMORY_TABLE, 0)!.where);
    expect(archived).toContain("archived_at");

    await listMemories({ brainId: BRAIN });
    const live = describeSql(readOf(MEMORY_TABLE, 1)!.where);
    expect(live).toContain("archived_at");
  });

  it("filters by type and project when provided", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await listMemories({ brainId: BRAIN, type: "decision", projectId: PROJECT });

    const predicate = describeSql(readOf(MEMORY_TABLE)!.where);
    expect(predicate).toContain("decision");
    expect(predicate).toContain(PROJECT);
  });

  it("filters by tag with a subquery", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await listMemories({ brainId: BRAIN, tag: "  Deploy  " });

    const predicate = describeSql(readOf(MEMORY_TABLE)!.where);
    expect(predicate).toContain("deploy");
    expect(predicate).toContain("tag_id");
  });
});

describe("getMemory", () => {
  it("reads the memory and its tags, and stamps last_accessed_at", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];

    const memory = await getMemory({ brainId: BRAIN, memoryId: "m1" });

    expect(memory?.id).toBe("m1");
    expect(Array.isArray(memory?.tags)).toBe(true);
    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).toHaveProperty("lastAccessedAt");
    expect(describeSql(update.where)).toContain("m1");
  });

  it("skips the touch when explicitly disabled", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];

    await getMemory({ brainId: BRAIN, memoryId: "m1", touch: false });

    expect(writeOf("update", MEMORY_TABLE)).toBeUndefined();
  });

  it("returns null when the memory does not exist", async () => {
    rows[MEMORY_TABLE] = [[], []];

    const memory = await getMemory({ brainId: BRAIN, memoryId: "m1" });

    expect(memory).toBeNull();
  });
});

describe("requireMemory", () => {
  it("returns the memory when it exists", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()]];

    const memory = await requireMemory(BRAIN, "m1");

    expect(memory.id).toBe("m1");
  });

  it("throws MemoryNotFoundError when absent", async () => {
    rows[MEMORY_TABLE] = [[]];

    await expect(requireMemory(BRAIN, "m1")).rejects.toThrow(MemoryNotFoundError);
  });
});

describe("updateMemory", () => {
  it("locks the row with FOR UPDATE before patching it", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];
    rows.__update = [[memoryRow({ title: "Updated" })]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { title: "Updated" },
    });

    expect(transactions).toBe(1);
    const select = readOf(MEMORY_TABLE)!;
    expect(select.forUpdate).toBe(true);
    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.inTransaction).toBe(true);
  });

  it("snapshots a version only when versioned columns change", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];
    rows.__update = [[memoryRow({ importance: 0.8 })]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { importance: 0.8 },
    });

    expect(writeOf("insert", VERSION_TABLE)).toBeUndefined();
    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).toMatchObject({ importance: 0.8 });
    expect(update.set).not.toHaveProperty("version");
  });

  it("snapshots a version when title, content, summary or metadata change", async () => {
    rows[MEMORY_TABLE] = [[memoryRow({ version: 5 })], []];
    rows.__update = [[memoryRow({ title: "New title", version: 6 })]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { title: "New title" },
      changeReason: "Fixed typo",
    });

    const versionInsert = writeOf("insert", VERSION_TABLE)!;
    expect(versionInsert.inTransaction).toBe(true);
    const values = versionInsert.values as Record<string, unknown>;
    expect(values).toMatchObject({
      memoryId: "m1",
      versionNumber: 5,
      title: "Deploy notes",
      changeReason: "Fixed typo",
      changedBy: USER,
      changedByAgent: null,
    });
    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).toHaveProperty("version", 6);
  });

  it("re-enriches only when the content hash changes", async () => {
    // Use the real hash calculation so the hash actually matches
    const hash = memoryContentHash({ type: "fact", title: "Deploy", content: "...", summary: null });
    const existing = memoryRow({
      contentHash: hash,
      title: "Deploy",
      content: "...",
      summary: null,
      type: "fact"
    });
    rows[MEMORY_TABLE] = [[existing], []];
    rows.__update = [[{ ...existing, importance: 0.7, updatedAt: new Date() }]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { importance: 0.7 },
    });

    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).not.toHaveProperty("enrichmentStatus");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("requests enrichment when the hash changes", async () => {
    rows[MEMORY_TABLE] = [[memoryRow({ contentHash: "old" })], []];
    rows.__update = [[memoryRow({ contentHash: "new", enrichmentStatus: "pending" })]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { content: "Different content" },
    });

    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).toMatchObject({
      enrichmentStatus: "pending",
      enrichmentError: null,
    });
    expect(enqueueJob).toHaveBeenCalledWith("enrich_memory", { brainId: BRAIN, memoryId: "m1" });
  });

  it("replaces tags when provided", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];
    rows.__update = [[memoryRow()]];
    rows[TAG_TABLE] = [[{ id: "t1" }]];

    const updated = await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { tags: ["new-tag"] },
    });

    expect(updated.tags).toEqual(["new-tag"]);
    expect(writeOf("delete", TAG_MAP_TABLE)).toBeDefined();
    expect(writeOf("insert", TAG_TABLE)).toBeDefined();
  });

  it("throws when no fields are provided", async () => {
    await expect(
      updateMemory({
        brainId: BRAIN,
        memoryId: "m1",
        principal: { userId: USER, agentId: null },
        data: {},
      })
    ).rejects.toThrow(BrainValidationError);
  });

  it("throws when the memory does not exist", async () => {
    rows[MEMORY_TABLE] = [[]];

    await expect(
      updateMemory({
        brainId: BRAIN,
        memoryId: "m1",
        principal: { userId: USER, agentId: null },
        data: { title: "Update" },
      })
    ).rejects.toThrow(MemoryNotFoundError);
  });
});

describe("deleteMemory", () => {
  it("soft-deletes by setting deleted_at and updated_at", async () => {
    rows.__update = [[{ id: "m1" }]];

    const deleted = await deleteMemory({ brainId: BRAIN, memoryId: "m1" });

    expect(deleted).toBe(true);
    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).toHaveProperty("deletedAt");
    expect(update.set).toHaveProperty("updatedAt");
    const predicate = describeSql(update.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("m1");
    expect(predicate).toContain("deleted_at");
  });

  it("returns false when nothing matched", async () => {
    rows.__update = [[]];

    const deleted = await deleteMemory({ brainId: BRAIN, memoryId: "m1" });

    expect(deleted).toBe(false);
  });
});

describe("PHASE 2 lifecycle — when derived edges are asked for and thrown away", () => {
  const DERIVED_TABLE = getTableName(schema.memoryDerivedLinks);
  const LINK_TABLE = getTableName(schema.memoryLinks);

  /** The cleanup is fire-and-forget; let its microtasks run before asserting. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A memory whose stored hash matches its text, so no edit looks like a rewrite. */
  const settledRow = (overrides: Record<string, unknown> = {}) =>
    memoryRow({
      title: "Deploy",
      content: "...",
      summary: null,
      type: "fact",
      contentHash: memoryContentHash({ type: "fact", title: "Deploy", content: "...", summary: null }),
      ...overrides,
    });

  it("asks for enrichment on create and lets the worker chain relate", async () => {
    rows[`__insert:${MEMORY_TABLE}`] = [[memoryRow()]];

    await createMemory({
      brainId: BRAIN,
      principal: { userId: USER, agentId: null },
      data: { title: "Deploy notes", content: "Always run migrations first" },
    });

    // PRINSIP 9: CREATE → enrichment → relate. Requesting relate here too would
    // score the memory before it has entities or a summary to score with.
    expect(enqueueJob).toHaveBeenCalledWith("enrich_memory", { brainId: BRAIN, memoryId: "m1" });
    expect(enqueueJob).not.toHaveBeenCalledWith("relate_memory", expect.anything());
  });

  it("asks for relate directly when only the tags moved", async () => {
    rows[MEMORY_TABLE] = [[settledRow()], []];
    rows.__update = [[settledRow()]];
    rows[TAG_TABLE] = [[{ id: "t1" }]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { tags: ["hetzner"] },
    });

    // Tags are a signal family of their own and are not part of contentHash, so
    // enrichment would never run and nothing would ever re-score this memory.
    expect(enqueueJob).toHaveBeenCalledWith("relate_memory", { brainId: BRAIN, memoryId: "m1" });
    expect(enqueueJob).not.toHaveBeenCalledWith("enrich_memory", expect.anything());
  });

  it("asks for relate directly when the project moved", async () => {
    rows[MEMORY_TABLE] = [[settledRow()], []];
    rows.__update = [[settledRow({ projectId: PROJECT })]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { projectId: PROJECT, importance: 0.7 },
    });

    expect(enqueueJob).toHaveBeenCalledWith("relate_memory", { brainId: BRAIN, memoryId: "m1" });
  });

  it("accepts a patch that only moves the memory between projects", async () => {
    rows[MEMORY_TABLE] = [[settledRow()], []];
    rows.__update = [[settledRow({ projectId: PROJECT })]];

    // Regression: `hasAnyChange` used to list every patchable field except
    // `projectId`, so this exact call answered 400 even though the patch below it
    // applies the column — and the PHASE 2 relate request was unreachable from the
    // one path whose whole purpose is a changed project signal.
    const updated = await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { projectId: PROJECT },
    });

    expect(updated.projectId).toBe(PROJECT);
    const write = writeOf("update", MEMORY_TABLE)!;
    expect(write.set).toMatchObject({ projectId: PROJECT });
    expect(enqueueJob).toHaveBeenCalledWith("relate_memory", { brainId: BRAIN, memoryId: "m1" });
  });

  it("clears the project when the patch sets it to null", async () => {
    rows[MEMORY_TABLE] = [[settledRow({ projectId: PROJECT })], []];
    rows.__update = [[settledRow({ projectId: null })]];

    // `null` is a value, `undefined` is silence: unfiling a memory has to be a real
    // change too, or the fix above would only work in one direction.
    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { projectId: null },
    });

    expect(writeOf("update", MEMORY_TABLE)!.set).toMatchObject({ projectId: null });
    expect(enqueueJob).toHaveBeenCalledWith("relate_memory", { brainId: BRAIN, memoryId: "m1" });
  });

  it("still rejects a patch that carries no fields at all", async () => {
    rows[MEMORY_TABLE] = [[settledRow()], []];

    await expect(
      updateMemory({
        brainId: BRAIN,
        memoryId: "m1",
        principal: { userId: USER, agentId: null },
        data: {},
      })
    ).rejects.toThrow(BrainValidationError);
  });

  it("asks only for enrichment when the content itself changed", async () => {
    rows[MEMORY_TABLE] = [[settledRow()], []];
    rows.__update = [[settledRow({ content: "Now on Hetzner" })]];
    rows[TAG_TABLE] = [[{ id: "t1" }]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { content: "Now on Hetzner", tags: ["hetzner"] },
    });

    // The worker chains relate off a finished enrichment, so asking twice would only
    // burn the dedupe slot the second pass needs.
    expect(enqueueJob).toHaveBeenCalledWith("enrich_memory", { brainId: BRAIN, memoryId: "m1" });
    expect(enqueueJob).not.toHaveBeenCalledWith("relate_memory", expect.anything());
  });

  it("re-scores nothing when the edit touches no signal family", async () => {
    rows[MEMORY_TABLE] = [[settledRow()], []];
    rows.__update = [[settledRow({ importance: 0.7 })]];

    await updateMemory({
      brainId: BRAIN,
      memoryId: "m1",
      principal: { userId: USER, agentId: null },
      data: { importance: 0.7 },
    });

    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("drops the derived edges of a soft-deleted memory, in that brain only", async () => {
    rows.__update = [[{ id: "m1" }]];
    rows[`__delete:${DERIVED_TABLE}`] = [[{ id: "edge-1" }, { id: "edge-2" }]];

    expect(await deleteMemory({ brainId: BRAIN, memoryId: "m1" })).toBe(true);
    await settled();

    // Soft delete leaves the row in place, so the FK cascade never fires and these
    // rows would keep pointing at a memory no reader should surface.
    const cleanup = writeOf("delete", DERIVED_TABLE)!;
    expect(cleanup).toBeDefined();
    const predicate = describeSql(cleanup.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).not.toContain(OTHER_BRAIN);
    expect(predicate).toContain("source_memory_id");
    expect(predicate).toContain("target_memory_id");
  });

  it("leaves the explicit links of a soft-deleted memory alone", async () => {
    rows.__update = [[{ id: "m1" }]];

    await deleteMemory({ brainId: BRAIN, memoryId: "m1" });
    await settled();

    // A restore has to revive what the user asserted; only the computed edges are
    // cheap enough to throw away.
    expect(writeOf("delete", LINK_TABLE)).toBeUndefined();
  });

  it("touches no derived edge when the delete matched nothing", async () => {
    rows.__update = [[]];

    expect(await deleteMemory({ brainId: BRAIN, memoryId: "m1" })).toBe(false);
    await settled();

    expect(writeOf("delete", DERIVED_TABLE)).toBeUndefined();
  });

  it("re-enriches, and so re-scores, a memory restored to an older version", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], [memoryRow()], []];
    rows[VERSION_TABLE] = [
      [{ version: { id: "v1", versionNumber: 1, title: "Deploy notes", content: "Older body", summary: null, metadata: null } }],
    ];
    rows.__update = [[memoryRow({ content: "Older body", contentHash: "restored" })]];

    await restoreMemoryVersion({
      brainId: BRAIN,
      memoryId: "m1",
      versionId: "v1",
      principal: { userId: USER, agentId: null },
    });

    // PRINSIP 9: RESTORE → recompute. It arrives via updateMemory's hash check.
    expect(enqueueJob).toHaveBeenCalledWith("enrich_memory", { brainId: BRAIN, memoryId: "m1" });
  });
});

describe("searchMemories", () => {
  it("returns empty array for blank query", async () => {
    const results = await searchMemories({ brainId: BRAIN, query: "   " });

    expect(results).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("uses FTS match and rank over search_vector", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await searchMemories({ brainId: BRAIN, query: "deploy redis" });

    const read = readOf(MEMORY_TABLE)!;
    const predicate = describeSql(read.where);
    expect(predicate).toContain("search_vector");
    expect(describeSql(read.order)).toContain("search_vector");
  });

  it("filters by brain, non-deleted and non-archived by default", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await searchMemories({ brainId: BRAIN, query: "deploy" });

    const predicate = describeSql(readOf(MEMORY_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("deleted_at");
    expect(predicate).toContain("archived_at");
  });

  it("includes archived when requested", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await searchMemories({ brainId: BRAIN, query: "deploy", includeArchived: true });

    const predicate = describeSql(readOf(MEMORY_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).not.toContain("archived_at");
  });

  it("filters by type and project when provided", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await searchMemories({ brainId: BRAIN, query: "deploy", type: "decision", projectId: PROJECT });

    const predicate = describeSql(readOf(MEMORY_TABLE)!.where);
    expect(predicate).toContain("decision");
    expect(predicate).toContain(PROJECT);
  });
});

describe("getMemoryVersions", () => {
  it("joins through memories so the brain filter still applies", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()]];
    rows[VERSION_TABLE] = [[{ version: { id: "v1", versionNumber: 3 } }]];

    const versions = await getMemoryVersions({ brainId: BRAIN, memoryId: "m1" });

    expect(versions).toHaveLength(1);
    expect(versions[0].versionNumber).toBe(3);
    const read = readOf(VERSION_TABLE)!;
    expect(read.join).toBeDefined();
    const predicate = describeSql(read.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("m1");
    expect(predicate).toContain("deleted_at");
  });

  it("throws when the memory does not exist", async () => {
    rows[MEMORY_TABLE] = [[]];

    await expect(getMemoryVersions({ brainId: BRAIN, memoryId: "m1" })).rejects.toThrow(
      MemoryNotFoundError
    );
  });
});

describe("restoreMemoryVersion", () => {
  it("calls updateMemory with the version's title, content, summary and metadata", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], [memoryRow()], []];
    rows[VERSION_TABLE] = [
      [
        {
          version: {
            id: "v1",
            versionNumber: 3,
            title: "Old title",
            content: "Old content",
            summary: "Old summary",
            metadata: { key: "value" },
          },
        },
      ],
    ];
    rows.__update = [[memoryRow({ title: "Old title" })]];

    const restored = await restoreMemoryVersion({
      brainId: BRAIN,
      memoryId: "m1",
      versionId: "v1",
      principal: { userId: USER, agentId: null },
    });

    expect(restored.title).toBe("Old title");
    const versionInsert = writeOf("insert", VERSION_TABLE)!;
    expect(versionInsert).toBeDefined();
    const update = writeOf("update", MEMORY_TABLE)!;
    expect(update.set).toMatchObject({
      title: "Old title",
      content: "Old content",
      summary: "Old summary",
    });
  });

  it("uses the provided reason, or defaults to version number", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], [memoryRow()], []];
    rows[VERSION_TABLE] = [
      [{ version: { id: "v1", versionNumber: 3, title: "Old", content: "...", summary: null, metadata: null } }],
    ];
    rows.__update = [[memoryRow()]];

    await restoreMemoryVersion({
      brainId: BRAIN,
      memoryId: "m1",
      versionId: "v1",
      principal: { userId: USER, agentId: null },
      reason: "Undo accidental edit",
    });

    const versionInsert = writeOf("insert", VERSION_TABLE)!;
    const values = versionInsert.values as Record<string, unknown>;
    expect(values).toHaveProperty("changeReason", "Undo accidental edit");
  });
});

describe("listBrainTags", () => {
  it("reads all tags for the brain, ordered by name", async () => {
    rows[TAG_TABLE] = [[{ id: "t1", name: "deploy" }]];

    const tags = await listBrainTags(BRAIN);

    expect(tags).toHaveLength(1);
    const read = readOf(TAG_TABLE)!;
    expect(describeSql(read.where)).toContain(BRAIN);
    expect(describeSql(read.order)).toContain("name");
  });
});

describe("exportMemories", () => {
  it("reads all non-deleted memories with tags, oldest first", async () => {
    rows[MEMORY_TABLE] = [[memoryRow()], []];

    const exported = await exportMemories(BRAIN);

    expect(exported).toHaveLength(1);
    const read = readOf(MEMORY_TABLE)!;
    const predicate = describeSql(read.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("deleted_at");
    expect(describeSql(read.order)).toContain("created_at");
  });
});

