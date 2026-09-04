/**
 * The brain reader's one hand-written decision, checked for drift.
 *
 * `brain-source.ts` derives almost everything from the descriptors — the scope clause, the
 * SELECT list, the keyset order — precisely so that a table added to `tables.ts` cannot
 * quietly acquire a `WHERE` clause that disagrees with the prose documenting it. The one
 * thing it cannot derive is `rowFilter`, which the descriptors state in English, so that
 * lives in a lookup keyed by table name.
 *
 * A lookup is exactly where the drift would happen: add `memory_reminders` to `tables.ts`,
 * forget the entry, and a scope-only query exports every row of it — including rows that
 * are soft-deleted, or rows the descriptor says belong to somebody else. The module answers
 * a missing key with a thrown `Error` rather than a permissive default, and this file is
 * what makes that failure arrive at the person adding the table instead of at the person
 * reading the archive.
 *
 * Importing the module is safe without a database: `db` is a lazy `Proxy`, so nothing
 * connects until a query is executed, and neither assertion here executes one.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3.
 */

import { describe, expect, it } from "vitest";

import { brainRowFilterNames, brainTableNames, drizzleBrainSource } from "@backup/account/infrastructure/brain-source";
import { accountTables } from "@backup/account/domain/tables";

describe("the brain reader's row filters", () => {
  it("has decided exactly one filter per brain table, no more and no fewer", () => {
    // Sorted rather than positional: the file groups its entries by subject, and rank
    // order is `tables.ts`'s business, not this lookup's.
    expect(brainRowFilterNames().sort()).toEqual(brainTableNames().sort());
  });

  it("knows every table by the name the descriptors spell", () => {
    expect(brainTableNames()).toEqual(accountTables("brain").map((table) => table.name));
  });
});

describe("the brain reader's scope", () => {
  it("refuses a table from the other domain before it builds a query", async () => {
    const source = drizzleBrainSource("user-1", new Date());
    const [files] = accountTables("files");

    // An async generator does nothing until it is driven, so the refusal has to be
    // observed by driving it — and it arrives before `db` is ever touched.
    const drive = async (): Promise<void> => {
      await source.rows(files)[Symbol.asyncIterator]().next();
    };

    await expect(drive()).rejects.toThrow(`${files.name} is not a brain table`);
  });
});
