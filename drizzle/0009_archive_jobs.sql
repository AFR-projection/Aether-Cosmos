-- Asynchronous archive downloads. Additive only: existing files and objects are untouched.

-- Backfill integrity columns if the Phase 1 migration was applied from an
-- earlier copy that did not yet contain them.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "checksum_sha256" text;
--> statement-breakpoint
ALTER TABLE "upload_parts" ADD COLUMN IF NOT EXISTS "checksum_sha256" text;
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "archive_job_status" AS ENUM ('created', 'processing', 'ready', 'failed', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "archive_item_status" AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "archive_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "folder_id" uuid REFERENCES "folders"("id") ON DELETE set null,
  "idempotency_key" text NOT NULL,
  "object_key" text NOT NULL,
  "archive_name" text NOT NULL,
  "status" "archive_job_status" DEFAULT 'created' NOT NULL,
  "total_files" integer DEFAULT 0 NOT NULL,
  "processed_files" integer DEFAULT 0 NOT NULL,
  "total_bytes" bigint DEFAULT 0 NOT NULL,
  "processed_bytes" bigint DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_message" text,
  "expires_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "archive_jobs_user_idempotency_unique"
  ON "archive_jobs" USING btree ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_jobs_user_status_idx"
  ON "archive_jobs" USING btree ("user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_jobs_expiry_idx"
  ON "archive_jobs" USING btree ("status", "expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "archive_job_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "archive_job_id" uuid NOT NULL REFERENCES "archive_jobs"("id") ON DELETE cascade,
  "file_id" uuid REFERENCES "files"("id") ON DELETE set null,
  "archive_path" text NOT NULL,
  "object_key" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "status" "archive_item_status" DEFAULT 'pending' NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "archive_job_items_size_nonnegative" CHECK ("size_bytes" >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "archive_job_items_job_path_unique"
  ON "archive_job_items" USING btree ("archive_job_id", "archive_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_job_items_job_status_idx"
  ON "archive_job_items" USING btree ("archive_job_id", "status");
