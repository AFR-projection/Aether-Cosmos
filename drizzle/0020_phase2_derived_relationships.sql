-- PHASE 2: Derived Relationship Intelligence Layer
-- Migration: 0020_phase2_derived_relationships
-- Date: 2026-08-23
--
-- ADDITIVE ONLY: New table, new enums, new indexes. Zero changes to existing data.
-- Rollback: drizzle/0020_phase2_derived_relationships_rollback.sql
--   (npx tsx scripts/apply-migration.ts drizzle/0020_phase2_derived_relationships_rollback.sql)
--
-- This migration implements the graph intelligence layer that distinguishes
-- algorithmic inferences (memory_derived_links) from explicit user assertions
-- (memory_links, unchanged).

-- New enums for derived relationship provenance
CREATE TYPE "memory_relation_origin" AS ENUM ('derived', 'inferred');
CREATE TYPE "memory_relation_status" AS ENUM ('applied', 'suggested');

-- Derived memory relationships table
CREATE TABLE IF NOT EXISTS "memory_derived_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brain_id" uuid NOT NULL,
	"source_memory_id" uuid NOT NULL,
	"target_memory_id" uuid NOT NULL,
	"origin" "memory_relation_origin" NOT NULL,
	"status" "memory_relation_status" DEFAULT 'applied' NOT NULL,
	"relation" text NOT NULL,
	"weight" real NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb,
	"reason" text NOT NULL,
	"computed_by" text NOT NULL,
	"source_hash_a" text,
	"source_hash_b" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_derived_links_canonical" CHECK ("source_memory_id" < "target_memory_id"),
	CONSTRAINT "memory_derived_links_weight" CHECK ("weight" >= 0 AND "weight" <= 1),
	CONSTRAINT "memory_derived_links_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "memory_derived_links_no_self" CHECK ("source_memory_id" <> "target_memory_id")
);

-- Foreign keys
ALTER TABLE "memory_derived_links" ADD CONSTRAINT "memory_derived_links_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "brains"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "memory_derived_links" ADD CONSTRAINT "memory_derived_links_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "memories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "memory_derived_links" ADD CONSTRAINT "memory_derived_links_target_memory_id_memories_id_fk" FOREIGN KEY ("target_memory_id") REFERENCES "memories"("id") ON DELETE cascade ON UPDATE no action;

-- Indexes for efficient queries
CREATE UNIQUE INDEX IF NOT EXISTS "memory_derived_links_pair_unique" ON "memory_derived_links" USING btree ("brain_id","source_memory_id","target_memory_id");
CREATE INDEX IF NOT EXISTS "memory_derived_links_source_idx" ON "memory_derived_links" USING btree ("brain_id","source_memory_id","status","weight");
CREATE INDEX IF NOT EXISTS "memory_derived_links_target_idx" ON "memory_derived_links" USING btree ("brain_id","target_memory_id","status","weight");
CREATE INDEX IF NOT EXISTS "memory_derived_links_version_idx" ON "memory_derived_links" USING btree ("brain_id","computed_by");

-- Tag reverse lookup index for candidate generation probe
CREATE INDEX IF NOT EXISTS "memory_tag_map_tag_idx" ON "memory_tag_map" USING btree ("tag_id","memory_id");

-- Comments documenting design decisions
COMMENT ON TABLE "memory_derived_links" IS 'PHASE 2: Algorithmic relationship intelligence layer. Distinct from explicit user assertions in memory_links. Every row carries full provenance (origin, confidence, evidence, reason, computedBy) so agents can distinguish stated facts from algorithmic inferences. Undirected: source < target enforced by CHECK. Reconcilable: computedBy version key. Idempotent: sourceHashA/B detect staleness.';
COMMENT ON COLUMN "memory_derived_links"."origin" IS 'derived = 1 signal family passed gate; inferred = >= 2 independent families agreed (higher confidence)';
COMMENT ON COLUMN "memory_derived_links"."status" IS 'applied = visible to brain_related (confidence >= threshold); suggested = awaiting policy/human approval (invisible by default)';
COMMENT ON COLUMN "memory_derived_links"."weight" IS 'Edge strength 0..1 from relate.ts scoring blend';
COMMENT ON COLUMN "memory_derived_links"."confidence" IS 'Belief 0..1 based on signal family agreement, NOT the weight. Used for APPLY vs SUGGEST threshold.';
COMMENT ON COLUMN "memory_derived_links"."evidence" IS 'Bounded structured data safe for agents: {signals, sharedTerms, sharedTags, sharedEntityIds, similarity}. Never contains full memory content.';
COMMENT ON COLUMN "memory_derived_links"."computed_by" IS 'Scorer version e.g. relate-v1. Reconciliation only touches rows with matching computedBy, allowing multiple algorithm versions to coexist.';
COMMENT ON COLUMN "memory_derived_links"."source_hash_a" IS 'memories.contentHash of sourceMemoryId at compute time. Cheap staleness detection without re-scoring.';
COMMENT ON COLUMN "memory_derived_links"."source_hash_b" IS 'memories.contentHash of targetMemoryId at compute time. Cheap staleness detection without re-scoring.';
COMMENT ON INDEX "memory_tag_map_tag_idx" IS 'PHASE 2: Reverse lookup for "which memories use tag X" candidate generation probe';
