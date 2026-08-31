import { describe, it, expect, beforeEach, vi } from "vitest";
import { is, SQL } from "drizzle-orm";

/**
 * The access budget on a share link.
 *
 * The two defects this file guards against are both "the check and the spend were
 * separable": the count was read, compared in JS, and written back as
 * `accessCount + 1`, so a concurrent burst all saw the same starting value and all
 * passed. `claimShareAccess` has to be ONE statement — which means the increment
 * must be a SQL expression and the limit must be part of the WHERE, not an `if`.
 *
 * The mock therefore behaves like Postgres does: the predicate is evaluated and
 * the row is updated inside a single `returning()` call, and nothing else can
 * interleave. If the production code ever goes back to deciding in JS, the burst
 * test overspends.
 */

type Row = { id: string; accessCount: number; maxAccessCount: number | null };

const store = vi.hoisted(() => ({
  rows: [] as { id: string; accessCount: number; maxAccessCount: number | null }[],
  /** Every UPDATE issued, with the payload it carried. */
  statements: [] as Record<string, unknown>[],
  /** Set when a claim was decided by the WHERE clause rather than by JS. */
  filteredOut: 0,
}));

vi.mock("@/shared/infrastructure/db", () => {
  return {
    db: {
      update: () => {
        let payload: Record<string, unknown> = {};
        // `whereRowId` is filled from the id the caller passed; the limit part of
        // the predicate is modelled below, since a mock cannot execute SQL.
        const api = {
          set(values: Record<string, unknown>) {
            payload = values;
            return api;
          },
          where() {
            return api;
          },
          async returning() {
            store.statements.push(payload);

            // One statement: find the row, test the budget, and write — with no
            // await in between, exactly as Postgres does it.
            const row = store.rows[0];
            if (!row) return [];

            const claimable = row.maxAccessCount === null || row.accessCount < row.maxAccessCount;
            if (!claimable) {
              store.filteredOut++;
              return [];
            }

            // The increment must have arrived as SQL. A plain number here would
            // mean the caller computed it from a value it read earlier.
            if (typeof payload.accessCount === "number") {
              throw new Error("accessCount was computed in JS, not in SQL");
            }

            row.accessCount += 1;
            return [{ ...row, lastAccessedAt: payload.lastAccessedAt ?? new Date() }];
          },
        };
        return api;
      },
    },
  };
});

const {
  claimShareAccess,
  shareBudgetExhausted,
  shareExpired,
  shareResumeIsFree,
  SHARE_RESUME_WINDOW_MS,
} = await import("./access");

function seed(over: Partial<Row> = {}) {
  store.rows = [{ id: "share-1", accessCount: 0, maxAccessCount: 1, ...over }];
}

beforeEach(() => {
  store.rows = [];
  store.statements = [];
  store.filteredOut = 0;
});

describe("shareBudgetExhausted", () => {
  it("is false while units remain", () => {
    expect(shareBudgetExhausted({ accessCount: 0, maxAccessCount: 1 })).toBe(false);
    expect(shareBudgetExhausted({ accessCount: 4, maxAccessCount: 5 })).toBe(false);
  });

  it("is true at and past the ceiling", () => {
    expect(shareBudgetExhausted({ accessCount: 1, maxAccessCount: 1 })).toBe(true);
    // Past it too — a link that somehow overspent stays closed.
    expect(shareBudgetExhausted({ accessCount: 9, maxAccessCount: 5 })).toBe(true);
  });

  it("treats a null ceiling as unlimited", () => {
    expect(shareBudgetExhausted({ accessCount: 10_000, maxAccessCount: null })).toBe(false);
  });
});

describe("shareExpired", () => {
  it("is false with no expiry", () => {
    expect(shareExpired({ expiresAt: null })).toBe(false);
  });

  it("is false for a future expiry and true for a past one", () => {
    expect(shareExpired({ expiresAt: new Date(Date.now() + 60_000) })).toBe(false);
    expect(shareExpired({ expiresAt: new Date(Date.now() - 1) })).toBe(true);
  });
});

describe("shareResumeIsFree", () => {
  /**
   * The content route exempts a `Range` request that starts past byte 0 so a
   * resumed download is not charged twice. Unconditionally, that exemption was the
   * whole bypass: a caller who only ever sent `Range: bytes=1-` never paid.
   * A resume is free only when there is a paid access to resume.
   */
  const now = new Date("2026-08-26T12:00:00.000Z");

  it("is false when nothing has been paid for", () => {
    expect(shareResumeIsFree({ accessCount: 0, lastAccessedAt: null }, now)).toBe(false);
    expect(shareResumeIsFree({ accessCount: 0, lastAccessedAt: now }, now)).toBe(false);
  });

  it("is false when a unit was spent but the timestamp is missing", () => {
    expect(shareResumeIsFree({ accessCount: 3, lastAccessedAt: null }, now)).toBe(false);
  });

  it("is true just after a paid access", () => {
    const justNow = new Date(now.getTime() - 1_000);
    expect(shareResumeIsFree({ accessCount: 1, lastAccessedAt: justNow }, now)).toBe(true);
  });

  it("is true at the edge of the window and false past it", () => {
    const edge = new Date(now.getTime() - SHARE_RESUME_WINDOW_MS);
    const past = new Date(now.getTime() - SHARE_RESUME_WINDOW_MS - 1);
    expect(shareResumeIsFree({ accessCount: 1, lastAccessedAt: edge }, now)).toBe(true);
    expect(shareResumeIsFree({ accessCount: 1, lastAccessedAt: past }, now)).toBe(false);
  });

  it("does not go free on a clock skew that puts the access in the future", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(shareResumeIsFree({ accessCount: 1, lastAccessedAt: future }, now)).toBe(true);
  });
});

describe("claimShareAccess", () => {
  it("spends a unit and returns the updated row", async () => {
    seed({ maxAccessCount: 3 });
    const claimed = await claimShareAccess("share-1");
    expect(claimed?.accessCount).toBe(1);
    expect(store.rows[0].accessCount).toBe(1);
    expect(store.statements).toHaveLength(1);
  });

  it("returns null once the budget is gone", async () => {
    seed({ accessCount: 1, maxAccessCount: 1 });
    expect(await claimShareAccess("share-1")).toBeNull();
    // Refused by the predicate, not by a JS branch before the statement.
    expect(store.statements).toHaveLength(1);
    expect(store.filteredOut).toBe(1);
    expect(store.rows[0].accessCount).toBe(1);
  });

  it("stamps lastAccessedAt as part of the same statement", async () => {
    seed({ maxAccessCount: null });
    const before = Date.now();
    const claimed = await claimShareAccess("share-1");
    expect(claimed?.lastAccessedAt).toBeInstanceOf(Date);
    expect((claimed!.lastAccessedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("increments with a SQL expression, never a value read beforehand", async () => {
    seed({ maxAccessCount: 5 });
    await claimShareAccess("share-1");
    expect(is(store.statements[0].accessCount, SQL)).toBe(true);
  });

  it("caps a concurrent burst at the ceiling — the race is closed", async () => {
    seed({ accessCount: 0, maxAccessCount: 1 });

    const results = await Promise.all(
      Array.from({ length: 25 }, () => claimShareAccess("share-1"))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(24);
    expect(store.rows[0].accessCount).toBe(1);
    // Every caller really did try — none was short-circuited by a stale read.
    expect(store.statements).toHaveLength(25);
  });

  it("caps a burst at a larger ceiling too", async () => {
    seed({ accessCount: 0, maxAccessCount: 5 });
    const results = await Promise.all(
      Array.from({ length: 40 }, () => claimShareAccess("share-1"))
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(store.rows[0].accessCount).toBe(5);
  });

  it("never refuses an unlimited link", async () => {
    seed({ accessCount: 0, maxAccessCount: null });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => claimShareAccess("share-1"))
    );
    expect(results.filter(Boolean)).toHaveLength(30);
    expect(store.filteredOut).toBe(0);
  });

  it("returns null when the share row is gone", async () => {
    store.rows = [];
    expect(await claimShareAccess("share-1")).toBeNull();
  });
});
