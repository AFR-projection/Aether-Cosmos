/**
 * The transcription allowance, as a decision rather than a database write.
 *
 * Lives in `src/shared/lib/billing` next to `bandwidth.ts` rather than in the files feature, and
 * that placement is enforced: the rule reads three columns of `users`, which is a platform table, so
 * a feature owning it would make `src/shared` depend on a feature to bill its own accounts.
 *
 * `bandwidth.ts` reads a row, decides, and updates it in one function, which is why it has no
 * tests. This quota gets the decision separated out, because it is the only meter in the app that
 * guards **somebody else's invoice** rather than this server's disk: a counter that resets a day
 * early does not fill a volume, it produces a bill. So the rule is pure, and
 * `subtitle-quota.test.ts` covers the window edges the DB wrapper could not reach.
 *
 * Two deliberate differences from the bandwidth meter, both worth knowing:
 *
 *  - **Usage is counted even when the quota is unlimited.** Bandwidth returns early for `0`;
 *    here the number is the only thing that tells a master how much the instance is spending,
 *    so it is always kept.
 *  - **Durations round up.** A 90.4-second clip bills 91 seconds. Rounding the other way would
 *    let a stream of short clips run permanently free.
 */

/** The rolling window, matching `bandwidth.ts` so an operator has one convention to remember. */
export const SUBTITLE_QUOTA_PERIOD_MS = 1000 * 60 * 60 * 24 * 30;

/** What the account's row says right now. */
export type SubtitleAllowance = {
  /** `0` or below means unlimited, matching how `bandwidth_quota_bytes` reads. */
  readonly quotaSeconds: number;
  readonly usedSeconds: number;
  /** `null` before the account's first transcription. */
  readonly periodStart: Date | null;
};

export type SubtitleQuotaDecision =
  /** Go ahead, and write these two values back. */
  | { readonly allowed: true; readonly usedSeconds: number; readonly periodStart: Date }
  /** Refuse, and tell the user how much of their allowance is left. */
  | { readonly allowed: false; readonly remainingSeconds: number };

/**
 * Whether this much audio may be transcribed, and what the account's counters become if so.
 *
 * A duration that is not a usable number is handled explicitly rather than falling through:
 * `Infinity` means the media length was never established and is refused, while `NaN`, zero and
 * negatives mean there is nothing to bill and pass through as a no-op. Both are pinned by tests,
 * because "unknown length" and "no length" arriving at the same branch is how a meter silently
 * stops metering.
 */
export function decideSubtitleQuota(
  allowance: SubtitleAllowance,
  requestedSeconds: number,
  now: Date = new Date()
): SubtitleQuotaDecision {
  const periodExpired =
    !allowance.periodStart ||
    now.getTime() - allowance.periodStart.getTime() >= SUBTITLE_QUOTA_PERIOD_MS;

  const periodStart = periodExpired ? now : allowance.periodStart;
  const used = periodExpired ? 0 : Math.max(0, allowance.usedSeconds);
  const unlimited = allowance.quotaSeconds <= 0;

  // The media length was never established. Refusing is the right way to be wrong here:
  // billing an unknown amount of work, or billing nothing for it, are both worse.
  if (requestedSeconds === Number.POSITIVE_INFINITY) {
    return unlimited
      ? { allowed: true, usedSeconds: used, periodStart }
      : { allowed: false, remainingSeconds: Math.max(0, allowance.quotaSeconds - used) };
  }

  // NaN, zero or negative: nothing measurable to bill. Not an error — the counters are handed
  // back untouched so the caller writes the same values it read.
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    return { allowed: true, usedSeconds: used, periodStart };
  }

  const billed = Math.ceil(requestedSeconds);
  const total = used + billed;

  if (!unlimited && total > allowance.quotaSeconds) {
    return { allowed: false, remainingSeconds: Math.max(0, allowance.quotaSeconds - used) };
  }

  return { allowed: true, usedSeconds: total, periodStart };
}

/** What is left of the allowance right now, for the UI. `null` when unlimited. */
export function remainingSubtitleSeconds(
  allowance: SubtitleAllowance,
  now: Date = new Date()
): number | null {
  if (allowance.quotaSeconds <= 0) return null;
  const periodExpired =
    !allowance.periodStart ||
    now.getTime() - allowance.periodStart.getTime() >= SUBTITLE_QUOTA_PERIOD_MS;
  const used = periodExpired ? 0 : Math.max(0, allowance.usedSeconds);
  return Math.max(0, allowance.quotaSeconds - used);
}
