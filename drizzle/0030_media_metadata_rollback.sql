-- ROLLBACK for 0030_media_metadata
-- Date: 2026-09-08
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0030_media_metadata_rollback.sql
--
-- This deletes only derived ffprobe metadata. The original objects, thumbnails, subtitles,
-- shares, and playback permissions are untouched; the worker can reconstruct these values after
-- re-applying 0030.

-- Operation rows contain only derived transform state. Drop them before the enum types they use;
-- output files and source files remain untouched because the foreign keys point out of this table.
DROP TABLE IF EXISTS "media_operations";
DROP TYPE IF EXISTS "media_operation_status";
DROP TYPE IF EXISTS "media_operation_kind";

ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_media_bitrate_nonnegative";
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_media_fps_positive";
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_media_dimensions_positive";
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_media_duration_nonnegative";

ALTER TABLE "files" DROP COLUMN IF EXISTS "media_inspected_at";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_compatibility_reason";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_compatible";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_faststart";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_container";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_bitrate_bps";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_audio_codec";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_video_codec";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_fps";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_height";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_width";
ALTER TABLE "files" DROP COLUMN IF EXISTS "media_duration_ms";
