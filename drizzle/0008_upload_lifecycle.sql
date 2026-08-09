-- Large-scale upload lifecycle (additive migration).
--
-- Existing non-note files intentionally become legacy_unverified. They are not
-- promoted to READY here because SQL migration code cannot safely HEAD objects
-- in R2. The reconciliation/backfill worker will verify them before promotion.

DO $$
BEGIN
  CREATE TYPE "file_upload_status" AS ENUM (
    'legacy_unverified',
    'created',
    'uploading',
    'verifying',
    'ready',
    'failed',
    'cancelled',
    'deleting',
    'delete_failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TYPE "file_upload_status" ADD VALUE IF NOT EXISTS 'inconsistent';
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "upload_session_status" AS ENUM (
    'created',
    'uploading',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "upload_part_status" AS ENUM ('pending', 'uploaded', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "upload_type" AS ENUM ('single', 'multipart');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "reserved_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "status" "file_upload_status" DEFAULT 'created' NOT NULL;
--> statement-breakpoint
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "failure_code" text;
--> statement-breakpoint
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "failure_message" text;
--> statement-breakpoint
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
--> statement-breakpoint

-- Notes are database-backed and do not require an R2 object. Every other
-- existing row must be verified by R2 reconciliation before becoming READY.
UPDATE "files"
SET
  "status" = CASE WHEN "is_note" THEN 'ready'::"file_upload_status" ELSE 'legacy_unverified'::"file_upload_status" END,
  "completed_at" = CASE WHEN "is_note" THEN COALESCE("completed_at", "created_at") ELSE "completed_at" END,
  "verified_at" = CASE WHEN "is_note" THEN COALESCE("verified_at", "created_at") ELSE "verified_at" END
WHERE "status" = 'created'::"file_upload_status";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "upload_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "idempotency_key" text NOT NULL,
  "upload_type" "upload_type" NOT NULL,
  "r2_upload_id" text,
  "object_key" text NOT NULL,
  "total_size_bytes" bigint NOT NULL,
  "part_size_bytes" bigint,
  "expected_checksum_sha256" text,
  "status" "upload_session_status" DEFAULT 'created' NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "reservation_released" boolean DEFAULT false NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "expires_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "upload_sessions_total_size_positive" CHECK ("total_size_bytes" > 0),
  CONSTRAINT "upload_sessions_part_size_positive" CHECK ("part_size_bytes" IS NULL OR "part_size_bytes" > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "upload_sessions_user_idempotency_unique"
  ON "upload_sessions" USING btree ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_file_idx"
  ON "upload_sessions" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_user_status_idx"
  ON "upload_sessions" USING btree ("user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_expiry_idx"
  ON "upload_sessions" USING btree ("status", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_r2_upload_idx"
  ON "upload_sessions" USING btree ("r2_upload_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "upload_parts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_session_id" uuid NOT NULL REFERENCES "upload_sessions"("id") ON DELETE cascade,
  "part_number" integer NOT NULL,
  "size_bytes" bigint NOT NULL,
  "etag" text,
  "checksum_sha256" text,
  "status" "upload_part_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "uploaded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "upload_parts_part_number_positive" CHECK ("part_number" > 0),
  CONSTRAINT "upload_parts_size_positive" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "upload_parts_session_part_unique"
  ON "upload_parts" USING btree ("upload_session_id", "part_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_parts_session_status_idx"
  ON "upload_parts" USING btree ("upload_session_id", "status");
