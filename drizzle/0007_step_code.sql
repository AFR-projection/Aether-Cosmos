-- ─────────────────────────────────────────────────────────────────────────────
-- 2-Step Code: the numpad layer that sits between the password and TOTP steps.
--
-- The code is argon2-hashed exactly like a password, never stored in the clear.
-- Attempt tracking is kept separate from the password columns so a lockout on
-- one layer cannot hide or reset the other.
--
-- Additive + idempotent — existing users get NULL (no code set yet) and are
-- prompted to enrol at next login when the admin requires it.
--
-- Run:  npm run db:push   (or apply this file manually)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "step_code_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "step_code_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "step_code_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "step_code_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "step_code_must_change" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Audit actions for the new layer. ADD VALUE IF NOT EXISTS is idempotent and
-- cannot run inside a transaction block on older Postgres, so keep it last.
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'step_code_change';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'step_code_lock';--> statement-breakpoint
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'step_code_reset';

