import { describe, it, expect } from "vitest";
import {
  MAX_QUOTA_BYTES,
  adminUserUpdateSchema,
  normalizeAdminEmail,
  sessionRevocationReason,
} from "@admin/domain/services/user-update";

/**
 * The pure half of the admin user-edit fix. The routes are exercised end to end in
 * `tests/admin-users-routes.test.ts`; this pins the decisions themselves.
 */

describe("adminUserUpdateSchema", () => {
  it("strips fields it does not name", () => {
    const parsed = adminUserUpdateSchema.parse({
      username: "renamed",
      passwordHash: "pwned",
      usedBytes: 0,
      id: "somewhere-else",
    });
    expect(parsed).toEqual({ username: "renamed" });
  });

  it("trims the username before bounding it", () => {
    expect(adminUserUpdateSchema.parse({ username: "  bob  " }).username).toBe("bob");
    // Trimmed to two characters, which is under the minimum.
    expect(adminUserUpdateSchema.safeParse({ username: "  ab  " }).success).toBe(false);
  });

  it("keeps quotas inside what the bigint column can round-trip as a number", () => {
    expect(adminUserUpdateSchema.safeParse({ quotaBytes: MAX_QUOTA_BYTES }).success).toBe(true);
    expect(adminUserUpdateSchema.safeParse({ quotaBytes: MAX_QUOTA_BYTES + 1 }).success).toBe(false);
    expect(MAX_QUOTA_BYTES).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("rejects the non-finite numbers a JSON body can carry as strings", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(adminUserUpdateSchema.safeParse({ quotaBytes: value }).success, String(value)).toBe(
        false
      );
    }
  });

  it("enumerates role and status, because both are pgEnum columns", () => {
    expect(adminUserUpdateSchema.safeParse({ role: "root" }).success).toBe(false);
    expect(adminUserUpdateSchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(adminUserUpdateSchema.safeParse({ role: "master" }).success).toBe(true);
    expect(adminUserUpdateSchema.safeParse({ status: "suspended" }).success).toBe(true);
  });

  it("bounds the password so a megabyte does not reach the hasher", () => {
    expect(adminUserUpdateSchema.safeParse({ password: "x".repeat(201) }).success).toBe(false);
  });
});

describe("normalizeAdminEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeAdminEmail("  Bob@Example.COM ")).toEqual({
      ok: true,
      email: "bob@example.com",
    });
  });

  it("treats empty, whitespace and null as a clear", () => {
    for (const value of ["", "   ", null]) {
      expect(normalizeAdminEmail(value)).toEqual({ ok: true, email: null });
    }
  });

  it("refuses an address with no domain, no local part or spaces in it", () => {
    for (const value of ["nope", "@example.com", "bob@", "bob@example", "a b@example.com"]) {
      expect(normalizeAdminEmail(value), value).toEqual({ ok: false });
    }
  });
});

describe("sessionRevocationReason", () => {
  it("revokes on a password reset", () => {
    expect(sessionRevocationReason({ password: "whatever" })).toBe("password_reset");
  });

  it("revokes on suspension and on a forced reset", () => {
    expect(sessionRevocationReason({ status: "suspended" })).toBe("suspended");
    expect(sessionRevocationReason({ mustChangePassword: true })).toBe("must_change_password");
  });

  it("reports the password as the reason when several apply", () => {
    expect(
      sessionRevocationReason({ password: "x", status: "suspended", mustChangePassword: true })
    ).toBe("password_reset");
  });

  it("leaves sessions alone for everything else", () => {
    for (const update of [
      {},
      { username: "renamed" },
      { quotaBytes: 0 },
      { status: "active" as const },
      { mustChangePassword: false },
      { role: "user" as const },
      { email: null },
    ]) {
      expect(sessionRevocationReason(update), JSON.stringify(update)).toBeNull();
    }
  });
});
