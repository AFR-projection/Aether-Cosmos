-- Second Brain 2.0 — step 3 of 4: additive columns on "brain_entities".
--
-- Extraction provenance. An entity node must be able to answer "who created me,
-- how, when, and how sure was it" — otherwise the graph is unauditable.
--
-- Apply with:
--   npx tsx scripts/apply-migration.ts drizzle/0018_brain_entity_provenance.sql

ALTER TABLE "brain_entities" ADD COLUMN IF NOT EXISTS "aliases" text[];--> statement-breakpoint
ALTER TABLE "brain_entities" ADD COLUMN IF NOT EXISTS "mention_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_entities" ADD COLUMN IF NOT EXISTS "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brain_entities" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brain_entities" ADD COLUMN IF NOT EXISTS "extracted_by" text;--> statement-breakpoint
ALTER TABLE "brain_entities" ADD COLUMN IF NOT EXISTS "extraction_confidence" real;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_entities_mention_count_non_negative') THEN
    ALTER TABLE "brain_entities" ADD CONSTRAINT "brain_entities_mention_count_non_negative"
      CHECK ("mention_count" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_entities_extraction_confidence_range') THEN
    ALTER TABLE "brain_entities" ADD CONSTRAINT "brain_entities_extraction_confidence_range"
      CHECK ("extraction_confidence" IS NULL OR ("extraction_confidence" >= 0 AND "extraction_confidence" <= 1));
  END IF;
END $$;
