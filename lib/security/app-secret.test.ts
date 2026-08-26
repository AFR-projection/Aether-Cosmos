import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appSecret,
  resetAppSecretWarning,
  DEV_FALLBACK_SECRET,
  MIN_SECRET_LENGTH,
} from "@/lib/security/app-secret";

/**
 * `SESSION_SECRET` is the HMAC key behind staged login tokens and the KDF input
 * for stored Gmail App Passwords. The three modules that used it each carried
 * their own `|| "dev-insecure-secret-change-me"` fallback, so a production
 * deployment that forgot the variable ran on a secret published in the source:
 * a `step_code`-stage token could be forged for any known user id, skipping both
 * the 2-Step Code and the authenticator layer.
 */

const LONG = "x".repeat(64);

describe("appSecret", () => {
  beforeEach(() => resetAppSecretWarning());
  afterEach(() => resetAppSecretWarning());

  it("returns the configured secret", () => {
    expect(appSecret({ SESSION_SECRET: LONG })).toBe(LONG);
  });

  it("falls back to CSRF_SECRET", () => {
    expect(appSecret({ CSRF_SECRET: LONG })).toBe(LONG);
  });

  it("refuses the development placeholder in production", () => {
    expect(() => appSecret({ NODE_ENV: "production" })).toThrow(
      /SESSION_SECRET is not set/
    );
    // Blank and whitespace-only count as unset, not as a secret.
    expect(() =>
      appSecret({ NODE_ENV: "production", SESSION_SECRET: "   " })
    ).toThrow(/SESSION_SECRET is not set/);
  });

  it("still allows the placeholder outside production", () => {
    expect(appSecret({ NODE_ENV: "development" })).toBe(DEV_FALLBACK_SECRET);
    expect(appSecret({ NODE_ENV: "test" })).toBe(DEV_FALLBACK_SECRET);
  });

  it("accepts a short secret but warns exactly once", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const short = "abc";
      expect(appSecret({ SESSION_SECRET: short })).toBe(short);
      expect(appSecret({ SESSION_SECRET: short })).toBe(short);
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(String(MIN_SECRET_LENGTH));
  });

  it("does not warn for a long secret", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      appSecret({ SESSION_SECRET: LONG });
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
  });
});

describe("staged login tokens are bound to the app secret", () => {
  it("a token signed under one secret does not verify under another", async () => {
    const { createStagedToken, verifyStagedToken } = await import("@/lib/security/step-code");
    const previous = process.env.SESSION_SECRET;

    process.env.SESSION_SECRET = LONG;
    const token = createStagedToken("user-1", "step_code");
    expect(verifyStagedToken(token, "step_code")?.userId).toBe("user-1");

    process.env.SESSION_SECRET = "y".repeat(64);
    expect(verifyStagedToken(token, "step_code")).toBeNull();

    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  });

  it("a password-stage token cannot be presented to the TOTP layer", async () => {
    const { createStagedToken, verifyStagedToken } = await import("@/lib/security/step-code");
    const token = createStagedToken("user-1", "password");
    expect(verifyStagedToken(token, "step_code")).toBeNull();
    expect(verifyStagedToken(token, "password")?.userId).toBe("user-1");
  });

  it("rejects an expired token", async () => {
    const { createStagedToken, verifyStagedToken } = await import("@/lib/security/step-code");
    const token = createStagedToken("user-1", "password", -1);
    expect(verifyStagedToken(token, "password")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { createStagedToken, verifyStagedToken } = await import("@/lib/security/step-code");
    const token = createStagedToken("user-1", "password");
    const parts = token.split(".");
    parts[0] = "user-2";
    expect(verifyStagedToken(parts.join("."), "password")).toBeNull();
  });
});
