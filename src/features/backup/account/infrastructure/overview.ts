/**
 * What the two cards on `/backup` say before anything has been clicked.
 *
 * Deliberately *not* an export plan. `planFilesExport` reads every row and every INDEX byte to
 * produce exact numbers, which is right for an archive and wrong for a page: opening `/backup`
 * would then cost what a download costs. These are five aggregates over indexed columns, and
 * they answer the only question the card is asking — "is there anything in here, and roughly how
 * much" — with the honesty that the archive's own SUMMARY is the number that counts.
 *
 * `encryptedFiles` is the one field that is not decoration. An account holding client-side
 * encrypted files cannot be exported at all (`AccountBackupEncryptedFilesError`), and finding
 * that out from a failed download after a two-minute wait is a worse experience than reading it
 * on the card. The scope predicates are copied from `files-source.ts` on purpose — the card must
 * count the same rows the archive would carry, or it is lying in a way nobody will notice. The
 * Brain side learned that the hard way: it counted every `memories` row, including the ones in
 * the Recycle Bin, and reported nine memories for an account whose `/brain` page showed three.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §14.
 */

import { and, count, eq, inArray, isNotNull, isNull, sum, type SQL } from "drizzle-orm";

import { db } from "@/shared/infrastructure/db";
import { brains, files, folders, memories } from "@/shared/infrastructure/db/schema";

/** The same two statuses `files-source.ts` treats as "a file the user has". */
const READABLE_STATUSES = ["ready", "legacy_unverified"] as const;

export interface FilesDomainOverview {
  folders: number;
  files: number;
  bytes: number;
  /** Files this instance cannot put in an archive. Non-zero means export will refuse. */
  encryptedFiles: number;
}

export interface BrainDomainOverview {
  brains: number;
  /** Live memories — exactly the rows `brain-source.ts` scopes into the archive. */
  memories: number;
  /**
   * How many of `memories` are archived rather than active.
   *
   * Carried like any other live row, and split out for one reason: `/brain` shows the active
   * count and the archived count in two separate tiles, for one brain. Without this number a
   * person reading "9" on this card and "3" on that page has no way to reconcile them, and an
   * unreconcilable number reads as a bug even when it is right.
   */
  archivedMemories: number;
}

export interface AccountBackupOverview {
  files: FilesDomainOverview;
  brain: BrainDomainOverview;
}

/** Drizzle's aggregates come back as strings on `bigint`/`numeric`. */
function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function readFilesOverview(userId: string): Promise<FilesDomainOverview> {
  const [folderRow] = await db
    .select({ total: count() })
    .from(folders)
    .where(and(eq(folders.userId, userId), isNull(folders.deletedAt)));

  const [fileRow] = await db
    .select({ total: count(), bytes: sum(files.sizeBytes) })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        isNull(files.deletedAt),
        inArray(files.status, [...READABLE_STATUSES])
      )
    );

  const [encryptedRow] = await db
    .select({ total: count() })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        isNull(files.deletedAt),
        inArray(files.status, [...READABLE_STATUSES]),
        eq(files.encrypted, true)
      )
    );

  return {
    folders: int(folderRow?.total),
    files: int(fileRow?.total),
    bytes: int(fileRow?.bytes),
    encryptedFiles: int(encryptedRow?.total),
  };
}

/**
 * The rows this account's Brain archive is made of, as a predicate.
 *
 * Exported and shared by both counts below because the number on the card is only worth
 * printing if it counts the same rows the download carries. `brain-source.ts` scopes
 * `memories` with `deleted_at IS NULL` — a Recycle Bin that travelled would restore as
 * content — so a count without that filter reports memories no archive will ever hold.
 * `tests/backup-overview-scope.test.ts` reads this predicate back and fails if the filter
 * disappears.
 *
 * Ownership goes through the join rather than a stored owner column: `memories` is owned
 * transitively by its brain, which is also how `export-brain.ts` scopes it. A denormalised
 * owner id would be a second source of truth for the same fact.
 */
export function liveMemoriesOf(userId: string): SQL | undefined {
  return and(eq(brains.ownerUserId, userId), isNull(memories.deletedAt));
}

export async function readBrainOverview(userId: string): Promise<BrainDomainOverview> {
  const [brainRow] = await db
    .select({ total: count() })
    .from(brains)
    .where(eq(brains.ownerUserId, userId));

  const [[memoryRow], [archivedRow]] = await Promise.all([
    db
      .select({ total: count() })
      .from(memories)
      .innerJoin(brains, eq(memories.brainId, brains.id))
      .where(liveMemoriesOf(userId)),
    db
      .select({ total: count() })
      .from(memories)
      .innerJoin(brains, eq(memories.brainId, brains.id))
      .where(and(liveMemoriesOf(userId), isNotNull(memories.archivedAt))),
  ]);

  return {
    brains: int(brainRow?.total),
    memories: int(memoryRow?.total),
    archivedMemories: int(archivedRow?.total),
  };
}

export async function readAccountBackupOverview(userId: string): Promise<AccountBackupOverview> {
  const [filesOverview, brainOverview] = await Promise.all([
    readFilesOverview(userId),
    readBrainOverview(userId),
  ]);
  return { files: filesOverview, brain: brainOverview };
}
