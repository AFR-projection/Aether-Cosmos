import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth/session";
import { SECURITY_HEADERS } from "@/lib/security";
import { UploadServiceError } from "@/lib/storage/upload-service";
import { BrainError } from "@/lib/brain/errors";
import { BodyInvalidJsonError, BodyTooLargeError } from "@/lib/api/read-body";

export function apiSuccess<T>(data: T, status = 200, extraHeaders?: HeadersInit) {
  return NextResponse.json({ success: true, data }, { status, headers: { ...SECURITY_HEADERS, ...extraHeaders } });
}

export function apiError(
  message: string,
  status = 400,
  extra?: { code?: string; [key: string]: unknown }
) {
  return NextResponse.json(
    { success: false, error: message, ...(extra ?? {}) },
    { status, headers: SECURITY_HEADERS }
  );
}

/** Map a Postgres unique-constraint index name to a friendly, specific message. */
function uniqueViolationMessage(constraint: string | undefined): string {
  if (!constraint) return "That value is already in use by another account.";
  if (constraint.includes("email")) return "That email is already registered to another user.";
  if (constraint.includes("phone")) return "That phone number is already registered to another user.";
  if (constraint.includes("username")) return "That username is already taken.";
  return "That value is already in use.";
}

export function handleApiError(error: unknown) {
  if (error instanceof BodyTooLargeError) {
    return apiError("Request body too large", 413, {
      code: "BODY_TOO_LARGE",
      maxBytes: error.maxBytes,
    });
  }
  if (error instanceof UploadServiceError) {
    return apiError(error.message, error.status, { code: error.code });
  }
  if (error instanceof BrainError) {
    return apiError(error.message, error.status, { code: error.code });
  }
  if (error instanceof AuthError) {
    return apiError(error.message, error.status, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.previousIp ? { previousIp: error.previousIp } : {}),
      ...(error.currentIp ? { currentIp: error.currentIp } : {}),
    });
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first?.path.join(".") || "input";
    return apiError(`${field}: ${first?.message ?? "Invalid input"}`, 400, {
      code: "VALIDATION_ERROR",
    });
  }
  // A body that is not JSON is the caller's mistake, not ours: `request.json()`
  // throws a SyntaxError, which used to fall through to a 500 (and a logged stack)
  // on every route that parses a body — including an empty DELETE body.
  if (error instanceof SyntaxError && /JSON/i.test(error.message)) {
    return apiError("Request body must be valid JSON", 400, { code: "INVALID_JSON" });
  }
  if (error instanceof BodyInvalidJsonError) {
    return apiError("Request body must be valid JSON", 400, { code: "INVALID_JSON" });
  }
  // Postgres unique-constraint violation (23505) — surface a clear 409 instead of
  // a generic 500, so e.g. "email already registered" is actionable, not a mystery.
  const pg = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = pg?.code ?? pg?.cause?.code;
  if (code === "23505") {
    const constraint = pg?.constraint ?? pg?.cause?.constraint;
    return apiError(uniqueViolationMessage(constraint), 409, { code: "DUPLICATE" });
  }
  /**
   * 22P02 — "invalid input syntax for type …". A route that takes an id from the
   * path and hands it to a `uuid` column produced this for any caller who typed
   * something that is not a UUID: `GET /api/webhooks/banana` was a 500 with a
   * logged stack, not a 404. The id never reached a row, so nothing was written
   * and there is nothing to roll back — it is a malformed request, and 400 is the
   * honest answer.
   *
   * Still logged: the same code comes from a bad server-side cast, and that is a
   * bug worth seeing rather than a client mistake worth hiding.
   */
  if (code === "22P02") {
    console.error("[api] invalid input syntax", error);
    return apiError("Malformed identifier", 400, { code: "INVALID_ID" });
  }
  console.error(error);
  return apiError("Internal server error", 500);
}
