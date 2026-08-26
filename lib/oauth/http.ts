import { BodyTooLargeError, readBoundedText } from "@/lib/api/read-body";

export function oauthJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function oauthError(
  error: string,
  description?: string,
  status = 400,
  extra?: Record<string, unknown>
): Response {
  return oauthJson({ error, error_description: description, ...extra }, status);
}

/**
 * Map a body that was refused for its size onto an RFC 6749 error, so the two
 * unauthenticated endpoints answer 413 instead of dying at 500 (or not at all).
 */
export function oauthBodyErrorResponse(error: unknown): Response | null {
  if (error instanceof BodyTooLargeError) {
    return oauthError("invalid_request", "Request body too large", 413);
  }
  if (error instanceof SyntaxError) {
    return oauthError("invalid_request", "Request body must be valid JSON", 400);
  }
  return null;
}

/**
 * Parse an OAuth request body — JSON or form-encoded — through a byte ceiling.
 *
 * `/api/oauth/token` and `/api/oauth/register` are reachable without any
 * credential, so an unbounded `request.json()` here let anyone on the internet
 * turn one request into an arbitrarily large allocation.
 */
export async function parseOAuthBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  const text = await readBoundedText(request);
  const out: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    if (!text.trim()) return out;
    const json = JSON.parse(text) as Record<string, unknown>;
    if (!json || typeof json !== "object" || Array.isArray(json)) return out;
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  for (const [k, v] of new URLSearchParams(text).entries()) out[k] = v;
  return out;
}
