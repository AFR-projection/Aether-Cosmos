/**
 * Reading an object body into memory with a ceiling.
 *
 * Every place that pulls a whole R2 object into a `Buffer` shares the same hazard:
 * the size in the `files` row is uploader-declared on the legacy presign path, so
 * it is a hint, not a bound. The count that decides is the one taken here, while
 * reading — and when it is crossed the transfer is abandoned rather than drained,
 * because the point is to not spend the memory (or the bandwidth).
 */

export class StreamTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Stream exceeds ${maxBytes} bytes`);
    this.name = "StreamTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Drain a web `ReadableStream` or a Node stream into one Buffer, refusing past
 * `maxBytes`.
 *
 * `makeError` lets a caller surface its own error type — the archive endpoints map
 * theirs onto a 413 with an archive-specific code.
 */
export async function readStreamBounded(
  body: unknown,
  maxBytes: number,
  makeError: (maxBytes: number) => Error = (max) => new StreamTooLargeError(max)
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  const take = (chunk: Uint8Array) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw makeError(maxBytes);
    }
    chunks.push(Buffer.from(chunk));
  };

  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) take(value);
      }
    } finally {
      // Abandon the rest of the object instead of paying for it.
      reader.cancel().catch(() => {});
    }
  } else if (
    !!body &&
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  ) {
    const stream = body as AsyncIterable<Uint8Array> & { destroy?: (e?: Error) => void };
    try {
      for await (const chunk of stream) {
        take(chunk);
      }
    } catch (error) {
      stream.destroy?.(error instanceof Error ? error : undefined);
      throw error;
    }
  } else {
    throw new TypeError("Unsupported stream type");
  }

  return Buffer.concat(chunks);
}
