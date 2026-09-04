/**
 * §7.6's store: drizzle + R2, plus raw SQL for the one question drizzle cannot spell.
 */

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "@/shared/infrastructure/db";
import { files, folders, restoreBatches, restoreReservations } from "@/shared/infrastructure/db/schema";
import { deleteR2Objects } from "@/shared/infrastructure/storage/r2-objects";
import type {
  CollectedRows,
  RestoreSweepStore,
  SweepableBatch,
} from "@backup/account/application/sweep-restores";

/** How many files' worth of keys one collect pass reads at a time. */
const COLLECT_PAGE_SIZE = 1000;

export function drizzleRestoreSweepStore(): RestoreSweepStore {
  async function findAbandoned(cutoff: Date, limit: number): Promise<readonly SweepableBatch[]> {
    return db
      .select({
        id: restoreBatches.id,
        userId: restoreBatches.userId,
        domain: restoreBatches.domain,
      })
      .from(restoreBatches)
      // `lt`, not a raw `sql` fragment: the column carries the encoder that turns this `Date`
      // into a timestamp the driver can send. A bare `${cutoff}` in a template has no column
      // to ask and reaches postgres-js as a `Date`, which throws — see
      // `tests/backup-sql-driver-params.test.ts`.
      .where(and(eq(restoreBatches.state, "staging"), lt(restoreBatches.createdAt, cutoff)))
      .orderBy(restoreBatches.createdAt)
      .limit(limit);
  }

  async function abortBatch(
    batch: SweepableBatch,
    reason: string,
    now: Date
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx
        .delete(restoreReservations)
        .where(
          and(
            eq(restoreReservations.restoreBatchId, batch.id),
            eq(restoreReservations.userId, batch.userId)
          )
        );

      const updated = await tx
        .update(restoreBatches)
        .set({ state: "aborted", error: reason, updatedAt: now })
        .where(
          and(
            eq(restoreBatches.id, batch.id),
            eq(restoreBatches.userId, batch.userId),
            eq(restoreBatches.state, "staging")
          )
        )
        .returning({ id: restoreBatches.id });

      return updated.length > 0;
    });
  }

  async function findCollectable(limit: number): Promise<readonly string[]> {
    // Batch ids that own staged rows while not being `staging` — a union because the two tables
    // are disjoint and a scan of either one is cheaper than a join. The `WHERE restore_batch_id
    // IS NOT NULL` is what the partial indexes cover, so both arms read the index only.
    //
    // The second predicate, `NOT IN (SELECT id FROM restore_batches WHERE state = 'staging')`,
    // is the one thing that makes this safe to run beside a live restore: a batch in `staging`
    // is one an import is still writing, and its rows are not collectable yet. The subquery is
    // tiny — one row per account, at most — so the planner inlines it rather than materialising.
    const result = await db.execute(sql`
      SELECT DISTINCT batch_id FROM (
        SELECT ${files.restoreBatchId} AS batch_id
        FROM ${files}
        WHERE ${isNotNull(files.restoreBatchId)}
        UNION
        SELECT ${folders.restoreBatchId}
        FROM ${folders}
        WHERE ${isNotNull(folders.restoreBatchId)}
      ) batches
      WHERE batch_id NOT IN (
        SELECT ${restoreBatches.id}
        FROM ${restoreBatches}
        WHERE ${eq(restoreBatches.state, "staging")}
      )
      LIMIT ${limit}
    `);

    return (result as unknown as Array<{ batch_id: string }>).map((row) => row.batch_id);
  }

  async function collectStagedRows(restoreBatchId: string): Promise<CollectedRows> {
    let fileCount = 0;
    let folderCount = 0;

    // Objects first, so a retry after a failed delete converges rather than leaking them.
    // Paginated because a batch can hold tens of thousands of files, and reading every key into
    // memory before deleting any of them is how a 2 GB VPS dies.
    //
    // The `DELETE` is keyed on *this page's ids*, never on `restore_batch_id`: a statement that
    // deleted the whole batch would remove rows whose objects the loop has not reached yet, and
    // those objects are then unreachable forever — the exact leak the objects-first order exists
    // to prevent. Deleting only what was just cleaned keeps the invariant per page, which is what
    // makes an interrupted collect resumable.
    while (true) {
      const page = await db
        .select({ id: files.id, r2Key: files.r2Key, thumbnailKey: files.thumbnailKey })
        .from(files)
        .where(eq(files.restoreBatchId, restoreBatchId))
        .limit(COLLECT_PAGE_SIZE);

      if (page.length === 0) break;

      const keys: string[] = [];
      for (const row of page) {
        keys.push(row.r2Key);
        if (row.thumbnailKey) keys.push(row.thumbnailKey);
      }
      await deleteR2Objects(keys);

      const deleted = await db
        .delete(files)
        .where(
          and(
            eq(files.restoreBatchId, restoreBatchId),
            inArray(
              files.id,
              page.map((row) => row.id)
            )
          )
        )
        .returning({ id: files.id });

      fileCount += deleted.length;
      // A page that deleted nothing means another pass took these rows; without this the loop
      // would read the same page forever.
      if (deleted.length === 0) break;
      if (page.length < COLLECT_PAGE_SIZE) break;
    }

    // Folders second. They hold no objects, and `parentId` is not a foreign key (schema.ts:263),
    // so deleting a tree in arbitrary order is safe — nothing cascades and nothing complains.
    const deletedFolders = await db
      .delete(folders)
      .where(eq(folders.restoreBatchId, restoreBatchId))
      .returning({ id: folders.id });

    folderCount = deletedFolders.length;

    return { files: fileCount, folders: folderCount };
  }

  return { findAbandoned, abortBatch, findCollectable, collectStagedRows };
}
