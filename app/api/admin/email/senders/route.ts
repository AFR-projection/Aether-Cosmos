import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { mailSenders } from "@/lib/db/schema";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { validateCsrf } from "@/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/lib/api/response";
import { encryptSecret } from "@/lib/email/crypto";
import { verifyCredentials, evictTransport } from "@/lib/email/mailer";
import { normalizeEmail } from "@/lib/email/email-service";
import { APP_NAME } from "@/lib/app-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gmail App Passwords are 16 chars; Google shows them grouped as "xxxx xxxx xxxx xxxx". */
const createSchema = z.object({
  email: z.string().email(),
  appPassword: z.string().min(16).max(40),
  displayName: z.string().min(1).max(100),
  fromName: z.string().min(1).max(100).optional(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(100).optional(),
  fromName: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
  /** Optional password rotation — re-verified before saving. */
  appPassword: z.string().min(16).max(40).optional(),
});

/** Never leak the encrypted password to the client. */
function publicSender(row: typeof mailSenders.$inferSelect) {
  const { appPasswordEncrypted, ...rest } = row;
  void appPasswordEncrypted;
  return rest;
}

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "email");
    const rows = await db.select().from(mailSenders).orderBy(mailSenders.priority);
    return apiSuccess(rows.map(publicSender));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "email");
    const body = createSchema.parse(await request.json());
    const email = normalizeEmail(body.email);
    // Gmail shows App Passwords with spaces; strip them so login succeeds.
    const appPassword = body.appPassword.replace(/\s+/g, "");

    // Verify the credentials with a live SMTP handshake BEFORE persisting, so the
    // admin gets an immediate pass/fail instead of discovering it at OTP time.
    const verify = await verifyCredentials(email, appPassword);

    const [sender] = await db
      .insert(mailSenders)
      .values({
        email,
        appPasswordEncrypted: encryptSecret(appPassword),
        displayName: body.displayName,
        fromName: body.fromName ?? APP_NAME,
        status: verify.ok ? "ok" : "error",
        lastError: verify.ok ? null : verify.error,
        lastVerifiedAt: verify.ok ? new Date() : null,
      })
      .returning();

    return apiSuccess({ ...publicSender(sender), verify }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "email");
    const body = updateSchema.parse(await request.json());
    const { id, appPassword, ...rest } = body;

    const updates: Record<string, unknown> = { ...rest, updatedAt: new Date() };

    // Rotating the password re-verifies and re-encrypts.
    if (appPassword) {
      const [existing] = await db
        .select({ email: mailSenders.email })
        .from(mailSenders)
        .where(eq(mailSenders.id, id));
      if (!existing) return apiError("Sender not found", 404);

      const clean = appPassword.replace(/\s+/g, "");
      const verify = await verifyCredentials(existing.email, clean);
      updates.appPasswordEncrypted = encryptSecret(clean);
      updates.status = verify.ok ? "ok" : "error";
      updates.lastError = verify.ok ? null : verify.error;
      updates.lastVerifiedAt = verify.ok ? new Date() : null;
      evictTransport(id);
    }

    const [updated] = await db
      .update(mailSenders)
      .set(updates)
      .where(eq(mailSenders.id, id))
      .returning();

    if (!updated) return apiError("Sender not found", 404);
    return apiSuccess(publicSender(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "email");
    const { id } = z.object({ id: z.string().uuid() }).parse(await request.json());
    evictTransport(id);
    await db.delete(mailSenders).where(eq(mailSenders.id, id));
    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
