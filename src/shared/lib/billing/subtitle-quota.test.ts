import { describe, it, expect } from "vitest";
import { SUBTITLE_QUOTA_PERIOD_MS, decideSubtitleQuota } from "@/shared/lib/billing/subtitle-quota";

/**
 * The transcription allowance, decided away from the database.
 *
 * This is the only quota in the app that guards somebody else's invoice rather than this
 * server's disk, which is why it exists at all and why it is tested this carefully: a bug that
 * lets the counter reset too eagerly does not fill a disk, it produces a bill.
 *
 * The window is rolling rather than calendar-based — the same 30 days from first use that
 * `@/shared/lib/billing/bandwidth.ts` uses — so there is no month boundary for a user to wait
 * for and no cron job to keep running.
 */

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-05T12:00:00.000Z");

describe("decideSubtitleQuota", () => {
  it("allows a request that fits, and reports the new total", () => {
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 600, periodStart: at("2026-09-01T00:00:00.000Z") },
      1_200,
      NOW
    );
    expect(decision).toEqual({
      allowed: true,
      usedSeconds: 1_800,
      periodStart: at("2026-09-01T00:00:00.000Z"),
    });
  });

  it("allows a request that exactly fills the allowance", () => {
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 600, periodStart: at("2026-09-01T00:00:00.000Z") },
      3_000,
      NOW
    );
    expect(decision.allowed).toBe(true);
  });

  it("refuses a request that would go over, and says how much is left", () => {
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 3_000, periodStart: at("2026-09-01T00:00:00.000Z") },
      1_200,
      NOW
    );
    expect(decision).toEqual({ allowed: false, remainingSeconds: 600 });
  });

  it("reports nothing left when the allowance was lowered below what is already used", () => {
    // A master can reduce a quota at any time, so `used` can legitimately exceed it.
    const decision = decideSubtitleQuota(
      { quotaSeconds: 600, usedSeconds: 3_000, periodStart: at("2026-09-01T00:00:00.000Z") },
      60,
      NOW
    );
    expect(decision).toEqual({ allowed: false, remainingSeconds: 0 });
  });

  it("starts the window on first use", () => {
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 0, periodStart: null },
      600,
      NOW
    );
    expect(decision).toEqual({ allowed: true, usedSeconds: 600, periodStart: NOW });
  });

  it("clears the counter and restarts the window once 30 days have passed", () => {
    const expired = new Date(NOW.getTime() - SUBTITLE_QUOTA_PERIOD_MS - 1);
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 3_600, periodStart: expired },
      600,
      NOW
    );
    expect(decision).toEqual({ allowed: true, usedSeconds: 600, periodStart: NOW });
  });

  it("keeps the window open right up to the last millisecond of it", () => {
    const almost = new Date(NOW.getTime() - SUBTITLE_QUOTA_PERIOD_MS + 1);
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 3_600, periodStart: almost },
      600,
      NOW
    );
    expect(decision.allowed).toBe(false);
  });

  it("treats a zero quota as unlimited, and still counts what was spent", () => {
    // Counting under an unlimited quota is a deliberate difference from the bandwidth meter:
    // the number is what tells a master how much this instance is spending.
    const decision = decideSubtitleQuota(
      { quotaSeconds: 0, usedSeconds: 100_000, periodStart: at("2026-09-01T00:00:00.000Z") },
      600,
      NOW
    );
    expect(decision).toEqual({
      allowed: true,
      usedSeconds: 100_600,
      periodStart: at("2026-09-01T00:00:00.000Z"),
    });
  });

  it("treats a negative quota as unlimited too, rather than as a locked account", () => {
    expect(
      decideSubtitleQuota({ quotaSeconds: -1, usedSeconds: 0, periodStart: null }, 600, NOW).allowed
    ).toBe(true);
  });

  it("rounds a fractional duration up, so a clip is never billed short", () => {
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 0, periodStart: NOW },
      90.4,
      NOW
    );
    expect(decision).toMatchObject({ allowed: true, usedSeconds: 91 });
  });

  it("changes nothing for a request of no length at all", () => {
    for (const seconds of [0, -5, Number.NaN]) {
      expect(
        decideSubtitleQuota({ quotaSeconds: 3_600, usedSeconds: 600, periodStart: NOW }, seconds, NOW)
      ).toEqual({ allowed: true, usedSeconds: 600, periodStart: NOW });
    }
  });

  it("refuses rather than allows when the duration is not a usable number and the quota is full", () => {
    // A duration that arrives as Infinity must not read as "nothing to bill".
    const decision = decideSubtitleQuota(
      { quotaSeconds: 3_600, usedSeconds: 0, periodStart: NOW },
      Number.POSITIVE_INFINITY,
      NOW
    );
    expect(decision).toEqual({ allowed: false, remainingSeconds: 3_600 });
  });
});
