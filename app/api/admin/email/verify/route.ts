import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { mailSenders } from "@/lib/db/schema";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { validateCsrf } from "@/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/lib/api/response";
import { decryptSecret } from "@/lib/email/crypto";
import { verifyCredentials, evictTransport } from "@/lib/email/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-test a saved sender's Gmail credentials with a live SMTP handshake and
 * persist the fresh status. Lets an admin re-check a sender that previously
 * errored (e.g. after fixing 2-Step Verification) without re-entering the password.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "email");
    const { id } = z.object({ id: z.string().uuid() }).parse(await request.json());

    const [sender] = await db.select().from(mailSenders).where(eq(mailSenders.id, id));
    if (!sender) return apiError("Sender not found", 404);

    let appPassword: string;
    try {
      appPassword = decryptSecret(sender.appPasswordEncrypted);
    } catch {
      return apiError("Stored credential is unreadable — please re-enter the App Password", 400);
    }

    const verify = await verifyCredentials(sender.email, appPassword);
    evictTransport(id);

    await db
      .update(mailSenders)
      .set({
        status: verify.ok ? "ok" : "error",
        lastError: verify.ok ? null : verify.error,
        lastVerifiedAt: verify.ok ? new Date() : sender.lastVerifiedAt,
        updatedAt: new Date(),
      })
      .where(eq(mailSenders.id, id));

    return apiSuccess({ verify });
  } catch (error) {
    return handleApiError(error);
  }
}
