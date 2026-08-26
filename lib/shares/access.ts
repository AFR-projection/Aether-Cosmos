import { and, eq, isNull, or, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { shares, type Share } from "@/lib/db/schema";

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
export function shareBudgetExhausted(share: Pick<Share, "accessCount" | "maxAccessCount">): boolean {
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
  now: Date = new Date()
): boolean {
  if (share.accessCount < 1) return false;
  if (!share.lastAccessedAt) return false;
  return now.getTime() - share.lastAccessedAt.getTime() <= SHARE_RESUME_WINDOW_MS;
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
        or(isNull(shares.maxAccessCount), lt(shares.accessCount, shares.maxAccessCount))
      )
    )
    .returning();

  return row ?? null;
}
