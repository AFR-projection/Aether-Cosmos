import { describe, it, expect } from "vitest";
import {
  validatePasswordStrength,
  getPasswordStrengthLabel,
  getPasswordPolicyRules,
} from "@/shared/lib/security/password-policy";

describe("validatePasswordStrength", () => {
  it("rejects passwords shorter than the 10-char minimum", () => {
    const r = validatePasswordStrength("Ab1!xyz"); // 7 chars
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("Password must be at least 10 characters");
  });

  it("rejects passwords longer than the 128-char maximum", () => {
    const r = validatePasswordStrength("Aa1!" + "x".repeat(130));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("at most 128"))).toBe(true);
  });

  it("flags common passwords immediately with score 0 and stops", () => {
    const r = validatePasswordStrength("Password1"); // in COMMON_PASSWORDS (lowercased)
    expect(r.valid).toBe(false);
    expect(r.score).toBe(0);
    expect(r.errors).toContain("This password is too common");
    // Early-return path: only the "unique password" suggestion is present.
    expect(r.suggestions).toEqual(["Choose a unique password"]);
  });

  it("requires at least 3 of 4 character classes", () => {
    // Only lowercase + digits = 2 classes, length ok.
    const r = validatePasswordStrength("abcdef123456");
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes("at least 3 of"))
    ).toBe(true);
  });

  it("accepts a strong password with 3+ classes and length >= 10", () => {
    const r = validatePasswordStrength("Tr0ub4dour!x");
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it("penalizes predictable keyboard/sequence patterns", () => {
    // Meets length + classes on the surface but starts with a keyboard run.
    const r = validatePasswordStrength("qwertyUI12!");
    expect(r.errors).toContain("Password contains a predictable pattern");
  });

  it("caps the score at 4", () => {
    const r = validatePasswordStrength("X9v!Kp2$Lm7#Qw"); // long, all 4 classes
    expect(r.score).toBeLessThanOrEqual(4);
    expect(r.score).toBe(4);
  });

  it("never marks a password valid while errors exist (invariant)", () => {
    const samples = ["short", "password", "abcdefghij", "ALLUPPER123456"];
    for (const p of samples) {
      const r = validatePasswordStrength(p);
      if (r.errors.length > 0) expect(r.valid).toBe(false);
    }
  });
});

describe("getPasswordStrengthLabel", () => {
  it("maps known scores to labels", () => {
    expect(getPasswordStrengthLabel(0)).toBe("Very Weak");
    expect(getPasswordStrengthLabel(4)).toBe("Very Strong");
  });

  it("returns Unknown for out-of-range scores", () => {
    expect(getPasswordStrengthLabel(99)).toBe("Unknown");
  });
});

describe("getPasswordPolicyRules", () => {
  it("exposes human-readable rules mentioning the minimum length", () => {
    const rules = getPasswordPolicyRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.includes("10"))).toBe(true);
  });
});
