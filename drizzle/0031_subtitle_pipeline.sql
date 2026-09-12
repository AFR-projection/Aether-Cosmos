-- Migration: 0031_subtitle_pipeline
-- Durable, bounded subtitle processing. Additive except for required bigint/index alterations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_track_state') THEN
    CREATE TYPE subtitle_track_state AS ENUM ('candidate', 'current', 'superseded');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_pipeline_run_status') THEN
    CREATE TYPE subtitle_pipeline_run_status AS ENUM ('queued', 'running', 'blocked', 'unsupported', 'completed', 'failed', 'cancelled', 'stale');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_pipeline_stage') THEN
    CREATE TYPE subtitle_pipeline_stage AS ENUM ('ensure', 'planning', 'preparing', 'transcribing', 'materializing_source', 'translating', 'publishing', 'cleanup', 'completed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_pipeline_target_kind') THEN
    CREATE TYPE subtitle_pipeline_target_kind AS ENUM ('automatic', 'manual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_pipeline_target_status') THEN
    CREATE TYPE subtitle_pipeline_target_status AS ENUM ('pending', 'queued', 'processing', 'satisfied', 'ready', 'blocked', 'failed', 'cancelled', 'skipped', 'stale');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_work_item_kind') THEN
    CREATE TYPE subtitle_work_item_kind AS ENUM ('control', 'prepare', 'asr', 'translate', 'materialize', 'publish', 'cleanup');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_work_item_status') THEN
    CREATE TYPE subtitle_work_item_status AS ENUM ('pending', 'leased', 'succeeded', 'retry', 'blocked', 'failed', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_cue_partition_kind') THEN
    CREATE TYPE subtitle_cue_partition_kind AS ENUM ('source', 'translation');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_partition_materialization_state') THEN
    CREATE TYPE subtitle_partition_materialization_state AS ENUM ('pending', 'materialized', 'failed', 'expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_provider_capability') THEN
    CREATE TYPE subtitle_provider_capability AS ENUM ('asr', 'translation');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_provider_role') THEN
    CREATE TYPE subtitle_provider_role AS ENUM ('primary', 'fallback');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_provider_health') THEN
    CREATE TYPE subtitle_provider_health AS ENUM ('unknown', 'healthy', 'degraded', 'unhealthy');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_provider_attempt_status') THEN
    CREATE TYPE subtitle_provider_attempt_status AS ENUM ('started', 'succeeded', 'retryable_failure', 'terminal_failure', 'ambiguous');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_reconciliation_kind') THEN
    CREATE TYPE subtitle_reconciliation_kind AS ENUM ('library_backfill', 'locale_reconciliation', 'lease_repair', 'r2_cleanup');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_reconciliation_status') THEN
    CREATE TYPE subtitle_reconciliation_status AS ENUM ('idle', 'running', 'blocked', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subtitle_provider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capability subtitle_provider_capability NOT NULL,
  role subtitle_provider_role NOT NULL, name text NOT NULL, provider text NOT NULL,
  base_url text NOT NULL, model text NOT NULL, api_key_encrypted text,
  enabled boolean NOT NULL DEFAULT false, timeout_ms integer NOT NULL DEFAULT 120000,
  concurrency_limit integer NOT NULL DEFAULT 1, rate_limit integer NOT NULL DEFAULT 0,
  burst_limit integer NOT NULL DEFAULT 0, circuit_failure_threshold integer NOT NULL DEFAULT 5,
  circuit_window_seconds integer NOT NULL DEFAULT 120, circuit_cooldown_seconds integer NOT NULL DEFAULT 60,
  circuit_max_cooldown_seconds integer NOT NULL DEFAULT 900, circuit_open_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0, health subtitle_provider_health NOT NULL DEFAULT 'unknown',
  last_health_at timestamptz, last_error_code text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_provider_profiles_timeout_chk CHECK (timeout_ms > 0),
  CONSTRAINT subtitle_provider_profiles_limits_chk CHECK (concurrency_limit > 0 AND rate_limit >= 0 AND burst_limit >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_provider_profiles_capability_role_unique ON subtitle_provider_profiles(capability, role);
CREATE INDEX IF NOT EXISTS subtitle_provider_profiles_health_idx ON subtitle_provider_profiles(capability, health);

-- Preserve the legacy settings table and seed only the two primary profiles from it when present.
-- Dynamic SQL keeps this migration safe for databases previously bootstrapped with a partial db:push.
DO $$
BEGIN
  IF to_regclass('public.subtitle_settings') IS NOT NULL THEN
    EXECUTE $seed$
      INSERT INTO subtitle_provider_profiles (
        capability, role, name, provider, base_url, model, api_key_encrypted, enabled, created_at, updated_at
      )
      SELECT 'asr', 'primary', 'Legacy ASR primary', provider, base_url, model,
             api_key_encrypted, enabled, created_at, updated_at
      FROM public.subtitle_settings
      ON CONFLICT (capability, role) DO NOTHING
    $seed$;
    EXECUTE $seed$
      INSERT INTO subtitle_provider_profiles (
        capability, role, name, provider, base_url, model, api_key_encrypted, enabled, created_at, updated_at
      )
      SELECT 'translation', 'primary', 'Legacy translation primary', 'openai-compatible',
             translate_base_url, translate_model, translate_api_key_encrypted, enabled, created_at, updated_at
      FROM public.subtitle_settings
      ON CONFLICT (capability, role) DO NOTHING
    $seed$;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subtitle_pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_version integer NOT NULL,
  source_r2_key text NOT NULL, source_mime_type text NOT NULL, policy_version integer NOT NULL,
  request_key text NOT NULL, locale_set_hash text NOT NULL,
  status subtitle_pipeline_run_status NOT NULL DEFAULT 'queued', stage subtitle_pipeline_stage NOT NULL DEFAULT 'ensure',
  duration_ms bigint, planner_cursor_ms bigint NOT NULL DEFAULT 0, planned_through_ms bigint NOT NULL DEFAULT 0,
  total_work_items bigint NOT NULL DEFAULT 0, completed_work_items bigint NOT NULL DEFAULT 0,
  progress integer NOT NULL DEFAULT 0, cancellation_requested_at timestamptz, cancelled_at timestamptz,
  unsupported_code text, failure_code text, failure_message text, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_pipeline_runs_source_version_chk CHECK (source_version > 0),
  CONSTRAINT subtitle_pipeline_runs_policy_version_chk CHECK (policy_version > 0),
  CONSTRAINT subtitle_pipeline_runs_duration_chk CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT subtitle_pipeline_runs_progress_chk CHECK (progress BETWEEN 0 AND 100 AND completed_work_items <= total_work_items)
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_pipeline_runs_request_key_unique ON subtitle_pipeline_runs(request_key);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_pipeline_runs_source_policy_unique ON subtitle_pipeline_runs(file_id, source_version, source_r2_key, source_mime_type, policy_version, locale_set_hash);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_runs_user_status_idx ON subtitle_pipeline_runs(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_runs_file_idx ON subtitle_pipeline_runs(file_id, source_version);

ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS pipeline_run_id uuid;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS source_version integer;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS source_r2_key text;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS source_mime_type text;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS source_track_revision bigint;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS track_state subtitle_track_state NOT NULL DEFAULT 'current';
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS superseded_by_id uuid;
ALTER TABLE subtitle_tracks ADD COLUMN IF NOT EXISTS user_edited_at timestamptz;
ALTER TABLE subtitle_tracks ALTER COLUMN cue_count TYPE bigint USING cue_count::bigint;
ALTER TABLE subtitle_tracks ALTER COLUMN duration_seconds TYPE bigint USING duration_seconds::bigint;
ALTER TABLE subtitle_cues ALTER COLUMN idx TYPE bigint USING idx::bigint;
ALTER TABLE subtitle_cues ALTER COLUMN start_ms TYPE bigint USING start_ms::bigint;
ALTER TABLE subtitle_cues ALTER COLUMN end_ms TYPE bigint USING end_ms::bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_pipeline_run_id_fk') THEN
    ALTER TABLE subtitle_tracks ADD CONSTRAINT subtitle_tracks_pipeline_run_id_fk FOREIGN KEY (pipeline_run_id) REFERENCES subtitle_pipeline_runs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_superseded_by_id_fk') THEN
    ALTER TABLE subtitle_tracks ADD CONSTRAINT subtitle_tracks_superseded_by_id_fk FOREIGN KEY (superseded_by_id) REFERENCES subtitle_tracks(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_revision_chk') THEN
    ALTER TABLE subtitle_tracks ADD CONSTRAINT subtitle_tracks_revision_chk CHECK (revision > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_source_revision_chk') THEN
    ALTER TABLE subtitle_tracks ADD CONSTRAINT subtitle_tracks_source_revision_chk CHECK (source_track_revision IS NULL OR source_track_revision > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_counts_chk') THEN
    ALTER TABLE subtitle_tracks ADD CONSTRAINT subtitle_tracks_counts_chk CHECK (cue_count >= 0 AND duration_seconds >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_cues_time_chk') THEN
    ALTER TABLE subtitle_cues ADD CONSTRAINT subtitle_cues_time_chk CHECK (start_ms >= 0 AND end_ms >= start_ms);
  END IF;
END $$;

DROP INDEX IF EXISTS subtitle_tracks_unique;
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_tracks_current_unique ON subtitle_tracks(file_id, language, origin) WHERE track_state = 'current';
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_tracks_run_unique ON subtitle_tracks(pipeline_run_id, language, origin) WHERE pipeline_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subtitle_tracks_file_state_idx ON subtitle_tracks(file_id, track_state, status);
CREATE INDEX IF NOT EXISTS subtitle_tracks_pipeline_run_idx ON subtitle_tracks(pipeline_run_id);
CREATE INDEX IF NOT EXISTS subtitle_tracks_superseded_by_idx ON subtitle_tracks(superseded_by_id);
DROP INDEX IF EXISTS subtitle_cues_track_time_idx;
CREATE INDEX subtitle_cues_track_time_idx ON subtitle_cues(track_id, start_ms, end_ms, idx, id);

-- The old quota fields remain readable by old application instances, but no longer reject work.
UPDATE users SET subtitle_quota_seconds = 0;
ALTER TABLE users ALTER COLUMN subtitle_quota_seconds SET DEFAULT 0;

CREATE TABLE IF NOT EXISTS subtitle_pipeline_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES subtitle_pipeline_runs(id) ON DELETE CASCADE,
  language text NOT NULL, kind subtitle_pipeline_target_kind NOT NULL,
  status subtitle_pipeline_target_status NOT NULL DEFAULT 'pending',
  source_track_id uuid REFERENCES subtitle_tracks(id) ON DELETE SET NULL, source_revision bigint,
  candidate_track_id uuid REFERENCES subtitle_tracks(id) ON DELETE SET NULL, progress integer NOT NULL DEFAULT 0,
  terminal_code text, terminal_message text, ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_pipeline_targets_progress_chk CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT subtitle_pipeline_targets_source_revision_chk CHECK (source_revision IS NULL OR source_revision > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_pipeline_targets_run_language_unique ON subtitle_pipeline_targets(run_id, language);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_targets_status_idx ON subtitle_pipeline_targets(status, updated_at);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_targets_source_track_idx ON subtitle_pipeline_targets(source_track_id);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_targets_candidate_track_idx ON subtitle_pipeline_targets(candidate_track_id);

CREATE TABLE IF NOT EXISTS subtitle_pipeline_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES subtitle_pipeline_runs(id) ON DELETE CASCADE,
  target_id uuid REFERENCES subtitle_pipeline_targets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind subtitle_work_item_kind NOT NULL,
  status subtitle_work_item_status NOT NULL DEFAULT 'pending', idempotency_key text NOT NULL,
  ordinal bigint, cursor_start_ms bigint, cursor_end_ms bigint, available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 8,
  delivery_sequence bigint NOT NULL DEFAULT 0, lease_owner text, lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0, heartbeat_at timestamptz, output_checkpoint jsonb,
  failure_code text, failure_message text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_pipeline_work_items_attempt_chk CHECK (attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts),
  CONSTRAINT subtitle_pipeline_work_items_cursor_chk CHECK ((cursor_start_ms IS NULL AND cursor_end_ms IS NULL) OR (cursor_start_ms >= 0 AND cursor_end_ms > cursor_start_ms))
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_pipeline_work_items_idempotency_unique ON subtitle_pipeline_work_items(idempotency_key);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_work_items_due_idx ON subtitle_pipeline_work_items(status, available_at, user_id, created_at) WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS subtitle_pipeline_work_items_lease_idx ON subtitle_pipeline_work_items(lease_expires_at) WHERE status = 'leased';
CREATE INDEX IF NOT EXISTS subtitle_pipeline_work_items_run_idx ON subtitle_pipeline_work_items(run_id, kind, status);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_work_items_target_idx ON subtitle_pipeline_work_items(target_id);
CREATE INDEX IF NOT EXISTS subtitle_pipeline_work_items_user_idx ON subtitle_pipeline_work_items(user_id, status);

CREATE TABLE IF NOT EXISTS subtitle_audio_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES subtitle_pipeline_runs(id) ON DELETE CASCADE,
  work_item_id uuid REFERENCES subtitle_pipeline_work_items(id) ON DELETE SET NULL, ordinal bigint NOT NULL,
  start_ms bigint NOT NULL, end_ms bigint NOT NULL, overlap_before_ms bigint NOT NULL DEFAULT 0,
  overlap_after_ms bigint NOT NULL DEFAULT 0, object_key text NOT NULL, checksum_sha256 text NOT NULL,
  size_bytes bigint NOT NULL, format text NOT NULL, provider_result_key text, provider_result_checksum text,
  detected_language text, language_evidence jsonb, asr_completed_at timestamptz, expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_audio_chunks_range_chk CHECK (start_ms >= 0 AND end_ms > start_ms),
  CONSTRAINT subtitle_audio_chunks_size_overlap_chk CHECK (size_bytes > 0 AND overlap_before_ms >= 0 AND overlap_after_ms >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_audio_chunks_run_ordinal_unique ON subtitle_audio_chunks(run_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_audio_chunks_object_key_unique ON subtitle_audio_chunks(object_key);
CREATE INDEX IF NOT EXISTS subtitle_audio_chunks_work_item_idx ON subtitle_audio_chunks(work_item_id);
CREATE INDEX IF NOT EXISTS subtitle_audio_chunks_expiry_idx ON subtitle_audio_chunks(expires_at);

CREATE TABLE IF NOT EXISTS subtitle_cue_partitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES subtitle_pipeline_runs(id) ON DELETE CASCADE,
  target_id uuid REFERENCES subtitle_pipeline_targets(id) ON DELETE CASCADE,
  track_id uuid REFERENCES subtitle_tracks(id) ON DELETE SET NULL, kind subtitle_cue_partition_kind NOT NULL,
  ordinal bigint NOT NULL, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  first_cue_sequence bigint, last_cue_sequence bigint, cue_count bigint NOT NULL DEFAULT 0,
  input_hash text NOT NULL, object_key text NOT NULL, checksum_sha256 text NOT NULL, schema_version integer NOT NULL,
  materialization_state subtitle_partition_materialization_state NOT NULL DEFAULT 'pending',
  materialized_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_cue_partitions_range_chk CHECK (start_ms >= 0 AND end_ms >= start_ms),
  CONSTRAINT subtitle_cue_partitions_schema_chk CHECK (schema_version > 0 AND cue_count >= 0),
  CONSTRAINT subtitle_cue_partitions_sequence_chk CHECK ((first_cue_sequence IS NULL AND last_cue_sequence IS NULL) OR (first_cue_sequence >= 0 AND last_cue_sequence >= first_cue_sequence))
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_cue_partitions_identity_unique ON subtitle_cue_partitions(run_id, target_id, kind, ordinal, input_hash);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_cue_partitions_object_key_unique ON subtitle_cue_partitions(object_key);
CREATE INDEX IF NOT EXISTS subtitle_cue_partitions_materialize_idx ON subtitle_cue_partitions(run_id, target_id, materialization_state, ordinal);
CREATE INDEX IF NOT EXISTS subtitle_cue_partitions_track_idx ON subtitle_cue_partitions(track_id);
CREATE INDEX IF NOT EXISTS subtitle_cue_partitions_expiry_idx ON subtitle_cue_partitions(expires_at);

CREATE TABLE IF NOT EXISTS subtitle_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES subtitle_pipeline_work_items(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES subtitle_provider_profiles(id) ON DELETE RESTRICT,
  request_key text NOT NULL, attempt_number integer NOT NULL,
  status subtitle_provider_attempt_status NOT NULL DEFAULT 'started', used_fallback boolean NOT NULL DEFAULT false,
  http_status integer, latency_ms bigint, retry_after_ms bigint, input_units bigint, output_units bigint,
  error_code text, error_message text, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CONSTRAINT subtitle_provider_attempts_number_chk CHECK (attempt_number > 0),
  CONSTRAINT subtitle_provider_attempts_metrics_chk CHECK ((latency_ms IS NULL OR latency_ms >= 0) AND (retry_after_ms IS NULL OR retry_after_ms >= 0) AND (input_units IS NULL OR input_units >= 0) AND (output_units IS NULL OR output_units >= 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS subtitle_provider_attempts_request_unique ON subtitle_provider_attempts(request_key, attempt_number);
CREATE INDEX IF NOT EXISTS subtitle_provider_attempts_work_item_idx ON subtitle_provider_attempts(work_item_id, attempt_number);
CREATE INDEX IF NOT EXISTS subtitle_provider_attempts_profile_time_idx ON subtitle_provider_attempts(profile_id, started_at);
CREATE INDEX IF NOT EXISTS subtitle_provider_attempts_status_idx ON subtitle_provider_attempts(status, started_at);

CREATE TABLE IF NOT EXISTS subtitle_reconciliation_state (
  kind subtitle_reconciliation_kind PRIMARY KEY, status subtitle_reconciliation_status NOT NULL DEFAULT 'idle',
  cursor_created_at timestamptz, cursor_id uuid, cursor_data jsonb,
  scanned_count bigint NOT NULL DEFAULT 0, processed_count bigint NOT NULL DEFAULT 0,
  failed_count bigint NOT NULL DEFAULT 0, lease_owner text, lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0, heartbeat_at timestamptz,
  last_error_code text, last_error_message text, last_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subtitle_reconciliation_state_counts_chk CHECK (scanned_count >= 0 AND processed_count >= 0 AND failed_count >= 0)
);
CREATE INDEX IF NOT EXISTS subtitle_reconciliation_state_due_idx ON subtitle_reconciliation_state(status, updated_at);
CREATE INDEX IF NOT EXISTS subtitle_reconciliation_state_lease_idx ON subtitle_reconciliation_state(lease_expires_at);
