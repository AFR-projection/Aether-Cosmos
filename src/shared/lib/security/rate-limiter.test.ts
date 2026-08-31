import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkIpRateLimit,
  peekIpRateLimit,
  resetIpRateLimit,
} from "@/shared/lib/security/rate-limiter";

// This is the in-memory fallback used when Redis is unavailable. Each test
// uses a unique IP so entries never collide across cases.
let ipCounter = 0;
function freshIp(): string {
  return `10.0.0.${ipCounter++}`;
}

describe("in-memory rate limiter (Redis fallback)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows attempts up to the max, then blocks", () => {
    const ip = freshIp();
    const max = 3;
    const window = 60_000;

    const r1 = checkIpRateLimit(ip, max, window);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    checkIpRateLimit(ip, max, window); // 2nd
    const r3 = checkIpRateLimit(ip, max, window); // 3rd — still allowed
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = checkIpRateLimit(ip, max, window); // 4th — blocked
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("peek reports the current count without incrementing", () => {
    const ip = freshIp();
    checkIpRateLimit(ip, 5, 60_000);
    checkIpRateLimit(ip, 5, 60_000);

    expect(peekIpRateLimit(ip, 60_000)).toBe(2);
    // Peeking again does not change the count.
    expect(peekIpRateLimit(ip, 60_000)).toBe(2);
  });

  it("resets the window after the time window elapses", () => {
    const ip = freshIp();
    const window = 1_000;

    checkIpRateLimit(ip, 2, window);
    checkIpRateLimit(ip, 2, window);
    expect(checkIpRateLimit(ip, 2, window).allowed).toBe(false);

    // Advance past the window — the bucket should be considered expired.
    vi.advanceTimersByTime(window + 1);

    const afterReset = checkIpRateLimit(ip, 2, window);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(1);
  });

  it("manual reset clears the bucket", () => {
    const ip = freshIp();
    checkIpRateLimit(ip, 2, 60_000);
    checkIpRateLimit(ip, 2, 60_000);
    expect(checkIpRateLimit(ip, 2, 60_000).allowed).toBe(false);

    resetIpRateLimit(ip);

    expect(checkIpRateLimit(ip, 2, 60_000).allowed).toBe(true);
  });

  it("peek returns 0 for an IP that was never seen", () => {
    expect(peekIpRateLimit(freshIp(), 60_000)).toBe(0);
  });
});
