-- Migration: 0027_backup
-- Date: 2026-09-02
--
-- Adds the three tables behind encrypted, downloadable backups, plus the six
-- `activity_action` labels that audit them. Design: docs/superpowers/specs/2026-09-01-backup-design.md
--
-- Shape, and why:
--
--   * `owner_key` is text — `'system'` or `'user:<uuid>'` — rather than a nullable
--     `user_id`. The system scope has no user row, so "one settings row per owner
--     per domain" would otherwise need a partial unique index over a nullable
--     column plus a second one for the NULL case. A text key states the intent in
--     the column instead of in two indexes. `user_id` is kept beside it purely so
--     ON DELETE CASCADE removes an account's keys, settings and job log with the
--     account.
--
--   * `domain` ('brain' | 'files') is text + CHECK, not an enum. Every enum costs a
--     CREATE TYPE in each pg_dump and a separate migration to extend; a two-value
--     CHECK is the same guarantee with neither cost. It is part of the identity of
--     a settings row, not a filter on it: Second Brain and Files are backed up and
--     retained independently, which is the whole point of the feature.
--
--   * `backup_jobs.manifest` is one jsonb column rather than child tables for
--     parts and blobs. It is written once by one worker at the end of a run and
--     only ever read whole, so normalising it would buy joins and no integrity.
--
-- All three tables are in the NEVER-RESTORED class (see §5 of the design). A
-- restored `backup_jobs` row would point at R2 objects that may not exist in the
-- destination bucket, and a restored `backup_keys` row carries a KEK sealed with
-- the SOURCE instance's SESSION_SECRET — an unreadable blob that looks like a
-- usable key, which is strictly worse than no row at all, because no row makes
-- the next backup create a fresh key cleanly.
--
-- Apply:    npx tsx scripts/apply-migration.ts drizzle/0027_backup.sql
-- Rollback: npx tsx scripts/apply-migration.ts drizzle/0027_backup_rollback.sql
--
-- Transaction-safe. scripts/apply-migration.ts sends the whole file as one
-- implicit transaction, and PostgreSQL forbids USING a value added by
-- `ALTER TYPE ... ADD VALUE` in the same transaction that added it. The six new
-- labels below are therefore only *declared* here — nothing in this file inserts
-- or compares them, and the application code that writes them runs long after
-- this transaction commits. (0016 exists as a labels-only migration for exactly
-- this reason; here the CREATE TABLEs are independent of the labels, so the two
-- can share a file.)

ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_create';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_download';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_delete';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_settings_change';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_key_rotate';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_purge_all';--> statement-breakpoint

-- One key per owner, shared by both domains: one passphrase covers Second Brain
-- and Files, because two passphrases means two things to lose and the recovery
-- story for a lost one is "the data is gone".
CREATE TABLE IF NOT EXISTS backup_keys (
  owner_key        text PRIMARY KEY,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  wrapped_kek      text NOT NULL,
  kdf_salt         text NOT NULL,
  key_epoch        integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS backup_settings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key        text NOT NULL,
  domain           text NOT NULL,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  frequency        text NOT NULL DEFAULT 'weekly',
  hour_utc         integer NOT NULL DEFAULT 3,
  day_of_week      integer,
  day_of_month     integer,
  keep_daily       integer NOT NULL DEFAULT 7,
  keep_weekly      integer NOT NULL DEFAULT 4,
  keep_monthly     integer NOT NULL DEFAULT 6,
  include_logs     boolean NOT NULL DEFAULT true,
  last_run_at      timestamptz,
  next_run_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_settings_domain_chk CHECK (domain IN ('brain', 'files'))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS backup_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key        text NOT NULL,
  domain           text NOT NULL,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  scope            text NOT NULL,
  trigger          text NOT NULL,
  status           text NOT NULL DEFAULT 'created',
  key_epoch        integer NOT NULL DEFAULT 1,
  idempotency_key  text NOT NULL,
  note             text,
  manifest         jsonb,
  total_bytes      bigint NOT NULL DEFAULT 0,
  error            text,
  verified_at      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_jobs_domain_chk CHECK (domain IN ('brain', 'files'))
);--> statement-breakpoint

-- One settings row per (owner, domain) — the constraint that makes "Second Brain
-- daily, Files weekly" expressible at all.
CREATE UNIQUE INDEX IF NOT EXISTS backup_settings_owner_domain_idx
  ON backup_settings (owner_key, domain);--> statement-breakpoint
-- The hourly due-scan only ever asks for enabled rows, so the index carries only
-- those: on a single-operator instance that is a handful of rows, not a table scan.
CREATE INDEX IF NOT EXISTS backup_settings_due_idx
  ON backup_settings (next_run_at) WHERE enabled;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS backup_settings_user_id_idx ON backup_settings (user_id);--> statement-breakpoint

-- Idempotency is per (owner, domain): a retried POST must not start a second run,
-- but the same clock minute in two domains is two legitimate runs.
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_owner_domain_idem_idx
  ON backup_jobs (owner_key, domain, idempotency_key);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS backup_jobs_owner_domain_created_idx
  ON backup_jobs (owner_key, domain, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS backup_jobs_status_idx ON backup_jobs (status);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS backup_jobs_user_id_idx ON backup_jobs (user_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS backup_keys_user_id_idx ON backup_keys (user_id);
