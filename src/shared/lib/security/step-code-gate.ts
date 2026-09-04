import { eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import {
  STEP_CODE_LOCKOUT_MS,
  STEP_CODE_MAX_ATTEMPTS,
  verifyStepCode,
} from "./step-code";

/**
 * Re-check a signed-in user's 2-Step Code, using the counters login uses.
 *
 * Login keeps its own copy of this sequence because it also mints staged tokens
 * and backfills the code's recorded length. Everything *else* that wants the
 * second factor again — today a backup download, tomorrow whatever else is
 * irreversible — comes through here, so there is one place the lockout can be
 * got wrong and one place to fix it.
 *
 * The counters live on `users` rather than in Redis deliberately: a lockout that
 * evaporates when the cache restarts is not a lockout.
 */

export type StepCodeDenial = "not_set" | "locked" | "incorrect";

export interface StepCodeAccepted {
  ok: true;
}

export interface StepCodeRejected {
  ok: false;
  reason: StepCodeDenial;
  /** Ready to show a user: says what to do, not only what failed. */
  message: string;
  /** The HTTP status this denial deserves, so every caller answers alike. */
  status: number;
  /** The machine code the login flow already uses for the same three cases. */
  code: "STEP_CODE_NOT_SET" | "STEP_CODE_LOCKED" | "STEP_CODE_INVALID";
  /** Attempts left before the lock closes. Zero once it has. */
  remaining: number;
  /** True on the attempt that closed it, so the caller can audit and notify. */
  justLocked: boolean;
}

export type StepCodeCheck = StepCodeAccepted | StepCodeRejected;

const LOCKOUT_MINUTES = Math.round(STEP_CODE_LOCKOUT_MS / 60_000);

/**
 * Verify `code` against the account's stored hash.
 *
 * A wrong code costs one attempt and, on the fifth, closes the same 15-minute
 * lock login uses — the two endpoints share the counter rather than each getting
 * five tries of their own, because five tries per surface is not a limit.
 */
export async function checkStepCode(userId: string, code: string): Promise<StepCodeCheck> {
  const [row] = await db
    .select({
      hash: users.stepCodeHash,
      failedAttempts: users.stepCodeFailedAttempts,
      lockedUntil: users.stepCodeLockedUntil,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // A missing row and an account with no code are the same answer to the caller:
  // this factor cannot be checked, so the action cannot proceed.
  if (!row?.hash) {
    return {
      ok: false,
      reason: "not_set",
      message:
        "This action needs your 2-Step Code, and your account does not have one yet. " +
        "Set one in your account settings, then try again.",
      status: 400,
      code: "STEP_CODE_NOT_SET",
      remaining: 0,
      justLocked: false,
    };
  }

  if (row.lockedUntil && new Date(row.lockedUntil) > new Date()) {
    return {
      ok: false,
      reason: "locked",
      message:
        "Your 2-Step Code is temporarily locked after repeated incorrect entries. " +
        `Try again in ${LOCKOUT_MINUTES} minutes.`,
      status: 429,
      code: "STEP_CODE_LOCKED",
      remaining: 0,
      justLocked: false,
    };
  }

  if (await verifyStepCode(code, row.hash)) {
    // Written only when there is something to clear, so the common case costs one
    // SELECT and no UPDATE.
    if ((row.failedAttempts ?? 0) > 0) {
      await db
        .update(users)
        .set({
          stepCodeFailedAttempts: 0,
          stepCodeLockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    }
    return { ok: true };
  }

  const attempts = (row.failedAttempts ?? 0) + 1;
  const justLocked = attempts >= STEP_CODE_MAX_ATTEMPTS;

  await db
    .update(users)
    .set({
      stepCodeFailedAttempts: attempts,
      stepCodeLockedUntil: justLocked ? new Date(Date.now() + STEP_CODE_LOCKOUT_MS) : null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  const remaining = Math.max(0, STEP_CODE_MAX_ATTEMPTS - attempts);
  return {
    ok: false,
    reason: "incorrect",
    message: justLocked
      ? `Incorrect 2-Step Code. Your code is now locked for ${LOCKOUT_MINUTES} minutes.`
      : `Incorrect 2-Step Code. ${remaining} attempt(s) remaining.`,
    // A locked account is throttled, not unauthorized: the difference tells the UI
    // whether to keep the input open or to stop offering it.
    status: justLocked ? 429 : 401,
    code: justLocked ? "STEP_CODE_LOCKED" : "STEP_CODE_INVALID",
    remaining,
    justLocked,
  };
}
