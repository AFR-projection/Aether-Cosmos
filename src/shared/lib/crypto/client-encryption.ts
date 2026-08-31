/**
 * Browser-only AES-GCM helpers (Web Crypto).
 * Import only from client components / client modules — never from server routes.
 */

export type EncryptionMetaV1 = {
  salt: string;
  iv: string;
  version: 1;
};

export type EncryptionMeta = EncryptionMetaV1;

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

function requireCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Web Crypto is not available in this environment");
  }
  return globalThis.crypto;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const crypto = requireCrypto();
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    usages
  );
}

export function isEncryptionMeta(value: unknown): value is EncryptionMetaV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.salt === "string" &&
    v.salt.length > 0 &&
    typeof v.iv === "string" &&
    v.iv.length > 0
  );
}

export async function encryptArrayBuffer(
  plaintext: ArrayBuffer,
  passphrase: string
): Promise<{ ciphertext: ArrayBuffer; meta: EncryptionMetaV1 }> {
  if (!passphrase) throw new Error("Passphrase is required");

  const crypto = requireCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(passphrase, salt, ["encrypt"]);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  return {
    ciphertext,
    meta: {
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      version: 1,
    },
  };
}

export async function decryptArrayBuffer(
  ciphertext: ArrayBuffer,
  passphrase: string,
  meta: EncryptionMetaV1
): Promise<ArrayBuffer> {
  if (!passphrase) throw new Error("Passphrase is required");
  if (!isEncryptionMeta(meta)) throw new Error("Invalid encryption metadata");

  const crypto = requireCrypto();
  const salt = base64ToBytes(meta.salt);
  const iv = base64ToBytes(meta.iv);
  const key = await deriveAesKey(passphrase, salt, ["decrypt"]);

  try {
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext
    );
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted data");
  }
}

export async function encryptFile(
  file: File,
  passphrase: string
): Promise<{ blob: Blob; meta: EncryptionMetaV1; sizeBytes: number }> {
  const { ciphertext, meta } = await encryptArrayBuffer(
    await file.arrayBuffer(),
    passphrase
  );
  const blob = new Blob([ciphertext as BlobPart], {
    type: "application/octet-stream",
  });
  return { blob, meta, sizeBytes: blob.size };
}

export async function decryptToBlob(
  ciphertext: ArrayBuffer,
  passphrase: string,
  meta: EncryptionMetaV1,
  mimeType: string
): Promise<Blob> {
  const plaintext = await decryptArrayBuffer(ciphertext, passphrase, meta);
  return new Blob([plaintext as BlobPart], {
    type: mimeType || "application/octet-stream",
  });
}
