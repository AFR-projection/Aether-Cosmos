import { db } from "@/lib/db";
import { otpTokens } from "@/lib/db/schema";
import { eq, and, gt, lt, desc, sql } from "drizzle-orm";
import { timingSafeEqual } from "crypto";
import { deliverMail } from "./mailer";
import { generateOTP, hashOTP } from "./otp-utils";
import { otpEmail } from "./templates";
import { recordEmailLog } from "./log";

const OTP_EXPIRY_MINUTES = 10;
const OTP_RATE_LIMIT_SECONDS = 60;

/** Guesses allowed per issued code before it is dead. */
export const OTP_MAX_ATTEMPTS = 5;

/** Constant-time digest comparison — never short-circuit on the first byte. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

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

  /**
   * Spend one attempt in a single statement.
   *
   * Reading `attemptCount`, comparing it to the cap, and writing it back later
   * left a window in which a burst of concurrent guesses all saw the same
   * "0 attempts used": the 5-guess budget on a 6-digit code became "as many
   * guesses as fit in one round trip", which is a tractable brute force. The
   * conditional UPDATE makes the attempt itself the thing being claimed.
   */
  const [claimed] = await db
    .update(otpTokens)
    .set({ attemptCount: sql`${otpTokens.attemptCount} + 1` })
    .where(and(eq(otpTokens.id, token.id), lt(otpTokens.attemptCount, OTP_MAX_ATTEMPTS)))
    .returning({ attemptCount: otpTokens.attemptCount });

  if (!claimed) {
    recordEmailLog("warn", "otp", `OTP verify blocked — too many attempts for ${clean}`, {
      to: clean,
      attempts: OTP_MAX_ATTEMPTS,
    });
    return false;
  }

  if (!sameDigest(hashOTP(code), token.code)) {
    recordEmailLog("warn", "otp", `OTP verify failed — wrong code for ${clean}`, {
      to: clean,
      attempt: claimed.attemptCount,
    });
    return false;
  }

  // Burn the code in the same statement that checks it is still unburnt, so two
  // requests carrying the same correct code cannot both be told "verified".
  const [consumed] = await db
    .update(otpTokens)
    .set({ verified: true })
    .where(and(eq(otpTokens.id, token.id), eq(otpTokens.verified, false)))
    .returning({ id: otpTokens.id });

  if (!consumed) {
    recordEmailLog("warn", "otp", `OTP verify lost the race — code already used for ${clean}`, {
      to: clean,
    });
    return false;
  }

  recordEmailLog("info", "otp", `OTP verified for ${clean}`, { to: clean });
  return true;
}
