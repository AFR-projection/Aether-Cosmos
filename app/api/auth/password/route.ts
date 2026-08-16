import { NextRequest } from "next/server";
import { eq, and, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { requireAuth, destroyAllUserSessions } from "@/lib/auth/session";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { logActivity } from "@/lib/auth/audit";
import { validatePasswordStrength } from "@/lib/security/password-policy";
import { validateCsrf, checkUserApiRateLimit } from "@/lib/security";
import { notifyUser } from "@/lib/email/notify-user";

const passwordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(10).max(128),
  /** When true (force reset), current password may be omitted if mustChangePassword is set. */
  forceReset: z.boolean().optional(),
});

export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();

    // Rate limit: 5 attempts per 15 minutes per user
    const rateLimitCheck = await checkUserApiRateLimit(user.id, 5, {
      bucket: "password_change",
      multiplier: 0.25, // 5 per 15min = 5 * 0.25 = 1.25, rounded to max(1, 1.25) per minute window
    });
    if (!rateLimitCheck.allowed) {
      return apiError("Too many password change attempts. Try again later.", 429);
    }

    const body = await request.json();
    const { currentPassword, newPassword, forceReset } = passwordSchema.parse(body);

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return apiError(`Password too weak: ${strength.errors.join(", ")}`, 400);
    }

    const [dbUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    if (!dbUser) {
      return apiError("User not found", 404);
    }

    const isForced = forceReset && dbUser.mustChangePassword;
    if (!isForced) {
      if (!currentPassword) return apiError("Current password is required", 400);
      const valid = await verifyPassword(currentPassword, dbUser.passwordHash);
      if (!valid) {
        return apiError("Current password is incorrect", 401);
      }
    }

    const same = await verifyPassword(newPassword, dbUser.passwordHash);
    if (same) {
      return apiError("New password must be different from current password", 400);
    }

    const passwordHash = await hashPassword(newPassword);

    await db
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    if (isForced) {
      // Keep current device session; revoke others
      if (user.sessionId) {
        await db
          .delete(sessions)
          .where(and(eq(sessions.userId, user.id), ne(sessions.id, user.sessionId)));
      }
      await logActivity(user, "password_change", {
        metadata: { changedBy: "force_reset" },
      });
      void notifyUser(user.id, { type: "password_changed", at: new Date() });
      return apiSuccess({
        message: "Password updated. You can continue using the app.",
        staySignedIn: true,
      });
    }

    await destroyAllUserSessions(user.id);
    await logActivity(user, "password_change", {
      metadata: { changedBy: "user" },
    });
    void notifyUser(user.id, { type: "password_changed", at: new Date() });

    return apiSuccess({
      message: "Password changed successfully. Please log in again.",
      staySignedIn: false,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
