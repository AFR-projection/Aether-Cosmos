-- Rollback: 0025_mail_from_name_rebrand
-- Date: 2026-08-26
--
-- Product identity changes are intentionally not rolled back. Reverting the
-- surrounding schema must never reintroduce a retired outbound-mail identity.
--
-- Apply: npx tsx scripts/apply-migration.ts drizzle/0025_mail_from_name_rebrand_rollback.sql

ALTER TABLE "mail_senders" ALTER COLUMN "from_name" SET DEFAULT 'Aether Cosmos ByAFR';
