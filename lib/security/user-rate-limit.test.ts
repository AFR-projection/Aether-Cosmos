import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Redis is not available in unit tests; stub it so checkRateLimit falls through
// to the in-memory limiter, which is the path a Redis-less deployment uses too.
vi.mock("@/lib/cache/redis", () => ({
  redisIncr: async () => null,
  redisGetInt: async () => null,
  redisDel: async () => undefined,
}));

const { checkUserApiRateLimit } = await import("@/lib/security");

let userCounter = 0;
function freshUser(): string {
  return `user-${userCounter++}`;
}

describe("checkUserApiRateLimit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows exactly the configured requests per minute, then blocks", async () => {
    const user = freshUser();

    for (let i = 0; i < 3; i++) {
      const r = await checkUserApiRateLimit(user, 3);
      expect(r.allowed).toBe(true);
    }

    const blocked = await checkUserApiRateLimit(user, 3);
    expect(blocked.allowed).toBe(false);
  });

  it("scales the limit by the multiplier for upload buckets", async () => {
    const user = freshUser();

    // multiplier 5 over a limit of 2 => 10 allowed
    for (let i = 0; i < 10; i++) {
      const r = await checkUserApiRateLimit(user, 2, { bucket: "upload", multiplier: 5 });
      expect(r.allowed).toBe(true);
    }

    const blocked = await checkUserApiRateLimit(user, 2, { bucket: "upload", multiplier: 5 });
    expect(blocked.allowed).toBe(false);
  });

  it("still throttles uploads when the admin lowers the limit", async () => {
    // Regression: uploads used a fixed floor of 300/min, so any admin value
    // below that was silently ignored and the setting did nothing.
    const user = freshUser();
    let allowed = 0;

    for (let i = 0; i < 40; i++) {
      const r = await checkUserApiRateLimit(user, 1, { bucket: "upload", multiplier: 5 });
      if (r.allowed) allowed++;
    }

    expect(allowed).toBe(5);
  });

  it("keeps separate buckets from interfering", async () => {
    const user = freshUser();

    for (let i = 0; i < 2; i++) {
      expect((await checkUserApiRateLimit(user, 2)).allowed).toBe(true);
    }
    expect((await checkUserApiRateLimit(user, 2)).allowed).toBe(false);

    // The upload bucket for the same user is untouched.
    expect(
      (await checkUserApiRateLimit(user, 2, { bucket: "upload", multiplier: 1 })).allowed
    ).toBe(true);
  });

  it("never drops below one request even with a fractional multiplier", async () => {
    const user = freshUser();
    const r = await checkUserApiRateLimit(user, 1, { multiplier: 0.1 });
    expect(r.allowed).toBe(true);
  });
});
