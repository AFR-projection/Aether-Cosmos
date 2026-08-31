import { describe, it, expect } from "vitest";
import {
  validateStepCode,
  hashStepCode,
  verifyStepCode,
  createStagedToken,
  verifyStagedToken,
  normalizeStepCodeLength,
  STEP_CODE_MIN_LENGTH,
  STEP_CODE_MAX_LENGTH,
} from "@/shared/lib/security/step-code";

describe("validateStepCode", () => {
  it("accepts a well-formed code", () => {
    expect(validateStepCode("482915").valid).toBe(true);
    expect(validateStepCode("9174036285").valid).toBe(true);
  });

  it("rejects non-digits", () => {
    expect(validateStepCode("48a915").valid).toBe(false);
    expect(validateStepCode("4829 15").valid).toBe(false);
    expect(validateStepCode("48-915").valid).toBe(false);
  });

  it("enforces the length window", () => {
    expect(validateStepCode("48291").valid).toBe(false);
    expect(validateStepCode("48291572906").valid).toBe(false);
    expect(validateStepCode("4".repeat(STEP_CODE_MIN_LENGTH - 1)).valid).toBe(false);
    // Boundaries themselves are valid shapes (pattern rules aside).
    expect(validateStepCode("482915").valid).toBe(true);
    expect(validateStepCode("4829153706").valid).toBe(true);
    expect(STEP_CODE_MAX_LENGTH).toBe(10);
  });

  it("rejects repeated digits", () => {
    expect(validateStepCode("111111").valid).toBe(false);
    expect(validateStepCode("0000000000").valid).toBe(false);
  });

  it("rejects straight sequences in both directions", () => {
    expect(validateStepCode("123456").valid).toBe(false);
    expect(validateStepCode("654321").valid).toBe(false);
    expect(validateStepCode("0123456789").valid).toBe(false);
  });

  it("rejects repeating units", () => {
    expect(validateStepCode("121212").valid).toBe(false);
    expect(validateStepCode("123123").valid).toBe(false);
  });

  it("rejects date-shaped codes", () => {
    expect(validateStepCode("17081945").valid).toBe(false); // DDMMYYYY
    expect(validateStepCode("19900215").valid).toBe(false); // YYYYMMDD
    expect(validateStepCode("251299").valid).toBe(false); // DDMMYY
  });

  it("reports every applicable error at once for shape problems", () => {
    const r = validateStepCode("abc");
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("step code hashing", () => {
  it("round-trips and rejects a wrong code", async () => {
    const hash = await hashStepCode("482915");
    expect(await verifyStepCode("482915", hash)).toBe(true);
    expect(await verifyStepCode("482916", hash)).toBe(false);
  });

  it("does not store the code in the hash", async () => {
    const hash = await hashStepCode("482915");
    expect(hash).not.toContain("482915");
  });

  it("produces a different hash for the same code (salted)", async () => {
    const a = await hashStepCode("482915");
    const b = await hashStepCode("482915");
    expect(a).not.toBe(b);
  });
});

describe("staged auth tokens", () => {
  it("verifies a token at its own stage", () => {
    const token = createStagedToken("user-1", "password");
    expect(verifyStagedToken(token, "password")?.userId).toBe("user-1");
  });

  it("refuses a token presented at a later stage", () => {
    // The core guarantee: a password-stage token cannot be used to satisfy the
    // TOTP step, so the 2-Step Code layer cannot be skipped.
    const token = createStagedToken("user-1", "password");
    expect(verifyStagedToken(token, "step_code")).toBeNull();
  });

  it("refuses a token presented at an earlier stage", () => {
    const token = createStagedToken("user-1", "step_code");
    expect(verifyStagedToken(token, "password")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = createStagedToken("user-1", "password");
    const parts = token.split(".");
    const forged = ["user-2", parts[1], parts[2], parts[3], parts[4]].join(".");
    expect(verifyStagedToken(forged, "password")).toBeNull();
  });

  it("rejects a tampered stage", () => {
    const token = createStagedToken("user-1", "password");
    const parts = token.split(".");
    const forged = [parts[0], "step_code", parts[2], parts[3], parts[4]].join(".");
    expect(verifyStagedToken(forged, "step_code")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createStagedToken("user-1", "password", -1000);
    expect(verifyStagedToken(token, "password")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyStagedToken("", "password")).toBeNull();
    expect(verifyStagedToken("a.b.c", "password")).toBeNull();
    expect(verifyStagedToken("....", "password")).toBeNull();
  });

  it("carries a distinct jti per token", () => {
    const a = verifyStagedToken(createStagedToken("u", "password"), "password");
    const b = verifyStagedToken(createStagedToken("u", "password"), "password");
    expect(a!.jti).not.toBe(b!.jti);
  });
});

/**
 * The login numpad draws one slot per digit the account's code actually has. A
 * bad length is worse than an unknown one: a pad locked to 5 or 11 slots could
 * never be completed, so anything outside the range degrades to "unknown" and
 * the flexible pad.
 */
describe("normalizeStepCodeLength", () => {
  it("passes through every length a code may have", () => {
    for (let n = STEP_CODE_MIN_LENGTH; n <= STEP_CODE_MAX_LENGTH; n++) {
      expect(normalizeStepCodeLength(n)).toBe(n);
    }
  });

  it("treats a missing length as unknown rather than guessing one", () => {
    expect(normalizeStepCodeLength(null)).toBeNull();
    expect(normalizeStepCodeLength(undefined)).toBeNull();
  });

  it("refuses a length no valid code could have", () => {
    expect(normalizeStepCodeLength(STEP_CODE_MIN_LENGTH - 1)).toBeNull();
    expect(normalizeStepCodeLength(STEP_CODE_MAX_LENGTH + 1)).toBeNull();
    expect(normalizeStepCodeLength(0)).toBeNull();
    expect(normalizeStepCodeLength(-6)).toBeNull();
  });

  it("refuses non-integers, which would render a fractional slot count", () => {
    expect(normalizeStepCodeLength(6.5)).toBeNull();
    expect(normalizeStepCodeLength(Number.NaN)).toBeNull();
    expect(normalizeStepCodeLength(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
