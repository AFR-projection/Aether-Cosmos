/**
 * `FilesExportSource` over this application's own tables and bucket.
 *
 * All policy lives upstream in `export-files.ts`; this file answers exactly one question —
 * *which rows belong to this caller* — and answers it the same way every read path in the
 * app already does: `user_id = $1`, `deleted_at IS NULL`, and a status the user can
 * actually see. The `userId` is closed over at construction and never appears in an
 * argument, so no code path can widen the scope by passing a different one.
 *
 * **Both readers are called twice**, once by the measuring pass and once by the streaming
 * pass (`export-types.ts`). Two properties make that safe:
 *
 *   - **A stable order.** Keyset pagination on the primary key — `WHERE id > $last ORDER BY
 *     id LIMIT n` — rather than a held cursor. A cursor would need one transaction open for
 *     the whole download, and this pool is `max: 10` behind PgBouncer in transaction mode,
 *     so ten concurrent exports would be the whole pool. `id` is a uuid primary key, so the
 *     order is total and an insert cannot shift a row that was already read.
 *   - **No held snapshot.** `folders()` and `files()` are read once each into memory by the
 *     measuring pass (they are bounded by the row caps of §9), so the second pass never
 *     re-queries them; only `openObject` and `noteBody` run twice, and `export-files.ts`
 *     compares what they return against what the INDEX committed to.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §6.4.
 */

import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Readable } from "stream";

import { db } from "@/shared/infrastructure/db";
import { fileContents, files, folders } from "@/shared/infrastructure/db/schema";
import { downloadR2Stream } from "@/shared/infrastructure/storage/r2-stream";
import { AccountBackupFileUnreadableError } from "@backup/account/domain/errors";
import { rowJsonBytes, type RowValue } from "@backup/account/domain/row-json";
import { NOTE_BODY_KEYS } from "@backup/account/domain/tables";
import type {
  ExportFileRow,
  ExportFolderRow,
  FilesExportSource,
} from "@backup/account/application/export-types";

/**
 * Rows per round trip.
 *
 * Large enough that a ten-thousand-file account is twenty queries rather than ten
 * thousand, small enough that one page is tens of kilobytes. Only the *entries* are held —
 * the payload is streamed — so this bounds the query, not the export.
 */
const PAGE_ROWS = 500;

/**
 * The statuses the app shows.
 *
 * Not just `'ready'`: `app/api/files/route.ts`, `permissions.ts`, and the paste path all
 * treat `legacy_unverified` as a file the user has, so an archive that skipped it would
 * quietly omit files visible in the UI — which is the one thing a disaster-recovery
 * artifact may not do. A legacy row whose object turns out to be missing is refused by
 * name rather than skipped (see `openObject`).
 */
const READABLE_STATUSES = ["ready", "legacy_unverified"] as const;

/**
 * `/Photos/2026/` → `Photos/2026`.
 *
 * `materializedPath` is stored with a leading and a trailing separator (`pathUnder` in
 * `app/api/folders/route.ts`); an archive path carries neither. Only the ends are touched:
 * anything odd left in the middle — an empty segment from a legacy name — is for
 * `parseArchivePath` to refuse, which it does with the name attached.
 */
function folderArchivePath(materializedPath: string): string {
  return materializedPath.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Epoch milliseconds, for a column the schema declares `NOT NULL DEFAULT now()`. */
function epochMs(value: Date | null): number {
  return value === null ? 0 : value.getTime();
}

/**
 * Did storage say "no such object", as opposed to "not right now"?
 *
 * The distinction is the whole point of {@link AccountBackupFileUnreadableError}: a 404
 * means the row outlived its bytes and a human has to decide what to do about it, while a
 * timeout or a 502 means try later. Getting this wrong in the generous direction would
 * tell a user their file is gone every time the bucket hiccups, so the test is narrow and
 * everything else propagates untouched.
 */
function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shaped = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (shaped.name === "NoSuchKey" || shaped.name === "NotFound") return true;
  if (shaped.Code === "NoSuchKey" || shaped.Code === "NoSuchBucket") return true;
  return shaped.$metadata?.httpStatusCode === 404;
}

export function drizzleFilesSource(userId: string): FilesExportSource {
  async function* readFolders(): AsyncIterable<ExportFolderRow> {
    let cursor: string | null = null;
    for (;;) {
      const page = await db
        .select({
          id: folders.id,
          materializedPath: folders.materializedPath,
          createdAt: folders.createdAt,
          updatedAt: folders.updatedAt,
        })
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
        yield {
          path: folderArchivePath(row.materializedPath),
          createdAt: epochMs(row.createdAt),
          updatedAt: epochMs(row.updatedAt),
        };
      }

      if (page.length < PAGE_ROWS) return;
      cursor = page[page.length - 1].id;
    }
  }

  async function* readFiles(): AsyncIterable<ExportFileRow> {
    let cursor: string | null = null;
    for (;;) {
      // The join is deliberately NOT filtered on `folders.deleted_at`. Soft-deleting a
      // folder cascades to its files (`deletion-service.ts`), so a live file under a dead
      // folder is an inconsistency rather than a state the app produces — and the honest
      // response is to keep the location the row records, which the importer recreates
      // from the path anyway, instead of silently moving the file to the account root.
      const page = await db
        .select({
          id: files.id,
          name: files.name,
          mimeType: files.mimeType,
          isNote: files.isNote,
          r2Key: files.r2Key,
          encrypted: files.encrypted,
          createdAt: files.createdAt,
          updatedAt: files.updatedAt,
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
        const parent = row.folderPath ? folderArchivePath(row.folderPath) : "";
        yield {
          id: row.id,
          path: parent.length > 0 ? `${parent}/${row.name}` : row.name,
          mime: row.mimeType,
          createdAt: epochMs(row.createdAt),
          updatedAt: epochMs(row.updatedAt),
          encrypted: row.encrypted,
          body: row.isNote ? { kind: "note" } : { kind: "object", r2Key: row.r2Key },
        };
      }

      if (page.length < PAGE_ROWS) return;
      cursor = page[page.length - 1].id;
    }
  }

  async function* openObject(r2Key: string): AsyncIterable<Uint8Array> {
    let body: Readable | null;
    try {
      body = (await downloadR2Stream(r2Key)).body;
    } catch (error) {
      if (isMissingObject(error)) {
        // No label: this layer knows an R2 key, which is internal and is not what the user
        // named the file. `export-files.ts` re-raises with the path attached.
        throw new AccountBackupFileUnreadableError(null, `r2 object ${r2Key} is missing`);
      }
      throw error;
    }
    if (body === null) {
      throw new AccountBackupFileUnreadableError(null, `r2 object ${r2Key} has no body`);
    }

    // `for await` over a Node stream propagates a read error and destroys the stream when
    // the consumer stops early — which is exactly what has to happen when the archive is
    // abandoned mid-write, or the socket would stay open until the request times out.
    for await (const piece of body) {
      yield piece as Uint8Array;
    }
  }

  async function noteBody(fileId: string): Promise<Buffer> {
    const [row] = await db
      .select({
        contentJson: fileContents.contentJson,
        annotationsJson: fileContents.annotationsJson,
      })
      .from(fileContents)
      .where(eq(fileContents.fileId, fileId))
      .limit(1);

    // A note with no content row is an empty note, not a failure: the file exists and its
    // body is nothing. Both keys are always present so the digest of an empty note is a
    // fixed value rather than a shape that depends on which columns happened to be null.
    const [annotations, content] = NOTE_BODY_KEYS;
    return rowJsonBytes({
      [annotations]: (row?.annotationsJson ?? null) as RowValue,
      [content]: (row?.contentJson ?? null) as RowValue,
    });
  }

  return { folders: readFolders, files: readFiles, openObject, noteBody };
}
