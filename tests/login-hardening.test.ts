import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Login hardening: the account-existence oracle and the unguarded TOTP layer.
 *
 * 1. A wrong password used to answer "Invalid credentials. 4 attempt(s)
 *    remaining before account lock." while an unknown identifier answered a bare
 *    "Invalid credentials" — free account enumeration from a username list
 *    (WSTG-ATHN-02). The bodies are now identical, AND an unknown identifier
 *    still spends a real argon2 verification so the response time cannot answer
 *    the question the body no longer does.
 *
 * 2. The authenticator layer had no per-account ceiling. A 6-digit code is one
 *    guess in a million, the `users` lockout columns only cover the password and
 *    2-Step Code layers, and the IP limit is worthless against a guesser with
 *    more than one address.
 */

const store = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  decoyCalls: 0,
  verifyResult: false,
  updates: [] as Record<string, unknown>[],
  /**
   * The IP limiter is real here (only Redis is stubbed, so it falls back to the
   * in-memory window), and its counter is process-wide. Each test gets its own
   * address so one test's failures cannot throttle the next.
   */
  ip: "203.0.113.1",
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
  verifyDecoyPassword: async () => {
    store.decoyCalls++;
    return false;
  },
}));

vi.mock("@/shared/lib/auth/session", () => ({
  getClientIp: () => store.ip,
  destroySession: async () => undefined,
  getSessionUser: async () => null,
  AuthError: class AuthError extends Error {},
}));

vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: async () => undefined }));
vi.mock("@/shared/infrastructure/email/notify-user", () => ({ notifyUser: async () => undefined }));
/*
 * The lockout thresholds moved out of RATE_LIMIT_LOGIN_* env vars into Admin →
 * Settings, so the route reads them per request. The real module is kept (the
 * route calls `loginLockoutPolicy`) and only the DB-backed fetch is stubbed, with
 * the shipped defaults the assertions below are written against: 5 failures per
 * account, 30 per IP, a 15-minute window.
 */
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

const totp = vi.hoisted(() => ({ ok: false }));
vi.mock("@/shared/lib/security/totp", () => ({
  verifyTotpCode: () => totp.ok,
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
function activeUser(overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    id: `11111111-1111-4111-8111-${String(seq).padStart(12, "0")}`,
    username: "victim",
    email: "victim@example.com",
    passwordHash: "$argon2id$irrelevant",
    status: "active",
    suspendReason: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    stepCodeHash: null,
    stepCodeMustChange: false,
    totpEnabled: true,
    totpSecret: "JBSWY3DPEHPK3PXP",
    totpRecoveryCodes: [],
    ...overrides,
  };
}

let ipSeq = 0;
beforeEach(() => {
  ipSeq++;
  store.ip = `198.51.100.${ipSeq}`;
  store.user = null;
  store.verifyResult = false;
  store.decoyCalls = 0;
  store.updates = [];
  totp.ok = false;
});

describe("password layer does not answer 'does this account exist?'", () => {
  it("rejects an oversized public request before password work", async () => {
    const res = await post({ identifier: "x".repeat(70 * 1024), password: "hunter2" });
    const body = await res.json();

    expect(res.status).toBe(413);
    expect(body.code).toBe("BODY_TOO_LARGE");
    expect(store.decoyCalls).toBe(0);
  });

  it("returns an identical status and body for an unknown identifier and a wrong password", async () => {
    store.user = null;
    const unknown = await post({ identifier: "nobody", password: "hunter2" });
    const unknownBody = await unknown.json();

    store.user = activeUser();
    store.verifyResult = false;
    const wrongPassword = await post({ identifier: "victim", password: "hunter2" });
    const wrongPasswordBody = await wrongPassword.json();

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknownBody).toEqual(wrongPasswordBody);
    expect(unknownBody).toEqual({ success: false, error: "Invalid credentials" });
  });

  it("never leaks the remaining-attempt count that only an existing account has", async () => {
    store.user = activeUser({ failedLoginAttempts: 3 });
    const res = await post({ identifier: "victim", password: "hunter2" });
    const body = await res.json();

    // The account is one failure from lockout, which the old copy announced.
    expect(store.updates.at(-1)?.failedLoginAttempts).toBe(4);
    expect(JSON.stringify(body)).not.toMatch(/attempt/i);
    expect(body.remaining).toBeUndefined();
  });

  it("spends a real password verification on an identifier that does not exist", async () => {
    store.user = null;
    await post({ identifier: "nobody", password: "hunter2" });
    // Without this the clock answers what the body no longer does: an instant
    // reply means "no such account", a ~0.5s reply means "wrong password".
    expect(store.decoyCalls).toBe(1);
  });

  it("does not burn a decoy verification when the account exists", async () => {
    store.user = activeUser();
    await post({ identifier: "victim", password: "hunter2" });
    expect(store.decoyCalls).toBe(0);
  });

  it("still locks the account on the configured failure ceiling", async () => {
    store.user = activeUser({ failedLoginAttempts: 4 });
    const res = await post({ identifier: "victim", password: "hunter2" });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe("ACCOUNT_LOCKED");
    expect(store.updates.at(-1)?.lockedUntil).toBeInstanceOf(Date);
  });
});

describe("authenticator layer has a per-account ceiling", () => {
  async function badCode(pendingToken: string) {
    return post({ pendingToken, totpCode: "000000" });
  }

  it("locks the account after ten wrong codes, not just the IP", async () => {
    const user = activeUser();
    store.user = user;
    const pendingToken = createStagedToken(user.id as string, "step_code");

    for (let i = 1; i <= 10; i++) {
      const res = await badCode(pendingToken);
      const body = await res.json();
      expect({ i, status: res.status, code: body.code }).toEqual({
        i,
        status: 401,
        code: "2FA_INVALID",
      });
    }

    const locked = await badCode(pendingToken);
    const lockedBody = await locked.json();
    expect(locked.status).toBe(429);
    expect(lockedBody.code).toBe("2FA_LOCKED");
  });

  it("refuses even a correct code once the ceiling is reached", async () => {
    const user = activeUser();
    store.user = user;
    const pendingToken = createStagedToken(user.id as string, "step_code");

    for (let i = 0; i < 10; i++) await badCode(pendingToken);

    totp.ok = true;
    const res = await post({ pendingToken, totpCode: "123456" });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("2FA_LOCKED");
  });

  it("clears the counter on a successful code so yesterday's typos do not lock tomorrow", async () => {
    const user = activeUser();
    store.user = user;
    const pendingToken = createStagedToken(user.id as string, "step_code");

    for (let i = 0; i < 9; i++) {
      expect((await badCode(pendingToken)).status).toBe(401);
    }

    totp.ok = true;
    expect((await post({ pendingToken, totpCode: "123456" })).status).toBe(200);

    // A stale counter would trip on the very next failure instead of the tenth.
    totp.ok = false;
    for (let i = 1; i <= 10; i++) {
      const res = await badCode(pendingToken);
      expect({ i, status: res.status }).toEqual({ i, status: 401 });
    }
    expect((await badCode(pendingToken)).status).toBe(429);
  });

  it("counts per account, so locking one user leaves another untouched", async () => {
    const victim = activeUser();
    store.user = victim;
    const victimToken = createStagedToken(victim.id as string, "step_code");
    for (let i = 0; i < 10; i++) await badCode(victimToken);
    expect((await badCode(victimToken)).status).toBe(429);

    const bystander = activeUser();
    store.user = bystander;
    const bystanderToken = createStagedToken(bystander.id as string, "step_code");
    const res = await badCode(bystanderToken);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("2FA_INVALID");
  });

  it("will not accept a password-stage token at the authenticator layer", async () => {
    const user = activeUser();
    store.user = user;
    const res = await post({
      pendingToken: createStagedToken(user.id as string, "password"),
      totpCode: "123456",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("2FA_EXPIRED");
  });
});

/**
 * The status code was the second half of the same oracle.
 *
 * Identical wording proved nothing while a real account switched to 429
 * ACCOUNT_LOCKED at its ceiling and an unknown identifier answered 401 forever:
 * an attacker sent `accountMax + 1` guesses and read the status instead of the
 * body. Unknown identifiers now carry their own counter (keyed by a hash of the
 * identifier) that trips on exactly the same attempt.
 */
describe("the lockout does not answer it either", () => {
  const MAX = 5; // DEFAULT_ADMIN_SETTINGS.loginMaxAttempts

  async function guess(identifier: string) {
    const res = await post({ identifier, password: "hunter2" });
    return { status: res.status, code: (await res.json()).code as string | undefined };
  }

  it("locks an identifier with no account on the same attempt a real one locks", async () => {
    store.user = null;
    for (let i = 1; i < MAX; i++) {
      expect({ i, ...(await guess("ghost-parity")) }).toEqual({ i, status: 401, code: undefined });
    }
    // Attempt 5 for a real account is the one that sets `lockedUntil` and answers
    // 429 — see "still locks the account on the configured failure ceiling".
    expect(await guess("ghost-parity")).toEqual({ status: 429, code: "ACCOUNT_LOCKED" });
  });

  it("keeps refusing past the ceiling without spending an argon2 verification", async () => {
    store.user = null;
    for (let i = 0; i < MAX; i++) await guess("ghost-timing");
    store.decoyCalls = 0;

    expect(await guess("ghost-timing")).toEqual({ status: 429, code: "ACCOUNT_LOCKED" });
    // A locked real account returns before `verifyPassword`, so a locked unknown
    // identifier must return before the decoy — otherwise the ~0.5s gap rebuilds
    // by clock what the status code just stopped saying.
    expect(store.decoyCalls).toBe(0);
  });

  it("counts per identifier, so one locked guess does not lock the next", async () => {
    store.user = null;
    for (let i = 0; i <= MAX; i++) await guess("ghost-isolated-a");
    expect(await guess("ghost-isolated-a")).toEqual({ status: 429, code: "ACCOUNT_LOCKED" });
    expect(await guess("ghost-isolated-b")).toEqual({ status: 401, code: undefined });
  });

  it("does not hand out a fresh budget for a different casing of the same guess", async () => {
    store.user = null;
    for (let i = 1; i < MAX; i++) await guess("Ghost-Casing@Example.com");
    // The account lookup lowercases the email, so the counter must too or the
    // ceiling is one attempt per capitalisation.
    expect(await guess("ghost-casing@example.com")).toEqual({
      status: 429,
      code: "ACCOUNT_LOCKED",
    });
  });
});

/**
 * Account status is judged only behind a correct password.
 *
 * The check used to run before `verifyPassword`, and every unverified
 * registration is stored as `suspended` — so any address plus any junk password
 * answered 403 for a registered address and 401 for a stranger. No credentials
 * required.
 */
describe("suspension does not answer 'is this address registered?'", () => {
  it("answers a wrong password on a pending account exactly like an unknown one", async () => {
    store.user = activeUser({ status: "suspended", suspendReason: null });
    store.verifyResult = false;
    const pending = await post({ identifier: "victim@example.com", password: "hunter2" });
    const pendingBody = await pending.json();

    store.user = null;
    const unknown = await post({ identifier: "stranger@example.com", password: "hunter2" });

    expect(pending.status).toBe(401);
    expect(pendingBody).toEqual({ success: false, error: "Invalid credentials" });
    expect(pending.status).toBe(unknown.status);
    expect(pendingBody).toEqual(await unknown.json());
  });

  it("tells the owner of an unverified account where the code is", async () => {
    store.user = activeUser({ status: "suspended", suspendReason: null });
    store.verifyResult = true;
    const res = await post({ identifier: "victim", password: "correct-horse" });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
    // The resend screen needs the address, and the caller just proved it is theirs.
    expect(body.email).toBe("victim@example.com");
  });

  it("does not send an admin-suspended user looking for a verification code", async () => {
    store.user = activeUser({ status: "suspended", suspendReason: "Abuse" });
    store.verifyResult = true;
    const res = await post({ identifier: "victim", password: "correct-horse" });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("ACCOUNT_SUSPENDED");
    // `suspend_reason` holds internal admin notes and never leaves the server.
    expect(JSON.stringify(body)).not.toMatch(/abuse/i);
  });
});

