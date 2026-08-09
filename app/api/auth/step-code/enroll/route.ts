import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getClientIp } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { completeLogin } from "@/lib/auth/login-complete";
import {
  createStagedToken,
  verifyStagedToken,
  validateStepCode,
  hashStepCode,
  getStepCodeRules,
} from "@/lib/security/step-code";

/**
 * Mid-login enrolment for the 2-Step Code.
 *
 * Reached when the password layer passed but the account has no code yet and
 * one is required (admin policy, or a master forcing re-enrolment). The caller
 * holds only a password-stage token, so this cannot be used to set a code for
 * an account whose password was never verified.
 *
 * No CSRF check: like the login route itself, this runs pre-session and is
 * instead authenticated by the HMAC-signed staged token.
 */

const LOCKOUT_WINDOW_MS =
  parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS ?? "900000", 10) || 15 * 60 * 1000;

const schema = z.object({
  stepToken: z.string().min(1),
  newCode: z.string().min(1),
  confirmCode: z.string().min(1),
});

export async function GET() {
  return apiSuccess({ rules: getStepCodeRules() });
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const userAgent = request.headers.get("user-agent") ?? "unknown";
    const body = schema.parse(await request.json());

    const pending = verifyStagedToken(body.stepToken, "password");
    if (!pending) {
      return apiError("Session expired. Please sign in again.", 401, {
        code: "STEP_CODE_EXPIRED",
      });
    }

    const [user] = await db.select().from(users).where(eq(users.id, pending.userId)).limit(1);
    if (!user || user.status !== "active") return apiError("Invalid credentials", 401);

    // Enrolment only — an account that already has a code must change it from
    // Settings, where the current code is required.
    if (user.stepCodeHash) {
      return apiError("A 2-Step Code is already set for this account", 400, {
        code: "STEP_CODE_ALREADY_SET",
      });
    }

    if (body.newCode !== body.confirmCode) {
      return apiError("Codes do not match", 400, { code: "STEP_CODE_MISMATCH" });
    }

    const validation = validateStepCode(body.newCode);
    if (!validation.valid) {
      return apiError(validation.errors.join(", "), 400, { code: "STEP_CODE_WEAK" });
    }

    const [enrolled] = await db
      .update(users)
      .set({
        stepCodeHash: await hashStepCode(body.newCode),
        stepCodeUpdatedAt: new Date(),
        stepCodeFailedAttempts: 0,
        stepCodeLockedUntil: null,
        stepCodeMustChange: false,
        updatedAt: new Date(),
      })
      // Keep the preflight check above race-safe: a staged token may be
      // submitted twice, but only the first request may claim enrollment.
      .where(and(eq(users.id, user.id), isNull(users.stepCodeHash)))
      .returning({ id: users.id });

    if (!enrolled) {
      return apiError("A 2-Step Code is already set for this account", 409, {
        code: "STEP_CODE_ALREADY_SET",
      });
    }

    await logActivity(user, "step_code_change", {
      ip,
      metadata: { changedBy: "enrollment", firstTime: true },
    });

    // Enrolment satisfies layer 2; hand off to the authenticator when enabled.
    if (user.totpEnabled && user.totpSecret) {
      return apiSuccess({
        requires2fa: true,
        pendingToken: createStagedToken(user.id, "step_code"),
        message: "Enter your authenticator code to continue",
      });
    }

    return apiSuccess(
      await completeLogin({ ...user, stepCodeMustChange: false }, {
        ip,
        userAgent,
        lockoutWindowMs: LOCKOUT_WINDOW_MS,
        layers: ["password", "step_code_enrollment"],
      })
    );
  } catch (error) {
    return handleApiError(error);
  }
}
