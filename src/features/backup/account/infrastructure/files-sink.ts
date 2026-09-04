/**
 * `FilesImportSink` over this application's own tables and bucket — the staging half of §7.3.
 *
 * Every row this sink writes is born invisible: `deleted_at = NOW()` and `restore_batch_id`
 * set, which is a state every existing read path already filters out (`deleted_at IS NULL`)
 * and the one the Recycle Bin was taught to exclude explicitly. Nothing here commits, and
 * nothing here can: making a batch visible is two `UPDATE`s in one transaction that live in
 * `commit-files.ts`, and this file contains no statement that clears either column.
 *
 * There is deliberately **no transaction** around any of this, unlike the Brain sink. Two
 * reasons, and the first is decisive:
 *
 *   - **`PutObject` does not roll back.** A transaction spanning the uploads would give the
 *     illusion of atomicity over half the writes and none of the other half. Staging is what
 *     replaces it: a failure leaves rows nobody can see and objects the sweeper can find *via*
 *     those rows.
 *   - **The pool is `max: 10` behind PgBouncer in transaction mode.** An account's restore is
 *     minutes of uploading; holding a connection open across it would let ten restores exhaust
 *     the pool for every other request on the box.
 *
 * The `userId` is closed over at construction and never appears in an argument, so no code
 * path can widen the scope by passing a different one (§10).
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.5, §11.
 */

import { randomUUID } from "crypto";
import { Readable } from "stream";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import { db } from "@/shared/infrastructure/db";
import { fileContents, files, folders } from "@/shared/infrastructure/db/schema";
import { tiptapToPlainText } from "@/shared/lib/search/tiptap-text";
import { buildR2Key } from "@/shared/infrastructure/storage/r2-key";
import { putR2Object } from "@/shared/infrastructure/storage/r2-objects";
import {
  MIN_MULTIPART_PART_BYTES,
  uploadR2Stream,
} from "@/shared/infrastructure/storage/r2-stream";
import type {
  FilesImportSink,
  StagedBody,
  StagedFile,
  StagedFolder,
} from "@backup/account/application/import-types";

/** Rows per round trip for the two `merge` readers — the export source's own page size. */
const PAGE_ROWS = 500;

/**
 * The statuses a `merge` may match against.
 *
 * The same list the export reads (`files-source.ts`), and symmetrical on purpose: a restore
 * skips a file because the account already has it, so "already has it" must mean the same
 * thing in both directions. A row still uploading has no `checksum_sha256` to compare and may
 * never get one — treating it as present could skip the archive's copy in favour of bytes that
 * never arrive, which is the one outcome a restore may not produce. Worst case the archive's
 * copy lands beside it under `name (restored)`, and one of the two is deleted in a click.
 */
const READABLE_STATUSES = ["ready", "legacy_unverified"] as const;

/**
 * Part size for a staged upload: the smallest R2 will take.
 *
 * `uploadR2Stream` buffers exactly one part, so this is resident memory per concurrent
 * restore. The 64 MiB default is sized for one archive stream on a large box; a restore writes
 * user files one after another on a 2 GB VPS beside Postgres and a queue worker, and 5 MiB
 * parts still reach a 50 GB object — far above anything this app accepts on upload.
 */
const RESTORE_PART_BYTES = MIN_MULTIPART_PART_BYTES;

/** What a note is stored as, when the body turns out to be one (`app/api/files/route.ts`). */
const NOTE_MIME = "application/json";

/**
 * `/Photos/2026/` → `Photos/2026`, the spelling the archive and the importer both use.
 *
 * Shares its reasoning with `folderArchivePath` in `files-source.ts`: `materializedPath` is
 * stored with both separators, an archive path carries neither, and only the ends are touched.
 */
function archivePath(materializedPath: string): string {
  return materializedPath.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * A note's `r2_key`: a name for a row that has no object.
 *
 * `notes/` is not a prefix anything writes to — it is the marker `deleteR2Object` and
 * `deleteR2Objects` both skip — but `files.r2_key` is `NOT NULL`, and the app's own note
 * creation fills it exactly this way. The sweeper deleting a staged note therefore asks the
 * bucket for nothing.
 */
function noteKey(userId: string): string {
  return `notes/${userId}/${randomUUID()}`;
}

/**
 * One staged upload, including the case multipart cannot express.
 *
 * `uploadR2Stream` refuses a stream that produced no parts — correct for an archive, wrong
 * here, because a zero-byte file is an ordinary thing to have backed up. So the first chunk is
 * pulled before the upload starts: nothing at all means one `PutObject` of nothing, and
 * anything else is re-attached in front of the rest and streamed.
 *
 * The declared size is not consulted (§11). Whether the stream is empty is answered by reading
 * it, and the returned count is what was actually written — never what the archive claimed.
 */
async function writeObject(
  r2Key: string,
  contentType: string,
  bytes: AsyncIterable<Uint8Array>
): Promise<number> {
  const iterator = bytes[Symbol.asyncIterator]();
  const first = await iterator.next();

  if (first.done === true) {
    await putR2Object(r2Key, Buffer.alloc(0), contentType);
    return 0;
  }

  let written = 0;
  const counted = async function* (): AsyncGenerator<Buffer, void, void> {
    let piece: Uint8Array | undefined = first.value;
    for (;;) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
      written += chunk.length;
      yield chunk;
      const step = await iterator.next();
      if (step.done === true) return;
      piece = step.value;
    }
  };

  // `Readable.from` propagates a throw out of the generator — a payload that runs short mid
  // file aborts the multipart upload rather than completing a truncated object.
  await uploadR2Stream(r2Key, Readable.from(counted()), contentType, {
    partSize: RESTORE_PART_BYTES,
  });
  return written;
}

/**
 * The account's visible folders, as archive paths.
 *
 * At module scope rather than inside `drizzleFilesSink` because it reads and writes nothing that
 * belongs to a batch: `deleted_at IS NULL` already excludes every staged row, including the
 * caller's own, so the importer is never offered a folder it created a moment ago as a match
 * candidate — its `tree` cache owns those. Hoisting it lets the §7.2 split preview ask the same
 * question without constructing a write sink, which is the only way the preview's numbers and
 * the restore's decisions can be guaranteed to agree.
 */
export async function* liveAccountFolders(
  userId: string
): AsyncIterable<{ path: string; id: string }> {
  let cursor: string | null = null;
  for (;;) {
    const page = await db
      .select({ id: folders.id, materializedPath: folders.materializedPath })
      .from(folders)
      .where(
        and(
          eq(folders.userId, userId),
          isNull(folders.deletedAt),
          ...(cursor === null ? [] : [gt(folders.id, cursor)])
        )
      )
      .orderBy(asc(folders.id))
      .limit(PAGE_ROWS);

    for (const row of page) {
      yield { path: archivePath(row.materializedPath), id: row.id };
    }

    if (page.length < PAGE_ROWS) return;
    cursor = page[page.length - 1].id;
  }
}

/** The account's visible files, as archive paths plus the digest a `merge` compares. */
export async function* liveAccountFiles(
  userId: string
): AsyncIterable<{ path: string; sha256: string | null }> {
  let cursor: string | null = null;
  for (;;) {
    const page = await db
      .select({
        id: files.id,
        name: files.name,
        checksumSha256: files.checksumSha256,
        folderPath: folders.materializedPath,
      })
      .from(files)
      .leftJoin(folders, eq(files.folderId, folders.id))
      .where(
        and(
          eq(files.userId, userId),
          isNull(files.deletedAt),
          inArray(files.status, [...READABLE_STATUSES]),
          ...(cursor === null ? [] : [gt(files.id, cursor)])
        )
      )
      .orderBy(asc(files.id))
      .limit(PAGE_ROWS);

    for (const row of page) {
      const parent = row.folderPath ? archivePath(row.folderPath) : "";
      yield {
        path: parent.length > 0 ? `${parent}/${row.name}` : row.name,
        sha256: row.checksumSha256,
      };
    }

    if (page.length < PAGE_ROWS) return;
    cursor = page[page.length - 1].id;
  }
}

export function drizzleFilesSink(input: {
  userId: string;
  restoreBatchId: string;
}): FilesImportSink {
  const { userId, restoreBatchId } = input;

  /** The two columns that make a row staged. Written together, cleared together. */
  const staged = () => ({ deletedAt: new Date(), restoreBatchId });

  async function createFolder(row: StagedFolder): Promise<string> {
    const [inserted] = await db
      .insert(folders)
      .values({
        userId,
        parentId: row.parentId,
        name: row.name,
        // Both computed by the importer from the parent chain it walked, never carried by
        // the archive (§11). This layer only stores them.
        materializedPath: row.materializedPath,
        depth: row.depth,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        ...staged(),
      })
      .returning({ id: folders.id });

    if (inserted === undefined) {
      // `INSERT … RETURNING` returning nothing is not a case Postgres produces; a throw here
      // is a bug caught rather than a `null` parent silently reparenting a subtree to the root.
      throw new Error("staged folder insert returned no row");
    }
    return inserted.id;
  }

  async function createFile(row: StagedFile, body: StagedBody): Promise<void> {
    const fileId = randomUUID();
    const isNote = body.kind === "note";
    const now = new Date();

    // The row goes in **before** the object, and the id is minted here rather than by the
    // database so the key is known in advance. The row is the sweeper's only handle on a
    // staged object: an upload under a row that was never written is an object nobody can
    // find and everybody keeps paying for.
    await db.insert(files).values({
      id: fileId,
      userId,
      folderId: row.folderId,
      name: row.name,
      mimeType: isNote ? NOTE_MIME : row.mime,
      // A note bills nothing, exactly as the app's own notes do — its body is a row, not an
      // object, and `recalculateUsedBytes` sums this column. For an object this is the
      // archive's declared size, corrected below to what was actually written.
      sizeBytes: isNote ? 0 : row.size,
      r2Key: isNote ? noteKey(userId) : buildR2Key(userId, fileId, row.name),
      // Ready and verified: these bytes came with a digest the importer checks against the
      // INDEX, which is a stronger statement than the upload path's own reconciliation makes.
      status: "ready",
      checksumSha256: row.sha256,
      completedAt: now,
      verifiedAt: now,
      isNote,
      version: 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      ...staged(),
    });

    if (body.kind === "note") {
      await db.insert(fileContents).values({
        fileId,
        contentJson: body.content ?? null,
        annotationsJson: body.annotations ?? null,
      });
      // The FTS vector is generated from `content_text`, so a restored note is searchable
      // the moment it is committed rather than after the next edit.
      const text = tiptapToPlainText(body.content);
      if (text.length > 0) {
        await db.update(files).set({ contentText: text }).where(eq(files.id, fileId));
      }
      return;
    }

    const written = await writeObject(
      buildR2Key(userId, fileId, row.name),
      row.mime,
      body.bytes
    );
    if (written !== row.size) {
      // The importer refuses the whole restore on the very next line — `assertHandedOver`
      // compares the same two numbers — so this correction is only ever read by whoever
      // inspects the staged rows afterwards. Storing the archive's claim instead would put a
      // number in the quota column that no object backs.
      await db.update(files).set({ sizeBytes: written }).where(eq(files.id, fileId));
    }
  }

  return {
    liveFolders: () => liveAccountFolders(userId),
    liveFiles: () => liveAccountFiles(userId),
    createFolder,
    createFile,
  };
}
