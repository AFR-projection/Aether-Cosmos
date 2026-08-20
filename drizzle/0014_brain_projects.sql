-- Second Brain projects: a project groups memories (and, later, notes/entities)
-- so an agent can load the context of one piece of work rather than the whole brain.
--
-- Additive only. Guarded/idempotent like 0011 and 0013, apply with:
--   npx tsx scripts/apply-migration.ts drizzle/0014_brain_projects.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_project_status') THEN
    CREATE TYPE "brain_project_status" AS ENUM ('active', 'paused', 'done', 'archived');
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" "brain_project_status" DEFAULT 'active' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- memories.project_id: nullable, and ON DELETE SET NULL so deleting a project
-- never deletes the knowledge that was gathered under it.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('brain_projects_brain_id_brains_id_fk',
       'ALTER TABLE "brain_projects" ADD CONSTRAINT "brain_projects_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('memories_project_id_brain_projects_id_fk',
       'ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_brain_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."brain_projects"("id") ON DELETE set null ON UPDATE no action')
    ) AS t(name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE fk.ddl;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brain_projects_brain_idx" ON "brain_projects" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_projects_brain_status_idx" ON "brain_projects" USING btree ("brain_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_projects_brain_name_unique" ON "brain_projects" USING btree ("brain_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_project_idx" ON "memories" USING btree ("project_id");
