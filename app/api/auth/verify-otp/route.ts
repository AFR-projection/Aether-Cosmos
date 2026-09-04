import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import {
  validateCsrf,
  checkRateLimit,
  peekRateLimit,
  resetRateLimit,
  rateLimitRetryAfterSeconds,
} from "@/shared/lib/security";
import { apiSuccess, apiError, apiRateLimited, handleApiError } from "@/shared/api/response";
import { readBoundedJson } from "@/shared/api/read-body";
import { verifyOTP, normalizeEmail } from "@/shared/infrastructure/email/email-service";
import { createSession, getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { publishToAdmins } from "@/shared/infrastructure/realtime/events";

export const runtime = "nodejs";

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

/**
 * Guessing budgets that span several issued codes. Per-code attempts are capped
 * separately inside `verifyOTP` (5, enforced by a conditional UPDATE), which is
 * the control that actually stops brute force — a 6-digit code is 1-in-a-million
 * and only 5 tries of it ever exist.
 *
 * The per-email window is deliberately short. These counters are reachable by
 * anyone who knows an address, so a long one hands out a denial of service:
 * burning the email budget delays that person's *verification* until it expires.
 * Five minutes bounds that to an annoyance while still throttling a guesser to
 * ~120 attempts an hour against a code that only 5 attempts of exist. The per-IP
 * budget is the wider net, and it only binds now that the client cannot pick its
 * own IP (see `resolveClientIp`).
 */
const PER_IP_MAX = 20;
const PER_IP_WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL_MAX = 10;
const PER_EMAIL_WINDOW_MS = 5 * 60 * 1000;
const emailKey = (email: string) => `verify-otp:email:${email}`;

/**
 * Verify an email OTP and activate the pending account. On success the user's
 * status flips to active and a session is created so they land straight in the app.
 *
 * This endpoint mints a session without a password, so it is strictly limited to
 * accounts that are still awaiting email verification. It used to sign in whoever
 * the address belonged to: for an already-active account a single OTP was a
 * complete authentication bypass, skipping the password, the 2-Step Code and the
 * authenticator layer alike.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const ip = getClientIp(request);
    const body = verifySchema.parse(await readBoundedJson(request));
    const email = normalizeEmail(body.email);

    // Read-only first, and spend from the budget only when the code is actually
    // wrong. Incrementing up front charged the correct code too, so a user who
    // mistyped once and then pasted the right one still walked away one attempt
    // poorer — and it made the counters climb on traffic that proves the caller
    // owns the mailbox.
    const perIp = await peekRateLimit(`verify-otp:${ip}`, PER_IP_MAX, PER_IP_WINDOW_MS);
    if (!perIp.allowed) {
      return apiRateLimited(
        "Too many verification attempts from this network. Please wait before trying again.",
        rateLimitRetryAfterSeconds(PER_IP_WINDOW_MS),
        { code: "OTP_THROTTLED" }
      );
    }
    const perEmail = await peekRateLimit(emailKey(email), PER_EMAIL_MAX, PER_EMAIL_WINDOW_MS);
    if (!perEmail.allowed) {
      return apiRateLimited(
        "Too many verification attempts for this email. Please wait before trying again.",
        rateLimitRetryAfterSeconds(PER_EMAIL_WINDOW_MS),
        { code: "OTP_THROTTLED" }
      );
    }

    const ok = await verifyOTP(email, body.code);
    if (!ok) {
      await checkRateLimit(`verify-otp:${ip}`, PER_IP_MAX, PER_IP_WINDOW_MS);
      await checkRateLimit(emailKey(email), PER_EMAIL_MAX, PER_EMAIL_WINDOW_MS);
      return apiError("OTP code is incorrect or expired", 400, { code: "OTP_INVALID" });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return apiError("User not found", 404);

    // Only PENDING-verification accounts may be activated here. A pending account
    // is "suspended" with a null reason (that's how register-email creates it).
    // An account an admin actively suspended carries a reason — activating it here
    // would let a suspended user self-lift their ban by re-verifying their email.
    if (user.status === "suspended" && user.suspendReason) {
      return apiError("This account has been suspended. Contact an administrator.", 403, {
        code: "ACCOUNT_SUSPENDED",
      });
    }

    // Already verified: there is nothing to activate, and handing out a session
    // here would be a password-less, 2FA-less login for an existing account.
    if (user.status === "active") {
      return apiError("This account is already verified. Please sign in with your password.", 409, {
        code: "ALREADY_VERIFIED",
      });
    }

    await db.update(users).set({ status: "active" }).where(eq(users.id, user.id));

    // A correct code proves this caller reads the mailbox, so the address stops
    // carrying whatever wrong guesses preceded it. The per-IP budget is left
    // alone: it is shared by everyone behind the same NAT, and clearing it would
    // let anyone holding one verifiable address wipe the wider net at will.
    await resetRateLimit(emailKey(email), PER_EMAIL_WINDOW_MS);

    // Account just went from pending → active: reflect it live in the admin panel.
    void publishToAdmins({ type: "user_verified", userId: user.id, at: Date.now() });

    await createSession(user.id, ip, request.headers.get("user-agent") ?? undefined);

    await logActivity(user, "create_user", {
      ip,
      metadata: { registrationMethod: "email" },
    });

    return apiSuccess({
      user: { id: user.id, username: user.username, role: user.role },
      message: "Account activated",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
