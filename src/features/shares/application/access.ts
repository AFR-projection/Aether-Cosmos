import { and, eq, isNull, or, lt, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { shares, users, type Share } from "@/shared/infrastructure/db/schema";
import { BandwidthQuotaError } from "@/shared/lib/billing/bandwidth";

const BANDWIDTH_PERIOD_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * The access budget on a share link (`maxAccessCount`).
 *
 * Two things were wrong with enforcing it inline:
 *
 *  1. It was read-then-written (`accessCount + 1` computed in JS), so a burst of
 *     concurrent hits all read the same count and all passed the limit check — a
 *     "one view" link served everyone who arrived together.
 *  2. Only the metadata endpoint counted. The endpoint that actually streams the
 *     bytes checked the (never-incremented) counter and served the file, so a
 *     caller who skipped straight to the content URL had an unlimited link.
 *
 * The budget is therefore claimed in one statement, on the path that delivers the
 * content: `claimShareAccess` returns the updated row when a unit was available
 * and null when the link is spent.
 */

/** True when the link has no budget left. Read-only — claims nothing. */
export function shareBudgetExhausted(
  share: Pick<Share, "accessCount" | "maxAccessCount">,
): boolean {
  return !!share.maxAccessCount && share.accessCount >= share.maxAccessCount;
}

export function shareExpired(share: Pick<Share, "expiresAt">): boolean {
  return !!share.expiresAt && share.expiresAt < new Date();
}

/**
 * Spend one unit of the link's budget. Single statement: the check and the
 * increment cannot be separated by another request.
 */
/**
 * How long after a paid access a resumed transfer stays free.
 *
 * The content route exempts a `Range` request that starts past byte 0, so that
 * resuming an interrupted download does not cost a second unit of a view-limited
 * link. On its own that exemption was unconditional and therefore unlimited: an
 * anonymous caller who never sent a plain request — only `Range: bytes=1-` —
 * never spent a unit, so `maxAccessCount` bounded nothing.
 *
 * A continuation is only free when there is something to continue: a unit was
 * already spent on this link, recently.
 */
export const SHARE_RESUME_WINDOW_MS = 5 * 60 * 1000;

/** True when a range request may skip the budget because it resumes a paid access. */
export function shareResumeIsFree(
  share: Pick<Share, "accessCount" | "lastAccessedAt">,
  now: Date = new Date(),
): boolean {
  if (share.accessCount < 1) return false;
  if (!share.lastAccessedAt) return false;
  return (
    now.getTime() - share.lastAccessedAt.getTime() <= SHARE_RESUME_WINDOW_MS
  );
}

export async function claimShareAccess(shareId: string): Promise<Share | null> {
  const [row] = await db
    .update(shares)
    .set({
      accessCount: sql`${shares.accessCount} + 1`,
      lastAccessedAt: new Date(),
    })
    .where(
      and(
        eq(shares.id, shareId),
        or(
          isNull(shares.maxAccessCount),
          lt(shares.accessCount, shares.maxAccessCount),
        ),
      ),
    )
    .returning();

  return row ?? null;
}

export type SharePlaybackReservation =
  "reserved" | "share-unavailable" | "share-exhausted";

export class SharePlaybackReservationError extends Error {
  constructor() {
    super("Playback owner is unavailable");
    this.name = "SharePlaybackReservationError";
  }
}

/**
 * Reserve one share capability and its owner's egress in one transaction.
 *
 * Both rows are locked in a fixed order (share, then owner), so two concurrent
 * issuances cannot overspend either ceiling and a failure rolls both counters back.
 */
export async function reserveSharePlaybackAccess(
  shareId: string,
  ownerId: string,
  bytes: number,
): Promise<SharePlaybackReservation> {
  return db.transaction(async (tx) => {
    const [share] = await tx
      .select()
      .from(shares)
      .where(eq(shares.id, shareId))
      .limit(1)
      .for("update");
    if (!share) return "share-unavailable";
    if (
      share.maxAccessCount !== null &&
      share.accessCount >= share.maxAccessCount
    ) {
      return "share-exhausted";
    }

    const [owner] = await tx
      .select()
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
      .for("update");
    if (!owner) throw new SharePlaybackReservationError();

    const now = new Date();
    if (bytes > 0 && owner.bandwidthQuotaBytes > 0) {
      const periodExpired =
        !owner.bandwidthPeriodStart ||
        now.getTime() - owner.bandwidthPeriodStart.getTime() >=
          BANDWIDTH_PERIOD_MS;
      const nextUsed = (periodExpired ? 0 : owner.bandwidthUsedBytes) + bytes;
      if (nextUsed > owner.bandwidthQuotaBytes) {
        throw new BandwidthQuotaError();
      }

      await tx
        .update(users)
        .set({
          bandwidthUsedBytes: nextUsed,
          bandwidthPeriodStart: periodExpired
            ? now
            : owner.bandwidthPeriodStart,
          updatedAt: now,
        })
        .where(eq(users.id, ownerId));
    }

    await tx
      .update(shares)
      .set({
        accessCount: share.accessCount + 1,
        lastAccessedAt: now,
      })
      .where(eq(shares.id, shareId));

    return "reserved";
  });
}
