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

/** Normalize the several body shapes the S3 client can hand back. */
export function toReadableStream(body: unknown): ReadableStream {
  if (body instanceof ReadableStream) return body;
  if (
    body &&
    typeof body === "object" &&
    "pipe" in body &&
    typeof (body as { pipe: unknown }).pipe === "function"
  ) {
    return new ReadableStream({
      start(controller) {
        const nodeStream = body as NodeJS.ReadableStream & {
          on: (event: string, cb: (...args: unknown[]) => void) => void;
        };
        nodeStream.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err: Error) => controller.error(err));
      },
    });
  }
  return body as ReadableStream;
}
