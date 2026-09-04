/**
 * §7.6's sweeper: the two things a restore that was killed cannot do for itself.
 *
 * A restore that fails *and returns* cleans up after its own bookkeeping — `release()` in
 * `import.ts` calls `ledger.abandon`, which drops the reservation and marks the batch `aborted`
 * before the refusal reaches the user. A restore whose process is **killed** reaches none of
 * that: it leaves a `staging` batch that answers `AccountBackupBusyError` to every retry, a
 * reservation eating quota the retry needs, and — for Files — staged rows plus the R2 objects
 * they name. This pass is what ends both stories, and it is the *only* thing that can clean up
 * the third: those objects are reachable only through the staged rows, so a sweeper that deleted
 * the rows first would leave the bytes behind forever.
 *
 * **Two passes, in this order, and the order is load-bearing.**
 *
 *   1. *Abort* every `staging` batch older than {@link RESTORE_ABANDON_AFTER_MS}. Bookkeeping
 *      only: `aborted` + drop the reservation, exactly what `abandon` does and exactly what
 *      `reserve` does for the calling account under its own row lock.
 *   2. *Collect* the staged rows of every batch that is **not** `staging`. Running the abort
 *      pass first is what lets a batch abandoned by the age gate be collected in the same tick,
 *      instead of waiting an hour for the next one.
 *
 * **What makes it safe beside a running restore** is that neither pass has an opinion about
 * progress. Pass 1 asks only how old the batch is; pass 2 asks only whether it is still
 * `staging`, which is true for exactly as long as the import may still write. Nothing here can
 * pull a row out from under a live import, and running the whole thing twice does the second
 * time what a `WHERE` clause that now matches nothing does — nothing.
 *
 * **`state <> 'staging'`, rather than `= 'aborted'`,** is deliberately the wider question. It
 * also catches staged rows whose batch row is gone: `files.restore_batch_id` is not a foreign
 * key (see the schema comment on it), so nothing nulls it automatically, and a row left behind
 * with a batch id nobody recognises is invisible to every read path — including the Recycle Bin,
 * which now filters it out — and therefore unpurgeable by any means except this pass.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.6, §8.
 */

import {
  RESTORE_ABANDONED_REASON,
  RESTORE_ABANDON_AFTER_MS,
} from "@backup/account/infrastructure/ledger";

/** How many batches one tick will touch, per pass. */
const SWEEP_BATCH_LIMIT = 50;

/** One abandoned batch, as either pass needs to see it. */
export interface SweepableBatch {
  id: string;
  userId: string;
  domain: string;
}

/** What a collect pass removed for one batch. */
export interface CollectedRows {
  files: number;
  folders: number;
}

/**
 * The database and bucket, as two questions and two commands.
 *
 * A port rather than direct drizzle because the thing worth testing here is the *order* — abort
 * before collect, and never collect a `staging` batch — and that is a statement about this file
 * rather than about PostgreSQL.
 */
export interface RestoreSweepStore {
  /** `staging` batches created before `cutoff`, oldest first, across every account. */
  findAbandoned(cutoff: Date, limit: number): Promise<readonly SweepableBatch[]>;
  /**
   * `aborted` + release the reservation, in one transaction. Idempotent.
   *
   * `false` when the batch was no longer `staging` by the time the write ran — a restore that
   * committed in the gap after {@link findAbandoned} read it. The move is a compare-and-set for
   * exactly that reason: this pass must never overwrite a `committed` batch with `aborted`.
   */
  abortBatch(batch: SweepableBatch, reason: string, now: Date): Promise<boolean>;
  /**
   * Batch ids that still own staged `files`/`folders` rows while not being `staging` — including
   * ids whose `restore_batches` row no longer exists.
   */
  findCollectable(limit: number): Promise<readonly string[]>;
  /** Delete the batch's staged objects and rows: objects, then files, then folders. */
  collectStagedRows(restoreBatchId: string): Promise<CollectedRows>;
}

export interface RestoreSweepReport {
  /** Batches the age gate moved out of `staging`. */
  abandoned: number;
  /** Batches whose staged rows were collected. */
  collected: number;
  stagedFiles: number;
  stagedFolders: number;
}

/**
 * One tick of the per-account restore sweep.
 *
 * Every step is wrapped, because this runs inside the hourly cleanup job alongside the
 * session purge and the trash purge (`workers/cleanup.ts`): one account's unreachable bucket
 * must not stop the next account's reservation being released, and it must not take the rest
 * of the tick down with it. Whatever a tick could not finish is simply still true an hour
 * later, which is the only reason a pass this quiet is acceptable.
 */
export async function sweepAbandonedRestores(
  store: RestoreSweepStore,
  now: Date = new Date()
): Promise<RestoreSweepReport> {
  const report: RestoreSweepReport = {
    abandoned: 0,
    collected: 0,
    stagedFiles: 0,
    stagedFolders: 0,
  };

  // ── pass 1: bookkeeping ───────────────────────────────────────────────────
  // `createdAt`-based, matching `restore_batches_stale_idx` and §7.6's own wording: the
  // question is the batch's age, not how recently something touched it.
  const cutoff = new Date(now.getTime() - RESTORE_ABANDON_AFTER_MS);
  let abandoned: readonly SweepableBatch[] = [];
  try {
    abandoned = await store.findAbandoned(cutoff, SWEEP_BATCH_LIMIT);
  } catch {
    // The collect pass asks its own question and does not depend on this one.
  }

  for (const batch of abandoned) {
    try {
      if (await store.abortBatch(batch, RESTORE_ABANDONED_REASON, now)) {
        report.abandoned += 1;
      }
    } catch {
      // Still `staging`, so still abandoned, so found again next hour.
    }
  }

  // ── pass 2: data ──────────────────────────────────────────────────────────
  let collectable: readonly string[] = [];
  try {
    collectable = await store.findCollectable(SWEEP_BATCH_LIMIT);
  } catch {
    return report;
  }

  for (const restoreBatchId of collectable) {
    try {
      const removed = await store.collectStagedRows(restoreBatchId);
      report.collected += 1;
      report.stagedFiles += removed.files;
      report.stagedFolders += removed.folders;
    } catch {
      // The rows are invisible to every read path, so leaving them for the next tick costs
      // storage and nothing else. Deleting the rows on a failed object delete would cost the
      // objects permanently, which is why the store does them in the other order.
    }
  }

  return report;
}
