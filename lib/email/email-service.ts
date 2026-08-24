import { db } from "@/lib/db";
import { otpTokens } from "@/lib/db/schema";
import { eq, and, gt, desc } from "drizzle-orm";
import { deliverMail } from "./mailer";
import { generateOTP, hashOTP } from "./otp-utils";
import { otpEmail } from "./templates";
import { recordEmailLog } from "./log";

const OTP_EXPIRY_MINUTES = 10;
const OTP_RATE_LIMIT_SECONDS = 60;

/** Lowercase + trim for consistent storage/lookup. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliver an OTP email. Returns false if no sender could deliver it. */
async function deliverOtp(email: string, code: string): Promise<boolean> {
  const { subject, html, text } = otpEmail(code, OTP_EXPIRY_MINUTES);
  return deliverMail({ to: email, subject, html, text });
}

/**
 * Generate, persist (hashed), and email an OTP for `email`. Rate-limited to one
 * code per OTP_RATE_LIMIT_SECONDS. Returns the raw code on success, or null if
 * rate-limited or delivery failed.
 */
export async function sendOTP(email: string): Promise<string | null> {
  const clean = normalizeEmail(email);

  const [recent] = await db
    .select()
    .from(otpTokens)
    .where(eq(otpTokens.email, clean))
    .orderBy(desc(otpTokens.createdAt))
    .limit(1);

  if (recent) {
    const diffSeconds = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (diffSeconds < OTP_RATE_LIMIT_SECONDS) {
      recordEmailLog("warn", "otp", `OTP request rate-limited for ${clean}`, {
        to: clean,
        retryInSeconds: Math.ceil(OTP_RATE_LIMIT_SECONDS - diffSeconds),
      });
      return null;
    }
  }

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.insert(otpTokens).values({ email: clean, code: hashOTP(code), expiresAt });

  const sent = await deliverOtp(clean, code);
  if (!sent) {
    // Code was persisted but couldn't be emailed — record so admins see the gap.
    recordEmailLog("error", "otp", `OTP generated but email delivery failed for ${clean}`, {
      to: clean,
    });
  }
  return sent ? code : null;
}

/** Verify a submitted OTP against the latest live token for the email. */
export async function verifyOTP(email: string, code: string): Promise<boolean> {
  const clean = normalizeEmail(email);

  const [token] = await db
    .select()
    .from(otpTokens)
    .where(
      and(
        eq(otpTokens.email, clean),
        eq(otpTokens.verified, false),
        gt(otpTokens.expiresAt, new Date())
      )
    )
    .orderBy(desc(otpTokens.createdAt))
    .limit(1);

  if (!token) {
    recordEmailLog("warn", "otp", `OTP verify failed — no live code for ${clean}`, { to: clean });
    return false;
  }
  if (token.attemptCount >= 5) {
    recordEmailLog("warn", "otp", `OTP verify blocked — too many attempts for ${clean}`, {
      to: clean,
      attempts: token.attemptCount,
    });
    return false;
  }

  if (hashOTP(code) !== token.code) {
    await db
      .update(otpTokens)
      .set({ attemptCount: token.attemptCount + 1 })
      .where(eq(otpTokens.id, token.id));
    recordEmailLog("warn", "otp", `OTP verify failed — wrong code for ${clean}`, {
      to: clean,
      attempt: token.attemptCount + 1,
    });
    return false;
  }

  await db.update(otpTokens).set({ verified: true }).where(eq(otpTokens.id, token.id));
  recordEmailLog("info", "otp", `OTP verified for ${clean}`, { to: clean });
  return true;
}
