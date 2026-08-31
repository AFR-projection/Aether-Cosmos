import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto";

describe("email/crypto", () => {
  it("round-trips a secret", () => {
    const secret = "abcd efgh ijkl mnop";
    const enc = encryptSecret(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces the v1 tagged format with distinct ciphertexts per call", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a.startsWith("v1:")).toBe(true);
    expect(a.split(":")).toHaveLength(4);
    // Random IV per call → ciphertext differs even for identical plaintext.
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const enc = encryptSecret("tamper-me");
    const parts = enc.split(":");
    // Flip a byte in the ciphertext segment.
    const data = Buffer.from(parts[3], "base64");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects an unrecognized format", () => {
    expect(() => decryptSecret("not-a-valid-payload")).toThrow("Unrecognized secret format");
    expect(() => decryptSecret("v2:a:b:c")).toThrow("Unrecognized secret format");
  });
});
