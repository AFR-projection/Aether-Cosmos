import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { BrainConflictError, BrainNotFoundError } from "./errors";

/**
 * Brains themselves — the tenant boundary every other Brain service is scoped by.
 *
 * Two things are load-bearing here. Every statement names the owner alongside the
 * brain id, so a brain id guessed off the wire resolves to nothing for anyone but its
 * owner (`requireBrainForUser` is what `lib/brain/access.ts` calls, and its 404 is
 * deliberately indistinguishable from "does not exist"). And the default brain is
 * created race-safely and can never be deleted, because it is where memories land
 * when no brain was named.
 *
 * The database is a recording fake: what is asserted is which predicates the service
 * insists on and which rows it refuses to write.
 */

type Rows = Record<string, unknown[][]>;
type WriteCall = {
  verb: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, unknown>;
  onConflictDoNothing?: boolean;
  where?: unknown;
};
type ReadCall = { table: string; columns: string[]; limit: number | null; where: unknown; order: unknown };

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

const reads: ReadCall[] = [];
const writes: WriteCall[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();

function selectChain(columns: string[]) {
  const call: ReadCall = { table: "", columns, limit: null, where: null, order: null };
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
        onConflictDoNothing() {
          call.onConflictDoNothing = true;
          return chain;
        },
        returning() {
          writes.push(call);
          return Promise.resolve(rows.__insert?.[0] ?? [{ id: "brain-new", ...call.values }]);
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
          return Promise.resolve(rows.__update?.[0] ?? [{ id: "brain-1", ...call.values }]);
        },
      };
      return chain;
    },
    // `deleteBrain` awaits the statement directly — no returning() — so the chain
    // itself has to be thenable or the service would await a builder forever.
    delete(table: unknown) {
      const call: WriteCall = { verb: "delete", table: getTableName(table as never) };
      const chain = {
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        then<T>(resolve: (value: unknown[]) => T) {
          writes.push(call);
          return Promise.resolve([]).then(resolve);
        },
      };
      return chain;
    },
  },
}));

const {
  getOrCreateDefaultBrain,
  getBrainForUser,
  requireBrainForUser,
  listBrains,
  createBrain,
  updateBrain,
  deleteBrain,
  getBrainStats,
  MAX_BRAINS_PER_USER,
} = await import("./brain-service");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const BRAIN = "22222222-2222-4222-8222-222222222222";

const BRAIN_TABLE = getTableName(schema.brains);
const MEMORY_TABLE = getTableName(schema.memories);
const ACCESS_TABLE = getTableName(schema.brainAccess);

const brainRow = (overrides: Record<string, unknown> = {}) => ({
  id: BRAIN,
  ownerUserId: USER,
  name: "Personal Brain",
  description: null,
  isDefault: true,
  status: "active",
  ...overrides,
});

const readOf = (table: string, index = 0): ReadCall | undefined =>
  reads.filter((call) => call.table === table)[index];

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  rows = {};
  cursors.clear();
});

describe("getOrCreateDefaultBrain", () => {
  it("hands back the existing default without writing anything", async () => {
    rows[BRAIN_TABLE] = [[brainRow()]];

    const brain = await getOrCreateDefaultBrain(USER);

    expect(brain.id).toBe(BRAIN);
    expect(writes).toEqual([]);
    const predicate = describeSql(readOf(BRAIN_TABLE)!.where);
    expect(predicate).toContain(USER);
    expect(predicate).toContain("is_default");
  });

  it("creates one on first use, owned by this user and marked default", async () => {
    rows[BRAIN_TABLE] = [[]];

    const brain = await getOrCreateDefaultBrain(USER);

    expect(writes).toHaveLength(1);
    expect(writes[0].values).toEqual({
      ownerUserId: USER,
      name: "Personal Brain",
      isDefault: true,
    });
    expect(brain.id).toBe("brain-new");
  });

  it("lets the partial unique index settle a race instead of failing the loser", async () => {
    // Two concurrent first requests both see "none". The loser's ON CONFLICT DO
    // NOTHING returns no row, so it must re-read and use the winner's brain.
    rows[BRAIN_TABLE] = [[], [brainRow({ name: "Winner" })]];
    rows.__insert = [[]];

    const brain = await getOrCreateDefaultBrain(USER);

    expect(brain.name).toBe("Winner");
    expect(writes[0].onConflictDoNothing).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("throws rather than returning undefined if the re-read finds nothing either", async () => {
    rows[BRAIN_TABLE] = [[], []];
    rows.__insert = [[]];

    await expect(getOrCreateDefaultBrain(USER)).rejects.toBeInstanceOf(BrainNotFoundError);
  });
});

describe("resolving a brain id off the wire", () => {
  it("reads by id AND owner, one row", async () => {
    rows[BRAIN_TABLE] = [[brainRow()]];

    const brain = await getBrainForUser(BRAIN, USER);

    expect(brain?.id).toBe(BRAIN);
    const read = readOf(BRAIN_TABLE)!;
    const predicate = describeSql(read.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(USER);
    expect(read.limit).toBe(1);
  });

  it("returns null for a brain owned by someone else", async () => {
    // The owner is in the predicate, so a foreign brain simply does not come back —
    // the caller never learns whether the id exists.
    rows[BRAIN_TABLE] = [[]];

    expect(await getBrainForUser(BRAIN, OTHER_USER)).toBeNull();
    expect(describeSql(readOf(BRAIN_TABLE)!.where)).toContain(OTHER_USER);
  });

  it("turns that miss into the same 404 access.ts relies on", async () => {
    rows[BRAIN_TABLE] = [[]];

    const error = await requireBrainForUser(BRAIN, USER).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainNotFoundError);
    expect((error as BrainNotFoundError).status).toBe(404);
    expect((error as BrainNotFoundError).code).toBe("BRAIN_NOT_FOUND");
    expect((error as Error).message).toBe("Brain not found");
  });
});

describe("listBrains", () => {
  it("lists this owner's brains, default first and then oldest to newest", async () => {
    rows[BRAIN_TABLE] = [[brainRow(), brainRow({ id: "b2", isDefault: false })]];

    const brains = await listBrains(USER);

    expect(brains).toHaveLength(2);
    const read = readOf(BRAIN_TABLE)!;
    expect(describeSql(read.where)).toContain(USER);
    const order = describeSql(read.order);
    expect(order).toContain("is_default");
    expect(order).toContain("created_at");
  });
});

describe("createBrain", () => {
  it("counts this owner's brains first, then writes a non-default brain", async () => {
    rows[BRAIN_TABLE] = [[{ total: 3 }]];

    await createBrain(USER, { name: "  Work  ", description: "  notes  " });

    expect(describeSql(readOf(BRAIN_TABLE)!.where)).toContain(USER);
    expect(writes[0].values).toEqual({
      ownerUserId: USER,
      name: "Work",
      description: "notes",
      // A second default would collide with brains_owner_default_unique; only
      // getOrCreateDefaultBrain is allowed to claim that flag.
      isDefault: false,
    });
  });

  it("refuses past the per-user cap, and writes nothing", async () => {
    rows[BRAIN_TABLE] = [[{ total: MAX_BRAINS_PER_USER }]];

    const error = await createBrain(USER, { name: "One more" }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainConflictError);
    expect((error as BrainConflictError).status).toBe(409);
    expect((error as Error).message).toBe(`Maximum ${MAX_BRAINS_PER_USER} brains allowed`);
    expect(writes).toEqual([]);
  });

  it("allows the last slot under the cap", async () => {
    rows[BRAIN_TABLE] = [[{ total: MAX_BRAINS_PER_USER - 1 }]];

    await createBrain(USER, { name: "Work" });
    expect(writes).toHaveLength(1);
  });

  it("treats a count that came back empty as zero rather than crashing", async () => {
    rows[BRAIN_TABLE] = [[]];

    await createBrain(USER, { name: "Work" });
    expect(writes).toHaveLength(1);
  });

  it("stores a blank description as null", async () => {
    rows[BRAIN_TABLE] = [[{ total: 0 }]];

    await createBrain(USER, { name: "Work", description: "   " });
    expect(writes[0].values!.description).toBeNull();
  });
});

describe("updateBrain", () => {
  it("checks ownership before it patches, and patches only what was sent", async () => {
    rows[BRAIN_TABLE] = [[brainRow()]];
    rows.__update = [[brainRow({ name: "Work" })]];

    const updated = await updateBrain(BRAIN, USER, { name: "  Work  " });

    expect(updated.name).toBe("Work");
    expect(Object.keys(writes[0].values!).sort()).toEqual(["name", "updatedAt"]);
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(USER);
  });

  it("refuses to patch a brain this user does not own, and writes nothing", async () => {
    rows[BRAIN_TABLE] = [[]];

    await expect(updateBrain(BRAIN, OTHER_USER, { name: "Mine now" })).rejects.toBeInstanceOf(
      BrainNotFoundError
    );
    expect(writes).toEqual([]);
  });

  it("clears a description on explicit null and on whitespace alike", async () => {
    rows[BRAIN_TABLE] = [[brainRow()], [brainRow()]];

    await updateBrain(BRAIN, USER, { description: null });
    await updateBrain(BRAIN, USER, { description: "   " });

    expect(writes[0].values!.description).toBeNull();
    expect(writes[1].values!.description).toBeNull();
  });

  it("carries a status change through, so archiving a brain is one statement", async () => {
    rows[BRAIN_TABLE] = [[brainRow()]];

    await updateBrain(BRAIN, USER, { status: "archived" });
    expect(writes[0].values!.status).toBe("archived");
  });

  it("reports a brain that vanished between the check and the write as not found", async () => {
    rows[BRAIN_TABLE] = [[brainRow()]];
    rows.__update = [[]];

    await expect(updateBrain(BRAIN, USER, { name: "Work" })).rejects.toBeInstanceOf(
      BrainNotFoundError
    );
  });
});

describe("deleteBrain", () => {
  it("deletes a non-default brain by id and owner", async () => {
    rows[BRAIN_TABLE] = [[brainRow({ isDefault: false })]];

    await deleteBrain(BRAIN, USER);

    expect(writes).toHaveLength(1);
    expect(writes[0].verb).toBe("delete");
    const predicate = describeSql(writes[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(USER);
  });

  it("protects the default brain: there has to be somewhere for memories to land", async () => {
    // This is a hard delete that cascades every memory, version, tag, edge and audit
    // row under the brain, so the one brain the app writes to by default is not
    // deletable at all — not even by its owner.
    rows[BRAIN_TABLE] = [[brainRow({ isDefault: true })]];

    const error = await deleteBrain(BRAIN, USER).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainConflictError);
    expect((error as Error).message).toBe("The default brain cannot be deleted");
    expect(writes).toEqual([]);
  });

  it("refuses a brain owned by someone else before deleting anything", async () => {
    rows[BRAIN_TABLE] = [[]];

    await expect(deleteBrain(BRAIN, OTHER_USER)).rejects.toBeInstanceOf(BrainNotFoundError);
    expect(writes).toEqual([]);
  });
});

describe("getBrainStats", () => {
  it("reports live, archived and agent counts for one brain", async () => {
    // The second query counts everything not deleted, so archived is the difference —
    // one fewer index scan than a third count.
    rows[MEMORY_TABLE] = [[{ total: 7 }], [{ total: 10 }]];
    rows[ACCESS_TABLE] = [[{ total: 2 }]];

    expect(await getBrainStats(BRAIN)).toEqual({
      memoryCount: 7,
      archivedCount: 3,
      agentCount: 2,
    });
  });

  it("never reports a negative archived count", async () => {
    rows[MEMORY_TABLE] = [[{ total: 5 }], [{ total: 3 }]];

    const stats = await getBrainStats(BRAIN);
    expect(stats.archivedCount).toBe(0);
  });

  it("reads zero for every count that came back empty", async () => {
    expect(await getBrainStats(BRAIN)).toEqual({
      memoryCount: 0,
      archivedCount: 0,
      agentCount: 0,
    });
  });

  it("excludes soft-deleted memories from both counts, and counts only agent grants", async () => {
    await getBrainStats(BRAIN);

    const live = describeSql(readOf(MEMORY_TABLE, 0)!.where);
    expect(live).toContain(BRAIN);
    expect(live).toContain("deleted_at");
    expect(live).toContain("archived_at");

    const notDeleted = describeSql(readOf(MEMORY_TABLE, 1)!.where);
    expect(notDeleted).toContain("deleted_at");
    expect(notDeleted).not.toContain("archived_at");

    const grants = describeSql(readOf(ACCESS_TABLE, 0)!.where);
    expect(grants).toContain(BRAIN);
    expect(grants).toContain("agent");
  });
});

describe("the owner is named in every statement about a brain", () => {
  it("never touches the brains table without the owner in it", async () => {
    // Asserted as a sweep: a helper added later that reads or writes `brains` by id
    // alone fails here, without anyone having to remember to test it.
    rows[BRAIN_TABLE] = [
      [brainRow()],
      [brainRow()],
      [{ total: 0 }],
      [brainRow()],
      [brainRow({ isDefault: false })],
      [brainRow()],
    ];

    await getOrCreateDefaultBrain(USER);
    await getBrainForUser(BRAIN, USER);
    await createBrain(USER, { name: "Work" });
    await updateBrain(BRAIN, USER, { name: "Work" });
    await deleteBrain(BRAIN, USER);
    await listBrains(USER);

    const brainReads = reads.filter((call) => call.table === BRAIN_TABLE);
    expect(brainReads.length).toBe(6);
    for (const read of brainReads) {
      const predicate = describeSql(read.where);
      expect(predicate).toContain(USER);
      expect(predicate).not.toContain(OTHER_USER);
    }
    for (const write of writes) {
      const evidence = `${describeSql(write.where)} ${JSON.stringify(write.values ?? {})}`;
      expect(evidence, `${write.verb} into ${write.table}`).toContain(USER);
      expect(evidence, `${write.verb} into ${write.table}`).not.toContain(OTHER_USER);
    }
    expect(writes.length).toBe(3);
  });
});

