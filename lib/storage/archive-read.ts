import type JSZip from "jszip";
import { apiError } from "@/lib/api/response";
import { readStreamBounded } from "@/lib/storage/read-bounded";

/**
 * Bounds for looking inside an archive.
 *
 * The listing and extract endpoints both pulled the WHOLE object out of R2 into a
 * single `Buffer` and then handed it to JSZip, with no ceiling anywhere. Two
 * consequences, both reachable by any signed-in user against their own files:
 *
 *  - a large upload (multi-GB ZIP) turns one request into a multi-GB allocation
 *    in the shared Node process — the process dies for everyone, not just the
 *    caller;
 *  - a decompression bomb (a few MB that expands to many GB) does the same thing
 *    on the extract path, where the entry is fully decompressed in memory.
 *
 * So the container is read through a byte ceiling, and an entry is decompressed
 * through a second one. Both refuse with 413 rather than failing later as an
 * out-of-memory crash.
 */

/** Largest archive we will parse at all. */
export const ARCHIVE_INSPECT_MAX_BYTES = 128 * 1024 * 1024;

/** Largest single entry we will decompress into memory. */
export const ARCHIVE_ENTRY_MAX_BYTES = 64 * 1024 * 1024;

export class ArchiveTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Archive exceeds ${maxBytes} bytes`);
    this.name = "ArchiveTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class ArchiveEntryTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Archive entry exceeds ${maxBytes} bytes when decompressed`);
    this.name = "ArchiveEntryTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/** Map the two size errors onto responses; returns null for anything else. */
export function archiveErrorResponse(error: unknown) {
  if (error instanceof ArchiveTooLargeError) {
    return apiError(
      "This archive is too large to open on the server — download it and open it on your computer",
      413,
      { code: "ARCHIVE_TOO_LARGE", maxBytes: error.maxBytes }
    );
  }
  if (error instanceof ArchiveEntryTooLargeError) {
    return apiError("A file inside this archive is too large to open on the server", 413, {
      code: "ARCHIVE_ENTRY_TOO_LARGE",
      maxBytes: error.maxBytes,
    });
  }
  return null;
}

/** The 413 for "this archive is too big to open server-side", ready to return. */
export function archiveTooLargeResponse(maxBytes: number = ARCHIVE_INSPECT_MAX_BYTES) {
  return archiveErrorResponse(new ArchiveTooLargeError(maxBytes))!;
}

/**
 * Drain an R2 body into one Buffer, refusing past `maxBytes`.
 *
 * The object size recorded in the database is a hint, not a guarantee (it is
 * declared by the uploader on the legacy presign path), so the count that matters
 * is the one taken while reading.
 */
export async function readArchiveBuffer(
  body: unknown,
  maxBytes: number = ARCHIVE_INSPECT_MAX_BYTES
): Promise<Buffer> {
  return readStreamBounded(body, maxBytes, (max) => new ArchiveTooLargeError(max));
}

/** The uncompressed size the archive claims for an entry, when it states one. */
export function declaredEntrySize(entry: JSZip.JSZipObject): number | null {
  const raw = entry as JSZip.JSZipObject & {
    uncompressedSize?: number;
    _data?: { uncompressedSize?: number };
  };
  const size = raw.uncompressedSize ?? raw._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

/**
 * JSZip's incremental reader. It exists at runtime but is absent from the shipped
 * typings, and it is the only way to see the inflater's output as it arrives —
 * `entry.async()` hands back the whole thing, which is exactly the problem.
 */
type EntryStream = {
  on(event: "data", handler: (chunk: Uint8Array) => void): EntryStream;
  on(event: "error", handler: (error: Error) => void): EntryStream;
  on(event: "end", handler: () => void): EntryStream;
  resume(): EntryStream;
  pause(): EntryStream;
};

function internalStreamOf(entry: JSZip.JSZipObject): EntryStream {
  return (
    entry as JSZip.JSZipObject & {
      internalStream(type: "uint8array"): EntryStream;
    }
  ).internalStream("uint8array");
}

/**
 * Decompress one entry with a hard ceiling.
 *
 * The declared size is checked first because it is free, but a crafted archive can
 * simply lie about it — so the real limit is applied to the bytes as they come out
 * of the inflater, and the stream is paused the moment it is crossed.
 */
export async function readEntryBounded(
  entry: JSZip.JSZipObject,
  maxBytes: number = ARCHIVE_ENTRY_MAX_BYTES
): Promise<Uint8Array> {
  const declared = declaredEntrySize(entry);
  if (declared !== null && declared > maxBytes) {
    throw new ArchiveEntryTooLargeError(maxBytes);
  }

  const stream = internalStreamOf(entry);
  const parts: Uint8Array[] = [];
  let total = 0;
  let settled = false;

  return new Promise<Uint8Array>((resolve, reject) => {
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };

    stream
      .on("data", (chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          fail(new ArchiveEntryTooLargeError(maxBytes));
          return;
        }
        parts.push(chunk);
      })
      .on("error", (error: Error) => fail(error))
      .on("end", () => {
        if (settled) return;
        settled = true;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.length;
        }
        resolve(out);
      })
      .resume();
  });
}
