import { apiError } from "@/shared/api/response";
import { BodyInvalidJsonError, BodyTooLargeError } from "@/shared/api/read-body";

/**
 * Bounded JSON body reader.
 *
 * `request.json()` buffers whatever arrives. On the routes a signed-out caller
 * can reach — the shared-note editor being the clearest case — that turns a
 * single request into an unbounded server-side allocation, and a `content-length`
 * header alone is no defence because a chunked sender need not send one (or need
 * not tell the truth).
 *
 * So the body is drained through the stream with a hard byte ceiling and the read
 * is abandoned the moment the ceiling is crossed.
 *
 * Both error classes are re-exported from `@/lib/api/read-body` rather than
 * declared again here. There were briefly two classes named `BodyTooLargeError`,
 * and `handleApiError` only knew one of them — so a route that used this reader
 * and left the error to the generic handler answered 500 instead of 413.
 */

export { BodyInvalidJsonError, BodyTooLargeError };

export async function readBoundedText(
  request: Request,
  maxBytes: number
): Promise<string> {
  // Trust the declared length only to reject early — never to allow.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Stop the sender rather than politely draining the rest of it.
    reader.cancel().catch(() => {});
  }

  return text + decoder.decode();
}

export async function readBoundedJson<T = unknown>(
  request: Request,
  maxBytes: number
): Promise<T> {
  const text = await readBoundedText(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BodyInvalidJsonError();
  }
}

/** Map the two body errors onto responses; returns null for anything else. */
export function bodyErrorResponse(error: unknown) {
  if (error instanceof BodyTooLargeError) {
    return apiError("Request body is too large", 413, { code: "BODY_TOO_LARGE" });
  }
  if (error instanceof BodyInvalidJsonError) {
    return apiError("Invalid JSON body", 400, { code: "INVALID_JSON" });
  }
  return null;
}
