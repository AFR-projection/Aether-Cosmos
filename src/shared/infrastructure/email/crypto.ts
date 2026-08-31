import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { appSecret } from "@/shared/lib/security/app-secret";

/**
 * At-rest encryption for Gmail App Passwords. Admins paste a 16-char App
 * Password into the panel; we must be able to read it back to open an SMTP
 * transport, so it can't be one-way hashed — instead it's encrypted with
 * AES-256-GCM under a key derived from SESSION_SECRET. The DB only ever holds
 * ciphertext, so a DB dump alone can't send mail as the sender.
 *
 * The key comes from `src/shared/lib/security/app-secret.ts`, which refuses to fall back to
 * the public development placeholder in production — otherwise a deployment with
 * SESSION_SECRET unset would encrypt every App Password under a key that is in
 * the source tree.
 */

const ALGO = "aes-256-gcm";
const KEY_SALT = "storagebyafr:mail-sender:v1";

/** Derive a stable 32-byte key from the app secret (scrypt, fixed salt). */
function key(): Buffer {
  return scryptSync(appSecret(), KEY_SALT, 32);
}

/**
 * Encrypt a secret. Returns "v1:<iv>:<tag>:<ciphertext>" (all base64) so the
 * format is self-describing and future key rotations can bump the version.
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/** Decrypt a value produced by encryptSecret. Throws if tampered/undecodable. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized secret format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
