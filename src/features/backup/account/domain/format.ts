import { createHmac, timingSafeEqual } from "node:crypto";
import {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  HMAC_BYTES,
  KDF_SALT_BYTES,
  KEY_BYTES,
} from "@backup/domain/types";
import type { BackupDomain } from "@backup/domain/types";
import { canonicalBytes, type CanonicalObject } from "./canonical";
import { AfrCorruptError, AfrVersionTooNewError, NotAnAfrBackupError } from "./errors";
import { bytesField, exactKeys, fail, intField, stringField } from "./fields";

/**
 * The `.afrbak` container: byte layout in, byte layout out.
 *
 * ```
 * PREAMBLE   32 bytes, fixed layout, plaintext
 * HEADER     canonical JSON, headerLength bytes, plaintext
 * HDR_HMAC   32 bytes over PREAMBLE ‖ HEADER, key = BACKUP_MASTER_KEY
 * SUMMARY    AES-256-GCM(DEK, summaryNonce), ct ‖ tag
 * INDEX      AES-256-GCM(DEK, indexNonce), ct ‖ tag, NDJSON, unbounded
 * CHUNKS     N × AES-256-GCM(DEK, noncePrefix ‖ u32BE(i)), ct ‖ tag
 * TRAILER    48 bytes, fixed layout, plaintext
 * TRL_HMAC   32 bytes over HDR_HMAC ‖ TRAILER, key = DEK
 * ```
 *
 * Everything this module parses is hostile input read **before** any key is
 * touched — the preamble has to be understood in order to know how many bytes the
 * header even is. That is what the caps are for: a length is rejected for being
 * absurd long before it is trusted enough to allocate against.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.
 */

/** `AFRBAK1\0`. Spelled in bytes so the trailing NUL is not a typo away from missing. */
export const AFRBAK_MAGIC = Buffer.from([0x41, 0x46, 0x52, 0x42, 0x41, 0x4b, 0x31, 0x00]);

export const AFR_FORMAT_VERSION = 1;

export const PREAMBLE_BYTES = 32;
export const TRAILER_BYTES = 48;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_SUMMARY_BYTES = 64 * 1024;

/**
 * What preview is allowed to cost: 32 + 16 KiB + 32 + 64 KiB = 81,984 bytes, whether
 * the archive holds one file or a million (§5.4).
 */
export const MAX_PREVIEW_BYTES =
  PREAMBLE_BYTES + MAX_HEADER_BYTES + HMAC_BYTES + MAX_SUMMARY_BYTES;

/**
 * The chunk size the writer uses, and the window a reader will accept.
 *
 * A floor as well as a ceiling: a 4 GiB `chunkSize` would have a reader allocating
 * against a number a stranger chose, and a 1-byte one turns a small file into
 * billions of GCM operations. Neither is a legitimate archive.
 */
export const AFR_CHUNK_SIZE = 4 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

/** `prefix(8) ‖ u32BE(chunkIndex)` = 12 bytes, exactly one GCM nonce (§5.3). */
export const NONCE_PREFIX_BYTES = 8;
export const NONCE_COUNTER_BYTES = 4;

/** The domain byte. 1 and 2 are the format's, not an enum's ordinal. */
const DOMAIN_TO_BYTE: Record<BackupDomain, number> = { files: 1, brain: 2 };
const BYTE_TO_DOMAIN: Record<number, BackupDomain> = { 1: "files", 2: "brain" };

export interface AfrPreamble {
  formatVersion: number;
  domain: BackupDomain;
  /** Bytes of canonical JSON, not counting `HDR_HMAC`. */
  headerLength: number;
  /** Encrypted length: plaintext + one GCM tag. */
  summaryLength: number;
  /** Encrypted length. Unbounded by the format — only the row caps of §9 bound it. */
  indexLength: number;
  chunkSize: number;
}

export function encodePreamble(preamble: AfrPreamble): Buffer {
  const out = Buffer.alloc(PREAMBLE_BYTES);
  AFRBAK_MAGIC.copy(out, 0);
  out.writeUInt16BE(preamble.formatVersion, 8);
  out.writeUInt8(DOMAIN_TO_BYTE[preamble.domain], 10);
  out.writeUInt8(0, 11); // flags: reserved, and reserved means zero
  out.writeUInt32BE(preamble.headerLength, 12);
  out.writeUInt32BE(preamble.summaryLength, 16);
  out.writeBigUInt64BE(BigInt(preamble.indexLength), 20);
  out.writeUInt32BE(preamble.chunkSize, 28);
  return out;
}

/**
 * The first read of any archive, and the one that decides whether to keep reading.
 *
 * Order matters: magic before anything (so a JPEG is "not an AFR backup" and not
 * "damaged"), version before the lengths (so a v2 archive is not called corrupt for
 * using a v2 field), lengths last.
 */
export function decodePreamble(bytes: Buffer): AfrPreamble {
  if (bytes.length < AFRBAK_MAGIC.length || !bytes.subarray(0, 8).equals(AFRBAK_MAGIC)) {
    throw new NotAnAfrBackupError("magic mismatch");
  }
  if (bytes.length < PREAMBLE_BYTES) {
    throw new AfrCorruptError(`preamble is ${bytes.length} bytes, needs ${PREAMBLE_BYTES}`);
  }

  const flags = bytes.readUInt8(11);
  if (flags !== 0) {
    // Reserved bits are how a later version signals something this build cannot do
    // — compression, say (§5.5). Refusing is the whole point of reserving them.
    throw new NotAnAfrBackupError(`flags ${flags} != 0`);
  }

  const formatVersion = bytes.readUInt16BE(8);
  if (formatVersion > AFR_FORMAT_VERSION) {
    throw new AfrVersionTooNewError(formatVersion, AFR_FORMAT_VERSION);
  }
  if (formatVersion < 1) {
    throw new AfrCorruptError(`formatVersion ${formatVersion}`);
  }

  const domain = BYTE_TO_DOMAIN[bytes.readUInt8(10)];
  if (!domain) {
    throw new AfrCorruptError(`domain byte ${bytes.readUInt8(10)}`);
  }

  const headerLength = bytes.readUInt32BE(12);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
    throw new AfrCorruptError(`headerLength ${headerLength}`);
  }

  const summaryLength = bytes.readUInt32BE(16);
  if (summaryLength <= GCM_TAG_BYTES || summaryLength > MAX_SUMMARY_BYTES) {
    throw new AfrCorruptError(`summaryLength ${summaryLength}`);
  }

  const indexRaw = bytes.readBigUInt64BE(20);
  if (indexRaw < BigInt(GCM_TAG_BYTES) || indexRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    // An empty index is still one GCM tag. The upper bound is representational, not
    // a policy cap: §5.4 leaves INDEX unbounded and lets the row caps do the work.
    throw new AfrCorruptError(`indexLength ${indexRaw.toString()}`);
  }

  const chunkSize = bytes.readUInt32BE(28);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new AfrCorruptError(`chunkSize ${chunkSize}`);
  }

  return {
    formatVersion,
    domain,
    headerLength,
    summaryLength,
    indexLength: Number(indexRaw),
    chunkSize,
  };
}

/** How many bytes a preview needs, given a preamble it has already read. */
export function previewLength(preamble: AfrPreamble): number {
  return PREAMBLE_BYTES + preamble.headerLength + HMAC_BYTES + preamble.summaryLength;
}

/* ── HEADER ───────────────────────────────────────────────────────────────── */

/** One wrapped DEK. `ct` is the 32-byte key plus its 16-byte GCM tag. */
export interface AfrKeyslot {
  alg: "AES-256-GCM";
  nonce: Buffer;
  ct: Buffer;
}

export interface AfrArgon2Params {
  /** Memory cost in KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Lanes. */
  p: number;
}

export interface AfrHeader {
  backupId: string;
  /** Epoch milliseconds. */
  createdAt: number;
  keyId: string;
  /** `[0]` opens with `BACKUP_MASTER_KEY`, `[1]` with the recovery phrase. */
  keyslot: readonly [AfrKeyslot, AfrKeyslot];
  phraseSalt: Buffer;
  argon2: AfrArgon2Params;
  /**
   * The eight random bytes every chunk nonce starts with (§5.3). It lives in the
   * header because a reader has to reconstruct the same nonces, and the header is
   * the only part of the file that is both plaintext and HMAC-covered.
   */
  chunkNoncePrefix: Buffer;
  summaryNonce: Buffer;
  indexNonce: Buffer;
}

const HEADER_KEYS = [
  "argon2",
  "backupId",
  "chunkNoncePrefix",
  "createdAt",
  "indexNonce",
  "keyId",
  "keyslot",
  "phraseSalt",
  "summaryNonce",
] as const;

const KEYSLOT_KEYS = ["alg", "ct", "nonce"] as const;
const ARGON2_KEYS = ["m", "p", "t"] as const;

/** 32 key bytes plus the 16-byte GCM tag — the exact width of `keyslot[i].ct`. */
export const KEYSLOT_CT_BYTES = KEY_BYTES + GCM_TAG_BYTES;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `keyId` reaches audit rows and internal logs, so it is held to a charset rather
 * than merely to a length: a "key id" carrying newlines would be a log-injection
 * primitive handed over by a file a stranger wrote.
 */
export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Roughly the year 9999 — a sanity bound, not a business rule. */
const MAX_CREATED_AT = 253_402_300_799_000;

/**
 * Argon2 bounds, and the reason they are not generous: these three numbers are
 * *executed* on the recovery path, on a 2 GB VPS, using values from a file the
 * server did not write. An archive asking for 64 GiB of memory cost would be a
 * one-line denial of service.
 */
const ARGON2_LIMITS = {
  m: { min: 8 * 1024, max: 512 * 1024 },
  t: { min: 1, max: 8 },
  p: { min: 1, max: 4 },
} as const;

function headerToCanonical(header: AfrHeader): CanonicalObject {
  return {
    argon2: { m: header.argon2.m, p: header.argon2.p, t: header.argon2.t },
    backupId: header.backupId,
    chunkNoncePrefix: header.chunkNoncePrefix,
    createdAt: header.createdAt,
    indexNonce: header.indexNonce,
    keyId: header.keyId,
    keyslot: header.keyslot.map((slot) => ({
      alg: slot.alg,
      ct: slot.ct,
      nonce: slot.nonce,
    })),
    phraseSalt: header.phraseSalt,
    summaryNonce: header.summaryNonce,
  };
}

export function encodeHeader(header: AfrHeader): Buffer {
  const bytes = canonicalBytes(headerToCanonical(header));
  if (bytes.length > MAX_HEADER_BYTES) {
    throw new AfrCorruptError(`header is ${bytes.length} bytes, cap ${MAX_HEADER_BYTES}`);
  }
  return bytes;
}

function decodeKeyslot(value: unknown, where: string): AfrKeyslot {
  const record = exactKeys(value, KEYSLOT_KEYS, where);
  if (record.alg !== "AES-256-GCM") {
    fail(`${where}.alg is not AES-256-GCM`);
  }
  return {
    alg: "AES-256-GCM",
    nonce: bytesField(record, "nonce", where, GCM_IV_BYTES),
    ct: bytesField(record, "ct", where, KEYSLOT_CT_BYTES),
  };
}

/**
 * Structural validation of the header, run **before** `HDR_HMAC` can be checked —
 * the `keyId` that names the verifying key is itself inside the header (§5.1). So
 * nothing here may trust a single field; it may only decide the shape is readable
 * enough to look a key up with. Authentication happens next, in `keys.ts`.
 */
export function decodeHeader(bytes: Buffer): AfrHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("header is not JSON");
  }

  const record = exactKeys(parsed, HEADER_KEYS, "header");
  const slots = record.keyslot;
  if (!Array.isArray(slots) || slots.length !== 2) {
    fail("header.keyslot is not a pair");
  }
  const argon2 = exactKeys(record.argon2, ARGON2_KEYS, "header.argon2");

  const header: AfrHeader = {
    backupId: stringField(record, "backupId", "header", UUID_RE),
    createdAt: intField(record, "createdAt", "header", 1, MAX_CREATED_AT),
    keyId: stringField(record, "keyId", "header", KEY_ID_RE),
    keyslot: [
      decodeKeyslot(slots[0], "header.keyslot[0]"),
      decodeKeyslot(slots[1], "header.keyslot[1]"),
    ],
    phraseSalt: bytesField(record, "phraseSalt", "header", KDF_SALT_BYTES),
    argon2: {
      m: intField(argon2, "m", "header.argon2", ARGON2_LIMITS.m.min, ARGON2_LIMITS.m.max),
      t: intField(argon2, "t", "header.argon2", ARGON2_LIMITS.t.min, ARGON2_LIMITS.t.max),
      p: intField(argon2, "p", "header.argon2", ARGON2_LIMITS.p.min, ARGON2_LIMITS.p.max),
    },
    chunkNoncePrefix: bytesField(record, "chunkNoncePrefix", "header", NONCE_PREFIX_BYTES),
    summaryNonce: bytesField(record, "summaryNonce", "header", GCM_IV_BYTES),
    indexNonce: bytesField(record, "indexNonce", "header", GCM_IV_BYTES),
  };

  // The header has to be *canonically* serialized, not merely parseable. `HDR_HMAC`
  // covers the raw bytes, so a sloppy writer would not break verification — it would
  // break the day someone re-derives the header from its parsed form and gets a
  // different 32 bytes. Cheaper to refuse the archive than to debug that.
  if (!canonicalBytes(headerToCanonical(header)).equals(bytes)) {
    fail("header is not canonically serialized");
  }
  return header;
}

/* ── HDR_HMAC ─────────────────────────────────────────────────────────────── */

/**
 * `HMAC-SHA256(BACKUP_MASTER_KEY, PREAMBLE ‖ HEADER)`, over the bytes as they were
 * read — never over a re-serialization of the parsed form.
 *
 * Authenticating the preamble together with the header is what makes the lengths
 * trustworthy: without it, an attacker could shrink `indexLength` and have a reader
 * silently stop halfway through the index while every GCM tag still verified.
 */
export function headerHmac(masterKey: Buffer, preamble: Buffer, header: Buffer): Buffer {
  return createHmac("sha256", masterKey).update(preamble).update(header).digest();
}

/** Constant-time, and false rather than throwing — the caller decides the refusal. */
export function verifyHeaderHmac(
  masterKey: Buffer,
  preamble: Buffer,
  header: Buffer,
  mac: Buffer
): boolean {
  const expected = headerHmac(masterKey, preamble, header);
  // `timingSafeEqual` throws on a length mismatch, which would leak by exception.
  return mac.length === expected.length && timingSafeEqual(mac, expected);
}

/* ── TRAILER ──────────────────────────────────────────────────────────────── */

/**
 * `chunkCount` is bounded by the nonce, not by policy: the counter is `u32BE`, so
 * index `2^32` has no nonce to be encrypted under.
 */
export const MAX_CHUNK_COUNT = 2 ** 32;

export interface AfrTrailer {
  /** How many chunks the reader must have consumed. Closes end-truncation (§5.3). */
  chunkCount: number;
  /** SHA-256 over the *plaintext* payload, in order. Closes per-chunk-valid-but-wrong-overall. */
  payloadSha256: Buffer;
  totalPlaintextBytes: number;
}

/**
 * Fixed 48 bytes, binary, not JSON — the trailer is the one structure a reader
 * locates by seeking backwards from the end of the file, and a variable-length JSON
 * blob with no length prefix cannot be found that way. Fixed-width is also
 * deterministic by construction, which is what the HMAC needs, and it keeps two u64
 * counters away from `JSON.parse`'s 2^53 ceiling.
 */
export function encodeTrailer(trailer: AfrTrailer): Buffer {
  if (trailer.payloadSha256.length !== 32) {
    throw new AfrCorruptError(`payloadSha256 is ${trailer.payloadSha256.length} bytes`);
  }
  const out = Buffer.alloc(TRAILER_BYTES);
  out.writeBigUInt64BE(BigInt(trailer.chunkCount), 0);
  trailer.payloadSha256.copy(out, 8);
  out.writeBigUInt64BE(BigInt(trailer.totalPlaintextBytes), 40);
  return out;
}

/**
 * `chunkSize` comes from the already-authenticated preamble, so the arithmetic below
 * is a real cross-check and not a comparison of two numbers the same attacker chose:
 * every chunk but the last is exactly `chunkSize` plaintext bytes, which pins
 * `totalPlaintextBytes` to a single interval per `chunkCount`. An archive claiming
 * 1,000 chunks and 12 bytes is refused here rather than after 999 useless reads.
 */
export function decodeTrailer(bytes: Buffer, chunkSize: number): AfrTrailer {
  if (bytes.length !== TRAILER_BYTES) {
    throw new AfrCorruptError(`trailer is ${bytes.length} bytes, needs ${TRAILER_BYTES}`);
  }

  const countRaw = bytes.readBigUInt64BE(0);
  if (countRaw > BigInt(MAX_CHUNK_COUNT)) {
    throw new AfrCorruptError(`chunkCount ${countRaw.toString()}`);
  }
  const totalRaw = bytes.readBigUInt64BE(40);
  if (totalRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AfrCorruptError(`totalPlaintextBytes ${totalRaw.toString()}`);
  }

  const chunkCount = Number(countRaw);
  const size = BigInt(chunkSize);
  // `BigInt(0)` rather than `0n`: the project targets ES2017, where the literal form
  // is a compile error.
  const lower = chunkCount === 0 ? BigInt(0) : size * BigInt(chunkCount - 1);
  const upper = size * countRaw;
  if (totalRaw > upper || (chunkCount > 0 && totalRaw <= lower)) {
    throw new AfrCorruptError(
      `${totalRaw.toString()} plaintext bytes cannot be ${chunkCount} chunks of ${chunkSize}`
    );
  }

  return {
    chunkCount,
    payloadSha256: Buffer.from(bytes.subarray(8, 40)),
    totalPlaintextBytes: Number(totalRaw),
  };
}

/**
 * `HMAC-SHA256(DEK, HDR_HMAC ‖ TRAILER)`.
 *
 * Keyed with the DEK and not the master key on purpose (§5.1): on the recovery path
 * the DEK came out of keyslot 1, so an instance with a different — or absent —
 * `BACKUP_MASTER_KEY` can still finish verifying the archive. Covering `HDR_HMAC`
 * binds the trailer to one specific header, so a trailer lifted from another archive
 * cannot be spliced onto this one.
 */
export function trailerHmac(dek: Buffer, headerMac: Buffer, trailer: Buffer): Buffer {
  return createHmac("sha256", dek).update(headerMac).update(trailer).digest();
}

export function verifyTrailerHmac(
  dek: Buffer,
  headerMac: Buffer,
  trailer: Buffer,
  mac: Buffer
): boolean {
  const expected = trailerHmac(dek, headerMac, trailer);
  return mac.length === expected.length && timingSafeEqual(mac, expected);
}

/* ── nonces and AAD ───────────────────────────────────────────────────────── */

/**
 * `prefix(8) ‖ u32BE(chunkIndex)` = 12 bytes (§5.3).
 *
 * A counter rather than fresh randomness per chunk: a reader has to reproduce the
 * exact nonce of chunk *i* while streaming, and 8 random bytes per archive already
 * make the (key, nonce) pair unique — which is the property GCM actually needs.
 */
export function chunkNonce(prefix: Buffer, chunkIndex: number): Buffer {
  if (prefix.length !== NONCE_PREFIX_BYTES) {
    throw new AfrCorruptError(`chunkNoncePrefix is ${prefix.length} bytes`);
  }
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_CHUNK_COUNT) {
    throw new AfrCorruptError(`chunkIndex ${chunkIndex}`);
  }
  const nonce = Buffer.alloc(NONCE_PREFIX_BYTES + NONCE_COUNTER_BYTES);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(chunkIndex, NONCE_PREFIX_BYTES);
  return nonce;
}

export interface AfrAadContext {
  backupId: string;
  domain: BackupDomain;
  formatVersion: number;
}

/**
 * What each chunk is bound to. `chunkIndex` appears here as well as in the nonce, so
 * two chunks cannot be swapped, replayed, or moved: the reader decrypting position 3
 * authenticates against `chunkIndex: 3` and a chunk that was written as 7 fails its
 * tag rather than being quietly accepted.
 */
export function chunkAad(context: AfrAadContext, chunkIndex: number): Buffer {
  return canonicalBytes({
    backupId: context.backupId,
    chunkIndex,
    domain: context.domain,
    formatVersion: context.formatVersion,
  });
}

/**
 * SUMMARY and INDEX are singletons, so they have no index to bind — `section` is what
 * keeps them apart. Without it, the two sections' AAD would be identical and a
 * SUMMARY ciphertext could be served in the INDEX's place with a valid tag.
 */
export function sectionAad(context: AfrAadContext, section: "summary" | "index"): Buffer {
  return canonicalBytes({
    backupId: context.backupId,
    domain: context.domain,
    formatVersion: context.formatVersion,
    section,
  });
}

/**
 * What each wrapped DEK is bound to.
 *
 * §5.1 gives `HDR_HMAC` the job of stopping a keyslot being lifted out of one archive
 * and pasted into another — and it does, on the master-key path. The recovery path
 * cannot check `HDR_HMAC` at all: it runs on an instance whose `BACKUP_MASTER_KEY` is
 * a different secret, or gone. So on exactly the path that matters most in a
 * disaster, that protection is absent unless the keyslot carries it itself.
 *
 * Binding the wrap to `backupId`, `domain` and `formatVersion` gives keyslot 1's own
 * GCM tag the same reach: edit any of those three in the header and the phrase stops
 * opening the file. `slot` keeps the two positions from being interchangeable, which
 * costs nothing and means "unwrap succeeded" implies "unwrapped the slot we asked for".
 */
export function keyslotAad(context: AfrAadContext, slot: 0 | 1): Buffer {
  return canonicalBytes({
    backupId: context.backupId,
    domain: context.domain,
    formatVersion: context.formatVersion,
    slot,
  });
}

/**
 * Every encrypted region in the file is `ct ‖ tag`, tag last and always 16 bytes.
 *
 * Stated once, here, because the alternative is each reader remembering the order —
 * and a reader that gets it backwards does not fail loudly, it fails as
 * "backup rusak" on a perfectly good archive.
 */
export function splitGcm(bytes: Buffer, where: string): { ct: Buffer; tag: Buffer } {
  if (bytes.length < GCM_TAG_BYTES) {
    throw new AfrCorruptError(`${where} is ${bytes.length} bytes, below one GCM tag`);
  }
  const boundary = bytes.length - GCM_TAG_BYTES;
  return {
    ct: Buffer.from(bytes.subarray(0, boundary)),
    tag: Buffer.from(bytes.subarray(boundary)),
  };
}
