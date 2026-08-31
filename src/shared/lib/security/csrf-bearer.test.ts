import { describe, it, expect } from "vitest";
import type { NextRequest } from "next/server";
import { validateCsrf } from "@/shared/lib/security";

/** Minimal NextRequest stand-in: only the bits validateCsrf touches. */
function mockRequest(opts: {
  authorization?: string;
  csrfHeader?: string;
  csrfCookie?: string;
}): NextRequest {
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "authorization") return opts.authorization ?? null;
        if (key === "x-csrf-token") return opts.csrfHeader ?? null;
        return null;
      },
    },
    cookies: {
      get: (name: string) =>
        name === "csrf_token" && opts.csrfCookie
          ? { value: opts.csrfCookie }
          : undefined,
    },
  } as unknown as NextRequest;
}

describe("validateCsrf — programmatic Bearer tokens bypass CSRF", () => {
  it("allows sk_ user API keys without a CSRF cookie", async () => {
    const req = mockRequest({ authorization: "Bearer sk_abc123" });
    expect(await validateCsrf(req)).toBe(true);
  });

  it("allows skm_ master API keys without a CSRF cookie (was blocked before)", async () => {
    const req = mockRequest({ authorization: "Bearer skm_abc123" });
    expect(await validateCsrf(req)).toBe(true);
  });

  it("allows oat_ OAuth access tokens without a CSRF cookie (MCP writes)", async () => {
    const req = mockRequest({ authorization: "Bearer oat_abc123" });
    expect(await validateCsrf(req)).toBe(true);
  });

  it("still requires a matching CSRF token for cookie sessions", async () => {
    expect(await validateCsrf(mockRequest({}))).toBe(false);
    expect(
      await validateCsrf(mockRequest({ csrfHeader: "x", csrfCookie: "y" }))
    ).toBe(false);
    expect(
      await validateCsrf(mockRequest({ csrfHeader: "same", csrfCookie: "same" }))
    ).toBe(true);
  });

  it("does not treat an unrelated Bearer token as a bypass", async () => {
    const req = mockRequest({ authorization: "Bearer randomjwt.value.here" });
    expect(await validateCsrf(req)).toBe(false);
  });
});
