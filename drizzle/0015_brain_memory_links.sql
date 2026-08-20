-- Second Brain backlinks (§41): links that start at a memory and point at either
-- another memory or an entity. brain_relationships stays entity->entity; this table
-- carries the two directions a memory needs so "Referenced by" is an indexed
-- lookup rather than a client-side scan of every memory body.
--
-- Additive only. Guarded/idempotent like 0013 and 0014, apply with:
--   npx tsx scripts/apply-migration.ts drizzle/0015_brain_memory_links.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_link_target') THEN
    CREATE TYPE "memory_link_target" AS ENUM ('memory', 'entity');
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "source_memory_id" uuid NOT NULL,
  "target_type" "memory_link_target" NOT NULL,
  "target_memory_id" uuid,
  "target_entity_id" uuid,
  "link_type" text DEFAULT 'relates_to' NOT NULL,
  "metadata" jsonb,
  "created_by" uuid,
  "created_by_agent" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('memory_links_brain_id_brains_id_fk',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_links_source_memory_id_memories_id_fk',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_links_target_memory_id_memories_id_fk',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_target_memory_id_memories_id_fk" FOREIGN KEY ("target_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_links_target_entity_id_brain_entities_id_fk',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_target_entity_id_brain_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."brain_entities"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_links_created_by_users_id_fk',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action'),
      ('memory_links_created_by_agent_brain_agents_id_fk',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_created_by_agent_brain_agents_id_fk" FOREIGN KEY ("created_by_agent") REFERENCES "public"."brain_agents"("id") ON DELETE set null ON UPDATE no action')
    ) AS t(name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE fk.ddl;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- Integrity at the database level (§48), not only in the service layer.
DO $$
DECLARE
  ck RECORD;
BEGIN
  FOR ck IN
    SELECT * FROM (VALUES
      ('memory_links_one_target',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_one_target" CHECK ((("target_memory_id" IS NOT NULL)::int + ("target_entity_id" IS NOT NULL)::int) = 1)'),
      ('memory_links_target_type_matches',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_target_type_matches" CHECK (("target_type" = ''memory'' AND "target_memory_id" IS NOT NULL) OR ("target_type" = ''entity'' AND "target_entity_id" IS NOT NULL))'),
      ('memory_links_no_self_link',
       'ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_no_self_link" CHECK ("target_memory_id" IS NULL OR "target_memory_id" <> "source_memory_id")')
    ) AS t(name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ck.name) THEN
      EXECUTE ck.ddl;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_links_brain_idx" ON "memory_links" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_links_source_idx" ON "memory_links" USING btree ("source_memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_links_target_memory_idx" ON "memory_links" USING btree ("target_memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_links_target_entity_idx" ON "memory_links" USING btree ("target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_links_memory_unique" ON "memory_links" USING btree ("source_memory_id","target_memory_id","link_type") WHERE "target_memory_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_links_entity_unique" ON "memory_links" USING btree ("source_memory_id","target_entity_id","link_type") WHERE "target_entity_id" is not null;
