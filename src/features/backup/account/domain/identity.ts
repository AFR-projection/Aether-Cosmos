import { randomBytes } from "node:crypto";
import { AfrCorruptError } from "./errors";

/**
 * Who an archive belongs to, in a form that outlives the database.
 *
 * `users.id` cannot answer this question. A rebuilt database hands every account a new
 * UUID, so an archive that names one is an archive addressed to a person who no longer
 * exists. Email cannot answer it either: it is editable on the settings page, and a
 * cryptographic identity that a user can change with a form submission is not an
 * identity. So the root is 32 random bytes minted once per account, carried inside the
 * archive's ENCRYPTED summary, and never derived from anything the database owns.
 *
 * Base32 rather than hex or base64 because a human reads this one out loud. Crockford's
 * alphabet drops `I`, `L`, `O` and `U`, and folds the first three onto `1`, `1` and `0`
 * when reading, so "was that a one or an ell" stops being a support ticket.
 *
 * Two representations, and only two:
 *
 *   canonical — 52 characters, no separators, uppercase. What the database stores, what
 *               the summary carries, what equality is ever tested on.
 *   display   — `AFR-7K2M-9QX4-…`, the canonical form in groups of four behind a prefix
 *               that says which application wrote it. Presentation only.
 *
 * Keeping separators out of the canonical form is what makes `=` a safe comparison: an
 * identity that could be spelled two ways is an identity that fails to match itself.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §3.
 */

/** 256 bits. The same width as a key, for the same reason: it must never collide. */
export const ACCOUNT_BACKUP_ID_BYTES = 32;

/** `ceil(256 / 5)`. The 52nd character carries one data bit and four zero bits. */
export const ACCOUNT_BACKUP_ID_CHARS = 52;

/** Crockford base32, in order, so an index into it is a five-bit value. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The canonical spelling: 52 of the 32 permitted characters, uppercase, unseparated. */
export const ACCOUNT_BACKUP_ID_RE = /^[0-9A-HJKMNP-TV-Z]{52}$/;

/** What the prefix in the display form says, and what it is not part of. */
export const ACCOUNT_BACKUP_ID_PREFIX = "AFR";

function corrupt(detail: string): never {
  // Reached only from *decrypted* summary bytes, so being specific leaks nothing: GCM
  // already proved whoever wrote this held the DEK. A value that is nonsense at that
  // point means the archive is damaged, which is exactly refusal #7.
  throw new AfrCorruptError(detail);
}

/**
 * 32 bytes → 52 characters.
 *
 * The accumulator never holds more than twelve bits, so the shifts stay inside the
 * 32-bit range JavaScript's bitwise operators work in.
 */
export function encodeAccountBackupId(bytes: Buffer): string {
  if (bytes.length !== ACCOUNT_BACKUP_ID_BYTES) {
    corrupt(`accountBackupId is ${bytes.length} bytes, needs ${ACCOUNT_BACKUP_ID_BYTES}`);
  }
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * The canonical spelling of whatever the caller has, or `null`.
 *
 * Accepts the display form, lowercase, extra dashes, spaces a copy-paste dragged in,
 * and the four confusable letters — then insists the result is canonical, because the
 * *text* is the identity and two spellings of one identity is a bug waiting for a
 * support call. Non-throwing on purpose: the caller here is often a human typing.
 */
export function tryNormalizeAccountBackupId(input: string): string | null {
  const bare = input
    .trim()
    .toUpperCase()
    .replace(new RegExp(`^${ACCOUNT_BACKUP_ID_PREFIX}[-\\s]*`), "")
    .replace(/[\s_-]+/g, "")
    .replace(/[OIL]/g, (letter) => (letter === "O" ? "0" : "1"));

  if (!ACCOUNT_BACKUP_ID_RE.test(bare)) return null;
  // 256 bits do not fill 52 characters: the last four bits are padding and must be
  // zero, or one identity would have two valid spellings.
  if ((ALPHABET.indexOf(bare[bare.length - 1]) & 0x0f) !== 0) return null;
  return bare;
}

/** The same, for the archive path, where a bad value is a damaged file and not a typo. */
export function normalizeAccountBackupId(input: string): string {
  const canonical = tryNormalizeAccountBackupId(input);
  if (!canonical) corrupt("accountBackupId is not 52 canonical base32 characters");
  return canonical;
}

/** 52 characters → the 32 bytes they encode. */
export function decodeAccountBackupId(text: string): Buffer {
  const canonical = normalizeAccountBackupId(text);
  const out = Buffer.alloc(ACCOUNT_BACKUP_ID_BYTES);
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (const character of canonical) {
    acc = (acc << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (acc >>> bits) & 0xff;
      index += 1;
    }
  }
  return out;
}

/** A new identity. Called exactly once per account, for the one `generated` row. */
export function newAccountBackupId(): string {
  return encodeAccountBackupId(randomBytes(ACCOUNT_BACKUP_ID_BYTES));
}

/** `AFR-7K2M-9QX4-…` in full — thirteen groups of four. */
export function formatAccountBackupId(id: string): string {
  const canonical = normalizeAccountBackupId(id);
  const groups = canonical.match(/.{4}/g) ?? [];
  return [ACCOUNT_BACKUP_ID_PREFIX, ...groups].join("-");
}

/**
 * The first two groups and an ellipsis, for a table cell or a preview line.
 *
 * Enough for a person to recognise their own account at a glance, and deliberately not
 * enough to retype: the full value belongs on the recovery page, next to the phrase,
 * where the user is being told to write something down.
 */
export function shortAccountBackupId(id: string): string {
  const canonical = normalizeAccountBackupId(id);
  return `${ACCOUNT_BACKUP_ID_PREFIX}-${canonical.slice(0, 4)}-${canonical.slice(4, 8)}…`;
}

/* ── the owner-key namespace ──────────────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why this is not `user:<uuid>`.
 *
 * `backup_keys.owner_key` is a primary key shared with the whole-instance backup, whose
 * own per-user rows would be spelled `user:<uuid>` if `USER_SCOPE_ENABLED` in
 * `application/owner.ts` were ever flipped on. Two features writing different secrets —
 * one sealed under `SESSION_SECRET`, one under `BACKUP_MASTER_KEY` — into one primary
 * key would be a collision that only appears the day someone turns that flag on, and
 * would look like "the recovery phrase stopped working" rather than like a bug.
 *
 * A distinct prefix costs one string and makes the two namespaces disjoint by
 * construction. `parseOwnerKey` in `domain/naming.ts` refuses this shape outright, which
 * is the behaviour we want: the system backup's repository will throw rather than
 * silently claim an account-backup row.
 */
export const ACCOUNT_OWNER_PREFIX = "afrbak:user:";

export function accountOwnerKey(userId: string): string {
  if (!UUID_RE.test(userId)) {
    corrupt(`account owner key needs a uuid, got ${userId.length} characters`);
  }
  return `${ACCOUNT_OWNER_PREFIX}${userId.toLowerCase()}`;
}

/** The user id inside an account owner key, or `null` if it is some other namespace. */
export function parseAccountOwnerKey(ownerKey: string): string | null {
  if (!ownerKey.startsWith(ACCOUNT_OWNER_PREFIX)) return null;
  const userId = ownerKey.slice(ACCOUNT_OWNER_PREFIX.length);
  return UUID_RE.test(userId) ? userId.toLowerCase() : null;
}

/* ── bound identities ─────────────────────────────────────────────────────── */

/**
 * `generated` is this instance's own id for the account — exactly one row, enforced by
 * a partial unique index. `adopted` rows are ids from other instances that the account
 * has proved it owns by typing the recovery phrase (§3.2).
 */
export const ACCOUNT_IDENTITY_SOURCES = ["generated", "adopted"] as const;

export type AccountIdentitySource = (typeof ACCOUNT_IDENTITY_SOURCES)[number];

export function isAccountIdentitySource(value: string): value is AccountIdentitySource {
  return (ACCOUNT_IDENTITY_SOURCES as readonly string[]).includes(value);
}

/**
 * Does this archive already belong to the caller?
 *
 * A plain string comparison, and deliberately not a constant-time one. The bound ids
 * come from a `WHERE user_id = $1` query whose own index lookup is not constant time
 * either, so a timing-safe compare here would buy nothing and imply a guarantee the
 * layer below cannot keep. What makes a wrong answer safe is what happens next: a miss
 * demands a typed recovery phrase, and that is a GCM tag rather than a comparison.
 */
export function isBoundIdentity(
  archiveId: string,
  bound: readonly { accountBackupId: string }[]
): boolean {
  const canonical = normalizeAccountBackupId(archiveId);
  return bound.some((row) => tryNormalizeAccountBackupId(row.accountBackupId) === canonical);
}
