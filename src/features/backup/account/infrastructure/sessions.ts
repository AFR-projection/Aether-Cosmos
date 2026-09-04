/**
 * The two `RestoreSession` implementations — where §7.3's asymmetry between the domains is a
 * difference of eight lines rather than a difference of design.
 *
 * `RestoreSession.run` is the port that makes the commit rule structural: it hands its body a
 * sink and commits **exactly when the body returns**. The body's last act is `finish()`, the
 * trailer verification, so "nothing is committed before the payload digest is proven" is not a
 * rule anybody has to remember here — returning is the only way to commit, and throwing is the
 * only other thing a body can do.
 *
 * What each domain does with that:
 *
 *   - **Brain** opens one transaction, imports into it, deletes the old rows into it if the mode
 *     is `replace`, and commits by returning. A failure anywhere rolls all of it back, which is
 *     why the brain domain needs no staging column and leaves no data row behind (§7.4).
 *   - **Files** runs stage 3 with *no* transaction — a `PutObject` does not roll back, and a
 *     minutes-long restore holding one of ten pooled connections would starve the whole box —
 *     and commits by clearing the two staging columns in a transaction of its own at stage 5.
 *
 * Both expose what their commit removed, because §13's audit row for `replace` records it and
 * `restoreAccountArchive` has no field for a number only the infrastructure can produce. It is
 * read after the call returns, which is the only moment it is meaningful.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.4, §13.
 */

import { db } from "@/shared/infrastructure/db";
import type { RestoreSession } from "@backup/account/application/import";
import type {
  BrainImportSink,
  FilesImportSink,
  RestoreMode,
} from "@backup/account/application/import-types";
import { drizzleBrainSink } from "@backup/account/infrastructure/brain-sink";
import {
  deleteOldBrainRows,
  snapshotBrainRoots,
  type BrainDeleteResult,
} from "@backup/account/infrastructure/commit-brain";
import { swapFilesBatch, type FilesSwapResult } from "@backup/account/infrastructure/commit-files";
import { drizzleFilesSink } from "@backup/account/infrastructure/files-sink";

/** A files session, plus what its commit sent to the Recycle Bin. `null` until `run` returns. */
export interface FilesRestoreSession extends RestoreSession<FilesImportSink> {
  readonly swap: FilesSwapResult | null;
}

/** A brain session, plus what its commit deleted. `null` until `run` returns. */
export interface BrainRestoreSession extends RestoreSession<BrainImportSink> {
  readonly deleted: BrainDeleteResult | null;
}

export function filesRestoreSession(input: {
  userId: string;
  mode: RestoreMode;
}): FilesRestoreSession {
  const { userId, mode } = input;
  let swap: FilesSwapResult | null = null;

  return {
    get swap() {
      return swap;
    },
    async run<T>(restoreBatchId: string, body: (sink: FilesImportSink) => Promise<T>): Promise<T> {
      // Stages 3 and 4, on autocommit. Every row the sink writes is born invisible, so there is
      // nothing here a transaction would be protecting — and a throw leaves exactly the staged
      // rows and R2 objects the sweeper is built to collect (§7.6).
      const result = await body(drizzleFilesSink({ userId, restoreBatchId }));

      // Stage 5. One transaction, two statements, and the only ones in the files path that can
      // remove anything the account could see.
      swap = await db.transaction((tx) => swapFilesBatch({ tx, userId, restoreBatchId, mode }));
      return result;
    },
  };
}

export function brainRestoreSession(input: {
  ownerUserId: string;
  mode: RestoreMode;
}): BrainRestoreSession {
  const { ownerUserId, mode } = input;
  let deleted: BrainDeleteResult | null = null;

  return {
    get deleted() {
      return deleted;
    },
    async run<T>(_restoreBatchId: string, body: (sink: BrainImportSink) => Promise<T>): Promise<T> {
      // `restoreBatchId` is unused here on purpose: it labels *staged* rows, and this domain
      // stages nothing — the transaction is what hides the import, and rolling back is what
      // unwinds it. The batch row still exists; it is stage 2's bookkeeping, not a column here.
      return db.transaction(async (tx) => {
        // Before the first insert, so "old" means "there when the restore began" rather than
        // "not minted by this batch" — a brain another request creates mid-restore is then not
        // in the set, and `replace` cannot delete what it never saw.
        const snapshot = mode === "replace" ? await snapshotBrainRoots({ tx, ownerUserId }) : null;
        const doomedBrainIds = snapshot?.get("brains") ?? [];

        const result = await body(drizzleBrainSink({ tx, ownerUserId, doomedBrainIds }));

        // Stage 5, inside the same transaction (§7.3) and after the trailer has verified: the
        // body returning is what proves stage 4 passed, so a corrupt payload has already thrown
        // past this line with every old row untouched.
        if (snapshot !== null) {
          deleted = await deleteOldBrainRows({ tx, ownerUserId, snapshot });
        }
        return result;
      });
    },
  };
}
