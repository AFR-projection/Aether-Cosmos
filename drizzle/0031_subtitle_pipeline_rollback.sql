-- ROLLBACK for 0031_subtitle_pipeline
-- Operational rollback should normally pause dispatch and roll back application/workers without
-- running this file. This script removes only the new pipeline foundation and restores the legacy
-- track uniqueness. It deliberately leaves bigint widenings and unlimited quota compatibility in
-- place because narrowing/count rollback can overflow or re-enable permanent cost rejection.

DROP TABLE IF EXISTS subtitle_provider_attempts;
DROP TABLE IF EXISTS subtitle_cue_partitions;
DROP TABLE IF EXISTS subtitle_audio_chunks;
DROP TABLE IF EXISTS subtitle_pipeline_work_items;
DROP TABLE IF EXISTS subtitle_pipeline_targets;
DROP TABLE IF EXISTS subtitle_reconciliation_state;

DROP INDEX IF EXISTS subtitle_tracks_run_unique;
DROP INDEX IF EXISTS subtitle_tracks_current_unique;
DROP INDEX IF EXISTS subtitle_tracks_file_state_idx;
DROP INDEX IF EXISTS subtitle_tracks_pipeline_run_idx;
DROP INDEX IF EXISTS subtitle_tracks_superseded_by_idx;

ALTER TABLE subtitle_tracks DROP CONSTRAINT IF EXISTS subtitle_tracks_superseded_by_id_fk;
ALTER TABLE subtitle_tracks DROP CONSTRAINT IF EXISTS subtitle_tracks_pipeline_run_id_fk;
ALTER TABLE subtitle_tracks DROP CONSTRAINT IF EXISTS subtitle_tracks_revision_chk;
ALTER TABLE subtitle_tracks DROP CONSTRAINT IF EXISTS subtitle_tracks_source_revision_chk;
ALTER TABLE subtitle_tracks DROP CONSTRAINT IF EXISTS subtitle_tracks_counts_chk;
ALTER TABLE subtitle_cues DROP CONSTRAINT IF EXISTS subtitle_cues_time_chk;

ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS user_edited_at;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS superseded_by_id;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS track_state;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS revision;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS source_track_revision;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS source_mime_type;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS source_r2_key;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS source_version;
ALTER TABLE subtitle_tracks DROP COLUMN IF EXISTS pipeline_run_id;

DROP TABLE IF EXISTS subtitle_pipeline_runs;
DROP TABLE IF EXISTS subtitle_provider_profiles;

-- Every surviving row was current when 0031 installed; this restores the old compatible invariant.
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_tracks_unique ON subtitle_tracks(file_id, language, origin);
DROP INDEX IF EXISTS subtitle_cues_track_time_idx;
CREATE INDEX IF NOT EXISTS subtitle_cues_track_time_idx ON subtitle_cues(track_id, start_ms);

DROP TYPE IF EXISTS subtitle_reconciliation_status;
DROP TYPE IF EXISTS subtitle_reconciliation_kind;
DROP TYPE IF EXISTS subtitle_provider_attempt_status;
DROP TYPE IF EXISTS subtitle_provider_health;
DROP TYPE IF EXISTS subtitle_provider_role;
DROP TYPE IF EXISTS subtitle_provider_capability;
DROP TYPE IF EXISTS subtitle_partition_materialization_state;
DROP TYPE IF EXISTS subtitle_cue_partition_kind;
DROP TYPE IF EXISTS subtitle_work_item_status;
DROP TYPE IF EXISTS subtitle_work_item_kind;
DROP TYPE IF EXISTS subtitle_pipeline_target_status;
DROP TYPE IF EXISTS subtitle_pipeline_target_kind;
DROP TYPE IF EXISTS subtitle_pipeline_stage;
DROP TYPE IF EXISTS subtitle_pipeline_run_status;
DROP TYPE IF EXISTS subtitle_track_state;
