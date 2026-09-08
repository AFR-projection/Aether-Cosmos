-- Migration: 0030_media_metadata
-- Date: 2026-09-08
--
-- Playback metadata discovered asynchronously by ffprobe. Every column is nullable so applying
-- this migration never turns an existing ready file back into a processing state: null means
-- "not inspected yet" (or "not applicable" for non-video files).
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0030_media_metadata.sql
-- Rollback: drizzle/0030_media_metadata_rollback.sql
--
-- The worker writes all fields in one UPDATE after a successful probe. It never stores ffprobe's
-- raw JSON, object names, or file contents. Values that do not fit PostgreSQL integer precision
-- stay null rather than being truncated.

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_duration_ms" bigint;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_width" integer;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_height" integer;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_fps" real;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_video_codec" text;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_audio_codec" text;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_bitrate_bps" bigint;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_container" text;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_faststart" boolean;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_compatible" boolean;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_compatibility_reason" text;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "media_inspected_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_media_duration_nonnegative'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_media_duration_nonnegative"
      CHECK ("media_duration_ms" IS NULL OR "media_duration_ms" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_media_dimensions_positive'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_media_dimensions_positive"
      CHECK (("media_width" IS NULL OR "media_width" > 0)
         AND ("media_height" IS NULL OR "media_height" > 0));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_media_fps_positive'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_media_fps_positive"
      CHECK ("media_fps" IS NULL OR "media_fps" > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_media_bitrate_nonnegative'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_media_bitrate_nonnegative"
      CHECK ("media_bitrate_bps" IS NULL OR "media_bitrate_bps" >= 0);
  END IF;
END $$;

-- A media transform is retried by BullMQ and can outlive the request that created it. This row is
-- the durable idempotency record: exact source identity, staged object, publication state, and the
-- stable output-file identity for extraction all survive worker restarts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_operation_kind') THEN
    CREATE TYPE "media_operation_kind" AS ENUM ('trim', 'extract_audio');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_operation_status') THEN
    CREATE TYPE "media_operation_status" AS ENUM ('queued', 'staged', 'publishing', 'completed', 'stale', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "media_operations" (
  "id" uuid PRIMARY KEY,
  "kind" media_operation_kind NOT NULL,
  "source_file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "source_r2_key" text NOT NULL,
  "source_mime_type" text NOT NULL,
  "source_version" integer NOT NULL,
  "output_file_id" uuid,
  "staging_key" text NOT NULL,
  "status" media_operation_status NOT NULL DEFAULT 'queued',
  "output_size_bytes" bigint,
  "output_mime_type" text,
  "output_name" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "media_operations_source_version_chk" CHECK ("source_version" > 0),
  CONSTRAINT "media_operations_output_size_chk"
    CHECK ("output_size_bytes" IS NULL OR "output_size_bytes" > 0),
  CONSTRAINT "media_operations_kind_output_chk" CHECK (
    ("kind" = 'trim' AND "output_file_id" IS NULL)
    OR ("kind" = 'extract_audio' AND "output_file_id" IS NOT NULL)
  ),
  CONSTRAINT "media_operations_staged_output_chk"
    CHECK ("status" = 'queued' OR "output_size_bytes" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "media_operations_source_idx"
  ON "media_operations" ("source_file_id", "source_version");
CREATE UNIQUE INDEX IF NOT EXISTS "media_operations_output_file_unique"
  ON "media_operations" ("output_file_id") WHERE "output_file_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "media_operations_status_updated_idx"
  ON "media_operations" ("status", "updated_at");
