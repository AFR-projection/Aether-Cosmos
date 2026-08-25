-- Rollback for 0022_brain_vector
-- Date: 2026-08-25
--
-- Drops everything 0022 added, in reverse dependency order. The DROP EXTENSION is
-- intentionally omitted: another feature may come to rely on pgvector, and dropping an
-- extension that other objects depend on would fail anyway. Removing the columns and the
-- config table is enough to fully undo this migration's surface.
--
-- Apply: npx tsx scripts/apply-migration.ts drizzle/0022_brain_vector_rollback.sql

DROP TABLE IF EXISTS "brain_embedding_settings";

ALTER TABLE "memories" DROP COLUMN IF EXISTS "embedding_updated_at";
ALTER TABLE "memories" DROP COLUMN IF EXISTS "embedding_model";
ALTER TABLE "memories" DROP COLUMN IF EXISTS "embedding";
