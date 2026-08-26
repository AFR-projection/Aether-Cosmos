import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /verify-otp is the only endpoint that creates a session without a password.
 *
 * It used to sign in whoever owned the address: the "activate the account" branch
 * was conditional, but `createSession` was not. Since /resend-otp would mail a
 * fresh code to ANY address, one guessed or intercepted 6-digit code was a
 * complete authentication bypass of an existing account — no password, no 2-Step
 * Code, no authenticator, even for users who had all three configured.
 *
 * Both halves are closed here: a code is only issued for an account that is
 * genuinely awaiting verification, and only such an account can be signed in.
 */

const store = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  recentToken: null as Record<string, unknown> | null,
  otpOk: true,
  rateAllowed: true,
  sessions: [] as string[],
  sent: [] as string[],
  updates: [] as Record<string, unknown>[],
  rateKeys: [] as string[],
}));

vi.mock("@/lib/db", () => {
  const select = () => {
    let isUsers = true;
    const api = {
      from: (table: Record<string, unknown>) => {
        isUsers = "passwordHash" in table;
        return api;
      },
      where: () => api,
      orderBy: () => api,
      limit: async () => {
        if (isUsers) return store.user ? [store.user] : [];
        return store.recentToken ? [store.recentToken] : [];
      },
    };
    return api;
  };
  return {
    db: {
      select,
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

// Partial: `@/lib/security` also exports the header set every response uses.
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  validateCsrf: async () => true,
  checkRateLimit: async (key: string) => {
    store.rateKeys.push(key);
    return { allowed: store.rateAllowed, remaining: 0 };
  },
}));

vi.mock("@/lib/email/email-service", () => ({
  verifyOTP: async () => store.otpOk,
  sendOTP: async (email: string) => {
    store.sent.push(email);
    return "123456";
  },
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: async (userId: string) => {
    store.sessions.push(userId);
    return "session-token";
  },
  getClientIp: () => "203.0.113.7",
  // handleApiError branches on this class.
  AuthError: class AuthError extends Error {},
}));

vi.mock("@/lib/auth/audit", () => ({ logActivity: async () => undefined }));
vi.mock("@/lib/realtime/events", () => ({ publishToAdmins: async () => undefined }));

const { POST: verifyOtpRoute } = await import("@/app/api/auth/verify-otp/route");
const { POST: resendOtpRoute } = await import("@/app/api/auth/resend-otp/route");

function req(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const PENDING = {
  id: "user-pending",
  username: "newcomer",
  email: "newcomer@example.com",
  role: "user",
  status: "suspended",
  suspendReason: null,
};

const ACTIVE = {
  id: "user-active",
  username: "victim",
  email: "victim@example.com",
  role: "user",
  status: "active",
  suspendReason: null,
};

const BANNED = {
  id: "user-banned",
  username: "banned",
  email: "banned@example.com",
  role: "user",
  status: "suspended",
  suspendReason: "Abuse",
};

beforeEach(() => {
  store.user = null;
  store.recentToken = null;
  store.otpOk = true;
  store.rateAllowed = true;
  store.sessions = [];
  store.sent = [];
  store.updates = [];
  store.rateKeys = [];
});

describe("/api/auth/verify-otp only activates pending accounts", () => {
  it("signs in an account that was awaiting verification", async () => {
    store.user = { ...PENDING };
    const res = await verifyOtpRoute(
      req("http://localhost/api/auth/verify-otp", { email: PENDING.email, code: "123456" })
    );

    expect(res.status).toBe(200);
    expect(store.sessions).toEqual([PENDING.id]);
    expect(store.updates).toEqual([{ status: "active" }]);
  });

  it("refuses to mint a session for an already-active account", async () => {
    store.user = { ...ACTIVE };
    const res = await verifyOtpRoute(
      req("http://localhost/api/auth/verify-otp", { email: ACTIVE.email, code: "123456" })
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_VERIFIED");
    // The whole point: a valid code for an active account is not a login.
    expect(store.sessions).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("does not let a suspended user lift their own ban", async () => {
    store.user = { ...BANNED };
    const res = await verifyOtpRoute(
      req("http://localhost/api/auth/verify-otp", { email: BANNED.email, code: "123456" })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("ACCOUNT_SUSPENDED");
    expect(store.sessions).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("creates nothing when the code is wrong", async () => {
    store.user = { ...PENDING };
    store.otpOk = false;
    const res = await verifyOtpRoute(
      req("http://localhost/api/auth/verify-otp", { email: PENDING.email, code: "000000" })
    );

    expect(res.status).toBe(400);
    expect(store.sessions).toEqual([]);
  });

  it("bounds guessing across several issued codes, per IP and per address", async () => {
    store.user = { ...PENDING };
    store.rateAllowed = false;
    const res = await verifyOtpRoute(
      req("http://localhost/api/auth/verify-otp", { email: PENDING.email, code: "123456" })
    );

    expect(res.status).toBe(429);
    expect(store.sessions).toEqual([]);
    expect(store.rateKeys).toEqual([
      "verify-otp:203.0.113.7",
      `verify-otp:email:${PENDING.email}`,
    ]);
  });
});

describe("/api/auth/resend-otp only mails accounts awaiting verification", () => {
  async function resend(email: string) {
    const res = await resendOtpRoute(req("http://localhost/api/auth/resend-otp", { email }));
    return { status: res.status, body: await res.json() };
  }

  it("sends a code to a pending account", async () => {
    store.user = { ...PENDING };
    const { status } = await resend(PENDING.email);
    expect(status).toBe(200);
    expect(store.sent).toEqual([PENDING.email]);
  });

  it("will not mail a code to an active account", async () => {
    store.user = { ...ACTIVE };
    const { status } = await resend(ACTIVE.email);
    expect(status).toBe(200);
    // No live code for an existing account means no code to guess.
    expect(store.sent).toEqual([]);
  });

  it("will not mail a code to an address with no account", async () => {
    store.user = null;
    const { status } = await resend("stranger@example.com");
    expect(status).toBe(200);
    expect(store.sent).toEqual([]);
  });

  it("will not mail a code to an account suspended for cause", async () => {
    store.user = { ...BANNED };
    await resend(BANNED.email);
    expect(store.sent).toEqual([]);
  });

  it("answers identically whether or not a code went out", async () => {
    store.user = { ...PENDING };
    const pending = await resend("someone@example.com");

    store.user = null;
    const unknown = await resend("someone@example.com");

    store.user = { ...ACTIVE };
    const active = await resend("someone@example.com");

    expect(unknown).toEqual(pending);
    expect(active).toEqual(pending);
  });

  it("caps the sweep by IP as well as by address", async () => {
    store.user = { ...PENDING };
    store.rateAllowed = false;
    const { status } = await resend(PENDING.email);

    expect(status).toBe(429);
    expect(store.sent).toEqual([]);
    expect(store.rateKeys[0]).toBe("resend-otp:ip:203.0.113.7");
  });
});
