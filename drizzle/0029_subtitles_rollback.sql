-- ROLLBACK for 0029_subtitles
-- Date: 2026-09-05
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0029_subtitles_rollback.sql
--
-- What is lost, stated plainly:
--
--   * Every subtitle track and every line of every track. Generated tracks cost
--     transcription minutes to make, and anything corrected in the subtitle editor is
--     not recoverable from anywhere else. Download the `.vtt` of any track that still
--     matters BEFORE running this file — the per-track download button exists for
--     exactly this, and an exported file can be attached again later.
--
--   * Both provider API keys. Nothing else on the instance holds them; they have to be
--     pasted again in /admin/subtitles after re-applying 0029.
--
--   * Every account's transcription allowance and how much of it has been used. After
--     a re-apply, the rolling window restarts from zero — which is generous, not
--     dangerous.
--
-- Dropped in reverse dependency order. `subtitle_cues` references `subtitle_tracks`, and
-- `subtitle_tracks` references itself, so cues go first and the enums go last: a type
-- cannot be dropped while a column still uses it.

DROP TABLE IF EXISTS "subtitle_cues";
DROP TABLE IF EXISTS "subtitle_tracks";
DROP TABLE IF EXISTS "subtitle_settings";

DROP TYPE IF EXISTS "public"."subtitle_status";
DROP TYPE IF EXISTS "public"."subtitle_origin";

ALTER TABLE "users" DROP COLUMN IF EXISTS "subtitle_period_start";
ALTER TABLE "users" DROP COLUMN IF EXISTS "subtitle_used_seconds";
ALTER TABLE "users" DROP COLUMN IF EXISTS "subtitle_quota_seconds";
