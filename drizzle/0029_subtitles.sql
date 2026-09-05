-- Migration: 0029_subtitles
-- Date: 2026-09-05
--
-- Multi-language subtitles for video files: generate from the video's own audio,
-- translate into any language, attach a `.srt`/`.vtt` somebody already has, and
-- correct the result by hand.
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0029_subtitles.sql
-- Rollback: drizzle/0029_subtitles_rollback.sql
--
-- Idempotent throughout (`IF NOT EXISTS`, guarded `DO` blocks) because this database
-- was bootstrapped with `db:push` and `__drizzle_migrations` is empty by design —
-- every migration here has to be safe to run against a schema that may already have
-- part of it.
--
-- Three tables and three columns, and why each exists:
--
--   * `subtitle_settings` — one row, `id = 'default'`, holding the two provider
--     configurations. Two rather than one because transcription and translation are
--     different services: transcription is an OpenAI-compatible
--     `/audio/transcriptions` endpoint (Groq, OpenAI) and translation is a
--     chat-completions endpoint (OpenRouter, or the same vendor). Both API keys are
--     stored as AES-256-GCM ciphertext, exactly as `mail_senders.app_password_encrypted`
--     and `brain_embedding_settings.api_key_encrypted` are, and neither is ever
--     returned to a client.
--
--     NOTE for whoever reads this after a secret rotation: the ciphertext is sealed
--     with SESSION_SECRET. Changing that secret does not corrupt these rows, but it
--     does make them unreadable — the keys have to be pasted again in
--     /admin/subtitles. Same behaviour as the Gmail App Passwords.
--
--   * `subtitle_tracks` — one row per language per file. There is deliberately NO
--     `label` column: a label would freeze one language's wording into the database,
--     and this app translates at render time. A track carries a BCP-47 `language` and
--     an `origin`, and the interface composes what to call it.
--
--   * `subtitle_cues` — one row per line. A table rather than a JSONB array on the
--     track, because the editor must be able to correct one line without rewriting a
--     300 KB document, and because serving the WebVTT is then an ordered range scan.
--
--   * `users.subtitle_quota_seconds` / `_used_seconds` / `_period_start` — a rolling
--     30-day allowance, structured exactly like the `bandwidth_*` columns beside them
--     and read by the same shape of code. This is the only quota in the schema that
--     guards somebody else's invoice rather than this server's disk, which is why it
--     has a non-zero default where bandwidth does not: an account that has never been
--     configured must not be able to spend without limit.

-- ── enums ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_origin') THEN
    CREATE TYPE "public"."subtitle_origin" AS ENUM ('asr', 'translated', 'uploaded');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtitle_status') THEN
    CREATE TYPE "public"."subtitle_status" AS ENUM ('queued', 'processing', 'ready', 'failed');
  END IF;
END $$;

-- ── subtitle_settings ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "subtitle_settings" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "provider" text DEFAULT 'groq' NOT NULL,
  "base_url" text DEFAULT 'https://api.groq.com/openai/v1' NOT NULL,
  "model" text DEFAULT 'whisper-large-v3-turbo' NOT NULL,
  "api_key_encrypted" text,
  "translate_base_url" text DEFAULT 'https://openrouter.ai/api/v1' NOT NULL,
  "translate_model" text DEFAULT 'google/gemini-2.5-flash' NOT NULL,
  "translate_api_key_encrypted" text,
  "enabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ── subtitle_tracks ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "subtitle_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_id" uuid NOT NULL,
  "language" text NOT NULL,
  "origin" "public"."subtitle_origin" NOT NULL,
  "status" "public"."subtitle_status" DEFAULT 'queued' NOT NULL,
  "translated_from_id" uuid,
  "progress" integer DEFAULT 0 NOT NULL,
  "cue_count" integer DEFAULT 0 NOT NULL,
  "duration_seconds" integer DEFAULT 0 NOT NULL,
  "provider" text,
  "model" text,
  "failure_code" text,
  "failure_message" text,
  "created_by" uuid,
  "ready_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Foreign keys added separately so a re-run against a table that already exists still
-- installs them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_file_id_files_id_fk') THEN
    ALTER TABLE "subtitle_tracks"
      ADD CONSTRAINT "subtitle_tracks_file_id_files_id_fk"
      FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_created_by_users_id_fk') THEN
    ALTER TABLE "subtitle_tracks"
      ADD CONSTRAINT "subtitle_tracks_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;
  END IF;
  -- Self-reference: a translated track points at the transcript it came from. ON DELETE
  -- SET NULL rather than CASCADE, because deleting a Japanese transcript should not take
  -- the Indonesian subtitles somebody has been watching with it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_tracks_translated_from_id_fk') THEN
    ALTER TABLE "subtitle_tracks"
      ADD CONSTRAINT "subtitle_tracks_translated_from_id_fk"
      FOREIGN KEY ("translated_from_id") REFERENCES "public"."subtitle_tracks"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- One track per language per origin. This is what makes "generate Indonesian again"
-- replace a row instead of adding a second entry to the menu. `origin` belongs in the key:
-- a Japanese film may legitimately have both a generated Japanese track and an uploaded one.
CREATE UNIQUE INDEX IF NOT EXISTS "subtitle_tracks_unique"
  ON "subtitle_tracks" ("file_id", "language", "origin");
-- Deliberately NO index on ("file_id") alone: it is the leading column of the unique above, which
-- Postgres already uses for "every track of this file". An earlier revision of this migration did
-- create one, and `scripts/audit-db.ts` correctly flagged it as a redundant prefix — the DROP below
-- removes it from any database that ran that revision.
DROP INDEX IF EXISTS "subtitle_tracks_file_idx";
CREATE INDEX IF NOT EXISTS "subtitle_tracks_status_idx" ON "subtitle_tracks" ("status");
CREATE INDEX IF NOT EXISTS "subtitle_tracks_created_by_idx" ON "subtitle_tracks" ("created_by");
CREATE INDEX IF NOT EXISTS "subtitle_tracks_translated_from_idx"
  ON "subtitle_tracks" ("translated_from_id");

-- ── subtitle_cues ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "subtitle_cues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "track_id" uuid NOT NULL,
  "idx" integer NOT NULL,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "text" text NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtitle_cues_track_id_fk') THEN
    ALTER TABLE "subtitle_cues"
      ADD CONSTRAINT "subtitle_cues_track_id_fk"
      FOREIGN KEY ("track_id") REFERENCES "public"."subtitle_tracks"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "subtitle_cues_unique" ON "subtitle_cues" ("track_id", "idx");
CREATE INDEX IF NOT EXISTS "subtitle_cues_track_time_idx"
  ON "subtitle_cues" ("track_id", "start_ms");

-- ── users: the transcription allowance ───────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "subtitle_quota_seconds" integer DEFAULT 36000 NOT NULL;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "subtitle_used_seconds" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "subtitle_period_start" timestamp with time zone;

-- The column default only applies to rows written from now on, so existing accounts are
-- given the same allowance explicitly — otherwise every account that predates this
-- migration would read as `0`, which means unlimited.
UPDATE "users"
   SET "subtitle_quota_seconds" = 36000
 WHERE "role" <> 'master' AND "subtitle_quota_seconds" = 0;

-- The master pays the bill and is trusted with it, so the master is uncapped. Written as an
-- UPDATE rather than left to the default because the default cannot know the role.
UPDATE "users" SET "subtitle_quota_seconds" = 0 WHERE "role" = 'master';
