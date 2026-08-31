import { NextRequest } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { otpTokens, users } from "@/shared/infrastructure/db/schema";
import { validateCsrf, checkRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { readBoundedJson } from "@/shared/api/read-body";
import { sendOTP, normalizeEmail } from "@/shared/infrastructure/email/email-service";
import { getClientIp } from "@/shared/lib/auth/session";

export const runtime = "nodejs";

const resendSchema = z.object({
  email: z.string().email(),
});

const OTP_RATE_LIMIT_SECONDS = 60;

/** Same wording whether or not a code was actually sent — see below. */
const MSG_SENT = "Verification code emailed";

/**
 * Re-send the registration code.
 *
 * Two things this must not become:
 *
 *  - a mailer for arbitrary addresses. The per-email cap alone let one caller
 *    walk a list and post a code to every address on it, and — because
 *    /verify-otp used to sign in whoever the address belonged to — minting a
 *    live code for an existing account was the first half of a password-less
 *    takeover. A code is only issued now when an account for that address is
 *    actually awaiting verification, and an IP cap bounds the sweep.
 *  - an account-existence oracle. Because the answer is now conditional, the
 *    response must not reveal which way it went.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const body = resendSchema.parse(await readBoundedJson(request));
    const email = normalizeEmail(body.email);
    const ip = getClientIp(request);

    const perIp = await checkRateLimit(`resend-otp:ip:${ip}`, 10, 15 * 60 * 1000);
    if (!perIp.allowed) {
      return apiError("Too many resend attempts. Try again later.", 429);
    }

    const limit = await checkRateLimit(`resend-otp:${email}`, 3, 5 * 60 * 1000);
    if (!limit.allowed) {
      return apiError("Too many resend attempts. Try again later.", 429);
    }

    const [account] = await db
      .select({ status: users.status, suspendReason: users.suspendReason })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Nothing to verify: no account, one an admin suspended for cause, or one
    // that is already active. Answer exactly as if a code had gone out.
    const pending = !!account && account.status !== "active" && !account.suspendReason;
    if (!pending) {
      return apiSuccess({ message: MSG_SENT, email });
    }

    const [recent] = await db
      .select()
      .from(otpTokens)
      .where(eq(otpTokens.email, email))
      .orderBy(desc(otpTokens.createdAt))
      .limit(1);

    if (recent) {
      const diffSeconds = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (diffSeconds < OTP_RATE_LIMIT_SECONDS) {
        return apiError(
          `Please wait ${Math.ceil(OTP_RATE_LIMIT_SECONDS - diffSeconds)}s before resending`,
          429
        );
      }
    }

    const code = await sendOTP(email);
    if (!code) {
      return apiError("Failed to send the verification email. Please try again shortly.", 500);
    }

    return apiSuccess({ message: MSG_SENT, email });
  } catch (error) {
    return handleApiError(error);
  }
}
