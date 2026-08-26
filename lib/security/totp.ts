import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Secret, TOTP } from "otpauth";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { appSecret } from "@/lib/security/app-secret";
import { APP_NAME } from "@/lib/app-version";

/**
 * The label an authenticator app files the entry under. Display only — it is not
 * part of the code derivation, so already-enrolled devices keep working (they just
 * keep showing the old brand until the user re-enrolls).
 */
const ISSUER = APP_NAME;

export function generateTotpSecret(): { secret: string; uri: (username: string) => string } {
  const secret = new Secret({ size: 20 });
  return {
    secret: secret.base32,
    uri: (username: string) => {
      const totp = new TOTP({
        issuer: ISSUER,
        label: username,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret,
      });
      return totp.toString();
    },
  };
}

export function verifyTotpCode(secretBase32: string, token: string): boolean {
  const clean = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: clean, window: 1 });
  return delta !== null;
}

export async function generateRecoveryCodes(count = 8): Promise<{
  plain: string[];
  hashed: string[];
}> {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(5).toString("hex"); // 10 hex chars
    plain.push(code);
    hashed.push(await hashPassword(code));
  }
  return { plain, hashed };
}

export async function consumeRecoveryCode(
  hashedCodes: string[] | null | undefined,
  input: string
): Promise<{ ok: boolean; remaining: string[] }> {
  const codes = hashedCodes ?? [];
  const clean = input.trim().toLowerCase();
  for (let i = 0; i < codes.length; i++) {
    if (await verifyPassword(clean, codes[i])) {
      return { ok: true, remaining: codes.filter((_, idx) => idx !== i) };
    }
  }
  return { ok: false, remaining: codes };
}

/** Short-lived HMAC token proving password step passed before 2FA. */
export function createPending2faToken(userId: string, ttlMs = 5 * 60 * 1000): string {
  const exp = Date.now() + ttlMs;
  const payload = `${userId}.${exp}`;
  const sig = createHmac("sha256", appSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyPending2faToken(token: string): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp) || Date.now() > exp) return null;
  const payload = `${userId}.${expStr}`;
  const expected = createHmac("sha256", appSecret()).update(payload).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { userId };
}
