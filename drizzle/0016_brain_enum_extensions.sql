-- Second Brain 2.0 — step 1 of 4: enum values only.
--
-- Isolated on purpose. `ALTER TYPE ... ADD VALUE` cannot be followed by a
-- statement that USES the new value inside the same transaction, and
-- scripts/apply-migration.ts sends a whole file as one implicit transaction.
-- So this file adds labels and nothing else; 0017-0019 consume them.
--
-- Additive and idempotent. Apply with:
--   npx tsx scripts/apply-migration.ts drizzle/0016_brain_enum_extensions.sql

-- New memory kinds for epistemic memory: a hypothesis is not a fact, and the
-- source/evidence pair lets a claim point at what backs it.
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'task';--> statement-breakpoint
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'hypothesis';--> statement-breakpoint
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'source';--> statement-breakpoint
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'evidence';--> statement-breakpoint

-- New enum types used by 0017-0019.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_validity_state') THEN
    CREATE TYPE "memory_validity_state" AS ENUM ('active', 'superseded', 'stale', 'retracted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_enrichment_status') THEN
    CREATE TYPE "memory_enrichment_status" AS ENUM ('pending', 'processing', 'ready', 'failed', 'skipped');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_graph_node_kind') THEN
    CREATE TYPE "brain_graph_node_kind" AS ENUM ('memory', 'entity');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_retrieval_outcome') THEN
    CREATE TYPE "brain_retrieval_outcome" AS ENUM (
      'retrieved', 'selected', 'omitted', 'opened', 'confirmed', 'corrected', 'superseded'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_review_kind') THEN
    CREATE TYPE "brain_review_kind" AS ENUM (
      'contradiction', 'duplicate', 'stale', 'orphan', 'low_confidence_important', 'missing_entities'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_review_status') THEN
    CREATE TYPE "brain_review_status" AS ENUM ('open', 'dismissed', 'resolved');
  END IF;
END $$;
