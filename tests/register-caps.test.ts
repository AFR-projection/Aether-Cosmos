import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Registration is the one endpoint an anonymous caller can use to make this
 * server send mail.
 *
 * The scan reported it as open email bombing. The per-IP cap of 5 per 15 minutes
 * had in fact been there all along — it simply did not bind, because the IP it was
 * keyed on came from headers the caller wrote (see tests/client-ip-trust.test.ts).
 * With that closed, one address is bounded, but a thousand addresses are not: every
 * signup spends the operator's own SMTP credentials, and the complaints land on
 * this domain's sending reputation. Hence a second, instance-wide ceiling.
 *
 * The interesting property is not "there is a cap" but WHEN the cap is charged.
 * Spending it on requests that never create an account would let a storm of
 * malformed bodies close registration for everybody — the exact outage the ceiling
 * is meant to prevent.
 */

const store = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
  deleted: 0,
  sent: [] as string[],
  otpCode: "123456" as string | null,
  hashCalls: 0,
  /** Budgets read without charging. */
  peeks: [] as { key: string; max: number }[],
  /** Budgets actually charged. */
  spends: [] as { key: string; max: number }[],
  blocked: [] as string[],
}));

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    select: () => {
      const api = {
        from: () => api,
        where: () => api,
        limit: async () => (store.existing ? [store.existing] : []),
      };
      return api;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          store.inserted.push(values);
          return [{ id: "user-new", ...values }];
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        store.deleted++;
      },
    }),
  },
}));

vi.mock("@/shared/lib/security", async (importOriginal) => {
  const verdict = (key: string, max: number) => ({
    allowed: !store.blocked.includes(key),
    remaining: max,
    count: 0,
  });
  return {
    ...(await importOriginal<typeof import("@/shared/lib/security")>()),
    validateCsrf: async () => true,
    checkRateLimit: async (key: string, max: number) => {
      store.spends.push({ key, max });
      return verdict(key, max);
    },
    peekRateLimit: async (key: string, max: number) => {
      store.peeks.push({ key, max });
      return verdict(key, max);
    },
  };
});

vi.mock("@/shared/lib/auth/password", () => ({
  hashPassword: async () => {
    store.hashCalls++;
    return "$argon2id$stub";
  },
}));

vi.mock("@/shared/infrastructure/email/email-service", () => ({
  sendOTP: async (email: string) => {
    store.sent.push(email);
    return store.otpCode;
  },
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

vi.mock("@/shared/lib/auth/session", () => ({
  getClientIp: () => "203.0.113.7",
  AuthError: class AuthError extends Error {},
}));

vi.mock("@/shared/infrastructure/realtime/events", () => ({
  publishToAdmins: async () => undefined,
}));

// Partial: the quota helpers and the domain allowlist are real logic worth keeping.
vi.mock("@/shared/lib/settings/admin-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/settings/admin-settings")>();
  return {
    ...actual,
    getAdminSettings: async () => ({
      ...actual.DEFAULT_ADMIN_SETTINGS,
      registrationEnabled: true,
    }),
  };
});

const { POST } = await import("@/app/api/auth/register-email/route");

const GOOD = {
  username: "newcomer",
  email: "newcomer@example.com",
  password: "correct-horse-battery-9",
};

function register(body: Record<string, unknown> = GOOD) {
  return POST(
    new NextRequest("http://localhost/api/auth/register-email", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

const globalSpends = () => store.spends.filter((s) => s.key === "register:global");

beforeEach(() => {
  store.existing = null;
  store.inserted = [];
  store.deleted = 0;
  store.sent = [];
  store.otpCode = "123456";
  store.hashCalls = 0;
  store.peeks = [];
  store.spends = [];
  store.blocked = [];
});

afterEach(() => {
  delete process.env.REGISTER_MAX_PER_HOUR;
});

describe("registration is capped per IP and per instance", () => {
  it("creates the pending account and mails a code on a clean request", async () => {
    const res = await register();

    expect(res.status).toBe(200);
    expect(store.inserted[0]?.status).toBe("suspended");
    expect(store.sent).toEqual([GOOD.email]);
  });

  it("refuses a flood from one address with a countdown", async () => {
    store.blocked = ["register:203.0.113.7"];
    const res = await register();
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe("REGISTER_THROTTLED");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(store.sent).toEqual([]);
  });

  it("refuses an instance-wide flood before spending an argon2 hash", async () => {
    store.blocked = ["register:global"];
    const res = await register();
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe("REGISTER_PAUSED");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Peeked before the body is even parsed, so a botnet cannot make the server
    // burn ~0.5s of CPU per refused request.
    expect(store.hashCalls).toBe(0);
    expect(store.inserted).toEqual([]);
  });

  it("defaults the hourly ceiling to 30", async () => {
    await register();
    expect(store.peeks).toContainEqual({ key: "register:global", max: 30 });
  });

  it("takes the ceiling from REGISTER_MAX_PER_HOUR", async () => {
    process.env.REGISTER_MAX_PER_HOUR = "200";
    await register();
    expect(store.peeks).toContainEqual({ key: "register:global", max: 200 });
  });

  it("falls back to the default when the override is junk or zero", async () => {
    process.env.REGISTER_MAX_PER_HOUR = "not-a-number";
    await register();
    process.env.REGISTER_MAX_PER_HOUR = "0";
    await register();

    // A typo in an env var must not silently disable registration entirely.
    expect(store.peeks.filter((p) => p.key === "register:global")).toEqual([
      { key: "register:global", max: 30 },
      { key: "register:global", max: 30 },
    ]);
  });
});

/**
 * The cap is charged for an account, not for a request. Anything that fails
 * before an account exists must leave the budget untouched, or a flood of junk
 * closes signup for real users — a denial of service handed out by the control
 * that exists to prevent one.
 */
describe("the hourly ceiling is charged only when an account is created", () => {
  it("charges exactly one unit for a successful signup", async () => {
    await register();
    expect(globalSpends()).toEqual([{ key: "register:global", max: 30 }]);
  });

  it("charges nothing for a malformed body", async () => {
    const res = await register({ username: "a", email: "not-an-email", password: "short" });
    expect(res.status).toBe(400);
    expect(globalSpends()).toEqual([]);
  });

  it("charges nothing for a weak password", async () => {
    const res = await register({ ...GOOD, password: "password123456" });
    expect(res.status).toBe(400);
    expect(globalSpends()).toEqual([]);
  });

  it("charges nothing when the username or email is already taken", async () => {
    store.existing = { id: "user-existing" };
    const res = await register();

    expect(res.status).toBe(409);
    expect(globalSpends()).toEqual([]);
    expect(store.sent).toEqual([]);
  });

  it("still rolls the account back when the mail cannot be sent", async () => {
    store.otpCode = null;
    const res = await register();

    expect(res.status).toBe(503);
    expect(store.deleted).toBe(1);
    // The unit was spent: the request did reach the mailer, and a bad address that
    // fails on send is exactly the traffic worth rate-limiting.
    expect(globalSpends()).toEqual([{ key: "register:global", max: 30 }]);
  });
});
