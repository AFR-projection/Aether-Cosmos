-- Second Brain 2.0 — step 2 of 4: additive columns on "memories".
--
-- Nothing here rewrites or drops data. Every column is nullable or has a
-- constant default, so PostgreSQL 11+ applies them as catalog-only changes.
-- Existing rows land on enrichment_status = 'pending' and validity_state =
-- 'active', which is exactly the desired backfill semantics: everything already
-- stored is still considered valid, and the worker will enrich it lazily.
--
-- Requires 0016 to have been applied first (enum labels).
-- Apply with:
--   npx tsx scripts/apply-migration.ts drizzle/0017_brain_memory_intelligence.sql

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "enriched_hash" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "enrichment_status" "memory_enrichment_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "enrichment_error" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "enriched_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "recall_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "last_recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "confirmation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "last_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "validity_state" "memory_validity_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "aliases" text[];--> statement-breakpoint

-- Self-reference: superseding never deletes the superseded row, it points at the
-- replacement. ON DELETE SET NULL so hard-deleting the replacement cannot
-- cascade into losing history.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_superseded_by_id_memories_id_fk') THEN
    ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_id_memories_id_fk"
      FOREIGN KEY ("superseded_by_id") REFERENCES "public"."memories"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_no_self_supersede') THEN
    ALTER TABLE "memories" ADD CONSTRAINT "memories_no_self_supersede"
      CHECK ("superseded_by_id" IS NULL OR "superseded_by_id" <> "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_validity_window') THEN
    ALTER TABLE "memories" ADD CONSTRAINT "memories_validity_window"
      CHECK ("valid_until" IS NULL OR "valid_from" IS NULL OR "valid_until" >= "valid_from");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_counters_non_negative') THEN
    ALTER TABLE "memories" ADD CONSTRAINT "memories_counters_non_negative"
      CHECK ("recall_count" >= 0 AND "confirmation_count" >= 0);
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memories_enrichment_idx" ON "memories" USING btree ("brain_id","enrichment_status") WHERE "enrichment_status" <> 'ready';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_validity_idx" ON "memories" USING btree ("brain_id","validity_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_superseded_by_idx" ON "memories" USING btree ("superseded_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_brain_recalled_idx" ON "memories" USING btree ("brain_id","last_recalled_at");
