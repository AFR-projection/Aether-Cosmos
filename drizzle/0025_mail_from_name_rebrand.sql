-- Migration: 0025_mail_from_name_rebrand
-- Date: 2026-08-26
--
-- Rebrand "Storage ByAFR" → "Aether Cosmos ByAFR" for outbound mail.
--
-- Two statements:
--   1. Move the `mail_senders.from_name` column default, so a sender added without
--      an explicit From name picks up the new brand. Mirrors `lib/db/schema.ts`,
--      which holds the same literal (drizzle-kit loads that file outside the
--      Next.js module graph, so it cannot import APP_NAME).
--   2. Rewrite existing rows, but ONLY where `from_name` is still exactly the old
--      default. `from_name` is user-editable in /admin/email, so a row may hold
--      something deliberately different — a person's name, a department. The
--      equality guard means those are left alone; only rows that were never
--      customised move. Without this the column default would say the new brand
--      while every actual email still went out under the old one.
--
-- Nothing else in the rebrand touches the database: rows are keyed by id, the mail
-- key-derivation salt in lib/email/crypto.ts is unchanged (changing it would make
-- every stored Gmail App Password undecryptable), and brain graph nodes named
-- "Storage ByAFR" keep matching because lib/brain/enrich/extract.ts still lists the
-- old name as a lexicon entry alongside the new one.
--
-- Apply:    npx tsx scripts/apply-migration.ts drizzle/0025_mail_from_name_rebrand.sql
-- Rollback: npx tsx scripts/apply-migration.ts drizzle/0025_mail_from_name_rebrand_rollback.sql
--
-- Transaction-safe inside apply-migration.ts: an ALTER COLUMN ... SET DEFAULT is
-- metadata only (no table rewrite, no lock held past the statement), and the UPDATE
-- touches at most a handful of rows.

ALTER TABLE "mail_senders" ALTER COLUMN "from_name" SET DEFAULT 'Aether Cosmos ByAFR';

UPDATE "mail_senders"
   SET "from_name" = 'Aether Cosmos ByAFR'
 WHERE "from_name" = 'Storage ByAFR';
