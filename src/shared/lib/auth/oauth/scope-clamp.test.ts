import { describe, it, expect } from "vitest";
import {
  clampScopesToRole,
  parseScopes,
  isMasterOnlyScope,
  type AnyOAuthScope,
} from "@/shared/lib/auth/oauth/constants";

describe("clampScopesToRole — role is the hard security boundary", () => {
  it("strips ALL admin/master scopes for a normal user, even if requested", () => {
    const requested = parseScopes("read write admin:users supreme admin admin:settings");
    const clamped = clampScopesToRole(requested, "user");
    expect(clamped).toContain("read");
    expect(clamped).toContain("write");
    for (const s of clamped) {
      expect(isMasterOnlyScope(s)).toBe(false);
    }
    expect(clamped).not.toContain("admin:users");
    expect(clamped).not.toContain("supreme");
  });

  it("keeps admin/master scopes for a master account", () => {
    const requested = parseScopes("read admin:users admin:stats supreme");
    const clamped = clampScopesToRole(requested, "master");
    expect(clamped).toContain("admin:users");
    expect(clamped).toContain("admin:stats");
    expect(clamped).toContain("supreme");
  });

  it("always keeps read as a baseline so a token is never empty", () => {
    expect(clampScopesToRole([], "user")).toEqual(["read"]);
    expect(clampScopesToRole(["admin" as AnyOAuthScope], "user")).toEqual(["read"]);
  });

  it("does not treat an unknown role as master", () => {
    const clamped = clampScopesToRole(parseScopes("admin supreme"), "");
    expect(clamped).toEqual(["read"]);
  });

  it("deduplicates scopes", () => {
    const clamped = clampScopesToRole(parseScopes("read read write write"), "user");
    expect(clamped.filter((s) => s === "read")).toHaveLength(1);
    expect(clamped.filter((s) => s === "write")).toHaveLength(1);
  });

  it("parseScopes accepts master scope names as valid tokens", () => {
    expect(parseScopes("admin:users")).toContain("admin:users");
    expect(parseScopes("supreme")).toContain("supreme");
    // garbage is dropped, falls back to read
    expect(parseScopes("not_a_scope")).toEqual(["read"]);
  });
});
