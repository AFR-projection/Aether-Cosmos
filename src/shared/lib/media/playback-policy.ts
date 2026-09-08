/**
 * Lifetime and refresh policy for a presigned media playback URL.
 *
 * In `src/shared` rather than beside the rest of the playback rules because
 * `admin-settings.ts` needs the default and the clamp, and shared may not import a feature.
 * The client hook and both playback routes read the same numbers from here, so the timer that
 * refreshes a URL and the signature that expires it can never drift apart.
 *
 * Pure, no imports: it is loaded by an API route, a worker-free server module and a browser
 * bundle alike.
 */

/**
 * A playback URL's lifetime is a security tradeoff, and it is a different one from a
 * download's.
 *
 * A download URL is handed to the browser and used once, within seconds — 60 s is right for
 * it. A playback URL signs every buffer segment and every seek for the whole viewing, because
 * the browser issues a NEW range request for each of them against the same URL. Expire it at
 * 60 s and a film stops one minute in.
 *
 * 2 hours is the default: long enough that the overwhelming majority of videos are watched end
 * to end without a single re-issue, short enough that a URL copied out of a network log is
 * worthless by the evening. Longer buys nothing the player needs — `refreshDelayMs` covers the
 * tail — so the extra leak window would be free risk.
 *
 * The 5-minute floor is not arbitrary either: below that the refresh machinery interrupts more
 * often than the shorter window is worth.
 */
export const PLAYBACK_EXPIRY_MIN_SECONDS = 300;
export const PLAYBACK_EXPIRY_MAX_SECONDS = 86_400;
export const PLAYBACK_EXPIRY_DEFAULT_SECONDS = 7_200;

/**
 * How long before expiry a fresh URL is fetched.
 *
 * It has to exceed the longest range request a player might have in flight: a request that
 * STARTS before expiry but is still running when the signature dies is not retried by the
 * media element, it surfaces as a stall. 90 s is generous for one buffer segment and a
 * rounding error against a 2-hour lifetime.
 */
export const PLAYBACK_REFRESH_MARGIN_MS = 90_000;

/** Never schedule a timer shorter than this; a stampede of refreshes is worse than one late. */
export const MIN_REFRESH_DELAY_MS = 5_000;

export function clampPlaybackExpirySeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return PLAYBACK_EXPIRY_DEFAULT_SECONDS;
  return Math.min(
    PLAYBACK_EXPIRY_MAX_SECONDS,
    Math.max(PLAYBACK_EXPIRY_MIN_SECONDS, Math.floor(seconds)),
  );
}

/**
 * Milliseconds to wait before re-issuing, or `null` when this source never expires — the
 * legacy proxy URL and a decrypted blob are both in that case and neither may be put on a
 * refresh timer.
 */
export function refreshDelayMs(input: {
  expiresAtMs: number | null;
  nowMs: number;
  marginMs?: number;
}): number | null {
  if (input.expiresAtMs === null || !Number.isFinite(input.expiresAtMs))
    return null;
  const margin = input.marginMs ?? PLAYBACK_REFRESH_MARGIN_MS;
  return Math.max(
    MIN_REFRESH_DELAY_MS,
    input.expiresAtMs - margin - input.nowMs,
  );
}

/**
 * Whether a URL is close enough to death that the next range request could fail.
 *
 * Covers the two cases the timer cannot: a background tab, where `setTimeout` is throttled and
 * the deadline can pass unnoticed, and a media error, where the cause may simply be that R2
 * refused an expired signature.
 */
export function isPlaybackUrlStale(input: {
  expiresAtMs: number | null;
  nowMs: number;
  marginMs?: number;
}): boolean {
  if (input.expiresAtMs === null || !Number.isFinite(input.expiresAtMs))
    return false;
  return (
    input.nowMs >=
    input.expiresAtMs - (input.marginMs ?? PLAYBACK_REFRESH_MARGIN_MS)
  );
}
