/**
 * Every parameter this feature hands the driver is already something the driver can send.
 *
 * `db.execute(sql`…`)` and a raw `sql` fragment inside a query builder call look like the
 * typed paths beside them, and they are not. `eq(column, value)` wraps the value together
 * with the column, so Drizzle converts it on the way out — a `Date` becomes an ISO string
 * because the column said it was a timestamp. A bare `${value}` in a `sql` template has no
 * column to ask, so it travels as itself, and postgres-js is then handed a `Date` where it
 * expects a string:
 *
 *   TypeError: The "string" argument must be of type string or an instance of Buffer or
 *   ArrayBuffer. Received an instance of Date
 *
 * That is not a wrong result. It is a thrown request, and it cost this feature its whole
 * Brain download: `brain-source.ts` fenced its two passes with `created_at <= startedAt`,
 * the first page of the first table threw, `planBrainExport` never returned, and because a
 * download is an anchor click rather than a fetch, the browser had nowhere to show the 500.
 * The button worked, the file never came. `restore-sweep-store.ts` had the same line for
 * `cutoff` and lost the same way, silently, in a background job.
 *
 * Neither module was untested — `tests/backup-account-brain-source.test.ts` checks the
 * filters and the scope. But it asserts on the *decision* and never on the *bytes*, and no
 * fake executes a query, so nothing in 3300 tests ever looked at a parameter. This file
 * does exactly that and nothing else: build the real statements, ask the real dialect what
 * it would send, and refuse anything postgres-js would not accept.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §7.6.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SQL } from "drizzle-orm";

const captured = vi.hoisted(() => ({
  /** Every `SQL` that reached `db.execute`, in execution order. */
  executed: [] as unknown[],
  /** Every argument the select chain's `.where()` was given. */
  conditions: [] as unknown[],
}));

vi.mock("@/shared/infrastructure/db", () => {
  interface Chain {
    from(table: unknown): Chain;
    where(condition: unknown): Chain;
    orderBy(...columns: unknown[]): Chain;
    limit(rows: number): Chain;
    then<A>(onFulfilled: (rows: unknown[]) => A): Promise<A>;
  }

  function chain(): Chain {
    const api: Chain = {
      from: () => api,
      where(condition) {
        captured.conditions.push(condition);
        return api;
      },
      orderBy: () => api,
      limit: () => api,
      then: (onFulfilled) => Promise.resolve(onFulfilled([])),
    };
    return api;
  }

  return {
    db: {
      execute: async (query: unknown) => {
        captured.executed.push(query);
        // An empty page ends the keyset loop after one round trip, which is all this needs.
        return [];
      },
      select: () => chain(),
    },
  };
});

const { accountTables } = await import("@backup/account/domain/tables");
const { drizzleBrainSource } = await import("@backup/account/infrastructure/brain-source");
const { drizzleRestoreSweepStore } = await import(
  "@backup/account/infrastructure/restore-sweep-store"
);

/** The same dialect Drizzle uses to turn a statement into a string and a parameter list. */
const dialect = new PgDialect();

/**
 * The parameters postgres-js would be handed, described where they are not sendable.
 *
 * Sendable is narrow on purpose. postgres-js writes an unspecified-type parameter with
 * `Buffer.byteLength`, so a string, a number and a boolean go out and everything else — a
 * `Date`, a `Buffer`, a plain object — either throws or arrives as `[object Object]`.
 * Nothing in this feature needs to pass one, so anything else is a defect.
 */
function unsendable(query: unknown): string[] {
  const { params } = dialect.sqlToQuery(query as SQL);
  return params.flatMap((param) => {
    if (param === null || param === undefined) return [];
    const type = typeof param;
    if (type === "string" || type === "number" || type === "boolean") return [];
    if (param instanceof Date) return [`a Date (${param.toISOString()})`];
    const name = type === "object" ? (param.constructor?.name ?? "an object") : type;
    return [`a ${name}`];
  });
}

const USER = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = new Date("2026-09-03T08:15:00.000Z");

beforeEach(() => {
  captured.executed.length = 0;
  captured.conditions.length = 0;
});

describe("the brain reader's statements", () => {
  it("sends nothing but strings, numbers and booleans, for every brain table", async () => {
    const source = drizzleBrainSource(USER, STARTED_AT);

    // Every table, not a sample: the horizon is added per table — only where the descriptor
    // declares `created_at` — so a sample would prove it about the tables that happen to be
    // first. Thirteen queries is one round trip each, all of them answered by an empty page.
    for (const table of accountTables("brain")) {
      for await (const _row of source.rows(table)) {
        throw new Error("the fake returns no rows");
      }
    }

    expect(captured.executed).toHaveLength(accountTables("brain").length);

    const offenders = captured.executed.flatMap((query, index) =>
      unsendable(query).map((what) => `${accountTables("brain")[index].name}: ${what}`)
    );
    expect(offenders).toEqual([]);
  });

  it("still fences both passes at the horizon it was given", async () => {
    const source = drizzleBrainSource(USER, STARTED_AT);
    const [brains] = accountTables("brain");

    for await (const _row of source.rows(brains)) {
      throw new Error("the fake returns no rows");
    }

    // The predicate has to survive the fix. Converting the timestamp is only correct if the
    // comparison it feeds is still there and still comparing against the same instant.
    const { sql: text, params } = dialect.sqlToQuery(captured.executed[0] as SQL);
    expect(text).toContain(`"created_at" <= `);
    expect(params).toContain(STARTED_AT.toISOString());
  });
});

describe("the restore sweeper's statements", () => {
  it("asks for abandoned batches with a timestamp the driver can send", async () => {
    const cutoff = new Date("2026-09-03T07:00:00.000Z");

    await drizzleRestoreSweepStore().findAbandoned(cutoff, 25);

    expect(captured.conditions).toHaveLength(1);
    expect(unsendable(captured.conditions[0])).toEqual([]);
  });
});
