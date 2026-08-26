-- Rollback: 0025_mail_from_name_rebrand
-- Date: 2026-08-26
--
-- Restores the pre-rebrand default on `mail_senders.from_name`, and moves back the
-- rows the forward migration rewrote.
--
-- The row UPDATE is guarded the same way as the forward one — only rows holding
-- exactly the new brand move — but the guard is less precise in this direction: a
-- sender someone deliberately named "Aether Cosmos ByAFR" in /admin/email after the
-- rebrand is indistinguishable from one the migration rewrote, so it reverts too.
-- That is the intended trade for a rollback; a From name is re-editable in the UI.
--
-- Apply: npx tsx scripts/apply-migration.ts drizzle/0025_mail_from_name_rebrand_rollback.sql

ALTER TABLE "mail_senders" ALTER COLUMN "from_name" SET DEFAULT 'Storage ByAFR';

UPDATE "mail_senders"
   SET "from_name" = 'Storage ByAFR'
 WHERE "from_name" = 'Aether Cosmos ByAFR';
