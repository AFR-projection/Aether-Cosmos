import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * OTP verification is the one path that mints a session without a password, so
 * the guess budget on a 6-digit code is the whole of its security.
 *
 * The cap was read-then-written: every request in a concurrent burst selected the
 * same `attemptCount`, compared it to 5, and only then wrote back. Twenty
 * simultaneous guesses therefore all passed the check — the "5 tries per code"
 * budget was really "as many tries as fit in one round trip", which is a
 * tractable brute force against a million-code keyspace. Both the attempt and the
 * final burn are now single conditional statements.
 */

type Row = { id: string; attemptCount: number; verified: boolean; code: string; expiresAt: Date };

const store = vi.hoisted(() => ({
  row: null as Row | null,
  /** Every UPDATE the service issued, in order, tagged by intent. */
  statements: [] as string[],
  maxAttempts: 5,
}));

vi.mock("@/shared/infrastructure/db", () => {
  const select = () => {
    const api = {
      from: () => api,
      where: () => api,
      orderBy: () => api,
      limit: async () => {
        const row = store.row;
        // Mirrors the real predicate: unburnt and unexpired only.
        if (!row || row.verified || row.expiresAt <= new Date()) return [];
        return [row];
      },
    };
    return api;
  };

  const update = () => {
    let intent: "attempt" | "burn" = "attempt";
    const api = {
      set: (values: Record<string, unknown>) => {
        intent = "verified" in values ? "burn" : "attempt";
        return api;
      },
      where: () => api,
      returning: async () => {
        const row = store.row;
        if (!row) return [];
        if (intent === "attempt") {
          store.statements.push("attempt");
          // WHERE attempt_count < MAX — the claim and the increment are one step.
          if (row.attemptCount >= store.maxAttempts) return [];
          row.attemptCount += 1;
          return [{ attemptCount: row.attemptCount }];
        }
        store.statements.push("burn");
        // WHERE verified = false — two holders of the same code cannot both win.
        if (row.verified) return [];
        row.verified = true;
        return [{ id: row.id }];
      },
    };
    return api;
  };

  return { db: { select, update } };
});

vi.mock("@/shared/infrastructure/email/mailer", () => ({ deliverMail: async () => true }));
vi.mock("@/shared/infrastructure/email/log", () => ({ recordEmailLog: () => undefined }));

const { verifyOTP, OTP_MAX_ATTEMPTS } = await import("@/shared/infrastructure/email/email-service");
const { hashOTP } = await import("@/shared/infrastructure/email/otp-utils");

const CORRECT = "314159";

function liveToken(overrides: Partial<Row> = {}): Row {
  return {
    id: "otp-1",
    attemptCount: 0,
    verified: false,
    code: hashOTP(CORRECT),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  store.row = liveToken();
  store.statements = [];
  store.maxAttempts = OTP_MAX_ATTEMPTS;
});

describe("verifyOTP", () => {
  it("accepts the right code and burns it", async () => {
    expect(await verifyOTP("user@example.com", CORRECT)).toBe(true);
    expect(store.row?.verified).toBe(true);
    expect(store.statements).toEqual(["attempt", "burn"]);
  });

  it("refuses a code that was already used", async () => {
    expect(await verifyOTP("user@example.com", CORRECT)).toBe(true);
    // The SELECT filters on verified=false, so the second call finds nothing.
    expect(await verifyOTP("user@example.com", CORRECT)).toBe(false);
  });

  it("refuses an expired code", async () => {
    store.row = liveToken({ expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyOTP("user@example.com", CORRECT)).toBe(false);
    expect(store.statements).toEqual([]);
  });

  it("spends exactly one attempt per guess", async () => {
    await verifyOTP("user@example.com", "000000");
    expect(store.row?.attemptCount).toBe(1);
    await verifyOTP("user@example.com", "000001");
    expect(store.row?.attemptCount).toBe(2);
  });

  it("caps a concurrent burst at the per-code budget", async () => {
    const guesses = Array.from({ length: 40 }, (_, i) => String(i).padStart(6, "0"));
    const results = await Promise.all(guesses.map((g) => verifyOTP("user@example.com", g)));

    expect(results.every((r) => r === false)).toBe(true);
    // Not 40. Every guess read the same row, but only OTP_MAX_ATTEMPTS claims won.
    expect(store.row?.attemptCount).toBe(OTP_MAX_ATTEMPTS);
    expect(store.statements.filter((s) => s === "attempt")).toHaveLength(40);
  });

  it("is dead to the correct code once the budget is spent", async () => {
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyOTP("user@example.com", "000000")).toBe(false);
    }
    expect(await verifyOTP("user@example.com", CORRECT)).toBe(false);
    expect(store.row?.verified).toBe(false);
  });

  it("lets only one of two concurrent holders of the correct code win", async () => {
    const [a, b] = await Promise.all([
      verifyOTP("user@example.com", CORRECT),
      verifyOTP("user@example.com", CORRECT),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(store.statements.filter((s) => s === "burn")).toHaveLength(2);
  });

  it("does not compare the digest before claiming an attempt", async () => {
    store.row = liveToken({ attemptCount: OTP_MAX_ATTEMPTS });
    expect(await verifyOTP("user@example.com", CORRECT)).toBe(false);
    // One rejected claim, and no burn: the cap is enforced before the comparison.
    expect(store.statements).toEqual(["attempt"]);
  });
});
