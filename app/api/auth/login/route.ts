import { NextRequest } from "next/server";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users, type User } from "@/shared/infrastructure/db/schema";
import { verifyPassword, verifyDecoyPassword } from "@/shared/lib/auth/password";
import {
  getClientIp,
  destroySession,
  getSessionUser,
  AuthError,
} from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { peekRateLimit, checkRateLimit, resetRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { readBoundedJson } from "@/shared/api/read-body";
import { notifyUser } from "@/shared/infrastructure/email/notify-user";
import { getAdminSettings, loginLockoutPolicy, type LoginLockoutPolicy } from "@/shared/lib/settings/admin-settings";
import { completeLogin } from "@/shared/lib/auth/login-complete";
import { verifyTotpCode, consumeRecoveryCode } from "@/shared/lib/security/totp";
import {
  createStagedToken,
  verifyStagedToken,
  verifyStepCode,
  normalizeStepCodeLength,
  STEP_CODE_MAX_ATTEMPTS,
  STEP_CODE_LOCKOUT_MS,
} from "@/shared/lib/security/step-code";

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

/**
 * Lockout thresholds come from Admin → Settings, read per request.
 *
 * They used to be module-level consts built from `RATE_LIMIT_LOGIN_*` env vars,
 * which froze them at import time — changing a threshold meant a redeploy, and
 * the "15 minutes" in the copy below was a separate hardcoded number that could
 * disagree with the window actually being enforced.
 */
async function lockoutPolicy(): Promise<LoginLockoutPolicy> {
  const settings = await getAdminSettings().catch(() => undefined);
  return loginLockoutPolicy(settings);
}

/**
 * One message for "no such account" and for "wrong password". The old copy
 * appended "N attempt(s) remaining before account lock" only when the account
 * existed, which turned the login form into an account-existence oracle for
 * anyone with a username list.
 */
const MSG_INVALID = "Invalid credentials";
const msgAccountLocked = (minutes: number) =>
  `This account has been temporarily locked due to multiple failed login attempts. Please try again in ${minutes} minutes.`;
const msgIpThrottle = (minutes: number) =>
  `Too many login attempts from this IP address. Please try again in ${minutes} minutes.`;

async function recordIpFailure(ip: string, policy: LoginLockoutPolicy, userId?: string) {
  const result = await checkRateLimit(`login:${ip}`, policy.ipMax, policy.windowMs);
  if (!result.allowed && userId) {
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (u) {
      await logActivity(u, "ip_rate_limit", {
        ip,
        metadata: { max: policy.ipMax, windowMs: policy.windowMs },
      });
    }
  }
  return result;
}

/**
 * A 6-digit authenticator code is a 1-in-a-million guess, so the layer needs its
 * own per-ACCOUNT ceiling: the IP limit alone lets a distributed guesser keep
 * trying against a password it already knows, and the `users` lockout columns
 * only cover the password and 2-Step Code layers.
 */
const TOTP_MAX_FAILED = 10;
const totpKey = (userId: string) => `login:totp:${userId}`;

/** Loads the user behind a staged token, re-checking status on every layer. */
async function loadStagedUser(userId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== "active") return null;
  return user;
}

/**
 * What the client must do after the password layer. Returned as a discriminated
 * response so the UI never has to infer the next screen from absence of data.
 *
 * `stepCodeLength` lets the numpad draw exactly the account's own number of slots
 * instead of the whole 6–10 range. It is only ever included on the branch where
 * the password has already been verified for this account, and the layer is still
 * capped at 5 attempts before a 15-minute lockout, so the length narrows nothing
 * an attacker holding the password could actually exploit. Null (an account whose
 * length was never recorded) keeps the flexible pad.
 */
async function nextAfterPassword(user: User) {
  const settings = await getAdminSettings().catch(() => null);
  const stepCodeRequired = settings?.stepCodeRequired ?? false;

  if (user.stepCodeHash) {
    return {
      requiresStepCode: true as const,
      stepCodeEnrollment: false as const,
      stepCodeLength: normalizeStepCodeLength(user.stepCodeLength),
      stepToken: createStagedToken(user.id, "password"),
    };
  }

  // No code on file. Force enrolment when policy demands it or a master flagged
  // the account; otherwise fall through to the authenticator layer.
  if (stepCodeRequired || user.stepCodeMustChange) {
    return {
      requiresStepCode: true as const,
      stepCodeEnrollment: true as const,
      stepCodeLength: null,
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
    const policy = await lockoutPolicy();

    const ipStatus = await peekRateLimit(`login:${ip}`, policy.ipMax, policy.windowMs);
    if (!ipStatus.allowed) {
      return apiError(msgIpThrottle(policy.windowMinutes), 429, { code: "IP_RATE_LIMIT" });
    }

    const body = await readBoundedJson(request);
    const { identifier, password, stepCode, stepToken, totpCode, recoveryCode, pendingToken } =
      loginSchema.parse(body);

    // ── Layer 3: authenticator ──
    if (pendingToken) {
      const pending = verifyStagedToken(pendingToken, "step_code");
      if (!pending) {
        return apiError("Session expired. Please sign in again.", 401, { code: "2FA_EXPIRED" });
      }

      const user = await loadStagedUser(pending.userId);
      if (!user) return apiError(MSG_INVALID, 401);

      const totpStatus = await peekRateLimit(
        totpKey(user.id),
        TOTP_MAX_FAILED,
        policy.windowMs
      );
      if (!totpStatus.allowed) {
        return apiError(
          `Too many incorrect authentication codes. Please try again in ${policy.windowMinutes} minutes.`,
          429,
          { code: "2FA_LOCKED" }
        );
      }

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
        await checkRateLimit(totpKey(user.id), TOTP_MAX_FAILED, policy.windowMs);
        await recordIpFailure(ip, policy, user.id);
        return apiError("Invalid authentication code", 401, { code: "2FA_INVALID" });
      }

      // A completed layer clears its own counter so a user who fumbled a code
      // twice is not still one mistake from a lockout tomorrow.
      await resetRateLimit(totpKey(user.id), policy.windowMs);

      return apiSuccess(
        await completeLogin(user, {
          ip,
          userAgent,
          lockoutWindowMs: policy.windowMs,
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
      if (!user) return apiError(MSG_INVALID, 401);
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

        await recordIpFailure(ip, policy, user.id);

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

      // A correct code is the only moment its length is known for certain, so it
      // is also the only safe place to record it for accounts enrolled before
      // `step_code_length` existed. Written together with the attempt reset to
      // keep this to a single UPDATE, and skipped entirely when neither needs it.
      const recordedLength = normalizeStepCodeLength(user.stepCodeLength);
      const lengthNeedsBackfill = recordedLength !== stepCode.length;
      const attemptsNeedReset = (user.stepCodeFailedAttempts ?? 0) > 0;

      if (attemptsNeedReset || lengthNeedsBackfill) {
        await db
          .update(users)
          .set({
            ...(attemptsNeedReset
              ? { stepCodeFailedAttempts: 0, stepCodeLockedUntil: null }
              : {}),
            ...(lengthNeedsBackfill ? { stepCodeLength: stepCode.length } : {}),
            updatedAt: new Date(),
          })
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
          lockoutWindowMs: policy.windowMs,
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
      // Spend a real argon2 verification anyway: an instant "no such user" reply
      // next to a ~0.5 s "wrong password" reply is the same oracle, told by the
      // clock instead of the body.
      await verifyDecoyPassword(password!);
      const ipResult = await recordIpFailure(ip, policy);
      if (!ipResult.allowed) {
        return apiError(msgIpThrottle(policy.windowMinutes), 429, { code: "IP_RATE_LIMIT" });
      }
      return apiError(MSG_INVALID, 401);
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
      return apiError(msgAccountLocked(policy.windowMinutes), 429, { code: "ACCOUNT_LOCKED" });
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
      const shouldLock = newAttempts >= policy.accountMax;

      await db
        .update(users)
        .set({
          failedLoginAttempts: newAttempts,
          lockedUntil: shouldLock ? new Date(Date.now() + policy.windowMs) : null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      await logActivity(user, "login", {
        ip,
        metadata: {
          userAgent,
          success: false,
          attempt: newAttempts,
          maxAttempts: policy.accountMax,
          locked: shouldLock,
        },
      });

      const ipResult = await recordIpFailure(ip, policy, user.id);
      if (!ipResult.allowed) {
        return apiError(msgIpThrottle(policy.windowMinutes), 429, { code: "IP_RATE_LIMIT" });
      }

      if (shouldLock) {
        await logActivity(user, "account_lock", {
          ip,
          metadata: { userAgent, attempts: newAttempts },
        });
        void notifyUser(user.id, {
          type: "account_locked",
          minutes: policy.windowMinutes,
        });
        return apiError(msgAccountLocked(policy.windowMinutes), 429, { code: "ACCOUNT_LOCKED" });
      }

      return apiError(MSG_INVALID, 401);
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
        lockoutWindowMs: policy.windowMs,
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
      const { publishToAdmins } = await import("@/shared/infrastructure/realtime/events");
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
