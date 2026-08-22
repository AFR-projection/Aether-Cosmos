-- Second Brain 2.0 — step 4 of 4: intelligence tables.
--
-- Five additive tables. No existing table is altered here.
--   memory_mentions        evidence spans behind every memory->entity link
--   brain_graph_metrics    cached PageRank / community / component per node
--   brain_health_snapshots point-in-time health rollups
--   brain_retrieval_events bounded ranking feedback (query HASH only, never text)
--   brain_review_items     human review queue; contradictions are never auto-resolved
--
-- Requires 0016 (enum labels). Apply with:
--   npx tsx scripts/apply-migration.ts drizzle/0019_brain_intelligence_tables.sql

CREATE TABLE IF NOT EXISTS "memory_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "memory_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "field" text NOT NULL,
  "surface" text NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "confidence" real DEFAULT 1 NOT NULL,
  "extracted_by" text DEFAULT 'deterministic-v1' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_graph_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "node_kind" "brain_graph_node_kind" NOT NULL,
  "node_id" uuid NOT NULL,
  "degree" integer DEFAULT 0 NOT NULL,
  "weighted_degree" real DEFAULT 0 NOT NULL,
  "pagerank" real DEFAULT 0 NOT NULL,
  "community_id" integer,
  "component_id" integer,
  "is_bridge" boolean DEFAULT false NOT NULL,
  "is_orphan" boolean DEFAULT false NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_health_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "total_memories" integer DEFAULT 0 NOT NULL,
  "stale_count" integer DEFAULT 0 NOT NULL,
  "contradiction_count" integer DEFAULT 0 NOT NULL,
  "duplicate_count" integer DEFAULT 0 NOT NULL,
  "orphan_count" integer DEFAULT 0 NOT NULL,
  "weak_cluster_count" integer DEFAULT 0 NOT NULL,
  "missing_entity_count" integer DEFAULT 0 NOT NULL,
  "low_confidence_important_count" integer DEFAULT 0 NOT NULL,
  "avg_confidence" real DEFAULT 0 NOT NULL,
  "score" real DEFAULT 0 NOT NULL,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_retrieval_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "memory_id" uuid NOT NULL,
  "query_hash" text,
  "tool" text NOT NULL,
  "outcome" "brain_retrieval_outcome" NOT NULL,
  "rank" integer,
  "score" real,
  "user_id" uuid,
  "agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brain_review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brain_id" uuid NOT NULL,
  "kind" "brain_review_kind" NOT NULL,
  "status" "brain_review_status" DEFAULT 'open' NOT NULL,
  "memory_id" uuid,
  "related_memory_id" uuid,
  "dedupe_key" text NOT NULL,
  "reason" text NOT NULL,
  "evidence" jsonb,
  "priority" real DEFAULT 0.5 NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Foreign keys. Everything cascades from the brain so deleting a brain leaves no
-- orphaned intelligence rows, and every node-shaped reference cascades from the
-- memory/entity it describes -- that is what keeps "no dangling edges" true.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('memory_mentions_brain_id_brains_id_fk',
       'ALTER TABLE "memory_mentions" ADD CONSTRAINT "memory_mentions_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_mentions_memory_id_memories_id_fk',
       'ALTER TABLE "memory_mentions" ADD CONSTRAINT "memory_mentions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('memory_mentions_entity_id_brain_entities_id_fk',
       'ALTER TABLE "memory_mentions" ADD CONSTRAINT "memory_mentions_entity_id_brain_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."brain_entities"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_graph_metrics_brain_id_brains_id_fk',
       'ALTER TABLE "brain_graph_metrics" ADD CONSTRAINT "brain_graph_metrics_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_health_snapshots_brain_id_brains_id_fk',
       'ALTER TABLE "brain_health_snapshots" ADD CONSTRAINT "brain_health_snapshots_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_retrieval_events_brain_id_brains_id_fk',
       'ALTER TABLE "brain_retrieval_events" ADD CONSTRAINT "brain_retrieval_events_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_retrieval_events_memory_id_memories_id_fk',
       'ALTER TABLE "brain_retrieval_events" ADD CONSTRAINT "brain_retrieval_events_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_retrieval_events_user_id_users_id_fk',
       'ALTER TABLE "brain_retrieval_events" ADD CONSTRAINT "brain_retrieval_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action'),
      ('brain_retrieval_events_agent_id_brain_agents_id_fk',
       'ALTER TABLE "brain_retrieval_events" ADD CONSTRAINT "brain_retrieval_events_agent_id_brain_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."brain_agents"("id") ON DELETE set null ON UPDATE no action'),
      ('brain_review_items_brain_id_brains_id_fk',
       'ALTER TABLE "brain_review_items" ADD CONSTRAINT "brain_review_items_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_review_items_memory_id_memories_id_fk',
       'ALTER TABLE "brain_review_items" ADD CONSTRAINT "brain_review_items_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_review_items_related_memory_id_memories_id_fk',
       'ALTER TABLE "brain_review_items" ADD CONSTRAINT "brain_review_items_related_memory_id_memories_id_fk" FOREIGN KEY ("related_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action'),
      ('brain_review_items_resolved_by_users_id_fk',
       'ALTER TABLE "brain_review_items" ADD CONSTRAINT "brain_review_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action')
    ) AS t(name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE fk.ddl;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE
  ck RECORD;
BEGIN
  FOR ck IN
    SELECT * FROM (VALUES
      ('memory_mentions_offsets',
       'ALTER TABLE "memory_mentions" ADD CONSTRAINT "memory_mentions_offsets" CHECK ("end_offset" > "start_offset")'),
      ('memory_mentions_field',
       'ALTER TABLE "memory_mentions" ADD CONSTRAINT "memory_mentions_field" CHECK ("field" IN (''title'', ''summary'', ''content''))')
    ) AS t(name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ck.name) THEN
      EXECUTE ck.ddl;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_mentions_brain_idx" ON "memory_mentions" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_mentions_memory_idx" ON "memory_mentions" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_mentions_entity_idx" ON "memory_mentions" USING btree ("brain_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_mentions_span_unique" ON "memory_mentions" USING btree ("memory_id","entity_id","field","start_offset");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brain_graph_metrics_node_unique" ON "brain_graph_metrics" USING btree ("brain_id","node_kind","node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_graph_metrics_brain_rank_idx" ON "brain_graph_metrics" USING btree ("brain_id","pagerank");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_graph_metrics_brain_kind_idx" ON "brain_graph_metrics" USING btree ("brain_id","node_kind");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brain_health_snapshots_brain_time_idx" ON "brain_health_snapshots" USING btree ("brain_id","created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "brain_retrieval_events_brain_time_idx" ON "brain_retrieval_events" USING btree ("brain_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_retrieval_events_memory_idx" ON "brain_retrieval_events" USING btree ("memory_id","outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_retrieval_events_query_idx" ON "brain_retrieval_events" USING btree ("brain_id","query_hash");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "brain_review_items_dedupe_unique" ON "brain_review_items" USING btree ("brain_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_review_items_brain_status_idx" ON "brain_review_items" USING btree ("brain_id","status","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_review_items_memory_idx" ON "brain_review_items" USING btree ("memory_id");
