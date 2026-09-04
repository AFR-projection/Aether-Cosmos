-- ROLLBACK for 0028_account_backup
-- Date: 2026-09-03
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0028_account_backup_rollback.sql
--
-- Order does not matter for referential integrity — `files.restore_batch_id` and
-- `folders.restore_batch_id` are plain uuid columns, not foreign keys (0028 explains
-- why) — but the columns are dropped first anyway, so the file reads in the reverse
-- order of the one that created them.
--
-- What is lost, stated plainly:
--
--   * `account_backup_identities` — the record of which `accountBackupId` each
--     account answers to. Archives already downloaded remain DECRYPTABLE (the key
--     material is BACKUP_MASTER_KEY and the recovery phrase, neither of which lives
--     here), but every restore will now report an identity mismatch and demand the
--     recovery phrase, because the binding that would have recognised the archive
--     is gone. Re-applying 0028 does not bring it back: the next backup mints a
--     NEW id. Run `SELECT * FROM account_backup_identities;` and keep the output
--     before running this file if any archive still matters.
--   * `restore_batches` / `restore_reservations` — in-flight restores. Any restore
--     that is mid-staging when this runs is abandoned: its rows lose the marker
--     along with the column and stay soft-deleted, which puts them in the Recycle
--     Bin where the account can restore or purge them by hand. That is the one
--     upside of dropping the column rather than the table alone. No file data is
--     destroyed by this file, and no R2 object is deleted.
--   * Reserved quota is released implicitly — the reservation rows are what the
--     quota check sums, so dropping them returns the account to `used_bytes` alone.
--
-- The seven `activity_action` labels are deliberately NOT removed, for the reason
-- 0027's rollback gives: PostgreSQL has no `ALTER TYPE ... DROP VALUE`, rebuilding
-- the enum would rewrite every `activity_logs` row, and the existing audit rows
-- that use these labels are history worth keeping. Unused labels cost nothing.
--
-- 0027 is NOT undone by this file. `backup_keys` (which holds the sealed
-- recovery-wrapping key and the per-account phrase salt) survives, which is what
-- makes re-applying 0028 a recoverable operation rather than a fresh start.

DROP INDEX IF EXISTS files_restore_batch_idx;--> statement-breakpoint
DROP INDEX IF EXISTS folders_restore_batch_idx;--> statement-breakpoint
ALTER TABLE files   DROP COLUMN IF EXISTS restore_batch_id;--> statement-breakpoint
ALTER TABLE folders DROP COLUMN IF EXISTS restore_batch_id;--> statement-breakpoint
DROP TABLE IF EXISTS restore_reservations;--> statement-breakpoint
DROP TABLE IF EXISTS restore_batches;--> statement-breakpoint
DROP TABLE IF EXISTS account_backup_identities;
