/**
 * The files export: a folder tree and its bytes, measured then streamed.
 *
 * Two passes over one in-memory list, and the list is the reason this file is shaped the
 * way it is. The format puts INDEX ahead of CHUNKS, so every path, size, and digest has to
 * be known before the first payload byte goes out — but the payload itself must never be
 * held, because an account is allowed to be larger than the machine's memory. So the pass
 * that measures keeps the *entries* (a few hundred bytes each, bounded by the row caps of
 * §9) and throws the bytes away; the pass that streams reads the bytes again and checks
 * them against what the INDEX already promised.
 *
 * That check is not ceremony. An archive whose INDEX says a file is 40 KiB when the
 * payload carries 39 is not a slightly wrong archive: the importer splits one long byte
 * stream by the sizes the INDEX declared, so a single byte of drift shifts every file
 * after it. The pass-two comparison is what makes that unrepresentable.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §11.
 */

import { createHash } from "crypto";

import { AFR_MAX_INDEX_BYTES } from "@backup/account/domain/archive";
import {
  AccountBackupBadNameError,
  AccountBackupChangedError,
  AccountBackupEncryptedFilesError,
  AccountBackupError,
  AccountBackupFileUnreadableError,
  AccountBackupTooBigError,
} from "@backup/account/domain/errors";
import { safeLabel } from "@backup/account/domain/fields";
import {
  AFR_MAX_MIME_CHARS,
  encodeFilesEntry,
  parseArchivePath,
  type AfrFileEntry,
  type AfrFilesEntry,
} from "@backup/account/domain/index-entries";
import { AFR_FILE_ROW_CAP, AFR_FOLDER_ROW_CAP } from "@backup/account/domain/summary";
import type {
  AccountExportPlan,
  ExportFileBody,
  ExportFileRow,
  ExportFolderRow,
  FilesExportSource,
} from "@backup/account/application/export-types";

/** The generic fallback, which the importer would re-derive from the name anyway. */
const FALLBACK_MIME = "application/octet-stream";

/** Written as escapes, matching `fields.ts` — the set that is never content. */
const NEVER_IN_MIME = new RegExp(
  "[\\u0000-\\u001F\\u007F\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]"
);

/** One measured file: what the INDEX said about it, and where to read it again. */
interface MeasuredFile {
  entry: AfrFileEntry;
  id: string;
  body: ExportFileBody;
}

/**
 * A stored type the archive can carry, or the generic one.
 *
 * Unlike a name, a mime type is not content: it is a guess the upload path made, and the
 * importer re-decides `Content-Type` on the way back in. So a legacy row holding something
 * the format cannot spell is downgraded rather than refused — refusing would block a
 * backup over a header nobody reads.
 */
function exportMime(mime: string): string {
  if (mime.length === 0 || mime.length > AFR_MAX_MIME_CHARS || NEVER_IN_MIME.test(mime)) {
    return FALLBACK_MIME;
  }
  return mime;
}

/**
 * The archive's path validator, run on our own rows on the way out.
 *
 * Running it here rather than trusting the database is the whole point: the validator is
 * stricter than the upload path (§11), so a row written before those checks existed can
 * hold a name this format has no way to spell. Writing it anyway would produce a file the
 * importer refuses — a backup that is not one — so the export stops and names it.
 */
function checkExportPath(path: string, what: string): void {
  let segments: string[];
  try {
    segments = parseArchivePath(path, what);
  } catch (error) {
    if (error instanceof AccountBackupError) {
      throw new AccountBackupBadNameError(safeLabel(path), `${what}: ${error.detail}`);
    }
    throw error;
  }
  if (segments.length === 0) {
    throw new AccountBackupBadNameError(safeLabel(path), `${what}: path names nothing`);
  }
}

/**
 * Epoch milliseconds the format will accept: never zero, never past the year 9999.
 *
 * The bound is the INDEX decoder's own, inclusive, and the two have to be the same number:
 * a millisecond this function passes and `decodeFilesEntry` refuses would be an archive we
 * write and cannot read back.
 */
function exportTime(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= 253_402_300_799_000
    ? value
    : fallback;
}

/** Digest and length of a stream, kept; bytes, discarded. */
async function measureStream(
  source: AsyncIterable<Uint8Array>
): Promise<{ size: number; sha256: Buffer }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const piece of source) {
    hash.update(piece);
    size += piece.length;
  }
  return { size, sha256: hash.digest() };
}

/** The same two numbers for whichever of the two places this file's bytes live in. */
async function measureBody(
  source: FilesExportSource,
  row: ExportFileRow
): Promise<{ size: number; sha256: Buffer }> {
  if (row.body.kind === "note") {
    const body = await source.noteBody(row.id);
    return { size: body.length, sha256: createHash("sha256").update(body).digest() };
  }
  return measureStream(source.openObject(row.body.r2Key));
}

/**
 * `measureBody`, with the one refusal that needs a name attached.
 *
 * The source cannot phrase this message itself: it knows an R2 key, which is internal and
 * is not what the user called the file. So it raises the refusal with a null label and the
 * key in `detail`, and the label is filled in here, where the path is in hand — the same
 * shape `checkExportPath` uses for a name the format cannot spell.
 */
async function measureNamedBody(
  source: FilesExportSource,
  row: ExportFileRow
): Promise<{ size: number; sha256: Buffer }> {
  try {
    return await measureBody(source, row);
  } catch (error) {
    if (error instanceof AccountBackupFileUnreadableError) {
      throw new AccountBackupFileUnreadableError(safeLabel(row.path), error.detail);
    }
    throw error;
  }
}

export async function planFilesExport(source: FilesExportSource): Promise<AccountExportPlan> {
  const folders: ExportFolderRow[] = [];
  for await (const row of source.folders()) {
    checkExportPath(row.path, "folder");
    folders.push(row);
    if (folders.length > AFR_FOLDER_ROW_CAP) {
      throw new AccountBackupTooBigError(`more than ${AFR_FOLDER_ROW_CAP} folders`);
    }
  }

  const rows: ExportFileRow[] = [];
  let encryptedCount = 0;
  for await (const row of source.files()) {
    if (row.encrypted) {
      // Counted rather than refused on the first one, so the message can say how many
      // files the user has to deal with instead of making them find them one at a time.
      encryptedCount += 1;
      continue;
    }
    checkExportPath(row.path, "file");
    rows.push(row);
    if (rows.length > AFR_FILE_ROW_CAP) {
      throw new AccountBackupTooBigError(`more than ${AFR_FILE_ROW_CAP} files`);
    }
  }
  if (encryptedCount > 0) {
    throw new AccountBackupEncryptedFilesError(encryptedCount);
  }

  // Sorted before anything is measured, because this order is the contract between the
  // two passes: the payload is the file bodies concatenated in exactly the order the INDEX
  // lists them. Sorting by path also puts every parent ahead of its children for free, a
  // prefix being shorter than what extends it.
  folders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const lines: Buffer[] = [];
  let indexBytes = 0;
  let oldest = Number.MAX_SAFE_INTEGER;
  let newest = 0;

  const push = (entry: AfrFilesEntry): void => {
    const line = encodeFilesEntry(entry);
    indexBytes += line.length;
    if (indexBytes > AFR_MAX_INDEX_BYTES) {
      // Before a single payload byte, and before the rest of the measuring pass: an
      // account this shape cannot produce a readable archive no matter how long we spend
      // hashing it.
      throw new AccountBackupTooBigError(
        `index exceeds ${AFR_MAX_INDEX_BYTES} bytes at ${lines.length} entries`
      );
    }
    lines.push(line);
    oldest = Math.min(oldest, entry.createdAt, entry.updatedAt);
    newest = Math.max(newest, entry.createdAt, entry.updatedAt);
  };

  const now = Date.now();
  for (const folder of folders) {
    push({
      kind: "folder",
      path: folder.path,
      createdAt: exportTime(folder.createdAt, now),
      updatedAt: exportTime(folder.updatedAt, now),
    });
  }

  const measured: MeasuredFile[] = [];
  let totalBytes = 0;
  for (const row of rows) {
    const { size, sha256 } = await measureNamedBody(source, row);
    const entry: AfrFileEntry = {
      kind: "file",
      path: row.path,
      size,
      sha256,
      mime: exportMime(row.mime),
      createdAt: exportTime(row.createdAt, now),
      updatedAt: exportTime(row.updatedAt, now),
    };
    push(entry);
    measured.push({ entry, id: row.id, body: row.body });
    totalBytes += size;
  }

  return {
    domain: "files",
    index: Buffer.concat(lines),
    counts: {
      folders: folders.length,
      files: measured.length,
      memories: 0,
      rows: folders.length + measured.length,
    },
    dateRange: newest > 0 ? { from: oldest, to: newest } : undefined,
    totalBytes,
    payload: () => streamFilesPayload(source, measured),
  };
}

/**
 * The second pass.
 *
 * Every file is re-read and re-hashed, and both numbers are compared to what the INDEX
 * already committed to. A mismatch means the account changed underneath the export —
 * a note rewritten, an object replaced — and the only safe response is to abandon the
 * stream: the bytes already sent cannot be recalled, so an archive that continues here is
 * one whose table of contents describes a file it does not carry.
 */
async function* streamFilesPayload(
  source: FilesExportSource,
  measured: readonly MeasuredFile[]
): AsyncGenerator<Uint8Array, void, void> {
  for (const file of measured) {
    const hash = createHash("sha256");
    let sent = 0;

    try {
      if (file.body.kind === "note") {
        const body = await source.noteBody(file.id);
        hash.update(body);
        sent = body.length;
        if (body.length > 0) yield body;
      } else {
        for await (const piece of source.openObject(file.body.r2Key)) {
          hash.update(piece);
          sent += piece.length;
          if (piece.length > 0) yield piece;
        }
      }
    } catch (error) {
      // Readable when the INDEX was built, gone now. That is the account changing
      // underneath the export, not the inconsistency `measureNamedBody` refuses, so it
      // gets the refusal whose advice — run it again — is the correct advice.
      if (error instanceof AccountBackupFileUnreadableError) {
        throw new AccountBackupChangedError(
          `${safeLabel(file.entry.path)} left storage while streaming`
        );
      }
      throw error;
    }

    if (sent !== file.entry.size) {
      throw new AccountBackupChangedError(
        `${safeLabel(file.entry.path)} was ${file.entry.size} bytes, streamed ${sent}`
      );
    }
    if (!hash.digest().equals(file.entry.sha256)) {
      throw new AccountBackupChangedError(`${safeLabel(file.entry.path)} changed while streaming`);
    }
  }
}
