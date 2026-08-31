-- ─────────────────────────────────────────────────────────────────────────────
-- Migrate the primary contact channel from WhatsApp → Gmail (email).
--
-- This is additive and idempotent: it adds the email columns + the mail_senders
-- table WITHOUT dropping the WhatsApp tables/columns yet, so a deploy can roll
-- forward safely. A follow-up migration (0005) drops the WhatsApp objects once
-- email delivery is confirmed working in production.
--
-- Run:  npm run db:push      (or apply this file manually)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Enum for Gmail sender verification state.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_status') THEN
    CREATE TYPE "mail_status" AS ENUM ('unverified', 'ok', 'error');
  END IF;
END $$;--> statement-breakpoint

-- 2. users.email (nullable + unique). Existing users have NULL until they set one.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'users_email_unique') THEN
    CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");
  END IF;
END $$;--> statement-breakpoint

-- 3. Gmail SMTP senders. App Password is stored ENCRYPTED (see lib/email/crypto.ts).
CREATE TABLE IF NOT EXISTS "mail_senders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "app_password_encrypted" text NOT NULL,
  "display_name" text NOT NULL,
  "from_name" text DEFAULT 'Aether Cosmos ByAFR' NOT NULL,
  "status" "mail_status" DEFAULT 'unverified' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_error" text,
  "last_verified_at" timestamp with time zone,
  "priority" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'mail_senders_email_unique') THEN
    CREATE UNIQUE INDEX "mail_senders_email_unique" ON "mail_senders" ("email");
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_senders_status_idx" ON "mail_senders" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_senders_active_idx" ON "mail_senders" ("is_active");--> statement-breakpoint

-- 4. otp_tokens: add email target, relax phone_number to nullable (email is primary now).
ALTER TABLE "otp_tokens" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "otp_tokens" ALTER COLUMN "phone_number" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otp_tokens_email_idx" ON "otp_tokens" ("email");
