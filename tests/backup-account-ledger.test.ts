/**
 * `drizzleRestoreLedger` — stage 2's arithmetic and stage 5's bookkeeping, without a database.
 *
 * Tests #20–#22 and #35 in §16 are integration tests for good reasons: a race between two
 * reservations is a statement about row locks, and only PostgreSQL can settle it. What is left
 * over is everything those tests cannot isolate — *which* statements stage 2 issues, in *what
 * order*, with *which numbers in them* — and that is what a scripted fake proves better than a
 * real database does, because it can fail an assertion about the third statement rather than
 * about the balance twenty statements later.
 *
 * So the fake here is not a shortcut around the integration tests. It pins the four decisions
 * that would otherwise only be visible as a wrong number much later:
 *
 *   - the quota sum counts `users.reserved_bytes` as well as `restore_reservations.bytes`;
 *   - abandoned debris is cleared *before* the busy question and *before* the quota question;
 *   - `settle` recomputes `used_bytes` for Files and not for Brain;
 *   - `abandon` releases the reservation before it marks the batch, and never throws.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.6, §8, §9.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Statement {
  kind: "select" | "insert" | "update" | "delete";
  table: string;
  locked: boolean;
  returning: boolean;
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  statements: [] as {
    kind: "select" | "insert" | "update" | "delete";
    table: string;
    locked: boolean;
    returning: boolean;
    set?: Record<string, unknown>;
    values?: Record<string, unknown>;
  }[],
  account: null as { usedBytes: number; reservedBytes: number; quotaBytes: number } | null,
  staging: [] as { id: string }[],
  reservedTotal: null as string | null,
  staleIds: [] as string[],
  batchId: null as string | null,
  settleDomain: null as string | null,
  recalculated: [] as string[],
  patterns: [] as string[],
}));

vi.mock("@/shared/infrastructure/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function nameOf(table: unknown): string {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  /** What the scripted database answers, chosen by the statement rather than by call order. */
  function respond(statement: Statement): Record<string, unknown>[] {
    if (statement.kind === "select") {
      if (statement.table === "users") return state.account === null ? [] : [state.account];
      if (statement.table === "restore_batches") return state.staging;
      if (statement.table === "restore_reservations") return [{ total: state.reservedTotal }];
    }
    if (statement.kind === "update" && statement.table === "restore_batches") {
      if (statement.set?.state === "committed") {
        return state.settleDomain === null ? [] : [{ domain: state.settleDomain }];
      }
      return state.staleIds.map((id) => ({ id }));
    }
    if (statement.kind === "insert" && statement.table === "restore_batches") {
      return state.batchId === null ? [] : [{ id: state.batchId }];
    }
    return [];
  }

  interface Chain {
    from(table: unknown): Chain;
    where(...args: unknown[]): Chain;
    limit(rows: number): Chain;
    for(strength: string): Chain;
    set(payload: Record<string, unknown>): Chain;
    values(payload: Record<string, unknown>): Chain;
    returning(projection?: Record<string, unknown>): Chain;
    then<A, B = never>(
      onFulfilled: (rows: Record<string, unknown>[]) => A | PromiseLike<A>,
      onRejected?: (reason: unknown) => B | PromiseLike<B>
    ): Promise<A | B>;
  }

  function chain(statement: Statement): Chain {
    const api: Chain = {
      from(table) {
        statement.table = nameOf(table);
        return api;
      },
      where: () => api,
      limit: () => api,
      for(strength) {
        // Only `FOR UPDATE` matters to this feature; anything else is worth failing on.
        if (strength !== "update") throw new Error(`unexpected lock strength ${strength}`);
        statement.locked = true;
        return api;
      },
      set(payload) {
        statement.set = payload;
        return api;
      },
      values(payload) {
        statement.values = payload;
        return api;
      },
      returning() {
        statement.returning = true;
        return api;
      },
      then(onFulfilled, onRejected) {
        // Recorded on await rather than on construction, so the list is execution order.
        return Promise.resolve()
          .then(() => {
            state.statements.push(statement);
            return respond(statement);
          })
          .then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  function open(kind: Statement["kind"], table?: unknown): Chain {
    return chain({
      kind,
      table: table === undefined ? "" : nameOf(table),
      locked: false,
      returning: false,
    });
  }

  interface FakeDb {
    select(projection?: Record<string, unknown>): Chain;
    insert(table: unknown): Chain;
    update(table: unknown): Chain;
    delete(table: unknown): Chain;
    transaction<T>(body: (tx: FakeDb) => Promise<T>): Promise<T>;
  }

  const fakeDb: FakeDb = {
    select: () => open("select"),
    insert: (table: unknown) => open("insert", table),
    update: (table: unknown) => open("update", table),
    delete: (table: unknown) => open("delete", table),
    transaction: (body) => body(fakeDb),
  };

  return {
    db: fakeDb,
    recalculateUsedBytes: async (userId: string) => {
      state.recalculated.push(userId);
    },
  };
});

vi.mock("@/shared/infrastructure/cache/redis", () => ({
  cacheDelPattern: async (pattern: string) => {
    state.patterns.push(pattern);
  },
}));

import type { RestoreReservationInput } from "@backup/account/application/import";
import { AccountBackupBusyError, AfrQuotaError } from "@backup/account/domain/errors";
import {
  drizzleRestoreLedger,
  RESTORE_ABANDON_AFTER_MS,
} from "@backup/account/infrastructure/ledger";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

/** One reservation input, with only the fields a test cares about worth overriding. */
function reservation(overrides: Partial<RestoreReservationInput> = {}): RestoreReservationInput {
  return {
    userId: USER,
    domain: "files",
    mode: "merge",
    backupId: "22222222-2222-4222-8222-222222222222",
    formatVersion: 1,
    keyId: "k1",
    expectedRows: 40,
    expectedBytes: 1_000,
    ...overrides,
  };
}

function ledger() {
  return drizzleRestoreLedger({ userId: USER, now: () => NOW });
}

/** Let the fire-and-forget cache invalidations land before asserting on them. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The shape assertions read, so a failure names the statement rather than an index. */
function trace(): string[] {
  return state.statements.map((statement) => {
    const lock = statement.locked ? " for-update" : "";
    const target =
      statement.kind === "update" ? `:${String(statement.set?.state ?? "?")}` : "";
    return `${statement.kind} ${statement.table}${target}${lock}`;
  });
}

beforeEach(() => {
  state.statements = [];
  state.account = { usedBytes: 0, reservedBytes: 0, quotaBytes: 10_000 };
  state.staging = [];
  state.reservedTotal = null;
  state.staleIds = [];
  state.batchId = "33333333-3333-4333-8333-333333333333";
  state.settleDomain = "files";
  state.recalculated = [];
  state.patterns = [];
});

describe("reserve — stage 2", () => {
  it("locks the quota row first, then clears debris, then asks its two questions", async () => {
    const id = await ledger().reserve(reservation());

    expect(id).toBe(state.batchId);
    expect(trace()).toEqual([
      "select users for-update",
      "update restore_batches:aborted",
      "select restore_batches",
      "select restore_reservations",
      "insert restore_batches",
      "insert restore_reservations",
    ]);
  });

  it("writes the batch as staging, with the summary's own claims", async () => {
    await ledger().reserve(reservation({ expectedBytes: 4_096 }));

    const batch = state.statements.find(
      (statement) => statement.kind === "insert" && statement.table === "restore_batches"
    );
    expect(batch?.values).toMatchObject({
      userId: USER,
      domain: "files",
      mode: "merge",
      state: "staging",
      keyId: "k1",
      expectedRows: 40,
      expectedBytes: 4_096,
    });

    const held = state.statements.find(
      (statement) => statement.kind === "insert" && statement.table === "restore_reservations"
    );
    expect(held?.values).toEqual({
      restoreBatchId: state.batchId,
      userId: USER,
      bytes: 4_096,
    });
  });

  it("counts bytes held by in-flight uploads, not only by other restores", async () => {
    // 6 000 stored + 1 000 held by an upload + 2 000 held by another restore = 9 000 of 10 000.
    // Forget the upload's 1 000 and this reservation fits with room to spare.
    state.account = { usedBytes: 6_000, reservedBytes: 1_000, quotaBytes: 10_000 };
    state.reservedTotal = "2000";

    await expect(ledger().reserve(reservation({ expectedBytes: 1_001 }))).rejects.toMatchObject({
      code: "AFRBAK_QUOTA",
      status: 409,
      reason: 9,
      needBytes: 1_001,
      availableBytes: 1_000,
    });
    await expect(ledger().reserve(reservation({ expectedBytes: 1_000 }))).resolves.toBe(
      state.batchId
    );
  });

  it("refuses with #9 and writes nothing", async () => {
    state.account = { usedBytes: 9_999, reservedBytes: 0, quotaBytes: 10_000 };

    await expect(ledger().reserve(reservation())).rejects.toBeInstanceOf(AfrQuotaError);
    expect(trace()).toEqual([
      "select users for-update",
      "update restore_batches:aborted",
      "select restore_batches",
      "select restore_reservations",
    ]);
  });

  it("reports zero available rather than a negative number", async () => {
    // A quota lowered below what the account already holds is a legitimate state, and this
    // number is shown to the user.
    state.account = { usedBytes: 12_000, reservedBytes: 0, quotaBytes: 10_000 };

    await expect(ledger().reserve(reservation({ expectedBytes: 1 }))).rejects.toMatchObject({
      needBytes: 1,
      availableBytes: 0,
    });
  });

  it("refuses a second live restore before it looks at the quota at all", async () => {
    state.staging = [{ id: "44444444-4444-4444-8444-444444444444" }];

    await expect(ledger().reserve(reservation())).rejects.toBeInstanceOf(AccountBackupBusyError);
    expect(trace()).toEqual([
      "select users for-update",
      "update restore_batches:aborted",
      "select restore_batches",
    ]);
  });

  it("releases an abandoned batch's reservation before either question is asked", async () => {
    state.staleIds = ["55555555-5555-4555-8555-555555555555"];

    await ledger().reserve(reservation());

    expect(trace()).toEqual([
      "select users for-update",
      "update restore_batches:aborted",
      "delete restore_reservations",
      "select restore_batches",
      "select restore_reservations",
      "insert restore_batches",
      "insert restore_reservations",
    ]);
    const aborted = state.statements[1];
    expect(aborted?.set).toMatchObject({ state: "aborted" });
    expect(typeof aborted?.set?.error).toBe("string");
  });

  it("skips the release when there was no debris", async () => {
    await ledger().reserve(reservation());
    expect(trace()).not.toContain("delete restore_reservations");
  });

  it("refuses to reserve for another account, before touching the database", async () => {
    const other = { ...reservation(), userId: "66666666-6666-4666-8666-666666666666" };

    await expect(ledger().reserve(other)).rejects.toThrow(/different account/);
    expect(state.statements).toEqual([]);
  });

  it("refuses a batch it could not create rather than returning an unusable id", async () => {
    state.batchId = null;
    await expect(ledger().reserve(reservation())).rejects.toThrow(/could not create a batch row/);
  });
});

describe("settle — stage 5's bookkeeping", () => {
  it("commits the batch, drops the reservation, and recomputes used_bytes for Files", async () => {
    await ledger().settle("77777777-7777-4777-8777-777777777777", { rows: 12, bytes: 900 });
    await flush();

    expect(trace()).toEqual([
      "update restore_batches:committed",
      "delete restore_reservations",
    ]);
    expect(state.statements[0]?.set).toMatchObject({
      state: "committed",
      writtenRows: 12,
      writtenBytes: 900,
    });
    expect(state.recalculated).toEqual([USER]);
    expect(state.patterns).toEqual([`files:${USER}:*`, `search:${USER}:*`]);
  });

  it("leaves the storage counters alone for Brain", async () => {
    state.settleDomain = "brain";

    await ledger().settle("77777777-7777-4777-8777-777777777777", { rows: 300, bytes: 4_000 });
    await flush();

    expect(trace()).toEqual([
      "update restore_batches:committed",
      "delete restore_reservations",
    ]);
    expect(state.recalculated).toEqual([]);
    expect(state.patterns).toEqual([]);
  });

  it("says the data is safe when only the bookkeeping row is missing", async () => {
    state.settleDomain = null;

    await expect(
      ledger().settle("77777777-7777-4777-8777-777777777777", { rows: 1, bytes: 1 })
    ).rejects.toThrow(/committed, but its ledger row is not this account's/);
  });
});

describe("abandon — the batch that will never commit", () => {
  it("releases the reservation before it marks the batch", async () => {
    await ledger().abandon("88888888-8888-4888-8888-888888888888", "refusal 7: bad chunk");

    expect(trace()).toEqual([
      "delete restore_reservations",
      "update restore_batches:aborted",
    ]);
    expect(state.statements[1]?.set).toMatchObject({
      state: "aborted",
      error: "refusal 7: bad chunk",
    });
  });

  it("clips a reason down to what the column keeps", async () => {
    await ledger().abandon("88888888-8888-4888-8888-888888888888", "x".repeat(400));

    const error = state.statements[1]?.set?.error;
    expect(typeof error).toBe("string");
    expect(String(error)).toHaveLength(200);
    expect(String(error).endsWith("…")).toBe(true);
  });

  it("stays silent when there is nothing to release", async () => {
    // The failure that got here is the one the caller must see; this adds none of its own.
    await expect(
      ledger().abandon("88888888-8888-4888-8888-888888888888", "gone")
    ).resolves.toBeUndefined();
  });
});

describe("the abandonment window", () => {
  it("is the sweeper's, so the two cannot drift apart", () => {
    // §7.6's 24 hours. The sweeper imports this constant rather than restating the number,
    // because a shorter window there would abort restores this file believes are running.
    expect(RESTORE_ABANDON_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});
