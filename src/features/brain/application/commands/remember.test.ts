import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/shared/infrastructure/db/schema";

/**
 * brain_remember — the write side of the agent memory protocol.
 *
 * The property under test is the one that keeps a brain from becoming a garbage
 * dump: writing the same thing twice must not produce twins. An exact title match
 * within the same type is routed to `updateMemory`, which snapshots a version, so
 * the second write refines the first instead of duplicating it. Near neighbours are
 * a different matter — deciding two differently-titled memories are the same thing
 * needs judgement this layer does not have — so they are *reported* and never block
 * the write.
 *
 * `memory-service` is stubbed here on purpose: what is asserted is the routing
 * decision and the payload handed over, not the write itself (that is covered by
 * memory-service's own suite).
 */

type Rows = Record<string, unknown[][]>;
type ReadCall = { table: string; limit: number | null; where: unknown; order: unknown };

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
const MEMORY_TABLE = getTableName(schema.memories);

const reads: ReadCall[] = [];
let rows: Rows = {};
let cursor = 0;

function selectChain() {
  const call: ReadCall = { table: "", limit: null, where: null, order: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
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
      const index = cursor;
      cursor += 1;
      return Promise.resolve(rows[MEMORY_TABLE]?.[index] ?? []).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/shared/infrastructure/db", () => ({ db: { select: () => selectChain() } }));

const createMemory = vi.fn();
const updateMemory = vi.fn();
vi.mock("./memory-service", () => ({
  createMemory: (...args: unknown[]) => createMemory(...args),
  updateMemory: (...args: unknown[]) => updateMemory(...args),
}));

const { rememberMemory } = await import("./remember");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const EXISTING = "22222222-2222-4222-8222-222222222222";

const PRINCIPAL = { userId: "user-1", agentId: null };

beforeEach(() => {
  reads.length = 0;
  rows = {};
  cursor = 0;
  createMemory.mockReset();
  updateMemory.mockReset();
  createMemory.mockResolvedValue({ id: "memory-new", title: "Deploy notes" });
  updateMemory.mockResolvedValue({ id: EXISTING, title: "Deploy notes" });
});

describe("a first write", () => {
  it("creates the memory, with the title trimmed and the default type", async () => {
    rows[MEMORY_TABLE] = [[], []];

    const outcome = await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "  Deploy notes  ", content: "Run update.sh" },
    });

    expect(outcome.mode).toBe("created");
    expect(updateMemory).not.toHaveBeenCalled();
    expect(createMemory).toHaveBeenCalledWith({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "Run update.sh", type: "fact" },
    });
  });

  it("forwards everything the caller supplied, untouched", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: {
        title: "Postgres tuning",
        content: "shared_buffers",
        type: "decision",
        summary: "db",
        importance: 8,
        confidence: 0.7,
        sourceType: "agent",
        sourceId: "run-1",
        tags: ["DB", "db", " "],
        metadata: { ticket: "SB-1" },
      },
    });

    expect(createMemory.mock.calls[0][0].data).toMatchObject({
      type: "decision",
      importance: 8,
      confidence: 0.7,
      sourceType: "agent",
      sourceId: "run-1",
      // Untouched on the create path — memory-service normalizes tags itself.
      tags: ["DB", "db", " "],
      metadata: { ticket: "SB-1" },
    });
  });
});

describe("writing the same title again", () => {
  it("refines the existing memory instead of adding a twin", async () => {
    rows[MEMORY_TABLE] = [[{ id: EXISTING }], []];

    const outcome = await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "Run update.sh --force" },
    });

    expect(outcome.mode).toBe("updated");
    expect(createMemory).not.toHaveBeenCalled();
    expect(updateMemory).toHaveBeenCalledWith({
      brainId: BRAIN,
      memoryId: EXISTING,
      principal: PRINCIPAL,
      data: {
        content: "Run update.sh --force",
        summary: undefined,
        importance: undefined,
        confidence: undefined,
        metadata: undefined,
        tags: undefined,
      },
      changeReason: "Updated by brain_remember (existing memory with same title)",
    });
  });

  it("does not send the fields the caller left out, so a re-write cannot blank them", async () => {
    // `summary: null` here means "not supplied", not "clear it" — an agent repeating a
    // title with a shorter payload must not erase the summary a human wrote.
    rows[MEMORY_TABLE] = [[{ id: EXISTING }], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x", summary: null, metadata: null },
    });

    const patch = updateMemory.mock.calls[0][0].data;
    expect(patch.summary).toBeUndefined();
    expect(patch.metadata).toBeUndefined();
  });

  it("normalizes tags on the way through", async () => {
    rows[MEMORY_TABLE] = [[{ id: EXISTING }], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x", tags: ["  Deploy ", "deploy", ""] },
    });

    expect(updateMemory.mock.calls[0][0].data.tags).toEqual(["deploy"]);
  });

  it("keeps a caller-supplied change reason for the audit trail", async () => {
    rows[MEMORY_TABLE] = [[{ id: EXISTING }], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
      changeReason: "Corrected after rollback",
    });

    expect(updateMemory.mock.calls[0][0].changeReason).toBe("Corrected after rollback");
  });
});

describe("the exact-title lookup", () => {
  it("matches case- and whitespace-insensitively, within one brain and one type", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy   Notes", content: "x", type: "decision" },
    });

    const predicate = describeSql(reads[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("decision");
    expect(predicate).toContain("deleted_at");
    // lower(regexp_replace(...)) on both sides: "Deploy   Notes" and "deploy notes"
    // are the same title.
    expect(predicate).toContain("regexp_replace");
    expect(predicate).toContain("[[:space:]]+");
  });

  it("takes the most recently touched match, one row only", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await rememberMemory({ brainId: BRAIN, principal: PRINCIPAL, data: { title: "T", content: "x" } });

    expect(reads[0].limit).toBe(1);
    expect(describeSql(reads[0].order)).toContain("updated_at");
  });

  it("ignores a soft-deleted twin, so re-remembering a deleted title creates again", async () => {
    rows[MEMORY_TABLE] = [[], []];

    const outcome = await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
    });

    expect(describeSql(reads[0].where)).toContain("deleted_at");
    expect(outcome.mode).toBe("created");
  });
});

describe("near duplicates are reported, never enforced", () => {
  it("returns the neighbours and still creates the memory", async () => {
    rows[MEMORY_TABLE] = [
      [],
      [
        { id: "m1", title: "Deployment notes", type: "fact" },
        { id: "m2", title: "Deploy runbook", type: "process" },
      ],
    ];

    const outcome = await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
    });

    expect(outcome.mode).toBe("created");
    expect(createMemory).toHaveBeenCalledOnce();
    expect(outcome.possibleDuplicates).toEqual([
      { id: "m1", title: "Deployment notes", type: "fact" },
      { id: "m2", title: "Deploy runbook", type: "process" },
    ]);
  });

  it("never lists the memory it is about to update", async () => {
    rows[MEMORY_TABLE] = [
      [{ id: EXISTING }],
      [
        { id: EXISTING, title: "Deploy notes", type: "fact" },
        { id: "m1", title: "Deployment notes", type: "fact" },
      ],
    ];

    const outcome = await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
    });

    expect(outcome.mode).toBe("updated");
    expect(outcome.possibleDuplicates.map((row) => row.id)).toEqual(["m1"]);
  });

  it("caps the report at three, fetching one extra so the exclusion cannot shorten it", async () => {
    rows[MEMORY_TABLE] = [
      [{ id: EXISTING }],
      [
        { id: EXISTING, title: "Deploy notes", type: "fact" },
        { id: "m1", title: "a", type: "fact" },
        { id: "m2", title: "b", type: "fact" },
        { id: "m3", title: "c", type: "fact" },
      ],
    ];

    const outcome = await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
    });

    expect(reads[1].limit).toBe(4);
    expect(outcome.possibleDuplicates.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("ranks live memories of this brain by full-text relevance", async () => {
    rows[MEMORY_TABLE] = [[], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
    });

    const predicate = describeSql(reads[1].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("deleted_at");
    expect(predicate).toContain("search_vector");
    // The title is a bound parameter inside to_tsquery, never concatenated in.
    expect(predicate).toContain("to_tsquery");
    expect(predicate).toContain("Deploy notes");
    expect(describeSql(reads[1].order)).toContain("ts_rank");
  });

  it("looks across types, unlike the exact match", async () => {
    // A decision titled almost like an existing fact is worth surfacing.
    rows[MEMORY_TABLE] = [[], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x", type: "decision" },
    });

    expect(describeSql(reads[1].where)).not.toContain("decision");
  });
});

describe("the brain id is folded into both reads", () => {
  it("never searches outside the brain it was given", async () => {
    rows[MEMORY_TABLE] = [[{ id: EXISTING }], []];

    await rememberMemory({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: { title: "Deploy notes", content: "x" },
    });

    expect(reads).toHaveLength(2);
    for (const read of reads) {
      const predicate = describeSql(read.where);
      expect(predicate).toContain(BRAIN);
      expect(predicate).not.toContain(OTHER_BRAIN);
    }
    expect(updateMemory.mock.calls[0][0].brainId).toBe(BRAIN);
  });
});

