import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { db as defaultDb } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { AuthError } from "@/shared/lib/auth/session";
import {
  decideSubtitleQuota,
  remainingSubtitleSeconds,
  type SubtitleAllowance,
} from "@/shared/lib/billing/subtitle-quota";

/**
 * The transcription meter: read the account's row, apply the rule, write it back.
 *
 * Sibling of `./bandwidth.ts` and shaped like it on purpose, so an operator has one convention to
 * learn — a rolling 30-day window, `0` meaning unlimited, three columns on `users`. The difference
 * is what it guards: bandwidth protects this server's uplink, and this protects the operator's
 * invoice at a transcription provider. That is why the decision itself lives in
 * `@/shared/lib/billing/subtitle-quota.ts` and is unit-tested there: the window edges of a meter
 * that costs money are worth pinning, and they cannot be reached through a database.
 *
 * Called by the worker rather than the route, and after ffmpeg rather than before it. That ordering
 * is deliberate: the media's real length is not known until the audio has been segmented, and
 * billing a guess would either overcharge a short file or let a long one through. ffmpeg time is
 * this server's own, so spending it before the check costs nothing anybody is billed for.
 */

type BillingDb = PostgresJsDatabase<typeof schema>;

export class SubtitleQuotaError extends AuthError {
  code = "SUBTITLE_QUOTA_EXCEEDED" as const;
  /** What is left of the allowance, so the message can say how much. */
  readonly remainingSeconds: number;

  constructor(remainingSeconds: number) {
    super("SUBTITLE_QUOTA_EXCEEDED", 429);
    this.remainingSeconds = remainingSeconds;
  }
}

async function readAllowance(
  userId: string,
  db: BillingDb
): Promise<SubtitleAllowance | null> {
  const [row] = await db
    .select({
      quotaSeconds: users.subtitleQuotaSeconds,
      usedSeconds: users.subtitleUsedSeconds,
      periodStart: users.subtitlePeriodStart,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Record transcription time against an account, or refuse.
 *
 * Throws {@link SubtitleQuotaError} (429) when the request would go over. An account that does not
 * exist is a no-op rather than a throw, matching `recordBandwidth`: the caller has already
 * established the file's owner, and failing a job because a row vanished mid-flight would be
 * reporting the wrong problem.
 */
export async function recordSubtitleSeconds(
  userId: string,
  seconds: number,
  db: BillingDb = defaultDb
): Promise<void> {
  const allowance = await readAllowance(userId, db);
  if (!allowance) return;

  const decision = decideSubtitleQuota(allowance, seconds);
  if (!decision.allowed) throw new SubtitleQuotaError(decision.remainingSeconds);

  await db
    .update(users)
    .set({
      subtitleUsedSeconds: decision.usedSeconds,
      subtitlePeriodStart: decision.periodStart,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * What is left of an account's allowance, without spending any of it.
 *
 * `null` means unlimited. The generate route calls this to refuse an account that has nothing left
 * *before* a worker slot and an R2 download are spent on it — the worker still applies the real
 * check against the measured duration, because this one cannot know how long the file is.
 */
export async function subtitleSecondsRemaining(
  userId: string,
  db: BillingDb = defaultDb
): Promise<number | null> {
  const allowance = await readAllowance(userId, db);
  if (!allowance) return null;
  return remainingSubtitleSeconds(allowance);
}
