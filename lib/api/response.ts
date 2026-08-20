import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth/session";
import { SECURITY_HEADERS } from "@/lib/security";
import { UploadServiceError } from "@/lib/storage/upload-service";
import { BrainError } from "@/lib/brain/errors";

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
  // Postgres unique-constraint violation (23505) — surface a clear 409 instead of
  // a generic 500, so e.g. "email already registered" is actionable, not a mystery.
  const pg = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = pg?.code ?? pg?.cause?.code;
  if (code === "23505") {
    const constraint = pg?.constraint ?? pg?.cause?.constraint;
    return apiError(uniqueViolationMessage(constraint), 409, { code: "DUPLICATE" });
  }
  console.error(error);
  return apiError("Internal server error", 500);
}
