import { hashRaw } from "@node-rs/argon2";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { normalizePassphrase } from "@backup/domain/passphrase";
import {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  KDF_MEMORY_KIB,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KDF_TIME_COST,
  KEY_BYTES,
} from "@backup/domain/types";
import {
  AccountRecoveryKeyUnreadableError,
  AccountBackupNotConfiguredError,
  AfrUnreadableError,
} from "./errors";
import {
  KEYSLOT_CT_BYTES,
  KEY_ID_RE,
  keyslotAad,
  verifyHeaderHmac,
  type AfrAadContext,
  type AfrArgon2Params,
  type AfrHeader,
  type AfrKeyslot,
} from "./format";

/**
 * The key hierarchy, and the only module allowed to touch key material.
 *
 * ```
 * BACKUP_MASTER_KEY (env, 32 bytes)        recovery phrase (9 words, in the user's head)
 *         │                                              │
 *         │                                   Argon2id(phrase, phraseSalt)
 *         │                                              │
 *         │                                     RWK (recovery wrapping key)
 *         │                                              │
 *  keyslot[0] = wrap(DEK)                        keyslot[1] = wrap(DEK)
 *         └──────────────────────┬───────────────────────┘
 *                                ▼
 *                    DEK (32 random bytes, per archive)
 *                                │
 *                AES-256-GCM over SUMMARY, INDEX, CHUNKS
 * ```
 *
 * Two independent paths to the same DEK, and that redundancy is the feature: an
 * archive whose only key lived on the server would die with the server, and an
 * archive whose only key lived in the user's memory would die with the note they
 * wrote it on. Every archive always carries both, so no archive depends on one.
 *
 * What this module never does: return a phrase, log a key, or try a key the header
 * did not name. The last one is not fussiness — blind-trying every key in the ring
 * against a stranger's file turns an unwrap into an oracle, and the timing of that
 * oracle is a search over the ring.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.
 */

/* ── BACKUP_MASTER_KEY ────────────────────────────────────────────────────── */

/** Its own secret, on purpose. §4.1: rotating `SESSION_SECRET` must stay harmless. */
export const MASTER_KEY_ENV = "BACKUP_MASTER_KEY";

/** Retired keys, comma- or whitespace-separated, each optionally `label:material`. */
export const PREVIOUS_KEYS_ENV = "BACKUP_MASTER_KEY_PREVIOUS";

/**
 * Only the two variables the ring reads, so a test can pass an object literal instead
 * of a whole `ProcessEnv` — the shape `shared/lib/security/app-secret.ts` established.
 */
export type MasterKeyEnv = Partial<
  Pick<NodeJS.ProcessEnv, typeof MASTER_KEY_ENV | typeof PREVIOUS_KEYS_ENV>
>;

export interface AfrMasterKey {
  /** Goes in every header this key signs, and into audit rows. Never secret. */
  keyId: string;
  key: Buffer;
}

export interface AfrKeyRing {
  active: AfrMasterKey;
  /** Retired keys. Consulted only when a header names one of them by `keyId`. */
  previous: readonly AfrMasterKey[];
}

/**
 * Below this many distinct byte values, a 32-byte "random" key is not random.
 *
 * Thirty-two draws from 256 values yield about 30 distinct ones on average, and the
 * chance of a genuine CSPRNG key landing under 16 is far below the chance of the
 * disk losing it. So this rejects `openssl rand`'s output essentially never, and
 * rejects `AAAA…`, `0000…`, and a repeated four-byte pattern every time.
 */
const MIN_DISTINCT_BYTES = 16;

const KEY_ID_LABEL = Buffer.from("afrbak-master-key-id:v1", "utf8");

/** How many hex characters of the digest name a key. 32 bits is plenty to tell a
 * handful of ring entries apart, and the digest is not a secret: `HDR_HMAC` already
 * lets anyone holding a candidate key confirm it. */
const KEY_ID_HEX = 8;

function distinctByteCount(key: Buffer): number {
  const seen = new Set<number>();
  for (const byte of key) seen.add(byte);
  return seen.size;
}

/** Catches every byte identical (delta 0) and counting sequences like `00 01 02 …`. */
function isArithmeticSequence(key: Buffer): boolean {
  const delta = (key[1] - key[0] + 256) % 256;
  for (let i = 2; i < key.length; i += 1) {
    if ((key[i] - key[i - 1] + 256) % 256 !== delta) return false;
  }
  return true;
}

/**
 * A 32-character password pasted where 32 random bytes belong. Printable ASCII
 * carries at most ~6.6 bits per byte and in practice far less, and a real key is
 * all-printable with probability about 2 × 10⁻¹⁴ — so this is a typo detector, not
 * a guess about the operator's intent.
 */
function isAllPrintableAscii(key: Buffer): boolean {
  for (const byte of key) {
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

function notConfigured(detail: string): never {
  throw new AccountBackupNotConfiguredError(detail);
}

/**
 * Decode one configured key.
 *
 * Hex is recognised by shape, because 64 hex characters are also valid base64 (of 48
 * different bytes) and a key silently decoded the wrong way is a key that works until
 * the day someone regenerates it from the same hex string. Anything else must be
 * base64 or base64url of exactly 32 bytes. Node's base64 decoder skips characters it
 * does not recognise, so the charset is checked first rather than trusting the length
 * of whatever came back.
 */
export function parseMasterKeyMaterial(text: string, where: string): Buffer {
  const trimmed = text.trim();
  if (!trimmed) notConfigured(`${where} is empty`);

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      notConfigured(`${where} is neither hex nor base64`);
    }
    key = Buffer.from(normalized, "base64");
  }

  if (key.length !== KEY_BYTES) {
    notConfigured(`${where} decodes to ${key.length} bytes, needs exactly ${KEY_BYTES}`);
  }
  // Every message below names the variable and the rule, never the value.
  if (isArithmeticSequence(key)) {
    notConfigured(`${where} is a constant or counting byte sequence, not a random key`);
  }
  if (distinctByteCount(key) < MIN_DISTINCT_BYTES) {
    notConfigured(`${where} has too few distinct bytes to be a random key`);
  }
  if (isAllPrintableAscii(key)) {
    notConfigured(
      `${where} looks like a typed password rather than 32 random bytes — ` +
        `generate it with \`openssl rand -base64 32\``
    );
  }
  return key;
}

/**
 * A key's name, derived from the key itself when the operator did not supply one.
 *
 * Derived rather than configured because a hand-written `keyId` has a failure mode
 * with no recovery: label two *different* keys `prod` on two instances and every
 * archive from one of them names a key that resolves to the wrong bytes. A digest
 * cannot collide by carelessness.
 */
export function deriveKeyId(key: Buffer): string {
  const digest = createHash("sha256").update(KEY_ID_LABEL).update(key).digest("hex");
  return `k${digest.slice(0, KEY_ID_HEX)}`;
}

/**
 * `label:material` or bare `material`. The split is on the first colon, which is
 * unambiguous because {@link KEY_ID_RE} has no colon in its charset and neither hex
 * nor base64 does.
 */
function parseRingEntry(entry: string, where: string): AfrMasterKey {
  const colon = entry.indexOf(":");
  if (colon < 0) {
    const key = parseMasterKeyMaterial(entry, where);
    return { keyId: deriveKeyId(key), key };
  }
  const label = entry.slice(0, colon).trim();
  if (!KEY_ID_RE.test(label)) {
    notConfigured(`${where} has a key label outside [A-Za-z0-9._-]{1,64}`);
  }
  return { keyId: label, key: parseMasterKeyMaterial(entry.slice(colon + 1), where) };
}

/**
 * The ring, from the environment. `env` is a parameter with a `process.env` default,
 * the pattern `shared/lib/security/app-secret.ts` established, so rotation can be
 * tested with an object literal instead of by mutating the process.
 *
 * Absent `BACKUP_MASTER_KEY` is not an error here — it is the feature being off, and
 * {@link AccountBackupNotConfiguredError} is a 503 saying which variable to set.
 */
export function parseMasterKeyRing(
  // `ProcessEnv` supplies these two through its index signature rather than as declared
  // properties, so the assertion is what lets the parameter stay a two-key type that a
  // test can satisfy with a plain object literal.
  env: MasterKeyEnv = process.env as MasterKeyEnv
): AfrKeyRing {
  const configured = (env[MASTER_KEY_ENV] ?? "").trim();
  if (!configured) notConfigured(`${MASTER_KEY_ENV} is not set`);

  const active = parseRingEntry(configured, MASTER_KEY_ENV);
  const previous = (env[PREVIOUS_KEYS_ENV] ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseRingEntry(entry, PREVIOUS_KEYS_ENV));

  const seen = new Set<string>([active.keyId]);
  for (const key of previous) {
    if (seen.has(key.keyId)) {
      // Two entries answering to one name means a header naming it resolves to
      // whichever we happened to check first. Refuse rather than pick.
      notConfigured(`${PREVIOUS_KEYS_ENV} repeats the key id ${key.keyId}`);
    }
    seen.add(key.keyId);
  }
  return { active, previous };
}

/**
 * The one key a header is allowed to be checked against, or `null`.
 *
 * §5.1, spelled as code: the `keyId` comes from the header being examined and only
 * that key is ever used. `null` means the archive was written by an instance whose
 * key this server has never held — which on the disaster path is the *expected*
 * answer, not a failure, because keyslot 1 does not need it.
 */
export function resolveMasterKey(ring: AfrKeyRing, keyId: string): AfrMasterKey | null {
  if (ring.active.keyId === keyId) return ring.active;
  return ring.previous.find((candidate) => candidate.keyId === keyId) ?? null;
}

/* ── DEK and keyslots ─────────────────────────────────────────────────────── */

/** One per archive, so two archives of the same account share no key material. */
export function newDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * A fresh Argon2id salt for a keyslot-1 phrase.
 *
 * Per **archive** since per-file phrases (§4.3). The export path no longer calls this at all —
 * `domain/per-file-phrase.ts` derives the salt from `BACKUP_MASTER_KEY` and the download's
 * `ticketId` so that `prepare` and the download agree without storing anything. It stays because
 * the salt is still a per-archive value in the format, and tests build archives with it.
 */
export function newPhraseSalt(): Buffer {
  return randomBytes(KDF_SALT_BYTES);
}

/** The Argon2id cost written into every header, from `domain/kek.ts`'s numbers. */
export const AFR_ARGON2: AfrArgon2Params = {
  m: KDF_MEMORY_KIB,
  t: KDF_TIME_COST,
  p: KDF_PARALLELISM,
};

/**
 * Wrap the DEK for one slot.
 *
 * The AAD ties the slot to the archive it belongs to and to its own position, so a
 * keyslot cannot be lifted out of another file — see {@link keyslotAad} for why that
 * matters specifically on the recovery path.
 */
export function wrapDek(
  wrappingKey: Buffer,
  dek: Buffer,
  context: AfrAadContext,
  slot: 0 | 1
): AfrKeyslot {
  const nonce = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(keyslotAad(context, slot));
  const ct = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return { alg: "AES-256-GCM", nonce, ct };
}

/**
 * The inverse, returning `null` instead of throwing.
 *
 * A dead slot is not by itself a refusal — the whole design is that slot 0 failing is
 * routine on a rebuilt instance and slot 1 is there to catch it. Only *both* failing
 * is refusal #4, so the decision belongs to {@link openDek}, which can see both.
 */
export function unwrapDek(
  wrappingKey: Buffer,
  keyslot: AfrKeyslot,
  context: AfrAadContext,
  slot: 0 | 1
): Buffer | null {
  if (keyslot.ct.length !== KEYSLOT_CT_BYTES) return null;
  const boundary = keyslot.ct.length - GCM_TAG_BYTES;
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, keyslot.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(keyslotAad(context, slot));
    decipher.setAuthTag(keyslot.ct.subarray(boundary));
    const dek = Buffer.concat([
      decipher.update(keyslot.ct.subarray(0, boundary)),
      decipher.final(),
    ]);
    return dek.length === KEY_BYTES ? dek : null;
  } catch {
    // A wrong key and an edited keyslot are the same event at the GCM tag, and
    // telling them apart is precisely the oracle §12 refuses to hand out.
    return null;
  }
}

/* ── the recovery phrase ──────────────────────────────────────────────────── */

/**
 * Phrase → RWK. Argon2id, with the cost from the archive's own header.
 *
 * The phrase is normalized exactly as `domain/passphrase.ts` normalizes it, and that
 * identity is the contract: the user retypes nine words from a note, and a double
 * space must not be the reason a restore fails.
 *
 * Never the AES key itself (§4.3) — a KDF output is, and the layer between them is
 * what makes the ~1 s per guess non-optional rather than a check someone can patch
 * out of a copy of this source.
 */
export async function deriveRecoveryWrappingKey(
  phrase: string,
  phraseSalt: Buffer,
  params: AfrArgon2Params = AFR_ARGON2
): Promise<Buffer> {
  if (phraseSalt.length !== KDF_SALT_BYTES) {
    throw new AfrUnreadableError(4, `phraseSalt is ${phraseSalt.length} bytes`);
  }
  return hashRaw(normalizePassphrase(phrase), {
    memoryCost: params.m,
    timeCost: params.t,
    parallelism: params.p,
    outputLen: KEY_BYTES,
    salt: phraseSalt,
  });
}

/* ── the RWK at rest ──────────────────────────────────────────────────────── */

/**
 * `afr1:<iv>:<tag>:<ct>`, all base64.
 *
 * The version prefix is not decoration. This value shares the `backup_keys` table
 * with the whole-instance backup's KEK, which is sealed under `SESSION_SECRET` and
 * spelled `v1:…`; the two are sealed under different secrets and must never be fed
 * to each other's opener. The rows are already kept apart by their `owner_key`
 * namespace, and this makes a mix-up fail loudly instead of quietly.
 */
const RWK_SEAL_VERSION = "afr1";

/**
 * Binds the sealed key to the account it belongs to.
 *
 * Without it, someone with write access to the database could move account A's
 * sealed RWK into account B's row, and every archive B exported afterwards would
 * open with A's recovery phrase.
 */
function rwkSealAad(ownerKey: string): Buffer {
  return Buffer.from(`afrbak-rwk-at-rest:v1:${ownerKey}`, "utf8");
}

/**
 * Seal the RWK so an unattended export can fill keyslot 1 without the phrase.
 *
 * This is the whole reason the server keeps anything at all: at export time nobody
 * has typed nine words, and an archive written without keyslot 1 would be an archive
 * that dies with the server. What the server holds is only the *wrapping* key — the
 * phrase itself is nowhere, which is why §4.3 can promise the recovery path is
 * genuinely independent and why the phrase can never be shown a second time.
 */
export function sealRecoveryKey(masterKey: Buffer, rwk: Buffer, ownerKey: string): string {
  if (rwk.length !== KEY_BYTES) {
    throw new AccountRecoveryKeyUnreadableError(`rwk is ${rwk.length} bytes`);
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(rwkSealAad(ownerKey));
  const ct = Buffer.concat([cipher.update(rwk), cipher.final()]);
  return [
    RWK_SEAL_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ct.toString("base64"),
  ].join(":");
}

export interface OpenedRecoveryKey {
  rwk: Buffer;
  /** Which ring entry opened it. */
  keyId: string;
  /** True when a retired key opened it — the caller should re-seal under the active one. */
  stale: boolean;
}

function openSealedUnder(masterKey: Buffer, parts: string[], ownerKey: string): Buffer | null {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKey,
      Buffer.from(parts[1], "base64"),
      { authTagLength: GCM_TAG_BYTES }
    );
    decipher.setAAD(rwkSealAad(ownerKey));
    decipher.setAuthTag(Buffer.from(parts[2], "base64"));
    const rwk = Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64")),
      decipher.final(),
    ]);
    return rwk.length === KEY_BYTES ? rwk : null;
  } catch {
    return null;
  }
}

/**
 * Open the account's sealed RWK, trying the whole ring.
 *
 * Trying every key here does **not** contradict the never-blind-try rule that governs
 * archive keyslots. That rule exists because an archive is a file a stranger wrote, so
 * each attempt against it is an oracle they can time. This value is a row this server
 * wrote, in its own database, with no attacker-chosen bytes and no `keyId` column to
 * name a key with — so walking the ring is the only way a master-key rotation does not
 * silently break every account's exports, and the walk reveals nothing to anyone.
 *
 * `stale` is how rotation finishes itself: the caller re-seals under the active key,
 * and the old key stops being load-bearing for future exports.
 */
export function openRecoveryKey(
  ring: AfrKeyRing,
  sealed: string,
  ownerKey: string
): OpenedRecoveryKey {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== RWK_SEAL_VERSION) {
    throw new AccountRecoveryKeyUnreadableError(
      `sealed rwk is not ${RWK_SEAL_VERSION} with four fields`
    );
  }
  for (const candidate of [ring.active, ...ring.previous]) {
    const rwk = openSealedUnder(candidate.key, parts, ownerKey);
    if (rwk) {
      return { rwk, keyId: candidate.keyId, stale: candidate.keyId !== ring.active.keyId };
    }
  }
  throw new AccountRecoveryKeyUnreadableError(
    `no key in the ring opens the sealed rwk for ${ownerKey}`
  );
}

/* ── opening an archive ───────────────────────────────────────────────────── */

export interface OpenDekInput {
  header: AfrHeader;
  /** The 32 plaintext preamble bytes, exactly as they arrived. */
  preamble: Buffer;
  /** The header bytes, byte for byte — `HDR_HMAC` covers these, not a re-encoding. */
  headerBytes: Buffer;
  /** The 32 bytes that followed the header. */
  headerMac: Buffer;
  context: AfrAadContext;
  ring: AfrKeyRing;
  /** Typed by the caller. Absent on the ordinary path; required by the disaster path. */
  phrase?: string;
}

export interface OpenedDek {
  dek: Buffer;
  /** Which slot opened it. `phrase` is what §3.2 requires before an identity is adopted. */
  via: "master" | "phrase";
  /** The header's `keyId`, whether or not this server holds it. Audit records both. */
  keyId: string;
  /** True when a retired key opened it — worth surfacing in the rotation audit. */
  stale: boolean;
}

/** What keyslot 0 has to say, without deciding anything on its own. */
type MasterSlotResult =
  | { ok: true; dek: Buffer; keyId: string; stale: boolean }
  | { ok: false; reason: 3 | 4; detail: string };

/**
 * Keyslot 0, tried once.
 *
 * ```
 * keyId in ring?  ──no──▶ slot 0 unusable (reason 3)
 *        │yes
 * HDR_HMAC ok?    ──no──▶ slot 0 unusable (reason 3)
 *        │yes
 * unwrap slot 0   ──no──▶ slot 0 dead     (reason 4)
 *        │yes
 *      DEK, via master
 * ```
 *
 * The distinction between reason 3 and reason 4 never reaches the caller — both carry the
 * one generic message of §12. It exists so an operator reading `activity_logs` can tell
 * "an archive from an instance whose key is gone" from "a wrong phrase".
 */
function tryMasterSlot(input: OpenDekInput): MasterSlotResult {
  const { context, header, ring } = input;
  const master = resolveMasterKey(ring, header.keyId);

  if (!master) {
    return { ok: false, reason: 3, detail: `keyId ${header.keyId} is not in this server's ring` };
  }
  if (!verifyHeaderHmac(master.key, input.preamble, input.headerBytes, input.headerMac)) {
    return { ok: false, reason: 3, detail: `HDR_HMAC does not verify under keyId ${header.keyId}` };
  }
  const dek = unwrapDek(master.key, header.keyslot[0], context, 0);
  if (!dek) {
    return {
      ok: false,
      reason: 4,
      detail: `keyslot 0 did not authenticate under keyId ${header.keyId}`,
    };
  }
  return { ok: true, dek, keyId: header.keyId, stale: master.keyId !== ring.active.keyId };
}

/**
 * Which keyslot opens this archive — and therefore, one level up, whether an unbound
 * `accountBackupId` may be adopted (§3.2).
 *
 * **A typed phrase decides; keyslot 0 is not consulted.** That is §3.2 rule 2 read literally
 * — *"tidak cocok → wajib mengetikkan recovery phrase; kalau keyslot 1 terbuka, adopt"* — and
 * it is the only order under which the disaster path is reachable at all:
 *
 *   - `assertOwnership` adopts an id that no row binds only when `via === "phrase"`, because a
 *     server holding `BACKUP_MASTER_KEY` must not be able to pull another account's archive
 *     into its own (§3.3). Trying keyslot 0 first answers `via: "master"` on a rebuilt instance
 *     whose `.env` survived — exactly the shape of acceptance test #7 — so the phrase the user
 *     correctly typed would be ignored and the restore refused as #6.
 *   - A mistyped phrase that quietly succeeded through keyslot 0 would teach an account that
 *     its phrase works. It would find out otherwise on the one day the master key is gone,
 *     which is the only day the phrase was ever for.
 *
 * With no phrase, keyslot 0 is the whole story and its failure is refusal #3 or #4.
 */
export async function openDek(input: OpenDekInput): Promise<OpenedDek> {
  const { context, header } = input;

  if (input.phrase === undefined) {
    const slot0 = tryMasterSlot(input);
    if (slot0.ok) {
      return { dek: slot0.dek, via: "master", keyId: slot0.keyId, stale: slot0.stale };
    }
    throw new AfrUnreadableError(slot0.reason, `${slot0.detail}; no recovery phrase supplied`);
  }

  const rwk = await deriveRecoveryWrappingKey(input.phrase, header.phraseSalt, header.argon2);
  const dek = unwrapDek(rwk, header.keyslot[1], context, 1);
  // The RWK's job is over in microseconds; leaving it in a live buffer for the rest of
  // the request is free risk in a heap dump.
  rwk.fill(0);
  if (dek) {
    return { dek, via: "phrase", keyId: header.keyId, stale: false };
  }

  // The phrase did not open keyslot 1. Whether keyslot 0 *would* have opened is not a second
  // chance — it is the one line that lets an operator tell "a wrong phrase on an archive this
  // server could otherwise read" from "a wrong phrase on an archive nothing here can read".
  const slot0 = tryMasterSlot(input);
  if (slot0.ok) {
    slot0.dek.fill(0);
    throw new AfrUnreadableError(4, "keyslot 1 did not authenticate; keyslot 0 would have");
  }
  throw new AfrUnreadableError(4, `keyslot 1 did not authenticate; ${slot0.detail}`);
}
