/**
 * `RestoreLedger` over this application's own quota columns — stage 2 in full, and the
 * bookkeeping half of stage 5.
 *
 * Everything here is scoped by one `userId`, closed over at construction and never taken from
 * an argument again. §10's rule is that the authenticated caller is the only source of scope,
 * and the cheapest way to keep a rule like that is to make the alternative unspellable: no call
 * on this object can name another account, and `reserve` rejects an input that tries.
 *
 * **Why `reserve` is its own committed transaction** is the port's own doc comment (§7.3): a
 * reservation nobody else can see stops no concurrent restore, and `restore_reservations`
 * cannot hang off a `restore_batches` row that a rolled-back import would take down with it.
 * What is worth saying here instead is the arithmetic.
 *
 * **The quota sum has three terms, not two.** §9 row 9 spells the check
 * `used + reserved + totalBytes ≤ limit`, and in this schema "reserved" is two tables: the
 * `users.reserved_bytes` counter that in-flight *uploads* hold, and the sum of
 * `restore_reservations.bytes` that staging *restores* hold. Leaving the first out would let a
 * restore spend space an upload has already claimed, so the statement below is exactly the one
 * `upload-service.ts` uses with one more term added — including its treatment of a zero quota
 * as "nothing fits", because a restore that were more permissive than an upload would be the
 * wrong kind of inconsistency to introduce.
 *
 * **A `replace` is charged for the space it is about to free.** The formula is what it is: the
 * old rows are still there at stage 2 and are not soft-deleted until stage 5, so an in-place
 * "Ganti total" on a nearly-full account can be refused for room it would have released. That
 * is the conservative direction, and the disaster path — fresh account, `used = 0` — never
 * meets it.
 *
 * **Abandoned debris is cleared here as well as by the sweeper.** §8 makes the sweeper the
 * mechanism, and it stays the mechanism for the things only it can do — staged Files rows and
 * their R2 objects. But a process killed mid-restore leaves a `staging` row that would answer
 * `AccountBackupBusyError` to every retry, and a reservation that would eat the quota those
 * retries need, until the next hourly sweep past the 24-hour mark. So `reserve` runs the same
 * age-gated bookkeeping the sweeper runs, under the row lock it already holds, before it asks
 * either question. Same window, same two statements, idempotent either way.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.6, §8, §9.
 */

import { and, eq, inArray, lt, sum } from "drizzle-orm";

import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";
import { db, recalculateUsedBytes } from "@/shared/infrastructure/db";
import { restoreBatches, restoreReservations, users } from "@/shared/infrastructure/db/schema";
import type { RestoreLedger, RestoreReservationInput } from "@backup/account/application/import";
import { AccountBackupBusyError, AfrQuotaError } from "@backup/account/domain/errors";
import type { AccountTx } from "@backup/account/infrastructure/schema-map";

/**
 * How long a batch may sit in `staging` before it is debris rather than a restore.
 *
 * §7.6's window, exported so the sweeper and this file cannot drift apart: the two of them
 * decide the same thing about the same rows, and a sweeper that used a shorter window would
 * abort restores the ledger still believes are running.
 *
 * Twenty-four hours is sized for the case that justifies it — tens of gigabytes arriving over a
 * throttled uplink into a 2 GB VPS — not for the common one.
 */
export const RESTORE_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/** `restore_batches.error` is read by whoever looks at the batch; keep it column-sized. */
const MAX_REASON_CHARS = 200;

/**
 * What an age-gated abort writes, in place of the failure nobody was there to catch.
 *
 * Exported for the same reason the window above is: the sweeper performs the identical abort on
 * the identical rows, and whoever later reads `restore_batches.error` should not be able to tell
 * — or have to care — which of the two got there first.
 */
export const RESTORE_ABANDONED_REASON = "abandoned: the restore stopped before it finished";

/**
 * A reason short enough for the column.
 *
 * `describeFailure` already clips to the same length, and this is not distrust of it: `abandon`
 * is a public port method and the string it is handed is the only thing standing between a
 * driver message and a text column.
 */
function clipReason(reason: string): string {
  return reason.length > MAX_REASON_CHARS
    ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…`
    : reason;
}

/**
 * The ledger for one account, for the length of one request.
 *
 * @param now injected so a test can put a batch on either side of the abandonment window
 *   without waiting a day for it.
 */
export function drizzleRestoreLedger(input: {
  userId: string;
  now?: () => number;
}): RestoreLedger {
  const { userId } = input;
  const clock = input.now ?? Date.now;

  /**
   * Abort this account's abandoned batches, and release what they were holding.
   *
   * Bookkeeping only. A Files batch may have left staged rows and R2 objects behind, and this
   * does not touch either — the sweeper collects those, which is why it must look for staged
   * rows under any non-`committed` batch rather than only under an aged `staging` one.
   */
  async function expireAbandoned(tx: AccountTx): Promise<void> {
    const cutoff = new Date(clock() - RESTORE_ABANDON_AFTER_MS);
    const stale = await tx
      .update(restoreBatches)
      .set({ state: "aborted", error: RESTORE_ABANDONED_REASON, updatedAt: new Date(clock()) })
      .where(
        and(
          eq(restoreBatches.userId, userId),
          eq(restoreBatches.state, "staging"),
          // `created_at`, matching `restore_batches_stale_idx` and §7.6's own wording. The
          // batch's age is what is being asked about, not how recently something touched it.
          lt(restoreBatches.createdAt, cutoff)
        )
      )
      .returning({ id: restoreBatches.id });
    if (stale.length === 0) return;

    await tx.delete(restoreReservations).where(
      and(
        eq(restoreReservations.userId, userId),
        inArray(
          restoreReservations.restoreBatchId,
          stale.map((row) => row.id)
        )
      )
    );
  }

  /**
   * Stage 2. Returns the `restore_batches.id` every later stage is labelled with.
   *
   * The lock is taken first and held to the commit, which is what makes the two questions after
   * it answerable at all: two restores arriving together serialise here, and the second one sees
   * the first one's reservation rather than the balance the first one read.
   */
  async function reserve(reservation: RestoreReservationInput): Promise<string> {
    if (reservation.userId !== userId) {
      // A plain `Error`, never a refusal: nothing a backup file contains can cause this, so it
      // must not be reportable as something a backup file caused.
      throw new Error("restore ledger was asked to reserve for a different account");
    }

    return db.transaction(async (tx) => {
      const [account] = await tx
        .select({
          usedBytes: users.usedBytes,
          reservedBytes: users.reservedBytes,
          quotaBytes: users.quotaBytes,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (account === undefined) {
        throw new Error("restore ledger found no account row to reserve against");
      }

      // Before either question below, so debris answers neither of them.
      await expireAbandoned(tx);

      const [running] = await tx
        .select({ id: restoreBatches.id })
        .from(restoreBatches)
        .where(and(eq(restoreBatches.userId, userId), eq(restoreBatches.state, "staging")))
        .limit(1);
      if (running !== undefined) throw new AccountBackupBusyError();

      const [restoring] = await tx
        .select({ total: sum(restoreReservations.bytes) })
        .from(restoreReservations)
        .where(eq(restoreReservations.userId, userId));
      const claimed =
        account.usedBytes + account.reservedBytes + Number(restoring?.total ?? 0);
      // Clamped at zero because a quota lowered below what the account already holds is a
      // legitimate state, and `AfrQuotaError` reports this number to the user.
      const available = Math.max(0, account.quotaBytes - claimed);
      if (reservation.expectedBytes > available) {
        throw new AfrQuotaError(reservation.expectedBytes, available);
      }

      const [batch] = await tx
        .insert(restoreBatches)
        .values({
          userId,
          domain: reservation.domain,
          mode: reservation.mode,
          state: "staging",
          backupId: reservation.backupId,
          formatVersion: reservation.formatVersion,
          keyId: reservation.keyId,
          // What the SUMMARY claimed. The importer compares every batch against these, so an
          // archive that announces 100 MB and starts delivering 50 GB is stopped mid-stream.
          expectedRows: reservation.expectedRows,
          expectedBytes: reservation.expectedBytes,
        })
        .returning({ id: restoreBatches.id });
      if (batch === undefined) {
        throw new Error("restore ledger could not create a batch row");
      }

      // The batch id is this table's primary key, so the same restore cannot reserve twice.
      await tx.insert(restoreReservations).values({
        restoreBatchId: batch.id,
        userId,
        bytes: reservation.expectedBytes,
      });

      return batch.id;
    });
  }

  /**
   * Stage 5's other half: the batch is committed, so record what landed and stop holding space.
   *
   * The transaction is the part that must not fail quietly. A batch left in `staging` would tell
   * the next restore this account is busy, and a reservation left behind would charge it for
   * bytes `used_bytes` is about to count as well — so a miss here throws, and says plainly that
   * the data is safe and only the bookkeeping is not.
   *
   * What follows the transaction is derived state, and is deliberately best-effort: `used_bytes`
   * is a cache of a `SUM` this function can recompute at any time, and the Redis keys expire on
   * their own. Turning a restore the user just watched succeed into a 500 because a cache
   * invalidation failed would be the worse of the two outcomes.
   */
  async function settle(
    restoreBatchId: string,
    written: { rows: number; bytes: number }
  ): Promise<void> {
    const domain = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(restoreBatches)
        .set({
          state: "committed",
          writtenRows: written.rows,
          writtenBytes: written.bytes,
          updatedAt: new Date(clock()),
        })
        .where(and(eq(restoreBatches.id, restoreBatchId), eq(restoreBatches.userId, userId)))
        .returning({ domain: restoreBatches.domain });
      if (row === undefined) {
        throw new Error(
          `restore ${restoreBatchId} committed, but its ledger row is not this account's`
        );
      }
      await tx
        .delete(restoreReservations)
        .where(
          and(
            eq(restoreReservations.restoreBatchId, restoreBatchId),
            eq(restoreReservations.userId, userId)
          )
        );
      return row.domain;
    });

    // Brain rows do not consume the storage quota and are not in any of these keys — its own
    // cache is per-`brainId`, in-process, and TTL-bounded, so a restore that minted new brain
    // ids has nothing stale to invalidate there.
    if (domain !== "files") return;

    await recalculateUsedBytes(userId).catch(() => {});
    void cacheDelPattern(`files:${userId}:*`).catch(() => {});
    void cacheDelPattern(`search:${userId}:*`).catch(() => {});
  }

  /**
   * This batch will never commit.
   *
   * Two effects, and the order between them is the reason there is a transaction: the
   * reservation goes first so the user can retry at once, and the state moves to `aborted` so
   * nothing reads the batch as running. Committed together, or the account can end up either
   * paying for a restore that is over or blocked by one that is.
   *
   * Nothing here throws. It runs on a path where some other failure is the one the caller must
   * see, and `release()` in `import.ts` swallows a secondary failure for exactly that reason —
   * so this adds none. Whatever it could not finish is the sweeper's, which is also true of the
   * one thing it never attempts: for Files there are staged rows and R2 objects that only the
   * sweeper can remove, and their batch is now `aborted` rather than `staging`.
   */
  async function abandon(restoreBatchId: string, reason: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(restoreReservations)
        .where(
          and(
            eq(restoreReservations.restoreBatchId, restoreBatchId),
            eq(restoreReservations.userId, userId)
          )
        );
      await tx
        .update(restoreBatches)
        .set({ state: "aborted", error: clipReason(reason), updatedAt: new Date(clock()) })
        .where(and(eq(restoreBatches.id, restoreBatchId), eq(restoreBatches.userId, userId)));
    });
  }

  return { reserve, settle, abandon };
}
