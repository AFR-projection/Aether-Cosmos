import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { verifyPassword } from "@/shared/lib/auth/password";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import {
  validateStepCode,
  hashStepCode,
  verifyStepCode,
  getStepCodeRules,
  normalizeStepCodeLength,
  STEP_CODE_MAX_ATTEMPTS,
  STEP_CODE_LOCKOUT_MS,
} from "@/shared/lib/security/step-code";

/**
 * Manage the signed-in user's own 2-Step Code.
 *
 * Every mutation re-checks a factor the caller already holds — the account
 * password, plus the current code when one exists — so a hijacked session
 * cannot quietly swap the second layer out from under the owner.
 */

export async function GET() {
  try {
    const user = await requireAuth();
    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const settings = await getAdminSettings().catch(() => null);

    return apiSuccess({
      enabled: !!row?.stepCodeHash,
      // Own-account metadata, behind requireAuth: lets Settings state the code's
      // length instead of the generic 6–10 range. Null until it is known.
      length: row?.stepCodeHash ? normalizeStepCodeLength(row.stepCodeLength) : null,
      updatedAt: row?.stepCodeUpdatedAt ?? null,
      mustChange: row?.stepCodeMustChange ?? false,
      required: settings?.stepCodeRequired ?? false,
      rules: getStepCodeRules(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const setSchema = z.object({
  password: z.string().min(1),
  /** Required when a code already exists — proves the caller knows the old one. */
  currentCode: z.string().optional(),
  newCode: z.string().min(1),
});

/** Set or change the code. */
export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();
    const ip = getClientIp(request);
    const body = setSchema.parse(await request.json());

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!row) return apiError("User not found", 404);

    if (!(await verifyPassword(body.password, row.passwordHash))) {
      return apiError("Password is incorrect", 401);
    }

    if (row.stepCodeHash) {
      if (row.stepCodeLockedUntil && new Date(row.stepCodeLockedUntil) > new Date()) {
        return apiError(
          "Your 2-Step Code is temporarily locked. Try again later.",
          429,
          { code: "STEP_CODE_LOCKED" }
        );
      }
      if (!body.currentCode) {
        return apiError("Current 2-Step Code is required", 400);
      }
      if (!(await verifyStepCode(body.currentCode, row.stepCodeHash))) {
        const attempts = (row.stepCodeFailedAttempts ?? 0) + 1;
        const shouldLock = attempts >= STEP_CODE_MAX_ATTEMPTS;
        await db
          .update(users)
          .set({
            stepCodeFailedAttempts: attempts,
            stepCodeLockedUntil: shouldLock
              ? new Date(Date.now() + STEP_CODE_LOCKOUT_MS)
              : null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
        return apiError("Current 2-Step Code is incorrect", 401);
      }
      if (await verifyStepCode(body.newCode, row.stepCodeHash)) {
        return apiError("New code must be different from your current code", 400);
      }
    }

    const validation = validateStepCode(body.newCode);
    if (!validation.valid) {
      return apiError(validation.errors.join(", "), 400, { code: "STEP_CODE_WEAK" });
    }

    await db
      .update(users)
      .set({
        stepCodeHash: await hashStepCode(body.newCode),
        // Kept in step with the hash — a stale length would make the login pad
        // ask for the wrong number of digits.
        stepCodeLength: body.newCode.length,
        stepCodeUpdatedAt: new Date(),
        stepCodeFailedAttempts: 0,
        stepCodeLockedUntil: null,
        stepCodeMustChange: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await logActivity(user, "step_code_change", {
      ip,
      metadata: { changedBy: "user", firstTime: !row.stepCodeHash },
    });

    return apiSuccess({
      message: row.stepCodeHash ? "2-Step Code updated" : "2-Step Code set",
      enabled: true,
      length: body.newCode.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const removeSchema = z.object({
  password: z.string().min(1),
  currentCode: z.string().min(1),
});

/** Remove the code — refused while the admin policy requires one. */
export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();
    const ip = getClientIp(request);
    const body = removeSchema.parse(await request.json());

    const settings = await getAdminSettings().catch(() => null);
    if (settings?.stepCodeRequired) {
      return apiError(
        "A 2-Step Code is required by your administrator and cannot be removed.",
        403,
        { code: "STEP_CODE_REQUIRED" }
      );
    }

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!row?.stepCodeHash) return apiError("No 2-Step Code is set", 400);

    if (!(await verifyPassword(body.password, row.passwordHash))) {
      return apiError("Password is incorrect", 401);
    }
    if (!(await verifyStepCode(body.currentCode, row.stepCodeHash))) {
      return apiError("Current 2-Step Code is incorrect", 401);
    }

    await db
      .update(users)
      .set({
        stepCodeHash: null,
        stepCodeLength: null,
        stepCodeUpdatedAt: null,
        stepCodeFailedAttempts: 0,
        stepCodeLockedUntil: null,
        stepCodeMustChange: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await logActivity(user, "step_code_change", {
      ip,
      metadata: { changedBy: "user", removed: true },
    });

    return apiSuccess({ message: "2-Step Code removed", enabled: false });
  } catch (error) {
    return handleApiError(error);
  }
}
