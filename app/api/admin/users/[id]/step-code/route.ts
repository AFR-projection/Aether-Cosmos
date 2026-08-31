import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { getClientIp, destroyAllUserSessions } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { STEP_CODE_MAX_ATTEMPTS } from "@/shared/lib/security/step-code";

/**
 * Master controls for a single user's 2-Step Code.
 *
 * A master can never read or set a code — only clear the lockout, remove the
 * code so the user enrols again, or flag it as needing a change. Keeping "set"
 * out of the API means a compromised admin account still cannot walk straight
 * through a user's second layer.
 */

const actionSchema = z.object({
  action: z.enum(["unlock", "reset", "require_change"]),
  /** Also sign the user out everywhere — appropriate when a code may be known. */
  revokeSessions: z.boolean().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireMasterOrApiKey(request, "users");
    const { id } = await params;

    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return apiError("User not found", 404);

    const lockedUntil = user.stepCodeLockedUntil;
    const locked = !!lockedUntil && new Date(lockedUntil) > new Date();

    return apiSuccess({
      username: user.username,
      stepCode: {
        enabled: !!user.stepCodeHash,
        updatedAt: user.stepCodeUpdatedAt,
        mustChange: user.stepCodeMustChange,
        failedAttempts: user.stepCodeFailedAttempts,
        maxAttempts: STEP_CODE_MAX_ATTEMPTS,
        locked,
        lockedUntil: locked ? lockedUntil : null,
      },
      totp: { enabled: user.totpEnabled },
      password: {
        mustChange: user.mustChangePassword,
        failedAttempts: user.failedLoginAttempts,
        locked: !!user.lockedUntil && new Date(user.lockedUntil) > new Date(),
        lockedUntil: user.lockedUntil,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMasterOrApiKey(request, "users");
    const { id } = await params;
    const ip = getClientIp(request);
    const body = actionSchema.parse(await request.json());

    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return apiError("User not found", 404);

    let message: string;

    switch (body.action) {
      case "unlock":
        await db
          .update(users)
          .set({
            stepCodeFailedAttempts: 0,
            stepCodeLockedUntil: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, id));
        message = "2-Step Code unlocked";
        break;

      case "reset":
        // Clear the code entirely — the user picks a new one at next sign-in.
        // The recorded length goes with it, so the enrolment pad does not offer
        // slots sized for a code that no longer exists.
        await db
          .update(users)
          .set({
            stepCodeHash: null,
            stepCodeLength: null,
            stepCodeUpdatedAt: null,
            stepCodeFailedAttempts: 0,
            stepCodeLockedUntil: null,
            stepCodeMustChange: true,
            updatedAt: new Date(),
          })
          .where(eq(users.id, id));
        message = "2-Step Code cleared — the user will set a new one at next sign-in";
        break;

      case "require_change":
        if (!user.stepCodeHash) {
          return apiError("This user has no 2-Step Code to change", 400);
        }
        await db
          .update(users)
          .set({ stepCodeMustChange: true, updatedAt: new Date() })
          .where(eq(users.id, id));
        message = "User will be asked to change their 2-Step Code";
        break;
    }

    if (body.revokeSessions) {
      await destroyAllUserSessions(id);
    }

    await cacheDelPattern("user:*");

    await logActivity(master, "step_code_reset", {
      resourceType: "user",
      resourceId: id,
      ip,
      metadata: {
        username: user.username,
        action: body.action,
        revokedSessions: !!body.revokeSessions,
      },
    });

    return apiSuccess({ message });
  } catch (error) {
    return handleApiError(error);
  }
}
