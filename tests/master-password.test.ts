import { describe, expect, it } from "vitest";
import {
  MASTER_PASSWORD_MAX_LENGTH,
  MASTER_PASSWORD_MIN_LENGTH,
  validateMasterPassword,
} from "../scripts/master-password";

describe("master admin password policy", () => {
  it("accepts exactly the requested six-character minimum", () => {
    expect(MASTER_PASSWORD_MIN_LENGTH).toBe(6);
    expect(validateMasterPassword("123456")).toBeNull();
  });

  it("rejects values below six characters", () => {
    expect(validateMasterPassword("12345")).toContain("6");
  });

  it("keeps a bounded maximum", () => {
    expect(validateMasterPassword("x".repeat(MASTER_PASSWORD_MAX_LENGTH))).toBeNull();
    expect(validateMasterPassword("x".repeat(MASTER_PASSWORD_MAX_LENGTH + 1))).toContain(
      "128",
    );
  });
});

