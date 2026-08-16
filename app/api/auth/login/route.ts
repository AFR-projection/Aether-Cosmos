import { NextRequest } from "next/server";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users, type User } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import {
  getClientIp,
  destroySession,
  getSessionUser,
  AuthError,
} from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/audit";
import { peekRateLimit, checkRateLimit } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { notifyUser } from "@/lib/email/notify-user";
import { getAdminSettings } from "@/lib/admin-settings";
import { completeLogin } from "@/lib/auth/login-complete";
import { verifyTotpCode, consumeRecoveryCode } from "@/lib/security/totp";
import {
  createStagedToken,
  verifyStagedToken,
  verifyStepCode,
  STEP_CODE_MAX_ATTEMPTS,
  STEP_CODE_LOCKOUT_MS,
} from "@/lib/security/step-code";

/**
 * Login is a three-layer sequence:
 *
 *   1. password        → issues a "password"-stage token
 *   2. 2-Step Code     → issues a "step_code"-stage token
 *   3. authenticator   → creates the session
 *
 * Each request carries the token proving the previous layer passed, and
 * verifyStagedToken is bound to the specific stage being gated, so a client
 * cannot present a password-stage token to the TOTP branch and skip layer 2.
 * Layers 2 and 3 are skipped only when the account genuinely has neither
 * configured.
 */

const loginSchema = z
  .object({
    identifier: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    /** Layer 2 */
    stepCode: z.string().optional(),
    stepToken: z.string().optional(),
    /** Layer 3 */
    totpCode: z.string().optional(),
    recoveryCode: z.string().optional(),
    pendingToken: z.string().optional(),
  })
  .refine(
    (d) => !!d.pendingToken || !!d.stepToken || (!!d.identifier && !!d.password),
    { message: "Credentials required" }
  );

const ACCOUNT_MAX_FAILED = parseInt(process.env.RATE_LIMIT_LOGIN_MAX ?? "5", 10) || 5;
const LOCKOUT_WINDOW_MS =
  parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS ?? "900000", 10) || 15 * 60 * 1000;
const IP_MAX_FAILED = parseInt(process.env.RATE_LIMIT_LOGIN_IP_MAX ?? "30", 10) || 30;

const MSG_ACCOUNT_LOCKED =
  "This account has been temporarily locked due to multiple failed login attempts. Please try again in 15 minutes.";
const MSG_IP_THROTTLE =
  "Too many login attempts from this IP address. Please try again in 15 minutes.";

async function recordIpFailure(ip: string, userId?: string) {
  const result = await checkRateLimit(`login:${ip}`, IP_MAX_FAILED, LOCKOUT_WINDOW_MS);
  if (!result.allowed && userId) {
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (u) {
      await logActivity(u, "ip_rate_limit", {
        ip,
        metadata: { max: IP_MAX_FAILED, windowMs: LOCKOUT_WINDOW_MS },
      });
    }
  }
  return result;
}

/** Loads the user behind a staged token, re-checking status on every layer. */
async function loadStagedUser(userId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== "active") return null;
  return user;
}

/**
 * What the client must do after the password layer. Returned as a discriminated
 * response so the UI never has to infer the next screen from absence of data.
 */
async function nextAfterPassword(user: User) {
  const settings = await getAdminSettings().catch(() => null);
  const stepCodeRequired = settings?.stepCodeRequired ?? false;

  if (user.stepCodeHash) {
    return {
      requiresStepCode: true as const,
      stepCodeEnrollment: false as const,
      stepToken: createStagedToken(user.id, "password"),
    };
  }

  // No code on file. Force enrolment when policy demands it or a master flagged
  // the account; otherwise fall through to the authenticator layer.
  if (stepCodeRequired || user.stepCodeMustChange) {
    return {
      requiresStepCode: true as const,
      stepCodeEnrollment: true as const,
      stepToken: createStagedToken(user.id, "password"),
    };
  }

  return null;
}

function nextAfterStepCode(user: User) {
  if (user.totpEnabled && user.totpSecret) {
    return {
      requires2fa: true as const,
      pendingToken: createStagedToken(user.id, "step_code"),
    };
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const userAgent = request.headers.get("user-agent") ?? "unknown";

    const ipStatus = await peekRateLimit(`login:${ip}`, IP_MAX_FAILED, LOCKOUT_WINDOW_MS);
    if (!ipStatus.allowed) {
      return apiError(MSG_IP_THROTTLE, 429, { code: "IP_RATE_LIMIT" });
    }

    const body = await request.json();
    const { identifier, password, stepCode, stepToken, totpCode, recoveryCode, pendingToken } =
      loginSchema.parse(body);

    // ── Layer 3: authenticator ──
    if (pendingToken) {
      const pending = verifyStagedToken(pendingToken, "step_code");
      if (!pending) {
        return apiError("Session expired. Please sign in again.", 401, { code: "2FA_EXPIRED" });
      }

      const user = await loadStagedUser(pending.userId);
      if (!user) return apiError("Invalid credentials", 401);

      let totpOk = false;
      if (totpCode && user.totpSecret) {
        totpOk = verifyTotpCode(user.totpSecret, totpCode);
      }
      if (!totpOk && recoveryCode) {
        const result = await consumeRecoveryCode(
          user.totpRecoveryCodes as string[] | null,
          recoveryCode
        );
        if (result.ok) {
          totpOk = true;
          await db
            .update(users)
            .set({ totpRecoveryCodes: result.remaining, updatedAt: new Date() })
            .where(eq(users.id, user.id));
        }
      }
      if (!totpOk) {
        await recordIpFailure(ip, user.id);
        return apiError("Invalid authentication code", 401, { code: "2FA_INVALID" });
      }

      return apiSuccess(
        await completeLogin(user, {
          ip,
          userAgent,
          lockoutWindowMs: LOCKOUT_WINDOW_MS,
          layers: ["password", "step_code", "totp"],
        })
      );
    }

    // ── Layer 2: 2-Step Code ──
    if (stepToken) {
      const pending = verifyStagedToken(stepToken, "password");
      if (!pending) {
        return apiError("Session expired. Please sign in again.", 401, {
          code: "STEP_CODE_EXPIRED",
        });
      }

      const user = await loadStagedUser(pending.userId);
      if (!user) return apiError("Invalid credentials", 401);
      if (!stepCode) return apiError("2-Step Code is required", 400);

      // Enrolment is handled by its own endpoint so this branch only ever
      // verifies an existing code.
      if (!user.stepCodeHash) {
        return apiError("No 2-Step Code is set for this account", 400, {
          code: "STEP_CODE_NOT_SET",
        });
      }

      if (user.stepCodeLockedUntil && new Date(user.stepCodeLockedUntil) > new Date()) {
        return apiError(
          "Your 2-Step Code is temporarily locked due to repeated incorrect entries. Try again in 15 minutes.",
          429,
          { code: "STEP_CODE_LOCKED" }
        );
      }

      const ok = await verifyStepCode(stepCode, user.stepCodeHash);
      if (!ok) {
        const attempts = (user.stepCodeFailedAttempts ?? 0) + 1;
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

        await recordIpFailure(ip, user.id);

        if (shouldLock) {
          await logActivity(user, "step_code_lock", {
            ip,
            metadata: { userAgent, attempts },
          });
          void notifyUser(user.id, {
            type: "account_locked",
            minutes: Math.round(STEP_CODE_LOCKOUT_MS / 60000),
          });
          return apiError(
            "Your 2-Step Code is temporarily locked due to repeated incorrect entries. Try again in 15 minutes.",
            429,
            { code: "STEP_CODE_LOCKED" }
          );
        }

        const remaining = STEP_CODE_MAX_ATTEMPTS - attempts;
        return apiError(
          `Incorrect 2-Step Code. ${remaining} attempt(s) remaining.`,
          401,
          { code: "STEP_CODE_INVALID", remaining }
        );
      }

      if ((user.stepCodeFailedAttempts ?? 0) > 0) {
        await db
          .update(users)
          .set({ stepCodeFailedAttempts: 0, stepCodeLockedUntil: null, updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }

      const totpStep = nextAfterStepCode(user);
      if (totpStep) {
        return apiSuccess({
          ...totpStep,
          message: "Enter your authenticator code to continue",
        });
      }

      return apiSuccess(
        await completeLogin(user, {
          ip,
          userAgent,
          lockoutWindowMs: LOCKOUT_WINDOW_MS,
          layers: ["password", "step_code"],
        })
      );
    }

    // ── Layer 1: password ──
    const [user] = await db
      .select()
      .from(users)
      .where(or(eq(users.username, identifier!), eq(users.email, identifier!.toLowerCase())))
      .limit(1);

    if (!user) {
      const ipResult = await recordIpFailure(ip);
      if (!ipResult.allowed) {
        return apiError(MSG_IP_THROTTLE, 429, { code: "IP_RATE_LIMIT" });
      }
      return apiError("Invalid credentials", 401);
    }

    if (user.lockedUntil && new Date(user.lockedUntil) <= new Date()) {
      await db
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return apiError(MSG_ACCOUNT_LOCKED, 429, { code: "ACCOUNT_LOCKED" });
    }

    if (user.status === "suspended") {
      // Don't expose internal admin notes — just show generic message
      return apiError(
        "Your account has been suspended. Contact an administrator for details.",
        403,
        { code: "ACCOUNT_SUSPENDED" }
      );
    }

    const valid = await verifyPassword(password!, user.passwordHash);
    if (!valid) {
      const newAttempts = (user.failedLoginAttempts ?? 0) + 1;
      const shouldLock = newAttempts >= ACCOUNT_MAX_FAILED;

      await db
        .update(users)
        .set({
          failedLoginAttempts: newAttempts,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_WINDOW_MS) : null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      await logActivity(user, "login", {
        ip,
        metadata: {
          userAgent,
          success: false,
          attempt: newAttempts,
          maxAttempts: ACCOUNT_MAX_FAILED,
          locked: shouldLock,
        },
      });

      const ipResult = await recordIpFailure(ip, user.id);
      if (!ipResult.allowed) {
        return apiError(MSG_IP_THROTTLE, 429, { code: "IP_RATE_LIMIT" });
      }

      if (shouldLock) {
        await logActivity(user, "account_lock", {
          ip,
          metadata: { userAgent, attempts: newAttempts },
        });
        void notifyUser(user.id, {
          type: "account_locked",
          minutes: Math.round(LOCKOUT_WINDOW_MS / 60000),
        });
        return apiError(MSG_ACCOUNT_LOCKED, 429, { code: "ACCOUNT_LOCKED" });
      }

      const remaining = ACCOUNT_MAX_FAILED - newAttempts;
      return apiError(
        `Invalid credentials. ${remaining} attempt(s) remaining before account lock.`,
        401
      );
    }

    await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const stepStep = await nextAfterPassword(user);
    if (stepStep) {
      return apiSuccess({
        ...stepStep,
        message: stepStep.stepCodeEnrollment
          ? "Set up your 2-Step Code to continue"
          : "Enter your 2-Step Code to continue",
      });
    }

    const totpStep = nextAfterStepCode(user);
    if (totpStep) {
      return apiSuccess({
        ...totpStep,
        message: "Enter your authenticator code to continue",
      });
    }

    return apiSuccess(
      await completeLogin(user, {
        ip,
        userAgent,
        lockoutWindowMs: LOCKOUT_WINDOW_MS,
        layers: ["password"],
      })
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE() {
  try {
    let user = null;
    try {
      user = await getSessionUser();
    } catch (err) {
      // Session may already be inactive/IP-revoked — still clear the cookie
      if (!(err instanceof AuthError)) throw err;
    }
    if (user) {
      await logActivity(user, "logout");
    }
    await destroySession();
    if (user) {
      const { publishToAdmins } = await import("@/lib/realtime/events");
      void publishToAdmins({ type: "user_updated", userId: user.id, at: Date.now() });
    }
    return apiSuccess({ message: "Logged out" });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return apiError("Not authenticated", 401);
    }

    return apiSuccess({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
      mustChangePassword: user.mustChangePassword,
      totpEnabled: user.totpEnabled,
      stepCodeEnabled: !!user.stepCodeHash,
      stepCodeMustChange: user.stepCodeMustChange,
      effectiveUserId: user.effectiveUserId,
      isImpersonating: user.isImpersonating,
      sessionId: user.sessionId,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
