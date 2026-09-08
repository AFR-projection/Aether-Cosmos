import { describe, expect, it } from "vitest";
import {
  REFRESH_MAX_ATTEMPTS,
  classifyRefusal,
  issuanceFailureAction,
  isFallbackWorthy,
  mediaErrorOutcome,
} from "./playback-recovery";

/**
 * The player's survival rules, decided by pure functions rather than buried in hook state.
 *
 * Every case below is one where a viewer either loses their place in a two-hour film, gets a
 * fallback they were never meant to need, or sees a refusal word that does not match what the
 * server said. The hook and the viewer apply these decisions; the numbers here are what the
 * server contract in `tests/playback-capability-routes.test.ts` promises.
 */

describe("classifyRefusal", () => {
  it("maps each named refusal code to its reader-facing cause", () => {
    expect(classifyRefusal(404, "PLAYBACK_NOT_FOUND")).toBe("not-found");
    expect(classifyRefusal(409, "PLAYBACK_NOT_READY")).toBe("not-ready");
    expect(classifyRefusal(404, "PLAYBACK_NO_OBJECT")).toBe("not-ready");
    expect(classifyRefusal(415, "PLAYBACK_UNSUPPORTED")).toBe("unsupported");
    expect(classifyRefusal(400, "PLAYBACK_NOTE")).toBe("unsupported");
    expect(classifyRefusal(402, "BANDWIDTH_QUOTA_EXCEEDED")).toBe("quota");
    expect(classifyRefusal(429, "RATE_LIMITED")).toBe("rate-limited");
    expect(classifyRefusal(403, "SHARE_EXPIRED")).toBe("share-expired");
    expect(classifyRefusal(403, "SHARE_EXHAUSTED")).toBe("share-exhausted");
  });

  it("falls back to the status when the code is unknown or missing", () => {
    expect(classifyRefusal(401, undefined)).toBe("unauthorized");
    expect(classifyRefusal(403, "SOMETHING_ELSE")).toBe("unauthorized");
    expect(classifyRefusal(404, undefined)).toBe("not-found");
    expect(classifyRefusal(500, undefined)).toBe("server");
    expect(classifyRefusal(502, "BANDWIDTH_QUOTA_EXCEEDED")).toBe("quota");
  });

  it("reads a missing response as a network break, not a server refusal", () => {
    expect(classifyRefusal(0, undefined)).toBe("network");
    expect(classifyRefusal(0, "PLAYBACK_NOT_FOUND")).toBe("network");
  });
});

describe("isFallbackWorthy", () => {
  it("sends only a broken path to the legacy proxy, never a settled refusal", () => {
    expect(isFallbackWorthy("server")).toBe(true);
    expect(isFallbackWorthy("network")).toBe(true);
    for (const code of [
      "unauthorized",
      "not-found",
      "not-ready",
      "unsupported",
      "quota",
      "rate-limited",
      "share-expired",
      "share-exhausted",
    ] as const) {
      expect(isFallbackWorthy(code), code).toBe(false);
    }
  });
});

describe("issuanceFailureAction", () => {
  it("hands an operator-forced proxy straight to the fallback without an error", () => {
    expect(
      issuanceFailureAction({
        refusalCode: "PLAYBACK_PROXY_FORCED",
        isRefresh: true,
        attempts: 0,
        errorCode: "server",
        hasFallbackUrl: true,
      }),
    ).toBe("proxy");
  });

  it("does not treat a forced proxy as a proxy when there is nothing to fall back to", () => {
    expect(
      issuanceFailureAction({
        refusalCode: "PLAYBACK_PROXY_FORCED",
        isRefresh: false,
        attempts: 0,
        errorCode: "server",
        hasFallbackUrl: false,
      }),
    ).toBe("error");
  });

  it("retries a failed RE-ISSUE quietly while the current URL still works", () => {
    for (let attempts = 1; attempts < REFRESH_MAX_ATTEMPTS; attempts++) {
      expect(
        issuanceFailureAction({
          refusalCode: null,
          isRefresh: true,
          attempts,
          errorCode: "server",
          hasFallbackUrl: true,
        }),
      ).toBe("retry");
    }
  });

  it("never retries the first issuance — a failed start has no URL to keep", () => {
    expect(
      issuanceFailureAction({
        refusalCode: null,
        isRefresh: false,
        attempts: 0,
        errorCode: "server",
        hasFallbackUrl: true,
      }),
    ).toBe("fallback");
  });

  it("exhausts the retry budget before falling back, keeping the working URL as long as it lives", () => {
    const exhausted = {
      refusalCode: null,
      isRefresh: true,
      attempts: REFRESH_MAX_ATTEMPTS,
      errorCode: "server" as const,
      hasFallbackUrl: true,
    };
    expect(issuanceFailureAction(exhausted)).toBe("fallback");
    expect(
      issuanceFailureAction({ ...exhausted, hasFallbackUrl: false }),
    ).toBe("error");
  });

  it("never hides a settled refusal behind the proxy", () => {
    for (const errorCode of [
      "unauthorized",
      "not-found",
      "not-ready",
      "unsupported",
      "quota",
      "rate-limited",
      "share-expired",
      "share-exhausted",
    ] as const) {
      expect(
        issuanceFailureAction({
          refusalCode: null,
          isRefresh: false,
          attempts: 0,
          errorCode,
          hasFallbackUrl: true,
        }),
        errorCode,
      ).toBe("error");
    }
  });

  it("reports the cause when the fallback is unavailable and the path is broken", () => {
    expect(
      issuanceFailureAction({
        refusalCode: null,
        isRefresh: false,
        attempts: 0,
        errorCode: "network",
        hasFallbackUrl: false,
      }),
    ).toBe("error");
  });
});

describe("mediaErrorOutcome", () => {
  const reissuable = {
    aborted: false,
    decode: false,
    network: true,
    reissuable: true,
    recoveryAttempts: 0,
    recoveryLimit: 2,
  };

  it("ignores ABORTED: replacing the URL mid-load is what we just did", () => {
    expect(mediaErrorOutcome({ ...reissuable, aborted: true })).toBe("ignore");
  });

  it("re-issues a network failure on the direct path, as long as the budget lasts", () => {
    expect(mediaErrorOutcome(reissuable)).toBe("recover");
    expect(mediaErrorOutcome({ ...reissuable, recoveryAttempts: 1 })).toBe("recover");
  });

  it("stops re-issuing when the budget is spent — a truncated object will break again", () => {
    expect(mediaErrorOutcome({ ...reissuable, recoveryAttempts: 2 })).toBe("network");
    expect(
      mediaErrorOutcome({ ...reissuable, network: false, recoveryAttempts: 2 }),
    ).toBe("unsupported");
  });

  it("never re-issues a decode failure: a fresh URL delivers the same bytes", () => {
    expect(
      mediaErrorOutcome({ ...reissuable, decode: true, network: false, recoveryAttempts: 0 }),
    ).toBe("decode");
  });

  it("says the honest thing on the proxy path, which cannot re-issue at all", () => {
    expect(mediaErrorOutcome({ ...reissuable, reissuable: false })).toBe("network");
    expect(
      mediaErrorOutcome({ ...reissuable, reissuable: false, decode: true, network: false }),
    ).toBe("decode");
  });
});
