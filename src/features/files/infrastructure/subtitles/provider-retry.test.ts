import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  fullJitterBackoffMs,
  parseRetryAfter,
  retryAvailableAt,
} from "./provider-retry";

describe("parseRetryAfter", () => {
  it("parses numeric delay-seconds", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
    expect(parseRetryAfter("0.5")).toBe(500);
  });

  it("parses an HTTP-date relative to the supplied clock", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now)).toBe(60_000);
  });

  it("clamps a past HTTP-date and rejects invalid values", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:29:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("tomorrow-ish", now)).toBeUndefined();
    expect(parseRetryAfter("-1", now)).toBeUndefined();
  });
});

describe("provider failure classification", () => {
  it.each([408, 409, 425, 429, 500, 503])("treats HTTP %i as transient", (status) => {
    expect(classifyProviderFailure({ status }).transient).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])("treats HTTP %i as permanent", (status) => {
    expect(classifyProviderFailure({ status }).transient).toBe(false);
  });

  it("recognizes timeout and network failures", () => {
    expect(classifyProviderFailure(new DOMException("aborted", "AbortError"))).toMatchObject({
      transient: true,
      kind: "timeout",
    });
    expect(classifyProviderFailure(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toMatchObject({
      transient: true,
      kind: "network",
    });
  });
});

describe("full-jitter backoff", () => {
  it("uses the exponential ceiling and deterministic injected random source", () => {
    expect(fullJitterBackoffMs({ attempt: 4, baseMs: 1_000, random: () => 0.5 })).toBe(4_000);
  });

  it("honours Retry-After as a floor and caps exponential growth", () => {
    expect(fullJitterBackoffMs({ attempt: 2, retryAfterMs: 30_000, random: () => 0 })).toBe(30_000);
    expect(fullJitterBackoffMs({ attempt: 30, capMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it("computes an available-at timestamp without sleeping", () => {
    expect(retryAvailableAt({ attempt: 1, random: () => 1 }, 1_000).getTime()).toBe(2_000);
  });
});
