import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_QUOTA_BYTES } from "@admin/domain/services/user-update";

/**
 * Guard rails on the two admin user-edit endpoints.
 *
 * `PATCH /api/admin/users/[id]` parsed nothing at all: `await request.json()` was
 * copied field by field onto a drizzle update, so `role: "root"` reached a pgEnum
 * column (driver error → 500), `quotaBytes: -1` / `1e30` reached a
 * `bigint({mode:"number"})` column, `username` was unbounded against an unbounded
 * `text` column, and `mustChangePassword: "no"` stored as truthy. `DELETE`
 * destructured an unvalidated body, so a request with no body was a 500.
 *
 * Neither route revoked the target's sessions. Session rows carry no link to the
 * password, so an admin resetting a credential to evict an attacker changed nothing
 * the attacker was holding: every cookie they already had kept working.
 */

const store = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  masterCount: 2,
  updates: [] as Record<string, unknown>[],
  revoked: [] as string[],
  deletes: 0,
  activity: [] as { action: string; metadata?: Record<string, unknown> }[],
}));

vi.mock("@/shared/infrastructure/db", () => {
  function selectChain(projection?: unknown) {
    // Only the "how many masters are left" query passes a projection; everything
    // else selects whole user rows.
    const rows = projection !== undefined
      ? [{ count: store.masterCount }]
      : store.user
        ? [store.user]
        : [];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "where", "orderBy", "groupBy", "limit"]) {
      chain[step] = () => chain;
    }
    chain.then = (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  const updateChain = {
    set: (values: Record<string, unknown>) => {
      store.updates.push(values);
      return updateChain;
    },
    where: async () => undefined,
  };

  return {
    db: {
      select: (projection?: unknown) => selectChain(projection),
      update: () => updateChain,
      delete: () => ({
        where: async () => {
          store.deletes++;
        },
      }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: "new-user", username: "new" }] }),
      }),
    },
  };
});

vi.mock("@/shared/infrastructure/db/schema", async (importOriginal) => importOriginal());

vi.mock("@/shared/lib/auth/api-key", () => ({ requireMasterOrApiKey: vi.fn() }));

vi.mock("@/shared/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/security")>();
  return { ...actual, validateCsrf: vi.fn() };
});

vi.mock("@/shared/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/session")>();
  return {
    ...actual,
    getClientIp: vi.fn(() => "127.0.0.1"),
    destroyAllUserSessions: vi.fn(async (userId: string) => {
      store.revoked.push(userId);
    }),
  };
});

vi.mock("@/shared/lib/auth/password", () => ({
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
}));

vi.mock("@/shared/lib/auth/audit", () => ({
  logActivity: vi.fn(async (_actor: unknown, action: string, extra?: { metadata?: Record<string, unknown> }) => {
    store.activity.push({ action, metadata: extra?.metadata });
  }),
}));

vi.mock("@/shared/infrastructure/cache/redis", () => ({ cacheDelPattern: vi.fn(async () => undefined) }));
vi.mock("@/shared/infrastructure/realtime/events", () => ({ publishToAdmins: vi.fn(async () => undefined) }));
vi.mock("@files/infrastructure/storage/r2", () => ({ deleteR2Object: vi.fn(async () => undefined) }));
vi.mock("@/shared/lib/settings/admin-settings", () => ({
  getAdminSettings: vi.fn(async () => ({})),
  defaultQuotaBytes: vi.fn(() => 1024),
}));

const { requireMasterOrApiKey } = await import("@/shared/lib/auth/api-key");
const { validateCsrf } = await import("@/shared/lib/security");
const { destroyAllUserSessions } = await import("@/shared/lib/auth/session");

const TARGET = "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a01";
/** 14 chars, four character classes — passes the real strength policy. */
const STRONG = "Tr0ub4dor&Xyz9";

/** `PATCH /api/admin/users/[id]` — the per-user route. */
async function patchOne(body: unknown) {
  const { PATCH } = await import("@/app/api/admin/users/[id]/route");
  return PATCH(
    new NextRequest(`http://localhost/api/admin/users/${TARGET}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TARGET }) }
  );
}

/** `DELETE /api/admin/users/[id]`, optionally with no body at all. */
async function deleteOne(body?: unknown) {
  const { DELETE } = await import("@/app/api/admin/users/[id]/route");
  return DELETE(
    new NextRequest(`http://localhost/api/admin/users/${TARGET}`, {
      method: "DELETE",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: TARGET }) }
  );
}

/** `PATCH /api/admin/users` — the collection route, target id in the body. */
async function patchCollection(body: unknown) {
  const { PATCH } = await import("@/app/api/admin/users/route");
  return PATCH(
    new NextRequest("http://localhost/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  store.user = {
    id: TARGET,
    username: "victim",
    email: "victim@example.com",
    role: "user",
    status: "active",
    suspendReason: null,
    mustChangePassword: false,
    quotaBytes: 1024,
    bandwidthQuotaBytes: 2048,
    passwordHash: "old-hash",
  };
  store.masterCount = 2;
  store.updates = [];
  store.revoked = [];
  store.deletes = 0;
  store.activity = [];
  vi.clearAllMocks();
  vi.mocked(requireMasterOrApiKey).mockResolvedValue({ id: "admin-1", role: "master" } as never);
  vi.mocked(validateCsrf).mockResolvedValue(true);
});

describe("PATCH /api/admin/users/[id] — input validation", () => {
  it("applies a well-formed update", async () => {
    const response = await patchOne({ username: "renamed", quotaBytes: 4096 });

    expect(response.status).toBe(200);
    expect(store.updates[0]).toMatchObject({ username: "renamed", quotaBytes: 4096 });
  });

  it("refuses a role outside the enum instead of handing it to the column", async () => {
    const response = await patchOne({ role: "root" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.updates).toEqual([]);
  });

  it("refuses a status outside the enum", async () => {
    const response = await patchOne({ status: "deleted" });
    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("refuses negative, fractional and absurd quotas", async () => {
    for (const body of [
      { quotaBytes: -1 },
      { quotaBytes: 1.5 },
      { quotaBytes: MAX_QUOTA_BYTES + 1 },
      { quotaBytes: 1e30 },
      { bandwidthQuotaBytes: -1 },
      { bandwidthQuotaBytes: MAX_QUOTA_BYTES + 1 },
    ]) {
      const response = await patchOne(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(store.updates).toEqual([]);
  });

  it("stores a zero quota rather than silently skipping it", async () => {
    // `if (body.quotaBytes)` skipped 0, so "no storage at all" was unsettable.
    const response = await patchOne({ quotaBytes: 0 });
    expect(response.status).toBe(200);
    expect(store.updates[0]).toMatchObject({ quotaBytes: 0 });
  });

  it("refuses a non-boolean mustChangePassword instead of storing it as truthy", async () => {
    const response = await patchOne({ mustChangePassword: "no" });
    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("bounds the username against the unbounded text column", async () => {
    expect((await patchOne({ username: "a".repeat(51) })).status).toBe(400);
    expect((await patchOne({ username: "ab" })).status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("bounds the suspend reason", async () => {
    const response = await patchOne({ status: "suspended", suspendReason: "x".repeat(501) });
    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("still rejects a malformed email with a readable message", async () => {
    const response = await patchOne({ email: "not-an-email" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Please enter a valid email address.",
    });
    expect(store.updates).toEqual([]);
  });

  it("normalizes an email and treats empty as a clear", async () => {
    await patchOne({ email: "  MixedCase@Example.COM " });
    expect(store.updates[0]).toMatchObject({ email: "mixedcase@example.com" });

    store.updates = [];
    await patchOne({ email: "" });
    expect(store.updates[0]).toMatchObject({ email: null });

    store.updates = [];
    await patchOne({ email: null });
    expect(store.updates[0]).toMatchObject({ email: null });
  });

  it("ignores fields it does not recognize", async () => {
    // A stripping schema means an attacker cannot reach a column the route never
    // meant to expose.
    const response = await patchOne({ username: "renamed", passwordHash: "pwned", usedBytes: 0 });
    expect(response.status).toBe(200);
    expect(store.updates[0]).not.toHaveProperty("passwordHash");
    expect(store.updates[0]).not.toHaveProperty("usedBytes");
  });

  it("returns 400, not 500, for a body that is not JSON", async () => {
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const response = await PATCH(
      new NextRequest(`http://localhost/api/admin/users/${TARGET}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
      { params: Promise.resolve({ id: TARGET }) }
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_JSON" });
  });
});

describe("PATCH /api/admin/users/[id] — session revocation", () => {
  it("revokes the target's sessions when the password is reset", async () => {
    const response = await patchOne({ password: STRONG });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { sessionsRevoked: true },
    });
    expect(store.revoked).toEqual([TARGET]);
    expect(store.updates[0]).toMatchObject({ passwordHash: `hashed:${STRONG}` });
  });

  it("revokes on suspension", async () => {
    await patchOne({ status: "suspended" });
    expect(store.revoked).toEqual([TARGET]);
  });

  it("revokes when the user is forced to change their password", async () => {
    // The flag is enforced by a redirect in the page layouts, so without this an
    // established session keeps driving the API and never passes through it.
    await patchOne({ mustChangePassword: true });
    expect(store.revoked).toEqual([TARGET]);
  });

  it("leaves sessions alone for an edit that does not touch credentials", async () => {
    const response = await patchOne({ quotaBytes: 8192 });
    await expect(response.json()).resolves.toMatchObject({
      data: { sessionsRevoked: false },
    });
    expect(destroyAllUserSessions).not.toHaveBeenCalled();
  });

  it("does not revoke when clearing the force-reset flag or reactivating", async () => {
    await patchOne({ mustChangePassword: false });
    await patchOne({ status: "active" });
    expect(store.revoked).toEqual([]);
  });

  it("records the revocation in the audit log", async () => {
    await patchOne({ password: STRONG });
    expect(store.activity[0]?.metadata).toMatchObject({ sessionsRevoked: "password_reset" });
  });

  it("does not revoke when the update is rejected", async () => {
    const response = await patchOne({ password: "weak" });
    expect(response.status).toBe(400);
    expect(store.revoked).toEqual([]);
    expect(store.updates).toEqual([]);
  });
});

describe("PATCH /api/admin/users/[id] — existing guards still hold", () => {
  it("rejects a missing CSRF token before authenticating", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const response = await patchOne({ username: "renamed" });

    expect(response.status).toBe(403);
    expect(requireMasterOrApiKey).not.toHaveBeenCalled();
    expect(store.updates).toEqual([]);
  });

  it("is master-gated", async () => {
    const { AuthError } = await import("@/shared/lib/auth/session");
    vi.mocked(requireMasterOrApiKey).mockRejectedValue(new AuthError("Forbidden", 403));
    const response = await patchOne({ username: "renamed" });

    expect(response.status).toBe(403);
    expect(store.updates).toEqual([]);
  });

  it("404s an unknown user without revoking anything", async () => {
    store.user = null;
    const response = await patchOne({ password: STRONG });

    expect(response.status).toBe(404);
    expect(store.revoked).toEqual([]);
  });

  it("refuses to suspend a master", async () => {
    store.user = { ...store.user!, role: "master" };
    const response = await patchOne({ status: "suspended" });

    expect(response.status).toBe(403);
    expect(store.revoked).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("refuses to demote the last master", async () => {
    store.user = { ...store.user!, role: "master" };
    store.masterCount = 1;
    const response = await patchOne({ role: "user" });

    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("always records a reason for an admin suspension", async () => {
    // A null reason is reserved for pending-email-verification accounts, which can
    // self-reactivate through the email OTP flow.
    await patchOne({ status: "suspended" });
    expect(store.updates[0]).toMatchObject({
      status: "suspended",
      suspendReason: "Suspended by administrator",
    });
  });
});

describe("DELETE /api/admin/users/[id]", () => {
  it("treats a missing body as a delete without data removal", async () => {
    const response = await deleteOne();

    expect(response.status).toBe(200);
    expect(store.deletes).toBe(1);
  });

  it("refuses a non-boolean deleteData", async () => {
    const response = await deleteOne({ deleteData: "yes" });
    expect(response.status).toBe(400);
    expect(store.deletes).toBe(0);
  });

  it("still refuses to delete a master", async () => {
    store.user = { ...store.user!, role: "master" };
    const response = await deleteOne({ deleteData: true });

    expect(response.status).toBe(403);
    expect(store.deletes).toBe(0);
  });
});

describe("PATCH /api/admin/users — the collection route matches", () => {
  it("bounds the username on the update path, as create already did", async () => {
    const response = await patchCollection({ id: TARGET, username: "a".repeat(51) });
    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("revokes sessions on a password reset", async () => {
    const response = await patchCollection({ id: TARGET, password: STRONG });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { sessionsRevoked: true } });
    expect(store.revoked).toEqual([TARGET]);
  });

  it("revokes sessions on suspension and on a forced reset", async () => {
    await patchCollection({ id: TARGET, status: "suspended" });
    expect(store.revoked).toEqual([TARGET]);

    store.revoked = [];
    await patchCollection({ id: TARGET, mustChangePassword: true });
    expect(store.revoked).toEqual([TARGET]);
  });

  it("leaves sessions alone for a plain quota change", async () => {
    await patchCollection({ id: TARGET, bandwidthQuotaBytes: 1 });
    expect(store.revoked).toEqual([]);
  });

  it("refuses an absurd quota", async () => {
    const response = await patchCollection({ id: TARGET, quotaBytes: 1e30 });
    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("still requires a uuid target", async () => {
    const response = await patchCollection({ id: "not-a-uuid", username: "renamed" });
    expect(response.status).toBe(400);
    expect(store.updates).toEqual([]);
  });
});
