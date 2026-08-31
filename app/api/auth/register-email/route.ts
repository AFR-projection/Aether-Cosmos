import { NextRequest } from "next/server";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { hashPassword } from "@/shared/lib/auth/password";
import { validateCsrf, checkRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { readBoundedJson } from "@/shared/api/read-body";
import { getAdminSettings, defaultQuotaBytes, defaultBandwidthQuotaBytes, isEmailDomainAllowed } from "@/shared/lib/settings/admin-settings";
import { validatePasswordStrength } from "@/shared/lib/security/password-policy";
import { sendOTP, normalizeEmail } from "@/shared/infrastructure/email/email-service";
import { getClientIp } from "@/shared/lib/auth/session";
import { publishToAdmins } from "@/shared/infrastructure/realtime/events";

export const runtime = "nodejs";

const registerSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.string().email().max(254),
  password: z.string().min(10).max(128),
});

/**
 * Start email-based registration: create a SUSPENDED user and email them an OTP.
 * The account is activated only after the code is verified at /verify-otp, which
 * proves the person controls the mailbox. Rolls the user back if the OTP can't
 * be delivered so a bad address doesn't leave an orphaned suspended account.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const settings = await getAdminSettings();
    if (settings.maintenanceMode) {
      return apiError(settings.maintenanceMessage || "Maintenance mode", 503, { code: "MAINTENANCE" });
    }
    if (!settings.registrationEnabled) {
      return apiError("Registration is disabled", 403);
    }

    const ip = getClientIp(request);
    const limit = await checkRateLimit(`register:${ip}`, 5, 15 * 60 * 1000);
    if (!limit.allowed) {
      return apiError("Too many registration attempts", 429);
    }

    const body = registerSchema.parse(await readBoundedJson(request));
    const email = normalizeEmail(body.email);

    // Optional domain allowlist from Admin → Settings. Checked before the
    // existence lookup so a blocked domain never learns whether a name is taken.
    if (!isEmailDomainAllowed(email, settings)) {
      return apiError("Registration is not open to that email domain.", 403);
    }

    const passwordCheck = validatePasswordStrength(body.password);
    if (!passwordCheck.valid) {
      return apiError(`Password too weak: ${passwordCheck.errors.join(", ")}`, 400);
    }

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.username, body.username), eq(users.email, email)))
      .limit(1);

    if (existing) {
      return apiError("Username or email is already registered", 409);
    }

    const passwordHash = await hashPassword(body.password);
    const quotaBytes = defaultQuotaBytes(settings);
    const bandwidthQuotaBytes = defaultBandwidthQuotaBytes(settings);

    const [user] = await db
      .insert(users)
      .values({
        username: body.username,
        email,
        passwordHash,
        role: "user",
        quotaBytes,
        bandwidthQuotaBytes,
        status: "suspended",
      })
      .returning();

    const code = await sendOTP(email);
    if (!code) {
      await db.delete(users).where(eq(users.id, user.id));
      return apiError(
        "Could not send the verification email. Check the address, or the email gateway may not be configured yet.",
        503
      );
    }

    // New pending account — surface it live in the admin User Management panel.
    void publishToAdmins({ type: "user_registered", userId: user.id, at: Date.now() });

    return apiSuccess({
      userId: user.id,
      email,
      message: "We emailed you a 6-digit verification code.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
