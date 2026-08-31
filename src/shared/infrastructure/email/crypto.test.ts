import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { describe, it, expect } from "vitest";
import { appSecret } from "@/shared/lib/security/app-secret";
import { encryptSecret, decryptSecret } from "./crypto";

function encryptPreviousVersion(plain: string): string {
  const salt = Buffer.from("c3RvcmFnZWJ5YWZyOm1haWwtc2VuZGVyOnYx", "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(appSecret(), salt, 32), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

describe("email/crypto", () => {
  it("round-trips a secret", () => {
    const secret = "abcd efgh ijkl mnop";
    const enc = encryptSecret(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces the v2 tagged format with distinct ciphertexts per call", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a.startsWith("v2:")).toBe(true);
    expect(a.split(":")).toHaveLength(4);
    // Random IV per call → ciphertext differs even for identical plaintext.
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("decrypts v1 ciphertext created before the product rename", () => {
    expect(decryptSecret(encryptPreviousVersion("existing-app-password"))).toBe(
      "existing-app-password"
    );
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
    expect(() => decryptSecret("v3:a:b:c")).toThrow("Unrecognized secret format");
  });
});
