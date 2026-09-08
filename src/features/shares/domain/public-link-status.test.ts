import { describe, expect, it } from "vitest";
import {
  derivePublicLinkStatus,
  isPublicLinkActive,
  type PublicLinkStatusInput,
} from "./public-link-status";

const NOW = new Date("2026-09-08T12:00:00.000Z");

function share(overrides: Partial<PublicLinkStatusInput> = {}): PublicLinkStatusInput {
  return {
    expiresAt: null,
    accessCount: 0,
    maxAccessCount: null,
    ...overrides,
  };
}

describe("derivePublicLinkStatus", () => {
  it("treats the expiry boundary as expired", () => {
    expect(derivePublicLinkStatus(share({ expiresAt: NOW.toISOString() }), NOW)).toBe("expired");
  });

  it("distinguishes past and future expiry", () => {
    expect(derivePublicLinkStatus(share({ expiresAt: "2026-09-08T11:59:59.999Z" }), NOW)).toBe("expired");
    expect(derivePublicLinkStatus(share({ expiresAt: "2026-09-08T12:00:00.001Z" }), NOW)).toBe("active");
  });

  it("treats the access limit boundary as reached", () => {
    expect(derivePublicLinkStatus(share({ accessCount: 3, maxAccessCount: 3 }), NOW)).toBe("limit-reached");
  });

  it("treats null constraints as unlimited", () => {
    expect(derivePublicLinkStatus(share({ accessCount: 999 }), NOW)).toBe("active");
  });

  it("gives expiry precedence over a reached limit", () => {
    expect(derivePublicLinkStatus(share({ expiresAt: NOW.toISOString(), accessCount: 3, maxAccessCount: 3 }), NOW)).toBe("expired");
  });

  it("reports whether a link contributes to the active summary", () => {
    expect(isPublicLinkActive(share(), NOW)).toBe(true);
    expect(isPublicLinkActive(share({ accessCount: 1, maxAccessCount: 1 }), NOW)).toBe(false);
  });
});
