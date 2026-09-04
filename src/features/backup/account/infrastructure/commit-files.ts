/**
 * Stage 5 for Files: two `UPDATE`s that make a staged batch the account's own rows.
 *
 * This file and `commit-brain.ts` are the only two places in the feature that remove
 * anything, and that is a property worth keeping deliberately: everything else — the
 * importer, the sink, the sweeper's row collector — writes staged rows or reads them, so a
 * restore that fails anywhere before this call has provably deleted nothing (§7.4).
 *
 * Both statements run in **one** transaction, in an order the spec fixes rather than leaves to
 * taste. `replace` soft-deletes the old rows *first*, and the `restore_batch_id IS NULL`
 * predicate on that statement is exactly what stops it taking the newly arrived rows with it;
 * activating the batch afterwards is then the same single statement `merge` uses. Two
 * statements, one transaction, atomic: no window exists in which the account has neither its
 * old files nor its new ones.
 *
 * Nothing here touches R2. A `replace` that removed objects would make the Recycle Bin a lie —
 * the row would be restorable and its bytes would not be — so the old rows are soft-deleted
 * and the existing deletion worker owns their objects on the existing schedule. That is also
 * what makes "Ganti total" undoable for the length of the retention window (§7.4).
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.4.
 */

import { and, eq, isNull } from "drizzle-orm";

import { files, folders } from "@/shared/infrastructure/db/schema";
import type { RestoreMode } from "@backup/account/application/import-types";
import type { AccountTx } from "@backup/account/infrastructure/schema-map";

/** What a `replace` sent to the Recycle Bin, for the audit row §13 asks for. */
export interface FilesSwapResult {
  softDeletedFolders: number;
  softDeletedFiles: number;
}

/**
 * Make this batch's rows the account's rows.
 *
 * `updated_at` is deliberately left alone. It carries the archive's own timestamp — the
 * provenance the whole format exists to preserve — and stamping it with the moment of the
 * restore would tell the user every file they own was modified today.
 */
export async function swapFilesBatch(input: {
  tx: AccountTx;
  userId: string;
  restoreBatchId: string;
  mode: RestoreMode;
}): Promise<FilesSwapResult> {
  const { tx, userId, restoreBatchId, mode } = input;
  const result: FilesSwapResult = { softDeletedFolders: 0, softDeletedFiles: 0 };

  if (mode === "replace") {
    const deletedAt = new Date();
    // `restore_batch_id IS NULL` is the whole safety of this statement, and `user_id` is the
    // whole scope of it. Files before folders so a row is never briefly orphaned by a folder
    // that left ahead of it — the two statements are in one transaction, so this is about the
    // shape of the intermediate state rather than about visibility.
    const deletedFiles = await tx
      .update(files)
      .set({ deletedAt })
      .where(
        and(eq(files.userId, userId), isNull(files.deletedAt), isNull(files.restoreBatchId))
      )
      .returning({ id: files.id });
    const deletedFolders = await tx
      .update(folders)
      .set({ deletedAt })
      .where(
        and(eq(folders.userId, userId), isNull(folders.deletedAt), isNull(folders.restoreBatchId))
      )
      .returning({ id: folders.id });

    result.softDeletedFiles = deletedFiles.length;
    result.softDeletedFolders = deletedFolders.length;
  }

  // Folders first here, for the mirror of the reason above: a file becomes visible only once
  // the folder it hangs in already is.
  await tx
    .update(folders)
    .set({ deletedAt: null, restoreBatchId: null })
    .where(and(eq(folders.userId, userId), eq(folders.restoreBatchId, restoreBatchId)));
  await tx
    .update(files)
    .set({ deletedAt: null, restoreBatchId: null })
    .where(and(eq(files.userId, userId), eq(files.restoreBatchId, restoreBatchId)));

  return result;
}
