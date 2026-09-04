import { BackupValidationError } from "./errors";

/**
 * What survives of the whole-instance feature's naming: two functions, two consumers.
 *
 * The rest of this module — R2 key prefixes, part names, manifest keys, download
 * filenames, the header note — went with the feature that wrote to `backups/`. The
 * per-account artifact is streamed, never staged, so there is no object key to build
 * and nothing to list.
 *
 *   * {@link compactTimestamp} is used by `account/application/export.ts` to date an
 *     `.afrbak` filename. UTC, for the reason its own comment gives.
 *   * {@link parseOwnerKey} is the *legacy* owner-key parser, kept as an executable
 *     statement of one property: it refuses `afrbak:user:<uuid>`. `backup_keys` now
 *     holds both namespaces — the old feature's `system` / `user:<uuid>` rows, inert
 *     but not deleted, and the per-account rows at `afrbak:user:<uuid>` — and the two
 *     cannot be confused for each other. `tests/backup-account-identity.test.ts`
 *     asserts exactly that; `account/domain/identity.ts` explains why it matters.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.3.
 */

/** The old feature's whole-instance owner key. No code writes it any more. */
export const SYSTEM_OWNER_KEY = "system";

export interface OwnerIdentity {
  ownerKey: string;
  scope: "system" | "user";
  userId: string | null;
}

/**
 * `system` or `user:<uuid>`, and nothing else.
 *
 * Text rather than a nullable `user_id` because it was a primary key: `('system',
 * 'brain')` had to be one row, and a NULL in a unique index is not equal to itself.
 * The strictness is now the point — a per-account key is `afrbak:`-prefixed and this
 * throws on it.
 */
export function parseOwnerKey(ownerKey: string): OwnerIdentity {
  if (ownerKey === SYSTEM_OWNER_KEY) {
    return { ownerKey, scope: "system", userId: null };
  }
  const match = /^user:([0-9a-f-]{36})$/i.exec(ownerKey);
  if (!match) {
    throw new BackupValidationError(`Unrecognised backup owner "${ownerKey}".`);
  }
  return { ownerKey, scope: "user", userId: match[1] };
}

/**
 * `20260902-0314` in UTC.
 *
 * UTC and not the viewer's zone: two people comparing filenames over a call must be
 * comparing the same instant, and a backup taken at 03:00 UTC that lands in a filename
 * as the previous day is how the wrong artifact gets restored.
 */
export function compactTimestamp(when: Date | string): string {
  const iso = (typeof when === "string" ? new Date(when) : when).toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!match) {
    throw new BackupValidationError("Backup timestamp is not a valid date.");
  }
  const [, year, month, day, hour, minute] = match;
  return `${year}${month}${day}-${hour}${minute}`;
}
