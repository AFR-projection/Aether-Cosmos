import { describe, it, expect } from "vitest";
import {
  MIN_REFRESH_DELAY_MS,
  PLAYBACK_EXPIRY_DEFAULT_SECONDS,
  PLAYBACK_EXPIRY_MAX_SECONDS,
  PLAYBACK_EXPIRY_MIN_SECONDS,
  PLAYBACK_REFRESH_MARGIN_MS,
  clampPlaybackExpirySeconds,
  isPlaybackUrlStale,
  refreshDelayMs,
} from "@/shared/lib/media/playback-policy";

/**
 * These three functions decide whether a two-hour film plays to the end.
 *
 * They are pure and tiny, and every one of their edge cases is a failure nobody would report as
 * a bug: the video simply stops somewhere in the middle, once, on long files only. The client
 * hook and both playback routes read the same numbers from here, so a disagreement between the
 * timer and the signature is exactly what these tests exist to prevent.
 */

describe("clampPlaybackExpirySeconds", () => {
  it("keeps an operator's value when it is usable", () => {
    expect(clampPlaybackExpirySeconds(PLAYBACK_EXPIRY_DEFAULT_SECONDS)).toBe(
      PLAYBACK_EXPIRY_DEFAULT_SECONDS,
    );
    expect(clampPlaybackExpirySeconds(PLAYBACK_EXPIRY_MIN_SECONDS)).toBe(
      PLAYBACK_EXPIRY_MIN_SECONDS,
    );
    expect(clampPlaybackExpirySeconds(PLAYBACK_EXPIRY_MAX_SECONDS)).toBe(
      PLAYBACK_EXPIRY_MAX_SECONDS,
    );
  });

  it("refuses a lifetime too short for the refresh machinery to be worth running", () => {
    expect(clampPlaybackExpirySeconds(1)).toBe(PLAYBACK_EXPIRY_MIN_SECONDS);
    expect(clampPlaybackExpirySeconds(0)).toBe(PLAYBACK_EXPIRY_MIN_SECONDS);
    expect(clampPlaybackExpirySeconds(-3600)).toBe(PLAYBACK_EXPIRY_MIN_SECONDS);
  });

  it("caps a lifetime that would leave a copied URL working for a week", () => {
    expect(clampPlaybackExpirySeconds(PLAYBACK_EXPIRY_MAX_SECONDS * 7)).toBe(
      PLAYBACK_EXPIRY_MAX_SECONDS,
    );
  });

  it("never hands a fractional or NaN lifetime to the signer", () => {
    expect(clampPlaybackExpirySeconds(7200.9)).toBe(7200);
    expect(clampPlaybackExpirySeconds(Number.NaN)).toBe(
      PLAYBACK_EXPIRY_DEFAULT_SECONDS,
    );
    expect(clampPlaybackExpirySeconds(Number.POSITIVE_INFINITY)).toBe(
      PLAYBACK_EXPIRY_DEFAULT_SECONDS,
    );
  });

  it("leaves the floor below the default and the default below the ceiling", () => {
    expect(PLAYBACK_EXPIRY_MIN_SECONDS).toBeLessThan(
      PLAYBACK_EXPIRY_DEFAULT_SECONDS,
    );
    expect(PLAYBACK_EXPIRY_DEFAULT_SECONDS).toBeLessThan(
      PLAYBACK_EXPIRY_MAX_SECONDS,
    );
  });

  it("keeps the refresh margin well inside the shortest lifetime it could be applied to", () => {
    // Otherwise the floor would schedule a refresh before the URL was even issued.
    expect(PLAYBACK_REFRESH_MARGIN_MS).toBeLessThan(
      PLAYBACK_EXPIRY_MIN_SECONDS * 1000,
    );
  });
});

describe("refreshDelayMs", () => {
  const now = 1_700_000_000_000;

  it("re-issues one margin before the signature dies", () => {
    const twoHours = now + 7_200_000;
    expect(refreshDelayMs({ expiresAtMs: twoHours, nowMs: now })).toBe(
      7_200_000 - PLAYBACK_REFRESH_MARGIN_MS,
    );
  });

  it("returns null for a source that cannot expire", () => {
    // The legacy proxy URL and a decrypted blob. Putting either on a timer would re-load a
    // perfectly good video for no reason.
    expect(refreshDelayMs({ expiresAtMs: null, nowMs: now })).toBeNull();
    expect(refreshDelayMs({ expiresAtMs: Number.NaN, nowMs: now })).toBeNull();
  });

  it("never schedules a stampede when the deadline is already inside the margin", () => {
    expect(refreshDelayMs({ expiresAtMs: now + 1_000, nowMs: now })).toBe(
      MIN_REFRESH_DELAY_MS,
    );
    expect(refreshDelayMs({ expiresAtMs: now, nowMs: now })).toBe(
      MIN_REFRESH_DELAY_MS,
    );
    // Already dead — a tab that came back from being suspended for a day.
    expect(refreshDelayMs({ expiresAtMs: now - 86_400_000, nowMs: now })).toBe(
      MIN_REFRESH_DELAY_MS,
    );
  });

  it("honours a caller's own margin", () => {
    expect(
      refreshDelayMs({
        expiresAtMs: now + 60_000,
        nowMs: now,
        marginMs: 10_000,
      }),
    ).toBe(50_000);
  });

  it("always leaves time for a range request that is already in flight", () => {
    // The failure this prevents: a request that STARTS before expiry and finishes after it is
    // not retried by a media element, it surfaces as a stall.
    const delay = refreshDelayMs({ expiresAtMs: now + 600_000, nowMs: now });
    expect(delay).not.toBeNull();
    expect(now + (delay as number)).toBeLessThan(now + 600_000);
  });
});

describe("isPlaybackUrlStale", () => {
  const now = 1_700_000_000_000;

  it("is false for a URL with plenty of life left", () => {
    expect(
      isPlaybackUrlStale({ expiresAtMs: now + 3_600_000, nowMs: now }),
    ).toBe(false);
  });

  it("is true once the deadline is inside the margin", () => {
    expect(
      isPlaybackUrlStale({
        expiresAtMs: now + PLAYBACK_REFRESH_MARGIN_MS,
        nowMs: now,
      }),
    ).toBe(true);
    expect(isPlaybackUrlStale({ expiresAtMs: now - 1, nowMs: now })).toBe(true);
  });

  it("is false for a source with no expiry at all", () => {
    // A blob URL is not stale, ever. Answering true would put the encrypted path into a refresh
    // loop against an endpoint that would refuse it.
    expect(isPlaybackUrlStale({ expiresAtMs: null, nowMs: now })).toBe(false);
    expect(isPlaybackUrlStale({ expiresAtMs: Number.NaN, nowMs: now })).toBe(
      false,
    );
  });

  it("agrees with refreshDelayMs about where the boundary is", () => {
    // The two are read by different callers — the visibility check and the timer — and a
    // disagreement would mean a tab that refuses to refresh a URL it also refuses to use.
    const expiresAtMs = now + PLAYBACK_REFRESH_MARGIN_MS + 1_000;
    expect(isPlaybackUrlStale({ expiresAtMs, nowMs: now })).toBe(false);
    expect(refreshDelayMs({ expiresAtMs, nowMs: now })).toBe(
      MIN_REFRESH_DELAY_MS,
    );
    expect(isPlaybackUrlStale({ expiresAtMs, nowMs: now + 1_001 })).toBe(true);
  });
});
