import { eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { AuthError } from "@/shared/lib/auth/session";

const PERIOD_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export class BandwidthQuotaError extends AuthError {
  code = "BANDWIDTH_QUOTA_EXCEEDED" as const;
  constructor() {
    super("BANDWIDTH_QUOTA_EXCEEDED", 429);
  }
}

/**
 * Record outbound bandwidth for a user on a rolling 30-day window.
 * Throws BandwidthQuotaError (429) when quota would be exceeded.
 * Quota of 0 means unlimited.
 */
export async function recordBandwidth(userId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return;

  // 0 = unlimited
  if (user.bandwidthQuotaBytes <= 0) return;

  const now = new Date();
  const periodStart = user.bandwidthPeriodStart;
  const periodExpired =
    !periodStart || now.getTime() - periodStart.getTime() >= PERIOD_MS;

  const used = periodExpired ? 0 : user.bandwidthUsedBytes;
  const nextUsed = used + bytes;

  if (nextUsed > user.bandwidthQuotaBytes) {
    throw new BandwidthQuotaError();
  }

  await db
    .update(users)
    .set({
      bandwidthUsedBytes: nextUsed,
      bandwidthPeriodStart: periodExpired ? now : periodStart,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}
