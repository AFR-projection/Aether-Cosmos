-- Rollback: 0026_step_code_length
-- Date: 2026-08-28
--
-- Drops `users.step_code_length`.
--
-- Losing the column is not a data-loss event for authentication: no 2-Step Code
-- is stored here, only its digit count, and `step_code_hash` is untouched. Every
-- account keeps signing in normally — the login numpad simply reverts to the
-- flexible 6–10 slot pad for everyone, which is exactly how it behaved before the
-- forward migration.
--
-- Re-applying the forward migration afterwards starts the per-user backfill over
-- from null, so nothing needs to be reconstructed by hand.
--
-- Apply: npx tsx scripts/apply-migration.ts drizzle/0026_step_code_length_rollback.sql

ALTER TABLE "users" DROP COLUMN IF EXISTS "step_code_length";
