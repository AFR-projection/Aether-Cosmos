/**
 * The one row this feature keeps per account — and the rule that it is not authority.
 *
 * `domain/keys.ts`, `domain/identity.ts` and `domain/per-file-phrase.ts` are pure: they mint ids
 * and derive keys, and none of them has ever heard of a database. This is the half that persists
 * what they produce, and there is exactly one table:
 *
 *   - `account_backup_identities` — which `accountBackupId` values the account answers to. One
 *     `generated` row, minted lazily on the first export, plus one `adopted` row per dead
 *     instance whose archives this account has reclaimed with a typed recovery phrase.
 *
 * **No key material is stored at all.** An earlier shape kept a sealed recovery-wrapping key per
 * account in `backup_keys`, because one phrase had to open every archive the account would ever
 * write and therefore had to survive between downloads. Per-file phrases removed the reason:
 * `domain/per-file-phrase.ts` derives this archive's words from `BACKUP_MASTER_KEY` and the
 * download ticket, so there is nothing left to store, nothing to rotate, and no row that can
 * become unopenable when the master key changes. `backup_keys` still exists in the schema and
 * still holds whatever the removed whole-instance feature left in it; nothing in this feature
 * reads or writes it.
 *
 * **What is deliberately not here.** Nothing in this file authorizes anything. The identity rows
 * are an anti-misrouting check (§10): they decide whether an archive belongs to the account that
 * is *already* authenticated, and a mismatch asks for a recovery phrase rather than granting
 * anything.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.3, §10, §15.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/shared/infrastructure/db";
import { accountBackupIdentities } from "@/shared/infrastructure/db/schema";
import {
  newAccountBackupId,
  normalizeAccountBackupId,
  type AccountIdentitySource,
} from "@backup/account/domain/identity";

/** One row of `account_backup_identities`, as every caller wants to see it. */
export interface BoundIdentity {
  accountBackupId: string;
  source: AccountIdentitySource;
  boundAt: Date;
}

/* ── identities ───────────────────────────────────────────────────────────── */

/** Every id this account answers to, `generated` first. */
export async function listBoundIdentities(userId: string): Promise<BoundIdentity[]> {
  const rows = await db
    .select({
      accountBackupId: accountBackupIdentities.accountBackupId,
      source: accountBackupIdentities.source,
      boundAt: accountBackupIdentities.boundAt,
    })
    .from(accountBackupIdentities)
    .where(eq(accountBackupIdentities.userId, userId));

  return rows
    .map((row) => ({
      accountBackupId: row.accountBackupId,
      source: row.source === "adopted" ? ("adopted" as const) : ("generated" as const),
      boundAt: row.boundAt,
    }))
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === "generated" ? -1 : 1;
      return a.boundAt.getTime() - b.boundAt.getTime();
    });
}

/**
 * The id this instance minted for the account, creating it on first use.
 *
 * `onConflictDoNothing` then re-read, rather than a read-then-insert: two exports clicked at
 * once would both see no row, and the partial unique index on `source = 'generated'` is what
 * makes the loser's insert a no-op instead of a second identity. A second identity would be the
 * quiet kind of disaster — half the account's archives bound to an id the other half rejects.
 */
export async function ensureGeneratedIdentity(userId: string): Promise<string> {
  const existing = await db
    .select({ accountBackupId: accountBackupIdentities.accountBackupId })
    .from(accountBackupIdentities)
    .where(
      and(
        eq(accountBackupIdentities.userId, userId),
        eq(accountBackupIdentities.source, "generated")
      )
    )
    .limit(1);
  if (existing[0] !== undefined) return existing[0].accountBackupId;

  await db
    .insert(accountBackupIdentities)
    .values({ userId, accountBackupId: newAccountBackupId(), source: "generated" })
    .onConflictDoNothing();

  const [row] = await db
    .select({ accountBackupId: accountBackupIdentities.accountBackupId })
    .from(accountBackupIdentities)
    .where(
      and(
        eq(accountBackupIdentities.userId, userId),
        eq(accountBackupIdentities.source, "generated")
      )
    )
    .limit(1);
  if (row === undefined) {
    throw new Error("account backup identity could not be created");
  }
  return row.accountBackupId;
}

/**
 * Bind an id this account has proven it owns.
 *
 * "Proven" means one thing only, and the caller is the one that must have established it: the
 * archive's keyslot 1 opened under a phrase the user typed. The server's own sealed RWK must
 * never satisfy that gate — it would let anyone with a stolen `.afrbak` and any account on this
 * instance adopt somebody else's archive, which is exactly the attack §10 names.
 *
 * Idempotent, and never touches the `generated` row: adopting the same dead instance's id twice
 * is a user clicking twice, not an error worth a message.
 */
export async function adoptIdentity(userId: string, accountBackupId: string): Promise<void> {
  await db
    .insert(accountBackupIdentities)
    .values({
      userId,
      accountBackupId: normalizeAccountBackupId(accountBackupId),
      source: "adopted",
    })
    .onConflictDoNothing();
}

/* ── what `/backup` draws itself from ─────────────────────────────────────── */

/** What `GET /api/backup/identity` answers with, and what the export card shows. */
export interface AccountBackupIdentityStatus {
  /** Canonical 52 characters. The display form is the UI's business. */
  accountBackupId: string;
  /** One row per dead instance whose archives this account has reclaimed. Usually empty. */
  adopted: BoundIdentity[];
}

/**
 * The identity card — two reads and nothing else.
 *
 * There is deliberately no `hasRecoveryPhrase` and no `recoveryPhraseUsable` any more. Both were
 * answers to a question that no longer exists: when one phrase per account was sealed in
 * `backup_keys`, the card had to say whether that row still opened, because a replaced
 * `BACKUP_MASTER_KEY` turned it into a healthy-looking row that failed only at export time.
 * Per-file phrases have no row to be unusable — every download derives its own words from the
 * *current* master key, so the only thing that can go wrong is `BACKUP_MASTER_KEY` being absent,
 * which `prepare` reports as `AFRBAK_NOT_CONFIGURED` at the moment it matters.
 */
export async function readIdentityStatus(userId: string): Promise<AccountBackupIdentityStatus> {
  const [accountBackupId, bound] = await Promise.all([
    ensureGeneratedIdentity(userId),
    listBoundIdentities(userId),
  ]);

  return {
    accountBackupId,
    adopted: bound.filter((row) => row.source === "adopted"),
  };
}
