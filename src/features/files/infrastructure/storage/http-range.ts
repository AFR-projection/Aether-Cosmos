import { Readable } from "node:stream";
/**
 * HTTP `Range` parsing for the byte-serving routes.
 *
 * This lived inline in `app/api/files/[id]/preview/route.ts` while
 * `app/api/shared/[token]/preview/route.ts` — the *public* one — advertised
 * `Accept-Ranges: bytes`, read the header only to decide whether to charge the
 * share's access budget, and then ignored it and streamed the whole object with a
 * `200`. So `Range: bytes=1-` was a free, repeatable full download: the exemption
 * was granted for a continuation that never happened.
 *
 * One parser, used by both, so a range that exempts a request is a range that was
 * actually served.
 */

export type ParsedRange = {
  start: number;
  end: number;
  /** The `Range` value to forward to R2. */
  byteRange: string;
};

/**
 * Parse a single-range `bytes=` header against a known object size.
 * Returns null for a syntactically invalid, multi-range or unsatisfiable header —
 * callers treat that as "no range", i.e. a full response.
 */
export function parseRangeHeader(
  rangeHeader: string,
  totalSize: number
): ParsedRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;
  if (!Number.isFinite(totalSize) || totalSize <= 0) return null;

  let start = match[1] ? parseInt(match[1], 10) : NaN;
  let end = match[2] ? parseInt(match[2], 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    // suffix range: bytes=-500
    const suffixLength = end;
    if (Number.isNaN(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else if (Number.isNaN(end)) {
    end = totalSize - 1;
  }

  if (start < 0 || end < start || start >= totalSize) return null;
  end = Math.min(end, totalSize - 1);

  return { start, end, byteRange: `bytes=${start}-${end}` };
}

/** Bytes a response for this range will actually carry. */
export function rangeLength(range: ParsedRange): number {
  return range.end - range.start + 1;
}

/**
 * A range that continues an earlier transfer rather than starting one.
 * `bytes=0-…` is a fresh transfer that happens to be chunked, not a resume.
 */
export function isContinuationRange(range: ParsedRange | null): boolean {
  return range !== null && range.start > 0;
}

/**
 * Normalize the several body shapes the S3 client can hand back.
 *
 * The Node-stream branch used to attach a `data` listener and `controller.enqueue` every chunk the
 * moment it arrived. Nothing in that consulted the consumer, so it was not a stream, it was a copy:
 * a `bytes=0-` request for a 123 MB video pulled all 123 MB into the controller's queue before the
 * browser had read the second chunk. On a 2 GB box also running the worker, nginx and Redis, that is
 * enough GC pressure to stall the event loop — and a stalled event loop delays every OTHER request,
 * which is how one large video made the whole app stutter rather than just that one playback.
 *
 * `Readable.toWeb` does the pull-based plumbing properly: the source stays paused until the consumer
 * asks for more. `http-range.test.ts` pins that by counting how much a source produces while nobody
 * is reading.
 */
export function toReadableStream(body: unknown): ReadableStream {
  if (body instanceof ReadableStream) return body;
  if (
    body &&
    typeof body === "object" &&
    "pipe" in body &&
    typeof (body as { pipe: unknown }).pipe === "function"
  ) {
    return Readable.toWeb(body as Readable) as ReadableStream;
  }
  return body as ReadableStream;
}
