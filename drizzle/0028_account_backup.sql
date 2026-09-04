-- Migration: 0028_account_backup
-- Date: 2026-09-03
--
-- Per-account backup & restore. Every account — regular user and master alike —
-- exports its OWN /files or /brain as one encrypted `.afrbak` file, downloads it,
-- and restores it back into its own account.
-- Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md
--
-- Sits ON TOP of 0027_backup.sql, which must be applied first: this migration
-- reuses `backup_keys` for the sealed recovery-wrapping key, and adds seven more
-- labels to the `activity_action` enum 0027 already extended.
--
-- Three tables, and why each one exists:
--
--   * `account_backup_identities` — the root cryptographic identity of an
--     account's archives. `users.id` cannot play that role: a disaster restore
--     rebuilds the database, the account row comes back with a NEW uuid, and every
--     archive written before the disaster would be orphaned. Email cannot either —
--     it is editable. So each account gets a random `account_backup_id`, embedded
--     in every archive's ENCRYPTED summary, and this table records which ids an
--     account answers to. `source = 'generated'` is the id this instance minted
--     (at most one per account — the partial unique index below); `source =
--     'adopted'` is an id proven by a TYPED recovery phrase after a rebuild, which
--     is precisely the disaster-recovery path.
--
--   * `restore_batches` — one row per restore attempt, carrying the row and byte
--     counts the archive summary CLAIMS beside the totals actually written. The
--     gap between the two is what lets an import abort mid-stream when an archive
--     announces 100 MB and starts delivering 50 GB.
--
--   * `restore_reservations` — quota a staging restore has claimed but not yet
--     committed. Without it, two concurrent restores both read the same
--     `used_bytes`, both pass a quota check, and jointly break it.
--
-- `files.restore_batch_id` / `folders.restore_batch_id` are the staging marker for
-- the Files domain ONLY. Brain imports inside a single transaction and needs no
-- marker: MVCC hides uncommitted rows and a failure is a ROLLBACK. Files cannot do
-- that, because writing R2 objects is not transactional — so its rows land with
-- `deleted_at = NOW()` plus a batch id. Every existing read already filters
-- `deleted_at IS NULL`, so staged rows are invisible with ZERO read-path changes.
-- Only the Recycle Bin, which deliberately looks for deleted rows, gains
-- `AND restore_batch_id IS NULL`. Neither column is a foreign key — see the note
-- above the two ALTER TABLEs at the bottom of this file, which is load-bearing.
--
-- All three new tables belong to the NEVER-RESTORED class (see
-- src/features/backup/domain/table-classification.ts). A restored
-- `account_backup_identities` row would let an archive be adopted without anyone
-- typing a recovery phrase, and that phrase is the only gate the disaster path
-- rests on.
--
-- Apply:    npx tsx scripts/apply-migration.ts drizzle/0028_account_backup.sql
-- Rollback: npx tsx scripts/apply-migration.ts drizzle/0028_account_backup_rollback.sql
--
-- Transaction-safe, with 0027's caveat: PostgreSQL forbids USING a value added by
-- `ALTER TYPE ... ADD VALUE` inside the transaction that added it. The seven labels
-- below are only DECLARED here — nothing in this file inserts or compares them, and
-- the application code that writes them runs long after this transaction commits.

ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_takeout';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_preview';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_merge';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_replace';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_recovery_view';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_refused';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_adopted';--> statement-breakpoint

-- Composite primary key, not a surrogate id: the question this table answers is
-- "does this account answer to this id", and (user_id, account_backup_id) IS that
-- question. It also makes the same id impossible to bind twice to one account.
CREATE TABLE IF NOT EXISTS account_backup_identities (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_backup_id text NOT NULL,
  source            text NOT NULL,
  bound_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_backup_id),
  CONSTRAINT account_backup_identities_source_chk CHECK (source IN ('generated', 'adopted'))
);--> statement-breakpoint

-- At most one minted id per account. Adopted ids are unbounded on purpose: an
-- account may legitimately reclaim archives from several dead instances.
CREATE UNIQUE INDEX IF NOT EXISTS account_backup_identities_one_generated
  ON account_backup_identities (user_id) WHERE source = 'generated';--> statement-breakpoint

-- Restore looks an id up before it knows whose it is, so the id needs its own index.
CREATE INDEX IF NOT EXISTS account_backup_identities_id_idx
  ON account_backup_identities (account_backup_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS restore_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain           text NOT NULL,
  mode             text NOT NULL,
  state            text NOT NULL DEFAULT 'staging',
  backup_id        uuid NOT NULL,
  format_version   integer NOT NULL,
  key_id           text,
  -- What the archive summary claims. The ceiling every write is measured against.
  expected_rows    bigint NOT NULL DEFAULT 0,
  expected_bytes   bigint NOT NULL DEFAULT 0,
  -- What actually landed. Compared against the two above on every batch.
  written_rows     bigint NOT NULL DEFAULT 0,
  written_bytes    bigint NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restore_batches_domain_chk CHECK (domain IN ('brain', 'files')),
  CONSTRAINT restore_batches_mode_chk   CHECK (mode IN ('merge', 'replace')),
  CONSTRAINT restore_batches_state_chk  CHECK (state IN ('staging', 'committed', 'aborted'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS restore_batches_user_state_idx
  ON restore_batches (user_id, state);--> statement-breakpoint
-- The sweeper's only query: staging batches older than the abandonment window.
CREATE INDEX IF NOT EXISTS restore_batches_stale_idx
  ON restore_batches (created_at) WHERE state = 'staging';--> statement-breakpoint

-- One reservation per batch, hence the batch id AS the primary key: a second
-- reservation for the same restore would double-count the same bytes.
CREATE TABLE IF NOT EXISTS restore_reservations (
  restore_batch_id uuid PRIMARY KEY REFERENCES restore_batches(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes            bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- The quota check sums this per account, so it reads by user_id, never by batch.
CREATE INDEX IF NOT EXISTS restore_reservations_user_idx
  ON restore_reservations (user_id);--> statement-breakpoint

-- Staging marker, Files domain only (see the header).
--
-- Deliberately NOT a foreign key. `restore_batches` is in the never-restored class,
-- so `pg_dump --exclude-table` strips its definition from the operator's system
-- backup, and a `REFERENCES restore_batches(id)` here would make `CREATE TABLE
-- files` fail on a fresh-database restore of that backup — this migration would
-- quietly break the feature 0027 exists for. The cost is that no `ON DELETE SET
-- NULL` cleans up after a deleted batch, so the sweeper MUST purge a batch's staged
-- rows before deleting the batch row: the other order leaves soft-deleted rows that
-- the Recycle Bin's `restore_batch_id IS NULL` filter hides, i.e. rows nobody can
-- see and nobody can purge.
ALTER TABLE files   ADD COLUMN IF NOT EXISTS restore_batch_id uuid;--> statement-breakpoint
ALTER TABLE folders ADD COLUMN IF NOT EXISTS restore_batch_id uuid;--> statement-breakpoint

-- Partial: staged rows are a rounding error against a real account's row count, and
-- the commit sets the column back to NULL, so the index stays near-empty in steady
-- state. It is also the sweeper's only way in.
CREATE INDEX IF NOT EXISTS files_restore_batch_idx
  ON files (restore_batch_id) WHERE restore_batch_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS folders_restore_batch_idx
  ON folders (restore_batch_id) WHERE restore_batch_id IS NOT NULL;
