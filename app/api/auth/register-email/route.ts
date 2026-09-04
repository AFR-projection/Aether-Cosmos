import { NextRequest } from "next/server";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { hashPassword } from "@/shared/lib/auth/password";
import {
  validateCsrf,
  checkRateLimit,
  peekRateLimit,
  rateLimitRetryAfterSeconds,
} from "@/shared/lib/security";
import { apiSuccess, apiError, apiRateLimited, handleApiError } from "@/shared/api/response";
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

const PER_IP_MAX = 5;
const PER_IP_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_KEY = "register:global";
const GLOBAL_DEFAULT_MAX = 30;

/**
 * Ceiling on new registrations per hour across the whole instance.
 *
 * The per-IP cap is the fair-use control; this one is the abuse ceiling. Every
 * signup sends mail from the operator's own SMTP credentials, so a botnet with a
 * thousand addresses does not need to beat the per-IP limit to matter — it just
 * needs a thousand IPs, and the cost of the resulting spam complaint lands on this
 * domain's sending reputation, not on the attacker.
 *
 * Thirty an hour suits a private instance and is not a number a real launch day
 * would hit; `REGISTER_MAX_PER_HOUR` raises it without a code change. Read per
 * request rather than at import so a test can set it.
 */
function globalRegisterMax(): number {
  const raw = Number.parseInt(process.env.REGISTER_MAX_PER_HOUR ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : GLOBAL_DEFAULT_MAX;
}

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
    const limit = await checkRateLimit(`register:${ip}`, PER_IP_MAX, PER_IP_WINDOW_MS);
    if (!limit.allowed) {
      return apiRateLimited(
        "Too many registration attempts. Please wait before trying again.",
        rateLimitRetryAfterSeconds(PER_IP_WINDOW_MS),
        { code: "REGISTER_THROTTLED" }
      );
    }

    // Peeked here so a flood is refused before argon2 runs, and spent further
    // down only when an account is really about to be created: charging failed
    // validation to the global budget would let a storm of malformed requests shut
    // registration for everyone, which is the outage the cap exists to prevent.
    const globalMax = globalRegisterMax();
    const globalStatus = await peekRateLimit(GLOBAL_KEY, globalMax, GLOBAL_WINDOW_MS);
    if (!globalStatus.allowed) {
      return apiRateLimited(
        "Registration is temporarily paused because of unusual signup volume. Please try again later.",
        rateLimitRetryAfterSeconds(GLOBAL_WINDOW_MS),
        { code: "REGISTER_PAUSED" }
      );
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

    // The request has earned an account and an outbound email — that is the unit
    // the hourly ceiling counts.
    const globalSpend = await checkRateLimit(GLOBAL_KEY, globalMax, GLOBAL_WINDOW_MS);
    if (!globalSpend.allowed) {
      return apiRateLimited(
        "Registration is temporarily paused because of unusual signup volume. Please try again later.",
        rateLimitRetryAfterSeconds(GLOBAL_WINDOW_MS),
        { code: "REGISTER_PAUSED" }
      );
    }

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
