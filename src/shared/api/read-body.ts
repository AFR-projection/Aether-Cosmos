/**
 * Reading a request body with a ceiling.
 *
 * `await request.json()` / `await request.text()` buffer whatever the client sends.
 * On an authenticated route that is a nuisance; on the two UNAUTHENTICATED OAuth
 * endpoints (`POST /api/oauth/token` and `POST /api/oauth/register`, both reached
 * through `parseOAuthBody`) it is a way for anyone on the internet to turn one
 * request into an arbitrarily large allocation in the shared Node process. No
 * `Content-Length` check helps on its own: the header is absent under
 * `Transfer-Encoding: chunked` and it can simply lie.
 *
 * So the declared length is used as a free early refusal, and the real limit is
 * applied to the bytes as they arrive.
 */

import { readStreamBounded, StreamTooLargeError } from "@/shared/lib/stream/read-bounded";

/** Plenty for an OAuth form post, a token request, or a client registration. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Lives here, next to `BodyTooLargeError`, so `handleApiError` can map both
 * without importing from `src/shared/api/body.ts` (which imports `apiError` from
 * `src/shared/api/response.ts` — that would be a cycle).
 */
export class BodyInvalidJsonError extends Error {
  constructor() {
    super("Request body is not valid JSON");
    this.name = "BodyInvalidJsonError";
  }
}

/** Read the body as text, refusing past `maxBytes`. */
export async function readBoundedText(
  request: Request,
  maxBytes: number = MAX_REQUEST_BODY_BYTES
): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  if (!request.body) return "";

  try {
    const buffer = await readStreamBounded(
      request.body,
      maxBytes,
      (max) => new BodyTooLargeError(max)
    );
    return buffer.toString("utf8");
  } catch (error) {
    // A caller that hands us something other than a stream still gets the ceiling,
    // just via the framework's own buffering.
    if (error instanceof TypeError) {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new BodyTooLargeError(maxBytes);
      return text;
    }
    if (error instanceof StreamTooLargeError) throw new BodyTooLargeError(maxBytes);
    throw error;
  }
}

/**
 * Read the body as JSON, refusing past `maxBytes`.
 *
 * An empty body parses as `{}` so a caller can treat "no body" as "no fields" —
 * `JSON.parse("")` throws, which used to surface as a 500.
 */
export async function readBoundedJson(
  request: Request,
  maxBytes: number = MAX_REQUEST_BODY_BYTES
): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  if (!text.trim()) return {};
  return JSON.parse(text);
}
