-- Second Brain: brains, memories (+versions/tags), agents & access, knowledge
-- graph (entities/relationships) and a per-brain audit log.
--
-- Written in the guarded/idempotent style of 0011 so it can be re-applied
-- safely with:  npx tsx scripts/apply-migration.ts drizzle/0013_second_brain.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_status') THEN
    CREATE TYPE "brain_status" AS ENUM ('active', 'archived');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_agent_status') THEN
    CREATE TYPE "brain_agent_status" AS ENUM ('active', 'revoked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_principal_type') THEN
    CREATE TYPE "brain_principal_type" AS ENUM ('user', 'agent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_access_role') THEN
    CREATE TYPE "brain_access_role" AS ENUM ('owner', 'editor', 'viewer', 'agent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_type') THEN
    CREATE TYPE "memory_type" AS ENUM (
      'fact', 'preference', 'decision', 'instruction', 'project',
      'person', 'concept', 'experience', 'procedure', 'event',
      'observation', 'conversation', 'knowledge'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_source_type') THEN
    CREATE TYPE "memory_source_type" AS ENUM (
      'user', 'agent', 'conversation', 'imported_document',
      'manual_note', 'api', 'system'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_entity_type') THEN
    CREATE TYPE "brain_entity_type" AS ENUM (
      'person', 'project', 'organization', 'technology', 'location',
      'concept', 'product', 'agent', 'document', 'other'
    );
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_default" boolean DEFAULT false NOT NULL,
  "status" "brain_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "type" text DEFAULT 'agent' NOT NULL,
  "status" "brain_agent_status" DEFAULT 'active' NOT NULL,
  "api_key_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "principal_type" "brain_principal_type" NOT NULL,
  "principal_id" uuid NOT NULL,
  "role" "brain_access_role" DEFAULT 'viewer' NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "type" "memory_type" DEFAULT 'fact' NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "summary" text,
  "importance" real DEFAULT 0.5 NOT NULL,
  "confidence" real DEFAULT 0.9 NOT NULL,
  "source_type" "memory_source_type" DEFAULT 'user' NOT NULL,
  "source_id" text,
  "created_by" uuid,
  "created_by_agent" uuid,
  "metadata" jsonb,
  "version" integer DEFAULT 1 NOT NULL,
  "archived_at" timestamp with time zone,
  "last_accessed_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "search_vector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memory_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "summary" text,
  "changed_by" uuid,
  "changed_by_agent" uuid,
  "change_reason" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_tag_map" (
  "memory_id" uuid NOT NULL,
  "tag_id" uuid NOT NULL,
  CONSTRAINT "memory_tag_map_memory_id_tag_id_pk" PRIMARY KEY("memory_id","tag_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "name" text NOT NULL,
  "type" "brain_entity_type" DEFAULT 'other' NOT NULL,
  "description" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_relationships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "source_entity_id" uuid NOT NULL,
  "target_entity_id" uuid NOT NULL,
  "relationship_type" text NOT NULL,
  "confidence" real DEFAULT 0.9 NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "principal_type" "brain_principal_type" NOT NULL,
  "principal_id" uuid NOT NULL,
  "operation" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Foreign keys, added only when missing so the file stays re-runnable.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('brains_owner_user_id_users_id_fk',
       'ALTER TABLE "brains" ADD CONSTRAINT "brains_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_agents_owner_user_id_users_id_fk',
       'ALTER TABLE "brain_agents" ADD CONSTRAINT "brain_agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_agents_api_key_id_api_keys_id_fk',
       'ALTER TABLE "brain_agents" ADD CONSTRAINT "brain_agents_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action'),
      ('brain_access_brain_id_brains_id_fk',
       'ALTER TABLE "brain_access" ADD CONSTRAINT "brain_access_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('memories_brain_id_brains_id_fk',
       'ALTER TABLE "memories" ADD CONSTRAINT "memories_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('memories_created_by_users_id_fk',
       'ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action'),
      ('memories_created_by_agent_brain_agents_id_fk',
       'ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_agent_brain_agents_id_fk" FOREIGN KEY ("created_by_agent") REFERENCES "public"."brain_agents"("id") ON DELETE set null ON UPDATE no action'),
      ('memory_versions_memory_id_memories_id_fk',
       'ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_versions_changed_by_users_id_fk',
       'ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action'),
      ('memory_versions_changed_by_agent_brain_agents_id_fk',
       'ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_changed_by_agent_brain_agents_id_fk" FOREIGN KEY ("changed_by_agent") REFERENCES "public"."brain_agents"("id") ON DELETE set null ON UPDATE no action'),
      ('memory_tags_brain_id_brains_id_fk',
       'ALTER TABLE "memory_tags" ADD CONSTRAINT "memory_tags_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_tag_map_memory_id_memories_id_fk',
       'ALTER TABLE "memory_tag_map" ADD CONSTRAINT "memory_tag_map_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_tag_map_tag_id_memory_tags_id_fk',
       'ALTER TABLE "memory_tag_map" ADD CONSTRAINT "memory_tag_map_tag_id_memory_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."memory_tags"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_entities_brain_id_brains_id_fk',
       'ALTER TABLE "brain_entities" ADD CONSTRAINT "brain_entities_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_relationships_brain_id_brains_id_fk',
       'ALTER TABLE "brain_relationships" ADD CONSTRAINT "brain_relationships_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_relationships_source_entity_id_brain_entities_id_fk',
       'ALTER TABLE "brain_relationships" ADD CONSTRAINT "brain_relationships_source_entity_id_brain_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."brain_entities"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_relationships_target_entity_id_brain_entities_id_fk',
       'ALTER TABLE "brain_relationships" ADD CONSTRAINT "brain_relationships_target_entity_id_brain_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."brain_entities"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_audit_logs_brain_id_brains_id_fk',
       'ALTER TABLE "brain_audit_logs" ADD CONSTRAINT "brain_audit_logs_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action')
    ) AS t(name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE fk.ddl;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brains_owner_idx" ON "brains" USING btree ("owner_user_id");--> statement-breakpoint
-- At most one default brain per user (see getOrCreateDefaultBrain).
CREATE UNIQUE INDEX IF NOT EXISTS "brains_owner_default_unique" ON "brains" USING btree ("owner_user_id") WHERE "is_default";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_agents_owner_idx" ON "brain_agents" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_agents_status_idx" ON "brain_agents" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_access_unique" ON "brain_access" USING btree ("brain_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_access_principal_idx" ON "brain_access" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_access_brain_idx" ON "brain_access" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_idx" ON "memories" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_type_idx" ON "memories" USING btree ("brain_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_created_idx" ON "memories" USING btree ("brain_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_importance_idx" ON "memories" USING btree ("brain_id","importance");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_deleted_idx" ON "memories" USING btree ("brain_id","deleted_at");--> statement-breakpoint
-- Matches the (created_at, id) keyset order used by listMemories().
CREATE INDEX IF NOT EXISTS "memories_brain_keyset_idx" ON "memories" USING btree ("brain_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_search_vector_idx" ON "memories" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_versions_unique" ON "memory_versions" USING btree ("memory_id","version_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_versions_memory_idx" ON "memory_versions" USING btree ("memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_tags_brain_name_unique" ON "memory_tags" USING btree ("brain_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_tags_brain_idx" ON "memory_tags" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_entities_brain_idx" ON "brain_entities" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_entities_brain_type_idx" ON "brain_entities" USING btree ("brain_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_entities_brain_name_type_unique" ON "brain_entities" USING btree ("brain_id","name","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_relationships_brain_idx" ON "brain_relationships" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_relationships_source_idx" ON "brain_relationships" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_relationships_target_idx" ON "brain_relationships" USING btree ("target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_relationships_unique" ON "brain_relationships" USING btree ("source_entity_id","target_entity_id","relationship_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_audit_logs_brain_time_idx" ON "brain_audit_logs" USING btree ("brain_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_audit_logs_principal_idx" ON "brain_audit_logs" USING btree ("principal_type","principal_id");
