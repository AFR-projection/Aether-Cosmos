/**
 * The constants the `.afrbak` container is built from.
 *
 * What is left of a larger module. The whole-instance `.acbak` format — its magic
 * bytes, manifest, trailer and part records — went with the feature that wrote it;
 * `account/domain/format.ts` owns the container that replaced it and spells its own
 * layout. These are the values both would have shared anyway: AES-GCM and HMAC-SHA256
 * field widths, and the Argon2id cost.
 *
 * They live here rather than in the account feature because a number that describes
 * cryptography should be stated once. `GCM_TAG_BYTES` appearing as a literal `16` in
 * two files is how a reader ends up trimming the wrong number of bytes.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4, §5.
 */

/**
 * The two halves of the product, backed up and restored independently. Never a
 * union with a third "everything" member: a combined artifact is the thing this
 * design exists to avoid.
 */
export type BackupDomain = "brain" | "files";

/* ── Field widths ─────────────────────────────────────────────────────────── */

export const GCM_TAG_BYTES = 16;
export const GCM_IV_BYTES = 12;
export const KEY_BYTES = 32;
export const HMAC_BYTES = 32;

/* ── Argon2id ─────────────────────────────────────────────────────────────── */

/**
 * 256 MiB is affordable on a 2 GB box because it runs exactly twice in an archive's
 * life: once when the recovery phrase is minted, once when someone opens an archive
 * *with* that phrase. A routine takeout derives nothing — keyslot 0 unwraps the DEK
 * with `BACKUP_MASTER_KEY` — so the cost is paid by an attacker guessing phrases and
 * by nobody else.
 */
export const KDF_MEMORY_KIB = 256 * 1024;
export const KDF_TIME_COST = 4;
export const KDF_PARALLELISM = 1;
export const KDF_SALT_BYTES = 16;
