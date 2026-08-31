import { createHash, randomInt } from "crypto";

/** Cryptographically-adequate numeric OTP. Digits only for easy entry. */
export function generateOTP(length = 6): string {
  let otp = "";
  for (let i = 0; i < length; i++) otp += randomInt(0, 10).toString();
  return otp;
}

/** One-way hash of an OTP for at-rest storage (never store the raw code). */
export function hashOTP(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
