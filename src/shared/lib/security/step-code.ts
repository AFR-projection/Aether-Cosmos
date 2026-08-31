import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { hashPassword, verifyPassword } from "@/shared/lib/auth/password";
import { appSecret } from "@/shared/lib/security/app-secret";

/**
 * 2-Step Code — the second of three login layers (password → 2-Step Code → TOTP).
 *
 * It is a short numeric code the user types on a numpad, stored the same way a
 * password is (argon2, never reversible). Because the keyspace is small, the
 * protection comes from rate limiting and lockout rather than from entropy, so
 * this module also owns the weak-pattern rules that stop a code like 123456.
 */

export const STEP_CODE_MIN_LENGTH = 6;
export const STEP_CODE_MAX_LENGTH = 10;

/** Failed attempts before the code is locked. */
export const STEP_CODE_MAX_ATTEMPTS = 5;

/** How long a locked code stays locked. */
export const STEP_CODE_LOCKOUT_MS = 15 * 60 * 1000;

export interface StepCodeValidation {
  valid: boolean;
  errors: string[];
}

/** Human-readable rules, shown next to the input so the user isn't guessing. */
export function getStepCodeRules(): string[] {
  return [
    `${STEP_CODE_MIN_LENGTH} to ${STEP_CODE_MAX_LENGTH} characters`,
    "Digits 0-9 only",
    "Not a repeated digit (e.g. 111111)",
    "Not a straight sequence (e.g. 123456)",
    "Not a date-like code (e.g. your birthday)",
  ];
}

function isAllSameDigit(code: string): boolean {
  return new Set(code).size === 1;
}

function isSequential(code: string): boolean {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < code.length; i++) {
    const diff = code.charCodeAt(i) - code.charCodeAt(i - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * Rejects DDMMYYYY / YYYYMMDD / DDMMYY shapes. Birthdays are the single most
 * common numeric code and are often discoverable from the user's own profile.
 */
function looksLikeDate(code: string): boolean {
  if (code.length === 8) {
    const asDmy = { d: +code.slice(0, 2), m: +code.slice(2, 4), y: +code.slice(4) };
    if (asDmy.d >= 1 && asDmy.d <= 31 && asDmy.m >= 1 && asDmy.m <= 12 && asDmy.y >= 1900 && asDmy.y <= 2100) {
      return true;
    }
    const asYmd = { y: +code.slice(0, 4), m: +code.slice(4, 6), d: +code.slice(6) };
    if (asYmd.y >= 1900 && asYmd.y <= 2100 && asYmd.m >= 1 && asYmd.m <= 12 && asYmd.d >= 1 && asYmd.d <= 31) {
      return true;
    }
  }
  if (code.length === 6) {
    const d = +code.slice(0, 2);
    const m = +code.slice(2, 4);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return true;
  }
  return false;
}

/** Repeating unit like 121212 or 123123 — reads as varied but has tiny entropy. */
function isRepeatingPattern(code: string): boolean {
  for (let unit = 1; unit <= code.length / 2; unit++) {
    if (code.length % unit !== 0) continue;
    const head = code.slice(0, unit);
    if (head.repeat(code.length / unit) === code) return true;
  }
  return false;
}

/**
 * The digit count a login numpad should draw for an account.
 *
 * `users.step_code_length` is null for codes enrolled before the column existed
 * and cannot be recovered from the argon2 hash, so callers get null and fall back
 * to the flexible min–max pad. Out-of-range values are treated the same way
 * rather than trusted: a pad locked to a length no code can have would leave the
 * user unable to submit at all.
 */
export function normalizeStepCodeLength(
  length: number | null | undefined
): number | null {
  if (typeof length !== "number" || !Number.isInteger(length)) return null;
  if (length < STEP_CODE_MIN_LENGTH || length > STEP_CODE_MAX_LENGTH) return null;
  return length;
}

export function validateStepCode(code: string): StepCodeValidation {
  const errors: string[] = [];

  if (!/^\d*$/.test(code)) {
    errors.push("Code must contain digits 0-9 only");
  }
  if (code.length < STEP_CODE_MIN_LENGTH || code.length > STEP_CODE_MAX_LENGTH) {
    errors.push(
      `Code must be ${STEP_CODE_MIN_LENGTH} to ${STEP_CODE_MAX_LENGTH} characters`
    );
  }

  // Pattern rules only make sense once the basic shape is right.
  if (errors.length === 0) {
    if (isAllSameDigit(code)) errors.push("Code cannot be the same digit repeated");
    else if (isSequential(code)) errors.push("Code cannot be a straight sequence");
    else if (isRepeatingPattern(code)) errors.push("Code cannot be a repeating pattern");
    else if (looksLikeDate(code)) errors.push("Code cannot look like a date");
  }

  return { valid: errors.length === 0, errors };
}

export async function hashStepCode(code: string): Promise<string> {
  return hashPassword(code);
}

export async function verifyStepCode(code: string, hash: string): Promise<boolean> {
  return verifyPassword(code, hash);
}

// ── Staged auth tokens ──────────────────────────────────────────────────────

/**
 * Login is a three-stage sequence and each stage must prove the previous one
 * passed. The token carries the stage it has *reached*, so a client cannot post
 * a TOTP code with a token that only cleared the password step and skip the
 * 2-Step Code entirely.
 *
 * `jti` binds the token to the session row created at password time, letting a
 * completed login invalidate any other token minted in the same attempt.
 */
export type AuthStage = "password" | "step_code";

interface StagedTokenPayload {
  userId: string;
  stage: AuthStage;
  jti: string;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", appSecret()).update(payload).digest("base64url");
}

export function createStagedToken(
  userId: string,
  stage: AuthStage,
  ttlMs: number = TOKEN_TTL_MS,
  jti: string = randomUUID()
): string {
  const exp = Date.now() + ttlMs;
  const payload = `${userId}.${stage}.${jti}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a staged token. `expectedStage` is required — callers must state which
 * layer they are gating, so a missing check is a compile error rather than a
 * silently skippable step.
 */
export function verifyStagedToken(
  token: string,
  expectedStage: AuthStage
): StagedTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 5) return null;

  const [userId, stage, jti, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !jti || !Number.isFinite(exp) || Date.now() > exp) return null;
  if (stage !== expectedStage) return null;

  const expected = sign(`${userId}.${stage}.${jti}.${expStr}`);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  return { userId, stage: stage as AuthStage, jti };
}
