import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The 2-Step Code numpad used to draw the whole allowed range — ten slots — for
 * every account, so a user whose code is six digits saw four slots that could
 * never fill. The code is argon2-hashed, so its length cannot be read back from
 * the hash; `users.step_code_length` records it instead, and these tests pin the
 * two things the server owes the UI:
 *
 *   1. the length reaches the client only on the branch where the password for
 *      that account has already been verified, and
 *   2. accounts enrolled before the column existed heal themselves — the length
 *      is written the first time a code verifies, which is the only moment it is
 *      known to be correct.
 */

const store = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  verifyResult: false,
  updates: [] as Record<string, unknown>[],
  ip: "203.0.113.9",
}));

vi.mock("@/shared/infrastructure/cache/redis", () => ({
  redisIncr: async () => null,
  redisGetInt: async () => null,
  redisDel: async () => undefined,
}));

vi.mock("@/shared/infrastructure/db", () => {
  const selectChain = () => {
    const api = {
      from: () => api,
      where: () => api,
      limit: async () => (store.user ? [store.user] : []),
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
  verifyPassword: async () => store.verifyResult,
  verifyDecoyPassword: async () => false,
}));

vi.mock("@/shared/lib/auth/session", () => ({
  getClientIp: () => store.ip,
  destroySession: async () => undefined,
  getSessionUser: async () => null,
  AuthError: class AuthError extends Error {},
}));

vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: async () => undefined }));
vi.mock("@/shared/infrastructure/email/notify-user", () => ({ notifyUser: async () => undefined }));
vi.mock("@/shared/lib/settings/admin-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/settings/admin-settings")>();
  return {
    ...actual,
    getAdminSettings: async () => ({
      ...actual.DEFAULT_ADMIN_SETTINGS,
      stepCodeRequired: false,
    }),
  };
});
vi.mock("@/shared/lib/auth/login-complete", () => ({
  completeLogin: async () => ({ message: "ok", user: { id: "u1" } }),
}));
vi.mock("@/shared/lib/security/totp", () => ({
  verifyTotpCode: () => false,
  consumeRecoveryCode: async () => ({ ok: false, remaining: [] }),
}));

const { POST } = await import("@/app/api/auth/login/route");
const { createStagedToken } = await import("@/shared/lib/security/step-code");

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

let seq = 0;
function userWithStepCode(overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    id: `22222222-2222-4222-8222-${String(seq).padStart(12, "0")}`,
    username: "holder",
    email: "holder@example.com",
    passwordHash: "$argon2id$irrelevant",
    status: "active",
    failedLoginAttempts: 0,
    lockedUntil: null,
    stepCodeHash: "$argon2id$step",
    stepCodeLength: 6,
    stepCodeFailedAttempts: 0,
    stepCodeLockedUntil: null,
    stepCodeMustChange: false,
    // Off, so a verified code finishes the login instead of handing off to TOTP.
    totpEnabled: false,
    totpSecret: null,
    totpRecoveryCodes: [],
    ...overrides,
  };
}

let ipSeq = 0;
beforeEach(() => {
  ipSeq++;
  store.ip = `192.0.2.${ipSeq}`;
  store.user = null;
  store.verifyResult = false;
  store.updates = [];
});

describe("the numpad is told the account's own code length", () => {
  it("returns the recorded length once the password is verified", async () => {
    store.user = userWithStepCode({ stepCodeLength: 6 });
    store.verifyResult = true;

    const body = await (await post({ identifier: "holder", password: "pw" })).json();

    expect(body.data.requiresStepCode).toBe(true);
    expect(body.data.stepCodeLength).toBe(6);
  });

  it("says null rather than guessing for a code enrolled before the column existed", async () => {
    store.user = userWithStepCode({ stepCodeLength: null });
    store.verifyResult = true;

    const body = await (await post({ identifier: "holder", password: "pw" })).json();

    expect(body.data.requiresStepCode).toBe(true);
    expect(body.data.stepCodeLength).toBeNull();
  });

  it("does not trust a stored length outside the allowed range", async () => {
    store.user = userWithStepCode({ stepCodeLength: 42 });
    store.verifyResult = true;

    const body = await (await post({ identifier: "holder", password: "pw" })).json();

    // A pad locked to 42 slots could never be submitted, so the flexible pad wins.
    expect(body.data.stepCodeLength).toBeNull();
  });

  it("sends no length on the enrolment branch, where no code exists yet", async () => {
    store.user = userWithStepCode({ stepCodeHash: null, stepCodeMustChange: true });
    store.verifyResult = true;

    const body = await (await post({ identifier: "holder", password: "pw" })).json();

    expect(body.data.stepCodeEnrollment).toBe(true);
    expect(body.data.stepCodeLength).toBeNull();
  });

  it("never reveals a length before the password is verified", async () => {
    store.user = userWithStepCode({ stepCodeLength: 8 });
    store.verifyResult = false;

    const res = await post({ identifier: "holder", password: "wrong" });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(JSON.stringify(body)).not.toContain("stepCodeLength");
  });
});

describe("a verified code records its own length", () => {
  function stepToken(userId: string) {
    return createStagedToken(userId, "password");
  }

  it("backfills the length the first time an old code verifies", async () => {
    const user = userWithStepCode({ stepCodeLength: null });
    store.user = user;
    store.verifyResult = true;

    const res = await post({ stepToken: stepToken(user.id), stepCode: "482915" });

    expect(res.status).toBe(200);
    expect(store.updates.some((u) => u.stepCodeLength === 6)).toBe(true);
  });

  it("corrects a length that disagrees with the code that just verified", async () => {
    const user = userWithStepCode({ stepCodeLength: 10 });
    store.user = user;
    store.verifyResult = true;

    await post({ stepToken: stepToken(user.id), stepCode: "482915" });

    expect(store.updates.some((u) => u.stepCodeLength === 6)).toBe(true);
  });

  it("writes nothing when the recorded length already matches", async () => {
    const user = userWithStepCode({ stepCodeLength: 6, stepCodeFailedAttempts: 0 });
    store.user = user;
    store.verifyResult = true;

    await post({ stepToken: stepToken(user.id), stepCode: "482915" });

    expect(store.updates).toHaveLength(0);
  });

  it("still clears the failed-attempt counter alongside a backfill", async () => {
    const user = userWithStepCode({ stepCodeLength: null, stepCodeFailedAttempts: 3 });
    store.user = user;
    store.verifyResult = true;

    await post({ stepToken: stepToken(user.id), stepCode: "4829157" });

    // One UPDATE carrying both, not two round trips.
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      stepCodeLength: 7,
      stepCodeFailedAttempts: 0,
      stepCodeLockedUntil: null,
    });
  });

  it("records nothing from a code that failed, however long it was", async () => {
    const user = userWithStepCode({ stepCodeLength: null });
    store.user = user;
    store.verifyResult = false;

    const res = await post({ stepToken: stepToken(user.id), stepCode: "1234567890" });

    expect(res.status).toBe(401);
    // The wrong code's length says nothing about the real one.
    expect(store.updates.every((u) => !("stepCodeLength" in u))).toBe(true);
  });
});
