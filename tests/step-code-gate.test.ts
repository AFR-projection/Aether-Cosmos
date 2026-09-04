import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lockout arithmetic behind a re-authentication prompt.
 *
 * A backup download asks for the 2-Step Code again, and it shares login's counter
 * rather than getting five tries of its own — five tries per surface is not a limit.
 * Everything worth testing here is arithmetic and ordering: how many attempts remain,
 * which attempt closes the lock, whether a locked code can be pushed further out by
 * knocking on it, and whether a lock that has expired lets the next correct code
 * through. Each of those is a silent failure if wrong, and none of them is visible
 * from the route.
 *
 * The database and argon2 are mocked. What is under test is the sequence, not
 * PostgreSQL and not the hash — a real argon2 verify per attempt would add seconds to
 * the suite and assert nothing this file is about.
 */

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  correct: false,
  updates: [] as Record<string, unknown>[],
  selects: 0,
}));

vi.mock("@/shared/infrastructure/db", () => {
  const selectChain = () => {
    const api = {
      from: () => api,
      where: () => api,
      limit: async () => {
        store.selects += 1;
        return store.row ? [store.row] : [];
      },
    };
    return api;
  };
  return {
    db: {
      select: () => selectChain(),
      update: () => {
        const api = {
          set: (values: Record<string, unknown>) => {
            store.updates.push(values);
            return api;
          },
          where: async () => undefined,
        };
        return api;
      },
    },
  };
});

vi.mock("@/shared/lib/auth/password", () => ({
  hashPassword: async (value: string) => `hashed:${value}`,
  verifyPassword: async () => store.correct,
}));

const { checkStepCode } = await import("@/shared/lib/security/step-code-gate");
const { STEP_CODE_LOCKOUT_MS, STEP_CODE_MAX_ATTEMPTS } = await import(
  "@/shared/lib/security/step-code"
);

const USER = "9f1c0e5a-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-02T21:00:00.000Z");

/** An enrolled account, with whatever counters the test needs. */
function enrolled(over: Record<string, unknown> = {}) {
  return { hash: "$argon2id$v=19$stored", failedAttempts: 0, lockedUntil: null, ...over };
}

beforeEach(() => {
  store.row = enrolled();
  store.correct = false;
  store.updates = [];
  store.selects = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Neither of these is ever hashed — `verifyPassword` is mocked, `store.correct` decides. */
const WRONG = "480913";
const RIGHT = "271846";

/** Narrow to a rejection, so a test can name only the fields it is about. */
function denial(result: Awaited<ReturnType<typeof checkStepCode>>) {
  if (result.ok) throw new Error("expected a rejection, got acceptance");
  return result;
}

/**
 * One attempt against the live account, with the counter persisted the way
 * PostgreSQL would persist it. Without the write-back every call in a loop would
 * re-read `failedAttempts: 0` and the walk toward the lock would never happen —
 * the test would pass while asserting the first attempt five times.
 */
async function attempt(code: string) {
  const before = store.updates.length;
  const result = await checkStepCode(USER, code);
  const written = store.updates[before];
  if (written && store.row) {
    store.row = {
      ...store.row,
      failedAttempts: written.stepCodeFailedAttempts,
      lockedUntil: written.stepCodeLockedUntil,
    };
  }
  return result;
}

describe("an account that has no 2-Step Code", () => {
  it("says so rather than counting a failure", async () => {
    store.row = null;
    const result = denial(await checkStepCode(USER, WRONG));

    expect(result).toMatchObject({
      reason: "not_set",
      status: 400,
      code: "STEP_CODE_NOT_SET",
      remaining: 0,
      justLocked: false,
    });
    // Tells the user where to go, not only that something is missing.
    expect(result.message).toMatch(/account settings/i);
    // The half that matters: an account with nothing to verify cannot be locked out
    // by someone hammering this endpoint on its behalf.
    expect(store.updates).toEqual([]);
  });

  it("treats an enrolled row with no hash the same way", async () => {
    // Reachable: the column is nullable, and a user who removes their code keeps
    // the row. A `!row?.hash` that only checked for a missing row would fall through
    // to argon2 with `undefined` as the hash.
    store.row = enrolled({ hash: null });

    expect(denial(await checkStepCode(USER, WRONG)).code).toBe("STEP_CODE_NOT_SET");
    expect(store.updates).toEqual([]);
  });
});

describe("a lock that is still closed", () => {
  const stillLocked = () => enrolled({ failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 60_000) });

  it("refuses, and names the wait in minutes", async () => {
    store.row = stillLocked();
    const result = denial(await checkStepCode(USER, WRONG));

    expect(result).toMatchObject({
      reason: "locked",
      status: 429,
      code: "STEP_CODE_LOCKED",
      remaining: 0,
      // False: this attempt did not close the lock, it found it closed. The caller
      // audits and notifies on `justLocked`, so a true here would send one email per
      // retry for fifteen minutes.
      justLocked: false,
    });
    expect(result.message).toMatch(/15 minutes/);
  });

  it("refuses the correct code too, which is the whole point of a lockout", async () => {
    store.row = stillLocked();
    store.correct = true;

    expect(denial(await checkStepCode(USER, RIGHT)).code).toBe("STEP_CODE_LOCKED");
  });

  it("is not pushed further out by knocking on it", async () => {
    store.row = stillLocked();
    const closesAt = store.row.lockedUntil;

    for (let i = 0; i < 4; i += 1) await attempt(WRONG);

    // No UPDATE at all on the locked path: the counter is not incremented and the
    // deadline is not rewritten. A lock that renewed itself on every rejected try
    // would never expire for anyone still retrying, and "try again in 15 minutes"
    // would be a lie.
    expect(store.updates).toEqual([]);
    expect(store.row.lockedUntil).toBe(closesAt);
    expect(store.selects).toBe(4);
  });
});

describe("a lock that has run out", () => {
  it("opens at the instant it said it would", async () => {
    // `lockedUntil` exactly now. The comparison is strictly-after, so this attempt is
    // already through — which is what makes the promised wait exact rather than
    // "fifteen minutes and some unspecified extra".
    store.row = enrolled({ failedAttempts: 5, lockedUntil: NOW });
    store.correct = true;

    expect(await checkStepCode(USER, RIGHT)).toEqual({ ok: true });
  });

  it("still refuses a millisecond earlier", async () => {
    store.row = enrolled({ failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 1) });

    expect(denial(await checkStepCode(USER, WRONG)).code).toBe("STEP_CODE_LOCKED");
  });

  it("clears the stale deadline when the code is finally right", async () => {
    store.row = enrolled({ failedAttempts: 5, lockedUntil: new Date(NOW.getTime() - 1000) });
    store.correct = true;

    expect(await checkStepCode(USER, RIGHT)).toEqual({ ok: true });
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      stepCodeFailedAttempts: 0,
      stepCodeLockedUntil: null,
    });
    // Left behind, the pair (5 failures, a past deadline) means the very next wrong
    // code re-locks the account immediately instead of granting four more tries.
    expect(store.updates[0].updatedAt).toBeInstanceOf(Date);
  });

  it("gives back the full five after the counter is cleared", async () => {
    store.row = enrolled({ failedAttempts: 4, lockedUntil: null });
    store.correct = true;
    await attempt(RIGHT);

    store.correct = false;
    // 4 → clear → 1, not 4 → 5. A cosmetic clear that did not persist would lock the
    // account on this attempt.
    expect(denial(await attempt(WRONG)).remaining).toBe(4);
  });
});

describe("the walk from five attempts to none", () => {
  /** Five wrong codes against one fresh account, in order. */
  async function walk() {
    const results = [];
    for (let i = 0; i < STEP_CODE_MAX_ATTEMPTS; i += 1) results.push(denial(await attempt(WRONG)));
    return results;
  }

  it("counts down and closes on the fifth, not the sixth", async () => {
    expect(STEP_CODE_MAX_ATTEMPTS).toBe(5);
    const results = await walk();

    expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0]);
    // `>=` rather than `>` in the gate: the fifth wrong code is the last one, and an
    // off-by-one here hands out a sixth try.
    expect(results.map((r) => r.justLocked)).toEqual([false, false, false, false, true]);
    // 401 while the input should stay open, 429 once it should not.
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 429]);
    expect(results.map((r) => r.code)).toEqual([
      "STEP_CODE_INVALID",
      "STEP_CODE_INVALID",
      "STEP_CODE_INVALID",
      "STEP_CODE_INVALID",
      "STEP_CODE_LOCKED",
    ]);
    expect(results.every((r) => r.reason === "incorrect")).toBe(true);
  });

  it("increments the column login reads, and only rewrites the deadline at the end", async () => {
    await walk();

    expect(store.updates.map((u) => u.stepCodeFailedAttempts)).toEqual([1, 2, 3, 4, 5]);
    expect(store.updates.slice(0, 4).map((u) => u.stepCodeLockedUntil)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("closes it exactly fifteen minutes out", async () => {
    await walk();

    expect(STEP_CODE_LOCKOUT_MS).toBe(15 * 60 * 1000);
    expect(store.updates[4].stepCodeLockedUntil).toEqual(
      new Date(NOW.getTime() + STEP_CODE_LOCKOUT_MS)
    );
  });

  it("says how many are left, and stops offering a number once none are", async () => {
    const messages = (await walk()).map((r) => r.message);

    expect(messages[0]).toMatch(/4 attempt/);
    expect(messages[3]).toMatch(/1 attempt/);
    expect(messages[4]).toMatch(/locked for 15 minutes/);
    // "0 attempt(s) remaining" beside a still-open input is how a user learns to keep
    // typing into an endpoint that will refuse them for a quarter of an hour.
    expect(messages[4]).not.toMatch(/remaining/);
  });
});

describe("a counter that is already past the limit", () => {
  it("clamps instead of counting backwards", async () => {
    // How this row happens: five failures locked the account, the lock expired, and
    // nobody has entered the right code since — the counter is never reset by the
    // passage of time. Three more wrong tries and the raw subtraction is -3.
    store.row = enrolled({ failedAttempts: 7, lockedUntil: new Date(NOW.getTime() - 1) });
    const result = denial(await attempt(WRONG));

    expect(result.remaining).toBe(0);
    expect(result.message).not.toMatch(/-\d/);
    expect(result).toMatchObject({ status: 429, code: "STEP_CODE_LOCKED", justLocked: true });
    expect(store.updates[0]).toMatchObject({
      stepCodeFailedAttempts: 8,
      stepCodeLockedUntil: new Date(NOW.getTime() + STEP_CODE_LOCKOUT_MS),
    });
  });

  it("re-locks on the first wrong code after an expired lock, with no free tries", async () => {
    store.row = enrolled({ failedAttempts: 5, lockedUntil: new Date(NOW.getTime() - 60_000) });

    // The counter, not the deadline, is what remembers. An expired lock plus an
    // untouched counter means one wrong code closes it again immediately.
    expect(denial(await attempt(WRONG)).justLocked).toBe(true);
  });

  it("never reports a negative number of attempts", async () => {
    for (let seeded = 0; seeded <= 9; seeded += 1) {
      store.row = enrolled({ failedAttempts: seeded });
      store.updates = [];

      expect(denial(await checkStepCode(USER, WRONG)).remaining).toBe(
        Math.max(0, STEP_CODE_MAX_ATTEMPTS - seeded - 1)
      );
    }
  });

  it("survives a null counter, which is what an enrolment writes", async () => {
    // `step_code_failed_attempts` is nullable and a fresh enrolment leaves it null.
    // `(null ?? 0) + 1` is 1; `null + 1` is also 1, but `Math.max(0, 5 - null)` is 5 —
    // the coalesce is what keeps the two halves agreeing.
    store.row = enrolled({ failedAttempts: null });
    const result = denial(await checkStepCode(USER, WRONG));

    expect(result.remaining).toBe(4);
    expect(store.updates[0].stepCodeFailedAttempts).toBe(1);
  });
});

describe("a correct code", () => {
  it("costs one SELECT and no UPDATE", async () => {
    store.correct = true;

    expect(await checkStepCode(USER, RIGHT)).toEqual({ ok: true });
    expect(store.selects).toBe(1);
    // A download asks for the code on every click; writing a row each time would put
    // an UPDATE on the happy path of the busiest gate in the app.
    expect(store.updates).toEqual([]);
  });

  it("clears the counter when there is one to clear", async () => {
    store.row = enrolled({ failedAttempts: 3 });
    store.correct = true;

    expect(await checkStepCode(USER, RIGHT)).toEqual({ ok: true });
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      stepCodeFailedAttempts: 0,
      stepCodeLockedUntil: null,
    });
  });

  it("answers with nothing but ok", async () => {
    store.row = enrolled({ failedAttempts: 3 });
    store.correct = true;

    // No `remaining` on the accepted branch, so no caller can render a stale count
    // beside a success.
    expect(Object.keys(await checkStepCode(USER, RIGHT))).toEqual(["ok"]);
  });
});

describe("the three denials, as a caller sees them", () => {
  /** One of each, in the order the function checks for them. */
  async function each() {
    store.row = null;
    const notSet = denial(await checkStepCode(USER, WRONG));
    store.row = enrolled({ failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 1000) });
    const locked = denial(await checkStepCode(USER, WRONG));
    store.row = enrolled();
    const incorrect = denial(await checkStepCode(USER, WRONG));
    return { notSet, locked, incorrect };
  }

  it("carry the status and code the login flow already uses", async () => {
    const { notSet, locked, incorrect } = await each();

    // Shared strings, so a client that already handles login's three cases handles a
    // backup download's three cases without a second branch.
    expect([notSet, locked, incorrect].map((r) => `${r.status} ${r.code}`)).toEqual([
      "400 STEP_CODE_NOT_SET",
      "429 STEP_CODE_LOCKED",
      "401 STEP_CODE_INVALID",
    ]);
    expect([notSet, locked, incorrect].map((r) => r.reason)).toEqual([
      "not_set",
      "locked",
      "incorrect",
    ]);
  });

  it("say something a user can act on, without naming internals", async () => {
    for (const result of Object.values(await each())) {
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(20);
      expect(result.message.trim()).toBe(result.message);
      expect(result.message.endsWith(".")).toBe(true);
      // A denial is shown verbatim; the hash algorithm and the column names are not
      // the user's business and are a small gift to anyone probing the endpoint.
      expect(result.message).not.toMatch(/argon2|hash|users\.|step_code/i);
    }
  });

  it("separate 'was locked' from 'just locked' by reason, never by code", async () => {
    const { locked } = await each();
    store.row = enrolled({ failedAttempts: 4 });
    const closing = denial(await attempt(WRONG));

    // Identical status and code, different reason. The audit and notify path keys on
    // `justLocked`, so anything keying on `code` would log a lockout on every retry.
    expect(`${closing.status} ${closing.code}`).toBe(`${locked.status} ${locked.code}`);
    expect(closing.reason).toBe("incorrect");
    expect(closing.justLocked).toBe(true);
    expect(locked.justLocked).toBe(false);
  });
});
