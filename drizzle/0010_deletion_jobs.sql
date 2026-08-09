-- Durable batch deletion jobs for large permanent folder deletes.

DO $$
BEGIN
  CREATE TYPE "deletion_job_status" AS ENUM ('created', 'processing', 'completed', 'failed', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "deletion_item_status" AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deletion_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "folder_id" uuid REFERENCES "folders"("id") ON DELETE set null,
  "idempotency_key" text NOT NULL,
  "status" "deletion_job_status" DEFAULT 'created' NOT NULL,
  "total_items" integer DEFAULT 0 NOT NULL,
  "processed_items" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_message" text,
  "expires_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deletion_jobs_user_idempotency_unique"
  ON "deletion_jobs" USING btree ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_jobs_user_status_idx"
  ON "deletion_jobs" USING btree ("user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_jobs_expiry_idx"
  ON "deletion_jobs" USING btree ("status", "expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deletion_job_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deletion_job_id" uuid NOT NULL REFERENCES "deletion_jobs"("id") ON DELETE cascade,
  "file_id" uuid REFERENCES "files"("id") ON DELETE set null,
  "object_key" text NOT NULL,
  "thumbnail_key" text,
  "status" "deletion_item_status" DEFAULT 'pending' NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deletion_job_items_job_object_unique"
  ON "deletion_job_items" USING btree ("deletion_job_id", "object_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_job_items_job_status_idx"
  ON "deletion_job_items" USING btree ("deletion_job_id", "status");
