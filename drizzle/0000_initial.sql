-- Aether Cosmos ByAFR initial schema
-- Run via: npm run db:push (recommended) or apply manually

CREATE TYPE "public"."user_role" AS ENUM('master', 'user');
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');
CREATE TYPE "public"."share_permission" AS ENUM('view', 'edit');
CREATE TYPE "public"."activity_action" AS ENUM(
  'login', 'logout', 'upload', 'download', 'delete', 'restore',
  'share', 'edit', 'rename', 'move', 'copy', 'create_folder',
  'delete_folder', 'impersonate', 'create_user', 'update_user',
  'delete_user', 'suspend_user', 'favorite'
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "email" text,
  "password_hash" text NOT NULL,
  "role" "user_role" DEFAULT 'user' NOT NULL,
  "status" "user_status" DEFAULT 'active' NOT NULL,
  "quota_bytes" bigint DEFAULT 10737418240 NOT NULL,
  "used_bytes" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_username_unique" ON "users" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email");
CREATE INDEX IF NOT EXISTS "users_role_idx" ON "users" ("role");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "expires_at" timestamp with time zone NOT NULL,
  "ip" text,
  "user_agent" text,
  "impersonating_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" ("expires_at");

CREATE TABLE IF NOT EXISTS "folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "parent_id" uuid,
  "name" text NOT NULL,
  "materialized_path" text NOT NULL,
  "depth" integer DEFAULT 0 NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "folders_user_id_idx" ON "folders" ("user_id");
CREATE INDEX IF NOT EXISTS "folders_parent_id_idx" ON "folders" ("parent_id");
CREATE INDEX IF NOT EXISTS "folders_path_idx" ON "folders" ("user_id", "materialized_path");
CREATE INDEX IF NOT EXISTS "folders_user_active_idx" ON "folders" ("user_id", "deleted_at");

CREATE TABLE IF NOT EXISTS "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "folder_id" uuid REFERENCES "folders"("id") ON DELETE set null,
  "name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint DEFAULT 0 NOT NULL,
  "r2_key" text NOT NULL,
  "checksum_sha256" text,
  "is_favorite" boolean DEFAULT false NOT NULL,
  "is_note" boolean DEFAULT false NOT NULL,
  "thumbnail_key" text,
  "deleted_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "files_user_id_idx" ON "files" ("user_id");
CREATE INDEX IF NOT EXISTS "files_folder_id_idx" ON "files" ("folder_id");
CREATE INDEX IF NOT EXISTS "files_user_active_idx" ON "files" ("user_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "files_r2_key_idx" ON "files" ("r2_key");
CREATE INDEX IF NOT EXISTS "files_favorite_idx" ON "files" ("user_id", "is_favorite");
CREATE INDEX IF NOT EXISTS "idx_files_search" ON "files" USING gin(to_tsvector('simple', name));

CREATE TABLE IF NOT EXISTS "file_contents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE cascade,
  "content_json" jsonb,
  "annotations_json" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "file_contents_file_id_unique" ON "file_contents" ("file_id");

CREATE TABLE IF NOT EXISTS "shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE cascade,
  "shared_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "token" text NOT NULL,
  "permission" "share_permission" DEFAULT 'view' NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "shares_token_unique" ON "shares" ("token");
CREATE INDEX IF NOT EXISTS "shares_file_id_idx" ON "shares" ("file_id");

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "action" "activity_action" NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "metadata" jsonb,
  "ip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "activity_logs_user_time_idx" ON "activity_logs" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "activity_logs_action_idx" ON "activity_logs" ("action");
CREATE INDEX IF NOT EXISTS "activity_logs_created_at_idx" ON "activity_logs" ("created_at");

CREATE TABLE IF NOT EXISTS "change_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "change_type" text NOT NULL,
  "snapshot" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "change_history_file_id_idx" ON "change_history" ("file_id");
CREATE INDEX IF NOT EXISTS "change_history_user_id_idx" ON "change_history" ("user_id");
